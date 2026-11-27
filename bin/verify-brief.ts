#!/usr/bin/env bun
//
// A verifier brief that does not start from the writer's claim (README, "Verifying a PR").
//
//   verify-brief.ts brief (--pr <n> | [--base origin/main] [--head HEAD]) [--out <file>] [--no-gh]
//   verify-brief.ts agent [--available codex,claude] [--model sonnet]
//   verify-brief.ts check --brief <file> --comment <file>
//
// `brief` reads the diff's paths (never the PR body) and assembles, deterministically, the
// boundaries those paths cross with their adversarial cases, the policy text that governs
// them, the regression history of the same files on the base branch, past `[review round]`
// blockers (through gh, skipped with --no-gh) and the contracts those paths touch. `agent`
// picks the verifier's agent: another model family when the host has one, else claude.
// `check` fails a `[verify]` comment that does not name every item the brief required.
//
// Exit: 0 ok, 1 the run could not finish or the check failed, 2 usage.
import { readFileSync, writeFileSync } from "node:fs";
import {
  agentAssignments,
  buildBrief,
  POLICY_DOC_NAMES,
  checkVerdict,
  type HistoryEntry,
  type PastBlocker,
  OTHER_FAMILY_AGENTS,
  parseVerifyBriefArgs,
  pickVerifierAgent,
  prNumberOf,
  requiredItemsOf,
  reviewBlockers,
  VERIFY_BRIEF_USAGE,
} from "../src/domain/verifyBrief.ts";

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
const verifyRef = (ref: string): string => git("rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`).trim();

let args: ReturnType<typeof parseVerifyBriefArgs>;
try {
  args = parseVerifyBriefArgs(process.argv.slice(2));
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  console.error(VERIFY_BRIEF_USAGE);
  process.exit(2);
}

if (args.cmd === "help") {
  console.log(VERIFY_BRIEF_USAGE);
} else if (args.cmd === "agent") {
  const available = args.available ?? OTHER_FAMILY_AGENTS.filter((a) => Bun.which(a) !== null);
  const pick = pickVerifierAgent(available, args.model);
  console.log(agentAssignments(pick));
} else if (args.cmd === "check") {
  const required = requiredItemsOf(readFileSync(args.brief, "utf8"));
  const res = checkVerdict(required, readFileSync(args.comment, "utf8"));
  console.log(`verdict: ${res.verdict}; exercised: ${res.exercised.join(",") || "-"}; missing: ${res.missing.join(",") || "-"}`);
  process.exit(res.ok ? 0 : 1);
} else {
  // --pr: the head, the base and the file list are GitHub's view of the PR (paged, so a huge diff
  // works), never the local HEAD; --base/--head: refs in this checkout
  let head: string;
  let baseRef = args.base;
  let paths: string[];
  const repo =
    args.repo ?? (args.gh || args.pr !== undefined ? run(["gh", "repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"]).out.trim() : "");
  if (args.pr !== undefined) {
    if (!repo) fail("--pr needs the repo: pass --repo <owner/name> or run inside a checkout gh can name");
    const meta = JSON.parse(gh("api", `repos/${repo}/pulls/${args.pr}`, "-q", "{head: .head.sha, base: .base.ref}")) as { head: string; base: string };
    git("fetch", "-q", "origin", `refs/pull/${args.pr}/head`, meta.base);
    head = verifyRef(meta.head);
    baseRef = `origin/${meta.base}`;
    paths = gh("api", `repos/${repo}/pulls/${args.pr}/files`, "--paginate", "-q", ".[] | .filename, (.previous_filename // empty)")
      .split("\n").map((x) => x.trim()).filter(Boolean);
  } else {
    head = verifyRef(args.head);
    baseRef = args.base;
    paths = git("diff", "--name-only", `${verifyRef(baseRef)}...${head}`).split("\n").map((x) => x.trim()).filter(Boolean);
  }
  paths = [...new Set(paths)].sort();

  // what governs the change is read where the diff cannot reach it: at the merge base, not the head
  const baseSha = verifyRef(baseRef);
  const mergeBase = git("merge-base", baseSha, head).trim();
  const known = git("ls-tree", "-r", "--name-only", mergeBase).split("\n").filter(Boolean);
  const docs = POLICY_DOC_NAMES.flatMap((name) => {
    const r = run(["git", "show", `${mergeBase}:${name}`]);
    return r.ok ? [{ name, text: r.out }] : [];
  });

  // first-parent merges of the base branch with the files each one changed: one entry per PR
  // (a \x01 starts a record: a subject cannot carry one)
  const raw = git("log", "--first-parent", "-m", "--name-only", "--format=%x01%H%x09%s", "-n", "600", baseSha, "--", ...paths);
  const history: HistoryEntry[] = raw
    .split("\x01")
    .filter(Boolean)
    .map((chunk) => {
      const [first = "", ...files] = chunk.split("\n");
      const [sha = "", ...subject] = first.split("\t");
      return { sha, subject: subject.join("\t"), files: files.map((f) => f.trim()).filter(Boolean) };
    });

  let blockers: PastBlocker[] | undefined;
  let blockersNote: string | undefined = args.gh ? undefined : "--no-gh";
  if (args.gh) {
    const prs = [...new Set(history.map((h) => prNumberOf(h.subject)).filter((n): n is number => n !== undefined))].slice(0, 20);
    if (!repo) blockersNote = "gh could not name the repo";
    else {
      blockers = [];
      for (const n of prs) {
        // one JSON string per review body: a body with a blank line or a marker inside cannot bleed into the next
        const r = run(["gh", "api", `repos/${repo}/pulls/${n}/reviews`, "--paginate", "-q", ".[].body | @json"]);
        if (!r.ok) {
          blockers = undefined;
          blockersNote = `gh api failed: ${r.err.slice(0, 120)}`;
          break;
        }
        const bodies = r.out.split("\n").filter(Boolean).map((l) => JSON.parse(l) as string);
        blockers.push(...reviewBlockers(n, bodies));
      }
    }
  }

  const brief = buildBrief({
    ...(args.pr !== undefined ? { pr: args.pr } : {}),
    head,
    base: baseRef,
    paths,
    known,
    docs,
    history,
    ...(blockers ? { blockers } : {}),
    ...(blockersNote ? { blockersNote } : {}),
    ...(args.agentNote ? { agentNote: args.agentNote } : {}),
  });
  if (args.out) writeFileSync(args.out, brief);
  else process.stdout.write(brief);
}
