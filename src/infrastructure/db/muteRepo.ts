/**
 * Threads the bot was told to stay out of, even when tagged.
 *
 * Checked on every message the bot receives in any thread (and every DM), so
 * it is held in memory and refreshed on write, like the follow set: a SELECT
 * per line of every busy channel for an answer that changes now and then.
 */
import type { DbClient } from "./client.ts";

export type MutedThread = {
  readonly channelId: string;
  readonly threadTs: string;
  readonly mutedBy: string;
  readonly createdAt: number;
};

type Row = { channel_id: string; thread_ts: string; muted_by: string; created_at: number };

const toMuted = (r: Row): MutedThread => ({
  channelId: r.channel_id,
  threadTs: r.thread_ts,
  mutedBy: r.muted_by,
  createdAt: r.created_at,
});

export type MuteRepo = {
  /** Hot path: is this thread one it must not answer people in? */
  isMuted: (channelId: string, threadTs: string) => boolean;
  /** Returns false when it was already muted. */
  mute: (channelId: string, threadTs: string, by: string, at: number) => boolean;
  /** Returns false when it was not muted in the first place. */
  unmute: (channelId: string, threadTs: string) => boolean;
  list: (limit?: number) => MutedThread[];
  count: () => number;
};

const key = (channelId: string, threadTs: string): string => `${channelId}:${threadTs}`;

export const createMuteRepo = (db: DbClient): MuteRepo => {
  const insertStmt = db.query(
    `INSERT INTO muted_threads (channel_id, thread_ts, muted_by, created_at)
     VALUES ($channelId, $threadTs, $by, $at)
     ON CONFLICT (channel_id, thread_ts) DO NOTHING`,
  );
  const deleteStmt = db.query(
    "DELETE FROM muted_threads WHERE channel_id = $channelId AND thread_ts = $threadTs",
  );
  const listStmt = db.query<Row, [number]>("SELECT * FROM muted_threads ORDER BY created_at DESC LIMIT ?");
  const allStmt = db.query<Row, []>("SELECT * FROM muted_threads");

  const live = new Set<string>(allStmt.all().map((r) => key(r.channel_id, r.thread_ts)));

  return {
    isMuted: (channelId, threadTs) => live.has(key(channelId, threadTs)),
    mute: (channelId, threadTs, by, at) => {
      const added = !live.has(key(channelId, threadTs));
      insertStmt.run({ $channelId: channelId, $threadTs: threadTs, $by: by, $at: at });
      live.add(key(channelId, threadTs));
      return added;
    },
    unmute: (channelId, threadTs) => {
      const had = live.delete(key(channelId, threadTs));
      deleteStmt.run({ $channelId: channelId, $threadTs: threadTs });
      return had;
    },
    list: (limit = 50) => listStmt.all(Math.max(1, limit)).map(toMuted),
    count: () => live.size,
  };
};
