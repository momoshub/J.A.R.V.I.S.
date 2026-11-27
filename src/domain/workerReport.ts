/**
 * The structured report an Orca worker ends with.
 *
 * A worker used to report in prose with a `VERDICT:` line the session had to
 * interpret. It now also ends with one fenced JSON block, so the hand-back reads
 * fields instead of sentences. The `VERDICT:` line stays for the PR comments the
 * review loop and `merge-when-green.sh` already read.
 *
 * A report is a worker's claim, never a fact: the session checks `head_sha`
 * against the PR's head and the verdict against the PR itself before it acts on it.
 */
import { WORKER_ROLES, type WorkerRole, isWorkerRole } from "./workerRoles.ts";

/** The fence language the block carries: ```worker-report. */
export const WORKER_REPORT_FENCE = "worker-report";

export const REPORT_STATUSES = ["succeeded", "failed", "blocked"] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];

/** `none` for a role that gives no verdict (a writer, an investigator). */
export const REPORT_VERDICTS = ["clean", "changes", "verified", "failed", "none"] as const;
export type ReportVerdict = (typeof REPORT_VERDICTS)[number];

export type ReportFinding = {
  readonly severity: "blocker" | "nit";
  readonly summary: string;
  readonly file?: string;
  readonly line?: number;
};

export type WorkerReport = {
  readonly role: WorkerRole;
  readonly status: ReportStatus;
  /** The PR the work is about, null when there is none. */
  readonly pr: number | null;
  /** The head commit the report speaks for, null when it is not about a commit. */
  readonly head_sha: string | null;
  readonly verdict: ReportVerdict;
  readonly findings: readonly ReportFinding[];
  /** Things only the owner can do, each a full step ("run X on the host"). */
  readonly owner_actions: readonly string[];
  /** What the worker knows it spent; null when it does not. */
  readonly cost: { readonly usd?: number; readonly tokens?: number } | null;
};

/** The one-line shape every brief carries; the full example is `WORKER_REPORT_EXAMPLE`. */
export const WORKER_REPORT_BRIEF_LINE =
  "role, status succeeded|failed|blocked, pr, head_sha, verdict clean|changes|verified|failed|none, findings [{severity blocker|nit, summary, file?, line?}], owner_actions [], cost {usd?, tokens?} or null";

export const WORKER_REPORT_EXAMPLE = `\`\`\`${WORKER_REPORT_FENCE}
{"role":"reviewer","status":"succeeded","pr":123,"head_sha":"<the head you read>","verdict":"changes","findings":[{"severity":"blocker","summary":"what is wrong","file":"src/x.ts","line":42}],"owner_actions":[],"cost":null}
\`\`\``;

export type ParseResult = { readonly ok: true; readonly report: WorkerReport } | { readonly ok: false; readonly error: string };

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const oneOf = <T extends string>(set: readonly T[], v: unknown): v is T => typeof v === "string" && (set as readonly string[]).includes(v);

const parseFinding = (v: unknown, i: number): ReportFinding | string => {
  if (!isObj(v)) return `findings[${i}] is not an object`;
  if (v.severity !== "blocker" && v.severity !== "nit") return `findings[${i}].severity must be blocker or nit`;
  if (typeof v.summary !== "string" || !v.summary.trim()) return `findings[${i}].summary must be a non-empty string`;
  if (v.file !== undefined && typeof v.file !== "string") return `findings[${i}].file must be a string`;
  if (v.line !== undefined && !(Number.isInteger(v.line) && (v.line as number) > 0)) return `findings[${i}].line must be a positive integer`;
  return {
    severity: v.severity,
    summary: v.summary.trim(),
    ...(typeof v.file === "string" ? { file: v.file } : {}),
    ...(typeof v.line === "number" ? { line: v.line } : {}),
  };
};

/** One parsed JSON value as a report, or what is wrong with it. Unknown extra keys are ignored. */
export const validateWorkerReport = (v: unknown): ParseResult => {
  if (!isObj(v)) return { ok: false, error: "the report is not a JSON object" };
  if (!isWorkerRole(v.role)) return { ok: false, error: `role must be one of ${WORKER_ROLES.join(", ")}` };
  if (!oneOf(REPORT_STATUSES, v.status)) return { ok: false, error: `status must be one of ${REPORT_STATUSES.join(", ")}` };
  if (!oneOf(REPORT_VERDICTS, v.verdict)) return { ok: false, error: `verdict must be one of ${REPORT_VERDICTS.join(", ")}` };
  if (v.pr !== null && !(Number.isInteger(v.pr) && (v.pr as number) > 0)) return { ok: false, error: "pr must be a positive integer or null" };
  if (v.head_sha !== null && !(typeof v.head_sha === "string" && /^[0-9a-f]{7,40}$/i.test(v.head_sha))) {
    return { ok: false, error: "head_sha must be a 7-40 character hex commit id or null" };
  }
  if (!Array.isArray(v.findings)) return { ok: false, error: "findings must be a list" };
  const findings: ReportFinding[] = [];
  for (const [i, f] of v.findings.entries()) {
    const parsed = parseFinding(f, i);
    if (typeof parsed === "string") return { ok: false, error: parsed };
    findings.push(parsed);
  }
  if (!Array.isArray(v.owner_actions) || !v.owner_actions.every((a) => typeof a === "string")) {
    return { ok: false, error: "owner_actions must be a list of strings" };
  }
  let cost: WorkerReport["cost"] = null;
  if (v.cost !== null) {
    if (!isObj(v.cost)) return { ok: false, error: "cost must be an object or null" };
    const { usd, tokens } = v.cost;
    if (usd !== undefined && !(typeof usd === "number" && Number.isFinite(usd) && usd >= 0)) return { ok: false, error: "cost.usd must be a non-negative number" };
    if (tokens !== undefined && !(Number.isInteger(tokens) && (tokens as number) >= 0)) return { ok: false, error: "cost.tokens must be a non-negative integer" };
    cost = { ...(typeof usd === "number" ? { usd } : {}), ...(typeof tokens === "number" ? { tokens } : {}) };
  }
  return {
    ok: true,
    report: {
      role: v.role,
      status: v.status,
      pr: v.pr as number | null,
      head_sha: typeof v.head_sha === "string" ? v.head_sha.toLowerCase() : null,
      verdict: v.verdict,
      findings,
      owner_actions: (v.owner_actions as string[]).map((a) => a.trim()).filter(Boolean),
      cost,
    },
  };
};

