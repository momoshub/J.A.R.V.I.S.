# Architecture

The bot runs as two processes on one host, a Slack gateway and the bot itself,
joined by a SQLite inbox. Inside the bot the code follows a clean, layered
architecture: dependencies point inward, outer layers know about inner ones,
never the reverse. Every layer is functional - factories and pure functions,
no classes.

## Runtime

```
      Slack (Socket Mode)                          GitHub
            |   ^                                    ^ |
  envelopes |   | replies (Web API, chat.startStream)| | review requests (polled)
            |   |                                    | | App webhook (Funnel ->
            |   |                                    | | 127.0.0.1:2003)
            v   |                                    |
  +-----------------+                                |
  | src/gateway.ts  |  holds the socket, never       |
  | (own supervisor)|  restarts                      |
  +-----------------+                                |
            |                                        |
            v                                        |
       INBOX_DATABASE_PATH (SQLite queue)      |
            |                                        |
  +---------v--------------------------------------------------------------+
  | src/index.ts - the bot (SLACK_TRANSPORT=inbox)                          |
  |                                                                         |
  |  inboxReceiver -> Bolt app.ts -> respond -+-> commands (role gate,      |
  |                                           |     allowance, audit log)   |
  |                                           +-> handleMessage (chat)      |
  |                                                    |                    |
  |                    threadQueue (1 turn per thread, queued messages merge) + runRegistry (stop) |
  |                                                    |                    |
  |                    LlmPort: claude CLI, one --resume session per thread |
  |                    tool policy per role, stream.ts -> live Slack reply  |
  |                                                                         |
  |  timers, outside every turn:                                            |
  |    watcher | reminders | loops | reviewInbox | workflow continues | ...  |
  |    orcaQuestions (worker questions -> the thread that started it)      |
  |    offlineAlarm (keeps an "I'm offline" Slack scheduled msg armed)     |
  |    stuckSweeper (dead Orca workers, quiet own PRs -> owner DM, 15 min)  |
  |    idleReaper (closes finished, idle Orca worker sessions, 30 min)      |
  |    stalePromiseSweep (steers a thread whose last bot message promised   |
  |      work nothing is doing, 15 min)                                     |
  |    coordinator (owner-DM housekeeping: journeys, tickets, watches, PRs, |
  |      one daily digest message, 30 min)                                  |
  |                                                                         |
  |  dashboard + JSON API (Bun.serve, loopback), /api/commands/run,         |
  |    /api/github-app/comment, /api/slack/proxy + /api/slack/file          |
  |    (the only door from a turn to the bot's Slack token, ticketed)       |
  |  GitHub App webhook listener (loopback, own port) -> githubApp          |
  +-------------------------------------------------------------------------+
            |                                   |
            v                                   v
   DATABASE_PATH, TOKEN_DATABASE_PATH    bin/ helpers the brain calls
   (outside the checkout, ~/.jarvis),   (slack-api, slack-read, run, ...)
   data/adapter-mirror/ (from DB),      bin/db-backup.ts -> DATABASE_BACKUP_DIR
   data/prompt-guides/ (from code)
```

- **The live databases are outside git.** `DATABASE_PATH` and
  `TOKEN_DATABASE_PATH` point outside the checkout, because a git operation that
  replaces a file under an open SQLite handle crashes the bot. A path may be moved
  once with `DATABASE_MIGRATE_FROM` / `TOKEN_DATABASE_MIGRATE_FROM`:
  `adoptDatabase` (`infrastructure/db/location.ts`) fills a missing (or empty) destination
  with a `VACUUM INTO` snapshot at boot, never overwrites a database with tables,
  and fails closed (throws) when the source is configured but missing. `bin/db-backup.ts`
  is the backup (snapshots into `DATABASE_BACKUP_DIR`, optionally committed to a
  repo of its own).
- **Gateway / bot split.** `src/gateway.ts` only holds the Slack socket and
  writes every envelope to the inbox DB (`INBOX_DATABASE_PATH`). The bot reads it through
  `inboxReceiver`, a Bolt receiver, so every listener in `app.ts` runs exactly
  as it would over Socket Mode. Restarting the bot never drops Slack. With
  `SLACK_TRANSPORT=socket` (the default) the bot holds the socket itself and no
  gateway is needed.
- **One turn per thread, one session per thread.** `threadQueue` serialises
  turns in a thread, and merges what one person types while a turn runs into a
  single turn when it ends (`coalesce`; bot-started turns never merge, stop hits
  only the running turn); `threadSession` keeps one CLI session id per thread and
  resumes it, so the model keeps its context and files between turns. Sessions
  never mix: what one thread needs another to know crosses as a `brief` (a
  short note written for the target, stored in `thread_briefs` by migration
  v34, handed to that thread's next turn inside the turn's MESSAGE so it stays
  in the resumed session's transcript, as untrusted background and never as
  instructions; read state is per access tier and set only once the turn ran).
  Linked threads: an owner's cross-thread write through the Slack proxy (or `post`) files that brief by itself and opens a one-way link in `thread_relays` (migration v44); while it is fresh (7 days since the last write) a human message that the Slack intake marked as typed by a person and that reaches the bot in the target thread (never a turn the bot builds itself) is filed back to the writing thread as a relay brief (who wrote, a cut quote), with no turn and no Slack post. The target keeps its own session and role; only the brief text crosses, and everything that crosses is untrusted data.
  `runRegistry` holds a handle on each running turn so it can be stopped, by its own actor or an admin/owner (`mayStopRun`), through the `stop` command or Slack's own stop button (`agent_session_stopped`, same rule).
