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
    fixed: async (k, l) => (calls.push(`fixed:${k}:${l}`), k !== "not-granted"),
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

  test("fixed without a granted self-fix says so and reports nothing as done", async () => {
    const { deps } = setup();
    const out = await run(deps, 'jueki fixed not-granted "did a thing"');
    expect(out).toContain("No self-fix was granted");
    expect(out).toContain("Nothing was posted");
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

describe("unblock command", () => {
  const LINK = "https://team.slack.com/archives/C0TEST00001/p1795000000123456";
  const PAL = "U0PAL000001";
  const palTurn = () => actor({ slackId: PAL, role: "pal" });
  const line = `unblock --thread ${LINK} --for ${PAL} --need "needs the staging grant" --plan "run it for them"`;

  test("a pal's brain turn hands Jueki an unblock for that thread; the owner is the one decided to ask", async () => {
    const { deps, blockers } = setup();
    expect(await run(deps, line, palTurn())).toBe("raised");
    expect(blockers).toHaveLength(1);
    expect(blockers[0]).toMatchObject({
      kind: "unblock",
      text: "needs the staging grant",
      subject: { forUser: PAL, channelId: "C0TEST00001", threadTs: "1795000000.123456", plan: "run it for them" },
    });
    expect(blockers[0]!.facts).toMatchObject({ prod: false, ownerDecision: true, reversible: false });
  });

  test("the same line twice has the same key, so Jueki can dedupe it", async () => {
    const { deps, blockers } = setup();
    await run(deps, line, palTurn());
    await run(deps, line.replace("needs the staging grant", "Needs the staging grant!"), palTurn());
    expect(blockers[0]!.key).toBe(blockers[1]!.key);
  });

  test("a typed line is refused for everyone, the owner included", async () => {
    const { deps, blockers } = setup();
    await dispatchCommand(deps, palTurn(), "D1", line);
    await dispatchCommand(deps, actor(), "D1", line);
    expect(blockers).toHaveLength(0);
  });

  test("approve and reject are never a command: only the owner's button", async () => {
    const { deps, blockers } = setup();
    expect(await run(deps, "unblock approve 1", actor())).toContain("only by the owner pressing the button");
    expect(await run(deps, "unblock reject 1", palTurn())).toContain("only by the owner pressing the button");
    expect(blockers).toHaveLength(0);
  });

  test("a bad line says what is wrong; the owner is not unblocked by the owner", async () => {
    const { deps, blockers } = setup();
    expect(await run(deps, `unblock --for ${PAL} --need x`, palTurn())).toContain("--thread");
    expect(await run(deps, `unblock --thread ${LINK} --for ${PAL}`, palTurn())).toContain("--need");
    expect(await run(deps, `unblock --thread ${LINK} --for ${OWNER} --need x`, palTurn())).toContain("needs no unblocking");
    expect(blockers).toHaveLength(0);
  });

  test("with Jueki off it says so", async () => {
    const { deps } = setup();
    expect(await run({ ...deps, jueki: undefined }, line, palTurn())).toContain("cannot reach the owner");
  });

  test("`jueki blocker --for --thread` is the same wall for that person", async () => {
    const { deps, blockers } = setup();
    await run(deps, `jueki blocker j87 --for ${PAL} --thread ${LINK} "build never started"`);
    expect(blockers[0]).toMatchObject({ key: "j87", kind: "unblock", subject: { forUser: PAL } });
  });
});

