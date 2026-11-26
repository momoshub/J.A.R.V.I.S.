import { describe, expect, test } from "bun:test";
import { openDatabase } from "../../src/infrastructure/db/client.ts";
import { createReviewRoundRepo, type ReviewedPr } from "../../src/infrastructure/db/reviewRoundRepo.ts";

const pr: ReviewedPr = {
  prKey: "o/r#7",
  url: "https://github.com/o/r/pull/7",
  repo: "o/r",
  number: 7,
  identity: "human",
  actorSlack: "U1",
  channelId: "C1",
  threadTs: "1.1",
  headSha: "aaa1111",
};

const make = () => createReviewRoundRepo(openDatabase(":memory:"));

describe("review round repo", () => {
  test("the first review starts the PR at round 1 on the head it read", () => {
    const repo = make();
    repo.reviewed(pr, 100);
    expect(repo.get("o/r#7")).toMatchObject({
      lastHead: "aaa1111",
      round: 1,
      status: "following",
      actorSlack: "U1",
      channelId: "C1",
      threadTs: "1.1",
      identity: "human",
      lastPushAt: 100,
      running: false,
      observedHead: "",
    });
    expect(repo.active()).toHaveLength(1);
  });

  test("a person asking again counts as one more round on a followed PR", () => {
    const repo = make();
    repo.reviewed(pr, 100);
    repo.reviewed({ ...pr, headSha: "bbb2222", actorSlack: "U2", threadTs: "9.9" }, 200);
    // the latest asker's token, thread and head win
    expect(repo.get("o/r#7")).toMatchObject({ round: 2, lastHead: "bbb2222", actorSlack: "U2", threadTs: "9.9", lastPushAt: 200 });
  });

  test("a round the poll started says its own number", () => {
    const repo = make();
    repo.reviewed(pr, 100);
    repo.reviewed({ ...pr, headSha: "bbb2222", round: 2 }, 200);
    repo.reviewed({ ...pr, headSha: "ccc3333", round: 3 }, 300);
    expect(repo.get("o/r#7")?.round).toBe(3);
  });

  test("asking again for a PR that stopped starts over at round 1, followed again", () => {
    const repo = make();
    repo.reviewed(pr, 100);
    repo.reviewed({ ...pr, headSha: "bbb2222", round: 5 }, 200);
    repo.stop("o/r#7", "cap", 300);
    expect(repo.active()).toHaveLength(0);
    expect(repo.get("o/r#7")).toMatchObject({ status: "stopped", stopReason: "cap" });
    repo.reviewed({ ...pr, headSha: "ccc3333" }, 400);
    expect(repo.get("o/r#7")).toMatchObject({ status: "following", stopReason: "", round: 1, lastHead: "ccc3333" });
    expect(repo.active()).toHaveLength(1);
  });

  test("a head handled without a review (a round that could not run) never becomes the base of the next delta", () => {
    const repo = make();
    repo.reviewed(pr, 100);
    repo.begin("o/r#7", 1, 200);
    repo.end("o/r#7", "bbb2222", 300);
    expect(repo.get("o/r#7")).toMatchObject({ lastHead: "aaa1111", handledHead: "bbb2222", round: 1 });
    // a recorded review moves both
    repo.reviewed({ ...pr, headSha: "ccc3333", round: 2 }, 400);
    expect(repo.get("o/r#7")).toMatchObject({ lastHead: "ccc3333", handledHead: "ccc3333", round: 2 });
  });

  test("a push is observed (and counts as activity); a reviewed head clears it", () => {
    const repo = make();
    repo.reviewed(pr, 100);
    repo.observe("o/r#7", "bbb2222", 500);
    expect(repo.get("o/r#7")).toMatchObject({ observedHead: "bbb2222", observedAt: 500, lastPushAt: 500 });
    repo.observe("o/r#7", "", 600);
    expect(repo.get("o/r#7")).toMatchObject({ observedHead: "", observedAt: 0, lastPushAt: 500 });
  });

  test("only one round of a PR can begin: the second take is refused until it ends", () => {
    const repo = make();
    repo.reviewed(pr, 100);
    expect(repo.begin("o/r#7", 1, 200)).toBe(true);
    expect(repo.get("o/r#7")?.running).toBe(true);
    expect(repo.begin("o/r#7", 1, 201)).toBe(false);
    repo.end("o/r#7", "bbb2222", 300);
    expect(repo.get("o/r#7")).toMatchObject({ running: false, handledHead: "bbb2222", lastHead: "aaa1111" });
    expect(repo.begin("o/r#7", 1, 301)).toBe(true); // once it ended, the same round number can begin again
  });

  test("a round whose number moved on, or a PR no longer followed, cannot begin", () => {
    const repo = make();
    repo.reviewed(pr, 100);
    repo.reviewed({ ...pr, headSha: "bbb2222", round: 2 }, 150);
    expect(repo.begin("o/r#7", 1, 200)).toBe(false);
    repo.stop("o/r#7", "merged", 210);
    expect(repo.begin("o/r#7", 2, 220)).toBe(false);
    expect(repo.begin("o/r#missing", 1, 220)).toBe(false);
  });

  test("ending a round marks its head handled and keeps a newer push that was seen meanwhile", () => {
    const repo = make();
    repo.reviewed(pr, 100);
    repo.observe("o/r#7", "bbb2222", 200);
    repo.begin("o/r#7", 1, 300);
    repo.observe("o/r#7", "ccc3333", 400);
    repo.end("o/r#7", "bbb2222", 500);
    expect(repo.get("o/r#7")).toMatchObject({ handledHead: "bbb2222", observedHead: "ccc3333", running: false });
    repo.begin("o/r#7", 1, 600);
    repo.end("o/r#7", "ccc3333", 700);
    expect(repo.get("o/r#7")?.observedHead).toBe("");
  });

  test("stopping releases the running mark; a restart releases every running mark", () => {
    const repo = make();
    repo.reviewed(pr, 100);
    repo.reviewed({ ...pr, prKey: "o/r#8", number: 8, url: "https://github.com/o/r/pull/8" }, 100);
    repo.begin("o/r#7", 1, 200);
    repo.begin("o/r#8", 1, 200);
    repo.stop("o/r#7", "merged", 250);
    expect(repo.get("o/r#7")?.running).toBe(false);
    expect(repo.recover(300)).toBe(1);
    expect(repo.get("o/r#8")?.running).toBe(false);
  });

  test("the app identity round-trips, and the table is the v53 migration", () => {
    const db = openDatabase(":memory:");
    const repo = createReviewRoundRepo(db);
    repo.reviewed({ ...pr, identity: "app" }, 100);
    expect(repo.get("o/r#7")?.identity).toBe("app");
    expect(db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version).toBeGreaterThanOrEqual(53);
  });
});
