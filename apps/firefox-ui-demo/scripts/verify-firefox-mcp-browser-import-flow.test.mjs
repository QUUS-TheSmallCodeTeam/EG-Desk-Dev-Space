import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import vm from 'node:vm';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { parseCli, assertBeforeDeadline, boundedTimeout, assertRunning, assertEvidenceRoot, assertPrivateDirectory, assertPortFree, prepareProfile,
  decodeScreenshot, syntheticBridgeState, providerBoundaryEvidence, sameCardGeometry, sameFullscreenCamera, fullscreenEdgesUncropped, openFileRefusalAccepted,
  IsolatedMcp, migrationMessageDisposition, loaderSources, sandboxPolicy, assertSupportedPlatform,
  assertRuntimePathSyntax, validateRuntimePaths, assertSafeRuntimeAllowlist, childEnvironment,
  mcpDriverPortPreload, MARIONETTE_PORT, REMOTE_PORT }
  from './verify-firefox-mcp-browser-import-flow.mjs';

test('CLI parsing validates POSIX path syntax, deadlines and scenarios', t => {
  if (process.platform === 'win32') return t.skip('POSIX runtime-path syntax; verifier itself is macOS-only');
  const now = Date.parse('2026-10-28T16:00:00Z');
  const runtimeArgs = ['--firefox', '/fixture/Firefox.app/Contents/MacOS/firefox', '--mcp-entry',
    '/fixture/node_modules/@mozilla/firefox-devtools-mcp-moz/dist.moz/index.js', '--geckodriver', '/fixture/geckodriver'];
  const base = ['--evidence-root', '/private/tmp/egdesk-round-test', '--deadline-utc', '2026-10-28T22:00:00Z', ...runtimeArgs];
  assert.deepEqual(parseCli(base, now), { evidenceRoot: '/private/tmp/egdesk-round-test',
    deadlineMs: Date.parse('2026-10-28T22:00:00Z'), scenario: 'core', expectedSurfaceSha256: null, runtimes: {
      firefox: runtimeArgs[1], mcpEntry: runtimeArgs[3], geckodriver: runtimeArgs[5] } });
  assert.equal(parseCli([...base, '--expected-surface-sha256', 'a'.repeat(64)], now).expectedSurfaceSha256, 'a'.repeat(64));
  assert.throws(() => parseCli([...base, '--expected-surface-sha256', 'BAD'], now), /SHA256/);
  assert.equal(parseCli([...base, '--scenario', 'ownership'], now).scenario, 'ownership');
  assert.equal(parseCli([...base, '--scenario', 'open-file'], now).scenario, 'open-file');
  assert.throws(() => parseCli([...base, '--scenario', 'unknown'], now));
  assert.throws(() => parseCli([], now));
  assert.throws(() => parseCli([...base, '--profile', '/Users/me/profile'], now));
  assert.throws(() => parseCli(base.slice(0, -2), now), /explicit runtime paths/);
  assert.throws(() => parseCli(['--evidence-root', '/tmp/x', '--deadline-utc', '2026-10-28 22:00', ...runtimeArgs], now));
  assert.throws(() => parseCli(['--evidence-root', '/tmp/x', '--deadline-utc', '2026-10-28T15:00:00Z', ...runtimeArgs], now));
  assert.throws(() => parseCli(['--evidence-root', '/tmp/x', '--deadline-utc', '2026-02-30T22:00:00Z', ...runtimeArgs], now));
  assert.throws(() => parseCli([...base.slice(0, 4), '--firefox', 'relative/firefox', ...runtimeArgs.slice(2)], now), /absolute/);
});

