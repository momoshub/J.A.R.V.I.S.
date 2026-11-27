/**
 * Bug reports: the bot tells its owner about a bug in ITSELF.
 *
 * A chat turn can only post in the channel it runs in, so from someone else's
 * thread it could not reach the owner. The internal `bug-report` command (the
 * brain's own turn only) DMs the owner what broke, where, why and the plan to
 * fix it, with Approve / Reject. A press is decided in code by its own Slack
 * listener (application/bugReportApproval.ts), never by a model turn, and only
 * an approve starts the fix, in the notice's thread, as the owner.
 */
import { cleanLine, tokenize, unwrapLink } from "./journey.ts";
import { touchesSensitive } from "./lowRisk.ts";

/** Buttons with this prefix are decided in code by their own listener, never a turn for the model. */
export const BUG_REPORT_ACTION_PREFIX = "jv:bug-report:";
export const BUG_APPROVE_ACTION = `${BUG_REPORT_ACTION_PREFIX}approve`;
export const BUG_REJECT_ACTION = `${BUG_REPORT_ACTION_PREFIX}reject`;

export type BugReportState = "pending" | "approved" | "rejected";

export const MAX_ISSUE = 200;
export const MAX_SUMMARY = 500;
export const MAX_PLAN = 700;

/** The same thread + issue is not put to the owner twice within this long. */
export const DEDUPE_MS = 86_400_000;
/** Reports at all within `DEDUPE_MS`: past this the owner is not asked again, so a looping turn cannot flood the DM. */
export const MAX_PER_DAY = 10;

/** A Slack message link: channel thread, DM or DM thread alike. */
export const SLACK_LINK_RE = /^https:\/\/[\w.-]+\.slack\.com\/archives\/[A-Z0-9]+\/p\d+(\?[\w=&.%-]*)?$/;

export type BugReportInput = {
  readonly thread: string;
  readonly issue: string;
  readonly summary: string;
  readonly plan: string;
};

const FLAGS = ["thread", "issue", "summary", "plan"] as const;

/** What the report's author states about the fix, for `routeBugReport`. A fact not stated is false, and `reversible` must be claimed: silence is never low-risk. */
export type BugRisk = {
  readonly reversible: boolean;
  /** Writes, changes or deletes data. */
  readonly dataWrite: boolean;
  readonly schemaChange: boolean;
  /** A secret, a credential or IAM. */
  readonly secretOrIam: boolean;
  /** Roles, permissions, auth, tickets, tokens or the approval code itself. */
  readonly touchesAccess: boolean;
  /** Prod data or prod behaviour. */
  readonly prod: boolean;
};

/** What `--owner-asked` and the risk flags said; only ever a claim, `routeBugReport` is what decides. */
export type BugClaims = { readonly ownerAsked: boolean; readonly risk: BugRisk };

const BOOL_FLAGS: Readonly<Record<string, "ownerAsked" | keyof BugRisk>> = {
  "owner-asked": "ownerAsked",
  reversible: "reversible",
  "data-write": "dataWrite",
  "schema-change": "schemaChange",
  "secret-iam": "secretOrIam",
  "touches-access": "touchesAccess",
  prod: "prod",
};

/**
 * `--thread <link> --issue "..." --summary "..." --plan "..."`, in any order, `--flag=value` too, and
 * the bare facts `--owner-asked --reversible --data-write --schema-change --secret-iam --touches-access --prod`.
 */
