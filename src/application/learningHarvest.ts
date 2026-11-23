/**
 * The learning harvest: the bot reviews its recent conversations and proposes
 * what is worth keeping. The owner decides every proposal; nothing is saved
 * until they press Approve.
 *
 * Off by default (`learning_harvest` setting, `harvest on|off`). Like the inner
 * child it rides the watcher's timer, outside every turn, reads only the turns
 * that ended since its cursor, never catches up on a backlog, and spends one
 * small-model call per batch. It is its own timer rather than a part of the
 * inner child because the two differ in what they need and what they risk: the
 * inner child needs a channel and may change the bot's source, the harvest
 * needs none and can only ever ask. Sharing a switch would make turning one on
 * turn the other on.
 *
 * One batch yields facts and skill drafts:
 * - a fact goes through `proposeLearning`: pending, never injected, put to the
 *   owner with Approve / Reject, deduped against every learning ever asked
 * - a skill draft (new, or a patch shown as a diff) is its own row and its own
 *   DM; Approve writes it into the adapter the way a hand edit does, Reject is
 *   remembered by name so it is not raised again
 *
 * The guards are code, not the prompt (see `domain/harvest.ts`): a proposal must
 * quote a person's own words from the turn it cites, so what the bot merely read
 * can never be a source; a secret or personal data drops it; a private source
 * (or one Slack will not describe) can only produce a fact scoped to its own
 * channel and never a skill; a daily cap, a per-batch cap and a pending cap
 * bound the owner's attention.
 */
import {
  HARVEST_APPROVE_ACTION,
  HARVEST_BATCH,
  HARVEST_MIN_TURNS,
  HARVEST_PER_BATCH,
  HARVEST_PER_DAY,
  HARVEST_REJECT_ACTION,
  HARVEST_SOURCE,
  MAX_PENDING_DRAFTS,
  draftRefusal,
  draftShown,
  draftText,
  fitsNotice,
  harvestMessage,
  harvestSystem,
  normalise,
  parseProposals,
  quoteGrounded,
  sensitiveProblem,
  settledDraftText,
  skillFingerprint,
  skillPath,
  skillProblem,
  writtenByPerson,
  type FactProposal,
  type HarvestTurn,
  type KnownSkill,
  type SkillProposal,
} from "../domain/harvest.ts";
import { CHANNELS_DIR, NOTES_FILE, PEOPLE_DIR } from "../domain/adapter.ts";
import { GLOBAL_SCOPE, oneLine, proposalProblem, type LearningScope } from "../domain/learning.ts";
import { SIGNATURES } from "../domain/messageFooter.ts";
import { noticeFingerprint } from "../domain/noticeFingerprint.ts";
import type { LearningsRepo } from "../infrastructure/db/learningsRepo.ts";
import type { MessageRepo } from "../infrastructure/db/messageRepo.ts";
import type { SkillDraft, SkillDraftRepo } from "../infrastructure/db/skillDraftRepo.ts";
import type { TurnLogRepo } from "../infrastructure/db/turnLogRepo.ts";
import { type AdapterDeps, editAdapterFile } from "./adapterMemory.ts";
import { CURSOR_MAX_AGE_MS, TRIAGE_MODEL } from "./innerChild.ts";
import { logAndIgnore } from "./ignoredError.ts";
import { proposeLearning, type LearningApprovalDeps } from "./learningApproval.ts";
import type { Clock, LlmPort } from "./ports.ts";
import type { SlackAdminPort } from "./slackAdmin.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

/** The harvest looks this often by default. */
export const HARVEST_EVERY_MS = 30 * 60 * 1000;
/** Facts and drafts shown to the model as already known: the newest few of each. */
const KNOWN_IN_PROMPT = 40;

