/** Skill drafts the learning harvest proposed, and where the owner stands on each. See domain/harvest.ts. */
import type { DbClient } from "./client.ts";

export type SkillDraftState = "pending" | "approved" | "rejected";

export type SkillDraft = {
  readonly id: number;
  readonly fingerprint: string;
  readonly name: string;
  /** The whole SKILL.md the draft proposes. */
  readonly content: string;
  /** The skill file it was written against; undefined for a new skill. */
  readonly base: string | undefined;
  readonly state: SkillDraftState;
  readonly sourceChannel: string;
  readonly sourceThreadTs: string;
  /** The owner's DM the question was posted in; empty until it went out. */
  readonly noticeChannel: string;
  readonly noticeTs: string;
  /** `noticeFingerprint` of that message as posted: a press is honoured only on a message that still matches it. */
  readonly noticeFingerprint: string;
  readonly createdAt: number;
  readonly decidedAt: number;
};

export type NewSkillDraft = Pick<SkillDraft, "fingerprint" | "name" | "content" | "base" | "sourceChannel" | "sourceThreadTs">;

type Row = {
  id: number;
  fingerprint: string;
  name: string;
  content: string;
  base: string | null;
  state: string;
  source_channel: string;
  source_thread_ts: string;
  notice_channel: string;
  notice_ts: string;
  notice_fingerprint: string;
  created_at: number;
  decided_at: number;
};

const toDraft = (r: Row): SkillDraft => ({
  id: r.id,
  fingerprint: r.fingerprint,
  name: r.name,
  content: r.content,
  base: r.base ?? undefined,
  state: r.state === "approved" || r.state === "rejected" ? r.state : "pending",
  sourceChannel: r.source_channel,
  sourceThreadTs: r.source_thread_ts,
  noticeChannel: r.notice_channel,
  noticeTs: r.notice_ts,
  noticeFingerprint: r.notice_fingerprint,
  createdAt: r.created_at,
  decidedAt: r.decided_at,
});

export type SkillDraftRepo = {
  add: (d: NewSkillDraft, at: number) => SkillDraft;
  get: (id: number) => SkillDraft | undefined;
  /** Whether a draft with this fingerprint was ever raised, whatever its state. */
  seen: (fingerprint: string) => boolean;
  /** Names the owner rejected a draft for, or has waiting: the same skill is not proposed again under another wording. */
  blockedNames: () => string[];
  pending: () => SkillDraft[];
  /** How many drafts were raised at or after `since`. */
  countSince: (since: number) => number;
  setNotice: (id: number, channel: string, ts: string, fingerprint: string) => void;
  /** Pending -> approved or rejected; false when it was not pending (so a second press changes nothing). */
  decide: (id: number, state: "approved" | "rejected", at: number) => boolean;
  /** Drop a draft whose question never went out. */
  discard: (id: number) => void;
};

export const createSkillDraftRepo = (db: DbClient): SkillDraftRepo => {
  const insertStmt = db.query<Row, Record<string, string | number | null>>(
    `INSERT INTO skill_drafts (fingerprint, name, content, base, source_channel, source_thread_ts, created_at)
     VALUES ($fingerprint, $name, $content, $base, $channel, $thread, $at)
     RETURNING *`,
  );
  const getStmt = db.query<Row, [number]>("SELECT * FROM skill_drafts WHERE id = ?");
  const seenStmt = db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM skill_drafts WHERE fingerprint = ?");
  const blockedStmt = db.query<{ name: string }, []>("SELECT DISTINCT name FROM skill_drafts WHERE state IN ('pending', 'rejected')");
  const pendingStmt = db.query<Row, []>("SELECT * FROM skill_drafts WHERE state = 'pending' ORDER BY id ASC");
  const countStmt = db.query<{ n: number }, [number]>("SELECT COUNT(*) AS n FROM skill_drafts WHERE created_at >= ?");
  const noticeStmt = db.query("UPDATE skill_drafts SET notice_channel = ?, notice_ts = ?, notice_fingerprint = ? WHERE id = ?");
  const decideStmt = db.query("UPDATE skill_drafts SET state = ?, decided_at = ? WHERE id = ? AND state = 'pending'");
  const discardStmt = db.query("DELETE FROM skill_drafts WHERE id = ?");

  return {
    add: (d, at) => {
      const row = insertStmt.get({
        $fingerprint: d.fingerprint,
        $name: d.name,
        $content: d.content,
        $base: d.base ?? null,
        $channel: d.sourceChannel,
        $thread: d.sourceThreadTs,
        $at: at,
      });
      if (!row) throw new Error("skill draft insert returned no row");
      return toDraft(row);
    },
    get: (id) => {
      const row = getStmt.get(id);
      return row ? toDraft(row) : undefined;
    },
    seen: (fingerprint) => (seenStmt.get(fingerprint)?.n ?? 0) > 0,
    blockedNames: () => blockedStmt.all().map((r) => r.name),
    pending: () => pendingStmt.all().map(toDraft),
    countSince: (since) => countStmt.get(since)?.n ?? 0,
    setNotice: (id, channel, ts, fingerprint) => void noticeStmt.run(channel, ts, fingerprint, id),
    decide: (id, state, at) => decideStmt.run(state, at, id).changes > 0,
    discard: (id) => void discardStmt.run(id),
  };
};
