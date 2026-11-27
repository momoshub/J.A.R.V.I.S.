import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { decideCoordinatorPress, coordinatorPressNotice, type CoordinatorApprovalDeps } from "../../src/application/coordinatorApproval.ts";
import { COORDINATOR_APPROVE_ACTION, COORDINATOR_REJECT_ACTION } from "../../src/domain/coordinator.ts";
import { createCoordinatorRepo } from "../../src/infrastructure/db/coordinatorRepo.ts";
import { migrate } from "../../src/infrastructure/db/schema.ts";

const OWNER = "U0OWNER0001";

const setup = () => {
  const db = new Database(":memory:");
  migrate(db);
  const repo = createCoordinatorRepo(db);
  const b = repo.openBlocker({ key: "k", kind: "prod-write", prod: true, text: "purge the table" }, 1);
  repo.setNotice(b.id, "D1", "5.5");
  const settled: { text: string; by?: string }[] = [];
  let approved = 0;
  const deps: CoordinatorApprovalDeps = {
    repo,
    slack: { settleInteractive: async (_c, _t, text, by) => void settled.push({ text, by }) },
    clock: () => 77,
    ownerSlackId: OWNER,
    name: "Aide",
    onApproved: () => void approved++,
  };
  const press = (over: Partial<Parameters<typeof decideCoordinatorPress>[1]> = {}) =>
    decideCoordinatorPress(deps, { slackUserId: OWNER, actionId: COORDINATOR_APPROVE_ACTION, value: String(b.id), channel: "D1", messageTs: "5.5", ...over });
  return { repo, id: b.id, settled, press, approved: () => approved };
};

describe("decideCoordinatorPress", () => {
  test("the owner's approve on the latest notice is stored, settled under the configured name, and tells the tick", async () => {
    const s = setup();
    expect(await s.press()).toEqual({ kind: "approved", id: s.id });
    expect(s.repo.blocker(s.id)).toMatchObject({ state: "approved", decidedAt: 77 });
    expect(s.settled).toHaveLength(1);
    expect(s.settled[0]).toMatchObject({ by: "Aide" });
    expect(s.settled[0]!.text).toContain("*Aide* - blocker");
    expect(s.settled[0]!.text).toContain("Approved by <@U0OWNER0001>");
    expect(s.approved()).toBe(1);
  });

  test("a press on a button posted before the rename still decides the blocker", async () => {
    const approve = setup();
    expect(await approve.press({ actionId: "jv:jueki:approve" })).toEqual({ kind: "approved", id: approve.id });
    expect(approve.repo.blocker(approve.id)?.state).toBe("approved");
    expect(approve.approved()).toBe(1);
    const reject = setup();
    expect(await reject.press({ actionId: "jv:jueki:reject" })).toEqual({ kind: "rejected", id: reject.id });
    expect(reject.approved()).toBe(0);
  });

  test("reject is stored and does not wake the tick", async () => {
    const s = setup();
    expect(await s.press({ actionId: COORDINATOR_REJECT_ACTION })).toEqual({ kind: "rejected", id: s.id });
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
    const second = await s.press({ actionId: COORDINATOR_REJECT_ACTION });
    expect(second).toEqual({ kind: "decided", id: s.id, state: "approved" });
    expect(coordinatorPressNotice(second)).toContain("already approved");
    expect(s.approved()).toBe(1);
  });

  test("notices: refusals are explained, a decision needs none", () => {
    expect(coordinatorPressNotice({ kind: "refused", why: "not-owner", id: 1 })).toContain("Only the owner");
    expect(coordinatorPressNotice({ kind: "refused", why: "wrong-message", id: 1 })).toContain("latest message");
    expect(coordinatorPressNotice({ kind: "approved", id: 1 })).toBeUndefined();
  });
});
