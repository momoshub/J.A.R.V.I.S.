import { describe, expect, test } from "bun:test";
import {
  DEFAULT_PROD_REPING_MS,
  HOUR_MS,
  DAY_MS,
  MINUTE_MS,
  REVIEW_CHASE_MS,
  blockerDue,
  cleanKey,
  dispatchIdsOf,
  emptyPicture,
  inQuietHours,
  isLowRisk,
  isUrgent,
  journeyAction,
  juekiTurnText,
  lapsedWorkerDispatch,
  localClock,
  localDay,
  mayFixProdItself,
  parseBlockerArgs,
  parseOwnPrs,
  prFindings,
  rearmPlan,
  MAX_GRANT_CHILDREN,
  CHAIN_MAX_MS,
  REARM_DEADLINE_MS,
  renderDigest,
  routeBlocker,
  ticketAction,
  type BlockerFacts,
  type OwnPr,
} from "../../src/domain/jueki.ts";
import { WORKER_LIFETIME_MAX_MS } from "../../src/domain/workerTicket.ts";

/** 2026-11-27 00:00 in Asia/Ho_Chi_Minh (UTC+7) = 2026-11-26 17:00 UTC. */
const MIDNIGHT = Date.UTC(2026, 10, 26, 17, 0, 0);
const at = (hour: number, min = 0): number => MIDNIGHT + hour * HOUR_MS + min * MINUTE_MS;

const facts = (over: Partial<BlockerFacts> = {}): BlockerFacts => ({
  prod: false,
  incident: false,
  customerImpact: false,
  reversible: false,
  dataWrite: false,
  schemaChange: false,
  secretOrIam: false,
  beyondRole: false,
  ownerDecision: false,
  ...over,
});

describe("quiet hours (22:00-05:00 Asia/Ho_Chi_Minh)", () => {
  test("the window wraps midnight and is read on the owner's clock", () => {
    expect(inQuietHours(at(21, 59))).toBe(false);
    expect(inQuietHours(at(22, 0))).toBe(true);
    expect(inQuietHours(at(23, 30))).toBe(true);
    expect(inQuietHours(at(0, 0))).toBe(true);
    expect(inQuietHours(at(4, 59))).toBe(true);
    expect(inQuietHours(at(5, 0))).toBe(false);
    expect(inQuietHours(at(12, 0))).toBe(false);
  });

  test("the same instant is quiet in one zone and not in another", () => {
    // 15:00 UTC is 22:00 in UTC+7 and 15:00 in UTC.
    const now = Date.UTC(2026, 10, 27, 15, 0, 0);
    expect(inQuietHours(now, 420)).toBe(true);
    expect(inQuietHours(now, 0)).toBe(false);
  });

  test("a same-day window and equal hours", () => {
    expect(inQuietHours(at(13), 420, 12, 14)).toBe(true);
    expect(inQuietHours(at(15), 420, 12, 14)).toBe(false);
    expect(inQuietHours(at(3), 420, 7, 7)).toBe(false);
  });

  test("the owner's calendar day and clock", () => {
    expect(localDay(at(23, 59), 420)).toBe("2026-11-27");
    expect(localDay(at(24, 1), 420)).toBe("2026-11-28");
    expect(localClock(at(9, 5), 420)).toBe("09:05");
  });
});

describe("journeyAction", () => {
  const j = (over: Partial<Parameters<typeof journeyAction>[0]> = {}) => ({ id: 1, status: "doing" as const, progress: 40, updatedAt: 0, ...over });
  const NOW = 10 * DAY_MS;
  const STALE = 3 * DAY_MS;

  test("an open journey at 100% is closed, however recent", () => {
    expect(journeyAction(j({ progress: 100, updatedAt: NOW }), NOW, STALE)).toEqual({ kind: "close" });
    expect(journeyAction(j({ status: "blocked", progress: 100, updatedAt: NOW }), NOW, STALE)).toEqual({ kind: "close" });
  });

  test("an open journey quiet for the stale span is nudged, a fresh one is left", () => {
    expect(journeyAction(j({ updatedAt: NOW - 3 * DAY_MS }), NOW, STALE)).toEqual({ kind: "nudge", idleMs: 3 * DAY_MS });
    expect(journeyAction(j({ updatedAt: NOW - 3 * DAY_MS + 1 }), NOW, STALE)).toBeUndefined();
  });

  test("a done or dropped journey is never touched", () => {
    expect(journeyAction(j({ status: "done", progress: 100 }), NOW, STALE)).toBeUndefined();
    expect(journeyAction(j({ status: "dropped", updatedAt: 0 }), NOW, STALE)).toBeUndefined();
  });
});

