import { describe, expect, test } from "bun:test";
import type { WebClient } from "@slack/web-api";
import { createSlackAdmin } from "../../src/infrastructure/slack/adminClient.ts";
import { FOOTER_BLOCK_ID, footerLine, UNSIGNED } from "../../src/domain/messageFooter.ts";
import { usageFooter } from "../../src/domain/usageFooter.ts";
import { blockKitReply } from "../../src/domain/blockKit.ts";


type Call = [string, Record<string, unknown>];
type Block = { type: string; block_id?: string; elements?: { text?: string }[] };

/** A WebClient that records chat calls; `refuse` makes a post with blocks fail. */
const fake = (refuse?: (a: Record<string, unknown>) => boolean) => {
  const calls: Call[] = [];
  const client = {
    conversations: { open: async () => ({ channel: { id: "D9" } }) },
    chat: {
      postMessage: async (a: Record<string, unknown>) => {
        calls.push(["post", a]);
        if (refuse?.(a)) throw new Error("invalid_blocks");
        return { ts: `${calls.length}.0` };
      },
      update: async (a: Record<string, unknown>) => void calls.push(["update", a]),
    },
  } as unknown as WebClient;
  return { calls, admin: createSlackAdmin(client) };
};

const footerOf = (a: Record<string, unknown> | undefined): Block | undefined => (a?.blocks as Block[] | undefined)?.at(-1);
const signedBy = (a: Record<string, unknown> | undefined): string | undefined => footerOf(a)?.elements?.[0]?.text;

