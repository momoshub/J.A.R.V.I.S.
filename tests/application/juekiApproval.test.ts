import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { decideJuekiPress, juekiPressNotice, type JuekiApprovalDeps } from "../../src/application/juekiApproval.ts";
import { JUEKI_APPROVE_ACTION, JUEKI_REJECT_ACTION } from "../../src/domain/jueki.ts";
import { createJuekiRepo } from "../../src/infrastructure/db/juekiRepo.ts";
import { migrate } from "../../src/infrastructure/db/schema.ts";

const OWNER = "U0OWNER0001";

const setup = () => {
  const db = new Database(":memory:");
  migrate(db);
  const repo = createJuekiRepo(db);
  const b = repo.openBlocker({ key: "k", kind: "prod-write", prod: true, text: "purge the table" }, 1);
  repo.setNotice(b.id, "D1", "5.5");
  const settled: { text: string; by?: string }[] = [];
  let approved = 0;
  const deps: JuekiApprovalDeps = {
    repo,
    slack: { settleInteractive: async (_c, _t, text, by) => void settled.push({ text, by }) },
    clock: () => 77,
    ownerSlackId: OWNER,
    onApproved: () => void approved++,
  };
  const press = (over: Partial<Parameters<typeof decideJuekiPress>[1]> = {}) =>
    decideJuekiPress(deps, { slackUserId: OWNER, actionId: JUEKI_APPROVE_ACTION, value: String(b.id), channel: "D1", messageTs: "5.5", ...over });
  return { repo, id: b.id, settled, press, deps, approved: () => approved };
};

describe("decideJuekiPress", () => {
  test("the owner's approve on the latest notice is stored, settled as Jueki, and tells the tick", async () => {
    const s = setup();
    expect(await s.press()).toEqual({ kind: "approved", id: s.id });
    expect(s.repo.blocker(s.id)).toMatchObject({ state: "approved", decidedAt: 77 });
    expect(s.settled).toHaveLength(1);
    expect(s.settled[0]).toMatchObject({ by: "Jueki" });
    expect(s.settled[0]!.text).toContain("Approved by <@U0OWNER0001>");
    expect(s.approved()).toBe(1);
  });

  test("reject is stored and does not wake the tick", async () => {
    const s = setup();
    expect(await s.press({ actionId: JUEKI_REJECT_ACTION })).toEqual({ kind: "rejected", id: s.id });
    expect(s.repo.blocker(s.id)?.state).toBe("rejected");
    expect(s.approved()).toBe(0);
  });

  test("anyone but the owner, a different message (an older ask), or a made-up id changes nothing", async () => {
    const s = setup();
    expect(await s.press({ slackUserId: "U0OTHER" })).toMatchObject({ kind: "refused", why: "not-owner" });
    expect(await s.press({ messageTs: "1.1" })).toMatchObject({ kind: "refused", why: "wrong-message" });
    expect(await s.press({ channel: "C9" })).toMatchObject({ kind: "refused", why: "wrong-message" });
    expect(await s.press({ value: "999" })).toEqual({ kind: "unknown" });
    expect(await s.press({ actionId: "jv:other:approve" })).toEqual({ kind: "unknown" });
    expect(s.repo.blocker(s.id)?.state).toBe("pending");
    expect(s.settled).toHaveLength(0);
  });

  test("the first decision wins; a second press is told so", async () => {
    const s = setup();
    await s.press();
    const second = await s.press({ actionId: JUEKI_REJECT_ACTION });
    expect(second).toEqual({ kind: "decided", id: s.id, state: "approved" });
    expect(juekiPressNotice(second)).toContain("already approved");
    expect(s.approved()).toBe(1);
  });

  test("notices: refusals are explained, a decision needs none", () => {
    expect(juekiPressNotice({ kind: "refused", why: "not-owner", id: 1 })).toContain("Only the owner");
    expect(juekiPressNotice({ kind: "refused", why: "wrong-message", id: 1 })).toContain("latest message");
    expect(juekiPressNotice({ kind: "approved", id: 1 })).toBeUndefined();
  });
});

describe("decideJuekiPress: a blocker about another person", () => {
  const subject = { forUser: "U0PAL000001", channelId: "C0TEST00001", threadTs: "1795000000.123456", permalink: "https://team.slack.com/archives/C0TEST00001/p1795000000123456", plan: "open the PR for them" };
  const setupUnblock = () => {
    const s = setup();
    const b = s.repo.openBlocker({ key: "unblock-1", kind: "unblock", prod: false, text: "needs write access", subject }, 1);
    s.repo.setNotice(b.id, "D1", "7.7");
    const press = (over: Partial<Parameters<typeof decideJuekiPress>[1]> = {}) =>
      decideJuekiPress(s.deps, { slackUserId: OWNER, actionId: JUEKI_APPROVE_ACTION, value: String(b.id), channel: "D1", messageTs: "7.7", ...over });
    return { ...s, ubId: b.id, press };
  };

  test("the owner's approve starts the work in the stuck person's thread, is settled with who decided, and is not left for a tick", async () => {
    const s = setupUnblock();
    const out = await s.press();
    expect(out).toMatchObject({ kind: "approved", id: s.ubId, unblock: { channelId: "C0TEST00001", threadTs: "1795000000.123456" } });
    if (out.kind !== "approved" || !out.unblock) throw new Error("no unblock");
    expect(out.unblock.brief).toContain("approved by the owner");
    expect(out.unblock.brief).toContain("<@U0PAL000001>");
    expect(out.unblock.brief).toContain("plan: open the PR for them");
    expect(s.repo.blocker(s.ubId)).toMatchObject({ state: "approved", handledAt: 77 });
    expect(s.repo.approvedUnhandled().map((b) => b.id)).not.toContain(s.ubId);
    expect(s.settled.at(-1)!.text).toContain("Approved by <@U0OWNER0001>: unblocking them");
    expect(s.approved()).toBe(0);
  });

  test("the owner's reject names their thread and a plain line telling them no, no turn", async () => {
    const s = setupUnblock();
    const out = await s.press({ actionId: JUEKI_REJECT_ACTION });
    expect(out).toMatchObject({ kind: "rejected", unblock: { channelId: "C0TEST00001", threadTs: "1795000000.123456" } });
    if (out.kind !== "rejected" || !out.unblock) throw new Error("no unblock");
    expect(out.unblock.notice).toContain("<@U0PAL000001>");
    expect(out.unblock.notice).toContain("said no");
    expect(s.repo.blocker(s.ubId)?.state).toBe("rejected");
    expect(s.settled.at(-1)!.text).toContain("Rejected by <@U0OWNER0001>: I tell them no");
  });

  test("only the owner, only on the notice as asked: anyone else or a made-up message starts nothing", async () => {
    const s = setupUnblock();
    expect(await s.press({ slackUserId: "U0PAL000001" })).toMatchObject({ kind: "refused", why: "not-owner" });
    expect(await s.press({ messageTs: "1.1" })).toMatchObject({ kind: "refused", why: "wrong-message" });
    expect(await s.press({ channel: "C0TEST00001", messageTs: "1795000000.123456" })).toMatchObject({ kind: "refused", why: "wrong-message" });
    expect(s.repo.blocker(s.ubId)?.state).toBe("pending");
  });

  test("a second press cannot start the thread's work again", async () => {
    const s = setupUnblock();
    await s.press();
    const again = await s.press();
    expect(again).toEqual({ kind: "decided", id: s.ubId, state: "approved" });
  });
});

