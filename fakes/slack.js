import crypto from 'node:crypto';
import http from 'node:http';

/**
 * Slack, as far as the tracker uses it: the Web API methods it calls, and a
 * Socket Mode WebSocket that delivers events and wants each acknowledged.
 * Everything the tracker sends is kept, to be asserted on.
 */
export async function fakeSlack() {
  const calls = [];
  const messages = new Map();     // ts -> message as last posted or updated
  const sockets = new Set();
  const acks = new Set();
  let seq = 1;
  const files = new Map();

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (req.method === 'GET' && url.pathname.startsWith('/files/')) {
      const f = files.get(url.pathname.slice(7));
      if (!f || req.headers.authorization !== 'Bearer xoxb-test') return res.writeHead(404).end();
      return res.writeHead(200).end(f);
    }
    let body = '';
    req.on('data', (b) => { body += b; });
    req.on('end', () => {
      const method = url.pathname.replace(/^\/api\//, '');
      const args = Object.fromEntries(new URLSearchParams(body));
      for (const k of ['blocks']) if (args[k]) args[k] = JSON.parse(args[k]);
      const token = String(req.headers.authorization ?? '').replace(/^Bearer /, '');
      calls.push({ method, args, token, at: Date.now() });
      const ok = (o = {}) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, ...o })); };
      const fail = (error) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false, error })); };
      if (method === 'apps.connections.open') {
        if (token !== 'xapp-test') return fail('invalid_auth');
        return ok({ url: `ws://127.0.0.1:${server.address().port}/socket` });
      }
      if (token !== 'xoxb-test') return fail('invalid_auth');
      switch (method) {
        case 'auth.test': return ok({ team_id: 'T1', team: 'Test', user_id: 'UBOT', user: 'claude', bot_id: 'B1', url: 'https://test.slack.com/' });
        case 'bots.info': return ok({ bot: { name: 'Claude Sessions' } });
        case 'conversations.info': return ok({ channel: { id: args.channel, name: 'claude' } });
        case 'chat.postMessage': {
          const ts = `1700000000.${String(seq++).padStart(6, '0')}`;
          args.ts = ts;
          const m = { ...args };
          messages.set(ts, m);
          return ok({ channel: args.channel, ts, message: m });
        }
        case 'chat.update': {
          const m = messages.get(args.ts);
          if (!m) return fail('message_not_found');
          messages.set(args.ts, { ...m, ...args, updated: (m.updated ?? 0) + 1 });
          return ok({ channel: args.channel, ts: args.ts });
        }
        case 'reactions.add': return ok();
        case 'chat.delete': {
          if (!messages.has(args.ts)) return fail('message_not_found');
          messages.delete(args.ts);
          return ok({ channel: args.channel, ts: args.ts });
        }
        case 'chat.postEphemeral': return ok({ message_ts: `1700000000.${String(seq++).padStart(6, '0')}` });
        case 'conversations.history': {
          const top = [...messages.values()].filter((m) => m.channel === args.channel && !m.thread_ts).sort((a, b) => Number(b.ts) - Number(a.ts));
          return ok({ messages: top.slice(0, Number(args.limit ?? 100)) });
        }
        default: return fail('unknown_method');
      }
    });
  });

  server.on('upgrade', (req, socket) => {
    const accept = crypto.createHash('sha1').update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => sockets.delete(socket));
    let buf = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        if (buf.length < 2) return;
        const op = buf[0] & 0x0f;
        let len = buf[1] & 0x7f, off = 2;
        if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
        else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
        const masked = buf[1] & 0x80;
        if (buf.length < off + (masked ? 4 : 0) + len) return;
        const mask = masked ? buf.subarray(off, off + 4) : null;
        off += masked ? 4 : 0;
        const data = Buffer.from(buf.subarray(off, off + len));
        if (mask) for (let i = 0; i < data.length; i++) data[i] ^= mask[i % 4];
        buf = buf.subarray(off + len);
        if (op === 8) { socket.end(); return; }
        if (op === 1) { try { const m = JSON.parse(data.toString('utf8')); if (m.envelope_id) acks.add(m.envelope_id); } catch { /* not ours */ } }
      }
    });
    send(socket, { type: 'hello', num_connections: 1 });
  });

  function send(socket, obj) {
    const p = Buffer.from(JSON.stringify(obj));
    const head = p.length < 126 ? Buffer.from([0x81, p.length])
      : p.length < 65536 ? Buffer.from([0x81, 126, p.length >> 8, p.length & 255])
        : (() => { const h = Buffer.alloc(10); h[0] = 0x81; h[1] = 127; h.writeBigUInt64BE(BigInt(p.length), 2); return h; })();
    socket.write(Buffer.concat([head, p]));
  }

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  return {
    api: `http://127.0.0.1:${port}/api/`,
    calls, messages, acks,
    get connected() { return sockets.size; },
    file(id, data) { files.set(id, Buffer.from(data)); return `http://127.0.0.1:${port}/files/${id}`; },
    /** Deliver an envelope down every open socket; resolves to its id. */
    push(type, payload) {
      const envelope_id = crypto.randomUUID();
      for (const s of sockets) send(s, { envelope_id, type, payload, accepts_response_payload: false });
      return envelope_id;
    },
    message(event) {
      return this.push('events_api', { event_id: `Ev${crypto.randomUUID()}`, event: { type: 'message', ts: `1800000000.${String(seq++).padStart(6, '0')}`, ...event } });
    },
    /** The channel as it stands, newest last: what is there now, not everything ever posted. */
    top: (channel) => [...messages.values()].filter((m) => m.channel === channel && !m.thread_ts).sort((a, b) => Number(a.ts) - Number(b.ts)),
    posts: (channel = null) => calls.filter((c) => c.method === 'chat.postMessage' && (!channel || c.args.channel === channel)).map((c) => c.args),
    close() { for (const s of sockets) s.destroy(); server.close(); },
  };
}
