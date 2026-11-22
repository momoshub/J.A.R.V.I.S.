/**
 * Messages that queue behind a running turn in one thread, answered together.
 *
 * Only what a person typed is merged: the same author, no bot-started turn in
 * between. Everything the bot starts itself keeps its own turn, because each
 * carries its own steer (a watch hand-back, a worker's question, a workflow
 * step, a loop's fire, a drift nudge) and folding a steer into a person's
 * message would hand the model a request nobody made.
 */

/** The fields of an inbound message that decide whether it may share a turn. */
export type CoalesceFields = {
  readonly slackUserId: string;
  readonly threadTs?: string;
  readonly viaSlash?: boolean;
  readonly following?: boolean;
  readonly batched?: boolean;
  readonly interrupted?: boolean;
  readonly keepSession?: boolean;
  readonly autoContinue?: boolean;
  readonly unprompted?: boolean;
  readonly workerLane?: boolean;
  readonly trigger?: string;
  readonly model?: string;
};

/**
 * The kind a message merges under, or undefined when it must run alone. The
 * author is part of the kind: a turn runs under ONE person's role, tools and
 * budget, so a second person's words never ride in on the first one's.
 * A retry after a restart (`interrupted`) and a hand-back that keeps a stale
 * session (`keepSession`) carry per-message prompt rules, and a forced model
 * (`model`) is the sender's choice, so each of those stays a turn of its own.
 */
export const coalesceKind = (m: CoalesceFields): string | undefined =>
  m.threadTs === undefined ||
  m.viaSlash ||
  m.following ||
  m.batched ||
  m.interrupted ||
  m.keepSession ||
  m.autoContinue ||
  m.unprompted ||
  m.workerLane ||
  m.trigger ||
  m.model
    ? undefined
    : m.slackUserId;

/**
 * One input for the turn: every message, oldest first. A single message is
 * itself, so a lone follow-up reads exactly as it always did.
 */
export const queuedInput = (author: string, texts: readonly string[]): string => {
  if (texts.length === 1) return texts[0]!;
  return [
    `${texts.length} messages from ${author} arrived while you were busy with an earlier turn in this thread. Read them together, oldest first, and answer once, covering each of them:`,
    ...texts.map((t, i) => `(${i + 1}/${texts.length}) ${t}`),
  ].join(" ");
};
