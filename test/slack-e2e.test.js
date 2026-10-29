import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fakeSlack } from '../fakes/slack.js';

/*
 * Real trackers driving sessions from Slack end to end. Slack is stood in for
 * by a fake that speaks the Web API and Socket Mode, and Claude Code by a fake
 * terminal UI (fakes/claude.js) running in real tmux panes on a private tmux
 * server - so every key is really typed into a pane, the way it is into Claude.
 */
const REPO = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
const CLI = path.join(REPO, 'bin', 'cli.js');
const FAKE = path.join(REPO, 'fakes', 'claude.js');
const hasTmux = spawnSync('tmux', ['-V']).status === 0;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-slack-'));
const sock = path.join(root, 'tmux.sock');
const fakeSsh = path.join(root, 'ssh');
fs.writeFileSync(fakeSsh, '#!/bin/sh\nwhile [ $# -gt 1 ]; do shift; done\nexec sh -c "$1"\n', { mode: 0o755 });

const env0 = { ...process.env };
for (const k of ['TMUX', 'TMUX_PANE', 'CLAUDE_CONFIG_DIR', 'CLAUDE_TRACKER_EXTRA_DIRS']) delete env0[k];
const tmux = (...args) => spawnSync('tmux', ['-S', sock, ...args], { encoding: 'utf8', env: env0 });
const screen = (target) => tmux('capture-pane', '-p', '-t', target).stdout;
// However the run ends, its tmux server and the fakes in it go with it.
process.on('exit', () => { tmux('kill-server'); fs.rmSync(root, { recursive: true, force: true }); });
for (const sig of ['SIGINT', 'SIGTERM']) process.once(sig, () => process.exit(1));

let slack;
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

