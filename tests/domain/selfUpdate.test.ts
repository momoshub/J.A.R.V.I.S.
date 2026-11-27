import { describe, expect, test } from "bun:test";
import {
  RESTART_DELAY_MS,
  RESTART_MAX_WAIT_MS,
  RESTART_HOLD_NOTICE,
  RESTART_TURN_BUDGET_MS,
  STANDALONE_REVIEW_RULE,
  restartWhenIdle,
  selfPrAccountsRule,
  selfUpdateRules,
} from "../../src/domain/selfUpdate.ts";

const rules = selfUpdateRules("/repo", "/bin/jarvis-restart.sh");
const agentRules = selfUpdateRules("/repo", "/bin/jarvis-restart.sh", undefined, false);

describe("selfUpdateRules is the whole procedure, from the codebase", () => {
  test("never defers to a memory skill", () => {
    // a clone of the repository has no memory: the rules ride in the code
    expect(rules).not.toContain("read the skill in your memory");
    expect(rules).toContain("Memory may add specifics of this instance");
    expect(rules).toContain("never replace a step of it");
  });

  test("the writer is an Orca worker with its own ticket, the session only orchestrates", () => {
    expect(rules).toContain("who writes it: an Orca worker, never the session itself");
    expect(rules).toContain("cheap jobs (a test fixture, a few edits) are done inline");
    expect(rules).toContain("`worker-ticket <owner/repo> pending` before `worker-start`");
    expect(rules).toContain("worker-ticket bind <id> <dispatchId>");
    expect(rules).toContain("never read, print or copy the file");
    expect(rules).toContain("without one the writer gets stuck at the PR step");
    expect(rules).toContain("`bin/github-app.sh ticket-renew <owner/repo>`");
    expect(rules).toContain("--model \"$BOT_WORKER_MODEL\"");
    expect(rules).toContain("`watch worker <dispatchId>`");
    expect(rules).toContain("it does NOT restart you");
    expect(rules).toContain("You only orchestrate");
    expect(rules).toContain("Orca unreachable or refused");
  });

  test("one writer per job: the job is claimed before the writer starts and bound after", () => {
    expect(rules).toContain("One writer per job: before any writer starts, take its job through the run helper (`claim take bug:<id>`");
    expect(rules).toContain("never start a second writer");
    expect(rules).toContain("`claim bind <dispatchId> <the same keys>`");
    expect(rules.indexOf("`claim take bug:<id>`")).toBeLessThan(rules.indexOf("`orca orchestration run-create"));
    // below owner there is no dispatch id to bind, the claim is taken and lapses
    expect(agentRules).toContain("`claim take bug:<id>`");
    expect(agentRules).not.toContain("claim bind");
  });

  test("below owner the writer is never an Orca worker", () => {
    expect(agentRules).toContain("never `orca`");
    expect(agentRules).not.toContain("worker-ticket");
    expect(agentRules).not.toContain("worker-start --run <runId> --spec-file <brief> --task-title <short> --worktree path:$BOT_WORKER_HOME-writer --agent claude --model \"$BOT_WORKER_MODEL\"");
  });

  test("docs and tests move with the code, and prompt text goes through the probe gate", () => {
    expect(rules).toContain("docs and tests move with the code, in the same branch and PR, never as a follow-up");
    expect(rules).toContain("`CLAUDE.md`");
    expect(rules).toContain("`ARCHITECTURE.md`");
    expect(rules).toContain("`.env.example`");
    expect(rules).toContain("no doc change: internal only");
    expect(rules).toContain("bun bin/probe-harness.ts --path <file> --base-ref origin/main");
    expect(rules).toContain("docs/probe-cases/");
    expect(rules).toContain("the repo is public");
  });

  test("a verifier runs runtime-code PRs and the writer never calls its own PR verified", () => {
    expect(rules).toContain("verifier (runtime code only");
    expect(rules).toContain(".claude/skills/verify/SKILL.md");
    expect(rules).toContain("`VERDICT: verified|failed`");
    expect(rules).toContain("You never call your own PR verified");
    expect(rules).toContain("a push after the verdict makes it stale");
    expect(rules).toContain("only the reviewer runs on opus");
  });

  test("the verifier brief is built by a script from sources the writer did not write, on another model family when there is one", () => {
    expect(rules).toContain("bun bin/verify-brief.ts brief --pr <pr>");
    expect(rules).toContain("never from the PR description");
    expect(rules).toContain("at least one adversarial or escalation case per boundary");
    expect(rules).toContain("`Exercised: <ids>`");
    expect(rules).toContain("bun bin/verify-brief.ts check --brief");
    expect(rules).toContain("bun bin/verify-brief.ts agent");
    expect(rules).toContain('eval "$(bun bin/verify-brief.ts agent');
    expect(rules).toContain('--agent "$VERIFIER_AGENT" ${VERIFIER_MODEL:+--model "$VERIFIER_MODEL"}');
    expect(rules).toContain("stop if `$VERIFIER_AGENT` is empty");
    // an Agent tool verifier has no Orca agent to pick, but still gets the brief
    expect(agentRules).toContain("bun bin/verify-brief.ts brief --pr <pr>");
    expect(agentRules).not.toContain("VERIFIER_AGENT");
  });

  test("after the merge: watch the e2e, fix or revert, pull, restart and watch the restart", () => {
    expect(rules).toContain("gh run list -w e2e -c <merge sha>");
    expect(rules).toContain("git revert -m 1 <merge sha>");
    expect(rules).toContain("Never leave main red");
    expect(rules).toContain("never ask anyone to ping you");
    expect(rules).toContain("Never watch `src/gateway.ts`");
    expect(rules.indexOf("watch the e2e")).toBeLessThan(rules.indexOf("pull --no-rebase"));
    expect(rules.indexOf("pull --no-rebase")).toBeLessThan(rules.indexOf("/bin/jarvis-restart.sh"));
  });

  test("a standalone reviewer comes before the merge of runtime code, on opus", () => {
    expect(rules).toContain(STANDALONE_REVIEW_RULE);
    expect(STANDALONE_REVIEW_RULE).toContain("orca orchestration worker-start");
    // the reviewer runs on opus; writers and verifiers keep the worker model
    expect(STANDALONE_REVIEW_RULE).toContain("--agent claude --model opus --json");
    expect(STANDALONE_REVIEW_RULE).not.toContain('--model "$BOT_WORKER_MODEL"');
    // the reviewer worker is trimmed before it starts, like every other worker
    expect(STANDALONE_REVIEW_RULE).toContain('"$BOT_WORKER_MCP_TRIM" --role <role>`');
    expect(STANDALONE_REVIEW_RULE).toContain("--worktree path:$BOT_WORKER_HOME-reviewer --agent claude");
    expect(STANDALONE_REVIEW_RULE).not.toContain("a folder or repo Orca knows");
    expect(STANDALONE_REVIEW_RULE.indexOf("BOT_WORKER_MCP_TRIM")).toBeLessThan(STANDALONE_REVIEW_RULE.indexOf("worker-start --run"));
    expect(STANDALONE_REVIEW_RULE).toContain("Up to 5 review rounds");
  });

  test("review by risk: docs and prompt text need no reviewer, runtime code does", () => {
    for (const text of [rules, STANDALONE_REVIEW_RULE]) {
      expect(text).toContain("docs, prompt text");
      expect(text).toContain("dashboard UI");
      expect(text).toMatch(/need none|gets no reviewer/);
      expect(text).toContain("runtime code");
    }
    expect(STANDALONE_REVIEW_RULE).toContain("adapter skills, prompt guides or dashboard UI gets no reviewer");
    expect(STANDALONE_REVIEW_RULE).toContain("a mixed PR counts as runtime code");
    // the old blanket rule is gone, and so is the two-round cap
    expect(STANDALONE_REVIEW_RULE).not.toContain("every fix, no exceptions");
    expect(STANDALONE_REVIEW_RULE).not.toContain("never a round 3");
    expect(STANDALONE_REVIEW_RULE).toContain("round 2 and later happen only when the previous round is `VERDICT: changes` with a real blocker");
    expect(STANDALONE_REVIEW_RULE).toContain("there are at most 5 rounds");
    expect(STANDALONE_REVIEW_RULE).toContain("ask the owner for approval before any further round (an approved extension is the only way past 5)");
    // CI is the gate either way
    expect(STANDALONE_REVIEW_RULE).toContain("never merge anything before green CI");
  });

  test("carries no stash/checkout rule about the database", () => {
    expect(rules).not.toContain("data/*.db");
    expect(rules).not.toContain("git stash");
  });

  test("keeps the instance specifics out of the public text", () => {
    expect(rules).not.toMatch(/momoshub|[a-z]+-at-[a-z]+|@[a-z]+\.com/i);
  });
});

