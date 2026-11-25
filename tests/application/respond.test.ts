import { describe, expect, test } from "bun:test";
import { openDatabase } from "../../src/infrastructure/db/client.ts";
import { createUserRepo } from "../../src/infrastructure/db/userRepo.ts";
import { createMessageRepo } from "../../src/infrastructure/db/messageRepo.ts";
import { TURN_CONTEXT_OPEN } from "../../src/domain/personality.ts";
import { respond, type RespondDeps } from "../../src/application/respond.ts";
import { createThreadQueue } from "../../src/application/threadQueue.ts";
import { createRunRegistry, cutForRestart, RESTART_STOPPER } from "../../src/application/runRegistry.ts";
import { createWorkflowRepo } from "../../src/infrastructure/db/workflowRepo.ts";
import { createTurnLogRepo } from "../../src/infrastructure/db/turnLogRepo.ts";
import { createWatchRepo } from "../../src/infrastructure/db/watchRepo.ts";
import { tellPrompt } from "../../src/domain/tellPrompt.ts";
import { createCommandTickets } from "../../src/application/commandTickets.ts";
import type { SlackAdminPort } from "../../src/application/slackAdmin.ts";
import type { BillingContext, LlmPort } from "../../src/application/ports.ts";
import { slackTicketContext } from "../../src/application/slackTickets.ts";
import { checkSlackCall } from "../../src/domain/slackProxy.ts";
import { seededBook } from "../../src/domain/roleSeed.ts";
import { staticBook } from "../../src/domain/roles.ts";
import { disabledRoleOf, enforceRolePolicies } from "../../src/application/rolePolicies.ts";

const OWNER = "U0OWNER0001";

const build = (llm: LlmPort): RespondDeps => {
  const db = openDatabase(":memory:");
  let t = 1;
  return {
    users: createUserRepo(db),
    messages: createMessageRepo(db),
    llm,
    clock: () => t++,
    ownerSlackId: OWNER,
    contextWindow: 10,
  };
};

const llm = (r: string): LlmPort => ({ complete: async () => r });

/** Every port method a no-op; a test overrides only what it asserts on. */
const quietSlack: SlackAdminPort = {
  listConversations: async () => [],
  history: async () => ({ messages: [] }),
  replies: async () => [],
  update: async () => {},
  remove: async () => {},
  post: async () => {},
  postDm: async () => undefined,
  postDmInteractive: async () => undefined,
  postInteractive: async () => undefined,
  postMenu: async () => undefined,
  settleInteractive: async () => {},
  addReactions: async () => 0,
  botUserId: async () => "UBOT",
  resolveNames: async () => ({}),
};

