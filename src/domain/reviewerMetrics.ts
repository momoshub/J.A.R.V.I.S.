/**
 * A measured reviewer: what the standalone self-fix reviewer is worth, beyond
 * "it took 3 rounds".
 *
 * Rounds say how long a review took, not whether it was any good. Three
 * numbers say more, all read off the merged PRs themselves (the review and fix
 * comments follow the `[review round N]` / `[fix round N]` / `VERDICT:`
 * protocol in `standaloneReviewRule`):
 *
 *   blockers raised      - findings in rounds that ended `VERDICT: changes`
 *   false positives      - blockers the writer pushed back on and the reviewer
 *                          then let go (the next round is clean): review that
 *                          cost a round and was wrong
 *   escaped defects      - PRs that merged on a `VERDICT: clean` and were later
 *                          fixed or reverted by another PR that cites them, or
 *                          that rewrites the very lines they added: review
 *                          that was clean and wrong
 *
 * Everything here is a heuristic over free text and patches, stated next to
 * each function, and errs the same way: it undercounts rather than invents (a
 * pushback the reviewer never confirmed is not a false positive; a later PR
 * that merely builds on one is not an escape). Pure: `bin/reviewer-metrics.ts`
 * fetches the PRs through `gh api`, the clock comes in as `generatedAt`.
 */
import { classifyDiff, type ChangedFile, type RiskClass } from "./riskClass.ts";

export type PrFile = { readonly path: string; readonly oldPath?: string; readonly status: string; readonly patch?: string };
export type PrReview = { readonly id: number; readonly body: string; readonly state: string; readonly submittedAt: string; readonly commitId: string; readonly inlineComments: number };
export type PrComment = { readonly body: string; readonly createdAt: string };

export type PrRecord = {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly headRef: string;
  readonly mergedAt: string;
  readonly reviews: readonly PrReview[];
  /** Conversation comments (where `[fix round N]` lives). */
  readonly comments: readonly PrComment[];
  readonly files: readonly PrFile[];
};

export type Verdict = "clean" | "changes";
export type ReviewRound = { readonly round: number; readonly verdict: Verdict | undefined; readonly blockers: number };
export type FixRound = { readonly round: number; readonly items: number; readonly pushbacks: number };

/** `cites` and `both` are confirmed (the fix names the PR); `same-lines` alone is only possible (busy files are rewritten by everyone). */
export type Escape = { readonly pr: number; readonly by: "cites" | "same-lines" | "both"; readonly paths: readonly string[] };

export const isConfirmed = (e: Escape): boolean => e.by !== "same-lines";

export type PrMetrics = {
  readonly number: number;
  readonly title: string;
  readonly mergedAt: string;
  readonly riskClass: RiskClass;
  /** The classifier says a reviewer was owed. */
  readonly reviewerOwed: boolean;
  /** Review rounds that happened (highest `[review round N]`), 0 = no reviewer ran. */
  readonly rounds: number;
  readonly finalVerdict: Verdict | undefined;
  readonly blockers: number;
  /** Pushbacks the reviewer then let go. */
  readonly falsePositives: number;
  /** Pushbacks no later round confirmed or contested. */
  readonly pushbacksUnconfirmed: number;
  readonly escapes: readonly Escape[];
};

export type ClassMetrics = { readonly prs: number; readonly reviewed: number; readonly cleanVerdicts: number; readonly escaped: number };

export type Aggregate = {
  readonly prs: number;
  readonly reviewed: number;
  /** Owed a reviewer by today's classifier and never reviewed. */
  readonly owedButUnreviewed: number;
  readonly roundsHistogram: Readonly<Record<string, number>>;
  readonly meanRounds: number;
  readonly firstRoundClean: number;
  readonly blockersRaised: number;
  readonly falsePositives: number;
  /** falsePositives / blockersRaised, 0 when nothing was raised. */
  readonly falsePositiveRate: number;
  readonly cleanVerdicts: number;
  /** Confirmed escapes: later fix PRs that cite a PR merged clean. */
  readonly escapedDefects: number;
  /** PRs that merged clean and a later fix PR names (confirmed), over PRs that merged clean. */
  readonly escapedPrs: number;
  readonly escapeRate: number;
  /** PRs with only same-lines evidence, on top of the confirmed ones: an upper bound, not a count. */
  readonly possiblyEscapedPrs: number;
  readonly possibleEscapeRate: number;
  readonly byClass: Readonly<Record<RiskClass, ClassMetrics>>;
};

