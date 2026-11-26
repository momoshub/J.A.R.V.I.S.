import { describe, expect, test } from "bun:test";
import { dispatchCommand, startReview } from "../../src/application/commands.ts";
import type { GitHubPort } from "../../src/application/github.ts";
import { createReviewGuard } from "../../src/application/reviewGuard.ts";
import type { ReviewedReport } from "../../src/application/reviewRounds.ts";
import { OWNER, actor, build } from "./commandsFixture.ts";

const PR = "https://github.com/o/r/pull/1";
const A = "a".repeat(40);
const B = "b".repeat(40);

const github = (head: string | undefined = A): GitHubPort => ({
  whoami: async () => undefined,
  reviewDecision: async () => undefined,
  approve: async () => ({ ok: true }),
  headSha: async () => head,
});

const setup = (head?: string) => {
  const deps = build();
  const reported: ReviewedReport[] = [];
  const systems: string[] = [];
  deps.github = github(head);
  deps.reviewRounds = { reviewed: (r) => void reported.push(r), maxRounds: () => 5 };
  deps.llm = {
    complete: async (p) => {
      systems.push(p.system);
      return "the review";
    },
  };
  return { deps, reported, systems };
};

describe("quick-review leaves the PR followed for rounds", () => {
  test("a review asked in a thread reports the head it read, who paid and where it was said", async () => {
    const { deps, reported } = setup();
    const lines: string[] = [];
    await dispatchCommand(deps, actor(), "C1", `rv ${PR}`, { reply: async (t: string) => void lines.push(t), threadTs: "111.1" });
    expect(reported).toEqual([{ url: PR, headSha: A, identity: "human", actorSlackId: OWNER, channelId: "C1", threadTs: "111.1" }]);
  });

  test("a review with no thread (a slash command's DM) is not followed: the rounds would have nowhere to answer", async () => {
    const { deps, reported } = setup();
    await dispatchCommand(deps, actor(), "C1", `rv ${PR}`, { reply: async () => {} });
    expect(reported).toEqual([]);
  });

  test("a head that cannot be read means nothing to follow it by", async () => {
    const { deps, reported } = setup();
    deps.github = { ...github(), headSha: async () => undefined };
    await dispatchCommand(deps, actor(), "C1", `rv ${PR}`, { reply: async () => {}, threadTs: "111.1" });
    expect(reported).toEqual([]);
  });

  test("a run on the bot's own credential (the owner pressed approve for it) is not followed: rounds would spend the owner's token", async () => {
    const { deps, reported } = setup();
    const lines: string[] = [];
    await startReview(deps, {
      actor: actor(),
      channelId: "C1",
      threadTs: "111.1",
      url: PR,
      identity: "human",
      botCredentialOk: true,
      reply: async (t) => void lines.push(t),
    });
    expect(lines).toContain("the review");
    expect(reported).toEqual([]);
    // the same run on the asker's own token is followed
    await startReview(deps, { actor: actor(), channelId: "C1", threadTs: "111.1", url: PR, identity: "human", reply: async () => {} });
    expect(reported).toHaveLength(1);
  });

  test("a review that produced nothing is not followed", async () => {
    const { deps, reported } = setup();
    deps.llm = { complete: async () => "   " };
    await dispatchCommand(deps, actor(), "C1", `rv ${PR}`, { reply: async () => {}, threadTs: "111.1" });
    expect(reported).toEqual([]);
  });

  test("a review that was cut off is not followed", async () => {
    const { deps, reported } = setup();
    deps.llm = {
      complete: async () => "unused",
      stream: async (_p, sink) => {
        sink({ type: "aborted", reason: "timed out" });
        return "half a review";
      },
    };
    await dispatchCommand(deps, actor(), "C1", `rv ${PR}`, { reply: async () => {}, threadTs: "111.1" });
    expect(reported).toEqual([]);
  });

  test("with the rounds not wired the review is the same one", async () => {
    const { deps } = setup();
    delete deps.reviewRounds;
    const lines: string[] = [];
    await dispatchCommand(deps, actor(), "C1", `rv ${PR}`, { reply: async (t: string) => void lines.push(t), threadTs: "111.1" });
    expect(lines).toContain("the review");
  });
});

describe("a round is the same review, told what changed", () => {
  const start = (deps: ReturnType<typeof setup>["deps"], lines: string[], over = {}) =>
    startReview(deps, {
      actor: actor(),
      channelId: "C1",
      threadTs: "111.1",
      url: PR,
      identity: "human",
      round: { number: 2, from: A, to: B },
      reply: async (t) => void lines.push(t),
      ...over,
    });

  test("the prompt carries the round and the delta, the thread gets the round line, and the head reported is the round's", async () => {
    const { deps, reported, systems } = setup(A);
    const lines: string[] = [];
    expect(await start(deps, lines)).toBe("");
    expect(systems[0]).toContain("THIS IS ROUND 2");
    expect(systems[0]).toContain(`compare/${A}...${B}`);
    expect(lines[0]).toBe(`🔁 round 2 on ${PR} - new commits \`aaaaaaa..bbbbbbb\``);
    expect(lines).not.toContain(`🔍 reviewing ${PR}`);
    // the head the poll saw, not the one gh happens to report a moment later: a later push is the next round's
    expect(reported).toEqual([{ url: PR, headSha: B, identity: "human", actorSlackId: OWNER, channelId: "C1", threadTs: "111.1", round: 2 }]);
  });

  test("a person's review has no round text", async () => {
    const { deps, systems } = setup();
    await dispatchCommand(deps, actor(), "C1", `rv ${PR}`, { reply: async () => {}, threadTs: "111.1" });
    expect(systems[0]).not.toContain("ROUND");
  });

  test("the guard's cooldown after the review before does not hold a round back, but a person's second ask is still pointed at the first", async () => {
    const { deps } = setup();
    let t = 0;
    deps.reviewGuard = createReviewGuard(() => t);
    const lines: string[] = [];
    await dispatchCommand(deps, actor(), "C1", `rv ${PR}`, { reply: async (x: string) => void lines.push(x), threadTs: "111.1" });
    t = 1000;
    const again = await dispatchCommand(deps, actor(), "C1", `rv ${PR}`, { reply: async () => {}, threadTs: "111.1" });
    expect(again).toContain("was just reviewed");
    const round: string[] = [];
    await start(deps, round);
    expect(round.join("\n")).not.toContain("was just reviewed");
    expect(round[0]).toContain("round 2");
  });
});
