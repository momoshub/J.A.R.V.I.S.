import { describe, expect, test } from "bun:test";
import { evaluateGate, namesSha, parseGateList, touchesRuntime, type GateInput } from "../../src/domain/mergeGate.ts";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const BOT = "jarvis[bot]";

const base = (over: Partial<GateInput> = {}): GateInput => ({
  sha: SHA,
  pr: { state: "open", merged: false, draft: false, headSha: SHA, author: BOT, mergeable: true, mergeState: "clean" },
  files: ["src/domain/x.ts"],
  checks: [
    { name: "checks", status: "completed", conclusion: "success" },
    { name: "gitleaks", status: "completed", conclusion: "success" },
  ],
  reviews: [{ login: "rev", body: "[review round 1]\nall fine\nVERDICT: clean", commitId: SHA }],
  comments: [{ login: "rev", body: `[verify]\nverified ${SHA.slice(0, 7)}\nVERDICT: verified` }],
  requiredChecks: ["checks", "gitleaks"],
  attesters: ["rev"],
  botLogin: BOT,
  ...over,
});

const refusedWith = (input: GateInput, part: string) => {
  const d = evaluateGate(input);
  expect(d.decision).toBe("refused");
  expect("reasons" in d && d.reasons.join("\n")).toContain(part);
};

describe("touchesRuntime", () => {
  test("docs, skills, guides, dashboard UI and .env.example are not runtime", () => {
    expect(touchesRuntime(["README.md", "docs/a.png", "web/src/App.tsx", ".claude/skills/verify/SKILL.md", "data/prompt-guides/x.md", ".env.example"])).toBe(false);
  });
  test("anything else is: source, scripts, CI, tests, config", () => {
    for (const f of ["src/a.ts", "bin/merge-when-green.sh", ".github/workflows/ci.yml", "tests/a.test.ts", "package.json"]) expect(touchesRuntime(["README.md", f])).toBe(true);
  });
});

