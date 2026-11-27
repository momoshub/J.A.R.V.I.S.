#!/usr/bin/env bash
# Verify the bot's own source, then ask it to restart into the change.
#
#   jarvis-restart.sh [--check-only]
#
# The restart is NOT done here. A `launchctl kickstart` from inside a turn kills
# the turn that asked for it, so the reply never lands. Instead this asks the
# running bot, over loopback, to exit once it is idle - after its reply has
# posted and no turn is running in any thread - and launchd brings it back.
# While it waits it takes no new work (messages queue in the inbox), and past
# 15 minutes it exits anyway; the turns it cut are picked up again after.
#
# Typecheck and tests both have to pass. Restarting into code that does not
# compile means crash-looping every fifteen seconds with no way back from Slack.
# The dashboard bundle (web/dist) is rebuilt too: it is not committed and the
# bot serves it as built, so a stale one breaks every page whose API changed.
# --check-only builds it into a throwaway folder, leaving the live one alone.
#
# Under the release supervisor (bin/jarvis-release.sh, see docs/releases.md) the
# checks run on an immutable per-commit copy of HEAD, NOT on the live checkout,
# and `current` only moves to that copy once all three passed. A refusal leaves
# the running release exactly where it was; the supervisor health-checks the new
# one after the restart and goes back to the last known good one by itself.
# Without the supervisor (no launcher.pid) it checks the checkout in place, as before.
set -uo pipefail

REPO=${JARVIS_SOURCE_REPO:-${JARVIS_REPO:-$(cd "$(dirname "$0")/.." && pwd)}}
PORT=${DASHBOARD_PORT:-2002}
RELEASES=${JARVIS_RELEASES_DIR:-$HOME/.jarvis/releases}
RELEASE_SH="$RELEASES/bin/jarvis-release.sh"
[ -x "$RELEASE_SH" ] || RELEASE_SH="$(cd "$(dirname "$0")" && pwd)/jarvis-release.sh"
cd "$REPO" || { echo "cannot enter $REPO" >&2; exit 2; }

supervised=""
pid=$(cat "$RELEASES/launcher.pid" 2>/dev/null || true)
if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then supervised=1; fi

# The reason is shown to anyone who writes in while it waits, so name the
# change: the PR number off the last merge, plus the newest real commit subject.
pr=$(git log -1 --merges --format=%s 2>/dev/null | sed -n 's/^Merge pull request \(#[0-9]*\).*/\1 /p')
subject=$(git log -1 --no-merges --format=%s 2>/dev/null)
reason="picking up ${pr}${subject:-a change}"

release=""
if [ -n "$supervised" ]; then
  sha=$(git rev-parse HEAD 2>/dev/null) || { echo "REFUSING TO RESTART: $REPO is not a git checkout" >&2; exit 1; }
  if [ -n "$(git status --porcelain --untracked-files=no 2>/dev/null)" ]; then
    echo "note: uncommitted changes in $REPO are NOT part of the release (it is built from $sha)" >&2
  fi
  echo "== release ${sha:0:12} (built outside the live checkout)"
  release=$("$RELEASE_SH" prepare "$sha") || { echo "REFUSING TO RESTART: could not prepare release $sha" >&2; exit 1; }
  cd "$release" || { echo "cannot enter $release" >&2; exit 2; }
fi

echo "== typecheck"
if ! bun run typecheck; then
  echo "REFUSING TO RESTART: typecheck failed" >&2
  exit 1
fi

echo "== tests (queues behind any other full bun test on this host, see bunfig.toml)"
if ! bun test; then
  echo "REFUSING TO RESTART: tests failed" >&2
  exit 1
fi

if [ "${1:-}" = "--check-only" ]; then
  echo "== dashboard build (throwaway, --check-only)"
  out_dir=$(mktemp -d "${TMPDIR:-/tmp}/jarvis-web.XXXXXX")
  (cd web && bun install && bun x vite build --outDir "$out_dir" --emptyOutDir)
  built=$?
  rm -rf "$out_dir"
  if [ "$built" -ne 0 ]; then
    echo "dashboard build failed" >&2
    exit 1
  fi
  echo "checks passed; not restarting (--check-only)"
  exit 0
fi

echo "== dashboard build"
if ! bun run build:web; then
  echo "REFUSING TO RESTART: dashboard build failed" >&2
  exit 1
fi

if [ -n "$release" ]; then
  # Checks passed on the copy. Only now does `current` move; last-good stays put
  # until the supervisor has seen the new release answer /health.
  "$RELEASE_SH" activate "$sha" || { echo "REFUSING TO RESTART: could not activate release $sha" >&2; exit 1; }
fi

payload=$(REASON="$reason" bun -e 'console.log(JSON.stringify({ reason: process.env.REASON }))')

echo "== asking the bot to restart ($reason)"
out=$(curl -s --max-time 10 -X POST "http://127.0.0.1:${PORT}/api/restart" \
  -H 'content-type: application/json' -d "$payload")
if printf '%s' "$out" | grep -q '"ok":true'; then
  echo "checks passed; restarting once idle (reply lands first, new messages queue, running turns get up to 15 min, then are cut and picked up again)"
  if [ -n "$release" ]; then
    echo "the supervisor health-checks release ${sha:0:12} after the restart and returns to the last known good one by itself if it fails: $RELEASE_SH status"
  fi
else
  echo "checks passed, but the restart request failed: $out" >&2
  exit 1
fi
