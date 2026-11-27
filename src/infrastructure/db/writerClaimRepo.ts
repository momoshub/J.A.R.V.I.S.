/** The claim table: who holds which job (domain/writerClaim.ts). A released claim keeps its row, so there is a trail. */
import type { DbClient } from "./client.ts";
import type { ClaimFacts } from "../../domain/writerClaim.ts";

type Row = {
  id: number;
  key: string;
  dispatch_id: string;
  channel_id: string;
  thread_ts: string;
  actor: string;
  created_at: number;
};

const toClaim = (r: Row): ClaimFacts => ({
  id: r.id,
  key: r.key,
  dispatchId: r.dispatch_id,
  channelId: r.channel_id,
  threadTs: r.thread_ts,
  actor: r.actor,
  createdAt: r.created_at,
});

export type WriterClaimRepo = {
  /** Every claim not released, oldest first. */
  live: () => ClaimFacts[];
  liveOfKey: (key: string) => ClaimFacts[];
  add: (c: Omit<ClaimFacts, "id" | "dispatchId">, at: number) => ClaimFacts;
  /** Back to pending and re-stamped: the same thread asked again before its writer started. */
  refresh: (id: number, at: number) => void;
  bind: (id: number, dispatchId: string) => void;
  /** False when it was already released. */
  release: (id: number, why: string, at: number) => boolean;
  /** Release every live claim of a dispatch; how many. */
  releaseDispatch: (dispatchId: string, why: string, at: number) => number;
};

export const createWriterClaimRepo = (db: DbClient): WriterClaimRepo => {
  const liveStmt = db.query<Row, []>("SELECT * FROM writer_claims WHERE released_at IS NULL ORDER BY id ASC");
  const keyStmt = db.query<Row, [string]>("SELECT * FROM writer_claims WHERE key = ? AND released_at IS NULL ORDER BY id ASC");
  const insertStmt = db.query<Row, Record<string, string | number>>(
    `INSERT INTO writer_claims (key, channel_id, thread_ts, actor, created_at)
     VALUES ($key, $channelId, $threadTs, $actor, $at) RETURNING *`,
  );
  const refreshStmt = db.query("UPDATE writer_claims SET created_at = ? WHERE id = ? AND released_at IS NULL");
  const bindStmt = db.query("UPDATE writer_claims SET dispatch_id = ? WHERE id = ? AND released_at IS NULL");
  const releaseStmt = db.query("UPDATE writer_claims SET released_at = ?, released_why = ? WHERE id = ? AND released_at IS NULL");
  const releaseDispatchStmt = db.query(
    "UPDATE writer_claims SET released_at = ?, released_why = ? WHERE dispatch_id = ? AND dispatch_id != '' AND released_at IS NULL",
  );
  return {
    live: () => liveStmt.all().map(toClaim),
    liveOfKey: (key) => keyStmt.all(key).map(toClaim),
    add: (c, at) => {
      const row = insertStmt.get({ $key: c.key, $channelId: c.channelId, $threadTs: c.threadTs, $actor: c.actor, $at: at });
      if (!row) throw new Error("claim insert returned no row");
      return toClaim(row);
    },
    refresh: (id, at) => void refreshStmt.run(at, id),
    bind: (id, dispatchId) => void bindStmt.run(dispatchId, id),
    release: (id, why, at) => Number(releaseStmt.run(at, why, id).changes) > 0,
    releaseDispatch: (dispatchId, why, at) => Number(releaseDispatchStmt.run(at, why, dispatchId).changes),
  };
};