export type MetricsReport = {
  readonly generatedAt: string;
  readonly repo: string;
  readonly windowDays: number;
  readonly perPr: readonly PrMetrics[];
  readonly aggregate: Aggregate;
};

// --- reading the protocol out of comments ---

const REVIEW_MARKER_RE = /^\s*\[review round (\d+)\]/i;
const FIX_MARKER_RE = /^\s*\[fix round (\d+)\]/i;
const VERDICT_RE = /VERDICT:\s*(clean|changes)\b/gi;
const LIST_ITEM_RE = /^\s{0,3}(?:\d+[.)]|[-*•])\s+\S/;
const LIST_MARKER_RE = /^\s{0,3}(?:\d+[.)]|[-*•])\s+/;

/** `[review round N]` and the LAST `VERDICT:` line (a body may quote an earlier verdict). */
export const parseReview = (body: string, inlineComments: number): ReviewRound | undefined => {
  const m = REVIEW_MARKER_RE.exec(body);
  if (!m) return undefined;
  const verdicts = [...body.matchAll(VERDICT_RE)].map((v) => (v[1] ?? "").toLowerCase() as Verdict);
  const verdict = verdicts[verdicts.length - 1];
  return { round: Number(m[1]), verdict, blockers: verdict === "changes" ? countBlockers(body, inlineComments) : 0 };
};

/**
 * Findings in a `changes` review: its inline comments when it has them, else
 * the list items of its body (the marker and verdict lines are not findings),
 * and at least one, since a `changes` verdict names a blocker even in prose.
 */
export const countBlockers = (body: string, inlineComments: number): number => {
  if (inlineComments > 0) return inlineComments;
  const items = body.split("\n").filter((l) => LIST_ITEM_RE.test(l) && !/VERDICT:/i.test(l)).length;
  return Math.max(1, items);
};

const PUSHBACK_RE = /\b(?:pushed? back|pushing back|push-?back|not a (?:bug|blocker|defect|regression|problem)|false positive|disagree|by design|intended|intentional|won'?t fix|not fixing|no change (?:needed|made)|leaving (?:it|as is)|already (?:handled|covered|guarded)|cannot happen|can'?t happen)\b/i;
const FIXED_RE = /^\W*(?:fixed|done|added|changed|updated|removed|renamed|now)\b/i;

/**
 * A `[fix round N]` comment answers each finding in a list item (or the whole
 * comment is one answer). An item is a pushback when it says so and does not
 * open with "fixed": "fixed, not a false positive" is a fix.
 */
export const parseFix = (body: string): FixRound | undefined => {
  const m = FIX_MARKER_RE.exec(body);
  if (!m) return undefined;
  const rest = body.slice(m[0].length);
  const items: string[] = [];
  for (const line of rest.split("\n")) {
    if (LIST_ITEM_RE.test(line)) items.push(line);
    else if (items.length > 0 && line.trim() !== "") items[items.length - 1] += ` ${line.trim()}`;
  }
  const answers = items.length > 0 ? items : [rest];
  const pushbacks = answers.filter((a) => PUSHBACK_RE.test(a) && !FIXED_RE.test(a.replace(LIST_MARKER_RE, ""))).length;
  return { round: Number(m[1]), items: answers.length, pushbacks };
};

type Rounds = { readonly reviews: ReadonlyMap<number, ReviewRound>; readonly fixes: ReadonlyMap<number, FixRound> };

const readRounds = (pr: PrRecord): Rounds => {
  const reviews = new Map<number, ReviewRound>();
  for (const r of pr.reviews) {
    const parsed = parseReview(r.body, r.inlineComments);
    if (parsed) reviews.set(parsed.round, parsed);
  }
  const fixes = new Map<number, FixRound>();
  for (const c of pr.comments) {
    const parsed = parseFix(c.body);
    if (parsed) fixes.set(parsed.round, parsed);
  }
  return { reviews, fixes };
};

/**
 * Pushbacks the reviewer let go: a fix round that pushed back, followed by a
 * review round that is `clean`. Pushbacks in a round whose next round does not
 * exist, or still says `changes`, are unconfirmed - the reviewer may still
 * have been right.
 */
