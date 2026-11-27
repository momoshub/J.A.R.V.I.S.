#!/usr/bin/env bash
# Merge a PR only once CI is green on the exact commit you pushed.
#
#   merge-when-green.sh <pr> [timeout-seconds]     (run from the PR's worktree)
#
# The repo is private on a free plan, so GitHub cannot require a passing check
# before a merge. This is the gate instead. It takes the commit to merge from
# `git rev-parse HEAD` (or MERGE_HEAD_SHA), waits until the PR's head IS that
# commit, waits for the CI check (REQUIRED_CHECK, default `checks`) to appear -
# a fast third-party check passing alone is not CI - and for every check to
# finish, then merges (merge commit) pinned to that commit, so a push that
# lands meanwhile is never merged unchecked. Any failed or cancelled check, or
# the timeout -> no merge, exit non-zero.
#
# It also reads the PR's mergeability (`mergeable`, `mergeStateStatus`) on every
# poll. A PR that conflicts with its base (CONFLICTING / DIRTY) gets no CI run
# from GitHub at all, so waiting is pointless: it says so and exits 4 at once -
# merge the base in, resolve, push, run it again. UNKNOWN means GitHub is still
# computing it: keep polling, and never merge until it is known.
#
# Right before the merge it approves the PR (`gh pr review --approve`) as the
# merging account, so the PR carries a real "Approved" review, not only review
# comments. GitHub refuses to approve a closed PR, hence before, not after. It
# is skipped (one line) when the merging account opened the PR - GitHub forbids
# approving your own PR, so a one-account setup still merges - and when that
# account's latest approve/request-changes review is already an approval of this
# exact head: the standalone reviewer posts that approval itself as the same
# account, and a rerun after exit 3 finds its own. A later request-changes, or a
# dismissed approval, does not count. A failed approval stops the merge (exit 1).
#
# THE BOT DECIDES. When this shell holds a ticket (JARVIS_RUN_TICKET, or
# JARVIS_RUN_TICKET_FILE for an Orca worker) that names `merge-gate`, the merge is
# not made here at all: the script asks the bot (`github-app.sh merge-gate`) and
# the bot merges, with the app's own credential, only if the PR head is this
# commit, the required checks are green on it and, for runtime code, the latest
# review is `VERDICT: clean` and a `[verify]` comment says `VERDICT: verified`
# naming it. The writer's shell then needs no merge token. The bot answers
# merged (exit 0), pending (poll again), conflict (exit 4), refused (the reasons,
# exit 1) or disabled (the bot's MERGE_GATE is off): only `disabled`, or no ticket
# at all, runs the old path below with the human `gh` login. Remove that login
# from the host and the old path has nothing to merge with.
#
# The default timeout stays under the 10 minute ceiling of a foreground tool
# call; give that call a timeout to match. Exit codes: 0 merged, 1 red CI, a refused
# gate or a failed approval, 2 usage, 3 "not finished yet" (run it again), 4 the PR
# conflicts with its base (resolve first, rerunning alone never helps).
set -uo pipefail

PR=${1:-}
TIMEOUT=${2:-540}
INTERVAL=${MERGE_POLL_SECONDS:-15}
REQUIRED=${REQUIRED_CHECK:-checks}
[ -n "$PR" ] || { echo "usage: merge-when-green.sh <pr> [timeout-seconds]" >&2; exit 2; }
SHA=${MERGE_HEAD_SHA:-$(git rev-parse HEAD 2>/dev/null)}
[ -n "$SHA" ] || { echo "cannot tell which commit to merge: run it from the PR's worktree" >&2; exit 2; }

# The gate: ask the bot until it merges, refuses, sees a conflict, or time is up.
# Returns 10 when the bot's gate is off (use the old path); anything else is final.
GITHUB_APP_SH=${GITHUB_APP_SH:-$(dirname "$0")/github-app.sh}
gate() {
  local repo answer decision reasons dl why=""
  repo=${MERGE_REPO:-$(git remote get-url origin 2>/dev/null | sed -E -e 's#\.git$##' -e 's#^.*github\.com[:/]##')}
  [ -n "$repo" ] || { echo "cannot tell which repository this is: set MERGE_REPO=owner/name" >&2; return 1; }
  [ ${#SHA} -eq 40 ] || { echo "the merge gate needs the full head sha, got '$SHA'" >&2; return 1; }
  dl=$(( $(date +%s) + TIMEOUT ))
  while :; do
    answer=$("$GITHUB_APP_SH" merge-gate "$repo" "$PR" --sha "$SHA" 2>&1)
    decision=$(printf '%s' "$answer" | jq -r '.github.decision // empty' 2>/dev/null)
    reasons=$(printf '%s' "$answer" | jq -r '(.github.reasons // [])[]' 2>/dev/null)
    case "$decision" in
      merged)
        echo "merged by the bot: $(printf '%s' "$answer" | jq -r '.github.mergedSha // .github.sha')"
        return 0
        ;;
      disabled)
        echo "the bot's merge gate is off (MERGE_GATE): using the human token" >&2
        return 10
        ;;
      conflict)
        echo "PR $PR conflicts with its base, merge the base in and resolve first - not merging" >&2
        return 4
        ;;
      refused)
        echo "the merge gate refused PR $PR:" >&2
        printf '%s\n' "$reasons" >&2
        return 1
        ;;
      pending) why=$(printf '%s' "$reasons" | paste -sd ';' - | sed 's/;/; /g') ;;
      *)
        echo "the merge gate gave no usable answer for PR $PR - not merging:" >&2
        printf '%s\n' "$answer" | head -c 600 >&2
        echo >&2
        return 1
        ;;
    esac
    if [ "$(date +%s)" -ge "$dl" ]; then
      echo "not merged within ${TIMEOUT}s: ${why:-pending}. run it again" >&2
      return 3
    fi
    sleep "$INTERVAL"
  done
}

