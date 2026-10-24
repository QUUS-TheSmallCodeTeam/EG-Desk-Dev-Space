import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  FX_AUTOCONFIG_PIN, LOADER_UTILITY_FILES, BRIDGE_PORT, APP_SERVER_PORT, CLEANUP_ORDER, STEP_ORDER,
  PLAN_KIND, RECEIPT_KIND, RECEIPT_FILE, parseCli, buildPlan, bridgeEnvironment, firefoxArguments,
  firefoxInstallPaths, inspectLoaderDirectory, fetchPinnedLoader, runCleanProfileBoot,
} from './verify-clean-profile-boot.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(here, 'verify-clean-profile-boot.mjs');
const sha = text => createHash('sha256').update(text).digest('hex');
const PROFILE = '/tmp/egdesk-chat-test-fake';
const FIXTURES = `${PROFILE}/qa-fixtures`;
const FAST = Object.freeze({ bridgeReadyMs: 150, marionetteMs: 150, mountMs: 150, exitMs: 60, portsMs: 40, pollMs: 2 });

function options(extra = {}) {
  return { firefoxBin: '/fake/Firefox.app/Contents/MacOS/firefox', headless: false, marionettePort: 2829,
    remoteAgentPort: 6001, timeoutMs: 30000, loader: { kind: 'source', path: '/fake/loader' },
    allowUnpinnedLoader: false, removeProfileOnPass: false, planOnly: false, timeouts: { ...FAST }, ...extra };
}

class FakeProcess extends EventEmitter {
  constructor(name, pid, log) {
    super();
    Object.assign(this, { name, pid, log, exitCode: null, signalCode: null,
      stdout: new PassThrough(), stderr: new PassThrough() });
    setImmediate(() => this.emit('spawn'));
  }
  finish(code, signal = null) {
    if (this.exitCode !== null || this.signalCode !== null) return;
    this.exitCode = code; this.signalCode = signal;
    this.log.push(`exit:${this.name}`);
    this.emit('exit', code, signal);
  }
}