describe("ticketAction", () => {
  const NOW = 100 * HOUR_MS;
  const t = (over: Partial<Parameters<typeof ticketAction>[0]> = {}) => ({ id: "aaaaaaaa", dispatchId: "ctx_w1", boundAt: NOW - HOUR_MS, expiresAt: NOW + 2 * HOUR_MS, ...over });

  test("a ticket with time left is left alone", () => {
    expect(ticketAction(t(), NOW, true)).toBeUndefined();
  });

  test("a ticket inside the renewal window, or already lapsed, is renewed while its worker is watched", () => {
    expect(ticketAction(t({ expiresAt: NOW + 30 * MINUTE_MS }), NOW, true)).toEqual({ kind: "renew", lapsed: false });
    expect(ticketAction(t({ expiresAt: NOW - 5 * MINUTE_MS }), NOW, true)).toEqual({ kind: "renew", lapsed: true });
  });

  test("nobody waiting on the worker, or no dispatch: nothing widens", () => {
    expect(ticketAction(t({ expiresAt: NOW - 1 }), NOW, false)).toBeUndefined();
    expect(ticketAction(t({ dispatchId: "", expiresAt: NOW - 1 }), NOW, true)).toBeUndefined();
  });

  test("past the absolute lifetime renewal cannot help: replace", () => {
    expect(ticketAction(t({ boundAt: NOW - WORKER_LIFETIME_MAX_MS, expiresAt: NOW + HOUR_MS }), NOW, true)).toEqual({ kind: "replace" });
  });
});

describe("ticketAction at the end of its life", () => {
  const NOW = 100 * HOUR_MS;
  test("a ticket whose expiry is already capped at its 24h life and about to lapse is replaced, not renewed again and again", () => {
    const boundAt = NOW - 23.5 * HOUR_MS;
    const capped = { id: "aaaaaaaa", dispatchId: "ctx_w1", boundAt, expiresAt: boundAt + WORKER_LIFETIME_MAX_MS };
    expect(ticketAction(capped, NOW, true)).toEqual({ kind: "replace" });
    // Not capped yet (renewal can still move it): renewed.
    expect(ticketAction({ ...capped, expiresAt: NOW + 20 * MINUTE_MS }, NOW, true)).toEqual({ kind: "renew", lapsed: false });
  });
});

describe("rearmPlan", () => {
  const NOW = 100 * DAY_MS;
  const grant = { createdBy: "U1", writeTargets: [{ channel: "C9" }] };
  test("a plain watch is armed again for the re-arm span, no grant", () => {
    expect(rearmPlan({ createdBy: "", writeTargets: [] }, NOW, NOW - 40 * DAY_MS, 0)).toEqual({ grant: false, deadlineAt: NOW + REARM_DEADLINE_MS });
  });
  test("a grant is carried inside the chain, and the deadline never passes the chain's end", () => {
    expect(rearmPlan(grant, NOW, NOW - DAY_MS, 0)).toEqual({ grant: true, deadlineAt: NOW + REARM_DEADLINE_MS });
    const root = NOW - CHAIN_MAX_MS + 3 * HOUR_MS;
    expect(rearmPlan(grant, NOW, root, 0)).toEqual({ grant: true, deadlineAt: root + CHAIN_MAX_MS });
  });
  test("past the 30 days counted from the FIRST watch, or with the children cap reached, the grant is dropped", () => {
    expect(rearmPlan(grant, NOW, NOW - CHAIN_MAX_MS, 0)).toEqual({ grant: false, deadlineAt: NOW + REARM_DEADLINE_MS });
    expect(rearmPlan(grant, NOW, NOW - CHAIN_MAX_MS + 30_000, 0).grant).toBe(false);
    expect(rearmPlan(grant, NOW, NOW - DAY_MS, MAX_GRANT_CHILDREN).grant).toBe(false);
    expect(rearmPlan(grant, NOW, NOW - DAY_MS, MAX_GRANT_CHILDREN - 1).grant).toBe(true);
  });
});

