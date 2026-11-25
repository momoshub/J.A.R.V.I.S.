/**
 * End-to-end: a streamed reply into a thread, against real Slack.
 *
 * Opt-in like `slackBlockKit.e2e.ts` (`JARVIS_E2E=1` + `SLACK_BOT_TOKEN`; see
 * `bun run test:e2e`). It drives the real `createSlackStream` over a real
 * `chat.startStream`/`appendStream`/`stopStream`, feeding it the model's text
 * in small deltas as the CLI would, and reads the thread back: the reply must
 * be ONE message holding the whole text, in the thread, not the channel root.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createSlackStream, type Streamer } from "../src/infrastructure/slack/stream.ts";
import { createStatusMessage, type StatusMessage } from "../src/infrastructure/slack/statusMessage.ts";
import { CHANNEL, enabled, openThread, type E2eThread, type SlackMessage } from "./support.ts";

describe.skipIf(!enabled)("streaming a reply into a thread against real Slack", () => {
  let t: E2eThread;
  beforeAll(async () => {
    t = await openThread("stream");
  });
  afterAll(async () => {
    if (t) await t.cleanup();
  });

  test("start/append/stop leaves ONE message in the thread with the full text", async () => {
    const sentences = Array.from({ length: 12 }, (_, i) => `Sentence number ${i + 1} of the streamed e2e reply.`);
    const answer = sentences.join(" ");
    const stream = createSlackStream(
      () =>
        t.web.chatStream({
          channel: CHANNEL,
          thread_ts: t.rootTs,
          recipient_user_id: t.botUserId,
          recipient_team_id: t.teamId,
        }) as unknown as Streamer,
      (m) => console.log(`  [stream] ${m}`),
    );
    for (const delta of answer.match(/[\s\S]{1,9}/g) ?? []) stream.sink({ type: "text", delta });
    const ok = await stream.finish();
    expect(ok).toBe(true);
    t.track(stream.ts);

    const botMessages = await t.waitFor((all) => {
      const mine = all.filter((m) => m.ts !== t.rootTs && (m.user === t.botUserId || m.bot_id));
      return mine.length > 0 && mine.every((m) => (m.text ?? "").includes("Sentence number 12")) ? mine : undefined;
    });
    expect(botMessages).toBeDefined();
    const mine = botMessages as SlackMessage[];
    console.log(`  stream case: ${mine.length} message(s), ${mine[0]?.text?.length ?? 0} chars`);
    expect(mine).toHaveLength(1);
    const m = mine[0] as SlackMessage;
    expect(m.thread_ts).toBe(t.rootTs);
    for (const s of sentences) expect(m.text ?? "").toContain(s);
  }, 60_000);

  /** A status message on the real thread, as the handler builds it. */
  const realStatus = (deleteDelayMs: number): StatusMessage =>
    createStatusMessage({
      api: {
        post: async (view) => {
          const res = await t.web.chat.postMessage({ channel: CHANNEL, thread_ts: t.rootTs, text: view.text, blocks: view.blocks as never });
          t.track(res.ts);
          return res.ts;
        },
        update: (ts, view) => t.web.chat.update({ channel: CHANNEL, ts, text: view.text, blocks: view.blocks as never }),
        remove: (ts) => t.web.chat.delete({ channel: CHANNEL, ts }),
      },
      log: (m) => console.log(`  [status] ${m}`),
      minIntervalMs: 300,
      deleteDelayMs,
    });

  const blockText = (m: SlackMessage | undefined): string =>
    JSON.stringify((m as { blocks?: unknown } | undefined)?.blocks ?? "");

  test("tool steps show in one separate message that is deleted when the turn ends clean", async () => {
    const status = realStatus(500);
    const stream = createSlackStream(
      () =>
        t.web.chatStream({
          channel: CHANNEL,
          thread_ts: t.rootTs,
          recipient_user_id: t.botUserId,
          recipient_team_id: t.teamId,
        }) as unknown as Streamer,
      (m) => console.log(`  [stream] ${m}`),
      { status },
    );
    stream.sink({ type: "tool", id: "a", title: "Run: Listing files", details: "log at: l.jsonl - line 3", status: "in_progress" });
    stream.sink({ type: "tool", id: "b", title: "Tool: Reading a file", status: "in_progress" });
    stream.sink({ type: "tool", id: "a", title: "Run: Listing files", status: "complete" });
    stream.sink({ type: "text", delta: "Done with the steps." });

    // While the turn runs there is a status message listing the steps, apart from the answer.
    const running = await t.waitFor((all) => {
      const mine = all.filter((m) => m.ts !== t.rootTs && blockText(m).includes("Listing files"));
      return mine[0];
    });
    expect(running).toBeDefined();
    const statusTs = (running as SlackMessage).ts;
    expect(blockText(running)).toContain("Reading a file");
    expect(blockText(running)).toContain("log line 3");
    expect(running?.thread_ts).toBe(t.rootTs);

    stream.sink({ type: "tool", id: "b", title: "Tool: Reading a file", status: "complete" });
    expect(await stream.finish()).toBe(true);
    t.track(stream.ts);
    await status.idle();

    // The answer stays, carries no task cards, and the status message is gone.
    const left = await t.waitFor((all) => (all.some((m) => m.ts === statusTs) ? undefined : all));
    expect(left).toBeDefined();
    const answer = (left as SlackMessage[]).find((m) => m.ts === stream.ts);
    expect(answer?.text ?? "").toContain("Done with the steps.");
    expect(((answer as { blocks?: { type: string }[] }).blocks ?? []).some((b) => b.type === "task_card")).toBe(false);
  }, 90_000);

  test("a turn with a failed step leaves its status message collapsed to the failure", async () => {
    const status = realStatus(500);
    status.step({ id: "ok", title: "Tool: Reading a file", state: "complete" });
    status.step({ id: "bad", title: "Run: Calling a URL", state: "error" });
    status.step({ id: "ok2", title: "Tool: Searching the code", state: "complete" });
    await status.end();
    await status.idle();
    const kept = await t.waitFor((all) => all.find((m) => blockText(m).includes("3 steps, 1 failed")));
    expect(kept).toBeDefined();
    expect(blockText(kept)).toContain("Calling a URL");
    expect(blockText(kept)).not.toContain("Searching the code");
  }, 90_000);
});
