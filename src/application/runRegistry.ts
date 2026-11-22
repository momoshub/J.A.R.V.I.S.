/**
 * The turns currently in flight, so one can be stopped.
 *
 * A turn can run for the better part of an hour, and until now the only way to
 * deal with one going the wrong way was to wait it out: a follow-up message
 * queued behind it, which is the opposite of what someone correcting course
 * wants. This holds a handle on each running turn so a button or a command can
 * end it.
 *
 * Stopping is cooperative at the edges and forceful at the centre: the signal
 * is passed to the CLI adapter, which kills the child process, and the turn's
 * own code checks `aborted` so a queued turn that was dropped before it started
 * never spawns anything at all.
 */

import { sessionThreadKey } from "../domain/agentSession.ts";
import { frontKeyOf } from "../domain/workflowFront.ts";

/**
 * `stopping` is its own state because a stop is a REQUEST, not an event. The
 * process may take a moment to die, or - as happened - never die at all, and a
 * registry that cannot tell "asked to stop" from "running" reports a fresh
 * successful stop every time the button is pressed. Pressing it four times on a
 * wedged turn got four confirmations and killed nothing.
 */
export type RunState = "running" | "queued" | "stopping";

export type TrackedRun = {
  /** Short id, carried on the buttons. */
  readonly id: string;
  /** Thread key this run belongs to, matching the queue's. */
  readonly key: string;
  readonly channelId: string;
  readonly threadTs?: string;
  /** Who asked for it, so the thread can say whose turn was stopped. */
  readonly actor: string;
  /** The first words of the request, to name it in a notice. */
  readonly what: string;
  /** The message that asked for it, so a notice can link to it. */
  readonly messageTs?: string;
  readonly startedAt: number;
  /**
   * A long job nobody is sitting watching - a workflow worker carrying on by
   * itself. It is still a run, and still stoppable, but it must not be able to
   * hold a restart open: it gets cut and redelivered on the same session, so
   * waiting for it only buys deafness.
   */
  readonly background?: boolean;
  /**
   * The gateway inbox row that started it, if any. A turn started while a
   * restart waits runs on a budget, and past it the row is cut: this is how
   * the row finds the turn to stop.
   */
  readonly inboxRowId?: number;
  /**
   * The inbox rows of the messages folded into this run (`fold`): what one
   * person queued behind a turn is answered inside the newest message's run,
   * so a restart's cut of this run is a cut of their rows too.
   */
  foldedRows?: number[];
  /** Mutable: a stop flips it to `stopping`, which the next press must see. */
  state: RunState;
  /** Set once someone stops it; the Slack id of whoever did. */
  stoppedBy?: string;
  /** When the stop was asked for, so a slow death can be reported honestly. */
  stoppedAt?: number;
  /**
   * The streamed messages this turn opened. Slack's stop button names every
   * open stream in the session, including the one a queued message already
   * opened for its thinking card - this is how the press tells them apart.
   */
  streams?: string[];
};

export type RunRegistry = {
  /**
   * Track a turn. Returns the signal to hand down to the CLI and a `done` to
   * call when the turn ends, however it ends.
   */
  track: (run: Omit<TrackedRun, "state" | "stoppedBy">) => {
    signal: AbortSignal;
    running: () => void;
    done: () => void;
  };
  /** What is running (or queued) in this thread right now. */
  inThread: (key: string) => TrackedRun[];
  /** The running turn of a thread, if there is one. */
  current: (key: string) => TrackedRun | undefined;
  byId: (id: string) => TrackedRun | undefined;
  /**
   * Stop a run by id. Returns what was stopped, or undefined when it had
   * already finished - which is common, because a button sits in Slack for as
   * long as anyone cares to leave it there.
   */
  stop: (id: string, by: string) => TrackedRun | undefined;
  /**
   * Stop whatever is RUNNING in a thread. Returns what was stopped. Only the
   * running turn: messages waiting behind it are never touched, so after a stop
   * the queued batch starts at once as one turn (`threadQueue.coalesce`); with
   * nothing running it is a no-op.
   */
  stopThread: (key: string, by: string) => TrackedRun | undefined;
  /** Record that these inbox rows are answered inside run `id`. */
  fold: (id: string, rowIds: readonly number[]) => void;
  /**
   * The run a restart cut that covered this inbox row (its own, or one it was
   * folded into), even after the run is gone: each row is checked against its
   * own budget, at its own time, and must still be found cut.
   */
  restartCutRun: (rowId: number) => { run: TrackedRun; rows: readonly number[] } | undefined;
  /** Every tracked run, whatever thread it is in - for a status report. */
  all: () => TrackedRun[];
  /**
   * Record that the turn answering this message opened a streamed message.
   * Matched by the message, because the stream is made before the turn has a
   * run id anyone outside it can see. False when no tracked run owns the
   * message any more (its turn already ended).
   */
  streamOpened: (channelId: string, messageTs: string, streamTs: string) => boolean;
  /**
   * What to do when a thread's agent session may go idle: a run ended, the
   * thread had been put in `processing` by a streamed reply (`streamOpened`),
   * and nothing else is live in it. Set once by the Slack app.
   */
  onSessionIdle: (fn: (channelId: string, threadTs: string) => void) => void;
  /**
   * The same check for a caller that knows a stream was opened but whose run
   * may already be gone (a reply streamed out after the turn was untracked):
   * marks the thread and fires at once when nothing is live in it.
   */
  sessionMayIdle: (channelId: string, threadTs: string) => void;
};

