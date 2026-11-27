import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { migrate } from "../../../src/infrastructure/db/schema.ts";
import { createJuekiRepo } from "../../../src/infrastructure/db/juekiRepo.ts";

const repo = () => {
  const db = new Database(":memory:");
  migrate(db);
  migrate(db); // idempotent
  return createJuekiRepo(db);
};

describe("juekiRepo", () => {
  test("digest lines are kept per day, oldest first", () => {
    const r = repo();
    r.addLine("2026-11-27", 1, "a");
    r.addLine("2026-11-27", 2, "b");
    r.addLine("2026-11-28", 3, "c");
    expect(r.lines("2026-11-27")).toEqual([{ at: 1, text: "a" }, { at: 2, text: "b" }]);
    expect(r.lines("2026-11-29")).toEqual([]);
  });

  test("marks answer when an item was last dealt with, and marks never show as digest lines", () => {
    const r = repo();
    expect(r.lastMark("nudge", "journey:3")).toBeUndefined();
    r.mark("nudge", "journey:3", 10);
    r.mark("nudge", "journey:3", 20);
    expect(r.lastMark("nudge", "journey:3")).toBe(20);
    expect(r.lastMark("nudge", "journey:4")).toBeUndefined();
    expect(r.lines("")).toEqual([]);
  });

  test("the digest message of a day is stored and replaced", () => {
    const r = repo();
    expect(r.digest("d")).toBeUndefined();
    r.setDigest("d", "D1", "1.1");
    r.setDigest("d", "D1", "2.2");
    expect(r.digest("d")).toEqual({ channel: "D1", ts: "2.2" });
  });

  test("a blocker key is its identity: opening it twice gives the same row", () => {
    const r = repo();
    const a = r.openBlocker({ key: "k", kind: "permission", prod: false, text: "first" }, 5);
    const b = r.openBlocker({ key: "k", kind: "decision", prod: true, text: "second" }, 9);
    expect(b.id).toBe(a.id);
    expect(b).toMatchObject({ kind: "permission", prod: false, text: "first", state: "pending", raisedCount: 0 });
  });

  test("raising counts, the first decision wins, an approval is handed over once", () => {
    const r = repo();
    const b = r.openBlocker({ key: "k", kind: "prod-write", prod: true, text: "t" }, 5);
    r.setNotice(b.id, "D1", "9.9");
    r.raised(b.id, 100);
    r.raised(b.id, 200);
    expect(r.blocker(b.id)).toMatchObject({ raisedCount: 2, lastRaisedAt: 200, noticeChannel: "D1", noticeTs: "9.9" });
    expect(r.pending().map((x) => x.id)).toEqual([b.id]);
    expect(r.decide(b.id, "approved", 300)).toBe(true);
    expect(r.decide(b.id, "rejected", 301)).toBe(false);
    expect(r.blocker(b.id)).toMatchObject({ state: "approved", decidedAt: 300 });
    expect(r.pending()).toEqual([]);
    expect(r.approvedUnhandled().map((x) => x.id)).toEqual([b.id]);
    r.markHandled(b.id, 400);
    expect(r.approvedUnhandled()).toEqual([]);
  });
});

describe("the lookups Jueki reads other tables with", () => {
  test("lapsedSince: expired and failed watches since a time, not fired or waiting ones", async () => {
    const { createWatchRepo } = await import("../../../src/infrastructure/db/watchRepo.ts");
    const db = new Database(":memory:");
    migrate(db);
    const w = createWatchRepo(db);
    const base = { channelId: "C1", threadTs: "1.1", slackUserId: "U1", note: "n", check: "c", everyMs: 1000, deadlineAt: 99, createdAt: 1 };
    const [a, b, c, d] = [w.add(base, 1), w.add(base, 1), w.add(base, 1), w.add(base, 1)];
    w.settle(a!.id, "expired", 100);
    w.settle(b!.id, "failed", 200);
    w.settle(c!.id, "fired", 300);
    expect(w.lapsedSince(0).map((x) => x.id)).toEqual([b!.id, a!.id]);
    expect(w.lapsedSince(150).map((x) => x.id)).toEqual([b!.id]);
    expect(w.waiting().map((x) => x.id)).toEqual([d!.id]);
  });

  test("bound: every bound ticket never revoked, lapsed ones included", async () => {
    const { createWorkerTicketRepo } = await import("../../../src/infrastructure/db/workerTicketRepo.ts");
    const db = new Database(":memory:");
    migrate(db);
    const t = createWorkerTicketRepo(db);
    const row = (hash: string, dispatchId: string, expiresAt: number) => ({
      tokenHash: hash, id: hash.slice(0, 8), actor: "U1", channel: "C1", threadTs: "", repo: "o/r", actions: [], ttlMs: 1, dispatchId, createdAt: 1, boundAt: dispatchId ? 1 : 0, expiresAt,
    });
    t.insert(row("aaaaaaaa11", "ctx_a", 10));
    t.insert(row("bbbbbbbb22", "ctx_b", 10));
    t.insert(row("cccccccc33", "", 10));
    t.revoke("bbbbbbbb22", 5);
    expect(t.bound().map((r) => r.id)).toEqual(["aaaaaaaa"]);
  });
});
