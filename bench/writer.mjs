// One simulated Claude Code session: appends an API response every 250-750ms.
// Writes a session_context record at start, and - unless it is a background
// job - another the moment the harness signals a /login, as real sessions do.
import fs from 'node:fs'; import path from 'node:path';
const [,, projDir, sessionsDir, sessionId, name, bg, root] = process.argv;
const isBg = bg === '1';
const file = path.join(projDir, `${sessionId}.jsonl`);
const flag = path.join(root, 'switch.flag');
let account = 'alice@test.dev', n = 0, switched = false;
const iso = () => new Date().toISOString();
const write = (o) => fs.appendFileSync(file, JSON.stringify(o) + '\n');
const context = () => write({ type: 'attachment', timestamp: iso(), sessionId,
  attachment: { type: 'session_context', context: { userEmail: `The user's email address is ${account}. Use it only to identify the user.` } } });
context();
fs.writeFileSync(path.join(sessionsDir, `${process.pid}.json`), JSON.stringify({
  pid: process.pid, sessionId: isBg ? `host${sessionId.slice(4)}` : sessionId, cwd: '/tmp/load', name,
  kind: isBg ? 'bg' : 'interactive', status: 'busy', startedAt: Date.now(), updatedAt: Date.now(),
  ...(isBg ? { parkedJobId: sessionId.slice(0, 8) } : {}) }));
function tick() {
  if (!switched && fs.existsSync(flag)) {
    switched = true;
    if (!isBg) { account = 'bob@test.dev'; context(); }
  }
  const id = `msg_${sessionId}_${n++}`;
  write({ type: 'assistant', uuid: `u-${id}`, timestamp: iso(), sessionId, requestId: `req_${id}`, cwd: '/tmp/load',
    message: { id, model: 'claude-opus-5', content: [{ type: 'text' }],
      usage: { input_tokens: 0, output_tokens: 1000, cache_read_input_tokens: 0,
        cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 } } } });   // $0.025 per call
  fs.appendFileSync(path.join(root, 'calls.log'), `${Date.now()} ${account} ${sessionId}\n`);
  setTimeout(tick, 250 + Math.random() * 500);
}
tick();
