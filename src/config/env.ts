/**
 * Environment configuration - parsed and validated once at boot.
 *
 * Fails fast with a readable message if something required is missing, so the bot
 * never limps along half-configured.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { expandHome } from "../domain/dbPath.ts";
import { parseAllowedOwners } from "../domain/githubApp.ts";
import { DEFAULT_REQUIRED_CHECKS, parseGateList } from "../domain/mergeGate.ts";
import {
  DEFAULT_MAX_NUDGES,
  DEFAULT_MIN_AGE_MS,
  DEFAULT_SWEEP_INTERVAL_MS,
  DEFAULT_WINDOW_MS,
} from "../domain/stalePromise.ts";
import {
  coordinatorName,
  COORDINATOR_LANGS,
  DEFAULT_COORDINATOR_NAME,
  DEFAULT_LANG,
  type CoordinatorLang,
  DEFAULT_INTERVAL_MS,
  DEFAULT_OFFSET_MIN,
  DEFAULT_PROD_REPING_MS,
  DEFAULT_QUIET_END_HOUR,
  DEFAULT_QUIET_START_HOUR,
  DEFAULT_STALE_JOURNEY_MS,
} from "../domain/coordinator.ts";
import { DEFAULT_REAP_IDLE_MS, DEFAULT_REAP_INTERVAL_MS } from "../domain/idleWorkers.ts";
import { DEFAULT_REVIEW_IDLE_DAYS, DEFAULT_REVIEW_ROUNDS } from "../domain/reviewRounds.ts";
import { parseSelfPrAccounts, RESTART_TURN_BUDGET_MS, type SelfPrAccounts } from "../domain/selfUpdate.ts";
import { parseDenyList } from "../domain/workerMcp.ts";

/** Where the GitHub App's credentials live by default: outside the repo, never in `.env`. */
export const GITHUB_APP_DIR = join(homedir(), ".config", "jarvis", "github-app");

/** Where a worker ticket's token file is written (mode 0600 in a 0700 dir), next to the app's credentials. */
export const WORKER_TICKET_DIR = join(homedir(), ".config", "jarvis", "worker-tickets");

