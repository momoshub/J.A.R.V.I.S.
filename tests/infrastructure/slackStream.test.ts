import { describe, expect, test } from "bun:test";
import { createSlackStream, rolloverCut, type Streamer } from "../../src/infrastructure/slack/stream.ts";
import type { StatusMessage } from "../../src/infrastructure/slack/statusMessage.ts";
import type { StatusStep } from "../../src/domain/statusSteps.ts";

type StatusEvent = { kind: "step"; step: StatusStep } | { kind: "thinking"; label: string | undefined } | { kind: "end"; discard: boolean };

/** A status message that only records what the stream told it. */
const stubStatus = () => {
  const events: StatusEvent[] = [];
  const status: StatusMessage = {
    step: (step) => void events.push({ kind: "step", step }),
    thinking: (label) => void events.push({ kind: "thinking", label }),
    steps: [],
    posted: false,
    end: async (o) => void events.push({ kind: "end", discard: o?.discard === true }),
    idle: async () => {},
  };
  const steps = () => events.flatMap((e) => (e.kind === "step" ? [e.step] : []));
  return { status, events, steps };
};

type Call = { markdown_text?: string; chunks?: unknown[] };

const fakeStreamer = (opts: { failAppend?: boolean; failStop?: boolean } = {}) => {
  const appends: Call[] = [];
  let stopped = 0;
  let made = 0;
  const streamer: Streamer = {
    append: async (a) => {
      if (opts.failAppend) throw new Error("append boom");
      appends.push(a as Call);
    },
    stop: async () => {
      if (opts.failStop) throw new Error("stop boom");
      stopped += 1;
    },
  };
  const make = () => {
    made += 1;
    return streamer;
  };
  return { make, appends, stopped: () => stopped, made: () => made };
};

