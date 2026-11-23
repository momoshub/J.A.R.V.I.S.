import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";

setDefaultTimeout(30_000);

const SCRIPT = join(import.meta.dir, "..", "..", "bin", "slack-wait.sh");
const PAGE = 200;

type Msg = { user: string; ts: string; text: string; bot_id?: string; thread_ts?: string };

/** A thread of `n` messages by the bot and, from `humanFrom` on, one person: ts 1000.000001 ... */
const thread = (n: number, humanFrom: number): Msg[] =>
  Array.from({ length: n }, (_, i) => ({
    user: i + 1 >= humanFrom ? "UHUMAN0001" : "UBOT0000001",
    ts: `${1000 + i}.000001`,
    text: `message ${i + 1}`,
    thread_ts: "1000.000001",
  }));

/**
 * A stand-in for the bot's Slack proxy that behaves like conversations.replies: oldest first, `oldest`
 * exclusive, 200 per page with a cursor. No network, and it logs what was asked.
 */
const fakeProxy = (messages: Msg[]) => {
  const calls: Record<string, string>[] = [];
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const { method, params } = (await req.json()) as { method: string; params: Record<string, string> };
      calls.push({ method, ...params });
      if (method !== "conversations.replies") return Response.json({ ok: false, error: "unexpected" });
      // a reply's own ts is not a thread: Slack answers with just that message, naming its root
      const own = messages.find((m) => m.ts === params.ts);
      if (own?.thread_ts && own.thread_ts !== own.ts) return Response.json({ ok: true, messages: [own], has_more: false });
      if (params.limit === "1") return Response.json({ ok: true, messages: own ? [own] : [] });
      const oldest = Number(params.oldest ?? 0);
      const start = Number(params.cursor ?? 0);
      const matching = messages.filter((m) => Number(m.ts) > oldest);
      const page = matching.slice(start, start + PAGE);
      const more = start + PAGE < matching.length;
      return Response.json({
        ok: true,
        messages: page,
        has_more: more,
        ...(more ? { response_metadata: { next_cursor: String(start + PAGE) } } : {}),
      });
    },
  });
  return { server, calls, url: `http://127.0.0.1:${server.port}/api/slack` };
};

let current: ReturnType<typeof fakeProxy> | undefined;
afterEach(() => current?.server.stop(true));

const wait = async (messages: Msg[], args: string[]) => {
  current = fakeProxy(messages);
  const proc = Bun.spawn({
    cmd: ["bash", SCRIPT, ...args],
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, SLACK_BOT_TOKEN: undefined, JARVIS_SLACK_TICKET: "jvsl_test", JARVIS_SLACK_API_URL: current.url },
  });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, stdout, stderr, calls: current.calls };
};

describe("slack-wait.sh on a long thread", () => {
  test("a watch anchored mid-thread fires on the next non-bot message past the 200th", async () => {
    // 300 messages; the anchor is message 250 and the only person speaks at 290
    const msgs = thread(300, 290);
    const r = await wait(msgs, ["C1", "1000.000001", "1249.000001", "UHUMAN0001"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("message 290");
  });

  test("without a from-user it fires on the first newer message of anyone", async () => {
    const r = await wait(thread(300, 290), ["C1", "1000.000001", "1249.000001"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("message 251");
  });

  test("it asks only for what is newer than the anchor, and follows the cursor", async () => {
    // 600 messages, the anchor at 10, the person speaks only at 590: needs three pages
    const r = await wait(thread(600, 590), ["C1", "1000.000001", "1009.000001", "UHUMAN0001"]);
    expect(r.code).toBe(0);
    const pages = r.calls.filter((c) => c.limit === "200");
    expect(pages.every((c) => c.oldest === "1009.000001")).toBe(true);
    expect(pages.length).toBe(3);
    expect(pages[1]?.cursor).toBe("200");
  });

  test("a watch armed on a reply's ts polls the thread that reply sits in", async () => {
    // 'message 50' is a reply, not the root: reading it directly returns only itself
    const r = await wait(thread(300, 120), ["C1", "1049.000001", "1049.000001", "UHUMAN0001"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("message 120");
  });

  test("nothing new after the anchor is exit 1", async () => {
    const r = await wait(thread(300, 10_000), ["C1", "1000.000001", "1299.000001", "UHUMAN0001"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
  });

  test("a person who never spoke after the anchor is exit 1, even with bot replies there", async () => {
    const r = await wait(thread(300, 10_000), ["C1", "1000.000001", "1249.000001", "UHUMAN0001"]);
    expect(r.code).toBe(1);
  });

  test("an unreadable thread is exit 2 with a reason, never a quiet 1", async () => {
    current = { ...fakeProxy([]) };
    current.server.stop(true);
    const proc = Bun.spawn({
      cmd: ["bash", SCRIPT, "C1", "1000.000001", "1.0"],
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, JARVIS_SLACK_TICKET: "jvsl_test", JARVIS_SLACK_API_URL: current.url },
    });
    const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    expect(code).toBe(2);
    expect(stderr.trim()).not.toBe("");
  });
});
