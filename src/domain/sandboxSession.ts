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

const sign = (secret: string, expSec: number): string => createHmac("sha256", secret).update(`jvsb:${expSec}`).digest("hex");

/** `jvsb_<expiry, epoch seconds>_<hmac>`. */
export const mintSession = (secret: string, expSec: number): string => `${SESSION_PREFIX}${expSec}_${sign(secret, expSec)}`;

export const isSessionToken = (token: string): boolean => token.startsWith(SESSION_PREFIX);

export type SessionCheck = { ok: true; expiresAt: number } | { ok: false; reason: "malformed" | "bad-signature" | "expired" };

export const verifySession = (secret: string, token: string, nowSec: number): SessionCheck => {
  const m = token.match(/^jvsb_(\d{1,12})_([0-9a-f]{64})$/);
  if (!m || !secret) return { ok: false, reason: "malformed" };
  const exp = Number(m[1]);
  const want = Buffer.from(sign(secret, exp), "hex");
  const got = Buffer.from(m[2] ?? "", "hex");
  if (want.length !== got.length || !timingSafeEqual(want, got)) return { ok: false, reason: "bad-signature" };
  if (exp <= nowSec) return { ok: false, reason: "expired" };
  return { ok: true, expiresAt: exp };
};
