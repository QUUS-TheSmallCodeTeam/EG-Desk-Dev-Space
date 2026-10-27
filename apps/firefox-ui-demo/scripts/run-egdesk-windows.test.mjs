import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalFirefoxPreferences, mergeNormalPreferences, normalChildEnvironment,
  assertPersistentProfile, requestedNormalProfile, safeDestination, profileIsRunning, assertHealthyBridge, readBridge,
  validateBridgeReceipt, waitForHealthyBridge, ensureStorage, superviseBridge, superviseWindowsBridge,
  SUPERVISE_BRIDGE_FLAG, BRIDGE_BUILD_MARKER, synchronizeProfile, writeExpectedBridgeBuild,
  shouldRelaunchWithPinnedNode } from './run-egdesk-windows.mjs';
import { isOwnedAndPrivate } from '../helper/egdesk-private-files.mjs';
import { computeBridgeBuildHash } from '../helper/egdesk-bridge-build.mjs';
import { prepareOntologyProfileBinding, ontologyStoragePaths } from '../helper/egdesk-ontology-http.mjs';
import { PINNED_NODE_VERSION } from '../helper/egdesk-node-runtime.mjs';

test('Windows launcher selects the pinned runtime even if another Node is on PATH', () => {
  assert.equal(shouldRelaunchWithPinnedNode('C:/Node/node.exe', 'C:/EG Desk/.tmp/node.exe'), true);
  assert.equal(shouldRelaunchWithPinnedNode('C:/EG Desk/.tmp/node.exe', 'c:/eg desk/.tmp/NODE.EXE'), false);
});

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
  const profile = path.resolve('validated profile');
  const env = normalChildEnvironment({ Path: 'installed node', USERPROFILE: 'normal user',
    MOZ_REMOTE_ALLOW_SYSTEM_ACCESS: '1', moz_marionette: '1', EGDESK_QA_REAL_TURN: '1',
    EGDESK_QA_FIXTURE_TOKEN: 'private sentinel', EGDESK_BROWSER_FIXTURE_QA_URL: 'http://qa',
    EGDESK_MARIONETTE_PORT: '2828', EGDESK_DATA_DIR: 'temporary fixture', egdesk_firefox_profile: 'untrusted',
    EGDESK_ONTOLOGY_PROFILE_PATH: 'untrusted obsolete override',
    EGDESK_CODEX_MODEL: 'qa override', egdesk_codex_disable_memories: '0' },
  { dataDir: 'persistent data', codex: 'installed native', root: 'repository', profile });
  for (const name of Object.keys(env)) assert.ok(!/^(MOZ_|EGDESK_QA_|EGDESK_BROWSER_FIXTURE_QA)/i.test(name));
  assert.equal(env.EGDESK_DATA_DIR, 'persistent data');
  assert.equal(env.EGDESK_CODEX_BIN, 'installed native');
  assert.equal(env.EGDESK_CODEX_DISABLE_MEMORIES, '1');
  assert.equal(env.EGDESK_FIREFOX_PROFILE, profile);
  assert.ok(!Object.hasOwn(env, 'egdesk_firefox_profile'));
  assert.ok(!Object.hasOwn(env, 'EGDESK_ONTOLOGY_PROFILE_PATH'));
  assert.throws(() => normalChildEnvironment({}, { dataDir: 'x', codex: 'x', root: 'x', profile: 'relative' }), /validated absolute/);
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

const TEST_ONTOLOGY_PROFILE_ID = 'b'.repeat(64);
const TEST_ONTOLOGY_TOKEN = 'c'.repeat(64);
const TEST_BUILD_HASH = 'd'.repeat(64);
const TEST_BINDING = { profileId: TEST_ONTOLOGY_PROFILE_ID, token: TEST_ONTOLOGY_TOKEN };
const TEST_SQLITE = { nodeVersion: PINNED_NODE_VERSION, sqliteVersion: '3.53.4', patched: true, supported: true, error: null };

function healthy() {
  const health = { ok: true, port: 39218, appServerReady: true, chatStorageReady: true,
    native: { schemaMatch: true, qaReadOnly: true, contractFingerprint: 'a'.repeat(64) },
    memoryIsolation: { status: 'verified-disabled' },
    node: { version: PINNED_NODE_VERSION, sqliteVersion: TEST_SQLITE.sqliteVersion, sqliteBuiltin: true },
    ontology: { ready: true, profileId: TEST_ONTOLOGY_PROFILE_ID, sqlite: TEST_SQLITE } };
  return { health, state: { provider: 'codex', protocolVersion: 1,
    appServerReady: true, chatStorageReady: true, native: health.native, bridge: { buildHash: TEST_BUILD_HASH } },
    ontologyAuthenticated: true, ontologyReady: true };
}

