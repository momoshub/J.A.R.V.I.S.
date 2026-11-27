#!/usr/bin/env bash
# The release store: one immutable folder per commit, a last known good one,
# the supervisor that health-checks a new one, and the way back.
#
#   jarvis-release.sh prepare <sha>      export <sha> into <root>/<sha>, install deps; prints the folder
#   jarvis-release.sh activate <sha>     link the host state in, mark it checked, point `current` at it
#   jarvis-release.sh launch             the supervisor launchd runs: start `current`, health-check, roll back
#   jarvis-release.sh rollback [sha] [--no-restart]
#                                        point the supervisor at the last known good release and restart
#   jarvis-release.sh status             what runs, what is known good, what happened lately
#   jarvis-release.sh install [--label L] [--source DIR]
#                                        copy this script (and the plist template) OUTSIDE the repo
#   jarvis-release.sh plist              print the LaunchAgent plist for this host (stdout)
#
# Why it exists: `jarvis-restart.sh` used to check the live checkout after a
# `git pull`. A refusal left the live copy on the new commit, there was no last
# known good build, and the only way back ran through the very pipeline (the
# agent, the merge script, CI) that had just shipped the broken thing.
#
# Layout under <root> (JARVIS_RELEASES_DIR, default ~/.jarvis/releases):
#   <sha>/            a plain export of that commit (no .git), deps installed,
#                     dashboard built. `.env`, `data`, `logs` are symlinks to the
#                     source checkout: host state is never copied or versioned
#   current           symlink: the release the supervisor starts
#   last-good         symlink: the newest release that passed a post-start health check
#   previous-good     symlink: the last-good before that
#   bin/              the copy of this script launchd runs; outside the repo, so
#                     a broken commit cannot break the way back
#   history.log       one line per event; rollback.json the last automatic rollback
#
# `rollback` needs nothing but bash, ln and launchctl: no bot, no bun, no network.
set -uo pipefail

ROOT=${JARVIS_RELEASES_DIR:-$HOME/.jarvis/releases}
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)

stamp() { date -u +%Y-%m-%dT%H:%M:%SZ; }
say() { echo "$*" >&2; }
note() {
  mkdir -p "$ROOT"
  printf '%s %s\n' "$(stamp)" "$*" >> "$ROOT/history.log"
  say "[release] $*"
}

# The checkout the code comes from and the host state lives in.
source_repo() {
  if [ -n "${JARVIS_SOURCE_REPO:-}" ]; then echo "$JARVIS_SOURCE_REPO"; return; fi
  if [ -s "$ROOT/source" ]; then cat "$ROOT/source"; return; fi
  (cd "$SCRIPT_DIR/.." && pwd)
}

link_of() { readlink "$ROOT/$1" 2>/dev/null || true; }

# Only a release that was checked through `activate` may run.
valid_release() { [ -n "${1:-}" ] && [ -f "$1/.ok" ] && [ -f "$1/src/index.ts" ] && [ ! -f "$1/.bad" ]; }

set_link() { ln -sfn "$2" "$ROOT/$1"; }

dashboard_port() {
  if [ -n "${DASHBOARD_PORT:-}" ]; then echo "$DASHBOARD_PORT"; return; fi
  local from_env
  from_env=$(grep -E '^DASHBOARD_PORT=' "$(source_repo)/.env" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d "\"' ")
  echo "${from_env:-2001}"
}

# `ok: true` is "can do its job": the process is up, the dashboard answers, the
# harness reports itself ready (Slack heard, not draining). -f turns the 503 of a
# deaf or draining bot into a failure.
health_ok() {
  curl -sf --max-time 3 "http://127.0.0.1:$(dashboard_port)/health" 2>/dev/null | grep -q '"ok":true'
}

cmd_prepare() {
  local src sha dir
  src=$(source_repo)
  sha=$(git -C "$src" rev-parse --verify "${1:-HEAD}^{commit}" 2>/dev/null) || { say "no such commit in $src: ${1:-HEAD}"; return 1; }
  dir="$ROOT/$sha"
  if [ -f "$dir/.bad" ]; then
    say "release $sha failed its health check before ($(cat "$dir/.bad")); push a fix, or remove $dir/.bad to retry it"
    return 1
  fi
  # A half-built folder is never reused; a finished one is immutable, so rebuilding it would change nothing.
  if [ -d "$dir" ] && [ ! -f "$dir/.ok" ]; then rm -rf "$dir"; fi
  if [ ! -d "$dir" ]; then
    mkdir -p "$dir" || return 1
    if ! git -C "$src" archive "$sha" | tar -x -C "$dir"; then rm -rf "$dir"; say "cannot export $sha"; return 1; fi
    if ! (cd "$dir" && bun install --frozen-lockfile >&2); then rm -rf "$dir"; say "bun install failed for $sha"; return 1; fi
  fi
  echo "$dir"
}