describe("selfUpdateRules, the restart and the checks", () => {
  test("the checks are stated as a gate, with the reason they are not optional", () => {
    // restarting into code that does not compile is a crash-loop KeepAlive
    // cannot break out of, and Slack is no use for fixing it
    expect(rules).toContain("bun run typecheck");
    expect(rules).toContain("bun test");
    expect(rules).toContain("only restarts you if BOTH pass");
    expect(rules).toContain("every fifteen seconds until a human walked to the machine");
  });

  test("the restart is deferred, and it is told why that matters", () => {
    expect(rules).toContain("waits a few seconds so your reply lands first");
    expect(rules).toContain("holds until no turn is running in any thread");
    expect(rules).toContain("New messages are still answered meanwhile, each on a short budget (`RESTART_TURN_BUDGET_MS`, 2 minutes unless set otherwise)");
    expect(rules).toContain("Once the turns from before the restart finish it takes no new message");
    expect(rules).toContain(`after ${RESTART_MAX_WAIT_MS / 60_000} minutes it restarts anyway`);
    expect(rules).toContain("picked up again by the new process on the same session");
    expect(rules).toContain("expect to be a new process");
  });

  test("it must not restart as a way of testing a guess", () => {
    expect(rules).toContain('never restart to "see if that fixed it"');
  });

  test("and lands every change through a worktree and a merged PR", () => {
    expect(rules).toContain("git worktree add");
    expect(rules).toContain("merge it yourself");
    expect(rules).toContain("pull --no-rebase");
    expect(rules).toContain("no attribution");
    expect(rules).not.toContain("Generated with Jarvis");
    expect(rules).not.toContain("do not commit or push");
  });

  test("every fix is reviewed by a standalone agent before it is merged", () => {
    expect(rules).toContain(STANDALONE_REVIEW_RULE);
    expect(rules).toContain("never the session that wrote the code");
    // an Orca worker that talks only on the PR, and the turn still waits for it
    expect(rules).toContain("The reviewer is an Orca worker, never the Agent tool");
    expect(STANDALONE_REVIEW_RULE).toContain("orca orchestration run-create");
    expect(STANDALONE_REVIEW_RULE).toContain("Never end your turn while it is open");
    expect(STANDALONE_REVIEW_RULE).toContain("You never use SendMessage or TaskStop for it");
    expect(STANDALONE_REVIEW_RULE).not.toContain("run_in_background");
    // each review round is a real GitHub review, each fix round a PR comment, marked since both may share one account
    expect(STANDALONE_REVIEW_RULE).toContain("`[review round N]`");
    expect(STANDALONE_REVIEW_RULE).toContain("one real GitHub review whose body starts with `[review round N]`");
    expect(STANDALONE_REVIEW_RULE).toContain("a request-changes review when the verdict is changes, an approving review (with its comments, if any) when it is clean");
    expect(STANDALONE_REVIEW_RULE).toContain("`gh pr review <pr> --request-changes|--approve --body-file <file>`");
    expect(STANDALONE_REVIEW_RULE).toContain("pulls/<pr>/reviews --input <json>");
    // one account cannot request changes on or approve its own PR: the body's VERDICT line is the verdict
    expect(STANDALONE_REVIEW_RULE).toContain("when the PR's author and the reviewer are one account");
    expect(STANDALONE_REVIEW_RULE).toContain("`--comment` / `event` = `COMMENT`");
    expect(STANDALONE_REVIEW_RULE).toContain("the verdict is the body's `VERDICT:` line, in both modes");
    expect(STANDALONE_REVIEW_RULE).not.toContain("its state is the verdict");
    expect(STANDALONE_REVIEW_RULE).toContain("`comments` = `[{path, line, side, body}]`");
    // the writer polls reviews, not comments, and reads the verdict from the body
    expect(STANDALONE_REVIEW_RULE).toContain("polls `gh pr view <pr> --json reviews`");
    expect(STANDALONE_REVIEW_RULE).toContain("`APPROVED` / `CHANGES_REQUESTED` / `COMMENTED`, is only a hint");
    expect(STANDALONE_REVIEW_RULE).toContain("answers each review point");
    expect(STANDALONE_REVIEW_RULE).toContain("inline review thread may also be answered in the thread itself");
    expect(STANDALONE_REVIEW_RULE).not.toContain("`[review round N]` comment");
    expect(STANDALONE_REVIEW_RULE).not.toContain("one PR comment that starts with `[review round N]`");
    expect(STANDALONE_REVIEW_RULE).toContain("`[fix round N]`");
    expect(STANDALONE_REVIEW_RULE).toContain("`VERDICT: clean`");
    expect(STANDALONE_REVIEW_RULE.indexOf("post a PR comment that starts with `[fix round N]`")).toBeGreaterThan(
      STANDALONE_REVIEW_RULE.indexOf("push, then"),
    );
    // the worker ends itself, so nothing is left running after the merge or
    // when the writer stops without another fix round
    expect(STANDALONE_REVIEW_RULE).toContain("when the PR is merged or closed");
    expect(STANDALONE_REVIEW_RULE).toContain("after 40 minutes with no new `[fix round N]` comment");
    // and the writer never waits forever on a reviewer that died
    expect(STANDALONE_REVIEW_RULE).toContain("shows the reviewer task completed, failed or blocked (blocked: it stopped without reporting) with no new review");
    expect(STANDALONE_REVIEW_RULE).toContain("gives up after 30 minutes");
    expect(STANDALONE_REVIEW_RULE).toContain("or the reviewer died or went silent, do not merge");
    // the reviewer never touches the shared checkout it is started in
    expect(STANDALONE_REVIEW_RULE).toContain("never checks out, edits or runs anything in the folder it starts in");
    // the same fallback as every other Orca worker
    expect(STANDALONE_REVIEW_RULE).toContain("or your tools refuse `orca`");
    // with no handle of its own Orca refuses run-create, so that falls back too
    expect(STANDALONE_REVIEW_RULE).toContain("`ORCA_TERMINAL_HANDLE` is unset, `run-create` refuses it as `terminal_handle_stale`");
    // CI is part of the gate, through the helper that refuses on red
    expect(STANDALONE_REVIEW_RULE).toContain("Merge only with `bin/merge-when-green.sh <pr>`");
    expect(STANDALONE_REVIEW_RULE).toContain("Never merge runtime code before a clean review, and never merge anything before green CI");
    // the helper outlives the default tool timeout, and a slow CI is a retry, not a bypass
    expect(STANDALONE_REVIEW_RULE).toContain("Bash timeout of 600000");
    expect(STANDALONE_REVIEW_RULE).toContain("exit 3 means CI has not finished so run it again");
    expect(STANDALONE_REVIEW_RULE).toContain("exit 4 means the PR conflicts with its base");
    expect(STANDALONE_REVIEW_RULE).toContain("approves the PR as the merging account when that account did not open it and its latest review on this commit is not already an approval (a failed approval is no merge)");
    expect(STANDALONE_REVIEW_RULE).toContain("Never fall back to a bare `gh pr merge`");
    // a fix made after review is checked again before it can merge
    expect(STANDALONE_REVIEW_RULE.indexOf("re-run `bun run typecheck` and `bun test`")).toBeGreaterThan(
      STANDALONE_REVIEW_RULE.indexOf("Fix every real finding"),
    );
    // and the loop is bounded, with a way out that is not a merge
    expect(STANDALONE_REVIEW_RULE).toContain("Up to 5 review rounds");
    expect(STANDALONE_REVIEW_RULE).toContain("after round 5,");
    expect(STANDALONE_REVIEW_RULE).toContain("do not merge - leave the PR open");
    // the step sits in the flow before the merge, and the rule before the restart
    expect(rules.indexOf(STANDALONE_REVIEW_RULE)).toBeLessThan(rules.indexOf("after the merge, watch the e2e"));
  });

  test("with no repo or no helper, there is no block at all", () => {
    // a role that may not do this must not be told how
    expect(selfUpdateRules(undefined, "/bin/r.sh")).toBe("");
    expect(selfUpdateRules("/repo", undefined)).toBe("");
    expect(selfUpdateRules(undefined, undefined)).toBe("");
  });

  test("the delay leaves room for a reply to land", () => {
    expect(RESTART_DELAY_MS).toBeGreaterThanOrEqual(3_000);
  });
});

