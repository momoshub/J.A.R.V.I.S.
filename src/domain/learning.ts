/**
 * Learnings need the owner's approval.
 *
 * A learning is injected into every future reply, in every channel, for
 * everyone, so whoever can write one controls the bot for good: one prompt
 * injection that makes the agent POST a learning poisons it permanently. Only
 * the owner typing `learn <fact>` themselves is saved active. Everything else
 * (a member's `learn`, the agent's `learn` or POST to the learnings API, in
 * any turn) is stored PENDING, never reaches a prompt, and waits for the
 * owner's Approve / Reject.
 *
 * Pure: wording, the `learn` argument grammar and the rules of a decision.
 */
import { escapeForSlack } from "./loop.ts";

/** `pending` waits for the owner and is never injected; only `active` reaches a prompt. */
export type LearningStatus = "pending" | "active" | "rejected";

/** Who a learning is credited to when the agent wrote it, through the API or the run bridge. */
export const AGENT_SOURCE = "agent";

/** One sentence: the whole fact has to fit the approval DM the owner decides on. */
export const MAX_LEARNING_CHARS = 1000;

/** A proposal shorter than this is not a fact the owner can judge ("list" once reached the approval DM). */
export const MIN_LEARNING_WORDS = 3;

/** Why a proposed fact cannot be put to the owner, or null when it can. */
export const proposalProblem = (text: string): string | null => {
  if (!text) return "Empty learning";
  if (text.length > MAX_LEARNING_CHARS) return `Too long (${text.length} characters, at most ${MAX_LEARNING_CHARS}). One sentence.`;
  if (text.split(/\s+/).length < MIN_LEARNING_WORDS) {
    return `Too short to be a fact ("${text}"). One full sentence, at least ${MIN_LEARNING_WORDS} words.`;
  }
  return null;
};

/** Button ids. `jv:` like every element of ours, but decided in code, never handed to the model. */
export const LEARNING_ACTION_PREFIX = "jv:learning:";
export const LEARNING_APPROVE_ACTION = `${LEARNING_ACTION_PREFIX}approve`;
export const LEARNING_REJECT_ACTION = `${LEARNING_ACTION_PREFIX}reject`;

/** The turn that proposed a learning: where it ran, and the session id it sent (empty when none). */
export type LearningSource = {
  readonly channel: string;
  /** The thread the turn answers in: its thread, or the message that started it. Empty when unknown. */
  readonly threadTs: string;
  readonly runId: string;
};

/**
 * Where a learning applies: the channel ids it is injected in, empty for global
 * (every channel - what every learning was before scopes, and the default).
 */
export type LearningScope = readonly string[];

export const GLOBAL_SCOPE: LearningScope = [];

/** A Slack channel, private channel or DM id. */
const CHANNEL_ID = /^[CGD][A-Z0-9]{8,}$/;

/** `<#C123|name>`, `<#C123>` or a bare id, as a channel id; undefined for anything else. */
export const channelIdOf = (token: string): string | undefined =>
  /^<#([CGD][A-Z0-9]{8,})(?:\|[^>]*)?>$/.exec(token)?.[1] ?? (CHANNEL_ID.test(token) ? token : undefined);

/** Does a learning with this scope reach a turn in `channel`? A turn with no known channel only gets global ones. */
export const appliesIn = (scope: LearningScope, channel?: string): boolean =>
  scope.length === 0 || (!!channel && scope.includes(channel));

/** Stored form: comma-separated, deduplicated, empty for global. */
export const serializeScope = (scope: LearningScope): string => [...new Set(scope)].join(",");

export const parseStoredScope = (raw: string): LearningScope => raw.split(",").map((c) => c.trim()).filter(Boolean);

