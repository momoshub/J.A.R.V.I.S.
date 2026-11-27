import { describe, expect, test } from "bun:test";
import {
  boundariesFor,
  buildBrief,
  checkVerdict,
  agentAssignments,
  contractsFor,
  guardTests,
  type HistoryEntry,
  parseVerifyBriefArgs,
  pickVerifierAgent,
  policyExcerpts,
  prNumberOf,
  regressionHistory,
  requiredItemsOf,
  reviewBlockers,
} from "../../src/domain/verifyBrief.ts";

const known = [
  "src/application/commandTickets.ts",
  "src/application/commandTickets.test.ts",
  "tests/application/commandTickets.test.ts",
  "tests/web/systemModel.test.ts",
  "tests/web/systemDesign.test.ts",
  "tests/bin/dbBackup.test.ts",
  "bin/db-backup.ts",
  "src/config/env.ts",
  ".env.example",
];

describe("boundariesFor", () => {
  test("maps paths to the boundaries they cross, runtime only as the fallback", () => {
    const ids = (p: string[]) => boundariesFor(p).map((b) => b.id);
    expect(ids(["src/application/commandTickets.ts"])).toEqual(["ticket"]);
    expect(ids(["bin/merge-when-green.sh"])).toEqual(["pipeline", "script"]);
    expect(ids(["src/application/commands/chat.ts"])).toEqual(["command"]);
    expect(ids(["src/domain/somethingNew.ts"])).toEqual(["runtime"]);
    expect(ids(["README.md", "tests/domain/x.test.ts"])).toEqual([]);
  });

  test("every boundary has at least one adversarial case", () => {
    for (const b of boundariesFor(["src/application/commandTickets.ts", "src/config/env.ts", "bin/x.sh", "web/src/a.tsx"])) {
      expect(b.cases.length).toBeGreaterThan(0);
    }
  });
});

describe("contractsFor", () => {
  test("finds the tests, the system-model tests and the env contract of the changed paths", () => {
    const c = contractsFor(["src/application/commandTickets.ts", "src/config/env.ts"], known).map((x) => x.path);
    expect(c).toContain("src/application/commandTickets.test.ts");
    expect(c).toContain("tests/application/commandTickets.test.ts");
    expect(c).toContain("tests/web/systemModel.test.ts");
    expect(c).toContain(".env.example");
  });

  test("finds the existing script test and skips files the diff already changes", () => {
    expect(contractsFor(["bin/db-backup.ts"], known).map((x) => x.path)).toEqual(["tests/bin/dbBackup.test.ts"]);
    const c = contractsFor(["src/application/commandTickets.ts", "tests/web/systemModel.test.ts"], known).map((x) => x.path);
    expect(c).not.toContain("tests/web/systemModel.test.ts");
  });

  test("a changed test or doc is not a contract: the writer wrote it", () => {
    expect(contractsFor(["tests/bin/dbBackup.test.ts", "README.md"], known)).toEqual([]);
  });
});

describe("history", () => {
  const history: HistoryEntry[] = [
    { sha: "a".repeat(40), subject: "Merge pull request #9 from o/fix/bug7-cross-channel-post", files: ["src/application/slackProxy.ts", "tests/application/slackProxy.test.ts"] },
    { sha: "b".repeat(40), subject: "Merge pull request #8 from o/feat/new-thing", files: ["src/application/slackProxy.ts", "tests/application/slackProxy.test.ts"] },
    { sha: "c".repeat(40), subject: "Revert \"Merge pull request #7\"", files: ["src/application/other.ts"] },
    { sha: "d".repeat(40), subject: "Merge pull request #6 from o/fix/ticket-replay", files: ["src/application/slackProxy.ts", "tests/domain/slackProxy.test.ts"] },
  ];

  test("keeps fix, bug and revert subjects that touched a changed file", () => {
    const got = regressionHistory(history, ["src/application/slackProxy.ts"]);
    expect(got.map((h) => h.sha[0])).toEqual(["a", "d"]);
  });

  test("caps the list and names the tests the incidents touched, sorted and unique", () => {
    expect(regressionHistory(history, ["src/application/slackProxy.ts"], 1)).toHaveLength(1);
    expect(guardTests(regressionHistory(history, ["src/application/slackProxy.ts"]))).toEqual([
      "tests/application/slackProxy.test.ts",
      "tests/domain/slackProxy.test.ts",
    ]);
  });

  test("reads PR numbers and only blocking review rounds", () => {
    expect(prNumberOf("Merge pull request #125 from o/fix/x")).toBe(125);
    expect(prNumberOf("Fix thing (#42)")).toBe(42);
    expect(prNumberOf("plain")).toBeUndefined();
    const found = reviewBlockers(5, [
      "[review round 1]\nthe ticket is not bound\n\nVERDICT: changes",
      "[review round 2]\nok\n\nVERDICT: clean",
      "a human comment VERDICT: changes",
    ]);
    expect(found).toHaveLength(1);
    expect(found[0]?.excerpt).toContain("ticket is not bound");
  });
});

