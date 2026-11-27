import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { createJueki, dayThreadTs, type JuekiDeps, type JuekiTurnRequest } from "../../src/application/jueki.ts";
import { DEFAULT_PROD_REPING_MS, HOUR_MS, DAY_MS, MINUTE_MS, type BlockerFacts, type OwnPr } from "../../src/domain/jueki.ts";
import { NO_STUCK_WORK } from "../../src/domain/stuckWork.ts";
import { createJourneyRepo } from "../../src/infrastructure/db/journeyRepo.ts";
import { createJuekiRepo } from "../../src/infrastructure/db/juekiRepo.ts";
import { migrate } from "../../src/infrastructure/db/schema.ts";
import type { Watch } from "../../src/infrastructure/db/watchRepo.ts";

const OWNER = "U0OWNER0001";
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

const setup = (start = NOON, over: Partial<JuekiDeps> = {}) => {
  const db = new Database(":memory:");
  migrate(db);
  const repo = createJuekiRepo(db);
  const journeys = createJourneyRepo(db);
  const clock = { t: start };
  const posts: { text: string; by?: string }[] = [];
  const updates: { channel: string; ts: string; text: string; by?: string }[] = [];
  const asked: { text: string; ids: string[]; by?: string }[] = [];
  const settled: { channel: string; ts: string; text: string }[] = [];
  const turns: JuekiTurnRequest[] = [];
  const renewed: string[] = [];
  const rearmed: number[] = [];
  let tickets: { id: string; dispatchId: string; boundAt: number; expiresAt: number }[] = [];
  let waiting: Watch[] = [];
  let lapsed: Watch[] = [];
  let prs: OwnPr[] = [];
  let scan = NO_STUCK_WORK;
  let unanswered: { channelId: string; threadTs: string; lastAt: number; slackUserId: string }[] = [];
  let n = 0;
  const jueki = createJueki({
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
      openDm: async () => "D1",
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
      return { text: "NO_REPLY" };
    },
    offsetMinutes: () => 420,
    quiet: { startHour: 22, endHour: 5 },
    prefix: "//bot",
    ...over,
  });
  return {
    jueki, repo, journeys, clock, posts, updates, asked, settled, turns, renewed, rearmed,
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
  test("a journey sitting at 100% is closed and the digest is posted once, signed Jueki", async () => {
    const s = setup();
    const j = journey(s, "ship it", 100, NOON - 5 * DAY_MS);
    await s.jueki.tick();
    expect(s.journeys.get(j.id)).toMatchObject({ status: "done", progress: 100 });
    expect(s.journeys.events(j.id).some((e) => e.actor === "jueki")).toBe(true);
    expect(s.posts).toHaveLength(1);
    expect(s.posts[0]).toMatchObject({ by: "Jueki" });
    expect(s.posts[0]!.text).toContain(`closed journey #${j.id}`);
    expect(s.turns).toHaveLength(0);
  });

  test("a later action edits the same message instead of posting a trail", async () => {
    const s = setup();
    journey(s, "a", 100, NOON);
    await s.jueki.tick();
    journey(s, "b", 100, NOON);
    s.clock.t += 30 * MINUTE_MS;
    await s.jueki.tick();
    expect(s.posts).toHaveLength(1);
    expect(s.updates).toHaveLength(1);
    expect(s.updates[0]).toMatchObject({ channel: "D1", ts: "p1", by: "Jueki" });
    expect(s.updates[0]!.text).toContain('closed journey #2 "b"');
    expect(s.updates[0]!.text).toContain('closed journey #1 "a"');
  });

  test("a tick with nothing to do posts nothing", async () => {
    const s = setup();
    await s.jueki.tick();
    expect(s.posts).toHaveLength(0);
    expect(s.asked).toHaveLength(0);
    expect(s.turns).toHaveLength(0);
  });

  test("a worker ticket near its end is renewed while its worker is watched, and not otherwise", async () => {
    const s = setup();
    s.set.tickets([{ id: "aaaaaaaa", dispatchId: "ctx_w1", boundAt: NOON - HOUR_MS, expiresAt: NOON + 20 * MINUTE_MS }]);
    await s.jueki.tick();
    expect(s.renewed).toEqual([]);
    s.set.waiting([watch({ state: "waiting" })]);
    await s.jueki.tick();
    expect(s.renewed).toEqual(["aaaaaaaa"]);
    expect(s.posts[0]!.text).toContain("renewed worker ticket aaaaaaaa for ctx_w1");
  });

  test("a ticket past its 24h life goes to the turn, once", async () => {
    const s = setup();
    s.set.waiting([watch({ state: "waiting" })]);
    s.set.tickets([{ id: "bbbbbbbb", dispatchId: "ctx_w1", boundAt: NOON - 25 * HOUR_MS, expiresAt: NOON + HOUR_MS }]);
    await s.jueki.tick();
    await settle();
    expect(s.turns).toHaveLength(1);
    expect(s.turns[0]!.text).toContain("ticket bbbbbbbb");
    expect(s.renewed).toEqual([]);
    s.clock.t += 30 * MINUTE_MS;
    await s.jueki.tick();
    await settle();
    expect(s.turns).toHaveLength(1);
  });

  test("a lapsed worker watch is armed again once, unless the worker is dead or already watched", async () => {
    const s = setup();
    s.set.lapsed([watch({ id: 4 })]);
    await s.jueki.tick();
    expect(s.rearmed).toEqual([4]);
    expect(s.posts[0]!.text).toContain("re-armed the lapsed watch on worker ctx_w1 (#4, now #99)");
    s.clock.t += HOUR_MS;
    await s.jueki.tick();
    expect(s.rearmed).toEqual([4]);

    const dead = setup();
    dead.set.lapsed([watch({ id: 5 })]);
    dead.set.scan({ ...NO_STUCK_WORK, tasks: [{ taskId: "task_1", runId: "run_1", title: "x", dispatchId: "ctx_w1", why: "terminal gone" }] });
    await dead.jueki.tick();
    expect(dead.rearmed).toEqual([]);

    const watched = setup();
    watched.set.lapsed([watch({ id: 6 })]);
    watched.set.waiting([watch({ id: 7, state: "waiting" })]);
    await watched.jueki.tick();
    expect(watched.rearmed).toEqual([]);
  });
});

