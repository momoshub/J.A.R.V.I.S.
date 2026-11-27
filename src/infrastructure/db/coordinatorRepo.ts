/**
 * The coordinator's state, in the database and never in a session (see domain/coordinator.ts):
 * the digest's lines and the marks that keep an item from being nudged twice,
 * the message the digest lives on, and the blockers put to the owner.
 */
import type { DbClient } from "./client.ts";
import { addDayUsage, isBlockerKind, type BlockerKind, type DayUsage } from "../../domain/coordinator.ts";
import type { FooterUsage } from "../../domain/usageFooter.ts";

export type CoordinatorBlocker = {
  readonly id: number;
  readonly key: string;
  readonly kind: BlockerKind;
  readonly prod: boolean;
  readonly text: string;
  readonly state: "pending" | "approved" | "rejected" | "fixed";
  readonly noticeChannel: string;
  readonly noticeTs: string;
  readonly raisedCount: number;
  readonly lastRaisedAt: number;
  /** 0 until the turn that acts on an approval has been handed it. */
  readonly handledAt: number;
  readonly createdAt: number;
  readonly decidedAt: number;
};

export type CoordinatorLine = { readonly at: number; readonly text: string };

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

const NUM_FIELDS = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "costUsd", "durationMs"] as const;

/** The last tick's usage as stored; undefined for a row that does not read back as one. */
const parseUsage = (raw: string): FooterUsage | undefined => {
  try {
    const v: unknown = JSON.parse(raw);
    if (typeof v !== "object" || v === null) return undefined;
    const r = v as Record<string, unknown>;
    if (typeof r.model !== "string" || NUM_FIELDS.some((k) => typeof r[k] !== "number")) return undefined;
    return {
      model: r.model,
      inputTokens: r.inputTokens as number,
      outputTokens: r.outputTokens as number,
      cacheReadTokens: r.cacheReadTokens as number,
      cacheWriteTokens: r.cacheWriteTokens as number,
      costUsd: r.costUsd as number,
      durationMs: r.durationMs as number,
    };
  } catch {
    return undefined;
  }
};

const toBlocker = (r: BlockerRow): CoordinatorBlocker => ({
  id: r.id,
  key: r.key,
  kind: isBlockerKind(r.kind) ? r.kind : "other",
  prod: r.prod === 1,
  text: r.text,
  state: r.state === "approved" || r.state === "rejected" || r.state === "fixed" ? r.state : "pending",
  noticeChannel: r.notice_channel,
  noticeTs: r.notice_ts,
  raisedCount: r.raised_count,
  lastRaisedAt: r.last_raised_at,
  handledAt: r.handled_at,
  createdAt: r.created_at,
  decidedAt: r.decided_at,
});

export type CoordinatorRepo = {
  /** One line of the day's digest. */
  addLine: (day: string, at: number, text: string) => void;
  lines: (day: string) => CoordinatorLine[];
  /** Remember that `ref` was dealt with (`nudge:journey:3`), so it is not again for a while. */
  mark: (kind: string, ref: string, at: number) => void;
  /** When `ref` was last marked, or undefined. */
  lastMark: (kind: string, ref: string) => number | undefined;
  /** Adds one tick's usage to the day's total, which survives a restart. */
  addUsage: (day: string, u: FooterUsage) => void;
  /** What the day's ticks cost; undefined when none has reported. */
  usage: (day: string) => DayUsage | undefined;
  digest: (day: string) => { channel: string; ts: string } | undefined;
  setDigest: (day: string, channel: string, ts: string) => void;
  /** The blocker with this key, if any ever existed (the key is its identity). */
  blockerByKey: (key: string) => CoordinatorBlocker | undefined;
  blocker: (id: number) => CoordinatorBlocker | undefined;
  /**
   * Opens a blocker, or returns the one already stored under the key. A key stored non-prod that is
   * raised again as prod BECOMES prod (never the other way): a prod blocker must never fall under the
   * once-only rule. A key the coordinator fixed itself opens again from nothing.
   */
  openBlocker: (b: { key: string; kind: BlockerKind; prod: boolean; text: string }, at: number) => CoordinatorBlocker;
  setNotice: (id: number, channel: string, ts: string) => void;
  /** Record that it was put to the owner (again). */
  raised: (id: number, at: number) => void;
  /** The coordinator fixed it itself under the prod rule: closes a still pending row; false when it was not pending. */
  close: (id: number, at: number) => boolean;
  /** First decision wins; false when it was already decided. */
  decide: (id: number, state: "approved" | "rejected", at: number) => boolean;
  pending: () => CoordinatorBlocker[];
  /** Approved, not yet handed to a turn. */
  approvedUnhandled: () => CoordinatorBlocker[];
  markHandled: (id: number, at: number) => void;
};

