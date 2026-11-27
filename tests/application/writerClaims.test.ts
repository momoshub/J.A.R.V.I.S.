import { describe, expect, test } from "bun:test";
import { dispatchCommand, listCommandInfo, type CommandDeps } from "../../src/application/commands.ts";
import { createWriterClaims, releaseClaimsOnWorkerEnd } from "../../src/application/writerClaims.ts";
import { seededBook } from "../../src/domain/roleSeed.ts";
import { createWriterClaimRepo } from "../../src/infrastructure/db/writerClaimRepo.ts";
import { OWNER, actor, build, db } from "./commandsFixture.ts";

const setup = () => {
  const base = build();
  const clock = { t: 1_000_000_000 };
  const repo = createWriterClaimRepo(db);
  const writerClaims = createWriterClaims(() => clock.t, repo);
  const deps: CommandDeps = {
    ...base,
    writerClaims,
    clock: () => clock.t,
    roles: seededBook({ commands: listCommandInfo().map((c) => ({ name: c.name, minRole: c.minRole })) }),
  };
  return { deps, repo, writerClaims, clock };
};

const run = (deps: CommandDeps, line: string, thread = "1.1", who = actor(), channel = "C1", fromBrainRun = true) =>
  dispatchCommand(deps, who, channel, line, { fromBrainRun, threadTs: thread });

describe("claim: one writer per job", () => {
  test("the first thread takes a job, the second is refused with the holder's dispatch id and thread", async () => {
    const { deps } = setup();
    expect(await run(deps, "claim take bug:23 branch:fix/x")).toContain("Claimed bug:23, branch:fix/x");
    expect(await run(deps, "claim bind ctx_aaa bug:23 branch:fix/x")).toContain("Bound bug:23, branch:fix/x to ctx_aaa");
    const refused = await run(deps, "claim take bug:23", "9.9", actor(), "C2");
    expect(refused).toContain("bug:23 is held by worker ctx_aaa");
    expect(refused).toContain("thread C1 1.1");
    expect(refused).toContain("Do not start a second writer");
    // the branch name is a job too
    expect(await run(deps, "claim take branch:fix/x", "9.9", actor(), "C2")).toContain("held by worker ctx_aaa");
  });

  test("a take is every key or none: one held key leaves the others free", async () => {
    const { deps, repo } = setup();
    await run(deps, "claim take bug:1");
    await run(deps, "claim bind ctx_a bug:1");
    expect(await run(deps, "claim take bug:2 bug:1", "9.9", actor(), "C2")).toContain("bug:1 is held");
    expect(repo.liveOfKey("bug:2")).toHaveLength(0);
  });

  test("the same thread asking again before its writer started refreshes its claim (a retry), after the bind it is refused", async () => {
    const { deps, repo } = setup();
    await run(deps, "claim take bug:3");
    expect(await run(deps, "claim take bug:3")).toContain("Claimed bug:3");
    expect(repo.liveOfKey("bug:3")).toHaveLength(1);
    await run(deps, "claim bind ctx_a bug:3");
    expect(await run(deps, "claim take bug:3")).toContain("is held by worker ctx_a");
  });

  test("bind needs the claim of this thread, and a bad key or dispatch id is told how it should look", async () => {
    const { deps } = setup();
    expect(await run(deps, "claim bind ctx_a bug:4")).toContain("not claimed by this thread");
    await run(deps, "claim take bug:4");
    expect(await run(deps, "claim bind ctx_a bug:4", "9.9", actor(), "C2")).toContain("not claimed by this thread");
    expect(await run(deps, "claim bind nope bug:4")).toContain("claim bind <ctx_...>");
    expect(await run(deps, "claim take pr:4")).toContain("is not a job key");
  });

  test("release: the holding thread may, another thread may not, and the owner may force it", async () => {
    const { deps, repo } = setup();
    await run(deps, "claim take bug:5");
    await run(deps, "claim bind ctx_a bug:5");
    expect(await run(deps, "claim release bug:5", "9.9", actor({ slackId: "U0ADMIN0001", role: "admin" }), "C2")).toContain("is held by worker ctx_a");
    expect(await run(deps, "claim release bug:5 --force", "9.9", actor({ slackId: "U0ADMIN0001", role: "admin" }), "C2")).toContain("Only the owner force-releases");
    expect(await run(deps, "claim release bug:5 --force", "9.9", actor(), "C2")).toContain("Released bug:5");
    expect(repo.liveOfKey("bug:5")).toHaveLength(0);
    await run(deps, "claim take bug:5");
    expect(await run(deps, "claim release bug:5")).toContain("Released bug:5");
    expect(await run(deps, "claim release bug:5")).toContain("is not claimed");
  });

  test("list shows who holds what; it is the brain's own command, never a typed line", async () => {
    const { deps } = setup();
    expect(await run(deps, "claim list")).toBe("No live claims.");
    await run(deps, "claim take journey:7");
    await run(deps, "claim bind ctx_j journey:7");
    expect(await run(deps, "claim list")).toContain("journey:7: worker ctx_j");
    expect(await run(deps, "claim take bug:9", "1.1", actor(), "C1", false)).not.toContain("Claimed");
  });

  test("without a claim table the command says nothing stops a second writer", async () => {
    const base = build();
    expect(await dispatchCommand(base, actor(), "C1", "claim take bug:1", { fromBrainRun: true })).toContain("keep no claims");
  });
});

describe("releaseClaimsOnWorkerEnd (the watcher's onFired)", () => {
  const helper = "/bin/orca-worker-wait.ts";
  const watch = { check: `'/bun' '${helper}' 'ctx_w1'` };
  const held = () => {
    const { writerClaims, repo } = setup();
    writerClaims.take(["bug:1", "branch:fix/a"], { channelId: "C1", threadTs: "1.1", actor: OWNER });
    writerClaims.bind(["bug:1", "branch:fix/a"], "ctx_w1", { channelId: "C1", threadTs: "1.1" });
    return { writerClaims, repo };
  };

  test("a worker that finished or died frees every claim it held", () => {
    for (const out of ["orca worker ctx_w1 finished: done", "orca worker ctx_w1 died: gone"]) {
      const { writerClaims, repo } = held();
      expect(releaseClaimsOnWorkerEnd(writerClaims, helper)(watch, out)).toBe(2);
      expect(repo.live()).toHaveLength(0);
    }
  });

  test("waiting frees nothing, nor does a shell watch printing the same line, nor another worker's end", () => {
    const { writerClaims, repo } = held();
    expect(releaseClaimsOnWorkerEnd(writerClaims, helper)(watch, "orca worker ctx_w1 waiting: input")).toBe(0);
    expect(releaseClaimsOnWorkerEnd(writerClaims, helper)({ check: "echo hi" }, "orca worker ctx_w1 finished: x")).toBe(0);
    expect(releaseClaimsOnWorkerEnd(writerClaims, helper)(watch, "orca worker ctx_other finished: x")).toBe(0);
    expect(repo.live()).toHaveLength(2);
  });

  test("a freed job can be claimed again", () => {
    const { writerClaims } = held();
    releaseClaimsOnWorkerEnd(writerClaims, helper)(watch, "orca worker ctx_w1 finished: done");
    expect(writerClaims.take(["bug:1"], { channelId: "C2", threadTs: "2.2", actor: OWNER })).toEqual({ ok: true });
  });
});