describe("evaluateGate", () => {
  test("green checks + clean review + verify on the sha -> merge, as runtime", () => {
    expect(evaluateGate(base())).toEqual({ decision: "merge", runtime: true });
  });

  test("a docs-only PR needs the checks and nothing else", () => {
    expect(evaluateGate(base({ files: ["README.md"], reviews: [], comments: [] }))).toEqual({ decision: "merge", runtime: false });
  });

  test("an incomplete file list counts as runtime", () => {
    refusedWith(base({ files: ["README.md"], filesComplete: false, reviews: [], comments: [] }), "review");
    expect(evaluateGate(base({ files: ["README.md"], filesComplete: true, reviews: [], comments: [] })).decision).toBe("merge");
  });

  test("closed, merged and draft PRs are refused", () => {
    refusedWith(base({ pr: { ...base().pr, state: "closed" } }), "closed");
    refusedWith(base({ pr: { ...base().pr, state: "closed", merged: true } }), "already merged");
    refusedWith(base({ pr: { ...base().pr, draft: true } }), "draft");
  });

  test("a head that is not the named sha waits (a push may be on its way)", () => {
    const d = evaluateGate(base({ pr: { ...base().pr, headSha: "f".repeat(40) } }));
    expect(d.decision).toBe("pending");
  });

  test("conflicts -> conflict, whatever else is true", () => {
    expect(evaluateGate(base({ pr: { ...base().pr, mergeable: false, mergeState: "dirty" } })).decision).toBe("conflict");
    expect(evaluateGate(base({ pr: { ...base().pr, mergeable: null, mergeState: "dirty" } })).decision).toBe("conflict");
  });

  test("mergeability not computed yet waits", () => {
    expect(evaluateGate(base({ pr: { ...base().pr, mergeable: null, mergeState: "unknown" } })).decision).toBe("pending");
  });

  test("a red or cancelled check is refused, even a non-required one", () => {
    refusedWith(base({ checks: [...base().checks, { name: "other", status: "completed", conclusion: "failure" }] }), "other: failure");
    expect(evaluateGate(base({ checks: [{ name: "checks", status: "completed", conclusion: "cancelled" }, base().checks[1]!] })).decision).toBe("pending");
  });

  test("a superseded cancelled run and a push-skipped run next to the green one do not make the check red (the shape real heads have)", () => {
    const run = (status: string, conclusion: string | null) => ({ name: "checks", status, conclusion });
    const gl = { name: "gitleaks", status: "completed", conclusion: "success" };
    expect(evaluateGate(base({ checks: [run("completed", "success"), run("completed", "cancelled"), run("completed", "skipped"), gl] })).decision).toBe("merge");
  });

  test("a required check with only skipped or only cancelled runs has not run: pending, never merge (a push-only `checks` run skips by its own `if:`)", () => {
    const gl = { name: "gitleaks", status: "completed", conclusion: "success" };
    for (const conclusion of ["skipped", "cancelled"]) {
      const d = evaluateGate(base({ checks: [{ name: "checks", status: "completed", conclusion }, gl] }));
      expect(d.decision).toBe("pending");
      expect("reasons" in d && d.reasons.join()).toContain("has not run on this head");
    }
  });

  test("a non-required name with only skipped runs is fine, only cancelled is red", () => {
    const ok = [...base().checks];
    expect(evaluateGate(base({ checks: [...ok, { name: "extra", status: "completed", conclusion: "skipped" }] })).decision).toBe("merge");
    refusedWith(base({ checks: [...ok, { name: "extra", status: "completed", conclusion: "cancelled" }] }), "extra: cancelled");
  });

  test("a red run is never hidden by a later green one of the same name (a second producer could post it); a running one waits", () => {
    const gl = { name: "gitleaks", status: "completed", conclusion: "success" };
    refusedWith(base({ checks: [{ name: "checks", status: "completed", conclusion: "failure" }, { name: "checks", status: "completed", conclusion: "success" }, gl] }), "checks: failure");
    refusedWith(base({ checks: [{ name: "checks", status: "completed", conclusion: "success" }, { name: "checks", status: "completed", conclusion: "failure" }, gl] }), "checks: failure");
    expect(evaluateGate(base({ checks: [{ name: "checks", status: "completed", conclusion: "success" }, { name: "checks", status: "in_progress", conclusion: null }, gl] })).decision).toBe("pending");
  });

  test("a required check missing or still running waits; neutral counts as green, skipped alone does not", () => {
    expect(evaluateGate(base({ checks: [base().checks[0]!] })).decision).toBe("pending");
    expect(evaluateGate(base({ checks: [{ name: "checks", status: "in_progress", conclusion: null }, base().checks[1]!] })).decision).toBe("pending");
    expect(evaluateGate(base({ checks: [{ name: "checks", status: "completed", conclusion: "neutral" }, { name: "gitleaks", status: "completed", conclusion: "success" }] })).decision).toBe("merge");
    expect(evaluateGate(base({ checks: [{ name: "checks", status: "completed", conclusion: "success" }, { name: "gitleaks", status: "completed", conclusion: "skipped" }] })).decision).toBe("pending");
  });

  test("a PR with no files is refused", () => {
    refusedWith(base({ files: [] }), "no files");
  });

  test("runtime needs a review from someone else, on this head, ending VERDICT: clean", () => {
    refusedWith(base({ reviews: [] }), "review round");
    refusedWith(base({ reviews: [{ login: "rev", body: "[review round 1]\nVERDICT: changes", commitId: SHA }] }), "VERDICT: clean");
    refusedWith(base({ reviews: [{ login: "rev", body: "[review round 1]\nVERDICT: clean", commitId: "a".repeat(40) }] }), "not the head");
    refusedWith(base({ reviews: [{ login: "rev", body: "[review round 1]\nVERDICT: clean\nbut see above", commitId: SHA }] }), "VERDICT: clean");
  });

  test("the latest round decides: a later changes beats an earlier clean, a later clean beats an earlier changes", () => {
    const changes = { login: "rev", body: "[review round 2]\nVERDICT: changes", commitId: SHA };
    const clean = { login: "rev", body: "[review round 1]\nVERDICT: clean", commitId: SHA };
    refusedWith(base({ reviews: [clean, changes] }), "round 2");
    refusedWith(base({ reviews: [changes, clean] }), "round 2");
    expect(evaluateGate(base({ reviews: [{ ...changes, body: "[review round 1]\nVERDICT: changes" }, { ...clean, body: "[review round 2]\nVERDICT: clean" }] })).decision).toBe("merge");
  });

  test("the author and the app cannot vouch for their own PR", () => {
    const forged = (login: string) => base({ reviews: [{ login, body: "[review round 1]\nVERDICT: clean", commitId: SHA }], comments: [{ login, body: `[verify] ${SHA}\nVERDICT: verified` }] });
    refusedWith(forged(BOT), "named attester");
    refusedWith(forged("JARVIS[BOT]"), "named attester");
    refusedWith({ ...forged("rev"), pr: { ...base().pr, author: "rev" } }, "named attester");
    refusedWith({ ...forged("jarvis[bot]"), attesters: ["jarvis[bot]"] }, "named attester");
  });

  test("only named attesters count: the repo is public, so an outsider's round 99 cannot override a real `changes`", () => {
    const real = { login: "rev", body: "[review round 1]\nVERDICT: changes", commitId: SHA };
    const outsider = { login: "stranger", body: "[review round 99]\nVERDICT: clean", commitId: SHA };
    refusedWith(base({ reviews: [real, outsider] }), "round 1");
    refusedWith(base({ attesters: ["someone-else"] }), "named attester");
    expect(evaluateGate(base({ attesters: ["REV"] })).decision).toBe("merge");
  });

  test("no attesters configured: a runtime PR is refused whatever is on it, docs-only still needs just checks", () => {
    refusedWith(base({ attesters: [] }), "MERGE_GATE_ATTESTERS names no account");
    expect(evaluateGate(base({ attesters: [], files: ["README.md"], reviews: [], comments: [] })).decision).toBe("merge");
  });

  test("an edited [verify] comment proves nothing (anyone with write access can edit it, keeping its author)", () => {
    const edited = { login: "rev", body: `[verify] ${SHA}\nVERDICT: verified`, edited: true };
    refusedWith(base({ comments: [edited] }), "was edited");
    // not skipped in favour of an older good one: `verified`, then `not verified`, then the second edited back must not pass
    refusedWith(base({ comments: [{ ...edited, edited: false }, edited] }), "was edited");
    expect(evaluateGate(base({ comments: [edited, { ...edited, edited: false }] })).decision).toBe("merge");
  });

  test("verify: must exist, say verified, and name the head", () => {
    refusedWith(base({ comments: [] }), "[verify]");
    refusedWith(base({ comments: [{ login: "rev", body: `[verify] ${SHA}\nVERDICT: not verified - missing evidence` }] }), "does not end `VERDICT: verified`");
    refusedWith(base({ comments: [{ login: "rev", body: `[verify] ${"a".repeat(40)}\nVERDICT: verified` }] }), "does not name the head");
  });

  test("the latest [verify] comment wins: a failed one after a verified one blocks, a stale one is replaced", () => {
    const ok = { login: "rev", body: `[verify] ${SHA}\nVERDICT: verified` };
    const failed = { login: "rev", body: `[verify] ${SHA}\nVERDICT: not verified - broke` };
    refusedWith(base({ comments: [ok, failed] }), "[verify]");
    expect(evaluateGate(base({ comments: [failed, ok] })).decision).toBe("merge");
  });

  test("a verified line in the middle does not count: the verdict is the last line", () => {
    refusedWith(base({ comments: [{ login: "rev", body: `[verify] ${SHA}\nVERDICT: verified\nthen it broke\nVERDICT: not verified - broke` }] }), "does not end");
  });

  test("a verify that names an old sha is stale after a push", () => {
    refusedWith(base({ comments: [{ login: "rev", body: `[verify] ${"b".repeat(40)}\nVERDICT: verified` }] }), "does not name the head");
  });

  test("every refusal reason is listed at once", () => {
    const d = evaluateGate(base({ reviews: [], comments: [], checks: [{ name: "checks", status: "completed", conclusion: "failure" }, base().checks[1]!] }));
    expect(d.decision).toBe("refused");
    expect("reasons" in d && d.reasons.length).toBe(3);
  });
});

