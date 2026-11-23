/** Things that run later or on their own: follow, mute, watch, remind, loop, mindful. */

import { type MessageRef, parseMessageLink, parsePostTarget } from "../../domain/slackLinks.ts";
import { builtinCheck, humanDuration, MAX_DEADLINE_MS, parseWatchArgs } from "../../domain/watch.ts";
import { formatWhen, humanLead, parseRemindArgs } from "../../domain/reminder.ts";
import {
  mindfulReport,
  teamFromPermalink,
  type LiveRun,
  type MindfulView,
} from "../../domain/mindful.ts";
import { MAX_LOOPS_PER_USER, cleanName, loopRef, nextRun, parseLoopArgs, scheduleText } from "../../domain/loop.ts";
import { proposeScriptLoop } from "../loopApproval.ts";
import { loopOriginText } from "../loops.ts";
import { channelIdByName, type CommandDef, parseWindow } from "./shared.ts";
import { coveredBy, describeTarget, MAX_WRITE_TARGETS, normalizeTargets, targetsNamedIn, type WriteTarget } from "../../domain/writeTargets.ts";
import { PERM } from "../../domain/permissions.ts";
import { isOwnerRole, roleNamesWith } from "../../domain/roles.ts";

/** How many watches one fired watch may hand its grant to while they wait: enough for a few things followed at once, not a multiplier. */
const MAX_REARM_CHILDREN = 5;
const FOLLOW_FILLER = new Set(["thread", "this", "the", "that"]);

/**
 * The thread a link points at. Slack wraps a pasted link as `<url|label>`, and
 * a reply's permalink names the reply itself with the thread in `thread_ts`:
 * following the reply's ts would follow a thread that does not exist.
 */
const followTarget = (arg: string): MessageRef | undefined => {
  const url = arg.replace(/^<|>$/g, "").split("|")[0] ?? "";
  const ref = parseMessageLink(url);
  const threadTs = url.match(/[?&]thread_ts=(\d+\.\d+)/)?.[1];
  return ref && threadTs ? { channel: ref.channel, ts: threadTs } : ref;
};

