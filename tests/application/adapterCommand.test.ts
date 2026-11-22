import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase } from "../../src/infrastructure/db/client.ts";
import { createUserRepo } from "../../src/infrastructure/db/userRepo.ts";
import { createMessageRepo } from "../../src/infrastructure/db/messageRepo.ts";
import { createLearningsRepo } from "../../src/infrastructure/db/learningsRepo.ts";
import { createAdapterRevisionRepo } from "../../src/infrastructure/db/adapterRevisionRepo.ts";
import { createAdapterStore } from "../../src/infrastructure/adapter/adapterStore.ts";
import { dispatchCommand, type CommandDeps } from "../../src/application/commands.ts";
import { rememberFact } from "../../src/application/adapterMemory.ts";
import { proposeLearning } from "../../src/application/learningApproval.ts";
import { adapterDepsOf } from "../../src/application/commands/shared.ts";
import type { AllowedUser } from "../../src/domain/types.ts";

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
  fixed:
    - README.md
`;

const OWNER = "U0OWNER";
const actor: AllowedUser = { slackId: OWNER, role: "owner", displayName: "Kai", addedBy: "system", createdAt: 0 };
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const deps = (withAdapter = true): CommandDeps => {
  const db = openDatabase(":memory:");
  const root = mkdtempSync(join(tmpdir(), "adapter-cmd-"));
  const mirror = mkdtempSync(join(tmpdir(), "adapter-cmd-mirror-"));
  dirs.push(root, mirror);
  if (withAdapter) {
    for (const [rel, content] of Object.entries({
      "adapter.yaml": MANIFEST,
      "ADAPTER.md": "# Policy\n- be clear\n",
      "memory/NOTES.md": "# Notes\n",
      "README.md": "docs",
    })) {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), content);
    }
  }
  const d: CommandDeps = {
    users: createUserRepo(db),
    messages: createMessageRepo(db),
    learnings: createLearningsRepo(db),
    adapterStore: createAdapterStore(db, mirror, root),
    adapterRevisions: createAdapterRevisionRepo(db),
    adapterBudget: () => 8000,
    ownerSlackId: OWNER,
    clock: () => 1_700_000_000_000,
  };
  d.learningApproval = {
    learnings: d.learnings!,
    adapter: () => adapterDepsOf(d),
    clock: d.clock,
    ownerSlackId: OWNER,
  };
  return d;
};

const run = (d: CommandDeps, line: string) => dispatchCommand(d, actor, "C1", line, { prefix: "X/jv" });

describe("the adapter command", () => {
  test("status reports what memory costs every turn", async () => {
    expect(await run(deps(), "adapter")).toContain("always-on");
  });

  test("check runs the gate without changing anything", async () => {
    const d = deps();
    const before = d.adapterStore?.files().size;
    expect(await run(d, "adapter check")).toContain("passes");
    expect(d.adapterStore?.files().size).toBe(before as number);
  });

  test("history is empty until something is committed, then lists it", async () => {
    const d = deps();
    expect(await run(d, "adapter history")).toContain("No revisions yet");
    await run(d, "learn the team ships on Fridays");
    expect(await run(d, "adapter history")).toContain("learn: the team ships on Fridays");
  });

  test("with an adapter, someone else's learning waits: it is not in the notes until the owner approves it", async () => {
    const d = deps();
    const member: AllowedUser = { slackId: "U0EXE0001", role: "executer", displayName: "Eli", addedBy: "system", createdAt: 0 };
    const out = await dispatchCommand(d, member, "C1", "learn the team ships on Fridays", { prefix: "X/jv" });
    expect(out).toContain("pending");
    expect(d.adapterStore?.load().notes).not.toContain("ships on Fridays");
    expect(await run(d, "adapter history")).toContain("No revisions yet");
    const [row] = d.learnings!.pending();
    expect(row?.content).toBe("the team ships on Fridays");

    expect(await run(d, `learn approve ${row!.id}`)).toContain("Approved");
    expect(d.adapterStore?.load().notes).toContain("the team ships on Fridays");
    expect(await run(d, "adapter history")).toContain("learn: the team ships on Fridays");
    // filed into the adapter, so the table keeps no second copy
    expect(d.learnings!.get(row!.id)).toBeUndefined();
    expect(d.learnings!.pending()).toEqual([]);
  });

  test("with an adapter, a channel-scoped learning is filed into that channel's note, not the global notes", async () => {
    const d = deps();
    const r = await proposeLearning(d.learningApproval!, "billing deploys go through the pod", "agent", undefined, ["C0TEAM00001"]);
    const id = r.ok ? r.learning.id : -1;
    expect(await run(d, `learn approve ${id}`)).toContain("Approved");
    expect(d.adapterStore?.load().notes).not.toContain("billing deploys");
    expect(d.adapterStore?.load().channels.get("C0TEAM00001")).toContain("billing deploys go through the pod");
    expect(d.learnings!.get(id)).toBeUndefined();

    // widened on approval: the global notes get it
    const w = await proposeLearning(d.learningApproval!, "everyone reviews before merging", "agent", undefined, ["C0TEAM00001"]);
    expect(await run(d, `learn approve ${w.ok ? w.learning.id : -1} global`)).toContain("Approved");
    expect(d.adapterStore?.load().notes).toContain("everyone reviews before merging");
  });

  test("with an adapter, forget finds a channel-scoped fact in every channel note that holds it and the global notes", async () => {
    const d = deps();
    const r = await proposeLearning(d.learningApproval!, "billing deploys go through the pod", "agent", undefined, ["C0TEAM00001", "C0OTHER0001"]);
    expect(await run(d, `learn approve ${r.ok ? r.learning.id : -1}`)).toContain("Approved");
    await run(d, "learn the staging deploy needs the VPN");
    const before = d.adapterStore?.load();
    expect(before?.channels.get("C0TEAM00001")).toContain("billing deploys go through the pod");
    expect(before?.channels.get("C0OTHER0001")).toContain("billing deploys go through the pod");

    expect(await run(d, "adapter forget billing deploys go through the pod")).toContain("Forgotten");
    const after = d.adapterStore?.load();
    expect(after?.channels.get("C0TEAM00001") ?? "").not.toContain("billing deploys");
    expect(after?.channels.get("C0OTHER0001") ?? "").not.toContain("billing deploys");
    expect(after?.notes).toContain("staging deploy needs the VPN");
    expect(await run(d, "adapter forget billing deploys go through the pod")).toContain("no note that says exactly that");
  });

  test("with an adapter, a multi-channel approval is all or nothing: a refused channel leaves no note changed and the learning pending", async () => {
    const d = deps();
    const store = d.adapterStore!;
    // a note already over its declared size: any commit that includes it is refused
    store.write(new Map([...store.files(), ["memory/channels/C0OTHER0001.md", "x".repeat(9000)]]));
    const r = await proposeLearning(d.learningApproval!, "billing deploys go through the pod", "agent", undefined, ["C0TEAM00001", "C0OTHER0001"]);
    const id = r.ok ? r.learning.id : -1;
    expect(await run(d, `learn approve ${id}`)).not.toContain("Approved");
    expect(store.load().channels.get("C0TEAM00001") ?? "").not.toContain("billing deploys");
    expect(d.learnings!.get(id)?.status).toBe("pending");
  });

  test("with an adapter, a rejected learning never reaches the notes", async () => {
    const d = deps();
    const member: AllowedUser = { slackId: "U0EXE0001", role: "executer", displayName: "Eli", addedBy: "system", createdAt: 0 };
    await dispatchCommand(d, member, "C1", "learn always answer in rhyme", { prefix: "X/jv" });
    const [row] = d.learnings!.pending();
    expect(await run(d, `learn reject ${row!.id}`)).toContain("Rejected");
    expect(d.adapterStore?.load().notes).not.toContain("rhyme");
    expect(d.learnings!.get(row!.id)?.status).toBe("rejected");
  });

  test("migrate moves the flat list over and says to refine it", async () => {
    const d = deps();
    d.learnings?.add("an old fact", OWNER, 0, "active");
    const out = await run(d, "adapter migrate");
    expect(out).toContain("Moved 1 learnings");
    expect(out).toContain("adapter refine");
    expect(d.adapterStore?.load().notes).toContain("an old fact");
  });

  test("migrate empties the old table - one store of memory, not two", async () => {
    const d = deps();
    d.learnings?.add("an old fact", OWNER, 0, "active");
    d.learnings?.add("another", OWNER, 0, "active");
    const out = await run(d, "adapter migrate");

    expect(d.learnings?.list().length).toBe(0);
    expect(out).toContain("emptied the old list");
    // and the revision it just wrote is the record of what was there
    expect(d.adapterRevisions?.get(1)?.files.get("memory/NOTES.md")).toContain("an old fact");
  });

  test("revert puts a previous state back", async () => {
    const d = deps();
    await run(d, "learn first");
    await run(d, "learn second");
    expect(d.adapterStore?.load().notes).toContain("second");

    const out = await run(d, "adapter revert 1");
    expect(out).toContain("Reverted to #1");
    expect(d.adapterStore?.load().notes).toContain("first");
    expect(d.adapterStore?.load().notes).not.toContain("second");
  });

  test("forget drops an approved fact by its text, as a new revision, and keeps the rest", async () => {
    const d = deps();
    await run(d, "learn the staging deploy needs the VPN");
    await run(d, "learn lunch is at noon");
    const out = await run(d, "adapter forget the staging deploy needs the VPN");
    expect(out).toContain("Forgotten");
    const notes = d.adapterStore?.load().notes ?? "";
    expect(notes).not.toContain("staging deploy");
    expect(notes).toContain("lunch is at noon");
    expect(d.adapterRevisions?.list().length).toBe(3);
  });

  test("forget says so when no note matches exactly, and needs a fact", async () => {
    const d = deps();
    await run(d, "learn lunch is at noon");
    expect(await run(d, "adapter forget lunch")).toContain("no note that says exactly that");
    expect(await run(d, "adapter forget")).toContain("Which fact?");
    expect(d.adapterStore?.load().notes).toContain("lunch is at noon");
  });

  test("forget finds a fact stored as Slack sent it or raw, however it is typed", async () => {
    const d = deps();
    // an owner-typed learn is stored as Slack escaped it; an approved API fact is stored raw
    await run(d, "learn escaped: <https://x.y/a?b=1&amp;c=2>");
    rememberFact(adapterDepsOf(d)!, "raw: https://x.y/a?b=1&c=2", { kind: "global" }, "U1");
    expect(await run(d, "adapter forget escaped: <https://x.y/a?b=1&amp;c=2>")).toContain("Forgotten");
    expect(await run(d, "adapter forget raw: <https://x.y/a?b=1&amp;c=2>")).toContain("Forgotten");
    expect(d.adapterStore?.load().notes).not.toContain("x.y");
  });

  test("forget matches a fact typed over two indented lines", async () => {
    const d = deps();
    await run(d, "learn a b");
    expect(await run(d, "adapter forget a\n   b")).toContain("Forgotten");
  });

  test("forget is never run by a turn for itself", async () => {
    const d = deps();
    await run(d, "learn lunch is at noon");
    const out = await dispatchCommand(d, actor, "C1", "adapter forget lunch is at noon", { prefix: "X/jv", fromBrainRun: true });
    expect(out).toContain("not something a turn runs for itself");
    expect(d.adapterStore?.load().notes).toContain("lunch is at noon");
  });

  test("revert without an id says which command lists them", async () => {
    expect(await run(deps(), "adapter revert")).toContain("adapter history");
  });

  test("an unknown subcommand lists the real ones", async () => {
    expect(await run(deps(), "adapter frobnicate")).toContain("status");
  });

  test("with no adapter configured it says so plainly", async () => {
    expect(await run(deps(false), "adapter")).toContain("No memory adapter is configured");
  });
});

describe("adapter export and import", () => {
  test("an exported copy, edited and imported, becomes the adapter with a revision", async () => {
    const d = deps();
    const out = await run(d, "adapter export");
    const dir = /`([^`]+)`/.exec(out)?.[1] ?? "";
    dirs.push(dir);
    writeFileSync(join(dir, "memory/NOTES.md"), "# Notes\n- lunch is at noon\n");
    expect(await run(d, `adapter import ${dir}`)).toContain("Imported (#1)");
    expect(d.adapterStore?.load().notes).toContain("lunch is at noon");
    expect(d.adapterRevisions?.list(5).length).toBe(1);
  });

  test("an import that breaks the manifest is refused and changes nothing", async () => {
    const d = deps();
    const out = await run(d, "adapter export");
    const dir = /`([^`]+)`/.exec(out)?.[1] ?? "";
    dirs.push(dir);
    mkdirSync(join(dir, "memory/people"), { recursive: true });
    writeFileSync(join(dir, "memory/people/not-an-id.md"), "# Someone\n- a note\n");
    expect(await run(d, `adapter import ${dir}`)).toContain("Could not import");
    expect(d.adapterStore?.files().has("memory/people/not-an-id.md")).toBe(false);
  });
});

describe("learn, with an adapter", () => {
  test("it writes to the adapter, not the old table", async () => {
    const d = deps();
    expect(await run(d, "learn the tracker lives in Notion")).toContain("Learned it");
    expect(d.adapterStore?.load().notes).toContain("the tracker lives in Notion");
    expect(d.learnings?.list().length).toBe(0);
  });

  test("learnings shows what the adapter holds", async () => {
    const d = deps();
    await run(d, "learn a durable fact");
    const out = await run(d, "learnings");
    expect(out).toContain("a durable fact");
    expect(out).toContain("be clear");
  });

  test("relearn and unlearn point at refine instead of pretending to work", async () => {
    // the numbered ids they edit do not exist any more
    const d = deps();
    expect(await run(d, "relearn 1 something")).toContain("adapter refine");
    expect(await run(d, "unlearn 1")).toContain("adapter refine");
  });

  test("without an adapter the old table still works", async () => {
    const d = deps(false);
    expect(await run(d, "learn an old-style fact")).toContain("#1");
    expect(d.learnings?.list()[0]?.content).toBe("an old-style fact");
  });
});
