import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { createCoordinator, dayThreadTs, rearmWatch, type CoordinatorDeps, type CoordinatorTurnRequest } from "../../src/application/coordinator.ts";
import { DEFAULT_PROD_REPING_MS, HOUR_MS, DAY_MS, MINUTE_MS, type BlockerFacts, type OwnPr } from "../../src/domain/coordinator.ts";
import { NO_STUCK_WORK } from "../../src/domain/stuckWork.ts";
import { createJourneyRepo } from "../../src/infrastructure/db/journeyRepo.ts";
import { createCoordinatorRepo } from "../../src/infrastructure/db/coordinatorRepo.ts";
import { createWriterClaimRepo } from "../../src/infrastructure/db/writerClaimRepo.ts";
import { createWatchRepo } from "../../src/infrastructure/db/watchRepo.ts";
import { migrate } from "../../src/infrastructure/db/schema.ts";
import type { Watch } from "../../src/infrastructure/db/watchRepo.ts";

const OWNER = "U0OWNER0001";
/** Deliberately not the default: what is signed and spoken comes from config, never from a constant. */
const NAME = "Aide";
/** 2026-11-27 10:00 in UTC+7. */
const NOON = Date.UTC(2026, 10, 27, 3, 0, 0);
/** 2026-11-27 23:00 in UTC+7: quiet. */
const NIGHT = Date.UTC(2026, 10, 27, 16, 0, 0);

const facts = (over: Partial<BlockerFacts> = {}): BlockerFacts => ({
  prod: false, incident: false, customerImpact: false, reversible: false, dataWrite: false,
  schemaChange: false, secretOrIam: false, beyondRole: false, ownerDecision: false, ...over,
});

const watch = (over: Partial<Watch> = {}): Watch => ({
  id: 1, channelId: "C1", threadTs: "1.1", slackUserId: OWNER, note: "n", check: "bun x/orca-worker-wait.ts 'ctx_w1'", everyMs: 30_000,
  deadlineAt: 0, nextAt: 0, state: "expired", attempts: 0, errors: 0, lastError: "", createdAt: 0, createdBy: "", writeTargets: [], parentWatchId: 0, ...over,
});

const setup = (start = NOON, over: Partial<CoordinatorDeps> = {}) => {
  const db = new Database(":memory:");
  migrate(db);
  const repo = createCoordinatorRepo(db);
  const journeys = createJourneyRepo(db);
  const clock = { t: start };
  const posts: { text: string; by?: string }[] = [];
  const updates: { channel: string; ts: string; text: string; by?: string | null }[] = [];
  const asked: { text: string; ids: string[]; by?: string }[] = [];
  const settled: { channel: string; ts: string; text: string }[] = [];
  const turns: CoordinatorTurnRequest[] = [];
  const renewed: string[] = [];
  const rearmed: number[] = [];
  let tickets: { id: string; dispatchId: string; boundAt: number; expiresAt: number }[] = [];
  let waiting: Watch[] = [];
  let lapsed: Watch[] = [];
  let prs: OwnPr[] = [];
  let scan = NO_STUCK_WORK;
  let unanswered: { channelId: string; threadTs: string; lastAt: number; slackUserId: string }[] = [];
  let n = 0;
  const flags = { dmOpen: true, turnThrows: false, turnCut: false };
  const coordinator = createCoordinator({
    name: NAME,
    clock: () => clock.t,
    ownerSlackId: OWNER,
    repo,
    journeys,
    slack: {
      postDm: async (_u, text, by) => {
        posts.push({ text, by });
        return { channel: "D1", ts: `p${++n}` };
      },
      update: async (channel, ts, text, by) => void updates.push({ channel, ts, text, by }),
      postDmInteractive: async (_u, text, actions, by) => {
        asked.push({ text, ids: actions.map((a) => a.actionId), by });
        return { channel: "D1", ts: `b${++n}` };
      },
      settleInteractive: async (channel, ts, text) => void settled.push({ channel, ts, text }),
      openDm: async () => (flags.dmOpen ? "D1" : undefined),
    },
    tickets: {
      bound: () => tickets,
      renew: (id) => {
        renewed.push(id);
        return { ok: true, expiresAt: clock.t + 3 * HOUR_MS };
      },
    },
    watches: { waiting: () => waiting, lapsedSince: () => lapsed, rearm: (w) => (rearmed.push(w.id), 99) },
    scan: async () => scan,
    ownPrs: async () => ({ prs }),
    unanswered: () => unanswered,
    runTurn: async (req) => {
      turns.push(req);
      if (flags.turnThrows) throw new Error("cut for a restart");
      // An ignored or restart-cut turn resolves as nothing, like a silent one.
      return flags.turnCut ? undefined : { text: "NO_REPLY", ran: true };
    },
    offsetMinutes: () => 420,
    quiet: { startHour: 22, endHour: 5 },
    prefix: "//bot",
    ...over,
  });
  return {
    coordinator, repo, journeys, clock, flags, posts, updates, asked, settled, turns, renewed, rearmed,
    set: {
      tickets: (t: typeof tickets) => (tickets = t),
      waiting: (w: Watch[]) => (waiting = w),
      lapsed: (w: Watch[]) => (lapsed = w),
      prs: (p: OwnPr[]) => (prs = p),
      scan: (s: typeof scan) => (scan = s),
      unanswered: (u: typeof unanswered) => (unanswered = u),
    },
  };
};