describe("respond", () => {
  test("routes commands to the command layer without hitting the llm", async () => {
    let called = false;
    const deps = build({ complete: async () => ((called = true), "x") });
    const res = await respond(deps, { channelId: "C1", slackUserId: OWNER, text: "!whoami" });
    expect(res.kind).toBe("reply");
    if (res.kind === "reply") expect(res.text).toContain("owner");
    expect(called).toBe(false);
  });

  test("routes plain chat to the llm", async () => {
    const deps = build(llm("Obviously."));
    const res = await respond(deps, { channelId: "C1", slackUserId: OWNER, text: "you there?" });
    expect(res).toEqual({ kind: "reply", text: "Obviously." });
  });

  test("denies unknown users on commands too", async () => {
    const deps = build(llm("x"));
    const res = await respond(deps, { channelId: "C1", slackUserId: "Ux", text: "!users" });
    expect(res.kind).toBe("denied");
  });

  test("a switched-off role reaches neither commands nor chat, and is told why", async () => {
    const deps = build(llm("should not run"));
    deps.users.upsert({ slackId: "Uadm", role: "admin", displayName: "A", addedBy: "x", createdAt: 1 });
    // the owner switched the admin role off: the stored role says so
    const seeded = seededBook();
    const book = staticBook(seeded.list().map((r) => (r.name === "admin" ? { ...r, enabled: false } : r)));
    const gated: RespondDeps = {
      ...deps,
      roles: book,
      users: enforceRolePolicies(deps.users, book),
      roleDisabled: disabledRoleOf(deps.users, book),
    };
    for (const text of ["!whoami", "hello there"]) {
      const res = await respond(gated, { channelId: "C1", slackUserId: "Uadm", text });
      expect(res).toEqual({ kind: "denied", text: expect.stringContaining("admin role is switched off") });
    }
    // The owner is untouched by any of it.
    expect((await respond(gated, { channelId: "C1", slackUserId: OWNER, text: "!whoami" })).kind).toBe("reply");
  });

  const REVIEW_PR = "https://github.com/o/r/pull/1";

  /** A respond() whose chat brain records that it ran; `workflowThread` puts a live workflow under the thread. */
  const withBrain = (workflowThread?: string) => {
    const db = openDatabase(":memory:");
    let t = 1;
    const workflows = createWorkflowRepo(db);
    if (workflowThread) {
      workflows.start({ channelId: "C1", threadTs: workflowThread, sessionId: "s1", task: "the blog", startedBy: OWNER }, 1);
    }
    const ran = { brain: false };
    const deps: RespondDeps = {
      users: createUserRepo(db),
      messages: createMessageRepo(db),
      llm: { complete: async () => ((ran.brain = true), "I would love to review that for you") },
      clock: () => t++,
      ownerSlackId: OWNER,
      contextWindow: 10,
      workflows,
    };
    return { deps, ran };
  };

  test("a human tagging the bot with review or approve runs quick-review, not a chat reply", async () => {
    // the gap this closes: `@bot review <url>` reached the chat brain, which
    // talked about the review - and about the token - instead of running one
    // and offering the box that takes it. `approve` is the same ask.
    for (const verb of ["review", "approve"]) {
      const { deps, ran } = withBrain();
      const res = await respond(deps, {
        channelId: "C1",
        slackUserId: OWNER,
        text: `<@UBOT> ${verb} ${REVIEW_PR}`,
        mentioned: true,
      });
      expect(ran.brain).toBe(false); // the chat brain never ran
      // the quick-review command answered: no token store wired here, so it refuses
      expect(res.kind).toBe("reply");
      expect(res.kind === "reply" ? res.text : "").toContain("caller's own");
    }
  });

  test("a DM tagged with review runs quick-review, a DM without the tag does not", async () => {
    // Slack sends no app_mention for a DM, so the transport marks `mentioned`
    // from the text; respond only sees the flag. Same for a thread reply in a DM.
    for (const extra of [{}, { threadTs: "5.5" }]) {
      const { deps, ran } = withBrain();
      const res = await respond(deps, {
        channelId: "D1",
        slackUserId: OWNER,
        text: `<@UBOT> review ${REVIEW_PR}`,
        mentioned: true,
        ...extra,
      });
      expect(ran.brain).toBe(false);
      expect(res.kind === "reply" ? res.text : "").toContain("caller's own");
    }
    const { deps, ran } = withBrain();
    const res = await respond(deps, { channelId: "D1", slackUserId: OWNER, text: `review ${REVIEW_PR}` });
    expect(ran.brain).toBe(true);
    expect(res.kind === "reply" ? res.text : "").not.toContain("caller's own");
  });

  test("a pal, the lowest role, can tag the bot for a quick review too", async () => {
    const { deps, ran } = withBrain();
    deps.users.upsert({ slackId: "U0PAL0009", role: "pal", displayName: "Pal", addedBy: OWNER, createdAt: 1 });
    const res = await respond(deps, {
      channelId: "C1",
      slackUserId: "U0PAL0009",
      text: `<@UBOT> approve ${REVIEW_PR}`,
      mentioned: true,
    });
    expect(ran.brain).toBe(false);
    expect(res.kind).toBe("reply");
    expect(res.kind === "reply" ? res.text : "").toContain("caller's own");
  });

  test("a raw quick-review line from a turn the bot started is dropped", async () => {
    for (const extra of [{ unprompted: true }, { autoContinue: true }, { workerLane: true }]) {
      const { deps, ran } = withBrain();
      const res = await respond(deps, { channelId: "C1", slackUserId: OWNER, text: `!quick-review ${REVIEW_PR}`, ...extra });
      expect(res).toEqual({ kind: "ignored" });
      expect(ran.brain).toBe(false);
    }
  });

  test("quick-review never starts from anything but a human's tag", async () => {
    const text = `<@UBOT> review ${REVIEW_PR}`;
    const cases: [string, Partial<Parameters<typeof respond>[1]>, string?][] = [
      ["no tag (a DM without the bot's tag, or a followed thread's reply)", { mentioned: undefined }],
      ["an untagged follow-up", { mentioned: true, following: true }],
      ["a turn the bot started itself", { mentioned: true, unprompted: true }],
      ["a batch of buffered messages", { mentioned: true, batched: true }],
      ["a workflow step", { mentioned: true, autoContinue: true }],
      ["a worker's question", { mentioned: true, unprompted: true, workerLane: true }],
      ["a thread driving a workflow", { mentioned: true, threadTs: "7.7" }, "7.7"],
    ];
    for (const [why, extra, workflowThread] of cases) {
      const { deps, ran } = withBrain(workflowThread);
      const res = await respond(deps, { channelId: "C1", slackUserId: OWNER, text, ...extra });
      // nothing was turned into the command: whatever answered, it was not quick-review
      const answer = res.kind === "reply" ? res.text : "";
      expect(answer, why).not.toContain("caller's own");
      expect(answer, why).not.toContain("Which PR");
      if (!extra.autoContinue) expect(ran.brain, why).toBe(true);
    }
  });

  test("a tell steer naming a PR and 'review' reaches the session, it does not run the review", async () => {
    // `tell <thread> ... <pr url> ... review` answered "sent" and then ran
    // `review` on the PR in the target thread; the session never saw the steer
    let seen = "";
    const deps = build({
      complete: async (p) => {
        seen = JSON.stringify(p);
        return "NO_REPLY";
      },
    });
    const steer = tellPrompt(OWNER, "please review https://github.com/o/r/pull/1 when CI is green");
    const res = await respond(deps, {
      channelId: "C1",
      slackUserId: OWNER,
      text: steer,
      threadTs: "1.0",
      keepSession: true,
      unprompted: true,
      trigger: "tell",
    });

    expect(seen).toContain("internal steer"); // the chat brain ran on the steer
    expect(seen).toContain("pull/1");
    expect(res).toEqual({ kind: "reply", text: "NO_REPLY", trigger: "tell" });
  });

  test("talking about a PR is still just talking", async () => {
    const deps = build(llm("it looked fine to me"));
    const res = await respond(deps, {
      channelId: "C1",
      slackUserId: OWNER,
      text: "<@UBOT> what did you make of https://github.com/o/r/pull/1",
    });
    expect(res).toEqual({ kind: "reply", text: "it looked fine to me" });
  });

  test("two messages in one thread take turns, instead of doing the work twice", async () => {
    // the failure this exists for: "create a PR" and "do all" three minutes
    // apart ran at once and opened two pull requests for the same task
    let running = 0;
    let overlapped = false;
    const deps = build({
      complete: async () => {
        running += 1;
        if (running > 1) overlapped = true;
        await new Promise((r) => setTimeout(r, 10));
        running -= 1;
        return "ok";
      },
    });
    deps.threadQueue = createThreadQueue();

    const inbound = { channelId: "C1", slackUserId: OWNER, threadTs: "100.1" };
    await Promise.all([
      respond(deps, { ...inbound, text: "add it and create a PR", messageTs: "100.1" }),
      respond(deps, { ...inbound, text: "do all", messageTs: "100.2" }),
    ]);

    expect(overlapped).toBe(false);
  });

  test("a second thread is not held up by the first", async () => {
    const deps = build({
      complete: async (p) => {
        if (p.messages.some((m) => m.content.includes("slow"))) {
          await new Promise((r) => setTimeout(r, 40));
        }
        return "ok";
      },
    });
    deps.threadQueue = createThreadQueue();

    const slow = respond(deps, { channelId: "C1", slackUserId: OWNER, text: "slow one", threadTs: "1.1", messageTs: "1.1" });
    const other = await respond(deps, { channelId: "C1", slackUserId: OWNER, text: "quick", threadTs: "2.1", messageTs: "2.1" });
    expect(other).toEqual({ kind: "reply", text: "ok" });
    await slow;
  });

  test("a running turn can be stopped, and stopping is not reported as a failure", async () => {
    // the point: a turn may run for the better part of an hour, and waiting one
    // out is not a way to correct course
    const runs = createRunRegistry();
    let started = false;
    const deps = build({
      complete: async (p) => {
        started = true;
        // what the CLI adapter does on abort: kill the child, which surfaces
        // exactly as the timeout's own kill
        await new Promise<void>((_resolve, reject) => {
          p.signal?.addEventListener("abort", () => reject(new Error("claude CLI exited with code 143: no output")));
        });
        return "never";
      },
    });
    deps.threadQueue = createThreadQueue();
    deps.runs = runs;

    const turn = respond(deps, {
      channelId: "C1",
      slackUserId: OWNER,
      text: "dig through every log group",
      threadTs: "100.1",
      messageTs: "100.1",
    });

    await new Promise((r) => setTimeout(r, 20));
    expect(started).toBe(true);
    const running = runs.current("C1:100.1");
    expect(running?.what).toBe("dig through every log group");

    runs.stop(running!.id, OWNER);
    // it comes back quietly rather than as "I hit an error": whoever stopped it
    // already knows, and the thread has been told
    expect(await turn).toEqual({ kind: "ignored" });
  });

  test("a message queued behind a running turn posts nothing, and still runs after it", async () => {
    const posted: string[] = [];
    const seen: string[] = [];
    const order: string[] = [];
    const deps = build({
      complete: async (p) => {
        const asked = (p.messages[p.messages.length - 1]?.content ?? "").split(TURN_CONTEXT_OPEN)[0]!;
        seen.push(asked);
        order.push(`start ${asked}`);
        await new Promise((r) => setTimeout(r, 30));
        order.push(`end ${asked}`);
        return "ok";
      },
    });
    deps.threadQueue = createThreadQueue();
    deps.runs = createRunRegistry();
    deps.slack = {
      ...quietSlack,
      post: async (channel, text) => {
        posted.push(text);
        return { channel, ts: `9.${posted.length}` };
      },
      postInteractive: async () => {
        throw new Error("a queued message must not post anything");
      },
    };

    const inbound = { channelId: "C1", slackUserId: OWNER, threadTs: "200.1" };
    const first = respond(deps, { ...inbound, text: "the long one", messageTs: "200.1" });
    await new Promise((r) => setTimeout(r, 10));
    let started = 0;
    const second = respond(deps, { ...inbound, text: "and this", messageTs: "200.2" }, undefined, () => void started++);
    await new Promise((r) => setTimeout(r, 5));
    expect(started).toBe(0); // still waiting its turn
    expect(posted).toEqual([]); // and nothing said about it

    await Promise.all([first, second]);
    expect(posted).toEqual([]);
    expect(started).toBe(1);
    expect(seen).toEqual(["the long one", "and this"]);
    expect(order).toEqual(["start the long one", "end the long one", "start and this", "end and this"]);
  });

  test("a watch hand-back queued behind a running turn posts nothing either", async () => {
    const posted: string[] = [];
    const deps = build({
      complete: async () => {
        await new Promise((r) => setTimeout(r, 30));
        return "ok";
      },
    });
    deps.threadQueue = createThreadQueue();
    deps.runs = createRunRegistry();
    deps.slack = {
      ...quietSlack,
      post: async (channel, text) => {
        posted.push(text);
        return { channel, ts: `9.${posted.length}` };
      },
    };

    const inbound = { channelId: "C1", slackUserId: OWNER, threadTs: "500.1" };
    const first = respond(deps, { ...inbound, text: "the long one", messageTs: "500.1" });
    await new Promise((r) => setTimeout(r, 10));
    const handBack = respond(deps, { ...inbound, text: "watch ready", messageTs: "500.2", unprompted: true });

    await Promise.all([first, handBack]);
    expect(posted).toEqual([]);
  });

  test("a message dropped before it ran never reaches the brain", async () => {
    const runs = createRunRegistry();
    const seen: string[] = [];
    const deps = build({
      complete: async (p) => {
        seen.push((p.messages[p.messages.length - 1]?.content ?? "").split(TURN_CONTEXT_OPEN)[0]!);
        await new Promise((r) => setTimeout(r, 30));
        return "ok";
      },
    });
    deps.threadQueue = createThreadQueue();
    deps.runs = runs;

    const inbound = { channelId: "C1", slackUserId: OWNER, threadTs: "300.1" };
    const first = respond(deps, { ...inbound, text: "the long one", messageTs: "300.1" });
    await new Promise((r) => setTimeout(r, 10));
    const second = respond(deps, { ...inbound, text: "never mind this", messageTs: "300.2" });

    // take the queued one back before its turn comes round
    const queued = runs.inThread("C1:300.1").find((r) => r.state === "queued");
    expect(queued?.what).toBe("never mind this");
    runs.stop(queued!.id, OWNER);

    await Promise.all([first, second]);
    expect(seen).toEqual(["the long one"]); // the dropped one never spawned
  });

  describe("messages queued behind a running turn", () => {
    /** An llm whose first call is held until released; every call's last message is recorded. */
    const held = () => {
      const asked: string[] = [];
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const brain: LlmPort = {
        complete: async (p) => {
          const last = (p.messages[p.messages.length - 1]?.content ?? "").split(TURN_CONTEXT_OPEN)[0]!;
          asked.push(last);
          if (asked.length === 1) await gate;
          return `reply ${asked.length}`;
        },
      };
      return { brain, asked, release };
    };
    const inbound = { channelId: "C1", slackUserId: OWNER, threadTs: "700.1" };
    const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

    test("when the running turn finishes, everything queued behind it is ONE turn with all of it", async () => {
      const { brain, asked, release } = held();
      const deps = build(brain);
      deps.threadQueue = createThreadQueue();
      deps.runs = createRunRegistry();
      const started: string[] = [];

      const a = respond(deps, { ...inbound, text: "the long one", messageTs: "700.1" }, undefined, () => void started.push("a"));
      await tick();
      const rest = ["b: do this", "c: and this", "d: also this", "e: last thing"].map((text, i) =>
        respond(deps, { ...inbound, text, messageTs: `700.${i + 2}` }, undefined, () => void started.push(text[0]!)),
      );
      await tick();
      expect(asked).toHaveLength(1); // only a is running
      release();

      const results = await Promise.all([a, ...rest]);
      expect(asked).toHaveLength(2); // a, then ONE turn for b..e - not four
      for (const t of ["b: do this", "c: and this", "d: also this", "e: last thing"]) expect(asked[1]).toContain(t);
      expect(asked[1]!.indexOf("b: do this")).toBeLessThan(asked[1]!.indexOf("e: last thing"));
      expect(asked[1]).toContain("4 messages");
      // one reply, to the newest message's caller; the three merged ones post nothing
      expect(results.map((r) => r.kind)).toEqual(["reply", "ignored", "ignored", "ignored", "reply"]);
      expect(results[4]).toEqual({ kind: "reply", text: "reply 2" });
      // only the caller that answers has its thinking card armed
      expect(started).toEqual(["a", "e"]);
      // no run is left tracked for a merged message
      expect(deps.runs.all()).toEqual([]);
    });

    test("stopping the running turn does not drop the queued ones: they run at once, as one turn", async () => {
      const runs = createRunRegistry();
      const asked: string[] = [];
      const deps = build({
        complete: async (p) => {
          asked.push(p.messages[p.messages.length - 1]?.content ?? "");
          if (asked.length === 1) {
            await new Promise<void>((_res, reject) => {
              p.signal?.addEventListener("abort", () => reject(new Error("claude CLI exited with code 143: no output")));
            });
          }
          return "answered the batch";
        },
      });
      deps.threadQueue = createThreadQueue();
      deps.runs = runs;

      const a = respond(deps, { ...inbound, text: "the long one", messageTs: "700.1" });
      await tick();
      const rest = ["one", "two", "three", "four"].map((text, i) => respond(deps, { ...inbound, text, messageTs: `700.${i + 2}` }));
      await tick();

      // the press hits only the running turn, never the four waiting
      const running = runs.current("C1:700.1");
      expect(running?.what).toBe("the long one");
      expect(runs.inThread("C1:700.1").filter((r) => r.state === "queued")).toHaveLength(4);
      runs.stop(running!.id, OWNER);

      expect(await a).toEqual({ kind: "ignored" });
      const results = await Promise.all(rest);
      expect(asked).toHaveLength(2);
      for (const t of ["one", "two", "three", "four"]) expect(asked[1]).toContain(t);
      expect(results.filter((r) => r.kind === "reply")).toEqual([{ kind: "reply", text: "answered the batch" }]);
      expect(results.filter((r) => r.kind === "ignored")).toHaveLength(3);
      expect(runs.all()).toEqual([]);
    });

    test("stopping while only queued messages exist stops nothing: they keep waiting", async () => {
      const runs = createRunRegistry();
      const deps = build(llm("ok"));
      deps.threadQueue = createThreadQueue();
      deps.runs = runs;
      // a turn the bot started holds the thread; a person's message waits behind it
      let release!: () => void;
      const holder = deps.threadQueue.run("C1:700.1", () => new Promise<void>((r) => (release = r)));
      const waiting = respond(deps, { ...inbound, text: "waiting here", messageTs: "700.2" });
      await tick();

      expect(runs.current("C1:700.1")).toBeUndefined(); // nothing running to stop
      expect(runs.stopThread("C1:700.1", OWNER)).toBeUndefined();
      expect(runs.inThread("C1:700.1")).toHaveLength(1); // and the queued one is untouched

      release();
      await holder;
      expect(await waiting).toEqual({ kind: "reply", text: "ok" });
    });

    test("messages that arrive while the combined turn runs queue again and form the next batch", async () => {
      const { brain, asked, release } = held();
      const deps = build(brain);
      deps.threadQueue = createThreadQueue();
      deps.runs = createRunRegistry();
      // slow second call, so there is a window while the combined turn runs
      const slowed: LlmPort = {
        complete: async (p) => {
          const out = await brain.complete(p);
          if (asked.length === 2) await tick(40);
          return out;
        },
      };
      deps.llm = slowed;

      const a = respond(deps, { ...inbound, text: "the long one", messageTs: "700.1" });
      await tick();
      const first = ["b1", "b2"].map((text, i) => respond(deps, { ...inbound, text, messageTs: `700.${i + 2}` }));
      await tick();
      release();
      await tick(15); // the combined turn is running now
      expect(asked).toHaveLength(2);
      const next = ["n1", "n2", "n3"].map((text, i) => respond(deps, { ...inbound, text, messageTs: `700.${i + 4}` }));

      await Promise.all([a, ...first, ...next]);
      expect(asked).toHaveLength(3); // a, {b1,b2}, {n1,n2,n3}
      expect(asked[1]).toContain("b2");
      expect(asked[1]).not.toContain("n1");
      for (const t of ["n1", "n2", "n3"]) expect(asked[2]).toContain(t);
    });

    test("commands are not queued, and other threads stay parallel", async () => {
      const { brain, asked, release } = held();
      const deps = build(brain);
      deps.threadQueue = createThreadQueue();
      deps.runs = createRunRegistry();
      const a = respond(deps, { ...inbound, text: "the long one", messageTs: "700.1" });
      await tick();
      const command = await respond(deps, { ...inbound, text: "!whoami", messageTs: "700.2" });
      expect(command.kind).toBe("reply");
      const elsewhere = await respond(deps, { channelId: "C1", slackUserId: OWNER, text: "other thread", threadTs: "800.1", messageTs: "800.1" });
      expect(elsewhere.kind).toBe("reply");
      expect(asked).toHaveLength(2); // the long one, and the other thread's turn
      release();
      await a;
    });

    test("a failed turn does not break the chain: the batch runs, and a failed batch does not stop the next", async () => {
      const asked: string[] = [];
      const deps = build({
        complete: async (p) => {
          asked.push(p.messages[p.messages.length - 1]?.content ?? "");
          if (asked.length === 1) {
            await new Promise((r) => setTimeout(r, 20));
            throw new Error("the first turn blew up");
          }
          if (asked.length === 2) throw new Error("the batch blew up too");
          return "fine";
        },
      });
      deps.threadQueue = createThreadQueue();
      deps.runs = createRunRegistry();

      const a = respond(deps, { ...inbound, text: "first", messageTs: "700.1" }).catch((e: Error) => e.message);
      await tick(5);
      const rest = ["b", "c"].map((text, i) => respond(deps, { ...inbound, text, messageTs: `700.${i + 2}` }).catch((e: Error) => e.message));
      const newest = respond(deps, { ...inbound, text: "newest", messageTs: "700.9" }).catch((e: Error) => e.message);
      expect(await a).toBe("the first turn blew up");
      // the batch (b, c, newest) ran despite the failure ahead, and its own failure reached only the newest caller
      expect(await Promise.all(rest)).toEqual([{ kind: "ignored" }, { kind: "ignored" }]);
      expect(await newest).toBe("the batch blew up too");
      expect(asked[1]).toContain("newest");
      // and the thread still works after a failed batch
      expect(await respond(deps, { ...inbound, text: "after the batch", messageTs: "700.10" })).toEqual({ kind: "reply", text: "fine" });
      expect(asked).toHaveLength(3);
      expect(deps.runs.all()).toEqual([]);
    });

    test("a turn the bot started keeps its own turn, and so does another person's message", async () => {
      const { brain, asked, release } = held();
      const deps = build(brain);
      deps.threadQueue = createThreadQueue();
      deps.runs = createRunRegistry();
      deps.users.upsert({ slackId: "Upal", role: "pal", displayName: "Pal", addedBy: "x", createdAt: 1 });

      const a = respond(deps, { ...inbound, text: "the long one", messageTs: "700.1" });
      await tick();
      const queued = [
        respond(deps, { ...inbound, text: "mine one", messageTs: "700.2" }),
        respond(deps, { ...inbound, text: "watch ready", messageTs: "700.3", unprompted: true }),
        respond(deps, { ...inbound, text: "mine two", messageTs: "700.4" }),
        respond(deps, { ...inbound, slackUserId: "Upal", text: "pal says hi", messageTs: "700.5" }),
        respond(deps, { ...inbound, slackUserId: "Upal", text: "pal again", messageTs: "700.6" }),
      ];
      await tick();
      release();
      await Promise.all([a, ...queued]);
      // a, mine one, the hand-back, mine two, then the pal's two together: never merged across the bot's turn or across people
      expect(asked).toHaveLength(5);
      expect(asked[1]).toBe("mine one");
      expect(asked[2]).toBe("watch ready");
      expect(asked[3]).toBe("mine two");
      expect(asked[4]).toContain("pal says hi");
      expect(asked[4]).toContain("pal again");
    });

    test("a restart's budget holds EVERY row of a combined turn, each checked at its own time", async () => {
      const runs = createRunRegistry();
      const { brain, release } = held();
      const deps = build({
        complete: async (p) => {
          const out = await brain.complete(p);
          if (p.messages.some((m) => m.content.includes("3 messages"))) {
            await new Promise<void>((_res, reject) => p.signal?.addEventListener("abort", () => reject(new Error("claude CLI exited with code 143: no output"))));
          }
          return out;
        },
      });
      deps.threadQueue = createThreadQueue();
      deps.runs = runs;
      const a = respond(deps, { ...inbound, text: "the long one", messageTs: "700.1", inboxRowId: 1 });
      await tick();
      const rest = [2, 3, 4].map((row) => respond(deps, { ...inbound, text: `msg ${row}`, messageTs: `700.${row}`, inboxRowId: row }));
      release();
      await a;
      await tick(20); // the combined turn (rows 2, 3, 4; 4 is the newest) is running

      // the receiver checks each row at its own budget, oldest first
      const held2 = cutForRestart(runs, 2);
      expect(held2.length).toBeGreaterThan(0);
      expect(await Promise.all(rest)).toEqual([{ kind: "ignored" }, { kind: "ignored" }, { kind: "ignored" }]);
      expect(runs.all()).toEqual([]); // the turn has unwound and every run is gone
      // ... and the others, checked after that, are still found cut: nothing is left to finish and close
      expect(cutForRestart(runs, 3).length).toBeGreaterThan(0);
      expect(cutForRestart(runs, 4).length).toBeGreaterThan(0);
      // a row that was never part of it is not
      expect(cutForRestart(runs, 99)).toEqual([]);
    });

    test("a lone queued message stopped by id leaves no run behind", async () => {
      const runs = createRunRegistry();
      const { brain, asked, release } = held();
      const deps = build(brain);
      deps.threadQueue = createThreadQueue();
      deps.runs = runs;
      const a = respond(deps, { ...inbound, text: "the long one", messageTs: "700.1" });
      await tick();
      const only = respond(deps, { ...inbound, text: "only one", messageTs: "700.2" });
      runs.stop(runs.inThread("C1:700.1").find((r) => r.what === "only one")!.id, OWNER);
      release();
      expect(await only).toEqual({ kind: "ignored" });
      await a;
      expect(asked).toHaveLength(1);
      expect(runs.all()).toEqual([]);
    });

    test("folded messages stay tracked until their turn ends, and a restart cut of one cuts the turn", async () => {
      const runs = createRunRegistry();
      let seen: AbortSignal | undefined;
      const { brain, release } = held();
      const deps = build({
        complete: async (p) => {
          const out = await brain.complete(p);
          if (!seen && p.messages.some((m) => m.content.includes("2 messages"))) {
            seen = p.signal;
            await new Promise<void>((_res, reject) => p.signal?.addEventListener("abort", () => reject(new Error("claude CLI exited with code 143: no output"))));
          }
          return out;
        },
      });
      deps.threadQueue = createThreadQueue();
      deps.runs = runs;
      const a = respond(deps, { ...inbound, text: "the long one", messageTs: "700.1" });
      await tick();
      const b = respond(deps, { ...inbound, text: "first of two", messageTs: "700.2", inboxRowId: 11 });
      const c = respond(deps, { ...inbound, text: "second of two", messageTs: "700.3", inboxRowId: 12 });
      release();
      await a;
      await tick(20); // the combined turn is running
      // the folded message still holds its run (so its inbox row stays open), but a stop never lands on it
      expect(runs.inThread("C1:700.1").map((r) => r.state).sort()).toEqual(["queued", "running"]);
      // its row runs over the restart budget: the turn that carries it is cut too
      runs.stop(runs.inThread("C1:700.1").find((r) => r.inboxRowId === 11)!.id, RESTART_STOPPER);
      expect(await Promise.all([b, c])).toEqual([{ kind: "ignored" }, { kind: "ignored" }]);
      expect(seen?.aborted).toBe(true);
      expect(runs.all()).toEqual([]);
    });

    test("a queued message stopped by id before its turn is left out of the batch", async () => {
      const runs = createRunRegistry();
      const { brain, asked, release } = held();
      const deps = build(brain);
      deps.threadQueue = createThreadQueue();
      deps.runs = runs;

      const a = respond(deps, { ...inbound, text: "the long one", messageTs: "700.1" });
      await tick();
      const rest = ["keep one", "never mind this", "keep two"].map((text, i) => respond(deps, { ...inbound, text, messageTs: `700.${i + 2}` }));
      runs.stop(runs.inThread("C1:700.1").find((r) => r.what === "never mind this")!.id, OWNER);
      release();

      await Promise.all([a, ...rest]);
      expect(asked).toHaveLength(2);
      expect(asked[1]).toContain("keep one");
      expect(asked[1]).toContain("keep two");
      expect(asked[1]).not.toContain("never mind this");
      expect(runs.all()).toEqual([]);
    });
  });

  test("owner can add a member via command end to end", async () => {
    const deps = build(llm("x"));
    await respond(deps, { channelId: "C1", slackUserId: OWNER, text: "!add <@UNEW>" });
    expect(deps.users.get("UNEW")?.role).toBe("pal");
  });

  test("a role word that is not a role is refused, not silently turned into the default", async () => {
    const deps = build(llm("x"));
    const res = await respond(deps, { channelId: "C1", slackUserId: OWNER, text: "!add <@UNEW> member" });
    expect(res.kind === "reply" ? res.text : "").toContain("no role called *member*");
    expect(deps.users.get("UNEW")).toBeUndefined();
  });
});

