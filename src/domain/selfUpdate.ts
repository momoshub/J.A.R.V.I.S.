/**
 * Letting the bot work on its own source.
 *
 * It already can: a full-access turn runs with the shell in the workspace that
 * holds this repository. What it could not do safely was finish the job -
 * restarting to pick up a change kills the very turn that asked for it, so the
 * reply never lands and nobody learns whether it worked.
 *
 * Two rules make this safe rather than merely possible:
 *
 * - the checks are not optional. A bot that restarts into code which does not
 *   compile is a bot that crash-loops, and `KeepAlive` will restart it into the
 *   same broken build every fifteen seconds forever. There is no way back from
 *   inside Slack; somebody has to walk to the machine.
 * - the restart is DEFERRED, never immediate. The request returns first, the
 *   reply posts, and the process exits a few seconds later - so the thread
 *   learns what happened instead of going silent mid-sentence.
 */
import { WORKER_MCP_TRIM_RULE } from "./workerMcp.ts";

/** How long the bot waits before exiting, so a reply can land first. */
export const RESTART_DELAY_MS = 6_000;

/** How often a pending restart looks again while turns are still running. */
export const RESTART_POLL_MS = 5_000;

/**
 * The longest a restart waits for running turns. Waiting for "idle" with no
 * bound meant a bot with several busy threads might never restart, and every
 * thread paid for the slowest one. Past this the turns still running are cut,
 * and the inbox hands each one back to the new process to pick up again.
 */
/**
 * How long a restart waits for running turns before cutting them.
 *
 * Left at fifteen minutes on purpose. The incident that made this painful was
 * a BACKGROUND worker holding it open, and those no longer count towards
 * idleness at all - so what remains is a foreground turn somebody is waiting
 * on, and cutting one of those early is a worse trade than waiting. The
 * silence is handled where it belongs, by telling the thread.
 */
export const RESTART_MAX_WAIT_MS = 15 * 60_000;

/**
 * How long a turn that STARTED while a restart waits may run before it is cut.
 *
 * Holding every new message until the slowest running turn ended left people
 * unanswered for up to the full wait. So new messages still run while a
 * restart waits, but on this budget: most answers fit in it, and one that
 * does not is told to hold on, cut, and picked up again by the next process
 * on the same session. Elapsed time is the signal - nothing is classified up
 * front. Overridable with `RESTART_TURN_BUDGET_MS`.
 */
export const RESTART_TURN_BUDGET_MS = 2 * 60_000;

/** What a thread is told when its turn ran past the budget and is cut for the restart. */
export const RESTART_HOLD_NOTICE = "⏳ đợi em xíu, vài phút em quay lại _(restarting - I will pick this up again in a few minutes)_";

export type IdleRestartDeps = {
  /** True when no turn is running or queued, in any thread. */
  readonly isIdle: () => boolean;
  readonly exit: () => void;
  readonly schedule: (fn: () => void, ms: number) => void;
  readonly log?: (line: string) => void;
  readonly delayMs?: number;
  readonly pollMs?: number;
  /**
   * Called once, as soon as the restart is asked for. New work still runs
   * from here on, but each new turn on a budget (`RESTART_TURN_BUDGET_MS`),
   * so it cannot hold the restart open for long.
   */
  readonly onDrain?: () => void;
  /**
   * True once nothing that started BEFORE the restart was asked for is still
   * running. Without it the intake stays open until the cap.
   */
  readonly settled?: () => boolean;
  /**
   * Called once, the first time `settled` holds while something still runs:
   * stop taking new work, so the budgeted turns left are the last ones and
   * the wait ends within one budget. The gateway keeps queueing meanwhile.
   */
  readonly onSettled?: () => void;
  /** Called right before an exit that cuts turns still running, to mark them. */
  readonly onForce?: () => void;
  readonly maxWaitMs?: number;
};

