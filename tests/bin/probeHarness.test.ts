import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const script = resolve(import.meta.dir, "..", "..", "bin", "probe-harness.ts");

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jarvis-probe-test-"));
  writeFileSync(join(dir, "base.md"), "Be brief.");
  writeFileSync(join(dir, "cand.md"), "Be brief and lead with the answer.");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

// `claude` is not on PATH here: any run that reaches a model call would fail loudly.
const run = (...args: string[]) => {
  const proc = Bun.spawnSync(["bun", script, ...args], { cwd: dir, env: { PATH: process.env.PATH, HOME: dir } });
  return { code: proc.exitCode, out: new TextDecoder().decode(proc.stdout), err: new TextDecoder().decode(proc.stderr) };
};
const cases = resolve(import.meta.dir, "..", "..", "docs", "probe-cases");

describe("bin/probe-harness.ts", () => {
  test("--help prints the usage", () => {
    const r = run("--help");
    expect(r.code).toBe(0);
    expect(r.out).toContain("usage: bun bin/probe-harness.ts");
  });
  test("a usage problem exits 2 with the usage", () => {
    const r = run("--runs", "9", "--path", "x");
    expect(r.code).toBe(2);
    expect(r.err).toContain("--runs");
    expect(r.err).toContain("usage:");
  });
  test("--dry-run prints the estimate and the plan, calls no model, writes no report", () => {
    const r = run("--base", "base.md", "--candidate", "cand.md", "--cases", cases, "--dry-run");
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/5 cases x 2 runs x 2 versions \+ 10 judgements = 30 model calls, about [\d,]+ input and [\d,]+ output tokens/);
    expect(r.out).toContain("dry run: cases lead-with-answer");
    expect(readdirSync(dir).filter((f) => f !== "Library").sort()).toEqual(["base.md", "cand.md"]);
  });
  test("--max-cases and --runs shrink the plan", () => {
    const r = run("--base", "base.md", "--candidate", "cand.md", "--cases", cases, "--max-cases", "2", "--runs", "1", "--dry-run");
    expect(r.out).toContain("2 cases x 1 run x 2 versions + 2 judgements = 6 model calls");
  });
  test("identical texts are flagged", () => {
    const r = run("--base", "base.md", "--candidate", "base.md", "--cases", cases, "--dry-run");
    expect(r.out).toContain("identical");
  });
  test("a missing file, an empty file and a missing cases folder exit 1", () => {
    expect(run("--base", "nope.md", "--candidate", "cand.md", "--dry-run").err).toContain("cannot read nope.md");
    writeFileSync(join(dir, "empty.md"), "  \n");
    expect(run("--base", "empty.md", "--candidate", "cand.md", "--dry-run").code).toBe(1);
    const r = run("--base", "base.md", "--candidate", "cand.md", "--cases", join(dir, "none"), "--dry-run");
    expect(r.code).toBe(1);
    expect(r.err).toContain("cannot read cases");
  });
  test("--path reads the base from git at a ref", () => {
    const repo = resolve(import.meta.dir, "..", "..");
    const r = Bun.spawnSync(["bun", script, "--path", "package.json", "--base-ref", "HEAD", "--cases", cases, "--dry-run"], { cwd: repo, env: { PATH: process.env.PATH, HOME: dir } });
    expect(r.exitCode).toBe(0);
    expect(new TextDecoder().decode(r.stdout)).toContain("package.json@HEAD");
    const bad = Bun.spawnSync(["bun", script, "--path", "package.json", "--base-ref", "no-such-ref", "--cases", cases, "--dry-run"], { cwd: repo, env: { PATH: process.env.PATH, HOME: dir } });
    expect(bad.exitCode).toBe(1);
  });
});
