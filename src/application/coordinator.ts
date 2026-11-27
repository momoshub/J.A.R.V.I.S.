/**
 * The coordinator's tick (see domain/coordinator.ts for the why and the rules).
 *
 * Every `COORDINATOR_INTERVAL_MS`, outside any turn, it rebuilds its picture from the
 * bot's own records - journeys, worker tickets, watches, Orca tasks, open PRs,
 * the owner's unanswered threads - and never from a session. What code can
 * settle it settles itself (close a journey that sat at 100%, renew a worker
 * ticket that is about to lapse, re-arm a lapsed `watch worker`) and says so as
 * one line in the day's digest, a single DM message edited through the day.
 * What needs judgment goes to ONE turn in the owner's DM, a fresh session per
 * day, run as the owner with the owner's existing role and nothing more. A wall
 * the owner has to knock down is raised through `blocker` (Approve / Reject
 * buttons, decided in code): once for a non-prod one, again and again for a
 * prod one, with the one exception the rules in the domain spell out.
 *
 * Quiet hours hold every ping (the first digest post, a non-prod blocker, the
 * turn, which may message people); prod blockers and edits do not wait.
 */
import {
  DAY_MS,
  HOUR_MS,
  DEFAULT_PROD_REPING_MS,
  DEFAULT_STALE_JOURNEY_MS,
  NUDGE_REPEAT_MS,
  ageLine,
  blockerDue,
  blockerText,
  cleanKey,
  digestLine,
  dispatchIdsOf,
  emptyPicture,
  inQuietHours,
  journeyAction,
  coordinatorTurnText,
  localDay,
  lapsedWorkerDispatch,
  pictureSize,
  prFindings,
  rearmPlan,
  renderDigest,
  routeBlocker,
  selfFixDmText,
  ticketAction,
  COORDINATOR_APPROVE_ACTION,
  COORDINATOR_REJECT_ACTION,
  type BlockerFacts,
  type BlockerKind,
  type BlockerRoute,
  type OwnPr,
  type Picture,
  type PictureItem,
  type TicketFacts,
} from "../domain/coordinator.ts";
import { watchesWorker } from "../domain/watch.ts";
import { claimFindings, findingLine, holderLine, type ClaimFacts } from "../domain/writerClaim.ts";
import { WORKER_TTL_DEFAULT_MS } from "../domain/workerTicket.ts";
import type { StuckWork } from "../domain/stuckWork.ts";
import type { JourneyRepo } from "../infrastructure/db/journeyRepo.ts";
import type { CoordinatorBlocker, CoordinatorRepo } from "../infrastructure/db/coordinatorRepo.ts";
import type { EndedThread } from "../infrastructure/db/messageRepo.ts";
import type { Watch, WatchRepo } from "../infrastructure/db/watchRepo.ts";
import { logAndIgnore } from "./ignoredError.ts";
import type { Clock } from "./ports.ts";
import type { SlackAdminPort } from "./slackAdmin.ts";

/**
 * A lapsed `watch worker`, armed again (the wiring `index.ts` hands to the tick). The new watch is the
 * same job on the same thread; its write grant, if the lapsed one held one, is carried over only inside
 * the limits a fired turn's re-arm has (`rearmPlan`: 30 days counted from the FIRST watch of the chain,
 * walked back through `parentWatchId`, and a bounded number of children), otherwise it is plain.
 */
export const rearmWatch = (
  watches: Pick<WatchRepo, "get" | "waiting" | "add">,
  w: Watch,
  now: number,
): number => {
  let root = w;
  for (let hops = 0; root.parentWatchId && hops < 100; hops++) root = watches.get(root.parentWatchId) ?? root;
  const children = watches.waiting(500).filter((x) => x.parentWatchId === w.id).length;
  const plan = rearmPlan(w, now, root.createdAt, children);
  return watches.add(
    {
      channelId: w.channelId,
      threadTs: w.threadTs,
      slackUserId: w.slackUserId,
      note: w.note,
      check: w.check,
      everyMs: w.everyMs,
      deadlineAt: plan.deadlineAt,
      createdAt: now,
      ...(plan.grant ? { createdBy: w.createdBy, writeTargets: w.writeTargets, parentWatchId: w.id } : {}),
    },
    now,
  ).id;
};

