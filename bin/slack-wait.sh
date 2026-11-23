#!/usr/bin/env bash
# Has anything new been said in this thread?
#
#   slack-wait.sh <channel> <thread-ts> <after-ts> [from-user-id]
#
# Exits 0 as soon as a reply newer than <after-ts> exists (optionally only one
# from a given person), 1 while there is nothing new, and 2 if the thread could
# not be read at all (the reason goes to stderr, where the watch runner logs it).
#
# This is what lets the bot wait for an ANSWER: another agent's investigation
# posted back into the thread, a colleague confirming a deploy, Amazon Q
# reporting a build. Without it, waiting on a person or another bot means
# ending the turn and hoping somebody prods it later.
#
# It reads only what is newer than <after-ts> (`oldest`) and follows the cursor
# through every page. conversations.replies is oldest first, so a plain read of
# one page of a thread over 200 messages never contained the newest replies and
# the watch answered "nothing new" until its deadline.
set -uo pipefail

here=$(cd "$(dirname "$0")" && pwd)
channel=${1:?channel}
thread=${2:?thread ts}
after=${3:?after ts}
from=${4:-}

# <thread-ts> may be a REPLY's ts (a link to a message inside a thread): Slack then
# returns just that one message, so the check would sit at exit 1 forever. Ask
# which thread it belongs to first and poll that root.
rootout=$("$here/slack-read.sh" root "$channel" "$thread" 2>/dev/null) || {
  echo "slack-wait: could not read the thread (slack-read.sh root failed)" >&2
  exit 2
}
root=$(printf '%s' "$rootout" | python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
    m = (d.get("messages") or [{}])[0]
    if not d.get("ok"):
        print("Slack said: %s" % d.get("error", "not ok"), file=sys.stderr)
        sys.exit(2)
    print(m.get("thread_ts") or m.get("ts") or sys.argv[1])
except SystemExit:
    raise
except Exception:
    print("unreadable answer from Slack", file=sys.stderr)
    sys.exit(2)
' "$thread") || exit 2
thread=$root

# A bound, not a target: 20 pages of 200 is 4000 new replies in one interval.
max_pages=20
cursor=""
page=0

while [ "$page" -lt "$max_pages" ]; do
  out=$("$here/slack-read.sh" replies-since "$channel" "$thread" "$after" $cursor 2>/dev/null) || {
    echo "slack-wait: could not read the thread (slack-read.sh replies-since failed)" >&2
    exit 2
  }
  # prints "hit" or "none <next-cursor>"; exits 2 when the page is not usable
  res=$(printf '%s' "$out" | python3 -c '
import json, sys
after = float(sys.argv[1])
who = sys.argv[2]
try:
    d = json.load(sys.stdin)
except Exception:
    print("unreadable answer from Slack", file=sys.stderr)
    sys.exit(2)
if not d.get("ok"):
    print("Slack said: %s" % d.get("error", "not ok"), file=sys.stderr)
    sys.exit(2)
for m in d.get("messages", []):
    try:
        ts = float(m.get("ts", 0))
    except (TypeError, ValueError):
        continue
    if ts <= after:
        continue
    if who and m.get("user") != who and m.get("bot_id") != who:
        continue
    # Something was said, and it was not the thread parent being re-read.
    print("hit " + m.get("text", "")[:300].replace("\n", " "))
    sys.exit(0)
print("none " + ((d.get("response_metadata") or {}).get("next_cursor") or ""))
' "$after" "$from") || exit 2
  case "$res" in
    hit*) printf '%s\n' "${res#hit }"; exit 0 ;;
  esac
  cursor=${res#none }
  [ -n "$cursor" ] || exit 1
  page=$((page + 1))
done
echo "slack-wait: gave up after $max_pages pages of replies" >&2
exit 2
