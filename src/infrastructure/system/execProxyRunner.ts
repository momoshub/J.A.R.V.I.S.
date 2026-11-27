/**
 * Runs the real `gh` or `orca` for the exec proxy (`application/execProxy.ts`).
 *
 * The command runs as the bot, with the bot's credentials, in a scratch folder
 * (never a checkout: the caller names the repo, not the folder). It can neither
 * prompt nor open a browser or an editor, and its output is capped.
 */
import { tmpdir } from "node:os";
import type { CommandRun } from "../../application/execProxy.ts";

export type ExecRunnerConfig = {
  ghBin?: string;
  orcaBin?: string;
  timeoutMs?: number;
  /** Bytes kept of each of stdout and stderr. */
  maxBytes?: number;
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

const clip = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max)}\n[output cut at ${max} bytes]` : s);

export const createExecRunner =
  (config: ExecRunnerConfig = {}) =>
  async (tool: "gh" | "orca", argv: readonly string[], opts: { stdin?: string; env?: Record<string, string> }): Promise<CommandRun> => {
    const max = config.maxBytes ?? 2_000_000;
    const env: Record<string, string | undefined> = { ...process.env, ...NO_UI_ENV, ...opts.env };
    // The bot is not sandboxed; a flag inherited from whoever started it must not make the command think it is.
    delete env.JARVIS_SANDBOXED;
    const proc = Bun.spawn({
      cmd: [tool === "gh" ? (config.ghBin ?? "gh") : (config.orcaBin ?? "orca"), ...argv],
      cwd: tmpdir(),
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
    }
  };
