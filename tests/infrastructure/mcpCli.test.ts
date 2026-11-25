import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMcpCli } from "../../src/infrastructure/mcp/codeMode.ts";
import { approvalsPath, createFileApprovalStore } from "../../src/infrastructure/mcp/approvals.ts";
import { MCP_ACCESS_ENV, turnMcpEnv } from "../../src/domain/mcpCodeMode.ts";

const fake = join(import.meta.dir, "fixtures", "fakeDbMcpServer.ts");

let dir: string;
let claudeJson: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mcp-cli-"));
  claudeJson = join(dir, "claude.json");
  writeFileSync(
    claudeJson,
    JSON.stringify({
      mcpServers: {
        pg: { command: process.execPath, args: [fake], env: { FAKE_MCP_SECRET: "from-server-env" } },
        remote: { type: "http", url: "https://example.invalid/mcp" },
      },
    }),
  );
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const run = async (argv: string[], env: Record<string, string | undefined> = {}, fetchFn?: typeof fetch, stdin?: string) => {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runMcpCli([...argv, "--claude-json", claudeJson, "--cache-dir", join(dir, "cache"), "--out", join(dir, "out")], {
    env,
    cwd: dir,
    out: (l) => void out.push(l),
    err: (l) => void err.push(l),
    now: () => new Date("2026-11-18T10:00:00Z"),
    ...(stdin !== undefined ? { stdin: async () => stdin } : {}),
    ...(fetchFn ? { fetchFn } : {}),
  });
  return { code, out: out.join("\n"), err: err.join("\n") };
};
const resultFile = (out: string): string => /result: (\S+)/.exec(out)![1]!;

