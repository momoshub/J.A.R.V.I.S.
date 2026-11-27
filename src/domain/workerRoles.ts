/**
 * What an Orca worker may do, by role.
 *
 * Every worker used to start with the same tools, so a reviewer could push and a
 * writer could merge by a line in a prompt and nothing else. A role profile is the
 * same mechanism as the MCP exclusion (`workerMcp.ts`): a session reads the project
 * settings of its working directory once, when it starts, and Orca has no per-launch
 * way in. One shared worker home cannot hold different settings for workers that
 * run at the same time, so each role has a home of its own, `<worker home>-<role>`,
 * which `bin/worker-mcp-trim.ts --role <role>` creates, registers with Orca and
 * writes: `permissions.allow` / `permissions.deny` from the profile below and the
 * host's MCP exclusions (`WORKER_MCP_DENY` plus `WORKER_ROLE_MCP_DENY` for the role).
 *
 * What is enforced and what is not: a `deny` rule is checked by the session before
 * it runs a tool, whatever its permission mode. The `allow` list is the surface the
 * role is meant to use, so a worker is not stopped by a prompt on every `gh pr view`;
 * a command outside both asks for approval, and the watch reports a worker parked
 * on one. Both match command prefixes, so a deliberate `bash -c "..."` wrapper is
 * not caught: this takes away the capabilities a role never needs, it is not a
 * sandbox (the credentials a shell can read are a separate boundary).
 */

const asRecord = (v: unknown): Record<string, unknown> | undefined =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;

export const WORKER_ROLES = ["writer", "reviewer", "verifier", "investigator"] as const;
export type WorkerRole = (typeof WORKER_ROLES)[number];

export const isWorkerRole = (v: unknown): v is WorkerRole => typeof v === "string" && (WORKER_ROLES as readonly string[]).includes(v);

/** Env var a turn carries with the per-role MCP exclusions (`reviewer=a,b;verifier=c`). */
export const WORKER_ROLE_MCP_DENY_ENV = "BOT_WORKER_ROLE_MCP_DENY";

export type RoleProfile = {
  /** Tool rules the role is meant to use (`Bash(gh pr view:*)`, `Read`). */
  readonly allow: readonly string[];
  /** Tool rules the session refuses, whatever it is asked. */
  readonly deny: readonly string[];
};

/**
 * One `Bash(...)` rule per command prefix. A prefix is written `git push:*` (anything after it) or
 * bare (`pwd`, exactly that command). The session reads a rule that mixes an inner `*` with the
 * trailing `:*` as a literal prefix that never matches, so a prefix with an inner `*` (`git -C * push`)
 * is emitted in the wildcard form instead (`Bash(git -C * push*)`).
 */
const rule = (prefix: string): string => {
  if (!prefix.endsWith(":*")) return `Bash(${prefix})`;
  const body = prefix.slice(0, -2);
  return body.includes("*") ? `Bash(${body}*)` : `Bash(${prefix})`;
};
const bash = (...prefixes: string[]): string[] => prefixes.map(rule);
/**
 * A worker picks its GitHub account with an assignment in front of the command
 * (`GH_TOKEN=$(gh auth token -u x) gh pr merge`). The session strips a literal assignment before it
 * matches a rule, but not one with a command substitution (checked on 2.1.285: the plain prefix rule
 * denied `GH_TOKEN=x git push` and let `GH_TOKEN=$(echo x) gh pr merge` through), so every denied
 * command also gets the same rule behind any assignment, and every allowed `gh` one the form a worker uses.
 */
const denyBash = (...prefixes: string[]): string[] => prefixes.flatMap((p) => [rule(p), rule(`*=* ${p.endsWith(":*") ? p.slice(0, -2) : p}:*`)]);
const withAssignment = (rules: readonly string[]): string[] =>
  rules.flatMap((r) => (r.startsWith("Bash(gh ") ? [r, `Bash(*=* ${r.slice("Bash(".length, -1).replace(/:\*$/, "")}*)`] : [r]));
/** A helper script is called by absolute path, so the rule matches the name wherever it lives. */
const githubApp = (...actions: string[]): string[] => actions.map((a) => `Bash(*github-app.sh ${a}*)`);

const READ_TOOLS = ["Read", "Grep", "Glob", "WebFetch", "WebSearch"];
const READ_SHELL = bash("ls:*", "cat:*", "head:*", "tail:*", "wc:*", "grep:*", "rg:*", "find:*", "jq:*", "sort:*", "diff:*", "pwd", "echo:*", "date:*", "sleep:*", "mkdir:*", "cd:*");
/**
 * Reads of the repository and of GitHub, the part every role shares. A worker is not inside the
 * repository, so it runs `cd <repo> && git ...`: each part is matched on its own. `git -C <dir>` is
 * not allowed: a wildcard before the subcommand would also approve `-c` options that run commands.
 */