// signals: 'sigterm' = exits on SIGTERM, 'sigkill' = only SIGKILL ends it, 'never' = ignores both.
function fakeWorld({ busyPorts = [], loaderMatches = true, bootstrapMatches = true, bridgeReady = true,
  bridgeCrashes = false, mountNever = false, quitExits = true, firefoxSignals = 'sigterm',
  bridgeSignals = 'sigterm', env = {}, platform = 'darwin', ...overrides } = {}) {
  const log = [], procs = {}, spawned = [], writes = new Map();
  let nextPid = 4100;
  const running = name => procs[name] && procs[name].exitCode === null && procs[name].signalCode === null;
  const heldByRun = port => (running('bridge') && [BRIDGE_PORT, APP_SERVER_PORT].includes(port))
    || (running('firefox') && [2829, 6001].includes(port));
  const harness = {
    profile: PROFILE,
    observeGuard: async () => { log.push('harness:guard');
      return { documentURI: 'chrome://browser/content/browser.xhtml', headless: false, mounted: !mountNever,
        loggedIn: false, accountBound: false }; },
    observeFirstUse: async () => ({ mode: 'desk', browserCount: 1 }),
    firstUseIssues: () => [],
    consoleErrors: async () => ({ count: 0, first: [] }),
    requestQuit: async () => { log.push('harness:quit');
      if (quitExits) setTimeout(() => procs.firefox.finish(0), 3);
      return 'quit-requested'; },
    close: async () => { log.push('harness:close'); },
  };
  const deps = {
    platform, baseEnv: { PATH: '/usr/bin', ...env }, execPath: '/fake/node',
    createEvidenceDir: async () => { log.push('evidence'); return '/tmp/egdesk-clean-boot-fake'; },
    gitHead: async () => 'abc1234',
    inspectFirefox: executable => { log.push('inspect-firefox');
      return { executable, exists: true, version: '158.0.1', bootstrap: { resources: '/fake/Resources', present: true,
        matchesPin: bootstrapMatches, mismatches: bootstrapMatches ? [] : ['config.js'], sha256: {} } }; },
    inspectMcpTools: async () => ({ mcpEntry: true, geckodriver: true }),
    isPortFree: async port => { log.push(`port-free?:${port}`); return !busyPorts.includes(port) && !heldByRun(port); },
    isPortOpen: async port => running('firefox') && port === 2829,
    fetchPinnedLoader: async ({ url, dest }) => { log.push('fetch-loader');
      return { dest, url, route: 'shallow', commit: FX_AUTOCONFIG_PIN.commit, loaderSource: `${dest}/profile/chrome/utils` }; },
    inspectLoader: dir => { log.push('inspect-loader');
      return { path: dir, files: {}, extra: [], mismatches: loaderMatches ? [] : ['boot.sys.mjs'], matchesPin: loaderMatches }; },
    createProfile: async ({ loaderSource }) => { log.push(`create-profile:${loaderSource}`);
      return { profile: PROFILE, realTurnCwd: `${FIXTURES}/real-turn`, backendDataDir: `${FIXTURES}/backend-data` }; },
    prepareIsolation: async () => { log.push('isolate');
      return { dataDir: `${FIXTURES}/backend-data`, codexHome: `${FIXTURES}/codex-home`,
        exportDir: `${FIXTURES}/exports`, contextRoot: `${FIXTURES}/real-turn` }; },
    spawn: (name, command, args, spawnOptions) => {
      log.push(`spawn:${name}`);
      spawned.push({ name, command, args, options: spawnOptions });
      const child = new FakeProcess(name, nextPid++, log);
      procs[name] = child;
      if (name === 'bridge' && bridgeCrashes) setTimeout(() => child.finish(1), 3);
      return child;
    },
    fetchJson: async url => {
      const route = new URL(url).pathname;
      log.push(`fetch:${route}`);
      if (route === '/health') {
        if (!bridgeReady) throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
        return { status: 200, body: { ok: true, port: BRIDGE_PORT, appServerReady: true, chatStorageReady: true,
          profileStorageReady: true, deskStorageReady: true, node: { version: 'v24.11.1' } } };
      }
      return { status: 200, body: { protocolVersion: 1, appServerReady: true, chatStorageReady: true,
        profileStorageReady: true, native: { version: '0.160.1', schemaMatch: true }, bridge: { buildHash: 'b' },
        auth: { isLoggedIn: false, authMode: null, accountEmail: 'never-copied@example.invalid', accountId: 'acct-never-copied' } } };
    },
    listDir: () => ['chat', 'desk', 'settings'],
    prepareFirefox: async (profile, prepareOptions) => { log.push('prepare-firefox'); deps.prepared = { profile, ...prepareOptions }; },
    fingerprintOverlay: async () => ({ 'JS/eg-desk-surface.uc.js': 'f'.repeat(64) }),
    connectHarness: async ({ profile, marionettePort }) => { log.push(`harness:connect:${marionettePort}`);
      assert.equal(profile, PROFILE); return harness; },
    signalProcess: (handle, sig, signalOptions = {}) => {
      log.push(`signal:${handle.name}:${sig}${signalOptions.group ? ':group' : ''}`);
      assert.ok(Object.values(procs).includes(handle.child), 'only a process this run spawned is signalled');
      const behaviour = handle.name === 'firefox' ? firefoxSignals : bridgeSignals;
      const ends = (sig === 'SIGTERM' && behaviour === 'sigterm') || (sig === 'SIGKILL' && behaviour !== 'never');
      if (ends) setTimeout(() => handle.child.finish(sig === 'SIGTERM' ? 0 : null, sig === 'SIGTERM' ? null : 'SIGKILL'), 2);
      return true;
    },
    removeProfile: async profile => { log.push(`remove-profile:${profile}`); },
    writeFile: (file, text) => { log.push(`write:${path.basename(file)}`); writes.set(file, text); },
    ...overrides,
  };
  return { deps, log, procs, spawned, writes };
}

const at = (log, entry) => {
  const index = log.indexOf(entry);
  assert.notEqual(index, -1, `missing ${entry} in ${log.join(' > ')}`);
  return index;
};
const lastAt = (log, prefix) => log.map((entry, index) => entry.startsWith(prefix) ? index : -1).filter(i => i >= 0).pop();
const checkOf = (receipt, id) => receipt.checks.find(item => item.id === id);

// ------------------------------------------------------------ pin