test('deadline and interruption guards reject unsafe work on every platform', () => {
  const now = Date.parse('2026-10-28T16:00:00Z');
  assert.throws(() => parseCli([], now));
  assert.throws(() => parseCli(['--profile', 'unapproved'], now));
  assert.throws(() => assertBeforeDeadline(now, now));
  assert.equal(boundedTimeout(now + 100, 30000, now), 100);
  assert.equal(boundedTimeout(now + 50000, 30000, now), 30000);
  assert.throws(() => boundedTimeout(now, 30000, now));
  const controller = new AbortController();
  assert.doesNotThrow(() => assertRunning(now + 1, controller.signal, now));
  controller.abort();
  assert.throws(() => assertRunning(now + 1, controller.signal, now), /interrupted/);
});

test('platform and path syntax guards fail closed on unsupported or malformed inputs', () => {
  assert.doesNotThrow(() => assertSupportedPlatform('darwin'));
  assert.throws(() => assertSupportedPlatform('linux'), /macOS/);
  assert.throws(() => assertSupportedPlatform('win32'), /macOS/);
  assert.throws(() => assertRuntimePathSyntax('../relative'));
  assert.throws(() => assertRuntimePathSyntax('/tmp/a/../b'));
  assert.throws(() => assertRuntimePathSyntax('/tmp/a"b'));
  if (process.platform === 'win32') {
    assert.throws(() => assertRuntimePathSyntax(path.win32.resolve('C:\\fixture\\geckodriver')), /runtime path/);
  } else assert.doesNotThrow(() => assertRuntimePathSyntax('/fixture/geckodriver'));
});

test('runCli rejects Linux and Windows before parsing or launching', () => {
  const moduleUrl = new URL('./verify-firefox-mcp-browser-import-flow.mjs', import.meta.url).href;
  const script = `const { runCli } = await import(process.argv[1]);
    Object.defineProperty(process, 'platform', { value: process.argv[2], configurable: true });
    try { await runCli([]); process.exitCode = 1; }
    catch (error) { if (!/requires macOS sandbox-exec/.test(error.message)) { process.stderr.write(error.message); process.exitCode = 1; } }`;
  for (const platform of ['linux', 'win32']) {
    const result = childProcess.spawnSync(process.execPath, ['--input-type=module', '-e', script, moduleUrl, platform],
      { encoding: 'utf8', timeout: 10000, windowsHide: true });
    assert.equal(result.status, 0, `${platform} must fail closed before CLI parsing: ${result.stderr || result.error || ''}`);
  }
});

test('macOS runtime files require canonical paths and expected bundle layout', t => {
  if (process.platform !== 'darwin') return t.skip('macOS filesystem, permissions and bundle layout required');
  const root = fs.mkdtempSync('/private/tmp/egdesk-round-runtime-test-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const firefox = path.join(root, 'Firefox.app/Contents/MacOS/firefox');
  const mcpEntry = path.join(root, 'node_modules/@mozilla/firefox-devtools-mcp-moz/dist.moz/index.js');
  const geckodriver = path.join(root, 'driver/geckodriver');
  const node = path.join(root, 'node/bin/node');
  for (const [file, mode] of [[firefox, 0o700], [mcpEntry, 0o600], [geckodriver, 0o700], [node, 0o700]]) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, 'fixture only', { mode });
  }
  const valid = { firefox, mcpEntry, geckodriver, node };
  const resolved = validateRuntimePaths(valid);
  assert.equal(resolved.firefoxApp, path.join(root, 'Firefox.app'));
  assert.equal(resolved.mcpDir, path.join(root, 'node_modules'));
  assert.throws(() => validateRuntimePaths({ ...valid, mcpEntry: path.join(root, 'missing') }));
  assert.throws(() => validateRuntimePaths({ ...valid, mcpEntry: node }), /MCP entry/);
  assert.throws(() => validateRuntimePaths({ ...valid, firefox: node }), /Firefox/);
  assert.throws(() => validateRuntimePaths({ ...valid, geckodriver: firefox }), /geckodriver/);
  fs.chmodSync(geckodriver, 0o600);
  assert.throws(() => validateRuntimePaths(valid));
  fs.chmodSync(geckodriver, 0o700);
  const linked = path.join(root, 'linked-node');
  fs.symlinkSync(path.dirname(node), linked);
  assert.throws(() => validateRuntimePaths({ ...valid, node: path.join(linked, 'node') }), /canonical/);
  assert.doesNotThrow(() => assertSafeRuntimeAllowlist('/Users/fixture', resolved));
  assert.throws(() => assertSafeRuntimeAllowlist('/Users/fixture', { ...resolved,
    mcpDir: '/Users/fixture/Library/Application Support/Firefox/Profiles' }), /profile or keychain/);
  assert.throws(() => assertSafeRuntimeAllowlist('/Users/fixture', { ...resolved,
    mcpDir: '/Users/fixture/Library' }), /profile or keychain/);
  assert.throws(() => assertSafeRuntimeAllowlist('/Users/fixture', { ...resolved,
    geckodriver: '/Users/fixture/Library/Keychains/geckodriver' }), /profile or keychain/);
  assert.equal(childEnvironment(geckodriver).PATH.split(':')[0], path.dirname(geckodriver));
  assert.throws(() => childEnvironment('geckodriver'), /absolute/);
});

