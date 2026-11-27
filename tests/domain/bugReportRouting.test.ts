import { describe, expect, test } from "bun:test";
import {
  approvedByCoordinatorBrief,
  approvedByCoordinatorText,
  linkIsThread,
  parseReport,
  routeBugReport,
  stoppedBrief,
  type BugClaims,
  type BugFiling,
  type BugReportInput,
  type BugRisk,
} from "../../src/domain/bugReport.ts";

const LINK = "https://acme.slack.com/archives/C1/p1700000000000100";
const input = (over: Partial<BugReportInput> = {}): BugReportInput => ({
  thread: LINK,
  issue: "reply posted twice",
  summary: "the retry re-sent it",
  plan: "dedupe on message ts",
  ...over,
});
const risk = (over: Partial<BugRisk> = {}): BugRisk => ({
  reversible: false, dataWrite: false, schemaChange: false, secretOrIam: false, touchesAccess: false, prod: false, ...over,
});
const claims = (over: Partial<BugClaims> = {}, r: Partial<BugRisk> = {}): BugClaims => ({ ownerAsked: false, risk: risk(r), ...over });
const filing = (over: Partial<BugFiling> = {}): BugFiling => ({ fromOwner: true, ownerTurn: true, sameThread: true, ...over });

describe("parseReport: the claims a report states", () => {
  const base = `--thread ${LINK} --issue "x" --plan "y"`;
  test("a fact not stated is false, silence is never low-risk", () => {
    const r = parseReport(base);
    expect(r.ok && r.claims).toEqual({ ownerAsked: false, risk: risk() });
  });

  test("bare flags state facts, in any order beside the valued ones", () => {
    const r = parseReport(`--reversible ${base} --owner-asked --data-write`);
    expect(r.ok && r.claims).toEqual({ ownerAsked: true, risk: risk({ reversible: true, dataWrite: true }) });
  });

  test("an unknown flag is still refused", () => {
    expect(parseReport(`${base} --approved`)).toEqual({ ok: false, error: "I do not know `--approved`" });
  });
});

describe("routeBugReport: the coordinator decides the small ones, in code", () => {
  test("the owner asked for the fix in this very thread: approved", () => {
    expect(routeBugReport(input(), claims({ ownerAsked: true }), filing())).toMatchObject({ route: "approve" });
  });

  test("the owner's ask is approved even for a sensitive fix: he asked", () => {
    const i = input({ plan: "change the role check" });
    expect(routeBugReport(i, claims({ ownerAsked: true }), filing())).toMatchObject({ route: "approve" });
  });

  test("an --owner-asked claim with no owner message behind it (the ticket's owner bit) is only a claim: the owner's buttons", () => {
    expect(routeBugReport(input(), claims({ ownerAsked: true }), filing({ ownerTurn: false }))).toMatchObject({ route: "ask" });
  });

  test("an owner message in a different thread than the report's is not the ask for this one", () => {
    expect(routeBugReport(input(), claims({ ownerAsked: true }), filing({ sameThread: false }))).toMatchObject({ route: "ask" });
  });

  test("everything filed from someone else's conversation goes to the buttons, whatever it claims", () => {
    const f = filing({ fromOwner: false, ownerTurn: false });
    expect(routeBugReport(input(), claims({ ownerAsked: true }, { reversible: true }), f)).toMatchObject({ route: "ask" });
    expect(routeBugReport(input(), claims({}, { reversible: true }), f)).toMatchObject({ route: "ask" });
  });

  test("a low-risk fix to my own source, from the owner's conversation, is approved", () => {
    expect(routeBugReport(input(), claims({}, { reversible: true }), filing({ ownerTurn: false, sameThread: false }))).toMatchObject({ route: "approve" });
  });

  test("not stated reversible: the buttons", () => {
    expect(routeBugReport(input(), claims(), filing())).toMatchObject({ route: "ask" });
  });

  test("any stated risk fact turns a low-risk claim into the buttons", () => {
    for (const r of [{ dataWrite: true }, { schemaChange: true }, { secretOrIam: true }, { touchesAccess: true }, { prod: true }]) {
      expect(routeBugReport(input(), claims({}, { reversible: true, ...r }), filing())).toMatchObject({ route: "ask" });
    }
  });

  test("a stated-low-risk report whose own words name roles, permissions, auth, tickets, tokens, secrets, approvals or prod is not low-risk", () => {
    for (const t of ["the role check", "permissions", "auth flow", "worker ticket", "a token", "the secret", "approval code", "prod data"]) {
      const i = input({ plan: `fix ${t}` });
      expect(routeBugReport(i, claims({}, { reversible: true }), filing())).toMatchObject({ route: "ask" });
    }
  });
});

describe("linkIsThread", () => {
  test("a link to the thread this turn runs in, by thread_ts or as the thread's own first message", () => {
    expect(linkIsThread(`${LINK}?thread_ts=1700000000.000100&cid=C1`, "C1", "1700000000.000100", "1700000000.000500")).toBe(true);
    expect(linkIsThread(LINK, "C1", "1700000000.000100", undefined)).toBe(true);
    expect(linkIsThread(LINK, "C1", undefined, "1700000000.000100")).toBe(true);
  });

  test("another channel or another thread is not it", () => {
    expect(linkIsThread(LINK, "C2", "1700000000.000100", undefined)).toBe(false);
    expect(linkIsThread(LINK, "C1", "1700000000.000999", undefined)).toBe(false);
    expect(linkIsThread("not a link", "C1", "1700000000.000100", undefined)).toBe(false);
  });
});

describe("what the coordinator's approval says", () => {
  test("the notice names the coordinator and the reason and leaves Reject as the way to stop it", () => {
    const t = approvedByCoordinatorText("Boss", 4, input(), "the owner asked for the fix in that thread");
    expect(t).toContain("approved by Boss: the owner asked for the fix in that thread");
    expect(t).toContain("Press Reject to stop it");
  });

  test("the fix turn is told it is the owner's ask, and what to do if it is rejected", () => {
    const b = approvedByCoordinatorBrief(4, input(), "low-risk");
    expect(b.startsWith("Bug #4 is approved by the coordinator")).toBe(true);
    expect(b).toContain("dedupe on message ts");
    expect(stoppedBrief(4)).toContain("Bug #4 was approved by the coordinator and the owner then rejected it");
  });
});
