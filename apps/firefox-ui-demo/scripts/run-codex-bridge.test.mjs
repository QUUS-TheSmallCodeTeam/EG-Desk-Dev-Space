import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PINNED_NODE_VERSION, pinnedNodeExecutable } from '../helper/egdesk-node-runtime.mjs';

function fixture(t, executable = null) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'egdesk-bridge-runtime-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.mkdirSync(path.join(root, 'helper'));
  fs.copyFileSync(fileURLToPath(new URL('./run-codex-bridge.sh', import.meta.url)), path.join(root, 'scripts', 'run-codex-bridge.sh'));
  fs.copyFileSync(fileURLToPath(new URL('../helper/egdesk-sqlite-runtime.mjs', import.meta.url)), path.join(root, 'helper', 'egdesk-sqlite-runtime.mjs'));
  fs.writeFileSync(path.join(root, '.node-version'), PINNED_NODE_VERSION + '\n');
  fs.writeFileSync(path.join(root, 'helper', 'codex-bridge-server.mjs'),
    'process.stdout.write("FIXTURE_BRIDGE " + process.versions.node + " " + process.versions.sqlite + "\\n");\n');
  if (executable) {
    const target = pinnedNodeExecutable({ appRoot: root });
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.symlinkSync(executable, target);
  }
  return path.join(root, 'scripts', 'run-codex-bridge.sh');
}

test('bridge refuses to use PATH Node when the pinned runtime is missing', { skip: process.platform === 'win32' }, t => {
  const result = spawnSync('bash', [fixture(t)], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /pinned Node missing/);
  assert.doesNotMatch(result.stdout, /FIXTURE_BRIDGE/);
});

test('bridge fixture starts with the pinned patched runtime', {
  skip: process.platform === 'win32' || process.versions.node !== PINNED_NODE_VERSION,
}, t => {
  const result = spawnSync('bash', [fixture(t, process.execPath)], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`FIXTURE_BRIDGE ${PINNED_NODE_VERSION.replaceAll('.', '\\.')} ${process.versions.sqlite.replaceAll('.', '\\.')}`));
});

test('vulnerable Node is rejected before starting the bridge fixture', {
  skip: process.platform === 'win32' || !process.env.EGDESK_TEST_UNPATCHED_NODE,
}, t => {
  const result = spawnSync('bash', [fixture(t, process.env.EGDESK_TEST_UNPATCHED_NODE)], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /SQLite 3\.50\.4/);
  assert.doesNotMatch(result.stdout, /FIXTURE_BRIDGE/);
});
