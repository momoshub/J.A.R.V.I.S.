import { RELEASE_SYNC, newQuickJSWASMModule, newVariant, type QuickJSHandle } from "quickjs-emscripten";
import { HOST_CALL, HOST_LOG, SANDBOX_PRELUDE, SANDBOX_RESULT, appendCapped, wrapScript, type SandboxLimits } from "../../domain/mcpSandbox.ts";

/**
 * The isolate `mcp run` executes a model-written script in: QuickJS compiled to WebAssembly (`quickjs-emscripten`).
 * It is a separate JavaScript engine with its own heap, so a script has no ambient authority at all - no `fetch`,
 * `require`, `process`, `Bun`, timers, environment or file system exist in it, because nothing but the ECMAScript
 * builtins is put there. The only two doors out are host functions this module registers: one that bridges a tool
 * call (`mcp.<server>.<tool>(args)`, answered by `callTool`, which holds the credentials) and one that collects
 * `console` output. Bun has no permission model, so a child `bun` would not be a sandbox; this is.
 *
 * Limits enforced here: the heap (`setMemoryLimit`), the native stack, a wall-clock deadline (an interrupt handler
 * stops a busy loop, a timer stops a script waiting on the host), a cap on bridged calls, on console output and on the
 * size of the final value.
 */

export type SandboxOutcome =
  | { readonly ok: true; readonly value: string | undefined; readonly logs: string; readonly calls: number }
  | { readonly ok: false; readonly error: string; readonly line?: number; readonly logs: string; readonly calls: number };

export type ToolBridge = (server: string, tool: string, args: unknown) => Promise<{ readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: string }>;

/** What the engine itself needs on top of the script's heap. */
const WASM_BASE_BYTES = 24 * 1024 * 1024;
const WASM_PAGE = 65536;

type ErrorDump = { name?: string; message?: string; stack?: string };

/** Disposes a handle once, whoever else already has (a promise state hands back handles the promise may own). */
const drop = (h: QuickJSHandle): void => {
  if (h.alive) h.dispose();
};

const lineOf = (stack: string | undefined): number | undefined => {
  const m = /script\.js:(\d+)/.exec(stack ?? "");
  return m ? Number(m[1]) : undefined;
};

const describeError = (dump: unknown): { message: string; line?: number } => {
  if (dump && typeof dump === "object") {
    const e = dump as ErrorDump;
    const line = lineOf(e.stack);
    return { message: e.message ? `${e.name ?? "Error"}: ${e.message}` : (e.name ?? "Error"), ...(line ? { line } : {}) };
  }
  return { message: `the script threw ${JSON.stringify(dump)}` };
};

