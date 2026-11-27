import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const SCRIPT = join(import.meta.dir, "..", "..", "bin", "merge-when-green.sh");
const SHA = "abc123";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

type Check = { name: string; bucket: string };
/**
 * One poll: the PR head GitHub shows, its "<mergeable> <mergeStateStatus>"
 * (default "MERGEABLE CLEAN"), and what `pr checks` answers (null = none reported yet).
 */
type Round = { head?: string; mergeable?: string; checks: Check[] | null };

type Review = { author: { login: string }; state: string; commit: { oid: string } };
/** Who runs the merge, who opened the PR, the reviews already on it, and whether `pr review` fails. */
type Accounts = { me?: string; author?: string; reviews?: Review[]; reviewFails?: boolean };

/**
 * A stand-in `gh` on PATH. `pr view` answers the current round's head (or its
 * mergeability, or the PR author / reviews when asked for them), `pr checks` its checks and then
 * moves to the next round (the last one repeats), `api user` the merging
 * login, and `pr review` / `pr merge` leave a marker with their arguments -
 * the gate is tested without a real PR. By default a second account merges, so
 * every merge is approved first.
 */
const fakeGh = (rounds: Round[], accounts: Accounts = {}) => {
  const dir = mkdtempSync(join(tmpdir(), "merge-green-test-"));
  dirs.push(dir);
  rounds.forEach((r, i) => {
    writeFileSync(join(dir, `head.${i}`), r.head ?? SHA);
    writeFileSync(join(dir, `mergeable.${i}`), r.mergeable ?? "MERGEABLE CLEAN");
    writeFileSync(join(dir, `checks.${i}`), r.checks === null ? "" : JSON.stringify(r.checks));
  });
  writeFileSync(join(dir, "me"), accounts.me ?? "checker");
  writeFileSync(join(dir, "author"), accounts.author ?? "writer");
  writeFileSync(join(dir, "reviews"), JSON.stringify({ reviews: accounts.reviews ?? [] }));
  const last = rounds.length - 1;
  writeFileSync(
    join(dir, "gh"),
    `#!/usr/bin/env bash
n=$(cat "${dir}/count" 2>/dev/null || echo 0)
[ "$n" -gt ${last} ] && n=${last}
if [ "$1 $2" = "api user" ]; then cat "${dir}/me"; exit 0; fi
if [ "$1 $2 $4 $5" = "pr view --json author" ]; then cat "${dir}/author"; exit 0; fi
if [ "$1 $2 $4 $5" = "pr view --json reviews" ]; then cat "${dir}/reviews"; exit 0; fi
if [ "$1 $2 $4 $5" = "pr view --json mergeable,mergeStateStatus" ]; then cat "${dir}/mergeable.$n"; exit 0; fi
if [ "$1 $2" = "pr view" ]; then cat "${dir}/head.$n"; exit 0; fi
if [ "$1 $2" = "pr review" ]; then echo "$@" > "${dir}/approved"; exit ${accounts.reviewFails ? 1 : 0}; fi
if [ "$1 $2" = "pr checks" ]; then
  echo $((n + 1)) > "${dir}/count"
  if [ ! -s "${dir}/checks.$n" ]; then echo "no checks reported on the 'fix' branch" >&2; exit 1; fi
  cat "${dir}/checks.$n"; exit 0
fi
if [ "$1 $2" = "pr merge" ]; then echo "$@" > "${dir}/merged"; exit 0; fi
exit 1
`,
  );
  chmodSync(join(dir, "gh"), 0o755);
  return dir;
};

