/**
 * What the bot's exec proxy will run for a sandboxed caller, as pure rules.
 *
 * Inside the sandbox a process holds no GitHub login and cannot reach Orca (see
 * `bin/sandbox/jarvis.sb`). Its `gh` and `orca` are shims that send the command
 * line here, and the bot runs the real one with its own credentials. So this is
 * the allowlist: only commands a worker, reviewer, verifier or turn really uses,
 * each classified by what it needs.
 *
 *  - `read`: any live session or ticket (GitHub reads, Orca reads);
 *  - `write`: a ticket whose grants include the matching GitHub action (the same
 *    grants `bin/github-app.sh` is checked against); a bare session never writes;
 *  - `orca`: message / read / start, see `OrcaLevel`.
 *
 * Merging a PR is never classified: it has its own gate (`bin/merge-when-green.sh`).
 * Nothing here reads a file on the bot's side on the caller's say-so: a body file
 * or spec file must be `-` (stdin), which the shim fills from the caller's own disk.
 */
import type { ActionName } from "./githubAppAction.ts";

export type GhWriteAction = Extract<ActionName, "comment" | "review" | "pr-edit" | "pr-close" | "pr-reopen" | "pr-create">;

/** `message`: tell or hear from another agent; `read`: look; `start`: dispatch and manage workers. */
export type OrcaLevel = "message" | "read" | "start";

export type Need =
  | { kind: "read" }
  | { kind: "write"; action: GhWriteAction }
  | { kind: "orca"; level: OrcaLevel };

export type Classified =
  | { ok: true; tool: "gh" | "orca"; need: Need; argv: string[]; /** `owner/name` the command acts on (gh only). */ repo?: string; /** For the audit line: what, never the text. */ label: string }
  | { ok: false; error: string };

const REPO = /^[\w.-]+\/[\w.-]+$/;
const fail = (error: string): Classified => ({ ok: false, error });

/** A flag as `[name, inlineValue]`; a plain word gives `undefined`. */
const flagOf = (arg: string): [string, string | undefined] | undefined => {
  if (!arg.startsWith("-") || arg === "-") return undefined;
  const eq = arg.startsWith("--") ? arg.indexOf("=") : -1;
  return eq > 0 ? [arg.slice(0, eq), arg.slice(eq + 1)] : [arg, undefined];
};

/** Flags that take a value in the next word, for the ones this module reads or must skip over. */
const VALUE_FLAGS = new Set([
  "-R", "--repo", "-b", "--body", "-F", "--body-file", "-t", "--title", "-B", "--base", "-H", "--head", "--json", "-q", "--jq",
  "-L", "--limit", "-s", "--state", "-a", "--assignee", "-A", "--author", "-l", "--label", "--search", "-S", "-w", "--workflow",
  "--branch", "-u", "--user", "-e", "--event", "--commit", "--cache", "-X", "--method", "--add-label", "--remove-label", "--add-reviewer",
  "--remove-reviewer", "--milestone", "--reason", "-c", "--comment", "--job", "-j", "--template", "-T", "--color", "--fields", "-f", "--field", "--raw-field", "--input", "--hostname", "--preview", "-p", "--base-branch",
]);

type Parsed = { positional: string[]; flags: Map<string, string | true> };

/** Orca's flags that stand alone; every other `--flag` takes the next word as its value. */
const ORCA_BOOLEAN_FLAGS = new Set(["--json", "--full", "--keep-open", "--unread", "--all", "--ack", "--peek", "--wait", "--help"]);

const parseWords = (words: readonly string[], genericValues = false): Parsed => {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < words.length; i++) {
    const w = words[i] as string;
    const f = flagOf(w);
    if (!f) {
      positional.push(w);
      continue;
    }
    const [name, inline] = f;
    if (inline !== undefined) flags.set(name, inline);
    else if ((genericValues ? !ORCA_BOOLEAN_FLAGS.has(name) && name.startsWith("--") : VALUE_FLAGS.has(name)) && i + 1 < words.length && (!genericValues || !(words[i + 1] as string).startsWith("-") || words[i + 1] === "-")) flags.set(name, words[++i] as string);
    else flags.set(name, true);
  }
  return { positional, flags };
};

