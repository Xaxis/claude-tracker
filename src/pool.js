import fs from 'node:fs';
import path from 'node:path';
import { discoverProfiles, configFileOf } from './paths.js';

/**
 * A pool profile is another account's way into the same Claude Code setup.
 *
 * Claude Code reads a user's settings, instructions, skills, agents, plugins
 * and project memories from whichever profile a session runs in - so a profile
 * made only to hold another sign-in would otherwise start bare, and a session
 * moved into it would lose its hooks, its MCP servers and what it remembered.
 * So a pool profile shares the main profile's: by link where a file or folder
 * can be shared whole, so a later change shows everywhere; by copy where it
 * lives in the config file beside the sign-in. It keeps only its own sign-in.
 */

const SHARED = ['settings.json', 'CLAUDE.md', 'claude-core', 'agents', 'commands', 'skills', 'output-styles', 'plugins', 'keybindings.json'];

export function mainProfile() {
  return discoverProfiles().find((p) => p.isDefault) ?? null;
}

const lstat = (p) => { try { return fs.lstatSync(p); } catch { return null; } };
const real = (p) => { try { return fs.realpathSync(p); } catch { return null; } };
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const same = (a, b) => real(a) != null && real(a) === real(b);

/**
 * Point `dir`'s memory for project `slug` at the main profile's, so a session
 * there remembers what it did as the main account, and the other way round.
 * `create` makes the main profile's memory folder when it has none yet - a
 * moved session's memories then land there from the start. A profile with a
 * memory of its own for that project keeps it.
 */
export function linkMemory(dir, slug, { create = false } = {}) {
  const main = mainProfile();
  if (!main || same(main.dir, dir)) return false;
  const shared = path.join(main.dir, 'projects', slug, 'memory');
  const here = path.join(dir, 'projects', slug, 'memory');
  if (lstat(here)) return false;
  if (!fs.existsSync(shared)) {
    if (!create) return false;
    fs.mkdirSync(shared, { recursive: true });
  }
  fs.mkdirSync(path.dirname(here), { recursive: true });
  fs.symlinkSync(shared, here);
  return true;
}

/**
 * Share the main profile's setup with the profile in `dir`. What the profile
 * already has of its own is left alone - and listed in `kept` - unless `force`,
 * which moves it aside as `<name>.pre-pool` first.
 */
export function shareSetup(dir, { force = false } = {}) {
  const out = { linked: [], kept: [], copied: [], memories: 0 };
  const main = mainProfile();
  if (!main || same(main.dir, dir)) return out;
  for (const f of SHARED) {
    const from = real(path.join(main.dir, f));
    if (!from) continue;
    const to = path.join(dir, f);
    const cur = lstat(to);
    if (cur) {
      if (cur.isSymbolicLink() && real(to) === from) continue;
      if (!force) { out.kept.push(f); continue; }
      fs.renameSync(to, `${to}.pre-pool`);
    }
    fs.symlinkSync(from, to);
    out.linked.push(f);
  }

  // MCP servers and folder trust live in the config file, beside the sign-in:
  // copied into it, never the other way.
  const mainCfg = readJson(configFileOf(main.dir) ?? '');
  const file = configFileOf(dir);
  const cfg = file && readJson(file);
  if (mainCfg && cfg) {
    let changed = false;
    cfg.mcpServers ??= {};
    for (const [name, server] of Object.entries(mainCfg.mcpServers ?? {})) {
      if (name in cfg.mcpServers && !force) continue;
      cfg.mcpServers[name] = server;
      out.copied.push(`MCP server ${name}`);
      changed = true;
    }
    let trusted = 0;
    cfg.projects ??= {};
    for (const [folder, p] of Object.entries(mainCfg.projects ?? {})) {
      if (!p?.hasTrustDialogAccepted || cfg.projects[folder]?.hasTrustDialogAccepted) continue;
      cfg.projects[folder] = { ...cfg.projects[folder], hasTrustDialogAccepted: true };
      trusted++;
      changed = true;
    }
    if (trusted) out.copied.push(`trust in ${trusted} folder${trusted === 1 ? '' : 's'}`);
    if (changed) {
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2));
      fs.renameSync(tmp, file);
    }
  }

  let slugs = [];
  try { slugs = fs.readdirSync(path.join(main.dir, 'projects')); } catch { /* no projects yet */ }
  for (const slug of slugs) if (linkMemory(dir, slug)) out.memories++;
  return out;
}