export type HarvestDeps = {
  turns: Pick<TurnLogRepo, "since">;
  messages: Pick<MessageRepo, "recentForThread">;
  learnings: Pick<LearningsRepo, "all">;
  /** Where a fact is proposed: the ordinary pending-approval path. */
  learningApproval: LearningApprovalDeps;
  drafts: SkillDraftRepo;
  /** The live memory adapter, read per call; without one there is nowhere to put a skill. */
  adapter: () => AdapterDeps | undefined;
  slack?: Pick<SlackAdminPort, "conversationInfo" | "postDmInteractive" | "permalink">;
  llm: LlmPort;
  clock: Clock;
  ownerSlackId: string;
  botName: () => string;
  /** Tools denied to the review run: it reads text, it never acts. */
  noTools: readonly string[];
  /** Off switch, read every tick. Absent settings mean off. */
  enabled: () => boolean;
  /** Model the review runs on. Read every tick; empty or absent = the inner child's triage model. */
  model?: () => string | undefined;
  /** Where the last review stopped, so a restart does not re-read or skip. */
  cursor: { get: () => number | undefined; set: (at: number) => void };
  /** A thread that is never reviewed (the inner child's own fix threads). */
  skip?: (channelId: string, threadTs: string) => boolean;
  everyMs?: number;
  maxPerDay?: number;
  maxPerBatch?: number;
  minTurns?: number;
  log?: (msg: string) => void;
};

export type LearningHarvest = {
  tick: () => Promise<void>;
};

/** What a fact or skill already known looks like once folded, so a reworded copy still matches. */
const foldedLines = (adapter: AdapterDeps | undefined): string[] => {
  if (!adapter) return [];
  const out: string[] = [];
  for (const [path, text] of adapter.store.files()) {
    if (path !== NOTES_FILE && !path.startsWith(`${CHANNELS_DIR}/`) && !path.startsWith(`${PEOPLE_DIR}/`)) continue;
    for (const line of text.split("\n")) {
      const m = /^\s*[-*]\s+(.+)$/.exec(line);
      if (m?.[1]) out.push(m[1]);
    }
  }
  return out;
};

