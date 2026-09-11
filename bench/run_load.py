# End-to-end realtime test for claude-tracker.
#
# Runs the real tracker - terminal and web dashboards together, in one process -
# against an isolated profile, while 20 simulated sessions write about 40 calls a
# second. Halfway through it performs a /login to a second account; one session
# is a background job that must keep its original account. It then measures how
# stale the numbers on screen are, how fast the switch shows up, and checks every
# call landed on the account that made it.
#
#   python3 bench/run_load.py                   # fresh, empty index
#   python3 bench/run_load.py --seed PATH.db    # on top of a copy of a real index
#
# Needs Google Chrome (override the path with CHROME=...). Exits non-zero if any
# call is misattributed or pushes ever stall for more than two seconds.
import os, sys, json, tempfile, time, pty, select, subprocess, signal, re, fcntl, termios, struct, shutil, threading, urllib.request, sqlite3, bisect, statistics
S = os.path.dirname(os.path.abspath(__file__)); REPO = os.path.dirname(S)
SEED = sys.argv[sys.argv.index('--seed') + 1] if '--seed' in sys.argv else None
PORT, CDP, N, COST = 4931, 9333, 20, 0.025
CHROME = os.environ.get('CHROME', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
root = tempfile.mkdtemp(prefix='claude-tracker-load-')
home = f'{root}/home'; prof = f'{home}/.claude'; proj = f'{prof}/projects/-tmp-load'; sess = f'{prof}/sessions'
for d in (proj, sess, f'{root}/db'): os.makedirs(d)
if SEED:   # consistent snapshot even if the source has a WAL
    src = sqlite3.connect(SEED); dst = sqlite3.connect(f'{root}/db/tracker.db')
    src.backup(dst); dst.close(); src.close()
    print(f'seeded from {SEED}: {sqlite3.connect(f"{root}/db/tracker.db").execute("SELECT COUNT(*) FROM events").fetchone()[0]:,} existing calls')
open(f'{prof}/settings.json', 'w').write('{}')
UUID = {'alice@test.dev': 'aaaaaaaa-0000-0000-0000-000000000001', 'bob@test.dev': 'bbbbbbbb-0000-0000-0000-000000000002'}
def login(email):   # atomic replace, the way Claude Code rewrites its config
    tmp = f'{home}/.claude.json.tmp.{os.getpid()}'
    json.dump({'oauthAccount': {'accountUuid': UUID[email], 'emailAddress': email,
               'organizationRateLimitTier': 'default_claude_max_20x', 'subscriptionCreatedAt': '2026-08-01T00:00:00Z'}}, open(tmp, 'w'))
    os.replace(tmp, f'{home}/.claude.json')
login('alice@test.dev')
env = dict(os.environ, HOME=home, CLAUDE_TRACKER_DIR=f'{root}/db', TERM='xterm-256color', COLORTERM='truecolor')

pid, fd = pty.fork()                       # the tracker: TUI + web, one process
if pid == 0:
    os.chdir(REPO); os.execvpe('node', ['node', 'bin/cli.js', 'serve', '--port', str(PORT), '--no-notify'], env)
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', 160, 130, 0, 0))
frames, buf = [], [b'']
def reader():
    while True:
        try: r, _, _ = select.select([fd], [], [], 0.2)
        except Exception: return
        if fd not in r: continue
        try: chunk = os.read(fd, 1 << 16)
        except OSError: return
        if not chunk: return
        now = time.time(); buf[0] += chunk
        parts = buf[0].split(b'\x1b[H')
        for p in parts[:-1]:
            if p: frames.append((now, p.decode('utf8', 'replace')))
        buf[0] = parts[-1]
threading.Thread(target=reader, daemon=True).start()
for _ in range(120):
    try: urllib.request.urlopen(f'http://127.0.0.1:{PORT}/api/overview', timeout=1); break
    except Exception: time.sleep(0.5)

sse = []
def sse_rec():
    try:
        for line in urllib.request.urlopen(f'http://127.0.0.1:{PORT}/events', timeout=300):
            if line.startswith(b'event: update'): sse.append(time.time())
    except Exception: pass
threading.Thread(target=sse_rec, daemon=True).start()

chrome = subprocess.Popen([CHROME, '--headless', '--disable-gpu', f'--remote-debugging-port={CDP}', f'--user-data-dir={root}/chrome', 'about:blank'],
                          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(3)
cdp = subprocess.Popen(['node', f'{S}/cdp-sample.mjs', f'http://127.0.0.1:{PORT}/', f'{root}/dom.jsonl', '56000', str(CDP)])
time.sleep(4)

live = f'{root}/db/live'; os.makedirs(live, exist_ok=True)
RESET_BASE = int(time.time()) // 600 * 600
T0 = time.time()
writers = [subprocess.Popen(['node', f'{S}/writer.mjs', proj, sess, f'{i:08d}-aaaa-bbbb-cccc-{i:012d}', f'load-{i:02d}', '1' if i == 0 else '0', root, live, str(RESET_BASE)])
           for i in range(N)]
time.sleep(20)
T_SWITCH = time.time()
login('bob@test.dev'); time.sleep(0.1); open(f'{root}/switch.flag', 'w').write('1')
time.sleep(22)
for w in writers: w.terminate()
T_END = time.time()
time.sleep(5)
cdp.wait(timeout=60)
os.write(fd, b'q'); time.sleep(2)
try: os.kill(pid, signal.SIGTERM)
except Exception: pass
chrome.terminate()

# ---------------------------------------------------------------- analysis
log = [l.split() for l in open(f'{root}/calls.log')]
db = sqlite3.connect(f'{root}/db/tracker.db')
stored = dict(db.execute(f'''SELECT e.call_id, a.email FROM events e LEFT JOIN accounts a ON a.account_uuid = e.account_uuid
    WHERE e.call_id IN ({','.join('?' * len(log))})''', [row[3] for row in log]))
# A session that did not type the /login moves when its process picks up the new
# login - within the second after the config changed. A call in that second is
# ambiguous by nature, so it counts as whichever account the tracker chose.
BG = '00000000-aaaa-bbbb-cccc-000000000000'
ambiguous = 0
for row in log:
    if row[2] != BG and row[1] == 'alice@test.dev' and T_SWITCH <= int(row[0]) / 1000 < T_SWITCH + 1 and stored.get(row[3]) == 'bob@test.dev':
        row[1] = 'bob@test.dev'; ambiguous += 1
writes = {'alice@test.dev': [], 'bob@test.dev': []}
for ms, acct, sid, cid in log: writes[acct].append(int(ms) / 1000)
for v in writes.values(): v.sort()
def staleness(t, acct, cost):
    """How old the displayed number is: now minus when that many calls had been written."""
    n = round(cost / COST); w = writes[acct]
    if n <= 0: return None
    if n > len(w): return 'OVER'
    return t - w[n - 1] if w[n - 1] <= t else 0.0
money = re.compile(r'\$([\d.]+)(k?)')
def cost_of(txt):
    m = money.search(txt or '');
    return (float(m.group(1)) * (1000 if m.group(2) else 1)) if m else None
def summarize(name, vals):
    over = sum(1 for v in vals if v == 'OVER'); vals = sorted(v for v in vals if isinstance(v, float))
    if not vals: return print(f'  {name}: no samples')
    p = lambda q: vals[min(len(vals) - 1, int(q * len(vals)))]
    print(f'  {name}: {len(vals)} readings  median {statistics.median(vals):.2f}s  p95 {p(.95):.2f}s  max {vals[-1]:.2f}s' + (f'  OVERCOUNT {over}' if over else ''))

print(f'\nload{" (seeded with real index)" if SEED else ""}: {N} sessions, {len(log)} calls in {T_END - T0:.0f}s ({len(log) / (T_END - T0):.0f} calls/s), /login at +{T_SWITCH - T0:.0f}s\n')
gaps = [b - a for a, b in zip(sse, sse[1:]) if T0 + 1 < a < T_END]
print('push cadence while writing (SSE update events):')
print(f'  {len([s for s in sse if T0 < s < T_END])} pushes; gap median {statistics.median(gaps):.2f}s, max {max(gaps):.2f}s' if gaps else '  NO PUSHES')

web, tui = [], []
dom = [json.loads(l) for l in open(f'{root}/dom.jsonl')]
for s in dom:
    t = s['t'] / 1000
    if not (T0 + 2 < t < T_END): continue
    for c in s['cards']:
        acct = (c['name'] or '').strip()
        if acct in writes and cost_of(c['meta']) is not None: web.append(staleness(t, acct, cost_of(c['meta'])))
strip = re.compile(r'\x1b\[[0-9;?]*[a-zA-Z]')
for t, raw in frames:
    if not (T0 + 2 < t < T_END): continue
    txt = strip.sub('', raw)
    for acct in writes:
        m = re.search(re.escape(acct) + r'[^\n]*?(\$[\d.]+k?) ·', txt)
        if m: tui.append(staleness(t, acct, cost_of(m.group(1))))
print('\nstaleness of the numbers on screen during continuous writes:')
summarize('web (DOM) ', web); summarize('terminal  ', tui)

def first(samples, pred):
    for t, v in samples:
        if t > T_SWITCH and pred(v): return t - T_SWITCH
print('\nreaction to the /login:')
web_bob = [(s['t'] / 1000, s) for s in dom]
r = first(web_bob, lambda s: any((c['name'] or '').strip() == 'bob@test.dev' and (cost_of(c['meta']) or 0) > 0 for c in s['cards']))
print(f'  web shows bob billing        +{r:.2f}s' if r is not None else '  web NEVER showed bob billing')
r = first(web_bob, lambda s: sum('bob@test.dev' in (x['sub'] or '') for x in s['live']) == N - 1 and any('alice@test.dev' in (x['sub'] or '') and 'background' in (x['sub'] or '') for x in s['live']))
print(f'  web live list: {N-1} sessions on bob, bg job still alice  +{r:.2f}s' if r is not None else '  web live list NEVER reached the expected split')
r = first([(t, strip.sub('', raw)) for t, raw in frames], lambda x: re.search(r'bob@test\.dev[^\n]*?\$(\d+\.\d\d) ·', x) and float(re.search(r'bob@test\.dev[^\n]*?\$(\d+\.\d\d) ·', x).group(1)) > 0)
print(f'  terminal shows bob billing   +{r:.2f}s' if r is not None else '  terminal NEVER showed bob billing')

want, sids = {}, set()
for ms, acct, sid, cid in log: want[(sid, acct)] = want.get((sid, acct), 0) + 1; sids.add(sid)
# Only the simulated sessions - a seeded index also holds real history.
got = {(s, e): n for s, e, n in db.execute(f'''SELECT e.session_id, a.email, COUNT(*) FROM events e
    LEFT JOIN accounts a ON a.account_uuid = e.account_uuid
    WHERE e.session_id IN ({','.join('?' * len(sids))}) GROUP BY 1, 2''', sorted(sids))}
bad = {k: (want.get(k, 0), got.get(k, 0)) for k in set(want) | set(got) if want.get(k, 0) != got.get(k, 0)}
print(f'\nattribution, call by call: {sum(want.values())} written, {sum(got.values())} stored, {len(bad)} session/account mismatches')
print(f'  ({ambiguous} calls fell in the second between the config switch and their session noticing it)')
for k, v in list(bad.items())[:6]: print('  mismatch', k, 'written/stored', v)
# Exact utilization reached both dashboards through the status-line path.
last_dom = dom[-1] if dom else {'cards': []}
exact_web = sorted((c['name'] or '').strip() for c in last_dom['cards'] if c.get('exact'))
last_txt = strip.sub('', frames[-3][1]) if len(frames) > 3 else ''
exact_tui = sorted(a for a in writes if re.search(re.escape(a) + r'[^\n]*exact ·', last_txt))
print(f'\nexact readings shown  web: {exact_web or "none"}   terminal: {exact_tui or "none"}')
print(f'"use now" on the web: {last_dom.get("useNow")}')
bad = bad or ({} if 'bob@test.dev' in exact_web and 'bob@test.dev' in exact_tui else {'exact': 'not shown'})
last = last_txt
print('\nlast terminal frame (top):'); print('\n'.join(l.rstrip() for l in last.split('\n')[:22]))

print(f'\nartifacts: {root}')
sys.exit(1 if bad or not gaps or max(gaps) > 2 else 0)
