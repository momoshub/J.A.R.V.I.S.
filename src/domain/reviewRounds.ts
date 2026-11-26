/**
 * Review rounds - what happens to a PR after its first quick review.
 *
 * A PR that has had a review is followed: a new head commit pushed to it gets
 * the next round by itself, in the same thread, on the same person's token and
 * as the same identity. This module is the pure part: the limits, the decision
 * a poll takes from what it sees on the PR, and the lines that go in the
 * thread. The state itself lives in `review_rounds` (infrastructure/db/
 * reviewRoundRepo.ts) and the poll in application/reviewRounds.ts.
 */

/** Rounds a PR is followed for, the first one included (`REVIEW_ROUNDS_MAX`; 0 turns following off). */
export const DEFAULT_REVIEW_ROUNDS = 5;
/** Days without a push after which a reviewed PR is no longer followed (`REVIEW_ROUNDS_IDLE_DAYS`). */
export const DEFAULT_REVIEW_IDLE_DAYS = 7;
/** Minutes the head must stay still before a round starts, so a burst of pushes is one round. */
export const DEFAULT_REVIEW_DEBOUNCE_MIN = 2;

/** One round of a PR the review already covered: the head it reviewed last and the one it reviews now. */
export type ReviewRound = {
  /** 2 for the first re-review; round 1 is the review the person asked for. */
  readonly number: number;
  /** The head the previous round reviewed. */
  readonly from: string;
  /** The head this round reviews. */
  readonly to: string;
};

export type RoundLimits = {
  /** Rounds in all, the first included. 0 means following is off. */
  readonly maxRounds: number;
  readonly idleMs: number;
  readonly debounceMs: number;
};

export const DEFAULT_ROUND_LIMITS: RoundLimits = {
  maxRounds: DEFAULT_REVIEW_ROUNDS,
  idleMs: DEFAULT_REVIEW_IDLE_DAYS * 86_400_000,
  debounceMs: DEFAULT_REVIEW_DEBOUNCE_MIN * 60_000,
};

/** What a poll knows about a followed PR. */
export type FollowState = {
  /** The head the last round reviewed: the base of the next delta. */
  readonly lastHead: string;
  /** The last head dealt with, reviewed or not: a head equal to it is nothing new. */
  readonly handledHead: string;
  /** The number of the last round (1 for the review the person asked for). */
  readonly round: number;
  /** A head seen since, not yet reviewed ("" none), and when it was first seen. */
  readonly observedHead: string;
  readonly observedAt: number;
  /** When the PR last got a push (or, before any, when it was reviewed). */
  readonly lastPushAt: number;
};

export type PrNow = { readonly state: "OPEN" | "MERGED" | "CLOSED"; readonly headSha: string };

export type StopReason = "merged" | "closed" | "cap" | "idle";

export type RoundStep =
  /** Nothing to do. */
  | { readonly kind: "none" }
  /** The head went back to the reviewed one: forget what was seen. */
  | { readonly kind: "clear" }
  /** A head nobody reviewed was seen for the first time (or changed again): the quiet period starts over. */
  | { readonly kind: "observe"; readonly head: string }
  /** Seen, but not still for long enough. */
  | { readonly kind: "wait" }
  /** Review it: this round, from the last reviewed head to this one. */
  | { readonly kind: "run"; readonly round: ReviewRound }
  /** Follow no more. `say`: worth a line in the thread (the others are expected). */
  | { readonly kind: "stop"; readonly reason: StopReason; readonly say: boolean };

/**
 * What to do about a followed PR given what it looks like now. A burst of
 * pushes keeps resetting the quiet period, so one round covers all of them;
 * the cap is only reached when one more round would have run.
 */
export const nextStep = (f: FollowState, pr: PrNow, now: number, limits: RoundLimits): RoundStep => {
  if (pr.state === "MERGED") return { kind: "stop", reason: "merged", say: false };
  if (pr.state === "CLOSED") return { kind: "stop", reason: "closed", say: false };
  if (pr.headSha === f.handledHead) {
    if (now - f.lastPushAt >= limits.idleMs) return { kind: "stop", reason: "idle", say: false };
    return f.observedHead ? { kind: "clear" } : { kind: "none" };
  }
  if (pr.headSha !== f.observedHead) return { kind: "observe", head: pr.headSha };
  if (now - f.observedAt < limits.debounceMs) return { kind: "wait" };
  if (f.round >= limits.maxRounds) return { kind: "stop", reason: "cap", say: true };
  return { kind: "run", round: { number: f.round + 1, from: f.lastHead, to: pr.headSha } };
};

const short = (sha: string): string => sha.slice(0, 7);

/** The one line when a PR reached its round cap with a push still unreviewed. */
export const capText = (url: string, maxRounds: number, head: string, ask: string): string =>
  `🔁 ${url} got ${maxRounds} rounds and has a new push (\`${short(head)}\`) - I stop following it here. ${ask} starts over`;

/** The one line when a round cannot run because nobody can pay for it. */
export const noRoundTokenText = (url: string, round: number, head: string, who: string): string =>
  `🔑 round ${round} of ${url} (\`${short(head)}\`) did not run - ${who} has no Claude Code token on file, and a review only ever runs on the asker's own`;

/** The line that opens a round in the thread. */
export const roundStartText = (url: string, r: ReviewRound): string =>
  `🔁 round ${r.number} on ${url} - new commits \`${short(r.from)}..${short(r.to)}\``;