describe("recording how a turn ended", () => {
  const withTurns = (llmPort: LlmPort) => {
    const deps = build(llmPort);
    const db = openDatabase(":memory:");
    const turns = createTurnLogRepo(db);
    return { deps: { ...deps, turns } as RespondDeps, turns };
  };

  const inbound = {
    channelId: "C1",
    slackUserId: OWNER,
    text: "why is the form slow",
    threadTs: "9.9",
    messageTs: "9.9",
    viaSlash: false,
  };

  test("a turn that worked is written down", async () => {
    const { deps, turns } = withTurns(llm("because of FINAL"));
    await respond(deps, inbound);
    const [t] = turns.since(0);
    expect(t?.outcome).toBe("ok");
    expect(t?.request).toBe("why is the form slow");
    expect(t?.threadTs).toBe("9.9");
    expect(t?.slackUserId).toBe(OWNER);
  });

  test("a person's turn is recorded as typed, one the bot composed (a GitHub issue body, a fix brief) is not", async () => {
    const { deps, turns } = withTurns(llm("ok"));
    await respond(deps, inbound);
    await respond(deps, { ...inbound, threadTs: "8.8", messageTs: "8.8", composed: true });
    await respond(deps, { ...inbound, threadTs: "7.7", messageTs: "7.7", unprompted: true });
    expect(turns.since(0).map((t) => [t.threadTs, t.typed]).sort()).toEqual([["7.7", false], ["8.8", false], ["9.9", true]]);
  });

  test("a turn that threw is written down WITH the error, not just lost to stderr", async () => {
    const { deps, turns } = withTurns({
      complete: async () => {
        throw new Error("disk I/O error");
      },
    });
    await expect(respond(deps, inbound)).rejects.toThrow("disk I/O error");
    const [t] = turns.since(0);
    expect(t?.outcome).toBe("failed");
    expect(t?.error).toContain("disk I/O error");
    // and it is the thing `mindful continue` will re-run
    expect(turns.stuckThreads(0)).toHaveLength(1);
  });

  test("a turn cut for a restart after it spoke is recorded stopped, not answered", async () => {
    // a streamed turn killed after its first words returns the fragment
    // instead of throwing; finishing it as the reply would leave a half answer
    // with a usage footer, and log as done a turn the next process re-runs
    const runs = createRunRegistry();
    const { deps, turns } = withTurns({
      complete: async () => {
        const running = runs.current("C1:9.9");
        runs.stop(running!.id, RESTART_STOPPER);
        return "the form is slow bec";
      },
    });
    deps.threadQueue = createThreadQueue();
    deps.runs = runs;
    expect(await respond(deps, inbound)).toEqual({ kind: "ignored" });
    const [t] = turns.since(0);
    expect(t?.outcome).toBe("stopped");
  });

  test("an instance with no turn log still answers", async () => {
    const deps = build(llm("fine"));
    const out = await respond(deps, inbound);
    expect(out.kind).toBe("reply");
  });
});

