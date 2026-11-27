/**
 * Message repository - the bot's conversation memory, keyed by channel.
 */
import type { DbClient } from "./client.ts";
import type {
  MessageRole,
  NewMessage,
  StoredMessage,
} from "../../domain/types.ts";

type Row = {
  id: number;
  channel_id: string;
  slack_user_id: string;
  role: MessageRole;
  content: string;
  created_at: number;
  slack_ts: string;
  thread_ts: string;
  via_bot: number;
};

const toMessage = (row: Row): StoredMessage => ({
  id: row.id,
  channelId: row.channel_id,
  slackUserId: row.slack_user_id,
  role: row.role,
  content: row.content,
  createdAt: row.created_at,
  ...(row.slack_ts ? { slackTs: row.slack_ts } : {}),
  ...(row.thread_ts ? { threadTs: row.thread_ts } : {}),
  ...(row.via_bot ? { viaBot: true } : {}),
});

/** A channel summary for the console's "in DB" badges. */
export type ChannelSummary = {
  channelId: string;
  count: number;
  lastAt: number;
};

/** One thread's stored turns - the thread root's ts is the key the bot's memory uses. */
export type ThreadSummary = {
  threadTs: string;
  count: number;
  lastAt: number;
};

/** A time window over `created_at` (ms): `since` inclusive, `before` exclusive. Either may be left out. */
export type TimeRange = { since?: number; before?: number };

export type MessageRepo = {
  append: (message: NewMessage, createdAt: number) => StoredMessage;
  /** Recent turns for a channel, returned oldest-first. Every thread in it. */
  recentForChannel: (channelId: string, limit: number) => StoredMessage[];
  /**
   * Recent turns for one thread, oldest-first - the window the brain actually
   * gets, so a conversation cannot bleed into an unrelated one next door.
   */
  recentForThread: (channelId: string, threadTs: string, limit: number) => StoredMessage[];
  /**
   * The newest `user` turns of a channel (one thread when given) whose text opens
   * with one of `prefixes`, oldest-first: the console's hidden steer turns, found
   * without reading the whole history.
   */
  userTurnsStartingWith: (channelId: string, prefixes: readonly string[], limit: number, threadTs?: string, range?: TimeRange) => StoredMessage[];
  /**
   * The newest `limit` turns (any role) of a channel - one thread when given, else only those outside a
   * thread or opening one - written inside `range`, oldest-first: the DB copy the console lays over
   * a Slack page to find what Slack no longer has.
   */
  turnsInRange: (channelId: string, limit: number, threadTs?: string, range?: TimeRange) => StoredMessage[];
  clearChannel: (channelId: string) => number;
  count: () => number;
  /** Distinct channels with a turn count, most-recently-active first. */
  channels: () => ChannelSummary[];
  /** Distinct threads of one channel with a stored turn, most-recently-active first. Turns outside any thread are not listed. */
  threads: (channelId: string) => ThreadSummary[];
  /** Forget one thread's turns only (channel-level turns and other threads stay). Returns how many went. */
  clearThread: (channelId: string, threadTs: string) => number;
  /**
   * Threads whose newest stored turn is the bot's, written between `since` and
   * `before` (ms), newest first, with the person that thread last heard from.
   */
  endedOnBot: (since: number, before: number, limit: number) => EndedThread[];
  /**
   * Threads whose newest stored turn is this person's own message (not one the bot wrote for itself),
   * written between `since` and `before` (ms), oldest first: what nobody answered.
   */
  endedOnUser: (slackUserId: string, since: number, before: number, limit: number) => EndedThread[];
};

export type EndedThread = { channelId: string; threadTs: string; lastAt: number; slackUserId: string };

const rangeSql = (r?: TimeRange): string =>
  `${r?.since === undefined ? "" : " AND created_at >= ?"}${r?.before === undefined ? "" : " AND created_at < ?"}`;
const rangeArgs = (r?: TimeRange): number[] => [...(r?.since === undefined ? [] : [r.since]), ...(r?.before === undefined ? [] : [r.before])];

