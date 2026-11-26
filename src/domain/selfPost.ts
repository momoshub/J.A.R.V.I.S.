/**
 * A turn that posted its answer itself does not stream a closing reply.
 *
 * A turn may post into its own thread through the Slack proxy (`chat.postMessage`,
 * later `chat.update`). Its closing reply would then be a second copy of the
 * answer, usually reworded, and no comparison of words tells a reword from a
 * correction reliably. So the default is inverted: once the turn has put a
 * message into its own thread, its closing reply is dropped, unless the turn
 * opts in with `KEEP_REPLY` on a line of its own (or as the closing token) in that reply.
 *
 * One exception, because losing the answer is the worst failure: a short plain line (a progress update on a long
 * job) is not an answer. When every message the turn posted is such a line, next to a clearly longer closing
 * reply, the reply is kept as if it carried the marker (`isProgressPost`).
 *
 * Pure: no I/O. The record of what a turn posted lives in `application/selfPosts.ts`.
 */

/**
 * One message the turn put into its own thread. `rich` is set once it carried blocks or attachments (a board, buttons):
 * such a message is never overwritten by the closing reply, and the flag stays even if a later update is plain text.
 */
export type SelfPost = {
  readonly ts: string;
  readonly rich?: true;
  /** Length of the plain `text` as last posted or updated; unknown (absent) counts as answer-sized. */
  readonly len?: number;
};

/** A progress line stays short: a post longer than this is an answer, whatever the closing reply looks like. */
export const PROGRESS_POST_MAX_CHARS = 280;
/** And it is clearly smaller than the closing reply: the post must be under 1/this of the reply, so a reworded copy of a short answer is never mistaken for progress. */
export const PROGRESS_REPLY_RATIO = 2;

/** Is this post a progress line next to a closing reply of `replyLen` chars: plain, short, and clearly shorter than the reply? */
export const isProgressPost = (post: SelfPost, replyLen: number): boolean =>
  !post.rich && post.len !== undefined && post.len <= PROGRESS_POST_MAX_CHARS && post.len * PROGRESS_REPLY_RATIO < replyLen;

/** The plain body of a call (`text`, else Slack's `markdown_text`); undefined when it sends neither, so its length stays unknown, never 0. */
const bodyLength = (params: Readonly<Record<string, string>>): number | undefined => {
  const body = params.text ?? params.markdown_text;
  return body === undefined ? undefined : body.trim().length;
};

const hasContent = (raw: string | undefined): boolean => raw !== undefined && raw.trim() !== "" && raw.trim() !== "[]";
const lenField = (len: number | undefined): { readonly len?: number } => (len !== undefined ? { len } : {});
const isRich = (params: Readonly<Record<string, string>>): boolean => hasContent(params.blocks) || hasContent(params.attachments);

/** The call a turn made, as the proxy saw it: the checked params and Slack's answer. */
export type SelfPostCall = {
  readonly method: string;
  readonly params: Readonly<Record<string, string>>;
  /** Slack's reply body; only a successful one counts. */
  readonly answer: string;
};

/** The line a closing reply carries to be sent although the turn posted its answer itself. */
export const KEEP_REPLY = "KEEP_REPLY";

const KEEP_LINE = /^[ \t]*KEEP_REPLY[ \t]*$/m;
const KEEP_LINES = /^[ \t]*KEEP_REPLY[ \t]*(?:\r?\n|$)/gm;
// the same token closing a text after other words on its line; a longer word that merely ends in it does not count
const KEEP_TRAILING = /(?<![A-Za-z0-9_])KEEP_REPLY[ \t]*$/;

/** Does the text carry the `KEEP_REPLY` marker: on a line of its own, or as the token that closes it? */
export const hasKeepMarker = (reply: string): boolean => KEEP_LINE.test(reply) || KEEP_TRAILING.test(reply.trimEnd());

/** The text without its marker lines and closing marker token, trimmed. */
export const stripKeepMarker = (reply: string): string => reply.replace(KEEP_LINES, "").trimEnd().replace(KEEP_TRAILING, "").trim();

/**
 * Walks Slack blocks and removes the marker from every `text` string. An object whose own `text` was only the
 * marker says nothing and is dropped from its parent (an array entry, or the property holding it, which drops
 * that parent in turn). `undefined` means "this node is gone".
 */
const cleanNode = (node: unknown): unknown => {
  if (Array.isArray(node)) return node.map(cleanNode).filter((n) => n !== undefined);
  if (!node || typeof node !== "object") return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === "text" && typeof value === "string" && hasKeepMarker(value)) {
      const text = stripKeepMarker(value);
      if (!text) return undefined;
      out[key] = text;
      continue;
    }
    const cleaned = cleanNode(value);
    if (cleaned === undefined && value !== undefined) return undefined;
    out[key] = cleaned;
  }
  return out;
};

