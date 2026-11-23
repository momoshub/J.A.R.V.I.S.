import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { createAdapterStore } from "../../src/infrastructure/adapter/adapterStore.ts";
import { createAdapterRevisionRepo } from "../../src/infrastructure/db/adapterRevisionRepo.ts";
import { openDatabase, type DbClient } from "../../src/infrastructure/db/client.ts";
import { createLearningsRepo, type LearningsRepo } from "../../src/infrastructure/db/learningsRepo.ts";
import { createMessageRepo } from "../../src/infrastructure/db/messageRepo.ts";
import { createSkillDraftRepo, type SkillDraftRepo } from "../../src/infrastructure/db/skillDraftRepo.ts";
import { createTurnLogRepo, type TurnLogRepo } from "../../src/infrastructure/db/turnLogRepo.ts";
import { rememberFact, type AdapterDeps } from "../../src/application/adapterMemory.ts";
import {
  createLearningHarvest,
  decideSkillDraftPress,
  draftPressNotice,
  type HarvestDeps,
  type SkillDraftApprovalDeps,
} from "../../src/application/learningHarvest.ts";
import { MAX_PENDING, decideLearning, injectedLearnings, type LearningApprovalDeps } from "../../src/application/learningApproval.ts";
import type { InteractiveAction, SlackAdminPort } from "../../src/application/slackAdmin.ts";
import type { LlmCompleteParams } from "../../src/application/ports.ts";
import { CURSOR_MAX_AGE_MS, TRIAGE_MODEL } from "../../src/application/innerChild.ts";
import { HARVEST_APPROVE_ACTION, HARVEST_REJECT_ACTION, HARVEST_SOURCE } from "../../src/domain/harvest.ts";
import { noticeFingerprint } from "../../src/domain/noticeFingerprint.ts";
import { DRIFT_NUDGE_MARK } from "../../src/domain/voiceDrift.ts";
import { noticeBlocks } from "./commandsFixture.ts";

const OWNER = "U0OWNER0001";
const PUBLIC = "C0TEST00001";
const PRIVATE = "G0TEST00001";
const DM = "D0DM000001";

const MANIFEST = `
template:
  id: mem
  version: "1.0"
  name: Memory
exports:
  context: ADAPTER.md
  skills: skills
structure:
  learnable:
    - path: ADAPTER.md
      format: {max_bytes: 8000}
    - path: memory/NOTES.md
      format: {max_bytes: 8000}
    - path: memory/people/*.md
      format: {max_bytes: 8000}
    - path: memory/channels/*.md
      format: {max_bytes: 8000}
    - path: skills/*/SKILL.md
      format: {frontmatter: [description]}
  fixed:
    - README.md
`;
const DEPLOY = "---\nname: deploy-staging\ndescription: How to deploy to staging when asked\n---\n# Deploy\n1. connect the VPN\n2. run the deploy script\n";
const NEW_SKILL = "---\nname: rotate-logs\ndescription: How to rotate the service logs when disk is low\n---\n# Rotate logs\n1. stop the service\n2. archive the logs\n3. start the service\n";

let db: DbClient;
let learnings: LearningsRepo;
let drafts: SkillDraftRepo;
let turns: TurnLogRepo;
let now: number;
let cursor: number | undefined;
let answer: string;
let calls: LlmCompleteParams[];
let dms: { text: string; actions: readonly InteractiveAction[]; ts: string }[];
let blocks: Record<string, unknown[]>;
let settled: { channel: string; ts: string; text: string }[];
let kinds: Record<string, "channel" | "group" | "im" | undefined>;
let dmWorks: boolean;
let roots: string[];
let adapter: AdapterDeps | undefined;

const mkAdapter = (files: Record<string, string> = {}): AdapterDeps => {
  const root = mkdtempSync(join(tmpdir(), "harvest-adapter-"));
  const mirror = mkdtempSync(join(tmpdir(), "harvest-mirror-"));
  roots.push(root, mirror);
  const all = { "adapter.yaml": MANIFEST, "ADAPTER.md": "# Policy\n", "README.md": "docs", ...files };
  for (const [rel, content] of Object.entries(all)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), content);
  }
  return { store: createAdapterStore(db, mirror, root), revisions: createAdapterRevisionRepo(db), clock: () => now };
};

