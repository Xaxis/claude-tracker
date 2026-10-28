import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR, ensureDataDir } from './paths.js';
import { db, getMeta, setMeta } from './db.js';
import { call, queue, socketMode, toMrkdwn, split, fromSlack, escape, FATAL } from './slack.js';

/**
 * Claude Code sessions in Slack: one thread per session, in one channel.
 *
 * A thread's first message shows the session - what it is, whether it is
 * working, idle or waiting on you, and on which account and machine - and is
 * kept current. Below it, the conversation as it happens: what was typed at
 * the terminal, what Claude wrote, and what it did in between. A reply in the
 * thread is typed into the session, as if at its keyboard. When a session
 * waits on a prompt, the thread shows the screen with a button for each
 * choice, and mentions you, so your phone tells you.
 *
 * Sessions on other synced machines come through the sync connection: their
 * tracker follows them and does the typing, and this one does all the Slack.
 * Only the person who paired with `claude-tracker slack setup` is listened to.
 */

export const CONFIG_FILE = path.join(DATA_DIR, 'slack.json');

export function readConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { return null; }
}

/** Written readable only by this user: it holds the app's tokens. */
export function writeConfig(cfg) {
  ensureDataDir();
  const tmp = `${CONFIG_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, CONFIG_FILE);
}

/** What the bridge running here last said about itself. */
export function bridgeStatus() {
  try { return JSON.parse(getMeta('slack_status') ?? 'null'); } catch { return null; }
}

export const newPairCode = () => String(crypto.randomInt(100000, 1000000));

const HELP = [
  '*In a session\'s thread*',
  '• Anything you write is typed into the session and sent, as at its keyboard - `!cmd` runs a shell command there, as it would.',
  '• `;compact`, `;model opus`, `;clear` … run Claude Code\'s slash commands (Slack keeps `/` for its own).',
  '• `;esc` interrupts what it is doing. `;screen` shows its terminal. `;keys 2`, `;keys down enter`, `;keys shift-tab` press keys.',
  '• `;mute` stops showing what it writes here (it still tells you when it needs you); `;unmute` starts again.',
  '• Writing while it waits on a prompt answers the prompt with Esc - no - and sends what you wrote instead. The buttons pick a choice.',
  '• Files you attach are saved on its machine, and their paths are added to the message.',
  '*Anywhere in this channel, or a DM with me*',
  '• `list` - every session, with a link to its thread.',
  '• `new <folder> [what to do]` - start Claude there, in a new tmux session. `new Mac:~/Projects/app …` starts it on another machine.',
  '• `usage` - how full each account is, and which to use.',
  '• `pause` / `resume` - stop and start showing conversations here. Prompts that need you still come through.',
].join('\n');

const EMOJI = { busy: ':large_green_circle:', idle: ':white_circle:', waiting: ':large_orange_circle:', ended: ':black_circle:' };
const norm = (s) => String(s).replace(/\s+/g, ' ').trim();
const tilde = (p) => (p ? String(p).replace(/^\/(?:home|Users)\/[^/]+(?=\/|$)/, '~') : p);
const shortNum = (n) => (n >= 999_500 ? `${(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1e3)}k`);
const ago = (ms) => (ms < 90_000 ? `${Math.round(ms / 1000)}s` : ms < 90 * 60_000 ? `${Math.round(ms / 60_000)}m` : `${Math.round(ms / 3600e3)}h`);

/** A turn's tool calls, in a line: "ran `npm test` · edited 2 files · read 5". */
export function toolsLine(tools) {
  if (!tools?.length) return '';
  const by = new Map();
  for (const t of tools) by.set(t.verb, [...(by.get(t.verb) ?? []), t]);
  const parts = [];
  for (const [verb, ts] of by) {
    if (verb === 'ran') {
      const code = (t) => `\`${escape(t.what.length > 60 ? `${t.what.slice(0, 59)}…` : t.what)}\``;
      parts.push(ts.length > 2 ? `ran ${ts.length} commands, the last ${code(ts.at(-1))}` : `ran ${ts.map(code).join(', ')}`);
    } else if (verb === 'edited' || verb === 'read') {
      const files = [...new Set(ts.map((t) => t.what))];
      parts.push(files.length === 1 ? `${verb} \`${escape(files[0])}\`` : `${verb} ${files.length} files`);
    } else {
      parts.push(`${verb} ${escape(ts.at(-1).what)}${ts.length > 1 ? ` (+${ts.length - 1})` : ''}`);
    }
  }
  return `:hammer_and_wrench: ${parts.join(' · ')}`;
}

/** A Slack message's text, as a command and what follows it: `;model opus` -> ['model', 'opus']. */
export function parseControl(text) {
  const m = text.match(/^;\s*([A-Za-z][\w:-]*)\s*([\s\S]*)$/);
  return m ? [m[1].toLowerCase(), m[2].trim()] : null;
}

/**
 * Run the bridge. `info(sessionId)` says what the tracker knows of a session
 * (account, context), `usage()` the accounts, `here` this machine's name, and
 * `forward(type, payload)` hands an event to another machine's bridge when a
 * thread here is not ours.
 */
