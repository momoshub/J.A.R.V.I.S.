import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_MCP_SCHEMA_CACHE_DIR, createClaudeJsonReader, stdioServersFor, type StdioServer } from "../llm/mcpConfig.ts";
import {
  MCP_CLI_HELP,
  firstLine,
  headOf,
  mcpCallRefusal,
  parseFields,
  payloadOf,
  projectFields,
  rowCountOf,
  searchTools,
  toolInfoOf,
  type CallPayload,
  type SearchHit,
  type ToolInfo,
} from "../../domain/mcpCodeMode.ts";
import { exposedTools } from "../../domain/mcpApproval.ts";
import { renderMcpTypes } from "../../domain/mcpTypes.ts";
import { DEFAULT_SANDBOX_LIMITS, positiveInt, secondsToMs } from "../../domain/mcpSandbox.ts";
import { runInSandbox, type ToolBridge } from "./sandbox.ts";
import { approvalsPath, createFileApprovalStore } from "./approvals.ts";
import { createFileSchemaCache, createLazyProxy, schemaCachePath, spawnStdioServer, type JsonRpc } from "./lazyProxy.ts";

/**
 * The `mcp` code-mode CLI (`bin/mcp.ts`), after Uber's MCP Gateway `list / search / call`: instead of loading a
 * server's tools into the model's context and pulling every result through it, the model asks for a tool from the
 * shell, the full result goes to a file, and only a path, a size and a short head come back. The servers, their
 * command and env are the bot's own (`~/.claude.json` through `stdioServersFor`), the tool lists come from the lazy
 * proxy's schema cache, and a call runs through the same proxy, so the owner's tool approvals apply here too.
 */

export type CliIo = {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly cwd: string;
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
  readonly now?: () => Date;
  /** The script piped to `mcp run -`. */
  readonly stdin?: () => Promise<string>;
  /** For the owner-ticket check; the global `fetch` when absent. */
  readonly fetchFn?: typeof fetch;
};

/**
 * A turn the owner started carries an owner ticket (`JARVIS_OWNER_TICKET`, `application/ownerTickets.ts`) and the URL to
 * redeem it at. Holding one is worth nothing until the bot says it is live, so an env copied out of a finished turn is dead.
 * Undefined when there is no ticket (a turn of another role, or the owner at a terminal) or it is live; otherwise the reason.
 */
export const ownerTicketRefusal = async (env: Readonly<Record<string, string | undefined>>, fetchFn: typeof fetch = fetch): Promise<string | undefined> => {
  const ticket = env.JARVIS_OWNER_TICKET;
  if (!ticket) return undefined;
  const url = env.JARVIS_OWNER_API_URL;
  if (!url) return "this turn holds an owner ticket but no URL to check it at";
  try {
    const res = await fetchFn(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ticket }), signal: AbortSignal.timeout(10_000) });
    return res.ok ? undefined : "this turn's owner ticket is no longer valid (the turn it belonged to has ended)";
  } catch {
    return "the bot could not be reached to check this turn's owner ticket";
  }
};

const DEFAULT_CALL_TIMEOUT_S = 120;

/** `--name value` pairs out of the argument list, and what is left. */
const splitFlags = (argv: readonly string[], names: readonly string[]): { flags: Record<string, string>; rest: string[] } => {
  const flags: Record<string, string> = {};
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--") && names.includes(a.slice(2))) {
      flags[a.slice(2)] = argv[i + 1] ?? "";
      i++;
    } else rest.push(a);
  }
  return { flags, rest };
};

type Loaded = { readonly name: string; readonly def: StdioServer; readonly tools: readonly ToolInfo[] | undefined; readonly hidden: number; readonly listed: readonly string[] };

/** A server's tools as a turn may see them: the cached list minus what the owner has not approved. */
const loadServer = (cacheDir: string, name: string, def: StdioServer): Loaded => {
  const cached = createFileSchemaCache(schemaCachePath(cacheDir, name, [def.command, ...def.args])).read();
  if (!cached) return { name, def, tools: undefined, hidden: 0, listed: [] };
  const state = createFileApprovalStore(approvalsPath(cacheDir, name)).read();
  // No baseline yet: the proxy takes the cached list as it is on its first run.
  const shown = state ? exposedTools(state, cached.tools) : cached.tools;
  return { name, def, tools: shown.flatMap((t) => toolInfoOf(t) ?? []), hidden: cached.tools.length - shown.length, listed: cached.tools.flatMap((t) => toolInfoOf(t)?.name ?? []) };
};

type ToolReply = { ok: true; result: unknown } | { ok: false; error: string };

/**
 * One server's lazy proxy, started on the first call and kept for as many calls as the caller makes (`mcp run` makes
 * many; `mcp call` one). The command and env are what the bot launches the server with: the turn's environment under the server's own `env`.
 */