const settle = () => new Promise((r) => setTimeout(r, 10));
const journey = (s: ReturnType<typeof setup>, title: string, progress: number, updatedAt: number) => {
  const j = s.journeys.add({ title, status: "doing", area: "", channelId: "C1", threadTs: "", permalink: "", prs: [], progress, now: "", next: "", createdBy: OWNER }, updatedAt);
  return j;
};

describe("the tick settles what code can, and says so in one digest message", () => {
  test("a journey sitting at 100% is closed and the digest is posted once, signed with the configured name", async () => {
    const s = setup();
    const j = journey(s, "ship it", 100, NOON - 5 * DAY_MS);
    await s.coordinator.tick();
    expect(s.journeys.get(j.id)).toMatchObject({ status: "done", progress: 100 });
    expect(s.journeys.events(j.id).some((e) => e.actor === "coordinator")).toBe(true);
    expect(s.posts).toHaveLength(1);
    expect(s.posts[0]).toMatchObject({ by: NAME });
    expect(s.posts[0]!.text).toContain(`closed journey #${j.id}`);
    expect(s.turns).toHaveLength(0);
  });

  test("a later action edits the same message instead of posting a trail", async () => {
    const s = setup();
    journey(s, "a", 100, NOON);
    await s.coordinator.tick();
    journey(s, "b", 100, NOON);
    s.clock.t += 30 * MINUTE_MS;
    await s.coordinator.tick();
    expect(s.posts).toHaveLength(1);
    expect(s.updates).toHaveLength(1);
    expect(s.updates[0]).toMatchObject({ channel: "D1", ts: "p1", by: NAME });
    expect(s.updates[0]!.text).toContain('closed journey #2 "b"');
    expect(s.updates[0]!.text).toContain('closed journey #1 "a"');
  });

  test("a tick with nothing to do posts nothing", async () => {
    const s = setup();
    await s.coordinator.tick();
    expect(s.posts).toHaveLength(0);
    expect(s.asked).toHaveLength(0);
    expect(s.turns).toHaveLength(0);
  });

  test("a worker ticket near its end is renewed while its worker is watched, and not otherwise", async () => {
    const s = setup();
    s.set.tickets([{ id: "aaaaaaaa", dispatchId: "ctx_w1", boundAt: NOON - HOUR_MS, expiresAt: NOON + 20 * MINUTE_MS }]);
    await s.coordinator.tick();
    expect(s.renewed).toEqual([]);
    s.set.waiting([watch({ state: "waiting" })]);
    await s.coordinator.tick();
    expect(s.renewed).toEqual(["aaaaaaaa"]);
    expect(s.posts[0]!.text).toContain("renewed worker ticket aaaaaaaa for ctx_w1");
  });

  test("a ticket past its 24h life goes to the turn, once", async () => {
    const s = setup();
    s.set.waiting([watch({ state: "waiting" })]);
    s.set.tickets([{ id: "bbbbbbbb", dispatchId: "ctx_w1", boundAt: NOON - 25 * HOUR_MS, expiresAt: NOON + HOUR_MS }]);
    await s.coordinator.tick();
    await settle();
    expect(s.turns).toHaveLength(1);
    expect(s.turns[0]!.text).toContain("ticket bbbbbbbb");
    expect(s.renewed).toEqual([]);
    s.clock.t += 30 * MINUTE_MS;
    await s.coordinator.tick();
    await settle();
    expect(s.turns).toHaveLength(1);
  });

  test("a lapsed worker watch is armed again once, unless the worker is dead or already watched", async () => {
    const s = setup();
    s.set.lapsed([watch({ id: 4 })]);
    await s.coordinator.tick();
    expect(s.rearmed).toEqual([4]);
    expect(s.posts[0]!.text).toContain("re-armed the lapsed watch on worker ctx_w1 (#4, now #99)");
    s.clock.t += HOUR_MS;
    await s.coordinator.tick();
    expect(s.rearmed).toEqual([4]);

    const dead = setup();
    dead.set.lapsed([watch({ id: 5 })]);
    dead.set.scan({ ...NO_STUCK_WORK, tasks: [{ taskId: "task_1", runId: "run_1", title: "x", dispatchId: "ctx_w1", why: "terminal gone" }] });
    await dead.coordinator.tick();
    expect(dead.rearmed).toEqual([]);

    const watched = setup();
    watched.set.lapsed([watch({ id: 6 })]);
    watched.set.waiting([watch({ id: 7, state: "waiting" })]);
    await watched.coordinator.tick();
    expect(watched.rearmed).toEqual([]);
  });
});