describe("createSlackStream", () => {
  test("does not open a stream until an event arrives", () => {
    const f = fakeStreamer();
    const s = createSlackStream(f.make);
    expect(s.started).toBe(false);
    expect(f.made()).toBe(0);
  });

  test("the KEEP_REPLY marker never reaches the live stream, even split across chunks", async () => {
    const f = fakeStreamer();
    const s = createSlackStream(f.make);
    for (const delta of ["Correction: not green.\n", "KEEP_", "REPLY"]) s.sink({ type: "text", delta });
    await s.finish();
    const shown = f.appends.map((a) => a.markdown_text ?? "").join("");
    expect(shown).toContain("not green");
    expect(shown).not.toContain("KEEP");
    expect(s.parts.map((p) => p.text).join("")).not.toContain("KEEP_REPLY");
  });

  test("a closing KEEP_REPLY after the sign line and an emoji never reaches the stream (bug #20)", async () => {
    for (const deltas of [["Answer.\n", "Done, sir 🐦‍🔥 KEEP_REPLY"], ["Answer.\nDone, sir 🐦‍🔥 KEEP_", "REPLY"], ["Answer.\nDone, sir 🐦‍🔥KEEP_REPLY"]]) {
      const f = fakeStreamer();
      const s = createSlackStream(f.make);
      for (const delta of deltas) s.sink({ type: "text", delta });
      await s.finish();
      const shown = f.appends.map((a) => a.markdown_text ?? "").join("");
      expect(shown).toContain("Done, sir 🐦‍🔥");
      expect(shown).not.toContain("KEEP");
      expect(s.parts.map((p) => p.text).join("")).not.toContain("KEEP_REPLY");
    }
  });

  test("a one-line reply ending in the marker token is delivered: finish answers true and shows it (bug #20)", async () => {
    for (const delta of ["Done, sir 🐦‍🔥 KEEP_REPLY", "Done, sir 🐦‍🔥 K"]) {
      const f = fakeStreamer();
      const s = createSlackStream(f.make);
      s.sink({ type: "text", delta });
      expect(await s.finish()).toBe(true);
      expect(f.appends.map((a) => a.markdown_text ?? "").join("")).toBe(delta.endsWith("K") ? delta : "Done, sir 🐦‍🔥");
    }
  });

  test("blank text never opens a message or goes out on its own (bug #20: empty posts)", async () => {
    const f = fakeStreamer();
    const s = createSlackStream(f.make);
    s.sink({ type: "text", delta: "\n" });
    s.sink({ type: "text", delta: "  \n\n" });
    s.sink({ type: "tool", id: "t1", title: "Run: step", status: "in_progress" });
    s.sink({ type: "text", delta: "\n" });
    expect(f.made()).toBe(0);
    s.sink({ type: "text", delta: "First.\n" });
    s.sink({ type: "text", delta: "\n" });
    s.sink({ type: "text", delta: "Second." });
    s.sink({ type: "text", delta: "\n\n" });
    const ok = await s.finish();
    expect(ok).toBe(true);
    const sent = f.appends.map((a) => a.markdown_text ?? "");
    expect(sent.every((t) => t.trim() !== "")).toBe(true);
    expect(sent.join("")).toBe("First.\n\nSecond.");
  });

  test("a stream of blank text only opens nothing and delivers nothing", async () => {
    const f = fakeStreamer();
    const s = createSlackStream(f.make);
    for (const delta of ["\n", " ", "\n\n"]) s.sink({ type: "text", delta });
    expect(await s.finish()).toBe(false);
    expect(f.made()).toBe(0);
    expect(f.appends).toEqual([]);
  });

  test("bufferText: text before it streams, text after it is held back, finish says the reply was not delivered", async () => {
    const f = fakeStreamer();
    const st = stubStatus();
    let hold = false;
    const s = createSlackStream(f.make, () => {}, { status: st.status, bufferText: () => hold });
    s.sink({ type: "text", delta: "Looking.\n" });
    hold = true;
    s.sink({ type: "text", delta: "The answer." });
    s.sink({ type: "tool", id: "t1", title: "Run: step", status: "in_progress" });
    const ok = await s.finish();
    expect(ok).toBe(false);
    expect(f.appends.map((a) => a.markdown_text ?? "").join("")).toBe("Looking.\n");
    expect(f.stopped()).toBe(1);
    // tool steps still reach the status message
    expect(st.steps().map((x) => x.id)).toEqual(["t1"]);
  });

  test("bufferText true from the start: no stream is ever opened", async () => {
    const f = fakeStreamer();
    const s = createSlackStream(f.make, () => {}, { bufferText: () => true });
    s.sink({ type: "text", delta: "The whole answer.\n" });
    expect(await s.finish()).toBe(false);
    expect(f.made()).toBe(0);
    expect(f.appends).toHaveLength(0);
    expect(s.parts).toHaveLength(0);
  });

  test("streams the text; the tool steps go to the status message, never into the stream", async () => {
    const f = fakeStreamer();
    const st = stubStatus();
    const s = createSlackStream(f.make, () => {}, { status: st.status });
    s.sink({ type: "text", delta: "Hello " });
    s.sink({ type: "tool", id: "t1", title: "Run: 🏃 Listing files", details: "log at: l.jsonl - line 4", status: "in_progress" });
    s.sink({ type: "tool", id: "t1", title: "Run: 🏃 Listing files", status: "complete" });
    s.sink({ type: "text", delta: "world" });
    const ok = await s.finish();
    expect(ok).toBe(true);
    expect(s.started).toBe(true);
    expect(f.stopped()).toBe(1);
    // no task_update card (or any chunk) in the answer's stream
    expect(f.appends).toEqual([{ markdown_text: "Hello " }, { markdown_text: "world" }]);
    expect(st.steps()).toEqual([
      { id: "t1", title: "Run: 🏃 Listing files", state: "in_progress", logLine: "4" },
      { id: "t1", title: "Run: 🏃 Listing files", state: "complete" },
    ]);
  });

  test("a turn that only ran tools opens no stream, so the caller posts its reply", async () => {
    const f = fakeStreamer();
    const st = stubStatus();
    const s = createSlackStream(f.make, () => {}, { status: st.status });
    s.sink({ type: "tool", id: "t1", title: "Reading a file", status: "in_progress" });
    s.sink({ type: "tool", id: "t1", title: "Reading a file", status: "complete" });
    expect(await s.finish()).toBe(false);
    expect(f.made()).toBe(0);
    expect(s.started).toBe(false);
    expect(st.steps()).toHaveLength(2);
  });

  test("finish leaves the status message to the caller, which knows whether the reply is kept", async () => {
    const f = fakeStreamer();
    const st = stubStatus();
    const s = createSlackStream(f.make, () => {}, { status: st.status });
    s.sink({ type: "tool", id: "t1", title: "Reading a file", status: "complete" });
    s.sink({ type: "text", delta: "hi" });
    await s.finish();
    expect(st.events.map((e) => e.kind)).toEqual(["step"]);
  });

  test("without a status message the steps are simply not shown, and the answer streams on", async () => {
    const f = fakeStreamer();
    const s = createSlackStream(f.make);
    s.sink({ type: "tool", id: "t1", title: "Reading a file", status: "in_progress" });
    s.sink({ type: "text", delta: "hi" });
    expect(await s.finish()).toBe(true);
    expect(f.appends).toEqual([{ markdown_text: "hi" }]);
  });

  test("a repeated step with a different log line per call still shares one line", async () => {
    const f = fakeStreamer();
    const st = stubStatus();
    const s = createSlackStream(f.make, () => {}, { status: st.status });
    s.sink({ type: "tool", id: "t1", title: "Tool: 📖 Reading a file", details: "log at: l.jsonl - line 3", status: "in_progress" });
    s.sink({ type: "tool", id: "t2", title: "Tool: 📖 Reading a file", details: "log at: l.jsonl - line 9", status: "in_progress" });
    await s.finish();
    expect(st.steps().map((x) => x.id)).toEqual(["t1", "t1"]);
    expect(st.steps()[1]).toMatchObject({ title: "Tool: 📖 Reading a file (2 runs)", logLine: "3" });
  });

  test("repeats of the same step share one line that counts the runs", async () => {
    const f = fakeStreamer();
    const st = stubStatus();
    const s = createSlackStream(f.make, () => {}, { status: st.status });
    s.sink({ type: "tool", id: "t1", title: "Querying a database", status: "in_progress" });
    s.sink({ type: "tool", id: "t1", title: "Querying a database", status: "complete" });
    s.sink({ type: "tool", id: "t2", title: "Querying a database", status: "in_progress" });
    s.sink({ type: "tool", id: "t3", title: "Querying a database", status: "in_progress" });
    s.sink({ type: "tool", id: "t2", title: "Querying a database", status: "complete" });
    s.sink({ type: "tool", id: "t3", title: "Querying a database", status: "error" });
    s.sink({ type: "tool", id: "t4", title: "Run: 🏃 Listing files", status: "in_progress" });
    await s.finish();
    expect(st.steps().map((c) => [c.id, c.title, c.state])).toEqual([
      ["t1", "Querying a database", "in_progress"],
      ["t1", "Querying a database", "complete"],
      ["t1", "Querying a database (2 runs)", "in_progress"],
      ["t1", "Querying a database (3 runs)", "in_progress"],
      ["t1", "Querying a database (3 runs)", "error"],
      ["t4", "Run: 🏃 Listing files", "in_progress"],
    ]);
  });

  test("different titles are different steps, whatever log line they point at", async () => {
    const f = fakeStreamer();
    const st = stubStatus();
    const s = createSlackStream(f.make, () => {}, { status: st.status });
    const sql = "MCP: 🔌 acme-pg-prod execute_sql";
    s.sink({ type: "tool", id: "q1", title: sql, details: "log at: l.jsonl - line 1", status: "in_progress" });
    s.sink({ type: "tool", id: "q2", title: "Tool: 📖 Reading a file", details: "log at: l.jsonl - line 5", status: "in_progress" });
    s.sink({ type: "tool", id: "q3", title: sql, details: "log at: l.jsonl - line 9", status: "in_progress" });
    await s.finish();
    expect(st.steps().map((c) => [c.id, c.title, c.logLine])).toEqual([
      ["q1", sql, "1"],
      ["q2", "Tool: 📖 Reading a file", "5"],
      ["q1", `${sql} (2 runs)`, "1"],
    ]);
  });

  test("skips empty text deltas", async () => {
    const f = fakeStreamer();
    const s = createSlackStream(f.make);
    s.sink({ type: "text", delta: "" });
    // an empty delta still opens the stream lazily via ensure(); assert no append queued
    await s.finish();
    expect(f.appends).toHaveLength(0);
  });

  test("finish returns false when an append fails", async () => {
    const f = fakeStreamer({ failAppend: true });
    const s = createSlackStream(f.make);
    s.sink({ type: "text", delta: "hi" });
    expect(await s.finish()).toBe(false);
  });

  test("finish returns false when a rollover could not close its message", async () => {
    const messages: { text: string; stopFails: boolean }[] = [];
    const make = (): Streamer => {
      const m = { text: "", stopFails: messages.length === 0 };
      messages.push(m);
      return {
        append: async (a) => void (m.text += (a as Call).markdown_text ?? ""),
        stop: async () => {
          if (m.stopFails) throw new Error("message_not_in_streaming_state");
        },
        ts: `ts.${messages.length}`,
      };
    };
    const logs: string[] = [];
    const s = createSlackStream(make, (l) => void logs.push(l));
    s.sink({ type: "text", delta: "a".repeat(10_000) });
    s.sink({ type: "text", delta: "b".repeat(3_000) });
    expect(await s.finish()).toBe(false);
    expect(logs.some((l) => l.includes("rollover stop failed"))).toBe(true);
    expect(s.parts.map((p) => p.ts)).toEqual(["ts.1", "ts.2"]);
  });

  test("a message that opened but took no append is an orphan, not a part", async () => {
    const s = createSlackStream(() => ({
      append: async () => {
        throw new Error("message_not_in_streaming_state");
      },
      stop: async () => {},
      ts: "9.9",
    }));
    s.sink({ type: "text", delta: "hello" });
    expect(await s.finish()).toBe(false);
    expect(s.parts).toEqual([]);
    expect(s.orphans).toEqual(["9.9"]);
  });

  test("finish returns false when stop fails", async () => {
    const f = fakeStreamer({ failStop: true });
    const s = createSlackStream(f.make);
    s.sink({ type: "text", delta: "hi" });
    expect(await s.finish()).toBe(false);
  });

  test("finish on an unopened stream returns false", async () => {
    const f = fakeStreamer();
    const s = createSlackStream(f.make);
    expect(await s.finish()).toBe(false);
  });

  test("shows a thinking line first and takes it away on the first content", async () => {
    const f = fakeStreamer();
    const st = stubStatus();
    const s = createSlackStream(f.make, () => {}, { status: st.status });
    s.showThinking("☄️ burning acme token..");
    s.sink({ type: "text", delta: "Hi" });
    const ok = await s.finish();
    expect(ok).toBe(true);
    expect(st.events.slice(0, 2)).toEqual([
      { kind: "thinking", label: "☄️ burning acme token.." },
      { kind: "thinking", label: undefined },
    ]);
    // it lives in the status message: the answer's stream carries only the text
    expect(f.appends).toEqual([{ markdown_text: "Hi" }]);
  });

  test("showThinking without any content finishes as not-shown, and the line is taken away", async () => {
    const f = fakeStreamer();
    const st = stubStatus();
    const s = createSlackStream(f.make, () => {}, { status: st.status });
    s.showThinking("☄️ burning acme token..");
    expect(await s.finish()).toBe(false);
    expect(st.events.map((e) => e.kind)).toEqual(["thinking", "thinking"]);
  });
});

