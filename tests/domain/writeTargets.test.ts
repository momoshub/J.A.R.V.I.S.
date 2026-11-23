import { describe, expect, test } from "bun:test";
import {
  MAX_WRITE_TARGETS,
  grantAllows,
  grantNote,
  normalizeTargets,
  parseTargets,
  serializeTargets,
  targetsNamedIn,
} from "../../src/domain/writeTargets.ts";

const THREAD = "https://team.slack.com/archives/C0TEAM00001/p1787122692303399";
const TS = "1787122692.303399";

describe("targetsNamedIn", () => {
  test("a message link names the thread it starts, a reply link its thread", () => {
    expect(targetsNamedIn(`post it in ${THREAD} when ready`)).toEqual([{ channel: "C0TEAM00001", threadTs: TS }]);
    const reply = `${THREAD}?thread_ts=1787000000.000100&cid=C0TEAM00001`;
    expect(targetsNamedIn(reply)).toEqual([{ channel: "C0TEAM00001", threadTs: "1787000000.000100" }]);
  });

  test("a Slack-wrapped link and an escaped ampersand still count", () => {
    expect(targetsNamedIn(`<${THREAD}|the thread>`)).toEqual([{ channel: "C0TEAM00001", threadTs: TS }]);
    expect(targetsNamedIn(`${THREAD}?thread_ts=1787000000.000100&amp;cid=C0TEAM00001`)).toEqual([{ channel: "C0TEAM00001", threadTs: "1787000000.000100" }]);
  });

  test("a channel mention and a bare id name the whole channel", () => {
    expect(targetsNamedIn("tell <#C0TEAM00002|eng> and also G0TEAM00009")).toEqual([{ channel: "C0TEAM00002" }, { channel: "G0TEAM00009" }]);
  });

  test("a thread link never widens into its channel, even though the channel id sits inside it", () => {
    expect(targetsNamedIn(`${THREAD} and ${THREAD}`)).toEqual([{ channel: "C0TEAM00001", threadTs: TS }]);
  });

  test("user ids, ordinary words and other urls name nothing", () => {
    expect(targetsNamedIn("ping <@U0USER00001> and U0USER00001, see https://example.com/C0TEAM00003/x and CHECKS and ABCDEFGHIJ")).toEqual([]);
  });

  test("a bare id needs a digit: capitalised words are not channels", () => {
    expect(targetsNamedIn("post it after the DEPLOYMENT and the CHANGELOG are in, for GITHUBPAGES")).toEqual([]);
    expect(targetsNamedIn("post it in C0TEAM00005")).toEqual([{ channel: "C0TEAM00005" }]);
  });

  test("a channel named as a whole absorbs a thread in it", () => {
    expect(targetsNamedIn(`${THREAD} <#C0TEAM00001|eng>`)).toEqual([{ channel: "C0TEAM00001" }]);
  });
});

describe("stored targets", () => {
  test("round trip, and nothing is the empty string", () => {
    const targets = [{ channel: "C0TEAM00001", threadTs: TS }, { channel: "C0TEAM00002" }];
    expect(parseTargets(serializeTargets(targets))).toEqual(targets);
    expect(serializeTargets([])).toBe("");
  });

  test("an old row, an empty value and junk all read as no targets, never throw", () => {
    for (const raw of [undefined, null, "", "  ", "not json", "{}", "[1,\"x\",null]"]) expect(parseTargets(raw)).toEqual([]);
  });

  test("a hand-edited entry naming a user id, a bad ts or no channel is dropped", () => {
    const raw = JSON.stringify([{ channel: "U0USER00001" }, { channel: "C0TEAM00001", threadTs: "tomorrow" }, { threadTs: TS }, { channel: "C0TEAM00002" }]);
    expect(parseTargets(raw)).toEqual([{ channel: "C0TEAM00002" }]);
  });

  test("never more than the cap", () => {
    const many = Array.from({ length: MAX_WRITE_TARGETS + 5 }, (_, i) => ({ channel: `C0TEAM${String(i).padStart(5, "0")}` }));
    expect(parseTargets(JSON.stringify(many))).toHaveLength(MAX_WRITE_TARGETS);
  });

  test("normalize drops duplicates", () => {
    expect(normalizeTargets([{ channel: "C0TEAM00001" }, { channel: "C0TEAM00001" }])).toEqual([{ channel: "C0TEAM00001" }]);
  });
});

describe("grantAllows", () => {
  const thread = [{ channel: "C0TEAM00001", threadTs: TS }];
  const wide = [{ channel: "C0TEAM00002" }];

  test("only the three grant methods", () => {
    for (const method of ["chat.postMessage", "reactions.add", "files.completeUploadExternal"]) {
      expect(grantAllows(wide, method, "C0TEAM00002", { thread_ts: "1.1", timestamp: "1.1" })).toBe(true);
    }
    for (const method of ["chat.update", "chat.delete", "conversations.join", "files.getUploadURLExternal", "users.setPresence"]) {
      expect(grantAllows(wide, method, "C0TEAM00002", {})).toBe(false);
    }
  });

  test("a channel nobody named is refused", () => {
    expect(grantAllows(wide, "chat.postMessage", "C0OTHER0001", {})).toBe(false);
    expect(grantAllows([], "chat.postMessage", "C0TEAM00002", {})).toBe(false);
  });

  test("a thread target holds the post and the upload to that thread", () => {
    expect(grantAllows(thread, "chat.postMessage", "C0TEAM00001", { thread_ts: TS })).toBe(true);
    expect(grantAllows(thread, "files.completeUploadExternal", "C0TEAM00001", { thread_ts: TS })).toBe(true);
    expect(grantAllows(thread, "chat.postMessage", "C0TEAM00001", {})).toBe(false);
    expect(grantAllows(thread, "chat.postMessage", "C0TEAM00001", { thread_ts: "none" })).toBe(false);
    expect(grantAllows(thread, "chat.postMessage", "C0TEAM00001", { thread_ts: "1700000000.000100" })).toBe(false);
    expect(grantAllows(thread, "chat.postMessage", "C0TEAM00001", { thread_ts: TS, reply_broadcast: "true" })).toBe(false);
  });

  test("a thread target lets a reaction land only on the thread's root", () => {
    expect(grantAllows(thread, "reactions.add", "C0TEAM00001", { timestamp: TS })).toBe(true);
    expect(grantAllows(thread, "reactions.add", "C0TEAM00001", { timestamp: "1700000000.000100" })).toBe(false);
  });

  test("a channel target takes a top-level post and any thread in it", () => {
    expect(grantAllows(wide, "chat.postMessage", "C0TEAM00002", {})).toBe(true);
    expect(grantAllows(wide, "chat.postMessage", "C0TEAM00002", { thread_ts: "none" })).toBe(true);
    expect(grantAllows(wide, "reactions.add", "C0TEAM00002", { timestamp: "9.9" })).toBe(true);
  });
});

test("the note a fired turn is handed names every target and the limits", () => {
  const note = grantNote(12, [{ channel: "C0TEAM00001", threadTs: TS }, { channel: "C0TEAM00002" }]);
  expect(note).toContain("Watch #12");
  expect(note).toContain(TS);
  expect(note).toContain("<#C0TEAM00002>");
  expect(note).toContain("no edits");
});
