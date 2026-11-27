import { describe, expect, test } from "bun:test";
import { createExecProxy, type ExecRequest, type ExecProxyDeps } from "../../src/application/execProxy.ts";
import { mintSession } from "../../src/domain/sandboxSession.ts";
import { seededBook } from "../../src/domain/roleSeed.ts";
import type { AllowedUser, UserRole } from "../../src/domain/types.ts";

const NOW = 1_800_000_000_000;
const SECRET = "test-secret";
const session = mintSession(SECRET, NOW / 1000 + 3600);
const roles = seededBook({ commands: [{ name: "worker-ticket", minRole: "admin" }] });

const user = (slackId: string, role: UserRole): AllowedUser => ({ slackId, role, displayName: slackId, addedBy: "", createdAt: 0 });
const people: Record<string, AllowedUser> = { UOWNER: user("UOWNER", "owner"), UPAL: user("UPAL", "pal"), UADMIN: user("UADMIN", "admin") };

type Setup = { workerOk?: (call: { action: string; repo: string }) => boolean };
const setup = (opts: Setup = {}) => {
  const ran: { tool: string; argv: readonly string[]; stdin?: string; env?: Record<string, string> }[] = [];
  const audit: { slackUserId: string; command: string; args: string; ok: boolean; result: string }[] = [];
  const deps: ExecProxyDeps = {
    clock: () => NOW,
    sessionSecret: () => SECRET,
    peekTurn: (t) => (t === "turn-owner" ? { actor: "UOWNER", channel: "C1" } : t === "turn-pal" ? { actor: "UPAL", channel: "C1" } : undefined),
    redeemWorker: (_t, call) =>
      (opts.workerOk ?? (() => true))(call)
        ? { ok: true, actor: "UADMIN", channel: "C2", dispatchId: "ctx_1", id: "abcd1234", push: false }
        : { ok: false, reason: "action", message: `this ticket does not grant ${call.action}` },
    users: { get: (id) => people[id] },
    roles,
    allowedOwners: ["momoshub"],
    audit: { add: (entry) => void audit.push(entry) },
    run: async (tool, argv, o) => {
      ran.push({ tool, argv, ...(o.stdin !== undefined ? { stdin: o.stdin } : {}), ...(o.env ? { env: o.env } : {}) });
      return { code: 0, stdout: "out", stderr: "" };
    },
  };
  const proxy = createExecProxy(deps);
  const call = (req: Partial<ExecRequest> & Pick<ExecRequest, "argv">) => proxy.handle({ bearer: session, tool: "gh", ...req });
  return { call, ran, audit };
};

const refused = (r: Awaited<ReturnType<ReturnType<typeof setup>["call"]>>): string => (r.ok ? "" : r.error);

describe("exec proxy: who may read", () => {
  test("a session reads GitHub on an allowed owner and the real command's output comes back", async () => {
    const { call, ran } = setup();
    expect(await call({ argv: ["pr", "view", "1", "-R", "momoshub/J.A.R.V.I.S."] })).toEqual({ ok: true, code: 0, stdout: "out", stderr: "" });
    expect(ran[0]).toMatchObject({ tool: "gh", argv: ["pr", "view", "1", "-R", "momoshub/J.A.R.V.I.S."] });
  });

  test("a repo outside GITHUB_APP_ALLOWED_OWNERS is refused before anything runs", async () => {
    const { call, ran } = setup();
    expect(refused(await call({ argv: ["pr", "view", "1", "-R", "evil/x"] }))).toContain("not in GITHUB_APP_ALLOWED_OWNERS");
    expect(ran).toEqual([]);
  });

  test("no bearer, a forged, an expired or an unknown one is refused", async () => {
    const { call, ran } = setup();
    const argv = ["pr", "view", "1", "-R", "momoshub/x"];
    expect(refused(await call({ argv, bearer: "" }))).toContain("needs one");
    expect(refused(await call({ argv, bearer: mintSession("wrong", NOW / 1000 + 60) }))).toContain("not a valid");
    expect(refused(await call({ argv, bearer: mintSession(SECRET, NOW / 1000 - 1) }))).toContain("expired");
    expect(refused(await call({ argv, bearer: "nonsense" }))).toContain("not valid any more");
    expect(ran).toEqual([]);
  });
});