export const SCHEDULE_COMMANDS: readonly CommandDef[] = [
  {
    name: "follow",
    aliases: ["autoreply"],
    // It makes the bot speak in a room without being spoken to, which is a
    // standing decision about a shared space rather than a one-off reply.
    minRole: "executer",
    usage: "[thread] [<thread link>] | off [<thread link>] | list",
    summary: "keep up with a thread without being tagged in every message",
    run: ({ deps, actor, args, rest, prefix, threadTs, channelId }) => {
      if (!deps.follows) return "I cannot keep track of followed threads right now.";
      const sub = (args[0] ?? "").toLowerCase();

      if (sub === "list") {
        const all = deps.follows.list(30);
        if (all.length === 0) return "I am not following any thread I did not start.";
        return all
          .map(
            (f) =>
              `- <#${f.channelId}> \`${f.threadTs}\` - added by <@${f.addedBy}>` +
              (deps.mutes?.isMuted(f.channelId, f.threadTs) ? " - muted, so I stay silent there until `mute off`" : ""),
          )
          .join("\n");
      }

      const off = sub === "off" || sub === "stop" || sub === "no";
      // "follow thread <link>", "follow this thread" read the way people say it:
      // the filler words are not the link, so skip them rather than refuse.
      const linkArg = (off ? args.slice(1) : args).find((a) => !FOLLOW_FILLER.has(a.toLowerCase())) ?? "";
      const ref = linkArg ? followTarget(linkArg) : undefined;
      if (linkArg && !ref) return `That is not a Slack thread link. \`${prefix} follow <thread link>\``;
      // A link wins; otherwise it is the thread this was typed in.
      const target = ref ?? (threadTs ? { channel: channelId, ts: threadTs } : undefined);
      if (!target) {
        return `Which thread? Run it in the thread, or \`${prefix} follow <thread link>\``;
      }

      if (off) {
        return deps.follows.remove(target.channel, target.ts, deps.clock())
          ? "stopped following that one - I will only answer there when tagged now 🫧"
          : "I was not following that thread.";
      }
      deps.follows.add(target.channel, target.ts, actor.slackId, deps.clock());
      void rest;
      if (deps.mutes?.isMuted(target.channel, target.ts)) {
        return `saved the follow, but that thread is muted: I answer nobody there, tagged or not, until \`${prefix} mute off\` 🔇`;
      }
      return `following that thread now - I will read every message in it and answer when I actually have something, without being tagged. Most of the time that means staying quiet: messages wait for a quiet moment and a cheap check first (\`follow_gate\`, \`follow_debounce_seconds\`, \`follow_debounce_max_seconds\`), then I answer the batch once. \`${prefix} follow off\` to stop 👀`;
    },
  },
  {
    name: "mute",
    // The mirror image of `follow`: a standing decision about a shared room,
    // and the one that silences the bot for everybody in it.
    minRole: "executer",
    usage: "[thread] [<thread link>] | off [<thread link>] | list",
    summary: "turn me off for one thread: I answer nobody there, even when tagged, until `mute off`",
    run: ({ deps, actor, args, prefix, threadTs, channelId }) => {
      if (!deps.mutes) return "I cannot keep track of muted threads right now.";
      const sub = (args[0] ?? "").toLowerCase();

      if (sub === "list") {
        const all = deps.mutes.list(30);
        if (all.length === 0) return "I am not muted in any thread.";
        return all
          .map(
            (m) =>
              `- <#${m.channelId}> \`${m.threadTs}\` - muted by <@${m.mutedBy}>` +
              (deps.follows?.isFollowed(m.channelId, m.threadTs) ? " - also followed, suppressed while muted" : ""),
          )
          .join("\n");
      }

      // `mute on` is `mute`: it must never lift the mute it reads as asking for.
      const off = sub === "off" || sub === "stop" || sub === "no";
      const linkArg = (off || sub === "on" ? args.slice(1) : args).find((a) => !FOLLOW_FILLER.has(a.toLowerCase())) ?? "";
      const ref = linkArg ? followTarget(linkArg) : undefined;
      if (linkArg && !ref) return `That is not a Slack thread link. \`${prefix} mute <thread link>\``;
      const target = ref ?? (threadTs ? { channel: channelId, ts: threadTs } : undefined);
      if (!target) return `Which thread? Run it in the thread, or \`${prefix} mute <thread link>\``;

      if (off) {
        return deps.mutes.unmute(target.channel, target.ts)
          ? "unmuted - I answer in that thread again 🔊"
          : "I was not muted in that thread.";
      }
      const added = deps.mutes.mute(target.channel, target.ts, actor.slackId, deps.clock());
      const followed = deps.follows?.isFollowed(target.channel, target.ts)
        ? " Its follow stays saved but is suppressed meanwhile."
        : "";
      return `${added ? "muted" : "already muted"} - I answer nobody in that thread now, even when tagged, and start nothing from their messages. Only \`${prefix} ...\` commands still run there, so \`${prefix} mute off\` works from inside it. Work I already have bound to the thread (a watch, a loop, a tell, a workflow step) keeps running.${followed} 🔇`;
    },
  },
  {
    name: "watch",
    aliases: ["waitfor"],
    // A raw `-- <shell>` predicate runs as the bot, on a timer, outside any
    // turn - the same authority a full-access turn has - so that form stays
    // executer and up, checked below. The named waits build their own quoted
    // predicate and a plain timer has none, so those are anyone's.
    minRole: "pal",
    // The confirmation is for the brain, not the thread: it already says what
    // it is waiting for in its own words, and a second notice is just noise.
    quiet: true,
    usage: "pr|checks|reply|url|worker <target> [--every 1m] [--until 45m|2h|30d] [--past-wait] [--to <thread-link|#channel>]... <what to do> | <what to do> -- <shell check> | list | cancel [<id>]",
    summary: "wait for a PR, CI, a reply, a url or an Orca worker (up to 30 days with --until), then carry on in this thread by itself; set in the owner's own turn, --to (or a link/channel in the request) lets it post, react and upload there when it fires; a watch that fired with such a grant and sets the next one passes on the same places or fewer (--to can only narrow)",
    run: async ({ can, roles, deps, actor, args, rest, prefix, threadTs, channelId, ownerTurn, watchGrant }) => {
      if (!deps.watches) return "I have nowhere to keep a watch right now.";
      const sub = (args[0] ?? "").toLowerCase();

      if (sub === "list") {
        // A pal sees their own; the rest name other people's channels and checks.
        const waiting = deps.watches
          .waiting(20)
          .filter((w) => can(PERM.shellWatch) || w.slackUserId === actor.slackId);
        if (waiting.length === 0) return "I am not waiting for anything.";
        const now = deps.clock();
        return waiting
          .map(
            (w) =>
              `- #${w.id} <#${w.channelId}> ${w.check ? `\`${w.check.slice(0, 60)}\`` : "timer"} - every ${humanDuration(w.everyMs)}, ${humanDuration(Math.max(0, w.deadlineAt - now))} left, ${w.attempts} checks${w.writeTargets.length ? `, may write to ${w.writeTargets.length} other place${w.writeTargets.length === 1 ? "" : "s"}${w.parentWatchId ? `, re-armed from #${w.parentWatchId}` : ""}` : ""}`,
          )
          .join("\n");
      }

      if (sub === "cancel" || sub === "stop") {
        // `cancel <id>` ends that one watch and says what happened to it; it
        // used to ignore the id and answer for the whole thread, which read
        // "nothing was being watched" for a watch that had just fired.
        const idArg = (args[1] ?? "").replace(/^#/, "");
        if (idArg) {
          if (!/^\d+$/.test(idArg)) return `\`${prefix} watch cancel [<id>]\` - the id is the #number the watch printed.`;
          const w = deps.watches.get(Number(idArg));
          if (!w) return `There is no watch #${idArg}.`;
          const mine = w.slackUserId === actor.slackId || (w.channelId === channelId && w.threadTs === threadTs);
          if (!mine && !can(PERM.shellWatch)) return `#${w.id} is not yours to cancel - ask <@${w.slackUserId}>.`;
          if (w.state !== "waiting") return `#${w.id} had already ${w.state === "fired" ? "fired" : `ended (${w.state})`}, so there was nothing left to cancel.`;
          return deps.watches.cancel(w.id, deps.clock()) ? `stopped watch #${w.id}` : `#${w.id} ended just now, before the cancel.`;
        }
        if (!threadTs) return "Cancel which thread's watch? Run it in the thread.";
        const n = deps.watches.cancelThread(channelId, threadTs, deps.clock());
        return n > 0 ? `stopped ${n} watch${n === 1 ? "" : "es"} here` : "nothing was being watched here.";
      }

      if (!threadTs) {
        return "A watch belongs to a thread - run it in the one that should carry on.";
      }
      const parsed = parseWatchArgs(rest);
      if (!parsed.ok) {
        return `${parsed.error}. \`${prefix} watch pr <url> <what to do>\`, or \`${prefix} watch <what to do> -- <shell check>\``;
      }
      if (parsed.check && !can(PERM.shellWatch)) {
        return `A shell check needs the *${PERM.shellWatch}* permission (held by ${roleNamesWith(roles, PERM.shellWatch)}). \`${prefix} watch pr|checks|reply|url|worker <target> <what to do>\` is open to you.`;
      }
      const now = deps.clock();
      // A named wait builds its own predicate. The raw `-- <shell>` form still
      // wins if both were given: somebody who wrote a command meant it.
      let check = parsed.check;
      if (!check && parsed.kind) {
        const ref = parsed.kind === "reply" ? parseMessageLink(parsed.target ?? "") : undefined;
        const built = builtinCheck(parsed.kind, parsed.target ?? "", {
          slackWaitScript: deps.slackWaitScript,
          channel: ref?.channel,
          threadTs: ref?.ts,
          // Only what is said from NOW counts; the thread's existing replies
          // are not an answer to a question asked after them.
          afterTs: (now / 1000).toFixed(6),
          from: parsed.from,
          orcaWorkerWait: deps.orcaWorkerWait,
          pastWait: parsed.pastWait,
          armedAt: now,
        });
        if ("error" in built) return built.error;
        check = built.check;
      }
      if (!check && !parsed.kind) {
        // A plain timer, which is allowed - but say so, because "watch" with
        // no check reads like it is watching something.
      }
      // Where the fired turn may write besides this thread. Two ways to hold a grant, both decided by the run bridge from the turn
      // ticket, never by what the brain writes:
      // - the owner's own turn: the watch gets what was NAMED - `--to`, the owner's message, the request text - never "anywhere".
      // - a turn a watch fired that itself carried a grant (this is a re-arm): the new watch inherits the creator and a SUBSET of
      //   that grant. Nothing is added: no `--to` outside it, no link in this turn's text, never the owner bit.
      // Anyone else's watch, and a watch from a turn nobody owner-started, keeps today's thread-only turn.
      let createdBy = "";
      let writeTargets: WriteTarget[] = [];
      let parentWatchId = 0;
      let chainEnd = Infinity;
      // Same test the Slack ticket applies when the grant is used: made by the owner, and this turn still runs as that owner.
      const inherit =
        !ownerTurn && watchGrant && !!deps.ownerSlackId && watchGrant.createdBy === deps.ownerSlackId && actor.slackId === deps.ownerSlackId && watchGrant.targets.length > 0
          ? watchGrant
          : undefined;
      if (ownerTurn || inherit) {
        const explicit: WriteTarget[] = [];
        for (const raw of parsed.to ?? []) {
          const t = parsePostTarget(raw);
          if (!t) return `\`--to ${raw}\` is not a place I can write: use a Slack thread link, or a channel (\`#name\`, \`<#C123>\` or its id).`;
          if (t.kind === "name") {
            if (!deps.slack?.listConversationPage) return `I cannot look channel names up here - give \`--to\` the channel id or a thread link.`;
            let id: string | undefined;
            try {
              id = await channelIdByName(deps.slack.listConversationPage, t.name);
            } catch (e) {
              return `Could not look up #${t.name}: ${e instanceof Error ? e.message : String(e)}`;
            }
            if (!id) return `No channel named #${t.name} that I can see. Use its id or a thread link.`;
            explicit.push({ channel: id });
          } else explicit.push(t.kind === "thread" ? { channel: t.channel, threadTs: t.threadTs } : { channel: t.channel });
        }
        if (ownerTurn) {
          createdBy = actor.slackId;
          // This channel already takes the turn's writes; only other places need a grant.
          writeTargets = normalizeTargets([...explicit, ...ownerTurn.named, ...targetsNamedIn([parsed.note, parsed.target ?? ""].join(" "))]).filter(
            (t) => t.channel !== channelId,
          );
        } else if (inherit) {
          // A re-armed watch is never wider than the one that fired: a `--to` the parent grant does not already cover is refused.
          const outside = explicit.filter((t) => !coveredBy(inherit.targets, t));
          if (outside.length) {
            return `\`--to\` can only narrow here: this turn was fired by watch #${inherit.watchId}, which may write only to ${inherit.targets.map(describeTarget).join("; ")}. Not covered: ${outside.map(describeTarget).join("; ")}. Ask the owner to set a new watch for those.`;
          }
          // A chain is not a way round the cap: the whole re-arm chain, counted from the first watch in it, lasts what one watch may,
          // and one fired watch sets only so many children (a fired turn reads untrusted content and must not multiply the grant).
          let root = deps.watches.get(inherit.watchId);
          for (let hops = 0; root?.parentWatchId && hops < 100; hops++) root = deps.watches.get(root.parentWatchId) ?? root;
          chainEnd = (root?.createdAt ?? now) + MAX_DEADLINE_MS;
          if (chainEnd <= now + 60_000) {
            return `This re-arm chain started from watch #${root?.id ?? inherit.watchId} and has used its ${humanDuration(MAX_DEADLINE_MS)}: a watch that keeps following cannot outlive that. Ask the owner to set a new watch if it should go on.`;
          }
          if (deps.watches.waiting(500).filter((x) => x.parentWatchId === inherit.watchId).length >= MAX_REARM_CHILDREN) {
            return `Watch #${inherit.watchId} has already set ${MAX_REARM_CHILDREN} watches that inherit its grant: cancel one, or ask the owner to set a new watch.`;
          }
          createdBy = inherit.createdBy;
          parentWatchId = inherit.watchId;
          // Without `--to` the child keeps the whole parent grant; with it, only the named part of it.
          writeTargets = (explicit.length ? normalizeTargets(explicit) : normalizeTargets(inherit.targets)).filter((t) => t.channel !== channelId);
          if (writeTargets.length === 0) createdBy = "";
        }
        if (writeTargets.length > MAX_WRITE_TARGETS) {
          return `A watch may name at most ${MAX_WRITE_TARGETS} places to write (this one names ${writeTargets.length}): keep \`--to\` and the links in the request to the ones it needs.`;
        }
      } else if (parsed.to?.length) {
        return "`--to` only works in the owner's own turn, or in a turn fired by a watch that already holds a grant (and then only inside it): a watch set anywhere else carries on in this thread only.";
      }
      const w = deps.watches.add(
        {
          channelId,
          threadTs,
          slackUserId: actor.slackId,
          note: parsed.note,
          check,
          everyMs: parsed.everyMs,
          deadlineAt: Math.min(now + parsed.deadlineMs, chainEnd),
          createdAt: now,
          createdBy,
          writeTargets,
          parentWatchId,
        },
        now,
      );
      const grantLine = writeTargets.length
        ? `\nWhen it fires it may post, react and upload in: ${writeTargets.map(describeTarget).join("; ")} - and nowhere else outside this thread${parentWatchId ? ` (inherited from watch #${parentWatchId}, never wider)` : ""}.`
        : "";
      const what =
        parsed.kind === "pr"
          ? `${parsed.target} to be merged`
          : parsed.kind === "checks"
            ? `CI on ${parsed.target}`
            : parsed.kind === "reply"
              ? `a reply in that thread${parsed.from ? ` from <@${parsed.from}>` : ""}`
              : parsed.kind === "url"
                ? parsed.target
                : parsed.kind === "worker"
                  ? `Orca worker \`${parsed.target}\` to finish, die${parsed.pastWait ? " or sit idle" : ", stop for input or sit idle"}`
                  : "";
      if (what) {
        return `⏳ waiting for ${what}, checking every ${humanDuration(parsed.everyMs)} and giving up after ${humanDuration(parsed.deadlineMs)}. I will carry on here by myself - you can still talk to me meanwhile. (\`${prefix} watch cancel\`, #${w.id})${grantLine}`;
      }
      return check
        ? `⏳ watching: \`${check.slice(0, 80)}\`\nevery ${humanDuration(parsed.everyMs)}, giving up after ${humanDuration(parsed.deadlineMs)}. I will carry on here by myself when it passes. (\`${prefix} watch cancel\`, #${w.id})${grantLine}`
        : `⏳ I will pick this up again in ${humanDuration(parsed.deadlineMs)}. (\`${prefix} watch cancel\`, #${w.id})${grantLine}`;
    },
  },
  {
    name: "remind",
    aliases: ["reminder", "remindme"],
    // No shell and no turn - a time and a line to post - so anyone may set
    // one. Tagging somebody else is what any Slack user can already do.
    minRole: "pal",
    usage: "[me|<@someone>] (in 2h | at 15:00 [today|tomorrow] | tomorrow 9am | on 2026-12-01) <what> | list | cancel <id>",
    summary: "remind you (or someone) of something here, at a time",
    run: async ({ can, deps, actor, args, rest, prefix, threadTs, channelId }) => {
      if (!deps.reminders) return "I have nowhere to keep a reminder right now.";
      const now = deps.clock();
      const offset = deps.tzOffsetMinutes?.() ?? -new Date(now).getTimezoneOffset();
      const sub = (args[0] ?? "").toLowerCase();
      const admin = can(PERM.manageReminders);

      if (sub === "list" && args.length <= 2) {
        const all = admin && (args[1] ?? "").toLowerCase() === "all";
        const rows = all ? deps.reminders.waiting(30) : deps.reminders.waitingFor(actor.slackId, 30);
        if (rows.length === 0) return all ? "No reminders are waiting." : "You have no reminders waiting.";
        return rows
          .map(
            (r) =>
              `- #${r.id} ${formatWhen(r.dueAt, offset)} (${humanLead(r.dueAt - now)}) <#${r.channelId}> ${r.targets.map((t) => `<@${t}>`).join(" ")}: ${r.text.slice(0, 80)}`,
          )
          .join("\n");
      }

      if ((sub === "cancel" || sub === "stop" || sub === "rm") && args.length === 2) {
        const id = Number((args[1] ?? "").replace(/^#/, ""));
        const r = Number.isInteger(id) ? deps.reminders.get(id) : undefined;
        if (!r || r.state !== "waiting") return `There is no waiting reminder #${args[1]}.`;
        // Whoever set it, whoever it is for, or an admin. Anyone else would be
        // quietly deleting somebody's promise to themselves.
        if (r.createdBy !== actor.slackId && !r.targets.includes(actor.slackId) && !admin) {
          return `#${r.id} is not yours to cancel - ask <@${r.createdBy}>.`;
        }
        deps.reminders.settle(r.id, "cancelled", now);
        return `cancelled reminder #${r.id}`;
      }

      const parsed = parseRemindArgs(rest, actor.slackId, now, offset);
      if (!parsed.ok) {
        return `${parsed.error}. \`${prefix} remind me in 2h check the deploy\`, or \`${prefix} remind <@someone> tomorrow 9am standup notes\``;
      }
      const r = deps.reminders.add(
        { channelId, threadTs: threadTs ?? "", createdBy: actor.slackId, targets: parsed.targets, text: parsed.text, dueAt: parsed.dueAt },
        now,
      );
      const who = parsed.targets.length === 1 && parsed.targets[0] === actor.slackId
        ? "you"
        : parsed.targets.map((t) => `<@${t}>`).join(" ");
      return `⏰ I will remind ${who} ${formatWhen(parsed.dueAt, offset)} (${humanLead(parsed.dueAt - now)}) ${threadTs ? "in this thread" : "here"}. (\`${prefix} remind cancel ${r.id}\`)`;
    },
  },
  {
    name: "loop",
    // Every fire is a model turn with nobody present, so it spends tokens
    // unattended - a standing decision, not a one-off request.
    minRole: "admin",
    usage: "every <monday 9am | day at 18:00 | 6h | week> [--name \"PR board\"] <prompt> | every <schedule> [--name <name>] -- <shell command> (my own turn only, at the owner's ask, then the owner approves) | list | rename <id> <name> | cancel <id>",
    summary: "on a schedule, run a prompt as a real turn; silent unless the prompt asks for a post or a person is needed, then it DMs you under its name (--name, else the first words of the prompt; rename later). A script loop is never typed: ask me in plain words and I write it, the owner approves it",
    run: async ({ deps, actor, args, rest, prefix, threadTs, messageTs, channelId, fromBrainRun }) => {
      if (!deps.loops) return "I have nowhere to keep a loop right now.";
      const now = deps.clock();
      const offset = deps.tzOffsetMinutes?.() ?? -new Date(now).getTimezoneOffset();
      const sub = (args[0] ?? "").toLowerCase();

      if (sub === "list" && args.length === 1) {
        // Yours, wherever you ask: a loop reports to its creator's DM, not to a thread.
        const rows = deps.loops.liveBy(actor.slackId, 30);
        if (rows.length === 0) return "You have no loops.";
        const origins = await Promise.all(rows.map((l) => loopOriginText(l, deps.slack?.permalink)));
        return rows
          .map((l, i) => {
            const what = l.command ? `\`${l.command.slice(0, 80)}\`` : l.prompt.slice(0, 80);
            // A pending one has no next run: it never runs until the owner approves it.
            return l.state === "pending"
              ? `- #${l.id} *${l.name}* script ${l.schedule} - pending the owner's approval, never runs until then: ${what}${origins[i]}`
              : `- #${l.id} *${l.name}* ${l.command ? "script" : "prompt"} ${l.schedule} - next ${formatWhen(l.nextAt, offset)} (${humanLead(l.nextAt - now)}): ${what}${origins[i]}`;
          })
          .join("\n");
      }

      if (sub === "rename" && args.length >= 3) {
        const id = Number((args[1] ?? "").replace(/^#/, ""));
        const l = Number.isInteger(id) ? deps.loops.get(id) : undefined;
        if (!l || (l.state !== "active" && l.state !== "pending")) return `There is no active loop #${args[1]}.`;
        if (l.createdBy !== actor.slackId && actor.role !== "owner") {
          return `#${l.id} is not yours to rename - ask <@${l.createdBy}>.`;
        }
        // Quotes around the name are optional; Slack-safe either way.
        const name = cleanName(args.slice(2).join(" ").replace(/^["“'‘]|["”'’]$/g, ""));
        if (!name || !deps.loops.rename(l.id, name, now)) return `Say the new name: \`${prefix} loop rename ${l.id} PR board\`.`;
        return `renamed ${loopRef(l.id, l.name)} to ${loopRef(l.id, name)}`;
      }

      if (sub === "rename") return `Say which loop and the new name: \`${prefix} loop rename <id> <name>\`.`;

      if ((sub === "cancel" || sub === "stop" || sub === "rm") && args.length === 2) {
        const id = Number((args[1] ?? "").replace(/^#/, ""));
        const l = Number.isInteger(id) ? deps.loops.get(id) : undefined;
        if (!l || (l.state !== "active" && l.state !== "pending")) return `There is no active loop #${args[1]}.`;
        if (l.createdBy !== actor.slackId && !isOwnerRole(actor.role)) {
          return `#${l.id} is not yours to cancel - ask <@${l.createdBy}>.`;
        }
        // A pending loop was never live: cancelling it deletes it, and its buttons go dead.
        if (l.state === "pending") deps.loops.discard(l.id);
        else deps.loops.settle(l.id, "cancelled", now);
        return `cancelled ${loopRef(l.id, l.name)}`;
      }

      const parsed = parseLoopArgs(rest);
      if (!parsed.ok) {
        return `${parsed.error}. \`${prefix} loop every monday 9am --name "Slang" search the web for new slang and update my slang learning\``;
      }
      // Shell on a timer is never typed, by anyone: a pasted line is exactly what an injected message looks like.
      if (parsed.command && !fromBrainRun) {
        return "A script loop is never made from a typed line, even the owner's. Ask me in plain words what to run and how often, and I will write the script and put it to the owner to approve.";
      }
      // From a turn it is the owner's alone, and even then it waits for their Approve.
      if (parsed.command && !isOwnerRole(actor.role)) {
        return "A script loop runs shell, so only the owner can have me create one. A prompt loop (`loop every <schedule> <prompt>`) is open to you.";
      }
      if (deps.loops.liveBy(actor.slackId, MAX_LOOPS_PER_USER + 1).length >= MAX_LOOPS_PER_USER) {
        return `You already have ${MAX_LOOPS_PER_USER} loops. \`${prefix} loop list\`, then \`${prefix} loop cancel <id>\`.`;
      }
      const nextAt = nextRun(parsed.schedule, now, offset);
      if (parsed.command) {
        if (!deps.loopApproval) return "I cannot ask for the owner's approval right now, so no script loop was created.";
        const proposed = await proposeScriptLoop(deps.loopApproval, {
          channelId,
          threadTs: threadTs ?? "",
          originTs: messageTs,
          createdBy: actor.slackId,
          name: parsed.name,
          schedule: scheduleText(parsed.schedule),
          prompt: "",
          command: parsed.command,
          nextAt,
        });
        if (!proposed.ok) return proposed.error;
        return `🔐 script ${loopRef(proposed.loop.id, proposed.loop.name)} (${proposed.loop.schedule}) is PENDING: nothing is scheduled and nothing runs until the owner presses Approve on the DM I just sent with the exact command. Reject, or no answer in 24h, deletes it. Tell the person that.`;
      }
      const l = deps.loops.add(
        { channelId, threadTs: threadTs ?? "", originTs: messageTs, createdBy: actor.slackId, name: parsed.name, schedule: scheduleText(parsed.schedule), prompt: parsed.prompt, command: parsed.command, nextAt },
        now,
      );
      return `🔁 ${loopRef(l.id, l.name)}: ${l.schedule}, first run ${formatWhen(nextAt, offset)} (${humanLead(nextAt - now)}). Each run starts a turn in your DM with me, as you. (\`${prefix} loop rename ${l.id} <name>\`, \`${prefix} loop cancel ${l.id}\`)`;
    },
  },
  {
    name: "mindful",
    aliases: ["mind", "whatsup"],
    // It names people, quotes what they asked, and spans every conversation
    // the bot can see - DMs and private channels the reader may not be in.
    minRole: "admin",
    usage: "[hours] | continue <thread link> | reply <thread link> [what to say]",
    summary: "everything I am doing: what is stuck, what is running, what it cost",
    run: async (ctx) => {
      const { deps, actor, args, prefix, channelId } = ctx;
      const sub = (args[0] ?? "").toLowerCase();
      const team = deps.slackTeam?.();

      if (sub === "continue" || sub === "retry" || sub === "reply") {
        if (!deps.runTurn) return "I cannot start a turn from here right now.";
        const ref = parseMessageLink((args[1] ?? "").replace(/^<|>$/g, ""));
        if (!ref) return `Which thread? \`${prefix} mindful ${sub} <thread link>\``;
        const said = args.slice(2).join(" ").trim();

        if (sub === "reply") {
          // Nudging a thread it has gone quiet in. With nothing said, it is
          // told to catch up and answer only if it has something - the same
          // judgement it uses when following its own threads.
          const text =
            said ||
            "Read this thread from the start, then reply only if you have something it needs. If you do not, say nothing.";
          await deps.runTurn({ channelId: ref.channel, threadTs: ref.ts, slackUserId: actor.slackId, text });
          return `nudged that thread${said ? "" : " - it will answer only if it has something"} 🫧`;
        }

        // Continue: run the dead turn again, as the person who asked for it
        // the first time. Their request is in the turn log precisely so this
        // does not depend on a `messages` table a `forget` can empty.
        const last = deps.turns?.latestInThread(ref.channel, ref.ts);
        if (!last) return "I have no record of a turn in that thread.";
        if (last.outcome === "ok" && !said) {
          return `The last turn there finished fine. \`${prefix} mindful reply <link> <what to ask>\` if you want something new.`;
        }
        const text = said || last.request;
        if (!text.trim()) return "That turn left nothing to run again.";
        await deps.runTurn({
          channelId: ref.channel,
          threadTs: ref.ts,
          slackUserId: last.slackUserId || actor.slackId,
          text,
        });
        return `running that one again for <@${last.slackUserId || actor.slackId}> 🔁`;
      }

      const windowMs = parseWindow(args[0]) ?? 4 * 60 * 60_000;
      const since = deps.clock() - windowMs;

      const live: LiveRun[] = (deps.runs?.all() ?? []).map((r) => ({
        id: r.id,
        channelId: r.channelId,
        threadTs: r.threadTs,
        actor: r.actor,
        what: r.what,
        startedAt: r.startedAt,
        state: r.state,
      }));

      const recent = deps.turns?.since(since, 500) ?? [];
      const done = {
        ok: recent.filter((t) => t.outcome === "ok").length,
        failed: recent.filter((t) => t.outcome === "failed").length,
        stopped: recent.filter((t) => t.outcome === "stopped").length,
      };

      const view: MindfulView = {
        now: deps.clock(),
        live,
        stuck: (deps.turns?.stuckThreads(since, 12) ?? []).map((t) => ({
          channelId: t.channelId,
          threadTs: t.threadTs,
          slackUserId: t.slackUserId,
          request: t.request,
          error: t.error,
          outcome: t.outcome,
          endedAt: t.endedAt,
        })),
        watching: (deps.watches?.waiting(15) ?? []).map((w) => ({
          id: w.id,
          channelId: w.channelId,
          threadTs: w.threadTs,
          check: w.check,
          note: w.note,
          deadlineAt: w.deadlineAt,
          attempts: w.attempts,
        })),
        workflows: (deps.workflows?.listActive() ?? []).map((w) => ({
          channelId: w.channelId,
          threadTs: w.threadTs,
          task: w.task,
          lastTurnAt: w.updatedAt,
        })),
        stuckWork: await deps.stuckWork?.(),
        done,
        spend: deps.usage?.totals(since) ?? {
          runs: 0,
          costUsd: 0,
          inputTokens: 0,
          outputTokens: 0,
          cacheRead: 0,
          cacheWrite: 0,
          durationMs: 0,
        },
        windowMs,
      };

      // One permalink resolves the workspace domain; every other link is then
      // built from ids rather than costing an API call of its own.
      const anchor =
        view.stuck[0] ??
        view.workflows[0] ??
        view.stuckWork?.tasks.find((t) => t.owner)?.owner ??
        view.stuckWork?.prs.find((p) => p.owner)?.owner;
      const resolved =
        team ??
        (anchor && deps.slack?.permalink
          ? teamFromPermalink(await deps.slack.permalink(anchor.channelId, anchor.threadTs))
          : undefined);
      const report = mindfulReport(view, resolved);
      const hint = view.stuck.length > 0 ? `\n\n_\`${prefix} mindful continue <thread link>\` runs a stuck one again_` : "";
      void channelId;
      return `${report}${hint}`;
    },
  },
];