const flagValue = (p: Parsed, ...names: string[]): string | undefined => {
  for (const n of names) {
    const v = p.flags.get(n);
    if (typeof v === "string") return v;
  }
  return undefined;
};
const hasFlag = (p: Parsed, ...names: string[]): boolean => names.some((n) => p.flags.has(n));

/** `owner/name` from a GitHub PR, issue or run URL. */
export const repoFromUrl = (s: string): string | undefined => s.match(/^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/(?:pull|issues|actions)\//)?.[1];

const GH_READ: Readonly<Record<string, readonly string[]>> = {
  pr: ["view", "diff", "list", "checks", "status"],
  issue: ["view", "list", "status"],
  run: ["list", "view"],
  workflow: ["list", "view"],
  repo: ["view"],
};
const GH_WRITE: Readonly<Record<string, Readonly<Record<string, GhWriteAction>>>> = {
  pr: { comment: "comment", review: "review", edit: "pr-edit", close: "pr-close", reopen: "pr-reopen", create: "pr-create" },
  issue: { comment: "comment" },
};

/** Flags no proxied `gh` takes: they would open a browser or an editor on the bot's side, read a file there, or aim at another host. */
const GH_REFUSED_FLAGS = ["--web", "--editor", "--hostname", "--input", "--template", "-T", "--with-token"];

/** `gh api`: a GET under `repos/<owner>/<name>/`, nothing that sends a field, a header or another method. */
const classifyApi = (p: Parsed): Classified => {
  const method = flagValue(p, "-X", "--method");
  if (method !== undefined && method.toUpperCase() !== "GET") return fail("gh api is read-only through the proxy: only GET");
  if (hasFlag(p, "-f", "--raw-field", "-F", "--field", "-H", "--header", "--preview", "-p")) return fail("gh api through the proxy takes no fields, headers or previews");
  const path = (p.positional[1] ?? "").replace(/^\//, "");
  const m = path.split("?")[0]?.match(/^repos\/([\w.-]+)\/([\w.-]+)(\/.*)?$/);
  if (!m || p.positional.length !== 2 || path.split("?")[0]?.split("/").some((s) => s === ".." || s === ".")) {
    return fail("gh api through the proxy reads repos/<owner>/<name>/... only");
  }
  const repo = `${m[1]}/${m[2]}`;
  const argv = ["api", path];
  for (const [name, v] of p.flags) {
    if (["--paginate", "--slurp", "-i", "--include", "--silent"].includes(name)) argv.push(name);
    else if (["-q", "--jq", "--cache"].includes(name) && typeof v === "string") argv.push(name, v);
    else if (name !== "-X" && name !== "--method") return fail(`gh api: ${name} is not available through the proxy`);
  }
  return { ok: true, tool: "gh", need: { kind: "read" }, argv, repo, label: `api GET ${repo}` };
};

export const classifyGh = (argv: readonly string[], repoHint?: string): Classified => {
  const [group, ...rest] = argv;
  if (!group || group.startsWith("-")) return fail("name a gh command: pr, issue, run, workflow, repo or api");
  const p = parseWords(rest);
  for (const f of GH_REFUSED_FLAGS) if (hasFlag(p, f)) return fail(`${f} is not available through the proxy`);
  const bodyFile = flagValue(p, "-F", "--body-file");
  if (bodyFile !== undefined && bodyFile !== "-") return fail("a body file is read on the caller's side: the shim sends it as stdin (`--body-file -`)");

  if (group === "api") return classifyApi(parseWords(argv));
  const verb = p.positional[0];
  if (!verb) return fail(`gh ${group} needs a subcommand`);
  if (group === "pr" && verb === "merge") return fail("merging is not something a proxied gh does: run bin/merge-when-green.sh, which asks the bot's merge gate");

  const reads = GH_READ[group];
  const write = GH_WRITE[group]?.[verb];
  if (!(reads?.includes(verb) || write)) return fail(`gh ${group} ${verb} is not available through the proxy`);

  const flagRepo = flagValue(p, "-R", "--repo");
  if (flagRepo !== undefined && !REPO.test(flagRepo)) return fail("-R wants owner/name");
  // `gh repo view o/r` and a PR url name the repo themselves; otherwise the clone the caller is in does.
  const urlRepo = p.positional.map(repoFromUrl).find(Boolean) ?? (group === "repo" && REPO.test(p.positional[1] ?? "") ? p.positional[1] : undefined);
  const repo = flagRepo ?? urlRepo ?? (repoHint && REPO.test(repoHint) ? repoHint : undefined);
  if (!repo) return fail("say which repository: -R owner/name (or run it in a clone whose origin is on GitHub)");
  // The repo the command acts on is the one named here: carry it as -R so the bot's own working directory never decides it.
  const args = [group, ...rest];
  if (flagRepo === undefined && urlRepo === undefined) args.push("-R", repo);
  return write
    ? { ok: true, tool: "gh", need: { kind: "write", action: write }, argv: args, repo, label: `${group} ${verb} ${repo}` }
    : { ok: true, tool: "gh", need: { kind: "read" }, argv: args, repo, label: `${group} ${verb} ${repo}` };
};

const ORCA_LEVEL: Readonly<Record<string, OrcaLevel>> = {
  send: "message", check: "message", reply: "message", ask: "message",
  inbox: "read", "task-list": "read", "worker-show": "read", "worker-read": "read", "worker-list": "read", "run-show": "read", "run-list": "read",
  "run-current": "read", "request-show": "read", "dispatch-show": "read", "gate-list": "read",
  "worker-start": "start", "worker-stop": "start", "worker-abandon": "start", "worker-release": "start", "worker-keep-open": "start",
  "task-create": "start", "task-update": "start", "run-create": "start", "run-use": "start", "gate-create": "start", "gate-resolve": "start",
};

/** Flags that reach another Orca server or put a worker on an existing (unsandboxed) terminal. */
const ORCA_REFUSED_FLAGS = ["--pairing-code", "--environment", "--on"];

export const classifyOrca = (argv: readonly string[]): Classified => {
  const [group, verb, ...rest] = argv;
  if (group === "status" && argv.length === 1) return { ok: true, tool: "orca", need: { kind: "orca", level: "read" }, argv: [...argv], label: "status" };
  if (group !== "orchestration" || !verb) return fail("inside the sandbox orca only does `orca orchestration <verb>` (and `orca status`): terminals, agents and worktrees would start something outside it");
  const level = ORCA_LEVEL[verb];
  if (!level) return fail(`orca orchestration ${verb} is not available inside the sandbox`);
  const p = parseWords(rest, true);
  for (const f of ORCA_REFUSED_FLAGS) if (hasFlag(p, f)) return fail(`${f} is not available inside the sandbox`);
  if (verb === "worker-start") {
    if (hasFlag(p, "--terminal")) return fail("worker-start --terminal would put the worker on an existing terminal, outside the sandbox: start a fresh one");
    const agent = flagValue(p, "--agent");
    if (agent !== "claude") return fail("worker-start inside the sandbox starts `--agent claude` only (the other agents are not launched through the sandbox wrapper)");
    const specFile = flagValue(p, "--spec-file");
    if (specFile !== undefined && specFile !== "-") return fail("a spec file is read on the caller's side: the shim sends it as stdin (`--spec-file -`)");
  }
  return { ok: true, tool: "orca", need: { kind: "orca", level }, argv: [...argv], label: `orchestration ${verb}` };
};
