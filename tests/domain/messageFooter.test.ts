import { describe, expect, test } from "bun:test";
import {
  FOOTER_BLOCK_ID,
  footerBlock,
  footerLine,
  triggerLabel,
  MARKDOWN_LIMIT,
  sectionChunks,
  signedSections,
  signedText,
  SIGNATURES,
  UNSIGNED,
  withFooter,
} from "../../src/domain/messageFooter.ts";
import { MAX_BLOCKS } from "../../src/domain/blockKit.ts";
import { SECTION_LIMIT } from "../../src/domain/slackFormat.ts";

describe("footerLine", () => {
  test("signature, then what the turn reported - one line", () => {
    const line = footerLine("Jarvis", "claude-opus-5-5 · in 95.9k · $1.30 · 3m 16s");
    expect(line).toBe("Jarvis · claude-opus-5-5 · in 95.9k · $1.30 · 3m 16s");
    expect(line).not.toContain("\n");
  });

  test("nothing reported means just the signature", () => {
    expect(footerLine(SIGNATURES.innerChild)).toBe("inner child Jarvis");
    expect(footerLine("watch", "  ")).toBe("watch");
  });

  test("a blank signature is still signed, as Jarvis", () => {
    expect(footerLine(" ")).toBe("Jarvis");
  });

  test("there is no \"updated\" stamp, however the line is built", () => {
    expect(footerLine("Jarvis", "claude-opus-5-5 · $0.20")).toBe("Jarvis · claude-opus-5-5 · $0.20");
    expect(footerLine("Jarvis", undefined, "watch")).not.toContain("updated");
  });

  test("UNSIGNED is the null `by`: not a name, so it never reaches a footer line", () => {
    expect(UNSIGNED).toBeNull();
  });
});

describe("blocks", () => {
  const line = footerLine("Jarvis");

  test("the footer is a context block carrying the id an edit finds it by", () => {
    expect(footerBlock(line)).toEqual({
      type: "context",
      block_id: FOOTER_BLOCK_ID,
      elements: [{ type: "mrkdwn", text: line }],
    });
  });

  test("withFooter replaces a footer already there rather than stacking a second one", () => {
    const once = withFooter([{ type: "markdown", text: "hi" }], line);
    const twice = withFooter(once, footerLine("watch"));
    expect(twice).toHaveLength(2);
    expect(JSON.stringify(twice[1])).toContain("\"text\":\"watch\"");
  });

  test("no line means no footer, and a stale one is dropped (an unsigned rebuild)", () => {
    const signed = withFooter([{ type: "markdown", text: "hi" }], line);
    expect(withFooter(signed, undefined)).toEqual([{ type: "markdown", text: "hi" }]);
    expect(signedText("hello", undefined)).toEqual({ text: "hello", blocks: [{ type: "markdown", text: "hello" }] });
    expect(signedSections("hello", undefined).blocks).toEqual([{ type: "section", text: { type: "mrkdwn", text: "hello" } }]);
  });

  test("a full message is clipped so the footer still fits Slack's 50", () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ type: "section", text: { type: "mrkdwn", text: `${i}` } }));
    const out = withFooter(many, line);
    expect(out).toHaveLength(MAX_BLOCKS);
    expect(out.at(-1)).toMatchObject({ block_id: FOOTER_BLOCK_ID });
  });

  test("a plain post becomes a markdown block plus the footer, keeping its text fallback", () => {
    const msg = signedText("hello *there*", line);
    expect(msg.text).toBe("hello *there*");
    expect(msg.blocks).toEqual([{ type: "markdown", text: "hello **there**" }, footerBlock(line)]);
  });

  test("a long plain post stays one markdown block, so Slack does not fold it behind Show more", () => {
    const long = `${"a ".repeat(2000)}\n${"b ".repeat(2000)}`;
    const msg = signedText(long, line);
    expect(msg.blocks).toEqual([{ type: "markdown", text: long }, footerBlock(line)]);
  });

  test("blank text posts just the footer, with a non-empty fallback", () => {
    expect(signedText("", line)).toEqual({ text: " ", blocks: [footerBlock(line)] });
  });

  test("text past Slack's markdown cap carries on in sections, nothing lost", () => {
    const para = `${"w ".repeat(1000)}\n`;
    const huge = para.repeat(9).trimEnd(); // ~18k: over the 12k markdown cap
    const msg = signedText(huge, line);
    const [head, ...rest] = msg.blocks.slice(0, -1) as unknown as ({ type: "markdown"; text: string } | { type: "section"; text: { text: string } })[];
    expect(head?.type).toBe("markdown");
    expect((head as { text: string }).text.length).toBeLessThanOrEqual(MARKDOWN_LIMIT);
    expect(rest.length).toBeGreaterThan(1);
    for (const b of rest) {
      expect(b.type).toBe("section");
      expect((b as { text: { text: string } }).text.text.length).toBeLessThanOrEqual(SECTION_LIMIT);
    }
    const all = [(head as { text: string }).text, ...rest.map((b) => (b as { text: { text: string } }).text.text)];
    expect(all.join("\n")).toBe(huge);
    expect(msg.blocks.filter((b) => b.type === "markdown")).toHaveLength(1);
    expect(msg.blocks.at(-1)).toMatchObject({ block_id: FOOTER_BLOCK_ID });
  });

  test("signedSections: a long post split so every section stays under Slack's 3000", () => {
    const msg = signedSections(`${"a ".repeat(2000)}\n${"b ".repeat(2000)}`, line);
    const sections = msg.blocks.slice(0, -1) as unknown as { type: string; text: { text: string } }[];
    expect(sections.length).toBeGreaterThan(2);
    for (const s of sections) {
      expect(s.type).toBe("section");
      expect(s.text.text.length).toBeLessThanOrEqual(SECTION_LIMIT);
    }
    expect(sections.map((s) => s.text.text).join("")).toBe(`${"a ".repeat(2000)}${"b ".repeat(2000)}`);
    expect(msg.blocks.at(-1)).toMatchObject({ block_id: FOOTER_BLOCK_ID });
  });
});

