/**
 * Slack streaming renderer.
 *
 * Bridges the bot's `LlmStreamSink` onto Slack's native text-streaming API. Slack
 * owns the message: we `append` text deltas and `stop` at the end - no manual
 * edits, so no edit rate limiting. The stream is started lazily on the first
 * TEXT, so non-streaming replies (e.g. `!commands`) never open one, and a turn
 * that only ran tools opens none.
 *
 * Tool steps are not part of that message. They go to a status message of their
 * own (see `statusMessage.ts`), so they neither share the answer's character
 * budget nor stay in it once the turn is over. Appends are serialised on a promise chain so they
 * never overlap; if any step fails (an append, a rollover's stop, the final
 * stop) `finish` answers false and the caller falls back to a plain post.
 *
 * The caller can arm a "thinking" line (`showThinkingAfter`), which appears in
 * the status message only if the turn is still silent when the delay is up and
 * goes as soon as real content arrives - so a quick answer never flashes a
 * placeholder.
 *
 * A ```blockkit fence in the text is lifted out and sent as a `blocks` chunk in
 * its place (see `domain/blockKit.ts`), so tables, alerts and cards stream
 * inline with the prose around them.
 */
import type { AnyChunk } from "@slack/types";
import { isHiddenAction } from "../../domain/toolVisibility.ts";
import { MAX_SILENCE_NOTE } from "../../domain/silence.ts";
import { toSlackMarkdown } from "../../domain/slackFormat.ts";
import { createEmphasisNormalizer } from "./emphasis.ts";
import { createKeepMarkerFilter } from "../../domain/selfPost.ts";
import { createFenceNormalizer } from "../../domain/fences.ts";
import type { StatusMessage } from "./statusMessage.ts";
import type { LlmUsage } from "../../application/ports.ts";
import { blocksToText, createBlockKitExtractor, type Block, type Segment } from "../../domain/blockKit.ts";
import type { LlmStreamEvent, LlmStreamSink } from "../../application/ports.ts";

/** The slice of Slack's ChatStreamer we depend on (kept minimal for testing). */
/** One message of a streamed reply and what it showed. */
export type StreamPart = { readonly ts: string; readonly text: string };

export type Streamer = {
  append: (args: { markdown_text?: string; chunks?: AnyChunk[] }) => Promise<unknown>;
  stop: (args?: { markdown_text?: string }) => Promise<unknown>;
  /** ts of the streamed message; undefined until the first flush opens it. */
  readonly ts?: string;
};

/** How long a turn may stay silent before a "thinking" line is worth showing. */
export const THINKING_AFTER_MS = 5_000;

/**
 * Characters of text one streamed message may carry before it is rolled over
 * into a continuation.
 *
 * Slack caps a streamed message at 12,000 characters - measured, not guessed:
 * appending 2,000 at a time succeeded through 10,005 and the next chunk failed
 * with `msg_too_long`, and so did `stop`. That failure is not a truncation, it
 * is a LOSS: the append throws, the stream breaks, and a long answer that took
 * minutes to produce never arrives at all. `msg_too_long` appears dozens of
 * times in this instance's log.
 *
 * So a long reply continues in a second message instead. Tool steps used to be
 * cards in the same message and ate the same allowance; they now have a
 * message of their own, so the allowance is the answer's alone.
 */
export const STREAM_CHAR_BUDGET = 11_000;

/**
 * Where to cut `text` so the piece fits in `room`: all of it when it fits,
 * else just after the last line break, else after the last space. A cut in
 * the middle of a word showed up as "I restart o" / "nce idle" across two
 * messages. With no break in reach it
 * answers 0 (roll over first, the whole room is then free), unless the
 * message is already fresh, where only a hard cut can make progress.
 */
export const rolloverCut = (text: string, room: number, fresh: boolean): number => {
  if (text.length <= room) return text.length;
  const head = text.slice(0, room);
  const line = head.lastIndexOf("\n");
  if (line > 0) return line + 1;
  const space = head.lastIndexOf(" ");
  if (space > 0) return space + 1;
  return fresh ? room : 0;
};

