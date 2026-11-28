import { describe, expect, test } from "bun:test";
import { computeMetrics, cites, countBlockers, findEscapes, formatMetricsText, hunkRanges, isFixLike, parseFix, parseReview, prRecordFromApi, type PrRecord } from "../../src/domain/reviewerMetrics.ts";

const pr = (number: number, over: Partial<PrRecord> = {}): PrRecord => ({
  number,
  title: `change ${number}`,
  body: "",
  headRef: `feat/x${number}`,
  mergedAt: `2026-11-${String(number % 28 || 28).padStart(2, "0")}T10:00:00Z`,
  reviews: [],
  comments: [],
  files: [{ path: "src/a.ts", status: "modified", patch: "@@ -10,2 +10,4 @@\n a\n+b" }],
  ...over,
});
const review = (id: number, body: string, inline = 0) => ({ id, body, state: "COMMENTED", submittedAt: "", commitId: "", inlineComments: inline });
const fix = (body: string) => ({ body, createdAt: "" });
const opts = { repo: "o/r", windowDays: 30, generatedAt: "2026-11-27T00:00:00Z" };

describe("reading the review protocol", () => {
  test("a review: round and the last verdict", () => {
    expect(parseReview("[review round 2]\nall fixed\nVERDICT: clean", 0)).toEqual({ round: 2, verdict: "clean", blockers: 0 });
    // a body quoting an earlier verdict ends on the real one
    expect(parseReview("[review round 3]\nround 2 said VERDICT: clean\nno\nVERDICT: changes", 2)).toEqual({ round: 3, verdict: "changes", blockers: 2 });
    expect(parseReview("a plain comment VERDICT: clean", 0)).toBeUndefined();
    expect(parseReview("[review round 1]\nno verdict line", 0)?.verdict).toBeUndefined();
  });

  test("blockers: inline comments, else list items, at least one", () => {
    expect(countBlockers("x", 3)).toBe(3);
    expect(countBlockers("[review round 1]\n1. a\n2. b\n- c\nVERDICT: changes", 0)).toBe(3);
    expect(countBlockers("[review round 1]\nprose only\nVERDICT: changes", 0)).toBe(1);
  });

  test("a fix round: items and pushbacks, 'fixed' wins over the word pushback", () => {
    expect(parseFix("[fix round 1]\n1. fixed the guard\n2. pushed back: the caller already checks it\n3. not a bug, by design")).toEqual({ round: 1, items: 3, pushbacks: 2 });
    expect(parseFix("[fix round 1]\n1. Fixed - not a false positive")).toEqual({ round: 1, items: 1, pushbacks: 0 });
    expect(parseFix("[fix round 2]\nPushed back on the whole point: this is intended.")).toEqual({ round: 2, items: 1, pushbacks: 1 });
    expect(parseFix("no marker")).toBeUndefined();
  });
});

