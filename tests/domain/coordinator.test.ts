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
  journeySubject,
  otherJourneyNote,
  parseUnblock,
  parseUserId,
  unblockApprovedBrief,
  unblockKey,
  unblockRejectedText,
  coordinatorTurnText,
  lapsedWorkerDispatch,
  localClock,
  localDay,
  mayFixProdItself,
  mayApproveItself,
  parseBlockerArgs,
  parseOwnPrs,
  prFindings,
  loginKey,
  rearmPlan,
  MAX_GRANT_CHILDREN,
  CHAIN_MAX_MS,
  REARM_DEADLINE_MS,
  renderDigest,
  routeBlocker,
  ticketAction,
  type BlockerFacts,
  type OwnPr,
  COORDINATOR_APPROVE_ACTION,
  COORDINATOR_REJECT_ACTION,
  coordinatorName,
  coordinatorPressKind,
  DEFAULT_COORDINATOR_NAME,
  isCoordinatorAction,
  addDayUsage,
  blockerText,
  digestFooter,
  selfFixDmText,
  settledBlockerText,
} from "../../src/domain/coordinator.ts";
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

  test("an App's PR is found however the login is written: gh prints app/<slug>, the API <slug>[bot]", () => {
    const json = JSON.stringify([
      { number: 1, title: "a", url: "https://github.com/o/r/pull/1", author: { login: "app/jarvis-at-momos" }, statusCheckRollup: [] },
      { number: 2, title: "b", url: "https://github.com/o/r/pull/2", author: { login: "kai-at-momos" }, statusCheckRollup: [] },
      { number: 3, title: "c", url: "https://github.com/o/r/pull/3", author: { login: "stranger" }, statusCheckRollup: [] },
    ]);
    expect(parseOwnPrs(json, ["jarvis-at-momos[bot]", "kai-at-momos"])?.map((p) => p.number)).toEqual([1, 2]);
    expect(parseOwnPrs(json, ["app/jarvis-at-momos"])?.map((p) => p.number)).toEqual([1]);
    expect(loginKey("App/Jarvis-At-Momos")).toBe("jarvis-at-momos");
    expect(loginKey("Jarvis-At-Momos[bot]")).toBe("jarvis-at-momos");
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

  test("a blocker the coordinator fixed itself is gone: the same key, raised again, starts from nothing", () => {
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

  test("prod, urgent and low-risk: the coordinator fixes it itself, quiet hours or not", () => {
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
    const text = renderDigest("Aide", "2026-11-27", [{ at: at(9, 5), text: "closed journey #4" }], 420, 2, "en");
    expect(text).toContain("*Aide* - housekeeping digest, 2026-11-27");
    expect(text).toContain("- 09:05 closed journey #4");
    expect(text).toContain("2 blockers waiting on you");
  });
  test("a long day folds its oldest lines into a count", () => {
    const lines = Array.from({ length: 45 }, (_, i) => ({ at: at(8) + i * MINUTE_MS, text: `line ${i}` }));
    const text = renderDigest("Aide", "2026-11-27", lines, 420, 0, "en");
    expect(text).toContain("5 earlier lines not shown");
    expect(text).toContain("line 44");
    expect(text).not.toContain("line 0\n");
  });
  test("the Vietnamese frame: title, folded count and waiting blockers, lines untouched", () => {
    const lines = Array.from({ length: 41 }, (_, i) => ({ at: at(8) + i * MINUTE_MS, text: `dòng ${i}` }));
    const text = renderDigest("Aide", "2026-11-27", lines, 420, 1);
    expect(text).toContain("*Aide* - bản tin dọn dẹp, 2026-11-27");
    expect(text).toContain("_1 dòng trước đó không hiển thị_");
    expect(text).toContain("_1 việc vướng đang chờ anh quyết, đã hỏi ở trên_");
    expect(text).toContain("- 08:40 dòng 40");
    expect(text).not.toContain("housekeeping");
    expect(renderDigest("Aide", "d", lines.slice(0, 1), 420, 0)).not.toContain("trước đó");
  });
  test("the footer is the last tick's usage line plus the day's total, nothing before a tick reported", () => {
    const u = { model: "claude-sonnet-5-5", inputTokens: 1000, outputTokens: 500, cacheReadTokens: 10_000, cacheWriteTokens: 500, costUsd: 0.25, durationMs: 62_000 };
    expect(digestFooter("Aide", undefined)).toBeUndefined();
    const day = addDayUsage(addDayUsage(undefined, u), { ...u, costUsd: 0.5 });
    expect(day).toMatchObject({ ticks: 2, costUsd: 0.75, tokens: 24_000 });
    expect(digestFooter("Aide", day)).toBe("claude-sonnet-5-5 · in 1k · out 500 · cache r 10k w 500 · $0.50 · 1m 2s · hôm nay 2 lượt · $0.75 · 24k token");
    expect(digestFooter("Aide", day, "en")).toContain("today 2 ticks · $0.75 · 24k tokens");
    expect(digestFooter("Aide", addDayUsage(undefined, u), "en")).toContain("today 1 tick ·");
  });
  test("blocker and fix texts follow the language", () => {
    const b = { id: 3, kind: "decision" as const, prod: true, text: "chọn cái nào" };
    expect(blockerText("Aide", b, 1)).toContain("🚨 vướng việc prod #3 (decision), đã hỏi 2 lần");
    expect(blockerText("Aide", b, 0, "en")).toContain("🚨 prod blocker #3 (decision)");
    expect(settledBlockerText("Aide", b, "approved", "U1")).toContain("Đã duyệt bởi <@U1>");
    expect(selfFixDmText("Aide", "k", "xong", "vi")).toContain("em vừa tự sửa");
  });
  test("the turn text asks for Vietnamese by default and keeps the style rules, English on request", () => {
    const vi = coordinatorTurnText("Aide", "d", false, emptyPicture, "//bot");
    expect(vi).toContain("in Vietnamese");
    expect(vi).toContain("no capital at the start of a line, no trailing dot, no em dashes");
    expect(vi).toContain("`//bot coordinator fixed <key>");
    const en = coordinatorTurnText("Aide", "d", false, emptyPicture, "//bot", "en");
    expect(en).toContain("in English");
    expect(en).not.toContain("Vietnamese");
  });
  test("the turn text names the configured name, the rules and only the sections that have items", () => {
    const text = coordinatorTurnText("Aide", "2026-11-27", false, { ...emptyPicture, staleJourneys: [{ ref: "journey #3", line: "quiet 4d" }] }, "//bot");
    expect(text).toContain("You are Aide");
    expect(text).toContain("//bot coordinator blocker");
    expect(text).toContain("//bot coordinator fixed");
    expect(text).toContain("Stale or finished-looking journeys:\n- journey #3: quiet 4d");
    expect(text).not.toContain("Own PRs with red CI");
    expect(text).toContain("never write to prod");
  });
  test("in quiet hours the turn is told not to message anyone", () => {
    expect(coordinatorTurnText("Aide", "d", true, emptyPicture, "//bot")).toContain("quiet hours");
  });
});

describe("the display name comes from config", () => {
  test("blank or missing falls back to the neutral default", () => {
    expect(DEFAULT_COORDINATOR_NAME).toBe("Coordinator");
    expect(coordinatorName(undefined)).toBe("Coordinator");
    expect(coordinatorName("  ")).toBe("Coordinator");
    expect(coordinatorName(" Aide ")).toBe("Aide");
  });
  test("every text the coordinator writes carries the name it was given", () => {
    const b = { id: 7, kind: "permission" as const, prod: false, text: "needs a grant" };
    expect(blockerText("Aide", b, 0, "en")).toStartWith("*Aide* - blocker #7");
    expect(settledBlockerText("Aide", b, "approved", "U1", "en")).toStartWith("*Aide* - blocker #7");
    expect(selfFixDmText("Aide", "k", "did it", "en")).toStartWith("*Aide* - fixed a prod item");
    expect(blockerText("Aide", b, 0)).toStartWith("*Aide* - vướng việc #7");
    expect(renderDigest("Coordinator", "2026-11-27", [], 420, 0, "en")).toStartWith("*Coordinator* - housekeeping digest");
  });
});

describe("button ids", () => {
  test("the current ids are recognised", () => {
    expect(COORDINATOR_APPROVE_ACTION).toBe("jv:coordinator:approve");
    expect(coordinatorPressKind(COORDINATOR_APPROVE_ACTION)).toBe("approve");
    expect(coordinatorPressKind(COORDINATOR_REJECT_ACTION)).toBe("reject");
    expect(isCoordinatorAction(COORDINATOR_REJECT_ACTION)).toBe(true);
  });
  test("ids posted before the rename still work, so a press on an old blocker message is not dead", () => {
    expect(isCoordinatorAction("jv:jueki:approve")).toBe(true);
    expect(coordinatorPressKind("jv:jueki:approve")).toBe("approve");
    expect(coordinatorPressKind("jv:jueki:reject")).toBe("reject");
  });
  test("anything else is not a coordinator press", () => {
    expect(isCoordinatorAction("jv:loop:approve")).toBe(false);
    expect(coordinatorPressKind("jv:coordinator:other")).toBeUndefined();
    expect(coordinatorPressKind("jv:jueki:other")).toBeUndefined();
  });
});

const LINK = "https://team.slack.com/archives/C0TEST00001/p1795000000123456";
const THREAD = { channelId: "C0TEST00001", threadTs: "1795000000.123456" };

describe("a blocker about another person", () => {
  test("`--for` and `--thread` together name who is stuck and where; the kind becomes unblock", () => {
    const r = parseBlockerArgs(["journey-87", "--for", "<@U0PAL000001>", "--thread", `<${LINK}|here>`, "needs", "a", "go-ahead"]);
    expect(r).toMatchObject({ ok: true, key: "journey-87", kind: "unblock", text: "needs a go-ahead" });
    if (r.ok) expect(r.subject).toEqual({ forUser: "U0PAL000001", ...THREAD, permalink: LINK, plan: "" });
  });

  test("one without the other, a bad user or a link that is not a Slack message is refused", () => {
    expect(parseBlockerArgs(["k", "--for", "U0PAL000001", "x"])).toMatchObject({ ok: false });
    expect(parseBlockerArgs(["k", "--thread", LINK, "x"])).toMatchObject({ ok: false });
    expect(parseBlockerArgs(["k", "--for", "bob", "--thread", LINK, "x"])).toMatchObject({ ok: false });
    expect(parseBlockerArgs(["k", "--for", "U0PAL000001", "--thread", "https://example.com/x", "x"])).toMatchObject({ ok: false });
  });

  test("`--kind unblock` without a subject is refused", () => {
    expect(parseBlockerArgs(["k", "--kind", "unblock", "x"])).toMatchObject({ ok: false });
  });

  test("a blocker with no subject is read as before", () => {
    const r = parseBlockerArgs(["k", "--kind", "decision", "x"]);
    expect(r).toMatchObject({ ok: true, kind: "decision" });
    if (r.ok) expect(r.subject).toBeUndefined();
  });

  test("parseUserId takes an id or a mention and nothing else", () => {
    expect(parseUserId("U0PAL000001")).toBe("U0PAL000001");
    expect(parseUserId("<@U0PAL000001>")).toBe("U0PAL000001");
    expect(parseUserId("<@U0PAL000001|bob>")).toBe("U0PAL000001");
    expect(parseUserId("coordinator")).toBeUndefined();
    expect(parseUserId("<!channel>")).toBeUndefined();
  });

  test("the owner's DM text says who is stuck, the plan, and what each button does", () => {
    const text = blockerText("Aide", { id: 4, kind: "unblock", prod: false, text: "needs write access to the repo", forUser: "U0PAL000001", permalink: LINK, plan: "open the PR for them" }, 0, "en");
    expect(text).toContain("<@U0PAL000001> is stuck: needs write access to the repo. Plan: open the PR for them.");
    expect(text).toContain("Approve = unblock them, I continue in their thread; Reject = I tell them no");
    expect(text).not.toContain("go ahead as you");
    // The owner's own wall keeps its words.
    expect(blockerText("Aide", { id: 5, kind: "decision", prod: false, text: "which one?" }, 0, "en")).toContain("Approve = go ahead as you");
  });

  test("in Vietnamese (the default) it reads the same way: who is stuck, the plan, what each button does, who decided", () => {
    const b = { id: 4, kind: "unblock" as const, prod: false, text: "needs access", forUser: "U0PAL000001", permalink: LINK, plan: "open the PR" };
    const ask = blockerText("Aide", b, 0);
    expect(ask).toContain("<@U0PAL000001> đang bị vướng: needs access. Kế hoạch: open the PR.");
    expect(ask).toContain("Duyệt = em gỡ vướng cho họ");
    expect(settledBlockerText("Aide", b, "rejected", "U0OWNER0001")).toContain("Đã từ chối bởi <@U0OWNER0001>");
  });

  test("the settled text says who decided", () => {
    const b = { id: 4, kind: "unblock" as const, prod: false, text: "needs access", forUser: "U0PAL000001" };
    expect(settledBlockerText("Aide", b, "approved", "U0OWNER0001", "en")).toContain("Approved by <@U0OWNER0001>: unblocking them");
    expect(settledBlockerText("Aide", b, "rejected", "U0OWNER0001", "en")).toContain("Rejected by <@U0OWNER0001>: I tell them no");
  });

  test("the approve brief names the owner's approval, the person, the need and the plan; the reject line is plain", () => {
    const brief = unblockApprovedBrief({ id: 4, forUser: "U0PAL000001", text: "needs access", plan: "open the PR" });
    expect(brief).toContain("Blocker #4 is approved by the owner");
    expect(brief).toContain("<@U0PAL000001>");
    expect(brief).toContain("need: needs access");
    expect(brief).toContain("plan: open the PR");
    expect(unblockApprovedBrief({ id: 4, forUser: "U0PAL000001", text: "x", plan: "" })).not.toContain("plan:");
    expect(unblockRejectedText({ forUser: "U0PAL000001", text: "needs access" })).toContain("<@U0PAL000001> the owner looked at this and said no");
  });
});

describe("parseUnblock and its dedupe key", () => {
  const line = `--thread ${LINK} --for U0PAL000001 --need "needs the staging grant" --plan "run the migration for them"`;

  test("reads the thread, person, need and plan, in any order", () => {
    const r = parseUnblock(line);
    expect(r).toMatchObject({ ok: true });
    if (r.ok) expect(r.input).toEqual({ need: "needs the staging grant", subject: { forUser: "U0PAL000001", ...THREAD, permalink: LINK, plan: "run the migration for them" } });
    expect(parseUnblock(`--need="x" --for=U0PAL000001 --thread=${LINK}`)).toMatchObject({ ok: true });
  });

  test("a thread reply link resolves to its root thread", () => {
    const r = parseUnblock(`--thread ${LINK}?thread_ts=1795000000.000001&cid=C0TEST00001 --for U0PAL000001 --need x`);
    if (r.ok) expect(r.input.subject.threadTs).toBe("1795000000.000001");
    else throw new Error(r.error);
  });

  test("the plan is optional; the need, the person and the thread are not", () => {
    expect(parseUnblock(`--thread ${LINK} --for U0PAL000001 --need x`)).toMatchObject({ ok: true });
    expect(parseUnblock(`--thread ${LINK} --for U0PAL000001`)).toMatchObject({ ok: false });
    expect(parseUnblock(`--thread ${LINK} --need x`)).toMatchObject({ ok: false });
    expect(parseUnblock(`--for U0PAL000001 --need x`)).toMatchObject({ ok: false });
    expect(parseUnblock(`--thread ${LINK} --for U0PAL000001 --need x --nope y`)).toMatchObject({ ok: false });
    expect(parseUnblock(`--thread ${LINK} --for U0PAL000001 --need`)).toMatchObject({ ok: false });
  });

  test("free text cannot fire a mention or a link", () => {
    const r = parseUnblock(`--thread ${LINK} --for U0PAL000001 --need "ping <!channel> and <@U0OTHER0003>"`);
    if (r.ok) expect(r.input.need).not.toMatch(/[<>]/);
    else throw new Error(r.error);
  });

  test("the same thread and need are one key whatever the case and punctuation; another thread or need is another", () => {
    const key = (need: string, link = LINK) => {
      const r = parseUnblock(`--thread ${link} --for U0PAL000001 --need "${need}"`);
      if (!r.ok) throw new Error(r.error);
      return unblockKey(r.input);
    };
    expect(key("Needs the staging grant!")).toBe(key("needs the  staging grant"));
    expect(key("needs the staging grant")).not.toBe(key("needs the prod grant"));
    expect(key("x", LINK)).not.toBe(key("x", "https://team.slack.com/archives/C0TEST00001/p1795000999000000"));
    expect(key("x").length).toBeLessThanOrEqual(80);
  });
});

describe("a journey somebody else asked for", () => {
  test("only a journey opened by a person other than the owner has a subject", () => {
    expect(journeySubject({ createdBy: "U0PAL000001", permalink: LINK }, "U0OWNER0001")).toEqual({ user: "U0PAL000001", link: LINK });
    expect(journeySubject({ createdBy: "U0OWNER0001", permalink: LINK }, "U0OWNER0001")).toBeUndefined();
    expect(journeySubject({ createdBy: "coordinator", permalink: LINK }, "U0OWNER0001")).toBeUndefined();
    expect(journeySubject({ createdBy: "", permalink: "" }, "U0OWNER0001")).toBeUndefined();
  });

  test("the note says it is not the owner's own and how to raise it for that person", () => {
    const note = otherJourneyNote({ user: "U0PAL000001", link: LINK }, "//bot");
    expect(note).toContain("NOT the owner's own");
    expect(note).toContain("--for U0PAL000001");
    expect(note).toContain(`--thread ${LINK}`);
    expect(otherJourneyNote({ user: "U0PAL000001", link: "" }, "//bot")).not.toContain("--thread");
  });

  test("the turn text tells the coordinator not to start or drop another person's journey as the owner", () => {
    const text = coordinatorTurnText("Aide", "2026-11-27", false, emptyPicture, "//bot");
    expect(text).toContain("NOT the owner's own");
    expect(text).toContain("--for <user> --thread <link>");
  });
});

describe("routeBlocker: the coordinator approves the small non-prod ones itself", () => {
  const NOW = 1_000 * HOUR_MS;
  const low = { reversible: true };
  const ask = { quiet: false, kind: "other" as const, text: "retry the failed lint step" };

  test("a non-prod, low-risk, in-role `other` blocker is approved by the coordinator, quiet hours or not", () => {
    expect(routeBlocker(facts(low), undefined, NOW, ask)).toEqual({ route: "approve" });
    expect(routeBlocker(facts(low), undefined, NOW, { ...ask, quiet: true })).toEqual({ route: "approve" });
  });

  test("silence is not low-risk: no --reversible, or any risky fact, goes to the owner", () => {
    expect(routeBlocker(facts(), undefined, NOW, ask)).toEqual({ route: "raise", repeat: false });
    for (const r of [{ dataWrite: true }, { schemaChange: true }, { secretOrIam: true }, { beyondRole: true }, { ownerDecision: true }]) {
      expect(routeBlocker(facts({ ...low, ...r }), undefined, NOW, ask)).toEqual({ route: "raise", repeat: false });
    }
  });

  test("only a plain `other` wall: a permission, prod-write, decision or repeat-failure one is the owner's", () => {
    for (const kind of ["permission", "prod-write", "decision", "repeat-failure"] as const) {
      expect(routeBlocker(facts(low), undefined, NOW, { ...ask, kind })).toEqual({ route: "raise", repeat: false });
    }
  });

  test("a sentence naming roles, permissions, auth, tickets, tokens, secrets, approvals or prod is not low-risk", () => {
    for (const text of ["needs a new role", "refresh the token", "touches the approval code", "reads prod data"]) {
      expect(mayApproveItself(facts(low), "other", text)).toBe(false);
      expect(routeBlocker(facts(low), undefined, NOW, { ...ask, text })).toEqual({ route: "raise", repeat: false });
    }
  });

  test("prod keeps today's rule: never approved here, however low-risk", () => {
    expect(routeBlocker(facts({ ...low, prod: true }), undefined, NOW, ask)).toEqual({ route: "raise", repeat: true });
  });

  test("a wall the owner was already asked about stays with the owner, and a decided one stays decided", () => {
    expect(routeBlocker(facts(low), { state: "pending", prod: false, lastRaisedAt: NOW - DAY_MS }, NOW, ask)).toEqual({ route: "hold", why: "already-raised" });
    expect(routeBlocker(facts(low), { state: "rejected", prod: false, lastRaisedAt: NOW - DAY_MS }, NOW, ask)).toEqual({ route: "hold", why: "decided" });
  });

  test("a caller that states no kind (the old call) never gets an approval", () => {
    expect(routeBlocker(facts(low), undefined, NOW, { quiet: false })).toEqual({ route: "raise", repeat: false });
  });
});

