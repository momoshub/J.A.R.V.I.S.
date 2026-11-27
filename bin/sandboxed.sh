#!/usr/bin/env bash
# Run a command under the seatbelt profile (bin/sandbox/jarvis.sb).
#
#   sandboxed.sh [--print-profile] [--] <command> [args...]
#
# This is what turns "prompt rules are the only thing in the way" into an OS
# boundary: the command, and everything it starts, cannot read the keychain, gh's
# login, the GitHub App key, the bot's .env and databases or the Orca runtime
# token, cannot reach the ssh agent, and cannot start anything outside the sandbox through the paths the
# profile names (see its header and the limits in CLAUDE.md: it is a denylist outside the checkout)
# (launchd, LaunchServices, Apple Events, cron/at, shell startup files). What it
# still needs from those credentials it asks the bot for, over loopback, with its
# ticket: bin/sandbox-shims/{gh,orca,git-credential-jarvis} are first on its PATH.
#
# Where it is used (all behind SEATBELT=on; with it off nothing changes):
#   - the bot starts every turn through it (src/infrastructure/llm/claudeCli.ts);
#   - Orca starts every worker through bin/sandboxed-claude.sh, set once as the
#     agent's command override in Orca's settings (see README, "Sandbox").
#
# It fails CLOSED: not macOS, no sandbox-exec, or a profile that will not render is
# an error, never a command run unsandboxed. A process already inside the sandbox
# just runs the command (the OS refuses a nested sandbox, and a child can never
# loosen its parent's), so a worker that calls this again gains nothing.
#
# Environment (all optional): JARVIS_SANDBOX_HOME (the home to protect, default $HOME),
# JARVIS_REPO (the bot's checkout, default the one this script is in),
# SEATBELT_SESSION_HOURS (life of the proxy session token, default 12), SEATBELT_SECRET_PATH (the signing secret; else the
# checkout's .env, else the default), ORCA_TERMINAL_HANDLE (an Orca worker's own terminal, signed into its session),
# SEATBELT_NO_SESSION=1 (mint no session: what the bot sets for a turn),
# DASHBOARD_PORT (where the bot's proxy listens; default read from the checkout's .env, else 2002).
set -uo pipefail

PRINT=0
[ "${1:-}" = "--print-profile" ] && { PRINT=1; shift; }
[ "${1:-}" = "--" ] && shift

# Already inside? Ask the OS, never an environment variable: a parent that set JARVIS_SANDBOXED=1 and is not
# sandboxed would otherwise get its command run bare. The OS refuses a nested sandbox-exec; that refusal IS the test.
if [ "${JARVIS_SANDBOXED:-}" = 1 ] && [ "$PRINT" = 0 ] && command -v sandbox-exec >/dev/null 2>&1 \
  && ! sandbox-exec -p '(version 1)(allow default)' /usr/bin/true >/dev/null 2>&1; then
  [ "$#" -gt 0 ] || { echo "usage: sandboxed.sh [--] <command> [args...]" >&2; exit 2; }
  exec "$@"
fi

HERE=$(cd "$(dirname "$0")" && pwd -P)
REPO=${JARVIS_REPO:-$(cd "$HERE/.." && pwd -P)}
HOME_DIR=${JARVIS_SANDBOX_HOME:-$HOME}
PROFILE_TEMPLATE=${JARVIS_SANDBOX_PROFILE:-$HERE/sandbox/jarvis.sb}

die() { echo "sandboxed.sh: $*" >&2; exit "${2:-1}"; }

if [ "$PRINT" = 0 ]; then
  [ "$#" -gt 0 ] || { echo "usage: sandboxed.sh [--] <command> [args...]" >&2; exit 2; }
  [ "$(uname)" = Darwin ] || die "the sandbox needs macOS (sandbox-exec); refusing to run the command unsandboxed" 78
  command -v sandbox-exec >/dev/null 2>&1 || die "sandbox-exec not found; refusing to run the command unsandboxed" 78
fi
[ -r "$PROFILE_TEMPLATE" ] || die "cannot read the profile $PROFILE_TEMPLATE" 78

