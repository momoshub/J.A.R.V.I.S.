import { describe, expect, test } from "bun:test";
import { createStatusMessage, retryAfterMs, sweepStatusMessages, type StatusApi } from "../../src/infrastructure/slack/statusMessage.ts";
import type { StatusView } from "../../src/domain/statusSteps.ts";

type Call = { op: "post" | "update" | "remove"; ts?: string; text: string; at: number };

/** A fake Slack: records every call with its time, and can be told to fail. */
const fake = (opts: { failures?: (call: number, op: string) => unknown } = {}) => {
  const calls: Call[] = [];
  const t0 = Date.now();
  let n = 0;
  const textOf = (v: StatusView): string => {
    const plan = v.blocks[0] as unknown as { title: string; tasks: { status: string; title: string }[] };
    return [plan.title, ...plan.tasks.map((t) => `${t.status}: ${t.title}`)].join("\n");
  };
  const hit = (op: Call["op"], ts: string | undefined, text: string): void => {
    const failure = opts.failures?.(++n, op);
    if (failure) throw failure;
    calls.push({ op, ...(ts ? { ts } : {}), text, at: Date.now() - t0 });
  };
  const api: StatusApi = {
    post: async (v) => (hit("post", undefined, textOf(v)), "100.1"),
    update: async (ts, v) => void hit("update", ts, textOf(v)),
    remove: async (ts) => void hit("remove", ts, ""),
  };
  const store: { added: string[]; removed: string[] } = { added: [], removed: [] };
  return {
    api,
    calls,
    store,
    storeApi: { add: (ts: string) => void store.added.push(ts), remove: (ts: string) => void store.removed.push(ts) },
  };
};

const FAST = { minIntervalMs: 30, deleteDelayMs: 20 };

