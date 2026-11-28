import { FLOW_AUDIT_MARKER, flowAuditProblem } from "./flowAudit.ts";

/**
 * The merge gate, as pure rules. The decision to merge a PR used to be a shell
 * script holding a human admin's token: whoever could run the script (the
 * writer) could merge, and the token could also edit branch protection. Now the
 * bot decides, in code, with the app's credential that no turn or worker ever
 * sees (`application/mergeGate.ts` runs it, the `merge-gate` action of
 * `domain/githubAppAction.ts` asks for it). Nothing here talks to GitHub.
 *
 * It merges only when ALL hold, on the exact head sha the caller names:
 * the PR is open, not a draft and mergeable; every required check (default
 * `checks` and `gitleaks`) is green on that sha and none is red; and for a PR
 * that touches runtime code the latest `[review round N]` review of the head
 * ends `VERDICT: clean` and the latest `[verify]` comment ends
 * `VERDICT: verified` and names the sha. Review and verify words only count
 * from an account named in `attesters` (`MERGE_GATE_ATTESTERS`) that is neither
 * the PR's author nor the app itself: the writer can comment as the app, and the
 * repo is public, so anyone-but-the-author would let any GitHub user vouch. A
 * `[verify]` comment edited after it was posted refuses the merge, and a rename out of a
 * runtime path counts as touching it.
 *
 * Behind `MERGE_GATE_FLOW_AUDIT` (default off) every PR, docs-only ones too, also
 * needs the latest `[flow-audit]` comment of an attester (the same account rule)
 * to be a well-formed `VERDICT: clean` whose `HEAD:` line is the head
 * (`domain/flowAudit.ts`): the audit of the review flow, not of the code.
 */

/** A PR whose every file matches one of these needs no reviewer and no verifier (the self-fix guide's "review by risk"). */
const NON_RUNTIME: readonly RegExp[] = [
  /\.md$/i,
  /^docs\//,
  /^web\//,
  /^\.claude\/skills\//,
  /^data\/prompt-guides\//,
  /^LICENSE$/,
  /^\.env\.example$/,
];

/** Runtime code is anything not provably docs, a skill, a guide or dashboard UI: `.github/`, `bin/`, `tests/` and prompt text in `.ts` files all count. */
export const touchesRuntime = (files: readonly string[]): boolean => files.some((f) => !NON_RUNTIME.some((p) => p.test(f)));

export type GatePr = {
  state: string;
  merged: boolean;
  draft: boolean;
  headSha: string;
  author: string;
  /** GitHub's `mergeable`: null while it is still being worked out. */
  mergeable: boolean | null;
  /** GitHub's `mergeable_state` (`dirty` = conflicts, `unknown` = not computed yet). */
  mergeState: string;
};
export type GateCheck = { name: string; status: string; conclusion: string | null };
/** `userType`: GitHub's `user.type` (`Bot` for an app, `User` for a person); absent = unknown, which `appVerdicts` treats as not a bot. */
export type GateReview = { login: string; body: string; commitId: string; userType?: string };
/** `edited`: the comment's `updated_at` is not its `created_at`. Anyone with write access can edit another's issue comment, keeping its author, so an edited `[verify]` proves nothing. */
export type GateComment = { login: string; body: string; edited?: boolean; userType?: string };

export type GateInput = {
  /** The sha the caller built and tested: the merge is pinned to it. */
  sha: string;
  pr: GatePr;
  files: readonly string[];
  /** False when GitHub gave fewer files than the PR changed (its list stops at 3000): what is missing may be runtime code, so the PR counts as runtime. */
  filesComplete?: boolean;
  checks: readonly GateCheck[];
  reviews: readonly GateReview[];
  comments: readonly GateComment[];
  requiredChecks: readonly string[];
  /** Accounts whose review / verify words count. Empty: nobody's do, so a runtime PR is refused: the repo is public, "anyone but the author" would let any GitHub user vouch. */
  attesters: readonly string[];
  /** The app's own login (`<slug>[bot]`). */
  botLogin: string;
  /**
   * `MERGE_GATE_APP_VERDICTS`: a review, verify or flow-audit only counts from an account GitHub types as a Bot, so a human
   * login (a person's token in a worker's hands) can never satisfy the gate; the verifier and the flow auditor must also be
   * two accounts. It adds to the rules above, never replaces them: the author and the app itself still do not count.
   * Absent = off. Keep it off until per-role tickets exist (the app alone cannot tell a writer's comment from a reviewer's).
   */
  appVerdicts?: boolean;
  /** `MERGE_GATE_FLOW_AUDIT`: also require a clean `[flow-audit]` comment on the head. Absent = off. */
  flowAudit?: boolean;
};

/** `merge` = go ahead; `pending` = not yet, ask again; `conflict` = merge the base in; `refused` = a real no. */
export type GateDecision =
  | { decision: "merge"; runtime: boolean }
  | { decision: "pending" | "conflict" | "refused"; reasons: string[] };