type Entry = { run: TrackedRun; abort: AbortController };

const CUT_ROWS_TTL_MS = 60 * 60_000;

const FRONT_SUFFIX = frontKeyOf("");

/** A run's thread key without the workflow front's lane suffix. */
const baseKeyOf = (key: string): string => (key.endsWith(FRONT_SUFFIX) ? key.slice(0, -FRONT_SUFFIX.length) : key);

export const createRunRegistry = (clock: () => number = () => Date.now()): RunRegistry => {
  const byId = new Map<string, Entry>();
  // Threads whose agent session a streamed reply put in `processing`, by base
  // key (both lanes of a workflow thread share one session). Whichever run ends
  // with nothing else live in the thread idles it, so it never depends on the
  // LAST run having opened a stream of its own: a queued turn that stays quiet,
  // or a workflow worker step that never goes through the Slack handler.
  const processing = new Map<string, { channelId: string; threadTs: string }>();
  let idle: (channelId: string, threadTs: string) => void = () => {};
  // Rows a restart's cut covered, with the run that carried them. Kept past the
  // run: the process is about to be replaced, so this stays small.
  const cutRows = new Map<number, { run: TrackedRun; rows: readonly number[]; at: number }>();

  const settle = (base: string): void => {
    const mark = processing.get(base);
    if (!mark || [...byId.values()].some((e) => baseKeyOf(e.run.key) === base)) return;
    processing.delete(base);
    idle(mark.channelId, mark.threadTs);
  };

  // Undefined when it has ALREADY been asked to stop: the caller needs to tell
  // "I stopped it" from "it was asked and has not let go", and only the first
  // of those should be reported as an action.
  const stopEntry = (entry: Entry, by: string): TrackedRun | undefined => {
    if (entry.run.state === "stopping") return undefined;
    entry.run.stoppedBy = by;
    entry.run.stoppedAt = clock();
    entry.run.state = "stopping";
    // The reason is who stopped it, so a restart's cut can be told apart
    // from a person pressing stop (`isRestartCut`).
    entry.abort.abort(by);
    if (by === RESTART_STOPPER) {
      const now = clock();
      for (const [row, c] of cutRows) if (now - c.at > CUT_ROWS_TTL_MS) cutRows.delete(row);
      const rows = [entry.run.inboxRowId, ...(entry.run.foldedRows ?? [])].filter((r): r is number => r !== undefined);
      // The first cut to cover a row owns it: a folded row's own run is stopped
      // a moment before it stops the turn that carries it, and that turn's
      // whole batch is what the row belongs to.
      for (const row of rows) if (!cutRows.has(row)) cutRows.set(row, { run: entry.run, rows, at: now });
    }
    return entry.run;
  };

  return {
    all: () => [...byId.values()].map((e) => e.run),
    track: (run) => {
      const abort = new AbortController();
      const entry: Entry = { run: { ...run, state: "queued" }, abort };
      byId.set(run.id, entry);
      return {
        signal: abort.signal,
        // Called when the turn actually starts, as opposed to waiting its turn
        // in the queue - the two are stopped with different words.
        running: () => {
          // In place: a copy would drop what was recorded on the old object.
          entry.run.state = "running";
        },
        done: () => {
          byId.delete(run.id);
          settle(baseKeyOf(run.key));
        },
      };
    },
    inThread: (key) => [...byId.values()].filter((e) => e.run.key === key).map((e) => e.run),
      current: (key) => [...byId.values()].find((e) => e.run.key === key && e.run.state === "running")?.run,
    byId: (id) => byId.get(id)?.run,
    stop: (id, by) => {
      const entry = byId.get(id);
      return entry ? stopEntry(entry, by) : undefined;
    },
    stopThread: (key, by) => {
      const entry = [...byId.values()].find((e) => e.run.key === key && e.run.state === "running");
      return entry ? stopEntry(entry, by) : undefined;
    },
    fold: (id, rowIds) => {
      const entry = byId.get(id);
      if (entry) entry.run.foldedRows = [...(entry.run.foldedRows ?? []), ...rowIds];
    },
    restartCutRun: (rowId) => cutRows.get(rowId),
    streamOpened: (channelId, messageTs, streamTs) => {
      const entry = [...byId.values()].find((e) => e.run.channelId === channelId && e.run.messageTs === messageTs);
      if (!entry) return false;
      entry.run.streams = [...(entry.run.streams ?? []), streamTs];
      processing.set(baseKeyOf(entry.run.key), { channelId, threadTs: entry.run.threadTs ?? messageTs });
      return true;
    },
    onSessionIdle: (fn) => {
      idle = fn;
    },
    sessionMayIdle: (channelId, threadTs) => {
      const base = sessionThreadKey(channelId, threadTs);
      processing.set(base, { channelId, threadTs });
      settle(base);
    },
  };
};

