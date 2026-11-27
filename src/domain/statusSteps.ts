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
 * Nothing credential-shaped, no machine path, no `NAME_TOKEN=value` assignment reaches Slack: the same
 * scrub the tool log and the step titles use (`redactSecrets`, `redactPaths`), plus what a command line
 * and a tool result carry that no token shape matches: `secret-ish-key=value` / `"key": "value"` / `--password x`
 * in any case, `user:pass@` in a URL, `Authorization:` values, JWTs, fine-grained PATs and `sk_live_`-style keys,
 * PEM private keys and chat webhook URLs. It is a net, not a proof: a bare secret value printed alone cannot be
 * recognised, which is why `outputHidden` drops the result of a step that fetches one.
 */
const SECRET_KEY =
  /(["']?)([\w.-]*(?:token|secret|passw(?:or)?d|pwd|api[_-]?key|apikey|credential|ticket|private[_-]?key|access[_-]?key|session[_-]?id|cookie)[\w.-]*)\1(\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,&;}]+)/gi;
const SECRET_FLAG = /(\s--?(?:password|passwd|pwd|token|secret|api-?key|auth|user|u|p)(?:=|\s+))("[^"]*"|'[^']*'|\S+)/gi;
const SECRET_FORMS: readonly [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, "[redacted]"],
  [/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+(?::[^\s/@]*)?@/gi, "$1[redacted]@"],
  [/(\bAuthorization\s*:\s*)(?:(?:Basic|Bearer|Token)\s+)?\S+/gi, "$1[redacted]"],
  [/\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]*/g, "[redacted]"],
  [/\bgithub_pat_\w{20,}/g, "[redacted]"],
  [/\b(?:sk|rk|pk)_(?:live|test)_\w{8,}/g, "[redacted]"],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, "[redacted]"],
  [/https:\/\/(?:hooks\.slack\.com\/(?:services|workflows|triggers)|(?:discord(?:app)?\.com)\/api\/webhooks)\/\S+/gi, "[redacted webhook]"],
];
export const scrubStatusText = (text: string): string => {
  const forms = SECRET_FORMS.reduce((out, [re, to]) => out.replace(re, to), text);
  const keyed = forms.replace(SECRET_KEY, "$1$2$1$3[redacted]").replace(SECRET_FLAG, "$1[redacted]");
  return redactPaths(redactSecrets(keyed));
};

/** A command (or a read path) that fetches or prints a credential: its result is never shown. */
const SECRET_FETCH =
  /(?:^|[;&|(]\s*)(?:op\s+(?:read|item|inject|document)|security\s+(?:find|dump)[\w-]*|printenv|env|set|export\s+-p|vault\s+(?:read|kv)|aws\s+(?:secretsmanager|ssm\s+get-parameter)|gcloud\s+secrets|kubectl\s+get\s+secret|pass\s+show|gpg\s+(?:-d|--decrypt)|age\s+-d)(?:\s|$)|\.env\b|\.pem\b|\.p12\b|\.netrc|id_(?:rsa|ed25519|ecdsa)|credentials|secrets?\b|keychain|\.aws\/|\.ssh\/|\/proc\/\S*environ/i;
const outputHidden = (step: StatusStep): boolean => !!step.command && SECRET_FETCH.test(step.command);

/** A short clipped line of a tool result: the first lines that say something, scrubbed. */
const outputLine = (output: string): string => {
  const lines = scrubStatusText(output)
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  return clip(lines.slice(0, 2).join(" ⏎ "), STATUS_OUTPUT_CHARS);
};

const URL_RE = /https?:\/\/[^\s<>"'`)\]]+/g;
/** Longest source url: Slack's own limit is far above it, and 3 per card across 20 cards must stay small. */
const SOURCE_URL_CHARS = 300;

/** A link safe to show: no userinfo, no query, no fragment, no webhook; undefined when it is none of that. */
const safeUrl = (raw: string): string | undefined => {
  try {
    const u = new URL(raw.replace(/[.,;:]+$/, ""));
    if (u.protocol !== "http:" && u.protocol !== "https:") return undefined;
    if (u.username || u.password) return undefined;
    const clean = scrubStatusText(`${u.origin}${u.pathname}`);
    if (clean.includes("[redacted") || clean.length > SOURCE_URL_CHARS) return undefined;
    return clean;
  } catch {
    return undefined;
  }
};

const sourcesOf = (step: StatusStep): { type: "url"; url: string; text: string }[] => {
  const given = (step.sources ?? []).map((s) => ({ url: s.url, text: s.text }));
  const found = [step.command, step.detail].flatMap((t) => (t ? (scrubStatusText(t).match(URL_RE) ?? []) : [])).map((url) => ({ url, text: undefined }));
  const seen = new Set<string>();
  const out: { type: "url"; url: string; text: string }[] = [];
  for (const s of [...given, ...found]) {
    const url = safeUrl(s.url);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push({ type: "url", url, text: clip(s.text ? scrubStatusText(s.text) : url, 100) });
    if (out.length === STATUS_SOURCES_MAX) break;
  }
  return out;
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
  const result = step.output && !outputHidden(step) ? outputLine(step.output) : "";
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
 * The header card first, then one top-level `task_card` per step, then the count as a `context` line. No `plan`
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