const lc = (s: string): string => s.toLowerCase();
const GOOD = new Set(["success", "neutral", "skipped"]);

/**
 * What a check name stands for on this sha. CI cancels a run when a newer push supersedes it, and a push-only run of
 * `checks` is skipped by its own `if:`, so a head usually carries cancelled and skipped runs next to the real one (13 of
 * the last 15 PR heads did): those say nothing either way and are set aside. Every other run speaks: any completed red
 * one refuses (a later green run of the same name does NOT hide it: anyone who can push a branch could post one),
 * any unfinished one waits. A name left with nothing but cancelled or skipped runs has not really run on this head.
 */
const verdictOf = (runs: readonly GateCheck[]): "good" | "running" | "none-cancelled" | "none-skipped" | { red: string } => {
  const decisive = runs.filter((c) => !(c.status === "completed" && (c.conclusion === "cancelled" || c.conclusion === "skipped")));
  const red = decisive.find((c) => c.status === "completed" && !GOOD.has(c.conclusion ?? ""));
  if (red) return { red: red.conclusion ?? "unknown" };
  if (decisive.some((c) => c.status !== "completed")) return "running";
  if (decisive.length === 0) return runs.some((c) => c.conclusion === "cancelled") ? "none-cancelled" : "none-skipped";
  return "good";
};

/** The last non-empty line of a body: where a verdict lives. */
const lastLine = (body: string): string =>
  body
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .pop() ?? "";

/** Does this body name the sha, in full or as a prefix of at least 7 hex digits? */
export const namesSha = (body: string, sha: string): boolean =>
  (lc(body).match(/\b[0-9a-f]{7,40}\b/g) ?? []).some((t) => lc(sha).startsWith(t));

const counts = (who: { login: string; userType?: string }, input: GateInput): boolean => {
  const l = lc(who.login);
  if (!l || l === lc(input.pr.author) || l === lc(input.botLogin)) return false;
  if (input.appVerdicts && lc(who.userType ?? "") !== "bot") return false;
  return input.attesters.some((a) => lc(a) === l);
};

/** The latest `[review round N]` review (highest N, the later one on a tie) from an account that counts. */
const latestReview = (input: GateInput): { round: number; review: GateReview } | undefined => {
  let best: { round: number; review: GateReview } | undefined;
  for (const review of input.reviews) {
    const m = review.body.match(/^\s*\[review round (\d+)\]/);
    if (!m || !counts({ login: review.login, ...(review.userType ? { userType: review.userType } : {}) }, input)) continue;
    const round = Number(m[1]);
    if (!best || round >= best.round) best = { round, review };
  }
  return best;
};

const reviewProblem = (input: GateInput): string | undefined => {
  const latest = latestReview(input);
  if (!latest) return "no `[review round N]` review from a named attester (MERGE_GATE_ATTESTERS; never the PR author or the app)";
  if (lc(latest.review.commitId) !== lc(input.sha)) return `the latest review (round ${latest.round}) was written on ${latest.review.commitId.slice(0, 7) || "an unknown commit"}, not the head ${input.sha.slice(0, 7)}`;
  if (!/^VERDICT:\s*clean\s*$/i.test(lastLine(latest.review.body))) return `the latest review (round ${latest.round}) does not end \`VERDICT: clean\``;
  return undefined;
};

const verifyProblem = (input: GateInput): string | undefined => {
  const latest = [...input.comments].reverse().find((c) => /^\s*\[verify\]/.test(c.body) && counts(c, input));
  if (!latest) return `no \`[verify]\` comment from a named attester (MERGE_GATE_ATTESTERS; never the PR author or the app${input.appVerdicts ? ", and a bot account, never a person" : ""})`;
  // Not skipped in favour of an older one: a verifier who said `verified`, then `not verified`, must not be undone by editing the second.
  if (latest.edited) return "the latest `[verify]` comment was edited after it was posted";
  if (!/^VERDICT:\s*verified\s*$/i.test(lastLine(latest.body))) return "the latest `[verify]` comment does not end `VERDICT: verified`";
  if (!namesSha(latest.body, input.sha)) return `the latest \`[verify]\` comment does not name the head ${input.sha.slice(0, 7)}`;
  return undefined;
};

const flowAuditCheck = (input: GateInput): string | undefined => {
  if (input.attesters.length === 0) return "MERGE_GATE_ATTESTERS names no account, so nobody's flow audit counts";
  const latest = [...input.comments].reverse().find((c) => c.body.trimStart().toLowerCase().startsWith(FLOW_AUDIT_MARKER) && counts(c, input));
  if (!latest) return `no ${FLOW_AUDIT_MARKER} comment from a named attester (MERGE_GATE_ATTESTERS; never the PR author or the app)`;
  if (latest.edited) return `the latest ${FLOW_AUDIT_MARKER} comment was edited after it was posted`;
  return flowAuditProblem(latest.body, input.sha);
};

