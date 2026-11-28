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
 * The path picks the comment syntax and whether a
 * markdown file is loaded by an agent, and a path can lower a class in exactly
 * one way: a file whose every path (old and new) is a doc path that cannot run
 * (`.md`, `.rst`, images, pdf, LICENSE/NOTICE, outside the steering paths) is
 * `docs`; any other path is at least `runtime`. The class of a
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
const LOCKFILE_RE = /(?:^|\/)(?:bun\.lockb?|package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|poetry\.lock|uv\.lock|Pipfile\.lock|Gemfile\.lock|composer\.lock|go\.sum)$/;
/** Manifests and requirement lists of other ecosystems: what they name is what gets installed. */
const DEPENDENCY_FILE_RE = /(?:^|\/)(?:requirements[\w.-]*\.txt|constraints[\w.-]*\.txt|Pipfile|Cargo\.toml|pyproject\.toml|go\.mod|Gemfile|composer\.json)$/;
const PACKAGE_JSON_RE = /(?:^|\/)package\.json$/;
const WORKFLOW_RE = /(?:^|\/)\.github\/(?:workflows|actions)\//;
const MANIFEST_RE = /(?:^|\/)slack-app-manifest\.ya?ml$/;
const TEST_PATH_RE = /(?:^|\/)(?:tests?|e2e|__tests__)\/|\.(?:test|spec|e2e)\.[cm]?[tj]sx?$/;
const GITHOOK_RE = /(?:^|\/)\.githooks\//;

/** Markdown an agent loads as instructions: skills, agents, guides, probe replay cases, the repo's own instruction files. */
const STEERING_PATH_RE = /(?:^|\/)(?:CLAUDE|AGENTS|GEMINI)(?:\.local)?\.md$|(?:^|\/)SKILL\.md$|(?:^|\/)\.claude\/(?!settings)[^/]+\/.*\.md$|(?:^|\/)\.claude\/(?:skills|agents|commands)\/|(?:^|\/)\.github\/(?:copilot-instructions\.md|instructions\/)|(?:^|\/)prompt-guides\/|(?:^|\/)docs\/probe-cases\//i;
// Only what cannot run or name a dependency: no svg (a `<script>`), no txt (`requirements.txt`), no mdx (compiled JSX with expressions)
const DOC_EXT_RE = /\.(?:md|rst|png|jpe?g|gif|webp|ico|pdf)$|(?:^|\/)(?:LICENSE|NOTICE|SECURITY\.md)$/i;
const SLASH_COMMENT_EXT_RE = /\.(?:ts|tsx|js|jsx|mjs|cjs|css|scss|java|go|rs|c|h|cpp)$/;
const HASH_COMMENT_EXT_RE = /\.(?:sh|bash|zsh|ya?ml|toml|py|rb|env|example|gitignore|gitleaksignore)$|(?:^|\/)\.env[\w.]*$|(?:^|\/)\.githooks\//;

/** Consume `*/`-closed block comments and a `//` tail from the left; anything else left over is code (`/* a */ run(x) /* b */`). */
const uncomment = (line: string): string => line.replace(/^\s*(?:\/\/+|\/\*+|\*+\/?)/, "").replace(/\*\/\s*$/, "");

function commentsOnly(line: string, inBlock: boolean): boolean {
  let rest = line.trim();
  if (inBlock) {
    const close = rest.indexOf("*/");
    if (close < 0) return true;
    rest = rest.slice(close + 2).trim();
  }
  for (;;) {
    if (rest === "" || rest.startsWith("//")) return true;
    if (!rest.startsWith("/*")) return false;
    const close = rest.indexOf("*/", 2);
    if (close < 0) return true;
    rest = rest.slice(close + 2).trim();
  }
}

function isComment(path: string, line: string, inBlock: boolean): boolean {
  const t = line.trim();
  if (t === "") return true;
  if (SLASH_COMMENT_EXT_RE.test(path)) {
    // a `// @ts-ignore` or `/* istanbul ignore */` steers a tool, it is not prose
    if (/@ts-(?:ignore|expect-error|nocheck)|eslint-disable|biome-ignore|istanbul ignore/.test(t)) return false;
    if (t.startsWith("//")) return true;
    // inside a block comment, or opening one: a comment only if nothing but comments is on the line
    if (inBlock || t.startsWith("/*")) return commentsOnly(t, inBlock);
    // a `*` or `*/` line that is not provably inside a block comment (no opener in view) is scanned as code
    return false;
  }
  // `# coding: utf_7` is a comment Python obeys: it can turn a later "comment" into code
  if (HASH_COMMENT_EXT_RE.test(path)) return t.startsWith("#") && !t.startsWith("#!") && !/coding[:=]/i.test(t);
  return false;
}

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

