/**
 * The proxy session of a sandboxed process.
 *
 * A sandboxed caller (a turn, an Orca worker) reaches the bot's proxy with a
 * ticket when it has one. Most workers do not (a reviewer, a verifier): they
 * get a SESSION, a signed expiry minted by `bin/sandboxed.sh` before the
 * sandbox starts, from a secret file only the unsandboxed side can read (the
 * profile denies `~/.config/jarvis`). The bot checks the signature with the
 * same file. A session is read-only on GitHub and may message through Orca;
 * everything that writes needs a real ticket (see `domain/proxyPolicy.ts`).
 *
 * Stateless on purpose: nothing to store, nothing lost on a restart, and a
 * session is worth no more than the sandbox that holds it.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export const SESSION_PREFIX = "jvsb_";

const HANDLE = /^term_[\w-]{1,80}$/;

const sign = (secret: string, expSec: number, handle: string): string => createHmac("sha256", secret).update(`jvsb:${expSec}:${handle}`).digest("hex");

/**
 * `jvsb_<expiry, epoch seconds>_<hmac>` or, for a worker that has an Orca terminal, `..._<handle>`.
 * The handle is signed in: the session can read that terminal's mailbox and no other.
 */
export const mintSession = (secret: string, expSec: number, handle = ""): string =>
  `${SESSION_PREFIX}${expSec}_${sign(secret, expSec, handle)}${handle ? `_${handle}` : ""}`;

export const isSessionToken = (token: string): boolean => token.startsWith(SESSION_PREFIX);

export type SessionCheck = { ok: true; expiresAt: number; /** The Orca terminal this session belongs to, if it was minted with one. */ handle?: string } | { ok: false; reason: "malformed" | "bad-signature" | "expired" };

export const verifySession = (secret: string, token: string, nowSec: number): SessionCheck => {
  const m = token.match(/^jvsb_(\d{1,12})_([0-9a-f]{64})(?:_(term_[\w-]{1,80}))?$/);
  if (!m || !secret) return { ok: false, reason: "malformed" };
  const exp = Number(m[1]);
  const handle = m[3] ?? "";
  if (handle && !HANDLE.test(handle)) return { ok: false, reason: "malformed" };
  const want = Buffer.from(sign(secret, exp, handle), "hex");
  const got = Buffer.from(m[2] ?? "", "hex");
  if (want.length !== got.length || !timingSafeEqual(want, got)) return { ok: false, reason: "bad-signature" };
  if (exp <= nowSec) return { ok: false, reason: "expired" };
  return handle ? { ok: true, expiresAt: exp, handle } : { ok: true, expiresAt: exp };
};