describe("the judgment turn", () => {
  test("stale journeys go to one fresh daily session in the owner's DM, held, as the owner", async () => {
    const s = setup();
    const j = journey(s, "old thing", 30, NOON - 5 * DAY_MS);
    await s.jueki.tick();
    await settle();
    expect(s.turns).toHaveLength(1);
    const req = s.turns[0]!;
    expect(req).toMatchObject({ channelId: "D1", slackUserId: OWNER, unprompted: true, hold: true, threadTs: dayThreadTs("2026-11-27") });
    expect(req.text).toContain(`journey #${j.id}`);
    expect(req.text).toContain("You are Jueki");
    // Another day is another session.
    expect(dayThreadTs("2026-11-28")).not.toBe(dayThreadTs("2026-11-27"));
  });

  test("the same stale journey is not fed again inside a day", async () => {
    const s = setup();
    journey(s, "old thing", 30, NOON - 5 * DAY_MS);
    await s.jueki.tick();
    await settle();
    s.clock.t += 30 * MINUTE_MS;
    await s.jueki.tick();
    await settle();
    expect(s.turns).toHaveLength(1);
    s.clock.t += DAY_MS;
    await s.jueki.tick();
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
    await s.jueki.tick();
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
    await s.jueki.tick();
    await settle();
    expect(s.turns).toHaveLength(0);
    expect(s.posts).toHaveLength(0);
    expect(s.repo.lines("2026-11-27").map((l) => l.text).join("\n")).toContain("closed journey");
    // Morning (10:00 on the 28th): the night's line is posted with its own day's digest, and the stale journey goes to the turn.
    s.clock.t = Date.UTC(2026, 10, 28, 3, 0, 0);
    await s.jueki.tick();
    await settle();
    expect(s.posts).toHaveLength(1);
    expect(s.posts[0]!.text).toContain("housekeeping digest, 2026-11-27");
    expect(s.posts[0]!.text).toContain("closed journey");
    expect(s.turns).toHaveLength(1);
    expect(s.turns[0]!.threadTs).toBe(dayThreadTs("2026-11-28"));
  });

  test("the day turns at 05:00, not at midnight: 02:00 still belongs to the evening before", async () => {
    const s = setup(Date.UTC(2026, 10, 27, 19, 0, 0)); // 02:00 on the 28th, quiet
    await s.jueki.act("night line");
    expect(s.repo.lines("2026-11-27").map((l) => l.text)).toEqual(["night line"]);
    expect(s.repo.lines("2026-11-28")).toEqual([]);
  });

  test("a digest that already exists keeps being edited through quiet hours (no ping)", async () => {
    const s = setup();
    journey(s, "a", 100, NOON);
    await s.jueki.tick();
    s.clock.t = NIGHT;
    journey(s, "b", 100, NIGHT);
    await s.jueki.tick();
    expect(s.posts).toHaveLength(1);
    expect(s.updates).toHaveLength(1);
  });

  test("while a restart drains the tick holds", async () => {
    const s = setup(NOON, { enabled: () => false });
    journey(s, "a", 100, NOON);
    await s.jueki.tick();
    expect(s.posts).toHaveLength(0);
  });

  test("an approved blocker is handed to the turn once", async () => {
    const s = setup();
    const b = s.repo.openBlocker({ key: "k", kind: "permission", prod: false, text: "needs the staging bucket" }, NOON);
    s.repo.decide(b.id, "approved", NOON);
    await s.jueki.tick();
    await settle();
    expect(s.turns).toHaveLength(1);
    expect(s.turns[0]!.text).toContain("needs the staging bucket");
    s.clock.t += 30 * MINUTE_MS;
    await s.jueki.tick();
    await settle();
    expect(s.turns).toHaveLength(1);
  });
});