const pushbackOutcome = (rounds: Rounds): { falsePositives: number; unconfirmed: number } => {
  let falsePositives = 0;
  let unconfirmed = 0;
  for (const fix of rounds.fixes.values()) {
    if (fix.pushbacks === 0) continue;
    const next = rounds.reviews.get(fix.round + 1);
    if (next?.verdict === "clean") falsePositives += fix.pushbacks;
    else unconfirmed += fix.pushbacks;
  }
  return { falsePositives, unconfirmed };
};

// --- escaped defects: later fixes of a PR that merged clean ---

export type Range = { readonly from: number; readonly to: number };

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** The line ranges a patch wrote (`new`) and the ones it rewrote (`old`); empty ranges (pure deletions, pure additions) are dropped. */
export const hunkRanges = (patch: string | undefined): { oldRanges: Range[]; newRanges: Range[] } => {
  const oldRanges: Range[] = [];
  const newRanges: Range[] = [];
  for (const line of (patch ?? "").split("\n")) {
    const m = HUNK_RE.exec(line);
    if (!m) continue;
    const oldLen = m[2] === undefined ? 1 : Number(m[2]);
    const newLen = m[4] === undefined ? 1 : Number(m[4]);
    if (oldLen > 0) oldRanges.push({ from: Number(m[1]), to: Number(m[1]) + oldLen - 1 });
    if (newLen > 0) newRanges.push({ from: Number(m[3]), to: Number(m[3]) + newLen - 1 });
  }
  return { oldRanges, newRanges };
};

const intersects = (a: readonly Range[], b: readonly Range[]): boolean => a.some((x) => b.some((y) => x.from <= y.to && y.from <= x.to));

/** A later PR that is a fix: by its title, its branch or its body's own words. */
const FIX_LIKE_RE = /\b(?:fix(?:es|ed)?|hotfix|revert(?:s|ed)?|regress(?:ion|ed)?|bug|broke|broken|repair)\b/i;
export const isFixLike = (pr: Pick<PrRecord, "title" | "headRef" | "body">): boolean => FIX_LIKE_RE.test(`${pr.title} ${pr.headRef.replace(/[-_/]/g, " ")}`) || /\b(?:fixes|reverts?|regression (?:from|of|in)|introduced (?:in|by)|broken by)\b/i.test(pr.body);

/** `#N`, `pull/N` or `PR N` as a whole number: #13 never matches a mention of #136. */
export const cites = (text: string, n: number): boolean => new RegExp(`(?:#|pull/|\\bPRs?\\s+)${n}(?!\\d)`, "i").test(text);

const DAY_MS = 86_400_000;

/**
 * Later fix PRs of `target`. A fix counts when it cites the PR, or when it
 * rewrites lines the PR added and no PR merged in between wrote them again
 * (line numbers are as of each PR's own base, so this is approximate: an
 * intervening edit above shifts them). A PR that only
 * builds on the target, with no fix wording, is evolution, not an escape.
 */
export const findEscapes = (target: PrRecord, others: readonly PrRecord[], windowDays: number): Escape[] => {
  const from = Date.parse(target.mergedAt);
  const written = new Map<string, Range[]>();
  for (const f of target.files) written.set(f.path, hunkRanges(f.patch).newRanges);
  const out: Escape[] = [];
  for (const l of others) {
    const at = Date.parse(l.mergedAt);
    if (l.number === target.number || !(at > from) || at - from > windowDays * DAY_MS) continue;
    if (!isFixLike(l)) continue;
    const citing = cites(`${l.title}\n${l.body}\n${l.headRef}`, target.number);
    const paths = l.files
      .filter((f) => {
        const path = f.oldPath ?? f.path;
        const mine = written.get(path) ?? written.get(f.path);
        const rewritten = hunkRanges(f.patch).oldRanges;
        if (mine === undefined || !intersects(mine, rewritten)) return false;
        // lines a PR merged in between rewrote again are that PR's, not this one's
        return !others.some((m) => {
          const mAt = Date.parse(m.mergedAt);
          return m.number !== target.number && m.number !== l.number && mAt > from && mAt < at && m.files.some((mf) => mf.path === path && intersects(hunkRanges(mf.patch).newRanges, rewritten));
        });
      })
      .map((f) => f.path);
    if (!citing && paths.length === 0) continue;
    out.push({ pr: l.number, by: citing && paths.length > 0 ? "both" : citing ? "cites" : "same-lines", paths });
  }
  return out;
};

// --- per PR and in aggregate ---