// `inBlock`: between a block-comment opener and its closer, as far as the hunk (context lines included) shows
type Line = { readonly sign: "+" | "-"; readonly text: string; readonly inBlock: boolean };

/**
 * The added and removed lines of a patch (a removed guard is as much a change
 * as an added one), each with whether it sits inside a block comment. The old
 * and the new side keep their own state, fed by the context lines they share;
 * a hunk that starts mid-comment shows no opener, so its lines read as code.
 */
const changedLines = (patch: string): Line[] => {
  const out: Line[] = [];
  let oldBlock = false;
  let newBlock = false;
  const next = (open: boolean, text: string): boolean => {
    const t = text.trim();
    if (open) return !t.includes("*/");
    return t.startsWith("/*") && !t.slice(2).includes("*/");
  };
  for (const raw of patch.split("\n")) {
    // a patch starts at its first `@@`, so a `+++` or `---` here is a changed line that begins with `++` or `--`, never a header
    if (raw.startsWith("@@")) {
      oldBlock = false;
      newBlock = false;
    } else if (raw.startsWith("+")) {
      out.push({ sign: "+", text: raw.slice(1), inBlock: newBlock });
      newBlock = next(newBlock, raw.slice(1));
    } else if (raw.startsWith("-")) {
      out.push({ sign: "-", text: raw.slice(1), inBlock: oldBlock });
      oldBlock = next(oldBlock, raw.slice(1));
    } else {
      const text = raw.startsWith(" ") ? raw.slice(1) : raw;
      oldBlock = next(oldBlock, text);
      newBlock = next(newBlock, text);
    }
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
  const lines = file.binary ? [] : changedLines(file.patch);
  const verdicts: Verdict[] = [];

  // a binary file has no lines to read, but it is not docs by its new path alone: a rename out of a workflow or source file keeps that class,
  // so it falls through to the path checks below instead of returning here
  if (file.binary) {
    verdicts.push(paths.every((p) => DOC_EXT_RE.test(p)) && !steering ? { class: "docs", reason: "binary doc asset", promptText: false } : { class: "runtime", reason: "binary file", promptText: false });
  }
  if (file.modeChanged) verdicts.push({ class: "runtime", reason: "file mode change", promptText: false });
  if (file.deleted && !steering && !paths.every((p) => DOC_EXT_RE.test(p))) verdicts.push({ class: "runtime", reason: "file deleted", promptText: false });

  // a rename or delete changes a file whose old path counts too, even with no changed line
  const moved = lines.length > 0 || file.deleted === true || file.binary === true || paths.length > 1;
  const any = (re: RegExp): boolean => moved && paths.some((p) => re.test(p));
  if (any(LOCKFILE_RE)) verdicts.push({ class: "capability", reason: "dependencies: lockfile changed", promptText: false });
  if (any(DEPENDENCY_FILE_RE)) verdicts.push({ class: "capability", reason: "dependencies: manifest or requirements file changed", promptText: false });
  if (any(MANIFEST_RE)) verdicts.push({ class: "capability", reason: "permissions: slack app manifest changed", promptText: false });
  if (any(WORKFLOW_RE)) verdicts.push({ class: "capability", reason: "ci: workflow changed", promptText: false });
  if (any(GITHOOK_RE)) verdicts.push({ class: "capability", reason: "exec: git hook changed", promptText: false });

  // prose only when every path the file had is a doc path: a rename out of source into `.md` is still that source
  const prose = paths.every((p) => DOC_EXT_RE.test(p)) && !steering;
  const test = TEST_PATH_RE.test(file.path);
  // A hunk cannot show whether a line is inside a multi-line template string: `/*` and `//` lines there are text, and a backtick on a changed line
  // can end the string and start code. A source patch with a backtick or a continued line (trailing backslash) therefore reads no line as a comment.
  // `${` runs code inside a template without a backtick, and in JSX a `{...}` between tags does too, so both count (JSX: any brace in the patch).
  const fragile = SLASH_COMMENT_EXT_RE.test(file.path) && (/`|\\$|\$\{/m.test(file.patch) || (/\.[jt]sx$/.test(file.path) && /[{}]/.test(file.patch)));
  for (const { text, inBlock } of lines) {
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
    if (!fragile && isComment(file.path, text, inBlock)) {
      // a hunk cannot show whether a comment-looking line sits inside a multi-line string, where it is prompt text: steering prose there is read as a prompt (a reviewer, no probe gate)
      verdicts.push(SLASH_COMMENT_EXT_RE.test(file.path) && isPromptText(uncomment(text)) ? { class: "prompt", reason: "comment that reads as steering text (may be inside a string)", promptText: false } : { class: "docs", reason: "comments", promptText: false });
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