describe("the status message while the turn runs", () => {
  test("posts once when the first step starts, then edits", async () => {
    const f = fake();
    const m = createStatusMessage({ api: f.api, store: f.storeApi, ...FAST });
    m.step({ id: "a", title: "Reading a file", state: "in_progress" });
    await Bun.sleep(15);
    expect(f.calls.map((c) => c.op)).toEqual(["post"]);
    expect(f.store.added).toEqual(["100.1"]);
    m.step({ id: "a", title: "Reading a file", state: "complete" });
    await Bun.sleep(80);
    expect(f.calls.map((c) => c.op)).toEqual(["post", "update"]);
    expect(f.calls[1]?.text).toBe("Burning token… 1 step\ncomplete: Reading a file");
    await m.end();
    await m.idle();
  });

  test("a burst is coalesced to about one edit per interval, and the trailing one carries the last state", async () => {
    const f = fake();
    const m = createStatusMessage({ api: f.api, ...FAST, minIntervalMs: 60 });
    m.step({ id: "s0", title: "First", state: "in_progress" });
    await Bun.sleep(10);
    for (let i = 1; i <= 20; i++) m.step({ id: `s${i}`, title: `Step ${i}`, state: "in_progress" });
    await Bun.sleep(200);
    const edits = f.calls.filter((c) => c.op === "update");
    expect(edits.length).toBeLessThanOrEqual(3);
    expect(edits.length).toBeGreaterThan(0);
    // the last edit shows the last step
    expect(edits.at(-1)?.text).toContain("Step 20");
    // never two sends closer than the interval
    for (let i = 1; i < f.calls.length; i++) expect((f.calls[i]?.at ?? 0) - (f.calls[i - 1]?.at ?? 0)).toBeGreaterThanOrEqual(45);
    await m.end();
    await m.idle();
  });

  test("a finishing update keeps the log line the step started with, and the step its place", async () => {
    const f = fake();
    const m = createStatusMessage({ api: f.api, ...FAST });
    m.step({ id: "a", title: "A", state: "in_progress", logLine: "4" });
    m.step({ id: "b", title: "B", state: "in_progress" });
    m.step({ id: "a", title: "A", state: "complete" });
    await Bun.sleep(20);
    expect(m.steps.map((s) => [s.id, s.state, s.logLine])).toEqual([
      ["a", "complete", "4"],
      ["b", "in_progress", undefined],
    ]);
    await m.end();
    await m.idle();
  });

  test("a rate limit waits its retry-after and the edit still lands", async () => {
    let limited = 0;
    const f = fake({
      failures: (_n, op) => {
        if (op === "update" && limited++ === 0) return Object.assign(new Error("ratelimited"), { code: "slack_webapi_rate_limited_error", retryAfter: 0.05 });
        return undefined;
      },
    });
    const m = createStatusMessage({ api: f.api, ...FAST });
    m.step({ id: "a", title: "A", state: "in_progress" });
    await Bun.sleep(15);
    m.step({ id: "a", title: "A", state: "complete" });
    await Bun.sleep(200);
    expect(limited).toBe(2);
    expect(f.calls.filter((c) => c.op === "update").at(-1)?.text).toBe("Burning token… 1 step\ncomplete: A");
    await m.end();
    await m.idle();
  });

  test("a failed post is tried again with the state as it is by then", async () => {
    let first = true;
    const f = fake({ failures: () => (first ? ((first = false), new Error("boom")) : undefined) });
    const logs: string[] = [];
    const m = createStatusMessage({ api: f.api, ...FAST, log: (l) => logs.push(l) });
    m.step({ id: "a", title: "A", state: "in_progress" });
    await Bun.sleep(15);
    m.step({ id: "b", title: "B", state: "in_progress" });
    await Bun.sleep(120);
    expect(logs.some((l) => l.includes("status post failed"))).toBe(true);
    expect(f.calls[0]?.op).toBe("post");
    expect(f.calls[0]?.text).toContain("B");
    await m.end();
    await m.idle();
  });

  test("the thinking line is posted, then replaced by the first step", async () => {
    const f = fake();
    const m = createStatusMessage({ api: f.api, ...FAST });
    m.thinking("working on it...");
    await Bun.sleep(15);
    expect(f.calls[0]).toMatchObject({ op: "post", text: "Burning token…\nin_progress: working on it..." });
    m.step({ id: "a", title: "A", state: "in_progress" });
    await Bun.sleep(80);
    expect(f.calls.at(-1)).toMatchObject({ op: "update", text: "Burning token… 1 step\nin_progress: A" });
    await m.end();
    await m.idle();
  });

  test("a thinking line taken away before anything shows posts nothing", async () => {
    const f = fake();
    const m = createStatusMessage({ api: f.api, ...FAST });
    m.thinking("working on it...");
    m.thinking(undefined);
    await Bun.sleep(60);
    await m.end();
    await m.idle();
    expect(f.calls).toHaveLength(0);
  });

  test("a thinking line taken away after it showed deletes the message", async () => {
    const f = fake();
    const m = createStatusMessage({ api: f.api, store: f.storeApi, ...FAST });
    m.thinking("working on it...");
    await Bun.sleep(15);
    m.thinking(undefined);
    await Bun.sleep(100);
    expect(f.calls.map((c) => c.op)).toEqual(["post", "remove"]);
    expect(f.store.removed).toEqual(["100.1"]);
    await m.end();
    await m.idle();
    expect(f.calls.map((c) => c.op)).toEqual(["post", "remove"]);
  });
});

