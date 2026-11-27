/**
 * Runs the merge gate (`domain/mergeGate.ts`) against GitHub with the app's own
 * installation: reads the PR, its files, the check runs of the named sha, its
 * reviews and comments, decides, and only on `merge` makes the one call that
 * merges, pinned to that sha. The credential never leaves the bot; the caller
 * (a writer's `bin/merge-when-green.sh`, holding only a ticket) gets the decision.
 */
import { type GateDecision, type GateInput, evaluateGate } from "../domain/mergeGate.ts";

export type MergeGateConfig = {
  /** `MERGE_GATE`: off keeps the old human-token path (the script falls back), on makes the bot the only merger. */
  enabled: boolean;
  requiredChecks: readonly string[];
  attesters: readonly string[];
  /** The app's login, `<slug>[bot]`. */
  botLogin: string;
};

export type MergeGateOutcome = (GateDecision & { sha: string }) | { decision: "disabled"; reasons: string[]; sha: string } | { decision: "merged"; sha: string; mergedSha?: string; runtime: boolean };

type Request = (method: string, path: string, body?: unknown) => Promise<unknown>;
type Json = Record<string, unknown>;

const obj = (v: unknown): Json => (v && typeof v === "object" ? (v as Json) : {});
const text = (v: unknown): string => (typeof v === "string" ? v : "");
const login = (v: unknown): string => text(obj(v).login);

/** Every page of a list endpoint (100 a page), capped so a runaway PR cannot loop for ever. */
const pages = async (request: Request, path: string, pick: (page: unknown) => unknown[]): Promise<unknown[]> => {
  const out: unknown[] = [];
  const sep = path.includes("?") ? "&" : "?";
  for (let page = 1; page <= 30; page++) {
    const items = pick(await request("GET", `${path}${sep}per_page=100&page=${page}`));
    out.push(...items);
    if (items.length < 100) break;
  }
  return out;
};

export const runMergeGate = async (
  config: MergeGateConfig,
  request: Request,
  repo: string,
  number: number,
  sha: string,
): Promise<MergeGateOutcome> => {
  if (!config.enabled) return { decision: "disabled", reasons: ["the bot's merge gate is off (MERGE_GATE)"], sha };
  const pull = obj(await request("GET", `repos/${repo}/pulls/${number}`));
  const head = obj(pull.head);
  const headSha = text(head.sha);
  const prState = {
    state: text(pull.state),
    merged: pull.merged === true,
    draft: pull.draft === true,
    headSha,
    author: login(pull.user),
    mergeable: typeof pull.mergeable === "boolean" ? pull.mergeable : null,
    mergeState: text(pull.mergeable_state) || "unknown",
  };
  // A head that is not the named sha needs none of the other reads: nothing about the named commit is being merged.
  const stale = headSha.toLowerCase() !== sha.toLowerCase();
  const [files, checks, reviews, comments] = stale
    ? [[], [], [], []]
    : await Promise.all([
        pages(request, `repos/${repo}/pulls/${number}/files`, (p) => (Array.isArray(p) ? p : [])),
        pages(request, `repos/${repo}/commits/${sha}/check-runs`, (p) => (Array.isArray(obj(p).check_runs) ? (obj(p).check_runs as unknown[]) : [])),
        pages(request, `repos/${repo}/pulls/${number}/reviews`, (p) => (Array.isArray(p) ? p : [])),
        pages(request, `repos/${repo}/issues/${number}/comments`, (p) => (Array.isArray(p) ? p : [])),
      ]);
  const input: GateInput = {
    sha,
    pr: prState,
    // A rename shows its new path as `filename`: the old one counts too, or moving code into docs/ would look docs-only.
    files: files.flatMap((f) => [text(obj(f).filename), text(obj(f).previous_filename)].filter(Boolean)),
    checks: checks.map((c) => ({ name: text(obj(c).name), status: text(obj(c).status), conclusion: typeof obj(c).conclusion === "string" ? (obj(c).conclusion as string) : null })),
    reviews: reviews.map((r) => ({ login: login(obj(r).user), body: text(obj(r).body), commitId: text(obj(r).commit_id) })),
    comments: comments.map((c) => ({ login: login(obj(c).user), body: text(obj(c).body), edited: text(obj(c).updated_at) !== text(obj(c).created_at) })),
    requiredChecks: config.requiredChecks,
    attesters: config.attesters,
    botLogin: config.botLogin,
  };
  const decision = evaluateGate(input);
  if (decision.decision !== "merge") return { ...decision, sha };
  // Pinned to the sha: a push that lands between the read and this call makes GitHub refuse (409), never merge unchecked.
  const merged = obj(await request("PUT", `repos/${repo}/pulls/${number}/merge`, { sha, merge_method: "merge" }));
  return { decision: "merged", sha, ...(text(merged.sha) ? { mergedSha: text(merged.sha) } : {}), runtime: decision.runtime };
};