const slack = (): NonNullable<HarvestDeps["slack"]> & Pick<SlackAdminPort, "settleInteractive"> => ({
  conversationInfo: async (id) => {
    const kind = kinds[id];
    return kind ? { kind } : undefined;
  },
  permalink: async (channel, ts) => `https://example.slack.com/archives/${channel}/p${ts.replace(".", "")}`,
  postDmInteractive: async (_user, text, actions) => {
    if (!dmWorks) return undefined;
    const ts = `dm-${dms.length + 1}`;
    const b = noticeBlocks(text, actions);
    blocks[`${OWNER}:${ts}`] = b;
    dms.push({ text, actions, ts });
    return { channel: OWNER, ts, fingerprint: noticeFingerprint(b) };
  },
  settleInteractive: async (channel, ts, text) => void settled.push({ channel, ts, text }),
});

/** The flat learnings list unless `inAdapter`: an approved fact then goes into the adapter's notes. */
const approvalDeps = (inAdapter = false): LearningApprovalDeps => ({
  learnings,
  adapter: () => (inAdapter ? adapter : undefined),
  slack: {
    postDmInteractive: async (_u: string, text: string, actions: readonly InteractiveAction[]) => {
      const ts = `fact-${dms.length + 1}`;
      const b = noticeBlocks(text, actions);
      blocks[`${OWNER}:${ts}`] = b;
      dms.push({ text, actions, ts });
      return { channel: OWNER, ts, fingerprint: noticeFingerprint(b) };
    },
    permalink: async () => undefined,
    settleInteractive: async () => {},
  } as unknown as SlackAdminPort,
  clock: () => now,
  ownerSlackId: OWNER,
});

const build = (over: Partial<HarvestDeps> = {}) =>
  createLearningHarvest({
    turns,
    messages: createMessageRepo(db),
    learnings,
    learningApproval: approvalDeps(),
    drafts,
    adapter: () => adapter,
    slack: slack(),
    llm: {
      complete: async (p) => {
        calls.push(p);
        return answer;
      },
    },
    clock: () => now,
    ownerSlackId: OWNER,
    botName: () => "Bot",
    noTools: ["Bash"],
    enabled: () => true,
    cursor: { get: () => cursor, set: (at) => void (cursor = at) },
    everyMs: 1000,
    ...over,
  });

let n = 0;
/** A finished chat turn, by default in a public channel. */
const addTurn = (over: Partial<Parameters<TurnLogRepo["add"]>[0]> = {}) =>
  turns.add({
    runId: `r${++n}`,
    channelId: PUBLIC,
    threadTs: `${n}.0`,
    slackUserId: "U0USER0001",
    kind: "chat",
    request: `message number ${n} about nothing in particular`,
    outcome: "ok",
    error: "",
    startedAt: now - 10,
    endedAt: now + n,
    ...over,
  });

/** Enough ordinary turns for a review, the first one being `first`. */
const fill = (first: Partial<Parameters<TurnLogRepo["add"]>[0]> = {}, total = 6) => {
  addTurn(first);
  for (let i = 1; i < total; i++) addTurn();
};

const fact = (over: Record<string, unknown> = {}) => ({
  kind: "fact",
  turn: 1,
  fact: "The team ships releases on Thursdays, never on Fridays.",
  scope: "global",
  quote: "we ship on Thursdays",
  ...over,
});
const skill = (over: Record<string, unknown> = {}) => ({
  kind: "skill",
  turn: 1,
  name: "rotate-logs",
  content: NEW_SKILL,
  quote: "that is how we rotate logs",
  ...over,
});

const SAID = "ok settled, we ship on Thursdays and that is how we rotate logs";

