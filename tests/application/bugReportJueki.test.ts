import { describe, expect, test } from "bun:test";
import { dispatchCommand, listCommandInfo, type CommandDeps } from "../../src/application/commands.ts";
import { decideBugReportPress } from "../../src/application/bugReportApproval.ts";
import { BUG_APPROVE_ACTION, BUG_REJECT_ACTION } from "../../src/domain/bugReport.ts";
import { seededBook } from "../../src/domain/roleSeed.ts";
import { createBugReportRepo } from "../../src/infrastructure/db/bugReportRepo.ts";
import { OWNER, actor, build, db, slackCalls } from "./commandsFixture.ts";

const LINK = "https://acme.slack.com/archives/C1/p1700000000000100";
const THREAD = "1700000000.000100";
const REPORT = `bug-report --thread ${LINK} --issue "reply posted twice" --summary "the retry re-sent it" --plan "dedupe on message ts"`;

type Turn = { channelId: string; threadTs: string; slackUserId: string; text: string };

const setup = (withRunTurn = true) => {
  const base = build();
  const bugReports = createBugReportRepo(db);
  const turns: Turn[] = [];
  const acts: string[] = [];
  const deps: CommandDeps = {
    ...base,
    bugReports,
    clock: () => 1_000_000_000,
    roles: seededBook({ commands: listCommandInfo().map((c) => ({ name: c.name, minRole: c.minRole })) }),
    ...(withRunTurn ? { runTurn: async (req: Turn) => void turns.push(req) } : {}),
    jueki: { act: async (l: string) => void acts.push(l) } as unknown as CommandDeps["jueki"],
  };
  return { deps, bugReports, turns, acts };
};

const owner = actor();
const pal = actor({ slackId: "U0PAL000001", role: "pal" });
/** The brain's turn as the owner in the thread the report points at; `ownerMessage` is the ticket's owner bit. */
const inThread = (deps: CommandDeps, line: string, ownerMessage: boolean, who = owner) =>
  dispatchCommand(deps, who, "C1", line, {
    fromBrainRun: true,
    threadTs: THREAD,
    messageTs: "1700000000.000900",
    ...(ownerMessage ? { ownerTurn: { named: [] } } : {}),
  });
const settle = () => new Promise((r) => setTimeout(r, 5));

describe("bug-report: Jueki approves the owner's own ask", () => {
  test("the owner asked in that thread: approved by Jueki, the fix turn starts in the notice's thread as the owner, Reject is the one button", async () => {
    const { deps, bugReports, turns, acts } = setup();
    const out = await inThread(deps, `${REPORT} --owner-asked`, true);
    await settle();
    expect(out).toContain("approved by Jueki");
    expect(out).toContain("Do not fix it in this turn");
    expect(bugReports.get(1)).toMatchObject({ state: "approved", decidedBy: "jueki" });
    expect(slackCalls.buttons).toEqual(["jv:bug-report:reject:1"]);
    expect(slackCalls.posts[0]!.text).toContain("approved by Jueki: the owner asked for the fix in that thread");
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ channelId: OWNER, threadTs: "notice-1", slackUserId: OWNER });
    expect(turns[0]!.text.startsWith("Bug #1 is approved by Jueki")).toBe(true);
    expect(turns[0]!.text).toContain("dedupe on message ts");
    expect(acts[0]).toContain("bug #1 approved by me");
  });

  test("the same claim from a turn the owner's message did not start (a loop, a page it read) goes to the buttons", async () => {
    const { deps, bugReports, turns } = setup();
    const out = await inThread(deps, `${REPORT} --owner-asked`, false);
    expect(out).toContain("sent to the owner for approval");
    expect(bugReports.get(1)?.state).toBe("pending");
    expect(slackCalls.buttons).toEqual(["jv:bug-report:approve:1", "jv:bug-report:reject:1"]);
    expect(turns).toHaveLength(0);
  });

  test("the owner's message in another thread is not the ask for this one", async () => {
    const { deps, bugReports } = setup();
    const out = await dispatchCommand(deps, owner, "C1", `${REPORT} --owner-asked`, {
      fromBrainRun: true,
      threadTs: "1700000000.000777",
      ownerTurn: { named: [] },
    });
    expect(out).toContain("sent to the owner for approval");
    expect(bugReports.get(1)?.state).toBe("pending");
  });

  test("a non-owner's conversation never gets an approval, whatever its text and flags claim", async () => {
    const { deps, bugReports, turns } = setup();
    const out = await inThread(deps, `${REPORT} --owner-asked --reversible`, false, pal);
    expect(out).toContain("sent to the owner for approval");
    expect(bugReports.get(1)?.state).toBe("pending");
    expect(slackCalls.buttons).toContain("jv:bug-report:approve:1");
    expect(turns).toHaveLength(0);
    // even a pal turn that somehow carried the ticket's owner bit is not the owner
    const again = await inThread(deps, `${REPORT.replace("reply posted twice", "another one")} --owner-asked --reversible`, true, pal);
    expect(again).toContain("sent to the owner for approval");
    expect(turns).toHaveLength(0);
  });
});