describe("restartWhenIdle", () => {
  const harness = (busy: boolean[], maxWaitMs = 1_000) => {
    const pending: { fn: () => void; ms: number }[] = [];
    const logs: string[] = [];
    const events: string[] = [];
    let exits = 0;
    restartWhenIdle({
      onDrain: () => events.push("drain"),
      onForce: () => events.push("force"),
      maxWaitMs,
      isIdle: () => !(busy.shift() ?? false),
      exit: () => {
        exits += 1;
        events.push("exit");
      },
      schedule: (fn, ms) => {
        pending.push({ fn, ms });
      },
      log: (l) => logs.push(l),
      delayMs: 100,
      pollMs: 10,
    });
    const tick = (): number | undefined => {
      const next = pending.shift();
      next?.fn();
      return next?.ms;
    };
    return { pending, logs, events, tick, exits: () => exits };
  };

  test("nothing happens before the delay, so the reply lands first", () => {
    const h = harness([]);
    expect(h.exits()).toBe(0);
    expect(h.pending[0]?.ms).toBe(100);
  });

  test("idle at the delay -> exits straight away", () => {
    const h = harness([false]);
    h.tick();
    expect(h.exits()).toBe(1);
    expect(h.pending).toHaveLength(0);
    expect(h.logs).toHaveLength(0);
  });

  test("busy -> keeps polling and only exits once idle, logging the wait once", () => {
    const h = harness([true, true, true, false]);
    h.tick();
    expect(h.exits()).toBe(0);
    expect(h.pending[0]?.ms).toBe(10);
    h.tick();
    h.tick();
    expect(h.exits()).toBe(0);
    h.tick();
    expect(h.exits()).toBe(1);
    expect(h.pending).toHaveLength(0);
    expect(h.logs).toEqual(["restart deferred: turns still running; new messages still run, each on a short budget"]);
    expect(h.events).toEqual(["drain", "exit"]);
  });

  test("new turns go on a budget the moment it is asked, before the delay even runs", () => {
    const h = harness([]);
    expect(h.events).toEqual(["drain"]);
    expect(h.exits()).toBe(0);
  });

  test("past the longest wait it marks what it cuts, then exits anyway", () => {
    const h = harness(Array(1_000).fill(true), 30);
    h.tick(); // the delay
    h.tick(); // waited 10
    h.tick(); // waited 20
    expect(h.exits()).toBe(0);
    h.tick(); // waited 30 -> forced
    expect(h.events).toEqual(["drain", "force", "exit"]);
    expect(h.pending).toHaveLength(0);
    expect(h.logs.at(-1)).toContain("restart forced");
  });

  test("going idle inside the wait never forces anything", () => {
    const h = harness([true, true, false], 1_000);
    h.tick();
    h.tick();
    h.tick();
    expect(h.events).toEqual(["drain", "exit"]);
  });

  test("once the turns from before it finish, new work stops - once - so the wait converges", () => {
    // A steady trickle of new messages must not keep it from ever being idle:
    // after `settled` it stops taking work and only the budgeted turns remain.
    const pending: { fn: () => void; ms: number }[] = [];
    const events: string[] = [];
    const busy = [true, true, true, true, false];
    const settled = [false, true, true, true];
    restartWhenIdle({
      onDrain: () => events.push("drain"),
      onSettled: () => events.push("settled"),
      settled: () => settled.shift() ?? true,
      onForce: () => events.push("force"),
      isIdle: () => !(busy.shift() ?? false),
      exit: () => events.push("exit"),
      schedule: (fn, ms) => void pending.push({ fn, ms }),
      delayMs: 100,
      pollMs: 10,
      maxWaitMs: 1_000,
    });
    while (pending.length > 0) pending.shift()?.fn();
    expect(events).toEqual(["drain", "settled", "exit"]);
  });

  test("idle before anything settles exits without closing the intake", () => {
    const events: string[] = [];
    const pending: (() => void)[] = [];
    restartWhenIdle({
      onSettled: () => events.push("settled"),
      settled: () => true,
      isIdle: () => true,
      exit: () => events.push("exit"),
      schedule: (fn) => void pending.push(fn),
    });
    pending.shift()?.();
    expect(events).toEqual(["exit"]);
  });

  test("the turn budget is short next to the longest wait", () => {
    expect(RESTART_TURN_BUDGET_MS).toBeGreaterThanOrEqual(30_000);
    expect(RESTART_TURN_BUDGET_MS).toBeLessThan(RESTART_MAX_WAIT_MS);
    expect(RESTART_HOLD_NOTICE).toContain("đợi em xíu");
  });

  test("the default wait is bounded, and long enough for an ordinary turn", () => {
    expect(RESTART_MAX_WAIT_MS).toBeGreaterThanOrEqual(5 * 60_000);
    expect(RESTART_MAX_WAIT_MS).toBeLessThanOrEqual(60 * 60_000);
  });
});

