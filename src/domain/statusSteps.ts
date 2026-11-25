/**
 * What the status message of a turn shows.
 *
 * Tool steps used to be cards inside the streamed answer, which shared its
 * character budget and could never be taken away. They now live in one
 * message of their own: a line per step with its state, rewritten as the turn
 * goes, then deleted - or collapsed to its failures - when the turn ends.
 *
 * Pure: the throttling, posting and deleting are in infrastructure/slack/statusMessage.ts.
 */
import type { Block } from "./blockKit.ts";
import { collapsedBlocks, collapseSteps, type FinishedStep } from "./collapseSteps.ts";

export type StepState = "in_progress" | "complete" | "error";

export type StatusStep = {
  readonly id: string;
  readonly title: string;
  readonly state: StepState;
  /** The line of the tool log this step is at, when it pointed at one. */
  readonly logLine?: string;
};

/** Finished steps listed under a running message; the older ones are counted, not shown. */
export const STATUS_FINISHED_SHOWN = 5;
/** Steps in progress listed at once. More than this running together is a burst, counted too. */
export const STATUS_RUNNING_SHOWN = 8;
/** Longest one line may be. */
export const STATUS_LINE_CHARS = 220;
/** Characters the whole text may take: a context block's element allows 3000. */
export const STATUS_TEXT_BUDGET = 2_600;

const ICON: Record<StepState, string> = { in_progress: "⏳", complete: "✅", error: "❌" };

/** Slack reads `<`, `>` and `&` in mrkdwn as links, mentions and entities. */
export const escapeMrkdwn = (text: string): string =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const clip = (text: string, max: number): string => {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length <= max ? one : `${one.slice(0, max - 1)}…`;
};

/** One step as a line: icon, title, and the log line when there is one. */
export const stepLine = (step: StatusStep): string => {
  const suffix = step.logLine ? ` · log line ${step.logLine}` : "";
  // A grouped title ends in " (N runs)": that stays whole, and the head gives way.
  const runs = /( \(\d+ runs\))$/.exec(step.title)?.[1] ?? "";
  const head = step.title.slice(0, step.title.length - runs.length);
  const room = STATUS_LINE_CHARS - runs.length - suffix.length - 2;
  const title = `${clip(head, Math.max(20, room))}${runs}`;
  return `${ICON[step.state]} ${escapeMrkdwn(title)}${suffix}`;
};

export type StatusView = { readonly text: string; readonly blocks: Block[] };

const contextBlock = (lines: readonly string[]): Block => ({
  type: "context",
  elements: [{ type: "mrkdwn", text: lines.join("\n") }],
});

/**
 * The running message: every step in progress (up to a cap) and the latest
 * finished ones, oldest first, with "and K more" on top for the rest.
 * `thinking` is the placeholder line a silent turn shows, gone with the first step.
 */
export const renderStatus = (steps: readonly StatusStep[], thinking?: string): StatusView => {
  const running = steps.filter((s) => s.state === "in_progress");
  const finished = steps.filter((s) => s.state !== "in_progress");
  const keepFinished = new Set(finished.slice(-STATUS_FINISHED_SHOWN));
  const keepRunning = new Set(running.slice(-STATUS_RUNNING_SHOWN));
  let shown = steps.filter((s) => keepFinished.has(s) || keepRunning.has(s));
  const build = (list: readonly StatusStep[]): string[] => {
    const hidden = steps.length - list.length;
    return [...(hidden > 0 ? [`_…and ${hidden} more step${hidden === 1 ? "" : "s"}_`] : []), ...list.map(stepLine)];
  };
  let lines = build(shown);
  // Over the budget: the oldest finished lines go first, then the oldest running.
  while (lines.join("\n").length > STATUS_TEXT_BUDGET && shown.length > 1) {
    const drop = shown.find((s) => s.state !== "in_progress") ?? shown[0];
    shown = shown.filter((s) => s !== drop);
    lines = build(shown);
  }
  if (thinking?.trim() && steps.length === 0) lines = [`⏳ ${escapeMrkdwn(clip(thinking, STATUS_LINE_CHARS))}`];
  const text = steps.length > 0 ? `🔧 Working… ${steps.length} step${steps.length === 1 ? "" : "s"}` : "🔧 Working…";
  return { text, blocks: [contextBlock(lines)] };
};

/**
 * The message left behind when the turn ended, or undefined when it should be
 * deleted. A turn whose steps all worked leaves nothing: the answer is what
 * matters. One where a step failed keeps "N steps" and the failures in full,
 * because those are the part somebody may have to act on.
 */
export const finalStatus = (steps: readonly StatusStep[]): StatusView | undefined => {
  const finished: FinishedStep[] = steps.map((s) => ({ title: s.title, failed: s.state === "error" }));
  if (!finished.some((s) => s.failed)) return undefined;
  // A lone failed step is kept too, unlike the answer's old one-card rule.
  const collapsed = collapseSteps(finished, 1);
  if (!collapsed) return undefined;
  // Measured after escaping (`&` grows to five characters), so the element stays under Slack's limit
  // however many steps failed: the first ones are kept in full and the rest are counted.
  const summary = escapeMrkdwn(collapsed.summary);
  const kept: string[] = [];
  let size = summary.length;
  for (const f of collapsed.failures.map(escapeMrkdwn)) {
    if (size + f.length + 3 > STATUS_TEXT_BUDGET) break;
    kept.push(f);
    size += f.length + 3;
  }
  const more = collapsed.failures.length - kept.length;
  return {
    text: collapsed.summary,
    blocks: collapsedBlocks("", {
      summary,
      failures: more > 0 ? [...kept, `_…and ${more} more failed_`] : kept,
    }),
  };
};
