import { beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { dispatchCommand } from "../../src/application/commands.ts";
import { createWatchRepo } from "../../src/infrastructure/db/watchRepo.ts";
import { openDatabase } from "../../src/infrastructure/db/client.ts";
import { createWatcher } from "../../src/application/watcher.ts";
import { createSlackProxy } from "../../src/application/slackProxy.ts";
import { createSlackTickets, slackTicketContext } from "../../src/application/slackTickets.ts";
import type { SlackAdminPort } from "../../src/application/slackAdmin.ts";
import type { WatchGrant } from "../../src/domain/writeTargets.ts";
import { OWNER, actor, build, db } from "./commandsFixture.ts";

const THREAD = "https://team.slack.com/archives/C0TEAM00001/p1787122692303399";
const TS = "1787122692.303399";
const OWN_THREAD = { threadTs: "9.9" };
const asOwnerTurn = (named: { channel: string; threadTs?: string }[] = []) => ({ ...OWN_THREAD, fromBrainRun: true, ownerTurn: { named } });

describe("watch: who may give it somewhere to write", () => {
  test("in the owner's turn, a thread link in the request becomes a write target and the creator is stored", async () => {
    const deps = build();
    const watches = createWatchRepo(db);
    const out = await dispatchCommand({ ...deps, watches }, actor(), "C1", `watch --until 30m post the screenshots in ${THREAD} when they are ready`, asOwnerTurn());
    expect(out).toContain("may post, react and upload");
    const [w] = watches.waiting();
    expect(w?.createdBy).toBe(OWNER);
    expect(w?.writeTargets).toEqual([{ channel: "C0TEAM00001", threadTs: TS }]);
  });

  test("what the owner's own message named counts too, and the watch's own channel never needs a grant", async () => {
    const deps = build();
    const watches = createWatchRepo(db);
    await dispatchCommand({ ...deps, watches }, actor(), "C1", "watch --until 30m post the result", asOwnerTurn([{ channel: "C0TEAM00002" }, { channel: "C1" }]));
    expect(watches.waiting()[0]?.writeTargets).toEqual([{ channel: "C0TEAM00002" }]);
  });

  test("--to names targets explicitly: a link, a mention, an id, and a #name looked up in the channel list", async () => {
    const deps = build();
    deps.slack = {
      ...deps.slack!,
      listConversationPage: async () => ({ conversations: [{ id: "C0TEAM00004", name: "design-review", kind: "channel" }] }),
    } as SlackAdminPort;
    const watches = createWatchRepo(db);
    const out = await dispatchCommand(
      { ...deps, watches },
      actor(),
      "C1",
      `watch --until 30m --to ${THREAD} --to <#C0TEAM00002|eng> --to C0TEAM00003 --to #Design-Review post the result`,
      asOwnerTurn(),
    );
    expect(out).toContain("may post, react and upload");
    expect(watches.waiting()[0]?.writeTargets).toEqual([
      { channel: "C0TEAM00001", threadTs: TS },
      { channel: "C0TEAM00002" },
      { channel: "C0TEAM00003" },
      { channel: "C0TEAM00004" },
    ]);
  });

  test("a bad --to, an unknown #name and too many targets are refused and nothing is stored", async () => {
    const deps = build();
    deps.slack = { ...deps.slack!, listConversationPage: async () => ({ conversations: [] }) } as SlackAdminPort;
    const watches = createWatchRepo(db);
    const run = (line: string) => dispatchCommand({ ...deps, watches }, actor(), "C1", line, asOwnerTurn());
    expect(await run("watch --until 30m --to nowhere post it")).toContain("is not a place I can write");
    expect(await run("watch --until 30m --to #ghost post it")).toContain("No channel named #ghost");
    const many = Array.from({ length: 11 }, (_, i) => `--to C0TEAM${String(i).padStart(5, "0")}`).join(" ");
    expect(await run(`watch --until 30m ${many} post it`)).toContain("at most 10");
    expect(watches.waiting()).toEqual([]);
  });

  test("a watch with nothing named is still the owner's, but names no place to write", async () => {
    const deps = build();
    const watches = createWatchRepo(db);
    const out = await dispatchCommand({ ...deps, watches }, actor(), "C1", "watch --until 30m look again", asOwnerTurn());
    expect(out).not.toContain("may post, react and upload");
    const [w] = watches.waiting();
    expect(w?.createdBy).toBe(OWNER);
    expect(w?.writeTargets).toEqual([]);
  });

  test("outside an owner-started turn nothing changes: links in the text grant nothing, --to is refused", async () => {
    const deps = build();
    const watches = createWatchRepo(db);
    // the brain's turn, but nobody owner started it (a pal's turn, a loop's fire)
    const brain = { ...OWN_THREAD, fromBrainRun: true };
    await dispatchCommand({ ...deps, watches }, actor(), "C1", `watch --until 30m post it in ${THREAD}`, brain);
    // typed by hand, even by the owner
    await dispatchCommand({ ...deps, watches }, actor(), "C1", `watch --until 30m post it in ${THREAD}`, OWN_THREAD);
    // anyone else
    await dispatchCommand({ ...deps, watches }, actor({ slackId: "U0PAL000001", role: "pal" }), "C1", `watch --until 30m post it in ${THREAD}`, { ...OWN_THREAD, fromBrainRun: true });
    for (const w of watches.waiting()) {
      expect(w.createdBy).toBe("");
      expect(w.writeTargets).toEqual([]);
    }
    expect(watches.waiting()).toHaveLength(3);
    expect(await dispatchCommand({ ...deps, watches }, actor(), "C1", `watch --until 30m --to ${THREAD} post it`, brain)).toContain("only works in the owner's own turn");
    expect(watches.waiting()).toHaveLength(3);
  });

  test("a pal cannot borrow the owner flag: the flag is the run bridge's, and a dispatch without a brain run ignores it", async () => {
    const deps = build();
    const watches = createWatchRepo(db);
    await dispatchCommand({ ...deps, watches }, actor(), "C1", `watch --until 30m post it in ${THREAD}`, { ...OWN_THREAD, ownerTurn: { named: [] } });
    expect(watches.waiting()[0]?.createdBy).toBe("");
  });

  test("watch list says how many places a watch may write", async () => {
    const deps = build();
    const watches = createWatchRepo(db);
    await dispatchCommand({ ...deps, watches }, actor(), "C1", `watch --until 30m post it in ${THREAD}`, asOwnerTurn());
    expect(await dispatchCommand({ ...deps, watches }, actor(), "C1", "watch list")).toContain("may write to 1 other place");
  });
});

describe("watch rows", () => {
  test("a row from before the columns existed loads, with no creator and no targets", () => {
    const old = openDatabase(":memory:");
    const repo = createWatchRepo(old);
    // insert the way the old code did: neither column named
    old.exec(
      `INSERT INTO watches (channel_id, thread_ts, slack_user_id, note, check_cmd, every_ms, deadline_at, next_at, state, attempts, errors, last_error, created_at, updated_at)
       VALUES ('C1', '9.9', 'U7', 'old note', '', 60000, 9000000, 1, 'waiting', 0, 0, '', 1, 1)`,
    );
    const [w] = repo.waiting();
    expect(w?.note).toBe("old note");
    expect(w?.createdBy).toBe("");
    expect(w?.writeTargets).toEqual([]);
  });

  test("a table that already exists without the columns gains them on open, keeping its rows", () => {
    const path = `${process.env.TMPDIR ?? "/tmp"}/watch-migrate-${crypto.randomUUID()}.db`;
    // an earlier release's table, written by hand
    const raw = new Database(path);
    raw.exec(`CREATE TABLE watches (id INTEGER PRIMARY KEY AUTOINCREMENT, channel_id TEXT NOT NULL, thread_ts TEXT NOT NULL, slack_user_id TEXT NOT NULL, note TEXT NOT NULL,
      check_cmd TEXT NOT NULL DEFAULT '', every_ms INTEGER NOT NULL, deadline_at INTEGER NOT NULL, next_at INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'waiting',
      attempts INTEGER NOT NULL DEFAULT 0, errors INTEGER NOT NULL DEFAULT 0, last_error TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      INSERT INTO watches (channel_id, thread_ts, slack_user_id, note, every_ms, deadline_at, next_at, created_at, updated_at) VALUES ('C1','9.9','U7','kept',60000,9,1,1,1);`);
    raw.close();
    const reopened = openDatabase(path);
    const w = createWatchRepo(reopened).get(1);
    expect(w).toMatchObject({ note: "kept", createdBy: "", writeTargets: [] });
    reopened.close();
  });

  test("targets are stored only with a creator", () => {
    const repo = createWatchRepo(openDatabase(":memory:"));
    const base = { channelId: "C1", threadTs: "9.9", slackUserId: "U7", note: "n", check: "", everyMs: 60_000, deadlineAt: 9_000_000, createdAt: 1 };
    const withCreator = repo.add({ ...base, createdBy: "U0OWNER0001", writeTargets: [{ channel: "C0TEAM00001", threadTs: TS }] }, 1);
    const without = repo.add({ ...base, writeTargets: [{ channel: "C0TEAM00001" }] }, 1);
    expect(repo.get(withCreator.id)).toMatchObject({ createdBy: "U0OWNER0001", writeTargets: [{ channel: "C0TEAM00001", threadTs: TS }] });
    expect(repo.get(without.id)).toMatchObject({ createdBy: "", writeTargets: [] });
  });
});

describe("a fired watch's turn", () => {
  let now: number;
  beforeEach(() => {
    now = 1_000_000;
  });

  const fire = async (over: { createdBy?: string; writeTargets?: { channel: string; threadTs?: string }[] }) => {
    const watches = createWatchRepo(openDatabase(":memory:"));
    watches.add({ channelId: "C1", threadTs: "9.9", slackUserId: OWNER, note: "post the screenshots", check: "", everyMs: 60_000, deadlineAt: now + 60_000, createdAt: now, ...over }, now);
    const turns: { text: string; watchGrant?: WatchGrant }[] = [];
    const watcher = createWatcher({
      watches,
      clock: () => now,
      check: async () => ({ code: 0, output: "" }),
      runTurn: async (r) => void turns.push({ text: r.text, watchGrant: r.watchGrant }),
    });
    now += 60_000;
    await watcher.tick();
    return turns;
  };

  test("the owner's watch hands its turn the grant and tells it where it may write", async () => {
    const turns = await fire({ createdBy: OWNER, writeTargets: [{ channel: "C0TEAM00001", threadTs: TS }] });
    expect(turns).toHaveLength(1);
    expect(turns[0]?.watchGrant).toEqual({ watchId: 1, createdBy: OWNER, targets: [{ channel: "C0TEAM00001", threadTs: TS }] });
    expect(turns[0]?.text).toContain("post the screenshots");
    expect(turns[0]?.text).toContain("Watch #1 was set in the owner's turn");
    expect(turns[0]?.text).toContain(TS);
  });

  test("any other watch fires exactly as before: no grant, no extra text", async () => {
    for (const over of [{}, { createdBy: OWNER, writeTargets: [] }, { writeTargets: [{ channel: "C0TEAM00001" }] }]) {
      const turns = await fire(over);
      expect(turns[0]?.watchGrant).toBeUndefined();
      expect(turns[0]?.text).not.toContain("write access");
    }
  });
});

describe("end to end through the ticket and the proxy", () => {
  const BOT = "xoxb-bot";
  const setup = () => {
    const sent: string[] = [];
    const logs: string[] = [];
    const tickets = createSlackTickets(() => 0);
    const proxy = createSlackProxy({
      tickets,
      botToken: BOT,
      log: (l) => logs.push(l),
      fetchFn: (async (url: string | URL | Request) => {
        sent.push(String(url));
        return Response.json({ ok: true, ts: "5.5", channel: "C0TEAM00001" });
      }) as typeof fetch,
    });
    return { proxy, tickets, sent, logs };
  };
  const grant: WatchGrant = { watchId: 12, createdBy: OWNER, targets: [{ channel: "C0TEAM00001", threadTs: TS }] };
  const bill = { actor: OWNER, kind: "chat", channel: "C1", threadTs: "9.9", watchGrant: grant };

  test("the owner's watch writes to its target, and the audit line carries the watch id", async () => {
    const { proxy, tickets, sent, logs } = setup();
    const ticket = tickets.issue(slackTicketContext(bill, "run-1", OWNER)!);
    const res = await proxy.call({ ticket, method: "chat.postMessage", params: { channel: "C0TEAM00001", thread_ts: TS, text: "shots" } });
    expect(res.status).toBe(200);
    expect(sent).toEqual(["https://slack.com/api/chat.postMessage"]);
    expect(logs).toEqual(["slack proxy chat.postMessage channel=C0TEAM00001 (watch #12's grant, outside the turn's channel)"]);
  });

  test("the same watch to a channel it did not name is refused before Slack is called, and the thread-only target holds", async () => {
    const { proxy, tickets, sent, logs } = setup();
    const ticket = tickets.issue(slackTicketContext(bill, "run-1", OWNER)!);
    const other = await proxy.call({ ticket, method: "chat.postMessage", params: { channel: "C0OTHER0001", text: "shots" } });
    expect(other.status).toBe(403);
    const topLevel = await proxy.call({ ticket, method: "chat.postMessage", params: { channel: "C0TEAM00001", text: "shots" } });
    expect(topLevel.status).toBe(403);
    const edit = await proxy.call({ ticket, method: "chat.update", params: { channel: "C0TEAM00001", ts: TS, text: "shots" } });
    expect(edit.status).toBe(403);
    expect(sent).toEqual([]);
    expect(logs.every((l) => l.startsWith("slack proxy refused"))).toBe(true);
  });

  test("a non-owner's watch, and a watch created by someone who is not the owner now, get no grant at all", async () => {
    const { proxy, tickets, sent } = setup();
    for (const b of [{ ...bill, watchGrant: undefined }, { ...bill, watchGrant: { ...grant, createdBy: "U0PAL000001" } }, { ...bill, actor: "U0PAL000001" }]) {
      const ticket = tickets.issue(slackTicketContext(b, "run-1", OWNER)!);
      const res = await proxy.call({ ticket, method: "chat.postMessage", params: { channel: "C0TEAM00001", thread_ts: TS, text: "shots" } });
      expect(res.status).toBe(403);
    }
    expect(sent).toEqual([]);
  });

  test("its own thread still works, and is not logged as outside", async () => {
    const { proxy, tickets, sent, logs } = setup();
    const ticket = tickets.issue(slackTicketContext(bill, "run-1", OWNER)!);
    const res = await proxy.call({ ticket, method: "chat.postMessage", params: { channel: "C1", text: "back here" } });
    expect(res.status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(logs).toEqual(["slack proxy chat.postMessage channel=C1"]);
  });
});