describe("hidden actions", () => {
  test("a reaction or a localhost call shows no step at all", async () => {
    const f = fakeStreamer();
    const st = stubStatus();
    const stream = createSlackStream(f.make, () => {}, { status: st.status });

    stream.sink({
      type: "tool",
      id: "t1",
      title: "run: curl ... reactions.add",
      command: 'curl -X POST -d "channel=C1&name=eyes" https://slack.com/api/reactions.add',
      status: "complete",
    });
    stream.sink({
      type: "tool",
      id: "t2",
      title: "run: curl localhost",
      command: "curl -s http://127.0.0.1:2002/api/learnings",
      status: "complete",
    });

    await stream.finish();
    expect(st.steps()).toHaveLength(0);
    expect(stream.started).toBe(false); // not even a stream opened for these
  });

  test("a real tool call still shows, in the status message", async () => {
    const f = fakeStreamer();
    const st = stubStatus();
    const stream = createSlackStream(f.make, () => {}, { status: st.status });
    stream.sink({
      type: "tool",
      id: "t1",
      title: "run: gh pr view",
      command: "gh pr view https://github.com/o/r/pull/1",
      status: "complete",
    });
    await stream.finish();
    expect(st.steps()).toEqual([{ id: "t1", title: "run: gh pr view", state: "complete" }]);
    expect(f.appends).toHaveLength(0);
  });
});