describe("a turn started by a watch can actually DO things", () => {
  /**
   * The follow-up turn a watch hands back is an ordinary turn in every way
   * that matters, and the ways that matter are easy to lose: without a command
   * ticket it can only talk about promoting, and without the command rules it
   * does not know the helper exists. Both arrive through `handleMessage`, so
   * both are checked here rather than assumed from the wiring.
   */
  const build2 = () => {
    const db = openDatabase(":memory:");
    let t = 1;
    const users = createUserRepo(db);
    users.upsert({
      slackId: "U7",
      role: "admin",
      displayName: "Kai",
      addedBy: "system",
      createdAt: 0,
    });
    const seen: { system: string; runTicket?: string }[] = [];
    const deps: RespondDeps = {
      users,
      messages: createMessageRepo(db),
      llm: {
        complete: async (p) => {
          seen.push({ system: p.system, runTicket: p.runTicket });
          return "promoting now";
        },
      },
      clock: () => t++,
      ownerSlackId: OWNER,
      contextWindow: 10,
      commandTickets: createCommandTickets(() => 1, () => "TICKET"),
      runScript: "/x/jarvis-run.sh",
      runUrl: "http://localhost/api/commands/run",
      commandPrefix: "//jarvis",
      watches: createWatchRepo(db),
    };
    return { deps, seen };
  };

  const fired = {
    channelId: "C1",
    slackUserId: "U7",
    text: "The thing you were waiting for is ready. Carry on with exactly this: promote be US then SG",
    threadTs: "9.9",
    messageTs: "9.9",
    viaSlash: false,
  };

  test("it gets a command ticket, so it can run them itself", async () => {
    const { deps, seen } = build2();
    await respond(deps, fired);
    expect(seen[0]?.runTicket).toBe("TICKET");
  });

  test("the ticket carries the message the turn started from, so a loop it creates can point back", async () => {
    const { deps } = build2();
    const issued: (string | undefined)[] = [];
    const tickets = createCommandTickets(() => 1, () => "TICKET");
    await respond(
      { ...deps, commandTickets: { ...tickets, issue: (ctx) => (issued.push(ctx.messageTs), tickets.issue(ctx)) } },
      { ...fired, threadTs: "9.0", messageTs: "9.9" },
    );
    expect(issued).toEqual(["9.9"]);
    const redeemed = tickets.redeem("TICKET");
    expect(redeemed.ok && redeemed.ctx.messageTs).toBe("9.9");
  });

  test("the ticket says the owner started the turn only for their own typed message, and carries what it named", async () => {
    const { deps } = build2();
    const issued: Parameters<typeof tickets.issue>[0][] = [];
    const tickets = createCommandTickets(() => 1, () => "TICKET");
    const spy = { ...deps, commandTickets: { ...tickets, issue: (ctx: Parameters<typeof tickets.issue>[0]) => (issued.push(ctx), tickets.issue(ctx)) } };
    const link = "https://team.slack.com/archives/C0TEAM00001/p1787122692303399";
    await respond(spy, { ...fired, slackUserId: OWNER, trigger: undefined, text: `post the shots in ${link} when ready`, threadTs: "9.1", messageTs: "9.1" });
    expect(issued[0]).toMatchObject({ actor: OWNER, owner: true, named: [{ channel: "C0TEAM00001", threadTs: "1787122692.303399" }] });
    // the watch hand-back the owner's watch fires, a bot-started turn, is not their own message
    await respond(spy, { ...fired, slackUserId: OWNER, unprompted: true, trigger: "watch", text: `ready: post the shots in ${link}`, threadTs: "9.2", messageTs: "9.2" });
    expect(issued[1]).not.toHaveProperty("owner");
    expect(issued[1]).toMatchObject({ watch: true });
    expect(issued[0]).not.toHaveProperty("watch");
    // someone else typing is never the owner's message
    await respond(spy, { ...fired, slackUserId: "U7", text: `post it in ${link}`, threadTs: "9.3", messageTs: "9.3" });
    expect(issued[2]).not.toHaveProperty("owner");
    expect(issued[2]).not.toHaveProperty("named");
  });

  test("the command ticket carries a fired watch's grant only on a watch turn, never on a typed or other turn", async () => {
    const { deps } = build2();
    const issued: Parameters<typeof tickets.issue>[0][] = [];
    const tickets = createCommandTickets(() => 1, () => "TICKET");
    const spy = { ...deps, commandTickets: { ...tickets, issue: (ctx: Parameters<typeof tickets.issue>[0]) => (issued.push(ctx), tickets.issue(ctx)) } };
    const grant = { watchId: 4, createdBy: OWNER, targets: [{ channel: "C0TEAM00001" }] };
    await respond(spy, { ...fired, slackUserId: OWNER, unprompted: true, trigger: "watch", watchGrant: grant, threadTs: "9.4", messageTs: "9.4" });
    expect(issued[0]).toMatchObject({ watch: true, watchGrant: grant });
    await respond(spy, { ...fired, slackUserId: OWNER, trigger: undefined, watchGrant: grant, threadTs: "9.5", messageTs: "9.5" });
    expect(issued[1]).not.toHaveProperty("watchGrant");
    expect(issued[1]).not.toHaveProperty("watch");
    await respond(spy, { ...fired, slackUserId: OWNER, unprompted: true, trigger: "watch", threadTs: "9.6", messageTs: "9.6" });
    expect(issued[2]).toMatchObject({ watch: true });
    expect(issued[2]).not.toHaveProperty("watchGrant");
  });

  test("a fired watch's grant reaches the run's billing context, and a typed message carries none", async () => {
    const { deps } = build2();
    const bills: unknown[] = [];
    const llm = { complete: async (p: { bill?: unknown }) => (bills.push(p.bill), "ok") };
    const grant = { watchId: 3, createdBy: OWNER, targets: [{ channel: "C0TEAM00001" }] };
    await respond({ ...deps, llm } as typeof deps, { ...fired, slackUserId: OWNER, unprompted: true, trigger: "watch", watchGrant: grant, threadTs: "9.4", messageTs: "9.4" });
    await respond({ ...deps, llm } as typeof deps, { ...fired, slackUserId: OWNER, trigger: undefined, threadTs: "9.5", messageTs: "9.5" });
    expect(bills[0]).toMatchObject({ actor: OWNER, watchGrant: grant });
    expect(bills[0]).not.toHaveProperty("ownMessage");
    expect(bills[1]).toMatchObject({ ownMessage: true });
    expect(bills[1]).not.toHaveProperty("watchGrant");
  });

  test("a followed thread's untagged message gets the owner bit only when the owner alone wrote it, so it may chat.update the bot's own message elsewhere", async () => {
    const { deps } = build2();
    const bills: BillingContext[] = [];
    const llm = { complete: async (p: { bill?: BillingContext }) => (bills.push(p.bill!), "ok") };
    const spy = { ...deps, llm } as typeof deps;
    const followed = { ...fired, slackUserId: OWNER, trigger: undefined, following: true };
    // the owner's own untagged message
    await respond(spy, { ...followed, threadTs: "9.7", messageTs: "9.7", humanMessages: [{ userId: OWNER, text: "x", messageTs: "9.7" }] });
    // the owner's buffered batch, all of it theirs
    await respond(spy, { ...followed, batched: true, threadTs: "9.8", messageTs: "9.9", humanMessages: [{ userId: OWNER, text: "a", messageTs: "9.8" }, { userId: OWNER, text: "b", messageTs: "9.9" }] });
    // a batch with somebody else's words in it, and a followed turn with no record of who typed it
    await respond(spy, { ...followed, batched: true, threadTs: "9.10", messageTs: "9.11", humanMessages: [{ userId: OWNER, text: "a", messageTs: "9.10" }, { userId: "U0PAL0001", text: "b", messageTs: "9.11" }] });
    await respond(spy, { ...followed, threadTs: "9.12", messageTs: "9.12" });
    // a run the bot started never counts, whatever else it carries
    await respond(spy, { ...fired, slackUserId: OWNER, unprompted: true, trigger: "watch", following: true, threadTs: "9.13", messageTs: "9.13", humanMessages: [{ userId: OWNER, text: "x", messageTs: "9.13" }] });
    expect(bills.map((b) => b.ownMessage === true)).toEqual([true, true, false, false, false]);

    // the first one is the Slack ticket's owner bit, and with it the cross-channel own-message update passes (the proxy then checks the bot wrote it)
    const ctx = slackTicketContext(bills[0], undefined, OWNER)!;
    expect(ctx.owner).toBe(true);
    const away = { channel: "C0OTHER0001", ts: "77.7", text: "fixed" };
    const call = checkSlackCall("chat.update", away, ctx);
    expect(call.ok && call.ownMessageIn).toEqual({ channel: "C0OTHER0001", ts: "77.7" });
    // a followed turn that is not the owner's stays in its channel
    expect(checkSlackCall("chat.update", away, slackTicketContext(bills[2], undefined, OWNER)!).ok).toBe(false);
  });

  test("and it is told how, so it does not hand the job back", async () => {
    const { deps, seen } = build2();
    await respond(deps, fired);
    expect(seen[0]?.system).toContain("/x/jarvis-run.sh");
    expect(seen[0]?.system).toContain("//jarvis");
  });

  test("it can set another watch, so a chain of waits does not need a person", async () => {
    // wait for the build, promote, then wait for the deploy
    const { deps, seen } = build2();
    await respond(deps, fired);
    expect(seen[0]?.system).toContain("Waiting for something to finish");
  });
});

