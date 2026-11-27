import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { createCoordinatorRepo } from "../../../src/infrastructure/db/coordinatorRepo.ts";
import { migrate } from "../../../src/infrastructure/db/schema.ts";

/** The tables exactly as v54 created them, before the feature was made generic. */
const V54 = `
  CREATE TABLE jueki_actions (
    id    INTEGER PRIMARY KEY AUTOINCREMENT,
    day   TEXT NOT NULL,
    at    INTEGER NOT NULL,
    kind  TEXT NOT NULL,
    ref   TEXT NOT NULL DEFAULT '',
    line  TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX idx_jueki_actions_day ON jueki_actions (day, id);
  CREATE INDEX idx_jueki_actions_ref ON jueki_actions (kind, ref, at);
  CREATE TABLE jueki_digest (day TEXT PRIMARY KEY, channel TEXT NOT NULL, ts TEXT NOT NULL);
  CREATE TABLE jueki_blockers (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    key            TEXT NOT NULL UNIQUE,
    kind           TEXT NOT NULL,
    prod           INTEGER NOT NULL DEFAULT 0,
    text           TEXT NOT NULL,
    state          TEXT NOT NULL DEFAULT 'pending',
    notice_channel TEXT NOT NULL DEFAULT '',
    notice_ts      TEXT NOT NULL DEFAULT '',
    raised_count   INTEGER NOT NULL DEFAULT 0,
    last_raised_at INTEGER NOT NULL DEFAULT 0,
    handled_at     INTEGER NOT NULL DEFAULT 0,
    created_at     INTEGER NOT NULL,
    decided_at     INTEGER NOT NULL DEFAULT 0
  );
`;

const NEW_TABLES = ["coordinator_actions", "coordinator_blockers", "coordinator_digest"];

/** Every table of this feature, in either generation. */
const tables = (db: Database): string[] =>
  db
    .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
    .map((r) => r.name)
    .filter((n) => n.startsWith("jueki_") || n.startsWith("coordinator_"));

const legacyDb = (): Database => {
  const db = new Database(":memory:");
  db.exec(V54);
  db.exec("PRAGMA user_version = 54;");
  db.exec(`
    INSERT INTO jueki_actions (day, at, kind, ref, line) VALUES ('2026-11-27', 5, 'line', '', 'closed journey #4'), ('', 9, 'nudge', 'journey:3', '');
    INSERT INTO jueki_digest (day, channel, ts) VALUES ('2026-11-27', 'D1', '7.7');
    INSERT INTO jueki_blockers (key, kind, prod, text, state, notice_channel, notice_ts, raised_count, created_at)
      VALUES ('purge', 'prod-write', 1, 'purge the table', 'pending', 'D1', '8.8', 2, 3);
  `);
  return db;
};