/** One tick that reviews a batch whose first turn says `first`. */
const review = async (h: ReturnType<typeof build>, items: unknown[], first: Partial<Parameters<TurnLogRepo["add"]>[0]> = { request: SAID }) => {
  cursor = now;
  now += 5_000;
  fill(first);
  now += 1_000;
  answer = JSON.stringify(items);
  await h.tick();
};

beforeEach(() => {
  db = openDatabase(":memory:");
  learnings = createLearningsRepo(db);
  drafts = createSkillDraftRepo(db);
  turns = createTurnLogRepo(db);
  now = 10_000_000;
  n = 0;
  cursor = undefined;
  answer = "[]";
  calls = [];
  dms = [];
  blocks = {};
  settled = [];
  kinds = { [PUBLIC]: "channel", [PRIVATE]: "group", [DM]: "im" };
  dmWorks = true;
  roots = [];
  adapter = mkAdapter({ "skills/deploy-staging/SKILL.md": DEPLOY });
});

afterEach(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

describe("off by default, and no backlog", () => {
  test("off: nothing is read and no model is called", async () => {
    cursor = now - 1000;
    fill({ request: SAID });
    answer = JSON.stringify([fact()]);
    await build({ enabled: () => false }).tick();
    expect(calls).toEqual([]);
    expect(learnings.all()).toEqual([]);
  });

  test("the first look only plants the cursor at now", async () => {
    fill({ request: SAID });
    await build().tick();
    expect(cursor).toBe(now);
    expect(calls).toEqual([]);
  });

  test("a cursor older than six hours jumps to now: the backlog is skipped, not read", async () => {
    cursor = now - CURSOR_MAX_AGE_MS - 1;
    fill({ request: SAID });
    await build().tick();
    expect(cursor).toBe(now);
    expect(calls).toEqual([]);
  });

  test("turns from before the cursor are never read", async () => {
    cursor = now + 1_000_000;
    fill({ request: SAID });
    await build().tick();
    expect(calls).toEqual([]);
  });

  test("too few turns are not worth a call, and are kept for the next look", async () => {
    cursor = now - 1000;
    for (let i = 0; i < 3; i++) addTurn({ request: SAID });
    const before = cursor;
    await build().tick();
    expect(calls).toEqual([]);
    expect(cursor).toBe(before);
  });

  test("it looks at most every `everyMs`", async () => {
    const h = build({ everyMs: 60_000 });
    await review(h, []);
    expect(calls.length).toBe(1);
    cursor = now;
    fill({ request: SAID });
    await h.tick();
    expect(calls.length).toBe(1);
    now += 60_000;
    cursor = now - 1000;
    fill({ request: SAID });
    await h.tick();
    expect(calls.length).toBe(2);
  });

  test("it uses the cheap model unless one is set, and no tools", async () => {
    await review(build(), []);
    expect(calls[0]?.policy?.model).toBe(TRIAGE_MODEL);
    expect(calls[0]?.policy?.disallowedTools).toEqual(["Bash"]);
    calls = [];
    now += 5000;
    await review(build({ model: () => "claude-other" }), []);
    expect(calls[0]?.policy?.model).toBe("claude-other");
  });
});

describe("only what people wrote is a source", () => {
  test("a fact whose quote is not in the person's text is dropped, even if the bot's answer holds it", async () => {
    // The text is in the bot's reply (something it read), not in what the person wrote.
    const h = build();
    cursor = now;
    now += 5000;
    fill({ request: "please summarise that page for me" });
    createMessageRepo(db).append({ channelId: PUBLIC, slackUserId: "bot", role: "assistant", content: "the page says we ship on Thursdays", threadTs: "1.0" }, now - 5);
    now += 1000;
    answer = JSON.stringify([fact({ quote: "we ship on Thursdays" })]);
    await h.tick();
    expect(calls.length).toBe(1);
    expect(learnings.all()).toEqual([]);
    expect(dms).toEqual([]);
  });

  test("the bot's answer is shown as context, labelled apart from what the person wrote", async () => {
    await review(build(), []);
    const text = calls[0]?.messages[0]?.content ?? "";
    expect(text).toContain("person: ");
    expect(calls[0]?.system).toContain("ONLY the person's words are a source");
  });

  test("the bot's own prompts (nudge, loop, watch hand-back) are never reviewed", async () => {
    cursor = now;
    now += 5000;
    addTurn({ request: `${DRIFT_NUDGE_MARK} we ship on Thursdays` });
    addTurn({ request: "[loop 3] we ship on Thursdays" });
    addTurn({ request: "The thing you were waiting for is ready (after 2m)" });
    for (let i = 0; i < 5; i++) addTurn();
    now += 1000;
    answer = JSON.stringify([fact({ turn: 1 })]);
    await build().tick();
    const text = calls[0]?.messages[0]?.content ?? "";
    expect(text).not.toContain("we ship on Thursdays");
    expect(learnings.all()).toEqual([]);
  });

  test("failed, stopped, non-chat and thread-less turns are not reviewed", async () => {
    cursor = now;
    now += 5000;
    addTurn({ request: "failed one here", outcome: "failed" });
    addTurn({ request: "stopped one here", outcome: "stopped" });
    addTurn({ request: "workflow one here", kind: "workflow" });
    addTurn({ request: "no thread here", threadTs: "" });
    for (let i = 0; i < 6; i++) addTurn();
    now += 1000;
    await build().tick();
    const text = calls[0]?.messages[0]?.content ?? "";
    for (const w of ["failed one", "stopped one", "workflow one", "no thread"]) expect(text).not.toContain(w);
  });

  test("a thread the caller skips (the inner child's own fix threads) is not reviewed", async () => {
    cursor = now;
    now += 5000;
    addTurn({ request: "fix thread talk here", threadTs: "fix.1" });
    for (let i = 0; i < 6; i++) addTurn();
    now += 1000;
    await build({ skip: (_c, t) => t === "fix.1" }).tick();
    expect(calls[0]?.messages[0]?.content).not.toContain("fix thread talk");
  });
});

describe("a fact goes through the owner's learning approval", () => {
  test("it is stored pending, never injected, and put to the owner with buttons", async () => {
    await review(build(), [fact()]);
    const [l] = learnings.all();
    expect(l).toMatchObject({ status: "pending", createdBy: HARVEST_SOURCE, content: "The team ships releases on Thursdays, never on Fridays.", scope: [] });
    expect(injectedLearnings(learnings)).toEqual([]);
    expect(dms.length).toBe(1);
    expect(dms[0]?.text).toContain("my review of recent conversations");
    expect(dms[0]?.actions.map((a) => a.label)).toEqual(["Approve", "Reject"]);
  });

  test("nothing is injected until the owner approves", async () => {
    await review(build(), [fact()]);
    const [l] = learnings.all();
    expect(injectedLearnings(learnings)).toEqual([]);
    const r = await decideLearning(approvalDeps(), l!.id, "approve", OWNER);
    expect(r.kind).toBe("approved");
    expect(injectedLearnings(learnings)).toEqual(["The team ships releases on Thursdays, never on Fridays."]);
  });

  test("with the memory adapter, an approved fact is filed in its scope's own note and nowhere else", async () => {
    await review(build(), [fact({ scope: "channel" })]);
    const [l] = learnings.all();
    await decideLearning(approvalDeps(true), l!.id, "approve", OWNER);
    expect(adapter!.store.files().get(`memory/channels/${PUBLIC}.md`)).toContain("ships releases on Thursdays");
    expect(adapter!.store.files().get("memory/NOTES.md") ?? "").not.toContain("Thursdays");
  });

  test("a public channel's fact the model says is about that channel only is channel-scoped", async () => {
    await review(build(), [fact({ scope: "channel" })]);
    expect(learnings.all()[0]?.scope).toEqual([PUBLIC]);
  });

  test("the proposal carries where it came from", async () => {
    await review(build(), [fact()]);
    expect(learnings.all()[0]).toMatchObject({ sourceChannel: PUBLIC });
    expect(learnings.all()[0]?.sourceThreadTs).not.toBe("");
  });
});

describe("a private source never reaches other channels", () => {
  test.each([
    ["a private channel", PRIVATE],
    ["a DM", DM],
    ["a channel Slack will not describe", "C0OTHER0001"],
  ])("a fact from %s is channel-scoped even when the model says global", async (_label, channel) => {
    await review(build(), [fact()], { request: SAID, channelId: channel });
    const [l] = learnings.all();
    expect(l?.scope).toEqual([channel]);
    // and so it is not injected anywhere else, once approved
    await decideLearning(approvalDeps(), l!.id, "approve", OWNER);
    expect(injectedLearnings(learnings, PUBLIC)).toEqual([]);
    expect(injectedLearnings(learnings, channel).length).toBe(1);
  });

  test("with the memory adapter, a private source's fact reaches only its own channel's note", async () => {
    await review(build(), [fact()], { request: SAID, channelId: PRIVATE });
    const [l] = learnings.all();
    await decideLearning(approvalDeps(true), l!.id, "approve", OWNER);
    expect(adapter!.store.files().get(`memory/channels/${PRIVATE}.md`)).toContain("Thursdays");
    expect(adapter!.store.files().get("memory/NOTES.md") ?? "").not.toContain("Thursdays");
  });

  test.each([
    ["a private channel", PRIVATE],
    ["a DM", DM],
    ["a channel Slack will not describe", "C0OTHER0001"],
  ])("a skill from %s is dropped: a skill loads everywhere", async (_label, channel) => {
    await review(build(), [skill()], { request: SAID, channelId: channel });
    expect(drafts.pending()).toEqual([]);
    expect(dms).toEqual([]);
  });

  test("when Slack cannot be asked at all the source counts as private", async () => {
    await review(build({ slack: undefined }), [fact(), skill()]);
    expect(drafts.pending()).toEqual([]);
    expect(learnings.all().map((l) => l.scope)).toEqual([[PUBLIC]]);
  });
});

describe("no secrets or personal data", () => {
  test.each([
    ["a token", "The deploy bot uses the token xoxb-1234567890-abcdefghij for Slack."],
    ["an email", "Escalations go to someone@example.com every week."],
    ["a stated password", "The staging password is hunter2hunter2 for everyone."],
    ["a Slack id", "Ask U0USER0099 about the release process."],
  ])("a fact with %s is dropped", async (_label, text) => {
    await review(build(), [fact({ fact: text })]);
    expect(learnings.all()).toEqual([]);
    expect(dms).toEqual([]);
  });

  test("a skill with a secret in it is dropped", async () => {
    await review(build(), [skill({ content: `${NEW_SKILL}4. login with xoxb-1234567890-abcdefghij\n` })]);
    expect(drafts.pending()).toEqual([]);
  });
});

describe("caps and dedupe", () => {
  test("at most the per-batch cap is raised from one batch", async () => {
    await review(build({ maxPerBatch: 2 }), [
      fact({ fact: "Releases ship on Thursdays and never on Fridays." }),
      fact({ fact: "Hotfixes go through the on-call engineer first." }),
      fact({ fact: "The staging cluster is rebuilt every Monday morning." }),
    ]);
    expect(learnings.all().length).toBe(2);
  });

  test("the daily cap stops proposals, facts and drafts counted together", async () => {
    const h = build({ maxPerDay: 2, maxPerBatch: 5 });
    await review(h, [fact({ fact: "Releases ship on Thursdays and never on Fridays." }), skill(), fact({ fact: "Hotfixes go through the on-call engineer first." })]);
    expect(learnings.all().length + drafts.pending().length).toBe(2);
    // a later look the same day proposes nothing more
    calls = [];
    now += 5000;
    await review(h, [fact({ fact: "The staging cluster is rebuilt every Monday morning." })]);
    expect(calls).toEqual([]);
    expect(learnings.all().length + drafts.pending().length).toBe(2);
    // the next day it may again
    now += 24 * 3600 * 1000;
    await review(h, [fact({ fact: "The staging cluster is rebuilt every Monday morning." })]);
    expect(learnings.all().length).toBe(2);
  });

  test("a fact already known is not asked again: active, pending, rejected, or in the adapter", async () => {
    const known = ["Active fact about the deploy window.", "Pending fact about the staging cluster.", "Rejected fact about the coffee machine."];
    learnings.add(known[0]!, "U1", now, "active");
    learnings.add(known[1]!, "U1", now, "pending");
    const rej = learnings.add(known[2]!, "U1", now, "pending");
    learnings.decide(rej.id, "rejected", OWNER, now);
    rememberFact(adapter!, "The wiki lives in the engineering space.", { kind: "global" }, OWNER);
    const before = learnings.all().length;
    await review(build({ maxPerBatch: 9 }), [
      ...known.map((k) => fact({ fact: k.toUpperCase() })),
      fact({ fact: "the wiki lives in the engineering space" }),
    ]);
    expect(learnings.all().length).toBe(before);
    expect(dms).toEqual([]);
  });

  test("the same fact proposed in two batches is asked once", async () => {
    const h = build();
    await review(h, [fact()]);
    now += 5000;
    await review(h, [fact()]);
    expect(learnings.all().length).toBe(1);
    expect(dms.length).toBe(1);
  });

  test("the owner's pending cap still holds", async () => {
    for (let i = 0; i < MAX_PENDING; i++) learnings.add(`pending number ${i} is here`, "U1", now, "pending");
    await review(build(), [fact()]);
    expect(learnings.all().filter((l) => l.createdBy === HARVEST_SOURCE)).toEqual([]);
  });

  test("known facts and the owner's rejections are shown to the model, so it does not propose them", async () => {
    learnings.add("Active fact about the deploy window.", "U1", now, "active");
    const rej = learnings.add("Rejected fact about the coffee machine.", "U1", now, "pending");
    learnings.decide(rej.id, "rejected", OWNER, now);
    await review(build(), []);
    const text = calls[0]?.messages[0]?.content ?? "";
    expect(text).toContain("Active fact about the deploy window.");
    expect(text).toContain("Rejected by the owner");
    expect(text).toContain("Rejected fact about the coffee machine.");
  });
});

describe("a skill draft", () => {
  const press = (id: number, action: string, over: Record<string, unknown> = {}) => {
    const row = drafts.get(id)!;
    return {
      slackUserId: OWNER,
      actionId: action,
      value: String(id),
      channel: row.noticeChannel,
      messageTs: row.noticeTs,
      blocks: blocks[`${row.noticeChannel}:${row.noticeTs}`],
      ...over,
    };
  };
  const approval = (over: Partial<SkillDraftApprovalDeps> = {}): SkillDraftApprovalDeps => ({
    drafts,
    adapter: () => adapter,
    slack: slack(),
    clock: () => now,
    ownerSlackId: OWNER,
    ...over,
  });

  test("a new skill is sent to the owner whole, pending, with Approve and Reject", async () => {
    await review(build(), [skill()]);
    const [d] = drafts.pending();
    expect(d).toMatchObject({ name: "rotate-logs", base: undefined, state: "pending", sourceChannel: PUBLIC });
    expect(dms.length).toBe(1);
    expect(dms[0]?.text).toContain("a new skill");
    expect(dms[0]?.text).toContain("archive the logs");
    expect(dms[0]?.actions.map((a) => a.actionId)).toEqual([HARVEST_APPROVE_ACTION, HARVEST_REJECT_ACTION]);
    // nothing is in the adapter yet
    expect(adapter!.store.files().has("skills/rotate-logs/SKILL.md")).toBe(false);
  });

  test("a change to an existing skill is shown as a diff against the file", async () => {
    const patched = DEPLOY.replace("2. run the deploy script", "2. run the deploy script\n3. check the health page");
    await review(build(), [skill({ name: "deploy-staging", content: patched })]);
    const [d] = drafts.pending();
    expect(d?.base).toBe(DEPLOY);
    expect(dms[0]?.text).toContain("a change to the skill");
    expect(dms[0]?.text).toContain("+ 3. check the health page");
    expect(dms[0]?.text).not.toContain("connect the VPN");
  });

  test("Approve writes it into the adapter the normal way, as a revision, and settles the notice", async () => {
    await review(build(), [skill()]);
    const [d] = drafts.pending();
    const out = await decideSkillDraftPress(approval(), press(d!.id, HARVEST_APPROVE_ACTION));
    expect(out).toEqual({ kind: "approved", id: d!.id });
    expect(adapter!.store.files().get("skills/rotate-logs/SKILL.md")).toBe(NEW_SKILL);
    expect(adapter!.store.load().skills.map((s) => s.name)).toContain("rotate-logs");
    expect(adapter!.revisions?.list()[0]?.reason).toBe("harvest skill: rotate-logs");
    expect(drafts.get(d!.id)?.state).toBe("approved");
    expect(settled[0]?.text).toContain("approved");
  });

  test("Approve of a patch writes the patched file", async () => {
    const patched = DEPLOY.replace("2. run the deploy script", "2. run the deploy script\n3. check the health page");
    await review(build(), [skill({ name: "deploy-staging", content: patched })]);
    const [d] = drafts.pending();
    await decideSkillDraftPress(approval(), press(d!.id, HARVEST_APPROVE_ACTION));
    expect(adapter!.store.files().get("skills/deploy-staging/SKILL.md")).toBe(patched);
  });

  test("a skill changed since the draft was written is refused, and the draft stays pending", async () => {
    const patched = DEPLOY.replace("2. run the deploy script", "2. run the deploy script\n3. check the health page");
    await review(build(), [skill({ name: "deploy-staging", content: patched })]);
    const [d] = drafts.pending();
    // someone edits the skill meanwhile
    const files = new Map(adapter!.store.files());
    files.set("skills/deploy-staging/SKILL.md", `${DEPLOY}4. an edit by someone else\n`);
    adapter!.store.write(files);
    const out = await decideSkillDraftPress(approval(), press(d!.id, HARVEST_APPROVE_ACTION));
    expect(out.kind).toBe("failed");
    expect(draftPressNotice(out)).toContain("still pending");
    expect(drafts.get(d!.id)?.state).toBe("pending");
    expect(adapter!.store.files().get("skills/deploy-staging/SKILL.md")).toContain("an edit by someone else");
  });

  test("Reject is remembered: the same draft, and the same skill reworded, are never raised again", async () => {
    const h = build({ maxPerDay: 20 });
    await review(h, [skill()]);
    const [d] = drafts.pending();
    expect((await decideSkillDraftPress(approval(), press(d!.id, HARVEST_REJECT_ACTION))).kind).toBe("rejected");
    expect(drafts.get(d!.id)?.state).toBe("rejected");
    expect(adapter!.store.files().has("skills/rotate-logs/SKILL.md")).toBe(false);
    dms = [];
    await review(h, [skill()]);
    await review(h, [skill({ content: NEW_SKILL.replace("stop the service", "halt the service first") })]);
    expect(drafts.countSince(0)).toBe(1);
    expect(dms).toEqual([]);
    // and the model is told not to propose it
    expect(calls.at(-1)?.messages[0]?.content).toContain("skill rotate-logs");
  });

  test("the same draft is not asked twice while it waits", async () => {
    const h = build({ maxPerDay: 20 });
    await review(h, [skill()]);
    await review(h, [skill()]);
    expect(drafts.countSince(0)).toBe(1);
    expect(dms.length).toBe(1);
  });

  test("only a few drafts wait at once", async () => {
    const h = build({ maxPerDay: 20 });
    for (const name of ["skill-aaa", "skill-bbb", "skill-ccc", "skill-ddd"]) {
      await review(h, [skill({ name, content: NEW_SKILL.replace(/rotate-logs/g, name) })]);
    }
    expect(drafts.pending().length).toBe(3);
  });

  test("a draft may not choose how a skill runs", async () => {
    await review(build(), [skill({ content: NEW_SKILL.replace("description:", "worker: orca\ndescription:") })]);
    expect(drafts.pending()).toEqual([]);
  });

  test("a draft too long for the notice is dropped: the owner reads all of what they approve", async () => {
    await review(build(), [skill({ content: `${NEW_SKILL}${"another step that goes on\n".repeat(120)}` })]);
    expect(drafts.pending()).toEqual([]);
  });

  test("a draft whose notice never went out is not left pending", async () => {
    dmWorks = false;
    await review(build(), [skill()]);
    expect(drafts.pending()).toEqual([]);
    dmWorks = true;
    await review(build(), [skill()]);
    expect(drafts.pending().length).toBe(1);
  });

  test("a skill needs an adapter to live in", async () => {
    adapter = undefined;
    await review(build(), [skill()]);
    expect(drafts.countSince(0)).toBe(0);
  });

  test("only the owner's press counts", async () => {
    await review(build(), [skill()]);
    const [d] = drafts.pending();
    const out = await decideSkillDraftPress(approval(), press(d!.id, HARVEST_APPROVE_ACTION, { slackUserId: "U0USER0001" }));
    expect(out).toEqual({ kind: "refused", why: "not-owner", id: d!.id });
    expect(drafts.get(d!.id)?.state).toBe("pending");
    expect(adapter!.store.files().has("skills/rotate-logs/SKILL.md")).toBe(false);
  });

  test("a press on another message, or one a turn edited, is refused", async () => {
    await review(build(), [skill()]);
    const [d] = drafts.pending();
    const wrongMessage = await decideSkillDraftPress(approval(), press(d!.id, HARVEST_APPROVE_ACTION, { messageTs: "someone-elses" }));
    expect(wrongMessage).toMatchObject({ kind: "refused", why: "forged" });
    const edited = await decideSkillDraftPress(approval(), press(d!.id, HARVEST_APPROVE_ACTION, { edited: true }));
    expect(edited).toMatchObject({ kind: "refused", why: "forged" });
    // the DM was rewritten to show a different text: the fingerprint no longer matches
    const rewritten = noticeBlocks("a different skill entirely", dms[0]!.actions);
    const out = await decideSkillDraftPress(approval(), press(d!.id, HARVEST_APPROVE_ACTION, { blocks: rewritten }));
    expect(out).toMatchObject({ kind: "refused", why: "forged" });
    // no blocks at all
    expect(await decideSkillDraftPress(approval(), press(d!.id, HARVEST_APPROVE_ACTION, { blocks: undefined }))).toMatchObject({ kind: "refused", why: "forged" });
    expect(drafts.get(d!.id)?.state).toBe("pending");
    expect(adapter!.store.files().has("skills/rotate-logs/SKILL.md")).toBe(false);
  });

  test("a double press changes nothing the second time", async () => {
    await review(build(), [skill()]);
    const [d] = drafts.pending();
    await decideSkillDraftPress(approval(), press(d!.id, HARVEST_APPROVE_ACTION));
    const again = await decideSkillDraftPress(approval(), press(d!.id, HARVEST_REJECT_ACTION));
    expect(again).toEqual({ kind: "decided", id: d!.id, state: "approved" });
    expect(drafts.get(d!.id)?.state).toBe("approved");
    expect(draftPressNotice(again)).toContain("already approved");
  });

  test("a button that is not a harvest one, or names no draft, is unknown", async () => {
    expect(await decideSkillDraftPress(approval(), { slackUserId: OWNER, actionId: "jv:learning:approve", value: "1" })).toEqual({ kind: "unknown" });
    expect(await decideSkillDraftPress(approval(), { slackUserId: OWNER, actionId: HARVEST_APPROVE_ACTION, value: "99" })).toEqual({ kind: "unknown" });
    expect(await decideSkillDraftPress(approval(), { slackUserId: OWNER, actionId: HARVEST_APPROVE_ACTION, value: "x" })).toEqual({ kind: "unknown" });
  });
});
