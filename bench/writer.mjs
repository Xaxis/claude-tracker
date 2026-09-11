// One simulated Claude Code session: appends an API response every 250-750ms.
// Writes a session_context record at start. At the harness's /login only the
// session it was typed into records it; the rest just carry on under the new
// account, as real sessions do. A background job keeps its own account and
// keeps re-stating it.
import fs from 'node:fs'; import path from 'node:path';
const [,, projDir, sessionsDir, sessionId, name, bg, root, liveDir, resetBase] = process.argv;
const started = Date.now();
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
    if (!isBg) { account = 'bob@test.dev'; if (name === 'load-01') context(); }
  }
  if (isBg) context();
  const id = `msg_${sessionId}_${n++}`;
  write({ type: 'assistant', uuid: `u-${id}`, timestamp: iso(), sessionId, requestId: `req_${id}`, cwd: '/tmp/load',
    message: { id, model: 'claude-opus-5', content: [{ type: 'text' }],
      usage: { input_tokens: 0, output_tokens: 1000, cache_read_input_tokens: 0,
        cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 } } } });   // $0.025 per call
  fs.appendFileSync(path.join(root, 'calls.log'), `${Date.now()} ${account} ${sessionId} ${id}\n`);
  // Interactive sessions also render a status line, which hands the tracker the
  // server's exact utilization. Background jobs have no status line.
  if (liveDir && !isBg && n % 3 === 0) {
    const pct = Math.min(99, 5 + ((Date.now() - started) / 1000) * 1.2);
    const rec = { ts: Date.now(), session_id: sessionId, config_dir: path.dirname(path.dirname(projDir)),
      // Every session on one account reads that account's reset time.
      rate_limits: { five_hour: { used_percentage: pct,
        resets_at: (Number(resetBase) || Math.floor(started / 1000)) + (account === 'alice@test.dev' ? 4 * 3600 : 3 * 3600 + 600) } } };
    const tmp = path.join(liveDir, `.${sessionId}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(rec));
    fs.renameSync(tmp, path.join(liveDir, `${sessionId}.json`));
  }
  setTimeout(tick, 250 + Math.random() * 500);
}
tick();
