# claude-tracker

A local dashboard for people running Claude across several accounts, who keep
hitting a limit without warning and having to work out which account still has
room.

It reads the transcripts Claude Code already writes, across every config
directory you use, reconstructs the 5-hour and 7-day rate-limit windows per
account, and shows how full each one is right now — in the terminal, in the
browser, or both at once. New accounts are picked up on their own.

It also shows what each running session carries into every turn, which jobs
are waiting for a machine's shared GPU or CPU pool, and how much of your spend
goes to re-writing prompt caches that lapsed.

Everything stays on your machine unless you sync it with another of yours,
over ssh. There are no dependencies, no API calls, and no network access beyond
a loopback HTTP server you start yourself - and Slack, if you set it up.

```
  Claude Tracker                     ● live · updated 09:32:16 · 127.0.0.1:4785

  Session (5h) · work@example.com
  24% used            ████████░░░░░░░░░░░░░░░░░░░░░░░░  resets in 1h 22m

  USE NOW  personal@example.com  96% headroom  CLAUDE_CONFIG_DIR=~/.claude-personal claude

   RUNNING NOW · 3 sessions · 1 job waiting for the GPU or CPU · d for detail ─
  ● api-server           work@example.com               4s     $1.20/5m
  ● docs-site            personal@example.com           1m     $0.35/5m
  ○ nightly-job          work@example.com (bg)          12m

   ACCOUNTS ─────────────────────────────────────────────────────────────────

  ● work@example.com     max 20x                  exact · $317 · 7 sessions
    Session (5h)   ██████░░░░░░░░░░░░░░░░░  24% resets 1h 22m    plenty left
    Weekly (7d)    █░░░░░░░░░░░░░░░░░░░░░░   3% resets 6d 20h    plenty left
```

## Install

Node 22.5 or newer. No dependencies to install.

```sh
git clone https://github.com/Xaxis/claude-tracker
cd claude-tracker
npm link          # puts `claude-tracker` on your PATH
```

With a system Node, as on most Linux installs, npm's global directory belongs to
root and `npm link` fails without sudo. Link into `~/.local` instead, whose `bin`
most distributions already put on your PATH:

```sh
NPM_CONFIG_PREFIX=~/.local npm link
```

Then, from anywhere:

```sh
claude-tracker
```

That is the whole thing: terminal dashboard and web dashboard, together.
(`npm unlink -g claude-tracker` undoes it, with the same `NPM_CONFIG_PREFIX` if
you used one.)

## Use

Run it from any directory once linked:

| Command | What you get |
|---|---|
| `claude-tracker` | terminal + web dashboard together |
| `claude-tracker --open` | ...and opens the browser |
| `claude-tracker tui` | terminal only, no HTTP server |
| `claude-tracker serve --no-tui` | web only, good for leaving running |
| `claude-tracker status` | one-shot summary — fine for a shell prompt |
| `claude-tracker sessions` | what is running, the context each carries, who waits for the GPU or CPU |
| `claude-tracker machine` | what uses this machine: cores, memory and jobs by project, and why jobs wait |
| `claude-tracker priority my-app high` | who goes first on the shared CPU pool: high, normal, low or paused |
| `claude-tracker run-next 12345` | start one waiting job before all the others |
| `claude-tracker storage` | who fills the disks, and what nobody cleaned up |
| `claude-tracker models --days 7` | where the spend went |
| `claude-tracker verify` | check the window model against your own resets |
| `claude-tracker accounts` | list accounts and their UUIDs |
| `claude-tracker label a1b2c3d4 "work"` | name an account by UUID prefix |
| `claude-tracker statusline install` | exact limit numbers, from each profile's status line |
| `claude-tracker service install` | keep it running in the background from login (macOS, Linux) |
| `claude-tracker sync add me@devbox` | sync with the tracker on another machine, over ssh |
| `claude-tracker sync` | which machines it syncs with, and how that is going |
| `claude-tracker failover` | where sessions go when their account runs low |
| `claude-tracker failover on` | switch accounts automatically when one runs low |
| `claude-tracker pool add me@example.com` | sign an account into a spare, to switch to |
| `claude-tracker pool add me@example.com --long` | the same with a year-long token, which every machine can share |
| `claude-tracker pool import` | take another machine's year-long tokens, piped from its `pool tokens` |
| `claude-tracker slack setup` | every session in Slack, a thread each: read it, answer it, drive it |

Or from inside the repo, without linking — `yarn` and `npm run` both work:

```sh
yarn start        # dashboards + open the browser
yarn tui          # terminal only
yarn web          # web only
yarn status       # one-shot summary
yarn verify
```

Pass flags through with `--`: `yarn start --port 5000`, `npm start -- --port 5000`.

Leaving it running is worth it beyond the dashboard: while it runs it samples
which account is signed into each profile, and notices new profiles appearing —
so a newly added account starts being tracked without you doing anything.
`claude-tracker service install` runs it in the background from login; opening
`claude-tracker` in a terminal then attaches to that instead of starting a
second copy.

Both dashboards run in one process off a single file watcher, so the browser and
the terminal never disagree and the transcripts are only scanned once.

Running sessions are listed at the top of both dashboards, each with the account
it is billing right now, whether it is busy, when it last did anything, and what
it has spent in the last five minutes.

