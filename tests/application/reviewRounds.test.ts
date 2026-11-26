import { beforeEach, describe, expect, test } from "bun:test";
import type { ReviewStart } from "../../src/application/commands.ts";
import { createReviewRounds, ROUND_POLL_MS, type ReviewedReport, type ReviewRounds } from "../../src/application/reviewRounds.ts";
import type { PrNow } from "../../src/domain/reviewRounds.ts";
import type { AllowedUser } from "../../src/domain/types.ts";
import { openDatabase } from "../../src/infrastructure/db/client.ts";
import { createReviewRoundRepo, type ReviewRoundRepo } from "../../src/infrastructure/db/reviewRoundRepo.ts";

const URL = "https://github.com/acme/web/pull/7";
const KEY = "acme/web#7";
const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);
const QUIET = 120_000;

const person: AllowedUser = { slackId: "U1", role: "executer", displayName: "Dev", addedBy: "U0", createdAt: 0 };

const report = (over: Partial<ReviewedReport> = {}): ReviewedReport => ({
  url: URL,
  headSha: A,
  identity: "human",
  actorSlackId: "U1",
  channelId: "C1",
  threadTs: "1.1",
  ...over,
});

type Post = { channel: string; text: string; threadTs?: string };

let now: number;
let repo: ReviewRoundRepo;
let pr: PrNow | undefined;
let posts: Post[];
let started: ReviewStart[];
let reviewOut: string | Error;
let gate: Promise<void> | undefined;
let tokens: Set<string>;
let people: AllowedUser[];
let maxRounds: number;
let prReads: number;

const make = (): ReviewRounds => {
  const rounds: ReviewRounds = createReviewRounds({
    clock: () => now,
    rounds: repo,
    users: { get: (id) => people.find((p) => p.slackId === id) },
    hasToken: (id) => tokens.has(id),
    pr: async () => {
      prReads++;
      return pr;
    },
    post: async (channel, text, threadTs) => {
      posts.push({ channel, text, ...(threadTs ? { threadTs } : {}) });
      return "ts";
    },
    // what the review command does on success: it reports the head it read back to the rounds
    review: async (start) => {
      started.push(start);
      if (gate) await gate;
      if (reviewOut instanceof Error) throw reviewOut;
      if (reviewOut === "") {
        rounds.reviewed(report({ headSha: start.round?.to ?? A, round: start.round?.number, identity: start.identity }));
      }
      return reviewOut;
    },
    limits: () => ({ maxRounds, idleMs: 7 * 86_400_000, debounceMs: QUIET }),
    prefix: "//bot",
  });
  return rounds;
};

/** One poll after `ms` more have passed. */
const poll = async (rounds: ReviewRounds, ms = ROUND_POLL_MS): Promise<void> => {
  now += ms;
  await rounds.tick();
  await rounds.idle();
};

beforeEach(() => {
  now = 1_000_000;
  repo = createReviewRoundRepo(openDatabase(":memory:"));
  pr = { state: "OPEN", headSha: A };
  posts = [];
  started = [];
  reviewOut = "";
  gate = undefined;
  tokens = new Set(["U1"]);
  people = [person];
  maxRounds = 5;
  prReads = 0;
});

describe("following a reviewed PR", () => {
  test("a finished review leaves the PR followed, from the head it read, with who asked and where", () => {
    const rounds = make();
    rounds.reviewed(report());
    expect(repo.get(KEY)).toMatchObject({ lastHead: A, round: 1, actorSlack: "U1", channelId: "C1", threadTs: "1.1", identity: "human", status: "following" });
  });

  test("a review that gives nothing to follow it by is not followed: no head, no thread, no asker", () => {
    const rounds = make();
    rounds.reviewed(report({ headSha: "" }));
    rounds.reviewed(report({ threadTs: "" }));
    rounds.reviewed(report({ actorSlackId: "" }));
    rounds.reviewed(report({ url: "not a pr" }));
    expect(repo.active()).toHaveLength(0);
  });

  test("with rounds off nothing is followed and nothing is polled", async () => {
    maxRounds = 0;
    const rounds = make();
    rounds.reviewed(report());
    expect(repo.active()).toHaveLength(0);
    await poll(rounds);
    expect(prReads).toBe(0);
  });

  test("an unchanged head costs one read and nothing else", async () => {
    const rounds = make();
    rounds.reviewed(report());
    await poll(rounds);
    expect(prReads).toBe(1);
    expect(started).toHaveLength(0);
    expect(posts).toHaveLength(0);
  });

  test("polls are at most one a minute", async () => {
    const rounds = make();
    rounds.reviewed(report());
    await poll(rounds);
    await poll(rounds, 1000);
    expect(prReads).toBe(1);
    await poll(rounds, ROUND_POLL_MS);
    expect(prReads).toBe(2);
  });
});

