#!/usr/bin/env bun
//
// How good is the self-fix reviewer? Walk merged PRs and measure it.
//
//   reviewer-metrics.ts [--repo <owner/repo>] [--limit <n>] [--since <YYYY-MM-DD>]
//                       [--window-days <n>] [--json] [--out <file>]
//
// Reads the newest <n> merged PRs (default 60) through `gh api` and prints, per
// PR and in aggregate: review rounds, blockers raised, blockers the writer
// pushed back on that the reviewer then let go (false positives), and defects
// that got past a `VERDICT: clean` (a later fix or revert PR within
// <window-days>, default 30, that cites the PR or rewrites its lines). Text by
// default, `--json` for the whole report, `--out` also writes the JSON to a
// file. Needs `gh` logged in with read access to the repo. Read-only.
// The rules, and their limits, are in src/domain/reviewerMetrics.ts.
import { writeFileSync } from "node:fs";
import { computeMetrics, formatMetricsText, prRecordFromApi, type ApiComment, type ApiFile, type ApiPr, type ApiReview, type ApiReviewComment, type PrRecord } from "../src/domain/reviewerMetrics.ts";

const USAGE = "usage: bun bin/reviewer-metrics.ts [--repo <owner/repo>] [--limit <n>] [--since <YYYY-MM-DD>] [--window-days <n>] [--json] [--out <file>]";
const fail = (msg: string): never => {
  console.error(msg);
  console.error(USAGE);
  process.exit(2);
};

let repo = "";
let limit = 60;
let since = "";
let windowDays = 30;
let json = false;
let out = "";
const args = process.argv.slice(2);
const value = (i: number, flag: string): string => args[i + 1] ?? fail(`${flag} needs a value`);
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--json") json = true;
  else if (a === "--repo") repo = value(i++, a);
  else if (a === "--limit") limit = Number(value(i++, a));
  else if (a === "--since") since = value(i++, a);
  else if (a === "--window-days") windowDays = Number(value(i++, a));
  else if (a === "--out") out = value(i++, a);
  else if (a === "--help" || a === "-h") {
    console.log(USAGE);
    process.exit(0);
  } else fail(`unknown argument ${a}`);
}
if (!Number.isInteger(limit) || limit < 1 || limit > 500) fail("--limit is a whole number from 1 to 500");
if (!Number.isFinite(windowDays) || windowDays < 1) fail("--window-days is a number of days, 1 or more");
if (since !== "" && !/^\d{4}-\d{2}-\d{2}$/.test(since)) fail("--since is YYYY-MM-DD");

const gh = async (...cmd: string[]): Promise<string> => {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(["gh", ...cmd], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  } catch {
    return fail("cannot run gh: install it and log in");
  }
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout as ReadableStream).text(), new Response(proc.stderr as ReadableStream).text()]);
  if ((await proc.exited) !== 0) return fail(`gh ${cmd.join(" ")} failed: ${stderr.trim()}`);
  return stdout;
};

/** Every page of a list endpoint, flattened (`--slurp` wraps the pages in one array). */
const ghList = async <T>(path: string): Promise<T[]> => {
  const pages = JSON.parse(await gh("api", "--paginate", "--slurp", path)) as T[][];
  return pages.flat();
};

if (repo === "") repo = (await gh("repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner")).trim();

// newest merged first: closed PRs by update time, filtered to merged, until <limit> or <since>
const merged: ApiPr[] = [];
for (let page = 1; merged.length < limit; page++) {
  const batch = JSON.parse(await gh("api", `repos/${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=100&page=${page}`)) as ApiPr[];
  if (batch.length === 0) break;
  for (const pr of batch) if (pr.merged_at && (since === "" || pr.merged_at.slice(0, 10) >= since)) merged.push(pr);
  if (batch.length < 100) break;
}
const picked = merged.slice(0, limit);

const load = async (pr: ApiPr): Promise<PrRecord> => {
  const [reviews, comments, reviewComments, files] = await Promise.all([
    ghList<ApiReview>(`repos/${repo}/pulls/${pr.number}/reviews?per_page=100`),
    ghList<ApiComment>(`repos/${repo}/issues/${pr.number}/comments?per_page=100`),
    ghList<ApiReviewComment>(`repos/${repo}/pulls/${pr.number}/comments?per_page=100`),
    ghList<ApiFile>(`repos/${repo}/pulls/${pr.number}/files?per_page=100`),
  ]);
  return prRecordFromApi(pr, reviews, comments, reviewComments, files);
};

// a few PRs at a time: each is four API calls
const records: PrRecord[] = [];
const queue = [...picked];
await Promise.all(
  Array.from({ length: 4 }, async () => {
    for (let pr = queue.shift(); pr !== undefined; pr = queue.shift()) records.push(await load(pr));
  }),
);

const report = computeMetrics(records, { repo, windowDays, generatedAt: new Date().toISOString() });
if (out !== "") writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
console.log(json ? JSON.stringify(report, null, 2) : formatMetricsText(report));