describe("the judgment turn", () => {
  test("stale journeys go to one fresh daily session in the owner's DM, held, as the owner", async () => {
    const s = setup();
    const j = journey(s, "old thing", 30, NOON - 5 * DAY_MS);
    await s.coordinator.tick();
    await settle();
    expect(s.turns).toHaveLength(1);
    const req = s.turns[0]!;
    expect(req).toMatchObject({ channelId: "D1", slackUserId: OWNER, unprompted: true, hold: true, threadTs: dayThreadTs("2026-11-27") });
    expect(req.text).toContain(`journey #${j.id}`);
    expect(req.text).toContain(`You are ${NAME}`);
    // Another day is another session.
    expect(dayThreadTs("2026-11-28")).not.toBe(dayThreadTs("2026-11-27"));
  });

  test("the same stale journey is not fed again inside a day", async () => {
    const s = setup();
    journey(s, "old thing", 30, NOON - 5 * DAY_MS);
    await s.coordinator.tick();
    await settle();
    s.clock.t += 30 * MINUTE_MS;
    await s.coordinator.tick();
    await settle();
    expect(s.turns).toHaveLength(1);
    s.clock.t += DAY_MS;
    await s.coordinator.tick();
    await settle();
    expect(s.turns).toHaveLength(2);
  });

  test("red CI, a reviewer waited on, a dead worker and an unanswered thread all reach the picture", async () => {
    const s = setup();
    s.set.prs([
      { number: 11, title: "red one", url: "https://github.com/o/r/pull/11", draft: false, ci: "red", waitingOn: [], updatedAt: NOON },
      { number: 12, title: "slow one", url: "https://github.com/o/r/pull/12", draft: false, ci: "green", waitingOn: ["sam"], updatedAt: NOON - 2 * DAY_MS },
    ]);
    s.set.scan({ ...NO_STUCK_WORK, tasks: [{ taskId: "task_9", runId: "run_9", title: "dead job", dispatchId: "ctx_d9", why: "terminal gone" }] });
    s.set.unanswered([{ channelId: "C9", threadTs: "9.9", lastAt: NOON - 5 * HOUR_MS, slackUserId: OWNER }]);
    await s.coordinator.tick();
    await settle();
    const text = s.turns[0]!.text;
    expect(text).toContain("PR #11");
    expect(text).toContain("PR #12");
    expect(text).toContain("waiting on sam");
    expect(text).toContain("task task_9 (ctx_d9)");
    expect(text).toContain("thread C9 9.9");
  });

  test("quiet hours hold the turn and the first digest post, never the work code does itself", async () => {
    const s = setup(NIGHT);
    journey(s, "stale", 30, NIGHT - 5 * DAY_MS);
    journey(s, "done", 100, NIGHT);
    await s.coordinator.tick();
    await settle();
    expect(s.turns).toHaveLength(0);
    expect(s.posts).toHaveLength(0);
    expect(s.repo.lines("2026-11-27").map((l) => l.text).join("\n")).toContain("closed journey");
    // Morning (10:00 on the 28th): the night's line is posted with its own day's digest, and the stale journey goes to the turn.
    s.clock.t = Date.UTC(2026, 10, 28, 3, 0, 0);
    await s.coordinator.tick();
    await settle();
    expect(s.posts).toHaveLength(1);
    expect(s.posts[0]!.text).toContain(`*${NAME}* - housekeeping digest, 2026-11-27`);
    expect(s.posts[0]!.text).toContain("closed journey");
    expect(s.turns).toHaveLength(1);
    expect(s.turns[0]!.threadTs).toBe(dayThreadTs("2026-11-28"));
  });

  test("the day turns at 05:00, not at midnight: 02:00 still belongs to the evening before", async () => {
    const s = setup(Date.UTC(2026, 10, 27, 19, 0, 0)); // 02:00 on the 28th, quiet
    await s.coordinator.act("night line");
    expect(s.repo.lines("2026-11-27").map((l) => l.text)).toEqual(["night line"]);
    expect(s.repo.lines("2026-11-28")).toEqual([]);
  });

  test("a digest that already exists keeps being edited through quiet hours (no ping)", async () => {
    const s = setup();
    journey(s, "a", 100, NOON);
    await s.coordinator.tick();
    s.clock.t = NIGHT;
    journey(s, "b", 100, NIGHT);
    await s.coordinator.tick();
    expect(s.posts).toHaveLength(1);
    expect(s.updates).toHaveLength(1);
  });

  test("while a restart drains the tick holds", async () => {
    const s = setup(NOON, { enabled: () => false });
    journey(s, "a", 100, NOON);
    await s.coordinator.tick();
    expect(s.posts).toHaveLength(0);
  });

  test("an approved blocker is handed to the turn once", async () => {
    const s = setup();
    const b = s.repo.openBlocker({ key: "k", kind: "permission", prod: false, text: "needs the staging bucket" }, NOON);
    s.repo.decide(b.id, "approved", NOON);
    await s.coordinator.tick();
    await settle();
    expect(s.turns).toHaveLength(1);
    expect(s.turns[0]!.text).toContain("needs the staging bucket");
    s.clock.t += 30 * MINUTE_MS;
    await s.coordinator.tick();
    await settle();
    expect(s.turns).toHaveLength(1);
  });
});