test('bridge readiness rejects fixture, offline, unsafe memory and incompatible protocols', () => {
  const { health, state } = healthy();
  assert.equal(assertHealthyBridge(health, state, TEST_ONTOLOGY_PROFILE_ID, TEST_BUILD_HASH), true);
  for (const bad of [{ ...health, fixture: true }, { ...health, appServerReady: false },
    { ...health, memoryIsolation: { status: 'not-requested' } },
    { ...health, native: { ...health.native, qaReadOnly: false } }]) {
    assert.throws(() => assertHealthyBridge(bad, state, TEST_ONTOLOGY_PROFILE_ID, TEST_BUILD_HASH), /compatible/);
  }
  assert.throws(() => assertHealthyBridge(health, { ...state, provider: 'fixture' }, TEST_ONTOLOGY_PROFILE_ID, TEST_BUILD_HASH), /compatible/);
});

test('ontology unavailability is allowed only for the exact bound profile and safe runtime', () => {
  const { health, state } = healthy();
  assert.equal(assertHealthyBridge({ ...health, ontology: { ...health.ontology, ready: false } },
    state, TEST_ONTOLOGY_PROFILE_ID, TEST_BUILD_HASH), true);
  for (const ontology of [undefined, { ...health.ontology, profileId: 'e'.repeat(64) },
    { ...health.ontology, profileId: null }, { ...health.ontology, ready: null }]) {
    assert.throws(() => assertHealthyBridge({ ...health, ontology }, state, TEST_ONTOLOGY_PROFILE_ID, TEST_BUILD_HASH), /ontology bound/);
  }
  assert.throws(() => assertHealthyBridge(health, state, TEST_ONTOLOGY_PROFILE_ID, 'e'.repeat(64)), /bridge build/);
  assert.throws(() => assertHealthyBridge(health, { ...state, bridge: null }, TEST_ONTOLOGY_PROFILE_ID, TEST_BUILD_HASH), /bridge build/);
  assert.throws(() => assertHealthyBridge(health, { ...state, bridge: { ...state.bridge, sourceMismatch: true } },
    TEST_ONTOLOGY_PROFILE_ID, TEST_BUILD_HASH), /bridge build/);
  for (const sqlite of [{ ...TEST_SQLITE, sqliteVersion: '3.50.4' }, { ...TEST_SQLITE, supported: false },
    { ...TEST_SQLITE, patched: false }, { ...TEST_SQLITE, error: 'probe failed' }, null]) {
    assert.throws(() => assertHealthyBridge({ ...health, ontology: { ...health.ontology, sqlite } },
      state, TEST_ONTOLOGY_PROFILE_ID, TEST_BUILD_HASH), /Node\/SQLite/);
  }
  for (const node of [{ ...health.node, version: '24.11.1' }, { ...health.node, sqliteBuiltin: false },
    { ...health.node, sqliteVersion: '3.50.4' }, null]) {
    assert.throws(() => assertHealthyBridge({ ...health, node }, state, TEST_ONTOLOGY_PROFILE_ID, TEST_BUILD_HASH), /Node\/SQLite/);
  }
});

function mockBridgeFetch({ health = healthy().health, state = healthy().state,
  ontology = { profileId: TEST_ONTOLOGY_PROFILE_ID, ready: true, sqlite: TEST_SQLITE }, status = 200 } = {}) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    const route = new URL(url).pathname;
    calls.push({ route, options });
    const code = route === '/ontology/health' ? status : 200;
    const body = route === '/health' ? health : route === '/v1/state' ? state : ontology;
    return { status: code, ok: code >= 200 && code < 300, text: async () => JSON.stringify(body) };
  };
  return { calls, fetchImpl };
}

