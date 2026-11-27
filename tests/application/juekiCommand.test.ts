import { describe, expect, test } from "bun:test";
import { dispatchCommand, listCommandInfo, type CommandDeps } from "../../src/application/commands.ts";
import type { BlockerInput, Jueki } from "../../src/application/jueki.ts";
import { seededBook } from "../../src/domain/roleSeed.ts";
import { OWNER, actor, build } from "./commandsFixture.ts";

const setup = () => {
  const calls: string[] = [];
  const blockers: BlockerInput[] = [];
  const jueki: Jueki = {
    tick: async () => {},
    blocker: async (i) => (blockers.push(i), "raised"),
    act: async (l) => void calls.push(`act:${l}`),
    fixed: async (k, l) => void calls.push(`fixed:${k}:${l}`),
    status: () => "status text",
  };
  const deps: CommandDeps = {
    ...build(),
    jueki,
    roles: seededBook({ commands: listCommandInfo().map((c) => ({ name: c.name, minRole: c.minRole })) }),
  };
  return { deps, calls, blockers };
};

const run = (deps: CommandDeps, line: string, who = actor()) => dispatchCommand(deps, who, "D1", line, { fromBrainRun: true });

describe("jueki command", () => {
  test("act, fixed and status reach Jueki; blocker parses its facts and hands them over", async () => {
    const { deps, calls, blockers } = setup();
    expect(await run(deps, 'jueki act "closed journey #3"')).toContain("digest");
    expect(await run(deps, 'jueki fixed cache-bust "flushed it"')).toContain("direct DM");
    expect(await run(deps, "jueki status")).toBe("status text");
    expect(calls).toEqual(["act:closed journey #3", "fixed:cache-bust:flushed it"]);
    expect(await run(deps, 'jueki blocker pg-full --kind prod-write --prod --incident --reversible "disk is filling"')).toBe("raised");
    expect(blockers[0]).toMatchObject({ key: "pg-full", kind: "prod-write", text: "disk is filling" });
    expect(blockers[0]!.facts).toMatchObject({ prod: true, incident: true, reversible: true, dataWrite: false });
  });

  test("a bad blocker line says what is wrong and raises nothing", async () => {
    const { deps, blockers } = setup();
    expect(await run(deps, "jueki blocker k --nope x")).toContain("I do not know");
    expect(await run(deps, "jueki blocker k")).toContain("sentence");
    expect(blockers).toHaveLength(0);
  });

  test("only the brain's own turn, only as the owner: a typed line and another person's turn are refused", async () => {
    const { deps, calls } = setup();
    const typed = await dispatchCommand(deps, actor(), "D1", 'jueki act "x"');
    expect(typed).not.toContain("digest");
    const pal = await run(deps, 'jueki act "x"', actor({ slackId: "U0PAL000001", role: "pal" }));
    expect(pal).not.toContain("digest");
    expect(calls).toEqual([]);
    expect(OWNER).toBe(actor().slackId);
  });

  test("with Jueki off it says so", async () => {
    const { deps } = setup();
    expect(await run({ ...deps, jueki: undefined }, "jueki status")).toContain("off");
  });
});