describe("lapsed watches", () => {
  const check = "bun /x/bin/orca-worker-wait.ts 'ctx_abc123' --every 30";
  test("the dispatch of a lapsed worker watch", () => {
    expect(dispatchIdsOf(check)).toEqual(["ctx_abc123"]);
    expect(lapsedWorkerDispatch({ id: 1, check, state: "expired" }, dispatchIdsOf(check))).toBe("ctx_abc123");
    expect(lapsedWorkerDispatch({ id: 1, check, state: "failed" }, dispatchIdsOf(check))).toBe("ctx_abc123");
  });
  test("a fired or cancelled watch is not lapsed, a shell watch names no worker", () => {
    expect(lapsedWorkerDispatch({ id: 1, check, state: "fired" }, dispatchIdsOf(check))).toBeUndefined();
    expect(lapsedWorkerDispatch({ id: 1, check, state: "cancelled" }, dispatchIdsOf(check))).toBeUndefined();
    expect(dispatchIdsOf("test -f /tmp/x")).toEqual([]);
  });
});

describe("own PRs", () => {
  const NOW = 50 * DAY_MS;
  const pr = (over: Partial<OwnPr> = {}): OwnPr => ({ number: 1, title: "t", url: "https://github.com/o/r/pull/1", draft: false, ci: "green", waitingOn: [], updatedAt: NOW, ...over });

  test("red CI and a reviewer waited on for a day are findings, drafts are not", () => {
    const out = prFindings(
      [
        pr({ number: 1, ci: "red" }),
        pr({ number: 2, waitingOn: ["sam"], updatedAt: NOW - REVIEW_CHASE_MS }),
        pr({ number: 3, waitingOn: ["sam"], updatedAt: NOW - HOUR_MS }),
        pr({ number: 4, draft: true, ci: "red" }),
        pr({ number: 5, ci: "red", waitingOn: ["sam"], updatedAt: 0 }),
      ],
      NOW,
    );
    expect(out.red.map((p) => p.number)).toEqual([1, 5]);
    expect(out.chase.map((p) => p.number)).toEqual([2]);
  });

  test("gh output is read into the bot's own PRs only, with CI and reviewers", () => {
    const json = JSON.stringify([
      {
        number: 7,
        title: "Fix `thing` <@U1>",
        url: "https://github.com/o/r/pull/7",
        isDraft: false,
        updatedAt: "2026-11-20T00:00:00Z",
        author: { login: "App[bot]" },
        statusCheckRollup: [{ name: "ci", status: "COMPLETED", conclusion: "FAILURE" }],
        reviewRequests: [{ login: "sam" }, { name: "team-x" }],
      },
      { number: 8, title: "other", url: "https://github.com/o/r/pull/8", author: { login: "someone" }, statusCheckRollup: [] },
    ]);
    const prs = parseOwnPrs(json, ["app[bot]"]);
    expect(prs).toHaveLength(1);
    expect(prs?.[0]).toMatchObject({ number: 7, ci: "red", waitingOn: ["sam", "team-x"], draft: false });
    expect(prs?.[0]?.title).not.toMatch(/[<>`]/);
    expect(parseOwnPrs(json, [])).toHaveLength(2);
    expect(parseOwnPrs("nope", [])).toBeUndefined();
  });
});

describe("what urgent and low-risk mean", () => {
  test("urgent: a live incident, customer impact, or a deadline within two hours", () => {
    expect(isUrgent(facts({ incident: true }))).toBe(true);
    expect(isUrgent(facts({ customerImpact: true }))).toBe(true);
    expect(isUrgent(facts({ deadlineMin: 120 }))).toBe(true);
    expect(isUrgent(facts({ deadlineMin: 0 }))).toBe(true);
    expect(isUrgent(facts({ deadlineMin: 121 }))).toBe(false);
    expect(isUrgent(facts())).toBe(false);
  });

  test("low-risk needs all four: reversible, no data write, no schema change, no secret or IAM", () => {
    expect(isLowRisk(facts({ reversible: true }))).toBe(true);
    expect(isLowRisk(facts())).toBe(false); // reversibility is a claim, silence is not low-risk
    expect(isLowRisk(facts({ reversible: true, dataWrite: true }))).toBe(false);
    expect(isLowRisk(facts({ reversible: true, schemaChange: true }))).toBe(false);
    expect(isLowRisk(facts({ reversible: true, secretOrIam: true }))).toBe(false);
  });

  test("a prod blocker is self-fixed only when urgent AND low-risk AND inside the owner's role", () => {
    const base = { prod: true, incident: true, reversible: true };
    expect(mayFixProdItself(facts(base))).toBe(true);
    expect(mayFixProdItself(facts({ ...base, incident: false }))).toBe(false); // low-risk but not urgent
    expect(mayFixProdItself(facts({ ...base, reversible: false }))).toBe(false); // urgent but not low-risk
    expect(mayFixProdItself(facts({ ...base, dataWrite: true }))).toBe(false);
    expect(mayFixProdItself(facts({ ...base, beyondRole: true }))).toBe(false);
    expect(mayFixProdItself(facts({ ...base, ownerDecision: true }))).toBe(false);
    expect(mayFixProdItself(facts({ ...base, prod: false }))).toBe(false);
  });
});

describe("routeBlocker", () => {
  const NOW = 1_000 * HOUR_MS;
  const open = { quiet: false };

  test("non-prod: raised once, never twice, even when asked again later", () => {
    expect(routeBlocker(facts(), undefined, NOW, open)).toEqual({ route: "raise", repeat: false });
    expect(routeBlocker(facts(), { state: "pending", prod: false, lastRaisedAt: NOW - DAY_MS }, NOW, open)).toEqual({ route: "hold", why: "already-raised" });
  });

  test("non-prod waits out quiet hours, then is raised", () => {
    expect(routeBlocker(facts(), undefined, NOW, { quiet: true })).toEqual({ route: "hold", why: "quiet-hours" });
    expect(routeBlocker(facts(), { state: "pending", prod: false, lastRaisedAt: 0 }, NOW, open)).toEqual({ route: "raise", repeat: false });
  });

  test("a non-prod blocker raised again as prod is asked at once under the prod rule, however recently it was asked", () => {
    const prior = { state: "pending" as const, prod: false, lastRaisedAt: NOW - MINUTE_MS };
    expect(routeBlocker(facts({ prod: true }), prior, NOW, { quiet: true })).toEqual({ route: "raise", repeat: true });
    expect(routeBlocker(facts({ prod: true }), { ...prior, prod: true }, NOW, { quiet: true })).toEqual({ route: "hold", why: "not-due" });
  });

  test("a blocker Jueki fixed itself is gone: the same key, raised again, starts from nothing", () => {
    expect(routeBlocker(facts(), { state: "fixed", prod: false, lastRaisedAt: NOW - HOUR_MS }, NOW, open)).toEqual({ route: "raise", repeat: false });
    expect(routeBlocker(facts({ prod: true }), { state: "fixed", prod: true, lastRaisedAt: NOW - 1 }, NOW, open)).toEqual({ route: "raise", repeat: true });
  });

  test("a decided blocker is never raised again, prod or not", () => {
    expect(routeBlocker(facts(), { state: "rejected", prod: false, lastRaisedAt: 1 }, NOW, open)).toEqual({ route: "hold", why: "decided" });
    expect(routeBlocker(facts({ prod: true }), { state: "approved", prod: true, lastRaisedAt: 1 }, NOW, open)).toEqual({ route: "hold", why: "decided" });
  });

  test("prod: always raised, repeated, and quiet hours do not hold it", () => {
    const prod = facts({ prod: true });
    expect(routeBlocker(prod, undefined, NOW, { quiet: true })).toEqual({ route: "raise", repeat: true });
    const prior = { state: "pending" as const, prod: true, lastRaisedAt: NOW - DEFAULT_PROD_REPING_MS };
    expect(routeBlocker(prod, prior, NOW, { quiet: true })).toEqual({ route: "raise", repeat: true });
    expect(routeBlocker(prod, { ...prior, lastRaisedAt: NOW - DEFAULT_PROD_REPING_MS + 1 }, NOW, open)).toEqual({ route: "hold", why: "not-due" });
    expect(routeBlocker(prod, { state: "pending", prod: true, lastRaisedAt: NOW - 10 * MINUTE_MS }, NOW, { quiet: false, repingMs: 5 * MINUTE_MS })).toEqual({ route: "raise", repeat: true });
  });

  test("prod, urgent and low-risk: Jueki fixes it itself, quiet hours or not", () => {
    const f = facts({ prod: true, customerImpact: true, reversible: true });
    expect(routeBlocker(f, undefined, NOW, open)).toEqual({ route: "self-fix" });
    expect(routeBlocker(f, undefined, NOW, { quiet: true })).toEqual({ route: "self-fix" });
  });

  test("prod, urgent but risky (data write) is raised to the owner, not self-fixed", () => {
    const f = facts({ prod: true, incident: true, reversible: true, dataWrite: true });
    expect(routeBlocker(f, undefined, NOW, open)).toEqual({ route: "raise", repeat: true });
  });

  test("prod, low-risk but not urgent is raised to the owner", () => {
    expect(routeBlocker(facts({ prod: true, reversible: true }), undefined, NOW, open)).toEqual({ route: "raise", repeat: true });
  });
});

describe("blockerDue", () => {
  const NOW = 1_000 * HOUR_MS;
  test("prod is due again after the re-ask span, quiet hours included", () => {
    expect(blockerDue({ prod: true, state: "pending", lastRaisedAt: 0 }, NOW, true)).toBe(true);
    expect(blockerDue({ prod: true, state: "pending", lastRaisedAt: NOW - 10 * MINUTE_MS }, NOW, false)).toBe(false);
    expect(blockerDue({ prod: true, state: "pending", lastRaisedAt: NOW - DEFAULT_PROD_REPING_MS }, NOW, true)).toBe(true);
  });
  test("non-prod is due only when never asked and not quiet; a decided one never", () => {
    expect(blockerDue({ prod: false, state: "pending", lastRaisedAt: 0 }, NOW, false)).toBe(true);
    expect(blockerDue({ prod: false, state: "pending", lastRaisedAt: 0 }, NOW, true)).toBe(false);
    expect(blockerDue({ prod: false, state: "pending", lastRaisedAt: 5 }, NOW, false)).toBe(false);
    expect(blockerDue({ prod: true, state: "approved", lastRaisedAt: 0 }, NOW, false)).toBe(false);
  });
});

describe("parseBlockerArgs", () => {
  test("reads the key, kind, facts and sentence; nothing unstated is claimed", () => {
    const r = parseBlockerArgs(["pg-restart", "--kind", "prod-write", "--prod", "--incident", "--deadline-min", "30", "restart", "the", "pod"]);
    expect(r).toMatchObject({ ok: true, key: "pg-restart", kind: "prod-write", text: "restart the pod" });
    if (r.ok) expect(r.facts).toMatchObject({ prod: true, incident: true, deadlineMin: 30, reversible: false, dataWrite: false });
  });
  test("refuses an unknown flag, a bad kind or minutes, and a missing key or sentence", () => {
    expect(parseBlockerArgs(["k", "--nope", "x"])).toMatchObject({ ok: false });
    expect(parseBlockerArgs(["k", "--kind", "weird", "x"])).toMatchObject({ ok: false });
    expect(parseBlockerArgs(["k", "--deadline-min", "soon", "x"])).toMatchObject({ ok: false });
    expect(parseBlockerArgs(["--prod"])).toMatchObject({ ok: false });
    expect(parseBlockerArgs(["k"])).toMatchObject({ ok: false });
  });
  test("a key is lowercase words", () => {
    expect(cleanKey("  Needs Prod ACCESS!! ")).toBe("needs-prod-access");
  });
});

describe("digest and turn text", () => {
  test("one message per day: header, time-stamped lines on the owner's clock, a waiting count", () => {
    const text = renderDigest("2026-11-27", [{ at: at(9, 5), text: "closed journey #4" }], 420, 2);
    expect(text).toContain("*Jueki* - housekeeping digest, 2026-11-27");
    expect(text).toContain("- 09:05 closed journey #4");
    expect(text).toContain("2 blockers waiting on you");
  });
  test("a long day folds its oldest lines into a count", () => {
    const lines = Array.from({ length: 45 }, (_, i) => ({ at: at(8) + i * MINUTE_MS, text: `line ${i}` }));
    const text = renderDigest("2026-11-27", lines, 420, 0);
    expect(text).toContain("5 earlier lines not shown");
    expect(text).toContain("line 44");
    expect(text).not.toContain("line 0\n");
  });
  test("the turn text names Jueki, the rules and only the sections that have items", () => {
    const text = juekiTurnText("2026-11-27", false, { ...emptyPicture, staleJourneys: [{ ref: "journey #3", line: "quiet 4d" }] }, "//bot");
    expect(text).toContain("You are Jueki");
    expect(text).toContain("//bot jueki blocker");
    expect(text).toContain("//bot jueki fixed");
    expect(text).toContain("Stale or finished-looking journeys:\n- journey #3: quiet 4d");
    expect(text).not.toContain("Own PRs with red CI");
    expect(text).toContain("never write to prod");
  });
  test("in quiet hours the turn is told not to message anyone", () => {
    expect(juekiTurnText("d", true, emptyPicture, "//bot")).toContain("quiet hours");
  });
});