describe("a push gets the next round", () => {
  test("only once the head has been still for the quiet period, in the same thread, as the same identity", async () => {
    const rounds = make();
    rounds.reviewed(report({ identity: "app" }));
    pr = { state: "OPEN", headSha: B };
    await poll(rounds); // seen
    expect(started).toHaveLength(0);
    await poll(rounds, 60_000); // 1 min still
    expect(started).toHaveLength(0);
    await poll(rounds, 60_000); // 2 min still
    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({
      actor: person,
      channelId: "C1",
      threadTs: "1.1",
      url: URL,
      identity: "app",
      round: { number: 2, from: A, to: B },
    });
    expect(repo.get(KEY)).toMatchObject({ round: 2, lastHead: B, running: false });
    // the head is reviewed: later polls leave it alone
    await poll(rounds);
    expect(started).toHaveLength(1);
  });

  test("a burst of pushes is one round, on the head that finally stays", async () => {
    const rounds = make();
    rounds.reviewed(report());
    pr = { state: "OPEN", headSha: B };
    await poll(rounds);
    await poll(rounds, 60_000);
    pr = { state: "OPEN", headSha: C }; // pushed again before the quiet period ran out
    await poll(rounds, 60_000);
    expect(started).toHaveLength(0);
    await poll(rounds, 60_000);
    expect(started).toHaveLength(0);
    await poll(rounds, 60_000);
    expect(started).toHaveLength(1);
    expect(started[0]?.round).toEqual({ number: 2, from: A, to: C });
  });

  test("a head that was force-pushed back to the reviewed one starts nothing", async () => {
    const rounds = make();
    rounds.reviewed(report());
    pr = { state: "OPEN", headSha: B };
    await poll(rounds);
    pr = { state: "OPEN", headSha: A };
    await poll(rounds);
    expect(repo.get(KEY)?.observedHead).toBe("");
    await poll(rounds, QUIET * 2);
    expect(started).toHaveLength(0);
  });

  test("round after round: each one reviews from the head the last one read", async () => {
    const rounds = make();
    rounds.reviewed(report());
    pr = { state: "OPEN", headSha: B };
    await poll(rounds);
    await poll(rounds, QUIET);
    pr = { state: "OPEN", headSha: C };
    await poll(rounds);
    await poll(rounds, QUIET);
    expect(started.map((s) => s.round)).toEqual([
      { number: 2, from: A, to: B },
      { number: 3, from: B, to: C },
    ]);
  });

  test("a manual review of the same PR in between counts as a round and moves the baseline", async () => {
    const rounds = make();
    rounds.reviewed(report());
    rounds.reviewed(report({ headSha: B })); // somebody asked again on the new head
    expect(repo.get(KEY)).toMatchObject({ round: 2, lastHead: B });
    pr = { state: "OPEN", headSha: B };
    await poll(rounds, QUIET * 2);
    expect(started).toHaveLength(0);
  });
});