/** The actor the coordinator's own journey and ticket changes are filed under. */
export const COORDINATOR_ACTOR = "coordinator";

/** An owner thread nobody answered for this long counts. */
export const UNANSWERED_AFTER_MS = 2 * HOUR_MS;
/** Only the last days are looked at. */
export const UNANSWERED_WINDOW_MS = 3 * DAY_MS;
/** A dead worker is put to the turn again after this long. */
export const WORKER_REPEAT_MS = 6 * HOUR_MS;
/** A `coordinator fixed` is accepted this long after the `blocker` that answered `self-fix`. */
export const SELF_FIX_GRANT_MS = 6 * HOUR_MS;
/** Threads and PRs handed to one turn, so a backlog is worked down, not dumped. */
const PICTURE_CAP = 6;

export type CoordinatorTurnRequest = {
  channelId: string;
  threadTs: string;
  slackUserId: string;
  text: string;
  unprompted: boolean;
  loop: boolean;
  hold: boolean;
  /** Answer whether the turn really ran: an ignored or restart-cut turn is not one that handled its picture. */
  reportRan: true;
  trigger: "loop";
};

export type CoordinatorDeps = {
  readonly clock: Clock;
  readonly ownerSlackId: string;
  /** The display name every message is signed with and the turn answers to (`COORDINATOR_NAME`). */
  readonly name: string;
  readonly repo: CoordinatorRepo;
  readonly journeys: JourneyRepo;
  readonly slack: Pick<SlackAdminPort, "postDm" | "update" | "postDmInteractive" | "settleInteractive"> & {
    openDm?: SlackAdminPort["openDm"];
  };
  /** Bound worker tickets never revoked, live or lapsed, and the renewal that revives them (inside the owner's role: it is the minter's own ticket). */
  readonly tickets: {
    bound: () => readonly TicketFacts[];
    renew: (id: string, ttlMs: number) => { ok: true; expiresAt: number } | { ok: false; error: string };
  };
  readonly watches: {
    waiting: () => readonly Watch[];
    lapsedSince: (since: number) => readonly Watch[];
    /** A new watch with the same job; returns its id. */
    rearm: (w: Watch, now: number) => number;
  };
  /** The live writer claims (one writer per job, domain/writerClaim.ts) and the release of one. Absent: no claims are watched. */
  readonly claims?: {
    live: () => readonly ClaimFacts[];
    release: (id: number, why: string) => boolean;
  };
  /** Dispatched Orca tasks whose worker is gone, and quiet PRs (the stuck-work probe). */
  readonly scan: () => Promise<StuckWork>;
  /** Open PRs of the bot's own repo with CI and reviewer state. */
  readonly ownPrs: () => Promise<{ readonly prs: readonly OwnPr[]; readonly problem?: string }>;
  readonly unanswered: (slackUserId: string, since: number, before: number) => readonly EndedThread[];
  readonly runTurn: (req: CoordinatorTurnRequest) => Promise<{ text: string; ran?: boolean } | undefined | void>;
  /** Minutes east of UTC the owner's day is read in. */
  readonly offsetMinutes: () => number;
  readonly quiet: { readonly startHour: number; readonly endHour: number };
  /** False while a restart drains: the tick holds. */
  readonly enabled?: () => boolean;
  readonly staleJourneyMs?: number;
  readonly repingMs?: number;
  readonly prefix: string;
  readonly log?: (msg: string) => void;
};

export type BlockerInput = {
  readonly key: string;
  readonly kind: BlockerKind;
  readonly text: string;
  readonly facts: BlockerFacts;
};

export type Coordinator = {
  /** One tick. Never throws, never overlaps itself. */
  tick: () => Promise<void>;
  /** A turn reports a wall; code routes it. The string is what the turn is told. */
  blocker: (input: BlockerInput) => Promise<string>;
  /** A line in today's digest. */
  act: (line: string) => Promise<void>;
  /** A prod item fixed under the self-fix rule: the digest line and one direct DM line. False (nothing posted) when no self-fix was granted for that key. */
  fixed: (key: string, line: string) => Promise<boolean>;
  /** What the coordinator holds right now, for `coordinator status`. */
  status: () => string;
};