export type SlackStream = {
  sink: LlmStreamSink;
  /** Show a "thinking" line in the status message now; it goes with the first content. */
  showThinking: (title: string) => void;
  /**
   * Show that line only if nothing has arrived yet after `delayMs`. A turn that
   * answers quickly never shows one at all.
   */
  showThinkingAfter: (title: string, delayMs?: number) => void;
  /** True once the underlying stream has been opened. */
  readonly started: boolean;
  /** ts of the streamed message, once Slack has assigned one. */
  readonly ts: string | undefined;
  /** What the run cost, once the CLI has reported it. Undefined until then. */
  readonly usage: LlmUsage | undefined;
  /**
   * Every message the reply was spread across, oldest first, with the text
   * each one actually carried (a Block Kit chunk as its ```blockkit fence).
   * More than one means it rolled over, and `ts` is only the LAST of them - so
   * rewriting that one with the whole answer posts it twice. Each message is
   * tidied with its own part instead. Only messages Slack actually took an
   * append for are listed: one whose first append failed never existed.
   */
  readonly parts: readonly StreamPart[];
  /**
   * ts of messages Slack opened but never took an append for: blank, and never
   * part of the reply. The caller removes them when it falls back to a post, so
   * the thread does not keep an empty message next to the answer.
   */
  readonly orphans: readonly string[];
  /**
   * Await pending appends and close the stream, and end the status message
   * (deleted shortly after, or collapsed to its failures). False if the stream
   * broke or showed no content - which a turn that only ran tools never does:
   * it has no stream, and the caller posts its reply.
   */
  finish: () => Promise<boolean>;
  /**
   * Give up on this turn: cancel an armed placeholder, end the status message
   * and close anything that was already opened. Returns the ts of a message left behind that holds no
   * real content, so the caller can take it away again.
   *
   * A turn that is queued or dropped used to return without touching the
   * stream at all, leaving the armed timer to fire a few seconds later into a
   * turn that no longer existed - which is where the stray "thinking" lines in
   * a busy thread came from.
   */
  abandon: () => Promise<{ emptyTs?: string }>;
};

/**
 * The log pointer a tool event carries in `details`: `log at: <file> - line <n>`.
 * The status line shows the line number; the file is the same for the whole
 * thread and is not repeated on every line.
 */
const LOG_POINTER = /^log at: .+? - line (\d+)$/;

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export type SlackStreamOptions = {
  /**
   * Where the turn's tool steps are shown. Without one they are not shown
   * anywhere: the answer streams on its own either way.
   */
  status?: StatusMessage;
  /**
   * Open nothing until the turn is plainly doing something: a visible tool
   * call, or more text than a silence note could be. Text before that is held
   * and sent when the stream opens.
   *
   * For a followed thread. Most of those turns say nothing, and a stream opened
   * at the start leaves a message behind for each of them - or shows "nothing
   * to add" to the channel before the boundary can drop it. Not streaming at
   * all was the other failure: a turn asked to fix something worked for
   * minutes with no sign it had heard. A turn that never opens is posted
   * plainly by the caller, which is where the silence check runs.
   */
  holdUntilWorking?: boolean;
  /**
   * Called once per message the reply opens, with its ts. Lets the caller
   * remember where a half-written reply is, so it can be tidied up if the
   * process dies before the stream is closed.
   */
  onOpen?: (ts: string) => void;
};