/** For the owner's notice and lists. Ids in code ticks, never a `<#C..>` mention: Slack echoes those back in another form and the press check compares the notice whole. */
export const scopeLabel = (scope: LearningScope): string =>
  scope.length === 0 ? "global (every channel)" : `only in ${scope.map((c) => `\`${c}\``).join(", ")}`;

/**
 * The scope words of `learn approve <id> <scope>`: `global`, or channel ids /
 * mentions only. Anything else is undefined, so "approve 3 people for access"
 * stays a fact instead of a malformed command.
 */
export const scopeFromWords = (words: readonly string[]): LearningScope | undefined => {
  if (words.length === 1 && (words[0] ?? "").toLowerCase() === "global") return GLOBAL_SCOPE;
  const ids = words.map(channelIdOf);
  return words.length > 0 && ids.every((c) => c !== undefined) ? [...new Set(ids as string[])] : undefined;
};

/**
 * The scope a proposal asks for, as the API receives it: absent or `global` is
 * global, `channel` is the channel of the turn that proposes it (the proposer
 * marking it channel-specific), or an explicit list of channel ids.
 */
export const proposedScope = (
  input: unknown,
  sourceChannel?: string,
): { readonly ok: true; readonly scope: LearningScope } | { readonly ok: false; readonly error: string } => {
  if (input === undefined || input === null || input === "" || input === "global") return { ok: true, scope: GLOBAL_SCOPE };
  if (input === "channel") {
    return sourceChannel
      ? { ok: true, scope: [sourceChannel] }
      : { ok: false, error: 'scope "channel" needs the turn\'s run ticket (X-Jarvis-Ticket) so I know which channel it is. Send an explicit list of channel ids, or leave scope out for global.' };
  }
  if (Array.isArray(input) && input.length > 0 && input.length <= 10) {
    const ids = input.map((c) => (typeof c === "string" ? channelIdOf(c.trim()) : undefined));
    if (ids.every((c) => c !== undefined)) return { ok: true, scope: [...new Set(ids as string[])] };
  }
  return { ok: false, error: 'scope must be "global", "channel", or a list of 1-10 channel ids' };
};

/** A fact on one line, the way it is stored and shown. */
export const oneLine = (fact: string): string => fact.trim().replace(/\s*\n+\s*/g, " ");

/**
 * The wordings a typed fact may be stored under. Slack hands a command over
 * escaped (`&amp;`, `&lt;`, `<url|label>`), and a fact typed through `learn` is
 * stored that way, while one that came through the API is stored raw; so the
 * typed text and its decoded form are both tried, in that order.
 */
export const factWordings = (typed: string): readonly string[] => {
  const one = oneLine(typed);
  const decoded = one
    .replace(/<([^<>|]+)\|[^<>]*>/g, "$1")
    .replace(/<([^<>]+)>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
  return decoded === one ? [one] : [one, decoded];
};

export type LearnArgs =
  | { readonly kind: "fact"; readonly text: string }
  | { readonly kind: "pending" }
  /** `scope` set by `approve <id> global|<channels>`: the owner changes where it applies as they approve. */
  | { readonly kind: "approve"; readonly id: number; readonly scope?: LearningScope }
  | { readonly kind: "reject"; readonly id: number }
  /** `approve` / `reject` with no id: a usage line, never a fact. */
  | { readonly kind: "usage"; readonly verb: "approve" | "reject" };

/**
 * What follows `learn`. `pending`, `approve <id>` and `reject <id>` are the
 * owner's subcommands; anything else is a fact, so "approve of the new
 * process" is still teachable. Only the exact shapes are subcommands, which is
 * also what lets a non-owner be refused them instead of saving "approve 3".
 */
export const parseLearnArgs = (rest: string): LearnArgs => {
  const text = rest.trim();
  const words = text.split(/\s+/).filter(Boolean);
  const verb = (words[0] ?? "").toLowerCase();
  if (words.length === 1 && verb === "pending") return { kind: "pending" };
  if (verb === "approve" || verb === "reject") {
    if (words.length === 1) return { kind: "usage", verb };
    const id = /^#?(\d+)$/.exec(words[1] ?? "");
    if (words.length === 2 && id) return { kind: verb, id: Number(id[1]) };
    const scope = verb === "approve" && id ? scopeFromWords(words.slice(2)) : undefined;
    if (scope && id) return { kind: "approve", id: Number(id[1]), scope };
  }
  return { kind: "fact", text };
};

/** The line of the approval DM that shows the fact: a press counts only while the pressed message still shows it. */
export const approvalCore = (content: string): string => `> ${escapeForSlack(oneLine(content))}`;

const whoAsked = (by: string): string => (by === AGENT_SOURCE || !by ? "one of my turns" : `<@${by}>`);

/**
 * The DM the owner decides on. The fact is escaped, so it cannot render a link or a mention.
 * Its icons are written as shortcodes: Slack hands block text back with emoji as `:shortcode:`,
 * so a unicode 🧠 here never matched the fingerprint of the pressed message.
 */
export const approvalText = (
  id: number,
  content: string,
  by: string,
  sourceLink?: string,
  scope: LearningScope = GLOBAL_SCOPE,
): string =>
  [
    `:brain: ${whoAsked(by)} wants me to remember this (learning #${id}). It is NOT part of my memory until you approve it:`,
    approvalCore(content),
    `Scope: ${scopeLabel(scope)}. Approve adds it to what I carry into ${scope.length === 0 ? "every reply, in every channel" : "replies there"}. Reject discards it.`,
    `To change the scope, approve by typing \`learn approve ${id} global\` or \`learn approve ${id} <channel id>\` instead of the button.`,
    ...(sourceLink ? [`Proposed in <${sourceLink}|this thread>.`] : []),
  ].join("\n");

export const settledText = (kind: "approved" | "rejected", id: number, content: string, by: string): string =>
  `${kind === "approved" ? ":white_check_mark:" : ":x:"} learning #${id} ${kind} by <@${by}>\n${approvalCore(content)}`;

/** What the typed `learn` says back when the fact is parked for the owner. */
export const pendingReply = (id: number, prefix: string): string =>
  `Saved as pending (#${id}). It is NOT part of my memory yet - the owner has to approve it first (\`${prefix} learn approve ${id}\`, or the buttons in their DM).`;

/**
 * What the API tells the agent that posted a learning. The agent reads this
 * and relays it, so it says plainly that nothing was saved yet.
 */
export const pendingApiMessage = (id: number): string =>
  `Pending owner approval (#${id}). This is NOT saved yet and changes nothing in any reply until the owner approves it. Do not tell anyone you saved it: say it is waiting for the owner's approval.`;

/** Why a decision, typed or pressed, did not go through. */
export type DecisionRefusal = "not-owner" | "from-turn" | "unknown" | "decided" | "forged";

export const refusalText = (r: DecisionRefusal, id?: number): string =>
  r === "not-owner"
    ? "Only the owner can approve, reject or list pending learnings."
    : r === "from-turn"
      ? "Approving or rejecting a learning is the owner's own typed line or button, never something I run for myself."
      : r === "decided"
        ? `Learning #${id} was already answered.`
        : r === "forged"
          ? "That button is not on the approval DM I posted for this learning, so it changed nothing."
          : `I have no pending learning #${id}. \`learn pending\` lists them.`;