const READ_GIT = bash("git status:*", "git log:*", "git show:*", "git diff:*", "git rev-parse:*", "git ls-files:*", "git branch --show-current", "git fetch:*", "git worktree list:*");
const READ_GH = bash("gh pr view:*", "gh pr diff:*", "gh pr checks:*", "gh pr list:*", "gh run list:*", "gh run view:*", "gh issue view:*", "gh issue list:*", "gh repo view:*", "gh auth token:*");
/** `orca orchestration` is how a worker asks, escalates and reports. */
const ORCA = bash("orca orchestration:*");
const RUN_CHECKS = bash("bun run typecheck", "bun test:*", "bun install:*", "bun run:*");

/** An API call that changes anything but a review or a comment. */
const GH_API_MUTATIONS = [
  "gh api*-X PUT", "gh api*-X DELETE", "gh api*-X PATCH", "gh api*--method PUT", "gh api*--method DELETE", "gh api*--method PATCH",
  "gh api*--method=PUT", "gh api*--method=DELETE", "gh api*--method=PATCH", "gh api*/merge", "gh api*/git/refs", "gh api*/contents/",
];
/** Every way to put a commit, a branch or a merge on the remote or into a checkout the role does not own. */
const GIT_WRITES = denyBash("git push:*", "git -C * push:*", "git commit:*", "git -C * commit:*", "git add:*", "git -C * add:*", "git merge:*", "git -C * merge:*", "git rebase:*", "git reset:*", "git cherry-pick:*", "git revert:*", "git tag:*", "git stash:*", "git checkout:*", "git switch:*", "git restore:*", "git apply:*", "git am:*");
const RAW_MERGE = [...denyBash("gh pr merge:*"), ...githubApp("pr-merge"), ...denyBash(...GH_API_MUTATIONS.map((m) => `${m}:*`))];

/**
 * The profiles. Read-only roles (reviewer, investigator) get no editing tool and no
 * way to push or merge; a reviewer may also post a review or comment and cut its own
 * `git worktree` to run the checks; the verifier runs the change in a checkout of its
 * own and comments its verdict; the writer does everything but merge by hand: its one
 * way to land a PR is `bin/merge-when-green.sh`, a script whose own `gh` calls are not
 * subject to the writer's rules.
 */
export const ROLE_PROFILES: Readonly<Record<WorkerRole, RoleProfile>> = {
  writer: {
    allow: withAssignment([...READ_TOOLS, "Edit", "Write", "NotebookEdit", ...READ_SHELL, ...READ_GIT, ...READ_GH, ...ORCA, ...RUN_CHECKS,
      ...bash("git:*", "gh pr create:*", "gh pr edit:*", "gh pr comment:*", "gh pr review:*", "gh api:*", "bash bin/*", "bin/*", "*/bin/merge-when-green.sh:*", "*/bin/github-app.sh:*"),
    ]),
    deny: [...RAW_MERGE, ...denyBash("gh auth switch:*", "gh pr close:*")],
  },
  reviewer: {
    allow: withAssignment([...READ_TOOLS, "Write", ...READ_SHELL, ...READ_GIT, ...READ_GH, ...ORCA, ...RUN_CHECKS,
      ...bash("gh pr review:*", "gh pr comment:*", "gh api:*", "git worktree add:*", "git worktree remove:*", "git worktree prune"),
      ...githubApp("comment"),
    ]),
    deny: [
      "Edit", "NotebookEdit", ...GIT_WRITES, ...RAW_MERGE,
      ...denyBash("gh pr create:*", "gh pr edit:*", "gh pr close:*", "gh pr reopen:*", "gh pr ready:*", "gh pr ready", "gh issue create:*", "gh issue edit:*", "gh issue close:*", "gh release:*", "gh auth switch:*"),
      ...githubApp("pr-create", "pr-edit", "pr-close", "pr-reopen", "labels-add", "labels-remove", "reviewers-request", "git", "push", "review", "ticket-renew"),
    ],
  },
  verifier: {
    allow: withAssignment([...READ_TOOLS, "Write", ...READ_SHELL, ...READ_GIT, ...READ_GH, ...ORCA, ...RUN_CHECKS,
      ...bash("gh pr comment:*", "gh api:*", "git worktree add:*", "git worktree remove:*", "git worktree prune"),
      ...githubApp("comment"),
    ]),
    deny: [
      "Edit", "NotebookEdit", ...GIT_WRITES, ...RAW_MERGE,
      ...denyBash("gh pr create:*", "gh pr edit:*", "gh pr close:*", "gh pr reopen:*", "gh pr review:*", "gh issue create:*", "gh issue edit:*", "gh issue close:*", "gh release:*", "gh auth switch:*"),
      ...githubApp("pr-create", "pr-edit", "pr-close", "pr-reopen", "labels-add", "labels-remove", "reviewers-request", "git", "push", "review", "ticket-renew"),
    ],
  },
  investigator: {
    allow: withAssignment([...READ_TOOLS, ...READ_SHELL, ...READ_GIT, ...READ_GH, ...ORCA, ...bash("gh api:*")]),
    deny: [
      "Edit", "Write", "NotebookEdit", ...GIT_WRITES, ...RAW_MERGE,
      ...denyBash("git worktree add:*", "git worktree remove:*", "git -C * worktree add:*", "gh pr create:*", "gh pr edit:*", "gh pr close:*", "gh pr reopen:*", "gh pr review:*", "gh pr comment:*", "gh issue create:*", "gh issue edit:*", "gh issue comment:*", "gh issue close:*", "gh release:*", "gh auth switch:*"),
      ...githubApp("pr-create", "pr-edit", "pr-close", "pr-reopen", "comment", "labels-add", "labels-remove", "reviewers-request", "git", "push", "review", "ticket-renew"),
    ],
  },
};

