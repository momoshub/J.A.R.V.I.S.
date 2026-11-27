import { describe, expect, test } from "bun:test";
import { dispatchCommand, listCommandInfo, type CommandDeps } from "../../src/application/commands.ts";
import { decideBugReportPress } from "../../src/application/bugReportApproval.ts";
import { BUG_REJECT_ACTION } from "../../src/domain/bugReport.ts";
import { createBugReportRepo } from "../../src/infrastructure/db/bugReportRepo.ts";
import { seededBook } from "../../src/domain/roleSeed.ts";
import { DEDUPE_MS, MAX_PER_DAY } from "../../src/domain/bugReport.ts";
import { OWNER, actor, build, db, slackCalls } from "./commandsFixture.ts";

const LINK = "https://acme.slack.com/archives/C1/p1700000000000100";
const REPORT = `bug-report --thread ${LINK} --issue "reply posted twice" --summary "the retry re-sent the message" --plan "dedupe on message ts"`;

const setup = () => {
  const base = build();
  const bugReports = createBugReportRepo(db);
  const clock = { t: 1_000_000_000 };
  const deps: CommandDeps = {
    ...base,
    bugReports,
    clock: () => clock.t,
    roles: seededBook({ commands: listCommandInfo().map((c) => ({ name: c.name, minRole: c.minRole })) }),
  };
  return { deps, bugReports, clock };
};

/** The brain's own turn, in a pal's thread unless said otherwise. */
const run = (deps: CommandDeps, line: string, who = actor({ slackId: "U0PAL000001", role: "pal" }), channel = "C1") =>
  dispatchCommand(deps, who, channel, line, { fromBrainRun: true });

describe("bug-report command", () => {
  test("DMs the owner the link, issue, cause and plan with Approve / Reject", async () => {
    const { deps, bugReports } = setup();
    const out = await run(deps, REPORT);
    expect(out).toContain("Bug #1 sent to the owner");
    expect(slackCalls.posts).toHaveLength(1);
    const post = slackCalls.posts[0]!;
    expect(post.channel).toBe(OWNER);
    expect(post.text).toContain(`<${LINK}|the thread>`);
    expect(post.text).toContain("reply posted twice");
    expect(post.text).toContain("the retry re-sent the message");
    expect(post.text).toContain("dedupe on message ts");
    expect(slackCalls.buttons).toEqual(["jv:bug-report:approve:1", "jv:bug-report:reject:1"]);
    expect(bugReports.get(1)).toMatchObject({ state: "pending", reportedIn: "C1", noticeChannel: OWNER, noticeTs: "notice-1" });
  });

  test("a typed line is refused for every role, the owner included, and sends nothing", async () => {
    const { deps, bugReports } = setup();
    for (const role of ["pal", "executer", "admin", "owner"] as const) {
      expect(await dispatchCommand(deps, actor({ slackId: `U-${role}`, role }), "C1", REPORT)).toContain("is internal");
    }
    expect(await dispatchCommand(deps, actor(), "C1", "bug-report approve 1")).toContain("is internal");
    expect(slackCalls.posts).toHaveLength(0);
    expect(bugReports.countSince(0)).toBe(0);
  });

  test("the same thread and issue is not sent twice within a day, but is again after it", async () => {
    const { deps, bugReports, clock } = setup();
    await run(deps, REPORT);
    const again = await run(deps, REPORT.replace("reply posted twice", "Reply  posted TWICE!"));
    expect(again).toContain("Already reported as bug #1");
    expect(slackCalls.posts).toHaveLength(1);
    // a different issue in the same thread is its own report
    await run(deps, REPORT.replace("reply posted twice", "wrong channel"));
    expect(slackCalls.posts).toHaveLength(2);
    clock.t += DEDUPE_MS + 1;
    await run(deps, REPORT);
    expect(slackCalls.posts).toHaveLength(3);
    expect(bugReports.countSince(0)).toBe(3);
  });

  test("a decided report still blocks a repeat inside the day", async () => {
    const { deps } = setup();
    await run(deps, REPORT);
    deps.bugReports!.decide(1, "rejected", 1);
    expect(await run(deps, REPORT)).toContain("Already reported as bug #1 (rejected)");
    expect(slackCalls.posts).toHaveLength(1);
  });

  test("past the daily cap the owner is not asked any more", async () => {
    const { deps } = setup();
    for (let i = 0; i < MAX_PER_DAY; i++) await run(deps, REPORT.replace("reply posted twice", `issue ${i}`));
    expect(slackCalls.posts).toHaveLength(MAX_PER_DAY);
    expect(await run(deps, REPORT.replace("reply posted twice", "one more"))).toContain("most bug reports");
    expect(slackCalls.posts).toHaveLength(MAX_PER_DAY);
  });

  test("needs a Slack link, an issue and a plan, and reads nothing else", async () => {
    const { deps, bugReports } = setup();
    expect(await run(deps, `bug-report --thread https://example.com/x --issue a --plan b`)).toContain("Slack link");
    expect(await run(deps, `bug-report --thread ${LINK} --plan b`)).toContain("`--issue`");
    expect(await run(deps, `bug-report --thread ${LINK} --issue a`)).toContain("`--plan`");
    expect(await run(deps, `bug-report --thread ${LINK} --issue a --plan b --bogus 1`)).toContain("do not know `--bogus`");
    expect(await run(deps, `bug-report --thread ${LINK} --issue a --plan`)).toContain("needs a value");
    expect(slackCalls.posts).toHaveLength(0);
    expect(bugReports.countSince(0)).toBe(0);
  });

  test("free text cannot mention or link: it is cleaned like a journey title", async () => {
    const { deps } = setup();
    await run(deps, `bug-report --thread <${LINK}|link> --issue "<!channel> broke <@U123>" --plan "fix it"`);
    const text = slackCalls.posts[0]!.text;
    expect(text).not.toContain("<!channel>");
    expect(text).not.toContain("<@U123>");
  });

  test("a DM that cannot go out leaves no record, so a retry is not called a repeat", async () => {
    const { deps, bugReports } = setup();
    const broken = { ...deps, slack: { ...deps.slack!, postDmInteractive: async () => { throw new Error("slack down"); } } };
    expect(await run(broken, REPORT)).toContain("could not DM the owner");
    expect(bugReports.countSince(0)).toBe(0);
    expect(await run(deps, REPORT)).toContain("sent to the owner");
  });
});

