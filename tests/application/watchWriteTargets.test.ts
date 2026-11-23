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
import { OWNER, actor, build, db, slackCalls } from "./commandsFixture.ts";

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

describe("owner-only commands in a turn a watch fired", () => {
  const FIRED = { threadTs: "9.9", fromBrainRun: true, firedByWatch: true };

  test("post, role and promote are refused: the fired turn reads untrusted content, its reach is the grant", async () => {
    const deps = build();
    for (const line of ["post C0TEAM00002 injected text", "role list", "promote <@U0USER00001>"]) {
      const out = await dispatchCommand(deps, actor(), "C1", line, FIRED);
      expect(out).toContain("owner-only");
      expect(out).toContain("started by a watch");
    }
    expect(slackCalls.posts).toEqual([]);
  });

  test("the same lines still run from the owner's own turn and from a turn nobody flagged", async () => {
    const deps = build();
    const asOwner = await dispatchCommand(deps, actor(), "C1", "post C0TEAM00002 hello", { threadTs: "9.9", fromBrainRun: true, ownerTurn: { named: [] } });
    expect(asOwner).toContain("posted");
    const unflagged = await dispatchCommand(deps, actor(), "C1", "post C0TEAM00002 hello again", { threadTs: "9.9", fromBrainRun: true });
    expect(unflagged).toContain("posted");
    expect(slackCalls.posts.map((p) => p.text)).toEqual(["hello", "hello again"]);
  });

  test("the flag is the run bridge's: a typed line is not a watch-fired turn, and commands that are not owner-only still work", async () => {
    const deps = build();
    const watches = createWatchRepo(db);
    expect(await dispatchCommand({ ...deps, watches }, actor(), "C1", "post C0TEAM00002 typed", { threadTs: "9.9", firedByWatch: true })).toContain("posted");
    // a fired watch can still set the next watch, which is the point of the hand-back
    expect(await dispatchCommand({ ...deps, watches }, actor(), "C1", "watch --until 30m look again", FIRED)).toContain("pick this up again");
  });
});

