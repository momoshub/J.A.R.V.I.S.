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
  buildBrief,
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

const run = (cmd: readonly string[]): { ok: boolean; out: string } => {
  const r = Bun.spawnSync([...cmd], { stdout: "pipe", stderr: "pipe" });
  return { ok: r.exitCode === 0, out: r.stdout.toString() };
};
const git = (...a: string[]): string => {
  const r = run(["git", ...a]);
  return r.ok ? r.out : fail(`git ${a.join(" ")} failed`);
};

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
  console.log(`VERIFIER_AGENT=${pick.agent}`);
  console.log(`VERIFIER_MODEL_ARGS=${pick.model ? `--model ${pick.model}` : ""}`);
  console.log(`VERIFIER_NOTE=${pick.note}`);
} else if (args.cmd === "check") {
  const required = requiredItemsOf(readFileSync(args.brief, "utf8"));
  const res = checkVerdict(required, readFileSync(args.comment, "utf8"));
  console.log(`verdict: ${res.verdict}; exercised: ${res.exercised.join(",") || "-"}; missing: ${res.missing.join(",") || "-"}`);
  process.exit(res.ok ? 0 : 1);
} else {
  const head = git("rev-parse", args.head).trim();
  const pathsOut =
    args.pr !== undefined
      ? run(["gh", "pr", "diff", String(args.pr), "--name-only", ...(args.repo ? ["--repo", args.repo] : [])])
      : { ok: true, out: git("diff", "--name-only", `${args.base}...${head}`) };
  if (!pathsOut.ok) fail("could not read the diff's paths (gh pr diff --name-only failed)");
  const paths = pathsOut.out.split("\n").map((s) => s.trim()).filter(Boolean).sort();

  const known = git("ls-tree", "-r", "--name-only", head).split("\n").filter(Boolean);
  const docs = ["SECURITY.md", "ARCHITECTURE.md", "AGENTS.md"].flatMap((name) => {
    const r = run(["git", "show", `${head}:${name}`]);
    return r.ok ? [{ name, text: r.out }] : [];
  });

  // first-parent merges of the base branch with the files each one changed: one entry per PR
  const raw = git("log", "--first-parent", "-m", "--name-only", "--format=@@%H%x09%s", "-n", "600", args.base, "--", ...paths);
  const history: HistoryEntry[] = raw
    .split("@@")
    .filter(Boolean)
    .map((chunk) => {
      const [first = "", ...files] = chunk.split("\n");
      const [sha = "", subject = ""] = first.split("\t");
      return { sha, subject, files: files.map((f) => f.trim()).filter(Boolean) };
    });

  let blockers: PastBlocker[] | undefined;
  let blockersNote: string | undefined = args.gh ? undefined : "--no-gh";
  if (args.gh) {
    const prs = [...new Set(history.map((h) => prNumberOf(h.subject)).filter((n): n is number => n !== undefined))].slice(0, 20);
    const repo = args.repo ?? run(["gh", "repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"]).out.trim();
    if (!repo) blockersNote = "gh could not name the repo";
    else {
      blockers = [];
      for (const n of prs) {
        const r = run(["gh", "api", `repos/${repo}/pulls/${n}/reviews`, "--paginate", "-q", ".[].body"]);
        if (!r.ok) {
          blockers = undefined;
          blockersNote = "gh api failed";
          break;
        }
        // one review body per line break is ambiguous; split on the round marker instead
        const bodies = r.out.split(/\n(?=\[review round \d+\])/);
        blockers.push(...reviewBlockers(n, bodies));
      }
    }
  }

  const brief = buildBrief({
    ...(args.pr !== undefined ? { pr: args.pr } : {}),
    head,
    base: args.base,
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
