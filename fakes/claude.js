#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

/*
 * A stand-in for Claude Code's terminal UI, enough to be driven the way the
 * tracker drives the real one: it registers itself with its tmux pane, draws
 * an input box between two rules, takes typed keys and bracketed pastes,
 * writes what is said to a transcript, and can stop on a permission prompt.
 *
 *   ASK …   asks permission, with a numbered menu, before it answers
 *   SLOW …  works for 30s (Esc interrupts)
 *   SHELLS … answers, then stays "shell": idle with shells left running
 *   STEPS …  a turn of several remarks and tool calls, a long write-up, and an answer
 *   /exit   quits
 *
 * Ctrl-C quits at once, so a test can tell if the tracker ever sends one.
 */
const [profile, sessionId, cwd] = process.argv.slice(2);
const slug = cwd.replace(/[^a-zA-Z0-9]/g, '-');
const transcript = path.join(profile, 'projects', slug, `${sessionId}.jsonl`);
const registry = path.join(profile, 'sessions', `${process.pid}.json`);
fs.mkdirSync(path.dirname(transcript), { recursive: true });
fs.mkdirSync(path.dirname(registry), { recursive: true });

let input = '', status = 'idle', waitingFor = null, menu = null, timer = null, log = [];
const queued = [];   // typed while it works: taken once the turn is over, as Claude Code does
let titled = false;
const pane = process.env.TMUX_PANE;

function register() {
  fs.writeFileSync(registry, JSON.stringify({
    pid: process.pid, sessionId, cwd, kind: 'interactive', name: 'fake', version: 'test',
    tmux: `fake:@0.${pane}`, status, waitingFor, startedAt: Date.now(), updatedAt: Date.now(), statusUpdatedAt: Date.now(),
  }));
}
const write = (e) => fs.appendFileSync(transcript, `${JSON.stringify({ sessionId, cwd, timestamp: new Date().toISOString(), uuid: Math.random().toString(36).slice(2), ...e })}\n`);
const say = (text, tools = []) => write({ type: 'assistant', message: { content: [...tools, { type: 'text', text }] } });

function draw() {
  const rule = '─'.repeat(50);
  let out = '\x1b[2J\x1b[H';
  for (const l of log.slice(-8)) out += `${l}\r\n`;
  if (menu) {
    out += `${rule}\r\n Do you want to proceed?\r\n`;
    menu.forEach((m, i) => { out += ` ${i === 0 ? '❯' : ' '} ${i + 1}. ${m}\r\n`; });
    out += ' Esc to cancel\r\n';
  } else {
    const lines = input.split('\n');
    out += `${rule}\r\n❯ ${input ? lines[0] : '\x1b[2mTry "something"\x1b[0m'}\r\n`;
    for (const l of lines.slice(1)) out += `  ${l}\r\n`;
    out += `${rule}\r\n  fake · ${status}\r\n`;
  }
  process.stdout.write(out);
}

function setStatus(s, w = null) {
  status = s; waitingFor = w; register(); draw();
  if (s !== 'busy' && s !== 'waiting' && queued.length) setTimeout(() => submit(queued.shift()), 50);
}

