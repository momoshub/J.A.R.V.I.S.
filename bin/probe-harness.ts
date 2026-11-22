#!/usr/bin/env bun
//
// Contrastive probe for a prompt or skill change (README, "Probing a prompt or skill change").
//
//   probe-harness.ts --path <file> [--base-ref origin/main] [options]
//   probe-harness.ts --base <file> --candidate <file> [options]
//
// Runs each replay case (docs/probe-cases/*.json) --runs times on the base text and on
// the candidate text with `claude -p`, then has a judge model compare the two answers
// pairwise and writes a short report (wins, losses, ties, the behaviour contrasts) to
// stdout and to a markdown file (--out, default in the system temp folder: a report is for a PR body, not for a commit). No ground truth: the judge compares behaviour, after
// Harness2's Propose-Probe-Compose. `--dry-run` prints the plan and the estimated token
// spend and calls no model; the estimate is printed before every real run too.
//
// The text under test is the whole system prompt of the answering call (`--system-prompt`),
// so a skill or guide is probed as the instructions it adds to nothing else. It takes plain
// text (a skill, a guide, an exported prompt), not a TypeScript module that builds one. The calls are
// sandboxed: no tools at all (`--tools ""`, so nothing to read, write or post), no MCP
// servers and no Slack (`--strict-mcp-config`, none given), no skills, no saved session, no user or project settings (`--setting-sources local`: no hooks, plugins or CLAUDE.md of the host),
// an empty temp folder as cwd, and an environment cut down to what the CLI needs to log
// in. It measures how the model WRITES to a message, not what it does with tools.
//
// Exit: 0 report written (or dry run), 1 the run could not finish, 2 usage.
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  buildReport,
  candidateIsA,
  contrastOf,
  estimateSpend,
  formatEstimate,
  judgePrompt,
  loadCases,
  MAX_TEXT_CHARS,
  type Outcome,
  outcomeOf,
  type PairResult,
  type ProbeCase,
  parseProbeArgs,
  parseVerdict,
  PROBE_USAGE,
  textLabel,
} from "../src/domain/probe.ts";

/** Pairs in flight at once (each runs its base and candidate answers side by side, so up to twice this many calls): enough to finish in minutes, few enough not to trip a rate limit. */
const CONCURRENCY = 3;
const CALL_TIMEOUT_MS = 300_000;
/** What the CLI needs to find its login and nothing else: no Slack token, no GitHub token, no BOT_* helper. */
const ENV_KEEP = ["PATH", "HOME", "USER", "LANG", "LC_ALL", "TERM", "TMPDIR", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL"];

const fail = (message: string, code = 1): never => {
  console.error(message);
  process.exit(code);
};

let options: ReturnType<typeof parseProbeArgs>;
try {
  options = parseProbeArgs(process.argv.slice(2));
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  console.error(PROBE_USAGE);
  process.exit(2);
}
if (options.help) {
  console.log(PROBE_USAGE);
  process.exit(0);
}

const checked = (label: string, text: string): string => {
  if (text.trim() === "") return fail(`${label} is empty`);
  if (text.includes("\0")) return fail(`${label} is binary, not a prompt or skill text`);
  if (text.length > MAX_TEXT_CHARS) return fail(`${label} is ${text.length} chars, over the ${MAX_TEXT_CHARS} a prompt or skill should be`);
  return text;
};

const readText = (file: string): string => {
  try {
    return checked(file, readFileSync(file, "utf8"));
  } catch (err) {
    if (err instanceof Error && "code" in err) return fail(`cannot read ${file}`);
    throw err;
  }
};

const gitShow = (ref: string, path: string): string => {
  const proc = Bun.spawnSync({ cmd: ["git", "show", `${ref}:./${path}`], stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0) return fail(`cannot read ${path} at ${ref}: ${new TextDecoder().decode(proc.stderr).trim()}`);
  return checked(`${path} at ${ref}`, new TextDecoder().decode(proc.stdout));
};

let baseText: string;
let candidateText: string;
let baseName: string;
let candidateName: string;
if (options.path !== undefined) {
  candidateText = readText(options.path);
  baseText = gitShow(options.baseRef, options.path);
  baseName = `${options.path}@${options.baseRef}`;
  candidateName = `${options.path} (working copy)`;
} else {
  baseText = readText(options.baseFile as string);
  candidateText = readText(options.candidateFile as string);
  baseName = basename(options.baseFile as string);
  candidateName = basename(options.candidateFile as string);
}

let caseFiles: string[] = [];
try {
  caseFiles = readdirSync(options.casesDir).filter((f) => f.endsWith(".json"));
} catch {
  fail(`cannot read cases in ${options.casesDir}`);
}
let cases: ProbeCase[] = [];
try {
  cases = loadCases(caseFiles.map((file) => ({ file, text: readFileSync(join(options.casesDir, file), "utf8") }))).slice(0, options.maxCases);
} catch (err) {
  fail(err instanceof Error ? err.message : `cannot load cases in ${options.casesDir}`);
}

const estimate = estimateSpend(baseText, candidateText, cases, options.runs);
console.log(`comparing ${textLabel(baseName, baseText)} with ${textLabel(candidateName, candidateText)}`);
console.log(formatEstimate(estimate, cases.length, options.runs));
if (baseText === candidateText) console.log("note: base and candidate are identical, expect ties");
if (options.dryRun) {
  console.log(`dry run: cases ${cases.map((c) => c.id).join(", ")}; no model called`);
  process.exit(0);
}

const sandboxEnv = (): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const key of ENV_KEEP) {
    const v = process.env[key];
    if (v !== undefined) env[key] = v;
  }
  return env;
};

