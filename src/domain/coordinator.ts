/**
 * The coordinator: the housekeeping coordinator that lives only in the owner's DM.
 *
 * The owner forgets open work: journeys go quiet for days, a worker ticket
 * lapses under a worker that is still going, a watch runs out, a PR waits on a
 * reviewer. It is a recurring tick (not a process) that rebuilds its picture
 * from the bot's own records every time, acts on what it can inside the owner's
 * role, and raises to the owner only what really needs them.
 *
 * Everything here is pure: when it is quiet, which journey needs what, which
 * ticket to renew, how a blocker is routed (the prod rule included), and the
 * words of the digest and of a blocker. The tick is `application/coordinator.ts`, the
 * rows are `infrastructure/db/coordinatorRepo.ts`.
 */
import { ciStatusOf, type RollupEntry } from "./ciGate.ts";
import { cleanLine } from "./journey.ts";
import { humanDuration, watchesWorker } from "./watch.ts";
import { WORKER_LIFETIME_MAX_MS } from "./workerTicket.ts";

/**
 * What the coordinator is called when `COORDINATOR_NAME` is not set. Every instance
 * is personalized through config, so the name it signs with and answers to is a
 * setting, never a constant (normal threads sign "Jarvis").
 */
export const DEFAULT_COORDINATOR_NAME = "Coordinator";

/** The configured display name, or the neutral default when it is blank. */
export const coordinatorName = (configured?: string): string => configured?.trim() || DEFAULT_COORDINATOR_NAME;

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

/** The owner's clock: Asia/Ho_Chi_Minh, UTC+7, no daylight saving. */
export const DEFAULT_OFFSET_MIN = 420;
/** No pings from 22:00 to 05:00 local (prod blockers excepted). */
export const DEFAULT_QUIET_START_HOUR = 22;
export const DEFAULT_QUIET_END_HOUR = 5;

export const DEFAULT_INTERVAL_MS = 30 * MINUTE_MS;
/** An open journey untouched this long is stale. */
export const DEFAULT_STALE_JOURNEY_MS = 3 * DAY_MS;
/** A prod blocker is put to the owner again after this long without a decision. */
export const DEFAULT_PROD_REPING_MS = 30 * MINUTE_MS;
/** The same stale journey (or other item) is nudged at most this often. */
export const NUDGE_REPEAT_MS = DAY_MS;
/** A worker ticket this close to its expiry is renewed. */
export const TICKET_RENEW_WINDOW_MS = 45 * MINUTE_MS;
/** How many lines one digest message shows; older ones fold into a count. */
export const DIGEST_MAX_LINES = 40;
export const MAX_LINE = 200;

// ---------------------------------------------------------------- time

const shifted = (now: number, offsetMin: number): Date => new Date(now + offsetMin * MINUTE_MS);
const pad = (n: number): string => String(n).padStart(2, "0");

/** `2026-11-27`, the owner's calendar day: the digest's key and the daily session's name. */
export const localDay = (now: number, offsetMin: number): string => {
  const d = shifted(now, offsetMin);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
};

/** `09:05`, the owner's clock, for a digest line. */
export const localClock = (now: number, offsetMin: number): string => {
  const d = shifted(now, offsetMin);
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
};

/** Whether `now` is inside the quiet window; the window may wrap midnight (22 -> 5). Equal hours mean never quiet. */
export const inQuietHours = (
  now: number,
  offsetMin: number = DEFAULT_OFFSET_MIN,
  startHour: number = DEFAULT_QUIET_START_HOUR,
  endHour: number = DEFAULT_QUIET_END_HOUR,
): boolean => {
  if (startHour === endHour) return false;
  const h = shifted(now, offsetMin).getUTCHours();
  return startHour < endHour ? h >= startHour && h < endHour : h >= startHour || h < endHour;
};

// ---------------------------------------------------------------- journeys

export type JourneyFacts = {
  readonly id: number;
  readonly status: "planned" | "doing" | "blocked" | "done" | "dropped";
  readonly progress: number;
  readonly updatedAt: number;
};

