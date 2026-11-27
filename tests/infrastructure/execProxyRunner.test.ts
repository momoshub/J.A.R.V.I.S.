import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    const out = await createExecRunner({ ghBin: bin })("gh", [], { env: { ORCA_TERMINAL_HANDLE: "term_x" } });
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