test('install.sh, install.bat and the script carry one identical fx-autoconfig pin', () => {
  const sh = fs.readFileSync(path.join(here, 'install.sh'), 'utf8');
  const bat = fs.readFileSync(path.join(here, 'install.bat'), 'utf8');
  assert.match(sh, new RegExp(`^FXAC_COMMIT="${FX_AUTOCONFIG_PIN.commit}"`, 'm'));
  assert.match(bat, new RegExp(`^set "FXAC_COMMIT=${FX_AUTOCONFIG_PIN.commit}"\\r?$`, 'm'));
  const shPairs = [...sh.matchAll(/^((?:program|profile)\/\S+) ([0-9a-f]{64})\r?$/gm)].map(m => [m[1], m[2]]);
  const batPairs = [...bat.matchAll(/^call :verify_sha256 "([^"]+)" ([0-9a-f]{64})\r?$/gm)]
    .map(m => [m[1].replaceAll('\\', '/'), m[2]]);
  assert.equal(shPairs.length, 8);
  assert.equal(batPairs.length, 8);
  assert.deepEqual(Object.fromEntries(shPairs), { ...FX_AUTOCONFIG_PIN.sha256 });
  assert.deepEqual(Object.fromEntries(batPairs), { ...FX_AUTOCONFIG_PIN.sha256 });
  assert.match(sh, new RegExp(`^FXAC_UTILS="${LOADER_UTILITY_FILES.join(' ')}"$`, 'm'));
  assert.deepEqual(Object.keys(FX_AUTOCONFIG_PIN.sha256).filter(key => key.startsWith('profile/chrome/utils/'))
    .map(key => path.posix.basename(key)), [...LOADER_UTILITY_FILES]);
  // The unpinned HEAD clone is gone from both installers.
  assert.doesNotMatch(sh, /git clone/);
  assert.doesNotMatch(bat, /git clone/);
  assert.match(sh, /core\.autocrlf false/);
  assert.match(bat, /core\.autocrlf false/);
});

test('inspectLoaderDirectory names the differing and extra utilities', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'egdesk-loader-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const pin = { commit: 'c'.repeat(40), sha256: {} };
  for (const name of LOADER_UTILITY_FILES) {
    fs.writeFileSync(path.join(dir, name), `${name}\n`);
    pin.sha256[`profile/chrome/utils/${name}`] = sha(`${name}\n`);
  }
  assert.equal(inspectLoaderDirectory(dir, pin).matchesPin, true);
  fs.writeFileSync(path.join(dir, 'fs.sys.mjs'), 'older loader\n');
  fs.writeFileSync(path.join(dir, 'stray.js'), 'x');
  const result = inspectLoaderDirectory(dir, pin);
  assert.equal(result.matchesPin, false);
  assert.deepEqual(result.mismatches, ['fs.sys.mjs']);
  assert.deepEqual(result.extra, ['stray.js']);
});

test('firefoxInstallPaths finds config.js beside the binary (macOS: Contents/Resources)', () => {
  const mac = firefoxInstallPaths('/Users/a/Applications/Firefox.app/Contents/MacOS/firefox', 'darwin');
  assert.equal(mac.configJs, '/Users/a/Applications/Firefox.app/Contents/Resources/config.js');
  assert.equal(mac.configPrefs, '/Users/a/Applications/Firefox.app/Contents/Resources/defaults/pref/config-prefs.js');
  assert.equal(firefoxInstallPaths('/usr/lib/firefox/firefox', 'linux').applicationIni, '/usr/lib/firefox/application.ini');
});