export type JourneyAction =
  /** Open at 100%: it is done, only never closed. */
  | { readonly kind: "close" }
  /** Open and silent for `idleMs`: nudge or resume it. */
  | { readonly kind: "nudge"; readonly idleMs: number };

const isOpen = (s: JourneyFacts["status"]): boolean => s === "planned" || s === "doing" || s === "blocked";

export const journeyAction = (j: JourneyFacts, now: number, staleMs: number): JourneyAction | undefined => {
  if (!isOpen(j.status)) return undefined;
  if (j.progress >= 100) return { kind: "close" };
  const idleMs = now - j.updatedAt;
  return idleMs >= staleMs ? { kind: "nudge", idleMs } : undefined;
};

// ---------------------------------------------------------------- worker tickets

export type TicketFacts = {
  readonly id: string;
  readonly dispatchId: string;
  readonly boundAt: number;
  readonly expiresAt: number;
};

export type TicketAction =
  /** Expiring soon or lapsed, under a worker still watched, and inside its lifetime: renew it. */
  | { readonly kind: "renew"; readonly lapsed: boolean }
  /** Past the absolute lifetime: no renewal can help, the worker needs a new ticket. */
  | { readonly kind: "replace" };

/**
 * What a worker ticket needs. A ticket is renewed only while someone still
 * waits on its worker (`liveDispatch`): a ticket of a finished worker is ended
 * by the watch, and extending it would widen a grant nobody is using.
 */
export const ticketAction = (
  t: TicketFacts,
  now: number,
  liveDispatch: boolean,
  windowMs: number = TICKET_RENEW_WINDOW_MS,
): TicketAction | undefined => {
  if (!t.dispatchId || !liveDispatch) return undefined;
  const lifetimeEnd = t.boundAt + WORKER_LIFETIME_MAX_MS;
  if (now >= lifetimeEnd) return { kind: "replace" };
  if (t.expiresAt - now > windowMs) return undefined;
  // Already at the end of its life and about to lapse: a renewal would move nothing, only a new ticket helps.
  if (t.expiresAt >= lifetimeEnd) return { kind: "replace" };
  return { kind: "renew", lapsed: t.expiresAt <= now };
};

// ---------------------------------------------------------------- watches

export type LapsedWatch = {
  readonly id: number;
  readonly check: string;
  readonly state: string;
};

/** The dispatch a lapsed `watch worker` was waiting on. */
export const lapsedWorkerDispatch = (w: LapsedWatch, dispatchIds: readonly string[]): string | undefined =>
  w.state === "expired" || w.state === "failed" ? dispatchIds.find((d) => watchesWorker(w.check, d)) : undefined;

/** `ctx_...` ids a `watch worker` check names. */
export const dispatchIdsOf = (check: string): string[] =>
  check.includes("orca-worker-wait") ? [...check.matchAll(/'(ctx_[A-Za-z0-9_-]+)'/g)].map((m) => m[1] ?? "") : [];

/** A re-armed worker watch runs this long before it needs arming again. */
export const REARM_DEADLINE_MS = 12 * HOUR_MS;
/** One fired watch sets at most this many children that inherit its grant (the rule of `watch` in a fired turn). */
export const MAX_GRANT_CHILDREN = 5;
/** A chain with less than this left carries no grant any more. */
const CHAIN_END_MARGIN_MS = MINUTE_MS;
/** The longest one watch, and so one re-arm chain counted from its first watch, may last. */
export const CHAIN_MAX_MS = 30 * DAY_MS;

export type RearmPlan = {
  /** When the new watch runs out. */
  readonly deadlineAt: number;
  /** Carry the write grant over (never wider than the lapsed watch's, never past the chain's 30 days). */
  readonly grant: boolean;
};

/**
 * How a lapsed `watch worker` is armed again. The grant it carries is the one a fired turn's re-arm
 * would inherit, under the same limits: counted from the FIRST watch of the chain (`rootCreatedAt`),
 * 30 days in all, and at most `MAX_GRANT_CHILDREN` waiting children per parent. Past either, the new
 * watch is plain: it still follows the worker, it just writes nowhere beyond its own thread.
 */
