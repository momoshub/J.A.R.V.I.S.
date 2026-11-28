#!/usr/bin/env bun
//
// The brief of the full-flow bullshit detector (README, "Auditing the review flow").
//
//   flow-audit-brief.ts brief --pr <n> [--repo <owner/name>] [--out <file>] [--attesters <a,b>] [--claims-file <file>]
//   flow-audit-brief.ts check --comment <file> --sha <head sha>
//
// `brief` reads the PR's own record through gh - every push sha with its time, every review and
// comment with the sha it names, the check runs per sha - computes the gaps a script can find
// (push after the last clean review, verify sha != head, CI not on the head, a figure with no
// artifact, the round cap) and assembles the auditor's brief. The policy text and the required
// checks are read from origin/main with `git show`, never from the PR branch (a diff that edits
// the policy must not feed its own words into its audit): run it from a checkout of origin/main.
// `check` fails a `[flow-audit]` comment that is malformed, names another sha, contradicts its
// own table, or says `VERDICT: bullshit found`: the same rule the merge gate applies.
//
// Exit: 0 ok, 1 the run could not finish or the check failed, 2 usage.
import { readFileSync, writeFileSync } from "node:fs";
import {
  type FlowCheck,
  type FlowItem,
  type FlowPush,
  type RoundDiff,
  attestersFrom,
  buildFlowAuditBrief,
  FLOW_AUDIT_USAGE,
  flowAuditProblem,
  markerOf,
  parseFlowAudit,
  parseFlowAuditArgs,
} from "../src/domain/flowAudit.ts";
import { touchesRuntime } from "../src/domain/mergeGate.ts";

const fail = (message: string, code = 1): never => {
  console.error(message);
  process.exit(code);
};

const run = (cmd: readonly string[]): { ok: boolean; out: string; err: string } => {
  const r = Bun.spawnSync([...cmd], { stdout: "pipe", stderr: "pipe", maxBuffer: 256 * 1024 * 1024 });
  return { ok: r.exitCode === 0, out: r.stdout.toString(), err: r.stderr.toString().trim() };
};
const git = (...a: string[]): string => {
  const r = run(["git", ...a]);
  return r.ok ? r.out : fail(`git ${a.join(" ")} failed: ${r.err}`);
};
const gh = (...a: string[]): string => {
  const r = run(["gh", ...a]);
  return r.ok ? r.out : fail(`gh ${a.join(" ")} failed: ${r.err}`);
};
/** One JSON value per line out of a paginated `-q` filter. */
const ghLines = <T>(path: string, filter: string): T[] =>
  gh("api", path, "--paginate", "-q", filter)
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as T);

let args: ReturnType<typeof parseFlowAuditArgs>;
try {
  args = parseFlowAuditArgs(process.argv.slice(2));
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  console.error(FLOW_AUDIT_USAGE);
  process.exit(2);
}

