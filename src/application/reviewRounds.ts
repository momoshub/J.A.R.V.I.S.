/**
 * Review rounds - a reviewed PR gets re-reviewed by itself when it is pushed to.
 *
 * Every quick review that finishes (asked in Slack, or started by a request on
 * GitHub, see autoReview.ts) leaves a row in `review_rounds`: the head it
 * reviewed, the round, whose token paid, the identity its comments went out as
 * and the Slack thread. A timer then polls the PRs that are still followed:
 *
 * - a head nobody reviewed that stays the same for the quiet period (a burst of
 *   pushes is one round) starts the next round, in the same thread, on the same
 *   person's token and as the same identity. The review is the very command a
 *   person types (`startReview`), so the CI gate, the policy and the comment
 *   shape all hold per round; it is told which head it reviewed last;
 * - following stops when the PR is merged or closed, after the round cap, or
 *   after the idle window without a push. Asking for a review again starts over;
 * - no token on file for the asker: nothing runs, one line in the thread.
 *
 * Never two rounds of one PR at once: `begin` is a compare-and-set in the table,
 * and the review command's own guard backs it up.
 */
import { prKeyOf, parsePrUrl, type ReviewIdentity, failedReviewText } from "../domain/reviewIdentity.ts";
import {
  capText,
  DEFAULT_ROUND_LIMITS,
  nextStep,
  noRoundTokenText,
  type PrNow,
  type RoundLimits,
} from "../domain/reviewRounds.ts";
import type { AllowedUser } from "../domain/types.ts";
import type { FollowedPr, ReviewRoundRepo } from "../infrastructure/db/reviewRoundRepo.ts";
import type { ReviewStart } from "./commands.ts";
import { logAndIgnore } from "./ignoredError.ts";
import type { Clock } from "./ports.ts";

/** How often followed PRs are looked at: one `gh pr view` each. */
export const ROUND_POLL_MS = 60_000;

/** What a finished review reports. */
export type ReviewedReport = {
  readonly url: string;
  readonly headSha: string;
  readonly identity: ReviewIdentity;
  readonly actorSlackId: string;
  readonly channelId: string;
  readonly threadTs: string;
  /** Set for a round the poll started. */
  readonly round?: number;
};

export type ReviewRoundsDeps = {
  clock: Clock;
  rounds: ReviewRoundRepo;
  users: { get: (slackId: string) => AllowedUser | undefined };
  hasToken: (slackId: string) => boolean;
  /** The PR's state and head, or undefined when it cannot be read (then nothing happens this poll). */
  pr: (url: string) => Promise<PrNow | undefined>;
  post: (channel: string, text: string, threadTs?: string) => Promise<string | undefined>;
  /** Run the quick review, as `startReview` does. */
  review: (start: ReviewStart) => Promise<string>;
  /** Limits, read on every poll so a setting change needs no restart. */
  limits?: () => RoundLimits;
  prefix: string;
  log?: (msg: string) => void;
  onError?: (e: unknown) => void;
};