describe("never two rounds of one PR at once", () => {
  test("a round still running holds the PR: later polls do not start another", async () => {
    let release: () => void = () => {};
    gate = new Promise<void>((r) => (release = r));
    const rounds = make();
    rounds.reviewed(report());
    pr = { state: "OPEN", headSha: B };
    await rounds.tick(); // seen
    now += QUIET;
    await rounds.tick(); // runs, and keeps running
    expect(started).toHaveLength(1);
    expect(repo.get(KEY)?.running).toBe(true);
    pr = { state: "OPEN", headSha: C }; // pushed meanwhile
    for (let i = 0; i < 4; i++) {
      now += ROUND_POLL_MS;
      await rounds.tick();
    }
    expect(started).toHaveLength(1);
    release();
    await rounds.idle();
    expect(repo.get(KEY)).toMatchObject({ running: false, round: 2, lastHead: B });
    // the push that landed meanwhile is the next round's, after its own quiet period
    await poll(rounds);
    await poll(rounds, QUIET);
    expect(started.map((s) => s.round?.to)).toEqual([B, C]);
  });

  test("the compare-and-set refuses a second start even when two polls race", async () => {
    const rounds = make();
    rounds.reviewed(report());
    expect(repo.begin(KEY, 1, now)).toBe(true);
    pr = { state: "OPEN", headSha: B };
    await poll(rounds);
    await poll(rounds, QUIET);
    expect(started).toHaveLength(0); // the PR is held by the first take
  });

  test("a restart frees a round the dead process was in the middle of", async () => {
    const rounds = make();
    rounds.reviewed(report());
    repo.begin(KEY, 1, now);
    expect(rounds.recover()).toBe(1);
    pr = { state: "OPEN", headSha: B };
    await poll(rounds);
    await poll(rounds, QUIET);
    expect(started).toHaveLength(1);
  });
});

describe("when following stops", () => {
  test("a merged PR stops at once, with no review and no line", async () => {
    const rounds = make();
    rounds.reviewed(report());
    pr = { state: "MERGED", headSha: B };
    await poll(rounds);
    expect(repo.get(KEY)).toMatchObject({ status: "stopped", stopReason: "merged" });
    expect(started).toHaveLength(0);
    expect(posts).toHaveLength(0);
    await poll(rounds);
    expect(prReads).toBe(1); // no longer polled
  });

  test("a closed PR stops the same way", async () => {
    const rounds = make();
    rounds.reviewed(report());
    pr = { state: "CLOSED", headSha: A };
    await poll(rounds);
    expect(repo.get(KEY)).toMatchObject({ status: "stopped", stopReason: "closed" });
  });

  test("after the round cap a push is not reviewed, and the thread is told once", async () => {
    maxRounds = 2;
    const rounds = make();
    rounds.reviewed(report());
    pr = { state: "OPEN", headSha: B };
    await poll(rounds);
    await poll(rounds, QUIET); // round 2, the last one
    expect(started).toHaveLength(1);
    pr = { state: "OPEN", headSha: C };
    await poll(rounds);
    await poll(rounds, QUIET);
    expect(started).toHaveLength(1);
    expect(repo.get(KEY)).toMatchObject({ status: "stopped", stopReason: "cap" });
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ channel: "C1", threadTs: "1.1" });
    expect(posts[0]?.text).toContain("2 rounds");
    await poll(rounds, QUIET);
    expect(posts).toHaveLength(1);
  });

  test("asking for a review again after the cap starts over", async () => {
    maxRounds = 1;
    const rounds = make();
    rounds.reviewed(report());
    pr = { state: "OPEN", headSha: B };
    await poll(rounds);
    await poll(rounds, QUIET);
    expect(repo.get(KEY)?.status).toBe("stopped");
    rounds.reviewed(report({ headSha: B }));
    expect(repo.get(KEY)).toMatchObject({ status: "following", round: 1, lastHead: B });
  });

  test("a PR nobody pushed to for a week stops, silently", async () => {
    const rounds = make();
    rounds.reviewed(report());
    await poll(rounds, 6 * 86_400_000);
    expect(repo.get(KEY)?.status).toBe("following");
    await poll(rounds, 86_400_000 + 1);
    expect(repo.get(KEY)).toMatchObject({ status: "stopped", stopReason: "idle" });
    expect(posts).toHaveLength(0);
  });

  test("a push inside the week restarts the idle window", async () => {
    const rounds = make();
    rounds.reviewed(report());
    await poll(rounds, 6 * 86_400_000);
    pr = { state: "OPEN", headSha: B };
    await poll(rounds);
    await poll(rounds, QUIET);
    await poll(rounds, 6 * 86_400_000);
    expect(repo.get(KEY)?.status).toBe("following");
  });
});