/**
 * Restart when nothing is in flight, or once the wait runs out. Exiting under
 * a running turn cuts it, so the exit waits the usual delay for the asker's
 * reply to land, then keeps looking until every turn has finished.
 *
 * New messages are still answered while it waits (`onDrain` puts each new
 * turn on a budget), and three things keep the wait bounded. A new turn past
 * its budget is cut and picked up again after the restart. Once the turns
 * from before the request have finished (`settled`), new work stops
 * (`onSettled`), so a steady trickle of messages cannot keep it from ever
 * being idle - what is left ends within one budget. And past `maxWaitMs` it
 * exits anyway, after `onForce` marks what it cut - the inbox redelivers those
 * rows to the new process, which picks each one up on the same session.
 */
export const restartWhenIdle = (deps: IdleRestartDeps): void => {
  const poll = deps.pollMs ?? RESTART_POLL_MS;
  const delay = deps.delayMs ?? RESTART_DELAY_MS;
  const maxWait = deps.maxWaitMs ?? RESTART_MAX_WAIT_MS;
  let waited = 0;
  let logged = false;
  let closed = false;
  deps.onDrain?.();
  const attempt = (): void => {
    if (deps.isIdle()) {
      deps.exit();
      return;
    }
    if (!closed && deps.settled?.()) {
      closed = true;
      deps.log?.("restart: the turns from before it have finished, taking no new work until the last ones end");
      deps.onSettled?.();
    }
    if (waited >= maxWait) {
      deps.log?.(`restart forced: turns still running after ${Math.round(maxWait / 60_000)} min, cutting them to pick up again`);
      deps.onForce?.();
      deps.exit();
      return;
    }
    if (!logged) {
      deps.log?.("restart deferred: turns still running; new messages still run, each on a short budget");
      logged = true;
    }
    waited += poll;
    deps.schedule(attempt, poll);
  };
  deps.schedule(attempt, delay);
};

/**
 * Every change to the bot's own source passes CI before it is merged, and a
 * change to runtime code is read by a second agent first (owner's rule, review
 * by risk since 2026-11-08: docs, prompt text, adapter skills, prompt guides
 * and dashboard UI need no reviewer; logic, commands, adapters and `bin/`
 * scripts get one, for at most fifteen rounds). The session that wrote a fix is the
 * worst judge of it: it shares the blind spot that caused the bug. The reviewer is an
 * Orca worker (owner's call, so it shows on Orca like every other background
 * agent) and the two talk only on the PR: the reviewer posts each round as a
 * real GitHub review (request changes, or approve), the writer answers with a
 * push and a comment saying what changed, and the reviewer re-reads. Orca
 * cannot wake the writer, so the writer polls the PR's reviews for the next
 * one. Each review and comment opens with a marker that says who wrote it - they
 * may share one GitHub account (see `selfPrAccountsRule` for when they do not). GitHub cannot require
 * the check on this plan, so `bin/merge-when-green.sh` is the CI gate.
 */
