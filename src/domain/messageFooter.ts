/**
 * The grey line under a message this process writes into its own thread: who
 * wrote it, what started the turn, and what the turn cost.
 *
 * Asked for by Kai after a thread filled with messages from Jarvis, the inner
 * child, a watch firing and a reminder, all under the same bot name - there was
 * no telling which part of the process had said what. So a message in the
 * session's own thread carries a signature.
 *
 * One line: `Jarvis · triggered by <kind> · <usage, when a turn reported it>`.
 * There is no "updated <time>" stamp: an edit keeps or rebuilds the footer as
 * it was (Kai, 2026-11-27). `triggered by <kind>` (nudge, tell, watch,
 * loop, orca) appears only when one of the bot's own senders started the turn
 * and named itself (`InboundMessage.trigger`, set by `runTurn` / the drift
 * steer / the loop runner's DM) - never guessed from the text, since a person
 * can type a look-alike opening. A chat turn's footer is unchanged.
 *
 * A message that goes anywhere but the turn's own thread (the `post` command,
 * a console post or edit, a write the model makes into another thread through
 * the Slack proxy) gets no footer at all: `by` of `UNSIGNED` on
 * `SlackAdminPort.post` / `update` leaves it off.
 *
 * The footer is a context block with a fixed `block_id`, which is how a rebuild
 * replaces it rather than stacking a second one.
 */
import { type Block, MAX_BLOCKS } from "./blockKit.ts";
import type { InternalKind } from "./internalMessages.ts";
import { SECTION_LIMIT, toSlackMarkdown } from "./slackFormat.ts";

/** Who signs what. Anything not listed here is plain Jarvis. */
export const SIGNATURES = {
  jarvis: "Jarvis",
  innerChild: "inner child Jarvis",
  workflowWorker: "workflow worker",
  workflowFront: "workflow front",
  command: "command",
  watch: "watch",
  reminder: "reminder",
  loop: "loop",
  learning: "learning",
  bugReport: "bug report",
  harvest: "learning harvest",
  reviewInbox: "review inbox",
  githubApp: "GitHub app",
  offlineAlarm: "offline alarm",
  stuckSweeper: "stuck-work sweeper",
} as const;

/** `by` for a post or edit that is not in the turn's own thread: no footer at all. */
export const UNSIGNED = null;

/** Marks the footer's context block, so a rebuild finds and replaces it. */
export const FOOTER_BLOCK_ID = "jv_footer";

/** The host's offset east of UTC at `ms`, in minutes (DST-aware). */
export const hostOffsetMin = (ms: number): number => -new Date(ms).getTimezoneOffset();

/**
 * `triggered by watch`: what started a turn that no person chatted. A brief
 * starts no turn, and no kind (a chat turn) says nothing.
 */
export const triggerLabel = (kind?: InternalKind): string | undefined =>
  kind && kind !== "brief" ? `triggered by ${kind}` : undefined;

/**
 * The whole line: signature, then what triggered the turn when it was not a
 * person chatting, then what the turn reported (model, tokens, cost, time).
 */
export const footerLine = (by: string, detail?: string, trigger?: InternalKind): string =>
  [by.trim() || SIGNATURES.jarvis, triggerLabel(trigger), detail?.trim()].filter(Boolean).join(" · ");

/** The footer as its own context block. */
export const footerBlock = (line: string): Block => ({
  type: "context",
  block_id: FOOTER_BLOCK_ID,
  elements: [{ type: "mrkdwn", text: line }],
});

/** Any block shape: Slack hands blocks back as loose records. */
type AnyBlock = Record<string, unknown>;

const isFooter = (b: AnyBlock): boolean => b.block_id === FOOTER_BLOCK_ID;

/**
 * `blocks` with the footer at the end. A footer already there is replaced, not
 * stacked, and the content is clipped so the footer still fits Slack's 50.
 * No `line` (an unsigned message): no footer, and a stale one is dropped too.
 */
export const withFooter = <T extends AnyBlock>(blocks: readonly T[], line?: string): (T | Block)[] =>
  line === undefined
    ? blocks.filter((b) => !isFooter(b)).slice(0, MAX_BLOCKS)
    : [...blocks.filter((b) => !isFooter(b)).slice(0, MAX_BLOCKS - 1), footerBlock(line)];