describe("blockers: the original rule (non-prod)", () => {
  test("raised once with Approve / Reject and never again, however often the turn asks", async () => {
    const s = setup();
    const first = await s.jueki.blocker({ key: "needs-iam", kind: "permission", text: "needs a role the owner lacks", facts: facts() });
    expect(first).toContain("raised to the owner once");
    expect(s.asked).toHaveLength(1);
    expect(s.asked[0]).toMatchObject({ ids: ["jv:jueki:approve", "jv:jueki:reject"], by: "Jueki" });
    s.clock.t += 5 * DAY_MS;
    const again = await s.jueki.blocker({ key: "needs-iam", kind: "permission", text: "needs a role the owner lacks", facts: facts() });
    expect(again).toContain("already put to the owner");
    await s.jueki.tick();
    expect(s.asked).toHaveLength(1);
  });

  test("in quiet hours it is held, then raised by the first tick after", async () => {
    const s = setup(NIGHT);
    const out = await s.jueki.blocker({ key: "k", kind: "decision", text: "which one?", facts: facts() });
    expect(out).toContain("quiet hours");
    expect(s.asked).toHaveLength(0);
    await s.jueki.tick();
    expect(s.asked).toHaveLength(0);
    s.clock.t = Date.UTC(2026, 10, 28, 3, 0, 0);
    await s.jueki.tick();
    expect(s.asked).toHaveLength(1);
  });

  test("a decided blocker is not raised again", async () => {
    const s = setup();
    await s.jueki.blocker({ key: "k", kind: "decision", text: "which?", facts: facts() });
    s.repo.decide(1, "rejected", NOON);
    const out = await s.jueki.blocker({ key: "k", kind: "decision", text: "which?", facts: facts() });
    expect(out).toContain("already decided");
    expect(s.asked).toHaveLength(1);
  });

  test("a blocker with no key or sentence raises nothing", async () => {
    const s = setup();
    expect(await s.jueki.blocker({ key: "", kind: "other", text: "x", facts: facts() })).toContain("Nothing was raised");
    expect(s.asked).toHaveLength(0);
  });
});