export const rearmPlan = (
  w: { readonly writeTargets: readonly unknown[]; readonly createdBy: string },
  now: number,
  rootCreatedAt: number,
  waitingChildren: number,
): RearmPlan => {
  const chainEnd = rootCreatedAt + CHAIN_MAX_MS;
  const grant = !!w.createdBy && w.writeTargets.length > 0 && chainEnd - now > CHAIN_END_MARGIN_MS && waitingChildren < MAX_GRANT_CHILDREN;
  return { grant, deadlineAt: grant ? Math.min(now + REARM_DEADLINE_MS, chainEnd) : now + REARM_DEADLINE_MS };
};

// ---------------------------------------------------------------- pull requests

export type OwnPr = {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly draft: boolean;
  /** `red` = a failing check, `green`, or `pending`. */
  readonly ci: "red" | "green" | "pending";
  /** Reviewers asked and not yet answered, by login. */
  readonly waitingOn: readonly string[];
  readonly updatedAt: number;
};

/** A reviewer who has had the request this long is chased. */
export const REVIEW_CHASE_MS = 24 * HOUR_MS;

export const prFindings = (prs: readonly OwnPr[], now: number): { red: OwnPr[]; chase: OwnPr[] } => ({
  red: prs.filter((p) => !p.draft && p.ci === "red"),
  chase: prs.filter((p) => !p.draft && p.ci !== "red" && p.waitingOn.length > 0 && now - p.updatedAt >= REVIEW_CHASE_MS),
});