export const createLearningHarvest = (deps: HarvestDeps): LearningHarvest => {
  const log = deps.log ?? (() => {});
  const every = deps.everyMs ?? HARVEST_EVERY_MS;
  const perDay = deps.maxPerDay ?? HARVEST_PER_DAY;
  const perBatch = deps.maxPerBatch ?? HARVEST_PER_BATCH;
  const minTurns = deps.minTurns ?? HARVEST_MIN_TURNS;
  let running = false;
  let lastRun = 0;

  // The turn's stored answer, bounded by its end as well as its start (see the
  // inner child: a thread's turns run one at a time and the reply is stored
  // before the turn is logged).
  const replyTo = (channelId: string, threadTs: string, startedAt: number, endedAt: number): string => {
    const during = deps.messages
      .recentForThread(channelId, threadTs, 10)
      .filter((m) => m.role === "assistant" && m.createdAt >= startedAt && m.createdAt <= endedAt);
    return during[during.length - 1]?.content ?? "";
  };

  /** A public channel is the only source whose content may reach other channels. Anything else - a private channel, a DM, or one Slack will not describe - counts as private. */
  const publicCache = new Map<string, boolean>();
  const isPublic = async (channelId: string): Promise<boolean> => {
    const hit = publicCache.get(channelId);
    if (hit !== undefined) return hit;
    const info = await deps.slack?.conversationInfo?.(channelId).catch(logAndIgnore("harvest conversation info"));
    const open = info?.kind === "channel";
    publicCache.set(channelId, open);
    return open;
  };

  const proposedSince = (since: number): number =>
    deps.learnings.all().filter((l) => l.createdBy === HARVEST_SOURCE && l.createdAt >= since).length + deps.drafts.countSince(since);

  const proposeFact = async (p: FactProposal, t: HarvestTurn, known: Set<string>): Promise<boolean> => {
    const text = oneLine(p.fact);
    const bad = proposalProblem(text) ?? sensitiveProblem(text);
    if (bad) {
      log(`dropped a fact: ${bad}`);
      return false;
    }
    if (known.has(normalise(text))) return false;
    // A fact leaves its channel only from a public one, and only when the model says it holds everywhere.
    const scope: LearningScope = (await isPublic(t.channelId)) && p.scope === "global" ? GLOBAL_SCOPE : [t.channelId];
    const r = await proposeLearning(deps.learningApproval, text, HARVEST_SOURCE, { channel: t.channelId, threadTs: t.threadTs, runId: "" }, scope);
    if (!r.ok) {
      log(`fact not proposed: ${r.error}`);
      return false;
    }
    known.add(normalise(text));
    return true;
  };

  const askOwner = async (d: SkillDraft, shown: string): Promise<boolean> => {
    if (!deps.slack?.postDmInteractive) return false;
    const link = d.sourceChannel && d.sourceThreadTs ? await deps.slack.permalink?.(d.sourceChannel, d.sourceThreadTs).catch(logAndIgnore("harvest source permalink")) : undefined;
    const posted = await deps.slack
      .postDmInteractive(
        deps.ownerSlackId,
        draftText({ id: d.id, name: d.name, patch: d.base !== undefined, shown, ...(link ? { sourceLink: link } : {}) }),
        [
          { actionId: HARVEST_APPROVE_ACTION, label: "Approve", value: String(d.id), style: "primary" },
          { actionId: HARVEST_REJECT_ACTION, label: "Reject", value: String(d.id), style: "danger" },
        ],
        SIGNATURES.harvest,
      )
      .catch(logAndIgnore("harvest skill draft post"));
    if (!posted?.fingerprint) return false;
    deps.drafts.setNotice(d.id, posted.channel, posted.ts, posted.fingerprint);
    return true;
  };

  const proposeSkill = async (p: SkillProposal, t: HarvestTurn, now: number): Promise<boolean> => {
    // A skill loads in every channel, so only a public source may write one.
    if (!(await isPublic(t.channelId))) {
      log("dropped a skill draft: its source is not a public channel");
      return false;
    }
    const adapter = deps.adapter();
    if (!adapter) return false;
    const base = adapter.store.files().get(skillPath(p.name));
    const bad = skillProblem(p.name, p.content, base);
    const shown = draftShown(base, p.content);
    if (bad || !fitsNotice(shown)) {
      log(`dropped a skill draft ${p.name}: ${bad ?? "it does not fit one notice"}`);
      return false;
    }
    const fingerprint = skillFingerprint(p.name, p.content);
    if (deps.drafts.seen(fingerprint) || deps.drafts.blockedNames().includes(p.name)) return false;
    if (deps.drafts.pending().length >= MAX_PENDING_DRAFTS) {
      log(`${MAX_PENDING_DRAFTS} skill drafts are already waiting for the owner`);
      return false;
    }
    const d = deps.drafts.add({ fingerprint, name: p.name, content: p.content, base, sourceChannel: t.channelId, sourceThreadTs: t.threadTs }, now);
    if (!(await askOwner(d, shown))) {
      // Never leave a pending row the owner cannot see: it would block the name for ever.
      deps.drafts.discard(d.id);
      log(`skill draft ${p.name}: the owner DM did not go out`);
      return false;
    }
    log(`skill draft #${d.id} ${p.name} proposed, pending the owner`);
    return true;
  };

  const harvest = async (now: number): Promise<void> => {
    // A channel can change kind between looks: ask again each time.
    publicCache.clear();
    const cursor = deps.cursor.get();
    // The first look starts from now, and a long pause is skipped, not caught up on.
    if (cursor === undefined) {
      deps.cursor.set(now);
      return;
    }
    if (now - cursor > CURSOR_MAX_AGE_MS) {
      log(`cursor ${new Date(cursor).toISOString()} is older than 6h, skipping the backlog`);
      deps.cursor.set(now);
      return;
    }
    if (proposedSince(now - DAY_MS) >= perDay) return;

    const entries = deps.turns
      .since(cursor + 1, HARVEST_BATCH)
      .filter((t) => t.endedAt > cursor && t.kind === "chat" && t.outcome === "ok" && !!t.threadTs && writtenByPerson(t.request) && !deps.skip?.(t.channelId, t.threadTs));
    // Too few to be worth a call: they stay past the cursor and join the next look.
    if (entries.length < minTurns) return;
    // Moved on before the model runs: a review that keeps failing must not pay for the same batch every run.
    deps.cursor.set(entries.reduce((max, t) => Math.max(max, t.endedAt), cursor));

    const turns: HarvestTurn[] = [...entries].reverse().map((t) => ({
      channelId: t.channelId,
      threadTs: t.threadTs,
      slackUserId: t.slackUserId,
      request: t.request,
      reply: replyTo(t.channelId, t.threadTs, t.startedAt, t.endedAt),
    }));

    const all = deps.learnings.all();
    const adapter = deps.adapter();
    const known = new Set([...all.map((l) => normalise(l.content)), ...foldedLines(adapter).map(normalise)]);
    const skills: KnownSkill[] = (adapter?.store.load().skills ?? []).map((s) => ({ name: s.name, description: s.description }));
    const rejected = [
      ...all.filter((l) => l.status === "rejected").map((l) => l.content),
      ...deps.drafts.blockedNames().map((n) => `skill ${n}`),
    ];
    let raw = "";
    try {
      raw = await deps.llm.complete({
        system: harvestSystem(deps.botName()),
        messages: [
          {
            role: "user",
            content: harvestMessage(turns, {
              facts: [...all.filter((l) => l.status !== "rejected").map((l) => l.content), ...foldedLines(adapter)].slice(-KNOWN_IN_PROMPT),
              skills,
              rejected: rejected.slice(-KNOWN_IN_PROMPT),
            }),
            speakerId: deps.ownerSlackId,
          },
        ],
        policy: { skipPermissions: false, disallowedTools: deps.noTools, model: deps.model?.()?.trim() || TRIAGE_MODEL },
        bill: { actor: deps.ownerSlackId, kind: "harvest" },
      });
    } catch (e) {
      log(`review failed: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }

    let raised = 0;
    for (const p of parseProposals(raw)) {
      if (raised >= perBatch || proposedSince(now - DAY_MS) >= perDay) break;
      const t = turns[p.turn - 1];
      // The one check that keeps text the bot only read out of a proposal: the quote is in what a person wrote.
      if (!t || !quoteGrounded(p.quote, t.request)) {
        log(`dropped a ${p.kind} proposal: its quote is not in what a person wrote`);
        continue;
      }
      const made = p.kind === "fact" ? await proposeFact(p, t, known) : await proposeSkill(p, t, now);
      if (made) raised += 1;
    }
    if (raised) log(`proposed ${raised} item(s) to the owner`);
  };

  return {
    tick: async () => {
      if (running || !deps.enabled()) return;
      const now = deps.clock();
      if (now - lastRun < every) return;
      running = true;
      lastRun = now;
      try {
        await harvest(now);
      } catch (e) {
        log(`review failed: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        running = false;
      }
    },
  };
};

