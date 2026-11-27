import { describe, expect, test } from "bun:test";
import {
  applyRoleProfile,
  isWorkerRole,
  parseRoleMcpDeny,
  profileOf,
  ROLE_PROFILES,
  roleHomeDir,
  roleMcpDeny,
  WORKER_ROLES,
} from "../../src/domain/workerRoles.ts";

describe("role profiles", () => {
  test("every role has one and the roles are the four the guides name", () => {
    expect([...WORKER_ROLES]).toEqual(["writer", "reviewer", "verifier", "investigator"]);
    for (const r of WORKER_ROLES) expect(ROLE_PROFILES[r].allow.length).toBeGreaterThan(0);
    expect(isWorkerRole("reviewer")).toBe(true);
    expect(isWorkerRole("owner")).toBe(false);
  });

  test("read-only roles cannot edit, push or merge, and the writer cannot merge by hand", () => {
    for (const r of ["reviewer", "investigator"] as const) {
      const { deny, allow } = ROLE_PROFILES[r];
      expect(deny).toContain("Edit");
      expect(deny).toContain("Bash(git push:*)");
      expect(deny).toContain("Bash(gh pr merge:*)");
      expect(deny).toContain("Bash(*github-app.sh pr-merge*)");
      expect(allow).not.toContain("Edit");
    }
    expect(ROLE_PROFILES.investigator.deny).toContain("Write");
    expect(ROLE_PROFILES.writer.deny).toContain("Bash(gh pr merge:*)");
    expect(ROLE_PROFILES.writer.deny).toContain("Bash(*github-app.sh pr-merge*)");
    expect(ROLE_PROFILES.writer.deny).not.toContain("Edit");
    expect(ROLE_PROFILES.writer.allow).toContain("Edit");
  });

  test("a reviewer may comment as the app and nothing else of it; the writer keeps the helper for its PR", () => {
    expect(ROLE_PROFILES.reviewer.allow).toContain("Bash(*github-app.sh comment*)");
    const denied = ROLE_PROFILES.reviewer.deny.join("\n");
    for (const a of ["pr-create", "pr-edit", "pr-close", "labels-add", "push", "git", "review"]) {
      expect(denied).toContain(`github-app.sh ${a}*`);
    }
    expect(denied).not.toContain("github-app.sh comment");
    expect(ROLE_PROFILES.writer.allow).toContain("Bash(*/bin/github-app.sh*)");
    expect(ROLE_PROFILES.writer.deny.join("\n")).not.toContain("github-app.sh pr-create");
  });

  test("no rule is both allowed and denied for a role", () => {
    for (const r of WORKER_ROLES) {
      const deny = new Set(ROLE_PROFILES[r].deny);
      expect(ROLE_PROFILES[r].allow.filter((a) => deny.has(a))).toEqual([]);
    }
  });
});