const run = async (dir: string, args: string[], extraEnv: Record<string, string> = {}) => {
  const proc = Bun.spawn({
    cmd: ["bash", SCRIPT, ...args],
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, MERGE_POLL_SECONDS: "0", MERGE_HEAD_SHA: SHA, JARVIS_RUN_TICKET: "", JARVIS_RUN_TICKET_FILE: "", ...extraEnv },
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const marker = (name: string) => (existsSync(join(dir, name)) ? readFileSync(join(dir, name), "utf8") : null);
  return { stdout, stderr, code, merged: marker("merged"), approved: marker("approved") };
};

const ci = (bucket: string): Check => ({ name: "checks", bucket });
const guardian: Check = { name: "GitGuardian Security Checks", bucket: "pass" };

describe("merge-when-green.sh", () => {
  test("no PR -> usage, nothing merged", async () => {
    const r = await run(fakeGh([{ checks: [ci("pass")] }]), []);
    expect(r.code).toBe(2);
    expect(r.merged).toBeNull();
  });

  test("waits for checks to appear and finish, then merges pinned to the pushed commit", async () => {
    const dir = fakeGh([{ checks: null }, { checks: [ci("pending"), guardian] }, { checks: [ci("pass"), guardian] }]);
    const r = await run(dir, ["42"]);
    expect(r.code).toBe(0);
    expect(r.merged).toContain(`pr merge 42 --merge --match-head-commit ${SHA}`);
    expect(r.approved).toContain("pr review 42 --approve --body Approved: standalone review clean, CI green (abc123)");
  });

  test("a fast third-party pass alone is not CI: it waits for the CI check", async () => {
    const dir = fakeGh([{ checks: [guardian] }, { checks: [ci("pass"), guardian] }]);
    const r = await run(dir, ["42"]);
    expect(r.code).toBe(0);
    expect(readFileSync(join(dir, "count"), "utf8").trim()).toBe("2");
  });

  test("only the third-party pass, ever -> times out unmerged", async () => {
    const r = await run(fakeGh([{ checks: [guardian] }]), ["42", "0"]);
    expect(r.code).toBe(3);
    expect(r.stderr).toContain("'checks' has not appeared");
    expect(r.merged).toBeNull();
  });

  test("green checks on an older head are not this commit's: it waits for the push", async () => {
    const dir = fakeGh([{ head: "old999", checks: [ci("pass")] }, { checks: [ci("pass")] }]);
    // the old head never reaches pr checks, so the round only moves once the head matches
    const r = await run(dir, ["42", "0"]);
    expect(r.code).toBe(3);
    expect(r.stderr).toContain("waiting for abc123");
    expect(r.merged).toBeNull();
  });

  test("a failed or cancelled check is never merged", async () => {
    for (const bucket of ["fail", "cancel"]) {
      const r = await run(fakeGh([{ checks: [ci("pending")] }, { checks: [ci(bucket), guardian] }]), ["42"]);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("not merging");
      expect(r.merged).toBeNull();
    }
  });

  test("checks that never finish time out unmerged, and say to run it again", async () => {
    const r = await run(fakeGh([{ checks: [ci("pending")] }]), ["42", "0"]);
    expect(r.code).toBe(3);
    expect(r.stderr).toContain("run it again");
    expect(r.merged).toBeNull();
  });

  test("a PR whose checks never show up is not merged either", async () => {
    const r = await run(fakeGh([{ checks: null }]), ["42", "0"]);
    expect(r.code).toBe(3);
    expect(r.merged).toBeNull();
  });

  test("nothing is approved before CI is green", async () => {
    const r = await run(fakeGh([{ checks: [ci("pending")] }]), ["42", "0"]);
    expect(r.code).toBe(3);
    expect(r.approved).toBeNull();
    const red = await run(fakeGh([{ checks: [ci("fail")] }]), ["42"]);
    expect(red.code).toBe(1);
    expect(red.approved).toBeNull();
  });

  test("the merging account opened the PR -> no approval (GitHub forbids it), still merges", async () => {
    const r = await run(fakeGh([{ checks: [ci("pass")] }], { me: "Writer", author: "writer" }), ["42"]);
    expect(r.code).toBe(0);
    expect(r.approved).toBeNull();
    expect(r.stdout).toContain("approval skipped");
    expect(r.merged).toContain("pr merge 42");
  });

  test("already approved by the merging account on this head -> no second approval", async () => {
    const reviews = [{ author: { login: "checker" }, state: "APPROVED", commit: { oid: SHA } }];
    const r = await run(fakeGh([{ checks: [ci("pass")] }], { reviews }), ["42"]);
    expect(r.code).toBe(0);
    expect(r.approved).toBeNull();
    expect(r.merged).toContain("pr merge 42");
  });

  test("the reviewer's own approval (same account, a COMMENTED note after it) is not approved again", async () => {
    const reviews = [
      { author: { login: "Checker" }, state: "APPROVED", commit: { oid: SHA } },
      { author: { login: "checker" }, state: "COMMENTED", commit: { oid: SHA } },
    ];
    const r = await run(fakeGh([{ checks: [ci("pass")] }], { reviews }), ["42"]);
    expect(r.code).toBe(0);
    expect(r.approved).toBeNull();
    expect(r.merged).toContain("pr merge 42");
  });

  test("a request-changes or dismissal after the approval means it is approved again", async () => {
    for (const state of ["CHANGES_REQUESTED", "DISMISSED"]) {
      const reviews = [
        { author: { login: "checker" }, state: "APPROVED", commit: { oid: SHA } },
        { author: { login: "checker" }, state, commit: { oid: SHA } },
      ];
      const r = await run(fakeGh([{ checks: [ci("pass")] }], { reviews }), ["42"]);
      expect(r.code).toBe(0);
      expect(r.approved).toContain("--approve");
    }
  });

  test("an approval on an older head, or by someone else, does not count", async () => {
    const reviews = [
      { author: { login: "checker" }, state: "APPROVED", commit: { oid: "old999" } },
      { author: { login: "someone" }, state: "APPROVED", commit: { oid: SHA } },
      { author: { login: "checker" }, state: "COMMENTED", commit: { oid: SHA } },
    ];
    const r = await run(fakeGh([{ checks: [ci("pass")] }], { reviews }), ["42"]);
    expect(r.code).toBe(0);
    expect(r.approved).toContain("--approve");
  });

  test("a failed approval stops the merge", async () => {
    const r = await run(fakeGh([{ checks: [ci("pass")] }], { reviewFails: true }), ["42"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("not merging");
    expect(r.merged).toBeNull();
  });

  test("cannot tell who merges -> no merge", async () => {
    const r = await run(fakeGh([{ checks: [ci("pass")] }], { me: "" }), ["42"]);
    expect(r.code).toBe(1);
    expect(r.approved).toBeNull();
    expect(r.merged).toBeNull();
  });

  test("a PR that conflicts with its base is refused at once with exit 4, not polled until the timeout", async () => {
    for (const mergeable of ["CONFLICTING DIRTY", "CONFLICTING UNKNOWN", "UNKNOWN DIRTY"]) {
      const dir = fakeGh([{ mergeable, checks: null }]);
      const r = await run(dir, ["42", "540"]);
      expect(r.code).toBe(4);
      expect(r.stderr).toContain("PR 42 conflicts with its base, merge the base in and resolve first - not merging");
      expect(r.merged).toBeNull();
      expect(r.approved).toBeNull();
      // it never waited for checks GitHub will not run
      expect(existsSync(join(dir, "count"))).toBe(false);
    }
  });

  test("mergeability still being computed (UNKNOWN) -> keeps polling, merges once it is known", async () => {
    const dir = fakeGh([
      { mergeable: "UNKNOWN UNKNOWN", checks: [ci("pass")] },
      { mergeable: "MERGEABLE CLEAN", checks: [ci("pass")] },
    ]);
    const r = await run(dir, ["42"]);
    expect(r.code).toBe(0);
    expect(r.merged).toContain(`pr merge 42 --merge --match-head-commit ${SHA}`);
    expect(readFileSync(join(dir, "count"), "utf8").trim()).toBe("2");
  });

  test("mergeability that never resolves -> times out unmerged with exit 3", async () => {
    const r = await run(fakeGh([{ mergeable: "UNKNOWN UNKNOWN", checks: [ci("pass")] }]), ["42", "0"]);
    expect(r.code).toBe(3);
    expect(r.stderr).toContain("merges cleanly");
    expect(r.approved).toBeNull();
    expect(r.merged).toBeNull();
  });
});

const FULL_SHA = "0123456789abcdef0123456789abcdef01234567";

/**
 * A stand-in `github-app.sh`: answers one canned bot reply per call (the last repeats) and
 * records its arguments, so the bot-side gate is tested without a bot. `gh` is a stub that
 * fails the test if the script touches it (a merge by the human token).
 */
const fakeBot = (answers: string[]) => {
  const dir = fakeGh([{ checks: [ci("pass")], head: FULL_SHA }]);
  writeFileSync(join(dir, "gh"), `#!/usr/bin/env bash\necho "$@" >> "${dir}/gh-used"\nexit 1\n`);
  answers.forEach((a, i) => writeFileSync(join(dir, `bot.${i}`), a));
  writeFileSync(
    join(dir, "bot.sh"),
    `#!/usr/bin/env bash
n=$(cat "${dir}/bot-count" 2>/dev/null || echo 0)
[ "$n" -gt ${answers.length - 1} ] && n=${answers.length - 1}
echo "$@" >> "${dir}/bot-args"
echo $((n + 1)) > "${dir}/bot-count"
cat "${dir}/bot.$n"
[ "$(jq -r '.ok' "${dir}/bot.$n")" = "true" ]
`,
  );
  chmodSync(join(dir, "bot.sh"), 0o755);
  return dir;
};
const reply = (github: unknown) => JSON.stringify({ ok: true, github });
const gateEnv = (dir: string) => ({
  JARVIS_RUN_TICKET: "jvwk_test",
  GITHUB_APP_SH: join(dir, "bot.sh"),
  MERGE_REPO: "o/r",
  MERGE_HEAD_SHA: FULL_SHA,
});
const seen = (dir: string, name: string) => (existsSync(join(dir, name)) ? readFileSync(join(dir, name), "utf8") : "");

describe("merge-when-green.sh with a ticket (the bot decides)", () => {
  test("the bot merges: exit 0, asked for this PR and this exact sha, the human gh never touched", async () => {
    const dir = fakeBot([reply({ decision: "merged", sha: FULL_SHA, mergedSha: "feed" })]);
    const r = await run(dir, ["42"], gateEnv(dir));
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("merged by the bot: feed");
    expect(seen(dir, "bot-args")).toContain(`merge-gate o/r 42 --sha ${FULL_SHA}`);
    expect(seen(dir, "gh-used")).toBe("");
  });

  test("pending is polled again until the bot merges", async () => {
    const dir = fakeBot([reply({ decision: "pending", reasons: ["required check checks is still running"], sha: FULL_SHA }), reply({ decision: "merged", sha: FULL_SHA })]);
    const r = await run(dir, ["42"], gateEnv(dir));
    expect(r.code).toBe(0);
    expect(seen(dir, "bot-count").trim()).toBe("2");
  });

  test("pending past the timeout -> exit 3 with the reason", async () => {
    const dir = fakeBot([reply({ decision: "pending", reasons: ["checks still running"], sha: FULL_SHA })]);
    const r = await run(dir, ["42", "0"], gateEnv(dir));
    expect(r.code).toBe(3);
    expect(r.stderr).toContain("checks still running");
  });

  test("refused -> exit 1 with every reason, no retry, no human merge", async () => {
    const dir = fakeBot([reply({ decision: "refused", reasons: ["check checks: failure", "no `[verify]` comment"], sha: FULL_SHA })]);
    const r = await run(dir, ["42"], gateEnv(dir));
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("check checks: failure");
    expect(r.stderr).toContain("no `[verify]` comment");
    expect(seen(dir, "bot-count").trim()).toBe("1");
    expect(seen(dir, "gh-used")).toBe("");
  });

  test("conflict -> exit 4", async () => {
    const dir = fakeBot([reply({ decision: "conflict", reasons: ["conflicts"], sha: FULL_SHA })]);
    expect((await run(dir, ["42"], gateEnv(dir))).code).toBe(4);
  });

  test("a bot error (ticket refused, merge action not granted) -> exit 1, never a fallback to the human token", async () => {
    const dir = fakeBot([JSON.stringify({ ok: false, error: "this worker ticket does not allow merge-gate" })]);
    const r = await run(dir, ["42"], gateEnv(dir));
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("no usable answer");
    expect(seen(dir, "gh-used")).toBe("");
  });

  test("the bot's gate is off (disabled) -> the old human path runs", async () => {
    const dir = fakeBot([reply({ decision: "disabled", reasons: ["off"], sha: FULL_SHA })]);
    // the old path reads `gh`: give it a green PR at the same sha
    const gh = fakeGh([{ checks: [ci("pass"), guardian], head: FULL_SHA }]);
    const r = await run(gh, ["42"], { ...gateEnv(dir), PATH: `${gh}:${process.env.PATH}` });
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("merge gate is off");
    expect(r.merged).toContain(`pr merge 42 --merge --match-head-commit ${FULL_SHA}`);
  });

  test("MERGE_GATE_REQUIRED=1: a gate that is off is an error, never the human path", async () => {
    const dir = fakeBot([reply({ decision: "disabled", reasons: ["off"], sha: FULL_SHA })]);
    const gh = fakeGh([{ checks: [ci("pass"), guardian], head: FULL_SHA }]);
    const r = await run(gh, ["42"], { ...gateEnv(dir), MERGE_GATE_REQUIRED: "1", PATH: `${gh}:${process.env.PATH}` });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("no merge path");
    expect(r.merged).toBeNull();
  });

  test("MERGE_GATE_REQUIRED=1 with no ticket: the human path is closed", async () => {
    const dir = fakeGh([{ checks: [ci("pass"), guardian] }]);
    const r = await run(dir, ["42"], { MERGE_GATE_REQUIRED: "1" });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("holds no ticket");
    expect(r.merged).toBeNull();
  });

  test("a short sha is refused before asking the bot", async () => {
    const dir = fakeBot([reply({ decision: "merged", sha: SHA })]);
    const r = await run(dir, ["42"], { ...gateEnv(dir), MERGE_HEAD_SHA: SHA });
    expect(r.code).toBe(1);
    expect(seen(dir, "bot-args")).toBe("");
  });
});