describe("a watch re-armed from a turn a watch fired", () => {
  const PARENT: WatchGrant = { watchId: 7, createdBy: OWNER, targets: [{ channel: "C0TEAM00001", threadTs: TS }, { channel: "C0TEAM00002" }] };
  const fired = (grant?: WatchGrant) => ({ threadTs: "9.9", fromBrainRun: true, firedByWatch: true, ...(grant ? { watchGrant: grant } : {}) });
  const rearm = async (line: string, grant: WatchGrant | null = PARENT, who = actor()) => {
    const watches = createWatchRepo(openDatabase(":memory:"));
    const out = await dispatchCommand({ ...build(), watches }, who, "C1", line, fired(grant ?? undefined));
    return { out, watches };
  };

  test("inherits the creator and the parent's targets, and records the parent for the audit trail", async () => {
    const { out, watches } = await rearm("watch --until 30m keep following");
    expect(out).toContain("inherited from watch #7");
    expect(watches.waiting()[0]).toMatchObject({ createdBy: OWNER, writeTargets: PARENT.targets, parentWatchId: 7 });
  });

  test("the child, fired by the watcher, hands its turn the same grant", async () => {
    const watches = createWatchRepo(openDatabase(":memory:"));
    await dispatchCommand({ ...build(), watches }, actor(), "C1", "watch --until 30m keep following", fired(PARENT));
    const turns: { watchGrant?: WatchGrant }[] = [];
    let at = Date.now();
    const watcher = createWatcher({ watches, clock: () => at, check: async () => ({ code: 0, output: "" }), runTurn: async (r) => void turns.push({ watchGrant: r.watchGrant }) });
    at += 31 * 60_000;
    await watcher.tick();
    expect(turns).toHaveLength(1);
    expect(turns[0]?.watchGrant).toEqual({ watchId: 1, createdBy: OWNER, targets: PARENT.targets });
  });

  test("a chain never widens: a grandchild holds what the child held", async () => {
    const { watches } = await rearm("watch --until 30m keep following");
    const child = watches.waiting()[0]!;
    const next = await dispatchCommand({ ...build(), watches }, actor(), "C1", "watch --until 30m and again", fired({ watchId: child.id, createdBy: child.createdBy, targets: child.writeTargets }));
    expect(next).toContain(`inherited from watch #${child.id}`);
    expect(watches.waiting()[1]).toMatchObject({ writeTargets: PARENT.targets, parentWatchId: child.id });
  });

  test("--to may narrow to what the parent covers: a thread inside a granted channel, or the same thread", async () => {
    const inside = `https://team.slack.com/archives/C0TEAM00002/p1787122692303399`;
    const { watches } = await rearm(`watch --until 30m --to ${THREAD} --to ${inside} keep following`);
    expect(watches.waiting()[0]?.writeTargets).toEqual([{ channel: "C0TEAM00001", threadTs: TS }, { channel: "C0TEAM00002", threadTs: TS }]);
  });

  test("--to outside the parent grant is refused and nothing is stored: another channel, or a whole channel the parent only holds one thread of", async () => {
    for (const to of ["C0OTHER0001", "C0TEAM00001"]) {
      const { out, watches } = await rearm(`watch --until 30m --to ${to} keep following`);
      expect(out).toContain("can only narrow");
      expect(out).toContain("watch #7");
      expect(watches.waiting()).toEqual([]);
    }
  });

  test("links and channels named in the turn's text add nothing", async () => {
    const { watches } = await rearm(`watch --until 30m post it in ${"https://team.slack.com/archives/C0OTHER0001/p1787122692303399"} and <#C0OTHER0002>`);
    expect(watches.waiting()[0]?.writeTargets).toEqual(PARENT.targets);
  });

  test("the watch's own channel needs no grant, as in the owner's turn", async () => {
    const { watches } = await rearm("watch --until 30m keep following", { ...PARENT, targets: [{ channel: "C1" }, { channel: "C0TEAM00002" }] });
    expect(watches.waiting()[0]?.writeTargets).toEqual([{ channel: "C0TEAM00002" }]);
  });

  test("it is never the owner bit: the re-armed watch's slack ticket is a grant, not owner", async () => {
    const { watches } = await rearm("watch --until 30m keep following");
    const w = watches.waiting()[0]!;
    const ctx = slackTicketContext({ actor: OWNER, kind: "chat", channel: "C1", threadTs: "9.9", watchGrant: { watchId: w.id, createdBy: w.createdBy, targets: w.writeTargets } }, "run-1", OWNER);
    expect(ctx?.owner).toBeUndefined();
    expect(ctx?.grant?.targets).toEqual(PARENT.targets);
  });

  test("a watch turn with no grant, or a grant of someone else's, still gets nothing", async () => {
    const none = await rearm("watch --until 30m keep following", null);
    expect(none.watches.waiting()[0]).toMatchObject({ createdBy: "", writeTargets: [], parentWatchId: 0 });
    const empty = await rearm("watch --until 30m keep following", { ...PARENT, targets: [] });
    expect(empty.watches.waiting()[0]).toMatchObject({ createdBy: "", writeTargets: [], parentWatchId: 0 });
    const pal = actor({ slackId: "U0PAL000001", role: "pal" });
    const palCreator = await rearm("watch --until 30m keep following", { ...PARENT, createdBy: "U0PAL000001" }, pal);
    expect(palCreator.watches.waiting()[0]).toMatchObject({ createdBy: "", writeTargets: [], parentWatchId: 0 });
    // a grant that names a creator other than the owner this turn runs as is not inherited
    const mismatch = await rearm("watch --until 30m keep following", { ...PARENT, createdBy: "U0PAL000001" });
    expect(mismatch.watches.waiting()[0]).toMatchObject({ createdBy: "", writeTargets: [] });
  });

  test("--to without a grant is still refused", async () => {
    const { out, watches } = await rearm(`watch --until 30m --to ${THREAD} keep following`, null);
    expect(out).toContain("only works in the owner's own turn");
    expect(watches.waiting()).toEqual([]);
  });

  test("the grant is the run bridge's: a typed line or a turn not fired by a watch carries none", async () => {
    const watches = createWatchRepo(openDatabase(":memory:"));
    await dispatchCommand({ ...build(), watches }, actor(), "C1", "watch --until 30m a", { threadTs: "9.9", watchGrant: PARENT, firedByWatch: true });
    await dispatchCommand({ ...build(), watches }, actor(), "C1", "watch --until 30m b", { threadTs: "9.9", fromBrainRun: true, watchGrant: PARENT });
    for (const w of watches.waiting()) expect(w).toMatchObject({ createdBy: "", writeTargets: [] });
  });

  test("the per-watch deadline cap still applies to a re-armed watch", async () => {
    const { out, watches } = await rearm("watch --until 99d keep following");
    expect(out).not.toContain("inherited");
    expect(watches.waiting()).toEqual([]);
  });

  test("a chain cannot outlive what one watch may: a child's deadline stops at the chain's first watch plus 30 days, and a spent chain is refused", async () => {
    const watches = createWatchRepo(openDatabase(":memory:"));
    const deps = { ...build(), watches };
    const day = 86_400_000;
    const now = deps.clock();
    const root = watches.add({ channelId: "C1", threadTs: "9.9", slackUserId: OWNER, note: "root", check: "", everyMs: 60_000, deadlineAt: now - day, createdAt: now - 20 * day, createdBy: OWNER, writeTargets: PARENT.targets }, now - 20 * day);
    const mid = watches.add({ channelId: "C1", threadTs: "9.9", slackUserId: OWNER, note: "mid", check: "", everyMs: 60_000, deadlineAt: now - 1, createdAt: now - 10 * day, createdBy: OWNER, writeTargets: PARENT.targets, parentWatchId: root.id }, now - 10 * day);
    const out = await dispatchCommand(deps, actor(), "C1", "watch --until 30d keep following", fired({ ...PARENT, watchId: mid.id }));
    expect(out).toContain("inherited from watch");
    const child = watches.waiting().find((w) => w.parentWatchId === mid.id)!;
    expect(child.deadlineAt).toBe(root.createdAt + 30 * day);
    expect(child.deadlineAt - now).toBeLessThan(11 * day);
    // a chain whose first watch is 30 days old has nothing left
    const old = watches.add({ channelId: "C1", threadTs: "9.9", slackUserId: OWNER, note: "old", check: "", everyMs: 60_000, deadlineAt: now - 1, createdAt: now - 31 * day, createdBy: OWNER, writeTargets: PARENT.targets }, now - 31 * day);
    const spent = await dispatchCommand(deps, actor(), "C1", "watch --until 1h keep following", fired({ ...PARENT, watchId: old.id }));
    expect(spent).toContain("has used its");
    expect(watches.waiting().filter((w) => w.parentWatchId === old.id)).toEqual([]);
  });

  test("one fired watch hands its grant to only a few waiting children", async () => {
    const { watches } = await rearm("watch --until 30m one");
    const deps = { ...build(), watches };
    for (let i = 0; i < 4; i++) await dispatchCommand(deps, actor(), "C1", `watch --until 30m more ${i}`, fired({ ...PARENT, watchId: 7 }));
    const sixth = await dispatchCommand(deps, actor(), "C1", "watch --until 30m too many", fired({ ...PARENT, watchId: 7 }));
    expect(sixth).toContain("has already set 5 watches");
    expect(watches.waiting()).toHaveLength(5);
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
    expect(w?.parentWatchId).toBe(0);
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