test('authenticated ontology probe allows temporary store failure without exposing the token elsewhere', async () => {
  const health = { ...healthy().health, ontology: { ...healthy().health.ontology, ready: false } };
  for (const options of [
    { health, ontology: { profileId: TEST_ONTOLOGY_PROFILE_ID, ready: false, sqlite: TEST_SQLITE } },
    { health, status: 503, ontology: { code: 'ONTOLOGY_STORE_UNAVAILABLE' } },
  ]) {
    const mock = mockBridgeFetch(options);
    const result = await readBridge({ expectedOntologyProfileId: TEST_ONTOLOGY_PROFILE_ID,
      ontologyToken: TEST_ONTOLOGY_TOKEN, expectedBuildHash: TEST_BUILD_HASH }, { fetchImpl: mock.fetchImpl });
    assert.equal(result.ontologyAuthenticated, true);
    assert.equal(result.ontologyReady, false);
    const authenticated = mock.calls.find(call => call.route === '/ontology/health');
    assert.equal(authenticated.options.headers['x-egdesk-ontology-token'], TEST_ONTOLOGY_TOKEN);
    for (const call of mock.calls.filter(item => item.route !== '/ontology/health')) {
      assert.ok(!Object.values(call.options.headers).includes(TEST_ONTOLOGY_TOKEN));
    }
  }
});

test('a receipt-verified bridge can launch with a temporarily unavailable ontology store', async () => {
  const health = { ...healthy().health, ontology: { ...healthy().health.ontology, ready: false } };
  const mock = mockBridgeFetch({ health, ontology: { profileId: TEST_ONTOLOGY_PROFILE_ID, ready: false, sqlite: TEST_SQLITE } });
  let ownerChecks = 0;
  const result = await waitForHealthyBridge({ binding: TEST_BINDING, expectedBuildHash: TEST_BUILD_HASH,
    verifyOwner: () => { ownerChecks++; return true; }, read: request => readBridge(request, { fetchImpl: mock.fetchImpl }) });
  assert.equal(ownerChecks, 1);
  assert.equal(result.ontologyAuthenticated, true);
  assert.equal(result.ontologyReady, false);
});

test('wrong token, wrong profile and untrusted health probes refuse bridge reuse', async () => {
  for (const options of [
    { status: 403, ontology: { code: 'ONTOLOGY_TOKEN_REQUIRED' } },
    { health: { ...healthy().health, ontology: { ...healthy().health.ontology, ready: false } },
      status: 403, ontology: { code: 'ONTOLOGY_TOKEN_REQUIRED' } },
    { status: 409, ontology: { code: 'ONTOLOGY_PROFILE_MISMATCH' } },
    { status: 503, ontology: { code: 'ONTOLOGY_PROFILE_UNAVAILABLE' } },
    { ontology: { profileId: 'e'.repeat(64), ready: false, sqlite: TEST_SQLITE } },
    { ontology: { profileId: TEST_ONTOLOGY_PROFILE_ID, ready: false, sqlite: { ...TEST_SQLITE, sqliteVersion: '3.50.4' } } },
  ]) {
    const mock = mockBridgeFetch(options);
    await assert.rejects(readBridge({ expectedOntologyProfileId: TEST_ONTOLOGY_PROFILE_ID,
      ontologyToken: TEST_ONTOLOGY_TOKEN, expectedBuildHash: TEST_BUILD_HASH }, { fetchImpl: mock.fetchImpl }),
    error => !error.message.includes(TEST_ONTOLOGY_TOKEN));
  }
  for (const options of [
    { state: { ...healthy().state, bridge: { buildHash: 'e'.repeat(64) } } },
    { health: { ...healthy().health, ontology: { ...healthy().health.ontology,
      sqlite: { ...TEST_SQLITE, sqliteVersion: '3.50.4' } } } },
  ]) {
    const mock = mockBridgeFetch(options);
    await assert.rejects(readBridge({ expectedOntologyProfileId: TEST_ONTOLOGY_PROFILE_ID,
      ontologyToken: TEST_ONTOLOGY_TOKEN, expectedBuildHash: TEST_BUILD_HASH }, { fetchImpl: mock.fetchImpl }));
    assert.ok(!mock.calls.some(call => call.route === '/ontology/health'));
  }
});

