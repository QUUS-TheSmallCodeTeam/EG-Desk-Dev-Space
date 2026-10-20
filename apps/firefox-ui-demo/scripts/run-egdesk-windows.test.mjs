import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalFirefoxPreferences, mergeNormalPreferences, normalChildEnvironment,
  assertPersistentProfile, requestedNormalProfile, safeDestination, profileIsRunning, assertHealthyBridge,
  validateBridgeReceipt, waitForHealthyBridge, ensureStorage } from './run-egdesk-windows.mjs';
import { isOwnedAndPrivate } from '../helper/egdesk-private-files.mjs';

test('new Windows persistent data is private at creation and existing private content is preserved',
  { skip: process.platform !== 'win32' }, () => {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'egdesk-normal-storage-test-')));
    const directory = path.join(root, 'app-data'), file = path.join(directory, 'preserved.txt');
    try {
      assert.equal(ensureStorage(directory), directory);
      assert.equal(isOwnedAndPrivate(directory, fs.lstatSync(directory), 0o077), true);
      fs.writeFileSync(file, 'keep existing user data');
      assert.equal(ensureStorage(directory), directory);
      assert.equal(fs.readFileSync(file, 'utf8'), 'keep existing user data');
    } finally {
      if (fs.existsSync(file)) fs.unlinkSync(file);
      if (fs.existsSync(directory)) fs.rmdirSync(directory);
      fs.rmdirSync(root);
    }
  });

test('normal preferences disable automation while preserving unrelated Desk and user preferences', () => {
  const preferences = normalFirefoxPreferences();
  for (const key of ['devtools.debugger.remote-enabled', 'marionette.enabled', 'devtools.chrome.enabled',
    'termsofuse.bypassNotification']) assert.equal(preferences.get(key), false);
  const original = 'user_pref("egdesk.deskSession.v1", "desk bytes");\nuser_pref("marionette.enabled", true);\n// custom comment\n';
  const merged = mergeNormalPreferences(original);
  assert.ok(merged.includes('user_pref("egdesk.deskSession.v1", "desk bytes");'));
  assert.ok(merged.includes('// custom comment'));
  assert.ok(!merged.includes('user_pref("marionette.enabled", true);'));
  assert.equal(merged, mergeNormalPreferences(merged));
});

test('normal child environment removes QA and remote-control settings without shell interpolation', () => {
  const env = normalChildEnvironment({ Path: 'installed node', USERPROFILE: 'normal user',
    MOZ_REMOTE_ALLOW_SYSTEM_ACCESS: '1', moz_marionette: '1', EGDESK_QA_REAL_TURN: '1',
    EGDESK_QA_FIXTURE_TOKEN: 'private sentinel', EGDESK_BROWSER_FIXTURE_QA_URL: 'http://qa',
    EGDESK_MARIONETTE_PORT: '2828', EGDESK_DATA_DIR: 'temporary fixture',
    EGDESK_CODEX_MODEL: 'qa override', egdesk_codex_disable_memories: '0' },
  { dataDir: 'persistent data', codex: 'installed native', root: 'repository' });
  for (const name of Object.keys(env)) assert.ok(!/^(MOZ_|EGDESK_QA_|EGDESK_BROWSER_FIXTURE_QA)/i.test(name));
  assert.equal(env.EGDESK_DATA_DIR, 'persistent data');
  assert.equal(env.EGDESK_CODEX_BIN, 'installed native');
  assert.equal(env.EGDESK_CODEX_DISABLE_MEMORIES, '1');
  assert.ok(!Object.hasOwn(env, 'egdesk_codex_disable_memories'));
  assert.equal(env.Path, 'installed node');
  assert.equal(env.USERPROFILE, 'normal user');
  assert.ok(!Object.values(env).includes('private sentinel'));
});

test('persistent profile guard requires the exact canonical dedicated profile', () => {
  const profile = path.resolve('dedicated', 'egdesk-windows-poc');
  const fileSystem = { lstatSync: () => ({ isDirectory: () => true, isSymbolicLink: () => false }),
    realpathSync: { native: target => target } };
  const options = { expected: profile, temporaryRoot: path.resolve('unrelated-temp'), fileSystem };
  assert.equal(assertPersistentProfile(profile, options), profile);
  assert.throws(() => assertPersistentProfile(path.resolve('personal-profile'), options), /Only/);
  assert.throws(() => assertPersistentProfile(profile, { ...options, temporaryRoot: path.dirname(profile) }), /persistent/);
  assert.throws(() => assertPersistentProfile(profile, { ...options,
    fileSystem: { ...fileSystem, realpathSync: { native: () => path.resolve('redirected') } } }), /canonical/);
  assert.throws(() => assertPersistentProfile(profile, { ...options,
    fileSystem: { ...fileSystem, lstatSync: () => ({ isDirectory: () => true, isSymbolicLink: () => true }) } }), /linked/);
});