cmd_activate() {
  local src sha dir n
  src=$(source_repo)
  sha=$(git -C "$src" rev-parse --verify "${1:-HEAD}^{commit}" 2>/dev/null) || { say "no such commit: ${1:-}"; return 1; }
  dir="$ROOT/$sha"
  [ -f "$dir/src/index.ts" ] || { say "$dir is not prepared"; return 1; }
  # State links go in AFTER the checks, so a test run never touches the live data.
  for n in .env data logs; do
    if [ -e "$src/$n" ] && [ ! -e "$dir/$n" ]; then ln -s "$src/$n" "$dir/$n"; fi
  done
  echo "$sha" > "$dir/.ok"
  set_link current "$dir"
  note "activated $sha"
  prune
}

# Keep the three that matter plus the newest few; the rest is disk.
prune() {
  local keep=${RELEASES_KEEP:-5} protected d n=0
  protected="$(link_of current) $(link_of last-good) $(link_of previous-good)"
  # shellcheck disable=SC2045
  for d in $(ls -1dt "$ROOT"/[0-9a-f]*/ 2>/dev/null); do
    d=${d%/}
    case " $protected " in *" $d "*) continue ;; esac
    n=$((n + 1))
    if [ "$n" -gt "$keep" ]; then rm -rf "$d"; fi
  done
}

promote() {
  local target=$1 old
  old=$(link_of last-good)
  if [ -n "$old" ] && [ "$old" != "$target" ]; then set_link previous-good "$old"; fi
  set_link last-good "$target"
  note "last-good is now $(basename "$target")"
}

cmd_launch() {
  local src target good child code deadline passed timeout poll
  mkdir -p "$ROOT"
  src=$(source_repo)
  target=""
  for cand in "$(link_of current)" "$(link_of last-good)" "$(link_of previous-good)"; do
    if valid_release "$cand"; then target=$cand; break; fi
  done
  # No release at all (the plist was installed before the first restart): run the
  # checkout itself, which is what the old plist did.
  kind=release
  if [ -z "$target" ]; then target=$src; kind=source; fi

  echo $$ > "$ROOT/launcher.pid"
  cd "$target" || exit 1
  export JARVIS_SOURCE_REPO=$src JARVIS_RELEASES_DIR=$ROOT JARVIS_RELEASE_SHA=$(basename "$target")
  note "starting $(basename "$target") ($kind)"
  bun run src/index.ts &
  child=$!
  trap 'kill -TERM "$child" 2>/dev/null; wait "$child"; exit $?' TERM INT

  good=$(link_of last-good)
  if [ "$kind" = release ] && [ "$target" != "$good" ]; then
    timeout=${RELEASE_HEALTH_TIMEOUT_S:-180}
    poll=${RELEASE_HEALTH_POLL_S:-2}
    deadline=$((SECONDS + timeout))
    passed=0
    while kill -0 "$child" 2>/dev/null && [ "$SECONDS" -lt "$deadline" ]; do
      if health_ok; then passed=1; break; fi
      sleep "$poll"
    done
    if [ "$passed" = 1 ]; then
      promote "$target"
    elif valid_release "$good"; then
      local why="did not report healthy within ${timeout}s"
      kill -0 "$child" 2>/dev/null || why="exited before it reported healthy"
      kill -TERM "$child" 2>/dev/null
      wait "$child" 2>/dev/null
      echo "$why" > "$target/.bad"
      set_link current "$good"
      printf '{"at":"%s","from":"%s","to":"%s","reason":"%s"}\n' "$(stamp)" "$(basename "$target")" "$(basename "$good")" "$why" > "$ROOT/rollback.json"
      note "ROLLED BACK $(basename "$target") -> $(basename "$good"): $why"
      exit 0 # KeepAlive starts the supervisor again, now on last-good
    else
      note "$(basename "$target") is not healthy and there is no last-good to go back to; leaving it running"
    fi
  elif [ "$kind" = release ]; then
    note "$(basename "$target") is last-good, not health-gated"
  fi

  wait "$child"
  code=$?
  note "$(basename "$target") exited with $code"
  exit "$code"
}

