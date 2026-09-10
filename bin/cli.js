#!/usr/bin/env node
// node:sqlite is stable enough for local use but still emits an experimental
// warning on every start; silence just that one so the CLI output stays clean.
const _emit = process.emit;
process.emit = function (name, data, ...rest) {
  if (name === 'warning' && data?.name === 'ExperimentalWarning' && /SQLite/i.test(data.message ?? '')) return false;
  return _emit.call(process, name, data, ...rest);
};

const { runCli } = await import('../src/cli.js');
await runCli(process.argv.slice(2));
