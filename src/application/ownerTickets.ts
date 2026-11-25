/**
 * One-turn tickets that say "the owner started this turn": the only thing that switches a spawn to the host's interactive login
 * and the claude.ai connectors (`claudeCli.ts`).
 *
 * Same shape as `slackTickets` and `commandTickets`, and deliberately a third store: this ticket names nobody and carries no
 * role. It cannot run a command, call Slack or act on GitHub; all it grants is connector access, which a child process of the
 * turn (the `mcp` code-mode CLI) redeems against the bot's own API. What decides who gets one is the bot's own record of who
 * sent the message (`ownerTicketWanted`), never anything the brain says: `ownMessage` comes from a person typing only
 * (`typedByActor` in `handleMessage`: the person's own tagged or DM message, or an untagged one in a followed thread that only they wrote; `ask`/`btw` when not `fromBrainRun`). That mint decision is the gate - the redeem
 * refuses a dead ticket, but the host login it unlocks sits in the keychain for any full-access process.
 *
 * A ticket belongs to ONE spawned process: minted when the turn starts, put in that process's environment, revoked when it
 * exits. The TTL is only the backstop for a revoke that
 * never ran. Tickets live in memory; a restart ends every turn anyway.
 */
import type { BillingContext, Clock } from "./ports.ts";

/** Longer than any turn the bot allows, like the Slack ticket. */
export const OWNER_TICKET_TTL_MS = 3 * 60 * 60_000;

/** The owner's own message (or command) started this run. `ownMessage` is set by the bot from the inbound event, not by a prompt. */
export const ownerTicketWanted = (bill: BillingContext | undefined, ownerSlackId: string): boolean =>
  !!ownerSlackId && bill?.ownMessage === true && bill.actor === ownerSlackId;

export type OwnerTicketRefusal = "unknown" | "expired";

export type OwnerTicketResult = { readonly ok: true } | { readonly ok: false; readonly reason: OwnerTicketRefusal };

export type OwnerTickets = {
  issue: () => string;
  /** Is it live? Redeeming spends nothing: a turn may ask as often as it calls tools. */
  redeem: (token: string) => OwnerTicketResult;
  /** End it now; a ticket that is already gone is fine. */
  revoke: (token: string) => void;
};

export const createOwnerTickets = (clock: Clock, newToken: () => string = () => `jvow_${crypto.randomUUID().replaceAll("-", "")}`): OwnerTickets => {
  const live = new Map<string, number>();

  const sweep = (now: number): void => {
    for (const [token, expiresAt] of live) if (expiresAt <= now) live.delete(token);
  };

  return {
    issue: () => {
      const now = clock();
      sweep(now);
      const token = newToken();
      live.set(token, now + OWNER_TICKET_TTL_MS);
      return token;
    },
    redeem: (token) => {
      const expiresAt = live.get(token);
      if (expiresAt === undefined) return { ok: false, reason: "unknown" };
      if (expiresAt <= clock()) {
        live.delete(token);
        return { ok: false, reason: "expired" };
      }
      return { ok: true };
    },
    revoke: (token) => void live.delete(token),
  };
};