test('fetchPinnedLoader takes one exact commit from a real local repository and checks every file', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'egdesk-pin-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const src = path.join(root, 'src');
  fs.mkdirSync(src);
  const emptyConfig = path.join(root, 'gitconfig');
  fs.writeFileSync(emptyConfig, '');
  const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid',
    '-c', 'commit.gpgsign=false', ...args], { cwd: src, encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: emptyConfig, GIT_CONFIG_NOSYSTEM: '1' } }).trim();
  git('init', '-q');
  const sha256 = {};
  for (const rel of Object.keys(FX_AUTOCONFIG_PIN.sha256)) {
    const file = path.join(src, ...rel.split('/'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `pinned ${rel}\n`);
    sha256[rel] = sha(`pinned ${rel}\n`);
  }
  git('add', '.');
  git('commit', '-qm', 'pinned');
  const commit = git('rev-parse', 'HEAD');
  fs.writeFileSync(path.join(src, 'program', 'config.js'), 'a later, unreviewed loader\n');
  git('commit', '-qam', 'later');
  const url = pathToFileURL(src).href;
  const result = await fetchPinnedLoader({ url, dest: path.join(root, 'ok'), pin: { commit, sha256 } });
  assert.equal(result.commit, commit);
  assert.equal(result.route, 'shallow');
  assert.equal(result.loaderSource, path.join(root, 'ok', 'profile', 'chrome', 'utils'));
  assert.equal(fs.readFileSync(path.join(root, 'ok', 'program', 'config.js'), 'utf8'), 'pinned program/config.js\n');
  await assert.rejects(fetchPinnedLoader({ url, dest: path.join(root, 'tampered'),
    pin: { commit, sha256: { ...sha256, 'program/config.js': '0'.repeat(64) } } }), /differ from the pin: program\/config\.js/);
  await assert.rejects(fetchPinnedLoader({ url, dest: path.join(root, 'unknown'),
    pin: { commit: 'f'.repeat(40), sha256 } }), /git (fetch|checkout) failed/);
});

test('fetchPinnedLoader uses a full fetch only when the exact-commit fetch is refused, and checks HEAD', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'egdesk-pin-fake-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const pin = { commit: 'a'.repeat(40), sha256: {} };
  for (const rel of Object.keys(FX_AUTOCONFIG_PIN.sha256)) pin.sha256[rel] = sha(rel);
  const fakeGit = (head = pin.commit) => {
    const calls = [];
    const git = async (args, { cwd } = {}) => {
      calls.push(args.join(' '));
      if (args.includes('--depth=1')) throw new Error('server refused want');
      if (args.includes('checkout')) {
        for (const rel of Object.keys(pin.sha256)) {
          const file = path.join(cwd, ...rel.split('/'));
          fs.mkdirSync(path.dirname(file), { recursive: true });
          fs.writeFileSync(file, rel);
        }
      }
      return { stdout: args[0] === 'rev-parse' ? `${head}\n` : '' };
    };
    return { git, calls };
  };
  const ok = fakeGit();
  const result = await fetchPinnedLoader({ url: 'https://mirror.invalid/fx.git', dest: path.join(root, 'a'), pin, git: ok.git });
  assert.equal(result.route, 'full');
  assert.deepEqual(ok.calls.slice(1), ['config core.autocrlf false', 'remote add origin https://mirror.invalid/fx.git',
    `fetch -q --depth=1 origin ${pin.commit}`, 'fetch -q origin', `-c advice.detachedHead=false checkout -q ${pin.commit}`,
    'rev-parse HEAD']);
  const wrong = fakeGit('b'.repeat(40));
  await assert.rejects(fetchPinnedLoader({ url: 'x', dest: path.join(root, 'b'), pin, git: wrong.git }), /is not the pinned/);
});

// ------------------------------------------------------------ options and plan

test('parseCli needs an explicit loader choice and only harness-approved ports', () => {
  const env = {};
  assert.throws(() => parseCli([], { env }), /loader is required/);
  assert.throws(() => parseCli(['--fetch-pinned-loader', '--loader-source', '/a'], { env }), /not both/);
  assert.throws(() => parseCli(['--loader-source', 'relative'], { env }), /absolute/);
  assert.throws(() => parseCli(['--fetch-pinned-loader', '--marionette-port', '2830'], { env }), /2828 or 2829/);
  assert.throws(() => parseCli(['--fetch-pinned-loader', '--remote-agent-port', '39218'], { env }), /remote-agent-port/);
  assert.throws(() => parseCli(['--fetch-pinned-loader', '--bogus'], { env }), /Unknown argument/);
  const parsed = parseCli(['--fetch-pinned-loader', '--headless', '--firefox-bin', '/opt/firefox/firefox'], { env });
  assert.deepEqual(parsed.loader, { kind: 'fetch', url: FX_AUTOCONFIG_PIN.repository });
  assert.equal(parsed.headless, true);
  assert.equal(parsed.marionettePort, 2829);
  assert.equal(parsed.remoteAgentPort, 6001);
  assert.deepEqual(parseCli([], { env: { EGDESK_QA_LOADER_SOURCE: '/x/utils' } }).loader, { kind: 'source', path: '/x/utils' });
  assert.equal(parseCli(['--plan', '--fetch-pinned-loader'], { env }).planOnly, true);
});

