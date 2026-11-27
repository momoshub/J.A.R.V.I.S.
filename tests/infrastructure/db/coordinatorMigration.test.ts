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

  test("both generations present (a cut-short rename): the rows of both are kept, the old tables go", () => {
    const db = legacyDb();
    migrate(db);
    // A build from before the rename ran against the same file again and recreated its tables, with two rows:
    // one whose id is already taken in the new table, one that is not.
    db.exec(V54);
    db.exec("INSERT INTO jueki_actions (id, day, at, kind, ref, line) VALUES (1, 'x', 1, 'line', '', 'clash'), (50, '2026-11-28', 6, 'line', '', 'late line');");
    migrate(db);
    expect(tables(db)).toEqual(NEW_TABLES);
    const r = createCoordinatorRepo(db);
    expect(r.lines("2026-11-27")).toEqual([{ at: 5, text: "closed journey #4" }]);
    expect(r.lines("2026-11-28")).toEqual([{ at: 6, text: "late line" }]);
    expect(r.lines("x")).toEqual([]);
  });
});
