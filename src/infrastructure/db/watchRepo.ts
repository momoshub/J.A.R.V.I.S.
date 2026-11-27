/**
 * Things the bot is waiting for.
 *
 * Durable on purpose: a watch that vanished on restart would be the same
 * broken promise it exists to prevent, only harder to notice. A restart
 * re-reads them and carries on polling.
 */
import type { DbClient } from "./client.ts";
import type { WatchState } from "../../domain/watch.ts";
import { MAX_WRITE_TARGETS, parseTargets, serializeTargets, type WriteTarget } from "../../domain/writeTargets.ts";

export type Watch = {
  readonly id: number;
  readonly channelId: string;
  readonly threadTs: string;
  readonly slackUserId: string;
  readonly note: string;
  readonly check: string;
  readonly everyMs: number;
  readonly deadlineAt: number;
  readonly nextAt: number;
  readonly state: WatchState;
  readonly attempts: number;
  readonly errors: number;
  readonly lastError: string;
  readonly createdAt: number;
  /**
   * The owner's Slack id when the watch was created in the owner's own turn; empty for every other watch (and every row from
   * before the column), which then fires exactly as it always did.
   */
  readonly createdBy: string;
  /** Where the fired turn may write besides its own thread, as the owner's turn named them; empty means nowhere. */
  readonly writeTargets: readonly WriteTarget[];
  /** The watch whose fired turn re-armed this one and handed it (a subset of) its grant; 0 for any other watch. For the audit trail only. */
  readonly parentWatchId: number;
};

export type NewWatch = Omit<Watch, "id" | "state" | "attempts" | "errors" | "lastError" | "nextAt" | "createdBy" | "writeTargets" | "parentWatchId"> & {
  readonly createdBy?: string;
  readonly writeTargets?: readonly WriteTarget[];
  readonly parentWatchId?: number;
};

type Row = {
  id: number;
  channel_id: string;
  thread_ts: string;
  slack_user_id: string;
  note: string;
  check_cmd: string;
  every_ms: number;
  deadline_at: number;
  next_at: number;
  state: string;
  attempts: number;
  errors: number;
  last_error: string;
  created_at: number;
  created_by: string | null;
  write_targets: string | null;
  parent_watch_id: number | null;
};

const STATES: readonly string[] = ["waiting", "fired", "expired", "cancelled", "failed"];
const asState = (v: string): WatchState => (STATES.includes(v) ? (v as WatchState) : "waiting");

const toWatch = (r: Row): Watch => ({
  id: r.id,
  channelId: r.channel_id,
  threadTs: r.thread_ts,
  slackUserId: r.slack_user_id,
  note: r.note,
  check: r.check_cmd,
  everyMs: r.every_ms,
  deadlineAt: r.deadline_at,
  nextAt: r.next_at,
  state: asState(r.state),
  attempts: r.attempts,
  errors: r.errors,
  lastError: r.last_error,
  createdAt: r.created_at,
  createdBy: r.created_by ?? "",
  writeTargets: parseTargets(r.write_targets),
  parentWatchId: r.parent_watch_id ?? 0,
});

export type WatchRepo = {
  add: (w: NewWatch, at: number) => Watch;
  /** Watches whose next check is due, oldest first. */
  due: (now: number, limit?: number) => Watch[];
  /** Still waiting, for `watch list` and for the mindful report. */
  waiting: (limit?: number) => Watch[];
  get: (id: number) => Watch | undefined;
  /** Push the next check out, counting the attempt (and any error). */
  reschedule: (id: number, nextAt: number, at: number, error?: string) => void;
  settle: (id: number, state: WatchState, at: number, error?: string) => void;
  /** End one watch if it is still waiting; false when it had already ended (or never existed). */
  cancel: (id: number, at: number) => boolean;
  /** End every watch on a thread; returns how many. */
  cancelThread: (channelId: string, threadTs: string, at: number) => number;
  /** Waiting watches bound to a thread. */
  waitingAt: (channelId: string, threadTs: string) => number;
  /** Watches that ran out of time or kept failing (`expired`, `failed`) since `since` (ms), newest first. */
  lapsedSince: (since: number, limit?: number) => Watch[];
  /** Re-bind the waiting watches of one thread to another; returns how many. */
  rebind: (channelId: string, fromTs: string, toTs: string) => number;
};