describe("migration v55: the v54 tables are renamed, nothing is lost", () => {
  test("an upgrade keeps every row and id, and the repo reads them under the new names", () => {
    const db = legacyDb();
    migrate(db);
    expect(tables(db)).toEqual(NEW_TABLES);
    const r = createCoordinatorRepo(db);
    expect(r.lines("2026-11-27")).toEqual([{ at: 5, text: "closed journey #4" }]);
    expect(r.lastMark("nudge", "journey:3")).toBe(9);
    expect(r.digest("2026-11-27")).toEqual({ channel: "D1", ts: "7.7" });
    expect(r.blockerByKey("purge")).toMatchObject({ id: 1, prod: true, state: "pending", noticeChannel: "D1", noticeTs: "8.8", raisedCount: 2 });
    // The id sequence carried over: the next blocker does not reuse an id a posted button still points at.
    expect(r.openBlocker({ key: "other", kind: "decision", prod: false, text: "x" }, 4).id).toBe(2);
    expect(db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version).toBeGreaterThanOrEqual(55);
  });

  test("the old index names are gone and the new ones exist", () => {
    const db = legacyDb();
    migrate(db);
    const idx = db
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE '%actions%'")
      .all()
      .map((i) => i.name)
      .sort();
    expect(idx).toEqual(["idx_coordinator_actions_day", "idx_coordinator_actions_ref"]);
  });

  test("a rerun changes nothing", () => {
    const db = legacyDb();
    migrate(db);
    migrate(db);
    migrate(db);
    expect(tables(db)).toEqual(NEW_TABLES);
    expect(createCoordinatorRepo(db).lines("2026-11-27")).toHaveLength(1);
  });

  test("a new database gets only the new tables", () => {
    const db = new Database(":memory:");
    migrate(db);
    expect(tables(db)).toEqual(NEW_TABLES);
  });

  test("both generations present: every row of the old build survives, ids that clash get fresh ones", () => {
    const db = legacyDb();
    migrate(db);
    const before = createCoordinatorRepo(db);
    before.addLine("2026-11-27", 6, "new build line");
    // A build from before the rename ran against the same file again. Its tables were recreated empty, so its
    // AUTOINCREMENT ids start at 1 and clash with ids the new tables already hold.
    db.exec(V54);
    db.exec(`
      INSERT INTO jueki_actions (day, at, kind, ref, line) VALUES ('2026-11-28', 7, 'line', '', 'old build line');
      INSERT INTO jueki_digest (day, channel, ts) VALUES ('2026-11-27', 'D9', '9.9'), ('2026-11-28', 'D1', '10.1');
      INSERT INTO jueki_blockers (key, kind, prod, text, state, notice_channel, notice_ts, created_at)
        VALUES ('pg-full', 'prod-write', 1, 'disk is full', 'pending', 'D1', '11.1', 8);
      INSERT INTO jueki_blockers (key, kind, prod, text, state, created_at) VALUES ('purge', 'prod-write', 1, 'again', 'pending', 9);
    `);
    db.exec("INSERT INTO coordinator_blockers (key, kind, prod, text, created_at) VALUES ('keep', 'decision', 0, 'x', 5);");
    migrate(db);
    expect(tables(db)).toEqual(NEW_TABLES);
    const r = createCoordinatorRepo(db);
    expect(r.lines("2026-11-27").map((l) => l.text)).toEqual(["closed journey #4", "new build line"]);
    expect(r.lines("2026-11-28")).toEqual([{ at: 7, text: "old build line" }]);
    // The digest message of a day the new table has stays; a day only the old build had is kept.
    expect(r.digest("2026-11-27")).toEqual({ channel: "D1", ts: "7.7" });
    expect(r.digest("2026-11-28")).toEqual({ channel: "D1", ts: "10.1" });
    // The pending prod blocker of the old build is found by key, kept pending with its notice, and not mistaken for #1.
    const moved = r.blockerByKey("pg-full");
    expect(moved).toMatchObject({ prod: true, state: "pending", noticeChannel: "D1", noticeTs: "11.1" });
    expect(moved!.id).not.toBe(r.blockerByKey("purge")!.id);
    expect(r.pending().map((b) => b.key).sort()).toEqual(["keep", "pg-full", "purge"]);
    // A key both generations have stays one row (UNIQUE key), the original's text kept.
    expect(r.blockerByKey("purge")).toMatchObject({ id: 1, text: "purge the table", prod: true });
  });

  test("a same-key blocker never loses its prod flag in the merge", () => {
    const db = new Database(":memory:");
    migrate(db);
    db.exec("INSERT INTO coordinator_blockers (key, kind, prod, text, created_at) VALUES ('k', 'decision', 0, 'x', 1);");
    db.exec(V54);
    db.exec("INSERT INTO jueki_blockers (key, kind, prod, text, created_at) VALUES ('k', 'decision', 1, 'x', 2);");
    migrate(db);
    expect(createCoordinatorRepo(db).blockerByKey("k")).toMatchObject({ prod: true });
  });
});