/** Runs the reviewer as an Orca worker (owner) or as an Agent tool agent in the writer's own process (admin: `orca` is denied below owner). */
export const standaloneReviewRule = (orca = true): string =>
  "review by risk. A PR that only touches docs, prompt text, adapter skills, prompt guides or dashboard UI gets no reviewer: `bun run typecheck` and `bun test` green, CI green through `bin/merge-when-green.sh <pr>` (below), merge. A PR that touches runtime code - logic, commands, adapters, `bin/` scripts - gets a standalone reviewer agent before you merge, and a mixed PR counts as runtime code. " +
  (orca
    ? "The reviewer is an Orca worker, never the Agent tool, never a fork and never the session that wrote the code: open a fresh Run with `orca orchestration run-create --objective <short> --json`. " +
      WORKER_MCP_TRIM_RULE +
      ". For this worker the role is `reviewer`. Then start it with `orca orchestration worker-start --run <runId> --spec-file <brief> --task-title <short> --worktree path:$BOT_WORKER_HOME-reviewer --agent claude --model opus --json` (the reviewer always runs on opus, while writers and verifiers keep `$BOT_WORKER_MODEL`; only if `orca status` says the runtime is not reachable, `ORCA_TERMINAL_HANDLE` is unset, `run-create` refuses it as `terminal_handle_stale` or your tools refuse `orca`, use a background Agent tool reviewer on the same PR-review protocol, and say so). "
    : "The reviewer is a background Agent tool agent (`run_in_background: true`, a self-contained brief) in your own process - never a fork and never the session that wrote the code - and you never run `orca` (it is the owner's: your tools refuse it). ") +
  "Its brief gives the PR url and what the change is for, and tells it the whole review happens on the PR. It reads the diff only through `gh pr diff` / `gh pr view` and never checks out, edits or runs anything in the folder it starts in - that may be a live checkout other sessions share - and if it needs to run the checks it cuts its own `git worktree add` from `origin/<branch>` and removes it after. It reports correctness bugs, regressions, missing tests and stale docs as one real GitHub review whose body starts with `[review round N]` (N from 1) and ends with `VERDICT: clean` or `VERDICT: changes` (changes only for a real blocker): a request-changes review when the verdict is changes, an approving review (with its comments, if any) when it is clean - but GitHub refuses both on a PR the poster opened, so when the PR's author and the reviewer are one account (no split `SELF_PR_AUTHOR` / `SELF_PR_REVIEWER`, or the same login twice) it posts a plain comment review instead (`--comment` / `event` = `COMMENT`) with the same `[review round N]` body and `VERDICT:` line - `gh pr review <pr> --request-changes|--approve --body-file <file>`, and when a point is about specific lines, one `gh api repos/<owner>/<repo>/pulls/<pr>/reviews --input <json>` call (`commit_id` = the head it read, `event` = `REQUEST_CHANGES`, `APPROVE` or `COMMENT`, `body`, `comments` = `[{path, line, side, body}]`) so the inline comments and the verdict land as one review. It then polls the PR every 30s for a `[fix round N]` comment answering that round and re-reviews the head as `[review round N]` - round 2 and later happen only when the previous round is `VERDICT: changes` with a real blocker, and there are at most 15 rounds - even when that fix comment only pushes back or asks and the head did not move - it still counts as a round. It exits when it posts `VERDICT: clean`, after round 15, when the PR is merged or closed, or after 40 minutes with no new `[fix round N]` comment. You never use SendMessage or TaskStop for it. Never end your turn while it is open: wait for its next review in a Bash loop (background, or foreground chunks of up to 10 minutes re-run until the deadline) that polls `gh pr view <pr> --json reviews` for a review whose body starts `[review round N]` (the verdict is the body's `VERDICT:` line, in both modes: `clean` or `changes`; the review state, `APPROVED` / `CHANGES_REQUESTED` / `COMMENTED`, is only a hint and says nothing on one account) and, " +
  (orca
    ? "also stops when `orca orchestration task-list --run <runId> --json` shows the reviewer task completed, failed or blocked (blocked: it stopped without reporting)"
    : "also stops when the reviewer agent has finished (its completion notice reaches you)") +
  " with no new review, and gives up after 30 minutes - a reviewer that died or never answered is a review that is not clean. Fix every real finding on the branch, re-run `bun run typecheck` and `bun test`, push, then post a PR comment that starts with `[fix round N]` (the round you are answering) and answers each review point, finding by finding (fixed how, or pushed back why; a question goes the same way, and an inline review thread may also be answered in the thread itself). After `[review round 15]` with `VERDICT: changes` the reviewer is gone: post no fix comment and wait for nothing until the owner approves an extension. The markers are how each side tells the other apart, even when both post from the same GitHub account: no attribution, no names. Only correctness, regression, test and doc findings block, style nits do not. Up to 15 review rounds: if it is still not clean after the fifteenth, or the reviewer died or went silent, do not merge - leave the PR open, link it and say what is still open, and when the fifteenth round was not clean ask the owner for approval before any further round (an approved extension is the only way past 15). Merge only with `bin/merge-when-green.sh <pr>` from the worktree, after the last push, with a Bash timeout of 600000: it asks the bot to merge (a ticketed `merge-gate` call: the bot, not this shell, holds the merge credential, and merges only when the PR head is that exact commit, the required checks are green on it and, for runtime code, the latest review ends `VERDICT: clean` and a `[verify]` comment ends `VERDICT: verified` and names it; a review or verify written by the PR author or the app does not count), so the writer's ticket names `merge-gate` and a reviewer's or verifier's never does; exit 1 prints why the bot refused (red CI included), exit 3 means CI has not finished so run it again, exit 4 means the PR conflicts with its base and GitHub never runs CI on it - merge the base in, resolve, push and run it again, never just rerun it - and red CI is a finding to fix like any other. Never fall back to a bare `gh pr merge`. Say in your reply what the reviewer found, or that the PR needed none. Never merge runtime code before a clean review, and never merge anything before green CI";

