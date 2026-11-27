import { describe, expect, test } from "bun:test";
import { isSessionToken, mintSession, SESSION_PREFIX, verifySession } from "../../src/domain/sandboxSession.ts";

const NOW = 1_800_000_000;

describe("sandbox session", () => {
  test("a minted session verifies with the same secret until it expires", () => {
    const t = mintSession("s3cret", NOW + 100);
    expect(isSessionToken(t)).toBe(true);
    expect(t.startsWith(SESSION_PREFIX)).toBe(true);
    expect(verifySession("s3cret", t, NOW)).toEqual({ ok: true, expiresAt: NOW + 100 });
    expect(verifySession("s3cret", t, NOW + 100)).toEqual({ ok: false, reason: "expired" });
  });

  test("another secret, a changed expiry and a changed signature are refused", () => {
    const t = mintSession("s3cret", NOW + 100);
    expect(verifySession("other", t, NOW)).toEqual({ ok: false, reason: "bad-signature" });
    // moving the expiry later keeps the old signature, which no longer matches
    expect(verifySession("s3cret", t.replace(`_${NOW + 100}_`, `_${NOW + 99_999}_`), NOW)).toEqual({ ok: false, reason: "bad-signature" });
    expect(verifySession("s3cret", `${t.slice(0, -1)}${t.endsWith("0") ? "1" : "0"}`, NOW).ok).toBe(false);
  });

  test("a terminal handle is signed in: it verifies, and neither swapping nor adding one does", () => {
    const t = mintSession("s3cret", NOW + 100, "term_abc-1");
    expect(verifySession("s3cret", t, NOW)).toEqual({ ok: true, expiresAt: NOW + 100, handle: "term_abc-1" });
    expect(verifySession("s3cret", t.replace("term_abc-1", "term_other"), NOW)).toEqual({ ok: false, reason: "bad-signature" });
    const plain = mintSession("s3cret", NOW + 100);
    expect(verifySession("s3cret", `${plain}_term_victim`, NOW)).toEqual({ ok: false, reason: "bad-signature" });
    expect(verifySession("s3cret", plain, NOW)).toEqual({ ok: true, expiresAt: NOW + 100 });
    expect(verifySession("s3cret", `${plain}_nothandle`, NOW)).toEqual({ ok: false, reason: "malformed" });
  });

  test("anything that is not a session is malformed, and an empty secret verifies nothing", () => {
    for (const bad of ["", "jvsb_", "jvsb_12_zz", "jvwk_abc", "jvsb_1_" + "a".repeat(63)]) {
      expect(verifySession("s3cret", bad, NOW)).toEqual({ ok: false, reason: "malformed" });
    }
    expect(verifySession("", mintSession("", NOW + 1), NOW)).toEqual({ ok: false, reason: "malformed" });
  });
});

test("bin/sandbox-session.ts mints a session the bot's check accepts, with the worker's terminal signed in", async () => {
  const { mkdtempSync, readFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "sess-"));
  try {
    const file = join(dir, "sub", "secret");
    const run = (...a: string[]) => Bun.spawnSync({ cmd: ["bun", join(import.meta.dir, "..", "..", "bin", "sandbox-session.ts"), "mint", file, ...a] });
    const t = String(run("1", "term_w-1").stdout).trim();
    const secret = readFileSync(file, "utf8").trim();
    expect(verifySession(secret, t, Math.floor(Date.now() / 1000))).toMatchObject({ ok: true, handle: "term_w-1" });
    expect(verifySession(secret, String(run("1", "not a handle").stdout).trim(), Math.floor(Date.now() / 1000))).toEqual({ ok: true, expiresAt: expect.any(Number) });
    expect(run("0").exitCode).toBe(2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
