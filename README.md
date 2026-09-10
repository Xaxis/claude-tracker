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
  Claude Tracker                                    ● live · 127.0.0.1:4785

  Session (5h) · work@example.com
  24% used            ████████░░░░░░░░░░░░░░░░░░░░░░░░  resets in 1h 22m

   ACCOUNTS ──────────────────────────────────────────────────────────────────

  ● work@example.com     max 20x                          $317 · 7 sessions
    Session (5h)   ██████░░░░░░░░░░░░░░░░░  24% resets 1h 22m    plenty left
    Weekly (7d)    █░░░░░░░░░░░░░░░░░░░░░░   3% resets 6d 20h    plenty left

  ○ personal@example.com                             $35.7k · 97 sessions
    Session (5h)   ███░░░░░░░░░░░░░░░░░░░░  16% resets 4h 42m    plenty left
    Weekly (7d)    █████████████████████   100% resets 4d 5h     limit reached
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

Both dashboards run in one process off a single file watcher, so the browser and
the terminal never disagree and the transcripts are only scanned once.

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

That last part is the important one. **A config directory holds exactly one
account at a time, so the directory a transcript lives under is the account that
paid for it.** No inference required.

`claude-tracker` discovers every profile at runtime — `~/.claude`, any
`~/.claude-*` sibling, anything named in `CLAUDE_CONFIG_DIR`, and anything listed
in `CLAUDE_TRACKER_EXTRA_DIRS` (colon-separated). Signing a new account into a
new directory makes it appear on its own, with no configuration; the watcher
re-scans while running, so a profile created after startup is picked up too. A
profile nested inside another is skipped, so a kept copy of an old tree does not
get scanned twice.

### Which account did what

Attribution is recorded with its source, strongest first:

- **bridge** — the transcript states the owner outright.
- **profile** — the profile's account timeline at the moment the session started.
  Each profile's config *and its rotating backups* form a dated record of who was
  signed into it, so this dates old sessions too, and handles a profile that
  changed accounts partway through.
- **observed** — the watcher saw who was signed in at that moment.
- **inferred** — the session sits between two moments that agree on the account.

Two rules keep it honest. When the evidence disagrees, the session is left
unattributed rather than guessed at, and the unattributed total is shown on the
dashboard so the size of the gap is visible. And a session is never attributed to
an account the API had rate limited at that moment — hitting a limit is exactly
when you switch accounts, which is exactly when naive inference would otherwise
keep crediting the account you just left.

Historical attribution is imperfect by nature; the further back you look, the
more of it is inferred. It becomes exact from the moment you start running this.

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

### Where the ceiling comes from

Anthropic does not publish subscription limits as a token or dollar figure, so a
hardcoded ceiling would be fiction. What is available is every moment the API
refused a request: at that instant the window was, by definition, full. Summing
usage in that window up to the refusal measures the capacity directly.

Because different models draw down quota at very different rates, usage is
normalised to a common unit — list API price — before being summed. The dollar
figures are that unit, not your bill. On a subscription you are not billed per
token; `$317` means "as much quota as $317 of API usage would consume."

Each reading is labelled with how much to trust it:

| Label | Meaning |
|---|---|
| measured | two or more observed limits on this account |
| approximate | a single observed limit |
| borrowed | no limit seen yet; using a ceiling measured on another account |
| estimated | nothing measured anywhere yet |

An account that has never been rate limited starts out estimated and sharpens
itself the first time it hits a wall.

## Accuracy, honestly

- **Percentages are estimates until an account has been limited at least once.**
  Reset times are exact whenever the API has reported one.
- **Only what is on this machine is visible.** Usage from claude.ai, other
  devices, or other machines counts against the same limits but leaves no local
  trace, so a reading can understate.
- **Renewal dates assume a monthly cycle** projected from the subscription start
  date; see above.
- **Transcripts are eventually cleaned up.** Windows that extend past the oldest
  retained transcript will read low.
- **One account per profile at a time.** That is how the CLI works, and it is
  what makes profile attribution exact. Several profiles running at once is fine
  and fully supported - each is tracked separately.

## Privacy

Reads local transcripts, `~/.claude.json`, and — only to learn the plan tier —
the subscription fields of the Claude keychain entries. Tokens are never read
into storage, logged, or transmitted. The HTTP server binds to `127.0.0.1` only.
The index lives in `~/.claude/tracker/` and never leaves the machine.

## Development

```sh
node --test          # unit tests over the window, pricing and attribution logic
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
| `src/billing.js` | projects the subscription cycle from its start date |
| `src/api.js` | aggregation for both dashboards |
| `src/tui.js` | terminal dashboard |
| `src/server.js` | HTTP API, static files, live updates |
| `web/` | browser dashboard |

## License

MIT