function machine(name, port) {
  const home = path.join(root, name);
  const data = path.join(home, 'data');
  const prof = path.join(home, '.claude');
  fs.mkdirSync(path.join(prof, 'projects'), { recursive: true });
  fs.mkdirSync(path.join(prof, 'sessions'), { recursive: true });
  fs.mkdirSync(data, { recursive: true });
  fs.writeFileSync(path.join(prof, 'settings.json'), '{}');
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: `${name}-acct`, emailAddress: `${name}@example.com` } }));
  const env = {
    ...env0, HOME: home, CLAUDE_TRACKER_DIR: data, CLAUDE_TRACKER_NOTIFY: '0', NO_COLOR: '1', CLAUDE_TRACKER_SSH: fakeSsh,
    CLAUDE_TRACKER_SLACK_API: slack.api, CLAUDE_TRACKER_PANES_MS: '250',
    BOX_GPU_DIR: path.join(home, 'box-gpu'), BOX_HEAVY_DIR: path.join(home, 'box-heavy'), BOX_GPU_STATE: path.join(home, 'gpu-state'),
  };
  return {
    name, port, home, data, prof, env,
    cli: (...args) => spawnSync(process.execPath, [CLI, ...args], { env, encoding: 'utf8', timeout: 60_000 }),
    relay: `CLAUDE_TRACKER_DIR='${data}' '${process.execPath}' '${CLI}' sync serve`,
    slackConfig(cfg) { fs.writeFileSync(path.join(data, 'slack.json'), JSON.stringify({ botToken: 'xoxb-test', appToken: 'xapp-test', team: 'T1', url: 'https://test.slack.com/', ...cfg }), { mode: 0o600 }); },
    config: () => JSON.parse(fs.readFileSync(path.join(data, 'slack.json'), 'utf8')),
    start() {
      this.proc = spawn(process.execPath, [CLI, 'serve', '--no-tui', '--port', String(port)], { env, stdio: ['ignore', 'pipe', 'pipe'] });
      this.log = '';
      this.proc.stdout.on('data', (b) => { this.log += b; });
      this.proc.stderr.on('data', (b) => { this.log += b; });
    },
    async get(p) { return (await fetch(`http://127.0.0.1:${port}${p}`)).json(); },
    /** Claude, as a person would start it: typed into a shell in a new tmux session. */
    claude(tmuxName, sessionId) {
      const cwd = path.join(home, 'work', tmuxName);
      fs.mkdirSync(cwd, { recursive: true });
      tmux('new-session', '-d', '-s', tmuxName, '-x', '120', '-y', '40', '-c', cwd, 'sh');
      tmux('send-keys', '-t', tmuxName, '-l', `PS1='$ ' exec 2>/dev/null; '${process.execPath}' '${FAKE}' '${prof}' ${sessionId} '${cwd}'`);
      tmux('send-keys', '-t', tmuxName, 'Enter');
      return { transcript: path.join(prof, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${sessionId}.jsonl`), cwd };
    },
  };
}

const said = (file) => { try { return fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l)); } catch { return []; } };
const prompts = (file) => said(file).filter((e) => e.type === 'user' && e.origin?.kind === 'human').map((e) => e.message.content);
const replies = (file) => said(file).filter((e) => e.type === 'assistant').flatMap((e) => e.message.content.filter((b) => b.type === 'text').map((b) => b.text));
const inThread = (ts) => slack.posts().filter((p) => p.thread_ts === ts);
const reacted = (name) => slack.calls.some((c) => c.method === 'reactions.add' && c.args.name === name);
const blocksText = (m) => JSON.stringify(m.blocks ?? []);

const one = { };
const SESSION = 'aaaaaaaa-1111-2222-3333-444444444444';

test.before(async () => { slack = await fakeSlack(); });
test.after(async () => {
  // CT_SLACK_DUMP=<file> keeps every call the trackers made, to check against real Slack.
  if (process.env.CT_SLACK_DUMP) fs.writeFileSync(process.env.CT_SLACK_DUMP, JSON.stringify(slack.calls));
  for (const m of [one.m, one.hub, one.peer].filter(Boolean)) {
    if (m.proc?.exitCode === null) await new Promise((r) => { m.proc.once('exit', r); m.proc.kill(); });
  }
  tmux('kill-server');
  slack?.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test('a running session gets a thread, and what it says shows there', { skip: !hasTmux && 'needs tmux', timeout: 60_000 }, async () => {
  const m = machine('solo', 47921);
  one.m = m;
  m.slackConfig({ owner: 'U1', channel: 'C1', channelName: '#claude' });
  one.s = m.claude('alpha', SESSION);
  await until('the fake Claude to register', () => fs.readdirSync(path.join(m.prof, 'sessions')).length);
  m.start();
  one.root = await until('the session\'s thread', () => slack.posts('C1').find((p) => !p.thread_ts && /^alpha: idle/.test(p.text)));
  assert.match(blocksText(one.root), /Reply in this thread to type into it/);
  assert.match(blocksText(one.root), /tmux `alpha:0\.0`/);
  const st = await m.get('/api/slack');
  assert.equal(st.state, 'connected');
});

test('a reply in the thread is typed into the session, and its answer comes back', { skip: !hasTmux, timeout: 30_000 }, async () => {
  const before = inThread(one.root.ts).length;
  slack.message({ channel: 'C1', user: 'U1', text: 'hello there &amp; welcome', thread_ts: one.root.ts });
  await until('the prompt to reach the session', () => prompts(one.s.transcript).includes('hello there & welcome'));
  const reply = await until('the answer in the thread', () => inThread(one.root.ts).find((p) => /echo: hello there &amp; welcome/.test(p.text)));
  assert.equal(reply.blocks[0].type, 'context', 'what it did comes first, in grey');
  assert.match(blocksText(reply), /worked \d+s · ran `echo hi`/);
  assert.match(reply.blocks[1].text.text, /^echo: hello there &amp; welcome$/);
  assert.ok(reacted('white_check_mark'));
  await sleep(2500);
  assert.equal(inThread(one.root.ts).length - before, 1, `one message for the turn, nothing else: ${JSON.stringify(inThread(one.root.ts).slice(before).map((p) => p.text))}`);
  assert.ok(!blocksText(reply).includes('at the terminal'), 'not echoed back as if typed at the terminal');
});

test('what is typed at the terminal shows in the thread', { skip: !hasTmux, timeout: 30_000 }, async () => {
  tmux('send-keys', '-t', 'alpha', '-l', 'from the keyboard');
  tmux('send-keys', '-t', 'alpha', 'Enter');
  const turn = await until('the terminal turn in the thread', () => inThread(one.root.ts).find((p) => /at the terminal: “from the keyboard”/.test(blocksText(p))));
  assert.match(turn.blocks[1].text.text, /^echo: from the keyboard$/);
});

test('a message starting with a dash is typed as it is', { skip: !hasTmux, timeout: 30_000 }, async () => {
  slack.message({ channel: 'C1', user: 'U1', text: '-x is not a flag', thread_ts: one.root.ts });
  await until('the dash message', () => prompts(one.s.transcript).includes('-x is not a flag'));
});

test('a half-typed draft is cleared first, and said so, and the message arrives whole', { skip: !hasTmux, timeout: 30_000 }, async () => {
  tmux('send-keys', '-t', 'alpha', '-l', 'half a draft');
  await until('the draft on screen', () => screen('alpha').includes('half a draft'));
  slack.message({ channel: 'C1', user: 'U1', text: 'line one\nline two', thread_ts: one.root.ts });
  await until('the multi-line prompt', () => prompts(one.s.transcript).includes('line one\nline two'));
  assert.ok(!prompts(one.s.transcript).some((p) => p.includes('half a draft')));
  const note = await until('the note about the draft', () => inThread(one.root.ts).find((p) => /cleared what was in its input box first: “half a draft”/.test(p.text)));
  assert.equal(note.blocks[0].type, 'context');
});

test('a permission prompt: the screen and a button per choice, with a mention, and a press answers it', { skip: !hasTmux, timeout: 30_000 }, async () => {
  slack.message({ channel: 'C1', user: 'U1', text: 'ASK to run something', thread_ts: one.root.ts });
  const alert = await until('the alert', () => inThread(one.root.ts).find((p) => /needs you/.test(blocksText(p))));
  assert.match(blocksText(alert), /<@U1> \*alpha needs you\*/);
  assert.match(blocksText(alert), /Do you want to proceed\?/);
  const actions = alert.blocks.find((b) => b.type === 'actions').elements;
  assert.deepEqual(actions.map((a) => a.text.text), ['1. Yes', '2. No', 'Esc', 'Full screen']);
  assert.ok(!/fake ·/.test(blocksText(alert)), 'the question, not the whole screen');
  const card = await until('the card to say it waits', () => slack.messages.get(one.root.ts)?.text === 'alpha: waiting on you (permission prompt)');
  assert.ok(card);
  await sleep(2500);   // a prompt pauses the turn: nothing of it is posted while it waits
  assert.ok(!inThread(one.root.ts).some((p) => Number(p.ts) > Number(alert.ts)), 'nothing posted while it waits');
  const yes = actions[0];
  slack.push('interactive', { type: 'block_actions', user: { id: 'U1' }, channel: { id: 'C1' }, message: { ts: alert.ts, thread_ts: one.root.ts }, actions: [{ action_id: yes.action_id, value: yes.value }] });
  await until('the session to be answered yes', () => replies(one.s.transcript).at(-1) === 'approved');
  const answered = await until('the alert to say what was chosen', () => /you chose 1\. Yes$/.test(slack.messages.get(alert.ts)?.text ?? ''));
  assert.ok(answered);
  assert.ok(!inThread(one.root.ts).some((p) => /pressed/.test(p.text)), 'a choice changes the prompt in place - nothing new is posted');
  // The prompt paused the turn; the turn itself ends in one message, after it.
  const after = await until('the turn\'s message', () => inThread(one.root.ts).filter((p) => Number(p.ts) > Number(alert.ts)).find((p) => p.text === 'approved'));
  await sleep(2500);
  assert.deepEqual(inThread(one.root.ts).filter((p) => Number(p.ts) > Number(alert.ts)).map((p) => p.text), [after.text]);
  assert.match(blocksText(after), /ran `ls`/, 'what it did before the prompt is part of the turn');
});

test('writing while a prompt is open answers it with Esc, then sends what was written', { skip: !hasTmux, timeout: 30_000 }, async () => {
  slack.message({ channel: 'C1', user: 'U1', text: 'ASK once more', thread_ts: one.root.ts });
  const second = await until('the second alert', () => inThread(one.root.ts).filter((p) => /needs you/.test(blocksText(p)))[1]);
  slack.message({ channel: 'C1', user: 'U1', text: 'no - do it differently', thread_ts: one.root.ts });
  await until('the new instruction', () => prompts(one.s.transcript).includes('no - do it differently'));
  assert.ok(replies(one.s.transcript).includes('denied'));
  await until('the alert to say how it was answered', () => /you chose Esc, then your reply$/.test(slack.messages.get(second.ts)?.text ?? ''));
});

test('`;` runs slash commands, `;screen` shows the terminal, and Ctrl-C is never sent', { skip: !hasTmux, timeout: 30_000 }, async () => {
  slack.message({ channel: 'C1', user: 'U1', text: ';model opus', thread_ts: one.root.ts });
  await until('the slash command', () => prompts(one.s.transcript).some((p) => p.startsWith('<command-name>/model</command-name>') && p.includes('<command-args>opus')));
  const note = await until('what the command printed', () => inThread(one.root.ts).find((p) => /`\/model opus` → ran \/model/.test(blocksText(p))));
  assert.equal(note.blocks[0].type, 'context');
  assert.equal(inThread(one.root.ts).filter((p) => /\/model opus/.test(`${p.text}${blocksText(p)}`)).length, 1, 'the command itself is not echoed');
  slack.message({ channel: 'C1', user: 'U1', text: ';screen', thread_ts: one.root.ts });
  await until('the screen', () => inThread(one.root.ts).find((p) => p.text === 'Screen of alpha' && /❯/.test(blocksText(p))));
  slack.message({ channel: 'C1', user: 'U1', text: ';keys ctrl-c', thread_ts: one.root.ts });
  await until('the refusal', () => inThread(one.root.ts).find((p) => /:x: ctrl-c is not sent: Ctrl-C twice closes Claude Code/.test(p.text)));
  assert.match(screen('alpha'), /fake · idle/, 'still running');
});

test('a turn of many steps: remarks fold into the summary, a long write-up posts as it comes, the answer last', { skip: !hasTmux, timeout: 30_000 }, async () => {
  const before = inThread(one.root.ts).length;
  slack.message({ channel: 'C1', user: 'U1', text: 'STEPS through it', thread_ts: one.root.ts });
  const turn = await until('the turn\'s message', () => inThread(one.root.ts).slice(before).find((p) => p.text === 'All done.'));
  await sleep(2500);
  const posted = inThread(one.root.ts).slice(before);
  assert.equal(posted.length, 2, JSON.stringify(posted.map((p) => p.text)));
  assert.match(posted[0].text, /^Here is the plan in full\./, 'the long write-up first, on its own');
  const grey = turn.blocks[0].elements[0].text;
  assert.match(grey, /worked \d+s · ran 3 commands, the last `npm test` · edited `src\/x\.js`/);
  assert.match(grey, /› Looking at it\.\n› Found it\./);
  assert.doesNotMatch(grey, /plan in full/, 'not twice');
  assert.equal(turn.blocks[1].text.text, 'All done.');
});

test('a turn that ends with shells left running still ends, and the card says so', { skip: !hasTmux, timeout: 30_000 }, async () => {
  slack.message({ channel: 'C1', user: 'U1', text: 'SHELLS in the background', thread_ts: one.root.ts });
  await until('the turn\'s message', () => inThread(one.root.ts).find((p) => /echo: SHELLS in the background/.test(p.text)));
  await until('the card', () => /idle · shells running in the background/.test(blocksText(slack.messages.get(one.root.ts))), 5000);
});

test('nobody but the owner is listened to', { skip: !hasTmux, timeout: 30_000 }, async () => {
  slack.message({ channel: 'C1', user: 'U2', text: 'not from the owner', thread_ts: one.root.ts });
  slack.push('interactive', { type: 'block_actions', user: { id: 'U2' }, channel: { id: 'C1' }, message: { ts: 'x', thread_ts: one.root.ts }, actions: [{ action_id: 'ct:keys:000000', value: JSON.stringify({ m: null, s: SESSION, k: ['esc'] }) }] });
  slack.message({ channel: 'C1', user: 'U1', text: 'from the owner', thread_ts: one.root.ts });
  await until('the owner\'s message', () => prompts(one.s.transcript).includes('from the owner'));
  assert.ok(!prompts(one.s.transcript).includes('not from the owner'));
});

test('`list` and `usage` answer in the channel', { skip: !hasTmux, timeout: 30_000 }, async () => {
  slack.message({ channel: 'C1', user: 'U1', text: 'list' });
  const list = await until('the list', () => slack.posts('C1').find((p) => /alpha>/.test(p.text ?? '')));
  assert.match(list.text, /<https:\/\/test\.slack\.com\/archives\/C1\/p1700000000\d+\|alpha>/);
});

test('once Claude exits, the pane\'s shell is never typed into', { skip: !hasTmux, timeout: 30_000 }, async () => {
  slack.message({ channel: 'C1', user: 'U1', text: ';exit', thread_ts: one.root.ts });
  await until('Claude to exit', () => tmux('display', '-p', '-t', 'alpha', '#{pane_current_command}').stdout.trim() === 'sh');
  await until('the card to say it ended', () => slack.messages.get(one.root.ts)?.text === 'alpha: ended');
  slack.message({ channel: 'C1', user: 'U1', text: 'echo SHOULD-NOT-RUN', thread_ts: one.root.ts });
  await until('the answer that it ended', () => inThread(one.root.ts).find((p) => /That session has ended/.test(p.text)));
  await sleep(500);
  assert.ok(!screen('alpha').includes('SHOULD-NOT-RUN'), screen('alpha'));
  await new Promise((r) => { one.m.proc.once('exit', r); one.m.proc.kill(); });
});

test('a session that ended while the tracker was down has its thread closed when it is back', { skip: !hasTmux, timeout: 60_000 }, async () => {
  const m = one.m;
  m.start();
  m.claude('gamma', 'cccccccc-1111-2222-3333-444444444444');
  const root = await until('gamma\'s thread', () => slack.posts('C1').find((p) => !p.thread_ts && /^gamma: idle/.test(p.text)));
  await new Promise((r) => { m.proc.once('exit', r); m.proc.kill(); });
  tmux('send-keys', '-t', 'gamma', '-l', '/exit');
  tmux('send-keys', '-t', 'gamma', 'Enter');
  await until('gamma to exit', () => tmux('display', '-p', '-t', 'gamma', '#{pane_current_command}').stdout.trim() === 'sh');
  m.start();
  await until('its thread to say it ended', () => slack.messages.get(root.ts)?.text === 'gamma: ended');
  assert.ok(!slack.posts('C1').some((p) => !p.thread_ts && /^gamma: /.test(p.text) && p.ts !== root.ts), 'no second thread');
  await new Promise((r) => { m.proc.once('exit', r); m.proc.kill(); });
});

test('a conversation from before the tracker was watching shows as context, not as something happening now', { skip: !hasTmux, timeout: 60_000 }, async () => {
  const m = one.m;   // stopped by the test before
  const d = m.claude('delta', 'dddddddd-1111-2222-3333-444444444444');
  await until('delta to start', () => screen('delta').includes('fake · idle'));
  tmux('send-keys', '-t', 'delta', '-l', 'asked before anyone watched');
  tmux('send-keys', '-t', 'delta', 'Enter');
  await until('its answer', () => replies(d.transcript).includes('echo: asked before anyone watched'));
  m.start();
  const root = await until('delta\'s thread', () => slack.posts('C1').find((p) => !p.thread_ts && /^delta: idle/.test(p.text)));
  const first = await until('its first message', () => inThread(root.ts)[0]);
  await sleep(2500);
  assert.match(blocksText(first), /before this thread · asked: “asked before anyone watched”/);
  assert.equal(inThread(root.ts).length, 1, JSON.stringify(inThread(root.ts).map((p) => p.text)));
  assert.match(blocksText(slack.messages.get(root.ts)), /\*delta\*  ·  Fake asked before anyone watched/);
  // Restarted, it carries on from where it read to - and still knows the title from before that.
  await new Promise((r) => { m.proc.once('exit', r); m.proc.kill(); });
  const updates = slack.calls.filter((c) => c.method === 'chat.update' && c.args.ts === root.ts).length;
  m.start();
  await until('the card refreshed after the restart', () => slack.calls.filter((c) => c.method === 'chat.update' && c.args.ts === root.ts).length > updates);
  await sleep(1500);
  assert.match(blocksText(slack.messages.get(root.ts)), /\*delta\*  ·  Fake asked before anyone watched/);
  assert.equal(inThread(root.ts).length, 1, 'nothing repeated');
  await new Promise((r) => { m.proc.once('exit', r); m.proc.kill(); });
});

test('pairing, and a synced machine\'s session driven through the one that has Slack', { skip: !hasTmux, timeout: 90_000 }, async () => {
  const hub = machine('hub', 47922);
  const peer = machine('peer', 47923);
  one.hub = hub; one.peer = peer;
  hub.slackConfig({ pair: { code: '482913', until: Date.now() + 600_000 } });
  const s = peer.claude('beta', 'bbbbbbbb-1111-2222-3333-444444444444');
  for (const x of [hub, peer]) { assert.equal(x.cli('sync', 'name', x.name).status, 0); x.start(); }
  for (const x of [hub, peer]) await until(`${x.name} to serve`, () => x.get('/api/health'));
  // Slack delivers events only to a connection that is open.
  await until('the hub to connect to Slack', async () => (await hub.get('/api/slack')).state === 'connected');

  // Pairing: a wrong code is ignored; the right one sets owner and home.
  slack.message({ channel: 'C9', user: 'U7', text: 'pair 111111', channel_type: 'channel' });
  await sleep(1000);
  assert.ok(!hub.config().owner);
  slack.message({ channel: 'C9', user: 'U7', text: 'pair 482913', channel_type: 'channel' });
  await until('pairing', () => hub.config().owner === 'U7' && hub.config().channel === 'C9' && !hub.config().pair);
  await until('the confirmation', () => slack.posts('C9').find((p) => /Paired\./.test(p.text ?? '')));

  const add = peer.cli('sync', 'add', 'hub.example', '--command', hub.relay, '--port', String(peer.port));
  assert.equal(add.status, 0, add.stdout + add.stderr);
  const root = await until('the peer\'s session thread on the hub', () => slack.posts('C9').find((p) => !p.thread_ts && /^beta: idle/.test(p.text)), 40_000);
  assert.match(blocksText(root), /on peer/);
  slack.message({ channel: 'C9', user: 'U7', text: 'over the sync link', thread_ts: root.ts });
  await until('the prompt on the peer', () => prompts(s.transcript).includes('over the sync link'));
  await until('its answer on the hub', () => inThread(root.ts).find((p) => /echo: over the sync link/.test(p.text)));
});