function submit(text) {
  if (status === 'busy') { queued.push(text); draw(); return; }
  if (text === '/exit') { cleanup(); process.exit(0); }
  const command = text.match(/^\/(\S+)\s*(.*)$/);
  write({ type: 'user', origin: { kind: 'human' }, promptSource: 'typed', message: {
    content: command ? `<command-name>/${command[1]}</command-name>\n<command-message>${command[1]}</command-message>\n<command-args>${command[2]}</command-args>` : text,
  } });
  log.push(`> ${text.split('\n')[0]}`);
  // Claude Code names a conversation after its first prompt.
  if (!titled) { titled = true; write({ type: 'ai-title', aiTitle: `Fake ${text.split('\n')[0].slice(0, 30)}` }); }
  // A slash command prints what it did, as Claude Code's do, and Claude says nothing.
  if (command) {
    write({ type: 'user', message: { content: `<local-command-stdout>ran /${command[1]}</local-command-stdout>` } });
    draw();
    return;
  }
  setStatus('busy');
  if (text.startsWith('ASK')) {
    // A tool call, then a prompt for the next one - as Claude stops mid-turn to ask.
    timer = setTimeout(() => {
      write({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] } });
      menu = ['Yes', 'No'];
      setStatus('waiting', 'permission prompt');
    }, 200);
  } else if (text.startsWith('STEPS')) {
    // A turn as Claude writes one: remarks between tool calls, a long write-up, then the answer.
    timer = setTimeout(() => {
      const bash = (c) => [{ type: 'tool_use', name: 'Bash', input: { command: c } }];
      say('Looking at it.', bash('ls'));
      say('Found it.', bash('grep -n bug src/x.js'));
      say(`Here is the plan in full. ${'It has many parts. '.repeat(45)}`, bash('npm test'));
      write({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: `${cwd}/src/x.js` } }] } });
      say('All done.');
      setStatus('idle');
    }, 300);
  } else if (text.startsWith('SLOW')) {
    timer = setTimeout(() => { say('slow done'); setStatus('idle'); }, 30_000);
  } else {
    timer = setTimeout(() => {
      say(`echo: ${text}`, [{ type: 'tool_use', name: 'Bash', input: { command: 'echo hi' } }]);
      log.push(`echo: ${text.split('\n')[0]}`);
      // Claude Code says "shell" for idle with shells left running in the background.
      setStatus(text.startsWith('SHELLS') ? 'shell' : 'idle');
    }, 300);
  }
}

function cleanup() { try { fs.unlinkSync(registry); } catch { /* gone */ } }

process.stdin.setRawMode(true);
process.stdin.setEncoding('utf8');
let pasting = false;
process.stdin.on('data', (d) => {
  let s = d;
  while (s.length) {
    if (s.startsWith('\x1b[200~')) { pasting = true; s = s.slice(6); continue; }
    if (s.startsWith('\x1b[201~')) { pasting = false; s = s.slice(6); continue; }
    if (pasting) {
      const end = s.indexOf('\x1b[201~');
      const chunk = end < 0 ? s : s.slice(0, end);
      input += chunk.replace(/\r\n?/g, '\n');
      s = s.slice(chunk.length);
      continue;
    }
    if (s.startsWith('\x1b[3~')) { s = s.slice(4); continue; }                 // Delete
    if (s[0] === '\x1b') {                                                     // Esc
      s = s.slice(1);
      if (menu) { menu = null; clearTimeout(timer); say('denied'); setStatus('idle'); }
      else if (status === 'busy') { clearTimeout(timer); write({ type: 'user', message: { content: '[Request interrupted by user]' } }); setStatus('idle'); }
      continue;
    }
    const ch = s[0];
    s = s.slice(1);
    if (ch === '\x03') { cleanup(); process.exit(130); }                       // Ctrl-C
    if (menu && /[12]/.test(ch)) { const yes = ch === '1'; menu = null; say(yes ? 'approved' : 'denied'); setStatus('idle'); continue; }
    if (ch === '\r') { const t = input; input = ''; if (t.trim()) submit(t); else draw(); continue; }
    if (ch === '\x15') { input = input.includes('\n') ? input.slice(0, input.lastIndexOf('\n') + 1) : ''; draw(); continue; }   // Ctrl-U
    if (ch === '\x7f') { input = input.slice(0, -1); draw(); continue; }        // Backspace
    if (ch === '\x05') continue;                                               // Ctrl-E
    if (ch >= ' ') { input += ch; draw(); }
  }
});
process.on('SIGTERM', () => { cleanup(); process.exit(0); });
process.stdout.write('\x1b[?2004h');   // bracketed paste on, as Claude Code turns it on
register();
draw();
