import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { createExecRunner } from "../../src/infrastructure/system/execProxyRunner.ts";

const dir = mkdtempSync(join(tmpdir(), "runner-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("the real command gets a minimal environment: none of the bot's tokens (gh --jq '$ENV' would print them)", async () => {
  const bin = join(dir, "fakegh");
  writeFileSync(bin, "#!/bin/sh\nenv | sort\n");
  chmodSync(bin, 0o755);
  process.env.SLACK_BOT_TOKEN = "xoxb-secret";
  process.env.GITHUB_APP_PRIVATE_KEY = "pem-secret";
  process.env.JARVIS_SANDBOXED = "1";
  try {
    const out = await createExecRunner({ ghBin: bin, workDir: join(dir, "work") })("gh", [], { env: { ORCA_TERMINAL_HANDLE: "term_x" } });
    expect(out.code).toBe(0);
    expect(out.stdout).not.toContain("secret");
    expect(out.stdout).not.toContain("SLACK_BOT_TOKEN");
    expect(out.stdout).not.toContain("JARVIS_SANDBOXED");
    expect(out.stdout).toContain("GH_PROMPT_DISABLED=1");
    expect(out.stdout).toContain("ORCA_TERMINAL_HANDLE=term_x");
    expect(out.stdout).toContain("PATH=");
  } finally {
    delete process.env.SLACK_BOT_TOKEN;
    delete process.env.GITHUB_APP_PRIVATE_KEY;
    delete process.env.JARVIS_SANDBOXED;
  }
});

test("each run starts in its own empty folder under workDir (never os.tmpdir()), git is told not to look above it, and the folder is removed", async () => {
  const bin = join(dir, "fakegh2");
  writeFileSync(bin, "#!/bin/sh\npwd -P\nls -A | wc -l\necho CEIL=$GIT_CEILING_DIRECTORIES\necho G=$GIT_CONFIG_GLOBAL $GIT_CONFIG_NOSYSTEM\n");
  chmodSync(bin, 0o755);
  const work = join(dir, "work2");
  const out = await createExecRunner({ ghBin: bin, workDir: work })("gh", [], {});
  const [cwd, count, ceil, g] = out.stdout.trim().split("\n");
  expect(cwd?.startsWith(realpathSync(work))).toBe(true);
  expect(cwd).not.toBe(realpathSync(tmpdir()));
  expect(count?.trim()).toBe("0");
  expect(ceil).toBe(`CEIL=${work}`);
  expect(g).toBe("G=/dev/null 1");
  expect(existsSync(cwd ?? "")).toBe(false);
});