test('launcher argument parsing preserves a spaced profile path and refuses alternate profiles or automation flags', () => {
  const expected = path.resolve("User's folder with spaces", 'egdesk-windows-poc');
  assert.equal(requestedNormalProfile([], expected), expected);
  assert.equal(requestedNormalProfile(['--profile', expected], expected), expected);
  for (const args of [['--profile'], ['--profile', path.resolve('personal')],
    ['--marionette'], ['--profile', expected, '--profile', expected]]) {
    assert.throws(() => requestedNormalProfile(args, expected), /exact dedicated/);
  }
});

test('stale parent.lock uses an injected exclusive probe rather than its presence', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'egdesk-normal-lock-test-'));
  try {
    fs.writeFileSync(path.join(root, 'parent.lock'), '');
    let observed;
    assert.equal(profileIsRunning(root, target => { observed = target; return 'unlocked'; }), false);
    assert.equal(observed, path.join(root, 'parent.lock'));
    assert.equal(profileIsRunning(root, () => 'locked'), true);
    assert.throws(() => profileIsRunning(root, () => 'unknown'), /could not be verified/);
    const linked = path.join(root, 'linked.js'), ordinary = path.join(root, 'ordinary.js');
    fs.writeFileSync(ordinary, 'owned fixture');
    fs.linkSync(ordinary, linked);
    assert.throws(() => safeDestination(linked, root), /Linked/);
    assert.throws(() => safeDestination(path.join(path.dirname(root), 'escape.js'), root), /escaped/);
  } finally {
    // Remove only the exact files created by this test, then its empty directory.
    for (const name of ['parent.lock', 'linked.js', 'ordinary.js']) {
      const target = path.join(root, name); if (fs.existsSync(target)) fs.unlinkSync(target);
    }
    fs.rmdirSync(root);
  }
});

function healthy() {
  const health = { ok: true, port: 39218, appServerReady: true, chatStorageReady: true,
    native: { schemaMatch: true, qaReadOnly: true, contractFingerprint: 'a'.repeat(64) },
    memoryIsolation: { status: 'verified-disabled' } };
  return { health, state: { provider: 'codex', protocolVersion: 1,
    appServerReady: true, chatStorageReady: true, native: health.native } };
}

test('bridge readiness rejects fixture, offline, unsafe memory and incompatible protocols', () => {
  const { health, state } = healthy();
  assert.equal(assertHealthyBridge(health, state), true);
  for (const bad of [{ ...health, fixture: true }, { ...health, appServerReady: false },
    { ...health, memoryIsolation: { status: 'not-requested' } },
    { ...health, native: { ...health.native, qaReadOnly: false } }]) {
    assert.throws(() => assertHealthyBridge(bad, state), /compatible/);
  }
  assert.throws(() => assertHealthyBridge(health, { ...state, provider: 'fixture' }), /compatible/);
});

test('reuse requires matching PID, process creation time, paths and actual bridge entry', () => {
  const root = path.resolve('repository'), dataDir = path.resolve('persistent-data');
  const node = path.resolve('Node 24', 'node.exe'), entry = path.join(root, 'helper', 'bridge.mjs');
  const receipt = { kind: 'egdesk-normal-windows-bridge-v1', pid: 42, startTime: 'exact-created-time',
    repoRoot: root, dataDir, node };
  const identity = { pid: 42, startTime: receipt.startTime, executable: node,
    commandLine: '"' + node + '" "' + entry + '"' };
  const expected = { root, dataDir, node, entry };
  assert.equal(validateBridgeReceipt(receipt, identity, expected), true);
  for (const bad of [{ ...identity, pid: 43 }, { ...identity, startTime: 'reused PID' },
    { ...identity, executable: path.resolve('other-node.exe') }, { ...identity, commandLine: 'unrelated process' }]) {
    assert.equal(validateBridgeReceipt(receipt, bad, expected), false);
  }
  assert.equal(validateBridgeReceipt({ ...receipt, dataDir: path.resolve('qa-data') }, identity, expected), false);
});

test('startup polling is bounded and can be tested without launching any process', async () => {
  let now = 0, calls = 0;
  const ready = healthy();
  assert.equal(await waitForHealthyBridge({ now: () => now, pause: async ms => { now += ms; },
    read: async () => { if (++calls < 3) throw new Error('starting'); return ready; }, timeoutMs: 1800 }), ready);
  now = 0;
  await assert.rejects(waitForHealthyBridge({ now: () => now, pause: async ms => { now += ms; },
    read: async () => { throw new Error('occupied incompatible server'); }, timeoutMs: 1000 }), /within 1000ms/);
  assert.equal(now, 1000);
});