describe("delayed thinking line", () => {
  const mk = () => {
    const f = fakeStreamer();
    const st = stubStatus();
    const stream = createSlackStream(f.make, () => {}, { status: st.status });
    return { f, st, stream };
  };
  const shown = (st: ReturnType<typeof stubStatus>) => st.events.some((e) => e.kind === "thinking" && e.label !== undefined);

  test("stays hidden when content arrives before the delay is up", async () => {
    const { st, stream } = mk();
    stream.showThinkingAfter("thinking..", 50);
    stream.sink({ type: "text", delta: "immediate answer" });
    await new Promise((r) => setTimeout(r, 80)); // let the timer have its chance
    await stream.finish();
    expect(shown(st)).toBe(false);
  });

  test("appears once the turn has been silent for the delay", async () => {
    const { st, f, stream } = mk();
    stream.showThinkingAfter("thinking..", 5);
    await new Promise((r) => setTimeout(r, 30));
    expect(shown(st)).toBe(true);
    // it is the status message's line: no stream opened for it
    expect(f.made()).toBe(0);
  });

  test("a hidden action does not count as content, so the line still comes", async () => {
    const { st, stream } = mk();
    stream.showThinkingAfter("thinking..", 15);
    stream.sink({
      type: "tool",
      id: "t1",
      title: "run: curl reactions.add",
      command: "curl -X POST https://slack.com/api/reactions.add",
      status: "complete",
    });
    await new Promise((r) => setTimeout(r, 40));
    expect(shown(st)).toBe(true);
  });

  test("a visible tool ends the line, since it is content", async () => {
    const { st, stream } = mk();
    stream.showThinking("thinking..");
    stream.sink({ type: "tool", id: "t1", title: "Reading a file", status: "in_progress" });
    expect(st.events.map((e) => e.kind)).toEqual(["thinking", "thinking", "step"]);
    await stream.finish();
  });

  test("finishing cancels a pending line", async () => {
    const { st, stream } = mk();
    stream.showThinkingAfter("thinking..", 20);
    await stream.finish();
    await new Promise((r) => setTimeout(r, 40));
    expect(shown(st)).toBe(false);
  });
});