export const STANDALONE_REVIEW_RULE = standaloneReviewRule(true);

/** The two GitHub logins a self-fix PR is split across. */
export type SelfPrAccounts = { readonly author: string; readonly reviewer: string };

/**
 * Both logins or nothing: half a split would leave one step on the wrong
 * account, and one login twice is no second pair of eyes.
 */
export const parseSelfPrAccounts = (author?: string, reviewer?: string): SelfPrAccounts | undefined => {
  const a = author?.trim();
  const r = reviewer?.trim();
  return a && r && a.toLowerCase() !== r.toLowerCase() ? { author: a, reviewer: r } : undefined;
};

/**
 * Owner's rule: the PR is opened by one account and reviewed and merged by
 * another, so GitHub shows a real second pair of eyes. Each command picks its
 * account with `GH_TOKEN=$(gh auth token -u <login>)` rather than `gh auth
 * switch`, which would flip the active account under every other session.
 * A login gh does not hold prints no token, and an empty GH_TOKEN is read as
 * unset, so gh would quietly fall back to the active account: the rule makes
 * that a stop, not a silent post under the wrong name.
 */
export const selfPrAccountsRule = (accounts?: SelfPrAccounts): string => {
  if (!accounts) return "";
  const as = (login: string) => `\`GH_TOKEN=$(gh auth token -u ${login})\``;
  return `GitHub accounts: open the PR and post every \`[fix round N]\` comment as \`${accounts.author}\` (${as(accounts.author)} in front of \`gh pr create\` and \`gh pr comment\`); the reviewer posts every \`[review round N]\` review as \`${accounts.reviewer}\` (say so in its brief, with ${as(accounts.reviewer)} in front of \`gh pr review\` and \`gh api\`); merge as \`${accounts.reviewer}\`: ${as(accounts.reviewer)} in front of \`bin/merge-when-green.sh <pr>\`, which approves the PR as \`${accounts.reviewer}\` right before it merges, so the PR shows a real approval. Check each login first: if \`gh auth token -u <login>\` fails or prints nothing, stop and say so - an empty GH_TOKEN falls back to the active account without a word, and neither side may post or merge under the wrong one (say the same in the reviewer's brief). Never \`gh auth switch\`: it flips the account under every other session`;
};

/**
 * Who writes the change. For the owner it is an Orca worker with its own
 * worker ticket (the turn's ticket dies with the turn, so a writer without one
 * gets stuck at the PR step); below owner `orca` is denied, so the turn writes
 * it itself or hands it to a background Agent tool agent.
 */
const writerRule = (orca: boolean): string =>
  orca
    ? "who writes it: an Orca worker, never the session itself - cheap jobs (a test fixture, a few edits) are done inline, no worker. One writer per job: before any writer starts, take its job through the run helper (`claim take bug:<id>` or `journey:<id>`, and `branch:<name>`): a refusal names the worker (dispatch id) and the thread that already holds it, so follow that one and never start a second writer; right after `worker-start` prints its dispatch id run `claim bind <dispatchId> <the same keys>`, and the claim is released when that worker ends. Open a fresh Run (`orca orchestration run-create --objective <short> --json`), and if the PR goes out as the GitHub App mint the writer's own ticket and bind it, as the parallel guide says (`worker-ticket <owner/repo> pending merge-gate` before `worker-start` - `merge-gate` is the writer's one merge, decided by the bot; a reviewer or verifier is minted none - only the `JARVIS_RUN_TICKET_FILE` path in the brief and never read, print or copy the file, `worker-ticket bind <id> <dispatchId>` after): without one the writer gets stuck at the PR step. " +
      WORKER_MCP_TRIM_RULE +
      ". For this worker the role is `writer`. Then `orca orchestration worker-start --run <runId> --spec-file <brief> --task-title <short> --worktree path:$BOT_WORKER_HOME-writer --agent claude --model \"$BOT_WORKER_MODEL\" --json` and, in the same turn, a `watch worker <dispatchId>` (waiting guide). The brief carries the issue, the cause and the plan, tells the writer to cut its own worktree and run this whole procedure (tests, docs, probe gate, PR, reviewer and verifier workers, merge, e2e watch), to export the ticket file before every github-app helper call and run `bin/github-app.sh ticket-renew <owner/repo>` first once it has run past about 2.5 hours, and that it does NOT restart you: it reports back and you run the restart helper. You only orchestrate: start the writer, set the watch, post progress in the thread, relay the result. Orca unreachable or refused (`orca status`, `ORCA_TERMINAL_HANDLE` unset, `terminal_handle_stale`) -> say so, then write it inline"
    : "who writes it: you, in the worktree, or a background Agent tool agent in your own process with a self-contained brief - never `orca`, it is the owner's and your tools refuse it. Cheap jobs are done inline. One writer per job: take it first through the run helper (`claim take bug:<id>` or `branch:<name>`); a refusal names who holds it, so follow that one and never start a second writer (an unbound claim lapses after 30 minutes)";