describe("every message the admin client writes is signed", () => {
  test("a plain post is a markdown block plus a footer signed Jarvis", async () => {
    const { calls, admin } = fake();
    await admin.post("C1", "hello **there**", "100.1");
    const [, a] = calls[0]!;
    expect(a).toMatchObject({ channel: "C1", thread_ts: "100.1", text: "hello *there*" });
    expect((a.blocks as Block[])[0]).toMatchObject({ type: "markdown", text: "hello **there**" });
    expect(footerOf(a)).toMatchObject({ type: "context", block_id: FOOTER_BLOCK_ID });
    expect(signedBy(a)).toBe("Jarvis");
  });

  test("the poster names itself", async () => {
    const { calls, admin } = fake();
    await admin.post("C1", "⏰ reminder", undefined, "reminder");
    await admin.postDm("U1", "hi", "inner child Jarvis");
    expect(signedBy(calls[0]?.[1])).toBe("reminder");
    expect(signedBy(calls[1]?.[1])).toBe("inner child Jarvis");
  });

  test("a DM and an edit carry the usage in the footer: a FooterUsage through usageFooter, a string as the line itself, none leaves it as it was", async () => {
    const { calls, admin } = fake();
    const usage = { model: "claude-sonnet-5-5", inputTokens: 1000, outputTokens: 500, cacheReadTokens: 10_000, cacheWriteTokens: 500, costUsd: 0.25, durationMs: 62_000 };
    await admin.postDm("U1", "digest", "Aide", undefined, "line · hôm nay 1 lượt");
    await admin.update("D9", "1.0", "digest", "Aide", "line · hôm nay 1 lượt");
    await admin.postDm("U1", "digest", "Aide", undefined, usage);
    await admin.update("D9", "1.0", "digest", "Aide", usage);
    await admin.postDm("U1", "digest", "Aide");
    await admin.update("D9", "1.0", "digest", "Aide");
    expect(calls.map(([, a]) => signedBy(a))).toEqual([
      "Aide · line · hôm nay 1 lượt",
      "Aide · line · hôm nay 1 lượt",
      footerLine("Aide", usageFooter(usage)),
      footerLine("Aide", usageFooter(usage)),
      "Aide",
      "Aide",
    ]);
    expect(footerOf(calls[0]![1])).toMatchObject({ type: "context", block_id: FOOTER_BLOCK_ID });
  });

  test("a turn's usage goes into the footer, in the live reply's format", async () => {
    const { calls, admin } = fake();
    const usage = {
      model: "claude-opus-5-5",
      inputTokens: 95_900,
      outputTokens: 10_600,
      cacheReadTokens: 1_600_000,
      cacheWriteTokens: 20_400,
      costUsd: 1.3,
      durationMs: 196_000,
    };
    await admin.post("D1", "done", "100.1", undefined, usage);
    await admin.post("D1", "done", "100.1", "workflow worker", usage);
    expect(signedBy(calls[0]?.[1])).toBe(footerLine("Jarvis", usageFooter(usage)));
    expect(signedBy(calls[0]?.[1])).toBe("Jarvis · claude-opus-5-5 · in 95.9k · out 10.6k · cache r 1.6M w 20.4k · $1.30 · 3m 16s");
    expect(signedBy(calls[1]?.[1])).toStartWith("workflow worker · claude-opus-5-5 · ");
  });

  test("a Block Kit post keeps its blocks and gains the footer", async () => {
    const { calls, admin } = fake();
    await admin.post("C1", 'look\n```blockkit\n[{"type":"divider"}]\n```', undefined, "watch");
    const blocks = calls[0]?.[1].blocks as Block[];
    expect(blocks.map((b) => b.type)).toEqual(["markdown", "divider", "context"]);
    expect(signedBy(calls[0]?.[1])).toBe("watch");
  });

  test("a long plain post is not folded: one markdown block, never a long section", async () => {
    const { calls, admin } = fake();
    const long = Array.from({ length: 80 }, (_, i) => `line ${i} of a watch reply nobody saw stream`).join("\n");
    await admin.post("D1", long, "100.1", "watch");
    const blocks = calls[0]?.[1].blocks as Block[];
    expect(blocks.map((b) => b.type)).toEqual(["markdown", "context"]);
  });

  test("a refused markdown block falls back to signed sections", async () => {
    const { calls, admin } = fake((a) => (a.blocks as Block[] | undefined)?.some((b) => b.type === "markdown") ?? false);
    const ref = await admin.post("C1", "still here", "100.1", "watch");
    expect(calls).toHaveLength(2);
    expect((calls[1]?.[1].blocks as Block[]).map((b) => b.type)).toEqual(["section", "context"]);
    expect(signedBy(calls[1]?.[1])).toBe("watch");
    expect(ref).toEqual({ channel: "C1", ts: "2.0" });
  });

  test("blocks Slack refuses still get the words out, signed if it can and bare if not", async () => {
    const { calls, admin } = fake((a) => Array.isArray(a.blocks));
    const ref = await admin.post("C1", "still here", "100.1");
    expect(calls.map(([, a]) => Array.isArray(a.blocks))).toEqual([true, true, false]);
    expect(calls[2]?.[1]).toEqual({ channel: "C1", text: "still here", thread_ts: "100.1" });
    expect(ref).toEqual({ channel: "C1", ts: "3.0" });
  });

  test("a Block Kit reply with its own words falls back to those words, never its JSON", async () => {
    // First post (the rich blocks) refused; the fallback posts carry the fence's text.
    let first = true;
    const { calls, admin } = fake(() => {
      const refuse = first;
      first = false;
      return refuse;
    });
    await admin.post("C1", blockKitReply("*cpu* fine", [{ type: "header", text: { type: "plain_text", text: "ok" } }]), "100.1");
    expect((calls[0]?.[1].blocks as Block[])[0]?.type).toBe("header");
    expect(calls[0]?.[1].text).toBe("*cpu* fine");
    expect(calls[1]?.[1].text).toBe("*cpu* fine");
    expect(JSON.stringify(calls[1]?.[1])).not.toContain("blockkit");
  });

  test("an edit sends blocks, so the old ones never stay on screen, and adds no \"updated\" stamp", async () => {
    const { calls, admin } = fake();
    await admin.update("C1", "5.5", "draining: 2 turns left");
    await admin.settleInteractive("C1", "6.6", "approved by <@U1>", "command");
    expect(calls[0]?.[0]).toBe("update");
    expect(calls[0]?.[1]).toMatchObject({ channel: "C1", ts: "5.5", text: "draining: 2 turns left" });
    expect(signedBy(calls[0]?.[1])).toBe(footerLine("Jarvis"));
    expect(signedBy(calls[0]?.[1])).not.toContain("updated");
    expect((calls[1]?.[1].blocks as Block[]).map((b) => b.type)).toEqual(["markdown", "context"]);
    expect(signedBy(calls[1]?.[1])).toBe(footerLine("command"));
  });

  test("a post or an edit with `by` UNSIGNED has no footer, so a console edit or a cross-thread post carries no sign", async () => {
    const { calls, admin } = fake();
    await admin.post("C9", "hello there", undefined, UNSIGNED);
    await admin.post("C9", "in a thread", "100.1", UNSIGNED);
    await admin.update("C1", "5.5", "edited from the console", UNSIGNED);
    for (const [, args] of calls) {
      expect(JSON.stringify(args.blocks)).not.toContain(FOOTER_BLOCK_ID);
      expect(footerOf(args)?.type).toBe("markdown");
    }
    expect(calls[0]?.[1]).toMatchObject({ channel: "C9", text: "hello there" });
    expect(calls[1]?.[1]).toMatchObject({ thread_ts: "100.1" });
    expect(calls[2]?.[1]).toMatchObject({ channel: "C1", ts: "5.5", text: "edited from the console" });
  });

  test("an unsigned Block Kit post keeps its blocks and gains no footer", async () => {
    const { calls, admin } = fake();
    await admin.post("C9", blockKitReply("*cpu* fine", [{ type: "header", text: { type: "plain_text", text: "ok" } }]), undefined, UNSIGNED);
    expect((calls[0]?.[1].blocks as Block[]).map((b) => b.type)).toEqual(["header"]);
  });

  test("a refused rewrite still edits the words, text-only", async () => {
    const calls: Record<string, unknown>[] = [];
    const client = {
      chat: {
        update: async (a: Record<string, unknown>) => {
          calls.push(a);
          if (a.blocks) throw new Error("block_mismatch");
        },
      },
    } as unknown as WebClient;
    await createSlackAdmin(client).update("C1", "5.5", "edited");
    expect(calls).toHaveLength(3);
    expect(calls[2]).toEqual({ channel: "C1", ts: "5.5", text: "edited" });
  });

  test("an edit whose markdown block is refused is retried as signed sections, not text-only", async () => {
    const calls: Record<string, unknown>[] = [];
    const client = {
      chat: {
        update: async (a: Record<string, unknown>) => {
          calls.push(a);
          if ((a.blocks as Block[] | undefined)?.some((b) => b.type === "markdown")) throw new Error("invalid_blocks");
        },
      },
    } as unknown as WebClient;
    await createSlackAdmin(client).update("C1", "5.5", "draining: 1 turn left", "command");
    expect(calls).toHaveLength(2);
    expect((calls[1]?.blocks as Block[]).map((b) => b.type)).toEqual(["section", "context"]);
    expect(signedBy(calls[1])).toBe("command");
  });

  test("a refused settle still drops the buttons, unsigned, then falls back to text-only", async () => {
    const calls: Record<string, unknown>[] = [];
    let refusals = 2;
    const client = {
      chat: {
        update: async (a: Record<string, unknown>) => {
          calls.push(a);
          if (refusals-- > 0) throw new Error("invalid_blocks");
        },
      },
    } as unknown as WebClient;
    await createSlackAdmin(client).settleInteractive("C1", "6.6", "approved");
    expect(calls).toHaveLength(3);
    expect(calls[1]).toEqual({ channel: "C1", ts: "6.6", text: "approved", blocks: [{ type: "section", text: { type: "mrkdwn", text: "approved" } }] });
    expect(calls[2]).toEqual({ channel: "C1", ts: "6.6", text: "approved" });
  });

  test("a signed edit of one very long line stays within Slack's markdown cap", async () => {
    const { calls, admin } = fake();
    await admin.update("C1", "5.5", "z".repeat(9000));
    const blocks = calls[0]?.[1].blocks as { type: string; text?: string }[];
    expect(blocks.map((b) => b.type)).toEqual(["markdown", "context"]);
    expect(blocks[0]?.text).toBe("z".repeat(9000));
  });

  test("buttons and menus carry the footer under their actions", async () => {
    const { calls, admin } = fake();
    const actions = [{ actionId: "a", label: "Yes", value: "y" }];
    await admin.postInteractive("C1", "ok?", actions, "100.1");
    await admin.postDmInteractive("U1", "ok?", actions);
    await admin.postMenu("C1", "pick", { actions });
    for (const [, a] of calls) {
      const types = (a.blocks as Block[]).map((b) => b.type);
      expect(types.slice(-2)).toEqual(["actions", "context"]);
      expect(signedBy(a)).toBe("Jarvis");
    }
  });
});