- **A turn holds no secret.** The CLI is spawned with the bot's environment
  minus every credential-shaped variable (`domain/turnEnv.ts`: by name -
  `*_TOKEN`, `*_SECRET`, `*_API_KEY`... - except the CLI's own
  `CLAUDE_CODE_OAUTH_TOKEN` and what `TURN_ENV_PASSTHROUGH` names; a turn the owner's own message started holds an owner ticket (`ownerTickets`) instead of the token and runs on the host login with the claude.ai connectors), because a
  turn's Bash is driven by a model that reads untrusted text. What a turn needs
  from Slack goes through `bin/slack-api.sh`: it presents the turn's
  `JARVIS_SLACK_TICKET` (`slackTickets`, minted when the process starts and
  revoked when it exits, no actor and no role, only an owner bit, set when the owner's own message started the turn (a tagged or DM message, or an untagged one in a followed thread that only the owner wrote, `typedByActor`), never for a run merely billed to them such as the dashboard draft) to `POST /api/slack/proxy`, where
  `slackProxy` checks the ticket, applies the method allowlist
  (`domain/slackProxy.ts`: a fixed set of reads, and writes only into the
  turn's own channel, plus the methods the owner added with `slack-methods`,
  kept in the `slack_extra_methods` setting and passed in per call, never below
  the built-in floor; a new post from a turn in a thread defaults to that
  thread, `thread_ts=none` posts at the top level; `chat.update` on a message
  the bot stored as an approval notice is refused, looked up in the database
  with `db/noticeLookup.ts`) and calls Slack with the
  token it holds. In an owner's turn only, every channel-scoped write (`chat.postMessage`, `files.completeUploadExternal`,
  `reactions.add` and the writes the owner added with `slack-methods`) may name another channel (by channel id,
  never a user id) and thread, and `chat.update` may also target a message in
  another channel, and only when the bot reads it back (`conversations.history`, else
  `conversations.replies`) and finds its own user id as the author; anything else
  there is refused, and the call is logged with the channel and ts. A turn a `watch` fired is not an owner's turn, but a watch the owner created in their own turn carries a grant instead (`domain/writeTargets.ts`): `chat.postMessage`, `reactions.add` and `files.completeUploadExternal` may name another channel only when it is one of the targets that turn named (`watch --to`, a link or channel in the request or in the owner's message), a thread target holds the write to that thread, everything else is refused as in any non-owner turn, and a grant write is logged with the watch id. A fired watch turn that sets the next watch (a re-arm) inherits that grant as a subset (`watchGrant` on the command ticket, `watches.parent_watch_id` for the audit trail): the same targets or fewer, `--to` can only narrow, text adds nothing, never the owner bit, and the chain as a whole never outlives one watch's 30 days (counted from its first watch) nor fans out past 5 waiting children per fired watch. The command door is shut the same way: the command ticket of a turn a watch fired says so (`watch: true`), and the run bridge refuses every owner-only command in it (`firedByWatch` in `dispatchCommand`). A post or update that lands in the turn's own thread is also
  noted per turn (`selfPosts`, keyed by the turn's run ticket carried on the Slack
  ticket, with the plain text length of each post, refreshed by a `chat.update` of it) and the answer handed back carries a `jarvis_note` saying the closing reply
  will be dropped if that post is the answer, and how to add something (`chat.update` the post and fold the
  later part in; a `KEEP_REPLY` line in the closing reply replaces the turn's single
  text post). The Slack handler then sends no closing reply for that turn unless it
  carries the marker (`domain/selfPost.ts`); the drop is logged with thread and
  length. The footer the closing reply would have carried goes on the turn's last own post instead (`footSelfPost`: read back, `chat.update` with its blocks kept and `jv_footer` last, skipped when one is there; a failure is only logged). The closing reply is not streamed live either: once the turn has a post, the stream
  (`bufferText` in `slack/stream.ts`, fed by the turn's run ticket through `onRunTicket`) stops
  showing text and holds it back until the end-of-turn decision, so nothing is shown only to be
  deleted; text that streamed before the first post stays until that tidy-up. One exception keeps the answer from vanishing: when EVERY post of the turn is a
  progress line (plain, at most `PROGRESS_POST_MAX_CHARS` = 280 chars, and under 1/`PROGRESS_REPLY_RATIO`
  = half of the closing reply's length, `isProgressPost`), the reply is kept as if it carried
  the marker (logged `closing reply kept, the turn's own posts were progress lines`). One
  rich, answer-sized or unknown-length post keeps the drop (a post's length is its `text`, else `markdown_text`; neither means unknown). Known trade-off: a short real answer post followed by a reply more than twice as long that is only meta is read as progress, and with a single post the reply then replaces it. With the marker (or that implicit keep) and exactly one plain text post of the turn (no blocks or
  attachments, no upload, `replaceableSelfPost`) the reply is written onto that post
  with `chat.update` (footer included) and the stream messages go, so one ask stays
  one message; with several posts, a rich post, an upload or a refused update it is
  sent as a message of its own. The marker is never shown, with or without a
  self-post: it is filtered from the live stream (`createKeepMarkerFilter`, own line or closing token), stripped
  from the closing reply and from every text the tidy-up writes. The proxy also strips it
  (own line or closing token) from the `text` and `blocks` of a turn's own
  `chat.postMessage` / `chat.update` (`stripKeepMarkerFromCall`), and refuses a
  call that would be empty without it (`no_text`). Files go through
  `/api/slack/file`. `slack-read`, `slack-react`, `slack-file` and `slack-upload`
  are built on it.
- **Commands from the brain.** The brain runs real commands through
  `bin/jarvis-run.sh` -> `/api/commands/run`. `commandTickets` mints a one-turn
  ticket bound to the person being answered, so the brain never names the actor
  and cannot escalate. `brainRun` delivers the result per the command's output
  mode (`quiet` comes back to the brain, the rest is posted to the thread). A
  handed-off command that later fails says so in the thread, not only in the log.
- **Timers.** `watcher` polls each due watch's predicate and hands the thread a
  fresh turn when it is ready (a watch the owner created in their own turn (`watches.created_by`, `watches.write_targets`) hands the turn its write targets as a scoped grant on the Slack ticket, see the proxy paragraph above; a watch lasts up to 30 days: the 10s tick compares the clock to the stored `deadline_at`, never a `setTimeout`, so a long deadline cannot overflow; one that runs its full 30 days is expired with one last line and not re-armed; `watch worker <dispatchId>` polls an Orca worker
  through `bin/orca-worker-wait.ts` and says whether it finished, died - also
  when it stopped without reporting - or waits for input, or sits idle at its prompt for 15 minutes with no report - a finished or dead worker's hand-back also names the tokens
  and list-price cost its Claude transcript used, stored in
  `orca_worker_usage`, read later with `worker-cost <ctx_...|run_...>`; a worker is started only after `bin/worker-mcp-trim.ts --role <role>` has written `WORKER_MCP_DENY` as `deniedMcpServers` and the role's tool rules (`permissions.allow` / `deny`: a reviewer or investigator cannot edit, push or merge, a writer cannot merge by hand) into the role's own worker home (`$BOT_WORKER_HOME-<role>`, next to `WORKER_HOME_DIR`, a folder only workers use, registered with Orca by the helper) `.claude/settings.local.json`, because a session reads that once at start and Orca has no per-launch way to pass it - `domain/workerMcp.ts`, `domain/workerRoles.ts`; a worker ends with a fenced `worker-report` JSON block that the hand-back reads as fields and flags as the worker's claim - `domain/workerReport.ts`);
  `reminders` posts at the time with no model;
  `loops` (`application/loops.ts`, `db/loopRepo.ts`, `domain/loop.ts`, `loop` command) fires a recurring schedule (every loop carries a name - `--name`, else the first words of its prompt, `loop rename` later - and every message about it reads `<name> - loop #<id>`, with a ` · created here` link back to the Slack message that created it, from `origin_ts`): a prompt loop hands a turn through the watcher's own `runTurn` (so there is one way to wake a thread), as the creator and silent unless it has something to say: the turn runs first under a made-up thread in the creator's DM (nothing posted, no header), and only a real reply is posted, as one top-level DM (`🔁 <name> - loop #id` header + reply) with the session (and any watch or reminder the turn set) moved onto it so a reply there resumes it, on the `loop` model (Sonnet) rather than the creator's role model (`loop: true` on the request -> `model` on the inbound message -> the policy's model); a script loop (`-- <shell>`) is never typed: only the owner's own turn can write one, it is stored pending and DMed to the owner with Approve / Reject `jv:loop:` buttons (`loopApproval.ts`, decided in code like `jv:cloudwatch:`), and only Approve activates it (Reject or 24h of silence deletes it); once active it runs through the watcher's shell runner with no turn, and only a failure posts, to the same DM. A loop is always moved on from now before it fires, so a run missed while down happens once on startup, never as a backlog; a creator who lost the role stops the loop;
  a `watches` row whose check is `ci-gate:{...}` is not shell and hands back no
  turn: `watcher` calls `application/ciGate.ts` instead, which polls the PR's
  checks once a minute and approves or requests changes itself (the CI gate of
  `quick-review`, deadline one hour; see "CI comes first" in the README);
  `reviewInbox` polls GitHub for review requests of the host's own account and
  hands each to `autoReview`, which opens the PR's one Slack thread in the
  review inbox channel and runs the quick review in it on the requester's token
  (a request to the GitHub App arrives on its webhook and takes the same road,
  answered as the app; the approval is always the host account's, see
  "Reviews that start by themselves" in CLAUDE.md; with `review_auto` off the
  inbox only announces); `reviewRounds` follows every PR a quick review finished
  on (a row per PR in `review_rounds`: reviewed head, round, asker, identity,
  thread) and polls it once a minute: a new head that stays still for two minutes
  gets the next round by itself, in the same thread on the same asker's token,
  reviewing the delta since the last reviewed head; it stops on merge or close,
  after the round cap and after an idle week (see "Review rounds" in CLAUDE.md); `orcaQuestions` reads the Orca mailbox of every Run a thread
  started a worker in (linked from the turn's tool trace as `worker-start`
  prints it) and hands each question a worker is still blocked on to that
  thread as a turn that answers it with `orca orchestration reply`, once per
  question (`orca_questions`; in a workflow thread on the worker's lane via
  `workerLane`, since the front cannot run `orca`); `workflowContinue` resumes long workflows after a restart;
  `learningHarvest` (off unless `learning_harvest` is on) reviews recent person-written turns every 30 minutes on a small model and PROPOSES facts (through `learningApproval`) and skill drafts (`skill_drafts`, its own Approve / Reject DM, written through `editAdapterFile` on approval): only public-channel turns a person typed (`turn_log.typed`) are reviewed and every proposal must quote that person's own words, a daily cap and dedupe bound it, and nothing is saved without the owner's press;
  `innerChild` watches the bot's own conversations (triage on a small model every 30 minutes) and queues fixes to itself - run only when `inner_child_autofix` is on, never files from or fixes a thread whose bug report the owner decided (`bug_reports`: rejected is closed, approved runs its own fix) and holds the autofix while one is still pending -
  and steers a session whose reply drifted from the voice rules (a private
  nudge to re-check that reply, logged in the drift log channel and
  `drift_events`, never an edit and never a code fix);
  `offlineAlarm` keeps an "I'm offline" notice armed as a Slack scheduled
  message ten minutes out (Slack ignores a cancel within ~5 min of due), so Slack posts it by itself when the host loses
  its connection, and edits it to "back online" when it returns.
  `stuckSweeper` asks Orca every 15 minutes for tasks still `dispatched`
  whose worker is gone, and `gh` for open PRs on the bot's own repo with no
  commit, comment or review for 30 minutes, and DMs the owner what is new with
  the thread that started each (recorded when the app opened the PR, else found in the traces; an item is not repeated for 4 hours);
  `mindful` shows the same two lists on demand. A task whose worker succeeded and whose thread already has the bot's own post after the worker ended is set `completed` instead of listed (the sweep and `mindful` share the probe); anything less stays flagged.
  `idleReaper` (`ORCA_REAP_INTERVAL_MS`, default 30 min, 0 = off) reads
  `orca orchestration worker-list` and `orca terminal list`, and closes through
  Orca (`worker-release` when the worker settled, else `worker-stop`) every
  supervised worker whose terminal has been silent for `ORCA_REAP_IDLE_MS`
  (3 h) and whose task is finished, failed, blocked with no pending gate, or
  absent (only once its worker ended). A worker with a waiting watch on its dispatch, an unanswered question,
  a kept-open terminal, an attention flag, unproven liveness, a terminal another dispatch now owns, or a task blocked while its worker is still going (an `ask`) is skipped (a watch on the dispatch, its Run or its task counts), and
  only supervised workers are candidates, so a user's own session and the bot's
  `claude -p` turns are out of reach. It never kills a pid.
  `stalePromiseSweep` (`STALE_PROMISE_INTERVAL_MS`, default 15 min, 0 = off) looks
  at threads the bot spoke in during the last 24 h whose newest message is its own,
  older than 30 minutes, promises further work ("next I will ...", "việc tiếp theo
  là ...") and has nothing waiting on it (no running turn, workflow, watch,
  reminder or live Orca worker). It steers each such session once, as the same
  internal turn `tell` starts (do it now, set a watch, or end with `NO_REPLY`), and
  posts nothing itself; a bot message is nudged at most once and a thread only
  again after a person spoke in it (`stale_promise_nudged` setting, which also
  remembers NO verdicts so they are not re-asked), thread state is re-read right
  before firing, at most 3 per sweep, each nudge logged as `[stale-promise]` and an
  activity `stale_promise_nudge` event.
  `backgroundWatch` tells a thread the moment background work its turn started
  has died: the CLI's live task list is kept per thread (`background_jobs`), what
  the CLI takes with it when it exits is posted in the thread at once and the
  thread is handed back a turn, and a row left from a process that died with its
  work (restart, drain cut, crash) is claimed at boot before the inbox starts and
  reported later (a thread already running a turn is told but not handed a second).
  A death is reported once (the row is claimed), and a cut-off with no row says nothing. `watch worker` polls every 30s and posts a dead worker's
  line before its hand-back turn. A worker the bot stops on purpose is no death:
  a turn's `worker-stop` (`onBashCommand`, told by the CLI adapter before the
  shell runs it, in every turn with or without a Slack sink) and the thread
  `stop` command (`beforeStop`, before each `worker-stop`) cancel that worker's
  watches first, and the watcher
  re-reads the row after its check, so a watch cancelled meanwhile stays quiet.
  None of them hold a session or a queue slot while they wait.
- **Coordinator.** `coordinator` (`application/coordinator.ts`, rules in `domain/coordinator.ts`,
  state in `db/coordinatorRepo.ts`, `COORDINATOR_INTERVAL_MS`, default 30 min, 0 = off) is
  the owner's housekeeping coordinator and lives only in the owner's DM; every
  message it posts is signed with its display name, `COORDINATOR_NAME` (default
  "Coordinator", set per instance). It is a tick, not a process, and it keeps
  nothing in a session: each tick rebuilds its picture from the journeys, bound
  worker tickets, watches, the stuck-work probe, `gh pr list` and the owner's
  unanswered threads. Code settles what it can (closes a journey at 100%,
  renews a worker ticket about to lapse under a watched worker, arms a lapsed
  `watch worker` again) and the rest goes to one held turn per tick, a fresh
  session per coordinator day (the day starts when quiet hours end), run as the owner
  with the owner's role and nothing beyond it. Every action is one line of a
  single digest message edited with `chat.update` through the day. A wall the
  owner must knock down goes through `coordinator blocker` and is routed in code: a
  non-prod blocker is put once ever with `jv:coordinator:` Approve / Reject buttons
  (decided in code, never by a model) and waits out quiet hours (22:00-05:00
  Asia/Ho_Chi_Minh); a prod blocker is asked again every `COORDINATOR_PROD_REPING_MS`
  until the owner acts, quiet hours or not, unless it is both urgent and
  low-risk and inside the owner's role, which the coordinator fixes itself and reports in
  the digest and one direct line. The digest and every blocker are written in
  `COORDINATOR_LANG` (Vietnamese by default), and the digest message carries the grey
  usage footer: the last tick's line plus the day's total, kept in `coordinator_usage`
  and counted only for a turn that really ran.
  The coordinator also takes the small approvals
  off the owner's hands, in code: a non-prod `other` blocker that is provably
  low-risk is approved by the coordinator, and a new bug report is approved by it
  when the owner himself asked for the fix in that very thread (read from the
  turn ticket's owner bit, never from text) or when it is a low-risk fix to the
  bot's own source filed from the owner's own conversation; everything else, and
  every report from someone else's conversation, still waits for the owner's
  buttons, and the owner can Reject what the coordinator approved. Nothing a
  non-owner writes can cause an approval, and the fix and stop turns the bot starts itself from a report's brief carry no owner bit (`unprompted` / `composed`). Its tick also holds the writer claims:
  one writer per job (`bug:<id>`, `journey:<id>`, `branch:<name>`), taken before
  `worker-start`, refused for a second claimant with the holder's dispatch id and
  thread, released when the worker ends or dies, with dead and duplicate ones
  reported in the digest. See "The coordinator sweeps" and "One writer per job"
  in CLAUDE.md.
- **Followed threads: debounce and gate.** An untagged message in a thread the bot
  follows (the `asked` and `own-thread` routes; tagged messages, DMs, one-on-one
  threads and command lines skip all of this) is not a turn yet. `app.ts` hands it
  to `followGate` (`application/followGate.ts`), which keeps one batch per thread in
  memory: each arrival resets a quiet window (`follow_debounce_seconds`, 25s), a cap
  from the first message (`follow_debounce_max_seconds`, 90s, at most 600s) bounds
  the wait. When it ends the pal model reads the batch and the few messages before
  it and says `reply`, `skip` or `wait` (`wait` buys one more window, still under the
  cap; an error, a timeout or an unreadable answer is `reply`). Only `reply` runs the
  main turn, once, on all the buffered messages in order. The listener awaits the
  batch, so each message's inbox row stays `running` while it is buffered: a restart
  redelivers those rows and they are buffered again, instead of waiting in memory
  alone. Like the other timers it holds no session and no queue slot while it waits,
  and `follow_gate=off` removes it.
- **Muted threads.** `mute` (`commands/schedule.ts`, `db/muteRepo.ts`, table
  `muted_threads`) turns the bot off for one thread. `mutedAway` in `slack/app.ts`
  runs first in the `app_mention` and `message` listeners and again at the top of
  the handler (a gate batch buffered before the mute, a button press and a reaction
  arrive there): a muted thread's message that is not a known command is dropped
  before a turn, a reaction or a stream exists. Known commands pass, so `mute off`
  works from inside. It outranks a follow, which stays stored but unused. Only
  person-originated intake asks; watch hand-backs, loops, tells and workflow steps
  reach `respond` another way and are untouched.
- **GitHub App.** A loopback listener (`GITHUB_APP_PORT`, reached through
  Tailscale Funnel) verifies each webhook, answers 202 and hands it to
  `githubApp`, which keeps only real calls (a mention of the app or its label,
  never from a bot, only in allowed owners' repos) as rows keyed by delivery id
  - the dedupe and the queue, held while a restart drains. Each is posted into
  a channel and run as a turn in that thread as the matched Slack person; the
  turn answers on GitHub through `bin/github-app-comment.sh` ->
  `/api/github-app/comment`, ticketed and bound to that one issue. Beyond that,
  an admin's or the owner's turn can act as the app on any repo it is installed
  on (PRs, comments, reviews, labels, merge) through `bin/github-app.sh` ->
  `/api/github-app/action`: the ticket resolves to the Slack user, the role is
  checked in `githubAppActions`, the installation is looked up per repo, and
  every call lands in the command log. The same helper's `git` / `push` run a
  local git as the app: it asks the bot for the `git-auth` action (installation
  token + `<slug>[bot]` identity) and gives that one git process the token in its
  environment (`GIT_CONFIG_*` `http.extraheader`), never in a url or a file.
  An Orca worker outlives the turn's 3-hour ticket, so a turn mints it a
  **worker ticket** (`worker-ticket`, `workerTickets.ts`; its token file also carries the bot's base URL on line 2 for the helper scripts, rows in
  `worker_tickets` holding only the token's sha-256): one repo, a short action
  list (the app's commit identity by default, so commits go out as the app with
  no token; `push` is the opt-in that adds a push-capable `git-auth` token,
  otherwise a worker pushes with the one-shot human credential), bound to its dispatch id, 3h (max 6h), ended when the
  `watch worker` sees it finish or die, on `revoke`, or by the expiry sweep. A
  long worker extends it (`ticket-renew` through `bin/github-app.sh`, or an
  admin's `worker-ticket renew`, which also revives one that lapsed unrevoked):
  up to 6h per renewal, 24h from the bind in all. The
  token is handed over as a 0600 file whose PATH is the only thing in the brief
  (`JARVIS_RUN_TICKET_FILE`, read by `bin/github-app.sh`). `githubAppActions`
  redeems it against the plan's action and repo (not the raw request), still
  checks the minter's role, and a `git-auth` token for a worker is minted per
  ticket (repo-narrowed, permission-narrowed, uncached) and revoked at GitHub
  when the ticket ends. It is a separate store from `commandTickets`, so it can
  never run a command, and only the brain's run bridge can mint one.
- **Self-update.** A fix lands through a PR that CI (`.github/workflows/ci.yml`)
  passes (typecheck, tests, the real-Slack e2e in its own workflow `e2e.yml` on a push to main only, its token held by the main-only `e2e` environment, and a `gitleaks` secret scan whose known false positives are allowlisted by value in `.gitleaks.toml`), merged only by `bin/merge-when-green.sh` (exit 4 at once on a PR that
  conflicts with its base, which GitHub never runs CI on). The merge is decided by the bot, not the script: the
  script asks the `merge-gate` action (`domain/mergeGate.ts` rules, `application/mergeGate.ts` GitHub reads and the single merge call, behind `MERGE_GATE=on`),
  which merges with the app's own credential only when the head is the named sha, the required checks (`checks`, `gitleaks`) are green on it and,
  for runtime code, the latest `[review round N]` review ends `VERDICT: clean` and a `[verify]` comment ends `VERDICT: verified` naming the sha, written by an account named in `MERGE_GATE_ATTESTERS` (never the PR's author or the app; an empty list means no runtime PR merges), with a raw `pr-merge` refused while the gate is on.
  The writer's worker ticket names `merge-gate` (never a raw `pr-merge`); a reviewer's or verifier's never does. Who holds what: the writer holds a ticket
  and a one-shot push credential, the reviewer and verifier a non-admin login that can only post reviews and comments, the app's private key and the merge live in the bot alone
  (the owner's by-hand steps to finish this are in the README, "Who merges"). When it touches runtime code
  (logic, commands, adapters, `bin/` scripts, or a mixed PR) a reviewer Orca worker
  reads it first, up to 5 rounds (each round is a real GitHub review, request changes or approve; fixes are pushes answered by a `[fix round N]` comment); docs,
  prompt text, skills and dashboard UI need no reviewer. `bin/jarvis-restart.sh` runs typecheck and tests, rebuilds the
  dashboard bundle, and only restarts when all three pass. Under the release supervisor
  those checks run on an immutable per-commit export of HEAD (`~/.jarvis/releases/<sha>`,
  `bin/jarvis-release.sh`), not on the live checkout, and a green run only moves the
  `current` link; the supervisor (what launchd runs, a copy outside the repo) health-checks a release
  that is not last-good yet (`/health` `ok: true`) and goes back to `last-good` by itself on failure.
  `jarvis-release.sh rollback` is the way back that needs neither the bot, the merge script nor CI
  (`docs/releases.md`). With `SELF_PR_AUTHOR`/`SELF_PR_REVIEWER` set, the
  PR is opened as the author and reviewed, approved and merged as the reviewer
  (the reviewer's `[review round N]` review ending `VERDICT: clean` is the clean verdict the merge gate reads; with `MERGE_GATE` off `merge-when-green.sh` still approves as that account right before the merge, unless it already approved this head). `restartWhenIdle` then drains: timers that start turns hold, and new
  chat messages are still answered, each turn on `RESTART_TURN_BUDGET_MS` (2 min;
  commands, slash commands and buttons wait in the inbox instead);
  one past it tells its thread to hold on, is cut and its inbox row stays
  `running` with `cut_at` for the next process. Once the turns from before the
  request have finished the inbox is no longer read, so the wait ends within
  one budget, and anyone writing in from then on (or whose command was held
  back before that) is told why, what it waits on and the latest it is back. Past 15 minutes it exits anyway and the rows it cut are
  redelivered to the next process on the same session. Where this goes next is
  in [`docs/rolling-restart.md`](docs/rolling-restart.md).

## Layers

```
                 index.ts / gateway.ts  (composition roots)
                          |
   +---------+-----------+-----------+---------+--------+
   |         |           |           |         |        |
 slack   dashboard      llm         db      github   system   <- infrastructure
   \         |           |           |         |        /
    +--------+----- application (use cases) ---+-------+
                          |
                     domain (pure)
```

### `src/domain` - pure business rules

No I/O, no frameworks. Just data shapes and functions of their inputs.

- `types.ts` - core data shapes (`AllowedUser`, `StoredMessage`; a role is just a name)
- `access.ts`, `toolPolicy.ts`, `toolVisibility.ts` - who may talk to the bot, and the per-role CLI sandbox (skip-permissions vs `--allowedTools` allow-list + fixed cwd), incl. the host `notion` MCP server gated by `note`'s floor and the host `datadog` MCP server (read tools only, every role, writes denied by name)
- `agentModels.ts` - the models of handed-off work (`model:subagent|worker|plan|loop`, defaults sonnet/sonnet/opus/sonnet): the turn env and the Explore/Plan `--agents` overrides
- `roles.ts` + `permissions.ts` + `roleSeed.ts` - roles are data: only `owner` is code (holds every permission, never stored); every other role is a stored row of the permissions it grants (`command:<name>`, `github:<action>`, `mcp:<server>`, tool tiers, guarded sub-actions), and `can(book, role, permission)` is the one question every role check asks. `roleSeed` holds what the built-in `pal`/`executer`/`admin` start with (reproducing the old hard-coded behaviour); `rolePolicy.ts` keeps what surrounds a role record (a switched-off role is off the allowlist, extra denied tool patterns)
- `slackNames.ts` - how a person or conversation is shown: always name and id
- `personality.ts`, `promptGuides.ts`, `conversation.ts`, `mentions.ts` - the system prompt from generic defaults + injected identity, a system prompt that is byte-identical for every thread of a role (so the prompt cache is shared) with everything per-turn/thread/channel/person returned separately as `volatile` for the end of the turn's message (procedure blocks, the self-fix procedure included, as on-demand guide files for turns that can read them), context windowing, `<@ID>` annotation
- `threadSession.ts`, `agentSession.ts` - one CLI session per thread and when it may be resumed; also Slack's own stop button: what a press does, and the notices when it is refused
- `threadBrief.ts` - briefs between threads: the opaque source reference (an HMAC), the nonce-delimited, escaped block a turn's message carries, its caps, the auto-brief and relay notes and the relay TTL, the prompt rule
- `internalMessages.ts` - the console's hidden messages: which stored `user` turn is a tell / nudge / watch hand-back / orca question / loop fire (by the prompt's own opening), a brief as one, secrets redacted, oldest first
- `adapter.ts`, `adapterCheck.ts` - memory as a checked, versioned directory (facts + skills) instead of an ever-growing list; a skill's optional `model:` / `worker:` frontmatter says which model and worker mode runs it (absent = the turn's model; `model` alone runs `foreground`; `orca` needs the turn's Orca grant, else `background`)
- `ciGate.ts` (domain) - CI verdict of a PR from its check rollup, what a CI-gate poll should do, the spec of a gate's watch row
- `acceptedBots.ts` - the `ACCEPTED_BOT_IDS` allowlist (an allowlisted bot posting with a person's user token is that user speaking) and the per-thread loop guard that caps consecutive accepted-bot turns
- `threadFollow.ts`, `followGate.ts` - which untagged thread messages the bot answers, and the pure rules of the gate in front of a followed thread (settings, bypass, batch windows, verdict parsing, the gate's prompt)
- `voiceMessage.ts` (domain), `voiceTranscript.ts` (application), `infrastructure/system/whisper.ts` - a voice message (an audio clip, no text) starts a turn: the clip is fetched with the bot token, converted by ffmpeg and transcribed by local whisper.cpp, and the transcript becomes the message text with a note to reply in text plus a spoken clip; a failure becomes a note in the text, never a dropped clip
- `bugReport.ts` - the internal `bug-report` command's pure parts: flag parsing, the Slack-link check, the fingerprint that dedupes, the owner's DM text, the `jv:bug-report:` button ids (the prefix is code-handled: `application/bugReportApproval.ts` decides a press, owner only, on the stored notice channel/ts, and only an approve starts the fix turn; the agent may approve in a turn the owner's own message started, with an audit DM carrying a Reject button), and `routeBugReport`, the pure rule by which the coordinator approves the small ones (the owner's own ask in that thread, or a low-risk own-source fix from the owner's conversation)
- `lowRisk.ts` - the words (role, permission, auth, ticket, token, secret, approval, prod...) that keep a bug report or a coordinator blocker out of the approve-it-myself lane
- `writerClaim.ts` - one writer per job: the `bug:` / `journey:` / `branch:` key grammar, who may take a claim, what a tick finds (dead, never bound, two on one key)
- `coordinator.ts` - the coordinator's pure rules: quiet hours and the owner's day, what a journey or worker ticket needs, own PRs from `gh`, urgent / low-risk / the prod self-fix rule, the non-prod self-approval rule, how a blocker is routed, the digest and the turn's text
- `journey.ts` - the bot's own work log: statuses, flag parsing for the internal `journey` command (run only by the brain's own turn, never typed), the one-line and help text
- `watch.ts`, `reminder.ts`, `loop.ts`, `selfUpdate.ts`, `runControl.ts`, `threadBackground.ts`, `backgroundJobs.ts` - waits, reminders, draining restart, stopping a turn and the background agents its thread started
- `stalePromise.ts`, `tellPrompt.ts` - the stale-promise rules (bilingual promise heuristic, the model's yes/no question, which threads may be nudged, the per-thread record) and the internal steer text shared by `tell` and the sweep
- `workerUsage.ts` - an Orca worker's tokens summed from its Claude Code transcript (deduped per message) and priced per model (the one price table)
- `offlineAlarm.ts` - the dead man's switch notice and its back-online edit
- `systemStatus.ts`, `orcaStatus.ts`, `systemBlocks.ts` - `sys`: the host verdict and numbers, Orca's runtime/runs/tasks parsed from its CLI JSON and counted, and the Block Kit message (header, fields, trend, Orca table) with the plain report as its fallback
- `harvest.ts` - the learning harvest's prompt, how its answer is read and every check on a proposal (person-typed turns only, quote grounded in a person's words, secrets and personal data, skill draft limits, the line diff, the owner's notice text)
- `innerChild.ts`, `voiceDrift.ts` - the self-review triage, and the cheap voice-drift check, nudge and log lines
- `githubApp.ts` - webhook signature, owner allowlist, trigger detection and what the GitHub App says
- `*Prompt.ts` - prompts for the preset tasks (quick-review, ticket, investigate, read, note, workflow, ...)
- `blockKit.ts`, `kitEvents.ts`, `slackFormat.ts`, `slackLinks.ts` - Slack formatting, Block Kit (model fences are normalised against Slack's min-length rules and can be rendered as words when Slack refuses them) and links
- `usageFooter.ts`, `collapseSteps.ts`, `messageFooter.ts` - the one grey line under a message: who wrote it (Jarvis, inner child Jarvis, watch, reminder, ...), what started the turn when it was not a person chatting (`triggered by watch`; the internal sender names it in `runTurn`/`steerViaRespond` -> `InboundMessage.trigger` -> `HandleResult.trigger`, never read off the text), what the turn cost (cache reads and writes shown apart, `cache r 60.5k w 39.4k`), the step summary, and nothing about edits (no "updated" time: an edit keeps or rebuilds the footer as it was); only a message in the session's own thread carries it, so the `post` command, a console post or edit and a cross-thread proxy write have none (`UNSIGNED`); `signedText` posts plain text as one `markdown` block (run through `toSlackMarkdown`, since that block is standard Markdown where mrkdwn `*x*` would be italic; the streaming equivalent is `slack/emphasis.ts`) (never folded behind "Show more", unlike a long section) up to Slack's 12k markdown cap, and `sectionChunks` cuts the rest (and the `signedSections` fallback) into sections Slack accepts, hard-splitting long lines and keeping code fences closed

Fully unit tested, no mocks needed.

### `src/application` - use cases

Orchestrates the domain and depends on **ports**, not concrete adapters.

- `ports.ts` - `LlmPort` (optional streaming + per-call tool `policy`), `Clock` and sink seams
- `respond.ts` - routes an inbound message to command or chat
- `handleMessage.ts` - the chat flow (access -> remember -> ask model -> remember), applying the role's tool policy
- `cloudwatch.ts` (application) + `domain/cloudwatch.ts` + `infrastructure/aws/cloudwatchCli.ts` + `db/cloudwatchRepo.ts` - the `cloudwatch` command: Logs Insights run by the bot's own `aws` CLI (a turn's `aws logs` stays denied), a scan estimate from the log group's stored size, owner runs after a warning, executer/admin park a `cloudwatch_requests` row behind `jv:cloudwatch:confirm|cancel` buttons decided in code (never a model turn), every request audited
- `ownerTickets.ts` (application) - the one-turn owner ticket (`jvow_...`): minted only when the bot's record says the owner's own message started the turn, it switches that spawn to the host login + claude.ai connectors (no `CLAUDE_CODE_OAUTH_TOKEN`, no `ENABLE_CLAUDEAI_MCP_SERVERS=false`, `--mcp-config` without `--strict-mcp-config`, the claude.ai Slack connector denied); a child of the turn redeems it at `POST /api/owner-ticket`. If the host login is refused (structured 401 signals, before anything visible was emitted), `claudeCli` re-runs the request once as a normal token spawn without connectors, logs one activity line and skips the ticket for 10 minutes. Names nobody, grants connectors only
- `slackTickets.ts`, `slackProxy.ts` (application) + `domain/slackProxy.ts` + `domain/turnEnv.ts` - a turn's Slack access: the per-turn ticket, the allowlisted call made with the bot's token (built-in lists plus the owner's `slack-methods` extras), and the environment scrub
- `selfPosts.ts` (application) + `domain/selfPost.ts` - what a turn (by its run ticket) posted into its own thread through the proxy, so that turn's closing reply is dropped instead of streamed as a second message (unless it carries a `KEEP_REPLY` line, which then replaces the turn's single plain text post; the proxy strips that marker from the turn's own post/update text and blocks)
- `commands.ts`, `commandTickets.ts`, `workerTickets.ts`, `commandLimits.ts`, `brainRun.ts` - the command registry (configurable prefix + slash, role gates, help), the brain's tickets, allowances and result delivery. The command definitions live in `commands/`, one file per group (`chat`, `schedule`, `people`, `adapter`, `learnings`, `errands`, `review`, `runtime`, `slack`, `cloudwatch`), with `commands/shared.ts` for the deps, the `CommandDef` type and the helpers more than one group uses
- `learningApproval.ts` (+ `domain/learning.ts`) - learnings need the owner's approval: only the owner's own typed `learn` is saved active (and `learn approve|reject` may be run by the agent in a turn the owner's own message started, with an audit DM to the owner); a member's `learn`, the agent's `learn` and every `POST /api/learnings` are stored pending (`learnings.status`, migration v35), kept out of every prompt (`injectedLearnings` is the one place the injection reads, active only) and put to the owner with `jv:learning:approve|reject` buttons - in the thread of the turn that proposed it when that is the owner's DM or a thread they started (source recorded in `learnings.source_*`, migration v39), otherwise in the owner's DM with a link to that thread - a press is honoured only on the notice exactly as last rendered (`domain/noticeFingerprint.ts` over its text and buttons, stored in `learnings.notice_fingerprint`, migration v40; `slackProxy` also refuses a turn's `chat.update` on any stored notice) - decided in code in `slack/app.ts` like `jv:loop:` and never handed to the model; after a decision the notice keeps its buttons (`updateInteractive`: the pressed one relabelled `Approved by` / `Rejected by`, the other flips the decision, which `LearningsRepo.decide` allows), unlike the other approval notices, which are settled with `settleInteractive`. Each learning also has an optional scope (`learnings.scope_channels`, migration v45; empty = global, the default and every older row): `injectedLearnings(repo, channelId)` injects a channel-scoped learning only into turns in its channels, the API takes `scope` (`global` | `channel` | channel id list), the owner's notice shows it and `learn approve <id> global|<channel ids>` changes it, and in adapter mode a scoped fact is filed into the channel's own note.
- `threadQueue.ts`, `runRegistry.ts` - one turn per thread (what a person queues behind it is merged into one turn), and stopping the running one
- `followGate.ts` (application), `followGateModel.ts` - the per-thread buffer for a followed thread (a quiet window, a hard cap, injectable timers) and the cheap pal-model call that says reply, skip or wait
- `coordinator.ts`, `coordinatorApproval.ts` (application) - the coordinator's tick (picture, deterministic actions, the daily turn, the digest, blockers) and the owner's code-decided Approve / Reject on a blocker; `writerClaims.ts` (application) - the claim operations the `claim` command, the worker-end hook and the tick share
- `ciGate.ts` (application) - the CI gate of `quick-review`: idempotent request-changes and approve against GitHub's own state, the watcher row for a running CI, and its poll
- `watcher.ts`, `reminders.ts`, `loops.ts`, `reviewInbox.ts`, `reviewRounds.ts`, `reviewGuard.ts`, `innerChild.ts`, `learningHarvest.ts`, `offlineAlarm.ts`, `orcaQuestions.ts`, `idleReaper.ts`, `stuckSweeper.ts`, `stalePromiseSweep.ts` - the timers (`orcaQuestions` also sits on the tool-trace sink, linking each Orca worker to the thread that started it)
- `githubApp.ts` - calls from the GitHub App: dedupe/queue, identity mapping, the turn, the answer back
- `workflow.ts`, `workflowFront.ts`, `workflowContinue.ts` - long tasks driven from one thread on a durable session
- `accessRequests.ts` - unknown people ask the owner and admins, who decide with a reaction; on ✅ the person's original message (stored whole, with its Slack ts) is answered as a normal turn through the Slack intake, falling back to a short "you are in" line if the replay fails
- `adapterMemory.ts`, `botProfile.ts`, `claudeTokens.ts` - memory, instance identity and CLI tokens (`adapterMemory.ts` also holds `rememberFact` / `forgetFact`: `adapter forget <fact>` drops one fact's line as a new revision, since an approved fact has no learnings row left to delete by id)
- `slackAdmin.ts`, `draftReply.ts` - Console + power tools port, AI reply drafting
- `conversationDirectory.ts` - every channel and DM (`conversations.list`, all cursor pages) held in memory for the Console sidebar's search, refreshed every 10 min, a failed refresh keeps the last list
- `dashboard.ts` - the dashboard's use cases (users, roles, memory, identity, commands, usage, modals) over narrow ports, returning an `Outcome` the server maps to a status
- `roles.ts` - seeds the built-in roles (folding in the old deny policies and `note`/`read` floors on the first boot) and holds the owner's role edits (create, grant, revoke, rename, delete); `rolePolicies.ts` - wraps the allowlist so a switched-off role is off it for every check in the bot; the dashboard alone gets the raw repo
- `slackDirectory.ts` - the workspace's members (`users.list`, every cursor page) held in memory for the Users page search, refreshed at most every 10 minutes, one sweep shared by concurrent searches, last good copy kept on a failed refresh; the filter itself is `domain/slackMembers.ts`
- `nameResolver.ts` - cached Slack names (conversations.info / users.info) for the dashboard, so a render never calls Slack per row

Tested with an in-memory SQLite database and a fake `LlmPort`.

### `src/infrastructure` - adapters

Concrete implementations of the seams and the transports.

- `slack/gateway.ts` - the gateway's socket, writing envelopes to the inbox
- `slack/inboxReceiver.ts` - the Bolt receiver that reads the inbox instead of a socket
- `slack/app.ts` - Bolt listeners + slash commands mapping Slack events to `respond`
- `slack/statusMessage.ts` + `domain/statusSteps.ts` + `db/statusMessageRepo.ts` - the turn's tool steps as ONE separate message in the thread: posted at the first visible step, edited about once a second (trailing edit always lands, 429 waits retry-after), rendered as a title-only header `task_card` (the dashboard thinking label), one top-level `task_card` per step carrying `details` / `output` / `sources` rich_text (clipped and secret-scrubbed) and a last `context` line with the step count (no `plan` block: it folds the cards and Slack allows only one per message), capped to the running steps plus the last few finished, deleted 3 s after a clean turn or collapsed to its failed steps when a step failed; recorded in `status_messages` so a boot sweeps what a dead process left
- `slack/stream.ts` (+ `domain/fences.ts`, which `toSlackMarkdown` also runs so a finished or one-shot `markdown` block gets the same fence fix) - bridges the `LlmStreamSink` onto Slack's `chatStream` (text and Block Kit fences only: tool steps go to the turn's status message instead;  a blocks chunk Slack refuses is written as its words and the stream carries on; a failed append, rollover stop or final stop makes `finish` answer false and `app.ts` rewrites the first message, or deletes the stream's messages and posts the full reply, so a streamed message is never left blank), falling back to a single post
- `slack/adminClient.ts` - `SlackAdminPort` over the Slack Web API; every post and edit carries the signed footer (`by` names the poster; `post` also takes a turn's usage, so an unwatched turn's reply shows the same usage line as a live one), falling back to bare text when Slack refuses the blocks
- `slack/offlineAlarmClient.ts` - the offline alarm's scheduled-message calls
- `inbox/inboxRepo.ts` - the inbox queue shared by both processes
- `llm/claudeCli.ts` - the default `LlmPort`, wraps the local `claude` CLI (`--resume`, `stream-json`, per-call policy -> `--allowedTools`/cwd/timeout, the timeout stopping the whole process tree, `turnEnv` for per-turn environment such as the Orca handle and the subagent/worker models, `agents` for the `--agents` definitions that pin Explore and Plan); `killTree.ts`, `toolTraceLog.ts` support it; `backgroundAgents.ts` finds a thread's `claude --bg` sessions and Orca workers in its trace and stops them through their own CLIs for `stop`
- `mcp/lazyProxy.ts` + `bin/mcp-lazy-proxy.ts` - stdio MCP proxy `claudeCli` puts in front of every stdio server of a turn's `--mcp-config`: answers `initialize` and the list methods from a schema cache (`~/.jarvis/mcp-schema-cache`), spawns the real server on the first `tools/call` (refreshing the cache), so no MCP server starts for a turn that never calls it; a whole-server `disallowedTools` entry drops the server from the config
- `mcp/approvals.ts` + `domain/mcpApproval.ts` + `application/commands/mcpTools.ts` - discovery is not exposure: per-server approval state in `<schema cache>/approvals/<server>.json`; the proxy takes a server's first-run tools as the baseline, hides any tool listed later from `tools/list` and refuses its `tools/call` until the owner runs `mcp-tools approve`
- `mcp/codeMode.ts` + `mcp/sandbox.ts` + `domain/mcpCodeMode.ts` + `domain/mcpTypes.ts` + `domain/mcpSandbox.ts` + `bin/mcp.ts` - the `mcp list | search | schema | call | types | run` CLI: reads tool lists from the schema cache, calls through the same lazy proxy, writes the full result to a file and prints a short summary; `--fields` projects JSON; `types` generates TypeScript declarations from the cache and `run` executes one model-written script in a QuickJS/WASM isolate (no network, files, process or env; only `mcp.<server>.<tool>()` bridged to the host, each call gated like `call`, with time, memory, call-count and output limits); refuses what the turn's role (`BOT_MCP_ACCESS`, `BOT_MCP_DENY`) may not use
- `llm/anthropic.ts` - alternative `LlmPort` backed by the Anthropic API
- `db/` - `bun:sqlite` client, schema + migrations, one repo per table (users, roles, messages, sessions, thread briefs, watches, reminders, loops, journeys + their append-only events, bug reports, workflows, usage, turn and command logs, Orca worker threads and questions, ...), `secretBox.ts` for encrypted tokens, `tokenKeyStore.ts` for where its key lives (file, or a macOS Keychain item via the `security` CLI, `TOKEN_KEY_SOURCE`)
- `adapter/adapterStore.ts` - the memory adapter in the `adapter_files` table, mirrored to `data/adapter-mirror` so skills can be read by path
- `github/` - `gh` CLI wrapper and review-request polling; the GitHub App's fetch client (`appClient.ts`, RS256 JWT -> cached installation token), credentials from files (`appCredentials.ts`) and webhook listener (`webhookServer.ts`)
- `system/` - host probes (system load, Accessibility access, shell checks for watches, `orcaProbe.ts` reading Orca's status, newest Runs and their tasks for `sys` under one deadline), `guideWriter.ts`, which writes the prompt's how-to guides to `data/prompt-guides`, and `orcaTerminal.ts`, the bot's own Orca terminal (created once, checked against Orca at most once a minute, re-created when gone) whose handle every spawned turn gets as `ORCA_TERMINAL_HANDLE` so it can open Orca Runs and start workers, and `workerTranscript.ts`, which finds an Orca worker's Claude Code session (one message id from `worker-read --source transcript`, matched to the `uuid` in a `~/.claude/projects` jsonl) and sums what it used
- `db/statsRepo.ts` - read-only day buckets and top-N sums over `messages`, `turn_log`, `llm_usage`, `command_log` and `thread_sessions` for the overview charts (`/api/stats`); `domain/dashboardStats.ts` lays them over the whole window, zeros included
- `dashboard/server.ts` - `Bun.serve` JSON API under `/api` plus the React SPA built to `web/dist`. HTTP only: parse, call `application/dashboard.ts`, map the outcome. The brain hooks (`/api/commands/run`, `/api/github-app/comment`, `/api/restart`) and the Slack console call their deps directly. `GET /api/memory/internal` (read-only) returns the hidden tell/brief/watch/nudge messages stored for a channel or thread, merged from `messages` and `thread_briefs`; `GET /api/memory/turns` the DB copy of ordinary turns (the console shows the ones Slack no longer has as "deleted on Slack"); both take a `since`/`before` time window so the console pages them with the Slack history. `GET /api/slack/thread` pages replies (`limit`, `before`) and `GET /api/slack/search` searches every channel and DM.
- `web/` - the dashboard front end: React 19 + Vite + React Router 7 (`react-router` package). Its Architecture page draws this document as an interactive diagram from `web/src/systemModel.ts` - change that file with the runtime section above. Layout: `routes/router.tsx` (route table), `pages/` (one module per page with its loader and action), `ui/` (shell, error and banner), `api.ts` (every fetch)

### `src/config`

- `env.ts` - zod-validated environment config, fails fast at boot

### Composition roots

- `src/index.ts` - imports every layer, builds the graph, starts the Slack
  listener (socket or inbox), the timers and the dashboard
- `src/gateway.ts` - reads only `SLACK_APP_TOKEN` and the inbox path, on
  purpose, so a new bot setting can never stop the gateway from starting

## Key decisions

- **Verifier brief.** A verifier runs a runtime-code PR on the PR head, but its brief is not the PR description: `bin/verify-brief.ts` (pure half `domain/verifyBrief.ts`) assembles it from the diff's paths - the trust boundaries crossed with numbered adversarial cases, the policy docs' matching paragraphs, the regression history of those files and the contracts they touch - and checks that the `[verify]` comment names every required item. It picks another model family for the verifier (`codex`) when the host has one. A convention step like the rest of the verifier, not a platform gate.
- **Functional throughout.** Repos are factory functions closing over the db
  handle and returning a bag of functions. No classes anywhere.
- **Ports and adapters.** Use cases depend on `LlmPort`/`Clock`, so tests inject
  fakes and never touch the network or the wall clock.
- **Slack never drops on a restart.** The gateway runs under its own supervisor
  and is not restarted with the bot.
- **Code is released, state is not.** The bot runs from `<releases>/<sha>`, a plain
  export of one commit with no `.git`, never edited; `.env`, the databases, `data/`
  and `logs/` stay in the source checkout (linked in, never copied or versioned), so
  going back to an older release moves no data. `current` is switched only after the
  checks pass and `last-good` only after the new process answered `/health`, which is
  why a red build is a refusal and a build that will not start is a rollback, not a
  crash-loop.
- **Sessions, not transcripts.** A thread resumes its CLI session instead of
  replaying history into a cold process, and the session id lives in the DB so
  a restart does not lose it.
- **Waiting costs nothing.** Watches, reminders and polls run on timers in the
  bot process, outside every turn: no model, no session, no queue slot.
- **Owner can never be locked out.** `decideAccess` grants the owner access even
  if the database is empty or broken.
- **Roles are data, and tool policy follows their grants.** Only `owner` is
  hard-coded (always on, holds every permission). Every other role is a row in
  `roles` - a name, a rank and the permissions it grants - and every role check
  asks `can(book, role, permission)`: a command (`command:<name>`), a GitHub App
  action (`github:<action>`), an MCP server (`mcp:<server>`), a tool tier or a
  guarded sub-action. `tools:full-access` runs the CLI with full access (the
  owner alone, as seeded: `isFullAccess` asks the book, so a role it does not
  know holds nothing); without it the role is sandboxed (allow-list + fixed
  cwd, no permission bypass, `--permission-mode dontAsk` so an off-list command
  is refused at once, `SANDBOX_TOOLS` sets the default list), with
  `tools:code` adding the code tools and the Agent tool, and every MCP server it
  holds no grant for denied by name. Orca is `tools:orca` (`ORCA_DENY` in
  `--disallowedTools` otherwise, since an Orca worker runs with full host
  permissions), and the prompt is role-aware (`orca` flag on
  `buildSystemPrompt`). `pal`, `executer` and `admin` are only the roles
  seeded on first boot with the grants the old code hard-wired. Managing roles
  is the owner's alone and cannot be granted, a role only manages people ranked
  below it, and a switched-off role is off the allowlist. `quick-review` is a
  preset that always runs full-access.
- **The brain never names the actor.** Commands it runs carry a ticket bound to
  the person it is answering.
- **The DB is committed** so identity/allowlist ship with the repo. Conversation
  content is cleared before commit; WAL sidecars are gitignored and flushed on
  clean shutdown.
- **Nothing bot-specific is hardcoded.** Identity lives in the DB; command
  triggers, model, cwd, etc. come from env. The code ships neutral defaults.

## Testing strategy

TDD, bottom-up: domain (pure) -> repos (`:memory:`) -> use cases (fakes) ->
dashboard (via its exported `handle`) -> the Slack handler (via the extracted
`createHandler`/`shouldHandleDm`, with fake clients/streamers).
Full `bun test` runs queue on a host-wide lock (`bunfig.toml` preload, `tests/support/hostLock.ts`) so several
worktrees testing at once do not overload the host; CI, single-file runs and `JARVIS_TEST_LOCK=0` skip it.
