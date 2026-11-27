/**
 * The seatbelt profile against a fake home and a fake checkout: each escape is
 * first shown OPEN without the sandbox (so a "closed" result means the profile
 * did it, not a typo in the probe) and then CLOSED inside it.
 *
 * macOS only (sandbox-exec). Elsewhere every test here is skipped, with this marker:
 *   SKIPPED sandbox profile tests: needs macOS sandbox-exec (platform=<x>)
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MAC = process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec");
if (!MAC) console.log(`SKIPPED sandbox profile tests: needs macOS sandbox-exec (platform=${process.platform})`);
const t = (name: string, fn: () => void): void => test.skipIf(!MAC)(name, fn, 60_000);

const ROOT = join(import.meta.dir, "..", "..");
const WRAPPER = join(ROOT, "bin", "sandboxed.sh");

let base = "";
let home = "";
let repo = "";
let work = "";

const write = (p: string, s: string): void => {
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, s);
};

beforeAll(() => {
  if (!MAC) return;
  base = realpathSync(mkdtempSync(join(tmpdir(), "seatbelt-")));
  home = join(base, "home");
  repo = join(base, "repo");
  work = join(base, "work");
  for (const d of [home, repo, work]) mkdirSync(d, { recursive: true });
  write(join(home, ".config/gh/hosts.yml"), "oauth_token: SECRET\n");
  write(join(home, ".config/jarvis/app-key.pem"), "KEY\n");
  write(join(home, ".config/jarvis/sandbox-secret"), "SECRET\n");
  write(join(home, ".config/jarvis/worker-tickets/aaaaaaaa"), "jvwk_mine\n");
  write(join(home, ".config/jarvis/worker-tickets/bbbbbbbb"), "jvwk_other\n");
  write(join(home, ".ssh/id_ed25519"), "SSH\n");
  write(join(home, ".aws/credentials"), "AWS\n");
  write(join(home, "Library/Keychains/login.keychain-db"), "KC\n");
  write(join(home, "Library/Application Support/orca/orca-runtime.json"), '{"token":"T"}\n');
  write(join(home, ".zshrc"), "# rc\n");
  write(join(home, "Library/LaunchAgents/keep"), "");
  write(join(repo, ".env"), "SLACK_BOT_TOKEN=SECRET\n");
  write(join(repo, "data/jarvis.db"), "DB\n");
  write(join(repo, "data/jarvis.db-wal"), "WAL\n");
  write(join(repo, "bin/tool.sh"), "#!/bin/sh\n");
  write(join(repo, ".githooks/pre-commit"), "#!/bin/sh\n");
  write(join(repo, ".git/hooks/pre-commit"), "#!/bin/sh\n");
  write(join(repo, "src/ok.ts"), "ok\n");
  write(join(repo, "package.json"), "{}\n");
  write(join(repo, ".git/config"), "[core]\n");
  write(join(repo, ".claude/worktrees/w1/src/mine.ts"), "mine\n");
  write(join(home, ".gitconfig"), "[user]\n");
  write(join(home, ".claude.json"), "{}\n");
  write(join(home, ".claude/plugins/p/hook.sh"), "#!/bin/sh\n");
  write(join(home, ".config/other/keep"), "");
});
afterAll(() => {
  if (base) rmSync(base, { recursive: true, force: true });
});

type R = { code: number; out: string };

const bare = (script: string, env: Record<string, string> = {}): R => {
  const p = Bun.spawnSync({ cmd: ["/bin/bash", "-c", script], cwd: work, env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: home, ...env } });
  return { code: p.exitCode ?? -1, out: `${p.stdout}${p.stderr}` };
};

const boxed = (script: string, env: Record<string, string> = {}): R => {
  const p = Bun.spawnSync({
    cmd: [WRAPPER, "--", "/bin/bash", "-c", script],
    cwd: work,
    env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: home, JARVIS_SANDBOX_HOME: home, JARVIS_REPO: repo, SEATBELT_NO_SESSION: "1", ...env },
  });
  return { code: p.exitCode ?? -1, out: `${p.stdout}${p.stderr}` };
};

/** Open outside the box, refused inside it: the shape of every escape test. */
const closed = (script: string, env: Record<string, string> = {}): void => {
  const open = bare(script, env);
  expect(open.code).toBe(0);
  const shut = boxed(script, env);
  expect(shut.code).not.toBe(0);
};