test('buildPlan spells out the launch, the isolated environment and the cleanup order without doing anything', () => {
  const plan = buildPlan(options({ headless: true }), { execPath: '/fake/node' });
  assert.equal(plan.kind, PLAN_KIND);
  assert.deepEqual(plan.steps.map(item => item.id), [...STEP_ORDER]);
  assert.deepEqual(plan.cleanup, [...CLEANUP_ORDER]);
  assert.deepEqual(plan.ports, { bridge: 39218, appServer: 39219, marionette: 2829, remoteAgent: 6001 });
  assert.deepEqual(Object.keys(plan.bridge.env), ['EGDESK_DATA_DIR', 'CODEX_HOME', 'EGDESK_EXPORT_DIR', 'EGDESK_CONTEXT_ROOTS']);
  for (const value of Object.values(plan.bridge.env)) assert.ok(value.startsWith(path.join('<profile>', 'qa-fixtures')));
  assert.deepEqual(plan.firefox.args, ['-profile', '<profile>', '--no-remote', '--purgecaches', '--headless',
    '--marionette', '--remote-debugging-port', '6001', '--remote-allow-hosts', 'localhost', 'about:blank']);
  assert.ok(!firefoxArguments({ profile: '/p', headless: false, marionettePort: 2829, remoteAgentPort: 6001 }).includes('--headless'));
});

test('the CLI prints the plan without starting anything and rejects bad usage with exit 2', () => {
  const output = execFileSync(process.execPath, [script, '--plan', '--fetch-pinned-loader', '--firefox-bin', '/opt/ff/firefox'],
    { encoding: 'utf8', env: { PATH: process.env.PATH } });
  const plan = JSON.parse(output);
  assert.equal(plan.kind, PLAN_KIND);
  assert.equal(plan.loader.commit, FX_AUTOCONFIG_PIN.commit);
  assert.throws(() => execFileSync(process.execPath, [script], { encoding: 'utf8', stdio: 'pipe', env: { PATH: process.env.PATH } }),
    error => error.status === 2 && /loader is required/.test(String(error.stderr)));
});

test('bridgeEnvironment drops inherited engine settings and keys but keeps the codex binary path', () => {
  const result = bridgeEnvironment({ PATH: '/bin', OPENAI_API_KEY: 'sk-x', EGDESK_CODEX_MODEL: 'm', CODEX_HOME: '/h',
    EGDESK_CODEX_BIN: '/opt/codex', anthropic_api_key: 'y' }, { dataDir: '/d', codexHome: '/c', exportDir: '/e', contextRoot: '/r' });
  assert.deepEqual(result.stripped, ['CODEX_HOME', 'EGDESK_CODEX_MODEL', 'OPENAI_API_KEY', 'anthropic_api_key']);
  assert.deepEqual(result.env, { PATH: '/bin', EGDESK_CODEX_BIN: '/opt/codex', EGDESK_DATA_DIR: '/d', CODEX_HOME: '/c',
    EGDESK_EXPORT_DIR: '/e', EGDESK_CONTEXT_ROOTS: '/r' });
});

// ------------------------------------------------------------ runs with fake processes