describe("escaped defects", () => {
  test("hunkRanges reads old and new sides and drops empty ones", () => {
    expect(hunkRanges("@@ -10,2 +10,4 @@\n x\n@@ -30 +32,0 @@\n-gone")).toEqual({ oldRanges: [{ from: 10, to: 11 }, { from: 30, to: 30 }], newRanges: [{ from: 10, to: 13 }] });
    expect(hunkRanges(undefined)).toEqual({ oldRanges: [], newRanges: [] });
  });

  test("cites matches whole numbers only", () => {
    expect(cites("Fixes #13", 13)).toBe(true);
    expect(cites("see pull/13 and PR 13", 13)).toBe(true);
    expect(cites("Fixes #136", 13)).toBe(false);
    expect(cites("issue 13", 13)).toBe(false);
  });

  test("fix-like: by title, branch or body", () => {
    expect(isFixLike({ title: "Fix the thing", headRef: "x", body: "" })).toBe(true);
    expect(isFixLike({ title: "t", headRef: "hotfix/y", body: "" })).toBe(true);
    expect(isFixLike({ title: "Revert \"x\"", headRef: "revert-1", body: "" })).toBe(true);
    expect(isFixLike({ title: "Add a feature", headRef: "feat/z", body: "builds on #5" })).toBe(false);
    expect(isFixLike({ title: "t", headRef: "feat/z", body: "regression from #5" })).toBe(true);
  });

  test("a later fix that cites the PR, or rewrites its lines, is an escape; a feature on top is not", () => {
    const target = pr(5);
    const cite = pr(6, { title: "Fix crash from #5", files: [{ path: "src/c.ts", status: "modified", patch: "@@ -1,1 +1,1 @@\n-a\n+b" }] });
    const lines = pr(7, { title: "fix: guard", files: [{ path: "src/a.ts", status: "modified", patch: "@@ -11,1 +11,1 @@\n-b\n+c" }] });
    const both = pr(8, { title: "Revert #5", files: [{ path: "src/a.ts", status: "modified", patch: "@@ -10,4 +10,2 @@\n-b" }] });
    // the revert rewrites lines that #7 wrote again after #5: those lines are #7's, but it still cites #5
    expect(findEscapes(target, [target, both], 30).map((e) => [e.pr, e.by])).toEqual([[8, "both"]]);
    const feature = pr(9, { title: "Add feature on top of #5", files: [{ path: "src/a.ts", status: "modified", patch: "@@ -11,1 +11,1 @@\n-b\n+c" }] });
    const elsewhere = pr(10, { title: "fix: other file", files: [{ path: "src/other.ts", status: "modified", patch: "@@ -11,1 +11,1 @@\n-b" }] });
    const earlier = pr(4, { title: "fix #5", mergedAt: "2026-11-01T00:00:00Z" });
    const result = findEscapes(target, [target, cite, lines, feature, elsewhere, earlier], 30);
    expect(result.map((e) => [e.pr, e.by])).toEqual([[6, "cites"], [7, "same-lines"]]);
    expect(result[1]?.paths).toEqual(["src/a.ts"]);
  });

  test("lines a PR in between wrote again belong to that PR, not the first", () => {
    const first = pr(5);
    const second = pr(6, { files: [{ path: "src/a.ts", status: "modified", patch: "@@ -10,2 +10,4 @@\n a\n+b" }] });
    const fixer = pr(7, { title: "fix: guard", files: [{ path: "src/a.ts", status: "modified", patch: "@@ -11,1 +11,1 @@\n-b\n+c" }] });
    expect(findEscapes(first, [first, second, fixer], 30)).toEqual([]);
    expect(findEscapes(second, [first, second, fixer], 30).map((e) => e.pr)).toEqual([7]);
  });

  test("a fix outside the window is not an escape; a renamed file is followed", () => {
    const target = pr(5, { mergedAt: "2026-10-01T00:00:00Z" });
    expect(findEscapes(target, [pr(6, { title: "fix #5", mergedAt: "2026-11-27T00:00:00Z" })], 30)).toEqual([]);
    const renamed = pr(7, { title: "fix: guard", mergedAt: "2026-10-05T00:00:00Z", files: [{ path: "src/b.ts", oldPath: "src/a.ts", status: "renamed", patch: "@@ -11,1 +11,1 @@\n-b" }] });
    expect(findEscapes(target, [renamed], 30).map((e) => e.pr)).toEqual([7]);
  });
});

