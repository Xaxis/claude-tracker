import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CLAUDE_TRACKER_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-slack-unit-'));
test.after(() => fs.rmSync(process.env.CLAUDE_TRACKER_DIR, { recursive: true, force: true }));
const { toMrkdwn, split, fromSlack, escape } = await import('../src/slack.js');
const { screenOptions, screenDialog, inputBox, parseKeys, readEntry, toolSummary } = await import('../src/panes.js');
const { toolsLine, parseControl } = await import('../src/bridge.js');

/* Screens as Claude Code 2.1.312 drew them, captured from a real session. */
const RULE = '─'.repeat(60);
const PERMISSION = `❯ Use the Bash tool to run: date > stamp.txt
● Writing current date into stamp.txt
  ⎿  $ date > stamp.txt
${RULE}
 Bash command
 Write current date into stamp.txt
${'╌'.repeat(60)}
 date > stamp.txt
${'╌'.repeat(60)}
 Do you want to proceed?
 ❯ 1. Yes
   2. Yes, and always allow access to /tmp/probe from this project
   3. Yes, and switch to auto mode · auto mode handles these prompts for you
   4. No
 Esc to cancel · Tab to amend`;
const TRUST = `${RULE}
 Accessing workspace:
 /tmp/probe
 Quick safety check: Is this a project you created or one you trust?
 Claude Code'll be able to read, edit, and execute files here.
 Security guide
 ❯ No, exit
   Yes, I trust this folder
 Enter to confirm · Esc to cancel`;
const PICKER = `${'▔'.repeat(60)}
   Select model
     1.  Default (recommended)  Opus 5.5 · Best for everyday, complex tasks
     2.  Opus 5.5               For complex work and everyday tasks
     3.  Fable 5.1              For your toughest challenges
     4.  Sonnet 5.5             Most efficient for simpler tasks
   ❯ 5.  Haiku 5.5 ✔            Fastest for quick answers
     6.  Haiku 4.5              Fastest for quick answers
     7.  Sonnet 5               Efficient for routine tasks
     8.  Opus 5                 Best for everyday, complex tasks
     9.  Fable 5                Most capable for your hardest and longest-running tasks
   ↓ 10. Opus 4.8               Best for everyday, complex tasks
   Enter to set as default · s to use this session only · Esc to cancel`;

test('a permission prompt offers its numbered choices, picked by number', () => {
  const o = screenOptions(PERMISSION);
  assert.deepEqual(o.map((x) => x.keys), [['1'], ['2'], ['3'], ['4']]);
  assert.equal(o[0].label, 'Yes');
  assert.equal(o[3].label, 'No');
});

test('the conversation above the dialog is not read as choices', () => {
  // The `❯` before the earlier prompt is above the rule, so it is not a menu.
  assert.deepEqual(screenOptions(PERMISSION).filter((x) => /Bash tool/.test(x.label)), []);
});

test('a cursor menu is picked by moving to the choice and pressing Enter', () => {
  const o = screenOptions(TRUST);
  assert.deepEqual(o, [
    { label: 'No, exit', keys: ['Enter'] },
    { label: 'Yes, I trust this folder', keys: ['Down', 'Enter'] },
  ]);
});

test('past nine, a numbered choice is reached with the arrows from where the cursor is', () => {
  const o = screenOptions(PICKER);
  assert.equal(o.length, 10);
  assert.deepEqual(o[4].keys, ['5']);
  assert.deepEqual(o[9].keys, ['Down', 'Down', 'Down', 'Down', 'Down', 'Enter']);
  assert.match(o[0].label, /^Default \(recommended\) · Opus 5\.5/);
});

test('a dialog reads as its question: title, what it is about, the command as code, no choices or hints', () => {
  const tip = PERMISSION.replace(' Bash command\n', ' Bash command\n Tip: auto mode handles these prompts for you\n');
  assert.deepEqual(screenDialog(tip), {
    title: 'Bash command',
    body: [
      { text: 'Write current date into stamp.txt', code: false },
      { text: 'date > stamp.txt', code: true },
      { text: 'Do you want to proceed?', code: false },
    ],
  });
  assert.deepEqual(screenDialog(TRUST).body.map((l) => l.text), ['/tmp/probe', 'Quick safety check: Is this a project you created or one you trust?', 'Claude Code\'ll be able to read, edit, and execute files here.', 'Security guide']);
  assert.deepEqual(screenDialog(PICKER), { title: 'Select model', body: [] });
});