export const createMessageRepo = (db: DbClient): MessageRepo => {
  const endedStmt = db.query<{ channel_id: string; thread_ts: string; created_at: number; user_id: string | null }, [number, number, number]>(
    `SELECT m.channel_id, m.thread_ts, m.created_at,
       (SELECT u.slack_user_id FROM messages u
         WHERE u.channel_id = m.channel_id AND u.thread_ts = m.thread_ts AND u.role = 'user'
         ORDER BY u.id DESC LIMIT 1) AS user_id
     FROM messages m
     WHERE m.thread_ts != '' AND m.role = 'assistant' AND m.created_at >= ? AND m.created_at <= ?
       AND m.id = (SELECT MAX(x.id) FROM messages x WHERE x.channel_id = m.channel_id AND x.thread_ts = m.thread_ts)
     ORDER BY m.created_at DESC LIMIT ?`,
  );
  const endedUserStmt = db.query<{ channel_id: string; thread_ts: string; created_at: number }, [string, number, number, number]>(
    `SELECT m.channel_id, m.thread_ts, m.created_at
     FROM messages m
     WHERE m.role = 'user' AND m.via_bot = 0 AND m.slack_user_id = ? AND m.created_at >= ? AND m.created_at <= ?
       AND m.id = (SELECT MAX(x.id) FROM messages x WHERE x.channel_id = m.channel_id AND x.thread_ts = m.thread_ts)
     ORDER BY m.created_at ASC LIMIT ?`,
  );
  const insertStmt = db.query(
    `INSERT INTO messages (channel_id, slack_user_id, role, content, created_at, slack_ts, thread_ts, via_bot)
     VALUES ($channelId, $slackUserId, $role, $content, $createdAt, $slackTs, $threadTs, $viaBot)
     RETURNING *`,
  );
  const recentStmt = db.query<Row, [string, number]>(
    `SELECT * FROM (
       SELECT * FROM messages WHERE channel_id = ? ORDER BY id DESC LIMIT ?
     ) ORDER BY id ASC`,
  );
  const recentThreadStmt = db.query<Row, [string, string, number]>(
    `SELECT * FROM (
       SELECT * FROM messages WHERE channel_id = ? AND thread_ts = ? ORDER BY id DESC LIMIT ?
     ) ORDER BY id ASC`,
  );
  const clearStmt = db.query("DELETE FROM messages WHERE channel_id = $channelId");
  const countStmt = db.query<{ n: number }, []>(
    "SELECT COUNT(*) AS n FROM messages",
  );
  const channelsStmt = db.query<{ channel_id: string; n: number; last_at: number }, []>(
    `SELECT channel_id, COUNT(*) AS n, MAX(created_at) AS last_at
     FROM messages GROUP BY channel_id ORDER BY last_at DESC`,
  );

  const threadsStmt = db.query<{ thread_ts: string; n: number; last_at: number }, [string]>(
    `SELECT thread_ts, COUNT(*) AS n, MAX(created_at) AS last_at
     FROM messages WHERE channel_id = ? AND thread_ts != ''
     GROUP BY thread_ts ORDER BY last_at DESC, thread_ts DESC`,
  );
  const clearThreadStmt = db.query("DELETE FROM messages WHERE channel_id = $channelId AND thread_ts = $threadTs");

  return {
    threads: (channelId) =>
      threadsStmt.all(channelId).map((r) => ({ threadTs: r.thread_ts, count: r.n, lastAt: r.last_at })),
    clearThread: (channelId, threadTs) => {
      if (!threadTs) return 0;
      return Number(clearThreadStmt.run({ $channelId: channelId, $threadTs: threadTs }).changes);
    },
    endedOnBot: (since, before, limit) =>
      endedStmt.all(since, before, Math.max(1, limit)).flatMap((r) =>
        r.user_id ? [{ channelId: r.channel_id, threadTs: r.thread_ts, lastAt: r.created_at, slackUserId: r.user_id }] : [],
      ),
    endedOnUser: (slackUserId, since, before, limit) =>
      endedUserStmt
        .all(slackUserId, since, before, Math.max(1, limit))
        .map((r) => ({ channelId: r.channel_id, threadTs: r.thread_ts, lastAt: r.created_at, slackUserId })),
    append: (message, createdAt) => {
      const row = insertStmt.get({
        $channelId: message.channelId,
        $slackUserId: message.slackUserId,
        $role: message.role,
        $content: message.content,
        $createdAt: createdAt,
        $slackTs: message.slackTs ?? "",
        $threadTs: message.threadTs ?? "",
        $viaBot: message.viaBot ? 1 : 0,
      }) as Row;
      return toMessage(row);
    },
    recentForChannel: (channelId, limit) =>
      recentStmt.all(channelId, Math.max(0, limit)).map(toMessage),
    recentForThread: (channelId, threadTs, limit) =>
      recentThreadStmt.all(channelId, threadTs, Math.max(0, limit)).map(toMessage),
    turnsInRange: (channelId, limit, threadTs, range) => {
      if (limit <= 0) return [];
      // A channel view has no thread: its own turns are those outside any thread, plus a thread's root message.
      const scope = threadTs === undefined ? "(thread_ts = '' OR thread_ts = slack_ts)" : "thread_ts = ?";
      const sql = `SELECT * FROM (
         SELECT * FROM messages WHERE channel_id = ? AND ${scope}${rangeSql(range)}
         ORDER BY id DESC LIMIT ?
       ) ORDER BY id ASC`;
      return db
        .query<Row, (string | number)[]>(sql)
        .all(channelId, ...(threadTs === undefined ? [] : [threadTs]), ...rangeArgs(range), limit)
        .map(toMessage);
    },
    userTurnsStartingWith: (channelId, prefixes, limit, threadTs, range) => {
      if (prefixes.length === 0 || limit <= 0) return [];
      // Exact, case-sensitive prefix match (LIKE folds case, so a person typing "i stopped waiting" would take a slot). Nothing marks an internal turn in the row (it even carries a synthetic `slack_ts`), so a person typing a look-alike opening shows up too - accepted, the console is owner-only and read-only.
      const starts = prefixes.map(() => "substr(content, 1, length(?)) = ?").join(" OR ");
      const args = prefixes.flatMap((p) => [p, p]);
      const sql = `SELECT * FROM (
         SELECT * FROM messages WHERE channel_id = ? AND role = 'user' AND (${starts})${threadTs === undefined ? "" : " AND thread_ts = ?"}${rangeSql(range)}
         ORDER BY id DESC LIMIT ?
       ) ORDER BY id ASC`;
      const rows = db
        .query<Row, (string | number)[]>(sql)
        .all(channelId, ...args, ...(threadTs === undefined ? [] : [threadTs]), ...rangeArgs(range), limit);
      return rows.map(toMessage);
    },
    clearChannel: (channelId) => {
      const res = clearStmt.run({ $channelId: channelId });
      return Number(res.changes);
    },
    count: () => countStmt.get()?.n ?? 0,
    channels: () =>
      channelsStmt
        .all()
        .map((r) => ({ channelId: r.channel_id, count: r.n, lastAt: r.last_at })),
  };
};
