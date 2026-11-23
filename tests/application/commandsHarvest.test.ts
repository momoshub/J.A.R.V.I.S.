import { describe, expect, test } from "bun:test";
import { createSettingsRepo } from "../../src/infrastructure/db/settingsRepo.ts";
import { createSkillDraftRepo } from "../../src/infrastructure/db/skillDraftRepo.ts";
import { dispatchCommand, listCommandInfo } from "../../src/application/commands.ts";
import { HARVEST_SOURCE } from "../../src/domain/harvest.ts";
import { actor, build, db } from "./commandsFixture.ts";

describe("harvest command", () => {
  const withRepo = () => {
    const deps = build();
    deps.settings = createSettingsRepo(db);
    deps.skillDrafts = createSkillDraftRepo(db);
    return deps;
  };
  const run = (deps: ReturnType<typeof withRepo>, text: string, who = actor()) => dispatchCommand(deps, who, "C1", text);
  const pal = () => actor({ slackId: "U0PAL0099", role: "pal" });

  test("it is off by default and says nothing is saved without the owner", async () => {
    const out = await run(withRepo(), "harvest");
    expect(out).toContain("*off*");
    expect(out).toContain("nothing is saved until the owner approves it");
    expect(await run(withRepo(), "harvest status")).toContain("*off*");
  });

  test("on needs settings:manage, writes the setting and moves the cursor to now", async () => {
    const deps = withRepo();
    deps.settings!.set("learning_harvest_cursor", "86400000");
    expect(await run(deps, "harvest on", pal())).toContain("not allowed");
    expect(deps.settings!.get("learning_harvest")).toBeUndefined();
    const before = Date.now();
    expect(await run(deps, "harvest on")).toContain("learning harvest on");
    expect(deps.settings!.get("learning_harvest")).toBe("on");
    // whatever was said while it was off is not read
    expect(Number(deps.settings!.get("learning_harvest_cursor"))).toBeGreaterThanOrEqual(before);
    expect(await run(deps, "harvest")).toContain("*on*");
  });

  test("off needs settings:manage and stops it", async () => {
    const deps = withRepo();
    await run(deps, "harvest on");
    expect(await run(deps, "harvest off", pal())).toContain("not allowed");
    expect(deps.settings!.get("learning_harvest")).toBe("on");
    expect(await run(deps, "harvest off")).toContain("learning harvest off");
    expect(deps.settings!.get("learning_harvest")).toBe("off");
    expect(await run(deps, "harvest")).toContain("*off*");
  });

  test("a pal can read the status but not switch it", async () => {
    const deps = withRepo();
    expect(await run(deps, "harvest", pal())).toContain("*off*");
    expect(await run(deps, "harvest on", pal())).toContain("You are not allowed");
    expect(await run(deps, "harvest off", pal())).toContain("You are not allowed");
    expect(deps.settings!.get("learning_harvest")).toBeUndefined();
  });

  test("status counts what it proposed in the last day and the drafts waiting", async () => {
    const deps = withRepo();
    deps.learnings!.add("Releases ship on Thursdays and never on Fridays.", HARVEST_SOURCE, Date.now(), "pending");
    deps.learnings!.add("Someone typed this fact themselves today.", "U0USER0001", Date.now(), "pending");
    deps.skillDrafts!.add({ fingerprint: "a:1", name: "a-skill", content: "x", base: undefined, sourceChannel: "C1", sourceThreadTs: "1" }, Date.now());
    const out = await run(deps, "harvest");
    expect(out).toContain("proposed in the last day: 2 of at most");
    expect(out).toContain("skill drafts waiting for the owner: 1");
  });

  test("an unknown option shows the usage, and the command is listed", async () => {
    expect(await run(withRepo(), "harvest maybe")).toContain("Usage:");
    expect(listCommandInfo().map((c) => c.name)).toContain("harvest");
  });
});
