# claude-tracker

A local dashboard for people running Claude across several accounts, who keep
hitting a limit without warning and having to work out which account still has
room.

It reads the transcripts Claude Code already writes to `~/.claude/projects`,
reconstructs the 5-hour and 7-day rate-limit windows per account, and shows how
full each one is right now — in the terminal, in the browser, or both at once.

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

Node 22.5 or newer. Nothing else.

```sh
git clone https://github.com/Xaxis/claude-tracker
cd claude-tracker
node bin/cli.js serve
```

Optionally link it so it is on your `PATH`:

```sh
npm link          # then just: claude-tracker
```

## Use

```sh
claude-tracker                 # terminal dashboard + web dashboard together
claude-tracker serve --open    # ...and open the browser for you
claude-tracker serve --no-tui  # web only (for running in the background)
claude-tracker tui             # terminal only, no HTTP server
claude-tracker status          # one-shot summary, good for a shell prompt
claude-tracker models --days 7 # what the spend went to
claude-tracker verify          # check the window model against reality
```

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

### Which account did what

Nothing in a transcript names the account that paid for it, with one exception:
sessions that used the Claude Code bridge record their owner outright. Everything
else is reconstructed, and the source of each attribution is tracked:

- **bridge** — the transcript states the owner. Authoritative.
- **observed** — the watcher saw who was signed in at that moment. While
  `claude-tracker` is running it samples `~/.claude.json` continuously, so
  attribution for new sessions is exact.
- **inferred** — the session sits between two moments that agree on the account.

Two rules keep this honest. When the surrounding evidence disagrees, the session
is left unattributed rather than guessed at, and the unattributed total is
reported on the dashboard so you can see the size of the gap. And a session is
never attributed to an account that the API had rate limited at that moment —
hitting a limit is exactly when you switch accounts, which is exactly when naive
inference would otherwise keep crediting the account you just left.

Historical attribution is imperfect by nature; the further back you look, the
more of it is inferred. It becomes exact from the moment you start running this.

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
- **Transcripts are eventually cleaned up.** Windows that extend past the oldest
  retained transcript will read low.
- **Concurrent accounts are assumed rare.** Attribution assumes one signed-in
  account at a time per config directory, which is how the CLI works unless you
  deliberately run separate `CLAUDE_CONFIG_DIR` profiles.

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
| `src/api.js` | aggregation for both dashboards |
| `src/tui.js` | terminal dashboard |
| `src/server.js` | HTTP API, static files, live updates |
| `web/` | browser dashboard |

## License

MIT
