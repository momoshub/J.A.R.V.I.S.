import { describe, expect, test } from "bun:test";
import { createReviewGuard, prKey, REVIEW_COOLDOWN_MS } from "../../src/application/reviewGuard.ts";

const PR = "https://github.com/acme/acme-web/pull/8436";

describe("review guard", () => {
  test("the same PR written two ways is one key", () => {
    expect(prKey(PR)).toBe(prKey("https://github.com/Acme/acme-web/pull/8436"));
    expect(prKey(PR)).not.toBe(prKey("https://github.com/acme/acme-web/pull/8437"));
  });

  test("a second claim while the first runs gets the first one's thread", () => {
    const guard = createReviewGuard(() => 0);
    expect(guard.claim(PR, { channelId: "C1", threadTs: "1.1" })).toBeUndefined();
    expect(guard.claim(PR, { channelId: "C2", threadTs: "2.2" })).toEqual({ channelId: "C1", threadTs: "1.1" });
  });

  test("a finished review holds for the cooldown, then lets go", () => {
    let now = 0;
    const guard = createReviewGuard(() => now);
    guard.claim(PR, { channelId: "C1", threadTs: "1.1" });
    now = 1000;
    guard.release(PR);
    now = 1000 + REVIEW_COOLDOWN_MS - 1;
    expect(guard.claim(PR, { channelId: "C2" })?.doneAt).toBe(1000);
    now = 1000 + REVIEW_COOLDOWN_MS;
    expect(guard.claim(PR, { channelId: "C2" })).toBeUndefined();
  });

  test("a later round is not held by the cooldown of the review before it, but never by one still running", () => {
    let now = 0;
    const guard = createReviewGuard(() => now);
    guard.claim(PR, { channelId: "C1", threadTs: "1.1" });
    expect(guard.claim(PR, { channelId: "C1" }, { ignoreCooldown: true })).toEqual({ channelId: "C1", threadTs: "1.1" });
    now = 1000;
    guard.release(PR);
    now = 2000;
    expect(guard.claim(PR, { channelId: "C1" })?.doneAt).toBe(1000);
    expect(guard.claim(PR, { channelId: "C1", threadTs: "2.2" }, { ignoreCooldown: true })).toBeUndefined();
    expect(guard.claim(PR, { channelId: "C9" }, { ignoreCooldown: true })).toEqual({ channelId: "C1", threadTs: "2.2" });
  });

  test("other PRs are not held up", () => {
    const guard = createReviewGuard(() => 0);
    guard.claim(PR, { channelId: "C1" });
    expect(guard.claim("https://github.com/o/r/pull/1", { channelId: "C1" })).toBeUndefined();
  });
});
