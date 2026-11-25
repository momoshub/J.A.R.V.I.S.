/**
 * Tiny JSON API client. The dashboard is a local, loopback-only tool with no auth
 * token; requests just go to the same-origin `/api`.
 */
const headers = (): HeadersInit => ({ "content-type": "application/json" });

export const get = async <T>(path: string): Promise<T> => {
  const res = await fetch(`/api/${path}`, { headers: headers() });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `GET ${path} failed`);
  return res.json() as Promise<T>;
};

export const post = async <T = { ok: true }>(path: string, body: unknown): Promise<T> => {
  const res = await fetch(`/api/${path}`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(body ?? {}),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error ?? `POST ${path} failed`);
  return json as T;
};

export type Bootstrap = {
  botName: string;
  ownerSlackId: string;
  model: string;
  commandPrefix: string;
  slashCommand: string;
};
export type Overview = {
  users: number;
  conversations: number;
  messages: number;
  learnings: number;
  /** True when memory is an adapter, so `learnings` counts memory items. */
  memory?: boolean;
};
/** One line of a spend breakdown: a person, or a command. */
export type UsageSlice = {
  key: string;
  runs: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheWrite: number;
  durationMs: number;
};
export type UsageView = {
  recording: boolean;
  windowMs?: number;
  totals: Omit<UsageSlice, "key">;
  byUser: UsageSlice[];
  byKind: UsageSlice[];
  /** Slack id -> display name, so a table is not a wall of U0ABC123. */
  names: Record<string, string>;
};
/** A role name: `owner` is fixed, every other role is data the owner edits (`pal`, `executer`, `admin` are only the seeded ones). */
export type UserRole = string;
export type AllowedUser = {
  name?: string;
  slackId: string;
  role: UserRole;
  displayName: string;
  addedBy: string;
  createdAt: number;
  /** GitHub logins linked to this person (the `github_login:` settings). */
  githubLogins: string[];
};

/** One thing a role can be granted: `command:<name>`, `github:<action>`, `mcp:<server>`, a tool tier or a guarded action. */
export type PermissionInfo = { id: string; group: string; label: string };

/** One role as the Roles page edits it: the permissions it GRANTS, its rank, and extra denied tool patterns. */
export type RoleView = {
  name: UserRole;
  /** Higher outranks lower; null for the owner. */
  rank: number | null;
  description: string;
  enabled: boolean;
  grants: string[];
  deniedTools: string[];
  /** `pal`, `executer` or `admin` when seeded as one of them; null for a custom role. */
  seed: string | null;
  /** The owner role: always on, holds everything, not editable. */
  locked: boolean;
  members: { slackId: string; name: string }[];
};
export type RolesView = {
  roles: RoleView[];
  /** Everything that can be granted, grouped. Managing roles is never in it: it is the owner's alone. */
  catalogue: PermissionInfo[];
  tools: string[];
  mcpServers: string[];
  /** The role an approved access request gets. */
  defaultRole: UserRole | null;
  editable: boolean;
  executerTools: string;
  palTools: string[];
};
export type Learning = { id: number; content: string; createdBy: string; createdAt: number };

/** The memory adapter as the dashboard renders it. Hand edits go through `adapter/file`. */
export type AdapterView = {
  configured: boolean;
  status?: string;
  policy?: string;
  notes?: string;
  skills?: { name: string; description: string }[];
  people?: string[];
  channels?: string[];
  revisions?: { id: number; createdAt: number; createdBy: string; reason: string }[];
  items?: number;
};
export type AdapterFile = { path: string; content: string };
export type Identity = {
  name: string;
  thinkingLabel: string;
  persona: string;
  usingDefault: boolean;
  defaultPersona: string;
};
/** What the bot's DB holds for a Slack channel (`/api/memory/channels`); a channel with no row has nothing stored. */
export type MemoryChannel = { channelId: string; count: number; lastAt: number };
/** The same per thread (`/api/memory/threads`), keyed by the thread root's ts. */
export type MemoryThread = { threadTs: string; count: number; lastAt: number };

/** A workspace member from the Users page search. `role` is set when they are already on the list. */
export type SlackMember = {
  id: string;
  handle: string;
  realName: string;
  displayName: string;
  title: string;
  avatar: string;
  role?: UserRole;
};

export type StatsView =
  | { recording: false; error?: string }
  | {
      recording: true;
      days: number;
      messages: { date: string; user: number; assistant: number }[];
      turns: { date: string; ok: number; failed: number }[];
      spend: { date: string; runs: number; costUsd: number }[];
      topCommands: { key: string; runs: number; failed: number }[];
      topUsers: { key: string; label: string; turns: number; commands: number }[];
      activeThreads: { day: number; week: number; window: number };
    };

export type SlackConversation = {
  id: string;
  name: string;
  kind: "channel" | "group" | "im" | "mpim";
  lastActive: number;
};
export type SlackMessage = {
  ts: string;
  userId: string;
  userName: string;
  text: string;
  replyCount: number;
  threadTs?: string;
  own: boolean;
  /** posted by a bot or app (Jarvis included: `own` tells it apart) */
  bot?: boolean;
  mentionsBot: boolean;
};
/** A page of history: oldest first, `nextCursor` fetches the next older page. */
export type HistoryPage = { messages: SlackMessage[]; nextCursor?: string };
/** A page of a thread: oldest first; `hasMore` says older replies remain. */
export type ThreadPage = { messages: SlackMessage[]; hasMore: boolean };

export type CommandInfo = {
  name: string;
  aliases: string[];
  /** Where the command's grant started (`pal`, `executer`, `admin`, `owner`); the grant decides now. */
  minRole: string;
  usage: string;
  summary: string;
};
export type CommandLogEntry = {
  id: number;
  slackUserId: string;
  /** `Name (U0…)`. */
  userLabel: string;
  /** `#channel (C0…)`, or "" when it ran outside a conversation. */
  channelLabel: string;
  command: string;
  args: string;
  channelId: string;
  ok: boolean;
  result: string;
  createdAt: number;
};

export const fmtTime = (ms: number): string =>
  ms ? new Date(ms).toISOString().replace("T", " ").slice(0, 16) : "-";

/** Slack timestamps are "seconds.micros" strings. */
export const fmtSlackTs = (ts: string): string => {
  const secs = Number(ts.split(".")[0]);
  return secs ? new Date(secs * 1000).toISOString().replace("T", " ").slice(5, 16) : "-";
};