describe("a held or failed turn loses nothing", () => {
  test("no DM to the owner: nothing is marked as fed, the same items come back next tick", async () => {
    const s = setup();
    journey(s, "old thing", 30, NOON - 5 * DAY_MS);
    s.flags.dmOpen = false;
    await s.coordinator.tick();
    await settle();
    expect(s.turns).toHaveLength(0);
    expect(s.repo.lastMark("nudge", "journey:1")).toBeUndefined();
    s.flags.dmOpen = true;
    s.clock.t += 30 * MINUTE_MS;
    await s.coordinator.tick();
    await settle();
    expect(s.turns).toHaveLength(1);
    expect(s.turns[0]!.text).toContain("journey #1");
  });

  test("an approval is handed over once the turn has run; a turn that throws leaves it to be fed again", async () => {
    const s = setup();
    const b = s.repo.openBlocker({ key: "k", kind: "permission", prod: false, text: "needs the staging bucket" }, NOON);
    s.repo.decide(b.id, "approved", NOON);
    s.flags.turnThrows = true;
    await s.coordinator.tick();
    await settle();
    expect(s.turns).toHaveLength(1);
    expect(s.repo.approvedUnhandled().map((x) => x.id)).toEqual([b.id]);
    s.flags.turnThrows = false;
    s.clock.t += 30 * MINUTE_MS;
    await s.coordinator.tick();
    await settle();
    expect(s.turns).toHaveLength(2);
    expect(s.turns[1]!.text).toContain("needs the staging bucket");
    expect(s.repo.approvedUnhandled()).toEqual([]);
  });

  test("a turn that was ignored or cut for a restart (it resolves as nothing) marks nothing and hands over no approval: all of it is fed again", async () => {
    const s = setup();
    journey(s, "old thing", 30, NOON - 5 * DAY_MS);
    const b = s.repo.openBlocker({ key: "k", kind: "permission", prod: false, text: "needs the bucket" }, NOON);
    s.repo.decide(b.id, "approved", NOON);
    s.flags.turnCut = true;
    await s.coordinator.tick();
    await settle();
    expect(s.turns).toHaveLength(1);
    expect(s.repo.lastMark("nudge", "journey:1")).toBeUndefined();
    expect(s.repo.approvedUnhandled().map((x) => x.id)).toEqual([b.id]);
    s.flags.turnCut = false;
    s.clock.t += 30 * MINUTE_MS;
    await s.coordinator.tick();
    await settle();
    expect(s.turns).toHaveLength(2);
    expect(s.turns[1]!.text).toContain("journey #1");
    expect(s.turns[1]!.text).toContain("needs the bucket");
    expect(s.repo.approvedUnhandled()).toEqual([]);
    expect(s.repo.lastMark("nudge", "journey:1")).toBeDefined();
  });

  test("a ticket already capped at its 24h life and about to lapse is replaced (fed to the turn), not renewed every tick", async () => {
    const s = setup();
    s.set.waiting([watch({ state: "waiting" })]);
    const boundAt = NOON - 23.5 * HOUR_MS;
    s.set.tickets([{ id: "cccccccc", dispatchId: "ctx_w1", boundAt, expiresAt: boundAt + 24 * HOUR_MS }]);
    await s.coordinator.tick();
    await settle();
    expect(s.renewed).toEqual([]);
    expect(s.turns[0]!.text).toContain("ticket cccccccc");
  });
});

