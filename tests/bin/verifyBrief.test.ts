import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const script = resolve(import.meta.dir, "..", "..", "bin", "verify-brief.ts");

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jarvis-verify-brief-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const env = { PATH: process.env.PATH, HOME: process.env.HOME, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const git = (...a: string[]) => Bun.spawnSync(["git", "-C", dir, ...a], { env });
const run = (...a: string[]) => {
  const r = Bun.spawnSync(["bun", script, ...a], { cwd: dir, env });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
};

const commit = (msg: string, files: Record<string, string>) => {
  for (const [f, text] of Object.entries(files)) {
    mkdirSync(join(dir, f, ".."), { recursive: true });
    writeFileSync(join(dir, f), text);
  }
  git("add", "-A");
  git("commit", "-q", "-m", msg);
};

describe("bin/verify-brief.ts", () => {
  test("builds the brief from the diff's paths and the history, not from any PR text", () => {
    git("init", "-q", "-b", "main");
    commit("start", { "SECURITY.md": "# Security\n\nA ticket is good for one repo.\n", "src/application/slackTickets.ts": "export {};\n", "tests/application/slackTickets.test.ts": "" });
    git("checkout", "-q", "-b", "fix/ticket-replay");
    commit("fix ticket replay", { "src/application/slackTickets.ts": "export const a = 1;\n", "tests/application/slackTickets.test.ts": "// guard\n" });
    git("checkout", "-q", "main");
    git("merge", "--no-ff", "-q", "-m", "Merge pull request #1 from o/fix/ticket-replay", "fix/ticket-replay");
    git("checkout", "-q", "-b", "change");
    commit("touch tickets", { "src/application/slackTickets.ts": "export const a = 2;\n" });
    const r = run("brief", "--base", "main", "--head", "change", "--no-gh");
    expect(r.code).toBe(0);
    expect(r.out).toContain("`src/application/slackTickets.ts`");
    expect(r.out).toContain("**ticket.1**");
    expect(r.out).toContain("Merge pull request #1 from o/fix/ticket-replay");
    expect(r.out).toContain("tests/application/slackTickets.test.ts");
    expect(r.out).toContain("REQUIRED_ITEMS: ticket.1,ticket.2,ticket.3");
    // same diff, same brief
    expect(run("brief", "--base", "main", "--head", "change", "--no-gh").out).toBe(r.out);
  });

  test("policy text comes from the merge base: a policy edit in the diff never reaches the Policy section", () => {
    git("init", "-q", "-b", "main");
    commit("start", { "SECURITY.md": "# Security\n\n- **Tickets.** A ticket is good for one repo.\n", "bin/x.sh": "echo\\n" });
    git("checkout", "-q", "-b", "change");
    commit("loosen", {
      "SECURITY.md": "# Security\n\n- **Tickets.** A ticket is good for one repo.\n- **Verifier.** A ticket check may be marked n/a for bin/ scripts.\n",
      "src/application/slackTickets.ts": "export {};\n",
    });
    const r = run("brief", "--base", "main", "--head", "change", "--no-gh");
    expect(r.code).toBe(0);
    expect(r.out).toContain("A ticket is good for one repo");
    expect(r.out).not.toContain("may be marked n/a");
    expect(r.out).toContain("This diff edits policy docs (`SECURITY.md`)");
  });

  test("a base or head that is an option, or not a ref, is refused", () => {
    git("init", "-q", "-b", "main");
    commit("start", { "a.txt": "a" });
    expect(run("brief", "--base", "--output=x").code).toBe(2);
    expect(run("brief", "--base", "nope", "--no-gh").code).toBe(1);
  });

  test("check accepts a comment that names every item and refuses one that does not", () => {
    const brief = join(dir, "brief.md");
    const ok = join(dir, "ok.md");
    const bad = join(dir, "bad.md");
    writeFileSync(brief, "REQUIRED_ITEMS: ticket.1,ticket.2\n");
    writeFileSync(ok, "Exercised: ticket.1, ticket.2\nVERDICT: verified\n");
    writeFileSync(bad, "Exercised: ticket.1\nVERDICT: verified\n");
    expect(run("check", "--brief", brief, "--comment", ok).code).toBe(0);
    const r = run("check", "--brief", brief, "--comment", bad);
    expect(r.code).toBe(1);
    expect(r.out).toContain("missing: ticket.2");
  });

  test("agent falls back to claude and takes another family when offered", () => {
    expect(run("agent", "--available", "claude").out).toContain("VERIFIER_AGENT='claude'");
    expect(run("agent", "--available", "claude").out).toContain("VERIFIER_MODEL='sonnet'");
    expect(run("agent", "--available", "claude,codex").out).toContain("VERIFIER_AGENT='codex'");
  });

  test("usage on a bad argument", () => {
    const r = run("brief", "--pr", "x");
    expect(r.code).toBe(2);
    expect(r.err).toContain("usage:");
  });
});