describe("bug-report approve / reject from a turn", () => {
  test("a turn the owner's message did not start cannot approve or reject, even as the owner", async () => {
    const { deps, bugReports } = setup();
    await run(deps, REPORT);
    for (const line of ["bug-report approve 1", "bug-report reject 1", "bug-report APPROVE 1"]) {
      expect(await run(deps, line, actor(), OWNER)).toContain("This turn is neither");
    }
    expect(bugReports.get(1)?.state).toBe("pending");
    expect(slackCalls.settled).toHaveLength(0);
  });

  test("nobody else's brain run can decide it either, owner bit or not", async () => {
    const { deps, bugReports } = setup();
    await run(deps, REPORT);
    for (const role of ["pal", "executer", "admin"] as const) {
      const who = actor({ slackId: `U-${role}`, role });
      expect(await run(deps, "bug-report approve 1", who, OWNER)).toContain("This turn is neither");
      expect(await dispatchCommand(deps, who, "C1", "bug-report approve 1", { fromBrainRun: true, ownerTurn: { named: [] } })).toContain("This turn is neither");
    }
    expect(bugReports.get(1)?.state).toBe("pending");
  });

  const ownerRun = (deps: CommandDeps, line: string, threadTs: string, turns?: unknown[]) =>
    dispatchCommand({ ...deps, ...(turns ? { runTurn: async (r: unknown) => void turns.push(r) } : {}) }, actor(), "C9", line, {
      fromBrainRun: true,
      threadTs,
      messageTs: threadTs,
      ownerTurn: { named: [] },
    });

  test("the owner's own turn approves: audit DM with Reject, fix turn started like the press does, logged as the agent's", async () => {
    const { deps, bugReports } = setup();
    await run(deps, REPORT);
    slackCalls.posts.length = 0;
    slackCalls.buttons.length = 0;
    const turns: { channelId: string; threadTs: string; slackUserId: string; text: string; unprompted?: boolean }[] = [];
    const out = await ownerRun(deps, "bug-report approve 1", "1800000000.000100", turns);
    expect(out).toContain("approved by me in the owner's own turn");
    expect(out).toContain("Do not fix it in this turn");
    expect(bugReports.get(1)).toMatchObject({ state: "approved", decidedBy: "agent" });
    const audit = slackCalls.posts.find((p) => p.channel === OWNER);
    expect(audit?.text).toContain("I approved it myself");
    expect(audit?.text).toContain("reply posted twice");
    expect(slackCalls.buttons).toEqual(["jv:bug-report:reject:1"]);
    // the old Approve / Reject notice is settled, and the audit line is the notice a Reject press is checked against
    expect(slackCalls.settled[0]?.text).toContain("approved by");
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ channelId: OWNER, slackUserId: OWNER, unprompted: true });
    expect(turns[0]?.text).toContain("approved by the agent");
    // the owner's Reject on the audit line stops it, as for the coordinator's approval
    const b = bugReports.get(1)!;
    const press = await decideBugReportPress(
      { bugReports, slack: deps.slack, clock: deps.clock, ownerSlackId: OWNER },
      { slackUserId: OWNER, actionId: BUG_REJECT_ACTION, value: "1", channel: b.noticeChannel, messageTs: b.noticeTs },
    );
    expect(press).toMatchObject({ kind: "rejected", id: 1 });
    expect(bugReports.get(1)?.state).toBe("rejected");
  });

  test("approving from the thread the bug is from does not start a second turn: this turn does the fix", async () => {
    const { deps, bugReports } = setup();
    await run(deps, REPORT);
    const turns: unknown[] = [];
    const out = await dispatchCommand({ ...deps, runTurn: async (r: unknown) => void turns.push(r) }, actor(), "C1", "bug-report approve 1", {
      fromBrainRun: true,
      threadTs: "1700000000.000100",
      messageTs: "1700000000.000900",
      ownerTurn: { named: [] },
    });
    expect(out).toContain("Do the fix in this turn");
    expect(turns).toHaveLength(0);
    expect(bugReports.get(1)).toMatchObject({ state: "approved", decidedBy: "agent" });
  });

  test("no way to DM the audit line means nothing is approved", async () => {
    const { deps, bugReports } = setup();
    await run(deps, REPORT);
    const mute = { ...deps, slack: { ...deps.slack!, postDmInteractive: undefined as never } };
    expect(await ownerRun(mute, "bug-report approve 1", "1800000000.000100")).toContain("did not approve");
    expect(bugReports.get(1)?.state).toBe("pending");
  });

  test("an unknown or already decided report changes nothing, and reject works in the owner's turn", async () => {
    const { deps, bugReports } = setup();
    await run(deps, REPORT);
    expect(await ownerRun(deps, "bug-report approve 7", "1800000000.000100")).toContain("no bug report");
    expect(await ownerRun(deps, "bug-report reject 1", "1800000000.000100")).toContain("rejected by me");
    expect(bugReports.get(1)?.state).toBe("rejected");
    expect(await ownerRun(deps, "bug-report approve 1", "1800000000.000100")).toContain("already rejected");
  });
});