describe("exec proxy: who may write", () => {
  const write = ["pr", "comment", "1", "--body", "hi", "-R", "momoshub/x"];

  test("a bare session never writes, whatever it asks", async () => {
    const { call, ran } = setup();
    expect(refused(await call({ argv: write }))).toContain("cannot write");
    expect(refused(await call({ argv: ["pr", "review", "1", "--comment", "-b", "x", "-R", "momoshub/x"] }))).toContain("cannot write");
    expect(ran).toEqual([]);
  });

  test("a turn ticket writes as its role allows: the owner may comment, a pal may not", async () => {
    const { call, ran } = setup();
    expect((await call({ argv: write, bearer: "turn-owner" })).ok).toBe(true);
    expect(refused(await call({ argv: write, bearer: "turn-pal" }))).toContain("may not comment");
    expect(ran).toHaveLength(1);
  });

  test("a worker ticket writes only what it was minted with, and the repo is the ticket's", async () => {
    const { call, ran } = setup({ workerOk: (c) => c.action === "comment" && c.repo === "momoshub/x" });
    expect((await call({ argv: write, bearer: "jvwk_ticket" })).ok).toBe(true);
    expect(refused(await call({ argv: ["pr", "comment", "1", "--body", "x", "-R", "momoshub/other"], bearer: "jvwk_ticket" }))).toContain("does not grant comment");
    // a proxied review is a comment: the same grant, never an approval
    expect((await call({ argv: ["pr", "review", "1", "--comment", "-b", "x", "-R", "momoshub/x"], bearer: "jvwk_ticket" })).ok).toBe(true);
    expect(refused(await call({ argv: ["pr", "review", "1", "--approve", "-R", "momoshub/x"], bearer: "jvwk_ticket" }))).toContain("comment only");
    expect(ran).toHaveLength(2);
  });

  test("a worker ticket whose minter lost the worker-ticket grant stops working at once", async () => {
    const { call } = setup();
    people.UADMIN = user("UADMIN", "pal");
    try {
      expect(refused(await call({ argv: write, bearer: "jvwk_ticket" }))).toContain("worker-ticket grant");
    } finally {
      people.UADMIN = user("UADMIN", "admin");
    }
  });

  test("a merge is refused for every bearer, the owner's included", async () => {
    const { call, ran } = setup();
    for (const bearer of [session, "turn-owner", "jvwk_ticket"]) {
      expect(refused(await call({ argv: ["pr", "merge", "1", "-R", "momoshub/x"], bearer }))).toContain("merge-when-green");
    }
    expect(ran).toEqual([]);
  });
});

describe("exec proxy: orca", () => {
  const withHandle = mintSession(SECRET, NOW / 1000 + 3600, "term_abc-1");

  test("a session messages and reads as ITS terminal (signed in), and cannot start, stop or resolve", async () => {
    const { call, ran } = setup();
    expect((await call({ tool: "orca", argv: ["orchestration", "check"], bearer: withHandle })).ok).toBe(true);
    expect(ran[0]?.env).toEqual({ ORCA_TERMINAL_HANDLE: "term_abc-1" });
    for (const verb of ["worker-start", "worker-stop", "gate-resolve", "task-update"]) {
      expect(refused(await call({ tool: "orca", argv: ["orchestration", verb, "--agent", "claude"], bearer: withHandle }))).toContain("tools:orca");
    }
    expect(ran).toHaveLength(1);
  });

  test("a session cannot list or read other agents' mail, runs or tasks", async () => {
    const { call, ran } = setup();
    for (const argv of [["inbox"], ["worker-read", "--dispatch", "ctx_1"], ["task-list", "--full"], ["dispatch-show", "--task", "t"], ["run-show"]]) {
      expect(refused(await call({ tool: "orca", argv: ["orchestration", ...argv], bearer: withHandle }))).toContain("tools:orca");
    }
    for (const flag of [["--run", "run_1"], ["--all"], ["--dispatch=ctx_1"], ["--task", "t"]]) {
      expect(refused(await call({ tool: "orca", argv: ["orchestration", "check", ...flag], bearer: withHandle }))).toContain("own mailbox");
    }
    expect(refused(await call({ tool: "orca", argv: ["status"], bearer: withHandle }))).toContain("tools:orca");
    expect(ran).toEqual([]);
  });

  test("the handle in the request is ignored for a session: it cannot read another terminal's mail", async () => {
    const { call, ran } = setup();
    await call({ tool: "orca", argv: ["orchestration", "check"], bearer: withHandle, handle: "term_victim" });
    expect(ran[0]?.env).toEqual({ ORCA_TERMINAL_HANDLE: "term_abc-1" });
    expect(refused(await call({ tool: "orca", argv: ["orchestration", "check", "--terminal", "term_victim"], bearer: withHandle }))).toContain("own Orca terminal");
    expect(refused(await call({ tool: "orca", argv: ["orchestration", "send", "--from=term_victim", "--to", "x"], bearer: withHandle }))).toContain("own Orca terminal");
    expect((await call({ tool: "orca", argv: ["orchestration", "check", "--terminal", "term_abc-1"], bearer: withHandle })).ok).toBe(true);
  });

  test("a session minted without a terminal has no Orca mailbox to use", async () => {
    const { call } = setup();
    expect(refused(await call({ tool: "orca", argv: ["orchestration", "check"] }))).toContain("no Orca terminal");
  });

  test("a turn names its own handle, may start workers, and may read a run's mailbox", async () => {
    const { call, ran } = setup();
    expect((await call({ tool: "orca", argv: ["orchestration", "worker-start", "--agent", "claude"], bearer: "turn-owner", handle: "term_bot" })).ok).toBe(true);
    expect(ran[0]?.env).toEqual({ ORCA_TERMINAL_HANDLE: "term_bot" });
    expect((await call({ tool: "orca", argv: ["orchestration", "inbox", "--terminal", "run:run_1"], bearer: "turn-owner", handle: "term_bot" })).ok).toBe(true);
    expect(refused(await call({ tool: "orca", argv: ["orchestration", "inbox", "--terminal", "run:run_1"], bearer: withHandle }))).toContain("tools:orca");
  });

  test("a handle that is not a handle is not passed on", async () => {
    const { call, ran } = setup();
    await call({ tool: "orca", argv: ["orchestration", "check"], bearer: "turn-owner", handle: "term_x; rm -rf /" });
    expect(ran[0]?.env).toEqual({});
  });

  test("a turn uses orca only when its role holds tools:orca; a worker ticket is not an orca credential", async () => {
    const { call } = setup();
    expect((await call({ tool: "orca", argv: ["orchestration", "check"], bearer: "turn-owner" })).ok).toBe(true);
    expect(refused(await call({ tool: "orca", argv: ["orchestration", "check"], bearer: "turn-pal" }))).toContain("tools:orca");
    expect(refused(await call({ tool: "orca", argv: ["orchestration", "check"], bearer: "jvwk_ticket" }))).toContain("session");
  });

  test("terminals, and a worker put on an existing terminal, are refused with the reason", async () => {
    const { call, ran } = setup();
    expect(refused(await call({ tool: "orca", argv: ["terminal", "send", "--terminal", "t", "--text", "id"] }))).toContain("outside");
    expect(refused(await call({ tool: "orca", argv: ["orchestration", "worker-start", "--spec", "x", "--agent", "claude", "--terminal", "term_1"] }))).toContain("existing terminal");
    expect(ran).toEqual([]);
  });
});