export const createCoordinatorRepo = (db: DbClient): CoordinatorRepo => {
  const addLine = db.query("INSERT INTO coordinator_actions (day, at, kind, ref, line) VALUES ($day, $at, 'line', '', $line)");
  const linesStmt = db.query<{ at: number; line: string }, [string]>(
    "SELECT at, line FROM coordinator_actions WHERE day = ? AND kind = 'line' ORDER BY id ASC",
  );
  const markStmt = db.query("INSERT INTO coordinator_actions (day, at, kind, ref, line) VALUES ('', $at, $kind, $ref, '')");
  const lastMarkStmt = db.query<{ at: number | null }, [string, string]>(
    "SELECT MAX(at) AS at FROM coordinator_actions WHERE kind = ? AND ref = ?",
  );
  const digestStmt = db.query<{ channel: string; ts: string }, [string]>("SELECT channel, ts FROM coordinator_digest WHERE day = ?");
  const setDigestStmt = db.query(
    "INSERT INTO coordinator_digest (day, channel, ts) VALUES ($day, $channel, $ts) ON CONFLICT(day) DO UPDATE SET channel = $channel, ts = $ts",
  );
  const usageStmt = db.query<{ ticks: number; cost: number; tokens: number; last: string }, [string]>(
    "SELECT ticks, cost, tokens, last FROM coordinator_usage WHERE day = ?",
  );
  const setUsageStmt = db.query(
    "INSERT INTO coordinator_usage (day, ticks, cost, tokens, last) VALUES ($day, $ticks, $cost, $tokens, $last) ON CONFLICT(day) DO UPDATE SET ticks = $ticks, cost = $cost, tokens = $tokens, last = $last",
  );
  const readUsage = (day: string): DayUsage | undefined => {
    const r = usageStmt.get(day);
    const last = r ? parseUsage(r.last) : undefined;
    return r && last ? { ticks: r.ticks, costUsd: r.cost, tokens: r.tokens, last } : undefined;
  };
  const byKeyStmt = db.query<BlockerRow, [string]>("SELECT * FROM coordinator_blockers WHERE key = ?");
  const byIdStmt = db.query<BlockerRow, [number]>("SELECT * FROM coordinator_blockers WHERE id = ?");
  const openStmt = db.query(
    `INSERT INTO coordinator_blockers (key, kind, prod, text, created_at) VALUES ($key, $kind, $prod, $text, $at)
     ON CONFLICT(key) DO UPDATE SET
       prod = MAX(coordinator_blockers.prod, excluded.prod),
       kind = CASE WHEN coordinator_blockers.state = 'fixed' THEN excluded.kind ELSE coordinator_blockers.kind END,
       text = CASE WHEN coordinator_blockers.state = 'fixed' THEN excluded.text ELSE coordinator_blockers.text END,
       raised_count = CASE WHEN coordinator_blockers.state = 'fixed' THEN 0 ELSE coordinator_blockers.raised_count END,
       last_raised_at = CASE WHEN coordinator_blockers.state = 'fixed' THEN 0 ELSE coordinator_blockers.last_raised_at END,
       notice_channel = CASE WHEN coordinator_blockers.state = 'fixed' THEN '' ELSE coordinator_blockers.notice_channel END,
       notice_ts = CASE WHEN coordinator_blockers.state = 'fixed' THEN '' ELSE coordinator_blockers.notice_ts END,
       handled_at = CASE WHEN coordinator_blockers.state = 'fixed' THEN 0 ELSE coordinator_blockers.handled_at END,
       decided_at = CASE WHEN coordinator_blockers.state = 'fixed' THEN 0 ELSE coordinator_blockers.decided_at END,
       state = CASE WHEN coordinator_blockers.state = 'fixed' THEN 'pending' ELSE coordinator_blockers.state END`,
  );
  const noticeStmt = db.query("UPDATE coordinator_blockers SET notice_channel = $channel, notice_ts = $ts WHERE id = $id");
  const raisedStmt = db.query(
    "UPDATE coordinator_blockers SET raised_count = raised_count + 1, last_raised_at = $at WHERE id = $id",
  );
  const decideStmt = db.query(
    "UPDATE coordinator_blockers SET state = $state, decided_at = $at WHERE id = $id AND state = 'pending'",
  );
  const closeStmt = db.query(
    "UPDATE coordinator_blockers SET state = 'fixed', decided_at = $at WHERE id = $id AND state = 'pending'",
  );
  const pendingStmt = db.query<BlockerRow, []>("SELECT * FROM coordinator_blockers WHERE state = 'pending' ORDER BY id ASC");
  const approvedStmt = db.query<BlockerRow, []>(
    "SELECT * FROM coordinator_blockers WHERE state = 'approved' AND handled_at = 0 ORDER BY id ASC",
  );
  const handledStmt = db.query("UPDATE coordinator_blockers SET handled_at = $at WHERE id = $id");

  return {
    addLine: (day, at, text) => void addLine.run({ $day: day, $at: at, $line: text }),
    lines: (day) => linesStmt.all(day).map((r) => ({ at: r.at, text: r.line })),
    mark: (kind, ref, at) => void markStmt.run({ $kind: kind, $ref: ref, $at: at }),
    lastMark: (kind, ref) => lastMarkStmt.get(kind, ref)?.at ?? undefined,
    addUsage: (day, u) => {
      const next = addDayUsage(readUsage(day), u);
      setUsageStmt.run({ $day: day, $ticks: next.ticks, $cost: next.costUsd, $tokens: next.tokens, $last: JSON.stringify(u) });
    },
    usage: readUsage,
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
    close: (id, at) => Number(closeStmt.run({ $id: id, $at: at }).changes) > 0,
    decide: (id, state, at) => Number(decideStmt.run({ $id: id, $state: state, $at: at }).changes) > 0,
    pending: () => pendingStmt.all().map(toBlocker),
    approvedUnhandled: () => approvedStmt.all().map(toBlocker),
    markHandled: (id, at) => void handledStmt.run({ $id: id, $at: at }),
  };
};
