# claude-tracker

A local dashboard for people running Claude across several accounts, who keep
hitting a limit without warning and having to work out which account still has
room.

It reads the transcripts Claude Code already writes, across every config
directory you use, reconstructs the 5-hour and 7-day rate-limit windows per
account, and shows how full each one is right now — in the terminal, in the
browser, or both at once. New accounts are picked up on their own.

Everything stays on your machine. There are no dependencies, no API calls, and
no network access beyond a loopback HTTP server you start yourself.

```
  Claude Tracker                     ● live · updated 09:32:16 · 127.0.0.1:4785

  Session (5h) · work@example.com
  24% used            ████████░░░░░░░░░░░░░░░░░░░░░░░░  resets in 1h 22m

  USE NOW  personal@example.com  96% headroom  CLAUDE_CONFIG_DIR=~/.claude-personal claude

   RUNNING NOW · 3 sessions ─────────────────────────────────────────────────
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

Then, from anywhere:

```sh
claude-tracker
```

That is the whole thing: terminal dashboard and web dashboard, together.
(`npm unlink -g claude-tracker` undoes it.)

## Use

Run it from any directory once linked:

| Command | What you get |
|---|---|
| `claude-tracker` | terminal + web dashboard together |
| `claude-tracker --open` | ...and opens the browser |
| `claude-tracker tui` | terminal only, no HTTP server |
| `claude-tracker serve --no-tui` | web only, good for leaving running |
| `claude-tracker status` | one-shot summary — fine for a shell prompt |
| `claude-tracker models --days 7` | where the spend went |
| `claude-tracker verify` | check the window model against your own resets |
| `claude-tracker accounts` | list accounts and their UUIDs |
| `claude-tracker label a1b2c3d4 "work"` | name an account by UUID prefix |
| `claude-tracker statusline install` | exact limit numbers, from each profile's status line |
| `claude-tracker service install` | keep it running in the background from login (macOS) |

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

In the terminal dashboard: `q` quit · `r` refresh · `a` cycle account ·
`w` switch window · `space` pause · `↑↓`/`jk` scroll.

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

`claude-tracker service install` adds a per-user launchd agent that runs the web
dashboard from login and restarts it if it stops; `service status` and `service
uninstall` do what they say. It matters for accuracy as much as convenience: the
tracker only sees the moment you switch accounts while it is running. The log is
`~/.claude/tracker/service.log`.

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
- **Estimates only see this machine.** Usage from claude.ai or other devices
  counts against the same limits but leaves no local trace; exact readings do
  include it.
- **Renewal dates assume a monthly cycle**, projected from the subscription
  start, and aren't shown for prepaid or organisation seats.
- **Attribution is per call**, exact from the moment the tracker runs; older
  history leans more on inference, and anything unresolvable is shown as
  unattributed.
- **Weekly Opus and Sonnet caps** show only once a refusal reveals them.
- **History is kept.** Claude Code deletes old transcripts; the tracker's index
  keeps every call it has seen, across upgrades.

## Privacy

Everything stays on this machine. The tracker reads Claude Code's transcripts and
config files, and never reads credentials. `statusline install` edits only the
`statusLine` key of each profile's `settings.json`, after writing a backup.
Notifications go through macOS's own notification centre. The web server binds
to `127.0.0.1` only, and the index lives in `~/.claude/tracker/`.

## Development

```sh
node --test                     # unit tests: windows, pricing, attribution
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
| `src/service.js` | the launchd login service |
| `src/billing.js` | projects the subscription cycle from its start date |
| `src/api.js` | aggregation for both dashboards |
| `src/tui.js` | terminal dashboard |
| `src/server.js` | HTTP API, static files, live updates |
| `web/` | browser dashboard |

## License

MIT
