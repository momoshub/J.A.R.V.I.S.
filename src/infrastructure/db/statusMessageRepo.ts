/**
 * The status messages (a turn's tool steps) that are posted and not yet taken down.
 *
 * A row is added when the message is posted and removed when it is deleted or
 * collapsed. What a boot finds left over was posted by a process that died
 * mid-turn, so it is swept (see `sweepStatusMessages`).
 */
import type { DbClient } from "./client.ts";

export type StatusMessageRow = {
  readonly channelId: string;
  readonly ts: string;
  readonly createdAt: number;
};

type Row = { channel_id: string; ts: string; created_at: number };

export type StatusMessageRepo = {
  add: (channelId: string, ts: string, at: number) => void;
  remove: (channelId: string, ts: string) => void;
  /** Oldest first. */
  list: () => StatusMessageRow[];
};

export const createStatusMessageRepo = (db: DbClient): StatusMessageRepo => {
  const insertStmt = db.query(
    `INSERT INTO status_messages (channel_id, ts, created_at)
     VALUES ($channelId, $ts, $at)
     ON CONFLICT (channel_id, ts) DO NOTHING`,
  );
  const deleteStmt = db.query("DELETE FROM status_messages WHERE channel_id = $channelId AND ts = $ts");
  const listStmt = db.query<Row, []>("SELECT * FROM status_messages ORDER BY created_at ASC, ts ASC");
  return {
    add: (channelId, ts, at) => void insertStmt.run({ $channelId: channelId, $ts: ts, $at: at }),
    remove: (channelId, ts) => void deleteStmt.run({ $channelId: channelId, $ts: ts }),
    list: () => listStmt.all().map((r) => ({ channelId: r.channel_id, ts: r.ts, createdAt: r.created_at })),
  };
};
