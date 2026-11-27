/**
 * One writer per job.
 *
 * Two sessions started a writer on the same bug within minutes, because nothing recorded who held it. A
 * claim is a row keyed by the job (`bug:<id>`, `journey:<id>`, `branch:<name>`), taken BEFORE `worker-start`,
 * bound to the dispatch id it printed, and released when that worker ends or dies. A second claimant is refused
 * with the holder's dispatch id and thread. Jueki's tick lists the live claims, reports a claim whose worker
 * is dead (and releases it) or two writers on one key.
 *
 * Pure: the key grammar, who may take, and what a tick finds. Rows: `infrastructure/db/writerClaimRepo.ts`.
 */
import { HOUR_MS } from "./workerTicket.ts";

export const CLAIM_KINDS = ["bug", "journey", "branch"] as const;
export type ClaimKind = (typeof CLAIM_KINDS)[number];

/** A claim taken and never bound to a dispatch (the writer never started) is released after this long. */
export const PENDING_CLAIM_MS = 30 * 60_000;
/** A claim no tick or hook ended is never held longer than a worker ticket can live. */
export const CLAIM_MAX_MS = 24 * HOUR_MS;

/** `bug:23`, `journey:7`, `branch:fix/x`: the one spelling of a job's key, or undefined when it is none of them. */
export const parseClaimKey = (raw: string): string | undefined => {
  const m = /^(bug|journey|branch):#?([\w./-]+)$/i.exec(raw.trim());
  const kind = m?.[1]?.toLowerCase();
  const rest = m?.[2];
  if (!kind || !rest) return undefined;
  if (kind === "branch") return rest.startsWith("-") || rest.includes("..") ? undefined : `branch:${rest}`;
  return /^\d+$/.test(rest) ? `${kind}:${Number(rest)}` : undefined;
};

export type ClaimFacts = {
  readonly id: number;
  readonly key: string;
  /** Empty until `worker-start` printed it and the claim was bound. */
  readonly dispatchId: string;
  readonly channelId: string;
  readonly threadTs: string;
  readonly actor: string;
  readonly createdAt: number;
};

export type Claimant = { readonly channelId: string; readonly threadTs: string };

const sameThread = (c: ClaimFacts, who: Claimant): boolean => c.channelId === who.channelId && c.threadTs === who.threadTs;

/** Where a claim's thread is, in words. */
export const holderLine = (c: ClaimFacts, now: number): string =>
  `${c.dispatchId ? `worker ${c.dispatchId}` : "a writer not started yet"}, thread ${c.channelId}${c.threadTs ? ` ${c.threadTs}` : ""}, claimed ${Math.max(1, Math.round((now - c.createdAt) / 60_000))}m ago`;

export type TakeVerdict =
  | { readonly ok: true; readonly refresh: boolean }
  | { readonly ok: false; readonly holder: ClaimFacts };

/**
 * May `who` take a key that `live` already holds? A free key, yes. The same thread asking again before its writer started
 * only refreshes its own pending claim (a retry). A held key is refused to everyone else, and to the same thread once its
 * writer is bound: that one is released when it ends, or by `claim release`.
 */
export const takeVerdict = (live: readonly ClaimFacts[], who: Claimant): TakeVerdict => {
  const holder = live[0];
  if (!holder) return { ok: true, refresh: false };
  if (live.length === 1 && sameThread(holder, who) && holder.dispatchId === "") return { ok: true, refresh: true };
  return { ok: false, holder };
};

export type ClaimFinding =
  /** The writer's dispatch is gone: release it. */
  | { readonly kind: "dead"; readonly claim: ClaimFacts }
  /** Taken, never bound: the writer never started. */
  | { readonly kind: "stale"; readonly claim: ClaimFacts }
  /** More than one live claim on one key: two writers on one job. */
  | { readonly kind: "duplicate"; readonly key: string; readonly claims: readonly ClaimFacts[] };

/** What a tick finds in the live claims; `dead` is the set of dispatch ids whose worker is gone. */
export const claimFindings = (live: readonly ClaimFacts[], dead: ReadonlySet<string>, now: number): ClaimFinding[] => {
  const out: ClaimFinding[] = [];
  const byKey = new Map<string, ClaimFacts[]>();
  for (const c of live) {
    byKey.set(c.key, [...(byKey.get(c.key) ?? []), c]);
    if (c.dispatchId && dead.has(c.dispatchId)) out.push({ kind: "dead", claim: c });
    else if (!c.dispatchId && now - c.createdAt >= PENDING_CLAIM_MS) out.push({ kind: "stale", claim: c });
    else if (now - c.createdAt >= CLAIM_MAX_MS) out.push({ kind: "dead", claim: c });
  }
  for (const [key, claims] of byKey) if (claims.length > 1) out.push({ kind: "duplicate", key, claims });
  return out;
};

export const findingLine = (f: ClaimFinding, now: number): string =>
  f.kind === "duplicate"
    ? `two writers on ${f.key}: ${f.claims.map((c) => holderLine(c, now)).join("; ")}`
    : f.kind === "dead"
      ? `released the claim on ${f.claim.key}: its worker ${f.claim.dispatchId} is gone`
      : `released the claim on ${f.claim.key}: no writer was ever started for it`;

export const refusalText = (key: string, holder: ClaimFacts, now: number): string =>
  `${key} is held by ${holderLine(holder, now)}. Do not start a second writer for it: follow that one (its dispatch id and thread are above), or ask the owner to release it.`;