export const createSlackStream = (
  makeStreamer: () => Streamer,
  log: (msg: string) => void = () => {},
  options: SlackStreamOptions = {},
): SlackStream => {
  let streamer: Streamer | undefined;
  let chain: Promise<unknown> = Promise.resolve();
  let broke = false;
  /**
   * A rollover could not close its message. What it buffered may never have
   * reached Slack, so the stream cannot claim to have delivered the reply.
   */
  let lost = false;
  let thinkingShown = false;
  let thinkingDone = false;
  let contentShown = false;
  const status = options.status;
  /** Characters appended to the CURRENT message, for the rollover. */
  let used = 0;
  let pending: ReturnType<typeof setTimeout> | undefined;
  const fences = createFenceNormalizer();
  // After the fences: markdown_text is standard Markdown, where mrkdwn `*x*` is italic.
  const emphasis = createEmphasisNormalizer();
  /** Prose out of the fence normaliser, as the Markdown Slack parses. */
  const prose = (text: string): string => emphasis.push(text);
  const proseFlush = (text: string): string => emphasis.push(text) + emphasis.flush();
  const kit = createBlockKitExtractor();
  const markerFilter = createKeepMarkerFilter();

  const cancelPending = (): void => {
    if (pending === undefined) return;
    clearTimeout(pending);
    pending = undefined;
  };

  const enqueue = (fn: () => Promise<unknown>): void => {
    chain = chain.then(fn).catch((e) => {
      if (!broke) log(`stream step failed: ${errMsg(e)}`);
      broke = true;
    });
  };

  /** Per opened message: the streamer, and the text it was sent. */
  const opened: { streamer: Streamer; text: string; live: boolean }[] = [];
  /** Message ts already reported through `onOpen`. */
  const announced = new Set<string>();
  const ensure = (): Streamer => {
    if (!streamer) {
      streamer = makeStreamer();
      opened.push({ streamer, text: "", live: false });
    }
    return streamer;
  };

  /** Close the current message so the next append opens a fresh one. */
  const rollover = async (): Promise<void> => {
    if (!streamer) return;
    try {
      await streamer.stop();
    } catch (e) {
      // The continuation still goes out, but this message may be blank:
      // `finish` reports the reply as not delivered, so the caller rewrites or posts it whole.
      log(`stream rollover stop failed: ${errMsg(e)}`);
      lost = true;
    }
    streamer = undefined;
    used = 0;
  };

  /**
   * Append to the current message, rolling over first when `cost` would not
   * fit. If Slack still says `msg_too_long` - its accounting is not ours - roll
   * over and try once more rather than breaking the stream for the whole turn.
   */
  const send = async (args: Parameters<Streamer["append"]>[0], cost: number): Promise<void> => {
    if (used > 0 && used + cost > STREAM_CHAR_BUDGET) await rollover();
    used += cost;
    try {
      await ensure().append(args);
    } catch (e) {
      if (!errMsg(e).includes("msg_too_long") || used === cost) throw e;
      await rollover();
      used = cost;
      await ensure().append(args);
    }
    record(args);
    const ts = streamer?.ts;
    if (ts && !announced.has(ts)) {
      announced.add(ts);
      try {
        options.onOpen?.(ts);
      } catch (e) {
        log(`onOpen failed: ${errMsg(e)}`);
      }
    }
  };

  /** Note what the current message now shows, so it can be rebuilt from its parts. */
  const record = (args: Parameters<Streamer["append"]>[0]): void => {
    const current = opened[opened.length - 1];
    if (!current) return;
    current.live = true;
    if (args.markdown_text) current.text += args.markdown_text;
    for (const c of args.chunks ?? []) {
      const blocks = (c as { type?: string; blocks?: unknown }).type === "blocks" ? (c as { blocks: unknown }).blocks : undefined;
      if (blocks) current.text += `\n\`\`\`blockkit\n${JSON.stringify(blocks)}\n\`\`\`\n`;
    }
  };

  /**
   * Append text, rolling over to a fresh message before Slack would refuse it.
   *
   * The length check happens INSIDE the chain so it sees the real running
   * total: appends are serialised, and deciding outside would race with
   * whatever is still in flight.
   */
  const appendText = (text: string) => {
    ensure();
    enqueue(async () => {
      let rest = text;
      while (rest) {
        if (used >= STREAM_CHAR_BUDGET) await rollover();
        const cut = rolloverCut(rest, STREAM_CHAR_BUDGET - used, used === 0);
        if (cut === 0) {
          await rollover();
          continue;
        }
        const piece = rest.slice(0, cut);
        rest = rest.slice(cut);
        await send({ markdown_text: piece }, piece.length);
      }
    });
  };

  /**
   * Send a run of blocks as one chunk, in order with the text around it.
   *
   * Slack refuses a block it does not support in a message (`alert` is
   * rejected with `invalid_blocks` even though the SDK types it) or one that
   * breaks its schema (an empty table cell came back `invalid_arguments`), and a
   * refusal would otherwise break the stream for the whole turn: the reply
   * split in two and the table vanished. So a refused chunk is shown as the
   * words it holds instead (its JSON in a code block when it holds none): the
   * content survives, and the rest of the reply keeps streaming.
   */
  const appendBlocks = (blocks: Block[]) => {
    ensure();
    const chunk = { type: "blocks", blocks } as AnyChunk;
    enqueue(async () => {
      try {
        await send({ chunks: [chunk] }, JSON.stringify(chunk).length);
      } catch (e) {
        if (!/invalid_blocks|invalid_arguments/.test(errMsg(e))) throw e;
        // A refused chunk was never shown, so it is not part of the allowance.
        used = Math.max(0, used - JSON.stringify(chunk).length);
        log(`blocks refused, shown as text: ${errMsg(e)}`);
        const words = blocksToText(blocks);
        const shown = words ? `\n${toSlackMarkdown(words)}\n\n` : `\n\`\`\`\n${JSON.stringify(blocks, null, 2)}\n\`\`\`\n`;
        await send({ markdown_text: shown }, shown.length);
      }
    });
  };

  /**
   * Route extracted segments: prose through the fence normaliser, blocks as a
   * chunk. Whatever the normaliser held back goes out first, or a block would
   * overtake the end of the sentence that introduced it.
   */
  const emitSegments = (segs: Segment[]) => {
    for (const seg of segs) {
      if (seg.kind === "text") {
        const text = prose(fences.push(seg.text));
        if (text) appendText(text);
        continue;
      }
      const held = proseFlush(fences.flush());
      if (held) appendText(held);
      appendBlocks(seg.blocks);
    }
  };

  const completeThinking = () => {
    if (!thinkingShown || thinkingDone) return;
    thinkingDone = true;
    status?.thinking(undefined);
  };

  const showThinking = (title: string) => {
    if (thinkingShown) return;
    thinkingShown = true;
    status?.thinking(title);
  };

  const showThinkingAfter = (title: string, delayMs = THINKING_AFTER_MS) => {
    cancelPending();
    pending = setTimeout(() => {
      pending = undefined;
      // Content beat the timer, so there is nothing to reassure anyone about.
      if (!contentShown) showThinking(title);
    }, delayMs);
    // Never hold the process open for a placeholder.
    (pending as { unref?: () => void }).unref?.();
  };

  const forward = (event: LlmStreamEvent): void => {
    cancelPending(); // something arrived, so no placeholder is needed
    completeThinking(); // first real content ends the thinking line
    if (event.type === "text") {
      // The marker line the turn may end with is for the bot, not the reader.
      const delta = markerFilter.push(event.delta);
      if (delta) {
        contentShown = true;
        emitSegments(kit.push(delta));
      }
      return;
    }
    // An aborted run is the caller's to narrate (it knows what was at stake);
    // there is no step to draw for it.
    if (event.type === "aborted") return;
    if (event.type === "usage") return;
    contentShown = true;
    const pointer = event.details ? LOG_POINTER.exec(event.details) : null;
    // The status message, not the answer's stream: steps never open it.
    status?.step({
      id: event.id,
      title: event.title,
      state: event.status,
      ...(pointer?.[1] ? { logLine: pointer[1] } : {}),
    });
  };

  /**
   * Repeats of the same step share one line. A turn that runs the same query
   * five times showed five identical lines; now it shows one, titled
   * "... (5 runs)", that completes when the last of them does.
   *
   * "The same" means the whole input, not the title: titles are clipped,
   * and an MCP call's title is only the tool name, so grouping on it merged
   * five different SQL queries into one line that showed just the first.
   */
  type Group = { id: string; title: string; details?: string; count: number; open: number; failed: boolean };
  const groups = new Map<string, Group>();
  const groupOf = new Map<string, Group>();
  /**
   * What the run cost. It arrives once, at the very end, and is NOT content:
   * it must never open a stream, end the thinking step, or count as something
   * to show - it is written into the footer after the turn is over.
   */
  let usage: LlmUsage | undefined;
  const runsLabel = (title: string, count: number): string => `${title} (${count} runs)`;
  const groupStep = (g: Group, state: "in_progress" | "complete" | "error"): LlmStreamEvent => ({
    type: "tool",
    id: g.id,
    title: runsLabel(g.title, g.count),
    status: state,
    ...(g.details ? { details: g.details } : {}),
  });

  /** The event to show for a tool step, or undefined when its group's line already covers it. */
  const grouped = (event: Extract<LlmStreamEvent, { type: "tool" }>): LlmStreamEvent | undefined => {
    if (event.status === "in_progress") {
      if (groupOf.has(event.id)) return event;
      // details is a log pointer that differs per call, so it is no part of the key
      const key = event.command ?? event.title;
      const g = groups.get(key);
      if (!g) {
        const fresh = { id: event.id, title: event.title, details: event.details, count: 1, open: 1, failed: false };
        groups.set(key, fresh);
        groupOf.set(event.id, fresh);
        return event;
      }
      groupOf.set(event.id, g);
      g.count += 1;
      g.open += 1;
      return groupStep(g, "in_progress");
    }
    const g = groupOf.get(event.id);
    if (!g) return event;
    g.open = Math.max(0, g.open - 1);
    g.failed ||= event.status === "error";
    if (g.count === 1) return event;
    if (g.open > 0) return undefined;
    return groupStep(g, g.failed ? "error" : "complete");
  };

  let holding = options.holdUntilWorking === true;
  let held = "";

  const sink: LlmStreamSink = (event: LlmStreamEvent) => {
    // Kept for the footer and nothing else: it must not open a stream, end the
    // thinking line, or count as content, all of which `forward` would do.
    if (event.type === "usage") {
      usage = event.usage;
      return;
    }
    // Hidden actions (reacting, remembering, anything on the local host) leave no
    // trace here: no line, and they do not count as content or end the thinking line.
    if (event.type === "tool" && isHiddenAction(event.command)) return;
    if (event.type === "tool") {
      const shown = grouped(event);
      if (!shown) return;
      event = shown;
    }
    if (holding) {
      if (event.type === "aborted") return;
      if (event.type === "text") {
        held += event.delta;
        if (held.trim().length <= MAX_SILENCE_NOTE) return;
      }
      holding = false;
      const text = held;
      held = "";
      if (event.type === "text") {
        forward({ type: "text", delta: text });
        return;
      }
      if (text) forward({ type: "text", delta: text });
    }
    forward(event);
  };

  return {
    sink,
    showThinking,
    showThinkingAfter,
    get started() {
      return streamer !== undefined;
    },
    get ts() {
      return streamer?.ts;
    },
    get usage() {
      return usage;
    },
    get parts() {
      return opened.flatMap((o) => (o.live && o.streamer.ts ? [{ ts: o.streamer.ts, text: o.text }] : []));
    },
    get orphans() {
      const kept = new Set(opened.flatMap((o) => (o.live && o.streamer.ts ? [o.streamer.ts] : [])));
      return opened.flatMap((o) => (!o.live && o.streamer.ts && !kept.has(o.streamer.ts) ? [o.streamer.ts] : []));
    },
    abandon: async () => {
      cancelPending();
      completeThinking();
      // A stopped turn may have run steps, and one that failed is worth keeping.
      await status?.end();
      if (!streamer) return {};
      try {
        await chain;
      } catch {
        // already swallowed into `broke`
      }
      const ts = streamer.ts;
      try {
        await streamer.stop();
      } catch {
        // closing a stream nobody will read is not worth reporting
      }
      return contentShown ? {} : { emptyTs: ts };
    },
    finish: async () => {
      cancelPending();
      completeThinking();
      // Not awaited: a clean turn's message waits a few seconds before it goes,
      // and the answer must not wait with it. `end` lands its own failures.
      void status?.end();
      const rest = markerFilter.flush();
      if (rest) emitSegments(kit.push(rest));
      emitSegments(kit.flush());
      const tail = proseFlush(fences.flush());
      if (tail) appendText(tail);
      try {
        await chain;
      } catch {
        // chain already swallows errors into `broke`
      }
      if (!streamer) return false;
      try {
        await streamer.stop();
      } catch (e) {
        log(`stream stop failed: ${errMsg(e)}`);
        return false;
      }
      return contentShown && !broke && !lost;
    },
  };
};
