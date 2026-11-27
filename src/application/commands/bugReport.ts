/** `bug-report`: the bot tells its owner about a bug in itself. See domain/bugReport.ts. */

import {
  BUG_APPROVE_ACTION,
  BUG_REJECT_ACTION,
  DEDUPE_MS,
  MAX_PER_DAY,
  approvalText,
  approvedByJuekiBrief,
  approvedByJuekiText,
  fingerprintOf,
  linkIsThread,
  parseReport,
  routeBugReport,
} from "../../domain/bugReport.ts";
import { SIGNATURES } from "../../domain/messageFooter.ts";
import { logAndIgnore } from "../ignoredError.ts";
import { type CommandDef } from "./shared.ts";

export const BUG_REPORT_COMMANDS: readonly CommandDef[] = [
  {
    name: "bug-report",
    // Mine alone: refused unless the brain runs it in its own turn, so no role or grant is involved.
    internal: true,
    minRole: "pal",
    usage:
      '--thread <slack link> --issue "<what is wrong>" --summary "<the cause>" --plan "<how to fix>" [--owner-asked] [--reversible] [--data-write] [--schema-change] [--secret-iam] [--touches-access] [--prod]',
    summary: "tell the owner about a bug in myself; Jueki approves the small ones, the rest wait for the owner's button",
    run: async ({ deps, actor, channelId, threadTs, messageTs, ownerTurn, rest, prefix }) => {
      const repo = deps.bugReports;
      if (!repo) return "I have nowhere to keep bug reports right now.";
      const now = deps.clock();
      const word = rest.trim().split(/\s+/)[0]?.toLowerCase() ?? "";

      // Approve / Reject are the owner's button presses, decided in code (application/bugReportApproval.ts):
      // a command run in a turn cannot tell a press from an owner turn in the same DM, so it refuses both.
      if (word === "approve" || word === "reject") {
        return "A bug report is approved or rejected only by the owner pressing the button on the DM I sent. Nothing changed.";
      }

      const read = parseReport(rest);
      if (!read.ok) return `${read.error}. \`${prefix} bug-report --thread <link> --issue "..." --summary "..." --plan "..."\``;
      const input = read.input;
      const claims = read.claims;
      const fingerprint = fingerprintOf(input);
      const since = now - DEDUPE_MS;
      const twin = repo.recent(fingerprint, since);
      if (twin) return `Already reported as bug #${twin.id} (${twin.state}): the owner is not asked twice. Tell the person the owner was asked.`;
      if (repo.countSince(since) >= MAX_PER_DAY) return "I have already sent the owner the most bug reports I send in a day, so this one was not sent.";
      if (!deps.slack?.postDmInteractive) return "I cannot DM the owner from here, so the bug report was not sent.";

      // Jueki decides the small ones, in code (domain/bugReport.ts `routeBugReport`): the owner's own ask in this very thread,
      // read from the turn ticket's owner bit and never from text, or a low-risk fix filed from the owner's own conversation.
      // The fix turn is started like an owner's Approve does, so it needs a way to run one.
      const route = deps.runTurn
        ? routeBugReport(input, claims, {
            fromOwner: actor.slackId === deps.ownerSlackId,
            ownerTurn: !!ownerTurn,
            sameThread: linkIsThread(input.thread, channelId, threadTs, messageTs),
          })
        : { route: "ask" as const, why: "no way to start the fix turn" };

      const b = repo.add({ fingerprint, threadLink: input.thread, issue: input.issue, summary: input.summary, plan: input.plan, reportedIn: channelId }, now);
      const buttons = [
        { actionId: BUG_APPROVE_ACTION, label: "Approve", value: String(b.id), style: "primary" as const },
        { actionId: BUG_REJECT_ACTION, label: "Reject", value: String(b.id), style: "danger" as const },
      ];
      const notice = await deps.slack
        .postDmInteractive(
          deps.ownerSlackId,
          route.route === "approve" ? approvedByJuekiText(b.id, input, route.reason) : approvalText(b.id, input),
          // An approval Jueki gave leaves the owner the one button that stops it.
          route.route === "approve" ? buttons.slice(1) : buttons,
          SIGNATURES.bugReport,
        )
        .catch(logAndIgnore("bug report post"));
      if (!notice) {
        repo.discard(b.id);
        return "I could not DM the owner, so the bug report was not sent.";
      }
      repo.setNotice(b.id, notice.channel, notice.ts);
      if (route.route === "approve" && repo.decide(b.id, "approved", now, "jueki")) {
        // Not awaited: the fix runs for as long as it runs, in the notice's thread, as the owner, exactly as the press would start it.
        void Promise.resolve(
          deps.runTurn?.({ channelId: notice.channel, threadTs: notice.ts, slackUserId: deps.ownerSlackId, text: approvedByJuekiBrief(b.id, input, route.reason) }),
        ).catch(logAndIgnore("bug report fix turn"));
        void deps.jueki?.act(`bug #${b.id} approved by me: ${route.reason}`).catch(logAndIgnore("bug report digest"));
        return `Bug #${b.id} approved by Jueki (${route.reason}): the fix turn is starting in the owner's DM and the owner can still reject it. Tell the person in one line that the owner was told and Jueki approved it. Do not fix it in this turn.`;
      }
      return `Bug #${b.id} sent to the owner for approval. Do not fix it yourself until they approve.`;
    },
  },
];
