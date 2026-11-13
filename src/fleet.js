import crypto from 'node:crypto';
import { machine } from './replica.js';
import { setPriority, runNext } from './machine.js';
import { previewCleanup, runCleanup } from './cleanup.js';

/**
 * Every synced machine's cores and disks, and the owner's priorities set on
 * any of them from any dashboard.
 *
 * Each tracker sends its live panels over the sync link (sync.js's `panel`
 * message). They are kept here in memory, never stored: they are only worth
 * anything while fresh, and a machine that stops sending goes stale. A
 * priority or "run next" for another machine goes over the same link to the
 * tracker running beside that machine's heavy, which applies it and answers.
 * The link is the owner's own (ssh, or the port's token), so whoever can send
 * on it is the owner.
 */

const STALE_MS = 30_000;
const panels = new Map();   // machine id -> { id, name, machine, storage, at }
const asked = new Map();    // request id -> { resolve, reject, timer }
let links = () => [];

/** Where the connections are: the running sync's links. */
export function useLinks(fn) { links = fn; }

const obj = (x) => (x && typeof x === 'object' && !Array.isArray(x) ? x : null);

/** A machine's panels arrived; the disks come only when they were measured again. */
export function onPanel(peer, msg) {
  if (msg?.v !== 1) return;
  const p = panels.get(peer.id) ?? { id: peer.id, machine: null, storage: null };
  p.name = String(peer.name ?? peer.id).slice(0, 80);
  p.at = Date.now();
  p.machine = obj(msg.machine);
  if ('storage' in msg) p.storage = obj(msg.storage);
  panels.set(peer.id, p);
}

/** This machine, then every machine that has sent its panels, for the dashboard to pick from. */
export function machines(now = Date.now()) {
  const me = machine();
  return [
    { id: me.id, name: me.name, self: true, online: true },
    ...[...panels.values()].sort((a, b) => a.name.localeCompare(b.name)).map((p) => ({
      id: p.id, name: p.name, self: false, online: now - p.at < STALE_MS, at: p.at, hasMachine: !!p.machine, hasStorage: !!p.storage,
    })),
  ];
}

/**
 * One panel ('machine' or 'storage') of the machine `on`, with the list to pick
 * from: this machine's from `local()`, another's as it last sent it.
 */
export function panelOf(kind, on, local, now = Date.now()) {
  const list = machines(now);
  if (!on || on === list[0].id) return { ...(local() ?? { unavailable: true }), machines: list, on: list[0].id };
  const p = panels.get(on);
  if (!p) return { gone: true, machines: list, on };
  const online = now - p.at < STALE_MS;
  return { ...(p[kind] ?? { unavailable: true }), machines: list, on, remote: { name: p.name, online, at: p.at } };
}

/**
 * Ask machine `id` to do `req` ({k: 'prio', project, tier}, {k: 'next', pid} or
 * {k: 'cleanup', cleanup, step}); resolves with what it answered once it has.
 * `id` is the request's own, so a request names nothing else by it.
 */
export function ask(id, req, ms = 25_000) {
  const link = links().find((l) => l.peer?.id === id && !l.closed);
  if (!link) return Promise.reject(new Error('that machine is not connected now'));
  const rid = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { asked.delete(rid); reject(new Error(`no answer from that machine in ${Math.round(ms / 1000)} s`)); }, ms);
    asked.set(rid, { resolve, reject, timer });
    link.send({ t: 'ctl', ...req, id: rid });
  });
}

/**
 * A `ctl` message this module answers; true when it was one. The peer's request
 * is done here, through this machine's heavy, and the panel goes back before
 * the answer, so the asking dashboard reads the change as soon as it hears.
 */
export async function onBoxControl(link, msg, changed = () => {}) {
  switch (msg?.k) {
    case 'prio':
    case 'next':
    case 'cleanup': {
      link.heardCtl = true;
      let reply;
      try {
        let result = null;
        if (msg.k === 'prio') setPriority(msg.project, msg.tier, `claude-tracker on ${String(link.peer?.name ?? 'another machine').slice(0, 60)}`);
        else if (msg.k === 'next') runNext(Number(msg.pid));
        else result = msg.step === 'run' ? runCleanup(String(msg.cleanup)) : await previewCleanup(String(msg.cleanup));
        reply = { ok: true, result };
        changed();
      } catch (err) { reply = { ok: false, error: err.message }; }
      await link.nudgePanel?.();
      link.send({ t: 'ctl', k: 'box-done', id: msg.id, ...reply });
      return true;
    }
    case 'box-done': {
      link.heardCtl = true;
      const a = asked.get(msg.id);
      if (a) {
        asked.delete(msg.id);
        clearTimeout(a.timer);
        if (msg.ok) a.resolve(msg.result ?? null); else a.reject(new Error(String(msg.error ?? 'it failed there').slice(0, 300)));
      }
      return true;
    }
    default:
      return false;
  }
}

/** For tests. */
export function resetFleet() { panels.clear(); }