**Detail** - `d` in the terminal, the Detail button (or `d`) in the browser - adds
what each session carries into every turn, its subagents at work, its jobs on
the GPU or CPU pool, the pool itself, and how much spend went to re-written
caches, all above the accounts:

```
   RUNNING NOW · 3 sessions · 1.3M context a turn in all ────────────────────
                                              context       agents ↻ last hour
  ● api-server       work@example.com         612k ██████░░ +3     ↻4 $9.10   4s
      agents: render-fix, docs ×2
      ▸ a job in render-fix waiting 9m for the GPU · next in line · behind docs-site
  ● docs-site        personal@example.com     480k ████░░░░                   1m
      ■ holds the GPU · 12m
```

Either way is remembered. With detail off, jobs waiting for the GPU or CPU still
get a word in the RUNNING NOW heading.

In the terminal dashboard: `q` quit · `r` refresh · `d` detail · `a` cycle account ·
`w` switch window · `space` pause · `↑↓`/`jk` scroll · `o` open the web
dashboard. The address in its header is a link as well: Cmd-click it in
terminals that support hyperlinks, such as iTerm2, Ghostty, kitty, WezTerm and
VS Code's.

## How it works

### Where the data comes from

Claude Code writes a JSONL transcript for every session, including subagent and
workflow turns nested several directories deep. Each assistant turn records its
model and exact token usage. `claude-tracker` walks all of it — for a typical
install that is a few thousand files and several gigabytes — and keeps a SQLite
index in `~/.claude/tracker/`. Ingest is incremental: only the bytes appended
since the last run are read, so refreshes take milliseconds.

Subagent and workflow turns matter. They are billed exactly like main-thread
turns and count against the same limits, and on a heavy install they can be most
of the spend. A tracker that only reads top-level transcripts will understate
usage badly.

### Profiles — the thing that makes multi-account work

Running several accounts on one machine means several *config directories*:
`CLAUDE_CONFIG_DIR=~/.claude-work claude`, and so on. Each is a complete,
independent Claude state tree with its own `projects/`, its own history, and its
own signed-in account.

That makes the profile the first place to look: whoever is signed into a
directory is normally who its sessions bill. Normally, not always — a running
session follows a `/login` in its profile partway through, and a background job
keeps the account it started with. How those are handled is below.

`claude-tracker` discovers every profile at runtime — `~/.claude`, any
`~/.claude-*` sibling, anything named in `CLAUDE_CONFIG_DIR`, and anything listed
in `CLAUDE_TRACKER_EXTRA_DIRS` (colon-separated). Signing a new account into a
new directory makes it appear on its own, with no configuration; the watcher
re-scans while running, so a profile created after startup is picked up too. A
profile nested inside another is skipped, so a kept copy of an old tree does not
get scanned twice.

### Which account did what

Attribution is decided **per API call, not per session**, because a session is
not tied to one account.

A `/login` moves every session in that profile, not just the one it was typed
into: sessions refused together have been seen carrying on the moment another
session signed in, on the account it signed into, though only that one session
recorded the switch. So each call is resolved at its own timestamp from the
**newest** evidence at or before it:

- **The session's own records** - the signed-in email Claude Code writes at
  start, and again when a `/login` is typed into that session.
- **Who was watched signed into its profile.** While running, the tracker
  records each profile's login as it changes, plus a heartbeat every 10
  minutes. A sighting only vouches for the stretch it was actually watching: an
  isolated old config snapshot does not get to claim the months around it.
- **The profile's other sessions** - each one's first record, and any record
  where it changed account. That is how a `/login` made elsewhere reaches a
  session that never recorded it.
- **Bridge records**, which name the account a session's remote-control bridge
  registered with. They can be days out of date, so they count only when
  nothing newer does. They carry no timestamp of their own, so each is dated by
  the line after it - one written on resume can follow hours of silence.

Ties go to the stronger kind, in that order. A session whose own record is newer
than the profile's switch keeps its account: some long-running sessions carry
on with the account they had.

Refusals and status-line readings settle the rest. When an account hits a
limit, every session on it is refused with the same reset time, and every status
line on it reads the same one - so a shared reset time names one account,
whatever each session's records say. Those groups are settled by vote, within
what is possible:

- an account never holds two overlapping windows of the same kind;
- an account that is out - for five hours or for the week - cannot take the
  call that opens a new five-hour window;
- a refused account serves nothing until its reset, beyond requests already in
  flight. If its profile made no calls until then, the session simply waited and
  carries on with the same account; if the profile carried on, it had moved.

A group nothing else settles goes to the most recent account seen in its profile
that could have held the window - never a later one, so history does not drift
onto an account signed in afterwards. Where the evidence runs out entirely, the
call is left unattributed rather than guessed at; the dashboard shows that total.

Historical attribution is imperfect by nature; the further back you look, the
more of it is inferred. It becomes exact from the moment you start running this
with the status line installed.

### Exact numbers, from the status line

Claude Code knows exactly how full each window is — the server reports it on
every response — and hands that to a profile's status-line command, if it has
one. `claude-tracker statusline install` points each profile's status line at a
small script that records those numbers for the tracker and shows them where you
work:

    work · 5h 42% 1h20 · 7d 18% 5d

