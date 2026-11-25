import { describe, expect, test } from "bun:test";
import { createBotLoopGuard, isAcceptedBot, isPersonMessage } from "../../src/domain/acceptedBots.ts";

const IDS = ["BFRIEND"];

describe("isAcceptedBot", () => {
  test("an allowlisted bot that carries a user is accepted", () => {
    expect(isAcceptedBot({ bot_id: "BFRIEND", user: "U1" }, IDS, "UBOT")).toBe(true);
  });

  test("a bot that is not on the list is not, however real its user", () => {
    expect(isAcceptedBot({ bot_id: "BOTHER", user: "U1" }, IDS, "UBOT")).toBe(false);
  });

  test("an empty list accepts nobody: today's behaviour", () => {
    expect(isAcceptedBot({ bot_id: "BFRIEND", user: "U1" }, [], "UBOT")).toBe(false);
  });

  test("a bot message with no user is still dropped", () => {
    expect(isAcceptedBot({ bot_id: "BFRIEND" }, IDS, "UBOT")).toBe(false);
  });

  test("a message from the bot's own user is never accepted", () => {
    expect(isAcceptedBot({ bot_id: "BFRIEND", user: "UBOT" }, IDS, "UBOT")).toBe(false);
  });

  test("a message with no bot id is not a bot at all", () => {
    expect(isAcceptedBot({ user: "U1" }, IDS, "UBOT")).toBe(false);
  });
});

describe("isPersonMessage", () => {
  test("a person is a person, with or without a list", () => {
    expect(isPersonMessage({ user: "U1" })).toBe(true);
    expect(isPersonMessage({ user: "U1" }, IDS, "UBOT")).toBe(true);
  });

  test("a message with no user is nobody", () => {
    expect(isPersonMessage({})).toBe(false);
  });

  test("another bot is not, an allowlisted one speaking for a user is", () => {
    expect(isPersonMessage({ bot_id: "BOTHER", user: "U1" }, IDS, "UBOT")).toBe(false);
    expect(isPersonMessage({ bot_id: "BFRIEND", user: "U1" }, IDS, "UBOT")).toBe(true);
  });
});

describe("createBotLoopGuard", () => {
  test("answers the first N bot turns in a thread, then refuses with a reason", () => {
    const guard = createBotLoopGuard(3);
    expect(guard.admit("t1").ok).toBe(true);
    expect(guard.admit("t1").ok).toBe(true);
    expect(guard.admit("t1").ok).toBe(true);
    const fourth = guard.admit("t1");
    expect(fourth.ok).toBe(false);
    expect(fourth.ok === false && fourth.reason).toContain("bot-loop");
  });

  test("a person writing starts the run over", () => {
    const guard = createBotLoopGuard(2);
    guard.admit("t1");
    guard.admit("t1");
    expect(guard.admit("t1").ok).toBe(false);
    guard.human("t1");
    expect(guard.admit("t1").ok).toBe(true);
  });

  test("threads are counted apart", () => {
    const guard = createBotLoopGuard(1);
    expect(guard.admit("t1").ok).toBe(true);
    expect(guard.admit("t1").ok).toBe(false);
    expect(guard.admit("t2").ok).toBe(true);
  });

  test("a person in one thread does not reset another", () => {
    const guard = createBotLoopGuard(1);
    guard.admit("t1");
    guard.human("t2");
    expect(guard.admit("t1").ok).toBe(false);
  });

  test("defaults to three turns", () => {
    const guard = createBotLoopGuard();
    for (let i = 0; i < 3; i++) expect(guard.admit("t").ok).toBe(true);
    expect(guard.admit("t").ok).toBe(false);
  });
});