describe("flow audit (MERGE_GATE_FLOW_AUDIT)", () => {
  const audit = (over: { sha?: string; verdict?: string; status?: string; extra?: string } = {}) =>
    `[flow-audit]\nHEAD: ${over.sha ?? SHA}\n| # | Claim | Evidence | Status |\n|---|---|---|---|\n| 1 | fixed | ${SHA.slice(0, 7)} | ${over.status ?? "SUPPORTED"} |\n${over.extra ?? ""}VERDICT: ${over.verdict ?? "clean"}`;
  const withAudit = (body: string, login = "rev", edited = false): GateInput => {
    const b = base();
    return base({ flowAudit: true, comments: [...b.comments, { login, body, edited }] });
  };

  test("off (absent) changes nothing: no audit comment is needed", () => {
    expect(evaluateGate(base())).toEqual({ decision: "merge", runtime: true });
    expect(evaluateGate(base({ flowAudit: false }))).toEqual({ decision: "merge", runtime: true });
  });

  test("on: a clean audit of the head from an attester merges", () => {
    expect(evaluateGate(withAudit(audit()))).toEqual({ decision: "merge", runtime: true });
  });

  test("on: no audit refuses, docs-only PRs included", () => {
    refusedWith(base({ flowAudit: true }), "no [flow-audit] comment from a named attester");
    refusedWith(base({ flowAudit: true, files: ["README.md"], reviews: [], comments: [] }), "no [flow-audit] comment");
  });

  test("on: VERDICT: bullshit found blocks the merge", () => {
    refusedWith(withAudit(audit({ verdict: "bullshit found", status: "FALSE" })), "bullshit found");
  });

  test("on: an audit of another sha is rejected", () => {
    refusedWith(withAudit(audit({ sha: "b".repeat(40) })), "not the head");
  });

  test("on: two VERDICT lines are rejected", () => {
    refusedWith(withAudit(audit({ extra: "VERDICT: bullshit found\n" })), "2 VERDICT lines");
  });

  test("on: an audit by the PR author, the app or a stranger does not count", () => {
    for (const login of ["jarvis[bot]", "stranger"]) refusedWith(withAudit(audit(), login), "no [flow-audit] comment from a named attester");
    refusedWith(base({ flowAudit: true, pr: { ...base().pr, author: "rev" }, comments: [{ login: "rev", body: audit() }] }), "no [flow-audit] comment");
  });

  test("on: a stranger's bullshit-found comment does not shadow the attester's clean one", () => {
    const b = withAudit(audit());
    expect(evaluateGate({ ...b, comments: [...b.comments, { login: "stranger", body: audit({ verdict: "bullshit found", status: "FALSE" }) }] })).toEqual({ decision: "merge", runtime: true });
  });

  test("on: the latest audit of an attester is the one read, and an edited one refuses", () => {
    const b = withAudit(audit());
    refusedWith({ ...b, comments: [...b.comments, { login: "rev", body: audit({ verdict: "bullshit found", status: "FALSE" }) }] }, "bullshit found");
    refusedWith(withAudit(audit(), "rev", true), "was edited after it was posted");
  });

  test("on: with no attesters nobody's audit counts", () => {
    refusedWith({ ...withAudit(audit()), attesters: [] }, "MERGE_GATE_ATTESTERS names no account");
  });
});