/** Docs, tests and the probe gate: what has to be true again before the PR goes out. */
const shipRules = `- docs and tests move with the code, in the same branch and PR, never as a follow-up. Any behaviour change adds or adjusts tests next to it (\`*.test.ts\`): a removed behaviour removes its test, a renamed thing renames it, a change with no test is a change nobody can keep. Before committing, grep the docs for what you touched (file names, function names, env vars, commands, settings) and fix every stale line: \`CLAUDE.md\` (architecture list, conventions, the "Key facts" entry of the area; a new non-obvious mechanism gets its own entry), \`ARCHITECTURE.md\`, \`README.md\`, \`.env.example\` and \`src/config/env.ts\` comments, command help text, and any memory skill that describes the area (those live in the memory adapter: change them through its export and import, never by editing a mirror folder). A pure refactor may touch no doc, but say "no doc change: internal only" in the PR body. Quick check: \`git diff --name-only origin/main\` with \`src/\` changed and no \`*.test.ts\` or doc means stop and ask why
- \`bun run typecheck\` and \`bun test\` in the worktree, both green before you push
- probe gate: a change to system prompt text, a prompt guide or an adapter skill first runs \`bun bin/probe-harness.ts --path <file> --base-ref origin/main\` (\`--dry-run\` shows the spend; \`--base <f> --candidate <f>\` for a skill that is not in the repo) and pastes the report (wins, losses, ties, contrasts) into the PR body. A candidate that loses more than it wins is rethought before the merge. Replay cases live in \`docs/probe-cases/\`: no real ids or private Slack text there, the repo is public`;

/** Verifier: runtime code only, a separate agent that runs the change. */
const verifierRule = (orca: boolean): string =>
  `- verifier (runtime code only, docs, prompt text and skills skip it like they skip the reviewer): the reviewer reads the diff, a separate verifier runs the change. After the PR is open, start ${orca ? "an Orca worker in a fresh Run (writers and verifiers keep \"$BOT_WORKER_MODEL\"; only the reviewer runs on opus)" : "a background Agent tool agent"} with fresh context (role \`verifier\`: \`"$BOT_WORKER_MCP_TRIM" --role verifier\` and \`--worktree path:$BOT_WORKER_HOME-verifier\`, as above), never the writer and never a fork. Its brief is built from sources the writer did not write, never from the PR description or the writer's own account of the fix: \`bun bin/verify-brief.ts brief --pr <pr> --out <brief file>\` assembles it from the diff's paths (the boundaries they cross, each with the adversarial and escalation cases to try, the policy docs, the regression history of those files, past \`[review round]\` blockers and the contracts: tests, system-model tests, help, env), and you hand the verifier that file plus the PR url${orca ? "; pick its agent with `eval \"$(bun bin/verify-brief.ts agent --model \"$BOT_WORKER_MODEL\")\"` and start it with `--agent \"$VERIFIER_AGENT\" ${VERIFIER_MODEL:+--model \"$VERIFIER_MODEL\"}` (another model family such as codex when the host has one, else claude with a note that the family is shared: the verdict repeats it; run `agent` first, stop if `$VERIFIER_AGENT` is empty, and give the brief `--agent-note \"$VERIFIER_NOTE\"`)" : ""}. It follows the repo's \`.claude/skills/verify/SKILL.md\`, tries at least one adversarial or escalation case per boundary of the brief and not only the happy path, runs the change on the PR head and posts its evidence, an \`Exercised: <ids>\` line naming every brief item it tried (or \`n/a <id>: <reason>\`) and \`VERDICT: verified|failed\` as a PR comment; \`bun bin/verify-brief.ts check --brief <brief file> --comment <comment file>\` must pass on it, and a \`verified\` that leaves an item out is not verified. You never call your own PR verified: no verifier comment on the current head, or a failed one, is not verified, and a push after the verdict makes it stale, so it runs again`;

