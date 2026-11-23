import { describe, expect, test } from "bun:test";
import { openDatabase } from "../../src/infrastructure/db/client.ts";
import { createMuteRepo } from "../../src/infrastructure/db/muteRepo.ts";

describe("mute repo", () => {
  test("a muted thread is muted until it is unmuted", () => {
    const mutes = createMuteRepo(openDatabase(":memory:"));
    expect(mutes.isMuted("C1", "1.0")).toBe(false);
    expect(mutes.mute("C1", "1.0", "U1", 1)).toBe(true);
    expect(mutes.isMuted("C1", "1.0")).toBe(true);
    // a thread is its channel and its ts, nothing looser
    expect(mutes.isMuted("C2", "1.0")).toBe(false);
    expect(mutes.isMuted("C1", "2.0")).toBe(false);
    expect(mutes.mute("C1", "1.0", "U2", 2)).toBe(false);
    expect(mutes.count()).toBe(1);
    expect(mutes.unmute("C1", "1.0")).toBe(true);
    expect(mutes.isMuted("C1", "1.0")).toBe(false);
    expect(mutes.unmute("C1", "1.0")).toBe(false);
  });

  test("it survives a restart, and lists newest first with who muted it", () => {
    const db = openDatabase(":memory:");
    const mutes = createMuteRepo(db);
    mutes.mute("C1", "1.0", "U1", 1);
    mutes.mute("C2", "2.0", "U2", 2);
    const reopened = createMuteRepo(db);
    expect(reopened.isMuted("C2", "2.0")).toBe(true);
    expect(reopened.list().map((m) => [m.channelId, m.threadTs, m.mutedBy])).toEqual([
      ["C2", "2.0", "U2"],
      ["C1", "1.0", "U1"],
    ]);
  });

  test("a mute does not touch a follow", () => {
    const db = openDatabase(":memory:");
    const row = db.query("SELECT 1 FROM sqlite_master WHERE name = 'followed_threads'").get();
    expect(row).not.toBeNull();
    createMuteRepo(db).mute("C1", "1.0", "U1", 1);
    expect(db.query("SELECT COUNT(*) AS n FROM followed_threads").get()).toEqual({ n: 0 });
  });
});
