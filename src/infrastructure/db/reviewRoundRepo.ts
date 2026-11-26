/**
 * The PRs followed for review rounds (see domain/reviewRounds.ts).
 *
 * `reviewed` is the one write a finished review makes: it records the head that
 * was reviewed and which round that was. Everything else is the poll's
 * bookkeeping: what it saw (`observe`), the guard that keeps two rounds of a PR
 * from running at once (`begin` / `end`) and why it stopped following (`stop`).
 */
import type { ReviewIdentity } from "../../domain/reviewIdentity.ts";
import type { StopReason } from "../../domain/reviewRounds.ts";
import type { DbClient } from "./client.ts";

/** What a finished review tells the repo. */
export type ReviewedPr = {
  readonly prKey: string;
  readonly url: string;
  readonly repo: string;
  readonly number: number;
  readonly identity: ReviewIdentity;
  /** The Slack person whose token paid for it; the next rounds run on it. */
  readonly actorSlack: string;
  readonly channelId: string;
  readonly threadTs: string;
  /** The head the review read. */
  readonly headSha: string;
  /** Set by the poll for a round it started; absent when a person asked. */
  readonly round?: number;
};

export type FollowedPr = Omit<ReviewedPr, "round" | "headSha"> & {
  /** The head the last round actually reviewed: the base of the next delta. */
  readonly lastHead: string;
  /** The last head the poll dealt with, reviewed or not (a round that could not run is not retried). */
  readonly handledHead: string;
  readonly round: number;
  readonly observedHead: string;
  readonly observedAt: number;
  readonly lastPushAt: number;
  readonly status: "following" | "stopped";
  readonly stopReason: string;
  readonly running: boolean;
};

export type ReviewRoundRepo = {
  /**
   * A review finished on `headSha`. A person's ask counts as one more round on a PR that is being
   * followed and starts over (round 1) on one that is not; a round the poll started says its number.
   * Either way the PR is followed again, from this head, with a fresh idle window.
   */
  reviewed: (r: ReviewedPr, at: number) => void;
  get: (prKey: string) => FollowedPr | undefined;
  /** The PRs still followed. */
  active: () => FollowedPr[];
  /** A head nobody reviewed was seen at `at` (that is a push); "" forgets what was seen. */
  observe: (prKey: string, head: string, at: number) => void;
  /** Take the right to run a round: false when one already runs, the PR is no longer followed or the round moved on. */
  begin: (prKey: string, fromRound: number, at: number) => boolean;
  /** The round is over, however it went: `head` counts as handled so the poll never retries it. The reviewed head only moves when a review was recorded. */
  end: (prKey: string, head: string, at: number) => void;
  stop: (prKey: string, reason: StopReason | "gone", at: number) => void;
  /** After a restart no round is running any more. */
  recover: (at: number) => number;
};

type Row = {
  pr_key: string;
  url: string;
  repo: string;
  number: number;
  identity: string;
  actor_slack: string;
  channel_id: string;
  thread_ts: string;
  last_head: string;
  handled_head: string;
  round: number;
  observed_head: string;
  observed_at: number;
  last_push_at: number;
  status: string;
  stop_reason: string;
  running: number;
};

const toFollowed = (r: Row): FollowedPr => ({
  prKey: r.pr_key,
  url: r.url,
  repo: r.repo,
  number: r.number,
  identity: r.identity === "app" ? "app" : "human",
  actorSlack: r.actor_slack,
  channelId: r.channel_id,
  threadTs: r.thread_ts,
  lastHead: r.last_head,
  handledHead: r.handled_head,
  round: r.round,
  observedHead: r.observed_head,
  observedAt: r.observed_at,
  lastPushAt: r.last_push_at,
  status: r.status === "stopped" ? "stopped" : "following",
  stopReason: r.stop_reason,
  running: r.running === 1,
});

export const createReviewRoundRepo = (db: DbClient): ReviewRoundRepo => {
  const getStmt = db.query<Row, [string]>("SELECT * FROM review_rounds WHERE pr_key = ?");
  const activeStmt = db.query<Row, []>("SELECT * FROM review_rounds WHERE status = 'following' ORDER BY created_at");
  const insertStmt = db.query(
    `INSERT INTO review_rounds
       (pr_key, url, repo, number, identity, actor_slack, channel_id, thread_ts, last_head, handled_head, round, last_push_at, created_at, updated_at)
     VALUES ($prKey, $url, $repo, $number, $identity, $actor, $channel, $thread, $head, $head, $round, $at, $at, $at)
     ON CONFLICT (pr_key) DO UPDATE SET
       url = $url, identity = $identity, actor_slack = $actor, channel_id = $channel, thread_ts = $thread,
       last_head = $head, handled_head = $head, round = $round, observed_head = '', observed_at = 0, last_push_at = $at,
       status = 'following', stop_reason = '', updated_at = $at`,
  );

  return {
    reviewed: (r, at) => {
      const row = getStmt.get(r.prKey);
      // A round the poll started never moves the count down: a person's review that finished meanwhile may already have counted.
      const round = r.round !== undefined ? Math.max(r.round, row?.status === "following" ? row.round : 0) : row && row.status === "following" ? row.round + 1 : 1;
      insertStmt.run({
        $prKey: r.prKey,
        $url: r.url,
        $repo: r.repo,
        $number: r.number,
        $identity: r.identity,
        $actor: r.actorSlack,
        $channel: r.channelId,
        $thread: r.threadTs,
        $head: r.headSha,
        $round: round,
        $at: at,
      });
    },
    get: (prKey) => {
      const r = getStmt.get(prKey);
      return r ? toFollowed(r) : undefined;
    },
    active: () => activeStmt.all().map(toFollowed),
    observe: (prKey, head, at) => {
      if (head) {
        db.query("UPDATE review_rounds SET observed_head = ?, observed_at = ?, last_push_at = ?, updated_at = ? WHERE pr_key = ?").run(head, at, at, at, prKey);
      } else {
        db.query("UPDATE review_rounds SET observed_head = '', observed_at = 0, updated_at = ? WHERE pr_key = ?").run(at, prKey);
      }
    },
    begin: (prKey, fromRound, at) =>
      db
        .query("UPDATE review_rounds SET running = 1, updated_at = ? WHERE pr_key = ? AND status = 'following' AND running = 0 AND round = ?")
        .run(at, prKey, fromRound).changes > 0,
    end: (prKey, head, at) => {
      db.query(
        "UPDATE review_rounds SET running = 0, handled_head = ?, observed_head = CASE WHEN observed_head = ? THEN '' ELSE observed_head END, updated_at = ? WHERE pr_key = ?",
      ).run(head, head, at, prKey);
    },
    stop: (prKey, reason, at) => {
      db.query("UPDATE review_rounds SET status = 'stopped', stop_reason = ?, running = 0, updated_at = ? WHERE pr_key = ?").run(reason, at, prKey);
    },
    recover: (at) => db.query("UPDATE review_rounds SET running = 0, updated_at = ? WHERE running = 1").run(at).changes,
  };
};