export type SkillDraftApprovalDeps = {
  drafts: SkillDraftRepo;
  adapter: () => AdapterDeps | undefined;
  slack?: Pick<SlackAdminPort, "settleInteractive">;
  clock: Clock;
  ownerSlackId: string;
  log?: (msg: string) => void;
};

export type DraftPressOutcome =
  | { readonly kind: "unknown" }
  | { readonly kind: "refused"; readonly why: "not-owner" | "forged"; readonly id: number }
  | { readonly kind: "decided"; readonly id: number; readonly state: SkillDraft["state"] }
  | { readonly kind: "failed"; readonly id: number; readonly violations: readonly string[] }
  | { readonly kind: "approved" | "rejected"; readonly id: number };

/**
 * The owner's Approve / Reject on a skill draft, decided in code like every
 * approval button: a model turn never sees these buttons, because a model that
 * could press its own Approve would make the gate decorative. Honoured only on
 * the message the draft was posted with, untouched (the whole message, text and
 * buttons, must match what was last rendered), and only from the owner.
 *
 * Approve writes the draft through `editAdapterFile`, the same gate a hand edit
 * goes through, against the file it was written against: a skill that changed
 * since is refused and the draft stays pending. Filed first, claimed second, so
 * a refused write leaves the draft pending.
 */
