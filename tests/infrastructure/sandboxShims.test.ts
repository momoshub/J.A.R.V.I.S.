import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SHIMS = join(import.meta.dir, "..", "..", "bin", "sandbox-shims");

type Seen = { path: string; body: Record<string, unknown> };
let server: ReturnType<typeof Bun.serve>;
let seen: Seen[] = [];
let answer: (path: string, body: Record<string, unknown>) => unknown = () => ({ ok: true, code: 0, stdout: "", stderr: "" });
const dirs: string[] = [];

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (req) => {
      const body = (await req.json()) as Record<string, unknown>;
      const path = new URL(req.url).pathname;
      seen.push({ path, body });
      const out = answer(path, body);
      return Response.json(out, { status: (out as { ok?: boolean }).ok === false ? 403 : 200 });
    },
  });
});
afterAll(() => {
  server.stop(true);
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), "shim-test-"));
  dirs.push(d);
  return d;
};

const run = async (shim: string, args: string[], env: Record<string, string> = {}, opts: { cwd?: string; stdin?: string } = {}) => {
  seen = [];
  const proc = Bun.spawn({
    cmd: [join(SHIMS, shim), ...args],
    cwd: opts.cwd ?? tmp(),
    env: { PATH: process.env.PATH ?? "", HOME: tmp(), JARVIS_PROXY_URL: `http://127.0.0.1:${server.port}`, ...env },
    stdin: opts.stdin !== undefined ? Buffer.from(opts.stdin) : "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { stdout, stderr, code };
};

const gitClone = (origin: string): string => {
  const d = tmp();
  Bun.spawnSync({ cmd: ["git", "init", "-q", d] });
  Bun.spawnSync({ cmd: ["git", "-C", d, "remote", "add", "origin", origin] });
  return d;
};

describe("gh shim", () => {
  test("sends the command line, the session as the bearer and the clone's repo, and relays output and exit code", async () => {
    answer = () => ({ ok: true, code: 4, stdout: "title\n", stderr: "warn\n" });
    const cwd = gitClone("git@github.com:momoshub/J.A.R.V.I.S..git");
    const r = await run("gh", ["pr", "view", "12", "--json", "title"], { JARVIS_PROXY_SESSION: "jvsb_session" }, { cwd });
    expect(r).toEqual({ stdout: "title\n", stderr: "warn\n", code: 4 });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.path).toBe("/api/proxy/exec");
    expect(seen[0]?.body).toEqual({ tool: "gh", bearer: "jvsb_session", argv: ["pr", "view", "12", "--json", "title"], repoHint: "momoshub/J.A.R.V.I.S." });
  });

  test("a ticket beats the session: the turn's, else the worker's file", async () => {
    answer = () => ({ ok: true, code: 0, stdout: "", stderr: "" });
    const dir = tmp();
    const file = join(dir, "ticket");
    writeFileSync(file, "jvwk_fromfile\nhttp://127.0.0.1:1\n");
    await run("gh", ["pr", "list", "-R", "o/r"], { JARVIS_PROXY_SESSION: "jvsb_s", JARVIS_RUN_TICKET_FILE: file });
    expect(seen[0]?.body.bearer).toBe("jvwk_fromfile");
    await run("gh", ["pr", "list", "-R", "o/r"], { JARVIS_PROXY_SESSION: "jvsb_s", JARVIS_RUN_TICKET_FILE: file, JARVIS_RUN_TICKET: "turnticket" });
    expect(seen[0]?.body.bearer).toBe("turnticket");
  });

  test("a body file is read here and sent as stdin: the proxy never gets a path", async () => {
    const dir = tmp();
    writeFileSync(join(dir, "body.md"), "line one\nline two\n");
    await run("gh", ["pr", "comment", "3", "-F", join(dir, "body.md"), "-R", "o/r"], { JARVIS_PROXY_SESSION: "s" });
    expect(seen[0]?.body.argv).toEqual(["pr", "comment", "3", "-F", "-", "-R", "o/r"]);
    expect(seen[0]?.body.stdin).toBe("line one\nline two\n");
    await run("gh", ["pr", "comment", "3", `--body-file=${join(dir, "body.md")}`, "-R", "o/r"], { JARVIS_PROXY_SESSION: "s" });
    expect(seen[0]?.body.argv).toEqual(["pr", "comment", "3", "--body-file", "-", "-R", "o/r"]);
    await run("gh", ["pr", "comment", "3", "--body-file", "-", "-R", "o/r"], { JARVIS_PROXY_SESSION: "s" }, { stdin: "from stdin" });
    expect(seen[0]?.body.stdin).toBe("from stdin");
  });

  test("a refusal is printed with its reason and exits 1", async () => {
    answer = () => ({ ok: false, error: "a bare session cannot write to GitHub (comment)" });
    const r = await run("gh", ["pr", "comment", "1", "--body", "x", "-R", "o/r"], { JARVIS_PROXY_SESSION: "s" });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("gh: a bare session cannot write to GitHub (comment)");
  });

  test("outside the sandbox (no proxy url) it says so and exits 3, sending nothing", async () => {
    seen = [];
    const proc = Bun.spawn({ cmd: [join(SHIMS, "gh"), "pr", "view", "1"], env: { PATH: process.env.PATH ?? "", HOME: tmp() }, stdout: "pipe", stderr: "pipe" });
    const [err, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    expect(code).toBe(3);
    expect(err).toContain("not inside the sandbox");
    expect(seen).toEqual([]);
  });

  test("a bot that is not listening is a clear error, not a hang", async () => {
    const r = await run("gh", ["pr", "view", "1", "-R", "o/r"], { JARVIS_PROXY_SESSION: "s", JARVIS_PROXY_URL: "http://127.0.0.1:9" });
    expect(r.code).toBe(3);
    expect(r.stderr).toContain("did not answer");
  });
});

describe("orca shim", () => {
  test("the session is the bearer, the ticket file is not used, and the caller's terminal handle rides along", async () => {
    answer = () => ({ ok: true, code: 0, stdout: "No messages.\n", stderr: "" });
    const file = join(tmp(), "ticket");
    writeFileSync(file, "jvwk_worker\n");
    const r = await run("orca", ["orchestration", "check"], { JARVIS_PROXY_SESSION: "jvsb_s", JARVIS_RUN_TICKET_FILE: file, ORCA_TERMINAL_HANDLE: "term_abc" });
    expect(r.stdout).toBe("No messages.\n");
    expect(seen[0]?.body).toEqual({ tool: "orca", bearer: "jvsb_s", argv: ["orchestration", "check"], handle: "term_abc" });
  });

  test("a turn's ticket is its orca credential, so the bot can check the role", async () => {
    await run("orca", ["orchestration", "check"], { JARVIS_PROXY_SESSION: "jvsb_s", JARVIS_RUN_TICKET: "turnticket" });
    expect(seen[0]?.body.bearer).toBe("turnticket");
  });

  test("a spec file is read here and sent as stdin", async () => {
    const dir = tmp();
    writeFileSync(join(dir, "brief.md"), "do the thing");
    await run("orca", ["orchestration", "worker-start", "--spec-file", join(dir, "brief.md"), "--agent", "claude"], { JARVIS_PROXY_SESSION: "s" });
    expect(seen[0]?.body.argv).toEqual(["orchestration", "worker-start", "--spec-file", "-", "--agent", "claude"]);
    expect(seen[0]?.body.stdin).toBe("do the thing");
  });

  test("with no arguments it still sends an (empty) command and does not trip on bash 3.2's empty arrays", async () => {
    answer = () => ({ ok: false, error: "inside the sandbox orca only does orchestration" });
    const r = await run("orca", [], { JARVIS_PROXY_SESSION: "s" });
    expect(r.code).toBe(1);
    expect(seen[0]?.body.argv).toEqual([]);
  });
});

describe("git credential helper", () => {
  const ask = (input: string, env: Record<string, string>, cwd?: string) => run("git-credential-jarvis", ["get"], env, { stdin: input, ...(cwd ? { cwd } : {}) });

  test("asks the bot's ticket-checked git-auth for the repo in the url path and prints a token", async () => {
    answer = () => ({ ok: true, github: { token: "ghs_scoped", name: "jarvis[bot]", email: "1+jarvis[bot]@users.noreply.github.com" } });
    const r = await ask("protocol=https\nhost=github.com\npath=momoshub/J.A.R.V.I.S..git\n\n", { JARVIS_RUN_TICKET: "jvwk_t" });
    expect(r.stdout).toBe("username=x-access-token\npassword=ghs_scoped\n");
    expect(seen[0]?.path).toBe("/api/github-app/action");
    expect(seen[0]?.body).toEqual({ action: "git-auth", repo: "momoshub/J.A.R.V.I.S.", purpose: "push", ticket: "jvwk_t" });
  });

  test("with no path it uses the clone's origin; with an empty token (identity only) or no ticket it prints nothing", async () => {
    answer = () => ({ ok: true, github: { token: "", name: "jarvis[bot]", email: "e" } });
    const cwd = gitClone("https://github.com/momoshub/x.git");
    const empty = await ask("protocol=https\nhost=github.com\n\n", { JARVIS_RUN_TICKET: "jvwk_t" }, cwd);
    expect(empty.stdout).toBe("");
    expect((seen[0]?.body as { repo: string }).repo).toBe("momoshub/x");
    seen = [];
    expect((await ask("protocol=https\nhost=github.com\npath=o/r\n\n", {})).stdout).toBe("");
    expect(seen).toEqual([]);
  });

  test("another host, or a store/erase call, is none of its business", async () => {
    answer = () => ({ ok: true, github: { token: "t" } });
    expect((await ask("protocol=https\nhost=example.com\npath=o/r\n\n", { JARVIS_RUN_TICKET: "t" })).stdout).toBe("");
    expect((await run("git-credential-jarvis", ["store"], { JARVIS_RUN_TICKET: "t" }, { stdin: "host=github.com\n" })).stdout).toBe("");
    expect(seen).toEqual([]);
  });
});

test("every shim is executable", () => {
  for (const f of ["gh", "orca", "git-credential-jarvis"]) chmodSync(join(SHIMS, f), 0o755);
  mkdirSync(tmp(), { recursive: true });
  expect(true).toBe(true);
});
