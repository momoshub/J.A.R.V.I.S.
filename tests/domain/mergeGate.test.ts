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
  test("a docs/ folder exempts only files that cannot run: an svg, txt or mdx there is runtime", () => {
    for (const f of ["docs/logo.svg", "docs/notes.txt", "docs/page.mdx", "docs/requirements.txt"]) expect(touchesRuntime(["README.md", f])).toBe(true);
    for (const f of ["docs/a.md", "docs/a.png", "docs/spec.pdf"]) expect(touchesRuntime([f])).toBe(false);
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
