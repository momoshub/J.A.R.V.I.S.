/**
 * The words that keep a change out of the "low-risk, approve it myself" lane.
 *
 * A bug report or a Jueki blocker carries risk facts the turn states (`--reversible`, `--data-write`, ...).
 * Those are a claim, and a claim can be wrong or planted by a page the turn read, so the text the
 * turn wrote is read too: anything that names roles, permissions, auth, tickets, tokens, secrets, the
 * approval code itself or prod data is never low-risk, whatever flags came with it. Over-matching is
 * the safe side: the owner's button is the fallback.
 */
const SENSITIVE = new RegExp(
  [
    "roles?",
    "permissions?",
    "grants?",
    "auth(?:entication|orization|orisation|n|z)?",
    "logins?",
    "oauth",
    "sso",
    "2fa",
    "totp",
    "tickets?",
    "tokens?",
    "secrets?",
    "credentials?",
    "passwords?",
    "api[ -]?keys?",
    "private[ -]keys?",
    "iam",
    "acl",
    "allowlist",
    "approv\\w*",
    "owner[ -]only",
    "prod",
    "production",
    "database",
    "db",
    "migrations?",
    "schema",
    "delete",
    "drop",
  ].join("|"),
  "i",
);

const WORD = new RegExp(`(?<![\\p{L}\\p{N}_])(?:${SENSITIVE.source})(?![\\p{L}\\p{N}_])`, "iu");

/** The sensitive word found in `text`, or undefined when it is clean. */
export const sensitiveWord = (text: string): string | undefined => WORD.exec(text)?.[0].toLowerCase();

/** Whether any of these texts names something that is never low-risk. */
export const touchesSensitive = (...texts: readonly string[]): boolean => texts.some((t) => sensitiveWord(t) !== undefined);