/** `app/jarvis-at-momos` (how `gh pr list` names an App) and `jarvis-at-momos[bot]` (how the API does) are one login. */
export const loginKey = (login: string): string => login.trim().toLowerCase().replace(/^app\//, "").replace(/\[bot\]$/, "");

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

/**
 * The open PRs `gh pr list --json number,title,url,isDraft,updatedAt,author,statusCheckRollup,reviewRequests`
 * printed, as the bot's own (`authors` are logins, case-insensitive; empty means every one). Undefined when
 * the output is not a list.
 */
export const parseOwnPrs = (stdout: string, authors: readonly string[]): OwnPr[] | undefined => {
  let r: unknown;
  try {
    r = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  if (!Array.isArray(r)) return undefined;
  const mine = new Set(authors.map(loginKey));
  return r.filter(isRecord).flatMap((p) => {
    const url = typeof p.url === "string" ? p.url : "";
    const login = isRecord(p.author) && typeof p.author.login === "string" ? loginKey(p.author.login) : "";
    if (typeof p.number !== "number" || !url || (mine.size > 0 && !mine.has(login))) return [];
    const rollup = Array.isArray(p.statusCheckRollup) ? (p.statusCheckRollup.filter(isRecord) as RollupEntry[]) : [];
    const verdict = ciStatusOf(rollup).verdict;
    const waitingOn = (Array.isArray(p.reviewRequests) ? p.reviewRequests : []).flatMap((q) => {
      if (!isRecord(q)) return [];
      const who = typeof q.login === "string" ? q.login : typeof q.name === "string" ? q.name : "";
      return who ? [who] : [];
    });
    const updated = typeof p.updatedAt === "string" ? Date.parse(p.updatedAt) : NaN;
    return [
      {
        number: p.number,
        title: cleanLine(typeof p.title === "string" ? p.title : "", 100),
        url,
        draft: p.isDraft === true,
        ci: verdict === "red" ? ("red" as const) : verdict === "green" ? ("green" as const) : ("pending" as const),
        waitingOn,
        updatedAt: Number.isFinite(updated) ? updated : 0,
      },
    ];
  });
};

// ---------------------------------------------------------------- blockers

/** What kind of wall the coordinator hit. */
export const BLOCKER_KINDS = ["permission", "prod-write", "decision", "repeat-failure", "other"] as const;
export type BlockerKind = (typeof BLOCKER_KINDS)[number];
export const isBlockerKind = (v: string): v is BlockerKind => (BLOCKER_KINDS as readonly string[]).includes(v);

/**
 * The facts the rules read, each stated by whoever hit the blocker. The rules
 * below are the only place they turn into a route.
 */
export type BlockerFacts = {
  /** It touches production. */
  readonly prod: boolean;
  /** An incident is live. */
  readonly incident: boolean;
  /** Customers feel it now. */
  readonly customerImpact: boolean;
  /** Minutes until something breaks for good (a deadline, an expiry); absent when nothing is timed. */
  readonly deadlineMin?: number;
  /** The fix can be undone as it was. */
  readonly reversible: boolean;
  /** It writes, changes or deletes data. */
  readonly dataWrite: boolean;
  /** It changes a schema (migration, index, table). */
  readonly schemaChange: boolean;
  /** It touches a secret, a credential or IAM / access. */
  readonly secretOrIam: boolean;
  /** It needs a grant the owner's role does not hold. */
  readonly beyondRole: boolean;
  /** Only the owner can decide it (a choice, a trade-off, a spend). */
  readonly ownerDecision: boolean;
};

/** Within this many minutes of a timed breakage counts as urgent. */
export const URGENT_DEADLINE_MIN = 120;

/** Urgent: a live incident, customers feeling it, or something timed that breaks within two hours. */
export const isUrgent = (f: BlockerFacts): boolean =>
  f.incident || f.customerImpact || (f.deadlineMin !== undefined && f.deadlineMin <= URGENT_DEADLINE_MIN);

/** Low-risk: reversible, and no data write or delete, no schema change, no secret or IAM change. All four, never some. */
export const isLowRisk = (f: BlockerFacts): boolean => f.reversible && !f.dataWrite && !f.schemaChange && !f.secretOrIam;

/**
 * The prod exception: a prod blocker that is BOTH urgent AND low-risk is fixed
 * by the coordinator itself, inside the owner's role. Something past the owner's role or
 * that only the owner can decide is never self-fixed, however urgent.
 */
export const mayFixProdItself = (f: BlockerFacts): boolean =>
  f.prod && isUrgent(f) && isLowRisk(f) && !f.beyondRole && !f.ownerDecision;

export type BlockerRow = {
  /** `fixed`: the coordinator fixed it itself under the prod rule; a later recurrence of the key is a new blocker. */
  readonly state: "pending" | "approved" | "rejected" | "fixed";
  /** Stored as prod. A non-prod row raised again as prod is asked at once under the prod rule, however recently it was asked as non-prod. */
  readonly prod: boolean;
  /** When it was last put to the owner; 0 when never. */
  readonly lastRaisedAt: number;
};

export type BlockerRoute =
  /** Prod, urgent and low-risk: do it, report it in the digest and one direct DM line. */
  | { readonly route: "self-fix" }
  /** Put it to the owner with Approve / Reject. `repeat` = a prod blocker, which is raised again until decided. */
  | { readonly route: "raise"; readonly repeat: boolean }
  /** Already put to the owner (non-prod, once only), or not yet due to be put again. */
  | { readonly route: "hold"; readonly why: "already-raised" | "decided" | "not-due" | "quiet-hours" };

/**
 * How a blocker is routed. A non-prod blocker is raised once, ever (the key is
 * its identity: the same wall is never repeated), and waits out quiet hours. A
 * prod blocker is raised again every `repingMs` until the owner acts, quiet
 * hours do not hold it back, and the one exception is `mayFixProdItself`.
 */
export const routeBlocker = (
  f: BlockerFacts,
  stored: BlockerRow | undefined,
  now: number,
  opts: { readonly quiet: boolean; readonly repingMs?: number },
): BlockerRoute => {
  // Fixed by the coordinator: the wall is gone, a new one under the same key starts from nothing.
  const prior = stored?.state === "fixed" ? undefined : stored;
  if (prior && (prior.state === "approved" || prior.state === "rejected")) return { route: "hold", why: "decided" };
  if (f.prod) {
    if (mayFixProdItself(f)) return { route: "self-fix" };
    if (prior?.prod && now - prior.lastRaisedAt < (opts.repingMs ?? DEFAULT_PROD_REPING_MS)) return { route: "hold", why: "not-due" };
    return { route: "raise", repeat: true };
  }
  if (prior && prior.lastRaisedAt > 0) return { route: "hold", why: "already-raised" };
  if (opts.quiet) return { route: "hold", why: "quiet-hours" };
  return { route: "raise", repeat: false };
};

/**
 * Whether a stored, still undecided blocker is due to be put to the owner now.
 * A stored prod blocker was routed `raise` (a self-fixable one is never stored),
 * so it is asked again every `repingMs`, quiet hours or not; a non-prod one is
 * asked once, when it has never been asked and it is not quiet.
 */
export const blockerDue = (
  b: { readonly prod: boolean; readonly state: string; readonly lastRaisedAt: number },
  now: number,
  quiet: boolean,
  repingMs: number = DEFAULT_PROD_REPING_MS,
): boolean => {
  if (b.state !== "pending") return false;
  if (b.prod) return now - b.lastRaisedAt >= repingMs;
  return b.lastRaisedAt === 0 && !quiet;
};

const BOOL_FLAGS: Readonly<Record<string, keyof BlockerFacts>> = {
  prod: "prod",
  incident: "incident",
  "customer-impact": "customerImpact",
  reversible: "reversible",
  "data-write": "dataWrite",
  "schema-change": "schemaChange",
  "secret-iam": "secretOrIam",
  "beyond-role": "beyondRole",
  "owner-decision": "ownerDecision",
};

/**
 * `<key> --kind K [--prod] [--incident] [--customer-impact] [--deadline-min N]
 * [--reversible] [--data-write] [--schema-change] [--secret-iam] [--beyond-role]
 * [--owner-decision] <sentence>`. A fact not stated is false, and `reversible`
 * is a claim that must be made: silence is never low-risk.
 */
export const parseBlockerArgs = (
  tokens: readonly string[],
): { ok: true; key: string; kind: BlockerKind; text: string; facts: BlockerFacts } | { ok: false; error: string } => {
  const words: string[] = [];
  const facts: { -readonly [K in keyof BlockerFacts]: BlockerFacts[K] } = {
    prod: false,
    incident: false,
    customerImpact: false,
    reversible: false,
    dataWrite: false,
    schemaChange: false,
    secretOrIam: false,
    beyondRole: false,
    ownerDecision: false,
  };
  let kind: BlockerKind = "other";
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i] ?? "";
    if (!t.startsWith("--") || t === "--") {
      words.push(t);
      continue;
    }
    const name = t.slice(2).toLowerCase();
    const flag = BOOL_FLAGS[name];
    if (flag) {
      (facts as Record<string, unknown>)[flag] = true;
    } else if (name === "kind") {
      const v = (tokens[++i] ?? "").toLowerCase();
      if (!isBlockerKind(v)) return { ok: false, error: `\`--kind\` is one of ${BLOCKER_KINDS.join(", ")}` };
      kind = v;
    } else if (name === "deadline-min") {
      const n = Number(tokens[++i]);
      if (!Number.isFinite(n) || n < 0) return { ok: false, error: "`--deadline-min` is a number of minutes" };
      facts.deadlineMin = n;
    } else {
      return { ok: false, error: `I do not know \`--${name}\`` };
    }
  }
  const key = cleanKey(words[0] ?? "");
  const text = words.slice(1).join(" ").trim();
  if (!key) return { ok: false, error: "name the wall with a short key first" };
  if (!text) return { ok: false, error: "say what is in the way in a sentence" };
  return { ok: true, key, kind, text, facts };
};

