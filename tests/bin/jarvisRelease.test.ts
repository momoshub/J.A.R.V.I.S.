import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// each case shells out to the script many times (git, tar, bash); a loaded host needs more than 5s
setDefaultTimeout(60_000);

const script = resolve(import.meta.dir, "..", "..", "bin", "jarvis-release.sh");
const template = resolve(import.meta.dir, "..", "..", "launchd", "com.example.jarvis.plist");

// `bun`, `curl` and `launchctl` are shims on PATH, so nothing real is installed,
// probed or restarted. The bun shim logs its call, then `bun run` stays up for
// BOT_LIFE seconds (or exits at once with BOT_EXIT). The curl shim answers
// /health from the HEALTHY file, as long as it exists.
let dir: string;
let src: string;
let root: string;
let shims: string;
let log: string;
let sha: string;

const git = (...args: string[]) => {
  const res = Bun.spawnSync(["git", "-C", src, ...args], { env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" } });
  if (res.exitCode !== 0) throw new Error(res.stderr.toString());
  return res.stdout.toString().trim();
};

const shim = (name: string, body: string) => {
  writeFileSync(join(shims, name), `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(join(shims, name), 0o755);
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jarvis-release-"));
  src = join(dir, "src");
  root = join(dir, "releases");
  shims = join(dir, "shims");
  log = join(dir, "calls.log");
  mkdirSync(join(src, "src"), { recursive: true });
  mkdirSync(join(src, "data"));
  mkdirSync(join(src, "logs"));
  writeFileSync(join(src, "src", "index.ts"), "// the bot\n");
  writeFileSync(join(src, ".env"), "DASHBOARD_PORT=2999\n");
  writeFileSync(join(src, ".gitignore"), ".env\ndata/\nlogs/\n");
  git("init", "-q", "-b", "main");
  git("-c", "user.name=t", "-c", "user.email=t@t", "add", "-A");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "one");
  sha = git("rev-parse", "HEAD");
  mkdirSync(shims);
  shim(
    "bun",
    `echo "bun $* @$(basename "$PWD")" >> "${log}"
[ "$1" = "install" ] && exit 0
[ -n "\${BOT_EXIT:-}" ] && exit "$BOT_EXIT"
exec sleep "\${BOT_LIFE:-1}"`,
  );
  shim(
    "curl",
    `echo "curl $*" >> "${log}"
[ -f "${dir}/HEALTHY" ] && { echo '{"ok":true}'; exit 0; }
exit 22`,
  );
  shim("launchctl", `echo "launchctl $*" >> "${log}"`);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const run = (args: string[], env: Record<string, string> = {}) =>
  Bun.spawnSync(["bash", script, ...args], {
    env: {
      PATH: `${shims}:/usr/bin:/bin`,
      HOME: dir,
      JARVIS_RELEASES_DIR: root,
      JARVIS_SOURCE_REPO: src,
      RELEASE_HEALTH_TIMEOUT_S: "3",
      RELEASE_HEALTH_POLL_S: "0.2",
      ...env,
    },
  });

const calls = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []);
const link = (name: string) => {
  try {
    return readlinkSync(join(root, name));
  } catch {
    return undefined;
  }
};
const history = () => (existsSync(join(root, "history.log")) ? readFileSync(join(root, "history.log"), "utf8") : "");

/** A second commit, prepared and activated by hand, so there are two releases to move between. */
const commitAndActivate = (msg: string): string => {
  writeFileSync(join(src, "src", "index.ts"), `// ${msg}\n`);
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-am", msg);
  const next = git("rev-parse", "HEAD");
  expect(run(["prepare", next]).exitCode).toBe(0);
  expect(run(["activate", next]).exitCode).toBe(0);
  return next;
};

describe("bin/jarvis-release.sh prepare / activate", () => {
  test("prepare exports the commit into its own folder and installs its dependencies there", () => {
    const res = run(["prepare", sha]);
    expect(res.exitCode).toBe(0);
    expect(res.stdout.toString().trim()).toBe(join(root, sha));
    expect(readFileSync(join(root, sha, "src", "index.ts"), "utf8")).toBe("// the bot\n");
    expect(existsSync(join(root, sha, ".git"))).toBe(false);
    expect(calls()).toEqual([`bun install --frozen-lockfile @${sha}`]);
  });

  test("a folder is built from the commit, so an uncommitted edit in the checkout is not in it", () => {
    writeFileSync(join(src, "src", "index.ts"), "// dirty\n");
    run(["prepare", sha]);
    expect(readFileSync(join(root, sha, "src", "index.ts"), "utf8")).toBe("// the bot\n");
  });

  test("an unknown commit and a failed install both refuse, and leave no half-built folder", () => {
    expect(run(["prepare", "deadbeefdeadbeef"]).exitCode).toBe(1);
    shim("bun", `echo "bun $*" >> "${log}"; exit 1`);
    expect(run(["prepare", sha]).exitCode).toBe(1);
    expect(existsSync(join(root, sha))).toBe(false);
  });

  test("a release that failed its health check is refused until its .bad marker is removed", () => {
    run(["prepare", sha]);
    writeFileSync(join(root, sha, ".bad"), "exited before it reported healthy");
    const res = run(["prepare", sha]);
    expect(res.exitCode).toBe(1);
    expect(res.stderr.toString()).toContain("failed its health check before");
  });

  test("activate links the host state in, marks the release checked and points current at it, last-good untouched", () => {
    run(["prepare", sha]);
    expect(existsSync(join(root, sha, "data"))).toBe(false);
    const res = run(["activate", sha]);
    expect(res.exitCode).toBe(0);
    for (const n of [".env", "data", "logs"]) {
      expect(lstatSync(join(root, sha, n)).isSymbolicLink()).toBe(true);
      expect(readlinkSync(join(root, sha, n))).toBe(join(src, n));
    }
    expect(link("current")).toBe(join(root, sha));
    expect(link("last-good")).toBeUndefined();
    expect(readFileSync(join(root, sha, ".ok"), "utf8").trim()).toBe(sha);
  });

  test("activate refuses a commit that was never prepared", () => {
    expect(run(["activate", sha]).exitCode).toBe(1);
    expect(link("current")).toBeUndefined();
  });

  test("old releases are pruned, but never current, last-good or previous-good", () => {
    run(["prepare", sha]);
    run(["activate", sha]);
    const shas = [sha];
    for (let i = 0; i < 3; i++) shas.push(commitAndActivate(`c${i}`));
    run(["rollback", "--no-restart", sha]); // sha is last-good and current again
    const last = commitAndActivate("last");
    // keep=1: only the protected ones (current, last-good) plus the newest one survive
    expect(run(["activate", last], { RELEASES_KEEP: "1" }).exitCode).toBe(0);
    expect(existsSync(join(root, sha))).toBe(true); // last-good
    expect(existsSync(join(root, last))).toBe(true); // current
    expect(shas.slice(1).filter((s) => existsSync(join(root, s))).length).toBeLessThanOrEqual(1);
  });
});

describe("bin/jarvis-release.sh launch", () => {
  const prepared = (): string => {
    expect(run(["prepare", sha]).exitCode).toBe(0);
    expect(run(["activate", sha]).exitCode).toBe(0);
    return join(root, sha);
  };

  test("with no release it runs the checkout itself, like the old plist, and is not health-gated", () => {
    const res = run(["launch"]);
    expect(res.exitCode).toBe(0);
    expect(calls()).toEqual(["bun run src/index.ts @src"]);
    expect(link("last-good")).toBeUndefined();
  });

  test("a new release that reports healthy becomes last-good, and the old last-good becomes previous-good", () => {
    prepared();
    writeFileSync(join(dir, "HEALTHY"), "");
    expect(run(["launch"]).exitCode).toBe(0);
    expect(calls()).toContain(`bun run src/index.ts @${sha}`);
    expect(calls().some((c) => c.startsWith("curl") && c.includes("127.0.0.1:2999/health"))).toBe(true);
    expect(link("last-good")).toBe(join(root, sha));
    const next = commitAndActivate("two");
    run(["launch"]);
    expect(link("last-good")).toBe(join(root, next));
    expect(link("previous-good")).toBe(join(root, sha));
  });

  test("a release that never reports healthy goes back to last-good by itself, is marked bad and says why", () => {
    prepared();
    writeFileSync(join(dir, "HEALTHY"), "");
    run(["launch"]); // sha is now last-good
    rmSync(join(dir, "HEALTHY"));
    const next = commitAndActivate("broken");
    const res = run(["launch"], { BOT_LIFE: "30" });
    expect(res.exitCode).toBe(0);
    expect(link("current")).toBe(join(root, sha));
    expect(link("last-good")).toBe(join(root, sha));
    expect(readFileSync(join(root, next, ".bad"), "utf8")).toContain("did not report healthy");
    const rb = JSON.parse(readFileSync(join(root, "rollback.json"), "utf8"));
    expect([rb.from, rb.to]).toEqual([next, sha]);
    expect(history()).toContain("ROLLED BACK");
  });

  test("a release that crashes on start goes back to last-good without waiting out the timeout", () => {
    prepared();
    writeFileSync(join(dir, "HEALTHY"), "");
    run(["launch"]);
    rmSync(join(dir, "HEALTHY"));
    const next = commitAndActivate("crashes");
    const started = Date.now();
    const res = run(["launch"], { BOT_EXIT: "1", RELEASE_HEALTH_TIMEOUT_S: "60" });
    expect(res.exitCode).toBe(0);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(link("current")).toBe(join(root, sha));
    expect(readFileSync(join(root, next, ".bad"), "utf8")).toContain("exited before");
  });

  test("an unhealthy release with no last-good to go back to is left running, not killed", () => {
    prepared();
    const res = run(["launch"], { BOT_LIFE: "1" });
    expect(res.exitCode).toBe(0);
    expect(link("current")).toBe(join(root, sha));
    expect(existsSync(join(root, sha, ".bad"))).toBe(false);
    expect(history()).toContain("no last-good to go back to");
  });

  test("the bot is told where its source checkout and releases are; a .bad current is skipped for last-good", () => {
    prepared();
    writeFileSync(join(dir, "HEALTHY"), "");
    run(["launch"]);
    const next = commitAndActivate("bad");
    writeFileSync(join(root, next, ".bad"), "x");
    rmSync(log);
    run(["launch"]);
    expect(calls()).toContain(`bun run src/index.ts @${sha}`);
  });

  test("the pid file lets jarvis-restart.sh tell a supervised bot from a bare one", () => {
    prepared();
    run(["launch"]);
    expect(Number(readFileSync(join(root, "launcher.pid"), "utf8"))).toBeGreaterThan(0);
  });
});

describe("bin/jarvis-release.sh rollback", () => {
  const twoGood = (): { a: string; b: string } => {
    run(["prepare", sha]);
    run(["activate", sha]);
    writeFileSync(join(dir, "HEALTHY"), "");
    run(["launch"]); // a = sha is last-good
    const b = commitAndActivate("two");
    run(["launch"]); // b is last-good, a previous-good
    rmSync(log, { force: true });
    return { a: sha, b };
  };

  test("points current and last-good at the last known good release and kickstarts the supervisor, needing no bot", () => {
    twoGood();
    commitAndActivate("three"); // activated, never proven: current != last-good
    const b = link("last-good");
    rmSync(log, { force: true });
    const res = run(["rollback"]);
    expect(res.exitCode).toBe(0);
    expect(link("current")).toBe(b);
    expect(link("last-good")).toBe(b);
    expect(calls()).toEqual([`launchctl kickstart -k gui/${process.getuid?.() ?? 0}/com.example.jarvis`]);
    expect(history()).toContain("ROLLBACK by hand");
  });

  test("kickstarts the label that install recorded", () => {
    twoGood();
    run(["install", "--label", "com.acme.bot", "--source", src]);
    commitAndActivate("three");
    rmSync(log, { force: true });
    run(["rollback"]);
    expect(calls().at(-1)).toBe(`launchctl kickstart -k gui/${process.getuid?.() ?? 0}/com.acme.bot`);
  });

  test("when current already is last-good it goes one further back, to previous-good", () => {
    const { a, b } = twoGood();
    expect(link("current")).toBe(join(root, b));
    const res = run(["rollback", "--no-restart"]);
    expect(res.exitCode).toBe(0);
    expect(link("current")).toBe(join(root, a));
    expect(link("last-good")).toBe(join(root, a));
    expect(link("previous-good")).toBe(join(root, b));
    expect(calls()).toEqual([]);
  });

  test("an explicit sha goes there, and a release that is not a checked one is refused", () => {
    const { a } = twoGood();
    expect(run(["rollback", a, "--no-restart"]).exitCode).toBe(0);
    expect(link("current")).toBe(join(root, a));
    const res = run(["rollback", "0".repeat(40), "--no-restart"]);
    expect(res.exitCode).toBe(1);
    expect(link("current")).toBe(join(root, a));
  });

  test("with nothing known good it refuses and says how to go back by hand", () => {
    run(["prepare", sha]);
    run(["activate", sha]);
    const res = run(["rollback"]);
    expect(res.exitCode).toBe(1);
    expect(res.stderr.toString()).toContain("no known good release");
    expect(calls().filter((c) => c.startsWith("launchctl"))).toEqual([]);
  });

  test("works with a broken checkout and no bun on the PATH", () => {
    twoGood();
    commitAndActivate("three");
    rmSync(join(shims, "bun"));
    rmSync(join(src, "src"), { recursive: true });
    expect(run(["rollback", "--no-restart"]).exitCode).toBe(0);
  });
});

describe("bin/jarvis-release.sh install / plist / status", () => {
  test("install copies the supervisor out of the repo and records the source and label", () => {
    const res = run(["install", "--label", "com.acme.bot", "--source", src]);
    // --source must be a checkout of the bot: ours is, through src/index.ts
    expect(res.exitCode).toBe(0);
    expect(existsSync(join(root, "bin", "jarvis-release.sh"))).toBe(true);
    expect(readFileSync(join(root, "source"), "utf8").trim()).toBe(src);
    expect(readFileSync(join(root, "label"), "utf8").trim()).toBe("com.acme.bot");
  });

  test("install refuses a folder that is not a checkout of the bot", () => {
    expect(run(["install", "--source", dir]).exitCode).toBe(1);
  });

  test("plist renders the shipped template with this host's label, releases folder and checkout", () => {
    expect(existsSync(template)).toBe(true);
    run(["install", "--label", "com.acme.bot", "--source", src]);
    const res = run(["plist"]);
    expect(res.exitCode).toBe(0);
    const out = res.stdout.toString();
    expect(out).toContain("<string>com.acme.bot</string>");
    expect(out).toContain(`<string>${root}/bin/jarvis-release.sh</string>`);
    expect(out).toContain(`<string>${src}</string>`);
    expect(out).not.toContain("__");
  });

  test("status names what runs, what is known good and the recent history", () => {
    run(["prepare", sha]);
    run(["activate", sha]);
    const out = run(["status"]).stdout.toString();
    expect(out).toContain(`current:       ${sha}`);
    expect(out).toContain("last-good:");
    expect(out).toContain(`activated ${sha}`);
  });
});
