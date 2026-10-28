/**
 * Slack, with nothing installed: the Web API over fetch, and Socket Mode over
 * the WebSocket Node already has.
 *
 * Socket Mode is what lets a tracker that only listens on loopback hear from
 * Slack at all: the tracker opens a connection out to Slack, and events and
 * button presses come back down it. Nothing listens on the network.
 */

const API = () => process.env.CLAUDE_TRACKER_SLACK_API || 'https://slack.com/api/';

export class SlackError extends Error {
  constructor(method, code, detail = null) {
    super(`${method}: ${code}${detail ? ` (${detail})` : ''}`);
    this.code = code;
  }
}

/** Errors that will not go away by trying again: the tokens or the app's setup are wrong. */
export const FATAL = new Set([
  'invalid_auth', 'not_authed', 'account_inactive', 'token_revoked', 'token_expired', 'no_permission',
  'missing_scope', 'not_allowed_token_type', 'invalid_token', 'app_missing_action_url', 'team_access_not_granted',
]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** One Web API call. Waits out a rate limit, up to a few times. */
export async function call(token, method, args = {}) {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(args)) {
    if (v === undefined || v === null) continue;
    body.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
  }
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(new URL(method, API()), {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' },
        body,
        signal: AbortSignal.timeout(20_000),
      });
    } catch (err) {
      if (attempt >= 2) throw new SlackError(method, 'unreachable', err.cause?.code ?? err.message);
      await sleep(1000 * (attempt + 1));
      continue;
    }
    if (res.status === 429 && attempt < 4) {
      await sleep(1000 * (Number(res.headers.get('retry-after')) || 2 ** attempt));
      continue;
    }
    let data;
    try { data = await res.json(); } catch { throw new SlackError(method, `http_${res.status}`); }
    if (!data.ok) {
      throw new SlackError(method, data.error ?? 'unknown_error',
        data.response_metadata?.messages?.join('; ') || (data.needed ? `needs ${data.needed}` : null));
    }
    return data;
  }
}

/**
 * Web API calls one at a time, most urgent first, paced well inside Slack's
 * limits. Answers to the person go first, the conversation next, and refreshes
 * of a thread's header last - and a refresh still waiting is replaced by a
 * newer one for the same message rather than sent twice.
 */
export function queue(token, { onError = () => {} } = {}) {
  const lanes = [[], [], []];
  const pending = new Map();
  // Posting is limited to about one a second in a channel, and editing to
  // about fifty a minute; each has its own clock, so neither holds up the other.
  const GAP = { 'chat.postMessage': 1050, 'chat.update': 1250 };
  const nextAt = new Map();
  let running = false, stopped = false;

  /** The most urgent job whose method may be called now, or how long until one may. */
  function next() {
    let wait = Infinity;
    for (const lane of lanes) {
      for (let i = 0; i < lane.length; i++) {
        const at = nextAt.get(lane[i].method) ?? 0;
        if (at <= Date.now()) return { job: lane.splice(i, 1)[0] };
        wait = Math.min(wait, at - Date.now());
      }
    }
    return { wait };
  }

  async function pump() {
    if (running) return;
    running = true;
    try {
      for (;;) {
        if (stopped) return;
        const { job, wait } = next();
        if (!job) { if (wait === Infinity) return; await sleep(wait); continue; }
        if (job.key) pending.delete(job.key);
        if (GAP[job.method]) nextAt.set(job.method, Date.now() + GAP[job.method]);
        try {
          const r = await call(token, job.method, job.args);
          for (const w of job.waiters) w.resolve(r);
        } catch (err) {
          onError(err, job.method);
          for (const w of job.waiters) w.reject(err);
        }
      }
    } finally {
      running = false;
    }
  }

  return {
    /** priority: 0 now, 1 conversation, 2 refresh. A `key` replaces a call still waiting with the same key. */
    send(method, args, { priority = 1, key = null } = {}) {
      return new Promise((resolve, reject) => {
        if (key && pending.has(key)) {
          const job = pending.get(key);
          job.args = args;
          job.waiters.push({ resolve, reject });
          return;
        }
        const job = { method, args, key, waiters: [{ resolve, reject }] };
        if (key) pending.set(key, job);
        lanes[priority].push(job);
        pump();
      });
    },
    get backlog() { return lanes.reduce((n, l) => n + l.length, 0); },
    stop() { stopped = true; },
  };
}