describe("the 12,000 character wall", () => {
  /** A streamer whose every `make` is a distinct message, so rollovers show up. */
  const multi = () => {
    const messages: { text: string; stopped: boolean }[] = [];
    const make = (): Streamer => {
      const m = { text: "", stopped: false };
      messages.push(m);
      return {
        ts: `ts-${messages.length}`,
        append: async (a) => {
          if (a.markdown_text) m.text += a.markdown_text;
          // Slack's real behaviour, measured: past 12,000 it refuses outright
          // and the answer is lost rather than truncated.
          if (m.text.length > 12_000) throw new Error("An API error occurred: msg_too_long");
        },
        stop: async () => {
          m.stopped = true;
        },
      };
    };
    return { make, messages };
  };

  test("a long reply rolls into a second message instead of being lost", async () => {
    const f = multi();
    const s = createSlackStream(f.make);
    // 20,000 characters, comfortably past one message's allowance
    for (let i = 0; i < 20; i++) s.sink({ type: "text", delta: "x".repeat(1000) });
    const ok = await s.finish();

    expect(ok).toBe(true);
    expect(f.messages.length).toBeGreaterThan(1);
    // nothing dropped on the floor
    expect(f.messages.map((m) => m.text).join("").length).toBe(20_000);
    // and every message is within what Slack will take
    expect(f.messages.every((m) => m.text.length <= 12_000)).toBe(true);
  });

  test("it reports each message and the part it showed", async () => {
    const short = multi();
    const a = createSlackStream(short.make);
    a.sink({ type: "text", delta: "hi" });
    await a.finish();
    expect(a.parts).toEqual([{ ts: "ts-1", text: "hi" }]);

    const long = multi();
    const b = createSlackStream(long.make);
    for (let i = 0; i < 20; i++) b.sink({ type: "text", delta: "x".repeat(1000) });
    await b.finish();
    expect(b.parts.length).toBe(long.messages.length);
    expect(b.parts.length).toBeGreaterThan(1);
    expect(b.parts.map((p) => p.text)).toEqual(long.messages.map((m) => m.text));
  });

  test("a Block Kit chunk is kept in its part as a fence, so the part can be rebuilt", async () => {
    const f = multi();
    const s = createSlackStream(f.make);
    s.sink({ type: "text", delta: 'before\n```blockkit\n[{"type":"divider"}]\n```\nafter' });
    await s.finish();
    const text = s.parts[0]?.text ?? "";
    expect(text).toContain("before");
    expect(text).toContain('```blockkit\n[{"type":"divider"}]\n```');
    expect(text).toContain("after");
  });

  test("the message before a rollover is closed properly", async () => {
    const f = multi();
    const s = createSlackStream(f.make);
    for (let i = 0; i < 15; i++) s.sink({ type: "text", delta: "y".repeat(1000) });
    await s.finish();

    expect(f.messages.every((m) => m.stopped)).toBe(true);
  });

  test("a rollover never cuts a word in half", async () => {
    const f = multi();
    const s = createSlackStream(f.make);
    const words = "restart once idle ".repeat(1200);
    s.sink({ type: "text", delta: words });
    await s.finish();

    expect(f.messages.length).toBeGreaterThan(1);
    expect(f.messages.map((m) => m.text).join("")).toBe(words);
    expect(f.messages.slice(0, -1).every((m) => m.text.endsWith(" "))).toBe(true);
  });

  test("a single delta bigger than the budget is split, not dropped", async () => {
    const f = multi();
    const s = createSlackStream(f.make);
    s.sink({ type: "text", delta: "z".repeat(30_000) });
    await s.finish();

    expect(f.messages.map((m) => m.text).join("")).toBe("z".repeat(30_000));
  });
});

