/**
 * The owner's Approve / Reject on a coordinator blocker, decided in code.
 *
 * Like the bug-report buttons: a press has its own Slack listener (the kit
 * listener skips `jv:coordinator:` and the legacy ids of buttons posted before the rename), never a model turn, because a turn that runs as
 * the owner in the owner's DM would pass every check a command could make and
 * the coordinator could approve its own blocker with nobody pressing. Only a press
 * carries `body.user.id` and the channel/ts of the message pressed, and only
 * the notice as it was LAST raised counts (a prod re-ask supersedes the old one).
 * An approval is not acted on here: it is stored, and the next tick hands it to
 * the turn (`approvedUnhandled`).
 */
import { coordinatorPressKind, settledBlockerText, type CoordinatorLang } from "../domain/coordinator.ts";
import type { CoordinatorBlocker, CoordinatorRepo } from "../infrastructure/db/coordinatorRepo.ts";
import { logAndIgnore } from "./ignoredError.ts";
import type { Clock } from "./ports.ts";
import type { SlackAdminPort } from "./slackAdmin.ts";

export type CoordinatorApprovalDeps = {
  repo: CoordinatorRepo;
  slack?: Pick<SlackAdminPort, "settleInteractive">;
  clock: Clock;
  ownerSlackId: string;
  /** The display name the settled message is signed with (`COORDINATOR_NAME`). */
  name: string;
  /** The language the blocker was asked in, so its settled text matches. Vietnamese when left out. */
  lang?: CoordinatorLang;
  /** Called once an approval is stored, to run the tick soon instead of at the next interval. */
  onApproved?: () => void;
};

export type CoordinatorPressOutcome =
  | { readonly kind: "unknown" }
  | { readonly kind: "refused"; readonly why: "not-owner" | "wrong-message"; readonly id: number }
  | { readonly kind: "decided"; readonly id: number; readonly state: CoordinatorBlocker["state"] }
  | { readonly kind: "approved"; readonly id: number }
  | { readonly kind: "rejected"; readonly id: number };

export const decideCoordinatorPress = async (
  deps: CoordinatorApprovalDeps,
  press: { slackUserId: string; actionId: string; value: string; channel?: string; messageTs?: string },
): Promise<CoordinatorPressOutcome> => {
  const pressed = coordinatorPressKind(press.actionId);
  if (!pressed) return { kind: "unknown" };
  const id = Number(press.value);
  const b = Number.isInteger(id) ? deps.repo.blocker(id) : undefined;
  if (!b) return { kind: "unknown" };
  if (press.slackUserId !== deps.ownerSlackId) return { kind: "refused", why: "not-owner", id: b.id };
  if (!b.noticeChannel || !b.noticeTs || press.channel !== b.noticeChannel || press.messageTs !== b.noticeTs) {
    return { kind: "refused", why: "wrong-message", id: b.id };
  }
  if (b.state !== "pending") return { kind: "decided", id: b.id, state: b.state };
  const verdict = pressed === "approve" ? "approved" : "rejected";
  if (!deps.repo.decide(b.id, verdict, deps.clock())) return { kind: "decided", id: b.id, state: b.state };
  await deps.slack
    ?.settleInteractive(b.noticeChannel, b.noticeTs, settledBlockerText(deps.name, b, verdict, press.slackUserId, deps.lang), deps.name)
    .catch(logAndIgnore("coordinator blocker settle"));
  if (verdict === "approved") deps.onApproved?.();
  return { kind: verdict, id: b.id };
};

/** What an owner who pressed the wrong thing is told, privately. */
export const coordinatorPressNotice = (o: CoordinatorPressOutcome): string | undefined =>
  o.kind === "refused"
    ? o.why === "not-owner"
      ? "Only the owner decides a coordinator blocker. Nothing changed."
      : `Blocker #${o.id} is decided on the latest message I asked it on. Nothing changed.`
    : o.kind === "decided"
      ? `Blocker #${o.id} is already ${o.state}. Nothing changed.`
      : undefined;