/** Buttons are code-handled: the press never reaches a model (`application/coordinatorApproval.ts`). */
export const COORDINATOR_ACTION_PREFIX = "jv:coordinator:";
export const COORDINATOR_APPROVE_ACTION = `${COORDINATOR_ACTION_PREFIX}approve`;
export const COORDINATOR_REJECT_ACTION = `${COORDINATOR_ACTION_PREFIX}reject`;

/**
 * The ids this feature's buttons carried before it was made generic. A blocker
 * message posted back then still has them in Slack, so a press on one keeps working:
 * the listener matches both prefixes and `coordinatorPressKind` reads either.
 * Nothing posts these any more.
 */
export const LEGACY_ACTION_PREFIX = "jv:jueki:";
const LEGACY_APPROVE_ACTION = `${LEGACY_ACTION_PREFIX}approve`;
const LEGACY_REJECT_ACTION = `${LEGACY_ACTION_PREFIX}reject`;

/** Whether `actionId` belongs to a coordinator blocker button, current or legacy. */
export const isCoordinatorAction = (actionId: string): boolean =>
  actionId.startsWith(COORDINATOR_ACTION_PREFIX) || actionId.startsWith(LEGACY_ACTION_PREFIX);

/** What a press means, whichever generation of id it carries; undefined for anything else. */
export const coordinatorPressKind = (actionId: string): "approve" | "reject" | undefined =>
  actionId === COORDINATOR_APPROVE_ACTION || actionId === LEGACY_APPROVE_ACTION
    ? "approve"
    : actionId === COORDINATOR_REJECT_ACTION || actionId === LEGACY_REJECT_ACTION
      ? "reject"
      : undefined;

