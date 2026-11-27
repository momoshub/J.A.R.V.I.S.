/**
 * Runs the real `gh` or `orca` for the exec proxy (`application/execProxy.ts`).
 *
 * The command runs as the bot, with the bot's credentials, in a fresh empty folder
 * of its own (never a checkout, never the sandbox's tmp: the caller names the repo, not the folder). It can neither
 * prompt nor open a browser or an editor, and its output is capped.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CommandRun } from "../../application/execProxy.ts";

export type ExecRunnerConfig = {
  ghBin?: string;
  orcaBin?: string;
  timeoutMs?: number;
  /** Bytes kept of each of stdout and stderr. */
  maxBytes?: number;
  /** Where each run's empty scratch folder is made; must not be writable by the sandboxed callers (default ~/.jarvis/proxy-run). */
  workDir?: string;
};

const NO_UI_ENV: Record<string, string> = {
  GH_PROMPT_DISABLED: "1",
  GH_NO_UPDATE_NOTIFIER: "1",
  GH_PAGER: "cat",
  PAGER: "cat",
  NO_COLOR: "1",
  GIT_TERMINAL_PROMPT: "0",
  BROWSER: "/usr/bin/false",
  GH_BROWSER: "/usr/bin/false",
  GH_EDITOR: "/usr/bin/false",
  EDITOR: "/usr/bin/false",
  VISUAL: "/usr/bin/false",
};

/** What `gh` and `orca` need from the bot's environment to run; nothing else crosses. */
const RUNNER_ENV = ["PATH", "HOME", "USER", "LOGNAME", "TMPDIR", "LANG", "LC_ALL", "SHELL"] as const;
const pick = (from: NodeJS.ProcessEnv, names: readonly string[]): Record<string, string> =>
  Object.fromEntries(names.flatMap((n) => (from[n] !== undefined ? [[n, from[n] as string]] : [])));

const clip = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max)}\n[output cut at ${max} bytes]` : s);

export const createExecRunner =
  (config: ExecRunnerConfig = {}) =>
  async (tool: "gh" | "orca", argv: readonly string[], opts: { stdin?: string; env?: Record<string, string> }): Promise<CommandRun> => {
    const max = config.maxBytes ?? 2_000_000;
    // A minimal environment, never the bot's own: gh's `--jq '$ENV'` prints every variable of the process, and the
    // bot's holds its tokens. Only what the tools need to find themselves and their login.
    // Each run gets its own empty folder under a place the sandbox cannot write (~/.jarvis is write-denied to it, and
    // os.tmpdir() is not): gh runs git in its cwd, and git runs the core.fsmonitor of any .git it finds there or above.
    const root = config.workDir ?? join(homedir(), ".jarvis", "proxy-run");
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const cwd = mkdtempSync(join(root, "run-"));
    const env: Record<string, string | undefined> = {
      ...pick(process.env, RUNNER_ENV),
      ...NO_UI_ENV,
      GIT_CEILING_DIRECTORIES: root,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      ...opts.env,
    };
    const proc = Bun.spawn({
      cmd: [tool === "gh" ? (config.ghBin ?? "gh") : (config.orcaBin ?? "orca"), ...argv],
      cwd,
      env,
      stdin: opts.stdin !== undefined ? Buffer.from(opts.stdin) : "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const limit = setTimeout(() => proc.kill(), config.timeoutMs ?? 60_000);
    try {
      const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      return { code, stdout: clip(stdout, max), stderr: clip(stderr, max) };
    } finally {
      clearTimeout(limit);
      rmSync(cwd, { recursive: true, force: true });
    }
  };
