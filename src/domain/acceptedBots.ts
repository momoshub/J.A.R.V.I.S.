/**
 * Messages from another team's bot that the bot answers as a person.
 *
 * Every path used to drop anything carrying a `bot_id`: a bot's message is
 * usually an echo or an automation nobody is waiting on an answer from. Some
 * bots post with a person's USER token, though, so the message carries both a
 * `bot_id` and a `user` who is a real, already-authorized person. For those,
 * an owner may list the bot's id (`ACCEPTED_BOT_IDS`) and the message is then
 * treated as that user speaking.
 *
 * Authorization never moves: it stays on the `user` id through the ordinary
 * access check, so the bot gets exactly that person's role, never more. A bot
 * message without a `user`, or whose user is the bot itself, is still dropped.
 *
 * Two bots answering each other would go on forever in a followed thread, so
 * `createBotLoopGuard` caps consecutive accepted-bot turns per thread.
 *
 * Pure: the transport hands in the ids and the bot's own user id.
 */

/** The slice of a Slack message these rules look at. */
export type BotCandidate = { readonly bot_id?: string; readonly user?: string };

/**
 * Is this a message from an allowlisted bot that speaks for a person?
 *
 * `ownUserId` is the bot's own Slack user: a message "from" it is never
 * accepted, whatever its `bot_id`, or it would answer its own posts.
 */
export const isAcceptedBot = (
  m: BotCandidate,
  acceptedBotIds: readonly string[],
  ownUserId?: string,
): boolean =>
  !!m.bot_id && !!m.user && acceptedBotIds.includes(m.bot_id) && (!ownUserId || m.user !== ownUserId);

/**
 * Is this message somebody talking: a person, or an accepted bot speaking for
 * one? A message from any other bot, or one with no user, is not.
 */
export const isPersonMessage = (
  m: BotCandidate,
  acceptedBotIds: readonly string[] = [],
  ownUserId?: string,
): boolean => (!m.bot_id && !!m.user) || isAcceptedBot(m, acceptedBotIds, ownUserId);

/** Consecutive accepted-bot turns one thread gets before a person must write again. */
export const DEFAULT_BOT_TURN_CAP = 3;

/** How many threads the guard remembers before it forgets the oldest. */
const MAX_TRACKED_THREADS = 1000;

export type BotLoopGuard = {
  /** An accepted bot wants an answer in this thread: whether it gets one, and why not. */
  readonly admit: (threadKey: string) => { readonly ok: true } | { readonly ok: false; readonly reason: string };
  /** A person wrote in this thread: the run of bot turns starts over. */
  readonly human: (threadKey: string) => void;
};

/**
 * Caps how many accepted-bot messages in a row one thread answers.
 *
 * After `cap` consecutive accepted-bot turns with no person writing in
 * between, further ones are refused until a person does. Tagged messages
 * count like followed ones. Kept in memory: a restart starts everyone from
 * zero, which at worst allows one more short run.
 */
export const createBotLoopGuard = (cap: number = DEFAULT_BOT_TURN_CAP): BotLoopGuard => {
  const runs = new Map<string, number>();
  return {
    admit: (threadKey) => {
      const n = runs.get(threadKey) ?? 0;
      if (n >= cap) return { ok: false, reason: `bot-loop:${n}/${cap} turns since a person wrote` };
      // Re-insert so the oldest-first eviction below drops the quietest thread.
      runs.delete(threadKey);
      runs.set(threadKey, n + 1);
      if (runs.size > MAX_TRACKED_THREADS) {
        const oldest = runs.keys().next().value;
        if (oldest !== undefined) runs.delete(oldest);
      }
      return { ok: true };
    },
    human: (threadKey) => void runs.delete(threadKey),
  };
};