describe("workspaceUrl", () => {
  const withAuth = (url: string | undefined) => {
    let calls = 0;
    const client = {
      auth: { test: async () => (calls++, { user_id: "UBOT", url }) },
    } as unknown as WebClient;
    return { admin: createSlackAdmin(client), calls: () => calls };
  };

  test("is the auth.test url without its trailing slash, asked of Slack once", async () => {
    const { admin, calls } = withAuth("https://acme.slack.com/");
    expect(await admin.workspaceUrl?.()).toBe("https://acme.slack.com");
    expect(await admin.workspaceUrl?.()).toBe("https://acme.slack.com");
    expect(calls()).toBe(1);
  });

  test("is undefined when Slack gave no url, and is asked again next time", async () => {
    const { admin, calls } = withAuth(undefined);
    expect(await admin.workspaceUrl?.()).toBeUndefined();
    await admin.workspaceUrl?.();
    expect(calls()).toBe(2);
  });
});

describe("the console's reads", () => {
  const readClient = (over: Record<string, unknown>) => createSlackAdmin({ auth: { test: async () => ({ user_id: "UBOT" }) }, users: { info: async () => ({ user: { name: "ann" } }) }, ...over } as unknown as WebClient);

  test("conversations.list pages channels (public and private) or DMs, archived left out, with the cursor handed on", async () => {
    const asked: Record<string, unknown>[] = [];
    const admin = readClient({
      conversations: {
        list: async (a: Record<string, unknown>) => {
          asked.push(a);
          return a.types === "im"
            ? { channels: [{ id: "D1", is_im: true, user: "U5" }] }
            : { channels: [{ id: "C1", name: "ops" }, { id: "G1", name: "secret", is_private: true }, { name: "no-id" }], response_metadata: { next_cursor: "n2" } };
        },
      },
    });
    expect(await admin.listConversationPage!("channels", "c1")).toEqual({
      conversations: [{ id: "C1", name: "ops", kind: "channel" }, { id: "G1", name: "secret", kind: "group" }],
      nextCursor: "n2",
    });
    expect(await admin.listConversationPage!("dms")).toEqual({ conversations: [{ id: "D1", name: "", kind: "im", userId: "U5" }] });
    expect(asked[0]).toMatchObject({ types: "public_channel,private_channel", exclude_archived: true, cursor: "c1" });
    expect(asked[1]).toMatchObject({ types: "im" });
    expect(asked[1]).not.toHaveProperty("cursor");
  });

  test("history marks bot-posted messages: Jarvis as own, another app as bot, a person as neither", async () => {
    const admin = readClient({
      conversations: {
        history: async () => ({
          messages: [
            { ts: "3.0", user: "U5", text: "hi from a person" },
            { ts: "2.0", user: "UOTHER", bot_id: "B2", text: "deploy finished" },
            { ts: "1.0", user: "UBOT", bot_id: "B1", text: "from jarvis" },
          ],
        }),
      },
    });
    const page = await admin.history("C1", 50);
    expect(page.messages.map((m) => [m.ts, m.own, m.bot ?? false])).toEqual([["1.0", true, true], ["2.0", false, true], ["3.0", false, false]]);
  });

  test("replies follows the cursor so a long thread's newest replies are in the result", async () => {
    const asked: Record<string, unknown>[] = [];
    const admin = readClient({
      conversations: {
        replies: async (a: Record<string, unknown>) => {
          asked.push(a);
          return a.cursor
            ? { messages: [{ ts: "3.0", user: "U5", text: "newest" }] }
            : { messages: [{ ts: "1.0", user: "U5", text: "root" }, { ts: "2.0", user: "U5", text: "mid" }], response_metadata: { next_cursor: "p2" } };
        },
      },
    });
    expect((await admin.replies("C1", "1.0")).map((m) => m.ts)).toEqual(["1.0", "2.0", "3.0"]);
    expect(asked.map((a) => a.cursor)).toEqual([undefined, "p2"]);
  });
});