describe("blockers: the original rule (non-prod)", () => {
  test("raised once with Approve / Reject and never again, however often the turn asks", async () => {
    const s = setup();
    const first = await s.coordinator.blocker({ key: "needs-iam", kind: "permission", text: "needs a role the owner lacks", facts: facts() });
    expect(first).toContain("raised to the owner once");
    expect(s.asked).toHaveLength(1);
    expect(s.asked[0]).toMatchObject({ ids: ["jv:coordinator:approve", "jv:coordinator:reject"], by: NAME });
    s.clock.t += 5 * DAY_MS;
    const again = await s.coordinator.blocker({ key: "needs-iam", kind: "permission", text: "needs a role the owner lacks", facts: facts() });
    expect(again).toContain("already put to the owner");
    await s.coordinator.tick();
    expect(s.asked).toHaveLength(1);
  });

  test("in quiet hours it is held, then raised by the first tick after", async () => {
    const s = setup(NIGHT);
    const out = await s.coordinator.blocker({ key: "k", kind: "decision", text: "which one?", facts: facts() });
    expect(out).toContain("quiet hours");
    expect(s.asked).toHaveLength(0);
    await s.coordinator.tick();
    expect(s.asked).toHaveLength(0);
    s.clock.t = Date.UTC(2026, 10, 28, 3, 0, 0);
    await s.coordinator.tick();
    expect(s.asked).toHaveLength(1);
  });

  test("a decided blocker is not raised again", async () => {
    const s = setup();
    await s.coordinator.blocker({ key: "k", kind: "decision", text: "which?", facts: facts() });
    s.repo.decide(1, "rejected", NOON);
    const out = await s.coordinator.blocker({ key: "k", kind: "decision", text: "which?", facts: facts() });
    expect(out).toContain("already decided");
    expect(s.asked).toHaveLength(1);
  });

  test("a blocker with no key or sentence raises nothing", async () => {
    const s = setup();
    expect(await s.coordinator.blocker({ key: "", kind: "other", text: "x", facts: facts() })).toContain("Nothing was raised");
    expect(s.asked).toHaveLength(0);
  });
});