/** `a, b,,c` -> `["a", "b", "c"]`; unset is empty. */
const parseList = (raw: string | undefined): string[] =>
  (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

const boolFromString = (def: boolean) =>
  z
    .enum(["true", "false"])
    .optional()
    .transform((v) => (v === undefined ? def : v === "true"));

const schema = z
  .object({
    SLACK_BOT_TOKEN: z.string().min(1, "SLACK_BOT_TOKEN is required"),
    SLACK_APP_TOKEN: z.string().min(1, "SLACK_APP_TOKEN is required"),
    // Stream replies live via chat.startStream; tool calls are listed in a separate status message (deleted when the turn ends, kept collapsed if a step failed).
    SLACK_STREAM_UPDATES: boolFromString(true),
    // Where Slack traffic comes from. `socket` opens Socket Mode in this
    // process; `inbox` reads what the separate gateway (src/gateway.ts) wrote,
    // so a restart of the bot never drops the connection.
    SLACK_TRANSPORT: z.enum(["socket", "inbox"]).default("socket"),
    // The gateway's queue. Its own file: two processes write it. Keep it OUTSIDE
    // the git checkout like the databases (`~/` works), e.g. ~/.jarvis/data/inbox.db.
    INBOX_DATABASE_PATH: z.string().default("data/inbox.db"),

    // Bot identity defaults. These only bootstrap a fresh database; once set, the
    // dashboard-managed DB settings take precedence, so the code stays generic.
    BOT_NAME: z.string().default("Assistant"),
    BOT_THINKING_LABEL: z.string().default("working on it..."),

    // Command interfaces. COMMAND_PREFIX is the message trigger (e.g. "//bot" or
    // "X/jarvis"); SLASH_COMMAND is the Slack slash command registered in the app.
    COMMAND_PREFIX: z.string().default("//bot"),
    SLASH_COMMAND: z.string().default("/bot"),

    // Which brain powers the bot: the local Claude Code CLI (default) or the API.
    LLM_PROVIDER: z.enum(["claude-cli", "anthropic"]).default("claude-cli"),

    // claude-cli provider
    CLAUDE_BIN: z.string().default("claude"),
    CLAUDE_MODEL: z.string().default("opus"),
    // Ordinary chat for the lowest role does not need the expensive model.
    CLAUDE_MODEL_PAL: z.string().default("haiku"),
    CLAUDE_SKIP_PERMISSIONS: boolFromString(true),
    // Allow-list of every role but the owner (comma list). Empty: the built-in read-only default.
    SANDBOX_TOOLS: z.string().optional(),
    CLAUDE_CWD: z.string().optional(),
    CLAUDE_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
    // Orca worktree (selector) the bot opens its own terminal in, the sender its
    // turns orchestrate from. Orca must know the folder (`orca repo list`).
    // Blank is `path:~/Workspaces`, `off` turns it off.
    ORCA_TERMINAL_WORKTREE: z.string().optional(),

    // anthropic provider
    ANTHROPIC_API_KEY: z.string().optional(),
    ANTHROPIC_MODEL: z.string().default("claude-opus-4-8"),

    OWNER_SLACK_ID: z.string().min(1, "OWNER_SLACK_ID is required"),
    DASHBOARD_PORT: z.coerce.number().int().positive().default(2001),
    // Extra browser origins allowed to POST to the dashboard (comma separated),
    // for when you reach it through a proxy/tunnel/port-forward. Loopback origins
    // are always allowed.
    DASHBOARD_ALLOWED_ORIGINS: z.string().optional(),
    // The live database. Keep it OUTSIDE the git checkout (`~/` works).
    DATABASE_PATH: z.string().default("data/bot.db"),
    // One-time move: when DATABASE_PATH does not exist yet and this file does,
    // the first boot fills it with a consistent snapshot of this one. The old
    // file is only read, never changed or deleted. Unset: no migration.
    DATABASE_MIGRATE_FROM: z.string().optional(),
    // Where the memory adapter is mirrored on disk. The adapter itself lives in
    // the database (`adapter_files`); this directory is re-rendered from it on
    // every write so skills and their scripts can be read by path. Never edit
    // it - use `adapter export` / `adapter import`.
    ADAPTER_PATH: z.string().default("data/adapter-mirror"),
    // Bytes of the adapter that may load into EVERY prompt. A refine pass must
    // come in under it; teaching may exceed it and says so.
    ADAPTER_BUDGET: z.coerce.number().int().positive().default(8000),
    // Commands one chat turn may trigger through the run helper. A runaway
    // guard, not a rate limit: it has to be high enough that ordinary bulk
    // work (deleting a thread's messages, reacting to a batch) finishes, or it
    // becomes pressure to work around the audited path.
    COMMAND_TICKET_USES: z.coerce.number().int().positive().default(50),
    // Per-user Claude Code tokens live in their OWN database, never the one that
    // gets committed, and are encrypted under a key kept beside it. Both paths
    // are gitignored; set them elsewhere if the data directory is shared.
    TOKEN_DATABASE_PATH: z.string().default("data/tokens.db"),
    // Same one-time move as DATABASE_MIGRATE_FROM, for the token database.
    TOKEN_DATABASE_MIGRATE_FROM: z.string().optional(),
    TOKEN_KEY_PATH: z.string().default("data/tokens.key"),
    // Where that key lives. `file` (default) is TOKEN_KEY_PATH. `keychain` keeps
    // it in one macOS Keychain item instead (service below, account = the login
    // user): a key file left at TOKEN_KEY_PATH is moved in on first boot and then
    // deleted. Keychain locked or unreachable: boot continues with per-user
    // tokens and 2FA seeds switched off. Item missing, no file, and the token
    // database already has rows: boot fails rather than mint a key over them.
    TOKEN_KEY_SOURCE: z.enum(["file", "keychain"]).default("file"),
    TOKEN_KEY_KEYCHAIN_SERVICE: z.string().trim().min(1).default("jarvis-token-key"),
    // Folder for the activity/error logs (one JSON line per event).
    LOG_DIR: z.string().default("logs"),
    // Channel that gets the one restart notice listing the waiting threads.
    // Unset: nobody is told. Also the inner child's voice-drift log channel
    // unless the `inner_child_drift_channel` setting names another.
    DRAIN_NOTICE_CHANNEL: z.string().optional(),
    // While a restart waits, new messages still run, but each turn on this
    // budget (ms). Past it the thread is told to hold on and the turn is cut,
    // then picked up again by the next process on the same session.
    RESTART_TURN_BUDGET_MS: z.coerce.number().int().positive().default(RESTART_TURN_BUDGET_MS),
    // Not config of the bot: JARVIS_TEST_LOCK, JARVIS_TEST_LOCK_TIMEOUT_MS,
    // JARVIS_TEST_NICE and JARVIS_TEST_LOCK_DIR are read by the `bun test`
    // preload (tests/support/hostLock.ts) so full test runs queue per host.

    // Idle-worker reaper: how often (ms) the bot looks for Orca worker sessions
    // whose task is over and that sit idle at their prompt, and closes them
    // through Orca. 0 turns the reaper off. Default 30 min.
    ORCA_REAP_INTERVAL_MS: z.coerce.number().int().min(0).default(DEFAULT_REAP_INTERVAL_MS),
    // How long (ms) a worker's terminal must be silent before it can be closed.
    // Default 3 h; never below a minute.
    ORCA_REAP_IDLE_MS: z.coerce.number().int().min(60_000).default(DEFAULT_REAP_IDLE_MS),
    // `true`: only log what the reaper would close, close nothing.
    ORCA_REAP_DRY_RUN: boolFromString(false),
    // Stale-promise sweep: how often (ms) the bot looks for threads whose last
    // message is its own promise of further work with nothing pending, and
    // steers that session once. 0 turns it off. Default 15 min.
    STALE_PROMISE_INTERVAL_MS: z.coerce.number().int().min(0).default(DEFAULT_SWEEP_INTERVAL_MS),
    // How old (ms) the promise must be before it counts as stale. Default 30 min.
    STALE_PROMISE_MIN_AGE_MS: z.coerce.number().int().min(60_000).default(DEFAULT_MIN_AGE_MS),
    // Threads the bot was active in within this long (ms) are looked at. Default 24 h.
    STALE_PROMISE_WINDOW_MS: z.coerce.number().int().min(60_000).default(DEFAULT_WINDOW_MS),
    // Most threads nudged in one sweep. Default 3.
    STALE_PROMISE_MAX_NUDGES: z.coerce.number().int().min(1).default(DEFAULT_MAX_NUDGES),
    // The housekeeping coordinator that lives only in the owner's DM. COORDINATOR_NAME is what it
    // signs its messages with and answers to (a personal setting, so the repo carries a neutral
    // default); then how
    // often (ms) its tick rebuilds the picture (journeys, worker tickets, watches,
    // Orca, own PRs, unanswered threads) and acts. 0 turns it off. Default 30 min.
    COORDINATOR_NAME: z.string().default(DEFAULT_COORDINATOR_NAME),
    COORDINATOR_INTERVAL_MS: z.coerce.number().int().min(0).default(DEFAULT_INTERVAL_MS),
    // An open journey untouched this long (ms) is stale and handed to the coordinator's turn. Default 3 days.
    COORDINATOR_STALE_JOURNEY_MS: z.coerce.number().int().min(60_000).default(DEFAULT_STALE_JOURNEY_MS),
    // A prod blocker nobody decided is put to the owner again after this long (ms). Default 30 min.
    COORDINATOR_PROD_REPING_MS: z.coerce.number().int().min(60_000).default(DEFAULT_PROD_REPING_MS),
    // Quiet hours (no pings, prod blockers excepted) as local hours, in the zone COORDINATOR_TZ_OFFSET_MIN
    // names (minutes east of UTC; Asia/Ho_Chi_Minh is 420). Equal hours: never quiet. Default 22 -> 5.
    COORDINATOR_QUIET_START_HOUR: z.coerce.number().int().min(0).max(23).default(DEFAULT_QUIET_START_HOUR),
    COORDINATOR_QUIET_END_HOUR: z.coerce.number().int().min(0).max(23).default(DEFAULT_QUIET_END_HOUR),
    // The language of everything the coordinator writes to the owner: the digest, a blocker, and the
    // lines its turn files (`vi` or `en`). The owner talks to the bot in Vietnamese, so `vi` by default.
    COORDINATOR_LANG: z.enum(COORDINATOR_LANGS).default(DEFAULT_LANG),
    COORDINATOR_TZ_OFFSET_MIN: z.coerce.number().int().min(-720).max(840).default(DEFAULT_OFFSET_MIN),
    // Channel the offline alarm reports to: a notice armed on Slack's side
    // that posts by itself if the host loses its connection, and is edited to
    // "back online" when it returns. Unset: no alarm. An id, not a name: the
    // scheduled list and history only take ids, so with a name the old notices
    // could never be found and cancelled.
    OFFLINE_ALARM_CHANNEL: z
      .string()
      .trim()
      .regex(/^[CG][A-Z0-9]+$/, "OFFLINE_ALARM_CHANNEL must be a channel id like C0123ABC, not a name")
      .optional()
      .or(z.string().trim().length(0).transform(() => undefined)),

    // Channel that gets the owner's copy of other people's slash commands (a
    // header per run, the output in its thread). Unset: the owner's DM.
    SLASH_MIRROR_CHANNEL: z
      .string()
      .trim()
      .regex(/^[CG][A-Z0-9]+$/, "SLASH_MIRROR_CHANNEL must be a channel id like C0123ABC, not a name")
      .optional()
      .or(z.string().trim().length(0).transform(() => undefined)),

    // GitHub App: people call the bot from an issue/PR (mention or label) and
    // the answer is posted back there as the app. Started only when the app id,
    // the private key and the webhook secret can all be found.
    // App id. Unset: read from `app.json` beside the private key.
    GITHUB_APP_ID: z.string().optional(),
    // PEM private key of the app (RS256 JWT -> installation token).
    GITHUB_APP_PRIVATE_KEY_PATH: z.string().default(join(GITHUB_APP_DIR, "private-key.pem")),
    // Webhook secret. Prefer the file; the variable wins when both are set.
    GITHUB_APP_WEBHOOK_SECRET: z.string().optional(),
    GITHUB_APP_WEBHOOK_SECRET_PATH: z.string().default(join(GITHUB_APP_DIR, "webhook-secret")),
    // Loopback port of the webhook listener (Tailscale Funnel proxies to it).
    GITHUB_APP_PORT: z.coerce.number().int().positive().default(2003),
    // App slug: `@<slug>` in a comment calls it, `<slug>[bot]` is itself.
    GITHUB_APP_SLUG: z.string().default("jarvis"),
    // The app is public, so it only acts for repositories owned by these
    // accounts (comma separated). Everything else is logged and ignored, so
    // the empty default acts for no owner until this is set.
    GITHUB_APP_ALLOWED_OWNERS: z.string().default(""),
    // Label that calls the app when added to an issue or PR.
    GITHUB_APP_LABEL: z.string().default("jarvis"),
    // The bot's own merge gate (`merge-gate` action): when on, the bot merges a
    // PR itself, with the app's credential, once checks, review and verify hold
    // on the named sha, and `bin/merge-when-green.sh` holds only a ticket. Off
    // (the default) keeps the script on the human token until the host is ready.
    MERGE_GATE: z.enum(["on", "off"]).default("off"),
    // Checks that must be green on the head sha (comma list).
    MERGE_GATE_REQUIRED_CHECKS: z.string().default(DEFAULT_REQUIRED_CHECKS.join(",")),
    // Accounts whose `[review round N]` / `[verify]` words count (comma list).
    // Empty: nobody's do, so no runtime PR merges (the repo is public: "anyone
    // but the author" would let any GitHub user vouch).
    MERGE_GATE_ATTESTERS: z.string().default(""),

    // Slack bot ids (comma separated) whose messages are answered as the person
    // they post for. Such a bot posts with a person's user token, so its messages
    // carry a `bot_id` AND that person's `user`; the message is then treated as
    // that user speaking, authorized by the user id like any other, so the bot
    // gets exactly that person's role. A bot message with no user is still
    // dropped. Empty (the default): every bot message is ignored, as before.
    ACCEPTED_BOT_IDS: z.string().default(""),

    // GitHub accounts for the bot's own PRs (gh CLI logins on this host): the
    // author opens the PR and answers reviews, the reviewer posts the review
    // comments, approves and merges. Both or neither; unset keeps whatever gh is active.
    SELF_PR_AUTHOR: z.string().optional(),
    SELF_PR_REVIEWER: z.string().optional(),

    // Review rounds: a PR that had a quick review is followed, and a new head
    // commit pushed to it gets the next round by itself (same thread, same
    // asker's token). REVIEW_ROUNDS_MAX is the rounds in all, the review that
    // was asked for included (0 turns following off); REVIEW_ROUNDS_IDLE_DAYS the
    // days without a push after which a PR is no longer followed.
    REVIEW_ROUNDS_MAX: z.coerce.number().int().min(0).max(50).default(DEFAULT_REVIEW_ROUNDS),
    REVIEW_ROUNDS_IDLE_DAYS: z.coerce.number().int().min(1).max(365).default(DEFAULT_REVIEW_IDLE_DAYS),

    // Local database MCP servers on this host (comma separated names as in
    // `claude mcp list`, e.g. `pg-prod,clickhouse-ro`). Each is denied BY NAME to
    // every role that may not query databases - a denial has to name the
    // server, so a server missing here is reachable by every role. Empty
    // denies nothing: list every database server you configure.
    DB_MCP_SERVERS: z.string().optional(),
    // The subset of DB_MCP_SERVERS the executer role may query. Only list
    // servers whose credential is read only on the server side. Empty: none.
    EXECUTER_DB_MCP_SERVERS: z.string().optional(),
    // User-scope MCP servers (names as in `claude mcp list`) kept out of the Orca
    // workers the bot starts. Every claude session loads every server in
    // ~/.claude.json and a stdio one is a process per session, so a batch of
    // workers multiplied them (17 sessions held ~1.3GB). The prompts run
    // bin/worker-mcp-trim.ts before each worker starts, which writes these into
    // the worker folder's .claude/settings.local.json (deniedMcpServers). Empty
    // keeps every server, as before. The bot's own turns are not affected.
    WORKER_MCP_DENY: z.string().optional(),
    // Servers kept out of one role's workers on top of WORKER_MCP_DENY, as
    // `reviewer=pg-prod,ch-ro;investigator=pg-prod` (roles: writer, reviewer,
    // verifier, investigator). Each role starts in its own folder
    // ($BOT_WORKER_HOME-<role>) whose settings also carry the role's tool rules
    // (a reviewer or investigator cannot edit, push or merge, a writer cannot merge
    // by hand), written by the same bin/worker-mcp-trim.ts --role <role>.
    WORKER_ROLE_MCP_DENY: z.string().optional(),
    // The shared worker home. Each role's Orca workers start in <it>-<role>
    // (`--worktree path:<it>-<role>`), a folder next to it, so the exclusion above and
    // the role's tool rules are written into folders only workers use and never into
    // one a person works in (~/Workspaces). bin/worker-mcp-trim.ts --role <role>
    // creates it, registers it with Orca as a plain folder and writes it; with no
    // --role it does the same for <it> itself. Blank = ~/.jarvis/worker-home.
    WORKER_HOME_DIR: z.string().optional(),
    // Voice messages (an audio clip with no text) are transcribed locally before
    // their turn: ffmpeg converts to 16 kHz mono wav, whisper.cpp's whisper-cli
    // transcribes it with the language auto-detected. Blank = the defaults below
    // (Homebrew paths, model in ~/.local/share/whisper-models). A missing binary
    // or model, a failure or a timeout never drops the clip: the turn starts with
    // a note that the audio could not be transcribed.
    WHISPER_BIN: z.string().optional(),
    WHISPER_MODEL_PATH: z.string().optional(),
    FFMPEG_BIN: z.string().optional(),
    WHISPER_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
    // Secret-shaped variable names (`*_TOKEN`, `*_SECRET`, `*_API_KEY`...) an agent turn may still
    // inherit. Every other credential-shaped variable is withheld from the spawned CLI, so a
    // prompt-injected turn has nothing to read out of its environment; Slack goes through a
    // ticketed local proxy instead. Empty (the default) passes none.
    TURN_ENV_PASSTHROUGH: z.string().optional(),
  })
  .refine((env) => env.LLM_PROVIDER !== "anthropic" || !!env.ANTHROPIC_API_KEY, {
    message: "ANTHROPIC_API_KEY is required when LLM_PROVIDER=anthropic",
    path: ["ANTHROPIC_API_KEY"],
  });

export type LlmProvider = "claude-cli" | "anthropic";

export type AppConfig = {
  slackBotToken: string;
  slackAppToken: string;
  slackStreamUpdates: boolean;
  slackTransport: "socket" | "inbox";
  inboxDatabasePath: string;
  botName: string;
  botThinkingLabel: string;
  commandPrefix: string;
  slashCommand: string;
  llmProvider: LlmProvider;
  claudeBin: string;
  claudeModel: string;
  claudeModelPal: string;
  claudeSkipPermissions: boolean;
  /** `SANDBOX_TOOLS`: replaces the default read-only allow-list of non-owner roles. */
  sandboxTools: string[];
  claudeCwd?: string;
  claudeTimeoutMs: number;
  /** Where the bot's own Orca terminal is created; undefined is off. */
  orcaTerminalWorktree?: string;
  anthropicApiKey?: string;
  anthropicModel: string;
  ownerSlackId: string;
  dashboardPort: number;
  dashboardAllowedOrigins: string[];
  databasePath: string;
  /** Old location of the database, copied from once when `databasePath` is missing. */
  databaseMigrateFrom?: string;
  /** Mirror directory of the memory adapter, rendered from the database. */
  adapterPath: string;
  /** Bytes of the adapter allowed to load into every prompt. */
  adapterBudget: number;
  /** Commands one turn may trigger through the run helper. */
  commandTicketUses: number;
  tokenDatabasePath: string;
  /** Old location of the token database, copied from once when `tokenDatabasePath` is missing. */
  tokenDatabaseMigrateFrom?: string;
  tokenKeyPath: string;
  tokenKeySource: "file" | "keychain";
  tokenKeyKeychainService: string;
  logDir: string;
  /** Channel for the restart notice listing waiting threads; unset is silent. */
  drainNoticeChannel?: string;
  /** How long a turn started while a restart waits may run before it is cut. */
  restartTurnBudgetMs: number;
  /** Idle-worker reaper: sweep interval (0 = off), idle threshold, log-only mode. */
  orcaReap: { intervalMs: number; idleMs: number; dryRun: boolean };
  /** Stale-promise sweep: interval (0 = off), minimum age of the promise, look-back window, nudges per sweep. */
  stalePromise: { intervalMs: number; minAgeMs: number; windowMs: number; maxNudges: number };
  /** The coordinator (domain/coordinator.ts): its display name (what it signs with), tick interval (0 = off), stale journey age, prod blocker re-ask, quiet hours (local hours) and the zone's offset in minutes east of UTC. */
  coordinator: { name: string; intervalMs: number; staleJourneyMs: number; prodRepingMs: number; quietStartHour: number; quietEndHour: number; tzOffsetMin: number; lang: CoordinatorLang };
  /** Channel the offline alarm posts to when the host drops off; unset is off. */
  offlineAlarmChannel?: string;
  /** Channel for the owner's copy of other people's slash commands; unset is the owner's DM. */
  slashMirrorChannel?: string;
  githubApp: {
    appId?: string;
    privateKeyPath: string;
    webhookSecret?: string;
    webhookSecretPath: string;
    port: number;
    slug: string;
    allowedOwners: string[];
    label: string;
    mergeGate: { enabled: boolean; requiredChecks: string[]; attesters: string[] };
  };
  /** Who opens the bot's own PRs and who reviews and merges them; unset is one account. */
  selfPrAccounts?: SelfPrAccounts;
  /** Slack bot ids whose messages are answered as the person they post for; empty ignores every bot. */
  acceptedBotIds: string[];
  /** Review rounds a PR is followed for, the first included; 0 is off. */
  reviewRoundsMax: number;
  /** Days without a push after which a reviewed PR is no longer followed. */
  reviewRoundsIdleDays: number;
  /** Local database MCP servers denied by name to roles that may not use databases; empty denies none. */
  dbMcpServers: string[];
  /** Secret-shaped variable names a turn may still inherit; empty is none. */
  turnEnvPassthrough: string[];
  /** The subset of `dbMcpServers` the executer role may query; empty is none. */
  executerDbMcpServers: string[];
  /** User-scope MCP servers kept out of Orca workers; empty keeps every server. */
  workerMcpDeny: string[];
  /** Raw `WORKER_ROLE_MCP_DENY`: per-role server exclusions, read by the trim helper. */
  workerRoleMcpDeny: string;
  /** Absolute shared worker home; each role's workers start in `<it>-<role>` (`roleHomeDir`). */
  workerHomeDir: string;
  /** whisper.cpp CLI, the ggml model and ffmpeg for voice messages, and the limit on each step. */
  whisperBin: string;
  whisperModelPath: string;
  ffmpegBin: string;
  whisperTimeoutMs: number;
};

/** A short human label for the active model, shown on the dashboard. */
export const modelLabel = (config: AppConfig): string =>
  config.llmProvider === "claude-cli"
    ? `claude-cli (${config.claudeModel})`
    : config.anthropicModel;

/** Parse `source` (defaults to `process.env`) into a validated config. */
export const loadConfig = (source: Record<string, string | undefined> = process.env): AppConfig => {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`);
    throw new Error(`Invalid configuration:\n${issues.join("\n")}`);
  }
  const env = parsed.data;
  return {
    slackBotToken: env.SLACK_BOT_TOKEN,
    slackAppToken: env.SLACK_APP_TOKEN,
    slackStreamUpdates: env.SLACK_STREAM_UPDATES,
    slackTransport: env.SLACK_TRANSPORT,
    inboxDatabasePath: env.INBOX_DATABASE_PATH,
    botName: env.BOT_NAME,
    botThinkingLabel: env.BOT_THINKING_LABEL,
    commandPrefix: env.COMMAND_PREFIX,
    slashCommand: env.SLASH_COMMAND,
    llmProvider: env.LLM_PROVIDER,
    claudeBin: env.CLAUDE_BIN,
    claudeModel: env.CLAUDE_MODEL,
    claudeModelPal: env.CLAUDE_MODEL_PAL,
    claudeSkipPermissions: env.CLAUDE_SKIP_PERMISSIONS,
    sandboxTools: parseList(env.SANDBOX_TOOLS),
    claudeCwd: env.CLAUDE_CWD,
    claudeTimeoutMs: env.CLAUDE_TIMEOUT_MS,
    ...(env.ORCA_TERMINAL_WORKTREE?.trim() === "off"
      ? {}
      : { orcaTerminalWorktree: env.ORCA_TERMINAL_WORKTREE?.trim() || `path:${join(homedir(), "Workspaces")}` }),
    anthropicApiKey: env.ANTHROPIC_API_KEY,
    anthropicModel: env.ANTHROPIC_MODEL,
    ownerSlackId: env.OWNER_SLACK_ID,
    dashboardPort: env.DASHBOARD_PORT,
    dashboardAllowedOrigins: (env.DASHBOARD_ALLOWED_ORIGINS ?? "")
      .split(",")
      .map((o) => o.trim())
      .filter(Boolean),
    databasePath: expandHome(env.DATABASE_PATH.trim()),
    ...(env.DATABASE_MIGRATE_FROM?.trim() ? { databaseMigrateFrom: expandHome(env.DATABASE_MIGRATE_FROM.trim()) } : {}),
    adapterPath: env.ADAPTER_PATH,
    adapterBudget: env.ADAPTER_BUDGET,
    commandTicketUses: env.COMMAND_TICKET_USES,
    tokenDatabasePath: expandHome(env.TOKEN_DATABASE_PATH.trim()),
    ...(env.TOKEN_DATABASE_MIGRATE_FROM?.trim()
      ? { tokenDatabaseMigrateFrom: expandHome(env.TOKEN_DATABASE_MIGRATE_FROM.trim()) }
      : {}),
    tokenKeyPath: env.TOKEN_KEY_PATH,
    tokenKeySource: env.TOKEN_KEY_SOURCE,
    tokenKeyKeychainService: env.TOKEN_KEY_KEYCHAIN_SERVICE,
    logDir: env.LOG_DIR,
    ...(env.DRAIN_NOTICE_CHANNEL ? { drainNoticeChannel: env.DRAIN_NOTICE_CHANNEL } : {}),
    restartTurnBudgetMs: env.RESTART_TURN_BUDGET_MS,
    orcaReap: { intervalMs: env.ORCA_REAP_INTERVAL_MS, idleMs: env.ORCA_REAP_IDLE_MS, dryRun: env.ORCA_REAP_DRY_RUN },
    stalePromise: {
      intervalMs: env.STALE_PROMISE_INTERVAL_MS,
      minAgeMs: env.STALE_PROMISE_MIN_AGE_MS,
      windowMs: env.STALE_PROMISE_WINDOW_MS,
      maxNudges: env.STALE_PROMISE_MAX_NUDGES,
    },
    coordinator: {
      name: coordinatorName(env.COORDINATOR_NAME),
      intervalMs: env.COORDINATOR_INTERVAL_MS,
      staleJourneyMs: env.COORDINATOR_STALE_JOURNEY_MS,
      prodRepingMs: env.COORDINATOR_PROD_REPING_MS,
      quietStartHour: env.COORDINATOR_QUIET_START_HOUR,
      quietEndHour: env.COORDINATOR_QUIET_END_HOUR,
      tzOffsetMin: env.COORDINATOR_TZ_OFFSET_MIN,
      lang: env.COORDINATOR_LANG,
    },
    ...(env.OFFLINE_ALARM_CHANNEL ? { offlineAlarmChannel: env.OFFLINE_ALARM_CHANNEL } : {}),
    ...(env.SLASH_MIRROR_CHANNEL ? { slashMirrorChannel: env.SLASH_MIRROR_CHANNEL } : {}),
    githubApp: {
      ...(env.GITHUB_APP_ID?.trim() ? { appId: env.GITHUB_APP_ID.trim() } : {}),
      privateKeyPath: env.GITHUB_APP_PRIVATE_KEY_PATH,
      ...(env.GITHUB_APP_WEBHOOK_SECRET ? { webhookSecret: env.GITHUB_APP_WEBHOOK_SECRET } : {}),
      webhookSecretPath: env.GITHUB_APP_WEBHOOK_SECRET_PATH,
      port: env.GITHUB_APP_PORT,
      slug: env.GITHUB_APP_SLUG.trim(),
      allowedOwners: parseAllowedOwners(env.GITHUB_APP_ALLOWED_OWNERS),
      label: env.GITHUB_APP_LABEL.trim(),
      mergeGate: {
        enabled: env.MERGE_GATE === "on",
        requiredChecks: parseGateList(env.MERGE_GATE_REQUIRED_CHECKS, DEFAULT_REQUIRED_CHECKS),
        attesters: parseGateList(env.MERGE_GATE_ATTESTERS),
      },
    },
    ...((accounts) => (accounts ? { selfPrAccounts: accounts } : {}))(
      parseSelfPrAccounts(env.SELF_PR_AUTHOR, env.SELF_PR_REVIEWER),
    ),
    acceptedBotIds: parseList(env.ACCEPTED_BOT_IDS),
    reviewRoundsMax: env.REVIEW_ROUNDS_MAX,
    reviewRoundsIdleDays: env.REVIEW_ROUNDS_IDLE_DAYS,
    dbMcpServers: parseList(env.DB_MCP_SERVERS),
    turnEnvPassthrough: parseList(env.TURN_ENV_PASSTHROUGH),
    executerDbMcpServers: parseList(env.EXECUTER_DB_MCP_SERVERS),
    workerMcpDeny: parseDenyList(env.WORKER_MCP_DENY),
    workerRoleMcpDeny: env.WORKER_ROLE_MCP_DENY?.trim() ?? "",
    workerHomeDir: expandHome(env.WORKER_HOME_DIR?.trim() || join(homedir(), ".jarvis", "worker-home")),
    whisperBin: expandHome(env.WHISPER_BIN?.trim() || "/opt/homebrew/bin/whisper-cli"),
    whisperModelPath: expandHome(env.WHISPER_MODEL_PATH?.trim() || join(homedir(), ".local", "share", "whisper-models", "ggml-large-v3-turbo-q5_0.bin")),
    ffmpegBin: expandHome(env.FFMPEG_BIN?.trim() || "/opt/homebrew/bin/ffmpeg"),
    whisperTimeoutMs: env.WHISPER_TIMEOUT_MS,
  };
};