describe("self PR accounts", () => {
  const accounts = { author: "writer", reviewer: "checker" };

  test("no split, no line: one account does it all", () => {
    expect(selfPrAccountsRule()).toBe("");
    expect(rules).not.toContain("GitHub accounts:");
  });

  test("the author opens the PR, the reviewer comments and merges", () => {
    const line = selfPrAccountsRule(accounts);
    expect(line).toContain("open the PR and post every `[fix round N]` comment as `writer`");
    expect(line).toContain("`GH_TOKEN=$(gh auth token -u writer)` in front of `gh pr create`");
    expect(line).toContain("posts every `[review round N]` review as `checker`");
    expect(line).toContain("`GH_TOKEN=$(gh auth token -u checker)` in front of `gh pr review` and `gh api`");
    expect(line).toContain("merge as `checker`: `GH_TOKEN=$(gh auth token -u checker)` in front of `bin/merge-when-green.sh <pr>`");
    expect(line).toContain("which approves the PR as `checker` right before it merges");
    // switching the active account would move it under every other session
    expect(line).toContain("Never `gh auth switch`");
    // a login gh does not hold must stop the step, not fall back to the active account
    expect(line).toContain("if `gh auth token -u <login>` fails or prints nothing, stop and say so");
    expect(line).toContain("say the same in the reviewer's brief");
  });

  test("both the owner and the agent-tool variant carry it", () => {
    expect(selfUpdateRules("/repo", "/bin/r.sh", accounts)).toContain(selfPrAccountsRule(accounts));
    expect(selfUpdateRules("/repo", "/bin/r.sh", accounts, false)).toContain(selfPrAccountsRule(accounts));
  });

  test("the review rule no longer assumes one shared account", () => {
    expect(STANDALONE_REVIEW_RULE).not.toContain("Both sides post from the same GitHub account");
    expect(STANDALONE_REVIEW_RULE).toContain("even when both post from the same GitHub account");
  });
});
