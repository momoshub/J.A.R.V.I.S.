/**
 * A fingerprint of an approval notice as it is shown: what each block says and
 * which buttons it carries (id, label, value).
 *
 * A notice that keeps live buttons is a trigger, so a press is honoured only on
 * the message exactly as the bot last rendered it. Checking that the fact is
 * still quoted is not enough: a rewrite can keep the fact and relabel the
 * button. The bot stores this when it posts or rewrites the notice, and compares
 * it with the blocks Slack hands back on a press.
 *
 * Slack echoes blocks with extra fields (`block_id`, `verbatim`, `action_ts`)
 * and may escape the quote marker, so only the fields the bot writes are read,
 * whitespace is dropped, and `&gt;` and `&amp;` (a thread permalink's
 * `?thread_ts=..&cid=..`) are read as `>` and `&`, in one pass so `&amp;gt;`
 * stays `&gt;`. A `<` is never softened: a
 * live link in place of an escaped one is a different message.
 *
 * Pure: blocks in, hex digest out.
 */
import { createHash } from "node:crypto";

type Loose = Record<string, unknown>;

const isRecord = (v: unknown): v is Loose => typeof v === "object" && v !== null && !Array.isArray(v);

const UNESCAPE: Record<string, string> = { "&gt;": ">", "&amp;": "&" };

type Canon = (text: unknown) => string;

const canon: Canon = (text) =>
  typeof text === "string" ? text.replace(/&(?:gt|amp);/g, (m) => UNESCAPE[m]!).replace(/\s+/g, "") : "";

// The canon before `&amp;` was read (bug #14). Digests stored by it keep a fact's escaped `&amp;`, so a notice posted
// before the change is still checked against it; it never softens `<` either, so it accepts nothing the old check did not.
const legacyCanon: Canon = (text) => (typeof text === "string" ? text.replaceAll("&gt;", ">").replace(/\s+/g, "") : "");

const describeWith = (canon: Canon) => (block: unknown): unknown => {
  const textOf = (v: unknown): string => (isRecord(v) ? canon(v.text) : "");
  if (!isRecord(block)) return ["?"];
  const type = typeof block.type === "string" ? block.type : "?";
  if (type === "section") return [type, textOf(block.text)];
  if (type === "actions") {
    const elements = Array.isArray(block.elements) ? block.elements : [];
    return [
      type,
      elements.map((e) =>
        isRecord(e)
          ? [e.type, e.action_id, textOf(e.text), e.value]
          : ["?"],
      ),
    ];
  }
  // Anything else (the signature footer) counts by its place only: it carries no decision.
  return [type];
};

/** Digest of the blocks' shown text and buttons, in order. Empty input still digests, to a value no real notice has. */
export const noticeFingerprint = (blocks: readonly unknown[]): string =>
  createHash("sha256").update(JSON.stringify(blocks.map(describeWith(canon)))).digest("hex");

/** The digest a notice stored before `&amp;` was read carries (bug #14). Exported for its tests. */
export const legacyNoticeFingerprint = (blocks: readonly unknown[]): string =>
  createHash("sha256").update(JSON.stringify(blocks.map(describeWith(legacyCanon)))).digest("hex");

/** Whether pressed blocks are the stored notice, under the current digest or the one stored before `&amp;` was read. */
export const sameNotice = (blocks: readonly unknown[], stored: string): boolean =>
  !!stored && (noticeFingerprint(blocks) === stored || legacyNoticeFingerprint(blocks) === stored);