test('independent loader has no personal profile path and loads only the isolated surface', () => {
  const sources = loaderSources();
  assert.equal(Object.keys(sources).length, 6);
  assert.doesNotMatch(JSON.stringify(sources), /Library\/Application Support\/Firefox\/Profiles/);
  assert.match(sources['boot.sys.mjs'], /browser-delayed-startup-finished/);
  assert.match(sources['boot.sys.mjs'], /eg-desk-surface\.uc\.js/);
  assert.doesNotMatch(sources['boot.sys.mjs'], /readdir|enumerat/i);
});

test('macOS sandbox policy text specifies home, keychain and network restrictions', () => {
  const policy = sandboxPolicy({ home: '/Users/fixture', firefoxApp: '/Users/fixture/Applications/Firefox.app',
    nodeDir: '/Users/fixture/node', mcpDir: '/Users/fixture/mcp', geckoDir: '/Users/fixture/gecko', fixturePort: 49153 });
  assert.match(policy, /deny file-read\* \(subpath "\/Users\/fixture"\)/);
  assert.match(policy, /deny file-write\* \(subpath "\/Users\/fixture"\)/);
  assert.match(policy, /deny network-outbound/);
  assert.match(policy, /allow network-outbound \(remote ip "localhost:49153"\)/);
  assert.match(policy, /allow network-outbound \(remote ip "localhost:28831"\)/);
  assert.match(policy, /allow network-outbound \(remote ip "localhost:60831"\)/);
  assert.doesNotMatch(policy, /localhost:\*|localhost:39217|localhost:39218/);
  assert.match(policy, /com\.apple\.securityd/);
  assert.match(policy, /com\.apple\.mDNSResponder/);
  assert.throws(() => sandboxPolicy({ home: '/Users/"bad', firefoxApp: '/a', nodeDir: '/b', mcpDir: '/c', geckoDir: '/d' }));
  assert.throws(() => sandboxPolicy({ home: '/Users/fixture', firefoxApp: '/a', nodeDir: '/b',
    mcpDir: '/c', geckoDir: '/d', fixturePort: 39217 }), /unsafe sandbox fixture port/);
  assert.throws(() => sandboxPolicy({ home: '/Users/fixture', firefoxApp: '/a', nodeDir: '/b',
    mcpDir: '/c', geckoDir: '/d', fixturePort: 49153, driverPort: 49153 }), /unsafe sandbox driver port/);
  assert.notEqual(MARIONETTE_PORT, REMOTE_PORT);
});

