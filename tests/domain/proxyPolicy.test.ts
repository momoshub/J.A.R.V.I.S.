import { describe, expect, test } from "bun:test";
import { classifyGh, classifyOrca } from "../../src/domain/proxyPolicy.ts";

const ok = (c: ReturnType<typeof classifyGh>) => {
  if (!c.ok) throw new Error(`refused: ${c.error}`);
  return c;
};
const refusal = (c: ReturnType<typeof classifyGh>): string => (c.ok ? "" : c.error);

describe("classifyGh: reads", () => {
  test("what workers, reviewers and verifiers read is a read, aimed at the named repo", () => {
    for (const line of [
      "pr view 12 --json title,body -R o/r",
      "pr diff 12 -R o/r",
      "pr list --state open -R o/r",
      "pr checks 12 -R o/r",
      "pr status -R o/r",
      "issue view 3 -R o/r",
      "run list -R o/r --limit 5",
      "run view 99 --log -R o/r",
      "workflow list -R o/r",
      "repo view o/r",
    ]) {
      const c = ok(classifyGh(line.split(" ")));
      expect(c.need).toEqual({ kind: "read" });
    }
  });

  test("the repo comes from -R, a PR url, or the clone the caller is in, and is always passed on as -R", () => {
    expect(ok(classifyGh(["pr", "view", "https://github.com/o/r/pull/4"])).repo).toBe("o/r");
    const hinted = ok(classifyGh(["pr", "view", "4"], "o/r"));
    expect(hinted.repo).toBe("o/r");
    expect(hinted.argv.slice(-2)).toEqual(["-R", "o/r"]);
    expect(refusal(classifyGh(["pr", "view", "4"]))).toContain("which repository");
    expect(refusal(classifyGh(["pr", "view", "4", "-R", "evil.example/o/r"]))).toContain("owner/name");
  });

  test("gh api is a GET under repos/<owner>/<name>/ and nothing that sends something", () => {
    const c = ok(classifyGh(["api", "repos/o/r/pulls/1/reviews", "--paginate", "-q", ".[].id"]));
    expect(c).toMatchObject({ need: { kind: "read" }, repo: "o/r", argv: ["api", "repos/o/r/pulls/1/reviews", "--paginate", "--jq", ".[].id"] });
    expect(ok(classifyGh(["api", "/repos/o/r/issues?state=all"])).repo).toBe("o/r");
    for (const bad of [
      ["api", "graphql"],
      ["api", "user"],
      ["api", "orgs/o/members"],
      ["api", "repos/o/r/issues", "-X", "POST"],
      ["api", "repos/o/r/issues", "-f", "title=x"],
      ["api", "repos/o/r/issues", "-F", "body=@/etc/passwd"],
      ["api", "repos/o/r/issues", "-H", "Authorization: token x"],
      ["api", "repos/o/r/issues", "--input", "/etc/passwd"],
      ["api", "repos/o/r/../../orgs/x"],
      ["api", "repos/o/r/x", "repos/o/r/y"],
    ]) {
      expect(classifyGh(bad).ok).toBe(false);
    }
    expect(ok(classifyGh(["api", "repos/o/r/pulls", "-X", "GET"])).need).toEqual({ kind: "read" });
  });
});

