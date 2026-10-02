import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

/*
 * `pool add` and `pool link` against a scratch home laid out like a real one,
 * with a stand-in for `claude auth` that signs a profile into whoever $AS names.
 */
const CLI = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'bin', 'cli.js');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-pool-'));
test.after(() => fs.rmSync(home, { recursive: true, force: true }));

const main = path.join(home, '.claude');
const core = path.join(home, 'claude-core');
fs.mkdirSync(path.join(core, 'skills', 'verify'), { recursive: true });
fs.writeFileSync(path.join(core, 'CLAUDE.md'), '# rules');
fs.mkdirSync(path.join(main, 'projects', '-work-app', 'memory'), { recursive: true });
fs.writeFileSync(path.join(main, 'projects', '-work-app', 'memory', 'MEMORY.md'), '- remembered');
fs.mkdirSync(path.join(main, 'plugins'));
fs.writeFileSync(path.join(main, 'settings.json'), JSON.stringify({ hooks: { Stop: [] } }));
fs.symlinkSync(core, path.join(main, 'claude-core'));
fs.symlinkSync(path.join(core, 'CLAUDE.md'), path.join(main, 'CLAUDE.md'));
fs.symlinkSync(path.join(core, 'skills'), path.join(main, 'skills'));
fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({
  oauthAccount: { accountUuid: 'main', emailAddress: 'main@x.com' },
  mcpServers: { linear: { type: 'http', url: 'https://mcp.example/linear' } },
  projects: { '/work/app': { hasTrustDialogAccepted: true }, '/work/other': { hasTrustDialogAccepted: false } },
}));

const fakeAuth = path.join(home, 'claude');
fs.writeFileSync(fakeAuth, `#!/bin/sh
cfg="$CLAUDE_CONFIG_DIR/.claude.json"
case "$2" in
  login) printf '{"oauthAccount":{"accountUuid":"u-%s","emailAddress":"%s"}}' "$AS" "$AS" > "$cfg" ;;
  logout) printf '{}' > "$cfg" ;;
esac
`, { mode: 0o755 });

const cli = (as, ...args) => spawnSync(process.execPath, [CLI, ...args], {
  env: { ...process.env, HOME: home, CLAUDE_TRACKER_DIR: path.join(home, 'data'), CLAUDE_TRACKER_CLAUDE: fakeAuth, AS: as,
    CLAUDE_CONFIG_DIR: '', CLAUDE_TRACKER_EXTRA_DIRS: '', NO_COLOR: '1' },
  encoding: 'utf8', timeout: 60_000,
});
const target = (p) => fs.realpathSync(p);

test('a new pool profile shares the main setup, and keeps only its own sign-in', () => {
  const r = cli('two@x.com', 'pool', 'add', 'two@x.com', '--as', 'two');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /signed in as two@x\.com/);
  const two = path.join(home, '.claude-two');
  for (const f of ['settings.json', 'CLAUDE.md', 'claude-core', 'skills', 'plugins']) {
    assert.ok(fs.lstatSync(path.join(two, f)).isSymbolicLink(), `${f} is linked`);
    assert.equal(target(path.join(two, f)), target(path.join(main, f)), `${f} is the main profile's`);
  }
  // A change to the main settings shows in the pool profile.
  fs.writeFileSync(path.join(main, 'settings.json'), JSON.stringify({ hooks: { Stop: [] }, model: 'opus' }));
  assert.equal(JSON.parse(fs.readFileSync(path.join(two, 'settings.json'), 'utf8')).model, 'opus');
  const cfg = JSON.parse(fs.readFileSync(path.join(two, '.claude.json'), 'utf8'));
  assert.equal(cfg.oauthAccount.emailAddress, 'two@x.com', 'its own sign-in');
  assert.deepEqual(Object.keys(cfg.mcpServers), ['linear']);
  assert.deepEqual(Object.keys(cfg.projects), ['/work/app'], 'trusted folders, and only those');
  assert.equal(fs.readFileSync(path.join(two, 'projects', '-work-app', 'memory', 'MEMORY.md'), 'utf8'), '- remembered');
});

test('pool link shares the setup with a profile made by hand, keeping what it has of its own', () => {
  const own = path.join(home, '.claude-own');
  fs.mkdirSync(path.join(own, 'projects'), { recursive: true });
  fs.writeFileSync(path.join(own, 'settings.json'), '{"mine":true}');
  fs.writeFileSync(path.join(own, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: 'u-own', emailAddress: 'own@x.com' } }));
  let r = cli('', 'pool', 'link');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /kept its own settings\.json/);
  assert.equal(fs.readFileSync(path.join(own, 'settings.json'), 'utf8'), '{"mine":true}');
  assert.ok(fs.lstatSync(path.join(own, 'skills')).isSymbolicLink());
  r = cli('', 'pool', 'link', '--force');
  assert.equal(r.status, 0, r.stderr);
  assert.ok(fs.lstatSync(path.join(own, 'settings.json')).isSymbolicLink());
  assert.equal(fs.readFileSync(path.join(own, 'settings.json.pre-pool'), 'utf8'), '{"mine":true}', 'the old one is kept aside');
});