test('a screen with nothing to choose offers nothing', () => {
  assert.deepEqual(screenOptions(`${RULE}\n❯ \n${RULE}\n  flubtronic`), []);
});

test('the input box: typed text, several lines, and the dim placeholder that is not text', () => {
  const esc = '\x1b[39m';
  assert.deepEqual(inputBox(`hi\n${RULE}\n${esc}❯ \x1b[2mTry "create a util"\n${RULE}\n  status`), { text: '' });
  assert.deepEqual(inputBox(`${RULE}\n${esc}❯ draft A\n  draft B\n${RULE}\n  status`), { text: 'draft A\ndraft B' });
  assert.deepEqual(inputBox(`${RULE}\n${esc}❯ \n${RULE}`), { text: '' });
  // A past prompt in the conversation has no rule straight under it.
  assert.equal(inputBox(`\x1b[48;5;237m❯ old prompt\nreply\n`), null);
});

test('keys: names, control keys, and never Ctrl-C', () => {
  assert.deepEqual(parseKeys(['esc', '2', 'down', 'Enter', 'shift-tab', 'ctrl-o']), ['Escape', '2', 'Down', 'Enter', 'BTab', 'C-o']);
  assert.throws(() => parseKeys(['ctrl-c']), /Ctrl-C twice closes Claude Code/);
  assert.throws(() => parseKeys(['C-c']), /Ctrl-C/);
  assert.throws(() => parseKeys(['^m']), /not a key Claude Code uses/);
  assert.throws(() => parseKeys(['rm -rf']), /not a key/);
});

test('transcripts: only what a person typed counts as a prompt', () => {
  const st = { tools: [] };
  const human = { type: 'user', origin: { kind: 'human' }, promptSource: 'typed', message: { content: 'fix the bug' }, timestamp: '2026-10-28T10:00:00Z' };
  assert.deepEqual(readEntry(human, st).map((i) => [i.kind, i.text]), [['prompt', 'fix the bug']]);
  const peer = { type: 'user', origin: { kind: 'peer' }, promptSource: 'system', isMeta: true, message: { content: 'Another Claude session sent a message: hi' } };
  assert.deepEqual(readEntry(peer, st), []);
  // A teammate message carries no origin at all, in a transcript that has them elsewhere.
  const teammate = { type: 'user', message: { content: 'Another Claude session sent a message:\n<teammate-message>…' } };
  assert.deepEqual(readEntry(teammate, st), []);
  assert.deepEqual(readEntry(teammate, { tools: [] }), [], 'worded as injected, even before any origin is seen');
  const task = { type: 'user', origin: { kind: 'task-notification' }, message: { content: '<task-notification>…' } };
  assert.deepEqual(readEntry(task, st), []);
  const result = { type: 'user', message: { content: [{ type: 'tool_result', content: 'ok' }] } };
  assert.deepEqual(readEntry(result, st), []);
});

test('transcripts: commands, interruptions and command output read as such', () => {
  const st = { tools: [] };
  const cmd = { type: 'user', origin: { kind: 'human' }, message: { content: '<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args>opus</command-args>' } };
  assert.deepEqual(readEntry(cmd, st).map((i) => [i.kind, i.text, i.command]), [['prompt', '/model opus', true]]);
  const out = { type: 'user', message: { content: '<local-command-stdout>Set model to \x1b[1mOpus\x1b[22m</local-command-stdout>' } };
  assert.deepEqual(readEntry(out, st).map((i) => [i.kind, i.text]), [['note', 'Set model to Opus']]);
  const stop = { type: 'user', message: { content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] } };
  assert.deepEqual(readEntry(stop, st).map((i) => [i.kind, i.text]), [['note', 'interrupted']]);
});

test('transcripts: tool calls ride along with the next thing Claude writes', () => {
  const st = { tools: [] };
  const a = (content) => ({ type: 'assistant', cwd: '/w/app', message: { content } });
  assert.deepEqual(readEntry(a([{ type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }]), st), []);
  assert.deepEqual(readEntry(a([{ type: 'tool_use', name: 'Edit', input: { file_path: '/w/app/src/x.js' } }]), st), []);
  assert.deepEqual(readEntry(a([{ type: 'thinking', thinking: '…' }]), st), []);
  const [t] = readEntry(a([{ type: 'text', text: 'Tests pass.' }]), st);
  assert.equal(t.text, 'Tests pass.');
  assert.deepEqual(t.tools.map((x) => [x.verb, x.what]), [['ran', 'npm test'], ['edited', 'src/x.js']]);
  assert.equal(st.turnTools, 2);
  assert.deepEqual(st.tools, [], 'carried once');
  assert.deepEqual(readEntry({ ...a([{ type: 'text', text: 'sub' }]), isSidechain: true }, st), [], 'subagents are not the conversation');
  readEntry({ type: 'user', origin: { kind: 'human' }, message: { content: 'next' } }, st);
  assert.deepEqual([st.turnTools, st.lastTool], [0, null], 'a new turn starts with nothing done');
});