/**
 * A Socket Mode connection that keeps itself up. Every envelope is
 * acknowledged at once, so Slack never re-sends one, and each event is handed
 * on once even if Slack does. `onState` hears 'connecting', 'connected' and
 * 'error' - with `fatal` when trying again cannot help.
 */
export function socketMode(appToken, { onEvent, onState = () => {} }) {
  let ws = null, stopped = false, failures = 0, watchdog = null;
  const seen = new Map();

  const fresh = (id) => {
    if (!id) return true;
    if (seen.has(id)) return false;
    seen.set(id, Date.now());
    if (seen.size > 2000) for (const [k] of [...seen].slice(0, 1000)) seen.delete(k);
    return true;
  };

  async function connect() {
    if (stopped) return;
    onState({ state: 'connecting' });
    let url;
    try {
      url = (await call(appToken, 'apps.connections.open')).url;
      if (process.env.CLAUDE_TRACKER_SLACK_WS_DEBUG) url += '&debug_reconnects=true';
    } catch (err) {
      failures++;
      const fatal = FATAL.has(err.code);
      onState({ state: 'error', error: err.message, code: err.code, fatal });
      // A token Slack refuses is checked again only now and then: fixing it
      // means running setup, which restarts this anyway.
      return retry(fatal ? 5 * 60_000 : Math.min(60_000, 1000 * 2 ** failures));
    }
    let sock;
    try { sock = new WebSocket(url); } catch (err) {
      failures++;
      onState({ state: 'error', error: err.message });
      return retry(Math.min(60_000, 1000 * 2 ** failures));
    }
    ws = sock;
    let closed = false;
    const reopen = (ms) => {
      if (closed) return;
      closed = true;
      clearTimeout(watchdog);
      try { sock.close(); } catch { /* already */ }
      if (ws === sock) ws = null;
      retry(ms);
    };
    // A connection that went quiet may be dead without saying so.
    const heard = () => {
      clearTimeout(watchdog);
      watchdog = setTimeout(() => reopen(0), 6 * 60_000);
      watchdog.unref?.();
    };
    sock.addEventListener('open', heard);
    sock.addEventListener('message', (m) => {
      heard();
      let msg;
      try { msg = JSON.parse(typeof m.data === 'string' ? m.data : Buffer.from(m.data).toString('utf8')); } catch { return; }
      if (msg.envelope_id) {
        try { sock.send(JSON.stringify({ envelope_id: msg.envelope_id })); } catch { /* closing */ }
      }
      if (msg.type === 'hello') { failures = 0; onState({ state: 'connected' }); return; }
      // Slack asks for a new connection every few hours; this one is closed for it.
      if (msg.type === 'disconnect') { reopen(0); return; }
      if (!msg.payload) return;
      const id = msg.payload.event_id ?? msg.payload.trigger_id ?? msg.envelope_id;
      if (!fresh(id)) return;
      Promise.resolve().then(() => onEvent(msg.type, msg.payload)).catch(() => {});
    });
    sock.addEventListener('close', () => { failures++; reopen(Math.min(30_000, 500 * 2 ** failures)); });
    sock.addEventListener('error', () => { /* followed by close */ });
  }

  let timer = null;
  function retry(ms) {
    if (stopped) return;
    clearTimeout(timer);
    timer = setTimeout(connect, ms);
    timer.unref?.();
  }

  connect();
  return {
    stop() {
      stopped = true;
      clearTimeout(timer);
      clearTimeout(watchdog);
      try { ws?.close(); } catch { /* already */ }
    },
  };
}

/* --- text ------------------------------------------------------------------ */

/** Slack treats these three as markup everywhere, so they go escaped. */
export const escape = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Inline Markdown, outside code, as Slack's mrkdwn. */
function inline(s) {
  const codes = [];
  s = s.replace(/`([^`\n]+)`/g, (_, c) => `\u0000${codes.push(c) - 1}\u0000`);
  s = escape(s);
  s = s.replace(/!?\[([^\]\n]+)\]\(([^)\s]+)\)/g, (_, t, u) => `<${u}|${t}>`);
  s = s.replace(/\*\*(?=\S)(.+?\S)\*\*/g, '\u0001$1\u0001').replace(/__(?=\S)(.+?\S)__/g, '\u0001$1\u0001');
  s = s.replace(/(^|[^\w*])\*(?=\S)([^*\n]+?\S)\*(?![\w*])/g, '$1_$2_');
  s = s.replace(/~~(?=\S)(.+?\S)~~/g, '~$1~');
  s = s.replace(/\u0001/g, '*');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `\`${escape(codes[Number(i)])}\``);
}