export type ReviewRounds = {
  /** A review finished: follow the PR from this head. Never throws. */
  reviewed: (r: ReviewedReport) => void;
  /** Look at every followed PR once (rate limited to `ROUND_POLL_MS`). */
  tick: () => Promise<void>;
  /** Boot: no round is running any more. */
  recover: () => number;
  /** Resolves when the rounds started so far are over (tests). */
  idle: () => Promise<void>;
};

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export const createReviewRounds = (deps: ReviewRoundsDeps): ReviewRounds => {
  const log = deps.log ?? (() => {});
  const limits = (): RoundLimits => deps.limits?.() ?? DEFAULT_ROUND_LIMITS;
  const inFlight = new Set<Promise<void>>();
  let polling = false;
  let lastPoll = 0;

  const say = (f: FollowedPr, text: string): Promise<void> =>
    deps.post(f.channelId, text, f.threadTs).then(() => undefined, logAndIgnore("review round post"));

  /** Run one round to its end, whatever happens: the head it covered is never retried by the poll. */
  const execute = async (f: FollowedPr, actor: AllowedUser, round: { number: number; from: string; to: string }): Promise<void> => {
    try {
      const out = await deps.review({
        actor,
        channelId: f.channelId,
        threadTs: f.threadTs,
        url: f.url,
        identity: f.identity,
        reply: (text) => say(f, text),
        prefix: deps.prefix,
        round,
      });
      // Text coming back means it did not run (a refused role, a PR another review holds): say it.
      if (out.trim()) await say(f, out.trim());
    } catch (e) {
      log(`${f.url}: round ${round.number} failed: ${errText(e)}`);
      await say(f, failedReviewText(f.url, errText(e)));
    } finally {
      deps.rounds.end(f.prKey, round.to, deps.clock());
    }
  };

  const follow = async (f: FollowedPr): Promise<void> => {
    if (f.running) return;
    const now = deps.clock();
    const lim = limits();
    const pr = await deps.pr(f.url);
    if (!pr) return;
    const step = nextStep(f, pr, now, lim);
    switch (step.kind) {
      case "none":
      case "wait":
        return;
      case "clear":
        deps.rounds.observe(f.prKey, "", now);
        return;
      case "observe":
        deps.rounds.observe(f.prKey, step.head, now);
        return;
      case "stop":
        deps.rounds.stop(f.prKey, step.reason, now);
        log(`${f.url}: no longer followed (${step.reason})`);
        if (step.say) await say(f, capText(f.url, lim.maxRounds, pr.headSha, "asking for a review again"));
        return;
      case "run": {
        // The compare-and-set is what keeps two rounds of one PR apart, whoever asks.
        if (!deps.rounds.begin(f.prKey, f.round, now)) return;
        const actor = deps.users.get(f.actorSlack);
        if (!actor || !deps.hasToken(actor.slackId)) {
          deps.rounds.end(f.prKey, step.round.to, now);
          log(`${f.url}: round ${step.round.number} skipped, nobody to pay for it`);
          await say(f, noRoundTokenText(f.url, step.round.number, step.round.to, f.actorSlack ? `<@${f.actorSlack}>` : "whoever asked"));
          return;
        }
        // Not awaited: a review takes minutes and the other PRs should not wait on it.
        const job = execute(f, actor, step.round).finally(() => inFlight.delete(job));
        inFlight.add(job);
        return;
      }
    }
  };

  return {
    reviewed: (r) => {
      try {
        const parsed = parsePrUrl(r.url);
        if (!parsed || !r.headSha || !r.actorSlackId || !r.channelId || !r.threadTs) return;
        if (limits().maxRounds === 0) return;
        deps.rounds.reviewed(
          {
            prKey: prKeyOf(parsed.repo, parsed.number),
            url: r.url,
            repo: parsed.repo,
            number: parsed.number,
            identity: r.identity,
            actorSlack: r.actorSlackId,
            channelId: r.channelId,
            threadTs: r.threadTs,
            headSha: r.headSha,
            ...(r.round !== undefined ? { round: r.round } : {}),
          },
          deps.clock(),
        );
      } catch (e) {
        log(`${r.url}: could not record the review: ${errText(e)}`);
      }
    },

    tick: async () => {
      if (polling) return;
      const now = deps.clock();
      if (now - lastPoll < ROUND_POLL_MS) return;
      lastPoll = now;
      if (limits().maxRounds === 0) return;
      polling = true;
      try {
        for (const f of deps.rounds.active()) {
          try {
            await follow(f);
          } catch (e) {
            log(`${f.url}: poll failed: ${errText(e)}`);
            deps.onError?.(e);
          }
        }
      } finally {
        polling = false;
      }
    },

    recover: () => deps.rounds.recover(deps.clock()),

    idle: async () => {
      while (inFlight.size > 0) await Promise.all([...inFlight]);
    },
  };
};