test('pure policy and runtime-path guards remain fail-closed under win32 path semantics', () => {
  const context = { path: path.win32, assert, MARIONETTE_PORT, REMOTE_PORT };
  const policyForWindowsPaths = vm.runInNewContext(`(${sandboxPolicy.toString()})`, context);
  const runtimePathForWindows = vm.runInNewContext(`(${assertRuntimePathSyntax.toString()})`, context);
  const policy = policyForWindowsPaths({ home: '/Users/fixture', firefoxApp: '/Users/fixture/Applications/Firefox.app',
    nodeDir: '/Users/fixture/node', mcpDir: '/Users/fixture/mcp', geckoDir: '/Users/fixture/gecko', fixturePort: 49153 });
  assert.match(policy, /deny file-read\* \(subpath "\/Users\/fixture"\)/);
  assert.match(policy, /allow network-outbound \(remote ip "localhost:49153"\)/);
  assert.doesNotMatch(policy, /localhost:\*/);
  assert.throws(() => runtimePathForWindows('C:\\fixture\\geckodriver'), /runtime path/);
  assert.throws(() => runtimePathForWindows('/fixture/geckodriver'), /runtime path/);
});

test('MCP preload forwards only its explicit driver port to a mocked Selenium builder', () => {
  class ServiceBuilder {
    setPort(port) { this.port = port; }
    build(value) { return { port: this.port, value }; }
  }
  let marker = '';
  const modules = { 'node:assert/strict': assert, 'node:fs': { constants: { X_OK: 1 }, accessSync() {} },
    'node:path': path.posix, 'node:module': { createRequire: () => () => ({ ServiceBuilder }) } };
  const environment = { EGDESK_QA_MCP_ENTRY: '/fixture/mcp.js', EGDESK_QA_DRIVER_PORT: '49154',
    EGDESK_QA_GECKODRIVER: '/fixture/bin/geckodriver', PATH: '/fixture/bin:/usr/bin' };
  vm.runInNewContext(mcpDriverPortPreload(), { require: name => modules[name],
    process: { env: environment, stderr: { write: value => { marker += value; } } } });
  assert.deepEqual(new ServiceBuilder().build('original-called'), { port: 49154, value: 'original-called' });
  assert.match(marker, /egdesk-qa-driver-port-configured/);
});

test('sandbox permits the owned fixture port but denies another loopback listener', async t => {
  if (process.platform !== 'darwin') return t.skip('macOS sandbox-exec required');
  const allowed = net.createServer(socket => socket.destroy());
  const denied = net.createServer(socket => socket.destroy());
  const servers = [allowed, denied];
  try {
    await Promise.all(servers.map(server => new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    })));
    const fixturePort = allowed.address().port, otherPort = denied.address().port;
    assert.ok(![MARIONETTE_PORT, REMOTE_PORT, 39217, 39218].includes(fixturePort));
    assert.ok(![MARIONETTE_PORT, REMOTE_PORT].includes(otherPort));
    const policy = sandboxPolicy({ home: '/Users/fixture', firefoxApp: '/Users/fixture/firefox',
      nodeDir: '/Users/fixture/node', mcpDir: '/Users/fixture/mcp', geckoDir: '/Users/fixture/gecko', fixturePort });
    const connect = port => new Promise((resolve, reject) => {
      const process = childProcess.spawn('/usr/bin/sandbox-exec', ['-p', policy,
        '/usr/bin/nc', '-z', '-w', '1', '127.0.0.1', String(port)], { stdio: 'ignore' });
      process.once('error', reject);
      process.once('exit', code => resolve(code));
    });
    assert.equal(await connect(fixturePort), 0, 'owned fixture port should be reachable');
    assert.notEqual(await connect(otherPort), 0, 'unowned loopback port must be denied');
  } finally {
    await Promise.all(servers.filter(server => server.listening).map(server => new Promise(resolve => server.close(resolve))));
  }
});