test('reuse requires matching PID, process creation time, paths and actual bridge entry', () => {
  const root = path.resolve('repository'), dataDir = path.resolve('persistent-data');
  const profile = path.resolve('dedicated', 'egdesk-windows-poc');
  const node = path.resolve('Node 24', 'node.exe'), entry = path.join(root, 'helper', 'bridge.mjs');
  const receipt = { kind: 'egdesk-normal-windows-bridge-v2', pid: 42, startTime: 'exact-created-time',
    repoRoot: root, dataDir, node, firefoxProfile: profile };
  const identity = { pid: 42, startTime: receipt.startTime, executable: node,
    commandLine: '"' + node + '" "' + entry + '"' };
  const expected = { root, dataDir, node, entry, profile };
  assert.equal(validateBridgeReceipt(receipt, identity, expected), true);
  for (const bad of [{ ...identity, pid: 43 }, { ...identity, startTime: 'reused PID' },
    { ...identity, executable: path.resolve('other-node.exe') }, { ...identity, commandLine: 'unrelated process' }]) {
    assert.equal(validateBridgeReceipt(receipt, bad, expected), false);
  }
  assert.equal(validateBridgeReceipt({ ...receipt, dataDir: path.resolve('qa-data') }, identity, expected), false);
  assert.equal(validateBridgeReceipt({ ...receipt, firefoxProfile: path.resolve('other-profile') }, identity, expected), false);
  assert.equal(validateBridgeReceipt({ ...receipt, kind: 'egdesk-normal-windows-bridge-v1' }, identity, expected), false);
});

test('startup polling is bounded and can be tested without launching any process', async () => {
  let now = 0, calls = 0;
  const ready = healthy();
  const options = { binding: TEST_BINDING, expectedBuildHash: TEST_BUILD_HASH, verifyOwner: () => true };
  assert.equal(await waitForHealthyBridge({ ...options, now: () => now, pause: async ms => { now += ms; },
    read: async () => { if (++calls < 3) throw new Error('starting'); return ready; }, timeoutMs: 1800 }), ready);
  now = 0;
  await assert.rejects(waitForHealthyBridge({ ...options, now: () => now, pause: async ms => { now += ms; },
    read: async () => { throw new Error('occupied incompatible server'); }, timeoutMs: 1000 }), /within 1000ms/);
  assert.equal(now, 1000);
  await assert.rejects(waitForHealthyBridge({ read: async () => ready }), /profile binding is required/);
  await assert.rejects(waitForHealthyBridge({ ...options, binding: { ...TEST_BINDING, profileId: 'e'.repeat(64) },
    read: async () => ready, timeoutMs: 0 }), /ontology bound/);
  const unavailable = { ...ready, health: { ...ready.health, ontology: { ...ready.health.ontology, ready: false } }, ontologyReady: false };
  assert.equal(await waitForHealthyBridge({ ...options, read: async () => unavailable }), unavailable);
  await assert.rejects(waitForHealthyBridge({ ...options,
    read: async () => ({ ...ready, ontologyAuthenticated: false }), timeoutMs: 0 }), /authentication was not verified/);
  let readCalled = false;
  await assert.rejects(waitForHealthyBridge({ ...options, verifyOwner: () => { throw new Error('unowned'); },
    read: async () => { readCalled = true; return ready; }, timeoutMs: 0 }), /unowned/);
  assert.equal(readCalled, false);
  await assert.rejects(waitForHealthyBridge({ ...options, verifyOwner: () => false,
    read: async () => { readCalled = true; return ready; }, timeoutMs: 0 }), /owner verification failed/);
  assert.equal(readCalled, false);
});

function fakeBridgeRuns(codes, { runMs = 10 } = {}) {
  const clock = { now: 0 }, waits = [], starts = [];
  const start = async () => {
    starts.push(clock.now);
    const code = codes[Math.min(starts.length - 1, codes.length - 1)];
    clock.now += typeof runMs === 'function' ? runMs(starts.length) : runMs;
    if (code instanceof Error) throw code;
    return code;
  };
  return { clock, waits, starts, options: { start, now: () => clock.now, delay: failures => failures * 100,
    pause: async ms => { waits.push(ms); clock.now += ms; } } };
}

test('bridge supervisor restarts unexpected exits with growing waits and ends on the bridge\'s clean exit', async () => {
  const run = fakeBridgeRuns([1, null, new Error('spawn failed'), 0]);
  assert.deepEqual(await superviseBridge(run.options).done, { status: 'exited', code: 0, failures: 3 });
  assert.equal(run.starts.length, 4);
  assert.deepEqual(run.waits, [100, 200, 300]);
});

test('bridge supervisor stops after maxRestarts failures in a row, and a stable run clears the count', async () => {
  const failing = fakeBridgeRuns([1]);
  assert.deepEqual(await superviseBridge({ ...failing.options, maxRestarts: 2 }).done, { status: 'gave-up', code: 1, failures: 3 });
  assert.equal(failing.starts.length, 3);
  const stable = fakeBridgeRuns([1, 1, 1, 1, 0], { runMs: attempt => (attempt === 3 ? 61000 : 10) });
  const result = await superviseBridge({ ...stable.options, maxRestarts: 2, stableMs: 60000 }).done;
  assert.deepEqual(result, { status: 'exited', code: 0, failures: 2 });
  assert.deepEqual(stable.waits, [100, 200, 100, 200]);
});