describe("app-only verdicts (MERGE_GATE_APP_VERDICTS)", () => {
  const BOT_TYPE = "Bot";
  const audit = `[flow-audit]\nHEAD: ${SHA}\n| 1 | fixed | ${SHA.slice(0, 7)} | SUPPORTED |\nVERDICT: clean`;
  /** Reviewer, verifier and auditor each a bot account of its own, none the PR author or the app. */
  const bots = (over: Partial<GateInput> = {}): GateInput =>
    base({
      appVerdicts: true,
      flowAudit: true,
      attesters: ["rev-app[bot]", "ver-app[bot]", "aud-app[bot]"],
      reviews: [{ login: "rev-app[bot]", userType: BOT_TYPE, body: "[review round 1]\nVERDICT: clean", commitId: SHA }],
      comments: [
        { login: "ver-app[bot]", userType: BOT_TYPE, body: `[verify] ${SHA}\nVERDICT: verified` },
        { login: "aud-app[bot]", userType: BOT_TYPE, body: audit },
      ],
      ...over,
    });

  test("three separate bot accounts satisfy the gate", () => {
    expect(evaluateGate(bots())).toEqual({ decision: "merge", runtime: true });
  });

  test("off (absent): a human attester still counts as before", () => {
    expect(evaluateGate(base({ reviews: [{ login: "rev", userType: "User", body: "[review round 1]\nVERDICT: clean", commitId: SHA }] }))).toEqual({ decision: "merge", runtime: true });
  });

  test("on: a verdict from a human login is rejected outright, even a named attester", () => {
    const d = bots({ attesters: ["rev-app[bot]", "ver-app[bot]", "aud-app[bot]", "kai-at-momos"], reviews: [{ login: "kai-at-momos", userType: "User", body: "[review round 1]\nVERDICT: clean", commitId: SHA }] });
    refusedWith(d, "posted by kai-at-momos, a human account");
    refusedWith(d, "no `[review round N]` review from a named attester");
  });

  test("on: an account whose type is unknown is not a bot", () => {
    refusedWith(bots({ comments: [{ login: "ver-app[bot]", body: `[verify] ${SHA}\nVERDICT: verified` }, { login: "aud-app[bot]", userType: BOT_TYPE, body: audit }] }), "no `[verify]` comment");
  });

  test("on: the PR author and the app itself still do not count, bot or not", () => {
    refusedWith(bots({ attesters: ["jarvis[bot]", "ver-app[bot]", "aud-app[bot]"], reviews: [{ login: "jarvis[bot]", userType: BOT_TYPE, body: "[review round 1]\nVERDICT: clean", commitId: SHA }] }), "no `[review round N]` review");
    refusedWith(bots({ pr: { ...base().pr, author: "rev-app[bot]" } }), "no `[review round N]` review");
  });

  test("on: the verifier and the flow auditor must be two accounts", () => {
    const one = bots({ comments: [{ login: "ver-app[bot]", userType: BOT_TYPE, body: `[verify] ${SHA}\nVERDICT: verified` }, { login: "ver-app[bot]", userType: BOT_TYPE, body: audit }] });
    refusedWith(one, "two separate workers");
  });

  test("a named human attester is refused with a reason; a stranger's comment is ignored, so no GitHub user can block a PR", () => {
    const withHuman = (login: string, attesters: string[]) => bots({ attesters: [...bots().attesters, ...attesters], comments: [...bots().comments, { login, userType: "User", body: "[verify]\nVERDICT: failed" }] });
    refusedWith(withHuman("lyluongthien", ["lyluongthien"]), "posted by lyluongthien, a human account");
    expect(evaluateGate(withHuman("stranger", []))).toEqual({ decision: "merge", runtime: true });
  });

  test("a clean audit dressed to hide a FALSE or UNSUPPORTED row does not pass the gate, in every shape", () => {
    const rows = ["| 2 | stale verify | **FALSE** |", "| 2 | stale verify | FALSE (verify on old sha) |", "| 2 | x | ❌ FALSE |", "| 2 | SUPPORTED | FALSE |", "| 2 | x | `UNSUPPORTED` |", "2 | stale verify | FALSE |"];
    for (const row of rows) {
      const dressed = `[flow-audit]\nHEAD: ${SHA}\n| 1 | a | ${SHA.slice(0, 7)} | SUPPORTED |\n${row}\nVERDICT: clean`;
      refusedWith(bots({ comments: [bots().comments[0]!, { login: "aud-app[bot]", userType: BOT_TYPE, body: dressed }] }), "UNSUPPORTED or FALSE row");
      // the same through the plain flag, with no app-verdicts rule in play
      refusedWith(base({ flowAudit: true, comments: [...base().comments, { login: "rev", body: dressed }] }), "UNSUPPORTED or FALSE row");
    }
  });

});