cmd_rollback() {
  local want="" restart=1 cur good prev label
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --no-restart) restart=0 ;;
      *) want=$1 ;;
    esac
    shift
  done
  cur=$(link_of current)
  good=$(link_of last-good)
  prev=$(link_of previous-good)
  if [ -n "$want" ]; then
    case "$want" in /*) ;; *) want="$ROOT/$want" ;; esac
  elif [ -n "$good" ] && [ "$good" != "$cur" ]; then
    want=$good
  else
    # `current` already is last-good: the owner wants the one before it.
    want=$prev
  fi
  if ! valid_release "$want"; then
    say "no known good release to go back to (asked for: ${want:-none})."
    say "the checkout is the fallback: git -C $(source_repo) checkout <good sha>, then launchctl kickstart -k gui/$(id -u)/$(cat "$ROOT/label" 2>/dev/null || echo com.example.jarvis)"
    return 1
  fi
  if [ -n "$good" ] && [ "$good" != "$want" ]; then set_link previous-good "$good"; fi
  set_link current "$want"
  set_link last-good "$want"
  note "ROLLBACK by hand: current and last-good are now $(basename "$want") (was $(basename "${cur:-none}"))"
  if [ "$restart" = 1 ]; then
    label=$(cat "$ROOT/label" 2>/dev/null || echo com.example.jarvis)
    # kickstart -k is immediate, no drain: this is the emergency path, and the
    # harness it would ask to drain may be the thing that is broken.
    launchctl kickstart -k "gui/$(id -u)/$label" || { say "launchctl kickstart failed; the supervisor will pick the release up on its next start"; return 1; }
    say "restarted $label on $(basename "$want")"
  fi
}

cmd_status() {
  local pid alive=no
  echo "root:          $ROOT"
  echo "source:        $(source_repo)"
  echo "current:       $(basename "$(link_of current)" 2>/dev/null)"
  echo "last-good:     $(basename "$(link_of last-good)" 2>/dev/null)"
  echo "previous-good: $(basename "$(link_of previous-good)" 2>/dev/null)"
  pid=$(cat "$ROOT/launcher.pid" 2>/dev/null || true)
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then alive=yes; fi
  echo "supervisor:    $alive"
  [ -f "$ROOT/rollback.json" ] && echo "last automatic rollback: $(cat "$ROOT/rollback.json")"
  echo "releases:"
  ls -1dt "$ROOT"/[0-9a-f]*/ 2>/dev/null | while read -r d; do
    d=${d%/}
    flags=""
    [ -f "$d/.ok" ] || flags="$flags unchecked"
    [ -f "$d/.bad" ] && flags="$flags BAD($(cat "$d/.bad"))"
    echo "  $(basename "$d")$flags"
  done
  echo "history (last 8):"
  tail -8 "$ROOT/history.log" 2>/dev/null | sed 's/^/  /'
}

cmd_install() {
  local label=com.example.jarvis src
  src=$(cd "$SCRIPT_DIR/.." && pwd)
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --label) label=${2:-}; shift ;;
      --source) src=${2:-}; shift ;;
    esac
    shift
  done
  [ -f "$src/src/index.ts" ] || { say "$src is not a checkout of the bot"; return 1; }
  mkdir -p "$ROOT/bin"
  cp "$SCRIPT_DIR/jarvis-release.sh" "$ROOT/bin/jarvis-release.sh"
  chmod 755 "$ROOT/bin/jarvis-release.sh"
  if [ -f "$SCRIPT_DIR/../launchd/com.example.jarvis.plist" ]; then
    cp "$SCRIPT_DIR/../launchd/com.example.jarvis.plist" "$ROOT/bin/jarvis.plist.template"
  fi
  echo "$src" > "$ROOT/source"
  echo "$label" > "$ROOT/label"
  note "installed the supervisor into $ROOT/bin for $label (source $src)"
  say "next: print the plist with  $ROOT/bin/jarvis-release.sh plist  and follow docs/releases.md"
}

cmd_plist() {
  local tpl label
  tpl="$ROOT/bin/jarvis.plist.template"
  [ -f "$tpl" ] || tpl="$SCRIPT_DIR/../launchd/com.example.jarvis.plist"
  [ -f "$tpl" ] || { say "no plist template found"; return 1; }
  label=$(cat "$ROOT/label" 2>/dev/null || echo com.example.jarvis)
  sed -e "s|__LABEL__|$label|g" -e "s|__RELEASES_DIR__|$ROOT|g" -e "s|__SOURCE_REPO__|$(source_repo)|g" "$tpl"
}

cmd=${1:-}
[ "$#" -gt 0 ] && shift
case "$cmd" in
  prepare) cmd_prepare "$@" ;;
  activate) cmd_activate "$@" ;;
  launch) cmd_launch "$@" ;;
  rollback) cmd_rollback "$@" ;;
  status) cmd_status "$@" ;;
  install) cmd_install "$@" ;;
  plist) cmd_plist "$@" ;;
  *)
    say "usage: jarvis-release.sh prepare|activate|launch|rollback|status|install|plist"
    exit 2
    ;;
esac
