/**
 * Jueki's state, in the database and never in a session (see domain/jueki.ts):
 * the digest's lines and the marks that keep an item from being nudged twice,
 * the message the digest lives on, and the blockers put to the owner.
 */
import type { DbClient } from "./client.ts";
import { isBlockerKind, type BlockerKind } from "../../domain/jueki.ts";

export type JuekiBlocker = {
  readonly id: number;
  readonly key: string;
  readonly kind: BlockerKind;
  readonly prod: boolean;
  readonly text: string;
  readonly state: "pending" | "approved" | "rejected";
  readonly noticeChannel: string;
  readonly noticeTs: string;
  readonly raisedCount: number;
  readonly lastRaisedAt: number;
  /** 0 until the turn that acts on an approval has been handed it. */
  readonly handledAt: number;
  readonly createdAt: number;
  readonly decidedAt: number;
};

export type JuekiLine = { readonly at: number; readonly text: string };

type BlockerRow = {
  id: number;
  key: string;
  kind: string;
  prod: number;
  text: string;
  state: string;
  notice_channel: string;
  notice_ts: string;
  raised_count: number;
  last_raised_at: number;
  handled_at: number;
  created_at: number;
  decided_at: number;
};

const toBlocker = (r: BlockerRow): JuekiBlocker => ({
  id: r.id,
  key: r.key,
  kind: isBlockerKind(r.kind) ? r.kind : "other",
  prod: r.prod === 1,
  text: r.text,
  state: r.state === "approved" || r.state === "rejected" ? r.state : "pending",
  noticeChannel: r.notice_channel,
  noticeTs: r.notice_ts,
  raisedCount: r.raised_count,
  lastRaisedAt: r.last_raised_at,
  handledAt: r.handled_at,
  createdAt: r.created_at,
  decidedAt: r.decided_at,
});

export type JuekiRepo = {
  /** One line of the day's digest. */
  addLine: (day: string, at: number, text: string) => void;
  lines: (day: string) => JuekiLine[];
  /** Remember that `ref` was dealt with (`nudge:journey:3`), so it is not again for a while. */
  mark: (kind: string, ref: string, at: number) => void;
  /** When `ref` was last marked, or undefined. */
  lastMark: (kind: string, ref: string) => number | undefined;
  digest: (day: string) => { channel: string; ts: string } | undefined;
  setDigest: (day: string, channel: string, ts: string) => void;
  /** The blocker with this key, if any ever existed (the key is its identity). */
  blockerByKey: (key: string) => JuekiBlocker | undefined;
  blocker: (id: number) => JuekiBlocker | undefined;
  /** Opens a blocker, or returns the one already stored under the key. */
  openBlocker: (b: { key: string; kind: BlockerKind; prod: boolean; text: string }, at: number) => JuekiBlocker;
  setNotice: (id: number, channel: string, ts: string) => void;
  /** Record that it was put to the owner (again). */
  raised: (id: number, at: number) => void;
  /** First decision wins; false when it was already decided. */
  decide: (id: number, state: "approved" | "rejected", at: number) => boolean;
  pending: () => JuekiBlocker[];
  /** Approved, not yet handed to a turn. */
  approvedUnhandled: () => JuekiBlocker[];
  markHandled: (id: number, at: number) => void;
};

export const createJuekiRepo = (db: DbClient): JuekiRepo => {
  const addLine = db.query("INSERT INTO jueki_actions (day, at, kind, ref, line) VALUES ($day, $at, 'line', '', $line)");
  const linesStmt = db.query<{ at: number; line: string }, [string]>(
    "SELECT at, line FROM jueki_actions WHERE day = ? AND kind = 'line' ORDER BY id ASC",
  );
  const markStmt = db.query("INSERT INTO jueki_actions (day, at, kind, ref, line) VALUES ('', $at, $kind, $ref, '')");
  const lastMarkStmt = db.query<{ at: number | null }, [string, string]>(
    "SELECT MAX(at) AS at FROM jueki_actions WHERE kind = ? AND ref = ?",
  );
  const digestStmt = db.query<{ channel: string; ts: string }, [string]>("SELECT channel, ts FROM jueki_digest WHERE day = ?");
  const setDigestStmt = db.query(
    "INSERT INTO jueki_digest (day, channel, ts) VALUES ($day, $channel, $ts) ON CONFLICT(day) DO UPDATE SET channel = $channel, ts = $ts",
  );
  const byKeyStmt = db.query<BlockerRow, [string]>("SELECT * FROM jueki_blockers WHERE key = ?");
  const byIdStmt = db.query<BlockerRow, [number]>("SELECT * FROM jueki_blockers WHERE id = ?");
  const openStmt = db.query(
    `INSERT INTO jueki_blockers (key, kind, prod, text, created_at) VALUES ($key, $kind, $prod, $text, $at)
     ON CONFLICT(key) DO NOTHING`,
  );
  const noticeStmt = db.query("UPDATE jueki_blockers SET notice_channel = $channel, notice_ts = $ts WHERE id = $id");
  const raisedStmt = db.query(
    "UPDATE jueki_blockers SET raised_count = raised_count + 1, last_raised_at = $at WHERE id = $id",
  );
  const decideStmt = db.query(
    "UPDATE jueki_blockers SET state = $state, decided_at = $at WHERE id = $id AND state = 'pending'",
  );
  const pendingStmt = db.query<BlockerRow, []>("SELECT * FROM jueki_blockers WHERE state = 'pending' ORDER BY id ASC");
  const approvedStmt = db.query<BlockerRow, []>(
    "SELECT * FROM jueki_blockers WHERE state = 'approved' AND handled_at = 0 ORDER BY id ASC",
  );
  const handledStmt = db.query("UPDATE jueki_blockers SET handled_at = $at WHERE id = $id");

  return {
    addLine: (day, at, text) => void addLine.run({ $day: day, $at: at, $line: text }),
    lines: (day) => linesStmt.all(day).map((r) => ({ at: r.at, text: r.line })),
    mark: (kind, ref, at) => void markStmt.run({ $kind: kind, $ref: ref, $at: at }),
    lastMark: (kind, ref) => lastMarkStmt.get(kind, ref)?.at ?? undefined,
    digest: (day) => digestStmt.get(day) ?? undefined,
    setDigest: (day, channel, ts) => void setDigestStmt.run({ $day: day, $channel: channel, $ts: ts }),
    blockerByKey: (key) => {
      const r = byKeyStmt.get(key);
      return r ? toBlocker(r) : undefined;
    },
    blocker: (id) => {
      const r = byIdStmt.get(id);
      return r ? toBlocker(r) : undefined;
    },
    openBlocker: (b, at) => {
      openStmt.run({ $key: b.key, $kind: b.kind, $prod: b.prod ? 1 : 0, $text: b.text, $at: at });
      return toBlocker(byKeyStmt.get(b.key) as BlockerRow);
    },
    setNotice: (id, channel, ts) => void noticeStmt.run({ $id: id, $channel: channel, $ts: ts }),
    raised: (id, at) => void raisedStmt.run({ $id: id, $at: at }),
    decide: (id, state, at) => Number(decideStmt.run({ $id: id, $state: state, $at: at }).changes) > 0,
    pending: () => pendingStmt.all().map(toBlocker),
    approvedUnhandled: () => approvedStmt.all().map(toBlocker),
    markHandled: (id, at) => void handledStmt.run({ $id: id, $at: at }),
  };
};
