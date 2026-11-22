import { describe, expect, test } from "bun:test";
import { createThreadQueue } from "../../src/application/threadQueue.ts";

const deferred = <T>() => {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

describe("createThreadQueue", () => {
  test("a second turn waits for the first instead of running beside it", async () => {
    // the failure this exists for: two messages three minutes apart each did
    // the same work and opened their own pull request for it
    const queue = createThreadQueue();
    const first = deferred<string>();
    const order: string[] = [];

    const a = queue.run("C1:100.1", async () => {
      order.push("a:start");
      const v = await first.promise;
      order.push("a:end");
      return v;
    });
    const b = queue.run("C1:100.1", async () => {
      order.push("b:start");
      return "b";
    });

    // b has not begun while a is still in flight
    await Promise.resolve();
    expect(order).toEqual(["a:start"]);

    first.resolve("a");
    expect(await a).toBe("a");
    expect(await b).toBe("b");
    expect(order).toEqual(["a:start", "a:end", "b:start"]);
  });

  test("different threads do not wait for each other", async () => {
    const queue = createThreadQueue();
    const held = deferred<string>();
    const slow = queue.run("C1:thread-a", () => held.promise);
    const quick = await queue.run("C1:thread-b", async () => "done");

    expect(quick).toBe("done"); // never blocked on the other thread
    held.resolve("eventually");
    await slow;
  });

  test("a failed turn does not break the chain behind it", async () => {
    // queueing is only better than refusing if the queue survives a failure
    const queue = createThreadQueue();
    const boom = queue.run("C1:100.1", async () => {
      throw new Error("timed out");
    });
    const after = queue.run("C1:100.1", async () => "still ran");

    await expect(boom).rejects.toThrow("timed out");
    expect(await after).toBe("still ran");
  });

  test("depth says whether anything is already running, and settles back to nothing", async () => {
    const queue = createThreadQueue();
    expect(queue.depth("C1:100.1")).toBe(0);

    const held = deferred<string>();
    const a = queue.run("C1:100.1", () => held.promise);
    expect(queue.depth("C1:100.1")).toBe(1);
    const b = queue.run("C1:100.1", async () => "b");
    expect(queue.depth("C1:100.1")).toBe(2);

    held.resolve("a");
    await Promise.all([a, b]);
    await new Promise((r) => setTimeout(r, 0));
    // an idle bot holds nothing
    expect(queue.depth("C1:100.1")).toBe(0);
  });

  test("turns keep their order", async () => {
    const queue = createThreadQueue();
    const ran: number[] = [];
    await Promise.all(
      [1, 2, 3, 4].map((n) =>
        queue.run("C1:100.1", async () => {
          await new Promise((r) => setTimeout(r, 5 - n)); // later ones are quicker
          ran.push(n);
        }),
      ),
    );
    expect(ran).toEqual([1, 2, 3, 4]);
  });
});

describe("createThreadQueue coalesce", () => {
  const KEY = "C1:100.1";
  const batch = (queue: ReturnType<typeof createThreadQueue>, item: string, ran: string[][], kind = "U1") =>
    queue.coalesce<string, string>({
      key: KEY,
      kind,
      item,
      merged: "merged",
      runBatch: async (items) => {
        ran.push([...items]);
        return `ran ${items.join("+")}`;
      },
    });

  test("everything queued behind a running turn runs as ONE turn when it finishes", async () => {
    const queue = createThreadQueue();
    const first = deferred<string>();
    const ran: string[][] = [];
    const a = queue.run(KEY, () => first.promise);
    const rest = ["b", "c", "d", "e"].map((m) => batch(queue, m, ran));

    await new Promise((r) => setTimeout(r, 5));
    expect(ran).toEqual([]); // nothing starts while a runs

    first.resolve("a");
    await a;
    const results = await Promise.all(rest);
    expect(ran).toEqual([["b", "c", "d", "e"]]);
    // the newest caller owns the answer, the other three settle as merged
    expect(results).toEqual(["merged", "merged", "merged", "ran b+c+d+e"]);
  });

  test("a failed running turn still lets the batch run, and a failed batch does not break the chain", async () => {
    const queue = createThreadQueue();
    const boom = queue.run(KEY, async () => {
      throw new Error("killed");
    });
    const failing = queue.coalesce<string, string>({
      key: KEY,
      kind: "U1",
      item: "b",
      merged: "merged",
      runBatch: async () => {
        throw new Error("batch broke");
      },
    });
    const sibling = queue.coalesce<string, string>({ key: KEY, kind: "U1", item: "c", merged: "merged", runBatch: async () => "unused" });
    const after = queue.run(KEY, async () => "next turn");
    const outcome = sibling.then(
      () => "resolved",
      (e: Error) => e.message,
    );

    await expect(boom).rejects.toThrow("killed");
    // c joined b's group and is the newest, so the failure is c's alone; b settled as merged
    expect(await failing).toBe("merged");
    expect(await outcome).toBe("batch broke");
    expect(await after).toBe("next turn");
  });

  test("messages that arrive while the batch runs form the next batch", async () => {
    const queue = createThreadQueue();
    const hold = deferred<string>();
    const ran: string[][] = [];
    const a = queue.run(KEY, () => hold.promise);
    const first = ["b", "c"].map((m) =>
      queue.coalesce<string, string>({
        key: KEY,
        kind: "U1",
        item: m,
        merged: "merged",
        runBatch: async (items) => {
          ran.push([...items]);
          await new Promise((r) => setTimeout(r, 20)); // the combined turn takes a while
          return "first batch";
        },
      }),
    );
    hold.resolve("a");
    await a;
    await new Promise((r) => setTimeout(r, 5)); // the batch is running now
    const later = ["d", "e"].map((m) => batch(queue, m, ran));

    await Promise.all([...first, ...later]);
    expect(ran).toEqual([["b", "c"], ["d", "e"]]);
  });

  test("a bot-started turn in between is a barrier, and a different author never merges", async () => {
    const queue = createThreadQueue();
    const hold = deferred<string>();
    const ran: string[][] = [];
    const order: string[] = [];
    const a = queue.run(KEY, () => hold.promise);
    const p1 = batch(queue, "b", ran);
    const watch = queue.run(KEY, async () => void order.push("watch hand-back"));
    const p2 = batch(queue, "c", ran); // after the barrier: its own batch
    const p3 = batch(queue, "d", ran, "U2"); // someone else: its own batch too
    const p4 = batch(queue, "e", ran, "U2");

    hold.resolve("a");
    await Promise.all([a, p1, watch, p2, p3, p4]);
    expect(ran).toEqual([["b"], ["c"], ["d", "e"]]);
    expect(order).toEqual(["watch hand-back"]);
  });

  test("the leader can be chosen, and a lone message runs as a batch of one", async () => {
    const queue = createThreadQueue();
    const hold = deferred<string>();
    const a = queue.run(KEY, () => hold.promise);
    const pick = (m: string) =>
      queue.coalesce<string, string>({
        key: KEY,
        kind: "U1",
        item: m,
        merged: "merged",
        leader: () => 0,
        runBatch: async (items) => `led by ${items[0]}`,
      });
    const results = [pick("b"), pick("c")];
    hold.resolve("a");
    await a;
    expect(await Promise.all(results)).toEqual(["led by b", "merged"]);
    expect(await batch(queue, "solo", [])).toBe("ran solo");
  });

  test("another thread is not held, and depth counts a group once", async () => {
    const queue = createThreadQueue();
    const hold = deferred<string>();
    const a = queue.run(KEY, () => hold.promise);
    const ps = ["b", "c", "d"].map((m) => batch(queue, m, []));
    expect(queue.depth(KEY)).toBe(2); // the running turn and the one group
    const other = await queue.coalesce<string, string>({
      key: "C1:other",
      kind: "U1",
      item: "x",
      merged: "merged",
      runBatch: async () => "other ran",
    });
    expect(other).toBe("other ran");
    hold.resolve("a");
    await Promise.all([a, ...ps]);
    await new Promise((r) => setTimeout(r, 0));
    expect(queue.depth(KEY)).toBe(0);
  });
});