With that in place, every account with a session open shows its **exact**
percentage and reset time, straight from the server — which also counts usage
this machine never sees, from claude.ai or another device. Between reports the
bar is carried forward with the calls made since. Accounts with nothing running
fall back to an estimate, marked `≈`, until their next session. Each reading
carries its window's reset time, so it is filed under the account that reset
belongs to: a session still running on an old account after a `/login` reads -
and is counted as - that old account. An idle session's status line keeps
repeating its last response's numbers, so its reading is dated to that call, not
to the render.

The installer changes only the `statusLine` key of each profile's
`settings.json`, writes a backup first, and will not replace a status line you
configured yourself unless you pass `--force`. `claude-tracker statusline
uninstall` removes it.

### Which account to use

Both dashboards and `claude-tracker status` name the account to use right now:
never one refused on any limit, preferring one already signed into a profile,
then the most headroom in its tightest window. It comes with the exact command —
`CLAUDE_CONFIG_DIR=~/.claude-personal claude`, say — which the web dashboard
copies with one click.

### Notifications

On macOS the tracker notifies you when a window reaches 80% and 95%, when a limit
is actually hit (naming the account to switch to), and when a refused account is
usable again. Only trustworthy readings alert — exact numbers, ceilings measured
from repeated refusals, or the API's own refusals — so an estimate never cries
wolf. Each alert is sent once, however many copies of the tracker are running.
Turn them off with `--no-notify` or `CLAUDE_TRACKER_NOTIFY=0`.

### Running at login

`claude-tracker service install` runs the web dashboard in the background from
login and restarts it if it stops: a per-user launchd agent on macOS, a systemd
user service on Linux. `service status` and `service uninstall` do what they
say. It matters for accuracy as much as convenience: the tracker only sees the
moment you switch accounts while it is running. The log is
`~/.claude/tracker/service.log`.

On Linux the service lives as long as your systemd user instance, which normally
stops when you last log out - taking the tracker with it while sessions left in
tmux carry on. On a machine you reach over SSH, turn on lingering so it starts
at boot and survives logout:

```sh
loginctl enable-linger
```

### Syncing machines

Running Claude on a laptop and a dev box means two trackers, each seeing half
the picture: an account's window fills from both machines, but each tracker
only counts the calls made on its own. Syncing them makes both whole. Put the
tracker on each machine, run `service install` on each, then from whichever
machine can reach the other over ssh:

```sh
claude-tracker sync add me@devbox      # what you would type after `ssh`
```