const openServer = (
  cacheDir: string,
  server: Loaded,
  env: Readonly<Record<string, string | undefined>>,
  timeoutMs: number,
  log: (line: string) => void,
): { call: (tool: string, args: unknown) => Promise<ToolReply>; close: () => void } => {
  const { name, def } = server;
  const command = [def.command, ...def.args];
  const waiting = new Map<number, (m: JsonRpc) => void>();
  let nextId = 2;
  const proxy = createLazyProxy({
    cache: createFileSchemaCache(schemaCachePath(cacheDir, name, command)),
    approvals: createFileApprovalStore(approvalsPath(cacheDir, name)),
    server: name,
    spawn: () => spawnStdioServer(command, { ...env, ...def.env }),
    out: (m) => {
      const id = typeof m.id === "number" ? m.id : undefined;
      if (id !== undefined) waiting.get(id)?.(m);
    },
    log: (line) => log(`[${name}] ${line}`),
  });
  let started: Promise<void> | undefined;
  const start = (): Promise<void> =>
    (started ??= (async () => {
      await proxy.handle({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "jarvis-mcp-cli", version: "1" } },
      });
      await proxy.handle({ jsonrpc: "2.0", method: "notifications/initialized" });
    })());
  return {
    call: async (tool, args) => {
      await start();
      const id = nextId++;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const answer = new Promise<JsonRpc>((resolve) => {
        waiting.set(id, resolve);
        timer = setTimeout(() => resolve({ jsonrpc: "2.0", id, error: { code: -32001, message: `no answer within ${timeoutMs / 1000}s` } }), timeoutMs);
      });
      try {
        void proxy.handle({ jsonrpc: "2.0", id, method: "tools/call", params: { name: tool, arguments: args } });
        const reply = await answer;
        if (reply.error && typeof reply.error === "object") return { ok: false, error: String((reply.error as { message?: unknown }).message ?? "the call failed") };
        return { ok: true, result: reply.result };
      } finally {
        clearTimeout(timer);
        waiting.delete(id);
      }
    },
    close: () => proxy.close(),
  };
};

/**
 * The one gate every tool call passes, from `mcp call` and from each call a `mcp run` script bridges: the turn's role
 * (`BOT_MCP_ACCESS`, `BOT_MCP_DENY`), a live owner ticket, and a tool the cache lists. Approval gating happens in the proxy
 * the call then goes through. Undefined when the call may go ahead, else why it may not.
 */
const callRefusal = async (io: CliIo, server: Loaded, tool: string): Promise<string | undefined> => {
  const refusal = mcpCallRefusal(io.env, server.name, tool) ?? (await ownerTicketRefusal(io.env, io.fetchFn));
  if (refusal) return `refused: ${refusal}`;
  // A tool the cache lists but the owner has not approved is refused by the proxy; one it does not list at all is a typo.
  if (server.tools && !server.listed.includes(tool)) return `"${server.name}" lists no tool "${tool}" (\`mcp search\` finds one)`;
  return undefined;
};

const stamp = (d: Date): string => d.toISOString().replace(/[-:]/g, "").replace(/\..*/, "").replace("T", "-");

/** The 0600 file in the 0700 out dir (default `$TMPDIR/jarvis-mcp-out`) every `call` and `run` result goes to. */
const writeOutput = (outDir: string | undefined, label: string, ext: string, text: string, now: (() => Date) | undefined): string => {
  const dir = outDir || join(tmpdir(), "jarvis-mcp-out");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, `${label}-${stamp((now ?? (() => new Date()))())}-${Math.random().toString(36).slice(2, 6)}.${ext}`.replace(/[^A-Za-z0-9_.-]/g, "_"));
  writeFileSync(file, text, { mode: 0o600 });
  return file;
};

const render = (payload: CallPayload): { text: string; ext: string } =>
  payload.kind === "text" ? { text: payload.text, ext: "txt" } : { text: JSON.stringify(payload.value, null, 1), ext: "json" };

