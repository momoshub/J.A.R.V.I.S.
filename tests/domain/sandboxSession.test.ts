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
    expect(verifySession("s3cret", `${t.slice(0, -1)}0`, NOW).ok).toBe(false);
  });

  test("anything that is not a session is malformed, and an empty secret verifies nothing", () => {
    for (const bad of ["", "jvsb_", "jvsb_12_zz", "jvwk_abc", "jvsb_1_" + "a".repeat(63)]) {
      expect(verifySession("s3cret", bad, NOW)).toEqual({ ok: false, reason: "malformed" });
    }
    expect(verifySession("", mintSession("", NOW + 1), NOW)).toEqual({ ok: false, reason: "malformed" });
  });
});