export const parseReport = (
  rest: string,
): { ok: true; input: BugReportInput; claims: BugClaims } | { ok: false; error: string } => {
  const found: Record<string, string> = {};
  const bools: { -readonly [K in "ownerAsked" | keyof BugRisk]?: boolean } = {};
  const tokens = tokenize(rest);
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i] ?? "";
    const m = /^--([\w-]+)(?:=([\s\S]*))?$/.exec(t);
    const name = m?.[1];
    const flag = name ? BOOL_FLAGS[name] : undefined;
    if (m && flag && m[2] === undefined) {
      bools[flag] = true;
      continue;
    }
    if (!name || !(FLAGS as readonly string[]).includes(name)) return { ok: false, error: `I do not know \`${t}\`` };
    const value = m[2] ?? tokens[++i];
    if (value === undefined || value.startsWith("--")) return { ok: false, error: `\`--${name}\` needs a value` };
    found[name] = value;
  }
  const link = unwrapLink((found.thread ?? "").trim());
  if (!SLACK_LINK_RE.test(link)) return { ok: false, error: "`--thread` is the Slack link of the thread (or DM) where the bug showed" };
  const issue = cleanLine(found.issue ?? "", MAX_ISSUE);
  const plan = cleanLine(found.plan ?? "", MAX_PLAN);
  if (!issue) return { ok: false, error: "`--issue` says what is wrong" };
  if (!plan) return { ok: false, error: "`--plan` says how you would fix it" };
  return {
    ok: true,
    input: { thread: link, issue, summary: cleanLine(found.summary ?? "", MAX_SUMMARY), plan },
    claims: {
      ownerAsked: bools.ownerAsked === true,
      risk: {
        reversible: bools.reversible === true,
        dataWrite: bools.dataWrite === true,
        schemaChange: bools.schemaChange === true,
        secretOrIam: bools.secretOrIam === true,
        touchesAccess: bools.touchesAccess === true,
        prod: bools.prod === true,
      },
    },
  };
};

/** What makes two reports the same one: the thread and the issue's words, case and spacing aside. */
export const fingerprintOf = (i: BugReportInput): string =>
  `${i.thread.split("?")[0]}|${i.issue.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim()}`;

/**
 * The channel and thread root a report's Slack link points at: `thread_ts` when
 * the link carries one (a reply), else the linked message's own ts. undefined
 * when it is not a message link.
 */