describe("rule syntax (checked against Claude Code 2.1.285)", () => {
  test("no rule mixes an inner * with the trailing :*, which the session reads as a literal prefix", () => {
    for (const r of WORKER_ROLES) {
      for (const rule of [...ROLE_PROFILES[r].allow, ...ROLE_PROFILES[r].deny]) {
        expect(/^Bash\(.*\*.*:\*\)$/.test(rule)).toBe(false);
      }
    }
  });

  test("a denied command is also denied behind an assignment, which a command substitution would otherwise slip through", () => {
    for (const r of ["writer", "reviewer"] as const) expect(ROLE_PROFILES[r].deny).toContain("Bash(*=* gh pr merge*)");
    expect(ROLE_PROFILES.reviewer.deny).toContain("Bash(*=* git push*)");
    expect(ROLE_PROFILES.reviewer.deny).toContain("Bash(git -C * push*)");
    expect(ROLE_PROFILES.reviewer.allow).toContain("Bash(*=* gh pr review*)");
  });

  test("global git options and GraphQL are shut for the read-only roles; the writer keeps GraphQL minus merge and push mutations", () => {
    for (const r of ["reviewer", "verifier", "investigator"] as const) {
      expect(ROLE_PROFILES[r].deny).toContain("Bash(git -*)");
      expect(ROLE_PROFILES[r].deny).toContain("Bash(*=* git -*)");
      expect(ROLE_PROFILES[r].deny).toContain("Bash(gh api graphql*)");
    }
    expect(ROLE_PROFILES.writer.deny).not.toContain("Bash(git -*)");
    expect(ROLE_PROFILES.writer.deny).not.toContain("Bash(gh api graphql*)");
    for (const m of ["mergePullRequest", "AutoMerge", "createCommitOnBranch", "updateRef"]) {
      expect(ROLE_PROFILES.writer.deny).toContain(`Bash(gh api graphql*${m}*)`);
    }
    expect(ROLE_PROFILES.reviewer.deny).toContain("Bash(gh api*-XPUT*)");
  });

  test("gh api cannot put commits on the remote without a method flag: refs, blobs, trees, commits, PRs and dispatches", () => {
    for (const r of WORKER_ROLES) expect(ROLE_PROFILES[r].deny).toContain("Bash(gh api*/git/refs*)");
    for (const r of ["reviewer", "verifier", "investigator"] as const) {
      for (const p of ["/git/commits", "/git/trees", "/git/blobs", "/dispatches", "/pulls -"]) {
        expect(ROLE_PROFILES[r].deny).toContain(`Bash(gh api*${p}*)`);
      }
      expect(ROLE_PROFILES[r].deny).toContain("Bash(*=* gh api*/git/blobs*)");
    }
  });

  test("a read of a file through gh api is not denied", () => {
    expect(ROLE_PROFILES.reviewer.deny.join("\n")).not.toContain("/contents");
  });

  test("reviewer and verifier may write only to scratch with the file tools; the investigator not at all", () => {
    for (const r of ["reviewer", "verifier"] as const) {
      expect(ROLE_PROFILES[r].allow).not.toContain("Write");
      expect(ROLE_PROFILES[r].allow).toContain("Edit(//private/tmp/**)");
      expect(ROLE_PROFILES[r].deny).toContain("Edit(//Users/**)");
    }
    expect(ROLE_PROFILES.writer.allow).toContain("Write");
  });

  test("a path rule is an Edit(path) one: the session refuses Write(path)", () => {
    for (const r of WORKER_ROLES) {
      for (const rule of [...ROLE_PROFILES[r].allow, ...ROLE_PROFILES[r].deny]) expect(rule.startsWith("Write(")).toBe(false);
    }
  });

  test("a deny list has no repeats", () => {
    for (const r of WORKER_ROLES) expect(new Set(ROLE_PROFILES[r].deny).size).toBe(ROLE_PROFILES[r].deny.length);
  });

  test("git -C is never allowed (a wildcard before the subcommand also approves -c options); cd is", () => {
    for (const r of WORKER_ROLES) {
      expect(ROLE_PROFILES[r].allow.filter((a) => a.includes("git -C"))).toEqual([]);
      expect(ROLE_PROFILES[r].allow).toContain("Bash(cd:*)");
    }
  });
});

describe("roleHomeDir", () => {
  test("sits next to the shared home, never inside it", () => {
    expect(roleHomeDir("/h/worker-home", "reviewer")).toBe("/h/worker-home-reviewer");
    expect(roleHomeDir("/h/worker-home/", "writer")).toBe("/h/worker-home-writer");
  });
});

describe("parseRoleMcpDeny / roleMcpDeny", () => {
  test("reads role=names pairs, drops blanks and repeats, and names an unknown role", () => {
    expect(parseRoleMcpDeny("reviewer=a, b;verifier=c;reviewer=a,d;;ghost=x;investigator=")).toEqual({
      deny: { reviewer: ["a", "b", "d"], verifier: ["c"], investigator: [] },
      unknown: ["ghost"],
    });
    expect(parseRoleMcpDeny(undefined)).toEqual({ deny: {}, unknown: [] });
  });

  test("a role loses the host-wide servers plus its own, once each", () => {
    expect(roleMcpDeny(["pg", "ch"], "reviewer=ch,x;writer=y", "reviewer")).toEqual(["pg", "ch", "x"]);
    expect(roleMcpDeny(["pg"], undefined, "writer")).toEqual(["pg"]);
  });
});

describe("applyRoleProfile", () => {
  test("a new file gets the role's lists", () => {
    const r = applyRoleProfile(undefined, "reviewer");
    if (!r.ok) throw new Error(r.error);
    expect(r.changed).toBe(true);
    expect(profileOf(r.text)).toEqual({ allow: [...ROLE_PROFILES.reviewer.allow], deny: [...ROLE_PROFILES.reviewer.deny] });
  });

  test("keeps every other setting, replaces the two lists, and is the same twice", () => {
    const existing = JSON.stringify({ deniedMcpServers: [{ serverName: "pg" }], permissions: { allow: ["Bash(old:*)"], deny: ["Bash(older:*)"], defaultMode: "default" } });
    const r = applyRoleProfile(existing, "investigator");
    if (!r.ok) throw new Error(r.error);
    const parsed = JSON.parse(r.text);
    expect(parsed.deniedMcpServers).toEqual([{ serverName: "pg" }]);
    expect(parsed.permissions.defaultMode).toBe("default");
    expect(parsed.permissions.allow).not.toContain("Bash(old:*)");
    expect(parsed.permissions.deny).toContain("Write");
    const again = applyRoleProfile(r.text, "investigator");
    expect(again.ok && again.changed).toBe(false);
  });

  test("refuses a file it cannot read as a settings object", () => {
    expect(applyRoleProfile("{nope", "writer").ok).toBe(false);
    expect(applyRoleProfile("[]", "writer").ok).toBe(false);
    expect(applyRoleProfile('{"permissions":[]}', "writer").ok).toBe(false);
  });
});