describe("blockers: the prod rule", () => {
  test("a prod blocker is raised at once, quiet hours or not", async () => {
    const s = setup(NIGHT);
    const out = await s.jueki.blocker({ key: "pg-full", kind: "prod-write", text: "disk is filling, needs a data purge", facts: facts({ prod: true, incident: true, dataWrite: true, reversible: true }) });
    expect(out).toContain("asked again until they act");
    expect(s.asked).toHaveLength(1);
    expect(s.asked[0]!.text).toContain("prod blocker");
  });

  test("an undecided prod blocker is asked again every re-ask span, each time a fresh message, the old one settled", async () => {
    const s = setup();
    await s.jueki.blocker({ key: "pg-full", kind: "prod-write", text: "purge needed", facts: facts({ prod: true, dataWrite: true }) });
    s.clock.t += 10 * MINUTE_MS;
    await s.jueki.tick();
    expect(s.asked).toHaveLength(1);
    s.clock.t += DEFAULT_PROD_REPING_MS;
    await s.jueki.tick();
    expect(s.asked).toHaveLength(2);
    expect(s.asked[1]!.text).toContain("asked 2 times");
    expect(s.settled).toHaveLength(1);
    expect(s.settled[0]!.text).toContain("asked again below");
    // Through the night too.
    s.clock.t = NIGHT;
    await s.jueki.tick();
    expect(s.asked).toHaveLength(3);
  });

  test("the turn calling again while it is not due is told to leave it", async () => {
    const s = setup();
    const f = facts({ prod: true, dataWrite: true });
    await s.jueki.blocker({ key: "k", kind: "prod-write", text: "x", facts: f });
    const again = await s.jueki.blocker({ key: "k", kind: "prod-write", text: "x", facts: f });
    expect(again).toContain("asked again on its own");
    expect(s.asked).toHaveLength(1);
  });

  test("once the owner decides, the re-asking stops", async () => {
    const s = setup();
    await s.jueki.blocker({ key: "k", kind: "prod-write", text: "x", facts: facts({ prod: true, dataWrite: true }) });
    s.repo.decide(1, "approved", NOON);
    s.clock.t += 2 * DEFAULT_PROD_REPING_MS;
    await s.jueki.tick();
    await settle();
    expect(s.asked).toHaveLength(1);
  });

  test("prod, urgent and low-risk: told to self-fix, nothing raised; fixed reports it in the digest and one direct DM line", async () => {
    const s = setup(NIGHT);
    const out = await s.jueki.blocker({ key: "cache-bust", kind: "prod-write", text: "stale cache serving wrong menu", facts: facts({ prod: true, customerImpact: true, reversible: true }) });
    expect(out).toContain("self-fix");
    expect(out).toContain("jueki fixed cache-bust");
    expect(s.asked).toHaveLength(0);
    expect(s.repo.blockerByKey("cache-bust")).toBeUndefined();

    await s.jueki.fixed("cache-bust", "flushed the menu cache, reversible");
    expect(s.repo.lines("2026-11-27").map((l) => l.text).join("\n")).toContain("prod fix by me");
    // The direct line goes out at night: a prod item was touched.
    const dm = s.posts.find((p) => p.text.includes("fixed a prod item myself"));
    expect(dm).toBeDefined();
    expect(dm).toMatchObject({ by: "Jueki" });
    expect(dm!.text).toContain("flushed the menu cache");
  });

  test("urgent but with a data write, or low-risk but not urgent, is never self-fixed", async () => {
    const s = setup();
    const risky = await s.jueki.blocker({ key: "a", kind: "prod-write", text: "x", facts: facts({ prod: true, incident: true, reversible: true, dataWrite: true }) });
    const calm = await s.jueki.blocker({ key: "b", kind: "prod-write", text: "y", facts: facts({ prod: true, reversible: true }) });
    expect(risky).not.toContain("self-fix");
    expect(calm).not.toContain("self-fix");
    expect(s.asked).toHaveLength(2);
  });
});

describe("act", () => {
  test("a line lands in the digest as plain text", async () => {
    const s = setup();
    await s.jueki.act("chased <@U123> on *PR #9*");
    expect(s.posts[0]!.text).toContain("chased U123 on PR #9");
    expect(s.posts[0]!.text).not.toContain("<@");
  });
});