lower() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }

# Approve the PR as the merging account, unless that account opened it or
# already approved this head. Returns non-zero (with the reason on stderr) when
# an approval was due and did not land.
approve() {
  local me author approved
  me=$(gh api user -q .login 2>/dev/null)
  author=$(gh pr view "$PR" --json author -q .author.login 2>/dev/null)
  if [ -z "$me" ] || [ -z "$author" ]; then
    echo "cannot tell who merges (${me:-?}) or who opened PR $PR (${author:-?}) - not merging" >&2
    return 1
  fi
  if [ "$(lower "$me")" = "$(lower "$author")" ]; then
    echo "approval skipped: $me opened PR $PR and GitHub forbids approving your own PR"
    return 0
  fi
  approved=$(gh pr view "$PR" --json reviews 2>/dev/null |
    jq -r --arg me "$(lower "$me")" --arg sha "$SHA" \
      '[.reviews[]? | select(((.author.login // "") | ascii_downcase) == $me and (.state == "APPROVED" or .state == "CHANGES_REQUESTED" or .state == "DISMISSED"))] | last | (.state == "APPROVED" and .commit.oid == $sha)' 2>/dev/null)
  if [ "$approved" = "true" ]; then
    echo "already approved by $me on ${SHA:0:7}"
    return 0
  fi
  if ! gh pr review "$PR" --approve --body "Approved: standalone review clean, CI green (${SHA:0:7})"; then
    echo "approving PR $PR as $me failed - not merging" >&2
    return 1
  fi
  echo "approved by $me on ${SHA:0:7}"
}

why=""
if [ -n "${JARVIS_RUN_TICKET:-}${JARVIS_RUN_TICKET_FILE:-}" ]; then
  gate
  rc=$?
  [ "$rc" -eq 10 ] || exit "$rc"
fi

deadline=$(( $(date +%s) + TIMEOUT ))
while :; do
  head=$(gh pr view "$PR" --json headRefOid -q .headRefOid 2>/dev/null)
  if [ "$head" != "$SHA" ]; then
    why="PR head is ${head:-unknown}, waiting for $SHA (pushed?)"
  else
    mergeability=$(gh pr view "$PR" --json mergeable,mergeStateStatus -q '"\(.mergeable) \(.mergeStateStatus)"' 2>/dev/null)
    case " $mergeability " in
      *" CONFLICTING "* | *" DIRTY "*)
        echo "PR $PR conflicts with its base, merge the base in and resolve first - not merging" >&2
        exit 4
        ;;
    esac
    out=$(gh pr checks "$PR" --json name,bucket 2>&1)
    if ! printf '%s' "$out" | jq -e 'type == "array"' >/dev/null 2>&1; then
      if printf '%s' "$out" | grep -qi "no checks reported"; then
        why="no checks reported yet"
      else
        echo "cannot read the checks of PR $PR - not merging:" >&2
        printf '%s\n' "$out" >&2
        exit 1
      fi
    else
      bad=$(printf '%s' "$out" | jq -r '.[] | select(.bucket == "fail" or .bucket == "cancel") | "\(.name): \(.bucket)"')
      if [ -n "$bad" ]; then
        echo "CI is not green on PR $PR - not merging:" >&2
        printf '%s\n' "$bad" >&2
        exit 1
      fi
      if ! printf '%s' "$out" | jq -e --arg n "$REQUIRED" 'any(.[]; .name == $n)' >/dev/null; then
        why="check '$REQUIRED' has not appeared yet"
      elif printf '%s' "$out" | jq -e 'any(.[]; .bucket == "pending")' >/dev/null; then
        why="checks still running"
      elif [ "${mergeability%% *}" != "MERGEABLE" ]; then
        why="GitHub has not worked out yet whether PR $PR merges cleanly (${mergeability:-unknown})"
      else
        printf '%s' "$out" | jq -r '.[] | "\(.name): \(.bucket)"'
        approve || exit 1
        exec gh pr merge "$PR" --merge --match-head-commit "$SHA"
      fi
    fi
  fi
  if [ "$(date +%s)" -ge "$deadline" ]; then
    echo "not merged within ${TIMEOUT}s: $why. run it again" >&2
    exit 3
  fi
  sleep "$INTERVAL"
done
