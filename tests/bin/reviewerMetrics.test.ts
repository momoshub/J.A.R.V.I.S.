import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

const script = resolve(import.meta.dir, "..", "..", "bin", "reviewer-metrics.ts");
// every path below exits on its arguments before `gh` is ever called, so no GitHub request is made
const run = (...args: string[]) => {
  const p = Bun.spawnSync([process.execPath, script, ...args]);
  return { code: p.exitCode, out: new TextDecoder().decode(p.stdout), err: new TextDecoder().decode(p.stderr) };
};

describe("bin/reviewer-metrics.ts", () => {
  test("--help prints the usage", () => {
    const r = run("--help");
    expect(r.code).toBe(0);
    expect(r.out).toContain("usage: bun bin/reviewer-metrics.ts");
  });

  test("bad arguments exit 2 with the usage", () => {
    for (const args of [["--limit", "0"], ["--limit", "x"], ["--window-days", "0"], ["--since", "yesterday"], ["--nope"], ["--repo"]]) {
      const r = run(...args);
      expect(r.code).toBe(2);
      expect(r.err).toContain("usage:");
    }
  });
});
