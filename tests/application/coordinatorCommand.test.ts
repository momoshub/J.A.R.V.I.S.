import { describe, expect, test } from "bun:test";
import { dispatchCommand, listCommandInfo, type CommandDeps } from "../../src/application/commands.ts";
import type { BlockerInput, Coordinator } from "../../src/application/coordinator.ts";
import { seededBook } from "../../src/domain/roleSeed.ts";
import { OWNER, actor, build } from "./commandsFixture.ts";

const setup = () => {
  const calls: string[] = [];
  const blockers: BlockerInput[] = [];
  const coordinator: Coordinator = {
    tick: async () => {},
    blocker: async (i) => (blockers.push(i), "raised"),
    act: async (l) => void calls.push(`act:${l}`),
    fixed: async (k, l) => (calls.push(`fixed:${k}:${l}`), k !== "not-granted"),
    status: () => "status text",
  };
  const deps: CommandDeps = {
    ...build(),
    coordinator,
    roles: seededBook({ commands: listCommandInfo().map((c) => ({ name: c.name, minRole: c.minRole })) }),
  };
  return { deps, calls, blockers };
};

const run = (deps: CommandDeps, line: string, who = actor()) => dispatchCommand(deps, who, "D1", line, { fromBrainRun: true });

describe("coordinator command", () => {
  test("act, fixed and status reach the coordinator; blocker parses its facts and hands them over", async () => {
    const { deps, calls, blockers } = setup();
    expect(await run(deps, 'coordinator act "closed journey #3"')).toContain("digest");
    expect(await run(deps, 'coordinator fixed cache-bust "flushed it"')).toContain("direct DM");
    expect(await run(deps, "coordinator status")).toBe("status text");
    expect(calls).toEqual(["act:closed journey #3", "fixed:cache-bust:flushed it"]);
    expect(await run(deps, 'coordinator blocker pg-full --kind prod-write --prod --incident --reversible "disk is filling"')).toBe("raised");
    expect(blockers[0]).toMatchObject({ key: "pg-full", kind: "prod-write", text: "disk is filling" });
    expect(blockers[0]!.facts).toMatchObject({ prod: true, incident: true, reversible: true, dataWrite: false });
  });

  test("fixed without a granted self-fix says so and reports nothing as done", async () => {
    const { deps } = setup();
    const out = await run(deps, 'coordinator fixed not-granted "did a thing"');
    expect(out).toContain("No self-fix was granted");
    expect(out).toContain("Nothing was posted");
  });

  test("a bad blocker line says what is wrong and raises nothing", async () => {
    const { deps, blockers } = setup();
    expect(await run(deps, "coordinator blocker k --nope x")).toContain("I do not know");
    expect(await run(deps, "coordinator blocker k")).toContain("sentence");
    expect(blockers).toHaveLength(0);
  });

  test("only the brain's own turn, only as the owner: a typed line and another person's turn are refused", async () => {
    const { deps, calls } = setup();
    const typed = await dispatchCommand(deps, actor(), "D1", 'coordinator act "x"');
    expect(typed).not.toContain("digest");
    const pal = await run(deps, 'coordinator act "x"', actor({ slackId: "U0PAL000001", role: "pal" }));
    expect(pal).not.toContain("digest");
    expect(calls).toEqual([]);
    expect(OWNER).toBe(actor().slackId);
  });

  test("with the coordinator off it says so", async () => {
    const { deps } = setup();
    expect(await run({ ...deps, coordinator: undefined }, "coordinator status")).toContain("off");
  });
});