/**
 * Flow audit: every PR, after the reviewer and verifier and before the merge, a
 * read-only opus auditor checks the review FLOW (claims against the record), not the code.
 */
export const flowAuditRule = (orca: boolean): string =>
  `- flow audit (every PR, docs-only ones too; after the reviewer and verifier, before the merge): the reviewer reads the diff and the verifier runs it, a separate read-only auditor checks the review FLOW, not the code: every \`[fix round N]\` claim against the real diff, every reviewer verdict naming a sha with no push after the last clean review that was not re-reviewed, the verifier on the exact head, every probe-gate figure with a report behind it on that sha, every "CI green" matching a check run on that exact sha, the round cap and the owner's approvals, and what you (the coordinator) reported. When the PR is otherwise ready (last push made, review clean and verified where they apply, CI green), start ${orca ? "an Orca worker in a fresh Run on opus (`--agent claude --model opus`; role `reviewer`: `\"$BOT_WORKER_MCP_TRIM\" --role reviewer` and `--worktree path:$BOT_WORKER_HOME-reviewer`, as above, so it cannot edit, push or merge)" : "a background Agent tool agent on opus (`model: \"opus\"`)"} with fresh context, never the writer, the reviewer or the verifier, and never a fork: the verifier and the flow auditor are two separate workers and the gate wants both a \`[verify]\` and a \`[flow-audit]\`. Its brief is built by \`bun bin/flow-audit-brief.ts brief --pr <pr> --out <brief file> --claims-file <file holding your own report so far>\`, run from a checkout of origin/main and never the PR branch (the policy it quotes and the gaps it computes must not come from a diff that edits them): it lists every push sha with its time, every review and verify comment with the sha it names, the check runs per sha and the gaps a script can compute (a push after the last clean review, a verify sha that is not the head, CI not on the head, a figure with no artifact, the round cap). It audits read-only (\`gh pr view\`, \`gh pr diff\`, \`gh api\`; it never checks out, edits or runs anything in its folder) and posts ONE PR comment: \`[flow-audit]\`, a \`HEAD: <sha>\` line, a claims table (each claim SUPPORTED, UNSUPPORTED or FALSE) and, as its only \`VERDICT:\` line and its last, \`VERDICT: clean\` or \`VERDICT: bullshit found\`; \`bun bin/flow-audit-brief.ts check --comment <file> --sha <head>\` must accept it. \`VERDICT: bullshit found\` blocks the merge: fix what the table shows (a missing re-review, a stale verify, a claim the diff does not back, an unbacked figure) through the same steps, never by editing or answering its comment, and start the audit again on the new head - a push after the audit makes it stale. With \`MERGE_GATE_FLOW_AUDIT=on\` the bot refuses the merge without a \`[flow-audit]\` comment of an attester that ends \`VERDICT: clean\` and names the head; with it off the stage is still yours to run. You never call your own flow audited, and the writer's own account of the flow is never the audit`;