const FENCE = new RegExp("(?:^|\\n)[ \\t]*```" + WORKER_REPORT_FENCE + "[ \\t]*\\n([\\s\\S]*?)\\n[ \\t]*```", "g");

/**
 * The report in a worker's text: the LAST `worker-report` fenced block, since a worker
 * that quotes its brief's example before its own must not be read as the example.
 * No block, or a block that is not valid, says why instead of guessing.
 */
export const parseWorkerReport = (text: string): ParseResult => {
  const blocks = [...text.matchAll(FENCE)];
  const last = blocks[blocks.length - 1];
  if (!last) return { ok: false, error: `no \`${WORKER_REPORT_FENCE}\` block in the report` };
  let json: unknown;
  try {
    json = JSON.parse(last[1] ?? "");
  } catch {
    return { ok: false, error: `the \`${WORKER_REPORT_FENCE}\` block is not valid JSON` };
  }
  return validateWorkerReport(json);
};

/** The last `VERDICT: <word>` line, for a worker or a review that predates the block (or skipped it). */
export const legacyVerdict = (text: string): "clean" | "changes" | "verified" | "failed" | undefined => {
  const all = [...text.matchAll(/^[ \t>*_-]*VERDICT:[ \t]*\**(clean|changes|verified|failed)\b/gim)];
  const v = all[all.length - 1]?.[1]?.toLowerCase();
  return v === "clean" || v === "changes" || v === "verified" || v === "failed" ? v : undefined;
};

/**
 * The report in whatever a worker left, a report text or the JSON of `worker-show --full`
 * (it holds the `worker_done` body somewhere; every string in it is searched). The first
 * string holding a valid block wins; when none is valid, the first problem found.
 */
export const findWorkerReport = (value: unknown): ParseResult => {
  let firstError: string | undefined;
  const walk = (v: unknown, depth: number): WorkerReport | undefined => {
    if (depth > 12) return undefined;
    if (typeof v === "string") {
      if (!v.includes("```" + WORKER_REPORT_FENCE)) return undefined;
      const r = parseWorkerReport(v);
      if (r.ok) return r.report;
      firstError ??= r.error;
      return undefined;
    }
    if (Array.isArray(v)) {
      for (const x of v) {
        const r = walk(x, depth + 1);
        if (r) return r;
      }
    } else if (isObj(v)) {
      for (const x of Object.values(v)) {
        const r = walk(x, depth + 1);
        if (r) return r;
      }
    }
    return undefined;
  };
  const report = walk(value, 0);
  return report ? { ok: true, report } : { ok: false, error: firstError ?? `no \`${WORKER_REPORT_FENCE}\` block found` };
};

/** The line `bin/orca-worker-wait.ts` prints for a worker that reported, which the hand-back reads back. */
export const workerReportLine = (dispatchId: string, report: WorkerReport): string => `orca worker ${dispatchId} report ${JSON.stringify(report)}`;

const REPORT_LINE = /^orca worker (ctx_[A-Za-z0-9_-]+) report (\{.*\})$/m;
export const REPORT_LINE_PREFIX = /^orca worker ctx_[A-Za-z0-9_-]+ report \{/;

/** Read a report line back out of a check's output (validated again: the output is only text). */
export const parseWorkerReportLine = (output: string): WorkerReport | undefined => {
  const m = output.match(REPORT_LINE);
  if (!m) return undefined;
  try {
    const r = validateWorkerReport(JSON.parse(m[2] ?? ""));
    return r.ok ? r.report : undefined;
  } catch {
    return undefined;
  }
};

/** A report as a few sentences for the turn that carries on from it. Worker-supplied text is clipped. */
export const reportSummary = (r: WorkerReport): string => {
  const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}...` : s);
  const blockers = r.findings.filter((f) => f.severity === "blocker");
  const parts = [
    `${r.role} ${r.status}${r.pr !== null ? ` on PR #${r.pr}` : ""}${r.head_sha ? ` at ${r.head_sha.slice(0, 7)}` : ""}, verdict ${r.verdict}`,
    `${blockers.length} blocker${blockers.length === 1 ? "" : "s"}, ${r.findings.length - blockers.length} nit${r.findings.length - blockers.length === 1 ? "" : "s"}`,
  ];
  for (const f of blockers.slice(0, 5)) parts.push(`blocker: ${clip(f.summary, 160)}${f.file ? ` (${f.file}${f.line ? `:${f.line}` : ""})` : ""}`);
  if (r.owner_actions.length) parts.push(`owner actions: ${r.owner_actions.slice(0, 5).map((a) => clip(a, 200)).join(" | ")}`);
  return parts.join("; ");
};