describe("exec proxy: bookkeeping", () => {
  test("every outcome is audited with the command and repo, never the text; a session is its own actor", async () => {
    const { call, audit } = setup();
    await call({ argv: ["pr", "view", "1", "-R", "momoshub/x"] });
    await call({ argv: ["pr", "comment", "1", "--body", "very private words", "-R", "momoshub/x"] });
    await call({ argv: ["pr", "comment", "1", "--body", "very private words", "-R", "momoshub/x"], bearer: "turn-owner" });
    expect(audit.map((a) => [a.slackUserId, a.command, a.args, a.ok])).toEqual([
      ["sandbox-session", "proxy-gh", "pr view momoshub/x", true],
      ["sandbox-session", "proxy-gh", "pr comment momoshub/x", false],
      ["UOWNER", "proxy-gh", "pr comment momoshub/x", true],
    ]);
    expect(JSON.stringify(audit)).not.toContain("very private words");
  });

  test("a body file's content is passed as stdin, and a command that fails to run is a 502, not a crash", async () => {
    const { call, ran } = setup();
    await call({ argv: ["pr", "comment", "1", "--body-file", "-", "-R", "momoshub/x"], bearer: "turn-owner", stdin: "the body" });
    expect(ran[0]?.stdin).toBe("the body");
    const dead = createExecProxy({ ...({} as ExecProxyDeps), clock: () => NOW, sessionSecret: () => SECRET, peekTurn: () => undefined, redeemWorker: () => ({ ok: false, reason: "unknown", message: "x" }), users: { get: () => undefined }, roles, allowedOwners: ["momoshub"], audit: { add: () => {} }, run: async () => { throw new Error("spawn failed"); } });
    expect(await dead.handle({ bearer: session, tool: "gh", argv: ["pr", "view", "1", "-R", "momoshub/x"] })).toEqual({ ok: false, status: 502, error: "spawn failed" });
  });

  test("a bad request is a 400: argv must be strings and the tool gh or orca", async () => {
    const { call } = setup();
    expect(await call({ argv: [1 as unknown as string] })).toMatchObject({ ok: false, status: 400 });
    expect(await call({ tool: "bash" as "gh", argv: ["ls"] })).toMatchObject({ ok: false, status: 400 });
  });
});
