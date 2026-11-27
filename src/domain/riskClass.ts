/**
 * Risk by behaviour, not by path: classify a diff by what it can CHANGE.
 *
 * The self-fix guide used to route review by folder ("prompt text in src/ gets
 * no reviewer, runtime logic does"). A one-line edit to a tool allow-list is
 * "just config" by that rule, and a prompt that tells the agent to merge
 * without review is "just text". This module reads the changed lines and
 * names the strongest thing the change can do, in four classes (low to high):
 *
 *   docs        - prose and comments an agent never loads as instructions
 *   prompt      - text that steers an agent's actions: system prompt strings,
 *                 prompt guides, skills, CLAUDE.md / AGENTS.md
 *   runtime     - code that runs (logic, commands, adapters, scripts, tests,
 *                 config, anything not recognised: the default fails closed)
 *   capability  - what the bot or its workers are ALLOWED to do: tools,
 *                 commands run, roles and permissions, tickets, network,
 *                 credentials, process execution, dependencies, CI
 *
 * The path only tells the parser which comment syntax to use and whether a
 * markdown file is loaded by an agent; it never lowers a class. The class of a
 * file is the highest class of any changed line, the class of a PR the highest
 * class of its files, and routing follows the class: docs none, prompt a
 * reviewer plus the probe gate, runtime and capability a reviewer plus a
 * verifier. Pure: the diff comes in as text, the bin wrapper reads git.
 */

export type RiskClass = "docs" | "prompt" | "runtime" | "capability";

export const RISK_ORDER: readonly RiskClass[] = ["docs", "prompt", "runtime", "capability"];

export type CapabilityKind = "tools" | "commands" | "roles" | "tickets" | "permissions" | "network" | "credentials" | "exec" | "dependencies" | "ci";

/** One file of a diff: its patch is the unified-diff text from its first `@@` on. */
export type ChangedFile = {
  readonly path: string;
  readonly oldPath?: string;
  readonly patch: string;
  readonly binary?: boolean;
  /** A mode change (`chmod +x`) with or without content changes. */
  readonly modeChanged?: boolean;
  readonly deleted?: boolean;
};

export type FileRisk = {
  readonly path: string;
  readonly class: RiskClass;
  readonly reasons: readonly string[];
};

export type Routing = {
  /** A standalone reviewer reads the diff before the merge. */
  readonly reviewer: boolean;
  /** A separate verifier runs the change on the PR head. */
  readonly verifier: boolean;
  /** The probe gate (`bin/probe-harness.ts`) runs before the PR goes out. */
  readonly probe: boolean;
};

export type RiskReport = {
  readonly class: RiskClass;
  readonly routing: Routing;
  readonly files: readonly FileRisk[];
  /** Every distinct reason across the files, for the PR body. */
  readonly reasons: readonly string[];
};

const rank = (c: RiskClass): number => RISK_ORDER.indexOf(c);
const highest = (classes: readonly RiskClass[]): RiskClass => classes.reduce<RiskClass>((a, b) => (rank(b) > rank(a) ? b : a), "docs");

/** What each class owes before it merges. */
export const routingFor = (cls: RiskClass, hasPromptText: boolean): Routing => ({
  reviewer: cls !== "docs",
  verifier: cls === "runtime" || cls === "capability",
  probe: hasPromptText,
});

// --- the capability table: one regex per way a change can widen what the bot may do ---

