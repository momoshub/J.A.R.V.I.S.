import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  buildReport,
  candidateIsA,
  contrastOf,
  DEFAULT_MAX_CASES,
  DEFAULT_RUNS,
  estimateSpend,
  formatEstimate,
  judgePrompt,
  loadCases,
  outcomeOf,
  type PairResult,
  parseCase,
  parseProbeArgs,
  parseVerdict,
  tally,
  textLabel,
} from "../../src/domain/probe.ts";

const good = { id: "a-case", message: "hello there", traits: ["greets back"] };
const file = (name: string, body: unknown) => ({ file: name, text: JSON.stringify(body) });

describe("parseProbeArgs", () => {
  test("--path with defaults", () => {
    const o = parseProbeArgs(["--path", "skills/x.md"]);
    expect(o).toMatchObject({ path: "skills/x.md", baseRef: "origin/main", runs: DEFAULT_RUNS, maxCases: DEFAULT_MAX_CASES, dryRun: false });
  });
  test("--base with --candidate and every option", () => {
    const o = parseProbeArgs(["--base", "a.md", "--candidate", "b.md", "--runs", "3", "--max-cases", "4", "--model", "haiku", "--judge-model", "sonnet", "--cases", "c", "--out", "r.md", "--dry-run"]);
    expect(o).toMatchObject({ baseFile: "a.md", candidateFile: "b.md", runs: 3, maxCases: 4, model: "haiku", judgeModel: "sonnet", casesDir: "c", out: "r.md", dryRun: true });
  });
  test("--help needs nothing else", () => {
    expect(parseProbeArgs(["--help"]).help).toBe(true);
  });
  test("refuses what it cannot run", () => {
    expect(() => parseProbeArgs([])).toThrow("name what to compare");
    expect(() => parseProbeArgs(["--base", "a.md"])).toThrow("name what to compare");
    expect(() => parseProbeArgs(["--path", "a", "--base", "b", "--candidate", "c"])).toThrow("not both");
    expect(() => parseProbeArgs(["--path"])).toThrow("needs a value");
    expect(() => parseProbeArgs(["--path", "--dry-run"])).toThrow("needs a value");
    expect(() => parseProbeArgs(["--path", "a", "--bogus"])).toThrow("unknown argument --bogus");
  });
  test("bounds the cost knobs", () => {
    for (const bad of ["0", "6", "1.5", "x", ""]) expect(() => parseProbeArgs(["--path", "a", "--runs", bad])).toThrow("--runs");
    for (const bad of ["0", "11"]) expect(() => parseProbeArgs(["--path", "a", "--max-cases", bad])).toThrow("--max-cases");
    expect(parseProbeArgs(["--path", "a", "--runs", "5", "--max-cases", "10"]).runs).toBe(5);
  });
});

describe("case loading", () => {
  test("a valid case is trimmed and returned", () => {
    expect(parseCase("f.json", { ...good, message: "  hi  ", traits: [" a "] })).toEqual({ id: "a-case", message: "hi", traits: ["a"] });
  });
  test.each([
    ["not an object", [], "JSON object"],
    ["bad id", { ...good, id: "Bad Id" }, "id must be"],
    ["empty message", { ...good, message: "  " }, "message"],
    ["long message", { ...good, message: "x".repeat(2001) }, "message"],
    ["no traits", { ...good, traits: [] }, "traits"],
    ["too many traits", { ...good, traits: ["1", "2", "3", "4", "5", "6", "7"] }, "traits"],
    ["blank trait", { ...good, traits: ["ok", " "] }, "each trait"],
    ["non-string trait", { ...good, traits: [3] }, "each trait"],
  ])("rejects %s", (_name, raw, why) => {
    expect(() => parseCase("f.json", raw)).toThrow(why);
  });
  test("loads in file-name order and names the broken file", () => {
    const cases = loadCases([file("b.json", { ...good, id: "second" }), file("a.json", { ...good, id: "first" })]);
    expect(cases.map((c) => c.id)).toEqual(["first", "second"]);
    expect(() => loadCases([{ file: "x.json", text: "{nope" }])).toThrow("x.json: not valid JSON");
  });
  test("refuses a repeated id and an empty set", () => {
    expect(() => loadCases([file("a.json", good), file("b.json", good)])).toThrow("already used");
    expect(() => loadCases([])).toThrow("no replay cases");
  });
});

