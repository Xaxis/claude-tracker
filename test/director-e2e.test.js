import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fakeSlack } from '../fakes/slack.js';

/*
 * The director's hands end to end: a real tracker, its API called as the
 * director calls it, Slack stood in for by a fake, and Claude Code by the fake
 * terminal UI in real tmux panes on a private tmux server.
 */
const REPO = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
const CLI = path.join(REPO, 'bin', 'cli.js');
const FAKE = path.join(REPO, 'fakes', 'claude.js');
const hasTmux = spawnSync('tmux', ['-V']).status === 0;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-director-'));
const sock = path.join(root, 'tmux.sock');
const env0 = { ...process.env };
for (const k of ['TMUX', 'TMUX_PANE', 'CLAUDE_CONFIG_DIR', 'CLAUDE_TRACKER_EXTRA_DIRS']) delete env0[k];
const tmux = (...args) => spawnSync('tmux', ['-S', sock, ...args], { encoding: 'utf8', env: env0 });
process.on('exit', () => { tmux('kill-server'); fs.rmSync(root, { recursive: true, force: true }); });
for (const sig of ['SIGINT', 'SIGTERM']) process.once(sig, () => process.exit(1));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(what, fn, ms = 20_000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    try { last = await fn(); if (last) return last; } catch (err) { last = err; }
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${what}${last instanceof Error ? `: ${last.message}` : ''}`);
}

const PORT = 47941;
const home = path.join(root, 'box');
const data = path.join(home, 'data');
const prof = path.join(home, '.claude');
for (const d of [path.join(prof, 'projects'), path.join(prof, 'sessions'), data]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(prof, 'settings.json'), '{}');
fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: 'box-acct', emailAddress: 'box@example.com' } }));
// What the director starts: the fake, with a new session id each time, in the folder it was started in.
// ps, failing while this file is there: as a ps that times out on a loaded box.
const psFails = path.join(home, 'ps-fails');
const shims = path.join(root, 'shims');
fs.mkdirSync(shims, { recursive: true });
fs.writeFileSync(path.join(shims, 'ps'), `#!/bin/sh\n[ -e '${psFails}' ] && exit 2\nexec '${spawnSync('sh', ['-c', 'command -v ps'], { encoding: 'utf8' }).stdout.trim()}' "$@"\n`, { mode: 0o755 });
// In the profile CLAUDE_CONFIG_DIR names, as Claude Code is, or the default one.
const LAUNCH = `'${process.execPath}' '${FAKE}' "\${CLAUDE_CONFIG_DIR:-${prof}}" "$('${process.execPath}' -p 'crypto.randomUUID()')" "$PWD"`;

let slack, proc, log = '';
const t = {};
const env = () => ({
  ...env0, PATH: `${shims}:${env0.PATH}`, HOME: home, CLAUDE_TRACKER_DIR: data, CLAUDE_TRACKER_NOTIFY: '0', NO_COLOR: '1',
  CLAUDE_TRACKER_SLACK_API: slack.api, CLAUDE_TRACKER_PANES_MS: '250', CLAUDE_TRACKER_LAUNCH: LAUNCH,
  CLAUDE_TRACKER_DIRECTOR_IDLE: '0.05',
  BOX_GPU_DIR: path.join(home, 'box-gpu'), BOX_HEAVY_DIR: path.join(home, 'box-heavy'), BOX_GPU_STATE: path.join(home, 'gpu-state'),
});
function start() {
  log = '';
  proc = spawn(process.execPath, [CLI, 'serve', '--no-tui', '--port', String(PORT)], { env: env(), stdio: ['ignore', 'pipe', 'pipe'] });
  proc.stdout.on('data', (b) => { log += b; });
  proc.stderr.on('data', (b) => { log += b; });
}
const stopTracker = () => new Promise((r) => { if (proc?.exitCode !== null) return r(); proc.once('exit', r); proc.kill(); });

const key = () => fs.readFileSync(path.join(data, 'director.key'), 'utf8').trim();
async function api(method, p, body, headers = {}) {
  const res = await fetch(`http://127.0.0.1:${PORT}/api/director${p}`, {
    method, headers: { authorization: `Bearer ${key()}`, ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
}
const ok = async (method, p, body) => {
  const r = await api(method, p, body);
  assert.equal(r.status, 200, `${method} ${p}: ${JSON.stringify(r.body)}`);
  return r.body;
};
const events = async () => (await ok('GET', '/events?after=0')).events;
const event = (what, pred) => until(what, async () => (await events()).find(pred));

const transcriptOf = (cwd, id, profile = prof) => path.join(profile, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${id}.jsonl`);
const said = (file) => { try { return fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l)); } catch { return []; } };
const prompts = (file) => said(file).filter((e) => e.type === 'user' && e.origin?.kind === 'human').map((e) => e.message.content);
const replies = (file) => said(file).filter((e) => e.type === 'assistant').flatMap((e) => e.message.content.filter((b) => b.type === 'text').map((b) => b.text));
const inThread = (ts) => slack.posts().filter((p) => p.thread_ts === ts);
const blocksText = (m) => JSON.stringify(m?.blocks ?? []);
const threadTs = (link) => link.match(/\/p(\d+)$/)[1].replace(/(\d{6})$/, '.$1');

test.before(async () => { slack = await fakeSlack(); });
test.after(async () => {
  await stopTracker();
  tmux('kill-server');
  slack?.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test('the key is made on first start, and nothing gets in without it or from a web page', { skip: !hasTmux && 'needs tmux', timeout: 60_000 }, async () => {
  fs.writeFileSync(path.join(data, 'slack.json'), JSON.stringify({ botToken: 'xoxb-test', appToken: 'xapp-test', team: 'T1', url: 'https://test.slack.com/', owner: 'U1', channel: 'C1' }), { mode: 0o600 });
  // The owner's own session, started by hand: the director may read it, not write to it.
  t.alphaCwd = path.join(home, 'work', 'alpha');
  fs.mkdirSync(t.alphaCwd, { recursive: true });
  t.alpha = 'aaaaaaaa-1111-2222-3333-444444444444';
  tmux('new-session', '-d', '-s', 'alpha', '-x', '120', '-y', '40', '-c', t.alphaCwd, 'sh');
  tmux('send-keys', '-t', 'alpha', '-l', `PS1='$ ' exec 2>/dev/null; '${process.execPath}' '${FAKE}' '${prof}' ${t.alpha} '${t.alphaCwd}'`);
  tmux('send-keys', '-t', 'alpha', 'Enter');
  await until('the fake Claude to register', () => fs.readdirSync(path.join(prof, 'sessions')).length);
  start();
  await until('the tracker', async () => (await fetch(`http://127.0.0.1:${PORT}/api/health`)).ok);
  assert.match(key(), /^[0-9a-f]{64}$/);
  assert.equal(fs.statSync(path.join(data, 'director.key')).mode & 0o777, 0o600);
  const none = await fetch(`http://127.0.0.1:${PORT}/api/director/sessions`);
  assert.equal(none.status, 401);
  assert.equal((await api('GET', '/sessions', null, { authorization: 'Bearer nope' })).status, 401);
  assert.equal((await api('GET', '/sessions', null, { origin: `http://127.0.0.1:${PORT}` })).status, 403, 'a page on the dashboard itself is refused too');
  const list = await until('alpha listed, with its thread', async () => {
    const r = await ok('GET', '/sessions');
    return r.sessions.find((s) => s.id === t.alpha && s.thread) && r;
  });
  assert.equal(list.paused, false);
  const a = list.sessions.find((s) => s.id === t.alpha);
  assert.equal(a.owner, 'owner');
  assert.equal(a.state, 'idle');
  assert.equal(a.tmux, 'alpha');
  assert.equal(a.cwd, t.alphaCwd);
  assert.match(a.thread, /^https:\/\/test\.slack\.com\/archives\/C1\/p\d+$/);
  t.alphaThread = threadTs(a.thread);
  const w = await api('POST', `/sessions/${t.alpha}/type`, { text: 'not yours' });
  assert.equal(w.status, 403);
  assert.match(w.body.error, /not the director's session/);
  assert.equal((await api('POST', '/sessions/nope/type', { text: 'x' })).status, 404);
});

test('it starts a session of its own, types its first message, and hears the turn end', { skip: !hasTmux, timeout: 60_000 }, async () => {
  t.cwd = path.join(home, 'work', 'beta');
  fs.mkdirSync(t.cwd, { recursive: true });
  const r = await ok('POST', '/sessions', { cwd: t.cwd, prompt: 'hello from the director', name: 'beta-dir' });
  assert.equal(r.tmux, 'beta-dir');
  assert.match(r.id, /^[0-9a-f-]{36}$/);
  t.id = r.id;
  t.transcript = transcriptOf(t.cwd, t.id);
  const started = await event('started', (e) => e.kind === 'started' && e.session === t.id);
  assert.deepEqual({ cwd: started.detail.cwd, owner: started.detail.owner }, { cwd: t.cwd, owner: 'director' });
  await until('its first message typed', () => prompts(t.transcript).includes('hello from the director'));
  const done = await event('turn_done', (e) => e.kind === 'turn_done' && e.session === t.id);
  assert.deepEqual(done.detail, { n: 1, answerPreview: 'echo: hello from the director' });
  const s = (await ok('GET', `/sessions/${t.id}`));
  assert.equal(s.owner, 'director');
  t.thread = threadTs(s.thread);
  // Its thread shows what the director did, as the director's.
  const shown = inThread(t.thread).map(blocksText).join('\n');
  assert.match(shown, /the director\* started this session/);
  assert.match(shown, /the director\* typed:.*hello from the director/);
  const turn = await until('the turn in the thread', () => inThread(t.thread).find((p) => /echo: hello from the director/.test(p.text)));
  assert.match(blocksText(turn), /asked via the director/);
  assert.ok(!/at the terminal/.test(blocksText(turn)));
  const turns = await ok('GET', `/sessions/${t.id}/turns?after=0`);
  assert.equal(turns.next, 1);
  assert.equal(turns.turns.length, 1);
  assert.deepEqual({ ...turns.turns[0], at: null }, { n: 1, at: null, prompt: 'hello from the director', answer: 'echo: hello from the director', tools: [{ verb: 'ran', what: 'echo hi' }], done: true });
  assert.deepEqual((await ok('GET', `/sessions/${t.id}/turns?after=1`)).turns, []);
});

test('a prompt is an event with its choices; a message for it is held; a choice answers it, by name', { skip: !hasTmux, timeout: 60_000 }, async () => {
  assert.deepEqual(await ok('POST', `/sessions/${t.id}/type`, { text: 'ASK to run ls' }), { sent: true, queued: false });
  const w = await event('waiting', (e) => e.kind === 'waiting' && e.session === t.id);
  assert.equal(w.detail.title, 'Do you want to proceed?');
  assert.deepEqual(w.detail.choices, [{ key: '1', label: 'Yes' }, { key: '2', label: 'No' }]);
  const listed = (await ok('GET', `/sessions/${t.id}`));
  assert.equal(listed.state, 'waiting');
  assert.equal(listed.waiting.title, 'Do you want to proceed?');
  const scr = await ok('GET', `/sessions/${t.id}/screen`);
  assert.match(scr.text, /1\. Yes/);
  // A message while it asks goes in only after the answer: never as one.
  assert.deepEqual(await ok('POST', `/sessions/${t.id}/type`, { text: 'after the prompt' }), { held: true });
  const alert = await until('the alert', () => inThread(t.thread).find((p) => /needs you/.test(blocksText(p))));
  await ok('POST', `/sessions/${t.id}/keys`, { keys: ['2'] });
  await until('the session to be answered no', () => replies(t.transcript).includes('denied'));
  await until('the alert to say who chose what', () => /the director chose 2\. No$/.test(slack.messages.get(alert.ts)?.text ?? ''));
  assert.match(inThread(t.thread).map(blocksText).join('\n'), /the director\* chose \*2\. No\*/);
  await until('the held message to go in after', () => prompts(t.transcript).includes('after the prompt'));
  const p = prompts(t.transcript);
  assert.ok(p.indexOf('after the prompt') > p.indexOf('ASK to run ls'));
});

test('keys by name, a slash command, and the Ctrl-C it never sends', { skip: !hasTmux, timeout: 60_000 }, async () => {
  await until('idle again', async () => (await ok('GET', `/sessions/${t.id}`)).state === 'idle');
  const bad = await api('POST', `/sessions/${t.id}/keys`, { keys: ['ctrl-c'] });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /Ctrl-C/);
  assert.equal((await api('POST', `/sessions/${t.id}/command`, { name: 'rm' })).status, 400);
  await ok('POST', `/sessions/${t.id}/command`, { name: 'compact' });
  await until('/compact run', () => said(t.transcript).some((e) => e.type === 'user' && /<command-name>\/compact</.test(e.message?.content ?? '')));
  assert.match(inThread(t.thread).map(blocksText).join('\n'), /the director\* ran `\/compact`/);
  const r = await ok('POST', `/sessions/${t.id}/keys`, { keys: ['shift-tab'] });
  assert.match(r.screen, /accept edits on/);
  assert.equal(tmux('display', '-p', '-t', 'beta-dir', '#{pane_current_command}').stdout.trim(), 'node', 'still running: no Ctrl-C');
});

test('a session that cannot be read for a moment has not ended, and is still the director\'s', { skip: !hasTmux, timeout: 60_000 }, async () => {
  const before = (await events()).at(-1).seq;
  // Its registry entry caught mid-rewrite, for a few looks.
  const dir = path.join(prof, 'sessions');
  const file = fs.readdirSync(dir).map((n) => path.join(dir, n)).find((f) => f.endsWith('.json') && fs.readFileSync(f, 'utf8').includes(t.id));
  const text = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, '');
  await sleep(1500);
  fs.writeFileSync(`${file}.tmp`, text);
  fs.renameSync(`${file}.tmp`, file);
  // ps failing, for a few looks.
  fs.writeFileSync(psFails, '');
  await sleep(1500);
  fs.unlinkSync(psFails);
  await sleep(1000);
  const since = (await ok('GET', `/events?after=${before}`)).events.filter((e) => e.session === t.id);
  assert.deepEqual(since.filter((e) => e.kind === 'exited' || e.kind === 'started'), [], 'it never left');
  assert.equal((await ok('GET', `/sessions/${t.id}`)).owner, 'director');
});

test('context nearly full is said at 70%, and again at 85%', { skip: !hasTmux, timeout: 90_000 }, async () => {
  await ok('POST', `/sessions/${t.id}/type`, { text: 'CONTEXT 700000' });
  const first = await event('context_high at 70%', (e) => e.kind === 'context_high' && e.session === t.id, 45_000);
  assert.deepEqual(first.detail, { percent: 72 });
  assert.deepEqual((await ok('GET', `/sessions/${t.id}`)).context, { tokens: 700000, percent: 72 });
  await ok('POST', `/sessions/${t.id}/type`, { text: 'CONTEXT 720000' });
  await until('that turn', async () => (await ok('GET', `/sessions/${t.id}`)).context?.tokens === 720000, 45_000);
  await ok('POST', `/sessions/${t.id}/type`, { text: 'CONTEXT 840000' });
  await event('context_high at 85%', (e) => e.kind === 'context_high' && e.session === t.id && e.detail.percent === 87, 45_000);
  assert.equal((await events()).filter((e) => e.kind === 'context_high' && e.session === t.id).length, 2, 'once per level');
});

test('a turn that stops on the plan\'s limit says so, and when the limit resets', { skip: !hasTmux, timeout: 60_000 }, async () => {
  await until('idle', async () => (await ok('GET', `/sessions/${t.id}`)).state === 'idle');
  await ok('POST', `/sessions/${t.id}/type`, { text: 'LIMIT then' });
  const done = await event('the turn on the limit', (e) => e.kind === 'turn_done' && e.session === t.id && e.detail.answerPreview.includes('hit your limit'));
  const limit = { kind: 'rate_limit', resetsAt: 1795111200000 };
  assert.deepEqual(done.detail.error, limit);
  const [turn] = (await ok('GET', `/sessions/${t.id}/turns?after=${done.detail.n - 1}&limit=1`)).turns;
  assert.equal(turn.n, done.detail.n);
  assert.deepEqual(turn.error, limit);
  // A turn that answers says nothing of one.
  await ok('POST', `/sessions/${t.id}/type`, { text: 'after the limit' });
  const next = await event('the next turn', (e) => e.kind === 'turn_done' && e.session === t.id && e.detail.n === done.detail.n + 1);
  assert.equal(next.detail.error, undefined);
  assert.equal((await ok('GET', `/sessions/${t.id}/turns?after=${done.detail.n}`)).turns[0].error, undefined);
});

test('`director pause` in the channel refuses every write until `director resume`, which an app cannot send', { skip: !hasTmux, timeout: 60_000 }, async () => {
  slack.message({ channel: 'C1', user: 'U1', text: 'director pause' });
  await event('paused', (e) => e.kind === 'paused');
  assert.equal((await ok('GET', '/sessions')).paused, true);
  const w = await api('POST', `/sessions/${t.id}/type`, { text: 'while paused' });
  assert.equal(w.status, 409);
  assert.equal((await api('POST', '/sessions', { cwd: t.cwd })).status, 409);
  const footer = { type: 'context', block_id: 'mcp_attribution_footer', elements: [{ type: 'mrkdwn', text: '*Sent using* Claude' }] };
  slack.message({ channel: 'C1', user: 'U1', app_id: 'A08SF47R6P4', text: 'director resume *Sent using* Claude', blocks: [
    { type: 'rich_text', elements: [{ type: 'rich_text_section', elements: [{ type: 'text', text: 'director resume' }] }] }, footer] });
  await until('the refusal', () => slack.posts('C1').find((p) => /Resume the director yourself/.test(p.text ?? '')));
  assert.equal((await ok('GET', '/sessions')).paused, true);
  slack.message({ channel: 'C1', user: 'U1', text: 'director resume' });
  await event('resumed', (e) => e.kind === 'resumed');
  assert.equal((await ok('GET', '/sessions')).paused, false);
  assert.ok(!prompts(t.transcript).includes('while paused'));
});

test('`;director` hands the owner\'s session over and `;mine` takes it back; an app\'s post cannot hand one over', { skip: !hasTmux, timeout: 60_000 }, async () => {
  const footer = { type: 'context', block_id: 'mcp_attribution_footer', elements: [{ type: 'mrkdwn', text: '*Sent using* Claude' }] };
  slack.message({ channel: 'C1', user: 'U1', app_id: 'A08SF47R6P4', thread_ts: t.alphaThread, text: ';director *Sent using* Claude', blocks: [
    { type: 'rich_text', elements: [{ type: 'rich_text_section', elements: [{ type: 'text', text: ';director' }] }] }, footer] });
  await until('the refusal', () => inThread(t.alphaThread).find((p) => /hand a session over yourself/.test(p.text ?? '')));
  assert.equal((await ok('GET', `/sessions/${t.alpha}`)).owner, 'owner');
  slack.message({ channel: 'C1', user: 'U1', thread_ts: t.alphaThread, text: ';director' });
  await event('handed_over', (e) => e.kind === 'handed_over' && e.session === t.alpha);
  assert.equal((await ok('GET', `/sessions/${t.alpha}`)).owner, 'director');
  await until('the card to say so', () => /the director's/.test(blocksText(slack.messages.get(t.alphaThread))));
  await ok('POST', `/sessions/${t.alpha}/type`, { text: 'typed by the director' });
  await until('it typed', () => prompts(transcriptOf(t.alphaCwd, t.alpha)).includes('typed by the director'));
  slack.message({ channel: 'C1', user: 'U1', thread_ts: t.alphaThread, text: ';mine' });
  await event('taken_back', (e) => e.kind === 'taken_back' && e.session === t.alpha);
  assert.equal((await api('POST', `/sessions/${t.alpha}/type`, { text: 'not any more' })).status, 403);
});

test('the Director thread: a decision with buttons, a tap, a reply, and an edit', { skip: !hasTmux, timeout: 60_000 }, async () => {
  const choices = [{ key: 'ship', label: 'Ship it' }, { key: 'wait', label: 'Not now' }];
  const { ts } = await ok('POST', '/thread', { text: 'Ship *the app* v2?', kind: 'decision', ref: 'dec-1', choices });
  const posted = slack.messages.get(ts);
  const top = slack.messages.get(posted.thread_ts);
  assert.equal(top.text, 'Director');
  assert.match(posted.text, /^<@U1> /, 'a decision mentions the owner');
  const buttons = posted.blocks.find((b) => b.type === 'actions').elements;
  assert.deepEqual(buttons.map((b) => b.text.text), ['Ship it', 'Not now']);
  // Someone else's tap is nobody's.
  slack.push('interactive', { type: 'block_actions', user: { id: 'U2' }, channel: { id: 'C1' }, message: { ts, thread_ts: posted.thread_ts }, actions: [{ action_id: buttons[0].action_id, value: buttons[0].value }] });
  slack.push('interactive', { type: 'block_actions', user: { id: 'U1' }, channel: { id: 'C1' }, message: { ts, thread_ts: posted.thread_ts }, actions: [{ action_id: buttons[1].action_id, value: buttons[1].value }] });
  const chose = await event('owner_choice', (e) => e.kind === 'owner_choice');
  assert.deepEqual(chose.detail, { ref: 'dec-1', choice: 'wait' });
  assert.equal((await events()).filter((e) => e.kind === 'owner_choice').length, 1);
  await until('its buttons gone', () => !slack.messages.get(ts).blocks.some((b) => b.type === 'actions') && /you chose \*Not now\*/.test(blocksText(slack.messages.get(ts))));
  await ok('POST', `/thread/${ts}`, { text: 'Ship *the app* v2? · answered: Not now' });
  assert.match(blocksText(slack.messages.get(ts)), /answered: Not now/);
  assert.equal((await api('POST', `/thread/${t.alphaThread}`, { text: 'not its message' })).status, 404);
  // A reply is a message for it; `;1` answers its newest open question.
  slack.message({ channel: 'C1', user: 'U1', thread_ts: posted.thread_ts, text: 'what about the docs?' });
  const msg = await event('owner_message', (e) => e.kind === 'owner_message');
  assert.deepEqual(msg.detail, { text: 'what about the docs?' });
  const q2 = await ok('POST', '/thread', { text: 'Docs first?', kind: 'decision', ref: 'dec-2', choices });
  slack.message({ channel: 'C1', user: 'U1', thread_ts: posted.thread_ts, text: ';1' });
  const chose2 = await event('the second choice', (e) => e.kind === 'owner_choice' && e.detail.ref === 'dec-2');
  assert.deepEqual(chose2.detail, { ref: 'dec-2', choice: 'ship' });
  await until('its buttons gone too', () => !slack.messages.get(q2.ts).blocks.some((b) => b.type === 'actions'));
  const brief = await ok('POST', '/thread', { text: 'Today: two tasks.', kind: 'brief' });
  assert.equal(slack.messages.get(brief.ts).thread_ts, posted.thread_ts, 'one Director thread');
});

test('events: a long poll that wakes on the next one, idle, and seq that survives a restart', { skip: !hasTmux, timeout: 90_000 }, async () => {
  const idle = await event('idle', (e) => e.kind === 'idle' && e.session === t.id);
  assert.deepEqual(idle.detail, { minutes: 0.05 });
  // Once nothing else is coming: a poll that finds nothing for a second.
  let next = (await ok('GET', '/events?after=0')).next;
  await until('a quiet moment', async () => {
    const r = await ok('GET', `/events?after=${next}&wait=1`);
    next = r.next;
    return !r.events.length;
  });
  const t0 = Date.now();
  const waiting = ok('GET', `/events?after=${next}&wait=20`);
  await sleep(500);
  slack.message({ channel: 'C1', user: 'U1', text: 'director are you there?' });
  const got = await waiting;
  assert.ok(Date.now() - t0 < 10_000, 'woke when it came, not at the end of the wait');
  assert.deepEqual(got.events.map((e) => [e.kind, e.detail]), [['owner_message', { text: 'are you there?' }]]);
  assert.equal(got.next, got.events[0].seq);
  // Taken by the director: the message says so.
  await until('the reply marked read', () => slack.reactions(slack.sent.at(-1)).includes('eyes'));
  const quiet = await ok('GET', `/events?after=${got.next}&wait=1`);
  assert.deepEqual(quiet, { events: [], next: got.next });
  await stopTracker();
  start();
  await until('the tracker back', async () => (await fetch(`http://127.0.0.1:${PORT}/api/health`)).ok);
  const kept = await ok('GET', `/events?after=${got.next - 1}`);
  assert.equal(kept.events[0].seq, got.next);
  // What it owns survives too.
  assert.equal((await until('beta listed again', async () => (await ok('GET', '/sessions')).sessions.find((s) => s.id === t.id))).owner, 'director');
  slack.message({ channel: 'C1', user: 'U1', text: 'director after the restart' });
  const after = await event('a new event', (e) => e.kind === 'owner_message' && e.detail.text === 'after the restart');
  assert.ok(after.seq > got.next);
});

test('stop ends it with /exit, and it is gone', { skip: !hasTmux, timeout: 60_000 }, async () => {
  await ok('POST', `/sessions/${t.id}/stop`);
  await event('exited', (e) => e.kind === 'exited' && e.session === t.id);
  // One it started goes with its tmux session; the owner's keep theirs.
  await until('its tmux session closed', () => tmux('has-session', '-t', '=beta-dir').status !== 0);
  assert.equal(tmux('has-session', '-t', '=alpha').status, 0);
  assert.match(inThread(t.thread).map(blocksText).join('\n'), /the director\* stopped it with `\/exit`/);
  assert.equal((await api('POST', `/sessions/${t.id}/type`, { text: 'x' })).status, 404);
  assert.ok(!/director/.test(log.replace(/director\.key/g, '')), `nothing went wrong: ${log}`);
});

test('on an account of its own: refused until its token, profile and folder are ready, and the token reaches Claude alone', { skip: !hasTmux, timeout: 60_000 }, async () => {
  const envFile = path.join(home, 'bot.env');
  const profile = path.join(home, '.claude-bot');
  fs.writeFileSync(path.join(data, 'director.json'), JSON.stringify({ accounts: { bot: { env: envFile, profile } } }));
  const cwd = path.join(home, 'work', 'gamma');
  fs.mkdirSync(cwd, { recursive: true });
  const refused = async (body, status, why) => {
    const r = await api('POST', '/sessions', { cwd, ...body });
    assert.equal(r.status, status, JSON.stringify(r.body));
    assert.match(r.body.error, why);
  };
  await refused({}, 400, /say which - bot/);
  await refused({ account: 'owner' }, 400, /one of bot/);
  await refused({ account: 'bot' }, 409, /no token yet/);
  fs.writeFileSync(envFile, 'DATABASE_URL=postgres://secret\nexport CLAUDE_CODE_OAUTH_TOKEN="sk-ant-oat01-TEST_token-123"\n', { mode: 0o600 });
  await refused({ account: 'bot' }, 409, /not set up yet/);
  fs.mkdirSync(profile, { recursive: true });
  fs.writeFileSync(path.join(profile, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, projects: {} }));
  await refused({ account: 'bot' }, 409, /not trusted/);
  fs.writeFileSync(path.join(profile, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, projects: { [path.join(home, 'work')]: { hasTrustDialogAccepted: true } } }));
  // Named through a symlink, it is the folder Claude trusts all the same.
  fs.symlinkSync(path.join(home, 'work'), path.join(home, 'linked'));
  const r = await ok('POST', '/sessions', { cwd: path.join(home, 'linked', 'gamma'), account: 'bot', name: 'gamma-bot', prompt: 'hello from its own account' });
  // Its profile has never been used for more than a theme and a trusted folder: no projects/ yet, as Claude Code leaves it.
  assert.equal(r.pending, undefined, `it came up, in a profile with nothing in it yet: ${JSON.stringify(r)}`);
  const got = await until('what the session got', () => { try { return JSON.parse(fs.readFileSync(path.join(profile, `env-${r.id}.json`), 'utf8')); } catch { return null; } });
  assert.deepEqual(got, { token: 'sk-ant-oat01-TEST_token-123', configDir: profile });
  assert.deepEqual(fs.readdirSync(path.join(data, 'launch-env')), [], 'the file it came in is gone');
  await until('its first message', () => [cwd, path.join(home, 'linked', 'gamma')].some((c) => prompts(transcriptOf(c, r.id, profile)).includes('hello from its own account')));
  // Its transcript, in a projects/ that only now exists, is read like any other.
  const done = await event('its turn done', (e) => e.kind === 'turn_done' && e.session === r.id);
  assert.equal(done.detail.n, 1);
  const shown = tmux('capture-pane', '-p', '-S', '-2000', '-t', '=gamma-bot').stdout;
  assert.ok(!shown.includes('TEST_token') && !shown.includes('postgres'), 'nothing from the env file is ever shown');
  await ok('POST', `/sessions/${r.id}/stop`);
  await until('its tmux session closed', () => tmux('has-session', '-t', '=gamma-bot').status !== 0);
});