describe("a workflow worker does not hold a restart open", () => {
  /** What the registry held while the turn was actually in flight. */
  const runDuring = async (threadTs: string, withWorkflow: boolean) => {
    const db = openDatabase(":memory:");
    let t = 1;
    const runs = createRunRegistry(() => t);
    const workflows = createWorkflowRepo(db);
    if (withWorkflow) {
      workflows.start({ channelId: "C1", threadTs, sessionId: "s1", task: "the blog", startedBy: OWNER }, 1);
    }
    let inFlight: ReturnType<typeof runs.all> = [];
    const deps: RespondDeps = {
      users: createUserRepo(db),
      messages: createMessageRepo(db),
      // Looked at from inside the call, which is the only moment the run exists
      llm: { complete: async () => ((inFlight = runs.all()), "done") },
      clock: () => t++,
      ownerSlackId: OWNER,
      contextWindow: 10,
      runs,
      workflows,
    };
    await respond(deps, {
      channelId: "C1",
      slackUserId: OWNER,
      text: "carry on",
      threadTs,
      messageTs: threadTs,
      viaSlash: false,
    });
    return inFlight;
  };

  test("a turn in a workflow thread is marked background", async () => {
    // the incident: a worker running nine minutes kept the bot deaf, because
    // idleness counted it. A cut worker is redelivered on the same session,
    // so waiting on one only costs everybody else their replies
    const runs = await runDuring("9.9", true);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.background).toBe(true);
  });

  test("an ordinary thread's turn is not background, and still holds it open", async () => {
    const runs = await runDuring("8.8", false);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.background).toBeUndefined();
  });
});