describe("Slack's own count of the 12,000", () => {
  /** Slack counts blocks toward the same 12,000 as text. */
  const multi = (cap = 12_000) => {
    const messages: { size: number; stopped: boolean }[] = [];
    const make = (): Streamer => {
      const m = { size: 0, stopped: false };
      messages.push(m);
      return {
        append: async (a) => {
          const add = (a.markdown_text?.length ?? 0) + (a.chunks ? JSON.stringify(a.chunks).length : 0);
          if (m.size + add > cap) throw new Error("An API error occurred: msg_too_long");
          m.size += add;
        },
        stop: async () => {
          m.stopped = true;
        },
      };
    };
    return { make, messages };
  };

  test("a msg_too_long Slack counts differently is retried in a fresh message", async () => {
    // a tighter cap than our budget: our arithmetic says it fits, Slack disagrees
    const f = multi(5_000);
    const s = createSlackStream(f.make);
    for (let i = 0; i < 8; i++) s.sink({ type: "text", delta: "x".repeat(1000) });
    const ok = await s.finish();

    expect(ok).toBe(true);
    expect(f.messages.reduce((n, m) => n + m.size, 0)).toBe(8_000);
  });

  test("a payload too big even for a fresh message still fails cleanly", async () => {
    const f = multi(100);
    const s = createSlackStream(f.make);
    s.sink({ type: "text", delta: "x".repeat(500) });
    expect(await s.finish()).toBe(false);
  });
});

describe("abandoning a turn", () => {
  test("an armed placeholder never fires once the turn is abandoned", async () => {
    // a queued or dropped message used to leave the timer running, and it
    // posted a thinking line into a turn that no longer existed
    const f = fakeStreamer();
    const st = stubStatus();
    const s = createSlackStream(f.make, () => {}, { status: st.status });
    s.showThinkingAfter("thinking...", 10);
    await s.abandon();
    await Bun.sleep(40);

    expect(f.made()).toBe(0);
    expect(s.started).toBe(false);
    expect(st.events.some((e) => e.kind === "thinking" && e.label !== undefined)).toBe(false);
  });

  test("abandoning deletes the status message: a turn that said nothing keeps no failures", async () => {
    const f = fakeStreamer();
    const st = stubStatus();
    const s = createSlackStream(f.make, () => {}, { status: st.status });
    s.showThinking("thinking...");
    const { emptyTs } = await s.abandon();

    // the placeholder is not in a stream, so there is no empty message to hand back
    expect(f.made()).toBe(0);
    expect(emptyTs).toBeUndefined();
    expect(st.events.at(-1)).toEqual({ kind: "end", discard: true });
  });

  test("a turn that said something is left alone", async () => {
    const f = fakeStreamer();
    const s = createSlackStream(f.make);
    s.sink({ type: "text", delta: "half an answer" });
    const { emptyTs } = await s.abandon();

    expect(emptyTs).toBeUndefined();
  });

  test("finish cancels an armed placeholder even when nothing opened a stream", async () => {
    const f = fakeStreamer();
    const s = createSlackStream(f.make);
    s.showThinkingAfter("thinking...", 10);
    expect(await s.finish()).toBe(false);
    await Bun.sleep(40);

    expect(f.made()).toBe(0);
  });
});

