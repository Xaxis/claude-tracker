import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { db } from './db.js';
import { DATA_DIR, discoverProfiles, ensureDataDir, HOME } from './paths.js';

/**
 * The Claude Code sessions running in tmux panes on this machine: what each one
 * says, and a way to type into it.
 *
 * Claude Code registers every running process in its profile's `sessions/`
 * directory, with the tmux pane it was started in and whether it is busy, idle,
 * or waiting on the person at the keyboard - a permission prompt, a question, a
 * dialog. Its transcript has everything said either way. So a session can be
 * followed without touching it, and driven exactly as from its keyboard: keys
 * typed into the pane run slash commands, answer prompts and interrupt turns,
 * which nothing else that reaches a running session can do.
 *
 * Keys are only ever sent to a pane whose foreground program is the Claude
 * process expected there. If Claude has exited, the pane is a shell, and text
 * typed into it would run as a command. Ctrl-C is never sent: two of them close
 * Claude Code, and the first only arms the second.
 */

const PROC = () => process.env.CLAUDE_TRACKER_PROC || '/proc';
const TICK_MS = Number(process.env.CLAUDE_TRACKER_PANES_MS) || 1000;
// Which pane each process is in hardly ever changes; checking it costs a ps
// and a tmux call, so it is redone on a slower beat - and before every action.
const PLACE_MS = 5000;
const BACKFILL_BYTES = 256 * 1024;
const CATCH_UP_BYTES = 4 * 1024 * 1024;
const CATCH_UP_ITEMS = 8;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };

function exec(cmd, args, { input, timeout = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(cmd, args, { encoding: 'utf8', timeout, maxBuffer: 4 << 20 }, (err, stdout, stderr) => {
      if (err) { err.message = (stderr || err.message).trim(); err.stdout = stdout; reject(err); } else resolve(stdout);
    });
    if (input != null) child.stdin.end(input);
  });
}

const tmux = (socket, args, opts) => exec('tmux', socket ? ['-S', socket, ...args] : args, opts);

/* --- what each pane holds --------------------------------------------------- */

/** The tmux server a process runs under, from its TMUX variable; null for the default one. */
const socketCache = new Map();
async function tmuxSocket(pid) {
  if (socketCache.has(pid)) return socketCache.get(pid);
  let env = '';
  try {
    env = fs.readFileSync(`${PROC()}/${pid}/environ`, 'utf8').replace(/\0/g, '\n');
  } catch {
    // No /proc (a Mac): ps prints a process's environment after its command.
    try { env = await exec('ps', ['eww', '-o', 'command=', '-p', String(pid)]); } catch { /* gone */ }
  }
  const sock = env.match(/(?:^|\s)TMUX=([^,\s]+),/m)?.[1] ?? null;
  if (socketCache.size > 500) socketCache.clear();
  socketCache.set(pid, sock);
  return sock;
}

/** Terminal, process group and command of each pid, from one ps. */
async function processes(pids) {
  const out = new Map();
  if (!pids.length) return out;
  let text = '';
  try { text = await exec('ps', ['-o', 'pid=,pgid=,tpgid=,tty=,args=', '-p', pids.join(',')]); } catch (err) {
    text = err.stdout ?? '';  // ps exits 1 when one of them has gone
  }
  for (const line of text.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(-?\d+)\s+(\S+)\s+(.*)$/);
    if (!m) continue;
    const tty = /^\?+$/.test(m[4]) ? null : m[4].replace(/^\/dev\//, '');
    out.set(Number(m[1]), { pgid: Number(m[2]), tpgid: Number(m[3]), tty, args: m[5] });
  }
  return out;
}

