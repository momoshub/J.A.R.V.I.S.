/**
 * What the status message of a turn shows.
 *
 * Tool steps used to be cards inside the streamed answer, which shared its
 * character budget and could never be taken away. They now live in one
 * message of their own: a header `task_card` (title only: the dashboard's
 * thinking label, `STATUS_LABEL` when it is empty), then one top-level `task_card` per step (Slack draws the progress look), rewritten
 * as the turn goes, then deleted - or collapsed to its failures - when the turn
 * ends, with the step count in a small `context` block after the last card. Every step card carries content: `details` (what the step does, the command /
 * path / query / url in code style), `output` (a short clipped result and the log
 * line) and `sources` (urls). There is no `plan` block:
 * Slack folds a plan, which hid the tool names, and refuses more than one per
 * message ("Cannot have more than 1 plan block").
 *
 * Pure: the throttling, posting and deleting are in infrastructure/slack/statusMessage.ts.
 */
import type { Block } from "./blockKit.ts";
import { collapseSteps, type FinishedStep } from "./collapseSteps.ts";
import { redactPaths, redactSecrets } from "./toolVisibility.ts";

export type StepState = "in_progress" | "complete" | "error";

export type StatusStep = {
  readonly id: string;
  readonly title: string;
  readonly state: StepState;
  /** The line of the tool log this step is at, when it pointed at one. */
  readonly logLine?: string;
  /** What the step does, in English (the tool's own description). */
  readonly detail?: string;
  /** What it ran: the command, path, query or url. Shown as code. */
  readonly command?: string;
  /** What came back (or the error), any length: clipped when rendered. */
  readonly output?: string;
  /** Links the step touched. Found in the detail and command when not given. */
  readonly sources?: readonly { readonly url: string; readonly text?: string }[];
};

/** Finished steps listed in a running plan; the older ones are counted in its title, not shown. */
export const STATUS_FINISHED_SHOWN = 5;
/** Steps in progress listed at once. More than this running together is a burst, counted too. */
export const STATUS_RUNNING_SHOWN = 8;
/** Longest a task card title may be (plain text; no mrkdwn, so nothing to escape). */
export const STATUS_TITLE_CHARS = 200;
/** Task cards one status message may carry (plus its header), well under Slack's 50 blocks. */
export const STATUS_TASKS_MAX = 20;
/** The running label of the status message, the title of its header card. */
export const STATUS_LABEL = "Burning token…";
/** Longest the description of a step may be in its card. */
export const STATUS_DETAIL_CHARS = 300;
/** Longest the command / path / query / url of a step may be in its card. */
export const STATUS_COMMAND_CHARS = 400;
/** Longest the result line of a step may be in its card. */
export const STATUS_OUTPUT_CHARS = 240;
/** Links one card lists as sources. */
export const STATUS_SOURCES_MAX = 3;

const clip = (text: string, max: number): string => {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length <= max ? one : `${one.slice(0, max - 1)}…`;
};

/**
 * Nothing credential-shaped, no machine path, no `SOME_TOKEN=value` assignment
 * reaches Slack: the same scrub the tool log and the step titles use, plus the
 * env-style assignments a command line carries.
 */
const ASSIGNMENT = /\b([A-Z][A-Z0-9_]*(?:TOKEN|SECRET|KEY|PASSWORD|PASSWD|PASS|CREDENTIALS?|TICKET)(?:_FILE)?)=("[^"]*"|'[^']*'|\S+)/g;
export const scrubStatusText = (text: string): string =>
  redactPaths(redactSecrets(text.replace(ASSIGNMENT, "$1=[redacted]")));

/** A short clipped line of a tool result: the first lines that say something, scrubbed. */
const outputLine = (output: string): string => {
  const lines = scrubStatusText(output)
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  return clip(lines.slice(0, 2).join(" ⏎ "), STATUS_OUTPUT_CHARS);
};

const URL_RE = /https?:\/\/[^\s<>"'`)\]]+/g;

const sourcesOf = (step: StatusStep): { type: "url"; url: string; text: string }[] => {
  const given = (step.sources ?? []).map((s) => ({ url: s.url, text: s.text }));
  const found = [step.command, step.detail].flatMap((t) => (t ? (scrubStatusText(t).match(URL_RE) ?? []) : [])).map((url) => ({ url, text: undefined }));
  const seen = new Set<string>();
  return [...given, ...found]
    .map((s) => ({ ...s, url: s.url.replace(/[.,;:]+$/, "") }))
    .filter((s) => /^https?:\/\/\S+$/.test(s.url) && s.url.length <= 2000 && !seen.has(s.url) && !!seen.add(s.url))
    .slice(0, STATUS_SOURCES_MAX)
    .map((s) => ({ type: "url" as const, url: s.url, text: clip(s.text ?? s.url, 100) }));
};

const richText = (elements: readonly object[]): object => ({
  type: "rich_text",
  elements: [{ type: "rich_text_section", elements }],
});

/** `details`: the description, then the command (code style); undefined when the step has neither. */
const detailsOf = (step: StatusStep): object | undefined => {
  const detail = step.detail ? clip(scrubStatusText(step.detail), STATUS_DETAIL_CHARS) : "";
  const command = step.command ? clip(scrubStatusText(step.command), STATUS_COMMAND_CHARS) : "";
  const elements = [
    ...(detail ? [{ type: "text", text: detail }] : []),
    ...(detail && command ? [{ type: "text", text: "\n" }] : []),
    ...(command ? [{ type: "text", text: command, style: { code: true } }] : []),
  ];
  return elements.length ? richText(elements) : undefined;
};

/** `output`: the clipped result or error line, then the log line it points at. */
const outputOf = (step: StatusStep): object | undefined => {
  const result = step.output ? outputLine(step.output) : "";
  const ref = step.logLine ? `log line ${step.logLine}` : "";
  const text = [result, ref].filter(Boolean).join("\n");
  return text ? richText([{ type: "text", text }]) : undefined;
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
  const seen = new Set<string>(["status_header"]);
  return steps.map((s, i) => {
    const base = s.id.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 60) || `step_${i}`;
    let id = base;
    for (let n = 2; seen.has(id); n++) id = `${base}_${n}`;
    seen.add(id);
    return id;
  });
};