test('transcripts: a title the person gave outranks the generated one', () => {
  const st = { tools: [] };
  readEntry({ type: 'ai-title', aiTitle: 'Generated' }, st);
  assert.equal(st.title, 'Generated');
  readEntry({ type: 'custom-title', customTitle: 'Mine' }, st);
  readEntry({ type: 'ai-title', aiTitle: 'Newer generated' }, st);
  assert.equal(st.title, 'Mine');
});

test('a turn\'s tools as one line', () => {
  const tools = [
    toolSummary({ name: 'Bash', input: { command: 'npm ci' } }),
    toolSummary({ name: 'Bash', input: { command: 'npm test' } }),
    toolSummary({ name: 'Bash', input: { command: 'git status' } }),
    toolSummary({ name: 'Read', input: { file_path: '/a/b.js' } }),
    toolSummary({ name: 'Read', input: { file_path: '/a/c.js' } }),
    toolSummary({ name: 'Edit', input: { file_path: '/a/b.js' } }),
    toolSummary({ name: 'mcp__linear__get_issue', input: {} }),
  ].filter(Boolean);
  assert.equal(toolsLine(tools), ':hammer_and_wrench: ran 3 commands, the last `git status` · read 2 files · edited `/a/b.js` · used get_issue (linear)');
  assert.equal(toolsLine(tools.slice(0, 2)), ':hammer_and_wrench: ran `npm ci`, `npm test`');
  assert.equal(toolSummary({ name: 'TodoWrite', input: {} }), null);
  assert.equal(toolsLine([]), '');
});

test('`;` commands, since Slack keeps `/` for its own', () => {
  assert.deepEqual(parseControl(';compact'), ['compact', '']);
  assert.deepEqual(parseControl('; model  opus'), ['model', 'opus']);
  assert.deepEqual(parseControl(';keys down enter'), ['keys', 'down enter']);
  assert.equal(parseControl('no; not this'), null);
  assert.equal(parseControl(';;'), null);
});

test('Markdown to Slack: emphasis, links, headings, lists, code and tables', () => {
  const out = toMrkdwn('# Done\n\nFixed **two** bugs in `a<b>.js` and *one* typo. [PR](https://x.co/a?b=1&c=2)\n\n- one\n  - two\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```js\nif (a < b && c) {}\n```\n~~old~~ snake_case_name 2*3*4');
  assert.equal(out, [
    '*Done*', '',
    'Fixed *two* bugs in `a&lt;b&gt;.js` and _one_ typo. <https://x.co/a?b=1&amp;c=2|PR>', '',
    '• one', '  • two', '',
    '```', '| a | b |', '| 1 | 2 |', '```', '',
    '```', 'if (a &lt; b &amp;&amp; c) {}', '```',
    '~old~ snake_case_name 2*3*4',
  ].join('\n'));
});

test('long text splits on breaks, and a code block cut in two stays code', () => {
  const parts = split(`${'a'.repeat(3000)}\n\n\`\`\`\n${'b\n'.repeat(400)}\`\`\`\nend`, 3500);
  assert.ok(parts.every((p) => p.length <= 3510));
  for (const p of parts) assert.equal((p.match(/^```/gm) ?? []).length % 2, 0, 'fences balanced in every part');
  assert.equal(parts.join('').replace(/```\n/g, '').replace(/\n```/g, '').replace(/\s/g, '').length,
    `${'a'.repeat(3000)}${'b'.repeat(400)}end`.length);
});

test('what was typed in Slack comes back as typed', () => {
  assert.equal(fromSlack('see <https://x.co/a?b=1&amp;c=2|x.co/a?b=1&amp;c=2> &lt;div&gt; 5 &gt; 3'), 'see https://x.co/a?b=1&c=2 <div> 5 > 3');
  assert.equal(fromSlack('<mailto:a@b.co|a@b.co> in <#C1|general> for <@U1> <!here>'), 'a@b.co in #general for @U1 @here');
  assert.equal(fromSlack('<https://plain.example>'), 'https://plain.example');
  assert.equal(escape('<&>'), '&lt;&amp;&gt;');
});