describe("policyExcerpts", () => {
  const md = "# Doc\n\n## Runtime\n\n- **A turn holds no secret.** Tokens stay out.\n- **Other.** Unrelated.\n\n```\nticket diagram\n```\n\nA ticket is bound to a repo.\n";
  test("takes bullets and paragraphs that name a keyword, tagged by heading, never code fences", () => {
    const got = policyExcerpts(md, ["holds no secret", "ticket"]);
    expect(got).toEqual(["[Runtime] - **A turn holds no secret.** Tokens stay out.", "[Runtime] A ticket is bound to a repo."]);
  });
});

describe("buildBrief", () => {
  const base = {
    head: "f".repeat(40),
    base: "origin/main",
    paths: ["src/application/commandTickets.ts"],
    known,
    docs: [{ name: "ARCHITECTURE.md", text: "## Runtime\n\n- **Commands.** `commandTickets` mints a one-turn ticket.\n" }],
    history: [{ sha: "a".repeat(40), subject: "Merge pull request #9 from o/fix/ticket", files: ["src/application/commandTickets.ts", "tests/application/commandTickets.test.ts"] }],
  };

  test("is deterministic and carries boundaries, policy, history, contracts and the required ids", () => {
    const a = buildBrief({ ...base, pr: 12 });
    expect(buildBrief({ ...base, pr: 12 })).toBe(a);
    expect(a).toContain("PR #12");
    expect(a).toContain("**ticket.1**");
    expect(a).toContain("commandTickets` mints a one-turn ticket");
    expect(a).toContain("Merge pull request #9 from o/fix/ticket");
    expect(a).toContain("tests/application/commandTickets.test.ts");
    expect(requiredItemsOf(a)).toEqual(["ticket.1", "ticket.2", "ticket.3"]);
  });

  test("never takes the PR description: the input has no field for it", () => {
    expect(buildBrief(base)).not.toMatch(/## (Summary|Description)/);
    expect(buildBrief(base)).toContain("does not come from the PR description");
  });

  test("a docs-only diff has no required items and says what to grep", () => {
    const a = buildBrief({ ...base, paths: ["README.md"] });
    expect(requiredItemsOf(a)).toEqual([]);
    expect(a).toContain("Docs-only");
  });

  test("says when blockers were not collected, and lists them when they were", () => {
    expect(buildBrief({ ...base, blockersNote: "--no-gh" })).toContain("not collected (--no-gh)");
    expect(buildBrief({ ...base, blockers: [{ pr: 3, excerpt: "[review round 1] bad" }] })).toContain("PR #3: [review round 1] bad");
  });

  test("a diff that edits a policy doc has it flagged as an edit to scrutinise, and the policy is labelled as read at the base", () => {
    const a = buildBrief({ ...base, paths: ["src/application/commandTickets.ts", "SECURITY.md"] });
    expect(a).toContain("This diff edits policy docs (`SECURITY.md`)");
    expect(a).toContain("Read at the merge base");
    expect(buildBrief(base)).not.toContain("This diff edits policy docs");
  });

  test("lists at most 60 paths", () => {
    const many = Array.from({ length: 70 }, (_, i) => `src/domain/f${i}.ts`);
    expect(buildBrief({ ...base, paths: many })).toContain("and 10 more");
  });
});

describe("checkVerdict", () => {
  const required = ["ticket.1", "ticket.2", "ticket.3"];
  test("ok when every item is exercised or n/a and the verdict is there", () => {
    const c = "Exercised: ticket.1, ticket.3\nn/a ticket.2: no other repo exists\nVERDICT: verified";
    expect(checkVerdict(required, c)).toMatchObject({ ok: true, verdict: "verified", missing: [] });
  });
  test("a verified verdict that leaves an item out is not ok", () => {
    const r = checkVerdict(required, "Exercised: ticket.1\nVERDICT: verified");
    expect(r.ok).toBe(false);
    expect(r.missing).toEqual(["ticket.2", "ticket.3"]);
  });
  test("a not-verified verdict is ok to post without every item, a missing verdict is not", () => {
    expect(checkVerdict(required, "VERDICT: not verified - it crashed").ok).toBe(true);
    expect(checkVerdict(required, "Exercised: ticket.1,ticket.2,ticket.3").verdict).toBe("missing");
  });
  test("a bold label and one line per item under an Exercised: header both count", () => {
    expect(checkVerdict(["ticket.1", "ticket.2"], "**Exercised:** ticket.1, ticket.2\nVERDICT: verified").ok).toBe(true);
    const listed = "Exercised:\n- ticket.1: replayed an expired one, refused\n  - **ticket.2**: other repo, refused\n\nVERDICT: verified";
    expect(checkVerdict(["ticket.1", "ticket.2"], listed)).toMatchObject({ ok: true, missing: [] });
    const na = "Exercised:\n- ticket.1: ok\n- n/a ticket.2: no second repo\nVERDICT: verified";
    expect(checkVerdict(["ticket.1", "ticket.2"], na).ok).toBe(true);
  });
  test("the list ends at a blank line: an id in later prose does not count", () => {
    const c = "Exercised:\n- ticket.1: ok\n\nticket.2 looked fine to me\nVERDICT: verified";
    expect(checkVerdict(["ticket.1", "ticket.2"], c).missing).toEqual(["ticket.2"]);
  });
  test("VERDICT: failed is the not-verified verdict", () => {
    expect(checkVerdict(["ticket.1"], "Exercised: ticket.1\nVERDICT: failed - broke")).toMatchObject({ ok: true, verdict: "not verified" });
  });
  test("an id only mentioned in prose does not count", () => {
    expect(checkVerdict(["ticket.1"], "I thought about ticket.1\nVERDICT: verified").missing).toEqual(["ticket.1"]);
  });
});

describe("pickVerifierAgent", () => {
  test("takes another model family when the host has one", () => {
    expect(pickVerifierAgent(["claude", "codex"], "sonnet")).toMatchObject({ agent: "codex", differentFamily: true });
    expect(pickVerifierAgent(["codex"], "sonnet").model).toBeUndefined();
  });
  test("the assignments eval cleanly in a shell and keep the model apart from the agent", () => {
    const run = (a: string) =>
      Bun.spawnSync(["bash", "-c", `eval "$1"; printf '%s|%s|%s' "$VERIFIER_AGENT" "$VERIFIER_MODEL" "$VERIFIER_NOTE"`, "x", a]).stdout.toString();
    const claude = pickVerifierAgent(["claude"], "sonnet");
    expect(run(agentAssignments(claude))).toBe(`claude|sonnet|${claude.note}`);
    const codex = pickVerifierAgent(["codex"], "sonnet");
    expect(run(agentAssignments(codex))).toBe(`codex||${codex.note}`);
    expect(run(agentAssignments({ ...claude, note: "it's $(touch /tmp/no) `x`" }))).toBe("claude|sonnet|it's $(touch /tmp/no) `x`");
  });
  test("falls back to claude on the worker model with a note", () => {
    const p = pickVerifierAgent(["claude"], "sonnet");
    expect(p).toMatchObject({ agent: "claude", model: "sonnet", differentFamily: false });
    expect(p.note).toContain("same family");
  });
});

describe("parseVerifyBriefArgs", () => {
  test("brief defaults and flags", () => {
    expect(parseVerifyBriefArgs(["brief"])).toEqual({ cmd: "brief", base: "origin/main", head: "HEAD", gh: true });
    expect(parseVerifyBriefArgs(["brief", "--pr", "7", "--no-gh", "--out", "b.md"])).toMatchObject({ pr: 7, gh: false, out: "b.md" });
  });
  test("agent and check", () => {
    expect(parseVerifyBriefArgs(["agent", "--available", "codex, claude"])).toEqual({ cmd: "agent", available: ["codex", "claude"], model: "sonnet" });
    expect(parseVerifyBriefArgs(["check", "--brief", "a", "--comment", "b"])).toEqual({ cmd: "check", brief: "a", comment: "b" });
  });
  test("bad input throws, no command is help", () => {
    expect(() => parseVerifyBriefArgs(["brief", "--pr", "x"])).toThrow();
    expect(() => parseVerifyBriefArgs(["brief", "--nope", "1"])).toThrow();
    expect(() => parseVerifyBriefArgs(["brief", "--base", "--output=x"])).toThrow();
    expect(() => parseVerifyBriefArgs(["brief", "--head", "-x"])).toThrow();
    expect(() => parseVerifyBriefArgs(["check", "--brief", "a"])).toThrow();
    expect(() => parseVerifyBriefArgs(["frob"])).toThrow();
    expect(parseVerifyBriefArgs([])).toEqual({ cmd: "help" });
  });
});