test('a passing run: receipt shape, every required check, and cleanup Firefox -> bridge -> ports -> receipt', async () => {
  const world = fakeWorld();
  const receipt = await runCleanProfileBoot(options(), world.deps);
  assert.equal(receipt.error, null);
  assert.equal(receipt.ok, true);
  assert.equal(receipt.kind, RECEIPT_KIND);
  assert.equal(receipt.version, 1);
  assert.equal(receipt.providerTurn, 'not-run');
  for (const key of ['startedAt', 'finishedAt', 'durationMs', 'host', 'source', 'plan', 'loader', 'profile', 'bridge',
    'firefox', 'steps', 'checks', 'cleanup', 'logs', 'evidenceDir', 'receiptPath']) assert.ok(key in receipt, key);
  assert.deepEqual(receipt.steps.map(item => [item.id, item.status]), STEP_ORDER.map(id => [id, 'done']));
  for (const id of ['firefox-executable', 'firefox-bootstrap-present', 'firefox-bootstrap-pinned', 'mcp-tools-present',
    'ports-free-before', 'loader-pinned', 'bridge-health', 'bridge-owned-process', 'bridge-isolated-data',
    'bridge-logged-out', 'firefox-profile-bound', 'overlay-mounted', 'ui-logged-out', 'firefox-graceful-exit',
    'bridge-graceful-exit', 'ports-released']) {
    assert.deepEqual([id, checkOf(receipt, id)?.passed, checkOf(receipt, id)?.required], [id, true, true]);
  }
  assert.deepEqual(receipt.cleanup.map(item => [item.id, item.status]), [['request-firefox-quit', 'done'],
    ['close-mcp', 'done'], ['stop-firefox', 'done'], ['stop-bridge', 'done'], ['verify-ports-released', 'done'],
    ['remove-profile', 'skipped']]);
  assert.deepEqual(receipt.firefox.exit, { via: 'app-quit', code: 0, signal: null });
  assert.deepEqual(receipt.bridge.exit, { via: 'sigterm', code: 0, signal: null });
  assert.deepEqual(receipt.profile, { path: PROFILE, retained: true, removed: false });

  const { log } = world;
  assert.ok(at(log, 'evidence') < at(log, 'inspect-firefox'));
  assert.ok(lastAt(log, 'port-free?') > at(log, 'exit:bridge'));
  assert.ok(at(log, 'spawn:bridge') < at(log, 'fetch:/health'));
  assert.ok(at(log, 'fetch:/v1/state') < at(log, 'prepare-firefox'));
  assert.ok(at(log, 'prepare-firefox') < at(log, 'spawn:firefox'));
  assert.ok(at(log, 'harness:quit') < at(log, 'harness:close'));
  assert.ok(at(log, 'harness:close') < at(log, 'signal:bridge:SIGTERM'));
  assert.ok(at(log, 'exit:firefox') < at(log, 'signal:bridge:SIGTERM'));
  assert.ok(!log.some(entry => entry.startsWith('signal:firefox')), 'a quitting Firefox is not signalled');
  assert.ok(at(log, 'write:bridge.log') < at(log, `write:${RECEIPT_FILE}`));
  assert.equal(log.at(-1), `write:${RECEIPT_FILE}`);

  const [bridge, firefox] = world.spawned;
  assert.equal(bridge.command, '/fake/node');
  assert.equal(bridge.options.detached, true);
  assert.equal(bridge.options.cwd, `${FIXTURES}/real-turn`);
  assert.equal(bridge.options.env.EGDESK_DATA_DIR, `${FIXTURES}/backend-data`);
  assert.equal(firefox.command, '/fake/Firefox.app/Contents/MacOS/firefox');
  assert.deepEqual(firefox.args.slice(0, 3), ['-profile', PROFILE, '--no-remote']);
  assert.equal(firefox.options.env.MOZ_REMOTE_ALLOW_SYSTEM_ACCESS, '1');
  assert.deepEqual(world.deps.prepared, { profile: PROFILE, mode: 'automation', marionette: 2829, remote: 6001 });

  const written = JSON.parse(world.writes.get(receipt.receiptPath));
  assert.equal(written.kind, RECEIPT_KIND);
  assert.equal(written.ok, true);
  assert.doesNotMatch(world.writes.get(receipt.receiptPath), /never-copied/);
});

test('a busy port is refused before any profile, process or loader fetch', async () => {
  const world = fakeWorld({ busyPorts: [BRIDGE_PORT] });
  const receipt = await runCleanProfileBoot(options({ loader: { kind: 'fetch', url: 'x' } }), world.deps);
  assert.equal(receipt.ok, false);
  assert.match(receipt.error, /39218 already in use; no existing process was stopped/);
  assert.ok(!world.log.some(entry => /^(spawn|create-profile|fetch-loader|signal)/.test(entry)));
  assert.deepEqual(receipt.steps.map(item => [item.id, item.status]), [['preflight', 'done'], ['ports', 'failed']]);
  assert.ok(receipt.cleanup.every(item => item.status === 'skipped'));
  assert.ok(world.writes.has(receipt.receiptPath), 'a refused run still leaves a receipt');
});

test('an unpinned Firefox bootstrap stops at preflight before any port is touched', async () => {
  const world = fakeWorld({ bootstrapMatches: false });
  const receipt = await runCleanProfileBoot(options(), world.deps);
  assert.equal(receipt.ok, false);
  assert.match(receipt.error, /Preflight failed/);
  assert.equal(checkOf(receipt, 'firefox-bootstrap-pinned').passed, false);
  assert.ok(!world.log.some(entry => entry.startsWith('port-free?')));
});

