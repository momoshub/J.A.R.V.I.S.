/** `bug-report`: the bot tells its owner about a bug in itself. See domain/bugReport.ts. */

import {
  BUG_APPROVE_ACTION,
  BUG_REJECT_ACTION,
  DECIDED_BY_AGENT,
  DEDUPE_MS,
  MAX_PER_DAY,
  approvalText,
  approvedByAgentBrief,
  approvedByAgentText,
  approvedByCoordinatorBrief,
  approvedByCoordinatorText,
  fingerprintOf,
  linkIsThread,
  parseReport,
  routeBugReport,
  settledText,
} from "../../domain/bugReport.ts";
import { coordinatorName } from "../../domain/coordinator.ts";
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
    summary: "tell the owner about a bug in myself; the coordinator approves the small ones, the rest wait for the owner's button",
    run: async ({ deps, actor, channelId, threadTs, messageTs, ownerTurn, rest, prefix }) => {
      const repo = deps.bugReports;
      if (!repo) return "I have nowhere to keep bug reports right now.";
      const now = deps.clock();
      const word = rest.trim().split(/\s+/)[0]?.toLowerCase() ?? "";

      // Approve / Reject: the owner's button press (application/bugReportApproval.ts), or this turn when it is the owner's own - the turn
      // ticket's owner bit, set by the bot only when the owner's own Slack message started it, never anything the text says. A watch, a loop,
      // a worker's or a `tell`'s turn, and every other person's, is refused and leaves it to the button.
      if (word === "approve" || word === "reject") {
        if (!ownerTurn || actor.slackId !== deps.ownerSlackId) {
          return "A bug report is approved or rejected by the owner pressing the button on the DM I sent, or by me in a turn the owner's own message started. This turn is neither. Nothing changed.";
        }
        const id = Number(rest.trim().split(/\s+/)[1]);
        const b = Number.isInteger(id) ? repo.get(id) : undefined;
        if (!b) return `I have no bug report #${rest.trim().split(/\s+/)[1] ?? ""}. Nothing changed.`;
        if (b.state !== "pending") return `Bug #${b.id} is already ${b.state}. Nothing changed.`;
        const input = { thread: b.threadLink, issue: b.issue, summary: b.summary, plan: b.plan };
        if (word === "reject") {
          if (!repo.decide(b.id, "rejected", now, DECIDED_BY_AGENT)) return `Bug #${b.id} was already decided. Nothing changed.`;
          if (b.noticeChannel && b.noticeTs) {
            await deps.slack?.settleInteractive(b.noticeChannel, b.noticeTs, settledText(b.id, input, "rejected", deps.ownerSlackId), SIGNATURES.bugReport).catch(logAndIgnore("bug report settle"));
          }
          return `Bug #${b.id} rejected by me in the owner's own turn. I leave it.`;
        }
        // The audit line is the notice the owner's Reject press is checked against, so it has to be able to go out before anything is decided.
        if (!deps.slack?.postDmInteractive) return "I cannot DM the owner the audit line from here, so I did not approve it. Nothing changed.";
        if (!repo.decide(b.id, "approved", now, DECIDED_BY_AGENT)) return `Bug #${b.id} was already decided. Nothing changed.`;
        // The fix turn the press would start runs in the notice's thread: if the report is from the thread this turn runs in, or this turn
        // runs in that notice's thread, a second turn would fix it twice - this turn does the fix instead.
        const here = threadTs ?? messageTs;
        const thisTurnFixes =
          !deps.runTurn || linkIsThread(b.threadLink, channelId, threadTs, messageTs) || (b.noticeChannel === channelId && b.noticeTs === here);
        const link = here ? await deps.slack.permalink?.(channelId, here).catch(logAndIgnore("bug report approver thread link")) : undefined;
        const audit = await deps.slack
          .postDmInteractive(
            deps.ownerSlackId,
            approvedByAgentText(b.id, input, link, thisTurnFixes ? "this-turn" : "started"),
            [{ actionId: BUG_REJECT_ACTION, label: "Reject", value: String(b.id), style: "danger" as const }],
            SIGNATURES.bugReport,
          )
          .catch(logAndIgnore("bug report agent approval audit"));
        if (audit) {
          // The Reject on the audit line is now the one a press is checked against; the old Approve / Reject notice is settled.
          if (b.noticeChannel && b.noticeTs) {
            await deps.slack.settleInteractive(b.noticeChannel, b.noticeTs, settledText(b.id, input, "approved", deps.ownerSlackId), SIGNATURES.bugReport).catch(logAndIgnore("bug report settle"));
          }
          repo.setNotice(b.id, audit.channel, audit.ts);
        }
        const warn = audit ? "" : " The audit DM to the owner did not go out: say so.";
        void deps.coordinator?.act(`bug #${b.id} approved by me in the owner's turn`).catch(logAndIgnore("bug report digest"));
        if (thisTurnFixes || !audit) {
          return `Bug #${b.id} approved by me in the owner's own turn and logged. Do the fix in this turn, in the usual way (a worktree and a PR), and tell the owner when it is up.${warn}`;
        }
        void Promise.resolve(
          deps.runTurn?.({ channelId: audit.channel, threadTs: audit.ts, slackUserId: deps.ownerSlackId, text: approvedByAgentBrief(b.id, input), unprompted: true }),
        ).catch(logAndIgnore("bug report fix turn"));
        return `Bug #${b.id} approved by me in the owner's own turn and logged: the owner was told in their DM and the fix turn is starting there. Do not fix it in this turn.`;
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

      // The coordinator decides the small ones, in code (domain/bugReport.ts `routeBugReport`): the owner's own ask in this very thread,
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
          route.route === "approve" ? approvedByCoordinatorText(coordinatorName(deps.coordinatorName), b.id, input, route.reason) : approvalText(b.id, input),
          // An approval the coordinator gave leaves the owner the one button that stops it.
          route.route === "approve" ? buttons.slice(1) : buttons,
          SIGNATURES.bugReport,
        )
        .catch(logAndIgnore("bug report post"));
      if (!notice) {
        repo.discard(b.id);
        return "I could not DM the owner, so the bug report was not sent.";
      }
      repo.setNotice(b.id, notice.channel, notice.ts);
      if (route.route === "approve") {
        // The owner may have pressed Reject in the instant since the notice went out: then it is decided already, and that is what is said.
        if (!repo.decide(b.id, "approved", now, "coordinator")) return `Bug #${b.id} was already decided (${repo.get(b.id)?.state ?? "gone"}) before it could be approved. Do not fix it.`;
        // Not awaited: the fix runs for as long as it runs, in the notice's thread, as the owner, as the press would start it. Marked `unprompted`:
        // the brief is built from a report's words, so the turn has no owner bit and a report it files itself goes to the owner's buttons.
        void Promise.resolve(
          deps.runTurn?.({ channelId: notice.channel, threadTs: notice.ts, slackUserId: deps.ownerSlackId, text: approvedByCoordinatorBrief(b.id, input, route.reason), unprompted: true }),
        ).catch(logAndIgnore("bug report fix turn"));
        void deps.coordinator?.act(`bug #${b.id} approved by me: ${route.reason}`).catch(logAndIgnore("bug report digest"));
        return `Bug #${b.id} approved by the coordinator (${route.reason}): the fix turn is starting in the owner's DM and the owner can still reject it. Tell the person in one line that the owner was told and the coordinator approved it. Do not fix it in this turn.`;
      }
      return `Bug #${b.id} sent to the owner for approval. Do not fix it yourself until they approve.`;
    },
  },
];