# A path goes into the profile inside a quoted string and a regex: refuse what would break out of either.
safe_path() {
  case "$1" in
    /*) ;;
    *) die "$2 must be an absolute path: $1" 78 ;;
  esac
  case "$1" in
    *\"* | *\\* | *$'\n'*) die "$2 has a quote, backslash or newline in it: $1" 78 ;;
  esac
}
HOME_DIR=$(cd "$HOME_DIR" 2>/dev/null && pwd -P) || die "no such home: $HOME_DIR" 78
safe_path "$HOME_DIR" "the home"
safe_path "$REPO" "the checkout"
re_escape() { printf '%s' "$1" | sed -e 's/[][\.*^$+?(){}|]/\\&/g'; }

SSH_SOCK=${SSH_AUTH_SOCK:-/nonexistent/no-ssh-agent}
safe_path "$SSH_SOCK" "SSH_AUTH_SOCK"

profile=$(sed \
  -e "s|@SSH_AUTH_SOCK@|$SSH_SOCK|g" \
  -e "s|@HOME_RE@|$(re_escape "$HOME_DIR")|g" \
  -e "s|@REPO_RE@|$(re_escape "$REPO")|g" \
  -e "s|@HOME@|$HOME_DIR|g" \
  -e "s|@REPO@|$REPO|g" \
  "$PROFILE_TEMPLATE") || die "could not render the profile" 78
# --- the paths this deployment really uses: databases and the worker home -----------------------------
# .env may put the databases anywhere (here: ~/.jarvis/data); deny exactly the files the bot opens, with their -wal/-shm.
env_value() { # <NAME>: the last NAME=value of the checkout's .env, quotes stripped
  [ -r "$REPO/.env" ] || return 0
  sed -n "s/^$1=//p" "$REPO/.env" | tail -1 | sed -e 's/^["'"'"']//' -e 's/["'"'"']$//'
}
abs_path() { # <value> <default>: ~ and relative paths the way src/config/env.ts reads them
  local v=${1:-$2}
  case "$v" in
    "~/"*) v="$HOME_DIR/${v#\~/}" ;;
    /*) ;;
    *) v="$REPO/$v" ;;
  esac
  printf '%s' "$v"
}
db_rules=";; --- the databases this deployment names in .env ---"
for pair in DATABASE_PATH:data/bot.db TOKEN_DATABASE_PATH:data/tokens.db INBOX_DATABASE_PATH:data/inbox.db; do
  dbp=$(abs_path "$(env_value "${pair%%:*}")" "${pair#*:}")
  safe_path "$dbp" "${pair%%:*}"
  db_rules="$db_rules"$'\n'"(deny file-read* file-write* (regex #\"^$(re_escape "$dbp")\"))"
done
worker_home=$(abs_path "$(env_value WORKER_HOME_DIR)" "$HOME_DIR/.jarvis/worker-home")
safe_path "$worker_home" "WORKER_HOME_DIR"
profile="$profile"$'\n'"$db_rules"$'\n'";; the worker home (a worker's own working folder) is writable again"$'\n'"(allow file-write* (subpath \"$worker_home\"))"
# Renaming a parent moves everything below it out from under its deny: no ancestor of the checkout or the home
# (up to /) may be renamed or deleted.
anc_rules=";; --- no renaming the folders above the checkout and the home ---"
for base in "$REPO" "$HOME_DIR"; do
  d=$base
  while [ "$d" != "/" ] && [ -n "$d" ]; do
    anc_rules="$anc_rules"$'\n'"(deny file-write-unlink (literal \"$d\"))"
    d=$(dirname "$d")
  done
done
profile="$profile"$'\n'"$anc_rules"
case "$profile" in *@[A-Z_]*@*) die "the profile still has an unreplaced @NAME@" 78 ;; esac
if [ "$PRINT" = 1 ]; then printf '%s\n' "$profile"; exit 0; fi

# --- where the bot's proxy listens -------------------------------------------
port=${DASHBOARD_PORT:-}
if [ -z "$port" ] && [ -r "$REPO/.env" ]; then
  port=$(sed -n 's/^DASHBOARD_PORT=\([0-9][0-9]*\).*/\1/p' "$REPO/.env" | tail -1)
fi
port=${port:-2002}

# --- a proxy session: read-only gh and Orca messaging, no ticket needed --------
# Signed with a secret only the unsandboxed side can read (this script, the bot).
# The bot starts a turn with SEATBELT_NO_SESSION=1: a turn stands on its ticket and its role, never on a session.
session=""
secret_path=${SEATBELT_SECRET_PATH:-}
if [ -z "$secret_path" ] && [ -r "$REPO/.env" ]; then
  # the bot reads SEATBELT_SECRET_PATH from .env; an Orca-launched wrapper has no such variable, so read the same line
  secret_path=$(sed -n 's/^SEATBELT_SECRET_PATH=//p' "$REPO/.env" | tail -1 | sed -e 's/^["'"'"']//' -e 's/["'"'"']$//' -e "s|^~/|$HOME_DIR/|")
fi
secret_path=${secret_path:-$HOME_DIR/.config/jarvis/sandbox-secret}
if [ "${SEATBELT_NO_SESSION:-}" != 1 ]; then
  BUN=$(command -v bun || true)
  [ -n "$BUN" ] || BUN="$HOME_DIR/.bun/bin/bun"
  if [ -x "$BUN" ]; then
    session=$("$BUN" "$HERE/sandbox-session.ts" mint "$secret_path" "${SEATBELT_SESSION_HOURS:-12}" "${ORCA_TERMINAL_HANDLE:-}" 2>/dev/null) || session=""
  fi
  [ -n "$session" ] || die "could not mint the proxy session (is bun installed, and is $HOME_DIR/.config/jarvis writable?)" 78
fi

# --- an empty gh config, so a stray `gh` finds no login ----------------------------
gh_dir=$(mktemp -d "${TMPDIR:-/tmp}/jarvis-gh.XXXXXX") || die "no temp dir" 78

export JARVIS_SANDBOXED=1
export JARVIS_PROXY_URL="http://127.0.0.1:$port"
export JARVIS_PROXY_SESSION="$session"
unset SEATBELT_NO_SESSION
export GH_CONFIG_DIR="$gh_dir"
export PATH="$HERE/sandbox-shims:$PATH"
# Credentials in the environment are credentials: none of the host's own may ride in.
unset GH_TOKEN GITHUB_TOKEN GH_ENTERPRISE_TOKEN GITHUB_ENTERPRISE_TOKEN SSH_AUTH_SOCK GIT_ASKPASS SSH_ASKPASS GIT_SSH GIT_SSH_COMMAND
# git asks the bot for a credential (scoped to the ticket's repo) and nothing else.
export GIT_CONFIG_COUNT=2
export GIT_CONFIG_KEY_0=credential.helper GIT_CONFIG_VALUE_0=
export GIT_CONFIG_KEY_1=credential.helper GIT_CONFIG_VALUE_1="$HERE/sandbox-shims/git-credential-jarvis"
export GIT_TERMINAL_PROMPT=0

exec sandbox-exec -p "$profile" "$@"