/** After the merge: the checks that only run on main, then pull, restart and the watch on it. */
const landRules = (restartScript: string, repoPath: string): string => `- after the merge, watch the e2e: the merge to main starts the \`e2e\` workflow (real Slack), which never runs on a PR, so a green PR says nothing about it. Find its run for the merge commit (\`gh run list -w e2e -c <merge sha>\`) and set a watch on it (waiting guide), never assume it passes. Green: done. Red: it is your break, fix it at once in a new PR through this same procedure, no asking first. Cannot fix it (cause unclear, a big fix, or the fix PR is red too): revert the merged PR (\`git revert -m 1 <merge sha>\` in a worktree, a PR, \`bin/merge-when-green.sh\`) so main is green again, then tell the owner what broke. Never leave main red, and never merge the next PR on top of a red e2e without saying so
- once merged and the e2e is watched, \`git -C ${repoPath} pull --no-rebase\` to bring it into the main folder, remove the worktree, and for a code change only then restart with \`${restartScript}\` (docs only: no restart). It runs \`bun run typecheck\` and \`bun test\`, and only restarts you if BOTH pass. It will refuse on a red build, which is the point: you would come back into code that does not compile, and \`KeepAlive\` would restart you into it every fifteen seconds until a human walked to the machine
- after the restart helper never ask anyone to ping you: set a watch (waiting guide) whose shell check passes once the old \`bun run src/index.ts\` process has exited and a new one listens on the dashboard port (\`lsof -tiTCP:<DASHBOARD_PORT, 2002 by default> -sTCP:LISTEN\`), then carry on. Never watch \`src/gateway.ts\`: the gateway never restarts, so that watch never fires`;

const fullRules = (repoPath: string, restartScript: string, accounts?: SelfPrAccounts, orca = true): string => `

Working on your own source (${repoPath}):
- you may read it like any other repository, but never edit it in place: other sessions share that folder, and two of them editing it at once is how changes get lost or tangled. It is Bun + TypeScript, functional, no classes, no \`any\`, and local imports carry \`.ts\`. Memory may add specifics of this instance (accounts, people, hosts) to what follows, never replace a step of it
- every change goes this way, docs-only ones too: \`git fetch\`, \`git worktree add .claude/worktrees/<name> -b <branch> origin/main\`, edit and test there, push the branch, open a PR, merge it yourself once it is reviewed and green
- ${writerRule(orca)}
${shipRules}
- ${standaloneReviewRule(orca)}
${verifierRule(orca)}
${flowAuditRule(orca)}${accounts ? `\n- ${selfPrAccountsRule(accounts)}` : ""}
- a PR description and commits carry no attribution at all: no "Generated with ..." line (Jarvis or Claude Code) and no co-author trailer
${landRules(restartScript, repoPath)}
- the restart waits a few seconds so your reply lands first, then holds until no turn is running in any thread. New messages are still answered meanwhile, each on a short budget (\`RESTART_TURN_BUDGET_MS\`, ${Math.round(RESTART_TURN_BUDGET_MS / 60_000)} minutes unless set otherwise): one that runs past it tells its thread to hold on and is cut, then picked up again after the restart on the same session. Once the turns from before the restart finish it takes no new message (they queue in the inbox, nothing is lost). If turns are still running after ${Math.round(RESTART_MAX_WAIT_MS / 60_000)} minutes it restarts anyway, and each turn it cut is picked up again by the new process on the same session. Say what you changed and that I restart once idle, then expect to be a new process - anything you were part-way through is gone
- never restart to "see if that fixed it". Run the checks, read what they say, and decide
- a change left uncommitted in the main folder is not finished: it blocks the next pull and gets swept into someone else's commit`;

/**
 * The self-update block of the chat prompt: always the whole procedure.
 *
 * It used to shrink to a pointer at "the skill in your memory" whenever an
 * adapter skill was visible. That put the procedure in the instance's database,
 * where a clone of the repository never gets it - and the memory copy had
 * drifted: it lacked the worker-ticket step the static parallel guide had, so
 * writers never got a ticket. The framework's rules now live here, in the
 * codebase. Memory may still add what is specific to one instance.
 *
 * A turn that can read files gets it as the `self-fix` guide behind a one-line
 * index entry (see `promptGuides.ts`); one that cannot keeps it inline.
 */
export const selfUpdateRules = (
  repoPath?: string,
  restartScript?: string,
  accounts?: SelfPrAccounts,
  /** False below owner: the writer and reviewer are then Agent tool agents, `orca` is denied. */
  orca = true,
): string => {
  if (!repoPath || !restartScript) return "";
  return fullRules(repoPath, restartScript, accounts, orca);
};