export const runMcpCli = async (argv: readonly string[], io: CliIo): Promise<number> => {
  const { flags, rest } = splitFlags(argv, ["claude-json", "cache-dir", "fields", "out", "timeout", "max-calls", "memory"]);
  const [command, ...args] = rest;
  if (!command || command === "help" || command === "--help" || command === "-h") {
    io.out(MCP_CLI_HELP);
    return command ? 0 : 2;
  }
  const cacheDir = flags["cache-dir"] || DEFAULT_MCP_SCHEMA_CACHE_DIR;
  const read = createClaudeJsonReader(flags["claude-json"] || undefined);
  const { stdio, other } = stdioServersFor(read(), io.cwd);
  const servers = Object.entries(stdio).map(([name, def]) => loadServer(cacheDir, name, def));
  const fail = (line: string): number => {
    io.err(`mcp: ${line}`);
    return 1;
  };

  if (command === "list") {
    if (servers.length === 0 && other.length === 0) return fail("no MCP servers are configured");
    for (const s of servers) {
      io.out(
        s.tools
          ? `${s.name}  ${s.tools.length} tool${s.tools.length === 1 ? "" : "s"}${s.hidden ? `  (${s.hidden} waiting for the owner's approval)` : ""}`
          : `${s.name}  no schema cache yet (a call starts it and fills the cache)`,
      );
    }
    for (const name of other) io.out(`${name}  not reachable from the shell (http/sse server, only the CLI can connect to it)`);
    return 0;
  }

  if (command === "search") {
    const query = args.join(" ").trim();
    if (!query) return fail("usage: mcp search <query>");
    const index: SearchHit[] = servers.flatMap((s) => (s.tools ?? []).map((tool) => ({ server: s.name, tool })));
    const hits = searchTools(index, query);
    if (hits.length === 0) return fail(`nothing matches "${query}" (${index.length} tools searched; a server with no schema cache is not searched)`);
    for (const h of hits) io.out(`${h.server} ${h.tool.name}  ${firstLine(h.tool.description)}`);
    return 0;
  }

  if (command === "types") {
    const wanted = args.length > 0 ? args : servers.map((s) => s.name);
    const unknown = wanted.filter((n) => !servers.some((s) => s.name === n));
    if (unknown.length > 0) return fail(`unknown server "${unknown[0]}". \`mcp list\` shows the ones this host has.`);
    // What a script may call: the approved tools, minus what the turn's role is denied (the same check each bridged call makes).
    const usable = servers
      .filter((s) => wanted.includes(s.name))
      .map((s) => ({ name: s.name, tools: (s.tools ?? []).filter((t) => mcpCallRefusal(io.env, s.name, t.name) === undefined) }));
    const noCache = servers.filter((s) => wanted.includes(s.name) && !s.tools).map((s) => s.name);
    if (noCache.length > 0) io.err(`mcp: no schema cache yet for ${noCache.join(", ")} (one \`mcp call\` fills it), so they have no types`);
    if (usable.every((s) => s.tools.length === 0)) return fail("no tools to describe");
    io.out(renderMcpTypes(usable));
    return 0;
  }

  if (command === "run") {
    const [source] = args;
    if (!source) return fail("usage: mcp run <file.ts | -> [--timeout <seconds>] [--out <dir>]");
    const timeoutMs = secondsToMs(flags.timeout, DEFAULT_SANDBOX_LIMITS.timeoutMs);
    const maxCalls = positiveInt(flags["max-calls"], DEFAULT_SANDBOX_LIMITS.maxCalls);
    const memoryMb = positiveInt(flags.memory, DEFAULT_SANDBOX_LIMITS.memoryBytes / (1024 * 1024));
    if (timeoutMs === undefined) return fail("--timeout is a number of seconds");
    if (maxCalls === undefined) return fail("--max-calls is a whole number");
    if (memoryMb === undefined) return fail("--memory is a number of megabytes");
    // A script needs the same standing as `call` has, before anything of it runs; each bridged call is gated again.
    const early = mcpCallRefusal(io.env, "", "") ?? (await ownerTicketRefusal(io.env, io.fetchFn));
    if (early) return fail(`refused: ${early}`);
    let source_text: string;
    try {
      source_text = source === "-" ? (io.stdin ? await io.stdin() : "") : readFileSync(source.startsWith("/") ? source : join(io.cwd, source), "utf8");
    } catch (e) {
      return fail(`cannot read ${source}: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!source_text.trim()) return fail("the script is empty");
    let js: string;
    try {
      js = new Bun.Transpiler({ loader: "ts", target: "bun", trimUnusedImports: false }).transformSync(source_text);
    } catch (e) {
      return fail(`the script does not compile: ${e instanceof Error ? e.message : String(e)}`);
    }

    const sessions = new Map<string, ReturnType<typeof openServer>>();
    const bridge: ToolBridge = async (serverName, toolName, toolArgs) => {
      const server = servers.find((s) => s.name === serverName);
      if (!server) return { ok: false, error: `unknown server "${serverName}" (\`mcp list\` shows the ones this host has)` };
      const refusal = await callRefusal(io, server, toolName);
      if (refusal) return { ok: false, error: refusal };
      let session = sessions.get(serverName);
      if (!session) sessions.set(serverName, (session = openServer(cacheDir, server, io.env, DEFAULT_CALL_TIMEOUT_S * 1000, (line) => io.err(line))));
      const reply = await session.call(toolName, toolArgs);
      if (!reply.ok) return reply;
      const payload = payloadOf(reply.result);
      const value = payload.kind === "text" ? payload.text : payload.value;
      if ((reply.result as { isError?: unknown } | undefined)?.isError === true) return { ok: false, error: typeof value === "string" ? value : JSON.stringify(value) };
      return { ok: true, value };
    };
    const limits = { ...DEFAULT_SANDBOX_LIMITS, timeoutMs, maxCalls, memoryBytes: memoryMb * 1024 * 1024 };
    const outcome = await runInSandbox(js, limits, bridge).finally(() => sessions.forEach((s) => s.close()));

    const logText = outcome.logs;
    const text = `${outcome.ok && outcome.value !== undefined ? `${outcome.value}\n` : ""}${logText ? `--- console ---\n${logText}` : ""}`;
    const file = text ? writeOutput(flags.out, "run", outcome.ok && outcome.value !== undefined && !logText ? "json" : "txt", text, io.now) : undefined;
    if (!outcome.ok) {
      if (file) io.out(`output so far: ${file}`);
      // The transpiler drops types and blank lines, so the line is the compiled script's; its text says where that is.
      const at = outcome.line ? js.split("\n")[outcome.line - 1]?.trim().slice(0, 120) : undefined;
      return fail(`the script failed${outcome.line ? ` at line ${outcome.line} of the compiled script${at ? ` (\`${at}\`)` : ""}` : ""}: ${outcome.error}`);
    }
    io.out(file ? `result: ${file}` : "result: (the script printed nothing and returned nothing)");
    io.out(`size: ${Buffer.byteLength(text)} bytes, ${outcome.calls} tool call${outcome.calls === 1 ? "" : "s"}`);
    if (text) io.out(`head: ${text.replace(/\s+/g, " ").trim().slice(0, 600)}`);
    return 0;
  }

  if (command === "schema" || command === "call") {
    const [serverName, toolName, argText] = args;
    if (!serverName || !toolName) return fail(command === "schema" ? "usage: mcp schema <server> <tool>" : "usage: mcp call <server> <tool> '<json args>' [--fields a,b.c]");
    const server = servers.find((s) => s.name === serverName);
    if (!server) return fail(`unknown server "${serverName}". \`mcp list\` shows the ones this host has.`);
    if (command === "schema") {
      const tool = server.tools?.find((t) => t.name === toolName);
      if (!tool) return fail(server.tools ? `"${serverName}" lists no tool "${toolName}" for you (\`mcp search\` finds one)` : `"${serverName}" has no schema cache yet`);
      io.out(JSON.stringify(tool.inputSchema ?? {}, null, 2));
      return 0;
    }

    // The turn's role: refuse here what the turn's own --disallowedTools would refuse.
    const refusal = await callRefusal(io, server, toolName);
    if (refusal) return fail(refusal);
    let callArgs: unknown = {};
    if (argText) {
      try {
        callArgs = JSON.parse(argText);
      } catch {
        return fail("the arguments must be one JSON object, e.g. '{\"sql\":\"select 1\"}'");
      }
      if (!callArgs || typeof callArgs !== "object" || Array.isArray(callArgs)) return fail("the arguments must be one JSON object");
    }
    const fields = flags.fields ? parseFields(flags.fields) : [];
    const seconds = Number(flags.timeout ?? DEFAULT_CALL_TIMEOUT_S);
    if (!Number.isFinite(seconds) || seconds <= 0) return fail("--timeout is a number of seconds");

    const opened = openServer(cacheDir, server, io.env, seconds * 1000, (line) => io.err(line));
    const called = await opened.call(toolName, callArgs).finally(opened.close);
    if (!called.ok) return fail(called.error);
    const result = called.result as { isError?: unknown } | undefined;
    const isError = result?.isError === true;
    const whole = payloadOf(called.result);
    // Projection only means something for JSON; a text or raw result is written whole.
    const payload: CallPayload = fields.length > 0 && whole.kind === "json" ? { kind: "json", value: projectFields(whole.value, fields) } : whole;
    const note = fields.length > 0 && whole.kind !== "json" ? "  (--fields ignored: the result is not JSON)" : "";

    const { text, ext } = render(payload);
    const file = writeOutput(flags.out, `${serverName}-${toolName}`, ext, text, io.now);

    const rows = payload.kind === "json" ? rowCountOf(payload.value) : undefined;
    io.out(`${isError ? "the tool reported an error; " : ""}result: ${file}`);
    io.out(`size: ${Buffer.byteLength(text)} bytes${rows ? `, ${rows.rows} rows${rows.where ? ` (${rows.where})` : ""}` : ""}${fields.length > 0 ? `, projected to ${fields.join(",")}` : ""}${note}`);
    io.out(`head: ${headOf(payload)}`);
    return isError ? 1 : 0;
  }

  return fail(`unknown command "${command}". ${MCP_CLI_HELP.split("\n")[0]}`);
};