test('an unpinned loader stops before the profile unless explicitly allowed', async () => {
  const refused = fakeWorld({ loaderMatches: false });
  const receipt = await runCleanProfileBoot(options(), refused.deps);
  assert.equal(receipt.ok, false);
  assert.match(receipt.error, /--fetch-pinned-loader or --allow-unpinned-loader/);
  assert.ok(!refused.log.some(entry => entry.startsWith('create-profile')));

  const allowed = fakeWorld({ loaderMatches: false, bootstrapMatches: false });
  const passed = await runCleanProfileBoot(options({ allowUnpinnedLoader: true }), allowed.deps);
  assert.equal(passed.ok, true);
  assert.deepEqual(checkOf(passed, 'loader-pinned'), { id: 'loader-pinned', passed: false, required: false,
    details: { mismatches: ['boot.sys.mjs'], extra: [] } });
  assert.equal(checkOf(passed, 'firefox-bootstrap-pinned').required, false);
});

test('a fetched loader feeds the new profile', async () => {
  const world = fakeWorld();
  const receipt = await runCleanProfileBoot(options({ loader: { kind: 'fetch', url: 'https://mirror.invalid/fx.git' } }), world.deps);
  assert.equal(receipt.ok, true);
  assert.ok(at(world.log, 'fetch-loader') < at(world.log, 'create-profile:/tmp/egdesk-clean-boot-fake/fx-autoconfig/profile/chrome/utils'));
  assert.deepEqual(receipt.loader.fetched, { url: 'https://mirror.invalid/fx.git', route: 'shallow', commit: FX_AUTOCONFIG_PIN.commit });
});

test('a bridge that never answers is stopped and Firefox is never started', async () => {
  const world = fakeWorld({ bridgeReady: false });
  const receipt = await runCleanProfileBoot(options(), world.deps);
  assert.equal(receipt.ok, false);
  assert.match(receipt.error, /bridge \/health: timed out \(connect ECONNREFUSED\)/);
  assert.ok(!world.log.includes('spawn:firefox'));
  assert.ok(at(world.log, 'signal:bridge:SIGTERM') < at(world.log, 'exit:bridge'));
  assert.deepEqual(receipt.cleanup.map(item => item.status), ['skipped', 'skipped', 'skipped', 'done', 'done', 'skipped']);
  assert.equal(receipt.steps.find(item => item.status === 'failed').id, 'bridge-ready');
  assert.equal(receipt.profile.retained, true);
});

test('a bridge that dies while starting fails fast and is not signalled', async () => {
  const world = fakeWorld({ bridgeCrashes: true, bridgeReady: false });
  const receipt = await runCleanProfileBoot(options(), world.deps);
  assert.match(receipt.error, /process exited before it was ready/);
  assert.equal(receipt.bridge.exit.via, 'already-exited');
  assert.equal(checkOf(receipt, 'bridge-graceful-exit').passed, false);
  assert.ok(!world.log.some(entry => entry.startsWith('signal:')));
});

test('a Firefox that ignores quit and SIGTERM is ended as its own process group and the run fails', async () => {
  const world = fakeWorld({ quitExits: false, firefoxSignals: 'sigkill' });
  const receipt = await runCleanProfileBoot(options(), world.deps);
  assert.equal(receipt.ok, false);
  assert.deepEqual(receipt.firefox.exit, { via: 'sigkill', code: null, signal: 'SIGKILL' });
  assert.equal(checkOf(receipt, 'firefox-graceful-exit').passed, false);
  const { log } = world;
  assert.ok(at(log, 'signal:firefox:SIGTERM') < at(log, 'signal:firefox:SIGKILL:group'));
  assert.ok(at(log, 'exit:firefox') < at(log, 'signal:bridge:SIGTERM'), 'the bridge still waits for Firefox');
  assert.equal(receipt.bridge.exit.via, 'sigterm');
});