describe("sandbox profile (macOS)", () => {
  t("sanity: an ordinary command, the checkout's sources and the work dir still work", () => {
    const r = boxed(`cat '${repo}/src/ok.ts' && echo hi > '${work}/x' && cat '${work}/x'`);
    expect(r).toEqual({ code: 0, out: "ok\nhi\n" });
  });

  describe("secrets cannot be read", () => {
    for (const [what, rel] of [
      ["gh login", ".config/gh/hosts.yml"],
      ["GitHub App key", ".config/jarvis/app-key.pem"],
      ["proxy signing secret", ".config/jarvis/sandbox-secret"],
      ["ssh key", ".ssh/id_ed25519"],
      ["aws credentials", ".aws/credentials"],
      ["keychain files", "Library/Keychains/login.keychain-db"],
      ["orca runtime token", "Library/Application Support/orca/orca-runtime.json"],
    ] as const) {
      t(what, () => closed(`cat "$HOME/${rel}" >/dev/null`));
    }
    t("the bot's .env", () => closed(`cat '${repo}/.env' >/dev/null`));
    t("the bot's databases (and wal)", () => {
      closed(`cat '${repo}/data/jarvis.db' >/dev/null`);
      closed(`cat '${repo}/data/jarvis.db-wal' >/dev/null`);
    });
  });

  describe("worker tickets", () => {
    t("a worker reads the ticket file it is given", () => {
      expect(boxed(`cat "$HOME/.config/jarvis/worker-tickets/aaaaaaaa"`)).toEqual({ code: 0, out: "jvwk_mine\n" });
    });
    t("but cannot list the directory to find the others", () => {
      closed(`ls "$HOME/.config/jarvis/worker-tickets" >/dev/null`);
    });
    t("nor read the proxy secret that sits next to it", () => {
      closed(`cat "$HOME/.config/jarvis/sandbox-secret" >/dev/null`);
    });
  });

  describe("persistence and tampering cannot be written", () => {
    t("shell rc file", () => closed(`echo x >> "$HOME/.zshrc"`));
    t("a new LaunchAgent", () => closed(`echo x > "$HOME/Library/LaunchAgents/evil.plist"`));
    t("gh config", () => closed(`echo x > "$HOME/.config/gh/config.yml"`));
    t("jarvis config", () => closed(`echo x > "$HOME/.config/jarvis/new"`));
    t("ssh dir", () => closed(`echo x > "$HOME/.ssh/authorized_keys"`));
    t("the claude settings (hooks run outside the sandbox's view)", () => {
      write(join(home, ".claude/keep"), "");
      closed(`echo '{}' > "$HOME/.claude/settings.json"`);
    });
    t("the checkout's bin, .githooks and .git/hooks", () => {
      closed(`echo x >> '${repo}/bin/tool.sh'`);
      closed(`echo x >> '${repo}/.githooks/pre-commit'`);
      closed(`echo x >> '${repo}/.git/hooks/pre-commit'`);
    });
  });

  describe("round 1 of the review: renames, wider writes, keystrokes", () => {
    t("renaming a protected file or folder away does not open it (mv, then cat)", () => {
      closed(`mv '${repo}/.env' '${work}/e' && cat '${work}/e' >/dev/null`);
      write(join(repo, ".env"), "SLACK_BOT_TOKEN=SECRET\n");
      closed(`mv '${repo}/data/jarvis.db' '${work}/d' && cat '${work}/d' >/dev/null`);
      write(join(repo, "data/jarvis.db"), "DB\n");
      closed(`mv "$HOME/.aws" '${work}/aws' && cat '${work}/aws/credentials' >/dev/null`);
      closed(`mv "$HOME/Library/Application Support/orca/orca-runtime.json" '${work}/o' && cat '${work}/o' >/dev/null`);
      write(join(home, "Library/Application Support/orca/orca-runtime.json"), '{"token":"T"}\n');
    });
    t("nor does moving the folder that holds it (~/.config, the checkout's data/)", () => {
      try {
        closed(`mv "$HOME/.config" '${work}/cfg' && cat '${work}/cfg/gh/hosts.yml' >/dev/null`);
      } finally {
        if (!existsSync(join(home, ".config")) && existsSync(join(work, "cfg"))) Bun.spawnSync({ cmd: ["mv", join(work, "cfg"), join(home, ".config")] });
      }
      try {
        closed(`mv '${repo}/data' '${work}/dd' && cat '${work}/dd/jarvis.db' >/dev/null`);
      } finally {
        if (!existsSync(join(repo, "data")) && existsSync(join(work, "dd"))) Bun.spawnSync({ cmd: ["mv", join(work, "dd"), join(repo, "data")] });
      }
    });
    t("what the host runs later is not writable: .env, .git/config, src, package.json, gitconfig, claude config and plugins", () => {
      closed(`echo x >> '${repo}/.env'`);
      closed(`echo x >> '${repo}/.git/config'`);
      closed(`echo x >> '${repo}/src/ok.ts'`);
      closed(`echo x >> '${repo}/package.json'`);
      closed(`echo x >> "$HOME/.gitconfig"`);
      closed(`echo x >> "$HOME/.claude.json"`);
      closed(`echo x >> "$HOME/.claude/plugins/p/hook.sh"`);
    });
    t("a worker's own worktree under the checkout, and the claude config's neighbours, stay writable", () => {
      expect(boxed(`echo more >> '${repo}/.claude/worktrees/w1/src/mine.ts' && cat '${repo}/.claude/worktrees/w1/src/mine.ts'`)).toEqual({ code: 0, out: "mine\nmore\n" });
      expect(boxed(`echo x > "$HOME/.config/other/new" && cat "$HOME/.config/other/new"`)).toEqual({ code: 0, out: "x\n" });
    });
    t("TIOCSTI (typing into the terminal that started us) is refused", () => {
      const probe = join(work, "tiocsti.py");
      writeFileSync(probe, "import fcntl,termios,sys\ntry:\n fcntl.ioctl(0, termios.TIOCSTI, b'X'); print('INJECTED')\nexcept OSError as e: print('REFUSED')\n");
      const runPty = (boxedRun: boolean): string => {
        const cmd = boxedRun ? `'${WRAPPER}' -- /usr/bin/python3 '${probe}'` : `/usr/bin/python3 '${probe}'`;
        const driver = `import os,pty,select,sys\npid,fd=pty.fork()\nif pid==0: os.execvp('/bin/bash',['/bin/bash','-c',sys.argv[1]])\nout=b''\nwhile True:\n r,_,_=select.select([fd],[],[],8)\n if not r: break\n try: d=os.read(fd,1000)\n except OSError: break\n if not d: break\n out+=d\nprint(out.decode())\n`;
        const p = Bun.spawnSync({ cmd: ["/usr/bin/python3", "-c", driver, cmd], cwd: work, env: { PATH: "/usr/bin:/bin", HOME: home, JARVIS_SANDBOX_HOME: home, JARVIS_REPO: repo, SEATBELT_NO_SESSION: "1" } });
        return String(p.stdout);
      };
      expect(runPty(false)).toContain("INJECTED");
      const shut = runPty(true);
      expect(shut).toContain("REFUSED");
      expect(shut).not.toContain("INJECTED");
    });
  });

  describe("starting something outside the sandbox", () => {
    // Copies of the system binaries: the profile must refuse the exec itself, not rely on a path.
    const copy = (src: string, name: string): string => {
      const dst = join(work, name);
      copyFileSync(src, dst);
      chmodSync(dst, 0o755);
      return dst;
    };

    t("launchctl submit (a launchd job runs outside the sandbox)", () => {
      write(join(work, "secret.txt"), "x");
      const job = `/bin/cat '${join(home, ".config/gh/hosts.yml")}' > '${work}/leak'`;
      const script = `launchctl submit -l seatbelt.test.$$ -- /bin/sh -c "${job}"; sleep 3; test -s '${work}/leak'`;
      rmSync(join(work, "leak"), { force: true });
      expect(boxed(script).code).not.toBe(0);
      expect(existsSync(join(work, "leak"))).toBe(false);
      expect(bare("launchctl remove seatbelt.test.x 2>/dev/null; true").code).toBe(0);
    });

    t("launchctl bootstrap with a plist it wrote", () => {
      const plist = join(work, "job.plist");
      writeFileSync(plist, `<?xml version="1.0"?><plist version="1.0"><dict><key>Label</key><string>seatbelt.test.bs</string><key>ProgramArguments</key><array><string>/bin/sh</string><string>-c</string><string>/bin/cat '${join(home, ".config/gh/hosts.yml")}' > '${work}/leak2'</string></array><key>RunAtLoad</key><true/></dict></plist>`);
      rmSync(join(work, "leak2"), { force: true });
      boxed(`launchctl bootstrap gui/$(id -u) '${plist}'; sleep 3`);
      expect(existsSync(join(work, "leak2"))).toBe(false);
    });

    t("a copied (re-signed) launchctl is refused too: open outside, refused inside", () => {
      const lc = copy("/bin/launchctl", "lc");
      // a plain copy of a system binary is killed by the OS; re-signing makes it a real copy that runs
      Bun.spawnSync({ cmd: ["codesign", "-f", "-s", "-", lc] });
      const ctl = join(work, "ctl.plist");
      writeFileSync(ctl, `<?xml version="1.0"?><plist version="1.0"><dict><key>Label</key><string>seatbelt.test.ctl</string><key>ProgramArguments</key><array><string>/usr/bin/touch</string><string>${work}/leak-ctl</string></array><key>RunAtLoad</key><true/></dict></plist>`);
      rmSync(join(work, "leak-ctl"), { force: true });
      bare(`'${lc}' bootstrap gui/$(id -u) '${ctl}'; sleep 2`);
      const wasOpen = existsSync(join(work, "leak-ctl"));
      bare(`'${lc}' bootout gui/$(id -u)/seatbelt.test.ctl 2>/dev/null; true`);
      expect(wasOpen).toBe(true);
      const plist = join(work, "job3.plist");
      writeFileSync(plist, `<?xml version="1.0"?><plist version="1.0"><dict><key>Label</key><string>seatbelt.test.cp</string><key>ProgramArguments</key><array><string>/usr/bin/touch</string><string>${work}/leak3</string></array><key>RunAtLoad</key><true/></dict></plist>`);
      rmSync(join(work, "leak3"), { force: true });
      boxed(`'${lc}' bootstrap gui/$(id -u) '${plist}'; sleep 3`);
      expect(existsSync(join(work, "leak3"))).toBe(false);
    });

    t("osascript (Apple Events)", () => {
      const open = bare(`perl -e 'alarm 10; exec @ARGV or exit 126' /usr/bin/osascript -e '1+1'`);
      expect(open.out).toContain("2");
      const shut = boxed(`perl -e 'alarm 10; exec @ARGV or exit 126' /usr/bin/osascript -e '1+1'`);
      expect(shut.out).not.toContain("2\n");
      expect(shut.code).not.toBe(0);
      const cp = copy("/usr/bin/osascript", "osa");
      expect(boxed(`perl -e 'alarm 10; exec @ARGV or exit 126' '${cp}' -e '1+1'`).code).not.toBe(0);
    });

    t("open (LaunchServices)", () => {
      expect(boxed(`perl -e 'alarm 10; exec @ARGV or exit 126' /usr/bin/open -g -a Finder`).code).not.toBe(0);
    });

    t("cron and at", () => {
      expect(boxed(`echo '* * * * * true' | crontab -`).code).not.toBe(0);
      expect(boxed(`echo true | at now 2>&1`).code).not.toBe(0);
    });

    t("security (the keychain), by path and as a copy", () => {
      expect(boxed(`security find-generic-password -s nothing-here`).out).not.toContain("password:");
      const cp = copy("/usr/bin/security", "sec");
      const r = boxed(`'${cp}' list-keychains`);
      expect(r.code).not.toBe(0);
    });
  });

  describe("credentials the environment would carry", () => {
    t("GH_TOKEN, GITHUB_TOKEN, SSH_AUTH_SOCK and askpass helpers are scrubbed", () => {
      const env = { GH_TOKEN: "x", GITHUB_TOKEN: "x", GH_ENTERPRISE_TOKEN: "x", SSH_AUTH_SOCK: "/tmp/none", GIT_ASKPASS: "/x", SSH_ASKPASS: "/x", GIT_SSH_COMMAND: "x" };
      const r = boxed(`env | grep -E '^(GH_TOKEN|GITHUB_TOKEN|GH_ENTERPRISE_TOKEN|SSH_AUTH_SOCK|GIT_ASKPASS|SSH_ASKPASS|GIT_SSH_COMMAND)=' ; true`, env);
      expect(r.out).toBe("");
    });
    t("gh's config dir is an empty temp dir, and the shims are first on PATH", () => {
      const r = boxed(`echo "$GH_CONFIG_DIR"; ls -A "$GH_CONFIG_DIR" | wc -l; command -v gh`);
      const [dir, count, gh] = r.out.trim().split("\n");
      expect(dir).not.toContain(".config/gh");
      expect(count?.trim()).toBe("0");
      expect(gh).toBe(join(ROOT, "bin", "sandbox-shims", "gh"));
    });
    t("the ssh agent socket is not reachable", () => {
      const sock = join(base, "agent.sock");
      const start = Bun.spawnSync({ cmd: ["/usr/bin/ssh-agent", "-a", sock] });
      expect(start.exitCode).toBe(0);
      const pid = String(start.stdout).match(/SSH_AGENT_PID=(\d+)/)?.[1];
      try {
        const open = bare(`SSH_AUTH_SOCK='${sock}' ssh-add -l`);
        expect(open.out).toContain("no identities");
        const shut = boxed(`SSH_AUTH_SOCK='${sock}' ssh-add -l`);
        expect(shut.out).not.toContain("no identities");
      } finally {
        if (pid) process.kill(Number(pid));
      }
    });
  });

  describe("the wrapper itself", () => {
    t("an exported JARVIS_SANDBOXED=1 does not skip the sandbox: the OS is asked, not the variable", () => {
      const p = Bun.spawnSync({ cmd: [WRAPPER, "--", "/bin/bash", "-c", `cat '${repo}/.env' >/dev/null; echo "rc=$?"`], cwd: work, env: { PATH: "/usr/bin:/bin", HOME: home, JARVIS_SANDBOX_HOME: home, JARVIS_REPO: repo, SEATBELT_NO_SESSION: "1", JARVIS_SANDBOXED: "1" } });
      expect(String(p.stdout)).not.toContain("rc=0");
    });
    t("is a no-op when already inside (a worker that calls it again gains nothing)", () => {
      const r = boxed(`'${WRAPPER}' -- /bin/echo nested`);
      expect(r).toEqual({ code: 0, out: "nested\n" });
    });
    t("fails closed: with no sandbox-exec it refuses rather than run unsandboxed", () => {
      const empty = join(base, "emptybin");
      mkdirSync(empty, { recursive: true });
      for (const c of ["bash", "uname", "dirname", "cat", "sed", "mkdir", "mktemp", "rm", "env", "tr", "grep"]) {
        const src = ["/bin", "/usr/bin"].map((d) => join(d, c)).find(existsSync);
        if (src) Bun.spawnSync({ cmd: ["ln", "-sf", src, join(empty, c)] });
      }
      const p = Bun.spawnSync({ cmd: ["/bin/bash", WRAPPER, "--", "/bin/echo", "ran"], env: { PATH: empty, HOME: home, JARVIS_REPO: repo, SEATBELT_NO_SESSION: "1" } });
      expect(p.exitCode).toBe(78);
      expect(String(p.stdout)).not.toContain("ran");
    });
    t("refuses a path that would break out of the profile", () => {
      const p = Bun.spawnSync({ cmd: [WRAPPER, "--", "/bin/echo", "ran"], env: { PATH: "/usr/bin:/bin", HOME: home, JARVIS_REPO: `${repo}"x`, SEATBELT_NO_SESSION: "1" } });
      expect(p.exitCode).toBe(78);
      expect(String(p.stdout)).not.toContain("ran");
    });
    t("--print-profile leaves no placeholder behind", () => {
      const p = Bun.spawnSync({ cmd: [WRAPPER, "--print-profile"], env: { PATH: "/usr/bin:/bin", HOME: home, JARVIS_REPO: repo } });
      expect(p.exitCode).toBe(0);
      expect(String(p.stdout)).not.toMatch(/@[A-Z_]+@/);
      expect(String(p.stdout)).toContain(repo);
    });
  });
});
