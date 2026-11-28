#!/usr/bin/env bash
# `claude`, sandboxed: the command Orca is told to launch for the claude agent.
#
#   sandboxed-claude.sh [claude args...]
#
# Claude Code keeps its login in the keychain, which the sandbox takes away, so
# the login comes in as CLAUDE_CODE_OAUTH_TOKEN instead, read HERE (outside the
# sandbox) from the first of:
#   1. CLAUDE_CODE_OAUTH_TOKEN already in the environment (the bot's per-caller token);
#   2. the file $JARVIS_SANDBOX_CLAUDE_TOKEN_FILE, default ~/.config/jarvis/sandbox-claude-token
#      (mode 0600; `claude setup-token` makes the token, see README "Sandbox").
# With neither it stops, saying so: a worker with no login would only fail later and
# look like a bug. The real claude is $JARVIS_CLAUDE_BIN, else the first `claude` on
# PATH that is not this script.
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd -P)
SELF=$(cd "$HERE" && pwd -P)/$(basename "$0")

real=${JARVIS_CLAUDE_BIN:-}
if [ -z "$real" ]; then
  IFS=: read -r -a dirs <<<"$PATH"
  for d in ${dirs[@]+"${dirs[@]}"}; do
    c="$d/claude"
    if [ -x "$c" ] && [ ! -d "$c" ] && [ "$(cd "$(dirname "$c")" && pwd -P)/claude" != "$SELF" ]; then real=$c; break; fi
  done
fi
[ -n "$real" ] && [ -x "$real" ] || { echo "sandboxed-claude: no claude to run (set JARVIS_CLAUDE_BIN)" >&2; exit 127; }

if [ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then
  tf=${JARVIS_SANDBOX_CLAUDE_TOKEN_FILE:-$HOME/.config/jarvis/sandbox-claude-token}
  if [ -r "$tf" ]; then
    CLAUDE_CODE_OAUTH_TOKEN=$(head -n 1 "$tf" | tr -d '[:space:]')
    export CLAUDE_CODE_OAUTH_TOKEN
  fi
fi
if [ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ] && [ "${JARVIS_SANDBOXED:-}" != 1 ]; then
  echo "sandboxed-claude: no Claude login for the sandbox: the keychain is off limits inside it." >&2
  echo "  run \`claude setup-token\`, then: umask 077; pbpaste > ~/.config/jarvis/sandbox-claude-token" >&2
  exit 78
fi
exec "$HERE/sandboxed.sh" -- "$real" "$@"
