/**
 * One turn at a time, per thread.
 *
 * Every Slack message used to spawn its own run with no idea another was in
 * flight. Ask for something, add "do all" three minutes later, and two runs do
 * the same work in parallel: two branches, two implementations, two pull
 * requests for one task. Neither could see the other, so neither was wrong.
 *
 * It is also required by the session model. A thread holds ONE CLI session, and
 * two `--resume` processes on one session id at the same moment are two
 * conversations writing over each other's history.
 *
 * So turns queue behind each other. The second message then runs with the
 * first's result already in the session, which is what makes "do all" mean "and
 * the rest" rather than "again, from scratch".
 *
 * Messages typed by a person queue differently from everything else
 * (`coalesce`). Ask for something, then add "and this", "and this", "and this"
 * while it runs, and four follow-ups used to take four turns one after the
 * other, each replying on its own to a thread that had moved on. Everything
 * that queued behind the running turn now waits as ONE group, and when its turn
 * comes it runs once with all of them. Whatever is not a person's message (a
 * watch hand-back, a workflow step, a worker's question) is a plain `run`: a
 * barrier the groups never merge across, so a bot-started turn keeps its own turn.
 *
 * Commands are deliberately NOT serialised here: a review is its own process
 * with its own session, and queueing one behind a long chat turn would make it
 * look dead.
 */

export type ThreadQueue = {
  /** Run `task` after anything already queued for `key`. */
  run: <T>(key: string, task: () => Promise<T>) => Promise<T>;
  /**
   * Run `item` in a turn it may share. Items that queue under the same `key`
   * and `kind` with no other turn between them wait as one group; when the
   * chain reaches it, `runBatch` is called ONCE with every item, oldest first,
   * and the item at `leader` (the newest by default) gets its result - the
   * caller whose reply is the one that gets posted. Every other caller settles
   * with `merged` as soon as the batch starts, so nothing waits on a turn that
   * is not theirs. A batch that fails rejects the leader only. Once a batch has
   * started, a later item opens the next group.
   */
  coalesce: <I, T>(opts: {
    key: string;
    /** Only items of the same kind merge (here: the same author). */
    kind: string;
    item: I;
    runBatch: (items: readonly I[]) => Promise<T>;
    /** What a caller whose item ran inside another's turn settles with. */
    merged: T;
    /** Index of the item whose caller receives the result. Defaults to the last. */
    leader?: (items: readonly I[]) => number;
  }) => Promise<T>;
  /** How many turns are waiting or running for `key`, for callers that wait on a thread (workflow checks). */
  depth: (key: string) => number;
};

export const createThreadQueue = (): ThreadQueue => {
  // The tail of each thread's chain, plus how deep it is. Entries are removed as
  // chains drain, so an idle bot holds nothing.
  const tails = new Map<string, Promise<unknown>>();
  const depths = new Map<string, number>();

  // The group still waiting its turn, per thread. Removed the moment it
  // starts, so what arrives while it runs forms the next one.
  type Waiter = { item: unknown; resolve: (v: never) => void; reject: (e: unknown) => void };
  type Group = { kind: string; waiters: Waiter[] };
  const open = new Map<string, Group>();

  const enqueue = <T>(key: string, task: () => Promise<T>): Promise<T> => {
    const depth = (depths.get(key) ?? 0) + 1;
    depths.set(key, depth);

    // A failed turn must not break the chain: the next one still gets to run,
    // which is the whole point of queueing rather than refusing.
    const prev = tails.get(key) ?? Promise.resolve();
    const result = prev.then(task, task);

    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    tails.set(key, settled);
    void settled.then(() => {
      const left = (depths.get(key) ?? 1) - 1;
      if (left <= 0) {
        depths.delete(key);
        // Only clear the tail if nothing else has queued behind us since.
        if (tails.get(key) === settled) tails.delete(key);
      } else {
        depths.set(key, left);
      }
    });

    return result;
  };

  // A plain turn is a barrier: a person's message that arrives after it must
  // not slide into a group that was waiting before it.
  const run = <T>(key: string, task: () => Promise<T>): Promise<T> => {
    open.delete(key);
    return enqueue(key, task);
  };

  const coalesce = <I, T>(opts: {
    key: string;
    kind: string;
    item: I;
    runBatch: (items: readonly I[]) => Promise<T>;
    merged: T;
    leader?: (items: readonly I[]) => number;
  }): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const waiter: Waiter = { item: opts.item, resolve: resolve as (v: never) => void, reject };
      const joined = open.get(opts.key);
      if (joined && joined.kind === opts.kind) {
        joined.waiters.push(waiter);
        return;
      }
      const group: Group = { kind: opts.kind, waiters: [waiter] };
      open.set(opts.key, group);
      let lead: Waiter | undefined;
      type Outcome = { ok: true; value: unknown } | { ok: false; error: unknown };
      // The leader hears back once the turn has left the chain (not from inside
      // it), so whoever awaits the answer sees the queue as it is afterwards.
      void enqueue<Outcome>(opts.key, async () => {
        if (open.get(opts.key) === group) open.delete(opts.key);
        const items = group.waiters.map((w) => w.item as I);
        const at = opts.leader?.(items) ?? items.length - 1;
        lead = group.waiters[Math.min(Math.max(at, 0), items.length - 1)]!;
        for (const w of group.waiters) if (w !== lead) w.resolve(opts.merged as never);
        // The failure belongs to the leader's caller; this turn itself never
        // throws, so the chain behind it is untouched.
        try {
          return { ok: true, value: await opts.runBatch(items) };
        } catch (error) {
          return { ok: false, error };
        }
      }).then((o) => (o.ok ? lead!.resolve(o.value as never) : lead!.reject(o.error)));
    });

  return { run, coalesce, depth: (key) => depths.get(key) ?? 0 };
};
