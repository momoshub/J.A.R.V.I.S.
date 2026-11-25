/**
 * What the status message of a turn shows.
 *
 * Tool steps used to be cards inside the streamed answer, which shared its
 * character budget and could never be taken away. They now live in one
 * message of their own: one Slack `plan` block with a `task_card` per step
 * (Slack draws the progress look), rewritten as the turn goes, then deleted -
 * or collapsed to its failures - when the turn ends.
 *
 * Pure: the throttling, posting and deleting are in infrastructure/slack/statusMessage.ts.
 */
import type { Block } from "./blockKit.ts";
import { collapseSteps, type FinishedStep } from "./collapseSteps.ts";

export type StepState = "in_progress" | "complete" | "error";

export type StatusStep = {
  readonly id: string;
  readonly title: string;
  readonly state: StepState;
  /** The line of the tool log this step is at, when it pointed at one. */
  readonly logLine?: string;
};

/** Finished steps listed in a running plan; the older ones are counted in its title, not shown. */
export const STATUS_FINISHED_SHOWN = 5;
/** Steps in progress listed at once. More than this running together is a burst, counted too. */
export const STATUS_RUNNING_SHOWN = 8;
/** Longest a task card title may be (plain text; no mrkdwn, so nothing to escape). */
export const STATUS_TITLE_CHARS = 200;
/** Tasks one plan block may carry. Slack's cap is not documented in the typings, so stay well under any plausible one. */
export const STATUS_TASKS_MAX = 20;

const clip = (text: string, max: number): string => {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length <= max ? one : `${one.slice(0, max - 1)}…`;
};

/** A task card title: the step title, and the log line when there is one. */
export const taskTitle = (step: StatusStep): string => {
  const suffix = step.logLine ? ` · log line ${step.logLine}` : "";
  // A grouped title ends in " (N runs)": that stays whole, and the head gives way.
  const runs = /( \(\d+ runs\))$/.exec(step.title)?.[1] ?? "";
  const head = step.title.slice(0, step.title.length - runs.length);
  const room = STATUS_TITLE_CHARS - runs.length - suffix.length;
  return `${clip(head, Math.max(20, room))}${runs}${suffix}`;
};

/** Slack allows letters, digits, `_` and `-` in a task id; ids are made unique after sanitising. */
const taskIds = (steps: readonly StatusStep[]): string[] => {
  const seen = new Set<string>();
  return steps.map((s, i) => {
    const base = s.id.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 60) || `step_${i}`;
    let id = base;
    for (let n = 2; seen.has(id); n++) id = `${base}_${n}`;
    seen.add(id);
    return id;
  });
};

export type StatusView = { readonly text: string; readonly blocks: Block[] };

const plan = (title: string, steps: readonly StatusStep[]): Block => {
  const ids = taskIds(steps);
  return {
    type: "plan",
    title,
    tasks: steps.map((s, i) => ({ type: "task_card", task_id: ids[i], title: taskTitle(s), status: s.state })),
  };
};

const stepsLabel = (n: number): string => `${n} step${n === 1 ? "" : "s"}`;

/**
 * The running message: every step in progress (up to a cap) and the latest
 * finished ones, oldest first, with the hidden count in the plan's title.
 * `thinking` is the placeholder a silent turn shows (one running task), gone with the first step.
 */
export const renderStatus = (steps: readonly StatusStep[], thinking?: string): StatusView => {
  if (steps.length === 0) {
    const label = thinking?.trim() || "Working…";
    return {
      text: "🔧 Working…",
      blocks: [plan("Working…", [{ id: "thinking", title: clip(label, STATUS_TITLE_CHARS), state: "in_progress" }])],
    };
  }
  const running = steps.filter((s) => s.state === "in_progress");
  const finished = steps.filter((s) => s.state !== "in_progress");
  const keepFinished = new Set(finished.slice(-STATUS_FINISHED_SHOWN));
  const keepRunning = new Set(running.slice(-STATUS_RUNNING_SHOWN));
  const shown = steps.filter((s) => keepFinished.has(s) || keepRunning.has(s)).slice(-STATUS_TASKS_MAX);
  const label = `Working… ${stepsLabel(steps.length)}`;
  const title = shown.length < steps.length ? `${label} (showing ${shown.length})` : label;
  return { text: `🔧 ${label}`, blocks: [plan(title, shown)] };
};

/**
 * The message left behind when the turn ended, or undefined when it should be
 * deleted. A turn whose steps all worked leaves nothing: the answer is what
 * matters. One where a step failed keeps "N steps" as the plan's title and the
 * failures as error cards, because those are the part somebody may have to act on.
 */
export const finalStatus = (steps: readonly StatusStep[]): StatusView | undefined => {
  const finished: FinishedStep[] = steps.map((s) => ({ title: s.title, failed: s.state === "error" }));
  if (!finished.some((s) => s.failed)) return undefined;
  // A lone failed step is kept too, unlike the answer's old one-card rule.
  const collapsed = collapseSteps(finished, 1);
  if (!collapsed) return undefined;
  const failed = steps.filter((s) => s.state === "error" && s.title.trim());
  const kept = failed.slice(0, STATUS_TASKS_MAX);
  const more = failed.length - kept.length;
  const title = more > 0 ? `${collapsed.summary} (…and ${more} more failed)` : collapsed.summary;
  return { text: collapsed.summary, blocks: [plan(title, kept)] };
};