const toChanged = (f: PrFile): ChangedFile => ({
  path: f.path,
  ...(f.oldPath !== undefined ? { oldPath: f.oldPath } : {}),
  patch: f.patch ?? "",
  // GitHub sends no patch for a binary or a huge file: unreadable is classed like a binary, never as docs
  binary: f.patch === undefined && f.status !== "removed" && f.status !== "renamed",
  deleted: f.status === "removed",
});

export const emptyClassMetrics = (): ClassMetrics => ({ prs: 0, reviewed: 0, cleanVerdicts: 0, escaped: 0 });

export const computeMetrics = (prs: readonly PrRecord[], opts: { readonly repo: string; readonly windowDays: number; readonly generatedAt: string }): MetricsReport => {
  const sorted = [...prs].sort((a, b) => a.number - b.number);
  const perPr: PrMetrics[] = sorted.map((pr) => {
    const rounds = readRounds(pr);
    const risk = classifyDiff(pr.files.map(toChanged));
    const ordered = [...rounds.reviews.values()].sort((a, b) => a.round - b.round);
    const last = ordered[ordered.length - 1];
    const push = pushbackOutcome(rounds);
    const finalVerdict = last?.verdict;
    return {
      number: pr.number,
      title: pr.title,
      mergedAt: pr.mergedAt,
      riskClass: risk.class,
      reviewerOwed: risk.routing.reviewer,
      rounds: last?.round ?? 0,
      finalVerdict,
      blockers: ordered.reduce((n, r) => n + r.blockers, 0),
      falsePositives: push.falsePositives,
      pushbacksUnconfirmed: push.unconfirmed,
      escapes: finalVerdict === "clean" ? findEscapes(pr, sorted, opts.windowDays) : [],
    };
  });

  const reviewed = perPr.filter((p) => p.rounds > 0);
  const clean = perPr.filter((p) => p.finalVerdict === "clean");
  const escaped = clean.filter((p) => p.escapes.some(isConfirmed));
  const possibly = clean.filter((p) => p.escapes.length > 0 && !p.escapes.some(isConfirmed));
  const blockersRaised = perPr.reduce((n, p) => n + p.blockers, 0);
  const falsePositives = perPr.reduce((n, p) => n + p.falsePositives, 0);
  const histogram: Record<string, number> = {};
  for (const p of reviewed) {
    const key = p.rounds >= 5 ? "5" : String(p.rounds);
    histogram[key] = (histogram[key] ?? 0) + 1;
  }
  const byClass: Record<RiskClass, ClassMetrics> = { docs: emptyClassMetrics(), prompt: emptyClassMetrics(), runtime: emptyClassMetrics(), capability: emptyClassMetrics() };
  for (const p of perPr) {
    const c = byClass[p.riskClass];
    byClass[p.riskClass] = {
      prs: c.prs + 1,
      reviewed: c.reviewed + (p.rounds > 0 ? 1 : 0),
      cleanVerdicts: c.cleanVerdicts + (p.finalVerdict === "clean" ? 1 : 0),
      escaped: c.escaped + (p.finalVerdict === "clean" && p.escapes.some(isConfirmed) ? 1 : 0),
    };
  }
  const ratio = (n: number, d: number): number => (d === 0 ? 0 : Math.round((n / d) * 1000) / 1000);
  return {
    generatedAt: opts.generatedAt,
    repo: opts.repo,
    windowDays: opts.windowDays,
    perPr,
    aggregate: {
      prs: perPr.length,
      reviewed: reviewed.length,
      owedButUnreviewed: perPr.filter((p) => p.reviewerOwed && p.rounds === 0).length,
      roundsHistogram: histogram,
      meanRounds: ratio(reviewed.reduce((n, p) => n + p.rounds, 0), reviewed.length),
      firstRoundClean: reviewed.filter((p) => p.rounds === 1 && p.finalVerdict === "clean").length,
      blockersRaised,
      falsePositives,
      falsePositiveRate: ratio(falsePositives, blockersRaised),
      cleanVerdicts: clean.length,
      escapedPrs: escaped.length,
      escapedDefects: escaped.reduce((n, p) => n + p.escapes.filter(isConfirmed).length, 0),
      escapeRate: ratio(escaped.length, clean.length),
      possiblyEscapedPrs: possibly.length,
      possibleEscapeRate: ratio(escaped.length + possibly.length, clean.length),
      byClass,
    },
  };
};

// --- the API shapes the bin reads ---