const ref = (kind: string, id: string | number): string => `${kind}:${id}`;

export const createCoordinator = (deps: CoordinatorDeps): Coordinator => {
  const log = deps.log ?? (() => {});
  const staleMs = deps.staleJourneyMs ?? DEFAULT_STALE_JOURNEY_MS;
  const repingMs = deps.repingMs ?? DEFAULT_PROD_REPING_MS;
  let running = false;
  let turnRunning = false;

  const quietNow = (): boolean => inQuietHours(deps.clock(), deps.offsetMinutes(), deps.quiet.startHour, deps.quiet.endHour);
  /**
   * The coordinator's day starts when quiet hours end (05:00), not at midnight: what happens at 23:00 belongs to
   * the day that began that morning, so a line held for quiet hours is posted with that day's digest
   * instead of being stranded by the calendar rolling over. Without quiet hours it is the calendar day.
   */
  const dayAt = (at: number): string =>
    localDay(deps.quiet.startHour === deps.quiet.endHour ? at : at - deps.quiet.endHour * HOUR_MS, deps.offsetMinutes());
  const today = (): string => dayAt(deps.clock());

  /** The digest text last written per day, so an unchanged digest is not edited again. */
  const rendered = new Map<string, string>();

  /** One digest message per day, edited in place; the first post waits out quiet hours. */
  const refreshDigest = async (): Promise<void> => {
    // Yesterday's too: a line held through the night is posted with its own day, not lost to the rollover.
    for (const day of [dayAt(deps.clock() - DAY_MS), today()]) {
      const lines = deps.repo.lines(day);
      if (lines.length === 0) continue;
      const text = renderDigest(deps.name, day, lines, deps.offsetMinutes(), deps.repo.pending().length);
      if (text === rendered.get(day)) continue;
      const where = deps.repo.digest(day);
      if (where) {
        await deps.slack.update(where.channel, where.ts, text, deps.name);
        rendered.set(day, text);
        continue;
      }
      if (quietNow()) continue;
      const posted = await deps.slack.postDm(deps.ownerSlackId, text, deps.name);
      if (posted) {
        deps.repo.setDigest(day, posted.channel, posted.ts);
        rendered.set(day, text);
      }
    }
  };

  const act = async (line: string): Promise<void> => {
    const text = digestLine(line);
    if (!text) return;
    deps.repo.addLine(today(), deps.clock(), text);
    await refreshDigest().catch(logAndIgnore("coordinator digest"));
  };

  /** Put a blocker to the owner now: a new message, and the previous one (a prod re-ask) is settled. */
  const raise = async (b: CoordinatorBlocker): Promise<void> => {
    const posted = await deps.slack.postDmInteractive(
      deps.ownerSlackId,
      blockerText(deps.name, b, b.raisedCount),
      [
        { actionId: COORDINATOR_APPROVE_ACTION, label: "Approve", value: String(b.id), style: "primary" },
        { actionId: COORDINATOR_REJECT_ACTION, label: "Reject", value: String(b.id), style: "danger" },
      ],
      deps.name,
    );
    if (!posted) {
      log(`could not raise blocker ${b.id}; trying again next tick`);
      return;
    }
    const before = { channel: b.noticeChannel, ts: b.noticeTs };
    deps.repo.setNotice(b.id, posted.channel, posted.ts);
    deps.repo.raised(b.id, deps.clock());
    if (before.channel && before.ts) {
      await deps.slack
        .settleInteractive(before.channel, before.ts, `*${deps.name}* - blocker #${b.id} asked again below.`, deps.name)
        .catch(logAndIgnore("coordinator superseded blocker"));
    }
    await act(`${b.prod ? "prod " : ""}blocker #${b.id} (${b.kind}) put to you: ${b.text}`);
  };

  /** A pending blocker the coordinator fixed itself: closed, and the message that asked is settled so nobody presses it. */
  const closeAsked = async (b: CoordinatorBlocker, why: string): Promise<void> => {
    if (!deps.repo.close(b.id, deps.clock())) return;
    if (b.noticeChannel && b.noticeTs) {
      await deps.slack
        .settleInteractive(b.noticeChannel, b.noticeTs, `*${deps.name}* - blocker #${b.id} (${b.kind}): ${b.text}\n_${why}._`, deps.name)
        .catch(logAndIgnore("coordinator closed blocker"));
    }
    await act(`prod blocker #${b.id} closed: ${why}`);
  };

  const blocker = async (input: BlockerInput): Promise<string> => {
    const key = cleanKey(input.key);
    const text = digestLine(input.text);
    if (!key || !text) return "A blocker needs a key and a sentence of what is in the way. Nothing was raised.";
    const now = deps.clock();
    const prior = deps.repo.blockerByKey(key);
    const route: BlockerRoute = routeBlocker(input.facts, prior, now, { quiet: quietNow(), repingMs, kind: input.kind, text });
    if (route.route === "self-fix") {
      // The grant `fixed` checks, and the end of any earlier ask: an owner asked about something the coordinator is now fixing would be asked all night.
      deps.repo.mark("selffix", key, now);
      if (prior?.state === "pending") await closeAsked(prior, "now fixed by me (urgent, low-risk)");
      return `self-fix: prod, urgent and low-risk (reversible, no data write, no schema change, no secret or IAM change), inside the owner's role. Do it, then run \`${deps.prefix} coordinator fixed ${key} "<what you did>"\`.`;
    }
    const b = deps.repo.openBlocker({ key, kind: input.kind, prod: input.facts.prod, text }, now);
    if (route.route === "approve") {
      // Decided here, in code, from the facts and the sentence: never from anything a person wrote. It is handled on the spot
      // (the turn that asked is told below), so the next tick does not hand it over as one the owner approved.
      if (deps.repo.decide(b.id, "approved", now)) {
        deps.repo.markHandled(b.id, now);
        await act(`blocker #${b.id} (${b.kind}) approved by me (non-prod, low-risk, inside your role): ${b.text}`);
      }
      return `approved by me: non-prod, low-risk (reversible, no data write, no schema change, no secret or IAM change), inside the owner's role, no owner decision. Go ahead and do it; the owner was not asked.`;
    }
    if (route.route === "raise") {
      await raise(b);
      return input.facts.prod
        ? `raised to the owner (prod: they are asked again until they act). Do not repeat it. Leave it and move on.`
        : `raised to the owner once. Do not repeat it. Leave it and move on.`;
    }
    const why: Record<typeof route.why, string> = {
      "already-raised": "already put to the owner; they are not asked twice. Leave it.",
      decided: "the owner already decided it (see the digest). Act on that decision, do not raise it again.",
      "not-due": "already put to the owner a moment ago; it is asked again on its own. Leave it.",
      "quiet-hours": "held for quiet hours; it is put to the owner when they end. Leave it.",
    };
    return `held: ${why[route.why]}`;
  };

  const fixed = async (key: string, line: string): Promise<boolean> => {
    const k = cleanKey(key);
    // Only a self-fix `blocker` granted (in the last hours) can be reported: this line is not a way to post as the coordinator about anything.
    const granted = deps.repo.lastMark("selffix", k);
    if (granted === undefined || deps.clock() - granted > SELF_FIX_GRANT_MS) return false;
    const stored = deps.repo.blockerByKey(k);
    if (stored?.state === "pending") await closeAsked(stored, "fixed by me (urgent, low-risk)");
    await act(`prod fix by me (urgent, low-risk): ${line}`);
    // A direct line, quiet hours or not: a prod item was touched and the owner hears it.
    await deps.slack
      .postDm(deps.ownerSlackId, selfFixDmText(deps.name, k, line), deps.name)
      .catch(logAndIgnore("coordinator self-fix DM"));
    return true;
  };

  // ------------------------------------------------------------ the tick

  /** Items handed to the turn this tick; marked only once a turn really starts, so a held tick loses nothing. */
  let toMark: { kind: string; id: string }[] = [];

  /** True when `id` was not fed to a turn within `repeatMs`; queues the mark that records it. */
  const fresh = (kind: string, id: string, now: number, repeatMs: number): boolean => {
    const last = deps.repo.lastMark(kind, id);
    if (last !== undefined && now - last < repeatMs) return false;
    toMark.push({ kind, id });
    return true;
  };

  /** An action code took itself: marked at once so it is not taken twice. */
  const doneOnce = (kind: string, id: string, now: number, repeatMs: number): boolean => {
    const last = deps.repo.lastMark(kind, id);
    if (last !== undefined && now - last < repeatMs) return false;
    deps.repo.mark(kind, id, now);
    return true;
  };

  const journeysStep = async (now: number, picture: { staleJourneys: PictureItem[] }): Promise<void> => {
    for (const j of deps.journeys.list({ statuses: ["planned", "doing", "blocked"], limit: 100 })) {
      const action = journeyAction(j, now, staleMs);
      if (!action) continue;
      if (action.kind === "close") {
        deps.journeys.update(j.id, { status: "done", note: `closed by ${deps.name}: it sat at 100% and was never closed` }, now, COORDINATOR_ACTOR);
        await act(`closed journey #${j.id} "${j.title}": it sat at 100%`);
      } else if (picture.staleJourneys.length < PICTURE_CAP && fresh("nudge", ref("journey", j.id), now, NUDGE_REPEAT_MS)) {
        picture.staleJourneys.push({
          ref: `journey #${j.id}`,
          line: `${j.status} ${j.progress}%, quiet for ${ageLine(action.idleMs)} - "${j.title}"${j.now ? ` (now: ${j.now})` : ""}${j.prs.length > 0 ? ` ${j.prs.join(" ")}` : ""}`,
        });
      }
    }
  };

  const ticketsStep = async (now: number, picture: { replaceTickets: PictureItem[] }): Promise<void> => {
    const waiting = deps.watches.waiting();
    for (const t of deps.tickets.bound()) {
      const live = waiting.some((w) => watchesWorker(w.check, t.dispatchId));
      const action = ticketAction(t, now, live);
      if (!action) continue;
      if (action.kind === "renew") {
        const r = deps.tickets.renew(t.id, WORKER_TTL_DEFAULT_MS);
        if (r.ok) await act(`renewed worker ticket ${t.id} for ${t.dispatchId}${action.lapsed ? " (it had lapsed)" : ""}: good for ${ageLine(r.expiresAt - now)} more`);
        else if (picture.replaceTickets.length < PICTURE_CAP && fresh("nudge", ref("ticket", t.id), now, NUDGE_REPEAT_MS)) {
          picture.replaceTickets.push({ ref: `ticket ${t.id}`, line: `${t.dispatchId}: renewal refused (${r.error})` });
        }
      } else if (picture.replaceTickets.length < PICTURE_CAP && fresh("nudge", ref("ticket", t.id), now, NUDGE_REPEAT_MS)) {
        picture.replaceTickets.push({ ref: `ticket ${t.id}`, line: `${t.dispatchId}: at the end of its 24h life, the worker needs a new ticket` });
      }
    }
  };

  /** A `watch worker` that ran out under a worker nobody found dead is armed again, once a day per worker. */
  const watchesStep = async (now: number, deadDispatches: ReadonlySet<string>): Promise<void> => {
    const waiting = deps.watches.waiting();
    for (const w of deps.watches.lapsedSince(now - DAY_MS)) {
      const d = lapsedWorkerDispatch(w, dispatchIdsOf(w.check));
      if (!d || deadDispatches.has(d) || waiting.some((x) => watchesWorker(x.check, d))) continue;
      if (!doneOnce("rewatch", d, now, DAY_MS)) continue;
      const id = deps.watches.rearm(w, now);
      await act(`re-armed the lapsed watch on worker ${d} (#${w.id}, now #${id})`);
    }
  };

  /**
   * The writer claims: a claim whose worker is gone, or that never got one, is released here (the `watch worker` hook
   * normally does it at the worker's end), and two writers on one job are reported. Each finding is a digest line,
   * once a day per key and kind; nothing else is said, no turn is needed.
   */
  const claimsStep = async (now: number, dead: ReadonlySet<string>): Promise<void> => {
    if (!deps.claims) return;
    const live = deps.claims.live();
    if (live.length > 0) log(`live claims: ${live.map((c) => `${c.key} (${holderLine(c, now)})`).join("; ")}`);
    for (const f of claimFindings(live, dead, now)) {
      const key = f.kind === "duplicate" ? f.key : f.claim.key;
      if (!doneOnce(`claim-${f.kind}`, key, now, f.kind === "duplicate" ? NUDGE_REPEAT_MS : 0)) continue;
      if (f.kind !== "duplicate") deps.claims.release(f.claim.id, f.kind === "dead" ? "its worker is gone" : "never bound to a writer");
      await act(findingLine(f, now));
    }
  };

  const picturePrs = async (now: number, picture: { redPrs: PictureItem[]; chasePrs: PictureItem[] }): Promise<string | undefined> => {
    const { prs, problem } = await deps.ownPrs();
    const { red, chase } = prFindings(prs, now);
    for (const p of red) {
      if (picture.redPrs.length < PICTURE_CAP && fresh("nudge", ref("pr-red", p.number), now, NUDGE_REPEAT_MS)) picture.redPrs.push({ ref: `PR #${p.number}`, line: `${p.title} ${p.url}` });
    }
    for (const p of chase) {
      if (picture.chasePrs.length < PICTURE_CAP && fresh("nudge", ref("pr-chase", p.number), now, NUDGE_REPEAT_MS)) {
        picture.chasePrs.push({ ref: `PR #${p.number}`, line: `${p.title} ${p.url} - waiting on ${p.waitingOn.join(", ")} for ${ageLine(now - p.updatedAt)}` });
      }
    }
    return problem;
  };

  const raiseDue = async (now: number): Promise<void> => {
    const quiet = quietNow();
    for (const b of deps.repo.pending()) {
      if (blockerDue(b, now, quiet, repingMs)) await raise(b);
    }
  };

  const once = async (): Promise<void> => {
    if (deps.enabled && !deps.enabled()) return;
    const now = deps.clock();
    toMark = [];
    const picture = {
      staleJourneys: [] as PictureItem[],
      deadWorkers: [] as PictureItem[],
      replaceTickets: [] as PictureItem[],
      redPrs: [] as PictureItem[],
      chasePrs: [] as PictureItem[],
      unansweredThreads: [] as PictureItem[],
      approvedBlockers: [] as PictureItem[],
    };

    const scan = await deps.scan().catch((e: unknown) => {
      log(`scan failed: ${e instanceof Error ? e.message : String(e)}`);
      return undefined;
    });
    const dead = new Set<string>();
    for (const t of scan?.tasks ?? []) {
      if (t.dispatchId) dead.add(t.dispatchId);
      if (picture.deadWorkers.length < PICTURE_CAP && fresh("nudge", ref("task", t.taskId), now, WORKER_REPEAT_MS)) {
        picture.deadWorkers.push({ ref: `task ${t.taskId}${t.dispatchId ? ` (${t.dispatchId})` : ""}`, line: `${t.title}: ${t.why}` });
      }
    }

    await journeysStep(now, picture);
    await ticketsStep(now, picture);
    await watchesStep(now, dead);
    await claimsStep(now, dead);
    const prProblem = await picturePrs(now, picture).catch((e: unknown) => `open PRs not read: ${e instanceof Error ? e.message : String(e)}`);
    if (prProblem) log(prProblem);

    for (const t of deps.unanswered(deps.ownerSlackId, now - UNANSWERED_WINDOW_MS, now - UNANSWERED_AFTER_MS).slice(0, PICTURE_CAP)) {
      if (fresh("nudge", ref("thread", `${t.channelId}/${t.threadTs}`), now, NUDGE_REPEAT_MS)) {
        picture.unansweredThreads.push({ ref: `thread ${t.channelId} ${t.threadTs}`, line: `the owner's last message there is ${ageLine(now - t.lastAt)} old, nothing answered it` });
      }
    }

    await raiseDue(now);
    const approved = deps.repo.approvedUnhandled();
    for (const b of approved) {
      picture.approvedBlockers.push({ ref: `blocker #${b.id} (${b.kind})`, line: `${b.text} - the owner approved: go ahead as them` });
    }

    const handed: Picture = {
      ...emptyPicture,
      staleJourneys: picture.staleJourneys.slice(0, PICTURE_CAP),
      deadWorkers: picture.deadWorkers.slice(0, PICTURE_CAP),
      replaceTickets: picture.replaceTickets.slice(0, PICTURE_CAP),
      redPrs: picture.redPrs.slice(0, PICTURE_CAP),
      chasePrs: picture.chasePrs.slice(0, PICTURE_CAP),
      unansweredThreads: picture.unansweredThreads,
      approvedBlockers: picture.approvedBlockers,
    };
    // Judgment waits for morning when it may message people. Nothing is marked while it waits, so the same items are in the next tick's picture.
    if (pictureSize(handed) > 0 && !quietNow() && !turnRunning) startTurn(now, handed, approved, toMark);
    await refreshDigest().catch(logAndIgnore("coordinator digest"));
  };

  /** Not awaited: a turn can run half an hour and the tick must not hold the next one. */
  const startTurn = (now: number, picture: Picture, approved: readonly CoordinatorBlocker[], marks: readonly { kind: string; id: string }[]): void => {
    turnRunning = true;
    void (async () => {
      try {
        const channel = await deps.slack.openDm?.(deps.ownerSlackId);
        if (!channel) {
          log("no DM with the owner; the turn is not started");
          return;
        }
        const day = today();
        const reply = await deps.runTurn({
          channelId: channel,
          // One made-up thread per local day: a fresh session each morning that reads its state back, the same one through the day.
          threadTs: dayThreadTs(day),
          slackUserId: deps.ownerSlackId,
          text: coordinatorTurnText(deps.name, day, quietNow(), picture, deps.prefix),
          unprompted: true,
          loop: true,
          hold: true,
          reportRan: true,
          trigger: "loop",
        });
        // Marks and approvals are written only once the turn REALLY ran (a reply or NO_REPLY): one that threw, was
        // ignored, was busy or was cut for a restart (all of which resolve as nothing) leaves its picture to the next tick.
        if (reply?.ran) {
          for (const m of marks) deps.repo.mark(m.kind, m.id, now);
          for (const b of approved) deps.repo.markHandled(b.id, deps.clock());
        }
        const note = reply?.text.trim();
        if (note && !/no[_ ]reply/i.test(note)) await act(`note: ${note}`);
      } catch (e) {
        log(`turn failed: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        turnRunning = false;
      }
    })();
  };

  const claimLines = (): string => {
    const live = deps.claims?.live() ?? [];
    const now = deps.clock();
    return live.length === 0 ? "none" : live.map((c) => `${c.key} (${holderLine(c, now)})`).join("; ");
  };

  const status = (): string => {
    const day = today();
    const pending = deps.repo.pending();
    return [
      `*${deps.name}* - ${day}${quietNow() ? ", quiet hours" : ""}`,
      `- digest lines today: ${deps.repo.lines(day).length}`,
      `- blockers waiting on the owner: ${pending.length}${pending.length > 0 ? ` (${pending.map((b) => `#${b.id}${b.prod ? " prod" : ""}`).join(", ")})` : ""}`,
      ...(deps.claims ? [`- writer claims held: ${claimLines()}`] : []),
      `- a turn is ${turnRunning ? "running" : "not running"}`,
    ].join("\n");
  };

  return {
    tick: async () => {
      if (running) return;
      running = true;
      try {
        await once();
      } catch (e) {
        log(`tick failed: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        running = false;
      }
    },
    blocker,
    act,
    fixed,
    status,
  };
};

/** `1795000000.000042`: Slack-shaped, unique per local day, never shown (the made-up thread of the daily session; the suffix changed when the feature was renamed, so the first day after the upgrade starts a session that knows the new command). */
export const dayThreadTs = (day: string): string => {
  const [y, m, d] = day.split("-").map(Number);
  const secs = Math.floor(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1) / 1000);
  return `${secs}.000043`;
};