That is all. Both dashboards then show every account's usage from both
machines, the sessions running on each (marked with the machine's name), and
the account to use next wherever it is signed in. An account in use - signed
into a machine's main profile, or billing a session running there - is marked
on both: a green dot for this machine, blue for another, with the machine's
name beside it. A new call on one machine
shows on the other within a couple of seconds.

How it works:

- **One ssh connection, both ways.** The tracker that added the peer keeps
  `ssh me@devbox claude-tracker sync serve` open; that command hands the
  connection to the tracker already running there. Only one machine needs to
  reach the other - a laptop that can ssh into a dev box, where the dev box
  cannot reach the laptop, still gets everything in both directions. Nothing
  new listens on the network, and ssh does the authentication, so it needs to
  work without a password prompt: a key, or an agent holding one.
- **Evidence travels, conclusions do not.** What is copied is calls, sign-in
  records, refusals, status-line readings, sessions and accounts. Each tracker
  then attributes every call over the combined evidence itself, so both arrive
  at the same totals. A profile from another machine is stored under that
  machine's id, so `~/.claude` on the laptop and `~/.claude` on the dev box
  never share a timeline. A session carried to the other machine and resumed
  there is followed there: each record keeps the profile it was written in,
  so its `/login` on one machine never moves the other machine's sessions.
- **Incremental.** Each side remembers how far into each of the other's tables
  it has read. The first sync copies everything - about half a minute for half
  a million calls - and after that only what is new. A machine that was asleep
  or offline catches up when it reconnects.
- **The tracker must be running on both.** `sync serve` hands the connection to
  it; if it is not running, `sync add` says so.

`claude-tracker sync` shows each peer's state and the last error, if any;
`sync remove me@devbox` stops connecting (the history already copied stays);
`sync name laptop` changes what other machines call this one, which is its
hostname until you do. If ssh needs something unusual to find the command on
the other machine, pass it: `sync add me@devbox --command "node ~/claude-tracker/bin/cli.js sync serve"`.

### When an account is free again

Every account says whether it can take a request now, and if not, when it can:
`out until 21:40` in the terminal, a pill on the card in the browser. An account
is out while any window is full - refused by the API, or read or carried to 100% -
and free again when the last of those resets. A window whose time is up reads
empty: the next request opens a fresh one. A reading Claude Code reported is
`exact`; once calls made since are added to it, it is `≈ carried`. Out until a
time marked `≈` rests on such an estimate.

The account a reading belongs to is worked out, since a status line does not say
whose numbers it shows. Two things matter most. A session repeats the email it
started with on later turns, even after a `/login` elsewhere has moved it, so only
a change in a session's own records counts as news. And a status line reads both
of its account's windows at once, so weekly windows are settled first and each
five-hour reading goes with the weekly window read alongside it - two accounts
whose five-hour windows reset at the same moment stay two accounts.

### Failing over

When the account a profile is signed into runs low, the tracker signs that
profile into another account with room - exactly what a `/login` in one of its
sessions does - and every session running in it carries on as that account,
mid-task, within about 30 seconds:

```sh
claude-tracker pool add me@example.com    # once per account, per machine: a browser login
claude-tracker failover on                # switch at 90% (--at to change)
```

Signing in takes a browser, so it is done once per account, ahead of time:
`pool add` signs the account into a spare, `~/.claude-pool-<name>`, which holds
its sign-in while it is not in use. When a profile's account crosses the
threshold, the tracker service - the one thing on the machine that switches, never
the sessions - moves the sign-in of the spare account with the most room into the
profile, and the outgoing account's into a spare of its own. Then it leaves the
profile ten minutes to settle. Nothing switches when the account frees up within
15 minutes (`--wait`).

A sign-in is moved, never copied: each token refresh retires the token before it,
so one left in two places would go stale in one of them. The switch takes Claude
Code's own lock on its credentials, writes in an order that can never lose one,
and touches only the account's tokens and details - an MCP server's own tokens
stay with the profile. On macOS the sign-ins are Keychain items, as Claude Code
keeps them; elsewhere, files in each profile. They never leave the machine: each
machine switches with its own spares.

The plan is always on show, switched on or not: in the terminal under `USE NOW`,
in the browser as a Failover panel, and with `claude-tracker failover` - each
profile with sessions running, the account it is on, how full, and what it would
switch to, on every synced machine. `claude-tracker failover switch` switches now;
`claude-tracker pool` lists what is signed in where.

How full a profile's account is comes from the profile's own sessions - their
status-line readings and refusals since it was signed in - so it cannot be
mistaken for another account whose windows reset at the same time. If the new
account turns out to be out, or fills before the next check, it switches again
within a minute; an account it ran out on is not switched back to until it
resets. If a spare fails to switch to, the next in line is tried at once.

When no spare has 15% left, stopping at the threshold would only strand what
is left, so each account runs to 98% - just short of being refused - and then
on to whichever has the most left, until none has any.

Room counts for more on a bigger plan: 50% left on a Max 20x outlasts 100% on a
Pro or Team seat, so small plans are a last resort. When a profile is down to
its last spare with room, or has none, the dashboards say so and the service
sends a notification: sign another account up, then `claude-tracker pool add
<email>`. A spare whose sign-in was lost (a `/login` over a switched profile
does that) is listed with the command that puts it back.

A sign-in does not last: its refresh token runs out some weeks after the
browser login, however often it is used, and every session on it is then
logged out ("Login expired"). So failover never switches to a spare that has
run out, or has under two hours left, and moves a profile off its own sign-in
an hour before it runs out - or at once, if Claude Code has already logged it
out. Three days ahead, the dashboards name each spare running out, and a day
ahead the service sends a notification, with the `pool add` for each:
adding an account again signs it in afresh, in the same spare.

So add accounts with year-long tokens instead: `claude-tracker pool add
<email> --long` runs `claude setup-token`, takes the token you paste, checks
Claude runs on it, and keeps it as the account's spare. A token is never
refreshed, so it is not used up by being in two places: another machine takes
every token this one has with

```sh
ssh <this machine> "bash -lc 'claude-tracker pool tokens'" | claude-tracker pool import
```

One login per account a year, for every machine. A token can only run Claude:
while a profile is on one, claude.ai's connectors, Remote Control and Claude in
Chrome are not there (Claude Code says so). `pool tokens` prints secrets: pipe
it, never paste it.

It picks the spare with the most room, unless you pick: `claude-tracker failover
prefer <email>` sends it to that account while it has room (`prefer auto` hands
the choice back). In the terminal dashboard the same settings are keys: `f`
turns failover on or off, `t` steps through the accounts it can switch to, `+`
and `-` move the threshold by 5 points, and `s` pressed twice switches now.
Settings are per machine.

### Driving sessions from Slack

Every Claude Code session running in a tmux pane - on this machine and on the
machines it syncs with - gets a thread in one Slack channel. You can read it,
answer it and drive it from your phone, as if you were at its keyboard.

The newest message in the channel is always an **overview** of every session.
What needs you comes first, then what is working, then what is idle, each a link to its
thread, with each other machine's sessions under its name. It changes in place as
sessions do. When something else is posted in the channel, the overview moves back to
the bottom, so opening the channel always shows it.

The thread's first message shows the session: its tmux session and title, its folder,
account, context and machine, and whether it is idle, working or waiting on you.
While it works, that message shows what it last said and is doing now. It changes in
place, and Slack never notifies anyone of an edit.

Below it, each turn ends in **one message**. A grey line says what it did: `worked 4m
· ran 12 commands, the last npm test · edited 3 files`, the prompt when it was typed
at the terminal, and its shorter remarks along the way. Then comes Claude's answer.
So a thread you follow pings your phone once a turn, not once a paragraph. A long
write-up from the middle of a turn is posted when it is written, rather than held
back. A long turn you asked for from Slack mentions you when it ends.

- **A reply is typed into the session** and sent, exactly as at its keyboard. A
  message sent while Claude works is queued, as typing it in would queue it.
  `!cmd` runs a shell command there, as it does in Claude Code.
- **`;compact`, `;model opus`, `;clear`** run Claude Code's slash commands. Slack
  keeps a leading `/` for its own commands.
- **More…** on a thread's first message is a menu with *Compact the conversation*,
  *Switch model…*, *Change permission mode*, *Show context use*, and
  *Mute this thread*. *Start over* asks first, and only you see the question.
  Beside it, *Screen* shows the terminal and *Esc* interrupts.
- **`;esc`** interrupts. **`;screen`** shows the terminal. **`;keys 2`**,
  **`;keys down enter`** and **`;keys shift-tab`** press keys.
- **When a session waits on you** - a permission prompt, a question, a dialog -
  the thread mentions you and shows the question itself. That means the dialog's title, what
  it is about, and the command in question as code, with a button for each
  choice. The rest of the screen is one tap away, under *Full screen*. A choice
  changes the alert in place, to `you chose 1. Yes`. A reply instead of a button
  answers the prompt with Esc, then sends what you wrote.
- **Files you attach** are saved on the session's machine, and their paths are
  added to the message, so Claude can open them.
- **In the channel itself** (or a DM with the app): `list` shows every session
  with a link to its thread. `new <folder> [what to do]` starts Claude there in
  a new tmux session, and `new Mac:~/Projects/app …` starts it on another machine.
  `usage` shows how full each account is. `pause` and `resume` stop and restart
  the conversations, while prompts that need you still come through.
- **`;mute`** in a busy session's thread stops showing its conversation, and only
  prompts that need you come through. `;unmute` turns it back on.
- The tracker's own alerts land in the channel too: a limit nearly hit, a failover
  switch, and "add another account".

A thread lasts as long as its conversation. A session restored after a reboot,
by `claude --resume`, carries on in its thread. A `/clear` starts a new
conversation in the same thread.

Setting it up takes a few minutes, once:

```sh
claude-tracker slack setup
```

It gives you a link that creates the Slack app with everything it needs already
filled in, including Socket Mode. You install the app to your workspace and paste
its two tokens. Then you post a pairing code in the channel you want, after inviting
the app there. A private channel is best. Whoever posts the code is the only person
the app listens to, and that channel is where the threads go. Set it up on one machine,
the one that is always on. Synced machines' sessions come through it over the sync
connection, and their trackers follow and type into them.

How it works, and what keeps it safe:

- **Socket Mode.** The tracker opens a connection out to Slack, and events come
  back down it. Nothing new listens on the network, so no public address or
  tunnel is needed.
- **Keys go into the pane, nowhere else.** Claude Code records each running
  process's tmux pane and whether it waits on you (`~/.claude/sessions/`), so
  the tracker knows where to type and when a prompt is open, without hooks.
  It types only into a pane where the Claude process it expects is running in
  the foreground, and it checks that just before each message. If Claude has
  exited, the pane is a shell, and anything typed there would run as a command.
  Ctrl-C is never sent, because twice closes Claude Code. Leftover text in the
  input box, such as a prompt an interrupt put back, is cleared with keys that
  can neither interrupt nor exit, and the thread says what was cleared.
- **What it says comes from the transcript**, read as it is written, from where
  it left off after a restart. Messages typed from Slack are not echoed back.
  Another session's messages, subagents' turns and injected context are left out.
- **Only what fits** is checked: a session not in tmux shows in Slack read-only,
  and says why.

`claude-tracker slack` shows how it is going, and both dashboards show it
too. When something is wrong, they say what fixes it. `slack pair` moves it to
another channel. `slack off` and `slack on` turn it off and back on, and `slack remove`
forgets the tokens. On a machine without Slack set up, `slack off` stops a synced
machine's Slack from driving its sessions.

### Exporting accounts

`claude-tracker accounts export` writes every account to a spreadsheet in
Downloads (or the file you name): email, name, plan, organization, billing,
when it was created, subscribed and renews, where it is signed in, how much of
its windows is used and when it is free. Phone number and payment card columns
are left blank to fill in - Claude Code is never told either. Open it in Google
Sheets with File → Import → Upload. The terminal dashboard exports with `e`, and
the web dashboard has an Export link on its Accounts panel.

### What each session carries

Every turn re-sends the whole conversation, so the context a session carries is
what it costs per turn. At 600k tokens a turn re-reads eighteen times what a
fresh session does, even when nothing new happens. On a machine running a dozen
long sessions most spend goes to that: on the one this was measured on, main
threads spent a third of their turns above 600k, and those turns were over half
of their spend. Seeing it is what tells you a session is due a hand-off.

Each running session shows the context of its main thread's latest turn, with a
bar up to where Claude Code compacts (about 967k on 1M-context models), and what
re-reading it costs per turn. Beside it: how many of its subagents have worked in
the last 15 minutes, by name in the browser, and how many of its turns this hour
re-wrote a lapsed cache (`↻`), and what that cost. Colour follows the context:
amber past 400k, orange past 600k, red past 800k.

It costs nothing to read: every call's tokens are already in the index.

Each machine works this out for its own sessions and sends it with them when it
syncs, so both dashboards show every session's detail. A machine on an older
tracker sends none; its calls are synced all the same, so its sessions' context
and re-written caches are worked out from them here, and only its subagents and
GPU waits are missing. Each tracker also sends which commit it runs, and a
machine on an older or newer one is named at the top of both dashboards and in
`claude-tracker sync`, with what updates it: `git pull` in its claude-tracker
checkout, then `claude-tracker service install`.

### The shared GPU and CPU pool

On a machine where claude-core's `gpu` and `heavy` lease commands
share out the GPU and CPU among sessions, a job can wait a long time behind
someone else's render, and neither tool says whose session is waiting. The
tracker reads their state - `/tmp/box-gpu` and `/tmp/box-heavy`, or wherever
`BOX_GPU_DIR` and `BOX_HEAVY_DIR` point - and names every holder and waiter by
its Claude session and worktree, from the job's own environment: Claude Code
puts `CLAUDE_CODE_SESSION_ID` in every command it runs.

Both dashboards and `claude-tracker sessions` show who holds the GPU and for how
long, who waits behind it, oldest first, with one agent's batch of jobs as one
wait, and what the lease log says about the last hour: how long jobs waited in
all, the longest wait and the longest hold. The CPU pool says when its slots are
free but the load keeps jobs waiting. Each running session that has a job
waiting says so on its own row. A synced machine's pool shows on the other, as
it last reported it.

A Mac has no `/proc` to read an environment from, so there jobs are listed by
project. A machine without either tool shows neither.

### This machine: who has the cores, and who goes first

Seven sessions sharing one box each see only their own work. The **This machine**
panel shows all of it: cores busy, memory, the GPU and the job pool, a bar of
who has the cores right now, the last hour a column a minute, and every project
with what it uses. Open a project to see its sessions (with the processes doing
the work: `vitest`, not `node`), its jobs in the pool, its jobs waiting and the
reason each gives (`gives way to my-app, higher in the owner's priorities`,
`waits for the load: 41 threads want a CPU, gate 30`), and what it left running:
processes of a session that has ended, or of a job whose `heavy` was killed.
What belongs to no project (the desktop, the browser, this tracker, short-lived
processes) folds into one line. The sampler reads `/proc` and each job's cgroup
every 3 s, and costs about 50 ms of one core each time.

Each project has four choices, which set its priority on claude-core's `heavy`
pool for every session at once:

| | Starts its jobs | Share of the cores when they run out |
|---|---|---|
| **High** | before other projects' waiting jobs, and may borrow slots | 4× normal |
| **Normal** | first come, first served | 1× |
| **Low** | after higher projects that want a slot | 1/5 |
| **Paused** | nothing new | idle CPU only, for what already runs |

The share applies to jobs that are running already: each project's jobs run in a
systemd slice of their own, and the slice's `CPUWeight` changes the moment you
click. A long benchmark is never killed to make room, only slowed. Waiting jobs
take the new order within a poll (2 s). **Run next** on one waiting job starts it
before every other as soon as a slot is free. `heavy` holds the rule
(`~/.local/state/box/priority.json`); the dashboard, `claude-tracker priority`
and `heavy --priority` all go through it, and agents are kept from setting
priorities by claude-core's command guard.

On a Mac the sampler reads `ps`, `vm_stat`, `sysctl` and `ioreg` instead. With
no cgroups there, a job is its `heavy` process and everything under it, and the
GPU shows how busy it is and how much of the shared memory it holds.

**Every synced machine.** Machines that sync (see *Syncing machines*) send each
other these panels every few seconds, and the disk survey whenever it runs again.
The panel's title has a switch with each machine's name: pick one to see its
cores and disks from here. A priority or **Run next** set for another machine
goes over the sync connection to the tracker running there, which sets it with
that machine's `heavy`, so the Mac's dashboard ranks the Linux box's projects and
the other way round. A machine that stops sending shows when it was last heard
from, and its buttons wait until it is back.

The dashboard's writes (priority, run next, rescan) only come from the dashboard
itself: a loopback `Host`, the same `Origin`, and a JSON body, so no other page
open in your browser can send one.

### Disk space

A few times a day, at idle disk priority, the tracker measures where the disks
went and whose it is: each project's checkout, worktrees, scratchpads, temp
folders and transcripts, the caches named for a project, the shared caches, and
Claude Code's own folder. **Not cleaned up** ranks what nothing uses any more:
scratchpads of sessions that ended days ago, worktrees no session has touched in
a week, idle temp folders. Under it are the commands that clean up safely:
`tmp-sweep`, `wt prune` per repository, and caches that only ever grow (Node's
compile cache, npm's, uv's). The tracker deletes nothing itself. Each disk
shows how much it grew in a day, and each owner too, so a runaway cache stands
out. `claude-tracker storage --rescan` measures now.

On a Mac the survey uses BSD `du` (or Homebrew's `gdu`) at background priority,
covers both `/tmp` and the per-user temp folder, counts `~/Library`'s caches,
logs and developer tools as caches, and never opens Desktop, Documents,
Downloads, Pictures, Movies, Music or the rest of `~/Library`, since macOS would
ask you in a dialog first.

A temp folder counts as a project's when its name starts with the project's
(`my-app-release-3`). Tools that use a short prefix instead (`ma-run-1`) can be
named in `~/.claude/tracker/temp-prefixes.json`: `{"ma": "my-app"}`.

### Cache re-written after a pause

Most of a turn's context is read from the prompt cache. The cache lapses after a
pause - by default 5 minutes for subagents and an hour for the main thread on a
subscription - and the turn after it writes the whole context again, at 12 to 20
times the price of reading it. A subagent waiting 9 minutes for the GPU with
500k of context pays that on its next turn.

Both dashboards and `claude-tracker models` show how much the last day and
week of such turns cost, as a share of all spend, for subagents and the main
thread apart, and how long each keeps its cache now. A turn counts when at least
half of a context of 50k or more was written rather than read; a fresh agent's
first turn is smaller than that. While subagents still write 5-minute caches and
it costs more than a twentieth of spend, the dashboards name the setting that
keeps them an hour, `"subagentPromptCacheTtl": "1h"` in `settings.json`; once
they write hour-long caches, the advice goes away and the figures show what
changed.

### Realtime

Both dashboards run off one watcher inside the tracker process:

- **Throttled, not debounced.** Transcript writes are coalesced for at most
  200ms, and no change is ever held longer than 800ms. (Waiting for a quiet gap
  starves: with many sessions running, one never comes.)
- **Only changed files are read.** The watcher passes the paths that changed, so
  a refresh reads just those instead of statting thousands of transcripts.
- **A `/login` shows within about 2 seconds**, even if the OS drops the file
  event — each profile's signed-in account is also polled every 2s.
- **Cheap reads.** Lifetime totals are cached and only recent calls re-summed;
  window reconstruction resumes where it left off. A dashboard update costs about
  20ms on a quarter-million-call index.
- Accounts and running sessions re-render on every push; the charts every 10s.
  The terminal header shows when its numbers were read.

Measured with 20 simulated sessions writing 40 calls a second on top of a copy of
a real 249,000-call index, every interactive session reporting through the status
line, and terminal and web dashboards running together:

| | median | p95 | max |
|---|---|---|---|
| Age of the numbers on screen, web | 0.72s | 1.28s | 1.76s |
| Age of the numbers on screen, terminal | 0.94s | 1.44s | 1.85s |

Halfway through, a `/login` is typed into one session; the other interactive
sessions record nothing, as real ones don't. The new account showed as billing
in 0.4s on both dashboards, and every running session had moved over in the live
list within 1.4s; the longest gap between pushes was 1.2s. Every call was checked
against the account that actually made it, with a background job kept on its
original account throughout - a call made in the second between the config
changing and its session noticing counts as either. `python3 bench/run_load.py`
reproduces this.

### What the dollar figures mean

They are **not your bill.** On a subscription you are not billed per token, and
these numbers are usually many times what you actually pay — that is the point of
the plan.

Different models draw down quota at very different rates, so usage is normalised
to a common unit before being summed: what the same tokens would cost at list API
prices. `$317` means "as much quota as $317 of pay-as-you-go API usage would
consume." It is the unit the rate-limit maths runs in, and it is what makes an
Opus call and a Haiku call comparable.

Two things dominate the total and surprise people: **cache reads**, which are
cheap per token but enormous in volume (a long agentic session re-reads its whole
context on every turn), and **subagent and workflow turns**, which are billed like
any other call.

The arithmetic is checked against Claude Code's own per-session cost accounting:
on single-run sessions the two agree to within about 4%. They diverge on sessions
that were resumed, because Claude Code's counter resets on resume and only covers
the final run — a 26-day session in this repo's own data reports 40 minutes of API
time against 13,406 calls. Where they disagree that way, the figure here is the
more complete one.

### Renewal dates

Claude records when each subscription started, but never when it next renews, so
the cycle is projected forward from the start date: same day of month, clamped to
the last day in shorter months. The dashboards show the next renewal, how far
through the period you are, and what you have used inside it.

This is an estimate and is labelled as one. It assumes a monthly cycle, so an
annual plan will read wrong, and it cannot see a plan that was cancelled, paused,
or switched. The renewal date is only as good as the subscription start date on
disk.

### Why some accounts show a UUID instead of an email

Usually they don't: each profile's config and its backups name the account
signed into it, so most accounts resolve to an email on their own.

One case still leaves a UUID. An account only appears by name where its own
config still exists — if a profile was signed out and re-signed to a different
account, and its backups have since rotated away, the older account's name is
gone even though its transcripts remain. The same is true of an account used
only through a profile you have deleted.

Signing into that account again while the tracker is running names it
permanently. Or name it yourself:

```sh
claude-tracker accounts                       # shows the UUIDs
claude-tracker label a1b2c3d4 "work account"  # a prefix is enough
```

An account can also be missing entirely: accounts are discovered from local
traces, so one never used on this machine — or used only from a config directory
that has since been deleted — leaves nothing to discover.

### The limit windows

Subscriptions enforce a rolling 5-hour "session" limit and a rolling 7-day limit.
Neither is anchored to the clock: a window opens on the first request made after
the previous one lapsed, and runs for a fixed span.

The 10-minute rounding this implementation uses is not a guess. Every time the
API refuses a request it reports the exact `resetsAt` for that window, and those
are recorded. Comparing them against local transcript timestamps shows the window
opening on the 10-minute boundary at or before the window's first request.
`claude-tracker verify` re-runs that check against your own data and prints how
far off each reconstructed boundary was:

```
  ✓ Session (5h)   reset 9/10/2026, 9:20:00 AM   0m off
  ✓ Session (5h)   reset 9/9/2026, 12:00:00 PM   0m off
  ~ Weekly (7d)    reset 9/14/2026, 3:00:00 PM   360m off
```

A reported reset that has not yet passed always wins over reconstruction — it
names the current window's exact end, so no inference is needed at all.

Besides these two, Claude Code tracks separate weekly caps for Opus and Sonnet.
Their fill level isn't exposed anywhere the tracker can read, so they appear
only when a refusal reveals one — and the account is then shown blocked on that
limit until it resets.

### Where the ceiling comes from

Anthropic does not publish subscription limits as a token or dollar figure, so a
hardcoded ceiling would be fiction. Two things measure it instead:

- **Exact readings**, with the status line installed. When Claude Code reports a
  window as p% full, the spend in it so far, scaled to 100%, is the ceiling. No
  limit has to be hit.
- **Refusals.** At the moment the API refuses a request the window was full, so
  the spend in it up to the refusal is the ceiling.

Because models draw down quota at very different rates, spend is normalised to a
common unit — list API price — before being compared.

| Label | Meaning |
|---|---|
| exact | reported by Claude Code; nothing estimated |
| measured | two or more refusals on this account |
| approximate | a single refusal |
| borrowed | nothing on this account yet; another account's solid ceiling |
| estimated | nothing measured anywhere yet |

Only solid ceilings — exact, or two or more refusals — are lent to other
accounts. A single refusal can be badly off, and lending it spreads the error
to every account on the plan.

## Accuracy, honestly

- **Exact where a session is running**, with the status line installed.
  Otherwise percentages are estimates, marked `≈`. Reset times are exact
  whenever Claude Code or the API has reported one.
- **Estimates only see this machine** and the machines it syncs with. Usage
  from claude.ai or anywhere else counts against the same limits but leaves no
  trace here; exact readings do include it.
- **Renewal dates assume a monthly cycle**, projected from the subscription
  start, and aren't shown for prepaid or organisation seats.
- **Attribution is per call**, exact from the moment the tracker runs; older
  history leans more on inference, and anything unresolvable is shown as
  unattributed.
- **Weekly Opus and Sonnet caps** show only once a refusal reveals them.
- **History is kept.** Claude Code deletes old transcripts; the tracker's index
  keeps every call it has seen, across upgrades.

## Privacy

Everything stays on this machine, unless you sync it: then the index is copied
to the machines you added, over ssh, and theirs to this one. The tracker reads
Claude Code's transcripts and config files. It reads and moves sign-ins only to fail over, between profiles on the same machine, never anywhere else. `statusline install` edits only the
`statusLine` key of each profile's `settings.json`, after writing a backup.
From the jobs holding or waiting for the GPU and CPU pool, it reads
`/proc/<pid>/environ` - your own processes only - for two variables,
`CLAUDE_CODE_SESSION_ID` and `PWD`, and keeps nothing else from it.
Notifications go through macOS's own notification centre, and into Slack when it
is set up. With Slack set up, what your sessions say is posted to the channel you
paired it with, and nowhere else. Its tokens are kept in
`~/.claude/tracker/slack.json`, readable only by you. A synced machine with Slack
set up can type into the sessions on this one. `claude-tracker slack off` here
stops that. The web server binds
to `127.0.0.1` only, and the index lives in `~/.claude/tracker/`. A sync
connection reaches it only through `sync serve`, which has to show a token kept
in a file only you can read.

## Development

```sh
node --test                     # unit tests, two trackers syncing, and sessions driven from Slack, end to end
CT_TEST_SSH=ssh CT_TEST_HOST=me@localhost node --test test/sync.test.js   # the same, over real ssh
python3 bench/run_load.py   # end-to-end realtime test (needs Chrome)
```

The tests run against a scratch database and synthetic fixtures, so they do not
depend on your own usage history.

## Layout

| Path | What it does |
|---|---|
| `src/ingest.js` | incremental transcript scanner |
| `src/accounts.js` | account discovery and attribution |
| `src/windows.js` | rolling-window reconstruction |
| `src/calibrate.js` | learns each plan's ceiling from observed limits |
| `src/watcher.js` | throttled file watching, account-switch detection |
| `src/aggregates.js` | cached per-account totals for cheap live reads |
| `bin/statusline.js` | status-line command: records exact utilization, prints it |
| `src/statusline.js` | installs that command into each profile |
| `src/live.js` | turns status-line snapshots into exact readings |
| `src/notify.js` | deduplicated desktop notifications |
| `src/service.js` | the login service: launchd or systemd |
| `src/replica.js` | what syncing copies between machines, and how it merges |
| `src/sync.js` | the sync connection: ssh, the relay, the protocol |
| `src/failover.js` | which account a profile switches to when its own runs low, and when |
| `src/panes.js` | the sessions in tmux panes: what each says, and typing into it safely |
| `src/slack.js` | Slack's Web API and Socket Mode, and Markdown as Slack shows it |
| `src/bridge.js` | a thread per session in Slack, and replies typed back in |
| `src/signin.js` | a profile's sign-in, read and moved the way Claude Code keeps it |
| `src/billing.js` | projects the subscription cycle from its start date |
| `src/api.js` | aggregation for both dashboards |
| `src/context.js` | what each session carries per turn, and caches re-written after a pause |
| `src/box.js` | the shared GPU lease and CPU pool, each job named by its session |
| `src/machine.js` | what uses this machine: every process by project, session and job; the owner's priorities |
| `src/storage.js` | who fills the disks, and what was left behind |
| `src/tui.js` | terminal dashboard |
| `src/server.js` | HTTP API, static files, live updates |
| `web/` | browser dashboard |
| `fakes/` | stand-ins for Slack and Claude Code's terminal, for the tests |

## License

MIT