/** The folder a role's workers start in: next to the shared worker home, never inside it. */
export const roleHomeDir = (workerHome: string, role: WorkerRole): string => `${workerHome.replace(/\/+$/, "")}-${role}`;

/**
 * `WORKER_ROLE_MCP_DENY`: `reviewer=pg-prod,ch-ro;verifier=pg-prod`, servers kept out of
 * one role's workers on top of `WORKER_MCP_DENY`. An unknown role or a blank entry is
 * ignored (and named in `unknown`, so boot can warn instead of silently excluding nothing).
 */
export const parseRoleMcpDeny = (raw: string | undefined): { deny: Partial<Record<WorkerRole, string[]>>; unknown: string[] } => {
  const deny: Partial<Record<WorkerRole, string[]>> = {};
  const unknown: string[] = [];
  for (const part of (raw ?? "").split(";")) {
    const [role, names] = part.split("=", 2).map((s) => s.trim());
    if (!role) continue;
    if (!isWorkerRole(role)) {
      unknown.push(role);
      continue;
    }
    const list = (names ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    deny[role] = [...new Set([...(deny[role] ?? []), ...list])];
  }
  return { deny, unknown };
};

/** The servers one role's workers lose: the host-wide list plus the role's own, once each. */
export const roleMcpDeny = (all: readonly string[], raw: string | undefined, role: WorkerRole): string[] => [
  ...new Set([...all, ...(parseRoleMcpDeny(raw).deny[role] ?? [])]),
];

export type ProfileResult = { ok: true; text: string; changed: boolean } | { ok: false; error: string };

/**
 * `existing` (the text of a role home's settings file, or nothing) with the role's
 * `permissions.allow` and `permissions.deny` set. A role home belongs to the helper, so the two lists
 * are replaced, not merged: a profile that lost a rule loses it in the folder too.
 * Everything else in the file stays; a file that is not a settings object is refused.
 */
export const applyRoleProfile = (existing: string | undefined, role: WorkerRole): ProfileResult => {
  let settings: Record<string, unknown> = {};
  if (existing !== undefined && existing.trim() !== "") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(existing);
    } catch {
      return { ok: false, error: "the settings file is not valid JSON; fix or remove it by hand" };
    }
    const record = asRecord(parsed);
    if (!record) return { ok: false, error: "the settings file is not a JSON object; fix or remove it by hand" };
    settings = record;
  }
  const permissions = settings.permissions;
  if (permissions !== undefined && !asRecord(permissions)) {
    return { ok: false, error: "`permissions` in the settings file is not an object; fix it by hand" };
  }
  const profile = ROLE_PROFILES[role];
  const next = { ...settings, permissions: { ...asRecord(permissions), allow: [...profile.allow], deny: [...profile.deny] } };
  const text = `${JSON.stringify(next, null, 2)}\n`;
  return { ok: true, text, changed: text !== existing };
};

/** The profile a settings file carries, or undefined when it holds none; the helper's check that a role home is set. */
export const profileOf = (text: string): { allow: string[]; deny: string[] } | undefined => {
  try {
    const p = asRecord(asRecord(JSON.parse(text))?.permissions);
    const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
    return p ? { allow: list(p.allow), deny: list(p.deny) } : undefined;
  } catch {
    return undefined;
  }
};
