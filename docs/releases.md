# Releases: immutable, health-checked, with a way back

How a merged change reaches the running bot, and how to get back to a working
one when it does not work. `bin/jarvis-release.sh` is the whole mechanism;
this file is what to do with it.

## Why

`bin/jarvis-restart.sh` used to run the checks on the live checkout after a
`git pull`. Two things followed:

- a refusal left the live copy on the new commit and there was no last known
  good build to point at
- the only way back ran through the pipeline that had just shipped the broken
  thing: the agent, the merge script, CI. A broken bot cannot fix itself

## The model

One folder per commit under `JARVIS_RELEASES_DIR` (default
`~/.jarvis/releases`):

```
<root>/<sha>/        plain export of that commit (no .git), deps installed,
                     dashboard built; .env, data and logs link to the checkout
<root>/current       the release the supervisor starts
<root>/last-good     the newest release that answered /health after a start
<root>/previous-good the one before that
<root>/bin/          the supervisor and the plist template, a copy OUTSIDE the repo
<root>/history.log   one line per event; rollback.json = the last automatic rollback
```

The checkout (`JARVIS_SOURCE_REPO`) stays the home of everything that is not
code: `.env`, the databases, `data/`, `logs/`, and the place where the self-fix
flow pulls and the restart helper runs. A release folder never holds state.

**Restart** (`jarvis-restart.sh`, unchanged for the caller): export HEAD into
`<root>/<sha>`, install, then typecheck, tests and the dashboard build INSIDE
that folder. Any of them red refuses (exit 1) and `current` does not move, so
the running bot is exactly what it was. All green: `current` points at the new
folder and the bot is asked to drain and exit, as before (same drain, same
15 minute cap).

**Health gate** (`jarvis-release.sh launch`, what launchd runs): it starts the
bot from `current`. A release that is not last-good yet must answer
`GET /health` with `ok: true` (dashboard up, Slack heard, not draining) within
`RELEASE_HEALTH_TIMEOUT_S` (180). Pass: it becomes last-good. Fail, or the bot
exits first: the supervisor stops it, marks the folder `.bad` (a `.bad` release
is never started or rebuilt again), points `current` back at last-good, writes
`rollback.json`, and exits so `KeepAlive` starts the last known good one. No
agent, merge script or CI is involved. The first run after the install, with no
release yet, starts the checkout itself and is not gated (there is nothing to go
back to).

**A refusal is a rollback now.** Red checks leave the running release in place;
a release that builds but does not come up is undone by the supervisor.

## The way back by hand

```sh
~/.jarvis/releases/bin/jarvis-release.sh rollback            # to last-good (or, when that is what runs, to previous-good)
~/.jarvis/releases/bin/jarvis-release.sh rollback <sha>      # to a release you name
~/.jarvis/releases/bin/jarvis-release.sh rollback --no-restart
~/.jarvis/releases/bin/jarvis-release.sh status              # what runs, what is good, what happened
```

It needs bash, `ln` and `launchctl`: not the bot, not bun, not the repo (it runs
from the copy under `<root>/bin`), not the network. It repoints `current` and
`last-good` and does `launchctl kickstart -k`, which is immediate and does NOT
drain: it is the emergency path, and the harness a drain would ask may be the
broken part. Turns running at that moment are cut and picked up again from the
inbox, as after any restart.

Last resort when no release is known good: `git -C <checkout> checkout <good
sha>` and `launchctl kickstart -k gui/$UID/<label>`. With no valid release link
the supervisor runs the checkout itself.

## One-time install (the owner, by hand)

The LaunchAgent lives outside the repo, so this is a manual step. The bot keeps
running the old way until it is done; nothing breaks if it waits.

1. Install the supervisor outside the repo (use your real label, the one in
   `launchctl list | grep jarvis`):

   ```sh
   cd <checkout>
   bin/jarvis-release.sh install --label <label> --source <checkout>
   ```

2. Print the plist for this host and compare it with the one in
   `~/Library/LaunchAgents/<label>.plist`:

   ```sh
   ~/.jarvis/releases/bin/jarvis-release.sh plist > /tmp/<label>.plist
   diff /tmp/<label>.plist ~/Library/LaunchAgents/<label>.plist
   ```

   Only `ProgramArguments` must change: it becomes `/bin/bash`,
   `~/.jarvis/releases/bin/jarvis-release.sh` (absolute), `launch`.
   `WorkingDirectory` stays the checkout. Keep your own
   `EnvironmentVariables` (the template only has `PATH`) and log paths. Edit
   the existing plist, or copy the rendered one over it after adding what is
   yours.

3. Reload it. This restarts the bot once, without the drain; do it when idle:

   ```sh
   launchctl bootout gui/$UID/<label>
   launchctl bootstrap gui/$UID ~/Library/LaunchAgents/<label>.plist
   ```

4. Check: `~/.jarvis/releases/bin/jarvis-release.sh status` says
   `supervisor: yes`. From then on `jarvis-restart.sh` builds releases. The
   first merged change after this creates the first release; the one after it is
   the first with a last-good to fall back to.

After changing `bin/jarvis-release.sh` itself, run `install` again: the running
supervisor is the copy, on purpose, so a bad commit cannot change it.

The gateway's plist does not change.

## Settings

| Variable | Default | |
| --- | --- | --- |
| `JARVIS_RELEASES_DIR` | `~/.jarvis/releases` | the release store (script and bot) |
| `JARVIS_SOURCE_REPO` | the supervisor sets it | the checkout; the bot then runs from a release and works on this one |
| `RELEASE_HEALTH_TIMEOUT_S` | 180 | how long a new release may take to report healthy |
| `RELEASE_HEALTH_POLL_S` | 2 | health probe interval |
| `RELEASES_KEEP` | 5 | releases kept besides current, last-good, previous-good |

The probe reads `DASHBOARD_PORT` from the environment, else from the
checkout's `.env`, else 2001.

## Not done here

- a Slack button that triggers the rollback. The gateway never restarts and
  would be the right host, but it holds only the socket and the inbox on
  purpose, and a button it cannot trust the bot to have posted needs its own
  owner check. The script can be the thing a button calls later
- a health check that waits out a long drain: the check starts when the new
  process starts, after the drain