const CAPABILITY_PATTERNS: readonly { readonly kind: CapabilityKind; readonly re: RegExp }[] = [
  { kind: "tools", re: /allowed[-_ ]?tools|disallowed[-_ ]?tools|\bBash\([^)]*\)|\bORCA_DENY\b|\bmcpServers\b|mcp[-_]config|--dangerously|permission[-_]mode|bypassPermissions|\bsandbox\b|\bdeny[-_ ]?list\b|\ballow[-_ ]?list\b/i },
  { kind: "commands", re: /\bregisterCommand\b|\bdefineCommand\b|\bCommandSpec\b|\bCOMMANDS\b|\bcommandHandlers?\b/ },
  { kind: "roles", re: /\broleSeed\b|\bROLE_[A-Z_]+\b|\bseedRoles?\b|\bRoleGrant\b|\broles?\.(?:grant|revoke|assign)\b|\bgrantRole\b/i },
  { kind: "tickets", re: /\bJARVIS_RUN_TICKET|\bworker-ticket\b|\bworkerTicket\w*|\bmintTicket\b|\bticket(?:Ttl|Scope|Actions)\b/ },
  { kind: "permissions", re: /\bhasPermission\b|\bisAllowed\b|\bauthori[sz]e\w*\(|\bcan[A-Z]\w*\(|\bPERMISSIONS?\b|\bpermissions?\s*[:=(]|\bgrants?\s*[:=(]|\bchmod\b|\bsudo\b|\bowner[-_]only\b/ },
  { kind: "network", re: /\bfetch\(|\bBun\.serve\b|\bcreateServer\b|\.listen\(|\bnew WebSocket\b|["']node:(?:http|https|net|dgram|tls)["']|\bBun\.connect\b|\bcurl\s+-|\bwget\s|\bhostname\s*:|\bAccess-Control-Allow/ },
  { kind: "credentials", re: /\bGH_TOKEN\b|\b[A-Z][A-Z0-9]*_(?:TOKEN|SECRET|API_KEY|PASSWORD)\b|\bPRIVATE_KEY\b|\bprocess\.env\.\w*(?:TOKEN|SECRET|KEY|PASSWORD)|\.pem\b|\bAuthorization\s*[:=]|\bBearer \$|\bkeychain\b|\bsecrets\.\w/ },
  { kind: "exec", re: /\bBun\.spawn(?:Sync)?\b|\bchild_process\b|\bexecSync\b|\bspawnSync\b|(?<![.\w])exec\(|\beval\(|\bnew Function\(|\bBun\.\$|\bshell:\s*true\b/ },
];

/** In a skill/agent markdown file only its tool grants are a capability; the prose is `prompt`. */
const STEERING_TOOL_RE = /^\s*(?:allowed[-_]tools|tools|permissions?|disallowed[-_]tools)\s*:/i;

const DEPENDENCY_LINE_RE = /^\s*"(?:@[\w.-]+\/)?[\w.-]+"\s*:\s*"[\^~<>=*]*\d[^"]*"\s*,?\s*$/;
const LOCKFILE_RE = /(?:^|\/)(?:bun\.lockb?|package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/;
const PACKAGE_JSON_RE = /(?:^|\/)package\.json$/;
const WORKFLOW_RE = /(?:^|\/)\.github\/(?:workflows|actions)\//;
const MANIFEST_RE = /(?:^|\/)slack-app-manifest\.ya?ml$/;
const TEST_PATH_RE = /(?:^|\/)(?:tests?|e2e|__tests__)\/|\.(?:test|spec|e2e)\.[cm]?[tj]sx?$/;
const GITHOOK_RE = /(?:^|\/)\.githooks\//;

/** Markdown an agent loads as instructions: skills, agents, guides, probe replay cases, the repo's own instruction files. */
const STEERING_PATH_RE = /(?:^|\/)(?:CLAUDE|AGENTS)\.md$|(?:^|\/)SKILL\.md$|(?:^|\/)\.claude\/(?:skills|agents|commands)\/|(?:^|\/)prompt-guides\/|(?:^|\/)docs\/probe-cases\//;
const DOC_EXT_RE = /\.(?:md|mdx|txt|rst|png|jpe?g|gif|svg|webp|ico|pdf)$|(?:^|\/)(?:LICENSE|NOTICE|SECURITY\.md)$/i;
const SLASH_COMMENT_EXT_RE = /\.(?:ts|tsx|js|jsx|mjs|cjs|css|scss|java|go|rs|c|h|cpp)$/;
const HASH_COMMENT_EXT_RE = /\.(?:sh|bash|zsh|ya?ml|toml|py|rb|env|example|gitignore|gitleaksignore)$|(?:^|\/)\.env[\w.]*$|(?:^|\/)\.githooks\//;

const isComment = (path: string, line: string): boolean => {
  const t = line.trim();
  if (t === "") return true;
  if (SLASH_COMMENT_EXT_RE.test(path)) {
    // a `// @ts-ignore` or `/* istanbul ignore */` steers a tool, it is not prose
    if (/@ts-(?:ignore|expect-error|nocheck)|eslint-disable|biome-ignore|istanbul ignore/.test(t)) return false;
    return t.startsWith("//") || t.startsWith("/*") || t.startsWith("*") || t.startsWith("*/");
  }
  if (HASH_COMMENT_EXT_RE.test(path)) return t.startsWith("#") && !t.startsWith("#!");
  return false;
};

const STEERING_WORD_RE = /\b(?:never|always|must|do not|don't|you|your|should|before you|only if|instead of|make sure|ask the|tell the)\b/i;
const CODE_SHAPE_RE = /=>|\bfunction\b|^\s*(?:const|let|var|import|export|return|if|for|while|type|interface)\b|[;{}]\s*$|\)\s*[,;]?\s*$/;

/**
 * A line of prose that instructs an agent, inside a source file: a long run of
 * words with steering vocabulary and none of the shape of code. It errs toward
 * "not prompt": a line it misses falls through to `runtime`, which is the
 * stricter class, never the looser one.
 */
const isPromptText = (line: string): boolean => {
  const t = line.trim().replace(/^[`'"+\-*\s]+/, "");
  if (t.split(/\s+/).length < 10) return false;
  if (CODE_SHAPE_RE.test(t)) return false;
  return STEERING_WORD_RE.test(t);
};

type Line = { readonly sign: "+" | "-"; readonly text: string };

/** The added and removed lines of a patch (a removed guard is as much a change as an added one). */
const changedLines = (patch: string): Line[] => {
  const out: Line[] = [];
  for (const raw of patch.split("\n")) {
    // a patch starts at its first `@@`, so a `+++` or `---` here is a changed line that begins with `++` or `--`, never a header
    if (raw.startsWith("@@")) continue;
    if (raw.startsWith("+")) out.push({ sign: "+", text: raw.slice(1) });
    else if (raw.startsWith("-")) out.push({ sign: "-", text: raw.slice(1) });
  }
  return out;
};

/** An import only names a module; what it does with it is on the lines that call it. */
const IMPORT_LINE_RE = /^\s*(?:import\b|\}\s*from\s|export\s+(?:\*|\{[^}]*\})\s+from\b)/;

const capabilityOf = (text: string): CapabilityKind | undefined => (IMPORT_LINE_RE.test(text) ? undefined : CAPABILITY_PATTERNS.find((p) => p.re.test(text))?.kind);

type Verdict = { readonly class: RiskClass; readonly reason: string; readonly promptText: boolean };

const classifyFile = (file: ChangedFile): { risk: FileRisk; promptText: boolean } => {
  const done = (verdicts: readonly Verdict[]): { risk: FileRisk; promptText: boolean } => {
    const cls = highest(verdicts.map((v) => v.class));
    const reasons = [...new Set(verdicts.filter((v) => v.class === cls || v.promptText).map((v) => v.reason))];
    return { risk: { path: file.path, class: cls, reasons }, promptText: verdicts.some((v) => v.promptText) };
  };
  const paths = [file.path, ...(file.oldPath !== undefined && file.oldPath !== file.path ? [file.oldPath] : [])];
  const steering = paths.some((p) => STEERING_PATH_RE.test(p));
  const lines = changedLines(file.patch);
  const verdicts: Verdict[] = [];

  if (file.binary) {
    return DOC_EXT_RE.test(file.path) && !steering ? done([{ class: "docs", reason: "binary doc asset", promptText: false }]) : done([{ class: "runtime", reason: "binary file", promptText: false }]);
  }
  if (file.modeChanged) verdicts.push({ class: "runtime", reason: "file mode change", promptText: false });
  if (file.deleted && !steering && !DOC_EXT_RE.test(file.path)) verdicts.push({ class: "runtime", reason: "file deleted", promptText: false });

  if (LOCKFILE_RE.test(file.path) && lines.length > 0) verdicts.push({ class: "capability", reason: "dependencies: lockfile changed", promptText: false });
  if (MANIFEST_RE.test(file.path) && lines.length > 0) verdicts.push({ class: "capability", reason: "permissions: slack app manifest changed", promptText: false });
  if (WORKFLOW_RE.test(file.path) && lines.length > 0) verdicts.push({ class: "capability", reason: "ci: workflow changed", promptText: false });
  if (GITHOOK_RE.test(file.path) && lines.length > 0) verdicts.push({ class: "capability", reason: "exec: git hook changed", promptText: false });

  const prose = DOC_EXT_RE.test(file.path) && !steering;
  const test = TEST_PATH_RE.test(file.path);
  for (const { text } of lines) {
    if (text.trim() === "") continue;
    if (PACKAGE_JSON_RE.test(file.path) && DEPENDENCY_LINE_RE.test(text)) {
      verdicts.push({ class: "capability", reason: "dependencies: package.json", promptText: false });
      continue;
    }
    if (prose) {
      verdicts.push({ class: "docs", reason: "prose", promptText: false });
      continue;
    }
    if (steering) {
      const tool = STEERING_TOOL_RE.test(text) ? capabilityOf(text) ?? "tools" : undefined;
      verdicts.push(tool !== undefined ? { class: "capability", reason: `${tool}: tool grant in a steering file`, promptText: true } : { class: "prompt", reason: "steering text (skill, guide or instruction file)", promptText: true });
      continue;
    }
    if (isComment(file.path, text)) {
      verdicts.push({ class: "docs", reason: "comments", promptText: false });
      continue;
    }
    if (test) {
      // tests mention tokens and spawn processes all day: they are runtime (what CI enforces), never lower, not scanned for capabilities
      verdicts.push({ class: "runtime", reason: "tests", promptText: false });
      continue;
    }
    const cap = capabilityOf(text);
    if (cap !== undefined) {
      verdicts.push({ class: "capability", reason: `${cap}: ${text.trim().slice(0, 60)}`, promptText: isPromptText(text) });
      continue;
    }
    if (isPromptText(text)) {
      verdicts.push({ class: "prompt", reason: "prompt text in source", promptText: true });
      continue;
    }
    verdicts.push({ class: "runtime", reason: "code", promptText: false });
  }

  // a patch with no readable lines (empty diff of a rename, say) is still a change to that file
  if (verdicts.length === 0) {
    return done([prose || steering ? { class: steering ? "prompt" : "docs", reason: "rename or empty change", promptText: steering } : { class: "runtime", reason: "rename or empty change", promptText: false }]);
  }
  return done(verdicts);
};

export const classifyDiff = (files: readonly ChangedFile[]): RiskReport => {
  const results = files.map(classifyFile);
  const cls = highest(results.map((r) => r.risk.class));
  const reasons = [...new Set(results.flatMap((r) => r.risk.reasons))];
  return {
    class: cls,
    routing: routingFor(cls, results.some((r) => r.promptText)),
    files: results.map((r) => r.risk),
    reasons,
  };
};

// --- unified diff parsing ---

const stripPrefix = (p: string): string => p.replace(/^[ab]\//, "");

/** Parse `git diff` / `gh pr diff` output into files. Quoted and `/dev/null` paths are handled; unknown lines are ignored. */
export const parseUnifiedDiff = (text: string): ChangedFile[] => {
  const files: ChangedFile[] = [];
  let cur: { path: string; oldPath?: string; patch: string[]; binary: boolean; modeChanged: boolean; deleted: boolean } | undefined;
  const flush = () => {
    if (cur) files.push({ path: cur.path, ...(cur.oldPath !== undefined ? { oldPath: cur.oldPath } : {}), patch: cur.patch.join("\n"), binary: cur.binary, modeChanged: cur.modeChanged, deleted: cur.deleted });
    cur = undefined;
  };
  let inHunk = false;
  for (const raw of text.split("\n")) {
    const header = /^diff --git (?:"?a\/(.+?)"?) (?:"?b\/(.+?)"?)$/.exec(raw);
    // a hunk line always starts with a space, `+`, `-` or `\`, so a line that opens with `diff --git` is never content
    if (header) {
      flush();
      const [, a = "", b = ""] = header;
      cur = { path: b, ...(a !== b ? { oldPath: a } : {}), patch: [], binary: false, modeChanged: false, deleted: false };
      inHunk = false;
      continue;
    }
    if (!cur) continue;
    if (raw.startsWith("@@")) inHunk = true;
    if (inHunk) {
      cur.patch.push(raw);
      continue;
    }
    if (raw.startsWith("rename from ")) cur.oldPath = raw.slice("rename from ".length);
    else if (raw.startsWith("rename to ")) cur.path = raw.slice("rename to ".length);
    else if (raw.startsWith("old mode ") || raw.startsWith("new mode ")) cur.modeChanged = true;
    else if (raw.startsWith("deleted file mode")) cur.deleted = true;
    else if (raw.startsWith("Binary files ") || raw.startsWith("GIT binary patch")) cur.binary = true;
    else if (raw.startsWith("+++ ") && raw !== "+++ /dev/null") cur.path = stripPrefix(raw.slice(4).replace(/^"|"$/g, ""));
  }
  flush();
  return files;
};

export const formatRiskReport = (report: RiskReport): string => {
  const yn = (b: boolean) => (b ? "yes" : "no");
  const lines = [
    `risk class: ${report.class}`,
    `reviewer: ${yn(report.routing.reviewer)}`,
    `verifier: ${yn(report.routing.verifier)}`,
    `probe gate: ${yn(report.routing.probe)}`,
    "files:",
    ...report.files.map((f) => `  ${f.class.padEnd(10)} ${f.path}${f.reasons.length > 0 ? `  (${f.reasons.slice(0, 3).join("; ")})` : ""}`),
  ];
  return lines.join("\n");
};