describe("computeMetrics", () => {
  // #1 two rounds: one blocker, pushed back on, round 2 clean (a false positive); later fixed by #4 (escaped)
  const p1 = pr(1, {
    reviews: [review(1, "[review round 1]\n1. guard missing\nVERDICT: changes"), review(2, "[review round 2]\nok\nVERDICT: clean")],
    comments: [fix("[fix round 1]\n1. pushed back: the caller checks it")],
  });
  // #2 one round, clean, never fixed
  const p2 = pr(2, { reviews: [review(3, "[review round 1]\nVERDICT: clean")], files: [{ path: "src/two.ts", status: "modified", patch: "@@ -1,1 +1,2 @@\n a\n+b" }] });
  // #3 docs only, no reviewer
  const p3 = pr(3, { files: [{ path: "README.md", status: "modified", patch: "@@ -1 +1 @@\n-a\n+b" }] });
  // #4 the fix of #1
  const p4 = pr(4, { title: "fix: crash after #1" });
  // #5 runtime code with no reviewer: owed one
  const p5 = pr(5, { title: "add thing", files: [{ path: "src/z.ts", status: "added", patch: "@@ -0,0 +1,1 @@\n+const z = 1;" }] });
  const report = computeMetrics([p4, p3, p2, p1, p5], opts);

  test("per PR, sorted by number", () => {
    expect(report.perPr.map((p) => p.number)).toEqual([1, 2, 3, 4, 5]);
    const one = report.perPr[0];
    expect(one).toMatchObject({ rounds: 2, finalVerdict: "clean", blockers: 1, falsePositives: 1, riskClass: "runtime", reviewerOwed: true });
    expect(one?.escapes.map((e) => e.pr)).toEqual([4]);
    expect(report.perPr[1]?.escapes).toEqual([]);
    expect(report.perPr[2]).toMatchObject({ rounds: 0, riskClass: "docs", reviewerOwed: false });
  });

  test("aggregate", () => {
    const a = report.aggregate;
    expect(a).toMatchObject({ possiblyEscapedPrs: 0, possibleEscapeRate: 0.5, prs: 5, reviewed: 2, owedButUnreviewed: 2, blockersRaised: 1, falsePositives: 1, falsePositiveRate: 1, cleanVerdicts: 2, escapedPrs: 1, escapedDefects: 1, escapeRate: 0.5, meanRounds: 1.5, firstRoundClean: 1 });
    expect(a.roundsHistogram).toEqual({ "1": 1, "2": 1 });
    expect(a.byClass.docs).toEqual({ prs: 1, reviewed: 0, cleanVerdicts: 0, escaped: 0 });
    expect(a.byClass.runtime).toMatchObject({ prs: 4, reviewed: 2, cleanVerdicts: 2, escaped: 1 });
  });

  test("same-lines alone is a possible escape, kept out of the confirmed rate", () => {
    const target = pr(1, { reviews: [review(1, "[review round 1]\nVERDICT: clean")] });
    const fixer = pr(2, { title: "fix: guard", files: [{ path: "src/a.ts", status: "modified", patch: "@@ -11,1 +11,1 @@\n-b\n+c" }] });
    const r = computeMetrics([target, fixer], opts);
    expect(r.aggregate).toMatchObject({ escapedPrs: 0, escapedDefects: 0, escapeRate: 0, possiblyEscapedPrs: 1, possibleEscapeRate: 1 });
    expect(r.aggregate.byClass.runtime.escaped).toBe(0);
    expect(formatMetricsText(r)).toContain("possibly escaped via #2 (same-lines)");
  });

  test("a pushback no later round confirms is not a false positive", () => {
    const r = computeMetrics([pr(1, { reviews: [review(1, "[review round 1]\n1. a\nVERDICT: changes")], comments: [fix("[fix round 1]\n1. not a bug")] })], opts);
    expect(r.perPr[0]).toMatchObject({ falsePositives: 0, pushbacksUnconfirmed: 1, finalVerdict: "changes", escapes: [] });
  });

  test("an empty window has zero rates, not NaN", () => {
    const r = computeMetrics([], opts);
    expect(r.aggregate).toMatchObject({ prs: 0, meanRounds: 0, falsePositiveRate: 0, escapeRate: 0 });
  });

  test("a file GitHub sent no patch for counts as a binary: runtime, never docs", () => {
    const r = computeMetrics([pr(1, { files: [{ path: "src/big.ts", status: "modified" }] })], opts);
    expect(r.perPr[0]?.riskClass).toBe("runtime");
  });

  test("the text report names the numbers and flags the escape and the unreviewed", () => {
    const text = formatMetricsText(report);
    expect(text).toContain("blockers raised:     1");
    expect(text).toContain("false positives:     1 (100%");
    expect(text).toContain("escaped defects:     1 in 1 PRs (50%");
    expect(text).toContain("#1 [runtime]");
    expect(text).toContain("ESCAPED via #4 (both)");
    expect(text).toContain("#5 [runtime] add thing: no reviewer");
    expect(text).not.toContain("#3 [docs]");
  });
});

describe("prRecordFromApi", () => {
  test("maps the API shapes and counts each review's inline comments", () => {
    const rec = prRecordFromApi(
      { number: 9, title: "t", body: null, merged_at: "2026-11-01T00:00:00Z", head: { ref: "b" } },
      [{ id: 1, body: "[review round 1]", state: "COMMENTED", submitted_at: "2026-11-01T01:00:00Z", commit_id: "abc" }],
      [{ body: null, created_at: "2026-11-01T02:00:00Z" }],
      [{ pull_request_review_id: 1 }, { pull_request_review_id: 1 }, { pull_request_review_id: 2 }],
      [{ filename: "n.ts", previous_filename: "o.ts", status: "renamed" }],
    );
    expect(rec).toMatchObject({ number: 9, body: "", headRef: "b", comments: [{ body: "" }], reviews: [{ id: 1, inlineComments: 2, commitId: "abc" }], files: [{ path: "n.ts", oldPath: "o.ts", status: "renamed" }] });
    expect(rec.files[0]?.patch).toBeUndefined();
  });
});
