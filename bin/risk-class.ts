#!/usr/bin/env bun
//
// What can this change do? Classify a diff by behaviour, not by folder.
//
//   risk-class.ts [--base <ref>] [--diff <file>|-] [--json]
//
// Default: the diff from the merge base with <base> to the working tree, plus
// untracked files, of the current directory (base defaults to origin/main), so it can run in a
// worktree before the commit or after the push. `--diff <file>` (or `-` for
// stdin) reads a unified diff instead, e.g. `gh pr diff <n>`.
//
// Prints the class (docs | prompt | runtime | capability) and what it owes:
// reviewer, verifier, probe gate. `--json` prints the whole report. Exit 0
// whatever the class (it routes, it does not gate), 2 on a usage problem or a
// diff it cannot read - the self-fix guide treats that as `runtime`.
// The rules are `classifyDiff` in src/domain/riskClass.ts.
import { lstatSync, readFileSync } from "node:fs";
import { classifyDiff, formatRiskReport, parseUnifiedDiff } from "../src/domain/riskClass.ts";

const USAGE = "usage: bun bin/risk-class.ts [--base <ref>] [--diff <file>|-] [--json]";
const fail = (msg: string): never => {
  console.error(msg);
  console.error(USAGE);
  process.exit(2);
};

let base = "origin/main";
let diffFile: string | undefined;
let json = false;
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--json") json = true;
  else if (a === "--base") base = args[++i] ?? fail("--base needs a ref");
  else if (a === "--diff") diffFile = args[++i] ?? fail("--diff needs a file or -");
  else if (a === "--help" || a === "-h") {
    console.log(USAGE);
    process.exit(0);
  } else fail(`unknown argument ${a}`);
}

const git = (...cmd: string[]): string => {
  const proc = Bun.spawnSync({ cmd: ["git", ...cmd], stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0) return fail(`git ${cmd.join(" ")} failed: ${new TextDecoder().decode(proc.stderr).trim()}`);
  return new TextDecoder().decode(proc.stdout);
};

const readDiff = (): string => {
  if (diffFile !== undefined) {
    try {
      return readFileSync(diffFile === "-" ? 0 : diffFile, "utf8");
    } catch {
      return fail(`cannot read ${diffFile}`);
    }
  }
  // committed work since the merge base and everything not committed yet, in one diff of the working tree
  const mergeBase = git("merge-base", base, "HEAD").trim();
  const tracked = git("diff", "--no-color", "--no-ext-diff", "--src-prefix=a/", "--dst-prefix=b/", mergeBase);
  // untracked files are additions: written as a diff here rather than touching the index
  // -z: names come back unquoted whatever their bytes; a directory or a symlink is not text, so it is an addition of mode 120000 (never docs)
  const added = git("ls-files", "-z", "--others", "--exclude-standard")
    .split("\0")
    .filter((f) => f !== "")
    .map((f) => {
      const st = lstatSync(f);
      if (st.isSymbolicLink() || st.isDirectory()) return `diff --git a/${f} b/${f}\nnew file mode 120000\n--- /dev/null\n+++ b/${f}\n@@ -0,0 +1 @@\n+symlink\n`;
      const mode = st.mode & 0o111 ? "100755" : "100644";
      const text = readFileSync(f, "utf8");
      if (text.includes("\0")) return `diff --git a/${f} b/${f}\nnew file mode ${mode}\nBinary files /dev/null and b/${f} differ\n`;
      const lines = text.split("\n");
      if (lines[lines.length - 1] === "") lines.pop();
      return `diff --git a/${f} b/${f}\nnew file mode ${mode}\n--- /dev/null\n+++ b/${f}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join("\n")}\n`;
    })
    .join("");
  return tracked + added;
};

const diffText = readDiff();
const parsed = parseUnifiedDiff(diffText);
// a diff that cannot be read must not look like "nothing changed": the guide treats exit 2 as `runtime`
if (diffFile !== undefined && diffText.trim() === "") fail("the diff is empty: nothing to classify, or the command that made it failed");
if (diffText.trim() !== "" && parsed.length === 0) fail("no `diff --git` file headers found: pass `git diff --src-prefix=a/ --dst-prefix=b/` or `gh pr diff` output");
const report = classifyDiff(parsed);
console.log(json ? JSON.stringify(report, null, 2) : formatRiskReport(report));