describe("the status message when the turn ends", () => {
  test("clean: lands the last state, then deletes after the wait, and forgets the row", async () => {
    const f = fake();
    const m = createStatusMessage({ api: f.api, store: f.storeApi, minIntervalMs: 30, deleteDelayMs: 80 });
    m.step({ id: "a", title: "A", state: "in_progress" });
    await Bun.sleep(15);
    m.step({ id: "a", title: "A", state: "complete" });
    await m.end();
    // end does not wait out the delay: the answer must not wait with it
    expect(f.calls.some((c) => c.op === "remove")).toBe(false);
    expect(f.store.removed).toEqual([]);
    await m.idle();
    const remove = f.calls.find((c) => c.op === "remove");
    expect(remove).toBeDefined();
    expect(f.store.removed).toEqual(["100.1"]);
    // deleted at least the delay after the last send
    const lastSend = f.calls.filter((c) => c.op !== "remove").at(-1)?.at ?? 0;
    expect((remove?.at ?? 0) - lastSend).toBeGreaterThanOrEqual(60);
  });

  test("a failed step: collapsed with chat.update, never deleted, row forgotten", async () => {
    const f = fake();
    const m = createStatusMessage({ api: f.api, store: f.storeApi, ...FAST });
    m.step({ id: "a", title: "Reading a file", state: "complete" });
    m.step({ id: "b", title: "Run: gh pr view", state: "error" });
    m.step({ id: "c", title: "Searching the code", state: "complete" });
    await Bun.sleep(15);
    await m.end();
    await m.idle();
    await Bun.sleep(60);
    expect(f.calls.some((c) => c.op === "remove")).toBe(false);
    expect(f.calls.at(-1)).toMatchObject({ op: "update", ts: "100.1", text: "🔧 3 steps, 1 failed\nerror: Run: gh pr view" });
    expect(f.store.removed).toEqual(["100.1"]);
  });

  test("a failed step that was never posted (a short turn) is posted collapsed", async () => {
    const f = fake();
    const m = createStatusMessage({ api: f.api, store: f.storeApi, minIntervalMs: 5_000, deleteDelayMs: 5 });
    m.step({ id: "a", title: "A", state: "complete" });
    m.step({ id: "b", title: "B", state: "error" });
    // the timer has not fired yet
    await m.end();
    await m.idle();
    expect(f.calls.map((c) => c.op)).toEqual(["post"]);
    expect(f.calls[0]?.text).toBe("🔧 2 steps, 1 failed\nerror: B");
  });

  test("nothing shown, nothing posted", async () => {
    const f = fake();
    const m = createStatusMessage({ api: f.api, ...FAST });
    await m.end();
    await m.idle();
    expect(f.calls).toHaveLength(0);
  });

  test("a rate limit on the final write is waited out and retried, so the final state lands", async () => {
    let updates = 0;
    const f = fake({
      failures: (_n, op) =>
        op === "update" && updates++ < 2 ? Object.assign(new Error("ratelimited"), { data: { retry_after: 0.03 } }) : undefined,
    });
    const m = createStatusMessage({ api: f.api, store: f.storeApi, ...FAST });
    m.step({ id: "a", title: "A", state: "complete" });
    await Bun.sleep(15);
    m.step({ id: "b", title: "B", state: "error" });
    await m.end();
    await m.idle();
    expect(f.calls.at(-1)).toMatchObject({ op: "update", text: "🔧 2 steps, 1 failed\nerror: B" });
    expect(f.store.removed).toEqual(["100.1"]);
  });

  test("a delete that cannot land leaves its row for the boot sweep", async () => {
    const f = fake({ failures: (_n, op) => (op === "remove" ? new Error("boom") : undefined) });
    const m = createStatusMessage({ api: f.api, store: f.storeApi, ...FAST, retries: 0 });
    m.step({ id: "a", title: "A", state: "complete" });
    await Bun.sleep(15);
    await m.end();
    // FINAL_RETRIES with a short sleep each: still bounded
    await m.idle();
    expect(f.store.removed).toEqual([]);
  }, 10_000);

  test("a message Slack no longer has counts as gone", async () => {
    const f = fake({ failures: (_n, op) => (op === "remove" ? new Error("An API error occurred: message_not_found") : undefined) });
    const m = createStatusMessage({ api: f.api, store: f.storeApi, ...FAST });
    m.step({ id: "a", title: "A", state: "complete" });
    await Bun.sleep(15);
    await m.end();
    await m.idle();
    expect(f.store.removed).toEqual(["100.1"]);
  });

  test("discard: a turn whose reply was dropped deletes the message at once, failures included", async () => {
    const f = fake();
    const m = createStatusMessage({ api: f.api, store: f.storeApi, minIntervalMs: 30, deleteDelayMs: 5_000 });
    m.step({ id: "a", title: "A", state: "error" });
    await Bun.sleep(15);
    await m.end({ discard: true });
    await m.idle();
    expect(f.calls.map((c) => c.op)).toEqual(["post", "remove"]);
    expect(f.store.removed).toEqual(["100.1"]);
  });

  test("a collapse Slack refuses is replaced by a delete, never left as the running view", async () => {
    const f = fake({ failures: (_n, op) => (op === "update" ? new Error("invalid_blocks") : undefined) });
    const m = createStatusMessage({ api: f.api, store: f.storeApi, ...FAST });
    m.step({ id: "a", title: "A", state: "error" });
    await Bun.sleep(15);
    await m.end();
    await m.idle();
    expect(f.calls.at(-1)?.op).toBe("remove");
    expect(f.store.removed).toEqual(["100.1"]);
  }, 10_000);

  test("a thinking line taken away while its post is in flight is still removed", async () => {
    const f = fake();
    const slow: typeof f.api = { ...f.api, post: async (v) => (await Bun.sleep(30), f.api.post(v)) };
    const m = createStatusMessage({ api: slow, store: f.storeApi, ...FAST });
    m.thinking("working...");
    await Bun.sleep(10); // the post is out
    m.thinking(undefined);
    await Bun.sleep(200);
    expect(f.calls.map((c) => c.op)).toEqual(["post", "remove"]);
    await m.end();
    await m.idle();
  });

  test("ending twice does nothing the second time, and later steps are ignored", async () => {
    const f = fake();
    const m = createStatusMessage({ api: f.api, ...FAST });
    m.step({ id: "a", title: "A", state: "complete" });
    await Bun.sleep(15);
    await m.end();
    await m.end();
    m.step({ id: "late", title: "Late", state: "error" });
    await m.idle();
    expect(f.calls.filter((c) => c.op === "remove")).toHaveLength(1);
    expect(f.calls.every((c) => !c.text.includes("Late"))).toBe(true);
  });
});