describe("the seed cases", () => {
  const dir = resolve(import.meta.dir, "..", "..", "docs", "probe-cases");
  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  const texts = files.map((f) => ({ file: f, text: readFileSync(join(dir, f), "utf8") }));
  test("3 to 5 valid cases ship", () => {
    const cases = loadCases(texts);
    expect(cases.length).toBeGreaterThanOrEqual(3);
    expect(cases.length).toBeLessThanOrEqual(5);
  });
  test("hold nothing the leak guard or a public repo should not see", () => {
    for (const { file: f, text } of texts) {
      expect(text, f).not.toMatch(/\b[UCWTDGB][A-Z0-9]{8,}\b/); // a Slack id
      expect(text, f).not.toMatch(/slack\.com|@[\w.-]+\.\w{2,}|https?:\/\//i); // a workspace link, an email, any url
      expect(text, f).not.toMatch(/xox[a-z]-|ghp_|sk-/); // a token
    }
  });
});

describe("estimate", () => {
  const cases = loadCases([file("a.json", good), file("b.json", { ...good, id: "other" })]);
  test("counts every call: two answers and one judgement per run", () => {
    const e = estimateSpend("base text", "candidate text", cases, 2);
    expect(e.calls).toBe(2 * 2 * 3);
    expect(e.inputTokens).toBeGreaterThan(0);
    expect(e.outputTokens).toBeGreaterThan(0);
  });
  test("grows with the text and with the runs", () => {
    const small = estimateSpend("x", "x", cases, 1);
    expect(estimateSpend("x".repeat(40_000), "x", cases, 1).inputTokens).toBeGreaterThan(small.inputTokens + 10_000);
    expect(estimateSpend("x", "x", cases, 3).calls).toBe(small.calls * 3);
  });
  test("reads as one line", () => {
    expect(formatEstimate(estimateSpend("a", "b", cases, 2), 2, 2)).toContain("2 cases x 2 runs x 2 versions + 4 judgements = 12 model calls");
  });
});

describe("judging", () => {
  test("the A/B layout is fixed per case and run, and spread over both", () => {
    expect(candidateIsA("lead", 1)).toBe(candidateIsA("lead", 1));
    const sides = new Set(Array.from({ length: 30 }, (_, i) => candidateIsA("lead", i + 1)));
    expect(sides.size).toBe(2);
  });
  test("the prompt carries the message, the traits and both answers, and says nothing of base or candidate", () => {
    const p = judgePrompt(parseCase("f", good), "ANSWER-ONE", "ANSWER-TWO");
    expect(p).toContain("hello there");
    expect(p).toContain("- greets back");
    expect(p.indexOf("ANSWER-ONE")).toBeLessThan(p.indexOf("ANSWER-TWO"));
    expect(p.toLowerCase()).not.toMatch(/base|candidate|old version|new version/);
  });
  test("reads a bare, fenced or prefaced verdict", () => {
    expect(parseVerdict('{"winner":"A","a":"leads","b":"pads"}')).toEqual({ winner: "A", a: "leads", b: "pads" });
    expect(parseVerdict('```json\n{"winner": "b", "a": "two\\nlines", "b": "x"}\n```')).toEqual({ winner: "B", a: "two lines", b: "x" });
    expect(parseVerdict('Here you go: {"winner":"Tie"}')).toEqual({ winner: "tie", a: "", b: "" });
  });
  test("refuses a reply with no usable verdict", () => {
    for (const bad of ["", "no json here", "{broken", '{"winner":"C"}', '{"winner":3}', "[1]", "{}"]) expect(parseVerdict(bad)).toBeUndefined();
  });
  test("maps what the judge said about A and B back to candidate and base", () => {
    const v = { winner: "A", a: "leads with the answer", b: "opens with filler" } as const;
    expect(contrastOf(v, true)).toBe("candidate leads with the answer; base opens with filler");
    expect(contrastOf(v, false)).toBe("candidate opens with filler; base leads with the answer");
    expect(contrastOf({ winner: "tie", a: "", b: "" }, true)).toBe("");
    expect(contrastOf({ winner: "A", a: "x", b: "" }, false)).toBe("base x");
  });
  test("maps the judge's pick back to a version", () => {
    expect(outcomeOf({ winner: "A", a: "", b: "" }, true)).toBe("candidate");
    expect(outcomeOf({ winner: "A", a: "", b: "" }, false)).toBe("base");
    expect(outcomeOf({ winner: "B", a: "", b: "" }, true)).toBe("base");
    expect(outcomeOf({ winner: "B", a: "", b: "" }, false)).toBe("candidate");
    expect(outcomeOf({ winner: "tie", a: "", b: "" }, true)).toBe("tie");
  });
});

describe("report", () => {
  const results: PairResult[] = [
    { caseId: "one", run: 1, outcome: "candidate", contrast: "candidate leads with the answer" },
    { caseId: "one", run: 2, outcome: "tie", contrast: "" },
    { caseId: "two", run: 1, outcome: "base", contrast: "base keeps the language" },
    { caseId: "two", run: 2, error: "claude failed: boom" },
  ];
  const base = { baseLabel: textLabel("a.md", "old"), candidateLabel: textLabel("b.md", "new"), model: "sonnet", judgeModel: "opus", runs: 2 };
  test("tally counts each outcome and the failures", () => {
    expect(tally(results)).toEqual({ candidate: 1, base: 1, tie: 1, errors: 1 });
  });
  test("names the totals, a row per case, the contrasts and the failures", () => {
    const r = buildReport({ ...base, results, usage: { inputTokens: 12345, outputTokens: 678, costUsd: 0.5 } });
    expect(r).toContain("**Candidate 1 wins, base 1 wins, 1 ties**, 1 pair not judged");
    expect(r).toContain("| one | 1 | 0 | 1 |");
    expect(r).toContain("| two | 0 | 1 | 0 (+1 failed) |");
    expect(r).toContain("- `one` run 1, candidate wins: candidate leads with the answer");
    expect(r).toContain("- `two` run 1, base wins: base keeps the language");
    expect(r).toContain("### Not judged");
    expect(r).toContain("`two` run 2: claude failed: boom");
    expect(r).toContain("12,345 input and 678 output tokens, $0.50");
    expect(r).toContain(textLabel("a.md", "old"));
  });
  test("says who is ahead, and when nobody is", () => {
    const win = (n: number): PairResult[] => Array.from({ length: n }, (_, i) => ({ caseId: "c", run: i + 1, outcome: "candidate", contrast: "x" }));
    expect(buildReport({ ...base, results: win(3) })).toContain("Candidate ahead by 3 of 3 judged pairs.");
    expect(buildReport({ ...base, results: [{ caseId: "c", run: 1, outcome: "tie", contrast: "" }] })).toContain("No behavioural difference");
    expect(buildReport({ ...base, results: [{ caseId: "c", run: 1, error: "e" }] })).toContain("no evidence either way");
    const thin: PairResult[] = [...win(2), { caseId: "c", run: 3, outcome: "base", contrast: "y" }, { caseId: "c", run: 4, outcome: "tie", contrast: "" }, { caseId: "c", run: 5, outcome: "tie", contrast: "" }];
    expect(buildReport({ ...base, results: thin })).toContain("a thin margin");
  });
  test("an all-tie report has no contrasts to list", () => {
    expect(buildReport({ ...base, results: [{ caseId: "c", run: 1, outcome: "tie", contrast: "" }] })).toContain("None: every judged pair was a tie.");
  });
});