describe("blockers: the prod rule", () => {
  test("a prod blocker is raised at once, quiet hours or not", async () => {
    const s = setup(NIGHT);
    const out = await s.coordinator.blocker({ key: "pg-full", kind: "prod-write", text: "disk is filling, needs a data purge", facts: facts({ prod: true, incident: true, dataWrite: true, reversible: true }) });
    expect(out).toContain("asked again until they act");
    expect(s.asked).toHaveLength(1);
    expect(s.asked[0]!.text).toContain("prod blocker");
  });

  test("an undecided prod blocker is asked again every re-ask span, each time a fresh message, the old one settled", async () => {
    const s = setup();
    await s.coordinator.blocker({ key: "pg-full", kind: "prod-write", text: "purge needed", facts: facts({ prod: true, dataWrite: true }) });
    s.clock.t += 10 * MINUTE_MS;
    await s.coordinator.tick();
    expect(s.asked).toHaveLength(1);
    s.clock.t += DEFAULT_PROD_REPING_MS;
    await s.coordinator.tick();
    expect(s.asked).toHaveLength(2);
    expect(s.asked[1]!.text).toContain("asked 2 times");
    expect(s.settled).toHaveLength(1);
    expect(s.settled[0]!.text).toContain("asked again below");
    // Through the night too.
    s.clock.t = NIGHT;
    await s.coordinator.tick();
    expect(s.asked).toHaveLength(3);
  });

  test("the turn calling again while it is not due is told to leave it", async () => {
    const s = setup();
    const f = facts({ prod: true, dataWrite: true });
    await s.coordinator.blocker({ key: "k", kind: "prod-write", text: "x", facts: f });
    const again = await s.coordinator.blocker({ key: "k", kind: "prod-write", text: "x", facts: f });
    expect(again).toContain("asked again on its own");
    expect(s.asked).toHaveLength(1);
  });

  test("once the owner decides, the re-asking stops", async () => {
    const s = setup();
    await s.coordinator.blocker({ key: "k", kind: "prod-write", text: "x", facts: facts({ prod: true, dataWrite: true }) });
    s.repo.decide(1, "approved", NOON);
    s.clock.t += 2 * DEFAULT_PROD_REPING_MS;
    await s.coordinator.tick();
    await settle();
    expect(s.asked).toHaveLength(1);
  });

  test("prod, urgent and low-risk: told to self-fix, nothing raised; fixed reports it in the digest and one direct DM line", async () => {
    const s = setup(NIGHT);
    const out = await s.coordinator.blocker({ key: "cache-bust", kind: "prod-write", text: "stale cache serving wrong menu", facts: facts({ prod: true, customerImpact: true, reversible: true }) });
    expect(out).toContain("self-fix");
    expect(out).toContain("coordinator fixed cache-bust");
    expect(s.asked).toHaveLength(0);
    expect(s.repo.blockerByKey("cache-bust")).toBeUndefined();

    expect(await s.coordinator.fixed("cache-bust", "flushed the menu cache, reversible")).toBe(true);
    expect(s.repo.lines("2026-11-27").map((l) => l.text).join("\n")).toContain("prod fix by me");
    // The direct line goes out at night: a prod item was touched.
    const dm = s.posts.find((p) => p.text.includes("fixed a prod item myself"));
    expect(dm).toBeDefined();
    expect(dm).toMatchObject({ by: NAME });
    expect(dm!.text).toContain("flushed the menu cache");
  });

  test("fixed is refused without a self-fix the rules granted for that key, and after the grant runs out", async () => {
    const s = setup();
    expect(await s.coordinator.fixed("never-asked", "did a thing")).toBe(false);
    expect(s.posts).toHaveLength(0);
    await s.coordinator.blocker({ key: "cache-bust", kind: "prod-write", text: "stale", facts: facts({ prod: true, customerImpact: true, reversible: true }) });
    expect(await s.coordinator.fixed("other-key", "x")).toBe(false);
    s.clock.t += 7 * HOUR_MS;
    expect(await s.coordinator.fixed("cache-bust", "late")).toBe(false);
    expect(s.posts).toHaveLength(0);
  });

  test("a self-fix closes an earlier prod ask for the same key: the old message is settled and the owner is not asked all night", async () => {
    const s = setup();
    await s.coordinator.blocker({ key: "menu-cache", kind: "prod-write", text: "cache serves a stale menu", facts: facts({ prod: true, reversible: true }) });
    expect(s.asked).toHaveLength(1);
    // Later it turns urgent: low-risk and urgent, so the coordinator fixes it itself.
    const out = await s.coordinator.blocker({ key: "menu-cache", kind: "prod-write", text: "cache serves a stale menu", facts: facts({ prod: true, reversible: true, customerImpact: true }) });
    expect(out).toContain("self-fix");
    expect(s.repo.blockerByKey("menu-cache")?.state).toBe("fixed");
    expect(s.settled.map((x) => x.text).join("\n")).toContain("now fixed by me");
    expect(await s.coordinator.fixed("menu-cache", "flushed the cache")).toBe(true);
    s.clock.t = NIGHT;
    await s.coordinator.tick();
    expect(s.asked).toHaveLength(1);
    expect(s.repo.pending()).toEqual([]);
  });

  test("the same key arising again after a self-fix is a new blocker", async () => {
    const s = setup();
    const risky = facts({ prod: true, incident: true, reversible: true });
    await s.coordinator.blocker({ key: "k", kind: "prod-write", text: "first time", facts: risky });
    await s.coordinator.fixed("k", "done");
    const second = await s.coordinator.blocker({ key: "k", kind: "prod-write", text: "second time", facts: { ...risky, dataWrite: true } });
    expect(second).toContain("raised to the owner");
    expect(s.asked).toHaveLength(1);
    expect(s.repo.blockerByKey("k")).toMatchObject({ state: "pending", text: "second time" });
  });

  test("a key raised first as non-prod and then as prod is asked under the prod rule: marked prod, asked again", async () => {
    const s = setup();
    await s.coordinator.blocker({ key: "deploy-x", kind: "decision", text: "ship it?", facts: facts() });
    s.clock.t += 10 * MINUTE_MS;
    const out = await s.coordinator.blocker({ key: "deploy-x", kind: "prod-write", text: "ship it?", facts: facts({ prod: true, dataWrite: true }) });
    expect(out).toContain("raised to the owner");
    expect(s.repo.blockerByKey("deploy-x")?.prod).toBe(true);
    expect(s.asked[1]!.text).toContain("prod blocker");
    s.clock.t += DEFAULT_PROD_REPING_MS;
    await s.coordinator.tick();
    expect(s.asked).toHaveLength(3);
  });

  test("urgent but with a data write, or low-risk but not urgent, is never self-fixed", async () => {
    const s = setup();
    const risky = await s.coordinator.blocker({ key: "a", kind: "prod-write", text: "x", facts: facts({ prod: true, incident: true, reversible: true, dataWrite: true }) });
    const calm = await s.coordinator.blocker({ key: "b", kind: "prod-write", text: "y", facts: facts({ prod: true, reversible: true }) });
    expect(risky).not.toContain("self-fix");
    expect(calm).not.toContain("self-fix");
    expect(s.asked).toHaveLength(2);
  });
});

