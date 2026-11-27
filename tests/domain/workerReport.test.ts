import { describe, expect, test } from "bun:test";
import {
  findWorkerReport,
  legacyVerdict,
  parseWorkerReport,
  parseWorkerReportLine,
  REPORT_LINE_PREFIX,
  reportSummary,
  validateWorkerReport,
  WORKER_REPORT_EXAMPLE,
  workerReportLine,
} from "../../src/domain/workerReport.ts";
import { readyMessage } from "../../src/domain/watch.ts";

const base = {
  role: "reviewer",
  status: "succeeded",
  pr: 12,
  head_sha: "ABCDEF1234567",
  verdict: "changes",
  findings: [{ severity: "blocker", summary: " the bug ", file: "src/a.ts", line: 3 }, { severity: "nit", summary: "style" }],
  owner_actions: [" run X ", ""],
  cost: { usd: 1.5, tokens: 1000 },
};
const fenced = (o: unknown) => `done.\n\n\`\`\`worker-report\n${JSON.stringify(o)}\n\`\`\`\n`;

describe("parseWorkerReport", () => {
  test("reads the block, normalises it and drops blanks", () => {
    const r = parseWorkerReport(`VERDICT: changes\n${fenced(base)}`);
    if (!r.ok) throw new Error(r.error);
    expect(r.report.head_sha).toBe("abcdef1234567");
    expect(r.report.findings[0]).toEqual({ severity: "blocker", summary: "the bug", file: "src/a.ts", line: 3 });
    expect(r.report.owner_actions).toEqual(["run X"]);
    expect(r.report.cost).toEqual({ usd: 1.5, tokens: 1000 });
  });

  test("the last block wins, so a quoted example before it is not the report", () => {
    const text = `${WORKER_REPORT_EXAMPLE}\n\nmine:\n${fenced({ ...base, pr: 99, verdict: "clean", findings: [] })}`;
    const r = parseWorkerReport(text);
    expect(r.ok && r.report.pr).toBe(99);
  });

  test("says why when there is no block or it is not JSON", () => {
    expect(parseWorkerReport("VERDICT: clean")).toEqual({ ok: false, error: "no `worker-report` block in the report" });
    const bad = parseWorkerReport("```worker-report\n{nope\n```");
    expect(bad.ok).toBe(false);
  });

  test("the documented example is itself a valid shape once its placeholder is a sha", () => {
    const body = WORKER_REPORT_EXAMPLE.split("\n")[1] ?? "";
    expect(validateWorkerReport(JSON.parse(body.replace("<the head you read>", "abc1234"))).ok).toBe(true);
  });
});

describe("validateWorkerReport", () => {
  const bad = (patch: Record<string, unknown>) => validateWorkerReport({ ...base, ...patch });
  test("rejects each field that is out of shape", () => {
    expect(bad({ role: "owner" }).ok).toBe(false);
    expect(bad({ status: "done" }).ok).toBe(false);
    expect(bad({ verdict: "approved" }).ok).toBe(false);
    expect(bad({ pr: 0 }).ok).toBe(false);
    expect(bad({ pr: "12" }).ok).toBe(false);
    expect(bad({ head_sha: "main" }).ok).toBe(false);
    expect(bad({ findings: "none" }).ok).toBe(false);
    expect(bad({ findings: [{ severity: "major", summary: "x" }] }).ok).toBe(false);
    expect(bad({ findings: [{ severity: "nit", summary: " " }] }).ok).toBe(false);
    expect(bad({ findings: [{ severity: "nit", summary: "x", line: 0 }] }).ok).toBe(false);
    expect(bad({ owner_actions: [1] }).ok).toBe(false);
    expect(bad({ cost: { usd: -1 } }).ok).toBe(false);
    expect(bad({ cost: "free" }).ok).toBe(false);
    expect(validateWorkerReport("x").ok).toBe(false);
  });
  test("accepts null pr, head_sha and cost, and ignores extra keys", () => {
    const r = bad({ pr: null, head_sha: null, cost: null, extra: 1, role: "investigator", verdict: "none" });
    expect(r.ok && r.report.pr).toBe(null);
  });
});