const spent = { inputTokens: 0, outputTokens: 0, costUsd: 0 };

/** One sandboxed `claude -p` call. The prompt is an argument, not stdin; `--tools ""` goes last so it cannot swallow what follows. */
const ask = async (cwd: string, model: string, system: string, prompt: string): Promise<string> => {
  const proc = Bun.spawn({
    cmd: [
      "claude", "-p", prompt, "--output-format", "json", "--model", model, "--system-prompt", system,
      "--strict-mcp-config", "--setting-sources", "local", "--disable-slash-commands", "--no-session-persistence", "--tools", "",
    ],
    cwd,
    env: sandboxEnv(),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
  });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(stdout) as Record<string, unknown>;
  } catch {
    throw new Error(`claude exited ${code}: ${(stderr || stdout).trim().slice(0, 200) || "no output"}`);
  }
  if (code !== 0 || parsed.is_error === true || typeof parsed.result !== "string") throw new Error(`claude failed: ${String(parsed.result ?? stderr).trim().slice(0, 200)}`);
  const usage = (parsed.usage ?? {}) as Record<string, number | undefined>;
  spent.inputTokens += (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
  spent.outputTokens += usage.output_tokens ?? 0;
  spent.costUsd += typeof parsed.total_cost_usd === "number" ? parsed.total_cost_usd : 0;
  return parsed.result.trim();
};

/** Run thunks with at most `limit` in flight, results in order. */
const pool = async <T>(jobs: readonly (() => Promise<T>)[], limit: number): Promise<T[]> => {
  const out: T[] = new Array(jobs.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < jobs.length) {
      const i = next++;
      out[i] = await (jobs[i] as () => Promise<T>)();
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, jobs.length) }, worker));
  return out;
};

const sandbox = mkdtempSync(join(tmpdir(), "jarvis-probe-"));
try {
  const jobs = cases.flatMap((c) =>
    Array.from({ length: options.runs }, (_, i) => async (): Promise<PairResult> => {
      const run = i + 1;
      try {
        const [base, candidate] = await Promise.all([
          ask(sandbox, options.model, baseText, c.message),
          ask(sandbox, options.model, candidateText, c.message),
        ]);
        const candidateWasA = candidateIsA(c.id, run);
        const [a, b] = candidateWasA ? [candidate, base] : [base, candidate];
        const reply = await ask(sandbox, options.judgeModel, "You compare two assistant answers and reply with one JSON object only.", judgePrompt(c, a, b));
        const verdict = parseVerdict(reply);
        if (!verdict) return { caseId: c.id, run, error: "the judge's reply held no verdict" };
        const outcome: Outcome = outcomeOf(verdict, candidateWasA);
        return { caseId: c.id, run, outcome, contrast: contrastOf(verdict, candidateWasA) };
      } catch (err) {
        return { caseId: c.id, run, error: err instanceof Error ? err.message : String(err) };
      }
    }),
  );
  const results = await pool(jobs, CONCURRENCY);
  const report = buildReport({
    baseLabel: textLabel(baseName, baseText),
    candidateLabel: textLabel(candidateName, candidateText),
    model: options.model,
    judgeModel: options.judgeModel,
    runs: options.runs,
    results,
    usage: spent,
  });
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const out = options.out ?? join(tmpdir(), `probe-${stamp}.md`);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, report);
  console.log(`\n${report}`);
  console.log(`report written to ${out}`);
  if (results.every((r) => "error" in r)) fail("every pair failed, so the report says nothing");
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}