describe("act", () => {
  test("a line lands in the digest as plain text", async () => {
    const s = setup();
    await s.coordinator.act("chased <@U123> on *PR #9*");
    expect(s.posts[0]!.text).toContain("chased U123 on PR #9");
    expect(s.posts[0]!.text).not.toContain("<@");
  });
});

describe("rearmWatch: a lapsed worker watch armed again, the grant bounded by the whole chain", () => {
  const mk = () => {
    const db = new Database(":memory:");
    migrate(db);
    const w = createWatchRepo(db);
    const base = { channelId: "C1", threadTs: "1.1", slackUserId: OWNER, note: "n", check: "bun x/orca-worker-wait.ts 'ctx_w1'", everyMs: 30_000, deadlineAt: 1 };
    return { w, base };
  };
  const T0 = 1_000_000_000_000;
  const grant = { createdBy: OWNER, writeTargets: [{ channel: "C0TEAM00001" }] };

  test("a plain watch is armed again plain", () => {
    const { w, base } = mk();
    const old = w.add({ ...base, createdAt: T0 }, T0);
    const id = rearmWatch(w, old, T0 + 5 * DAY_MS);
    expect(w.get(id)).toMatchObject({ createdBy: "", writeTargets: [], parentWatchId: 0, state: "waiting" });
    expect(w.get(id)!.deadlineAt).toBe(T0 + 5 * DAY_MS + 12 * HOUR_MS);
  });

  test("a grant is carried inside the chain, with the lapsed watch as parent", () => {
    const { w, base } = mk();
    const old = w.add({ ...base, createdAt: T0, ...grant }, T0);
    const id = rearmWatch(w, old, T0 + DAY_MS);
    expect(w.get(id)).toMatchObject({ createdBy: OWNER, parentWatchId: old.id });
    expect(w.get(id)!.writeTargets).toEqual([{ channel: "C0TEAM00001" }]);
  });

  test("the 30 days are counted from the FIRST watch of the chain: re-arming again and again does not renew the grant", () => {
    const { w, base } = mk();
    const root = w.add({ ...base, createdAt: T0, ...grant }, T0);
    let cur = root;
    let now = T0;
    let carried = 0;
    // Re-arm every 10 days: the third re-arm sits past the root's 30 days.
    for (let i = 0; i < 4; i++) {
      now += 10 * DAY_MS;
      w.settle(cur.id, "expired", now);
      const id = rearmWatch(w, cur, now);
      cur = w.get(id)!;
      if (cur.createdBy) carried++;
    }
    expect(carried).toBe(2);
    expect(cur).toMatchObject({ createdBy: "", writeTargets: [], parentWatchId: 0 });
    // The last grant-carrying watch ended no later than the root's 30 days.
    const chain = [root.id + 1, root.id + 2].map((id) => w.get(id)!);
    for (const c of chain) expect(c.deadlineAt).toBeLessThanOrEqual(T0 + 30 * DAY_MS);
  });

  test("a parent that already has the most grant-holding children waiting arms the new one plain", () => {
    const { w, base } = mk();
    const old = w.add({ ...base, createdAt: T0, ...grant }, T0);
    for (let i = 0; i < 5; i++) w.add({ ...base, createdAt: T0, ...grant, parentWatchId: old.id }, T0);
    const id = rearmWatch(w, old, T0 + HOUR_MS);
    expect(w.get(id)).toMatchObject({ createdBy: "", writeTargets: [] });
  });
});