describe("holding until the turn is working", () => {
  const hold = { holdUntilWorking: true };

  test("a short reply opens nothing, so the caller posts it or drops it", async () => {
    const f = fakeStreamer();
    const s = createSlackStream(f.make, () => {}, hold);
    s.sink({ type: "text", delta: "nothing to add" });
    expect(await s.finish()).toBe(false);
    expect(f.made()).toBe(0);
  });

  test("a hidden action does not open it", async () => {
    const f = fakeStreamer();
    const s = createSlackStream(f.make, () => {}, hold);
    s.sink({
      type: "tool",
      id: "r",
      title: "react",
      command: "/x/bin/slack-react.sh C1 1.2 eyes",
      status: "complete",
    });
    expect(await s.finish()).toBe(false);
    expect(f.made()).toBe(0);
  });

  test("a visible tool releases the held text into a stream and shows the step in the status message", async () => {
    const f = fakeStreamer();
    const st = stubStatus();
    const s = createSlackStream(f.make, () => {}, { ...hold, status: st.status });
    s.sink({ type: "text", delta: "on it" });
    expect(f.made()).toBe(0);
    s.sink({ type: "tool", id: "t1", title: "run: gh pr view", status: "in_progress" });
    expect(await s.finish()).toBe(true);
    expect(f.appends).toEqual([{ markdown_text: "on it" }]);
    expect(st.steps()).toHaveLength(1);
  });

  test("text longer than a silence note opens it, all of it", async () => {
    const f = fakeStreamer();
    const s = createSlackStream(f.make, () => {}, hold);
    s.sink({ type: "text", delta: "a".repeat(50) });
    expect(f.made()).toBe(0);
    s.sink({ type: "text", delta: "b".repeat(50) });
    s.sink({ type: "text", delta: "c" });
    expect(await s.finish()).toBe(true);
    expect(f.appends.map((a) => a.markdown_text).join("")).toBe(`${"a".repeat(50)}${"b".repeat(50)}c`);
  });

  test("without the option it opens on the first event, as before", () => {
    const f = fakeStreamer();
    const s = createSlackStream(f.make);
    s.sink({ type: "text", delta: "hi" });
    expect(f.made()).toBe(1);
  });
});

describe("createSlackStream block kit", () => {
  test("a blockkit fence goes out as a blocks chunk between the text", async () => {
    const f = fakeStreamer();
    const s = createSlackStream(f.make);
    s.sink({ type: "text", delta: "look:\n```block" });
    s.sink({ type: "text", delta: 'kit\n[{"type":"divider"}]\n```\nthat is all' });
    expect(await s.finish()).toBe(true);
    const text = f.appends.map((a) => a.markdown_text ?? "").join("");
    expect(text).toBe("look:\nthat is all");
    const blocks = f.appends.flatMap((a) => (a.chunks ?? []) as { type: string; blocks?: unknown[] }[]);
    expect(blocks).toEqual([{ type: "blocks", blocks: [{ type: "divider" }] }]);
    // order: the intro text, then the blocks, then the rest
    const kinds = f.appends.map((a) => (a.chunks ? "blocks" : "text"));
    expect(kinds.indexOf("blocks")).toBeGreaterThan(0);
    expect(kinds.lastIndexOf("text")).toBeGreaterThan(kinds.indexOf("blocks"));
  });

  test("a broken fence streams as code instead of vanishing", async () => {
    const f = fakeStreamer();
    const s = createSlackStream(f.make);
    s.sink({ type: "text", delta: "```blockkit\n{nope\n```\n" });
    await s.finish();
    const text = f.appends.map((a) => a.markdown_text ?? "").join("");
    expect(text).toContain("{nope");
    expect(f.appends.some((a) => a.chunks)).toBe(false);
  });
});

test("blocks Slack refuses are shown as code when they hold no words, and the stream carries on", async () => {
  const appends: Call[] = [];
  const streamer: Streamer = {
    append: async (a) => {
      if (a.chunks?.some((c) => c.type === "blocks")) throw new Error("An API error occurred: invalid_blocks");
      appends.push(a as Call);
    },
    stop: async () => {},
  };
  const s = createSlackStream(() => streamer);
  s.sink({ type: "text", delta: 'a\n```blockkit\n[{"type":"alert"}]\n```\nb' });
  expect(await s.finish()).toBe(true);
  const text = appends.map((x) => x.markdown_text ?? "").join("");
  expect(text).toContain('"alert"');
  expect(text.endsWith("b")).toBe(true);
});

