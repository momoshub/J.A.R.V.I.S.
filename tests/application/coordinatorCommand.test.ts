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

describe("unblock command", () => {
  const LINK = "https://team.slack.com/archives/C0TEST00001/p1795000000123456";
  const PAL = "U0PAL000001";
  const palTurn = () => actor({ slackId: PAL, role: "pal" });
  const inThread = (deps: CommandDeps, text: string, who = palTurn(), threadTs = "1795000000.123456", channel = "C0TEST00001") =>
    dispatchCommand(deps, who, channel, text, { fromBrainRun: true, threadTs });
  const line = `unblock --thread ${LINK} --for ${PAL} --need "needs the staging grant" --plan "run it for them"`;

  test("a pal's brain turn hands the coordinator an unblock for that thread; the owner is the one decided to ask", async () => {
    const { deps, blockers } = setup();
    expect(await inThread(deps, line)).toBe("raised");
    expect(blockers).toHaveLength(1);
    expect(blockers[0]).toMatchObject({
      kind: "unblock",
      text: "needs the staging grant",
      subject: { forUser: PAL, channelId: "C0TEST00001", threadTs: "1795000000.123456", plan: "run it for them" },
    });
    expect(blockers[0]!.facts).toMatchObject({ prod: false, ownerDecision: true, reversible: false });
  });

  test("the same line twice has the same key, so the coordinator can dedupe it", async () => {
    const { deps, blockers } = setup();
    await inThread(deps, line);
    await inThread(deps, line.replace("needs the staging grant", "Needs the staging grant!"));
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
    expect(await inThread(deps, `unblock --for ${PAL} --need x`)).toContain("--thread");
    expect(await inThread(deps, `unblock --thread ${LINK} --for ${PAL}`)).toContain("--need");
    expect(await inThread(deps, `unblock --thread ${LINK} --for ${OWNER} --need x`, actor())).toContain("needs no unblocking");
    expect(blockers).toHaveLength(0);
  });

  test("with the coordinator off it says so", async () => {
    const { deps } = setup();
    expect(await inThread({ ...deps, coordinator: undefined }, line)).toContain("cannot reach the owner");
  });

  test("`coordinator blocker --for --thread` is the same wall for that person", async () => {
    const { deps, blockers } = setup();
    await run(deps, `coordinator blocker j87 --for ${PAL} --thread ${LINK} "build never started"`);
    expect(blockers[0]).toMatchObject({ key: "j87", kind: "unblock", subject: { forUser: PAL } });
  });

  test("the thread must be the one the conversation is in, and the person the one it serves", async () => {
    const { deps, blockers } = setup();
    expect(await inThread(deps, line, palTurn(), "1795000000.999999")).toContain("must be the thread this conversation is in");
    expect(await inThread(deps, line, palTurn(), undefined, "C0TEST00002")).toContain("must be the thread this conversation is in");
    expect(await inThread(deps, line.replace(PAL, "U0OTHER0002"))).toContain("must be the person you are talking to");
    expect(blockers).toHaveLength(0);
    // The owner may raise it for someone else, in that person's thread.
    expect(await inThread(deps, line.replace(PAL, "U0OTHER0002"), actor())).toBe("raised");
  });

  test("a top-level message is its own thread root", async () => {
    const { deps } = setup();
    const out = await dispatchCommand(deps, palTurn(), "C0TEST00001", line, { fromBrainRun: true, messageTs: "1795000000.123456" });
    expect(out).toBe("raised");
  });

  test("`coordinator blocker --kind unblock` needs a subject", async () => {
    const { deps, blockers } = setup();
    expect(await run(deps, 'coordinator blocker k --kind unblock "x"')).toContain("--for");
    expect(blockers).toHaveLength(0);
  });
});

