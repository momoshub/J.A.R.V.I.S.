import { describe, expect, test } from "bun:test";
import { OWNER_TICKET_TTL_MS, createOwnerTickets, ownerTicketWanted } from "../../src/application/ownerTickets.ts";

describe("owner tickets", () => {
  test("a minted ticket redeems, as often as asked, and names nobody", () => {
    const tickets = createOwnerTickets(() => 0);
    const token = tickets.issue();
    expect(token).toMatch(/^jvow_[0-9a-f]{32}$/);
    expect(tickets.redeem(token)).toEqual({ ok: true });
    expect(tickets.redeem(token)).toEqual({ ok: true });
  });

  test("an unknown token is refused", () => {
    expect(createOwnerTickets(() => 0).redeem("jvow_nope")).toEqual({ ok: false, reason: "unknown" });
  });

  test("revoking ends it, and a second revoke is fine", () => {
    const tickets = createOwnerTickets(() => 0);
    const token = tickets.issue();
    tickets.revoke(token);
    tickets.revoke(token);
    expect(tickets.redeem(token)).toEqual({ ok: false, reason: "unknown" });
  });

  test("the TTL is the backstop for a revoke that never ran", () => {
    let now = 0;
    const tickets = createOwnerTickets(() => now);
    const token = tickets.issue();
    now = OWNER_TICKET_TTL_MS - 1;
    expect(tickets.redeem(token).ok).toBe(true);
    now = OWNER_TICKET_TTL_MS;
    expect(tickets.redeem(token)).toEqual({ ok: false, reason: "expired" });
    expect(tickets.redeem(token)).toEqual({ ok: false, reason: "unknown" });
  });

  test("tokens are not shared between tickets", () => {
    const tickets = createOwnerTickets(() => 0);
    const a = tickets.issue();
    const b = tickets.issue();
    expect(a).not.toBe(b);
    tickets.revoke(a);
    expect(tickets.redeem(b).ok).toBe(true);
  });
});

describe("ownerTicketWanted", () => {
  const bill = { actor: "UOWNER", kind: "chat", ownMessage: true as const };
  test("only the owner's own message earns one", () => {
    expect(ownerTicketWanted(bill, "UOWNER")).toBe(true);
  });
  test("another actor, a run over other people's text, no bill or no configured owner gets none", () => {
    expect(ownerTicketWanted({ ...bill, actor: "UOTHER" }, "UOWNER")).toBe(false);
    expect(ownerTicketWanted({ actor: "UOWNER", kind: "triage" }, "UOWNER")).toBe(false);
    expect(ownerTicketWanted(undefined, "UOWNER")).toBe(false);
    expect(ownerTicketWanted({ ...bill, actor: "" }, "")).toBe(false);
  });
});