describe("a blocks chunk Slack rejects does not kill the stream", () => {
  const TABLE = JSON.stringify([
    {
      type: "table",
      rows: [
        [{ type: "raw_text", text: "Name" }, { type: "raw_text", text: "Qty" }],
        [{ type: "raw_text", text: "widget" }, { type: "raw_text", text: "3" }],
      ],
    },
  ]);

  const refusing = (error: string) => {
    const appends: Call[] = [];
    let stops = 0;
    let opened = 0;
    const streamer: Streamer = {
      append: async (a) => {
        if (a.chunks?.some((c) => c.type === "blocks")) throw new Error(error);
        appends.push(a as Call);
      },
      stop: async () => {
        stops += 1;
      },
      ts: "1.1",
    };
    return { make: () => (opened++, streamer), appends, stops: () => stops, opened: () => opened };
  };

  // The live incident: Slack answered the table chunk with invalid_arguments
  // ("failed to match exactly one allowed schema"), which was not caught, so
  // the stream broke, the reply split in two and the table vanished.
  test("invalid_arguments: the table is written as its words, one message, nothing broken", async () => {
    const f = refusing("An API error occurred: invalid_arguments (failed to match exactly one allowed schema [json-pointer:/chunks/0])");
    const logs: string[] = [];
    const s = createSlackStream(f.make, (m) => logs.push(m));
    s.sink({ type: "text", delta: `before\n\`\`\`blockkit\n${TABLE}\n\`\`\`\nafter` });
    expect(await s.finish()).toBe(true);
    expect(f.opened()).toBe(1);
    const text = f.appends.map((x) => x.markdown_text ?? "").join("");
    expect(text).toContain("Name | Qty\nwidget | 3");
    expect(text.startsWith("before")).toBe(true);
    expect(text.endsWith("after")).toBe(true);
    expect(text).not.toContain("blockkit");
    expect(logs.some((l) => l.includes("blocks refused"))).toBe(true);
    // what the part recorded is words too, so the tidy-up never rebuilds the refused blocks
    expect(s.parts.map((p) => p.text).join("")).not.toContain("blockkit");
  });

  test("invalid_blocks: same", async () => {
    const f = refusing("An API error occurred: invalid_blocks");
    const s = createSlackStream(f.make);
    s.sink({ type: "text", delta: `\`\`\`blockkit\n${TABLE}\n\`\`\`\n` });
    expect(await s.finish()).toBe(true);
    expect(f.appends.map((x) => x.markdown_text ?? "").join("")).toContain("widget | 3");
  });

  test("another failure still breaks the stream, as before", async () => {
    const f = refusing("An API error occurred: ratelimited");
    const s = createSlackStream(f.make);
    s.sink({ type: "text", delta: `\`\`\`blockkit\n${TABLE}\n\`\`\`\n` });
    expect(await s.finish()).toBe(false);
  });

  test("a table with an empty cell is fixed before it is sent, so nothing is refused", async () => {
    const f = fakeStreamer();
    const s = createSlackStream(f.make);
    const table = JSON.stringify([{ type: "table", rows: [[{ type: "raw_text", text: "" }, { type: "raw_text", text: "Qty" }]] }]);
    s.sink({ type: "text", delta: `\`\`\`blockkit\n${table}\n\`\`\`\n` });
    expect(await s.finish()).toBe(true);
    const chunk = f.appends.find((a) => a.chunks)?.chunks?.[0] as { blocks: { rows: { text: string }[][] }[] };
    expect(chunk.blocks[0]?.rows[0]?.map((c) => c.text)).toEqual(["-", "Qty"]);
  });
});

describe("what the run cost", () => {
  const usage = {
    model: "claude-opus-5-5",
    inputTokens: 10,
    outputTokens: 20,
    cacheReadTokens: 30,
    cacheWriteTokens: 40,
    costUsd: 1.5,
    durationMs: 1000,
  };

  test("it is kept for the footer", () => {
    const stream = createSlackStream(fakeStreamer().make);
    stream.sink({ type: "usage", usage });
    expect(stream.usage?.costUsd).toBe(1.5);
  });

  test("it never opens a stream, and never counts as content", () => {
    // it arrives at the very end of EVERY run, including ones that said
    // nothing - opening a message for it would post an empty reply
    const f = fakeStreamer();
    const stream = createSlackStream(f.make);
    stream.sink({ type: "usage", usage });
    expect(f.made()).toBe(0);
    expect(stream.started).toBe(false);
  });
});

describe("rolloverCut", () => {
  test("everything when it fits", () => {
    expect(rolloverCut("hello world", 50, false)).toBe(11);
  });

  test("after a line break first, then a space", () => {
    expect(rolloverCut("ab cd\nef gh", 10, false)).toBe(6);
    expect(rolloverCut("I restart once idle", 12, false)).toBe(10);
  });

  test("no break in reach: roll over first, or hard cut a fresh message", () => {
    expect(rolloverCut("xxxxxxxx", 4, false)).toBe(0);
    expect(rolloverCut("xxxxxxxx", 4, true)).toBe(4);
  });
});
