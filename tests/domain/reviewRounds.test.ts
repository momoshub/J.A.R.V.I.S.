import { describe, expect, test } from "bun:test";
import {
  capText,
  DEFAULT_ROUND_LIMITS,
  nextStep,
  noRoundTokenText,
  roundStartText,
  type FollowState,
  type RoundLimits,
} from "../../src/domain/reviewRounds.ts";

const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);
const LIM: RoundLimits = { maxRounds: 5, idleMs: 7 * 86_400_000, debounceMs: 120_000 };
const follow = (over: Partial<FollowState> = {}): FollowState => ({
  lastHead: A,
  handledHead: A,
  round: 1,
  observedHead: "",
  observedAt: 0,
  lastPushAt: 1000,
  ...over,
});
const open = (headSha: string) => ({ state: "OPEN" as const, headSha });

describe("round limits", () => {
  test("the defaults are 5 rounds, a week and a 2 minute quiet period", () => {
    expect(DEFAULT_ROUND_LIMITS).toEqual({ maxRounds: 5, idleMs: 7 * 86_400_000, debounceMs: 120_000 });
  });
});

describe("nextStep", () => {
  test("the head the last round reviewed is nothing to do", () => {
    expect(nextStep(follow(), open(A), 2000, LIM)).toEqual({ kind: "none" });
  });

  test("a head nobody reviewed starts the quiet period instead of a round", () => {
    expect(nextStep(follow(), open(B), 2000, LIM)).toEqual({ kind: "observe", head: B });
  });

  test("it waits while the head has been still for less than the quiet period", () => {
    const f = follow({ observedHead: B, observedAt: 2000 });
    expect(nextStep(f, open(B), 2000 + 119_999, LIM)).toEqual({ kind: "wait" });
  });

  test("a burst of pushes keeps resetting it: only the head that stays gets the round", () => {
    const seen = follow({ observedHead: B, observedAt: 2000 });
    // another push before the quiet period ran out: the clock starts over on the new head
    expect(nextStep(seen, open(C), 2000 + 60_000, LIM)).toEqual({ kind: "observe", head: C });
    // and one round then covers the whole burst
    const settled = follow({ observedHead: C, observedAt: 62_000 });
    expect(nextStep(settled, open(C), 62_000 + 120_000, LIM)).toEqual({
      kind: "run",
      round: { number: 2, from: A, to: C },
    });
  });

  test("a stable head runs the next round, from the last reviewed head to this one", () => {
    const f = follow({ round: 3, observedHead: B, observedAt: 2000 });
    expect(nextStep(f, open(B), 2000 + 120_000, LIM)).toEqual({ kind: "run", round: { number: 4, from: A, to: B } });
  });

  test("a head handled without a review is nothing new, and the next delta still starts at the last reviewed head", () => {
    const f = follow({ handledHead: B });
    expect(nextStep(f, open(B), 5000, LIM)).toEqual({ kind: "none" });
    const next = follow({ handledHead: B, observedHead: C, observedAt: 2000 });
    expect(nextStep(next, open(C), 2000 + 120_000, LIM)).toEqual({ kind: "run", round: { number: 2, from: A, to: C } });
  });

  test("a head that went back to the reviewed one forgets what was seen", () => {
    const f = follow({ observedHead: B, observedAt: 2000 });
    expect(nextStep(f, open(A), 5000, LIM)).toEqual({ kind: "clear" });
  });

  test("merged and closed PRs stop at once, silently, even with a push waiting", () => {
    const f = follow({ observedHead: B, observedAt: 2000 });
    expect(nextStep(f, { state: "MERGED", headSha: B }, 999_999, LIM)).toEqual({ kind: "stop", reason: "merged", say: false });
    expect(nextStep(f, { state: "CLOSED", headSha: A }, 999_999, LIM)).toEqual({ kind: "stop", reason: "closed", say: false });
  });

  test("the cap is reached only when one more round would have run, and says so once", () => {
    const f = follow({ round: 5, observedHead: B, observedAt: 2000 });
    expect(nextStep(f, open(B), 2000 + 119_999, LIM)).toEqual({ kind: "wait" });
    expect(nextStep(f, open(B), 2000 + 120_000, LIM)).toEqual({ kind: "stop", reason: "cap", say: true });
    // a PR on its last round that nobody pushes to is not stopped by the cap
    expect(nextStep(follow({ round: 5 }), open(A), 5000, LIM)).toEqual({ kind: "none" });
    // a configured cap of 2
    const two = { ...LIM, maxRounds: 2 };
    expect(nextStep(follow({ round: 1, observedHead: B, observedAt: 0 }), open(B), 200_000, two)).toMatchObject({ kind: "run" });
    expect(nextStep(follow({ round: 2, observedHead: B, observedAt: 0 }), open(B), 200_000, two)).toMatchObject({ kind: "stop", reason: "cap" });
  });

  test("a PR nobody pushed to for the idle window stops, silently", () => {
    const week = 7 * 86_400_000;
    expect(nextStep(follow({ lastPushAt: 1000 }), open(A), 1000 + week - 1, LIM)).toEqual({ kind: "none" });
    expect(nextStep(follow({ lastPushAt: 1000 }), open(A), 1000 + week, LIM)).toEqual({ kind: "stop", reason: "idle", say: false });
  });

  test("a push inside the idle window is reviewed even when the window ran out meanwhile", () => {
    const week = 7 * 86_400_000;
    const f = follow({ lastPushAt: 1000 + week - 10, observedHead: B, observedAt: 1000 + week - 10 });
    expect(nextStep(f, open(B), 1000 + week + 200_000, LIM)).toMatchObject({ kind: "run" });
  });
});

describe("thread lines", () => {
  test("the round line names the round and the commits it covers", () => {
    expect(roundStartText("https://github.com/o/r/pull/1", { number: 2, from: A, to: B })).toBe(
      "🔁 round 2 on https://github.com/o/r/pull/1 - new commits `aaaaaaa..bbbbbbb`",
    );
  });

  test("the cap line says how to start over", () => {
    expect(capText("https://github.com/o/r/pull/1", 5, B, "asking for a review again")).toContain("5 rounds");
    expect(capText("https://github.com/o/r/pull/1", 5, B, "asking for a review again")).toContain("asking for a review again starts over");
  });

  test("the no-token line says whose token is missing", () => {
    const t = noRoundTokenText("https://github.com/o/r/pull/1", 3, B, "<@U1>");
    expect(t).toContain("round 3");
    expect(t).toContain("<@U1> has no Claude Code token on file");
  });
});