/**
 * Which of the streams Slack's stop button named should be closed: all of
 * them, except one still owned by a turn that is not being stopped. Closing
 * those used to kill a queued message's reply along with the turn the press
 * was meant for. A stream nobody owns any more is closed, so a session left
 * in `processing` by a finished turn can still leave it.
 */
export const streamsToClose = (runs: RunRegistry, streams: readonly string[]): string[] => {
  const kept = new Set(
    runs
      .all()
      .filter((r) => r.state !== "stopping")
      .flatMap((r) => r.streams ?? []),
  );
  return streams.filter((ts) => !kept.has(ts));
};

export type RunPressOutcome =
  /** The running turn was ended. */
  | { kind: "stopped"; run: TrackedRun }
  /** A turn that had not started yet was taken back off the queue. */
  | { kind: "dropped"; run: TrackedRun }
  /** The button outlived what it pointed at - it finished on its own. */
  | { kind: "gone" }
  /** Already asked to stop and still letting go; pressing again changes nothing. */
  | { kind: "stopping"; run: TrackedRun }
  /** Not theirs to stop. */
  | { kind: "refused" }
  | { kind: "ignored" };

/** Who a restart's cut is recorded as, in place of a Slack id. */
export const RESTART_STOPPER = "restart";

/**
 * Cut the turns an inbox row started, because it ran past its budget while a
 * restart waits. Returns what was cut, one per run; empty when nothing of it
 * is still running (it finished, or it was never a tracked turn), in which
 * case the row is left alone.
 */
export const cutForRestart = (runs: RunRegistry, rowId: number): TrackedRun[] => {
  const stopped = runs
    .all()
    .filter((r) => r.inboxRowId === rowId || r.foldedRows?.includes(rowId))
    .map((r) => runs.stop(r.id, RESTART_STOPPER))
    .filter((r): r is TrackedRun => r !== undefined);
  if (stopped.length > 0) return stopped;
  // Already cut by the run it is folded into (or its own row, cut a moment
  // ago through a sibling): the row is still a cut one.
  const earlier = runs.restartCutRun(rowId);
  return earlier ? [earlier.run] : [];
};

/** Whether this turn was stopped by a restart's budget rather than by a person. */
export const isRestartCut = (signal: AbortSignal | undefined): boolean =>
  signal?.aborted === true && signal.reason === RESTART_STOPPER;

/**
 * Where to tell the cut turns to hold on: once per thread, and in the thread
 * even for a top-level message, whose reply opens one under it.
 */
export const holdThreads = (cut: readonly TrackedRun[]): { channelId: string; threadTs?: string }[] => {
  const seen = new Map<string, { channelId: string; threadTs?: string }>();
  for (const r of cut) {
    const threadTs = r.threadTs ?? r.messageTs;
    const key = `${r.channelId}/${threadTs ?? ""}`;
    if (!seen.has(key)) seen.set(key, threadTs ? { channelId: r.channelId, threadTs } : { channelId: r.channelId });
  }
  return [...seen.values()];
};

/**
 * What the receiver calls when a row runs past its restart budget: cut the
 * turns it started and tell each thread to hold on - once per thread for the
 * whole drain, since two messages in one thread both run over within a tick
 * of each other. Returns every inbox row the cut covers (the row itself, and
 * the rows folded into the same combined turn): the receiver holds them all at
 * once, because the turn unwinds and their handlers return before their own
 * budgets come due. Empty when nothing was cut.
 */
export const createRestartCutter = (
  runs: RunRegistry,
  post: (channelId: string, text: string, threadTs?: string) => void,
  notice: string,
): ((rowId: number) => readonly number[]) => {
  const told = new Set<string>();
  return (rowId) => {
    const cut = cutForRestart(runs, rowId);
    for (const t of holdThreads(cut)) {
      const key = `${t.channelId}/${t.threadTs ?? ""}`;
      if (told.has(key)) continue;
      told.add(key);
      post(t.channelId, notice, t.threadTs);
    }
    if (cut.length === 0) return [];
    const rows = new Set<number>([rowId, ...(runs.restartCutRun(rowId)?.rows ?? [])]);
    for (const r of cut) {
      if (r.inboxRowId !== undefined) rows.add(r.inboxRowId);
      for (const f of r.foldedRows ?? []) rows.add(f);
    }
    return [...rows];
  };
};

/**
 * Whether the work from before a restart was asked for is done: no inbox row
 * claimed before it is still in flight, and no foreground turn that started
 * before it is running or queued. Background (workflow) turns never count.
 */
export const drainSettled = (runs: RunRegistry, unbudgetedInFlight: number, drainStartedAt: number): boolean =>
  unbudgetedInFlight === 0 && !runs.all().some((r) => !r.background && r.startedAt < drainStartedAt);
