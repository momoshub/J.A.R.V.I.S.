import { describe, expect, test } from "bun:test";
import { DEFAULT_SANDBOX_LIMITS, type SandboxLimits } from "../../src/domain/mcpSandbox.ts";
import { runInSandbox, type ToolBridge } from "../../src/infrastructure/mcp/sandbox.ts";

const limits = (over: Partial<SandboxLimits> = {}): SandboxLimits => ({ ...DEFAULT_SANDBOX_LIMITS, timeoutMs: 5_000, ...over });
const none: ToolBridge = async () => ({ ok: false, error: "no tools here" });
const run = (code: string, over: Partial<SandboxLimits> = {}, bridge: ToolBridge = none) => runInSandbox(code, limits(over), bridge);

describe("the isolate has no ambient authority", () => {
  test("no fetch, require, import of node modules, process, Bun, timers or env", async () => {
    const r = await run(`console.log([typeof fetch, typeof require, typeof process, typeof Bun, typeof setTimeout, typeof XMLHttpRequest, typeof WebSocket, typeof Deno].join(","));`);
    expect(r.logs.trim()).toBe("undefined,undefined,undefined,undefined,undefined,undefined,undefined,undefined");
  });

  test("calling them is a ReferenceError, and a dynamic import of a node module fails", async () => {
    for (const code of ["fetch('http://127.0.0.1:1')", "require('fs')", "process.env.HOME", "Bun.file('/etc/passwd')"]) {
      const r = await run(code);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain("ReferenceError");
    }
    const imp = await run(`await import("node:fs");`);
    expect(imp.ok).toBe(false);
  });

  test("the host bridge functions are not left on the global object", async () => {
    const r = await run(`console.log(typeof __hostCall, typeof __hostLog);`);
    expect(r.logs.trim()).toBe("undefined undefined");
  });
});

describe("limits", () => {
  test("a wall-clock timeout kills an infinite loop", async () => {
    const started = Date.now();
    const r = await run(`while (true) {}`, { timeoutMs: 300 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("ran out of time");
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  test("a timeout also stops a script waiting on a slow host call", async () => {
    const slow: ToolBridge = () => new Promise(() => {});
    const r = await run(`await mcp.a.b({});`, { timeoutMs: 300 }, slow);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("ran out of time");
  });

  test("the heap is capped", async () => {
    const r = await run(`const keep = []; while (true) keep.push("x".repeat(1_000_000) + keep.length);`, { memoryBytes: 8 * 1024 * 1024, timeoutMs: 10_000 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.toLowerCase()).toMatch(/memory|out of/);
  });

  test("the number of tool calls is capped, and the host is not asked past it", async () => {
    let asked = 0;
    const bridge: ToolBridge = async () => ((asked += 1), { ok: true, value: 1 });
    const r = await run(`for (let i = 0; i < 10; i++) await mcp.a.b({});`, { maxCalls: 3 }, bridge);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("call limit reached (3");
    expect(asked).toBe(3);
  });

  test("console output is capped", async () => {
    const r = await run(`for (let i = 0; i < 1000; i++) console.log("line".repeat(10));`, { maxLogBytes: 500 });
    expect(r.ok).toBe(true);
    expect(r.logs.length).toBeLessThan(700);
    expect(r.logs).toContain("[output truncated at 500 bytes]");
  });

  test("an oversized final value is refused", async () => {
    const r = await run(`export default "x".repeat(10_000);`, { maxResultBytes: 100 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("larger than 100 bytes");
  });
});

describe("running a script", () => {
  test("the default export, or what a default exported function returns, is the value; console.log is the log", async () => {
    const a = await run(`console.log("hi", {a: 1}); export default { n: 1 + 1 };`);
    expect(a).toMatchObject({ ok: true, value: '{"n":2}' });
    expect(a.logs).toBe('hi {"a":1}\n');
    const b = await run(`export default async function () { return [1, 2].map((x) => x * 2); }`);
    expect(b).toMatchObject({ ok: true, value: "[2,4]" });
    expect(await run(`console.log(1)`)).toMatchObject({ ok: true, value: undefined });
  });

  test("bridged calls chain, in parallel too, and an error from the host is a catchable exception", async () => {
    const bridge: ToolBridge = async (server, tool, args) =>
      tool === "fail" ? { ok: false, error: "nope" } : { ok: true, value: { server, tool, args } };
    const r = await run(
      `const [x, y] = await Promise.all([mcp.db.q({ n: 1 }), mcp["my-db"].q2()]);
       let caught = "";
       try { await mcp.db.fail({}); } catch (e) { caught = e.message; }
       export default { x, y, caught };`,
      {},
      bridge,
    );
    expect(r).toMatchObject({ ok: true, calls: 3 });
    expect(JSON.parse(r.ok ? r.value! : "{}")).toEqual({
      x: { server: "db", tool: "q", args: { n: 1 } },
      y: { server: "my-db", tool: "q2", args: {} },
      caught: "nope",
    });
  });

  test("a throw comes back as an error with its line, a syntax error too, and neither crashes the host", async () => {
    const thrown = await run(`const a = 1;\nconst b = 2;\nthrow new Error("boom");`);
    expect(thrown).toMatchObject({ ok: false, line: 3 });
    if (!thrown.ok) expect(thrown.error).toBe("Error: boom");
    const syntax = await run(`const = ;`);
    expect(syntax.ok).toBe(false);
    const bad = await run(`await mcp.a.b("not an object");`);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toContain("one object of arguments");
  });

  test("a promise nothing settles is reported, not hung", async () => {
    const r = await run(`await new Promise(() => {});`);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("never finished");
  });
});