export type StatusView = { readonly text: string; readonly blocks: Block[] };

/**
 * The header card first, then one top-level `task_card` per step. No `context` line and no `plan`
 * block: Slack folds a plan, which hid the tool names, and refuses more than one per message.
 */
const card = (taskId: string, title: string, status: StepState, step?: StatusStep): Block => {
  const body = step ? detailsOf(step) : undefined;
  const output = step ? outputOf(step) : undefined;
  const sources = step ? sourcesOf(step) : [];
  return {
    type: "task_card",
    task_id: taskId,
    title,
    status,
    ...(body ? { details: body } : {}),
    ...(output ? { output } : {}),
    ...(sources.length ? { sources } : {}),
  };
};

const cards = (header: Block, steps: readonly StatusStep[], count?: string): Block[] => {
  const ids = taskIds(steps);
  return [header, ...steps.map((s, i) => card(ids[i] as string, taskTitle(s), s.state, s)), ...(count ? [countLine(count)] : [])];
};

/** The first card: the label alone. Title only, so Slack draws nothing to expand. */
const headerCard = (label: string | undefined, status: StepState): Block =>
  card("status_header", clip(label?.trim() || STATUS_LABEL, STATUS_TITLE_CHARS), status);

/** The count line after the last card. */
const countLine = (text: string): Block => ({ type: "context", elements: [{ type: "plain_text", text: clip(text, STATUS_TITLE_CHARS) }] });

const stepsLabel = (n: number): string => `${n} step${n === 1 ? "" : "s"}`;

/**
 * The running message: every step in progress (up to a cap) and the latest
 * finished ones, oldest first, with the hidden count in the header line.
 * `thinking` is the placeholder a silent turn shows (one running task), gone with the first step.
 */
export const renderStatus = (steps: readonly StatusStep[], thinking?: string, label?: string): StatusView => {
  if (steps.length === 0) {
    const head = label?.trim() || STATUS_LABEL;
    const wait = thinking?.trim() || head;
    // The placeholder is a task of its own only when it says more than the header does.
    const tasks: StatusStep[] = wait === head ? [] : [{ id: "thinking", title: clip(wait, STATUS_TITLE_CHARS), state: "in_progress" }];
    return { text: `🔧 ${head}`, blocks: cards(headerCard(head, "in_progress"), tasks) };
  }
  const running = steps.filter((s) => s.state === "in_progress");
  const finished = steps.filter((s) => s.state !== "in_progress");
  const keepFinished = new Set(finished.slice(-STATUS_FINISHED_SHOWN));
  const keepRunning = new Set(running.slice(-STATUS_RUNNING_SHOWN));
  const shown = steps.filter((s) => keepFinished.has(s) || keepRunning.has(s)).slice(-STATUS_TASKS_MAX);
  const head = label?.trim() || STATUS_LABEL;
  const count = stepsLabel(steps.length);
  const line = shown.length < steps.length ? `${count}, showing ${shown.length}` : count;
  return { text: `🔧 ${head} ${count}`, blocks: cards(headerCard(head, "in_progress"), shown, line) };
};

/**
 * The message left behind when the turn ended, or undefined when it should be
 * deleted. A turn whose steps all worked leaves nothing: the answer is what
 * matters. One where a step failed keeps a header card, the failures as error cards and "🔧 N steps, M failed" as the count line,
 * because those are the part somebody may have to act on.
 */
export const finalStatus = (steps: readonly StatusStep[], label?: string): StatusView | undefined => {
  const finished: FinishedStep[] = steps.map((s) => ({ title: s.title, failed: s.state === "error" }));
  if (!finished.some((s) => s.failed)) return undefined;
  // A lone failed step is kept too, unlike the answer's old one-card rule.
  const collapsed = collapseSteps(finished, 1);
  if (!collapsed) return undefined;
  const failed = steps.filter((s) => s.state === "error" && s.title.trim());
  const kept = failed.slice(0, STATUS_TASKS_MAX);
  const more = failed.length - kept.length;
  const title = more > 0 ? `${collapsed.summary} (…and ${more} more failed)` : collapsed.summary;
  return { text: collapsed.summary, blocks: cards(headerCard(label, "error"), kept, title) };
};