/**
 * Claude's Markdown as Slack mrkdwn: bold, italics, links, headings, lists,
 * code. Slack has no tables, so a table goes in a code block, where its
 * columns still line up.
 */
export function toMrkdwn(md) {
  const out = [];
  const lines = String(md).replace(/\r\n?/g, '\n').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = line.match(/^\s*(`{3,}|~{3,})/);
    if (fence) {
      const body = [];
      for (i++; i < lines.length && !lines[i].trim().startsWith(fence[1]); i++) body.push(lines[i]);
      out.push('```', ...body.map(escape), '```');
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      const rows = [];
      for (; i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i]); i++) rows.push(lines[i].trim());
      i--;
      out.push('```', ...rows.filter((r) => !/^\|[\s:|-]+\|$/.test(r)).map(escape), '```');
      continue;
    }
    const h = line.match(/^#{1,6}\s+(.*?)\s*#*\s*$/);
    if (h) { out.push(`*${inline(h[1]).replace(/\*/g, '')}*`); continue; }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { out.push('───'); continue; }
    const li = line.match(/^(\s*)[-*+]\s+(.*)$/);
    if (li) { out.push(`${' '.repeat(li[1].length)}• ${inline(li[2])}`); continue; }
    const q = line.match(/^>\s?(.*)$/);
    if (q) { out.push(`> ${inline(q[1])}`); continue; }
    out.push(inline(line));
  }
  return out.join('\n');
}

/**
 * Text cut into messages Slack shows whole, on paragraph or line breaks where
 * it can. A code block cut in two is closed and reopened, so both halves
 * still read as code.
 */
export function split(text, max = 3500) {
  const parts = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n\n', max);
    if (cut < max / 2) cut = rest.lastIndexOf('\n', max);
    if (cut < max / 2) cut = max;
    let head = rest.slice(0, cut);
    rest = rest.slice(cut).replace(/^\n+/, '');
    if ((head.match(/^```/gm)?.length ?? 0) % 2) { head += '\n```'; rest = `\`\`\`\n${rest}`; }
    parts.push(head);
  }
  if (rest.trim()) parts.push(rest);
  return parts;
}

/** What someone typed in Slack, as they typed it: links, names and escapes undone. */
export function fromSlack(text) {
  return String(text ?? '')
    .replace(/<#[A-Z0-9]+\|([^>]*)>/g, '#$1')
    .replace(/<!(here|channel|everyone)[^>]*>/g, '@$1')
    .replace(/<@([A-Z0-9]+)(?:\|[^>]*)?>/g, '@$1')
    // A pasted link comes back as <url|what was shown>: the url is what was meant.
    .replace(/<([^<>|]+)\|([^<>]*)>/g, (_, target, label) => (/^https?:/.test(target) ? target : label))
    .replace(/<(?:mailto:|tel:)?([^<>]+)>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

/* --- the app ---------------------------------------------------------------- */

/** What Slack needs to know to create the app: its scopes, events, and Socket Mode. */
export function manifest(name = 'Claude Sessions') {
  return {
    display_information: {
      name,
      description: 'Your Claude Code sessions, one thread each: read them, answer them, drive them.',
      background_color: '#2b2a33',
    },
    features: {
      app_home: { home_tab_enabled: false, messages_tab_enabled: true, messages_tab_read_only_enabled: false },
      bot_user: { display_name: name, always_online: true },
    },
    oauth_config: {
      scopes: {
        bot: ['chat:write', 'channels:history', 'groups:history', 'im:history', 'channels:read', 'groups:read', 'reactions:write', 'files:read'],
      },
    },
    settings: {
      event_subscriptions: { bot_events: ['message.channels', 'message.groups', 'message.im'] },
      interactivity: { is_enabled: true },
      org_deploy_enabled: false,
      socket_mode_enabled: true,
      token_rotation_enabled: false,
    },
  };
}

/** A link that opens Slack's "create an app" with the manifest filled in. */
export const createAppUrl = (m = manifest()) => `https://api.slack.com/apps?new_app=1&manifest_json=${encodeURIComponent(JSON.stringify(m))}`;