describe("sectionChunks", () => {
  test("short text is one chunk, blank text none", () => {
    expect(sectionChunks("hello")).toEqual(["hello"]);
    expect(sectionChunks("  \n ")).toEqual([]);
  });

  test("a single line over the limit is hard-cut, nothing lost", () => {
    const giant = "x".repeat(7000);
    const chunks = sectionChunks(giant);
    expect(chunks.length).toBe(3);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(SECTION_LIMIT);
    expect(chunks.join("")).toBe(giant);
  });

  test("one huge line inside a fence is cut into fenced chunks, none empty", () => {
    const chunks = sectionChunks(`\`\`\`\n${"q".repeat(10_000)}\n\`\`\``);
    expect(chunks.length).toBe(4);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(SECTION_LIMIT);
      expect(c).toStartWith("```\n");
      expect(c).toEndWith("\n```");
      expect(c.replace(/[`\s]/g, "")).not.toBe("");
    }
  });

  test("a fence closing exactly at the limit adds no empty code block", () => {
    for (let n = SECTION_LIMIT - 20; n < SECTION_LIMIT + 10; n++) {
      const chunks = sectionChunks(`\`\`\`\n${"a".repeat(n - 8)}\n\`\`\`\nafter`);
      for (const c of chunks) {
        expect(c.length).toBeLessThanOrEqual(SECTION_LIMIT);
        expect(c.replace(/[`\s]/g, "")).not.toBe("");
      }
    }
  });

  test("a code fence crossing a cut is closed and reopened, so both halves render as code", () => {
    const code = Array.from({ length: 200 }, (_, i) => `line ${i} ${"y".repeat(20)}`).join("\n");
    const chunks = sectionChunks(`before\n\`\`\`\n${code}\n\`\`\`\nafter`);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(SECTION_LIMIT);
      // every chunk holds an even number of fences: opened and closed inside it
      expect((c.match(/^```/gm) ?? []).length % 2).toBe(0);
    }
    expect(chunks[1]?.startsWith("```")).toBe(true);
    expect(chunks.at(-1)?.endsWith("after")).toBe(true);
  });
});

describe("triggered by", () => {
  test("an internal kind sits after the signature and before the usage", () => {
    expect(footerLine("Jarvis", "1.2k tokens", "watch")).toBe("Jarvis · triggered by watch · 1.2k tokens");
    expect(footerLine("Jarvis", undefined, "loop")).toBe("Jarvis · triggered by loop");
    for (const kind of ["nudge", "tell", "orca"] as const) expect(triggerLabel(kind)).toBe(`triggered by ${kind}`);
  });

  test("a chat turn, and a brief (which starts no turn), say nothing", () => {
    expect(footerLine("Jarvis", "1.2k tokens")).toBe("Jarvis · 1.2k tokens");
    expect(triggerLabel(undefined)).toBeUndefined();
    expect(triggerLabel("brief")).toBeUndefined();
    expect(footerLine("Jarvis", undefined, "brief")).toBe("Jarvis");
  });
});