describe("mcp call", () => {
  test("writes the full result to a file and prints only path, size, rows and a head", async () => {
    const r = await run(["call", "pg", "run_query", '{"sql":"select 1"}']);
    expect(r.code).toBe(0);
    const file = resultFile(r.out);
    const written = JSON.parse(readFileSync(file, "utf8"));
    expect(written.sql).toBe("select 1");
    expect(written.rows).toHaveLength(5);
    // the server's own env from the config reached it
    expect(written.rows[0].secret).toBe("from-server-env");
    expect(r.out).toContain("5 rows (rows)");
    expect(r.out).toMatch(/size: \d+ bytes/);
    expect(r.out).toContain("head: ");
    expect(r.out).not.toContain("row5");
  });

  test("--fields keeps only those paths before the file is written", async () => {
    const r = await run(["call", "pg", "run_query", '{"sql":"select 1"}', "--fields", "rows.id,rows.name"]);
    expect(r.code).toBe(0);
    const written = JSON.parse(readFileSync(resultFile(r.out), "utf8"));
    expect(written).toEqual({ rows: [1, 2, 3, 4, 5].map((id) => ({ id, name: `row${id}` })) });
    expect(r.out).toContain("projected to rows.id,rows.name");
  });

  test("a tool that reports an error still leaves its output, and exits non-zero", async () => {
    const r = await run(["call", "pg", "boom"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("the tool reported an error");
    expect(readFileSync(resultFile(r.out), "utf8")).toBe("it broke");
  });

  test("bad arguments, unknown servers and unknown tools are refused without a spawn", async () => {
    expect((await run(["call", "pg", "run_query", "not json"])).err).toContain("one JSON object");
    expect((await run(["call", "nope", "x"])).err).toContain('unknown server "nope"');
    await run(["call", "pg", "run_query", "{}"]);
    expect((await run(["call", "pg", "no_such_tool", "{}"])).err).toContain('lists no tool "no_such_tool"');
  });
});

describe("mcp call respects the turn's role", () => {
  const full = (disallowedTools: string[]) => ({ ...turnMcpEnv({ skipPermissions: true, disallowedTools }) });

  test("a sandboxed turn cannot use it", async () => {
    const r = await run(["call", "pg", "run_query", "{}"], turnMcpEnv({ skipPermissions: false }));
    expect(r.code).toBe(1);
    expect(r.err).toContain("refused");
    expect(existsSync(join(dir, "out"))).toBe(false);
  });

  test("a server in the turn's disallowed tools is refused, not reachable around --disallowedTools", async () => {
    const r = await run(["call", "pg", "run_query", "{}"], full(["mcp__pg"]));
    expect(r.code).toBe(1);
    expect(r.err).toContain("may not use the `pg` MCP server");
    expect(existsSync(join(dir, "out"))).toBe(false);
  });

  test("a single disallowed tool is refused and the server's other tools are not", async () => {
    expect((await run(["call", "pg", "drop_table", "{}"], full(["mcp__pg__drop_table"]))).err).toContain("may not call `drop_table`");
    expect((await run(["call", "pg", "run_query", "{}"], full(["mcp__pg__drop_table"]))).code).toBe(0);
  });

  test("outside a turn there is no access marker and the owner's terminal works", async () => {
    expect(MCP_ACCESS_ENV in {}).toBe(false);
    expect((await run(["call", "pg", "run_query", "{}"])).code).toBe(0);
  });
});

describe("mcp call and the owner's tool approval", () => {
  test("a tool the owner has not approved cannot be called, even from the shell", async () => {
    await run(["call", "pg", "run_query", "{}"]); // first run: the baseline
    createFileApprovalStore(approvalsPath(join(dir, "cache"), "pg")).write({ approved: ["run_query"], denied: [] });
    const r = await run(["call", "pg", "drop_table", "{}"]);
    expect(r.code).toBe(1);
    expect(r.out + r.err).toContain("mcp-tools approve pg drop_table");
    expect((await run(["call", "pg", "run_query", "{}"])).code).toBe(0);
  });
});

describe("mcp list / search / schema (from the cache, no server)", () => {
  test("before any call there is no cache to read", async () => {
    const r = await run(["list"]);
    expect(r.out).toContain("pg  no schema cache yet");
    expect(r.out).toContain("remote  not reachable from the shell");
  });

  test("after a call: tool counts, search and schema, with unapproved tools left out", async () => {
    await run(["call", "pg", "run_query", "{}"]);
    // wait for the background cache refresh the first spawn does
    for (let i = 0; i < 50 && !(await run(["list"])).out.includes("pg  3 tools"); i++) await new Promise((r) => setTimeout(r, 50));
    expect((await run(["list"])).out).toContain("pg  3 tools");
    expect((await run(["search", "sql"])).out).toBe("pg run_query  Run a SQL query and return rows");
    expect((await run(["search", "nothing-like-this"])).code).toBe(1);
    expect(JSON.parse((await run(["schema", "pg", "run_query"])).out)).toMatchObject({ properties: { sql: { type: "string" } } });

    createFileApprovalStore(approvalsPath(join(dir, "cache"), "pg")).write({ approved: ["run_query"], denied: [] });
    expect((await run(["list"])).out).toContain("pg  1 tool  (2 waiting for the owner's approval)");
    expect((await run(["search", "drop"])).code).toBe(1);
    expect((await run(["schema", "pg", "drop_table"])).err).toContain("lists no tool");
  });

  test("help and a missing command", async () => {
    expect((await run(["help"])).out).toContain("mcp call <server> <tool>");
    expect((await run([])).code).toBe(2);
    expect((await run(["frobnicate"])).err).toContain("unknown command");
  });
});

describe("mcp call and the owner ticket", () => {
  const owner = { ...turnMcpEnv({ skipPermissions: true }), JARVIS_OWNER_TICKET: "jvow_t", JARVIS_OWNER_API_URL: "http://127.0.0.1:1/api/owner-ticket" };
  const answering = (status: number): typeof fetch => (async (_url: unknown, init?: { body?: unknown }) => {
    expect(JSON.parse(String(init?.body))).toEqual({ ticket: "jvow_t" });
    return new Response("{}", { status });
  }) as unknown as typeof fetch;

  test("a live ticket lets the call through", async () => {
    expect((await run(["call", "pg", "run_query", "{}"], owner, answering(200))).code).toBe(0);
  });

  test("a dead ticket (the turn ended, or the env was copied out) is refused before anything runs", async () => {
    const r = await run(["call", "pg", "run_query", "{}"], owner, answering(403));
    expect(r.code).toBe(1);
    expect(r.err).toContain("owner ticket is no longer valid");
    expect(existsSync(join(dir, "out"))).toBe(false);
  });

  test("an unreachable bot, or a ticket with no URL, refuses too", async () => {
    const down = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    expect((await run(["call", "pg", "run_query", "{}"], owner, down)).err).toContain("could not be reached");
    expect((await run(["call", "pg", "run_query", "{}"], { ...owner, JARVIS_OWNER_API_URL: undefined })).err).toContain("no URL");
  });

  test("a turn without a ticket asks nobody", async () => {
    const never = (async () => {
      throw new Error("must not be called");
    }) as unknown as typeof fetch;
    expect((await run(["call", "pg", "run_query", "{}"], turnMcpEnv({ skipPermissions: true }), never)).code).toBe(0);
  });
});

/** Fill the schema cache the way a first call does, and wait for the proxy's background refresh to finish. */
const warmCache = async (): Promise<void> => {
  await run(["call", "pg", "run_query", "{}"]);
  for (let i = 0; i < 50 && !(await run(["list"])).out.includes("pg  3 tools"); i++) await new Promise((r) => setTimeout(r, 50));
};
const full = (disallowedTools: string[] = []) => turnMcpEnv({ skipPermissions: true, disallowedTools });

describe("mcp types", () => {
  test("declarations for the servers in the cache, nothing started", async () => {
    await warmCache();
    const r = await run(["types"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("declare const mcp: {");
    expect(r.out).toContain("pg: {");
    expect(r.out).toContain("run_query(args?: {");
    expect(r.out).toContain("sql?: string;");
    expect(r.out).toContain("Promise<unknown>");
    expect((await run(["types", "nope"])).err).toContain('unknown server "nope"');
    expect((await run(["types", "pg"])).code).toBe(0);
  });

  test("no cache yet: nothing to describe, and it says why", async () => {
    const r = await run(["types"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("no schema cache yet for pg");
  });

  test("tools the owner has not approved, and tools or servers the turn is denied, are not emitted", async () => {
    await warmCache();
    createFileApprovalStore(approvalsPath(join(dir, "cache"), "pg")).write({ approved: ["run_query", "boom"], denied: [] });
    const approved = await run(["types"]);
    expect(approved.out).toContain("run_query(");
    expect(approved.out).not.toContain("drop_table");
    const denied = await run(["types"], full(["mcp__pg__boom"]));
    expect(denied.out).toContain("run_query(");
    expect(denied.out).not.toContain("boom");
    expect((await run(["types"], full(["mcp__pg"]))).code).toBe(1);
  });
});

describe("mcp run", () => {
  const script = `
    type Rows = { rows: { id: number; name: string }[] };
    const first = (await mcp.pg.run_query({ sql: "select a" })) as Rows;
    const second = (await mcp.pg.run_query({ sql: "select b" })) as Rows;
    console.log("rows seen:", first.rows.length + second.rows.length);
    export default first.rows.filter((r) => r.id > 3).map((r) => r.name);
  `;

  test("chains two tool calls, filters, and writes value + logs to a file, printing only path, size and a head", async () => {
    const r = await run(["run", "-"], {}, undefined, script);
    expect(r.code).toBe(0);
    const written = readFileSync(resultFile(r.out), "utf8");
    expect(written.startsWith('["row4","row5"]\n')).toBe(true);
    expect(written).toContain("rows seen: 10");
    expect(r.out).toContain("2 tool calls");
    expect(r.out).toContain("head: ");
    // the rows the tools returned never reach the output, only what the script chose to keep
    expect(r.out).not.toContain("row1");
  });

  test("reads the script from a file too, and the server's own env reaches the server, not the script", async () => {
    const file = join(dir, "s.ts");
    writeFileSync(file, `const r = (await mcp.pg.run_query({})) as { rows: { secret: string }[] };\nexport default { secret: r.rows[0]!.secret, env: typeof process };`);
    const r = await run(["run", file]);
    expect(r.code).toBe(0);
    expect(JSON.parse(readFileSync(resultFile(r.out), "utf8").split("\n")[0]!)).toEqual({ secret: "from-server-env", env: "undefined" });
    expect(readFileSync(resultFile(r.out), "utf8")).not.toContain("secret\":\"\"");
  });

  test("the sandbox has no network, no env, no node modules", async () => {
    const r = await run(["run", "-"], {}, undefined, `console.log(typeof fetch, typeof process, typeof Bun);\ntry { require("node:fs"); } catch (e) { console.log((e as Error).name); }`);
    expect(r.code).toBe(0);
    // (`typeof require` is folded to "function" by the transpiler, so the call is what shows it is not there)
    expect(readFileSync(resultFile(r.out), "utf8")).toContain("undefined undefined undefined\nReferenceError");
  });

  test("a script error is a clear error with the line, not a crash; the output so far is kept", async () => {
    const r = await run(["run", "-"], {}, undefined, `console.log("before");\nthrow new Error("bad thing");`);
    expect(r.code).toBe(1);
    expect(r.err).toContain("the script failed at line 2");
    expect(r.err).toContain("bad thing");
    expect(readFileSync(/output so far: (\S+)/.exec(r.out)![1]!, "utf8")).toContain("before");
    expect((await run(["run", "-"], {}, undefined, "const = ;")).err).toContain("does not compile");
    expect((await run(["run", "-"], {}, undefined, "  ")).err).toContain("empty");
    expect((await run(["run", join(dir, "missing.ts")])).err).toContain("cannot read");
  });

  test("--timeout kills a runaway script; --max-calls caps tool calls; bad flags are refused", async () => {
    const loop = await run(["run", "-", "--timeout", "0.5"], {}, undefined, "while (true) {}");
    expect(loop.code).toBe(1);
    expect(loop.err).toContain("ran out of time");
    const calls = await run(["run", "-", "--max-calls", "1"], {}, undefined, `await mcp.pg.run_query({}); await mcp.pg.run_query({});`);
    expect(calls.err).toContain("call limit reached (1");
    expect((await run(["run", "-", "--timeout", "abc"], {}, undefined, "1")).err).toContain("--timeout");
    expect((await run(["run", "-", "--max-calls", "0"], {}, undefined, "1")).err).toContain("--max-calls");
  });

  test("a tool that reports an error throws inside the script and can be caught", async () => {
    const r = await run(["run", "-"], {}, undefined, `try { await mcp.pg.boom({}); } catch (e) { console.log("caught", (e as Error).message); }`);
    expect(r.code).toBe(0);
    expect(readFileSync(resultFile(r.out), "utf8")).toContain("caught it broke");
  });

  test("unknown servers and tools the cache does not list are errors inside the script, and start nothing", async () => {
    await warmCache();
    const r = await run(["run", "-"], {}, undefined, `await mcp.nope.x({});`);
    expect(r.err).toContain('unknown server "nope"');
    expect((await run(["run", "-"], {}, undefined, `await mcp.pg.no_such_tool({});`)).err).toContain('lists no tool "no_such_tool"');
  });
});

describe("mcp run keeps the role of `call`, per bridged call", () => {
  const callBoth = `
    const out: string[] = [];
    for (const tool of ["run_query", "drop_table"]) {
      try { await (mcp.pg as Record<string, (a: object) => Promise<unknown>>)[tool]!({}); out.push(tool + ": ok"); } catch (e) { out.push(tool + ": " + (e as Error).message); }
    }
    export default out;
  `;

  test("a sandboxed turn is refused before the script runs", async () => {
    const r = await run(["run", "-"], turnMcpEnv({ skipPermissions: false }), undefined, `console.log("ran")`);
    expect(r.code).toBe(1);
    expect(r.err).toContain("refused");
    expect(existsSync(join(dir, "out"))).toBe(false);
  });

  test("a server in the deny list is refused for every bridged call", async () => {
    const r = await run(["run", "-"], full(["mcp__pg"]), undefined, `try { await mcp.pg.run_query({}); } catch (e) { console.log((e as Error).message); }`);
    expect(readFileSync(resultFile(r.out), "utf8")).toContain("may not use the `pg` MCP server");
  });

  test("a single denied tool is refused and the server's other tools are not", async () => {
    const r = await run(["run", "-"], full(["mcp__pg__drop_*"]), undefined, callBoth);
    const text = readFileSync(resultFile(r.out), "utf8");
    expect(text).toContain("run_query: ok");
    expect(text).toContain("drop_table: refused: this turn may not call `drop_table`");
  });

  test("a tool the owner has not approved is refused by the proxy on its own call", async () => {
    await warmCache();
    createFileApprovalStore(approvalsPath(join(dir, "cache"), "pg")).write({ approved: ["run_query"], denied: [] });
    const r = await run(["run", "-"], full(), undefined, callBoth);
    const text = readFileSync(resultFile(r.out), "utf8");
    expect(text).toContain("run_query: ok");
    expect(text).toContain("mcp-tools approve pg drop_table");
  });

  test("a dead owner ticket stops the script, a live one is asked again for each bridged call", async () => {
    const owner = { ...full(), JARVIS_OWNER_TICKET: "jvow_t", JARVIS_OWNER_API_URL: "http://127.0.0.1:1/api/owner-ticket" };
    let asked = 0;
    const live = (async () => ((asked += 1), new Response("{}", { status: 200 }))) as unknown as typeof fetch;
    expect((await run(["run", "-"], owner, live, `await mcp.pg.run_query({}); await mcp.pg.run_query({});`)).code).toBe(0);
    // once before the script starts, then once per bridged call
    expect(asked).toBe(3);
    const dead = (async () => new Response("{}", { status: 403 })) as unknown as typeof fetch;
    const r = await run(["run", "-"], owner, dead, `console.log("ran")`);
    expect(r.err).toContain("owner ticket is no longer valid");
    expect(existsSync(join(dir, "out"))).toBe(false);
  });

  test("help lists the new commands", async () => {
    const help = (await run(["help"])).out;
    expect(help).toContain("mcp types");
    expect(help).toContain("mcp run");
  });
});