export const decideSkillDraftPress = async (
  deps: SkillDraftApprovalDeps,
  press: {
    slackUserId: string;
    actionId: string;
    value: string;
    channel?: string;
    messageTs?: string;
    edited?: boolean;
    /** The pressed message's blocks as Slack sent them back. */
    blocks?: readonly unknown[];
  },
): Promise<DraftPressOutcome> => {
  if (press.actionId !== HARVEST_APPROVE_ACTION && press.actionId !== HARVEST_REJECT_ACTION) return { kind: "unknown" };
  const id = Number(press.value);
  const d = Number.isInteger(id) ? deps.drafts.get(id) : undefined;
  if (!d) return { kind: "unknown" };
  const untouched =
    !!d.noticeChannel &&
    !!d.noticeTs &&
    !!d.noticeFingerprint &&
    press.channel === d.noticeChannel &&
    press.messageTs === d.noticeTs &&
    !press.edited &&
    press.blocks !== undefined &&
    noticeFingerprint(press.blocks) === d.noticeFingerprint;
  if (!untouched) {
    deps.log?.(`skill draft #${d.id} press refused: not the untouched approval DM`);
    return { kind: "refused", why: "forged", id: d.id };
  }
  if (press.slackUserId !== deps.ownerSlackId) return { kind: "refused", why: "not-owner", id: d.id };
  if (d.state !== "pending") return { kind: "decided", id: d.id, state: d.state };

  const approve = press.actionId === HARVEST_APPROVE_ACTION;
  if (approve) {
    const adapter = deps.adapter();
    if (!adapter) return { kind: "failed", id: d.id, violations: ["there is no memory adapter to put a skill in"] };
    const problem = skillProblem(d.name, d.content, d.base);
    if (problem) return { kind: "failed", id: d.id, violations: [problem] };
    const r = editAdapterFile(adapter, skillPath(d.name), d.content, press.slackUserId, d.base ?? "", `harvest skill: ${d.name}`);
    if (!r.ok) return { kind: "failed", id: d.id, violations: r.violations };
  }
  if (!deps.drafts.decide(d.id, approve ? "approved" : "rejected", deps.clock())) return { kind: "decided", id: d.id, state: d.state };
  deps.log?.(`skill draft #${d.id} ${approve ? "approved" : "rejected"} by ${press.slackUserId}`);
  await deps.slack
    ?.settleInteractive(
      d.noticeChannel,
      d.noticeTs,
      settledDraftText(approve ? "approved" : "rejected", { id: d.id, name: d.name, patch: d.base !== undefined, shown: draftShown(d.base, d.content) }, press.slackUserId),
      SIGNATURES.harvest,
    )
    .catch(logAndIgnore("skill draft settle"));
  return { kind: approve ? "approved" : "rejected", id: d.id };
};

/** What an owner who pressed the wrong thing is told, privately. */
export const draftPressNotice = (o: DraftPressOutcome): string | undefined =>
  o.kind === "refused"
    ? draftRefusal(o.why)
    : o.kind === "failed"
      ? draftRefusal("failed", o.violations.join("; "))
      : o.kind === "decided"
        ? `Skill draft #${o.id} is already ${o.state}. Nothing changed.`
        : undefined;