test('a process that will not die is reported, not hidden', async () => {
  const world = fakeWorld({ quitExits: false, firefoxSignals: 'never' });
  const receipt = await runCleanProfileBoot(options(), world.deps);
  assert.equal(receipt.ok, false);
  assert.equal(receipt.firefox.exit.via, 'not-exited');
  assert.equal(receipt.cleanup.find(item => item.id === 'stop-firefox').status, 'failed');
  assert.equal(checkOf(receipt, 'ports-released').passed, false);
  assert.deepEqual(checkOf(receipt, 'ports-released').details.busy, [2829, 6001]);
});

test('a Desk that never mounts fails the confirm step but still cleans up in order', async () => {
  const world = fakeWorld({ mountNever: true });
  const receipt = await runCleanProfileBoot(options(), world.deps);
  assert.equal(receipt.ok, false);
  assert.match(receipt.error, /Desk mount: timed out/);
  assert.equal(receipt.steps.at(-1).id, 'confirm');
  assert.equal(receipt.steps.at(-1).status, 'failed');
  const { log } = world;
  assert.ok(at(log, 'harness:quit') < at(log, 'harness:close'));
  assert.ok(at(log, 'exit:firefox') < at(log, 'signal:bridge:SIGTERM'));
  assert.ok(!log.some(entry => entry.startsWith('remove-profile')));
});

test('an interrupt during confirm stops waiting, cleans up and marks the receipt', async () => {
  const world = fakeWorld({ mountNever: true });
  const controller = new AbortController();
  const registry = new Set();
  setTimeout(() => controller.abort(), 20);
  const receipt = await runCleanProfileBoot(options({ timeouts: { ...FAST, mountMs: 10000 } }), world.deps,
    { signal: controller.signal, registry });
  assert.equal(receipt.interrupted, true);
  assert.equal(receipt.ok, false);
  assert.match(receipt.error, /interrupted/);
  assert.deepEqual([...registry].map(handle => handle.name), ['bridge', 'firefox']);
  assert.ok([...registry].every(handle => !handle.running));
  assert.ok(world.log.includes('exit:firefox') && world.log.includes('exit:bridge'));
});

test('inherited keys and engine settings never reach the bridge or the receipt', async () => {
  const world = fakeWorld({ env: { OPENAI_API_KEY: 'sk-secret-value', EGDESK_CODEX_MODEL: 'gpt-x',
    CODEX_HOME: '/Users/me/.codex', EGDESK_CODEX_BIN: '/opt/codex/bin/codex' } });
  const receipt = await runCleanProfileBoot(options(), world.deps);
  const bridgeEnv = world.spawned[0].options.env;
  assert.equal(bridgeEnv.OPENAI_API_KEY, undefined);
  assert.equal(bridgeEnv.EGDESK_CODEX_MODEL, undefined);
  assert.equal(bridgeEnv.CODEX_HOME, `${FIXTURES}/codex-home`);
  assert.equal(bridgeEnv.EGDESK_CODEX_BIN, '/opt/codex/bin/codex');
  assert.deepEqual(receipt.bridge.strippedEnvKeys, ['CODEX_HOME', 'EGDESK_CODEX_MODEL', 'OPENAI_API_KEY']);
  const text = world.writes.get(receipt.receiptPath);
  assert.doesNotMatch(text, /sk-secret-value|\/Users\/me\/\.codex|acct-never-copied/);
});

test('the profile is removed only after a passing run when asked', async () => {
  const passing = fakeWorld();
  const receipt = await runCleanProfileBoot(options({ removeProfileOnPass: true }), passing.deps);
  assert.equal(receipt.ok, true);
  assert.deepEqual(receipt.profile, { path: PROFILE, retained: false, removed: true });
  assert.equal(receipt.cleanup.at(-1).status, 'done');
  assert.ok(at(passing.log, 'exit:bridge') < at(passing.log, `remove-profile:${PROFILE}`));

  const failing = fakeWorld({ mountNever: true });
  const failed = await runCleanProfileBoot(options({ removeProfileOnPass: true }), failing.deps);
  assert.equal(failed.profile.retained, true);
  assert.ok(!failing.log.some(entry => entry.startsWith('remove-profile')));
});

test('on Windows the processes are not detached and a hard bridge stop is informational', async () => {
  const world = fakeWorld({ platform: 'win32' });
  const receipt = await runCleanProfileBoot(options(), world.deps);
  assert.equal(receipt.ok, true);
  assert.ok(world.spawned.every(item => item.options.detached === false));
  assert.equal(checkOf(receipt, 'bridge-graceful-exit').required, false);
});