test('only synthetic enumeration and inert telemetry pass the migration actor gate', () => {
  assert.equal(migrationMessageDisposition('GetAvailableMigrators'), 'synthetic-list');
  assert.equal(migrationMessageDisposition('RecordEvent'), 'ignore-telemetry');
  for (const name of ['Migrate', 'CheckPermissions', 'GetPermissions', 'RequestSafariPermissions',
    'SelectManualPasswordFile', 'LaunchMacOSPasswordsApp', 'OpenURL', '', '__proto__', 'unknown']) {
    assert.equal(migrationMessageDisposition(name), 'deny', name);
  }
});

test('local bridge advertises only fake portable capabilities and no real identity or provider', () => {
  const state = syntheticBridgeState();
  assert.deepEqual(state.capabilities.portable, ['inspect', 'import-as-new']);
  assert.equal(state.appServerReady, false);
  assert.equal(state.deskStorageReady, false);
  assert.equal(state.auth.isLoggedIn, false);
  assert.equal(state.auth.accountId, null);
  assert.equal(state.auth.accountEmail, null);
});

test('provider evidence distinguishes an unmeasured count from the structural isolation boundary', () => {
  const evidence = providerBoundaryEvidence();
  assert.equal(evidence.providerCalls, 'not-measured');
  assert.match(evidence.providerMode, /fixture-does-not-forward/);
  assert.match(evidence.externalNetwork, /denied-by-inherited-os-sandbox/);
});

test('profile and evidence guards refuse existing unmarked or unsafe paths before launch', t => {
  if (process.platform !== 'darwin') return t.skip('macOS canonical /private/tmp and POSIX permission checks required');
  const directory = fs.mkdtempSync('/private/tmp/egdesk-round-verifier-test-');
  t.after(() => { fs.chmodSync(directory, 0o700); fs.rmSync(directory, { recursive: true, force: true }); });
  fs.chmodSync(directory, 0o700);
  assert.equal(assertEvidenceRoot(directory), directory);
  assert.throws(() => assertEvidenceRoot('/tmp'));
  assert.throws(() => assertEvidenceRoot('/private/tmp'));
  assert.throws(() => assertPrivateDirectory(directory, '/not-the-parent'));
  assert.throws(() => new IsolatedMcp({ profile: directory, policy: '' }));
  assert.throws(() => new IsolatedMcp({ prepared: { profile: directory }, firefox: { pid: process.pid }, policy: '' }),
    /not created by this run/);
  assert.throws(() => prepareProfile({ loader: directory, fixturePort: 39218 }));
  assert.throws(() => prepareProfile({ loader: directory, fixturePort: 39217 }));
  assert.throws(() => prepareProfile({ loader: directory, fixturePort: MARIONETTE_PORT }));
  assert.throws(() => prepareProfile({ loader: directory, fixturePort: 49153 }), /loader must be created/);
  fs.chmodSync(directory, 0o755);
  assert.throws(() => assertEvidenceRoot(directory), /private/);
});