describe("retryAfterMs", () => {
  test("reads the web client's retryAfter (seconds)", () => {
    expect(retryAfterMs(Object.assign(new Error("x"), { code: "slack_webapi_rate_limited_error", retryAfter: 3 }))).toBe(3000);
  });
  test("reads a raw answer's retry_after", () => {
    expect(retryAfterMs({ data: { retry_after: 2, error: "ratelimited" } })).toBe(2000);
  });
  test("a ratelimited message with no number gets a default wait", () => {
    expect(retryAfterMs(new Error("An API error occurred: ratelimited"))).toBeGreaterThan(0);
  });
  test("other errors are not rate limits", () => {
    expect(retryAfterMs(new Error("message_not_found"))).toBeUndefined();
    expect(retryAfterMs("nope")).toBeUndefined();
  });
});

describe("the boot sweep", () => {
  const rows = [
    { channelId: "C1", ts: "1.1" },
    { channelId: "C2", ts: "2.2" },
    { channelId: "C3", ts: "3.3" },
  ];

  test("deletes what a dead process left and forgets each row", async () => {
    const removed: string[] = [];
    const forgot: string[] = [];
    const n = await sweepStatusMessages({
      rows: () => rows,
      remove: async (c, ts) => void removed.push(`${c}/${ts}`),
      forget: (c, ts) => void forgot.push(`${c}/${ts}`),
    });
    expect(n).toBe(3);
    expect(removed).toEqual(["C1/1.1", "C2/2.2", "C3/3.3"]);
    expect(forgot).toEqual(removed);
  });

  test("a message already gone is swept, one Slack will not delete keeps its row", async () => {
    const forgot: string[] = [];
    const logs: string[] = [];
    const n = await sweepStatusMessages({
      rows: () => rows,
      remove: async (c) => {
        if (c === "C1") throw new Error("message_not_found");
        if (c === "C2") throw new Error("ratelimited");
      },
      forget: (c, ts) => void forgot.push(`${c}/${ts}`),
      log: (l) => logs.push(l),
    });
    expect(n).toBe(2);
    expect(forgot).toEqual(["C1/1.1", "C3/3.3"]);
    expect(logs).toHaveLength(1);
  });
});