describe("rounds that cannot run", () => {
  test("no token on file: one line in the thread, nothing runs, and the head is not retried", async () => {
    tokens.clear();
    const rounds = make();
    rounds.reviewed(report());
    pr = { state: "OPEN", headSha: B };
    await poll(rounds);
    await poll(rounds, QUIET);
    expect(started).toHaveLength(0);
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ channel: "C1", threadTs: "1.1" });
    expect(posts[0]?.text).toContain("did not run");
    expect(posts[0]?.text).toContain("<@U1>");
    for (let i = 0; i < 3; i++) await poll(rounds);
    expect(posts).toHaveLength(1);
    // a later push, with a token by then, is reviewed
    tokens.add("U1");
    pr = { state: "OPEN", headSha: C };
    await poll(rounds);
    await poll(rounds, QUIET);
    expect(started).toHaveLength(1);
    expect(started[0]?.round).toEqual({ number: 2, from: A, to: C });
  });

  test("an asker who is no longer on the access list is the same: one line, nothing runs", async () => {
    people = [];
    const rounds = make();
    rounds.reviewed(report());
    pr = { state: "OPEN", headSha: B };
    await poll(rounds);
    await poll(rounds, QUIET);
    expect(started).toHaveLength(0);
    expect(posts).toHaveLength(1);
  });

  test("a review that says why it did not run is relayed once, and the head is not retried", async () => {
    reviewOut = "👯 the PR is already being reviewed";
    const rounds = make();
    rounds.reviewed(report());
    pr = { state: "OPEN", headSha: B };
    await poll(rounds);
    await poll(rounds, QUIET);
    for (let i = 0; i < 3; i++) await poll(rounds);
    expect(started).toHaveLength(1);
    expect(posts.map((p) => p.text)).toEqual(["👯 the PR is already being reviewed"]);
    expect(repo.get(KEY)).toMatchObject({ running: false, handledHead: B });
  });

  test("a review that throws is said in the thread once and the poll carries on", async () => {
    reviewOut = new Error("claude CLI exited with code 1");
    const rounds = make();
    rounds.reviewed(report());
    pr = { state: "OPEN", headSha: B };
    await poll(rounds);
    await poll(rounds, QUIET);
    for (let i = 0; i < 3; i++) await poll(rounds);
    expect(started).toHaveLength(1);
    expect(posts).toHaveLength(1);
    expect(posts[0]?.text).toContain("stopped");
    expect(repo.get(KEY)).toMatchObject({ running: false, status: "following", handledHead: B, lastHead: A });
  });

  test("a PR that cannot be read this poll is left as it is", async () => {
    const rounds = make();
    rounds.reviewed(report());
    pr = undefined;
    await poll(rounds);
    expect(repo.get(KEY)).toMatchObject({ status: "following", observedHead: "" });
  });

  test("one PR's trouble does not stop the others being looked at", async () => {
    const rounds = make();
    rounds.reviewed(report());
    rounds.reviewed(report({ url: "https://github.com/acme/web/pull/8" }));
    let n = 0;
    const flaky = createReviewRounds({
      clock: () => now,
      rounds: repo,
      users: { get: () => person },
      hasToken: () => true,
      pr: async () => {
        n++;
        if (n === 1) throw new Error("gh exploded");
        return { state: "MERGED" as const, headSha: B };
      },
      post: async () => "ts",
      review: async () => "",
      prefix: "//bot",
    });
    now += ROUND_POLL_MS;
    await flaky.tick();
    expect(n).toBe(2);
    expect(repo.get("acme/web#8")?.status).toBe("stopped");
  });
});