/** A key names one wall: `lowercase-words-and-dashes`, so the same one is recognised again. */
export const cleanKey = (v: string): string =>
  v
    .toLowerCase()
    .replace(/[^a-z0-9._:-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);

export const blockerText = (name: string, b: { id: number; kind: BlockerKind; prod: boolean; text: string }, repeat: number): string =>
  [
    `*${name}* - ${b.prod ? "🚨 prod blocker" : "blocker"} #${b.id} (${b.kind})${repeat > 0 ? `, asked ${repeat + 1} times` : ""}`,
    b.text,
    b.prod
      ? "_Prod: I keep asking until you act. Approve = go ahead as you; Reject = leave it._"
      : "_Approve = go ahead as you; Reject = leave it. I ask this once._",
  ].join("\n");

export const settledBlockerText = (
  name: string,
  b: { id: number; kind: BlockerKind; prod: boolean; text: string },
  verdict: "approved" | "rejected",
  by: string,
): string => `*${name}* - blocker #${b.id} (${b.kind}): ${b.text}\n_${verdict === "approved" ? "Approved" : "Rejected"} by <@${by}>._`;

export const selfFixDmText = (name: string, key: string, line: string): string =>
  `*${name}* - fixed a prod item myself (urgent and low-risk, inside your role): ${cleanLine(line, MAX_LINE)} (\`${key}\`)`;

// ---------------------------------------------------------------- digest

export type DigestLine = { readonly at: number; readonly text: string };

/** One digest line is a short sentence of plain text. */
export const digestLine = (text: string): string => cleanLine(text, MAX_LINE);

/** The whole day's message, edited in place through the day. */
export const renderDigest = (name: string, day: string, lines: readonly DigestLine[], offsetMin: number, blockers: number): string => {
  const shown = lines.slice(-DIGEST_MAX_LINES);
  const folded = lines.length - shown.length;
  return [
    `*${name}* - housekeeping digest, ${day}`,
    ...(folded > 0 ? [`_${folded} earlier line${folded === 1 ? "" : "s"} not shown_`] : []),
    ...shown.map((l) => `- ${localClock(l.at, offsetMin)} ${l.text}`),
    ...(blockers > 0 ? [`_${blockers} blocker${blockers === 1 ? "" : "s"} waiting on you, asked above_`] : []),
  ].join("\n");
};

// ---------------------------------------------------------------- the turn

export type PictureItem = { readonly ref: string; readonly line: string };

/** What the judgment turn is handed: only items code cannot settle by itself. */
export type Picture = {
  readonly staleJourneys: readonly PictureItem[];
  readonly deadWorkers: readonly PictureItem[];
  readonly replaceTickets: readonly PictureItem[];
  readonly redPrs: readonly PictureItem[];
  readonly chasePrs: readonly PictureItem[];
  readonly unansweredThreads: readonly PictureItem[];
  readonly approvedBlockers: readonly PictureItem[];
};

export const emptyPicture: Picture = {
  staleJourneys: [],
  deadWorkers: [],
  replaceTickets: [],
  redPrs: [],
  chasePrs: [],
  unansweredThreads: [],
  approvedBlockers: [],
};

export const pictureSize = (p: Picture): number =>
  p.staleJourneys.length +
  p.deadWorkers.length +
  p.replaceTickets.length +
  p.redPrs.length +
  p.chasePrs.length +
  p.unansweredThreads.length +
  p.approvedBlockers.length;

const section = (title: string, items: readonly PictureItem[]): string[] =>
  items.length === 0 ? [] : [`${title}:`, ...items.map((i) => `- ${i.ref}: ${i.line}`), ""];

/**
 * The text of one coordinator turn. It starts cold (a fresh session per day), so
 * everything it needs is here or in the journeys, never in carried context.
 */
export const coordinatorTurnText = (name: string, day: string, quiet: boolean, p: Picture, prefix: string): string =>
  [
    `[coordinator ${day}] You are ${name}, the owner's housekeeping coordinator. This is a scheduled tick, nobody typed it, and you live only in the owner's DM. Your state is the journeys, watches, Orca runs, open PRs and threads, never memory: read them back (\`${prefix} journey list\`, \`${prefix} journey show <id>\`) before you act.`,
    "",
    "The picture below is what code could not settle by itself. Work through it, acting inside the owner's existing role:",
    "- stale journey: read it, then close it if it is done (`journey done`), resume it (start or steer the work), or `journey update --now` with what you found. Never leave it as it was.",
    "- dead worker: look at its task and decide redo, resume or drop; renew or re-bind what lapsed (`worker-ticket renew`, a new `watch worker`), inside the owner's role.",
    "- ticket past its lifetime: mint a replacement bound to the same dispatch the way the parallel guide says.",
    "- red CI on an own PR: read the failure and fix it through the self-fix procedure.",
    "- PR waiting on a reviewer: chase them in the PR, once, short.",
    "- unanswered owner thread: answer it or say what is blocking.",
    "- approved blocker: the owner said go ahead, do it.",
    "",
    "Rules that do not bend:",
    `- You never grant yourself anything beyond the owner's role and never write to prod. A blocker that needs a grant beyond the role, a prod write, a decision only the owner can make, or the same fix failing twice goes through \`${prefix} coordinator blocker <key> --kind <permission|prod-write|decision|repeat-failure|other> "<what, in one or two sentences>"\` and nowhere else: code puts it to the owner once (prod ones again and again). Add \`--prod\` when it touches prod, then state the facts it asks for.`,
    `- A prod item that is urgent and low-risk is the one thing code lets you fix yourself: \`coordinator blocker\` answers \`self-fix\` only then. After you fix it run \`${prefix} coordinator fixed <key> "<what you did>"\`.`,
    `- Every action you take is one short line: \`${prefix} coordinator act "<what you did>"\`. That is the digest; do not post anywhere yourself, and do not post in this thread.`,
    quiet
      ? "- It is quiet hours: do not message anyone, comment on GitHub or ping a person. Work that pings waits for morning."
      : "- Ping people sparingly: one chase per PR, no repeats.",
    "- Never repeat a blocker already raised: code refuses it.",
    `- Sign nothing as Jarvis: everything you write on the owner's behalf in the DM is ${name}.`,
    "- When you are done end with NO_REPLY.",
    "",
    ...section("Stale or finished-looking journeys", p.staleJourneys),
    ...section("Dead, blocked or idle Orca workers", p.deadWorkers),
    ...section("Worker tickets past their lifetime", p.replaceTickets),
    ...section("Own PRs with red CI", p.redPrs),
    ...section("Own PRs waiting on a reviewer", p.chasePrs),
    ...section("Owner threads nobody answered", p.unansweredThreads),
    ...section("Blockers the owner approved", p.approvedBlockers),
  ]
    .join("\n")
    .trimEnd();

export const ageLine = (ms: number): string => humanDuration(ms);
