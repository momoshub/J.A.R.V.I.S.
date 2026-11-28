import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const script = resolve(import.meta.dir, "..", "..", "bin", "risk-class.ts");

let dir: string;
let home: string;
const sh = (...cmd: string[]) => {
  const p = Bun.spawnSync(cmd, { cwd: dir, env: { PATH: process.env.PATH, HOME: home, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  return { code: p.exitCode, out: new TextDecoder().decode(p.stdout), err: new TextDecoder().decode(p.stderr) };
};
const run = (...args: string[]) => sh("bun", script, ...args);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jarvis-risk-test-"));
  home = mkdtempSync(join(tmpdir(), "jarvis-risk-home-"));
  sh("git", "init", "-q", "-b", "main");
  writeFileSync(join(dir, "README.md"), "hello\n");
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src", "a.ts"), "export const a = 1;\n");
  sh("git", "add", ".");
  sh("git", "commit", "-q", "-m", "base");
  sh("git", "branch", "base");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

describe("bin/risk-class.ts", () => {
  test("--help prints the usage, a bad flag exits 2", () => {
    expect(run("--help").out).toContain("usage: bun bin/risk-class.ts");
    const r = run("--nope");
    expect(r.code).toBe(2);
    expect(r.err).toContain("usage:");
  });

  test("no change is docs", () => {
    const r = run("--base", "base", "--json");
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out).class).toBe("docs");
  });

  test("a docs-only commit needs no reviewer", () => {
    writeFileSync(join(dir, "README.md"), "hello\nmore prose\n");
    sh("git", "commit", "-qam", "docs");
    const r = run("--base", "base");
    expect(r.out).toContain("risk class: docs");
    expect(r.out).toContain("reviewer: no");
  });

  test("committed, uncommitted and untracked changes all count", () => {
    writeFileSync(join(dir, "README.md"), "hello\nmore prose\n");
    sh("git", "commit", "-qam", "docs");
    writeFileSync(join(dir, "src", "a.ts"), "export const a = 1;\nexport const t = process.env.GH_TOKEN;\n");
    writeFileSync(join(dir, "src", "new.ts"), "export const b = 2;\n");
    const r = JSON.parse(run("--base", "base", "--json").out);
    expect(r.class).toBe("capability");
    expect(r.routing).toEqual({ reviewer: true, verifier: true, probe: false });
    expect(r.files.map((f: { path: string }) => f.path).sort()).toEqual(["README.md", "src/a.ts", "src/new.ts"]);
  });

  test("an untracked file alone is an addition", () => {
    writeFileSync(join(dir, "src", "new.ts"), "export const b = 2;\n");
    expect(run("--base", "base").out).toContain("risk class: runtime");
  });

  test("--diff reads a unified diff from a file or stdin", () => {
    writeFileSync(join(dir, "d.diff"), ["diff --git a/README.md b/README.md", "--- a/README.md", "+++ b/README.md", "@@ -1 +1,2 @@", " hello", "+x"].join("\n"));
    expect(run("--diff", "d.diff").out).toContain("risk class: docs");
    expect(run("--diff", "missing.diff").code).toBe(2);
  });

  test("a diff it cannot read is exit 2, never docs", () => {
    writeFileSync(join(dir, "empty.diff"), "");
    const empty = run("--diff", "empty.diff");
    expect(empty.code).toBe(2);
    expect(empty.err).toContain("empty");
    writeFileSync(join(dir, "plain.diff"), ["--- a/README.md", "+++ b/README.md", "@@ -1 +1,2 @@", " hello", "+x"].join("\n"));
    const headerless = run("--diff", "plain.diff");
    expect(headerless.code).toBe(2);
    expect(headerless.err).toContain("diff --git");
  });

  test("a checkout with diff.noprefix still reads its own diff", () => {
    sh("git", "config", "diff.noprefix", "true");
    writeFileSync(join(dir, "src", "a.ts"), "export const a = 1;\nexport const t = process.env.GH_TOKEN;\n");
    expect(run("--base", "base").out).toContain("risk class: capability");
  });

  test("an unknown base is an error, not a silent docs", () => {
    const r = run("--base", "nope");
    expect(r.code).toBe(2);
    expect(r.err).toContain("merge-base");
  });

  test("untracked files: a non-ASCII name and an executable doc-path file are read, a symlink or a directory does not crash it", () => {
    mkdirSync(join(dir, "docs"));
    writeFileSync(join(dir, "docs", "\u00e9.md"), "caf\u00e9\n");
    let r = run("--base", "base");
    expect(r.code).toBe(0);
    expect(r.out).toContain("risk class: docs");
    writeFileSync(join(dir, "docs", "setup.md"), "#!/bin/sh\necho hi\n", { mode: 0o755 });
    r = run("--base", "base");
    expect(r.code).toBe(0);
    expect(r.out).toContain("risk class: runtime");
    rmSync(join(dir, "docs", "setup.md"));
    symlinkSync("src", join(dir, "docs", "linkdir"));
    r = run("--base", "base");
    expect(r.code).toBe(0);
    expect(r.out).toContain("risk class: runtime");
  });

  test("an untracked file with a newline in its name cannot be written as a diff header: exit 2, never a docs report", () => {
    mkdirSync(join(dir, "docs"), { recursive: true });
    writeFileSync(join(dir, "docs", "a.md"), "more\n");
    writeFileSync(join(dir, "deploy\n.sh"), "#!/bin/sh\necho hi\n", { mode: 0o755 });
    const r = run("--base", "base");
    expect(r.code).toBe(2);
    expect(r.out).not.toContain("risk class: docs");
  });
});
