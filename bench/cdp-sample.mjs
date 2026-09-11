// Sample the live dashboard's DOM every 250ms and log what a viewer would see.
import fs from 'node:fs';
const [,, url, out, durMs, port] = process.argv;
const t = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((x) => x.type === 'page');
const ws = new WebSocket(t.webSocketDebuggerUrl);
let id = 0; const pend = new Map();
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id); } };
await new Promise((r) => (ws.onopen = r));
await send('Page.enable'); await send('Runtime.enable'); await send('Page.navigate', { url });
await new Promise((r) => setTimeout(r, 2500));
const expr = `JSON.stringify({
  cards: [...document.querySelectorAll('.account')].map((c) => ({ name: c.querySelector('.account-name')?.textContent, meta: c.querySelector('.account-meta')?.textContent })),
  live: [...document.querySelectorAll('#live-sessions .row')].map((r) => ({ title: r.querySelector('.row-title')?.textContent.trim(), sub: r.querySelector('.row-sub')?.textContent })) })`;
const end = Date.now() + Number(durMs);
while (Date.now() < end) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
  fs.appendFileSync(out, JSON.stringify({ t: Date.now(), ...JSON.parse(r.result.value) }) + '\n');
  await new Promise((r) => setTimeout(r, 250));
}
ws.close(); process.exit(0);