/**
 * What `chat.update` must send to put the footer under a message that is already posted (a turn's own post, whose
 * closing reply was dropped): its own blocks kept and the footer last, or - for a plain text post - the text as
 * blocks (`signedText`). `undefined` when it already carries a footer, or has nothing to build one on.
 */
export const footerUpdate = (message: { text?: string; blocks?: readonly AnyBlock[] }, line: string): { text: string; blocks: (AnyBlock | Block)[] } | undefined => {
  const blocks = message.blocks ?? [];
  if (blocks.some(isFooter)) return undefined;
  if (blocks.length > 0) return { text: message.text?.trim() ? message.text : " ", blocks: withFooter(blocks, line) };
  return message.text?.trim() ? signedText(message.text, line) : undefined;
};

const FENCE = /^\s*```/;
const FENCE_ROOM = 8; // "```\n" reopened at the top of a chunk + "\n```" closing it

/**
 * Text cut into section-sized chunks that Slack will take. Unlike
 * `splitForBlocks` (which passes a long line through whole), nothing here may
 * exceed the limit, since one refused section loses the whole message: a line
 * longer than that is hard-cut. A code fence crossing a cut is closed at the
 * end of one chunk and reopened at the top of the next, so it still renders
 * as code rather than stray backticks.
 */
export const sectionChunks = (text: string, limit: number = SECTION_LIMIT): string[] => {
  const width = Math.max(1, limit - FENCE_ROOM);
  const lines = text
    .split("\n")
    .flatMap((l) => (l.length <= width ? [l] : Array.from({ length: Math.ceil(l.length / width) }, (_, i) => l.slice(i * width, (i + 1) * width))));
  const chunks: string[] = [];
  let current: string[] = [];
  let size = 0;
  let inFence = false;
  const flush = () => {
    chunks.push(inFence ? `${current.join("\n")}\n\`\`\`` : current.join("\n"));
    current = inFence ? ["```"] : [];
    size = inFence ? 3 : 0;
  };
  for (const line of lines) {
    // Inside a fence, leave room for the "\n```" a cut adds - except on the
    // line that closes the fence itself, which needs none.
    const closes = inFence && FENCE.test(line);
    const grown = size + (current.length ? 1 : 0) + line.length + (inFence && !closes ? 4 : 0);
    if (grown > limit && current.length > (inFence ? 1 : 0)) flush();
    size += (current.length ? 1 : 0) + line.length;
    current.push(line);
    if (FENCE.test(line)) inFence = !inFence;
  }
  if (current.join("\n").trim() && !(current.length === 1 && current[0] === "```" && chunks.length)) chunks.push(current.join("\n"));
  return chunks.filter((c) => c.trim());
};

/**
 * Slack's cap on all the `markdown` blocks in one message, together - not per
 * block, so splitting the text across several does not buy more room.
 */
export const MARKDOWN_LIMIT = 12_000;

const section = (chunk: string): Block => ({ type: "section", text: { type: "mrkdwn", text: chunk } });

/**
 * A plain mrkdwn post as blocks, so it can carry the footer: the text in a
 * `markdown` block, then the footer.
 *
 * Not sections: Slack folds a long section behind "Show more", so a watch
 * firing or an auto-continue - a turn nobody watched stream - posted its answer
 * half hidden, while the same answer streamed live showed in full. A `markdown`
 * block is what the live reply ends up as (`collapsedBlocks`, the Block Kit
 * post in `toBlockMessage`), and Slack does not fold it.
 *
 * Text past `MARKDOWN_LIMIT` carries on in sections (`sectionChunks`, every one
 * under Slack's 3000) rather than being refused whole. A post whose markdown
 * block Slack refuses can fall back to `signedSections`.
 */
export const signedText = (mrkdwn: string, line?: string): { text: string; blocks: Block[] } => {
  const [head, ...rest] = sectionChunks(mrkdwn, MARKDOWN_LIMIT);
  return {
    text: mrkdwn || " ",
    blocks: withFooter(
      [...(head ? [{ type: "markdown", text: toSlackMarkdown(head) }] : []), ...rest.flatMap((c) => sectionChunks(c)).map(section)],
      line,
    ),
  };
};

/** The same post as sections only (one per `sectionChunks` chunk), then the footer. */
export const signedSections = (mrkdwn: string, line?: string): { text: string; blocks: Block[] } => ({
  text: mrkdwn || " ",
  blocks: withFooter(sectionChunks(mrkdwn).map(section), line),
});