/** What the proxy sends for a `chat.postMessage` / `chat.update` after the marker is taken out: the params, or nothing left to say. */
export type MarkerStrip = { readonly kind: "send"; readonly params: Readonly<Record<string, string>> } | { readonly kind: "empty" };

/**
 * The marker is an instruction to the bot, so it never goes into a message the turn writes itself. Taken out of `text`
 * and of the `text` fields in `blocks` of `chat.postMessage` and `chat.update`; any other call, any text without the
 * marker and any blocks that are not JSON go through as they came. A call whose text and blocks held only the marker
 * (and that has no attachments) is `empty`: it must not post or blank a message.
 */
export const stripKeepMarkerFromCall = (method: string, params: Readonly<Record<string, string>>): MarkerStrip => {
  if (method !== "chat.postMessage" && method !== "chat.update") return { kind: "send", params };
  const out: Record<string, string> = { ...params };
  let touched = false;
  if (out.text !== undefined && hasKeepMarker(out.text)) {
    touched = true;
    const text = stripKeepMarker(out.text);
    if (text) out.text = text;
    else delete out.text;
  }
  if (out.blocks !== undefined && out.blocks.includes(KEEP_REPLY)) {
    try {
      const blocks = JSON.parse(out.blocks) as unknown;
      const cleaned = cleanNode(blocks);
      if (JSON.stringify(cleaned) !== JSON.stringify(blocks)) {
        touched = true;
        if (Array.isArray(cleaned) && cleaned.length > 0) out.blocks = JSON.stringify(cleaned);
        else delete out.blocks;
      }
    } catch {
      // not JSON: Slack will say so
    }
  }
  if (touched && !out.text?.trim() && out.blocks === undefined && !out.attachments) return { kind: "empty" };
  return { kind: "send", params: touched ? out : params };
};

/**
 * What the Slack handler does with the closing reply of a turn: `send` it as
 * `text`, or `drop` it. The marker is an instruction to the bot, so it is
 * stripped whenever it is there, posts or not, and a reply that was only the
 * marker says nothing and is dropped. Without the marker, a turn with a post
 * of its own drops, unless every post was a progress line (`implicit: true`, sent
 * like a marked reply), and a turn that posted nothing sends the reply as it is.
 */
export const closingReply = (
  reply: string,
  posts: readonly SelfPost[],
): { readonly kind: "send"; readonly text: string; readonly implicit?: true } | { readonly kind: "drop" } => {
  if (!hasKeepMarker(reply)) {
    if (posts.length === 0) return { kind: "send", text: reply };
    // every post of the turn is a progress line: the reply is the answer, kept as if it carried the marker
    const replyLen = reply.trim().length;
    return posts.every((p) => isProgressPost(p, replyLen)) ? { kind: "send", text: reply, implicit: true } : { kind: "drop" };
  }
  const text = stripKeepMarker(reply);
  return text ? { kind: "send", text } : { kind: "drop" };
};

/**
 * The one message of its own the closing reply may replace: the turn put exactly one plain text message into its
 * thread and uploaded no file. Several posts, blocks/attachments and uploads are things the turn did on purpose and
 * stay as they are (the reply is then posted as today).
 */
export const replaceableSelfPost = (posts: readonly SelfPost[], uploaded: boolean): SelfPost | undefined => {
  const [only] = posts;
  return posts.length === 1 && only && !only.rich && !uploaded ? only : undefined;
};

/** Could `line` still grow into a marker line (`KEEP_REPLY` with optional blanks around it)? */
const mayBecomeMarker = (line: string): boolean => {
  const body = line.trimStart();
  const word = body.trimEnd();
  if (body === "") return true;
  return word === body ? KEEP_REPLY.startsWith(body) : word === KEEP_REPLY;
};

/**
 * Where the held tail of `buf` starts, or -1 when nothing needs holding: the last non-blank line (with the blank
 * lines after it) when it ends in `KEEP_REPLY` or the start of it, the character before being no word character
 * (`... sir 🐦‍🔥 KEEP_`, `...🐦‍🔥KEEP_REPLY`). Whether that token is the end of the reply is only known at the end of the
 * stream, so the whole line waits: releasing its head and holding the token would also lose the line break
 * after it if more text follows. `before` is the last character already released.
 */
const closingTokenFrom = (buf: string, before: string): number => {
  const line = buf.trimEnd();
  const lineStart = line.lastIndexOf("\n") + 1;
  const last = line.slice(lineStart);
  for (let n = Math.min(KEEP_REPLY.length, last.length); n > 0; n--) {
    if (!last.endsWith(KEEP_REPLY.slice(0, n))) continue;
    // the word character in front of the token: in the held text, or the last one already released
    const prev = n < last.length ? last.charAt(last.length - n - 1) : lineStart === 0 ? before : "";
    if (!/[A-Za-z0-9_]/.test(prev)) return lineStart;
  }
  return -1;
};