describe("classifyGh: writes are named by the action whose grant they need", () => {
  test("comment, review, edit, close, reopen and create", () => {
    const need = (line: string) => ok(classifyGh(line.split(" "), "o/r")).need;
    expect(need("pr comment 1 --body hi")).toEqual({ kind: "write", action: "comment" });
    expect(need("issue comment 1 --body hi")).toEqual({ kind: "write", action: "comment" });
    expect(need("pr review 1 --comment -b looks-ok")).toEqual({ kind: "write", action: "comment" });
    expect(need("pr edit 1 --title x")).toEqual({ kind: "write", action: "pr-edit" });
    expect(need("pr close 1")).toEqual({ kind: "write", action: "pr-close" });
    expect(need("pr reopen 1")).toEqual({ kind: "write", action: "pr-reopen" });
    expect(need("pr create --title t --body b --head h --base main")).toEqual({ kind: "write", action: "pr-create" });
  });

  test("merging is never proxied, whatever the flags", () => {
    for (const line of ["pr merge 1", "pr merge 1 --admin --squash", "pr merge https://github.com/o/r/pull/1"]) {
      expect(refusal(classifyGh(line.split(" "), "o/r"))).toContain("merge-when-green");
    }
  });

  test("everything else is refused: auth, config, alias, extension, secret, release, repo delete, run rerun, graphql", () => {
    for (const line of [
      "auth token",
      "auth status",
      "config set x y",
      "alias set x y",
      "extension install x",
      "secret set X",
      "ssh-key add",
      "repo delete o/r",
      "repo clone o/r",
      "release create v1",
      "run rerun 1",
      "run cancel 1",
      "run download 1",
      "issue create --title x",
      "label create x",
      "codespace create",
    ]) {
      expect(classifyGh(line.split(" "), "o/r").ok).toBe(false);
    }
  });

  test("flags that would open a browser or editor, read a bot-side file or aim at another host are refused", () => {
    for (const flag of ["--web", "--editor", "--hostname=ghe.example", "--template", "--with-token"]) {
      expect(classifyGh(["pr", "view", "1", flag], "o/r").ok).toBe(false);
    }
  });

  test("a body file must be stdin: the shim reads the caller's file, the bot never opens a path the caller names", () => {
    expect(refusal(classifyGh(["pr", "comment", "1", "--body-file", "/Users/x/.config/gh/hosts.yml"], "o/r"))).toContain("stdin");
    expect(refusal(classifyGh(["pr", "comment", "1", "-F", "../x"], "o/r"))).toContain("stdin");
    expect(classifyGh(["pr", "comment", "1", "--body-file", "-"], "o/r").ok).toBe(true);
    expect(classifyGh(["pr", "comment", "1", "-F", "-"], "o/r").ok).toBe(true);
  });

  test("the audit label names the command and repo, never the text", () => {
    expect(ok(classifyGh(["pr", "comment", "1", "--body", "secret words"], "o/r")).label).toBe("pr comment o/r");
  });
});

describe("classifyOrca", () => {
  test("messaging, reading and dispatching are served; the level says which", () => {
    const level = (line: string) => {
      const c = classifyOrca(line.split(" "));
      return c.ok ? (c.need.kind === "orca" ? c.need.level : "?") : `refused: ${c.error}`;
    };
    expect(level("orchestration send --to term_1 --type status --body hi")).toBe("message");
    expect(level("orchestration check")).toBe("message");
    expect(level("orchestration reply --id m1 --body x")).toBe("message");
    expect(level("orchestration ask --question q")).toBe("message");
    expect(level("orchestration task-list --run r --json")).toBe("read");
    expect(level("orchestration worker-show --dispatch ctx_1")).toBe("read");
    expect(level("orchestration worker-start --spec x --agent claude --model opus --worktree path:/w")).toBe("start");
    expect(level("orchestration worker-stop --dispatch ctx_1")).toBe("start");
    expect(level("status")).toBe("read");
  });

  test("terminals, agents, worktrees, accounts, plugins and the rest of orca are refused: each would start something outside the sandbox", () => {
    for (const line of [
      "terminal send --terminal t --text id --enter",
      "terminal create",
      "agent launch --agent claude",
      "worktree create --name x",
      "account add",
      "plugin test .",
      "serve",
      "open",
      "skills install x",
      "orchestration dispatch --task t --to term_1",
      "orchestration reset",
      "orchestration coordinator-start",
      "orchestration",
    ]) {
      expect(classifyOrca(line.split(" ")).ok).toBe(false);
    }
  });

  test("worker-start must be a fresh claude: no existing terminal, no other agent, no other server, no bot-side spec file", () => {
    const start = (extra: string) => classifyOrca(`orchestration worker-start ${extra}`.split(" "));
    expect(start("--spec x --agent claude").ok).toBe(true);
    expect(start("--spec-file - --agent claude").ok).toBe(true);
    expect(start("--spec x --terminal term_abc").ok).toBe(false);
    expect(start("--spec x --agent codex").ok).toBe(false);
    expect(start("--spec x").ok).toBe(false);
    expect(start("--spec-file /etc/passwd --agent claude").ok).toBe(false);
    expect(start("--spec x --agent claude --on remote").ok).toBe(false);
    expect(start("--spec x --agent claude --environment prod").ok).toBe(false);
    expect(start("--spec x --agent claude --pairing-code orca://pair").ok).toBe(false);
  });
});