test('an occupied port is refused without touching its owner', async () => {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  try {
    await assert.rejects(assertPortFree(server.address().port), /occupied/);
    assert.equal(server.listening, true);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('screenshot evidence requires bounded PNG bytes and matching dimensions', () => {
  const png = Buffer.alloc(33);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
  png.writeUInt32BE(13, 8); png.write('IHDR', 12, 'ascii');
  png.writeUInt32BE(2, 16); png.writeUInt32BE(3, 20);
  const value = { width: 2, height: 3, data: png.toString('base64') };
  assert.deepEqual(decodeScreenshot(value), png);
  assert.throws(() => decodeScreenshot({ ...value, width: 3 }), /mismatched/);
  assert.throws(() => decodeScreenshot({ ...value, data: '!invalid' }), /encoding/);
  assert.throws(() => decodeScreenshot({ ...value, width: 5000, height: 5000 }), /dimensions/);
});

test('a moving or replaced card is not accepted as geometrically stable', () => {
  const card = { id: 'qa', rect: { left: 10, top: 20, right: 410, bottom: 320 } };
  assert.equal(sameCardGeometry(null, card), false);
  assert.equal(sameCardGeometry(card, { ...card, id: 'other' }), false);
  assert.equal(sameCardGeometry(card, { ...card, rect: { ...card.rect, top: 21 } }), false);
  assert.equal(sameCardGeometry(card, { ...card, rect: { ...card.rect, top: 20.5 } }), true);
});

test('same-card fullscreen camera rejects a 24px crop, focus change or exit', () => {
  const camera = { cardId: 'qa', fullscreenCardId: 'qa', activeCardId: 'qa',
    rect: { left: 0, top: 0, right: 1366, bottom: 768 }, pan: { x: 0, y: 0 }, panTarget: { x: 0, y: 0 },
    zoom: 1, zoomTarget: 1, viewport: { width: 1366, height: 768 } };
  assert.equal(sameFullscreenCamera(camera, structuredClone(camera)), true);
  assert.equal(sameFullscreenCamera(camera, { ...camera, rect: { ...camera.rect, left: -24 } }), false);
  assert.equal(sameFullscreenCamera(camera, { ...camera, panTarget: { x: -24, y: 0 } }), false);
  assert.equal(sameFullscreenCamera(camera, { ...camera, fullscreenCardId: null }), false);
  assert.equal(sameFullscreenCamera(camera, { ...camera, activeCardId: 'other' }), false);
  assert.equal(sameFullscreenCamera(camera, { ...camera, rect: null }), false);
  assert.equal(fullscreenEdgesUncropped(camera), true);
  assert.equal(fullscreenEdgesUncropped({ ...camera, rect: { ...camera.rect, left: -24 } }), false);
});

test('Open File refusal cannot pass if the guard, command, notice or side-effect evidence is missing', () => {
  const good = { guard: { installed: true, guarded: ['browser', 'library'] },
    invoked: { invoked: true, disabled: false }, observed: { commands: [{ trusted: false }], blockedNativeCalls: [], notice: 'Unavailable in Desk' },
    unchanged: true, fileRequests: [], beforeNotice: null };
  assert.equal(openFileRefusalAccepted(good), true);
  assert.equal(openFileRefusalAccepted({ ...good, guard: { installed: true, guarded: ['library'] } }), false);
  assert.equal(openFileRefusalAccepted({ ...good, invoked: { invoked: true, disabled: true } }), false);
  assert.equal(openFileRefusalAccepted({ ...good, observed: { ...good.observed, commands: [] } }), false);
  assert.equal(openFileRefusalAccepted({ ...good, observed: { ...good.observed, commands: [{}, {}] } }), false);
  assert.equal(openFileRefusalAccepted({ ...good, observed: { ...good.observed, blockedNativeCalls: ['library'] } }), false);
  assert.equal(openFileRefusalAccepted({ ...good, observed: { ...good.observed, notice: null } }), false);
  assert.equal(openFileRefusalAccepted({ ...good, unchanged: false }), false);
  assert.equal(openFileRefusalAccepted({ ...good, fileRequests: ['/v1/files/open'] }), false);
});

test('importing the verifier starts no process, listener, network request or file write', async t => {
  const forbidden = () => assert.fail('side effect during verifier import');
  const mocks = [
    t.mock.method(childProcess, 'spawn', forbidden), t.mock.method(childProcess, 'execFileSync', forbidden),
    t.mock.method(net, 'createServer', forbidden), t.mock.method(net, 'connect', forbidden),
    t.mock.method(fs, 'writeFileSync', forbidden), t.mock.method(fs, 'mkdirSync', forbidden),
    t.mock.method(globalThis, 'fetch', forbidden),
  ];
  syncBuiltinESMExports();
  try { await import('./verify-firefox-mcp-browser-import-flow.mjs?no-side-effects-test'); }
  finally { for (const mock of mocks) mock.mock.restore(); syncBuiltinESMExports(); }
});