/** Filters marker lines and a closing marker token out of streamed text, chunk by chunk. */
export type KeepMarkerFilter = {
  /** The part of the stream that is safe to show now; may be empty while a line is undecided. */
  readonly push: (delta: string) => string;
  /** The held tail at the end of the stream, minus a marker line or the closing marker token. */
  readonly flush: () => string;
};

/**
 * Stream deltas carry the marker before the final reply is tidied, and a chunk
 * can split the token (`KEEP_` + `REPLY`). Complete lines are released minus the
 * marker lines. The last line is held while it could still become a marker line,
 * or while it ends in the token (or the start of it) after other words, which only
 * the end of the stream can tell from a mention; it is released as soon as it
 * cannot be one, and `flush` drops the closing token like `stripKeepMarker` does.
 */
export const createKeepMarkerFilter = (): KeepMarkerFilter => {
  let pending = "";
  /** The last character released, for the word-character check when the token opens the held text. */
  let before = "";
  const lineOut = (line: string): string => (KEEP_LINE.test(line.replace(/\r?\n$/, "")) ? "" : line);
  /** The text minus its marker lines; the first piece goes through as it is when it continues a line already released. */
  const lines = (text: string, continues: boolean): string =>
    text
      .split(/(?<=\n)/)
      .map((line, i) => (i === 0 && continues ? line : lineOut(line)))
      .join("");
  return {
    push: (delta) => {
      const buf = pending + delta;
      let hold = closingTokenFrom(buf, before);
      if (hold < 0) {
        const cut = buf.lastIndexOf("\n") + 1;
        // a partial line is a marker line only when it opens a line: after a line break, or at the very start
        const opensLine = cut > 0 || before === "" || before === "\n";
        hold = buf.slice(cut) && !(opensLine && mayBecomeMarker(buf.slice(cut))) ? buf.length : cut;
      }
      pending = buf.slice(hold);
      const out = lines(buf.slice(0, hold), before !== "" && before !== "\n");
      if (out) before = out.slice(-1);
      return out;
    },
    flush: () => {
      // a held line that continues released text ends in the token, so it goes either way: no `continues` needed
      const rest = lines(pending, false);
      pending = "";
      const trimmed = rest.trimEnd();
      return KEEP_TRAILING.test(trimmed) ? trimmed.replace(KEEP_TRAILING, "").trimEnd() : rest;
    },
  };
};

const answerOf = (raw: string): { ok: boolean; ts?: string } => {
  try {
    const body = JSON.parse(raw) as { ok?: unknown; ts?: unknown; message?: { ts?: unknown } };
    const ts = typeof body.ts === "string" ? body.ts : typeof body.message?.ts === "string" ? body.message.ts : undefined;
    return { ok: body.ok === true, ...(ts ? { ts } : {}) };
  } catch {
    return { ok: false };
  }
};

/**
 * What a turn's call did to its own thread's messages: the new list of posts.
 * A post counts only when it succeeded and landed in the turn's own thread
 * (`thread_ts` is the turn's thread, which the proxy fills in when omitted); an
 * update counts only for a message this turn posted there, since a ts alone
 * does not say which thread a message sits in. Anything else: the list as it was.
 */
export const applySelfPostCall = (posts: readonly SelfPost[], call: SelfPostCall, threadTs: string | undefined): readonly SelfPost[] => {
  if (!threadTs) return posts;
  const answer = answerOf(call.answer);
  if (!answer.ok) return posts;
  if (call.method === "chat.postMessage") {
    if (call.params.thread_ts !== threadTs || !answer.ts) return posts;
    return posts.some((p) => p.ts === answer.ts) ? posts : [...posts, { ts: answer.ts, ...lenField(bodyLength(call.params)), ...(isRich(call.params) ? { rich: true as const } : {}) }];
  }
  if (call.method === "chat.update") {
    const ts = call.params.ts;
    // an update of a message this turn posted keeps the turn marked as having posted, and blocks make it rich for good
    if (!ts || !posts.some((p) => p.ts === ts)) return posts;
    // an update that sends a body (`text` or `markdown_text`) refreshes the length (a progress line grown into the answer stops being one); one without leaves it
    return posts.map((p) => {
      if (p.ts !== ts) return p;
      const len = bodyLength(call.params) ?? p.len;
      return { ts: p.ts, ...lenField(len), ...(p.rich || isRich(call.params) ? { rich: true as const } : {}) };
    });
  }
  return posts;
};
