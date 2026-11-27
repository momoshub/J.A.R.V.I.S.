import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// each case shells out to the script many times (git, tar, bash); a loaded host needs more than 5s
setDefaultTimeout(60_000);

const script = resolve(import.meta.dir, "..", "..", "bin", "jarvis-restart.sh");

// `bun` and `curl` are shims on PATH: each call is logged, and FAIL_ON names the
// `bun` call that fails, so nothing real is typechecked, tested, built or restarted.
let dir: string;
let repo: string;
let log: string;
let shims: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jarvis-restart-"));
  repo = join(dir, "repo");
  mkdirSync(join(repo, "web"), { recursive: true });
  log = join(dir, "calls.log");
  shims = join(dir, "shims");
  mkdirSync(shims);
  writeFileSync(
    join(shims, "bun"),
    `#!/usr/bin/env bash
if [ "$1" = "-e" ]; then echo '{"reason":"x"}'; exit 0; fi
echo "bun $* @$(basename "$PWD")" >> "${log}"
[ -n "\${FAIL_ON:-}" ] && [ "$*" = "$FAIL_ON" ] && exit 1
exit 0
`,
  );
  writeFileSync(join(shims, "curl"), `#!/usr/bin/env bash\necho "curl" >> "${log}"\necho '{"ok":true}'\n`);
  chmodSync(join(shims, "bun"), 0o755);
  chmodSync(join(shims, "curl"), 0o755);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

// JARVIS_RELEASES_DIR is always set: a real host's supervisor must never leak in.
const run = (args: string[], failOn = "", env: Record<string, string> = {}) =>
  Bun.spawnSync(["bash", script, ...args], {
    env: {
      PATH: `${shims}:/usr/bin:/bin`,
      HOME: process.env.HOME,
      JARVIS_REPO: repo,
      JARVIS_RELEASES_DIR: join(dir, "releases"),
      FAIL_ON: failOn,
      ...env,
    },
  });

const calls = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []);

describe("bin/jarvis-restart.sh", () => {
  test("rebuilds the dashboard after the checks and before asking for the restart", () => {
    const res = run([]);
    expect(res.exitCode).toBe(0);
    expect(calls()).toEqual(["bun run typecheck @repo", "bun test @repo", "bun run build:web @repo", "curl"]);
  });

  test("a failed dashboard build refuses the restart", () => {
    const res = run([], "run build:web");
    expect(res.exitCode).toBe(1);
    expect(res.stderr.toString()).toContain("REFUSING TO RESTART: dashboard build failed");
    expect(calls()).not.toContain("curl");
  });

  test("--check-only builds into a throwaway folder and never touches web/dist or restarts", () => {
    const res = run(["--check-only"]);
    expect(res.exitCode).toBe(0);
    const built = calls().find((c) => c.startsWith("bun x vite build"));
    expect(built).toMatch(/--outDir \S*jarvis-web\.\S+ --emptyOutDir @web$/);
    expect(calls()).not.toContain("bun run build:web @repo");
    expect(calls()).not.toContain("curl");
  });

  test("--check-only fails when the dashboard does not build", () => {
    const res = run(["--check-only"], "install");
    expect(res.exitCode).toBe(1);
    expect(calls()).not.toContain("curl");
  });
});

// Under the release supervisor (a live launcher.pid) the checks run on an
// immutable copy of HEAD, and `current` moves only when they all passed.
describe("bin/jarvis-restart.sh under the release supervisor", () => {
  let sha: string;
  let releases: string;
  const git = (...args: string[]) => {
    const res = Bun.spawnSync(["git", "-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", ...args], {
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
    });
    if (res.exitCode !== 0) throw new Error(res.stderr.toString());
    return res.stdout.toString().trim();
  };
  const current = () => {
    try {
      return readlinkSync(join(releases, "current"));
    } catch {
      return undefined;
    }
  };
  const supervised = (extra: Record<string, string> = {}) => ({ JARVIS_SOURCE_REPO: repo, ...extra });

  beforeEach(() => {
    releases = join(dir, "releases");
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, "src", "index.ts"), "// bot\n");
    writeFileSync(join(repo, "web", "package.json"), "{}\n");
    git("init", "-q", "-b", "main");
    git("add", "-A");
    git("commit", "-q", "-m", "one");
    sha = git("rev-parse", "HEAD");
    mkdirSync(releases);
    writeFileSync(join(releases, "launcher.pid"), String(process.pid));
  });

  test("builds a release by sha, runs every check inside it, only then points current at it and asks for the restart", () => {
    const res = run([], "", supervised());
    expect(res.exitCode).toBe(0);
    expect(calls()).toEqual([
      `bun install --frozen-lockfile @${sha}`,
      `bun run typecheck @${sha}`,
      `bun test @${sha}`,
      `bun run build:web @${sha}`,
      "curl",
    ]);
    expect(current()).toBe(join(releases, sha));
    expect(res.stdout.toString()).toContain("returns to the last known good one by itself");
  });

  test("a red check refuses, and current stays on the release that is running", () => {
    const first = run([], "", supervised());
    expect(first.exitCode).toBe(0);
    writeFileSync(join(repo, "src", "index.ts"), "// bot 2\n");
    git("commit", "-q", "-am", "two");
    for (const failing of ["run typecheck", "test", "run build:web"]) {
      const res = run([], failing, supervised());
      expect(res.exitCode).toBe(1);
      expect(res.stderr.toString()).toContain("REFUSING TO RESTART");
      expect(current()).toBe(join(releases, sha));
    }
    expect(calls().filter((c) => c === "curl")).toHaveLength(1);
  });

  test("the checkout is left alone: nothing is installed, tested or built in it", () => {
    run([], "", supervised());
    expect(calls().filter((c) => c.endsWith("@repo"))).toEqual([]);
  });

  test("--check-only checks the release copy and moves nothing", () => {
    const res = run(["--check-only"], "", supervised());
    expect(res.exitCode).toBe(0);
    expect(current()).toBeUndefined();
    expect(calls()).not.toContain("curl");
    expect(calls()).toContain(`bun test @${sha}`);
  });

  test("a release that failed its health check before is refused, not retried", () => {
    run(["--check-only"], "", supervised());
    writeFileSync(join(releases, sha, ".bad"), "exited before it reported healthy");
    const res = run([], "", supervised());
    expect(res.exitCode).toBe(1);
    expect(res.stderr.toString()).toContain("REFUSING TO RESTART: could not prepare release");
  });

  test("a stale launcher.pid is not a supervisor: it checks the checkout in place, as before", () => {
    writeFileSync(join(releases, "launcher.pid"), "999999");
    const res = run([], "", supervised());
    expect(res.exitCode).toBe(0);
    expect(calls()).toEqual(["bun run typecheck @repo", "bun test @repo", "bun run build:web @repo", "curl"]);
    expect(current()).toBeUndefined();
  });
});