describe("bug-report: Jueki approves a low-risk own-source fix", () => {
  test("stated reversible from the owner's own conversation: approved", async () => {
    const { deps, bugReports, turns } = setup();
    const out = await inThread(deps, `${REPORT} --reversible`, false);
    await settle();
    expect(out).toContain("approved by Jueki");
    expect(bugReports.get(1)?.decidedBy).toBe("jueki");
    expect(slackCalls.posts[0]!.text).toContain("low-risk fix in my own source");
    expect(turns).toHaveLength(1);
  });

  test("nothing stated, a stated risk, or a sensitive word in the report: the owner's buttons", async () => {
    const { deps, bugReports, turns } = setup();
    expect(await inThread(deps, REPORT, false)).toContain("sent to the owner");
    expect(await inThread(deps, `${REPORT.replace("reply posted twice", "b")} --reversible --data-write`, false)).toContain("sent to the owner");
    expect(await inThread(deps, `${REPORT.replace("reply posted twice", "c").replace("dedupe on message ts", "change the token refresh")} --reversible`, false)).toContain("sent to the owner");
    expect(bugReports.byState("pending", 10)).toHaveLength(3);
    expect(turns).toHaveLength(0);
  });

  test("with no way to start the fix turn nothing is approved: the owner's buttons", async () => {
    const { deps, bugReports } = setup(false);
    expect(await inThread(deps, `${REPORT} --owner-asked --reversible`, true)).toContain("sent to the owner");
    expect(bugReports.get(1)?.state).toBe("pending");
  });
});

describe("the owner's Reject on what Jueki approved", () => {
  const press = (over: Partial<Parameters<typeof decideBugReportPress>[1]> = {}) => ({
    slackUserId: OWNER,
    actionId: BUG_REJECT_ACTION,
    value: "1",
    channel: OWNER,
    messageTs: "notice-1",
    ...over,
  });

  test("stops it: rejected, the notice settled, and the fix turn is told to stop", async () => {
    const { deps, bugReports } = setup();
    await inThread(deps, `${REPORT} --owner-asked`, true);
    const approval = { bugReports, slack: deps.slack, clock: () => 2_000_000_000, ownerSlackId: OWNER };
    const out = await decideBugReportPress(approval, press());
    expect(out).toMatchObject({ kind: "rejected", id: 1, stop: { channel: OWNER, threadTs: "notice-1" } });
    if (out.kind !== "rejected" || !out.stop) throw new Error("not stopped");
    expect(out.stop.brief).toContain("approved by Jueki and the owner then rejected it");
    expect(bugReports.get(1)).toMatchObject({ state: "rejected", decidedBy: "" });
    expect(slackCalls.settled[0]!.text).toContain("rejected by");
    // a second press changes nothing
    expect(await decideBugReportPress(approval, press())).toMatchObject({ kind: "decided", state: "rejected" });
  });

  test("a non-owner's press on it is refused, and an Approve on it changes nothing", async () => {
    const { deps, bugReports } = setup();
    await inThread(deps, `${REPORT} --owner-asked`, true);
    const approval = { bugReports, slack: deps.slack, clock: () => 2_000_000_000, ownerSlackId: OWNER };
    expect(await decideBugReportPress(approval, press({ slackUserId: "U0PAL000001" }))).toMatchObject({ kind: "refused", why: "not-owner" });
    expect(await decideBugReportPress(approval, press({ actionId: BUG_APPROVE_ACTION }))).toMatchObject({ kind: "decided", state: "approved" });
    expect(bugReports.get(1)?.state).toBe("approved");
  });

  test("an approval the owner gave with the button is final: Reject afterwards changes nothing", async () => {
    const { deps, bugReports } = setup();
    await inThread(deps, REPORT, false);
    const approval = { bugReports, slack: deps.slack, clock: () => 2_000_000_000, ownerSlackId: OWNER };
    expect(await decideBugReportPress(approval, press({ actionId: BUG_APPROVE_ACTION }))).toMatchObject({ kind: "approved" });
    expect(await decideBugReportPress(approval, press())).toMatchObject({ kind: "decided", state: "approved" });
  });
});
