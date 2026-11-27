#!/usr/bin/env bash
# Shared client for the shims in this folder: send one command line to the bot's
# exec proxy (POST /api/proxy/exec) and print what the real command printed.
#
#   . _proxy.sh; proxy_exec <gh|orca> <stdin-file-or-empty> <arg>...
#
# The bearer is the caller's ticket (JARVIS_RUN_TICKET, or the first line of
# JARVIS_RUN_TICKET_FILE) for gh, a turn's ticket or else the sandbox session for
# orca. Nothing here holds a credential of its own.
set -uo pipefail

PROXY_URL=${JARVIS_PROXY_URL:-}

proxy_bearer() { # <tool>
  local ticket=${JARVIS_RUN_TICKET:-}
  if [ -z "$ticket" ] && [ -n "${JARVIS_RUN_TICKET_FILE:-}" ] && [ "$1" = gh ]; then
    ticket=$(sed -n 1p "$JARVIS_RUN_TICKET_FILE" 2>/dev/null | tr -d '[:space:]')
  fi
  if [ -n "$ticket" ]; then printf '%s' "$ticket"; else printf '%s' "${JARVIS_PROXY_SESSION:-}"; fi
}

# owner/name of the clone we are in, from its origin remote; empty when there is none.
proxy_repo_hint() {
  git remote get-url origin 2>/dev/null | sed -E -e 's#\.git$##' -e 's#^.*github\.com[:/]##' | grep -E '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' || true
}

proxy_exec() { # <tool> <stdin-file|""> <arg>...
  local tool=$1 stdin_file=$2 body answer rc
  shift 2
  [ -n "$PROXY_URL" ] || { echo "$tool: not inside the sandbox (JARVIS_PROXY_URL is unset); start the process through bin/sandboxed.sh" >&2; return 3; }
  command -v jq >/dev/null 2>&1 || { echo "$tool: jq is needed by the sandbox shims" >&2; return 3; }
  local stdin_json="null"
  [ -n "$stdin_file" ] && stdin_json=$(jq -Rs . <"$stdin_file")
  body=$(jq -n --arg tool "$tool" --arg bearer "$(proxy_bearer "$tool")" --arg hint "$(proxy_repo_hint)" --arg handle "${ORCA_TERMINAL_HANDLE:-}" \
    --argjson stdin "$stdin_json" --args \
    '{tool:$tool, bearer:$bearer, argv:$ARGS.positional} + (if $stdin==null then {} else {stdin:$stdin} end) + (if $hint=="" then {} else {repoHint:$hint} end) + (if $handle=="" then {} else {handle:$handle} end)' \
    -- "$@") || return 3
  answer=$(curl -sS --max-time 120 -H 'Content-Type: application/json' --data-binary "$body" "$PROXY_URL/api/proxy/exec" 2>&1) || {
    echo "$tool: the bot's proxy did not answer at $PROXY_URL: $answer" >&2
    return 3
  }
  if [ "$(printf '%s' "$answer" | jq -r '.ok // false' 2>/dev/null)" != true ]; then
    echo "$tool: $(printf '%s' "$answer" | jq -r '.error // "no usable answer from the bot"' 2>/dev/null)" >&2
    return 1
  fi
  printf '%s' "$answer" | jq -j '.stdout'
  printf '%s' "$answer" | jq -j '.stderr' >&2
  rc=$(printf '%s' "$answer" | jq -r '.code')
  return "$rc"
}

# Rewrite `--body-file <path>` / `-F <path>` and `--spec-file <path>` to `-`, reading the file HERE,
# in the caller's sandbox, so the bot never opens a path the caller names. Sets REWRITTEN (the args)
# and STDIN_FILE (a temp file, or empty). Call as: rewrite_file_args "$@"
rewrite_file_args() {
  REWRITTEN=()
  STDIN_FILE=""
  local a next
  while [ "$#" -gt 0 ]; do
    a=$1
    shift
    case "$a" in
      --body-file | -F | --spec-file)
        next=${1:-}
        [ "$#" -gt 0 ] && shift
        if [ "$next" = "-" ]; then STDIN_FILE=$(mktemp); cat >"$STDIN_FILE"; else STDIN_FILE=$next; fi
        REWRITTEN+=("$a" "-")
        ;;
      --body-file=* | --spec-file=*)
        next=${a#*=}
        if [ "$next" = "-" ]; then STDIN_FILE=$(mktemp); cat >"$STDIN_FILE"; else STDIN_FILE=$next; fi
        REWRITTEN+=("${a%%=*}" "-")
        ;;
      *) REWRITTEN+=("$a") ;;
    esac
  done
}