describe("a verdict expires", () => {
  const audit = (verdict: string, status = "SUPPORTED", sha = SHA) => `[flow-audit]\nHEAD: ${sha}\n| 1 | x | ${SHA.slice(0, 7)} | ${status} |\nVERDICT: ${verdict}`;
  const withAudit = (...bodies: string[]): GateInput => base({ flowAudit: true, comments: [...base().comments, ...bodies.map((body) => ({ login: "rev", body }))] });

  test("when the head moves: review, verify and audit each name the sha they judged", () => {
    const other = "b".repeat(40);
    refusedWith(base({ reviews: [{ login: "rev", body: "[review round 1]\nVERDICT: clean", commitId: other }] }), "was written on");
    refusedWith(base({ comments: [{ login: "rev", body: `[verify] ${other}\nVERDICT: verified` }] }), "does not name the head");
    refusedWith(withAudit(audit("clean", "SUPPORTED", other)), "not the head");
  });

  test("when a later word on the same sha contradicts it: the latest of each kind wins", () => {
    refusedWith(withAudit(audit("clean"), audit("bullshit found", "FALSE")), "bullshit found");
    refusedWith(base({ comments: [{ login: "rev", body: `[verify] ${SHA}\nVERDICT: verified` }, { login: "rev", body: `[verify] ${SHA}\nVERDICT: failed` }] }), "does not end `VERDICT: verified`");
    refusedWith(base({ reviews: [{ login: "rev", body: "[review round 2]\nVERDICT: clean", commitId: SHA }, { login: "rev", body: "[review round 2]\nVERDICT: changes", commitId: SHA }] }), "does not end `VERDICT: clean`");
  });

  test("a later clean one on the same sha re-validates it", () => {
    expect(evaluateGate(withAudit(audit("bullshit found", "FALSE"), audit("clean")))).toEqual({ decision: "merge", runtime: true });
  });
});

describe("namesSha / parseGateList", () => {
  test("a full sha or a 7+ hex prefix names it; shorter or different does not", () => {
    expect(namesSha(`ran on ${SHA}`, SHA)).toBe(true);
    expect(namesSha("head 0123456 ok", SHA)).toBe(true);
    expect(namesSha("head 012345 ok", SHA)).toBe(false);
    expect(namesSha("head 0123457 ok", SHA)).toBe(false);
  });
  test("lists drop blanks and fall back", () => {
    expect(parseGateList(" a, ,b ")).toEqual(["a", "b"]);
    expect(parseGateList("", ["x"])).toEqual(["x"]);
    expect(parseGateList(undefined)).toEqual([]);
  });
});
