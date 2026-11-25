/**
 * Pure parts of `mcp run`: the limits of a script's isolate, the JavaScript prelude that is the only thing the isolate
 * sees (`mcp.<server>.<tool>(args)` and `console`), the script wrapper, and capping of what comes out.
 */

export type SandboxLimits = {
  /** Wall clock for the whole script, host calls included. */
  readonly timeoutMs: number;
  /** Heap of the isolate. */
  readonly memoryBytes: number;
  /** Bridged tool calls the script may make. */
  readonly maxCalls: number;
  /** Bytes of console output kept; the rest is dropped with a marker. */
  readonly maxLogBytes: number;
  /** Bytes of the serialized final value. */
  readonly maxResultBytes: number;
};

export const DEFAULT_SANDBOX_LIMITS: SandboxLimits = {
  timeoutMs: 60_000,
  memoryBytes: 64 * 1024 * 1024,
  maxCalls: 100,
  maxLogBytes: 256 * 1024,
  maxResultBytes: 8 * 1024 * 1024,
};

/** `--memory` ceiling: the WebAssembly memory maximum is 4 GB, and the engine needs some of it. */
export const MAX_SANDBOX_MEMORY_MB = 1024;

export const HOST_CALL = "__hostCall";
export const HOST_LOG = "__hostLog";

/**
 * Evaluated first inside the isolate. It captures the two host functions in a closure, removes them from the global
 * object, and defines `mcp` (a proxy: `mcp.db.run_query({...})` asks the host) and `console`. Nothing else is added:
 * no `fetch`, `require`, `process`, `Bun`, timers or file access exists in the isolate.
 */
export const SANDBOX_PRELUDE = `(() => {
  const call = globalThis.${HOST_CALL};
  const log = globalThis.${HOST_LOG};
  delete globalThis.${HOST_CALL};
  delete globalThis.${HOST_LOG};
  const show = (v) => {
    if (typeof v === "string") return v;
    if (v instanceof Error) return v.stack || String(v);
    try { const s = JSON.stringify(v); return s === undefined ? String(v) : s; } catch { return String(v); }
  };
  const print = (...a) => log(a.map(show).join(" "));
  globalThis.console = { log: print, info: print, warn: print, error: print, debug: print };
  const tool = (server, name) => (args) => {
    if (args !== undefined && (args === null || typeof args !== "object" || Array.isArray(args))) {
      return Promise.reject(new TypeError("mcp." + server + "." + name + " takes one object of arguments"));
    }
    return call(server, name, JSON.stringify(args === undefined ? {} : args)).then((s) => JSON.parse(s));
  };
  const server = (s) => new Proxy(Object.create(null), { get: (_, name) => (typeof name === "string" && name !== "then" ? tool(s, name) : undefined) });
  globalThis.mcp = new Proxy(Object.create(null), { get: (_, s) => (typeof s === "string" && s !== "then" ? server(s) : undefined) });
})();`;

/**
 * The script as the isolate runs it: an ES module (top-level await works) whose `export default` is turned into
 * the final value; a default-exported function is called and awaited. `code` is already plain JavaScript (transpiled).
 */
export const wrapScript = (code: string): string => {
  const body = code.replace(/(^|[;}\n])(\s*)export\s+default\s+/, "$1$2globalThis.__default = ");
  return `${body}\n;globalThis.__done = true;`;
};

/** The epilogue run after the module settled: the final value, calling a default-exported function. */
export const SANDBOX_RESULT = `(async () => {
  const d = globalThis.__default;
  const v = typeof d === "function" ? await d() : await d;
  return v === undefined ? "" : JSON.stringify(v);
})()`;

/** Appends to a capped buffer; returns whether it still fits. */
export const appendCapped = (buf: { text: string; bytes: number; truncated: boolean }, line: string, max: number): void => {
  if (buf.truncated) return;
  const add = Buffer.byteLength(line) + 1;
  if (buf.bytes + add > max) {
    buf.text += `[output truncated at ${max} bytes]\n`;
    buf.truncated = true;
    return;
  }
  buf.text += `${line}\n`;
  buf.bytes += add;
};

/** `1.5`, `60` -> milliseconds; undefined when it is not a positive number. */
export const secondsToMs = (raw: string | undefined, fallbackMs: number): number | undefined => {
  if (raw === undefined) return fallbackMs;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 1000) : undefined;
};

/** A positive integer flag, or undefined when it is not one. */
export const positiveInt = (raw: string | undefined, fallback: number): number | undefined => {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : undefined;
};
