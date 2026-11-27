/**
 * The status message of a turn: its tool steps, in one message of their own.
 *
 * Posted in the thread when the first step is worth showing, rewritten with
 * `chat.update` as steps start and end, and taken down when the turn ends:
 * deleted a few seconds after when every step worked, collapsed to its
 * failures when one did not (see domain/statusSteps.ts for what it shows).
 *
 * Updates are coalesced to about one a second per message. Every send renders
 * the state as it is AT that moment, so a burst of steps costs one edit and the
 * trailing one always carries the last state. A rate limit (429) waits out its
 * retry-after and tries again; the final write is retried harder than the
 * rest, since a lost final state leaves a stale "in progress" message behind.
 *
 * The message is recorded in the store when it is posted and forgotten when it
 * is deleted or collapsed, so a process that dies mid-turn leaves a row the
 * next boot sweeps (`sweepStatusMessages`).
 */
import { finalStatus, renderStatus, type StatusStep, type StatusView } from "../../domain/statusSteps.ts";

/** The three Slack calls the message needs; the app binds them to a client and channel. */
export type StatusApi = {
  /** Post into the thread; resolves to the new message's ts. */
  post: (view: StatusView) => Promise<string | undefined>;
  update: (ts: string, view: StatusView) => Promise<unknown>;
  remove: (ts: string) => Promise<unknown>;
};

/** Where posted messages are remembered, for the boot sweep. */
export type StatusStore = {
  add: (ts: string, at: number) => void;
  remove: (ts: string) => void;
};

export type StatusMessageOptions = {
  api: StatusApi;
  store?: StatusStore;
  log?: (msg: string) => void;
  now?: () => number;
  /** Least time between two sends. */
  minIntervalMs?: number;
  /** How long a clean turn's message stays after the turn ends. */
  deleteDelayMs?: number;
  /** The header card's title: the dashboard's thinking label. Empty or absent falls back to `STATUS_LABEL`. */
  label?: () => string;
  /** Retries after a failed send. The final write gets `FINAL_RETRIES`. */
  retries?: number;
};

export const STATUS_MIN_INTERVAL_MS = 1_000;
export const STATUS_DELETE_DELAY_MS = 3_000;
const RETRIES = 2;
const FINAL_RETRIES = 6;
/** A retry-after longer than this is not waited out for a mid-turn edit: the next one carries the state. */
const MAX_WAIT_MS = 30_000;
const DEFAULT_WAIT_MS = 1_000;

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * How long Slack asked to wait, when `e` is a rate limit. The web client
 * reports it as `retryAfter` seconds, a raw API answer as `data.retry_after`.
 */
export const retryAfterMs = (e: unknown): number | undefined => {
  if (typeof e !== "object" || e === null) return undefined;
  const err = e as { retryAfter?: unknown; data?: { retry_after?: unknown; error?: unknown }; code?: unknown; message?: unknown };
  const secs = [err.retryAfter, err.data?.retry_after].map(Number).find((n) => Number.isFinite(n) && n >= 0);
  const limited =
    secs !== undefined ||
    err.code === "slack_webapi_rate_limited_error" ||
    err.data?.error === "ratelimited" ||
    /ratelimited|rate limit|429/i.test(String(err.message ?? ""));
  if (!limited) return undefined;
  return secs !== undefined ? secs * 1000 : DEFAULT_WAIT_MS;
};