describe("legacyVerdict", () => {
  test("reads the last VERDICT line in the forms the review loop posts", () => {
    expect(legacyVerdict("[review round 1]\nbody\n\nVERDICT: clean")).toBe("clean");
    expect(legacyVerdict("VERDICT: changes\nlater\n**VERDICT: verified**")).toBe("verified");
    expect(legacyVerdict("VERDICT: failed")).toBe("failed");
    expect(legacyVerdict("the verdict was clean")).toBeUndefined();
    expect(legacyVerdict("VERDICT: maybe")).toBeUndefined();
  });
});

describe("findWorkerReport", () => {
  test("finds the block in any string of a worker-show style record", () => {
    const shown = { ok: true, result: { dispatch: { id: "ctx_1" }, outcome: { body: fenced(base), other: [1, "x"] } } };
    const r = findWorkerReport(shown);
    expect(r.ok && r.report.role).toBe("reviewer");
  });
  test("the last valid block in the record wins, so a quoted template before the worker's end is not its report", () => {
    const template = fenced({ ...base, pr: null, head_sha: null, verdict: "none", findings: [] });
    const mine = fenced({ ...base, pr: 7 });
    const r = findWorkerReport({ brief: template, terminal: { preview: template }, outcome: { body: mine } });
    expect(r.ok && r.report.pr).toBe(7);
  });
  test("reports the first problem when no block is valid, and a plain miss when there is none", () => {
    const r = findWorkerReport({ body: fenced({ ...base, role: "owner" }) });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain("role");
    expect(findWorkerReport({ body: "nothing here" })).toEqual({ ok: false, error: "no `worker-report` block found" });
  });
});

describe("report line and hand-back", () => {
  const report = (() => {
    const r = validateWorkerReport(base);
    if (!r.ok) throw new Error(r.error);
    return r.report;
  })();

  test("round-trips through the line the check prints, and a mangled line is no report", () => {
    const line = workerReportLine("ctx_ab-1", report);
    expect(REPORT_LINE_PREFIX.test(line)).toBe(true);
    expect(parseWorkerReportLine(`orca worker ctx_ab-1 finished: outcome ok\n${line}`)).toEqual(report);
    expect(parseWorkerReportLine(line.replace('"reviewer"', '"boss"'))).toBeUndefined();
    expect(parseWorkerReportLine("nothing")).toBeUndefined();
    expect(parseWorkerReportLine(line, "ctx_ab-1")).toEqual(report);
    expect(parseWorkerReportLine(line, "ctx_other")).toBeUndefined();
  });

  test("the summary names role, PR, head, verdict, blockers and owner actions, clipped", () => {
    const s = reportSummary({ ...report, owner_actions: ["x".repeat(500)] });
    expect(s).toContain("reviewer succeeded on PR #12 at abcdef1, verdict changes");
    expect(s).toContain("1 blocker, 1 nit");
    expect(s).toContain("blocker: the bug (src/a.ts:3)");
    expect(s).toContain("owner actions: ");
    expect(s.length).toBeLessThan(600);
  });

  test("the watch hand-back carries the report as a sentence, flags it as a claim, and hides the raw line", () => {
    const out = `orca worker ctx_ab-1 finished: outcome succeeded\n${workerReportLine("ctx_ab-1", report)}`;
    const msg = readyMessage("merge it", 60_000, out);
    expect(msg).toContain("structured report");
    expect(msg).toContain("not a fact");
    expect(msg).toContain("verdict changes");
    expect(msg).not.toContain('"head_sha"');
  });

  test("a report line for another dispatch is not this worker's report", () => {
    const out = `orca worker ctx_ab-1 finished: outcome succeeded\n${workerReportLine("ctx_zz-9", report)}`;
    expect(readyMessage("go", 1000, out)).not.toContain("structured report");
  });

  test("no report line, no report sentence", () => {
    expect(readyMessage("go", 1000, "orca worker ctx_ab-1 finished: outcome succeeded")).not.toContain("structured report");
  });
});