describe("blockers: a low-risk non-prod one is approved by the coordinator, not put to the owner", () => {
  test("approved on the spot, handled, one digest line, nothing asked, and the next tick does not hand it over", async () => {
    const s = setup();
    const out = await s.coordinator.blocker({ key: "retry-lint", kind: "other", text: "retry the failed lint step", facts: facts({ reversible: true }) });
    expect(out).toContain("approved by me");
    expect(s.asked).toHaveLength(0);
    expect(s.repo.blockerByKey("retry-lint")).toMatchObject({ state: "approved" });
    expect(s.repo.approvedUnhandled()).toHaveLength(0);
    expect(s.posts[0]!.text).toContain("approved by me (non-prod, low-risk");
    await s.coordinator.tick();
    expect(s.turns).toHaveLength(0);
  });

  test("the same wall asked again is decided, not approved twice", async () => {
    const s = setup();
    await s.coordinator.blocker({ key: "retry-lint", kind: "other", text: "retry the failed lint step", facts: facts({ reversible: true }) });
    const again = await s.coordinator.blocker({ key: "retry-lint", kind: "other", text: "retry the failed lint step", facts: facts({ reversible: true }) });
    expect(again).toContain("owner already decided");
  });

  test("anything not provably low-risk still goes to the owner's buttons", async () => {
    const s = setup();
    await s.coordinator.blocker({ key: "a", kind: "other", text: "retry the failed lint step", facts: facts() });
    await s.coordinator.blocker({ key: "b", kind: "other", text: "rotate the token", facts: facts({ reversible: true }) });
    await s.coordinator.blocker({ key: "c", kind: "decision", text: "pick a vendor", facts: facts({ reversible: true }) });
    expect(s.asked).toHaveLength(3);
  });
});

describe("writer claims on the tick", () => {
  const withClaims = () => {
    const db = new Database(":memory:");
    migrate(db);
    const claims = createWriterClaimRepo(db);
    const s = setup(NOON, {
      claims: { live: claims.live, release: (id, why) => claims.release(id, why, NOON) },
    });
    return { s, claims };
  };
  const take = (claims: ReturnType<typeof createWriterClaimRepo>, key: string, dispatch: string, at = NOON - HOUR_MS) => {
    const c = claims.add({ key, channelId: "C1", threadTs: "1.1", actor: OWNER, createdAt: at }, at);
    if (dispatch) claims.bind(c.id, dispatch);
    return c;
  };

  test("a claim whose worker is dead is released by the tick and reported in the digest", async () => {
    const { s, claims } = withClaims();
    take(claims, "bug:23", "ctx_dead");
    take(claims, "bug:24", "ctx_alive");
    s.set.scan({ tasks: [{ taskId: "t1", dispatchId: "ctx_dead", title: "fix", why: "worker gone" }], prs: [] } as never);
    await s.coordinator.tick();
    expect(claims.live().map((c) => c.key)).toEqual(["bug:24"]);
    expect(s.posts[0]!.text).toContain("released the claim on bug:23: its worker ctx_dead is gone");
  });

  test("a claim never bound to a writer is released once it is old enough", async () => {
    const { s, claims } = withClaims();
    take(claims, "bug:25", "", NOON - HOUR_MS);
    take(claims, "bug:26", "", NOON - 60_000);
    await s.coordinator.tick();
    expect(claims.live().map((c) => c.key)).toEqual(["bug:26"]);
    expect(s.posts[0]!.text).toContain("no writer was ever started for it");
  });

  test("two writers on one key are reported, once a day, and neither is released", async () => {
    const { s, claims } = withClaims();
    take(claims, "bug:27", "ctx_a");
    take(claims, "bug:27", "ctx_b");
    await s.coordinator.tick();
    expect(s.posts[0]!.text).toContain("two writers on bug:27");
    expect(claims.live()).toHaveLength(2);
    s.clock.t += 30 * MINUTE_MS;
    await s.coordinator.tick();
    const digest = s.updates.at(-1)?.text ?? s.posts[0]!.text;
    expect(digest.split("two writers on bug:27")).toHaveLength(2);
  });

  test("status lists the live claims", async () => {
    const { s, claims } = withClaims();
    take(claims, "bug:28", "ctx_a");
    expect(s.coordinator.status()).toContain("bug:28 (worker ctx_a");
  });
});