export const linkThread = (link: string): { channelId: string; threadTs: string } | undefined => {
  const m = /\/archives\/([A-Z0-9]+)\/p(\d{7,})(?:\?([^#]*))?/.exec(link);
  if (!m?.[1] || !m[2]) return undefined;
  const fromQuery = new URLSearchParams(m[3] ?? "").get("thread_ts");
  return { channelId: m[1], threadTs: fromQuery ?? `${m[2].slice(0, -6)}.${m[2].slice(-6)}` };
};

/** Whether any of these reports' links point at this channel and thread. */
export const reportsCover = (
  reports: readonly { readonly threadLink: string }[],
  channelId: string,
  threadTs: string,
): boolean => {
  if (!threadTs) return false;
  return reports.some((r) => {
    const t = linkThread(r.threadLink);
    return t?.channelId === channelId && t.threadTs === threadTs;
  });
};

/** Low-risk: stated reversible and none of the risky facts, all of them, never some. */
export const isLowRiskFix = (r: BugRisk): boolean =>
  r.reversible && !r.dataWrite && !r.schemaChange && !r.secretOrIam && !r.touchesAccess && !r.prod;

/** Whether a report's link points at the conversation (channel and thread) the turn is running in. */
export const linkIsThread = (link: string, channelId: string, threadTs: string | undefined, messageTs: string | undefined): boolean => {
  const t = linkThread(link);
  if (!t || t.channelId !== channelId) return false;
  return t.threadTs === threadTs || (!threadTs && t.threadTs === messageTs);
};

/**
 * What the turn filing the report is, as the code knows it (never as the turn says it):
 * - `fromOwner`: the turn runs as the owner (the ticket's actor), so it is the owner's own conversation or DM and not a pal's;
 * - `ownerTurn`: the turn ticket's owner bit, set only when the owner's own Slack message started this very turn;
 * - `sameThread`: the report's link is the thread this turn runs in, so the owner's message is the one in that thread.
 */
export type BugFiling = { readonly fromOwner: boolean; readonly ownerTurn: boolean; readonly sameThread: boolean };

export type BugRoute =
  /** The coordinator starts the fix; `reason` is what the notice says. */
  | { readonly route: "approve"; readonly reason: string }
  /** The owner's buttons, as before. */
  | { readonly route: "ask"; readonly why: string };

/**
 * Who decides a new bug report. The coordinator approves in two cases only:
 * 1. the owner himself asked for the fix (or said to approve it) in the conversation it was filed from: the turn claims
 *    it (`--owner-asked`) and the code checks it against the ticket's owner bit and the thread;
 * 2. it is a low-risk fix to my own source, filed from a turn the owner's own message started (the same ticket bit; a watch, a loop, the coordinator's own turn never qualify): it states `--reversible`, none of the
 *    risky facts, and the text it wrote names no role, permission, auth, ticket, token, secret, approval or prod word.
 * Anything else, and every report filed from someone else's conversation, goes to the owner's buttons.
 */
export const routeBugReport = (i: BugReportInput, claims: BugClaims, filing: BugFiling): BugRoute => {
  if (!filing.fromOwner) return { route: "ask", why: "filed from someone else's conversation" };
  if (claims.ownerAsked && filing.ownerTurn && filing.sameThread) {
    return { route: "approve", reason: "the owner asked for the fix in that thread" };
  }
  // The low-risk lane needs the owner's own message behind the turn too: a watch-fired, loop, scheduled or coordinator turn runs AS the owner
  // and reads pages, CI logs and other people's messages, so the actor alone proves nothing.
  if (filing.ownerTurn && isLowRiskFix(claims.risk) && !touchesSensitive(i.issue, i.summary, i.plan)) {
    return { route: "approve", reason: "low-risk fix in my own source (reversible, no data, access, secrets, approvals or prod)" };
  }
  return { route: "ask", why: claims.ownerAsked ? "the owner's own message in this thread did not start this turn" : "not low-risk, or not stated as such" };
};

/** The owner's DM: where, what, why, the plan, and what each button does. */
export const approvalText = (id: number, i: BugReportInput): string =>
  [
    `🐞 *I found a bug in myself* (#${id})`,
    `*Where:* <${i.thread}|the thread>`,
    `*Issue:* ${i.issue}`,
    ...(i.summary ? [`*Cause:* ${i.summary}`] : []),
    `*Fix plan:* ${i.plan}`,
    "Approve and I start the fix. Reject and I leave it.",
  ].join("\n");

export const settledText = (id: number, i: BugReportInput, kind: "approved" | "rejected", by: string): string =>
  `🐞 bug #${id} - ${kind === "approved" ? "approved by" : "rejected by"} <@${by}>${kind === "approved" ? ", fixing it" : ", leaving it"}\n*Issue:* ${i.issue}\n<${i.thread}|the thread>`;

/** What the fix turn the owner's Approve press starts is told to do. */
export const approvedBrief = (id: number, i: BugReportInput): string =>
  [
    `Bug #${id} is approved by the owner (they pressed Approve): this is the owner asking for the fix, so fix it now, in the usual way (a worktree and a PR), and tell the owner here when it is up.`,
    `thread: ${i.thread}`,
    `issue: ${i.issue}`,
    ...(i.summary ? [`cause: ${i.summary}`] : []),
    `plan: ${i.plan}`,
  ].join("\n");

/** The notice of a report the coordinator approved: what it decided, why, and the one button left. */
export const approvedByCoordinatorText = (name: string, id: number, i: BugReportInput, reason: string): string =>
  [
    `🐞 bug #${id} - approved by ${name}: ${cleanLine(reason, 160)}, fixing it`,
    `*Issue:* ${i.issue}`,
    `<${i.thread}|the thread>`,
    "Press Reject and the fix is told to stop and undo.",
  ].join("\n");

/** What the fix turn the coordinator's approval starts is told to do (the same ask as an owner's Approve). */
export const approvedByCoordinatorBrief = (id: number, i: BugReportInput, reason: string): string =>
  [
    `Bug #${id} is approved by the coordinator (${cleanLine(reason, 160)}), deciding for the owner, and the owner can still reject it: this is the owner's ask for the fix, so fix it now, in the usual way (a worktree and a PR), and tell the owner here when it is up.`,
    `thread: ${i.thread}`,
    `issue: ${i.issue}`,
    ...(i.summary ? [`cause: ${i.summary}`] : []),
    `plan: ${i.plan}`,
  ].join("\n");

/** Told to the fix turn when the owner presses Reject on a report the coordinator approved. */
export const stoppedBrief = (id: number): string =>
  `Bug #${id} was approved by the coordinator and the owner then rejected it (they pressed Reject): stop. Change nothing more, do not merge or restart anything, close any PR you opened for it unmerged, and say so.`;