if (args.cmd === "help") {
  console.log(FLOW_AUDIT_USAGE);
} else if (args.cmd === "check") {
  const body = readFileSync(args.comment, "utf8");
  const parsed = parseFlowAudit(body);
  const problem = flowAuditProblem(body, args.sha);
  console.log(`verdict: ${parsed.ok ? parsed.verdict : "malformed"}; sha: ${parsed.ok ? parsed.sha : "-"}${problem ? `; ${problem}` : ""}`);
  process.exit(problem ? 1 : 0);
} else {
  const repo = args.repo ?? run(["gh", "repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"]).out.trim();
  if (!repo) fail("pass --repo <owner/name> or run inside a checkout gh can name");
  const pr = args.pr;

  // policy: origin/main, never the PR branch or the working tree
  git("fetch", "-q", "origin", "main");
  const policySha = git("rev-parse", "origin/main").trim();
  const show = (path: string): string | undefined => {
    const r = run(["git", "show", `${policySha}:${path}`]);
    return r.ok ? r.out : undefined;
  };
  const docs = ["SECURITY.md", "ARCHITECTURE.md", "AGENTS.md"].flatMap((name) => {
    const text = show(name);
    return text === undefined ? [] : [{ name, text }];
  });
  const requiredChecks = (show("src/domain/mergeGate.ts")?.match(/DEFAULT_REQUIRED_CHECKS[^=]*=\s*\[([^\]]*)\]/)?.[1] ?? '"checks", "gitleaks"')
    .split(",")
    .map((s) => s.trim().replace(/^"|"$/g, ""))
    .filter(Boolean);
  if (run(["git", "diff", "--quiet", policySha, "--", "bin/flow-audit-brief.ts", "src/domain/flowAudit.ts"]).ok === false && show("bin/flow-audit-brief.ts") !== undefined)
    console.error("warning: this checkout's flow-audit code differs from origin/main: run it from a checkout of origin/main, not the PR branch");

  const pull = JSON.parse(gh("api", `repos/${repo}/pulls/${pr}`)) as { head: { sha: string; ref: string }; base: { ref: string }; user: { login: string }; body: string | null };
  const head = pull.head.sha;
  git("fetch", "-q", "origin", `refs/pull/${pr}/head`);

  const files = gh("api", `repos/${repo}/pulls/${pr}/files`, "--paginate", "-q", ".[] | .filename, (.previous_filename // empty)")
    .split("\n")
    .map((x) => x.trim())
    .filter(Boolean);
  const reviews = ghLines<FlowItem>(
    `repos/${repo}/pulls/${pr}/reviews`,
    '.[] | {id: ("review-" + (.id | tostring)), kind: "review", login: (.user.login // ""), time: (.submitted_at // ""), body: (.body // ""), commitId: (.commit_id // ""), userType: (.user.type // "")}',
  ).filter((r) => r.body.trim() !== "");
  const comments = ghLines<FlowItem>(
    `repos/${repo}/issues/${pr}/comments`,
    '.[] | {id: ("comment-" + (.id | tostring)), kind: "comment", login: (.user.login // ""), time: .created_at, body: (.body // ""), edited: (.updated_at != .created_at), userType: (.user.type // "")}',
  );
  const items = [...reviews, ...comments];

  // pushes with the time of the push (the activity feed); the commit list is only a fallback
  let pushes: FlowPush[];
  let pushSource = "the repository activity feed (push and force_push events of the branch)";
  const act = run(["gh", "api", `repos/${repo}/activity?ref=refs/heads/${pull.head.ref}&per_page=100`, "--paginate", "-q", '.[] | select(.activity_type == "push" or .activity_type == "force_push") | {sha: .after, time: .timestamp, force: (.activity_type == "force_push")}']);
  if (act.ok && act.out.trim()) {
    pushes = act.out.split("\n").filter(Boolean).map((l) => JSON.parse(l) as FlowPush);
  } else {
    pushSource = "the PR's commit list: the time is the COMMIT's, a push may have come later (the activity feed was not available)";
    pushes = ghLines<FlowPush>(`repos/${repo}/pulls/${pr}/commits`, ".[] | {sha: .sha, time: .commit.committer.date}");
  }
  pushes.sort((a, b) => Date.parse(a.time) - Date.parse(b.time));

  // check runs of every sha that was pushed or reviewed, and the head (the last 30: a runaway branch must not loop for ever)
  const shas = [...new Set([...pushes.map((p) => p.sha), ...items.flatMap((i) => (i.commitId ? [i.commitId] : [])), head])].slice(-30);
  const checks: FlowCheck[] = shas.flatMap((sha) => {
    const r = run(["gh", "api", `repos/${repo}/commits/${sha}/check-runs`, "--paginate", "-q", ".check_runs[] | {name: .name, status: .status, conclusion: .conclusion}"]);
    return r.ok ? r.out.split("\n").filter(Boolean).map((l) => ({ sha, ...(JSON.parse(l) as Omit<FlowCheck, "sha">) })) : [];
  });

  // what each fix round changed: from the head its review was written on to the head the fix comment answered
  const roundDiffs: RoundDiff[] = items
    .flatMap((i) => {
      const m = markerOf(i.body);
      if (m.kind !== "fix") return [];
      const review = items.find((r) => r.kind === "review" && markerOf(r.body).kind === "review" && markerOf(r.body).round === m.round && r.commitId);
      const to = [...pushes].reverse().find((p) => Date.parse(p.time) <= Date.parse(i.time))?.sha ?? head;
      return review?.commitId ? [{ label: `${i.id} [fix round ${m.round}]`, from: review.commitId, to }] : [];
    })
    .map((d) => {
      const r = run(["git", "diff", "--stat", "--stat-width=200", `${d.from}..${d.to}`]);
      return { ...d, stat: r.ok ? r.out.trim() || "(no change between the two shas)" : `(not computed: ${r.err.slice(0, 160)}: a force-pushed sha may be gone)` };
    });

  const brief = buildFlowAuditBrief({
    pr,
    repo,
    author: pull.user.login,
    head,
    base: `origin/${pull.base.ref}`,
    policySha,
    files,
    runtime: touchesRuntime(files),
    prBody: pull.body ?? "",
    pushes,
    pushSource,
    items,
    checks,
    requiredChecks,
    attesters: attestersFrom(args.attesters, process.env.MERGE_GATE_ATTESTERS),
    docs,
    roundDiffs,
    ...(args.claimsFile ? { claims: readFileSync(args.claimsFile, "utf8") } : {}),
  });
  if (args.out) writeFileSync(args.out, brief);
  else process.stdout.write(brief);
}