const VERDICT_WORDS = /^\s*(\[review round \d+\]|\[verify\]|\[flow-audit\])/i;

/**
 * With `appVerdicts`: every verdict-marked review or comment from a NAMED ATTESTER that is not a Bot, named once, so the
 * refusal says why that person's words do not count. A stranger's comment is ignored (never refused for), or any GitHub
 * user could block any PR of a public repo with one comment.
 */
const humanVerdicts = (input: GateInput): string[] => {
  const humans = new Set<string>();
  for (const x of [...input.reviews, ...input.comments]) {
    if (VERDICT_WORDS.test(x.body) && lc(x.userType ?? "") !== "bot" && lc(x.login) !== lc(input.pr.author) && input.attesters.some((a) => lc(a) === lc(x.login))) humans.add(x.login);
  }
  return [...humans];
};

/** With `appVerdicts` and the flow audit: the verifier and the flow auditor are two workers, so two accounts. */
const separateRoles = (input: GateInput): string | undefined => {
  const verify = [...input.comments].reverse().find((c) => /^\s*\[verify\]/i.test(c.body) && counts(c, input));
  const audit = [...input.comments].reverse().find((c) => c.body.trimStart().toLowerCase().startsWith(FLOW_AUDIT_MARKER) && counts(c, input));
  if (verify && audit && lc(verify.login) === lc(audit.login)) return `the \`[verify]\` and the \`[flow-audit]\` comments were both posted by ${verify.login}: the verifier and the flow auditor must be two separate workers (two accounts)`;
  return undefined;
};

export const evaluateGate = (input: GateInput): GateDecision => {
  const { pr } = input;
  if (pr.merged || pr.state !== "open") return { decision: "refused", reasons: [`the PR is ${pr.merged ? "already merged" : pr.state}`] };
  if (pr.draft) return { decision: "refused", reasons: ["the PR is a draft"] };
  if (lc(pr.headSha) !== lc(input.sha)) return { decision: "pending", reasons: [`the PR head is ${pr.headSha.slice(0, 7)}, waiting for ${input.sha.slice(0, 7)} (pushed?)`] };
  if (pr.mergeable === false || pr.mergeState === "dirty") return { decision: "conflict", reasons: ["the PR conflicts with its base: merge the base in, resolve, push"] };

  const refused: string[] = [];
  const pending: string[] = [];
  const names = [...new Set(input.checks.map((c) => c.name))];
  for (const name of names) {
    const v = verdictOf(input.checks.filter((c) => c.name === name));
    const required = input.requiredChecks.includes(name);
    if (typeof v === "object") refused.push(`check ${name}: ${v.red}`);
    else if (v === "running") pending.push(`check ${name} is still running`);
    else if (v === "none-cancelled" && !required) refused.push(`check ${name}: cancelled`);
    else if (v !== "good" && required) pending.push(`required check ${name} has not run on this head (only ${v === "none-cancelled" ? "cancelled" : "skipped"} runs so far)`);
  }
  for (const name of input.requiredChecks) if (!names.includes(name)) pending.push(`required check ${name} has not appeared yet`);

  const runtime = input.filesComplete === false || touchesRuntime(input.files);
  if (input.files.length === 0) refused.push("the PR changes no files");
  if (runtime && input.attesters.length === 0) refused.push("MERGE_GATE_ATTESTERS names no account, so nobody's review or verify counts for runtime code");
  else if (runtime) {
    const r = reviewProblem(input);
    if (r) refused.push(r);
    const v = verifyProblem(input);
    if (v) refused.push(v);
  }
  if (input.flowAudit) {
    const a = flowAuditCheck(input);
    if (a) refused.push(a);
  }
  if (input.appVerdicts) {
    for (const h of humanVerdicts(input)) refused.push(`a review, verify or flow-audit was posted by ${h}, a human account: MERGE_GATE_APP_VERDICTS counts bot accounts only`);
    if (input.flowAudit) {
      const sep = separateRoles(input);
      if (sep) refused.push(sep);
    }
  }
  if (refused.length > 0) return { decision: "refused", reasons: refused };
  if (pending.length > 0) return { decision: "pending", reasons: [...new Set(pending)] };
  if (pr.mergeable === null || pr.mergeState === "unknown") return { decision: "pending", reasons: ["GitHub has not worked out yet whether the PR merges cleanly"] };
  return { decision: "merge", runtime };
};

/** `MERGE_GATE_REQUIRED_CHECKS` / `MERGE_GATE_ATTESTERS`: a comma list, blanks dropped. */
export const parseGateList = (v: string | undefined, fallback: readonly string[] = []): string[] => {
  const items = (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return items.length > 0 ? items : [...fallback];
};

export const DEFAULT_REQUIRED_CHECKS: readonly string[] = ["checks", "gitleaks"];