/** The message is gone already (or never was): nothing left to edit or delete. */
const isGone = (e: unknown): boolean => /message_not_found|channel_not_found|cant_delete_message/.test(errMsg(e));

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export type StatusMessage = {
  /** Add a step, or move an existing one to a new state. */
  step: (step: StatusStep) => void;
  /** The placeholder a silent turn shows until its first step; `undefined` takes it down. */
  thinking: (label: string | undefined) => void;
  /** Every step seen so far, in the order it first appeared. */
  readonly steps: readonly StatusStep[];
  /** Whether a message is on screen (or being posted). */
  readonly posted: boolean;
  /**
   * The turn is over: land the final state (collapse to failures, or delete
   * after a short wait; `discard` for a turn whose reply was dropped: deleted at
   * once, failures included). Resolves once the final state is out; a delete that
   * is waiting for its delay is not awaited, see `idle`. Idempotent.
   */
  end: (opts?: { discard?: boolean }) => Promise<void>;
  /** Resolves when nothing is pending any more, a delayed delete included. For tests. */
  idle: () => Promise<void>;
};

export const createStatusMessage = (opts: StatusMessageOptions): StatusMessage => {
  const log = opts.log ?? (() => {});
  const now = opts.now ?? Date.now;
  const minInterval = opts.minIntervalMs ?? STATUS_MIN_INTERVAL_MS;
  const deleteDelay = opts.deleteDelayMs ?? STATUS_DELETE_DELAY_MS;
  const retries = opts.retries ?? RETRIES;

  const steps = new Map<string, StatusStep>();
  let thinkingLabel: string | undefined;
  let ts: string | undefined;
  let lastSentAt = Number.NEGATIVE_INFINITY;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let chain: Promise<void> = Promise.resolve();
  let dirty = false;
  let ended = false;
  let endPromise: Promise<void> | undefined;
  let pendingDelete: Promise<void> = Promise.resolve();

  const view = (): StatusView => renderStatus([...steps.values()], thinkingLabel, opts.label?.());
  /** Nothing worth a message yet: no step and no placeholder. */
  const empty = (): boolean => steps.size === 0 && !thinkingLabel;

  const forget = (): void => {
    const was = ts;
    ts = undefined;
    if (was) {
      try {
        opts.store?.remove(was);
      } catch (e) {
        log(`status store remove failed: ${errMsg(e)}`);
      }
    }
  };

  /**
   * Run `send`, waiting out rate limits and retrying other failures `tries` more
   * times. True when it landed or the message is already gone; false when it
   * could not be done.
   */
  const attempt = async (what: string, send: () => Promise<unknown>, tries: number): Promise<boolean> => {
    for (let left = tries; ; left--) {
      try {
        await send();
        return true;
      } catch (e) {
        if (isGone(e)) return true;
        const wait = retryAfterMs(e);
        if (left <= 0 || (wait !== undefined && wait > MAX_WAIT_MS && tries === retries)) {
          log(`status ${what} failed: ${errMsg(e)}`);
          return false;
        }
        await sleep(wait ?? 200);
      }
    }
  };

  /** One send of the current state: the post the first time, an edit after. */
  const flush = async (): Promise<void> => {
    timer = undefined;
    if (ended || !dirty) return;
    dirty = false;
    if (empty()) {
      // The placeholder was taken down and no step ever followed.
      if (ts) {
        const was = ts;
        // A delete that did not land keeps its row for the boot sweep.
        // The handle is kept when it fails, so a later step reuses the message and `end` can still delete it.
        if (await attempt("delete", () => opts.api.remove(was), retries)) forget();
        lastSentAt = now();
      }
      return;
    }
    const shown = view();
    if (ts === undefined) {
      try {
        const posted = await opts.api.post(shown);
        lastSentAt = now();
        if (posted) {
          ts = posted;
          try {
            opts.store?.add(posted, now());
          } catch (e) {
            log(`status store add failed: ${errMsg(e)}`);
          }
        }
      } catch (e) {
        lastSentAt = now();
        log(`status post failed: ${errMsg(e)}`);
        // Try again with whatever the state is by then.
        dirty = true;
      }
    } else {
      const at = ts;
      await attempt("update", () => opts.api.update(at, shown), retries);
      lastSentAt = now();
    }
  };

  const schedule = (): void => {
    dirty = true;
    if (ended || timer !== undefined) return;
    const wait = Math.max(0, lastSentAt + minInterval - now());
    timer = setTimeout(() => {
      timer = undefined;
      chain = chain.then(flush).then(() => {
        // State that moved while a send was out still has to land.
        if (dirty && !ended) schedule();
      });
    }, wait);
    (timer as { unref?: () => void }).unref?.();
  };

  const step = (s: StatusStep): void => {
    if (ended) return;
    // The finishing update carries no log pointer: the line the step started at is kept.
    // Map order is first-seen order, so an update never moves a step.
    steps.set(s.id, { ...steps.get(s.id), ...s });
    thinkingLabel = undefined;
    schedule();
  };

  const thinking = (label: string | undefined): void => {
    if (ended) return;
    if (label === thinkingLabel) return;
    // A placeholder is only worth a message while it is the only thing to say: taken away, the next send deletes it.
    thinkingLabel = label;
    schedule();
  };

  const settleChain = async (): Promise<void> => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    ended = true;
    await chain.catch(() => {});
  };

  const end = (endOpts: { discard?: boolean } = {}): Promise<void> => {
    endPromise ??= (async () => {
      await settleChain();
      // A turn whose reply was dropped has nothing to explain its failures: they go too.
      const final = endOpts.discard ? undefined : finalStatus([...steps.values()], opts.label?.());
      if (!final) {
        // Nothing failed. If it was ever posted it goes after a short wait.
        const at = ts;
        if (!at) return;
        // A placeholder that never became a step has nothing to read: no wait.
        const wait = steps.size === 0 || endOpts.discard ? 0 : deleteDelay;
        pendingDelete = (async () => {
          if (wait > 0) await sleep(wait);
          // A delete that could not land keeps its row: the boot sweep retries it.
          if (await attempt("delete", () => opts.api.remove(at), FINAL_RETRIES) && ts === at) forget();
        })();
        return;
      }
      if (ts === undefined) {
        try {
          const posted = await opts.api.post(final);
          if (posted) {
            // Posted already in its final form, so there is nothing to remember.
            log(`status message posted collapsed ts=${posted}`);
          }
        } catch (e) {
          log(`status post failed: ${errMsg(e)}`);
        }
        return;
      }
      const at = ts;
      if (await attempt("collapse", () => opts.api.update(at, final), FINAL_RETRIES)) {
        forget();
        return;
      }
      // A collapse Slack refuses must not leave the running view ("⏳ ...") up for good.
      if (await attempt("delete", () => opts.api.remove(at), FINAL_RETRIES)) forget();
    })();
    return endPromise;
  };

  return {
    step,
    thinking,
    get steps() {
      return [...steps.values()];
    },
    get posted() {
      return ts !== undefined;
    },
    end,
    idle: async () => {
      await chain.catch(() => {});
      await (endPromise ?? Promise.resolve());
      await pendingDelete;
    },
  };
};

/** What the sweep needs: a delete and the rows left from before. */
export type StatusSweepDeps = {
  rows: () => readonly { channelId: string; ts: string }[];
  remove: (channelId: string, ts: string) => Promise<unknown>;
  forget: (channelId: string, ts: string) => void;
  log?: (msg: string) => void;
};

/**
 * Boot: delete every status message a dead process left behind. Failures are
 * unknown, so none is collapsed - the answer, or the thread's own history, says
 * what happened. A message Slack no longer has counts as swept; one it refuses
 * to delete for another reason keeps its row for the next boot.
 */
export const sweepStatusMessages = async (deps: StatusSweepDeps): Promise<number> => {
  const log = deps.log ?? (() => {});
  let swept = 0;
  for (const row of deps.rows()) {
    try {
      await deps.remove(row.channelId, row.ts);
    } catch (e) {
      if (!isGone(e)) {
        log(`status sweep could not delete ${row.channelId}/${row.ts}: ${errMsg(e)}`);
        continue;
      }
    }
    deps.forget(row.channelId, row.ts);
    swept += 1;
  }
  return swept;
};