describe("classifyGh: what the first review found", () => {
  const line = (l: string, hint = "o/r") => classifyGh(l.split(" "), hint);
  const no = (c: ReturnType<typeof classifyGh>): string => (c.ok ? "ALLOWED" : c.error);

  test("a short flag with its value attached is refused, not read past (-F/path is --body-file path)", () => {
    expect(no(line("pr comment 1 -F/etc/hosts"))).toContain("two words");
    expect(no(line("pr comment 1 -F=/etc/hosts"))).toContain("two words");
    expect(no(line("pr view 1 -Rother/repo"))).toContain("two words");
    expect(no(line("pr view 1 -- -R x/y"))).toContain("--");
  });

  test("a flag nobody listed is refused (an allowlist), whatever its name", () => {
    expect(no(line("pr create --recover /etc/hosts --title t"))).toContain("--recover");
    expect(no(line("pr view 1 --made-up"))).toContain("--made-up");
    expect(no(line("pr merge 1 --admin"))).toContain("merge-when-green");
  });

  test("a boolean flag does not swallow the next word: --comment then --body-file is still a body file", () => {
    expect(no(line("pr review 1 --comment --body-file /etc/hosts"))).toContain("stdin");
    expect(line("pr review 1 --comment --body-file -").ok).toBe(true);
  });

  test("a url and -R naming different repos are refused; the same repo twice is fine", () => {
    expect(no(line("pr comment https://github.com/o/other/pull/1 -R o/r -b x"))).toContain("different repositories");
    expect(line("pr comment https://github.com/O/R/pull/1 -R o/r -b x").ok).toBe(true);
    expect(no(line("pr view https://github.com/o/a/pull/1 https://github.com/o/b/pull/2"))).toContain("too many");
  });

  test("a proxied review is a comment: approving would be recorded under the host's own account", () => {
    expect(no(line("pr review 1 --approve -b x"))).toContain("comment only");
    expect(no(line("pr review 1 --request-changes -b x"))).toContain("comment only");
  });

  test("orca: a repeated flag is refused (the proxy and orca could read different ones), and so is a short flag", () => {
    expect(no(classifyOrca(["orchestration", "worker-start", "--agent", "codex", "--agent", "claude"]))).toContain("twice");
    expect(no(classifyOrca(["orchestration", "worker-start", "--agent=codex", "--agent", "claude"]))).toContain("twice");
    expect(no(classifyOrca(["orchestration", "check", "-x"]))).toContain("--like-this");
    expect(classifyOrca(["orchestration", "check", "--wait"]).ok).toBe(true);
  });
});

describe("classifyGh: what the second review found", () => {
  const line = (l: string, hint = "o/r") => classifyGh(l.split(" "), hint);
  const no = (c: ReturnType<typeof classifyGh>): string => (c.ok ? "ALLOWED" : c.error);

  test("a short flag and its long name are one flag: giving both is refused (last wins in gh, first in a naive parser)", () => {
    expect(no(line("pr comment 1 -F - --body-file /etc/hosts"))).toContain("twice");
    expect(no(line("pr comment 1 --body-file=/etc/hosts -F -"))).toContain("twice");
    expect(no(line("pr view 1 -R o/r --repo cli/cli"))).toContain("twice");
    expect(no(line("api repos/o/r/pulls -X GET --method POST"))).toContain("twice");
  });

  test("a body file given by its short name is still only stdin", () => {
    expect(no(line("pr comment 1 -F /etc/hosts"))).toContain("stdin");
  });

  test("only an https github.com url (or a number) selects a PR: http, www, upper-case hosts and owner/repo#n are refused", () => {
    for (const bad of ["http://github.com/evil/x/pull/1", "https://www.github.com/evil/x/pull/1", "https://GITHUB.com/evil/x/pull/1", "evil/x#1", "evil:branch", "feat/x"]) {
      expect(no(line(`pr view ${bad}`))).toContain("by its number");
    }
    expect(line("pr view 12").ok).toBe(true);
    expect(line("pr view https://github.com/o/r/pull/12").ok).toBe(true);
    expect(line("repo view o/r").ok).toBe(true);
  });

  test("a search may not reach into another repo, org or user", () => {
    expect(no(line("pr list --search repo:evil/x"))).toContain("--search");
    expect(no(line("pr list -S org:evil"))).toContain("--search");
    expect(line("pr list --search fix").ok).toBe(true);
  });
});

describe("classifyGh: what the third review found", () => {
  const no = (l: string): string => {
    const c = classifyGh(l.split(" "), "o/r");
    return c.ok ? "ALLOWED" : c.error;
  };
  test("gh's short letters mean different things per command: `pr review -a` approves and must not pass", () => {
    expect(no("pr review -a 1")).toContain("spell the option out");
    expect(no("pr review 1 -r -b x")).not.toBe("ALLOWED");
    expect(no("pr review 1 --approve")).toContain("comment only");
    expect(no("pr comment 1 -e")).toContain("spell the option out");
    expect(no("pr review 1 -c -b fine")).toBe("ALLOWED");
    expect(no("pr list -a me")).toBe("ALLOWED");
  });
});