export type ApiPr = { number: number; title: string; body: string | null; merged_at: string | null; head: { ref: string } };
export type ApiReview = { id: number; body: string | null; state: string; submitted_at?: string | null; commit_id?: string | null };
export type ApiComment = { body: string | null; created_at: string };
export type ApiReviewComment = { pull_request_review_id: number | null };
export type ApiFile = { filename: string; previous_filename?: string; status: string; patch?: string };

export const prRecordFromApi = (pr: ApiPr, reviews: readonly ApiReview[], comments: readonly ApiComment[], reviewComments: readonly ApiReviewComment[], files: readonly ApiFile[]): PrRecord => ({
  number: pr.number,
  title: pr.title,
  body: pr.body ?? "",
  headRef: pr.head.ref,
  mergedAt: pr.merged_at ?? "",
  reviews: reviews.map((r) => ({
    id: r.id,
    body: r.body ?? "",
    state: r.state,
    submittedAt: r.submitted_at ?? "",
    commitId: r.commit_id ?? "",
    inlineComments: reviewComments.filter((c) => c.pull_request_review_id === r.id).length,
  })),
  comments: comments.map((c) => ({ body: c.body ?? "", createdAt: c.created_at })),
  files: files.map((f) => ({ path: f.filename, ...(f.previous_filename !== undefined ? { oldPath: f.previous_filename } : {}), status: f.status, ...(f.patch !== undefined ? { patch: f.patch } : {}) })),
});

// --- the text report ---

const pct = (r: number): string => `${Math.round(r * 1000) / 10}%`;

export const formatMetricsText = (report: MetricsReport): string => {
  const a = report.aggregate;
  const lines = [
    `reviewer metrics for ${report.repo} (${a.prs} merged PRs, escape window ${report.windowDays} days, ${report.generatedAt})`,
    "",
    `reviewed:            ${a.reviewed} of ${a.prs} PRs (${a.owedButUnreviewed} owed a reviewer by today's classifier and had none)`,
    `rounds:              mean ${a.meanRounds}, histogram ${Object.entries(a.roundsHistogram).map(([k, v]) => `${k}:${v}`).join(" ") || "none"}, clean in round 1: ${a.firstRoundClean}`,
    `blockers raised:     ${a.blockersRaised}`,
    `false positives:     ${a.falsePositives} (${pct(a.falsePositiveRate)} of blockers: pushed back and the reviewer let go)`,
    `clean verdicts:      ${a.cleanVerdicts}`,
    `escaped defects:     ${a.escapedDefects} in ${a.escapedPrs} PRs (${pct(a.escapeRate)} of clean verdicts: a later fix or revert PR names them)`,
    `possibly escaped:    up to ${pct(a.possibleEscapeRate)} (${a.possiblyEscapedPrs} more PRs whose lines a later fix PR rewrote without naming them: busy files, weak evidence)`,
    "",
    "by risk class:",
    ...(["capability", "runtime", "prompt", "docs"] as const).map((c) => {
      const m = a.byClass[c];
      return `  ${c.padEnd(10)} ${String(m.prs).padStart(3)} PRs, ${m.reviewed} reviewed, ${m.cleanVerdicts} clean, ${m.escaped} escaped`;
    }),
  ];
  const interesting = report.perPr.filter((p) => p.rounds > 0 || p.escapes.length > 0 || (p.reviewerOwed && p.rounds === 0));
  if (interesting.length > 0) {
    lines.push("", "per PR (reviewed, escaped, or owed a reviewer and not reviewed):");
    for (const p of interesting) {
      const flags = [
        p.rounds > 0 ? `${p.rounds} round${p.rounds === 1 ? "" : "s"}, ${p.finalVerdict ?? "no verdict"}` : "no reviewer",
        p.blockers > 0 ? `${p.blockers} blocker${p.blockers === 1 ? "" : "s"}` : "",
        p.falsePositives > 0 ? `${p.falsePositives} false positive${p.falsePositives === 1 ? "" : "s"}` : "",
        p.escapes.length > 0 ? `${p.escapes.some(isConfirmed) ? "ESCAPED" : "possibly escaped"} via ${p.escapes.map((e) => `#${e.pr} (${e.by})`).join(", ")}` : "",
      ].filter((f) => f !== "");
      lines.push(`  #${p.number} [${p.riskClass}] ${p.title.slice(0, 60)}: ${flags.join("; ")}`);
    }
  }
  return lines.join("\n");
};