export const runInSandbox = async (code: string, limits: SandboxLimits, callTool: ToolBridge, now: () => number = Date.now): Promise<SandboxOutcome> => {
  // A WebAssembly module and linear memory of its own per run, with a hard ceiling: QuickJS's own heap limit does not
  // count every large allocation (a loop of big strings runs far past it), a ceiling on the memory itself does.
  const pages = Math.ceil((limits.memoryBytes + WASM_BASE_BYTES) / WASM_PAGE);
  const wasmMemory = new WebAssembly.Memory({ initial: Math.min(256, pages), maximum: pages });
  const QuickJS = await newQuickJSWASMModule(newVariant(RELEASE_SYNC, { wasmMemory }));
  const runtime = QuickJS.newRuntime();
  runtime.setMemoryLimit(limits.memoryBytes);
  runtime.setMaxStackSize(512 * 1024);
  const deadline = now() + limits.timeoutMs;
  let timedOut = false;
  runtime.setInterruptHandler(() => {
    if (now() > deadline) timedOut = true;
    return timedOut;
  });
  const context = runtime.newContext();
  const logs = { text: "", bytes: 0, truncated: false };
  let calls = 0;
  let aborted = false;
  const inflight = new Set<Promise<void>>();
  let wake: () => void = () => {};
  let woken = new Promise<void>((resolve) => (wake = resolve));

  const finish = (
    outcome: { ok: true; value: string | undefined } | { ok: false; error: string; line?: number },
  ): SandboxOutcome => ({ ...outcome, logs: logs.text, calls });
  let clean = false;
  const dispose = (): void => {
    aborted = true;
    // QuickJS asserts (and aborts the whole WebAssembly module) when a runtime that hit its memory limit, was interrupted
    // or still has a promise pending is freed. Those isolates are dropped instead: one `mcp run` is one process, which exits.
    if (!clean) return;
    try {
      context.dispose();
      runtime.dispose();
    } catch {
      // A runtime with a promise still pending can refuse to dispose cleanly; the process is about to move on either way.
    }
  };

  try {
    const logFn = context.newFunction(HOST_LOG, (line) => {
      appendCapped(logs, context.getString(line), limits.maxLogBytes);
    });
    context.setProp(context.global, HOST_LOG, logFn);
    logFn.dispose();

    const callFn = context.newFunction(HOST_CALL, (serverH, toolH, argsH) => {
      const promise = context.newPromise();
      const server = context.getString(serverH);
      const tool = context.getString(toolH);
      const argsText = context.getString(argsH);
      const settle = (run: () => void): void => {
        if (aborted) return;
        run();
        runtime.executePendingJobs();
        wake();
      };
      if (++calls > limits.maxCalls) {
        const err = context.newError(`mcp call limit reached (${limits.maxCalls} tool calls per script)`);
        promise.reject(err);
        err.dispose();
      } else {
        const work = (async () => {
          let reply: Awaited<ReturnType<ToolBridge>>;
          try {
            reply = await callTool(server, tool, JSON.parse(argsText));
          } catch (e) {
            reply = { ok: false, error: e instanceof Error ? e.message : String(e) };
          }
          settle(() => {
            if (reply.ok) {
              const text = JSON.stringify(reply.value ?? null);
              const h = context.newString(text);
              promise.resolve(h);
              h.dispose();
            } else {
              const err = context.newError(reply.error);
              promise.reject(err);
              err.dispose();
            }
          });
        })();
        inflight.add(work);
        void work.finally(() => inflight.delete(work));
      }
      promise.settled.then(() => runtime.executePendingJobs(), () => {});
      return promise.handle;
    });
    context.setProp(context.global, HOST_CALL, callFn);
    callFn.dispose();

    const prelude = context.evalCode(SANDBOX_PRELUDE, "prelude.js");
    if (prelude.error) {
      const d = describeError(context.dump(prelude.error));
      prelude.error.dispose();
      return finish({ ok: false, error: `sandbox setup failed: ${d.message}` });
    }
    prelude.value.dispose();

    const settled = async (handle: QuickJSHandle): Promise<{ ok: true; value: QuickJSHandle } | { ok: false; error: unknown }> => {
      for (;;) {
        const pending = runtime.executePendingJobs();
        if (pending.error) {
          const dump = context.dump(pending.error);
          pending.error.dispose();
          return { ok: false, error: dump };
        }
        const state = context.getPromiseState(handle);
        if (state.type === "fulfilled") return { ok: true, value: state.value };
        if (state.type === "rejected") {
          const dump = context.dump(state.error);
          state.error.dispose();
          return { ok: false, error: dump };
        }
        if (timedOut || now() > deadline) return { ok: false, error: { name: "TimeoutError", message: "the script ran out of time" } };
        if (inflight.size === 0) return { ok: false, error: { name: "Error", message: "the script never finished: it is waiting on a promise nothing will settle" } };
        const remaining = Math.max(1, deadline - now());
        let timer: ReturnType<typeof setTimeout> | undefined;
        const expired = new Promise<void>((resolve) => (timer = setTimeout(resolve, remaining)));
        await Promise.race([woken, expired]);
        clearTimeout(timer);
        woken = new Promise<void>((resolve) => (wake = resolve));
      }
    };

    const module = context.evalCode(wrapScript(code), "script.js", { type: "module" });
    if (module.error) {
      const d = describeError(context.dump(module.error));
      module.error.dispose();
      return finish({ ok: false, error: timedOut ? "TimeoutError: the script ran out of time" : d.message, ...(d.line ? { line: d.line } : {}) });
    }
    const ran = await settled(module.value);
    drop(module.value);
    if (!ran.ok) {
      const d = describeError(ran.error);
      return finish({ ok: false, error: timedOut ? "TimeoutError: the script ran out of time" : d.message, ...(d.line ? { line: d.line } : {}) });
    }
    drop(ran.value);

    const result = context.evalCode(SANDBOX_RESULT, "result.js");
    if (result.error) {
      const d = describeError(context.dump(result.error));
      result.error.dispose();
      return finish({ ok: false, error: d.message });
    }
    const end = await settled(result.value);
    drop(result.value);
    if (!end.ok) {
      const d = describeError(end.error);
      return finish({ ok: false, error: timedOut ? "TimeoutError: the script ran out of time" : d.message, ...(d.line ? { line: d.line } : {}) });
    }
    const text = context.getString(end.value);
    drop(end.value);
    if (Buffer.byteLength(text) > limits.maxResultBytes) return finish({ ok: false, error: `the final value is larger than ${limits.maxResultBytes} bytes; return less (filter it in the script)` });
    clean = inflight.size === 0 && !timedOut;
    return finish({ ok: true, value: text === "" ? undefined : text });
  } catch (e) {
    // A host-side failure while the isolate was running (it ran out of memory on the way to a handle, say).
    return finish({ ok: false, error: e instanceof Error ? e.message : String(e) });
  } finally {
    dispose();
  }
};
