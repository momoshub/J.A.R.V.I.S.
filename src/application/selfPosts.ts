/**
 * What each turn has posted into its own thread through the Slack proxy.
 *
 * The proxy records a successful `chat.postMessage` / `chat.update` here; the
 * Slack handler reads it when the turn ends, to drop the closing reply of a turn
 * that posted its answer itself (`domain/selfPost.ts`), and clears it.
 *
 * Keyed by the turn's run ticket (shared by every process the turn spawns, each
 * of which has its own Slack ticket), not by thread: watch hand-backs, `tell`,
 * workflow steps and commands post into the same thread under tickets of their
 * own, and none of that may be taken for what THIS turn said. In memory: a
 * restart ends every turn anyway.
 */
import { applySelfPostCall, type SelfPost, type SelfPostCall } from "../domain/selfPost.ts";
import type { Clock } from "./ports.ts";

/** Longer than any turn the bot allows (the ticket's own TTL): the backstop for a turn that never reached its clear. */
export const SELF_POSTS_TTL_MS = 3 * 60 * 60_000;
/** Turns remembered at once; the oldest goes first. Only a turn the Slack handler never read (a hand-back, a loop, a workflow step) leaves one behind. */
export const SELF_POSTS_MAX_TURNS = 500;

export type SelfPosts = {
  /** Note a call the proxy made for the turn `turn`, which runs in the thread `threadTs`. True when the call put (or changed) a message of the turn's own thread. */
  record: (turn: string, threadTs: string | undefined, call: SelfPostCall) => boolean;
  /** What that turn has posted so far. */
  posts: (turn: string) => readonly SelfPost[];
  /** The turn finished a file upload (into any thread): its closing reply never replaces a post of its own. */
  noteUpload: (turn: string) => void;
  /** Did the turn upload a file? */
  uploaded: (turn: string) => boolean;
  /** The turn ended. */
  clear: (turn: string) => void;
};

type Entry = { readonly posts: readonly SelfPost[]; readonly uploaded: boolean; readonly at: number };

export const createSelfPosts = (clock: Clock = () => Date.now()): SelfPosts => {
  const byTurn = new Map<string, Entry>();
  const liveOf = (key: string): Entry | undefined => {
    const live = byTurn.get(key);
    return live && clock() - live.at < SELF_POSTS_TTL_MS ? live : undefined;
  };
  const put = (key: string, entry: Omit<Entry, "at">): void => {
    // delete first so a re-set turn moves to the newest end of the Map
    byTurn.delete(key);
    byTurn.set(key, { ...entry, at: clock() });
    for (const oldest of byTurn.keys()) {
      if (byTurn.size <= SELF_POSTS_MAX_TURNS) break;
      byTurn.delete(oldest);
    }
  };
  return {
    record: (key, threadTs, call) => {
      if (!threadTs) return false;
      const live = liveOf(key);
      const before = live?.posts ?? [];
      const after = applySelfPostCall(before, call, threadTs);
      if (after === before) return false;
      put(key, { posts: after, uploaded: live?.uploaded ?? false });
      return true;
    },
    posts: (turn) => liveOf(turn)?.posts ?? [],
    noteUpload: (turn) => {
      if (!turn) return;
      put(turn, { posts: liveOf(turn)?.posts ?? [], uploaded: true });
    },
    uploaded: (turn) => liveOf(turn)?.uploaded ?? false,
    clear: (turn) => void byTurn.delete(turn),
  };
};
