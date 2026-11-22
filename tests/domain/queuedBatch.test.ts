import { describe, expect, test } from "bun:test";
import { coalesceKind, queuedInput } from "../../src/domain/queuedBatch.ts";
import { queuedRules } from "../../src/domain/personality.ts";

const typed = { slackUserId: "U1", threadTs: "1.1" };

describe("coalesceKind", () => {
  test("a person's own message in a thread merges, under their id", () => {
    expect(coalesceKind(typed)).toBe("U1");
    expect(coalesceKind({ ...typed, slackUserId: "U2" })).toBe("U2");
  });

  test("everything the bot started, or that carries its own rules, runs alone", () => {
    for (const odd of [
      { unprompted: true },
      { autoContinue: true },
      { workerLane: true },
      { trigger: "watch" },
      { following: true },
      { batched: true },
      { interrupted: true },
      { keepSession: true },
      { model: "opus" },
      { viaSlash: true },
    ]) {
      expect(coalesceKind({ ...typed, ...odd })).toBeUndefined();
    }
  });

  test("a top-level message with no thread has nothing to share a turn with", () => {
    expect(coalesceKind({ slackUserId: "U1" })).toBeUndefined();
  });
});

describe("queuedInput", () => {
  test("a lone message is itself", () => {
    expect(queuedInput("Kai", ["just this"])).toBe("just this");
  });

  test("several are numbered, in order, and say they were sent while busy", () => {
    const text = queuedInput("Kai", ["first", "second", "third"]);
    expect(text).toContain("3 messages from Kai");
    expect(text).toContain("while you were busy");
    expect(text.indexOf("(1/3) first")).toBeLessThan(text.indexOf("(2/3) second"));
    expect(text.indexOf("(2/3) second")).toBeLessThan(text.indexOf("(3/3) third"));
  });
});

describe("queuedRules", () => {
  test("silent for one message, and tells the model to answer once for several", () => {
    expect(queuedRules(1)).toBe("");
    const rules = queuedRules(4);
    expect(rules).toContain("4 messages");
    expect(rules).toContain("ONE reply");
  });
});
