/**
 * Learnings repository - durable facts the bot carries into every reply, curated
 * from the dashboard.
 *
 * Each row has a status and only `active` ones are ever read back as a
 * learning: `list()` is what reaches a prompt and the dashboard count, so a
 * pending or rejected row cannot be injected by a caller that forgot to filter.
 * The owner decides pending ones (`application/learningApproval.ts`).
 */
import type { DbClient } from "./client.ts";
import type { Learning } from "../../domain/types.ts";
import { parseStoredScope, serializeScope, type LearningScope, type LearningSource, type LearningStatus } from "../../domain/learning.ts";

type Row = {
  id: number;
  content: string;
  created_by: string;
  created_at: number;
  status: LearningStatus;
  notice_channel: string;
  notice_ts: string;
  notice_fingerprint: string;
  source_channel: string;
  source_thread_ts: string;
  source_run_id: string;
  scope_channels: string;
};

const toLearning = (row: Row): Learning => ({
  id: row.id,
  content: row.content,
  createdBy: row.created_by,
  createdAt: row.created_at,
  status: row.status,
  noticeChannel: row.notice_channel,
  noticeTs: row.notice_ts,
  noticeFingerprint: row.notice_fingerprint,
  sourceChannel: row.source_channel,
  sourceThreadTs: row.source_thread_ts,
  sourceRunId: row.source_run_id,
  scope: parseStoredScope(row.scope_channels),
});

export type LearningsRepo = {
  /** Active learnings only - what is injected into replies. */
  list: () => Learning[];
  /** Learnings waiting for the owner, oldest first. Never injected. */
  pending: () => Learning[];
  /** Any learning whatever its status. */
  get: (id: number) => Learning | undefined;
  /** The status is explicit: nothing is saved active by accident. */
  add: (content: string, createdBy: string, createdAt: number, status: LearningStatus, source?: LearningSource, scope?: LearningScope) => Learning;
  /** Where it applies: a channel id list, empty for global. */
  setScope: (id: number, scope: LearningScope) => void;
  /** New wording, and the status it now has (a rewording by anyone but the owner is pending again). */
  update: (id: number, content: string, status: LearningStatus) => void;
  /** Where the owner's Approve / Reject message for a pending learning lives. */
  setNotice: (id: number, channel: string, ts: string, fingerprint?: string) => void;
  /** The fingerprint of the notice after the bot rewrote it ('' when it no longer carries buttons). */
  setNoticeFingerprint: (id: number, fingerprint: string) => void;
  /** Set the learning's status once: false when it already has it (a double press) or is gone. A decided one can be flipped. */
  decide: (id: number, status: "active" | "rejected", by: string, at: number) => boolean;
  remove: (id: number) => void;
};

export const createLearningsRepo = (db: DbClient): LearningsRepo => {
  const listStmt = db.query<Row, []>(
    "SELECT * FROM learnings WHERE status = 'active' ORDER BY created_at ASC, id ASC",
  );
  const pendingStmt = db.query<Row, []>(
    "SELECT * FROM learnings WHERE status = 'pending' ORDER BY created_at ASC, id ASC",
  );
  const getStmt = db.query<Row, { $id: number }>("SELECT * FROM learnings WHERE id = $id");
  const insertStmt = db.query(
    `INSERT INTO learnings (content, created_by, created_at, status, source_channel, source_thread_ts, source_run_id, scope_channels)
     VALUES ($content, $createdBy, $createdAt, $status, $sourceChannel, $sourceThreadTs, $sourceRunId, $scope) RETURNING *`,
  );
  const updateStmt = db.query(
    `UPDATE learnings
        SET content = $content, status = $status,
            notice_channel = CASE WHEN $status = 'pending' THEN '' ELSE notice_channel END,
            notice_ts = CASE WHEN $status = 'pending' THEN '' ELSE notice_ts END,
            notice_fingerprint = CASE WHEN $status = 'pending' THEN '' ELSE notice_fingerprint END
      WHERE id = $id`,
  );
  const noticeStmt = db.query(
    "UPDATE learnings SET notice_channel = $channel, notice_ts = $ts, notice_fingerprint = $fingerprint WHERE id = $id",
  );
  const fingerprintStmt = db.query("UPDATE learnings SET notice_fingerprint = $fingerprint WHERE id = $id");
  const decideStmt = db.query(
    `UPDATE learnings SET status = $status, decided_by = $by, decided_at = $at
      WHERE id = $id AND status != $status`,
  );
  const scopeStmt = db.query("UPDATE learnings SET scope_channels = $scope WHERE id = $id");
  const removeStmt = db.query("DELETE FROM learnings WHERE id = $id");

  return {
    list: () => listStmt.all().map(toLearning),
    pending: () => pendingStmt.all().map(toLearning),
    get: (id) => {
      const row = getStmt.get({ $id: id });
      return row ? toLearning(row) : undefined;
    },
    add: (content, createdBy, createdAt, status, source, scope) => {
      const row = insertStmt.get({
        $content: content,
        $createdBy: createdBy,
        $createdAt: createdAt,
        $status: status,
        $sourceChannel: source?.channel ?? "",
        $sourceThreadTs: source?.threadTs ?? "",
        $sourceRunId: source?.runId ?? "",
        $scope: serializeScope(scope ?? []),
      }) as Row;
      return toLearning(row);
    },
    update: (id, content, status) => {
      updateStmt.run({ $id: id, $content: content, $status: status });
    },
    setNotice: (id, channel, ts, fingerprint = "") => {
      noticeStmt.run({ $id: id, $channel: channel, $ts: ts, $fingerprint: fingerprint });
    },
    setNoticeFingerprint: (id, fingerprint) => {
      fingerprintStmt.run({ $id: id, $fingerprint: fingerprint });
    },
    decide: (id, status, by, at) =>
      Number(decideStmt.run({ $id: id, $status: status, $by: by, $at: at }).changes) > 0,
    setScope: (id, scope) => {
      scopeStmt.run({ $id: id, $scope: serializeScope(scope) });
    },
    remove: (id) => {
      removeStmt.run({ $id: id });
    },
  };
};
