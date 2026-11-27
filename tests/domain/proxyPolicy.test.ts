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
    expect(c).toMatchObject({ need: { kind: "read" }, repo: "o/r", argv: ["api", "repos/o/r/pulls/1/reviews", "--paginate", "-q", ".[].id"] });
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
    expect(need("pr review 1 --approve")).toEqual({ kind: "write", action: "review" });
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