export function startBridge({ info = () => null, usage = () => '', here = 'this machine', forward = () => false, log = () => {} } = {}) {
  let cfg = null, api = null, sock = null, cfgStamp = null;
  let status = { state: 'off' };
  const machines = new Map();   // '' (here) or machine id -> { id, name, act, online, own }
  const live = new Map();       // `${machine}/${sessionId}` -> per-session state
  const byThread = new Map();   // `${channel}/${ts}` -> key
  const launches = [];          // sessions started from Slack, waiting to appear
  const d = db();
  const q = {
    get: d.prepare('SELECT * FROM slack_threads WHERE session_id = ?'),
    byTs: d.prepare('SELECT * FROM slack_threads WHERE channel = ? AND ts = ?'),
    put: d.prepare(`INSERT INTO slack_threads (session_id, machine_id, channel, ts, name, muted, created_at, ended_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
      ON CONFLICT(session_id) DO UPDATE SET machine_id = excluded.machine_id, channel = excluded.channel, ts = excluded.ts,
        name = excluded.name, ended_at = NULL`),
    open: d.prepare('SELECT * FROM slack_threads WHERE ended_at IS NULL AND channel = ? AND machine_id IS ?'),
    move: d.prepare('UPDATE slack_threads SET session_id = ? WHERE session_id = ?'),
    mute: d.prepare('UPDATE slack_threads SET muted = ? WHERE session_id = ?'),
    end: d.prepare('UPDATE slack_threads SET ended_at = ? WHERE session_id = ?'),
    count: d.prepare('SELECT COUNT(*) n FROM slack_threads WHERE channel = ? AND ended_at IS NULL'),
  };

  const setStatus = (patch) => {
    status = { ...status, ...patch, at: Date.now() };
    try { setMeta('slack_status', JSON.stringify(status)); } catch { /* next time */ }
  };
  const ready = () => !!(api && cfg?.owner && cfg?.channel);
  const keyOf = (machine, sessionId) => `${machine ?? ''}/${sessionId}`;

  /* --- Slack, out ----------------------------------------------------- */

  const send = (method, args, opts) => api.send(method, args, opts);
  const post = (channel, thread, text, extra = {}, priority = 1) => send('chat.postMessage',
    { channel, thread_ts: thread, text, unfurl_links: false, unfurl_media: false, ...extra }, { priority });
  const react = (channel, ts, name) => send('reactions.add', { channel, timestamp: ts, name }, { priority: 0 }).catch(() => {});
  const mention = () => (cfg?.owner ? `<@${cfg.owner}>` : '');
  const link = (channel, ts) => (cfg?.url ? `${cfg.url.replace(/\/?$/, '/')}archives/${channel}/p${String(ts).replace('.', '')}` : null);

  /** What went wrong with Slack, kept where `slack status` and the dashboards see it. */
  function slackFailed(err, method) {
    if (['not_in_channel', 'channel_not_found', 'is_archived'].includes(err.code)) {
      setStatus({ state: 'error', error: `the app can't post in its channel any more (${err.code}) - add it back with /invite, or pair again: claude-tracker slack pair` });
    } else if (FATAL.has(err.code)) {
      setStatus({ state: 'error', fatal: true, error: `the bot token was refused (${err.code}) - run claude-tracker slack setup again` });
    } else {
      log(`slack ${method}: ${err.message}`);
    }
  }

  /** In order, per session: its posts must not overtake each other. */
  const chain = (x, fn) => (x.chain = x.chain.then(fn).catch((err) => log(`slack: ${err.message}`)));

  /* --- the thread's first message ------------------------------------------ */

  function card(x) {
    const s = x.s;
    const i = info(s.sessionId, x.machine) ?? {};
    const name = nameOf(s);
    const head = `*${escape(name)}*${s.title ? `  ·  ${escape(s.title)}` : ''}`;
    let state;
    if (x.ended) state = `${EMOJI.ended} ended`;
    else if (s.status === 'waiting') state = `${EMOJI.waiting} *waiting on you* · ${escape(s.waitingFor ?? 'input')}`;
    else if (s.status === 'busy') {
      state = `${EMOJI.busy} working${s.turnTools ? ` · ${s.turnTools} tool call${s.turnTools === 1 ? '' : 's'}` : ''}`;
      if (s.lastTool) state += ` · last: ${toolsLine([s.lastTool]).replace(/^:hammer_and_wrench: /, '')}`;
    } else state = `${EMOJI.idle} idle${s.statusAt ? ` since <!date^${Math.floor(s.statusAt / 1000)}^{time}|${new Date(s.statusAt).toISOString().slice(11, 16)} UTC>` : ''}`;
    const machine = machines.get(x.machine ?? '');
    if (!x.ended && x.machine && !machine?.online) state = `${EMOJI.ended} ${escape(machine?.name ?? 'its machine')} is not connected · last ${state}`;
    const facts = [
      s.cwd && `\`${escape(tilde(s.cwd))}\``,
      i.account && escape(i.account),
      i.context?.tokens && `${shortNum(i.context.tokens)} context`,
      x.machine && machine?.name && `on ${escape(machine.name)}`,
      s.target && `tmux \`${escape(s.target)}\``,
    ].filter(Boolean).join(' · ');
    const how = x.ended ? 'This session has ended. If it is resumed, it carries on here.'
      : s.controllable ? 'Reply in this thread to type into it. `;help` for more.'
        : `Read only: ${escape(s.why ?? 'not in a tmux pane')}.`;
    const blocks = [
      { type: 'section', text: { type: 'mrkdwn', text: `${head}\n${state}` } },
      { type: 'context', elements: [{ type: 'mrkdwn', text: `${facts}${facts ? '\n' : ''}${how}` }] },
    ];
    if (!x.ended && s.controllable) {
      blocks.push({ type: 'actions', elements: [
        button('Screen', 'ct:screen', x), button('Esc', 'ct:keys', x, ['esc']),
        ...(x.muted ? [button('Unmute', 'ct:unmute', x)] : []),
      ] });
    }
    return { text: `${name}: ${x.ended ? 'ended' : s.status === 'waiting' ? `waiting on you (${s.waitingFor})` : s.status ?? ''}`, blocks };
  }

  function button(text, action, x, keys = null, style = null) {
    const value = JSON.stringify({ m: x.machine ?? null, s: x.s.sessionId, ...(keys ? { k: keys } : {}) });
    return { type: 'button', text: { type: 'plain_text', text: text.slice(0, 75), emoji: true }, action_id: `${action}:${crypto.randomBytes(3).toString('hex')}`, value, ...(style ? { style } : {}) };
  }

  /** Refresh a thread's first message: at once when something that matters changes, otherwise every half minute while it works. */
  function refreshCard(x, force = false) {
    if (!ready() || !x.thread) return;
    const c = card(x);
    const sig = JSON.stringify(c.blocks);
    if (sig === x.cardSig) return;
    const important = c.text !== x.cardText;
    if (!force && !important && Date.now() - (x.cardAt ?? 0) < 30_000) return;
    x.cardSig = sig; x.cardText = c.text; x.cardAt = Date.now();
    send('chat.update', { channel: x.thread.channel, ts: x.thread.ts, text: c.text, blocks: c.blocks }, { priority: 2, key: `card:${x.key}` })
      .catch((err) => slackFailed(err, 'chat.update'));
  }

  /** The thread a session is carried in: the one it had, or a new one. */
  async function ensureThread(x) {
    if (x.thread?.channel === cfg.channel) return x.thread;
    const row = q.get.get(x.s.sessionId);
    if (row && row.channel === cfg.channel) {
      x.thread = { channel: row.channel, ts: row.ts };
      x.muted = !!row.muted;
      if (row.ended_at) {
        q.put.run(x.s.sessionId, x.machine, row.channel, row.ts, nameOf(x.s), row.muted, row.created_at);
        post(row.channel, row.ts, ':arrow_forward: _resumed_').catch(() => {});
      }
    } else {
      const c = card(x);
      const r = await send('chat.postMessage', { channel: cfg.channel, text: c.text, blocks: c.blocks, unfurl_links: false }, { priority: 1 });
      x.thread = { channel: r.channel, ts: r.ts };
      x.cardSig = JSON.stringify(c.blocks); x.cardText = c.text; x.cardAt = Date.now();
      q.put.run(x.s.sessionId, x.machine, r.channel, r.ts, nameOf(x.s), 0, Date.now());
    }
    byThread.set(`${x.thread.channel}/${x.thread.ts}`, x.key);
    for (const l of launches.filter((l) => l.match(x))) l.found(x);
    return x.thread;
  }

  /* --- what sessions say ------------------------------------------------- */

  const nameOf = (s) => s.tmux ?? s.name ?? (path.basename(s.cwd ?? '') || 'session');

  /**
   * Threads left open for sessions that ended while nobody was watching - the
   * tracker was down, or the machine away. Settled once per machine, against
   * its first full list.
   */
  const settled = new Set();
  function settle(machine, list) {
    if (settled.has(machine ?? '') || !ready()) return;
    settled.add(machine ?? '');
    const running = new Set(list.map((s) => s.sessionId));
    for (const row of q.open.all(cfg.channel, machine)) {
      if (running.has(row.session_id)) continue;
      q.end.run(Date.now(), row.session_id);
      send('chat.update', {
        channel: row.channel, ts: row.ts, text: `${row.name ?? 'session'}: ended`,
        blocks: [
          { type: 'section', text: { type: 'mrkdwn', text: `*${escape(row.name ?? 'session')}*\n${EMOJI.ended} ended` } },
          { type: 'context', elements: [{ type: 'mrkdwn', text: 'This session has ended. If it is resumed, it carries on here.' }] },
        ],
      }, { priority: 2, key: `card:${row.session_id}` }).catch(() => {});
    }
  }

  function sessions(machine, list) {
    machine = machine ?? null;
    settle(machine, list);
    const seen = new Set();
    const gone = [...live.values()].filter((x) => x.machine === machine && !x.ended);
    for (const s of list) {
      const key = keyOf(machine, s.sessionId);
      seen.add(key);
      let x = live.get(key);
      if (!x) {
        // A /clear starts a new conversation in the same process; it keeps the thread.
        const before = gone.find((g) => g.s.pid === s.pid && g.s.sessionId !== s.sessionId && !list.some((l) => l.sessionId === g.s.sessionId));
        x = { key, machine, s, chain: Promise.resolve(), sent: [], muted: false };
        live.set(key, x);
        if (before?.thread) {
          live.delete(before.key);
          try { q.move.run(s.sessionId, before.s.sessionId); } catch { /* the new one has a row already */ }
          x.thread = before.thread; x.muted = before.muted; x.chain = before.chain;
          byThread.set(`${x.thread.channel}/${x.thread.ts}`, key);
          if (ready()) chain(x, () => post(x.thread.channel, x.thread.ts, ':new: _a new conversation in this session_'));
        }
        if (ready()) chain(x, () => ensureThread(x));
      }
      const prev = x.s;
      x.s = s;
      x.ended = false;
      if (!ready()) continue;
      chain(x, async () => {
        await ensureThread(x);
        if (s.status === 'waiting' && (prev.status !== 'waiting' || prev.waitingFor !== s.waitingFor || !x.alert)) await waiting(x);
        else if (s.status !== 'waiting' && x.alert) answered(x);
        if (prev.status === 'busy' && s.status === 'idle' && x.turn) finished(x);
        refreshCard(x);
      });
    }
    for (const x of gone) {
      if (seen.has(x.key) || !live.has(x.key)) continue;
      x.ended = true;
      try { q.end.run(Date.now(), x.s.sessionId); } catch { /* fine */ }
      if (ready()) chain(x, async () => { if (x.alert) answered(x); refreshCard(x, true); });
      live.delete(x.key);
    }
  }

  function items(machine, sessionId, list) {
    const x = live.get(keyOf(machine ?? null, sessionId));
    if (!x || !ready()) return;
    chain(x, async () => {
      const t = await ensureThread(x);
      for (const it of list) {
        if (it.kind === 'prompt') {
          const n = norm(it.text);
          const mine = x.sent.findIndex((m) => m.norm === n);
          if (mine >= 0) { x.sent.splice(mine, 1); continue; }   // typed from here
          if (x.muted || cfg.paused) continue;
          const quoted = escape(it.text.length > 1500 ? `${it.text.slice(0, 1500)}…` : it.text).replace(/^/gm, '> ');
          const lead = it.backfill ? '_asked last, before this thread:_' : it.command ? ':keyboard: _at the terminal:_' : ':keyboard: _typed at the terminal:_';
          await post(t.channel, t.ts, `${lead}\n${quoted}`);
        } else if (it.kind === 'text') {
          if (x.muted || cfg.paused) continue;
          const tools = toolsLine(it.tools);
          const body = toMrkdwn(it.text);
          const parts = split(`${it.backfill ? '_its last reply:_\n' : ''}${it.error ? ':warning: ' : ''}${body}`);
          for (let n = 0; n < parts.length; n++) await post(t.channel, t.ts, n === 0 && tools ? `${tools}\n${parts[n]}` : parts[n]);
        } else if (it.kind === 'tools') {
          if (x.muted || cfg.paused) continue;
          await post(t.channel, t.ts, toolsLine(it.tools));
        } else if (it.kind === 'note') {
          if (x.muted || cfg.paused) continue;
          await post(t.channel, t.ts, `_${escape(it.text).replace(/_/g, '\u2009_\u2009').replace(/\n/g, '_\n_')}_`);
        }
      }
    });
  }

  /** The session waits on a prompt: show the screen, with the choices as buttons, and say so. */
  async function waiting(x) {
    await new Promise((r) => setTimeout(r, 500));   // let the dialog finish drawing
    let screen = null;
    try { screen = (await act(x, { op: 'screen', sessionId: x.s.sessionId })).screen; } catch { /* shown without it */ }
    const shown = (screen?.text ?? '').split('\n').slice(-24).join('\n').trim();
    const opts = (screen?.options ?? []).slice(0, 9);
    const blocks = [
      { type: 'section', text: { type: 'mrkdwn', text: `:raising_hand: ${mention()} *needs you* · ${escape(x.s.waitingFor ?? 'input')}` } },
      ...(shown ? [{ type: 'section', text: { type: 'mrkdwn', text: `\`\`\`${escape(shown).slice(-2900)}\`\`\`` } }] : []),
    ];
    if (x.s.controllable) {
      blocks.push({ type: 'actions', elements: [
        ...opts.map((o, n) => button(`${n + 1}. ${o.label}`, 'ct:keys', x, o.keys.map((k) => k.toLowerCase()), n === 0 ? 'primary' : null)),
        button('Esc', 'ct:keys', x, ['esc']), button('Screen', 'ct:screen', x),
      ].slice(0, 25) });
    }
    const r = await post(x.thread.channel, x.thread.ts, `${x.s.tmux ?? x.s.name} needs you: ${x.s.waitingFor}`, { blocks }, 0);
    x.alert = { ts: r.ts, waitingFor: x.s.waitingFor };
  }

  function answered(x) {
    const a = x.alert;
    x.alert = null;
    send('chat.update', {
      channel: x.thread.channel, ts: a.ts, text: `${a.waitingFor}: answered`,
      blocks: [{ type: 'context', elements: [{ type: 'mrkdwn', text: `:ballot_box_with_check: ~needed you~ · ${escape(a.waitingFor)} · answered` }] }],
    }, { priority: 2, key: `alert:${a.ts}` }).catch(() => {});
  }

  /** A turn asked for from Slack has ended: a long one gets a mention, so it is noticed. */
  function finished(x) {
    const t = x.turn;
    x.turn = null;
    if (Date.now() - t.at > 90_000) post(x.thread.channel, x.thread.ts, `:white_check_mark: ${mention()} finished after ${ago(Date.now() - t.at)}`).catch(() => {});
  }

  /* --- acting on a session -------------------------------------------------- */

  function act(x, op) {
    const m = machines.get(x.machine ?? '');
    if (!m?.online) throw new Error(`${m?.name ?? 'its machine'} is not connected right now`);
    return m.act(op);
  }

  async function filesOf(ev) {
    const out = [];
    for (const f of ev.files ?? []) {
      if (f.size > 20e6) { out.push({ name: f.name, skipped: 'over 20 MB' }); continue; }
      const res = await fetch(f.url_private_download ?? f.url_private, { headers: { authorization: `Bearer ${cfg.botToken}` } });
      if (!res.ok) { out.push({ name: f.name, skipped: `Slack said ${res.status}` }); continue; }
      out.push({ name: f.name, data: Buffer.from(await res.arrayBuffer()).toString('base64') });
    }
    return out;
  }

  /** A reply in a session's thread: typed in, or a `;` command. */
  async function reply(x, ev) {
    const t = x.thread;
    const text = fromSlack(ev.text).trim();
    const say = (m, priority = 0) => post(t.channel, t.ts, m, {}, priority);
    const ctl = parseControl(text);
    const fail = (err) => { react(ev.channel, ev.ts, 'x'); return say(`:x: ${escape(err.message)}`); };
    try {
      if (ctl) {
        const [cmd, rest] = ctl;
        if (cmd === 'help') return say(HELP);
        if (cmd === 'mute' || cmd === 'unmute') {
          x.muted = cmd === 'mute';
          q.mute.run(x.muted ? 1 : 0, x.s.sessionId);
          refreshCard(x, true);
          return say(x.muted ? ':mute: _muted - only prompts that need you come through_' : ':sound: _unmuted_');
        }
        if (cmd === 'screen' || cmd === 's') return showScreen(x, await act(x, { op: 'screen', sessionId: x.s.sessionId }));
        if (cmd === 'esc' || cmd === 'stop' || cmd === 'interrupt') {
          await act(x, { op: 'keys', sessionId: x.s.sessionId, keys: ['esc'] });
          return react(ev.channel, ev.ts, 'octagonal_sign');
        }
        if (cmd === 'keys' || cmd === 'key') {
          const r = await act(x, { op: 'keys', sessionId: x.s.sessionId, keys: rest.split(/\s+/).filter(Boolean) });
          react(ev.channel, ev.ts, 'white_check_mark');
          return showScreen(x, r);
        }
      }
      const typed = ctl ? `/${ctl[0]}${ctl[1] ? ` ${ctl[1]}` : ''}` : text;
      const files = await filesOf(ev);
      if (!typed && !files.length) return;
      x.sent.push({ norm: norm(typed), at: Date.now() });
      x.sent = x.sent.filter((m) => Date.now() - m.at < 15 * 60_000).slice(-20);
      const r = await act(x, { op: 'type', sessionId: x.s.sessionId, text: typed, files });
      if (r.typed && norm(r.typed) !== norm(typed)) x.sent.push({ norm: norm(r.typed), at: Date.now() });
      x.turn = { at: Date.now(), ts: ev.ts };
      react(ev.channel, ev.ts, r.sent === false ? 'warning' : 'white_check_mark');
      const notes = [
        r.dismissed && `_answered the open ${escape(r.dismissed)} with Esc first_`,
        r.cleared && `_cleared what was in its input box first:_\n${escape(r.cleared).replace(/^/gm, '> ')}`,
        ...(r.skipped ?? []).map((f) => `_${escape(f.name)} not attached: ${escape(f.skipped)}_`),
        r.sent === false && '_typed, but it does not look sent - `;screen` to see_',
      ].filter(Boolean);
      if (notes.length) await say(notes.join('\n'));
    } catch (err) {
      await fail(err);
    }
  }

  function showScreen(x, r) {
    const text = r?.screen?.text ?? '';
    const lines = text.split('\n').slice(-40).join('\n').trim();
    const opts = (r?.screen?.options ?? []).slice(0, 9);
    const blocks = [{ type: 'section', text: { type: 'mrkdwn', text: `\`\`\`${escape(lines || '(blank)').slice(-2900)}\`\`\`` } }];
    if (opts.length && x.s.controllable) {
      blocks.push({ type: 'actions', elements: opts.map((o, n) => button(`${n + 1}. ${o.label}`, 'ct:keys', x, o.keys.map((k) => k.toLowerCase()))) });
    }
    return post(x.thread.channel, x.thread.ts, 'screen', { blocks }, 0);
  }

  /* --- commands outside threads ------------------------------------------ */

  async function command(ev) {
    const text = fromSlack(ev.text).trim().replace(/^<@[A-Z0-9]+>\s*/, '');
    const [word, ...rest] = text.split(/\s+/);
    const say = (m, extra) => post(ev.channel, ev.thread_ts ?? ev.ts, m, extra, 0);
    switch ((word ?? '').toLowerCase()) {
      case 'list': case 'ls': case 'sessions': return say(listText());
      case 'usage': case 'status': case 'accounts': return say(usage() || 'No accounts yet.');
      case 'new': case 'start': case 'launch': return launch(ev, rest.join(' '), say);
      case 'pause': cfg.paused = true; writeConfig(cfg); return say(':double_vertical_bar: Paused: threads stay, conversations stop showing. Prompts that need you still come through. `resume` to carry on.');
      case 'resume': cfg.paused = false; writeConfig(cfg); return say(':arrow_forward: Showing conversations again.');
      case 'help': case '?': return say(HELP);
      default: return say(`Reply in a session's thread to talk to it. Here: \`list\`, \`new <folder> [what to do]\`, \`usage\`, \`help\`.`);
    }
  }

  function listText() {
    const rows = [...live.values()].filter((x) => !x.ended).sort((a, b) => (b.s.statusAt ?? 0) - (a.s.statusAt ?? 0));
    if (!rows.length) return 'No sessions running.';
    const lines = rows.map((x) => {
      const s = x.s;
      const name = escape(s.tmux ?? s.name ?? 'session');
      const where = x.machine ? ` · ${escape(machines.get(x.machine)?.name ?? 'another machine')}` : '';
      const l = x.thread && link(x.thread.channel, x.thread.ts);
      return `${EMOJI[s.status] ?? EMOJI.idle} ${l ? `<${l}|${name}>` : `*${name}*`}${s.title ? ` - ${escape(s.title)}` : ''}${where}${s.status === 'waiting' ? ` · *waiting: ${escape(s.waitingFor)}*` : ''}`;
    });
    const quiet = [...machines.values()].filter((m) => m.id && !m.online).map((m) => `_${escape(m.name)}: ${
      m.old ? 'its tracker is too old to be driven from here - update it there: `git pull` in its claude-tracker, then `claude-tracker service install`'
        : m.refused ? 'driving its sessions from Slack is off there (`claude-tracker slack on` there allows it)' : 'not connected'}_`);
    return [...lines, ...quiet].join('\n');
  }

  async function launch(ev, args, say) {
    const m = args.match(/^(?:([^\s:/~]+):)?(\S+)\s*([\s\S]*)$/);
    if (!m) return say('Say where: `new ~/Projects/app` or `new app fix the login bug`.');
    let machine = '';
    if (m[1]) {
      const found = [...machines.values()].find((x) => x.name.toLowerCase() === m[1].toLowerCase());
      if (!found) return say(`:x: No machine called ${escape(m[1])}. Machines: ${[...machines.values()].map((x) => escape(x.name)).join(', ')}`);
      machine = found.id ?? '';
    }
    const mach = machines.get(machine);
    if (!mach?.online) return say(`:x: ${escape(mach?.name ?? 'That machine')} is not connected.`);
    let r;
    try { r = await mach.act({ op: 'launch', dir: m[2], prompt: m[3] }); } catch (err) { return say(`:x: ${escape(err.message)}`); }
    const started = await say(`:rocket: Starting Claude in \`${escape(tilde(r.dir))}\`${mach.id ? ` on ${escape(mach.name)}` : ''} - tmux session \`${escape(r.tmux)}\`. Its thread appears when it is up${m[3].trim() ? ', and your message is typed in then' : ''}.`);
    // Until it registers, the pane may show a first dialog - trusting the folder.
    const watch = { match: (x) => (x.machine ?? '') === machine && x.s.pane === r.pane, found: (x) => {
      watch.done = true;
      launches.splice(launches.indexOf(watch), 1);
      const l = link(x.thread.channel, x.thread.ts);
      send('chat.update', { channel: started.channel, ts: started.ts, text: `Started ${r.tmux}`, blocks: [{ type: 'section', text: { type: 'mrkdwn', text: `:rocket: Started Claude in \`${escape(tilde(r.dir))}\`: ${l ? `<${l}|its thread>` : 'see its thread'}.` } }] }, { priority: 0 }).catch(() => {});
    } };
    launches.push(watch);
    setTimeout(async () => {
      if (watch.done) return;
      try {
        const e = await mach.act({ op: 'early', pane: r.pane, socket: r.socket });
        if (e.screen.options.length) {
          const opts = e.screen.options.slice(0, 5);
          await post(ev.channel, ev.thread_ts ?? ev.ts, 'Claude asks something first', { blocks: [
            { type: 'section', text: { type: 'mrkdwn', text: `It asks first:\n\`\`\`${escape(e.screen.text.split('\n').slice(-16).join('\n').trim()).slice(-2800)}\`\`\`` } },
            { type: 'actions', elements: opts.map((o) => ({ type: 'button', text: { type: 'plain_text', text: o.label.slice(0, 75) }, action_id: `ct:early:${crypto.randomBytes(3).toString('hex')}`, value: JSON.stringify({ m: machine || null, p: r.pane, so: r.socket, k: o.keys.map((k) => k.toLowerCase()) }) })) },
          ] }, 0);
        }
      } catch { /* it came up on its own, or it is gone */ }
    }, 8000).unref?.();
    setTimeout(() => { const i = launches.indexOf(watch); if (i >= 0) launches.splice(i, 1); }, 15 * 60_000).unref?.();
  }

  /* --- Slack, in -------------------------------------------------------- */

  async function onEvent(type, payload, { forwarded = false } = {}) {
    if (type === 'events_api') {
      const ev = payload.event;
      if (ev?.type !== 'message' || ev.bot_id || ev.hidden) return;
      if (ev.subtype && ev.subtype !== 'file_share' && ev.subtype !== 'thread_broadcast') return;
      if (cfg.pair && !cfg.owner) return pairing(ev);
      if (cfg.pair && /\bpair\s+\d{6}\b/.test(ev.text ?? '')) return pairing(ev);
      if (ev.user !== cfg.owner) return;
      const inThread = ev.thread_ts && ev.thread_ts !== ev.ts;
      if (inThread) {
        const key = byThread.get(`${ev.channel}/${ev.thread_ts}`);
        const x = key && live.get(key);
        if (x) return reply(x, ev);
        const row = q.byTs.get(ev.channel, ev.thread_ts);
        if (row && row.ended_at) return post(ev.channel, ev.thread_ts, ':black_circle: That session has ended. `new <folder>` starts another; resuming it brings this thread back.', {}, 0);
        // Not a thread of ours: maybe another machine's, if it runs Slack itself.
        if (forwarded) return;
        if (forward(type, payload)) return;
        if (row) return post(ev.channel, ev.thread_ts, ':hourglass: That session\'s machine is not connected right now.', {}, 0);
        if (ev.channel === cfg.channel || ev.channel_type === 'im') return command(ev);
        return;
      }
      if (forwarded) return;
      if (ev.channel === cfg.channel || ev.channel_type === 'im') return command(ev);
      return;
    }
    if (type === 'interactive' && payload.type === 'block_actions') {
      if (payload.user?.id !== cfg.owner) return;
      for (const a of payload.actions ?? []) await action(a, payload, forwarded);
    }
  }

  async function action(a, payload, forwarded) {
    let v;
    try { v = JSON.parse(a.value); } catch { return; }
    const kind = a.action_id.split(':').slice(0, 2).join(':');
    const channel = payload.channel?.id ?? payload.container?.channel_id;
    const thread = payload.message?.thread_ts ?? payload.message?.ts;
    if (kind === 'ct:early') {
      const m = machines.get(v.m ?? '');
      try {
        if (!m?.online) throw new Error('that machine is not connected');
        await m.act({ op: 'early', pane: v.p, socket: v.so, keys: v.k });
        await post(channel, thread, `:ballot_box_with_check: pressed ${v.k.join(' ')}`, {}, 0);
      } catch (err) { await post(channel, thread, `:x: ${escape(err.message)}`, {}, 0); }
      return;
    }
    const x = live.get(keyOf(v.m ?? null, v.s));
    if (!x) {
      if (forwarded) return;
      if (forward('interactive', payload)) return;
      return post(channel, thread, ':black_circle: That session is not running any more.', {}, 0);
    }
    try {
      if (kind === 'ct:screen') return await showScreen(x, await act(x, { op: 'screen', sessionId: x.s.sessionId }));
      if (kind === 'ct:unmute') { x.muted = false; q.mute.run(0, x.s.sessionId); refreshCard(x, true); return; }
      if (kind === 'ct:keys') {
        await act(x, { op: 'keys', sessionId: x.s.sessionId, keys: v.k });
        await post(x.thread.channel, x.thread.ts, `:ballot_box_with_check: pressed ${v.k.map((k) => `\`${escape(k)}\``).join(' ')}`, {}, 0);
      }
    } catch (err) {
      await post(x.thread.channel, x.thread.ts, `:x: ${escape(err.message)}`, {}, 0);
    }
  }

  /** The pairing code from `claude-tracker slack setup`: whoever posts it is the owner, and where is home. */
  async function pairing(ev) {
    const code = (ev.text ?? '').match(/\bpair\s+(\d{6})\b/)?.[1];
    if (!code || !cfg.pair) return;
    if (Date.now() > cfg.pair.until) {
      return post(ev.channel, ev.ts, ':hourglass: That code has expired. Run `claude-tracker slack pair` for a new one.', {}, 0);
    }
    const a = Buffer.from(code), b = Buffer.from(String(cfg.pair.code));
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return;
    cfg = { ...cfg, owner: ev.user, channel: ev.channel, pair: null, paused: false };
    writeConfig(cfg);
    cfgStamp = stamp();
    let name = ev.channel_type === 'im' ? 'a DM' : null;
    try { if (!name) name = `#${(await call(cfg.botToken, 'conversations.info', { channel: ev.channel })).channel.name}`; } catch { name = 'this channel'; }
    cfg.channelName = name; writeConfig(cfg); cfgStamp = stamp();
    setStatus({ state: 'connected', error: null, channel: ev.channel, channelName: name, owner: ev.user });
    await post(ev.channel, ev.ts, `:white_check_mark: Paired. Your Claude sessions on ${escape(here)}${machines.size > 1 ? ' and the machines it syncs with' : ''} each get a thread here now.\n\n${HELP}`, {}, 0);
    for (const m of machines.values()) if (m.last) sessions(m.id, m.last);
  }

  /* --- running ----------------------------------------------------------- */

  const stamp = () => { try { return fs.statSync(CONFIG_FILE).mtimeMs; } catch { return null; } };

  function connect() {
    sock?.stop(); api?.stop();
    sock = null; api = null;
    cfg = readConfig();
    if (!cfg?.botToken || !cfg?.appToken || cfg.disabled) { setStatus({ state: 'off', error: null }); return; }
    api = queue(cfg.botToken, { onError: slackFailed });
    setStatus({ state: 'connecting', error: null, fatal: false, channel: cfg.channel ?? null, channelName: cfg.channelName ?? null, owner: cfg.owner ?? null, pairing: !!cfg.pair });
    sock = socketMode(cfg.appToken, {
      onEvent: (type, payload) => onEvent(type, payload).catch((err) => log(`slack event: ${err.message}`)),
      onState: (s) => {
        if (s.state === 'connected') setStatus({ state: 'connected', error: null, fatal: false });
        else if (s.state === 'error') {
          setStatus({ state: 'error', error: s.fatal ? `the app token was refused (${s.code}) - run claude-tracker slack setup again` : s.error, fatal: !!s.fatal });
        } else if (status.state !== 'connected') setStatus({ state: s.state });
      },
    });
    for (const m of machines.values()) if (m.last) sessions(m.id, m.last);
  }

  // Setup and pairing write the config from another process; pick it up.
  const watcher = setInterval(() => {
    const s = stamp();
    if (s === cfgStamp) return;
    const before = cfg;
    cfgStamp = s;
    const next = readConfig();
    if (!next || next.botToken !== before?.botToken || next.appToken !== before?.appToken || !!next.disabled !== !!before?.disabled) return connect();
    cfg = next;
    if (cfg.channel !== before?.channel) for (const x of live.values()) x.thread = null;
    setStatus({ channel: cfg.channel ?? null, channelName: cfg.channelName ?? null, owner: cfg.owner ?? null, pairing: !!cfg.pair });
    for (const m of machines.values()) if (m.last) sessions(m.id, m.last);
  }, 3000);
  watcher.unref?.();
  cfgStamp = stamp();
  connect();

  // A thread's first message keeps up with what changes quietly - context, the
  // account after a failover - at most every half minute, and only if it did.
  const cards = setInterval(() => { if (ready()) for (const x of live.values()) refreshCard(x); }, 30_000);
  cards.unref?.();

  return {
    get active() { return !!(cfg?.botToken && cfg?.appToken && !cfg.disabled); },
    /** A machine whose sessions come through here: this one (id null), or a synced one. */
    machine(id, name, act) {
      const m = machines.get(id ?? '') ?? { id: id ?? null, last: null };
      Object.assign(m, { name, act, online: true, old: false });
      machines.set(id ?? '', m);
    },
    machineDown(id, { old = false, refused = false } = {}) {
      const m = machines.get(id ?? '');
      if (!m) return;
      m.online = false; m.old = old; m.refused = refused;
      for (const x of live.values()) if (x.machine === (id ?? null)) refreshCard(x, true);
    },
    sessions(id, list) {
      const m = machines.get(id ?? '');
      if (m) m.last = list;
      sessions(id, list);
    },
    items,
    /** An event another machine's bridge received for a thread of ours. */
    foreign: (type, payload) => onEvent(type, payload, { forwarded: true }).catch(() => {}),
    /** One of the tracker's own alerts, said in the channel too. */
    notice(title, text) {
      if (!ready()) return;
      post(cfg.channel, null, `:bell: *${escape(title)}*\n${escape(text)}`).catch(() => {});
    },
    status: () => ({ ...status, threads: cfg?.channel ? q.count.get(cfg.channel).n : 0, backlog: api?.backlog ?? 0 }),
    stop() {
      clearInterval(watcher); clearInterval(cards);
      sock?.stop(); api?.stop();
    },
  };
}