export const createWatchRepo = (db: DbClient): WatchRepo => {
  const insertStmt = db.query(
    `INSERT INTO watches
       (channel_id, thread_ts, slack_user_id, note, check_cmd, every_ms, deadline_at, next_at,
        state, attempts, errors, last_error, created_at, updated_at, created_by, write_targets, parent_watch_id)
     VALUES ($channelId, $threadTs, $slackUserId, $note, $check, $everyMs, $deadlineAt, $nextAt,
        'waiting', 0, 0, '', $at, $at, $createdBy, $writeTargets, $parentWatchId)
     RETURNING *`,
  );
  const dueStmt = db.query<Row, [number, number]>(
    "SELECT * FROM watches WHERE state = 'waiting' AND next_at <= ? ORDER BY next_at ASC LIMIT ?",
  );
  const waitingStmt = db.query<Row, [number]>(
    "SELECT * FROM watches WHERE state = 'waiting' ORDER BY id ASC LIMIT ?",
  );
  const getStmt = db.query<Row, [number]>("SELECT * FROM watches WHERE id = ?");
  const rescheduleStmt = db.query(
    `UPDATE watches SET next_at = $nextAt, attempts = attempts + 1, updated_at = $at,
       errors = CASE WHEN $error = '' THEN 0 ELSE errors + 1 END,
       last_error = $error
     WHERE id = $id`,
  );
  const settleStmt = db.query(
    "UPDATE watches SET state = $state, updated_at = $at, last_error = COALESCE($error, last_error) WHERE id = $id",
  );
  const cancelStmt = db.query(
    "UPDATE watches SET state = 'cancelled', updated_at = $at WHERE id = $id AND state = 'waiting'",
  );
  const cancelThreadStmt = db.query(
    "UPDATE watches SET state = 'cancelled', updated_at = $at WHERE channel_id = $channelId AND thread_ts = $threadTs AND state = 'waiting'",
  );

  const lapsedStmt = db.query<Row, [number, number]>(
    "SELECT * FROM watches WHERE state IN ('expired', 'failed') AND updated_at >= ? ORDER BY updated_at DESC LIMIT ?",
  );
  const waitingAtStmt = db.query<{ n: number }, [string, string]>(
    "SELECT COUNT(*) AS n FROM watches WHERE channel_id = ? AND thread_ts = ? AND state = 'waiting'",
  );
  const rebindStmt = db.query(
    "UPDATE watches SET thread_ts = $toTs WHERE channel_id = $channelId AND thread_ts = $fromTs AND state = 'waiting'",
  );

  return {
    lapsedSince: (since, limit = 50) => lapsedStmt.all(since, Math.max(1, limit)).map(toWatch),
    waitingAt: (channelId, threadTs) => waitingAtStmt.get(channelId, threadTs)?.n ?? 0,
    rebind: (channelId, fromTs, toTs) => rebindStmt.run({ $channelId: channelId, $fromTs: fromTs, $toTs: toTs }).changes,
    add: (w, at) =>
      toWatch(
        insertStmt.get({
          $channelId: w.channelId,
          $threadTs: w.threadTs,
          $slackUserId: w.slackUserId,
          $note: w.note.slice(0, 2000),
          $check: w.check.slice(0, 2000),
          $everyMs: w.everyMs,
          $deadlineAt: w.deadlineAt,
          // The first check waits one interval: whatever it is watching has
          // only just been started, so asking immediately is a wasted probe.
          $nextAt: at + w.everyMs,
          $at: at,
          // Targets only mean something with a creator: the grant is the owner's turn's, never anyone else's.
          $createdBy: w.createdBy ?? "",
          $writeTargets: w.createdBy ? serializeTargets((w.writeTargets ?? []).slice(0, MAX_WRITE_TARGETS)) : "",
          // Only a watch that holds a grant has a parent worth naming.
          $parentWatchId: w.createdBy && w.writeTargets?.length ? (w.parentWatchId ?? 0) : 0,
        }) as Row,
      ),
    due: (now, limit = 20) => dueStmt.all(now, Math.max(1, limit)).map(toWatch),
    waiting: (limit = 50) => waitingStmt.all(Math.max(1, limit)).map(toWatch),
    get: (id) => {
      const r = getStmt.get(id);
      return r ? toWatch(r) : undefined;
    },
    reschedule: (id, nextAt, at, error = "") =>
      void rescheduleStmt.run({ $id: id, $nextAt: nextAt, $at: at, $error: error.slice(0, 300) }),
    settle: (id, state, at, error) =>
      void settleStmt.run({ $id: id, $state: state, $at: at, $error: error?.slice(0, 300) ?? null }),
    cancel: (id, at) => cancelStmt.run({ $id: id, $at: at }).changes > 0,
    cancelThread: (channelId, threadTs, at) =>
      Number(cancelThreadStmt.run({ $channelId: channelId, $threadTs: threadTs, $at: at }).changes),
  };
};