test('stopping the supervisor ends the loop at once and never signals the running bridge', async () => {
  let release, starts = 0;
  const waiting = superviseBridge({ start: async () => { starts += 1; return 1; },
    pause: () => new Promise(resolve => { release = resolve; }), delay: () => 30000 });
  await new Promise(resolve => setImmediate(resolve));
  waiting.stop();
  assert.deepEqual(await waiting.done, { status: 'stopped', code: 1, failures: 1 });
  assert.equal(starts, 1);
  release();
  let exit;
  const running = superviseBridge({ start: () => new Promise(resolve => { exit = resolve; }) });
  await new Promise(resolve => setImmediate(resolve));
  running.stop();
  exit(1);
  assert.deepEqual(await running.done, { status: 'stopped', code: 1, failures: 0 });
});

test('the Windows launcher starts the bridge through its supervisor, which refuses to run elsewhere', async () => {
  const source = fs.readFileSync(new URL('./run-egdesk-windows.mjs', import.meta.url), 'utf8');
  assert.equal(SUPERVISE_BRIDGE_FLAG, '--supervise-bridge');
  assert.match(source, /detached\(process\.execPath, \[fileURLToPath\(import\.meta\.url\), SUPERVISE_BRIDGE_FLAG\], env, root, output\)/);
  assert.doesNotMatch(source, /detached\(process\.execPath, \[bridgeEntry\]/);
  assert.match(source, /spawn\(process\.execPath, \[bridgeEntry\], \{ env: process\.env, cwd: root, detached: true,/);
  assert.match(source, /const profile = assertPersistentProfile\(requestedNormalProfile\(args\)\)/);
  assert.match(source, /normalChildEnvironment\(process\.env, \{ dataDir, codex, root, profile \}\)/);
  assert.match(source, /process\.env\.EGDESK_FIREFOX_PROFILE !== profile/);
  assert.match(source, /readOntologyProfileBinding\(profile\)/);
  const launch = source.slice(source.indexOf('export async function launchNormalWindows('));
  const prepare = launch.indexOf('prepareOntologyProfileBinding({ profilePath: profile, dataDir })');
  assert.ok(prepare > launch.indexOf('assertPersistentProfile(requestedNormalProfile(args))'));
  assert.ok(prepare < launch.indexOf('detached(process.execPath, [fileURLToPath(import.meta.url), SUPERVISE_BRIDGE_FLAG]'));
  assert.ok(prepare < launch.indexOf('synchronizeProfile(profile'));
  assert.equal([...launch.matchAll(/waitForHealthyBridge\(\{ binding: ontologyBinding, expectedBuildHash, verifyOwner \}\)/g)].length, 2);
  assert.doesNotMatch(source, /\.kill\(|process\.kill|taskkill/i);
  if (process.platform !== 'win32') await assert.rejects(superviseWindowsBridge(), /only under the Windows launcher/);
});

function profileFixture() {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'egdesk-normal-sync-test-')));
  const profile = path.join(root, 'egdesk-windows-poc'), overlay = path.join(root, 'overlay'), outside = path.join(root, 'outside');
  for (const dir of [path.join(profile, 'chrome'), path.join(overlay, 'JS'), path.join(overlay, 'CSS'), path.join(overlay, 'resources'), outside]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(overlay, 'JS', 'eg-desk-surface.uc.js'), '// overlay fixture');
  fs.writeFileSync(path.join(overlay, 'CSS', 'eg-desk-surface.uc.css'), '/* overlay fixture */');
  fs.writeFileSync(path.join(overlay, 'resources', 'EGDeskChatState.sys.mjs'), 'export {}');
  const marker = path.join(profile, 'chrome', 'resources', BRIDGE_BUILD_MARKER);
  return { root, profile, overlay, outside, marker, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('ontology binding captures the existing graph before overlay synchronization and preserves it on retry', {
  skip: process.platform === 'win32',
}, () => {
  const fixture = profileFixture();
  try {
    fs.writeFileSync(path.join(fixture.profile, '.egdesk-dedicated-firefox-profile'),
      'EGDESK_DEDICATED_FIREFOX_PROFILE_V1\n', { mode: 0o600 });
    const profileOntology = path.join(fixture.profile, 'chrome', 'resources', 'ontology');
    const overlayOntology = path.join(fixture.overlay, 'resources', 'ontology');
    fs.mkdirSync(profileOntology, { recursive: true });
    fs.mkdirSync(overlayOntology, { recursive: true });
    const oldGraph = Buffer.from('{"nodes":[{"id":"original"}],"edges":[]}\n');
    const bundledGraph = Buffer.from('{"nodes":[{"id":"bundled"}],"edges":[]}\n');
    fs.writeFileSync(path.join(profileOntology, 'graph.json'), oldGraph, { mode: 0o600 });
    fs.writeFileSync(path.join(overlayOntology, 'graph.json'), bundledGraph, { mode: 0o600 });
    const dataDir = path.join(fixture.root, 'data');
    const binding = prepareOntologyProfileBinding({ profilePath: fixture.profile, dataDir });
    const { baselinePath } = ontologyStoragePaths({ dataDir, profileId: binding.profileId });
    assert.deepEqual(fs.readFileSync(baselinePath), oldGraph);
    assert.equal(synchronizeProfile(fixture.profile, { locked: () => false, overlay: fixture.overlay,
      buildHash: () => 'a'.repeat(64) }), true);
    assert.deepEqual(fs.readFileSync(path.join(profileOntology, 'graph.json')), bundledGraph);
    const retry = prepareOntologyProfileBinding({ profilePath: fixture.profile, dataDir });
    assert.equal(retry.profileId, binding.profileId);
    assert.equal(retry.token, binding.token);
    assert.deepEqual(fs.readFileSync(baselinePath), oldGraph);
  } finally { fixture.cleanup(); }
});

test('profile sync writes the expected bridge build beside the overlay resources, as egdesk-bridge-build.mjs prints it', () => {
  const fixture = profileFixture();
  try {
    const warnings = [];
    assert.equal(BRIDGE_BUILD_MARKER, 'egdesk-bridge-build.json');
    assert.equal(synchronizeProfile(fixture.profile, { locked: () => false, overlay: fixture.overlay,
      buildHash: () => 'a'.repeat(64), warn: message => warnings.push(message) }), true);
    assert.deepEqual(JSON.parse(fs.readFileSync(fixture.marker, 'utf8')), { buildHash: 'a'.repeat(64) });
    assert.ok(fs.existsSync(path.join(fixture.profile, 'chrome', 'resources', 'EGDeskChatState.sys.mjs')));
    assert.match(fs.readFileSync(path.join(fixture.profile, 'chrome', 'userChrome.css'), 'utf8'), /eg-desk-surface\.uc\.css/);
    assert.deepEqual(warnings, []);
    // The default is this checkout's helper build, the value the CLI prints.
    assert.equal(writeExpectedBridgeBuild(fixture.profile), computeBridgeBuildHash());
    assert.deepEqual(JSON.parse(fs.readFileSync(fixture.marker, 'utf8')), { buildHash: computeBridgeBuildHash() });
    assert.deepEqual(fs.readdirSync(path.dirname(fixture.marker)).filter(name => name.endsWith('.tmp')), []);
  } finally { fixture.cleanup(); }
});

test('a build marker that cannot be written only warns, removes a stale marker and never follows a link', () => {
  const fixture = profileFixture();
  try {
    const warnings = [];
    const warn = message => warnings.push(message);
    fs.mkdirSync(path.dirname(fixture.marker), { recursive: true });
    fs.writeFileSync(fixture.marker, JSON.stringify({ buildHash: 'b'.repeat(64) }));
    assert.equal(synchronizeProfile(fixture.profile, { locked: () => false, overlay: fixture.overlay,
      buildHash: () => { throw new Error('EACCES helper'); }, warn }), true, 'the launch goes on');
    assert.equal(fs.existsSync(fixture.marker), false, 'a stale expected build is not kept');
    assert.equal(writeExpectedBridgeBuild(fixture.profile, { buildHash: () => 'not-a-hash', warn }), null);
    assert.equal(fs.existsSync(fixture.marker), false);
    const target = path.join(fixture.outside, 'sentinel.json');
    fs.writeFileSync(target, 'unchanged');
    fs.symlinkSync(target, fixture.marker);
    assert.equal(writeExpectedBridgeBuild(fixture.profile, { buildHash: () => 'c'.repeat(64), warn }), null);
    assert.equal(fs.readFileSync(target, 'utf8'), 'unchanged');
    assert.equal(warnings.length, 3);
    assert.ok(warnings.every(message => message.startsWith('Expected bridge build marker was not written')));
  } finally { fixture.cleanup(); }
});
