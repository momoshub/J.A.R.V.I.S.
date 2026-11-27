/**
 * One writer per job (domain/writerClaim.ts), the operations the `claim` command, the worker-end hook and
 * the coordinator's tick share. A claim is taken before `worker-start`, bound to its dispatch after, released when the
 * worker ends (the same `watch worker` hook that revokes its ticket) or, if that never fired, by the tick.
 */
import {
  refusalText,
  takeVerdict,
  type ClaimFacts,
  type Claimant,
} from "../domain/writerClaim.ts";
import { endedWorkerOf } from "../domain/workerTicket.ts";
import type { WriterClaimRepo } from "../infrastructure/db/writerClaimRepo.ts";
import type { Clock } from "./ports.ts";

export type WriterClaims = {
  /** Take every key or none: the refusal names the first holder. */
  take: (keys: readonly string[], who: Claimant & { actor: string }) => { ok: true } | { ok: false; error: string };
  /** After `worker-start`: bind the keys this thread holds to the dispatch it printed. */
  bind: (keys: readonly string[], dispatchId: string, who: Claimant) => { ok: true } | { ok: false; error: string };
  /** The holder's own thread, or the owner (`force`), ends a claim before its worker did. */
  release: (key: string, who: Claimant, force: boolean) => { ok: true } | { ok: false; error: string };
  live: () => readonly ClaimFacts[];
  releaseId: (id: number, why: string) => boolean;
  /** A worker ended: every claim it held. */
  releaseDispatch: (dispatchId: string, why: string) => number;
};

export const createWriterClaims = (clock: Clock, repo: WriterClaimRepo): WriterClaims => {
  const inThread = (c: ClaimFacts, who: Claimant): boolean => c.channelId === who.channelId && c.threadTs === who.threadTs;
  return {
    take: (keys, who) => {
      const now = clock();
      const verdicts = keys.map((key) => ({ key, live: repo.liveOfKey(key), verdict: takeVerdict(repo.liveOfKey(key), who) }));
      for (const v of verdicts) if (!v.verdict.ok) return { ok: false, error: refusalText(v.key, v.verdict.holder, now) };
      for (const v of verdicts) {
        if (v.verdict.ok && v.verdict.refresh && v.live[0]) repo.refresh(v.live[0].id, now);
        else repo.add({ key: v.key, channelId: who.channelId, threadTs: who.threadTs, actor: who.actor, createdAt: now }, now);
      }
      return { ok: true };
    },
    bind: (keys, dispatchId, who) => {
      const mine: ClaimFacts[] = [];
      for (const key of keys) {
        const held = repo.liveOfKey(key).find((c) => inThread(c, who) && (c.dispatchId === "" || c.dispatchId === dispatchId));
        if (!held) return { ok: false, error: `${key} is not claimed by this thread: run \`claim take ${key}\` first.` };
        mine.push(held);
      }
      for (const c of mine) repo.bind(c.id, dispatchId);
      return { ok: true };
    },
    release: (key, who, force) => {
      const held = repo.liveOfKey(key);
      if (held.length === 0) return { ok: false, error: `${key} is not claimed.` };
      if (!force && !held.every((c) => inThread(c, who))) return { ok: false, error: refusalText(key, held[0] as ClaimFacts, clock()) };
      for (const c of held) repo.release(c.id, force ? "released by the owner" : "released by its thread", clock());
      return { ok: true };
    },
    live: () => repo.live(),
    releaseId: (id, why) => repo.release(id, why, clock()),
    releaseDispatch: (dispatchId, why) => repo.releaseDispatch(dispatchId, why, clock()),
  };
};

/**
 * The watcher's `onFired` half that frees a worker's claims: like `revokeOnWorkerEnd`, only a watch whose check
 * runs the worker helper counts, and only `finished` / `died`. How many claims were released.
 */
export const releaseClaimsOnWorkerEnd =
  (claims: Pick<WriterClaims, "releaseDispatch">, helper: string) =>
  (watch: { readonly check: string }, output: string): number => {
    if (!helper || !watch.check.includes(helper)) return 0;
    const ended = endedWorkerOf(output);
    return ended ? claims.releaseDispatch(ended, "its worker ended") : 0;
  };