/** Every pane of a tmux server, by pane id. */
async function panesOf(socket) {
  const out = new Map();
  let text;
  try {
    text = await tmux(socket, ['list-panes', '-a', '-F',
      '#{pane_id}\t#{pane_tty}\t#{session_name}\t#{window_index}\t#{pane_index}\t#{pane_current_command}']);
  } catch { return out; }
  for (const line of text.split('\n')) {
    const [id, tty, session, win, pane, command] = line.split('\t');
    if (id) out.set(id, { id, tty: tty.replace(/^\/dev\//, ''), session, target: `${session}:${win}.${pane}`, command });
  }
  return out;
}

const isPrint = (args) => / (-p|--print)( |$)/.test(` ${args} `);

// Looking for profiles walks the home directory; once a tick is too often.
let profiles = null, profilesAt = 0;
function profilesNow() {
  if (!profiles || Date.now() - profilesAt > 30_000) { profiles = discoverProfiles(); profilesAt = Date.now(); }
  return profiles;
}

/** The live processes in every profile's session registry, once each. */
function registered() {
  const byPid = new Map();
  for (const profile of profilesNow()) {
    let names = [];
    try { names = fs.readdirSync(profile.sessionsDir); } catch { continue; }
    for (const n of names) {
      if (!n.endsWith('.json')) continue;
      const s = readJson(path.join(profile.sessionsDir, n));
      if (!s?.sessionId || !s.pid) continue;
      try { process.kill(s.pid, 0); } catch (err) { if (err.code !== 'EPERM') continue; }
      // A copied profile carries a copy of the registry; the newest entry is the live one.
      const prev = byPid.get(s.pid);
      if (!prev || (s.updatedAt ?? 0) > (prev.s.updatedAt ?? 0)) byPid.set(s.pid, { profile, s, file: path.join(profile.sessionsDir, n) });
    }
  }
  return byPid;
}

/** Where a session's transcript is: under its launch directory's slug, or wherever it is. */
function transcriptOf(profile, sessionId, cwd) {
  const name = `${sessionId}.jsonl`;
  if (cwd) {
    const p = path.join(profile.projectsDir, cwd.replace(/[^a-zA-Z0-9]/g, '-'), name);
    if (fs.existsSync(p)) return p;
  }
  let slugs = [];
  try { slugs = fs.readdirSync(profile.projectsDir); } catch { return null; }
  for (const slug of slugs) {
    const p = path.join(profile.projectsDir, slug, name);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/* --- what a transcript says ------------------------------------------------- */

const short = (s, n) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };
// eslint-disable-next-line no-control-regex
const stripAnsi = (s) => String(s).replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');

/** One tool call, as a few words: what it did and to what. */
export function toolSummary(block, cwd = null) {
  const i = block.input ?? {};
  const file = (p) => {
    if (!p) return '';
    const rel = cwd && p.startsWith(cwd + path.sep) ? p.slice(cwd.length + 1) : p;
    return rel.startsWith(HOME + path.sep) ? `~${rel.slice(HOME.length)}` : rel;
  };
  const name = String(block.name ?? '');
  switch (name) {
    case 'Bash': return { verb: 'ran', what: short(i.command, 120), note: i.description ? short(i.description, 80) : null };
    case 'Edit': case 'MultiEdit': case 'Write': case 'NotebookEdit':
      return { verb: 'edited', what: file(i.file_path ?? i.notebook_path) };
    case 'Read': return { verb: 'read', what: file(i.file_path) };
    case 'Grep': case 'Glob': return { verb: 'searched', what: short(i.pattern, 60) };
    case 'WebFetch': return { verb: 'fetched', what: short(i.url, 80) };
    case 'WebSearch': return { verb: 'searched the web for', what: short(i.query, 60) };
    case 'Agent': case 'Task': return { verb: 'started agent', what: short(i.description ?? i.subagent_type, 60) };
    case 'Skill': return { verb: 'used skill', what: short(i.skill, 40) };
    case 'TodoWrite': case 'TaskCreate': case 'TaskUpdate': case 'TaskList': case 'TaskGet': case 'ToolSearch': return null;
    default: {
      const m = name.match(/^mcp__(.+?)__(.+)$/);
      return m ? { verb: 'used', what: `${m[2]} (${m[1]})` } : { verb: 'used', what: name };
    }
  }
}

/** The text of a user entry's content, or null for tool results. */
function userText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content) || content.some((b) => b?.type === 'tool_result')) return null;
  return content.filter((b) => b?.type === 'text').map((b) => b.text).join('\n');
}

/**
 * What one transcript line adds to the conversation, as seen from outside:
 * what the person typed, what Claude wrote, and what it did in between. Tool
 * calls are held in `state.tools` until the next thing Claude writes, which
 * carries them. Subagents' turns, injected context and other sessions'
 * messages are left out - they are not the conversation.
 */
export function readEntry(e, state) {
  const out = [];
  if (!e || e.isSidechain) return out;
  // Where it works now: sessions restored from a shell in ~ carry on wherever they cd'd.
  if (e.cwd) state.cwd = e.cwd;
  // A title the person gave it outranks the one Claude Code made up.
  if (e.type === 'ai-title' && e.aiTitle) { if (!state.named) state.title = e.aiTitle; return out; }
  if (e.type === 'custom-title' && e.customTitle) { state.title = e.customTitle; state.named = true; return out; }
  const at = Date.parse(e.timestamp) || Date.now();
  if (e.type === 'user') {
    const text = userText(e.message?.content);
    if (text == null || e.isMeta || e.isCompactSummary) return out;
    if (/^\[Request interrupted by user/.test(text)) {
      out.push({ kind: 'note', text: 'interrupted', at, uuid: e.uuid });
      return out;
    }
    const cmd = text.match(/<command-name>([^<]*)<\/command-name>/);
    if (cmd) {
      const args = text.match(/<command-args>([^<]*)<\/command-args>/)?.[1]?.trim();
      out.push({ kind: 'prompt', text: `${cmd[1].trim()}${args ? ` ${args}` : ''}`, command: true, at, uuid: e.uuid });
      return out;
    }
    const stdout = text.match(/<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/);
    if (stdout) {
      const t = stripAnsi(stdout[1]).trim();
      if (t) out.push({ kind: 'note', text: short(t, 1500), at, uuid: e.uuid });
      return out;
    }
    // Only what a person typed. Newer versions say where each prompt came from,
    // and once a transcript has said so, a prompt that does not is something
    // injected. Older ones are told apart by how injected text is worded.
    if (e.origin || e.promptSource) state.origins = true;
    const human = e.origin ? e.origin.kind === 'human'
      : e.promptSource ? e.promptSource === 'typed' || e.promptSource === 'queued'
        : !state.origins && !/^\s*</.test(text) && !/^(Caveat:|Another Claude session sent a message)/.test(text);
    if (!human) return out;
    state.tools = [];
    state.turnTools = 0;
    state.lastTool = null;
    state.said = null;
    out.push({ kind: 'prompt', text, at, uuid: e.uuid, queued: e.promptSource === 'queued' });
    return out;
  }
  if (e.type === 'assistant') {
    for (const b of Array.isArray(e.message?.content) ? e.message.content : []) {
      if (b?.type === 'text' && b.text?.trim()) {
        out.push({ kind: 'text', text: b.text, tools: state.tools ?? [], at, uuid: e.uuid, error: !!e.isApiErrorMessage });
        state.tools = [];
        state.said = short(b.text.split('\n').find((l) => l.trim()) ?? '', 160);
      } else if (b?.type === 'tool_use') {
        const t = toolSummary(b, e.cwd);
        state.turnTools = (state.turnTools ?? 0) + 1;
        if (t) { (state.tools ??= []).push(t); state.lastTool = t; }
      }
    }
  }
  return out;
}

/* --- the screen ------------------------------------------------------------- */

const RULE = /^\s*[─━▔▁╌┄═-]{8,}\s*$/;

/**
 * The choices a dialog on screen offers, and the keys that pick each one.
 * Numbered menus take the number; a cursor menu (`❯` beside one line) takes
 * arrow presses and Enter. Only the part below the last horizontal rule is
 * read: above it is the conversation, where `❯` marks things already said.
 */
export function screenOptions(screen) {
  const lines = screen.split('\n');
  let start = 0;
  for (let i = lines.length - 1; i >= 0; i--) if (RULE.test(lines[i])) { start = i + 1; break; }
  const region = lines.slice(start);
  const numbered = [];
  for (const l of region) {
    // A menu longer than the screen marks where it scrolls with an arrow.
    const m = l.match(/^\s*(?:[❯›>↓↑]\s*)?(\d{1,2})\.\s+(.+?)\s*$/);
    if (!m) continue;
    const n = Number(m[1]);
    if (n === 1 && numbered.length) numbered.length = 0;    // a second menu starts: keep the later one
    if (n !== numbered.length + 1) continue;
    numbered.push({ label: short(m[2].replace(/\s{2,}/g, ' · '), 70), keys: n <= 9 ? [String(n)] : null });
  }
  if (numbered.length >= 2) {
    // Past 9, pick by moving the cursor there.
    const cur = region.findIndex((l) => /^\s*[❯›]\s*\d/.test(l));
    const curN = cur >= 0 ? Number(region[cur].match(/(\d+)\./)[1]) : 1;
    return numbered.map((o, i) => o.keys ? o : { ...o, keys: [...Array(Math.abs(i + 1 - curN)).fill(i + 1 > curN ? 'Down' : 'Up'), 'Enter'] });
  }
  const at = region.findIndex((l) => /^\s*❯ \S/.test(l));
  if (at < 0) return [];
  const col = region[at].indexOf('❯') + 2;
  const sibling = (l) => l.length > col && /^\s*$/.test(l.slice(0, col)) && l[col] !== ' ';
  let first = at, last = at;
  while (first > 0 && sibling(region[first - 1])) first--;
  while (last < region.length - 1 && sibling(region[last + 1])) last++;
  if (last === first) return [];
  const out = [];
  for (let i = first; i <= last; i++) {
    const d = i - at;
    out.push({ label: short(region[i].slice(col), 70), keys: [...Array(Math.abs(d)).fill(d > 0 ? 'Down' : 'Up'), 'Enter'] });
  }
  return out;
}

const SOLID = /^\s*[─━▔═]{8,}\s*$/;
const DASHED = /^\s*[╌┄-]{8,}\s*$/;
const HINT = /(Esc to |Enter to |Tab to |to navigate|to adjust|this session only|ctrl\+\w to|^Tip: )/i;

/**
 * The dialog on screen as a person would read it out: its title, what it is
 * about, and the question - without its choices (they are buttons), the key
 * hints, or the conversation above it. Lines between dashed rules, where Claude
 * Code shows the command or file in question, are marked as code.
 */
export function screenDialog(screen) {
  const lines = screen.split('\n');
  let start = -1;
  for (let i = lines.length - 1; i >= 0; i--) if (SOLID.test(lines[i])) { start = i + 1; break; }
  if (start < 0) return null;
  const labels = screenOptions(screen).map((o) => o.label.replace(/…$/, ''));
  const isOption = (l) => /^[❯›>↓↑]?\s*\d{1,2}\.\s/.test(l) || /^❯\s/.test(l)
    || labels.some((x) => x && l.replace(/\s{2,}/g, ' · ').startsWith(x));
  const out = [];
  let code = false;
  for (const raw of lines.slice(start)) {
    if (DASHED.test(raw)) { code = !code; continue; }
    const l = raw.trim();
    if (!l || isOption(l) || HINT.test(l)) continue;
    out.push({ text: short(l, 300), code });
  }
  if (!out.length) return null;
  return { title: out[0].text, body: out.slice(1, 12) };
}

/**
 * What is in Claude Code's input box, from a capture with its colours: the
 * lines from the `❯` prompt down to the rule under it. A dim line straight
 * after the prompt is the placeholder, not something typed.
 */
export function inputBox(rawScreen) {
  const lines = rawScreen.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const plain = stripAnsi(lines[i]);
    if (!/^[❯!] /.test(plain)) continue;
    const text = [plain.slice(2)];
    let j = i + 1;
    for (; j < lines.length && !RULE.test(stripAnsi(lines[j])); j++) text.push(stripAnsi(lines[j]).replace(/^ {2}/, ''));
    if (j >= lines.length) continue;   // not the box: the box has its rule below it
    const after = lines[i].slice(lines[i].indexOf(' ') + 1);
    if (/^(\x1b\[[0-9;]*m)*\x1b\[2m/.test(after) && text.length === 1) return { text: '' };  // eslint-disable-line no-control-regex
    return { text: text.join('\n').replace(/\s+$/, '') };
  }
  return null;
}

/* --- driving a pane ----------------------------------------------------------- */

/**
 * Files sent with a message, saved on this machine - the session's - with
 * their paths added to what is typed, so Claude can open them.
 */
function attach(text, files = []) {
  const saved = [], skipped = [];
  for (const f of files ?? []) {
    if (!f.data) { skipped.push({ name: f.name, skipped: f.skipped ?? 'nothing came through' }); continue; }
    const dir = path.join(ensureDataDir(), 'slack-files');
    fs.mkdirSync(dir, { recursive: true });
    const name = `${new Date().toISOString().replace(/[:.]/g, '-')}-${String(f.name ?? 'file').replace(/[^\w.-]+/g, '_').slice(-80)}`;
    const p = path.join(dir, name);
    fs.writeFileSync(p, Buffer.from(f.data, 'base64'), { mode: 0o600 });
    saved.push(p);
  }
  if (!saved.length) return { text, skipped };
  const list = saved.length === 1 ? `Attached: ${saved[0]}` : `Attached:\n${saved.map((p) => `- ${p}`).join('\n')}`;
  return { text: text?.trim() ? `${text}\n\n${list}` : list, skipped };
}

// tmux key names a sender may use, besides single printable characters.
const KEY_NAMES = new Map(Object.entries({
  esc: 'Escape', escape: 'Escape', enter: 'Enter', return: 'Enter', tab: 'Tab', 'shift-tab': 'BTab', stab: 'BTab', btab: 'BTab',
  up: 'Up', down: 'Down', left: 'Left', right: 'Right', space: 'Space', bspace: 'BSpace', backspace: 'BSpace',
  delete: 'Delete', del: 'Delete', home: 'Home', end: 'End', pageup: 'PPage', pagedown: 'NPage', pgup: 'PPage', pgdn: 'NPage',
}));
const CTRL_OK = new Set(['a', 'b', 'd', 'e', 'f', 'g', 'k', 'l', 'n', 'o', 'p', 'r', 's', 't', 'u', 'v', 'w', 'y', 'z']);

/**
 * Key names as tmux knows them, from what a person might write. Control keys
 * are allowed except Ctrl-C, which closes Claude Code when pressed twice, and
 * Ctrl-J/M/H/I, which are Enter, Backspace and Tab in disguise.
 */
export function parseKeys(words) {
  const out = [];
  for (const w of words) {
    const lw = w.toLowerCase();
    if (KEY_NAMES.has(lw)) { out.push(KEY_NAMES.get(lw)); continue; }
    const ctrl = lw.match(/^(?:c-|ctrl[-+]|\^)([a-z])$/);
    if (ctrl) {
      if (!CTRL_OK.has(ctrl[1])) throw new Error(`${w} is not sent: ${ctrl[1] === 'c' ? 'Ctrl-C twice closes Claude Code. Use esc to interrupt' : 'not a key Claude Code uses'}`);
      out.push(`C-${ctrl[1]}`);
      continue;
    }
    if ([...w].length === 1 && w !== ';') { out.push(w); continue; }
    throw new Error(`"${w}" is not a key - try: 1, esc, enter, up, down, tab, shift-tab, space, ctrl-o`);
  }
  return out;
}

export function startPanes({ onSessions = () => {}, onItems = () => {} } = {}) {
  const live = new Map();       // pid -> session as last seen
  const reads = new Map();      // session id -> { path, offset, partial, state }
  const launched = new Map();   // pane id -> { prompt, at }: to type once Claude is up there
  const unseen = new Set();     // sessions first seen before they had a transcript
  const watching = Date.now();
  let placedAt = 0, placing = null, places = new Map();
  let last = '', stopped = false, ticking = false, looked = false;

  const d = db();
  const getRead = d.prepare('SELECT path, offset FROM pane_reads WHERE session_id = ?');
  const putRead = d.prepare(`INSERT INTO pane_reads (session_id, path, offset, at) VALUES (?, ?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET path = excluded.path, offset = excluded.offset, at = excluded.at`);
  const dirty = new Set();

  /** Which pane each registered process is in, and whether it is that pane's foreground program. */
  async function place(entries) {
    const procs = await processes(entries.map((e) => e.s.pid));
    const sockets = new Map();
    const out = new Map();
    for (const e of entries) {
      const p = procs.get(e.s.pid);
      // A process with no terminal is a `claude -p` run, wherever it registered.
      if (!p?.tty || isPrint(p.args)) continue;
      const pane = typeof e.s.tmux === 'string' ? e.s.tmux.match(/(%\d+)$/)?.[1] : null;
      let where = { tty: p.tty, controllable: false, why: 'not in tmux' };
      if (pane) {
        const socket = await tmuxSocket(e.s.pid);
        if (!sockets.has(socket)) sockets.set(socket, await panesOf(socket));
        const tp = sockets.get(socket).get(pane);
        if (!tp) where = { ...where, why: 'its tmux pane is gone' };
        else if (tp.tty !== p.tty) where = { ...where, why: 'it is not running in its tmux pane' };
        else {
          where = {
            ...where, socket, pane, tmux: tp.session, target: tp.target,
            controllable: p.pgid === p.tpgid, why: p.pgid === p.tpgid ? null : 'something else has its pane',
          };
        }
      }
      out.set(e.s.pid, where);
    }
    return out;
  }

  function session(e, where) {
    const r = reads.get(e.s.sessionId);
    return {
      sessionId: e.s.sessionId, pid: e.s.pid, cwd: r?.state.cwd ?? e.s.cwd ?? null, name: e.s.name ?? null,
      title: r?.state.title ?? null, profile: e.profile.name,
      status: e.s.status ?? null, waitingFor: e.s.status === 'waiting' ? e.s.waitingFor ?? 'input' : null,
      statusAt: e.s.statusUpdatedAt ?? e.s.updatedAt ?? null, startedAt: e.s.startedAt ?? null, version: e.s.version ?? null,
      tmux: where.tmux ?? null, target: where.target ?? null, pane: where.pane ?? null, socket: where.socket ?? null,
      controllable: where.controllable, why: where.why,
      turnTools: r?.state.turnTools ?? 0, lastTool: r?.state.lastTool ?? null, said: r?.state.said ?? null,
    };
  }

  /**
   * Is this transcript the session's own, begun while it ran - rather than a
   * conversation it resumed? A new one is read from its start; an old one
   * shows only its last exchange, for context.
   */
  function begunNow(p, s) {
    if (unseen.has(s.sessionId)) return true;   // it had none when the session was first seen
    let head = '';
    try {
      const fd = fs.openSync(p, 'r');
      try { const b = Buffer.alloc(16384); head = b.subarray(0, fs.readSync(fd, b, 0, b.length, 0)).toString('utf8'); } finally { fs.closeSync(fd); }
    } catch { return false; }
    // Begun since this started watching, by this process: anything older is
    // history, however recently the process itself started.
    for (const line of head.split('\n').slice(0, 20)) {
      let t;
      try { t = Date.parse(JSON.parse(line).timestamp); } catch { continue; }
      if (t) return t >= watching && t >= (s.startedAt ?? Infinity) - 60_000;
    }
    return false;
  }

  /**
   * What a transcript said of itself before `end` - its title, and the folder
   * it works in. A read resumed from where it left off starts after both.
   */
  function lookBack(p, end, state) {
    const start = Math.max(0, end - BACKFILL_BYTES);
    let text = '';
    try {
      const fd = fs.openSync(p, 'r');
      try { const b = Buffer.alloc(end - start); text = b.subarray(0, fs.readSync(fd, b, 0, b.length, start)).toString('utf8'); } finally { fs.closeSync(fd); }
    } catch { return; }
    for (const line of text.split('\n')) {
      if (!/"type":"(ai|custom)-title"/.test(line)) continue;
      try { readEntry(JSON.parse(line), state); } catch { /* cut through at the start */ }
    }
    const cwd = [...text.matchAll(/"cwd":"((?:[^"\\]|\\.)*)"/g)].at(-1)?.[1];
    if (cwd) try { state.cwd = JSON.parse(`"${cwd}"`); } catch { /* keep the registry's */ }
  }

  /** Read what a session's transcript gained, as conversation items. */
  function read(s, profile) {
    let r = reads.get(s.sessionId);
    if (!r) {
      const p = transcriptOf(profile, s.sessionId, s.cwd);
      if (!p) { unseen.add(s.sessionId); return []; }
      const saved = getRead.get(s.sessionId);
      r = { path: p, offset: 0, partial: '', state: { tools: [], turnTools: 0, title: null }, backfill: false };
      let size = 0;
      try { size = fs.statSync(p).size; } catch { return []; }
      if (saved?.path === p && saved.offset <= size) { r.offset = saved.offset; lookBack(p, r.offset, r.state); }
      else if (!begunNow(p, s)) { r.offset = Math.max(0, size - BACKFILL_BYTES); r.backfill = true; }
      unseen.delete(s.sessionId);
      if (size - r.offset > CATCH_UP_BYTES) { r.offset = size - BACKFILL_BYTES; r.skipped = true; }
      // Start on a line boundary, and know the title from before it.
      if (r.offset > 0) r.partial = null;
      reads.set(s.sessionId, r);
    }
    let size;
    try { size = fs.statSync(r.path).size; } catch { return []; }
    if (size < r.offset) { r.offset = 0; r.partial = ''; }   // rewritten from scratch
    if (size === r.offset) return [];
    const fd = fs.openSync(r.path, 'r');
    let chunk;
    try {
      const len = Math.min(size - r.offset, CATCH_UP_BYTES);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, r.offset);
      // Only whole lines: a line still being written is read next time.
      const lastNl = buf.lastIndexOf(10);
      if (lastNl < 0) return [];
      chunk = buf.subarray(0, lastNl + 1).toString('utf8');
      r.offset += lastNl + 1;
    } finally { fs.closeSync(fd); }
    let lines = chunk.split('\n');
    if (r.partial === null) { lines = lines.slice(1); r.partial = ''; }   // began mid-line
    let items = [];
    for (const line of lines) {
      if (!line.startsWith('{')) continue;
      let e;
      try { e = JSON.parse(line); } catch { continue; }
      items.push(...readEntry(e, r.state));
    }
    dirty.add(s.sessionId);
    if (r.backfill) {
      // A session seen for the first time: only its last exchange, for context.
      r.backfill = false;
      const lastPrompt = items.findLastIndex((i) => i.kind === 'prompt' && !i.command);
      const lastText = items.findLastIndex((i) => i.kind === 'text');
      items = [items[lastPrompt], lastText > lastPrompt ? items[lastText] : null].filter(Boolean).map((i) => ({ ...i, backfill: true, tools: [] }));
    } else if (items.length > CATCH_UP_ITEMS || r.skipped) {
      const dropped = items.length - CATCH_UP_ITEMS;
      items = items.slice(-CATCH_UP_ITEMS);
      if (dropped > 0 || r.skipped) items.unshift({ kind: 'note', text: `${r.skipped ? 'a long stretch' : `${dropped} earlier messages`} not shown - the tracker was not following this session`, at: Date.now() });
      r.skipped = false;
    }
    return items;
  }

  function flushReads() {
    for (const id of dirty) {
      const r = reads.get(id);
      if (r) try { putRead.run(id, r.path, r.offset, Date.now()); } catch { /* next time */ }
    }
    dirty.clear();
  }

  async function tick() {
    if (ticking || stopped) return;
    ticking = true;
    try {
      const entries = registered();
      const pids = [...entries.keys()].sort().join(',');
      if (pids !== placing || Date.now() - placedAt > PLACE_MS) {
        places = await place([...entries.values()]);
        placing = pids; placedAt = Date.now();
      }
      const now = new Map();
      const said = [];
      for (const [pid, e] of entries) {
        const where = places.get(pid);
        if (!where) continue;
        const items = read(e.s, e.profile);
        const prev = live.get(pid);
        const s = session(e, where);
        // A turn that ended on tool calls, with nothing written after them.
        if (prev?.status === 'busy' && s.status !== 'busy' && reads.get(s.sessionId)?.state.tools.length) {
          const st = reads.get(s.sessionId).state;
          items.push({ kind: 'tools', tools: st.tools, at: Date.now() });
          st.tools = [];
        }
        if (items.length) said.push([s.sessionId, items]);
        now.set(pid, s);
      }
      live.clear();
      for (const [pid, s] of now) live.set(pid, s);
      for (const [pane, l] of launched) {
        const s = [...live.values()].find((x) => x.pane === pane);
        if (s?.controllable && s.status === 'idle') {
          launched.delete(pane);
          check(s.sessionId).then((x) => type(x, l.prompt)).catch(() => {});
        } else if (Date.now() - l.at > 10 * 60_000) launched.delete(pane);
      }
      // Sessions first: what they said belongs to a session already known.
      const list = [...live.values()];
      const sig = JSON.stringify(list.map(({ statusAt, ...rest }) => rest));
      looked = true;
      if (sig !== last) { last = sig; onSessions(list); }
      for (const [id, items] of said) onItems(id, items);
      if (dirty.size) flushReads();
    } finally {
      ticking = false;
    }
  }

  const timer = setInterval(() => { tick().catch(() => {}); }, TICK_MS);
  timer.unref?.();
  tick().catch(() => {});

  /* --- acting on a session ---------------------------------------------- */

  const bySession = (id) => [...live.values()].find((s) => s.sessionId === id) ?? null;

  /**
   * The session, freshly checked: still registered, still in its pane, still
   * that pane's foreground program. Throws, saying why, if anything is off.
   */
  async function check(id) {
    const s = bySession(id);
    if (!s) throw new Error('that session is not running any more');
    const entries = registered();
    const e = entries.get(s.pid);
    if (!e || e.s.sessionId !== id) throw new Error('that session is not running any more');
    const where = (await place([e])).get(s.pid);
    if (!where?.controllable) throw new Error(`can't type into it: ${where?.why ?? 'it is not in a terminal'}`);
    return session(e, where);
  }

  // `--` before what is sent: a message starting with "-" is not an option of tmux's.
  const send = (s, keys) => tmux(s.socket, ['send-keys', '-t', s.pane, '--', ...keys]);
  const capture = (s, colours = false) => tmux(s.socket, ['capture-pane', '-p', ...(colours ? ['-e'] : []), '-t', s.pane]);

  /** Empty the input box without pressing anything that could interrupt or exit. */
  async function clearInput(s) {
    let was = null;
    for (let round = 0; round < 12; round++) {
      const box = inputBox(await capture(s, true));
      if (!box?.text) return was;
      was ??= box.text;
      await send(s, ['C-e', 'C-u', 'BSpace', 'Delete']);
      await sleep(120);
    }
    throw new Error('its input box has text in it that would not clear');
  }

  async function type(s, text) {
    text = String(text).replace(/\r\n?/g, '\n').replace(/\t/g, '    ').replace(/\n+$/, '');
    if (!text.trim()) throw new Error('nothing to type');
    let dismissed = null;
    if (s.status === 'waiting') {
      // A reply while a prompt is open answers it the way Esc does - no, or
      // never mind - and then says what to do instead.
      dismissed = s.waitingFor;
      await send(s, ['Escape']);
      await sleep(600);
      s = await check(s.sessionId);
      if (s.status === 'waiting') throw new Error(`it is still waiting (${s.waitingFor}) - answer with the buttons, or ;keys`);
    }
    const cleared = await clearInput(s);
    s = await check(s.sessionId);
    if (text.includes('\n')) {
      const buf = `ct-${process.pid}-${Date.now()}`;
      await tmux(s.socket, ['load-buffer', '-b', buf, '-'], { input: text });
      // Bracketed, so the lines stay one message; and with newlines left as
      // they are, so even unbracketed, no line is sent as if Enter were pressed.
      await tmux(s.socket, ['paste-buffer', '-p', '-r', '-d', '-b', buf, '-t', s.pane]);
    } else {
      await tmux(s.socket, ['send-keys', '-t', s.pane, '-l', '--', text]);
    }
    await sleep(150 + Math.min(1500, text.length / 10));
    await send(s, ['Enter']);
    await sleep(400);
    const after = inputBox(await capture(s, true).catch(() => ''));
    return { cleared, dismissed, sent: !after?.text };
  }

  /**
   * Start Claude in a new tmux session in `dir`, through a shell, so whatever
   * the shell sets up for `claude` applies. A prompt is typed once it is ready.
   */
  async function launch({ dir, prompt, command = process.env.CLAUDE_TRACKER_LAUNCH || 'claude' }) {
    const full = path.resolve(String(dir).replace(/^~(?=$|\/)/, HOME));
    let st;
    try { st = fs.statSync(full); } catch { throw new Error(`${dir} does not exist`); }
    if (!st.isDirectory()) throw new Error(`${dir} is not a directory`);
    // On the tmux server the sessions here already use.
    const socket = [...live.values()].find((s) => s.pane)?.socket ?? null;
    let names = new Set();
    try { names = new Set((await tmux(socket, ['list-sessions', '-F', '#{session_name}'])).split('\n')); } catch { /* no server yet */ }
    const base = path.basename(full).replace(/[^A-Za-z0-9_-]+/g, '_') || 'claude';
    let name = base;
    for (let i = 2; names.has(name); i++) name = `${base}-${i}`;
    const pane = (await tmux(socket, ['new-session', '-d', '-s', name, '-c', full, '-P', '-F', '#{pane_id}'])).trim();
    await sleep(300);
    await tmux(socket, ['send-keys', '-t', pane, '-l', '--', command]);
    await tmux(socket, ['send-keys', '-t', pane, 'Enter']);
    if (prompt?.trim()) launched.set(pane, { prompt, at: Date.now() });
    return { tmux: name, pane, socket, dir: full };
  }

  /** A pane Claude was just launched in, before it has registered: its screen, or keys for its first dialog. */
  async function earlyPane({ pane, socket }, keys) {
    const panes = await panesOf(socket);
    const p = panes.get(pane);
    if (!p) throw new Error('that tmux session is gone');
    if (p.command !== 'claude') throw new Error(`Claude is not running there (${p.command})`);
    if (keys) await tmux(socket, ['send-keys', '-t', pane, '--', ...keys]);
    return tmux(socket, ['capture-pane', '-p', '-t', pane]);
  }

  async function screen(s) {
    const text = (await capture(s)).replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trimEnd();
    const waiting = s.status === 'waiting' || !s.status;
    return { text, options: waiting ? screenOptions(text) : [], dialog: waiting ? screenDialog(text) : null };
  }

  return {
    /** Every session, or null before the first look: an empty list would say they had all ended. */
    sessions: () => (looked ? [...live.values()] : null),
    /** Do something to a session (or a just-launched pane); resolves to what happened. */
    async act(op) {
      if (op.op === 'launch') return launch(op);
      if (op.op === 'early') {
        const text = (await earlyPane(op, op.keys ? parseKeys(op.keys) : null)).replace(/[ \t]+$/gm, '').trimEnd();
        return { screen: { text, options: screenOptions(text), dialog: screenDialog(text) } };
      }
      const s = await check(op.sessionId);
      switch (op.op) {
        case 'type': {
          const { text, skipped } = attach(op.text, op.files);
          return { ...(await type(s, text)), typed: text, skipped };
        }
        case 'keys': {
          const keys = parseKeys(op.keys);
          await send(s, keys);
          await sleep(500);
          return { screen: await screen(await check(op.sessionId)) };
        }
        case 'screen': return { screen: await screen(s) };
        default: throw new Error(`unknown action ${op.op}`);
      }
    },
    tick,
    stop() {
      stopped = true;
      clearInterval(timer);
      if (dirty.size) flushReads();
    },
  };
}
