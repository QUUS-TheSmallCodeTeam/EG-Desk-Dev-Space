#!/usr/bin/env node
// RT-01: the "first run on a new PC" check as one command.
//   new temp profile -> isolated bridge -> Firefox -> confirm Desk mounted
//   -> quit Firefox -> stop bridge -> ports released -> receipt.
// Only processes this script spawned are ever signalled. A port that is already
// in use is refused; no existing process is stopped or attached to. The profile
// and evidence are kept unless --remove-profile-on-pass is given and the run
// passed. Pattern source: web-ext temp profile + --no-remote (MPL-2.0, pattern only).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

// The loader install.sh / install.bat fetch. Keep all three in step; the test
// compares them. https://github.com/MrOtherGuy/fx-autoconfig (MPL-2.0).
export const FX_AUTOCONFIG_PIN = Object.freeze({
  repository: 'https://github.com/MrOtherGuy/fx-autoconfig.git',
  commit: 'dfdab5684faffc112b76ccb1d8cab7f75da0102c',
  committedAt: '2026-07-23T12:59:54+03:00',
  license: 'MPL-2.0',
  sha256: Object.freeze({
    'program/config.js': '80dc421264a3ea04275e1724b7b57234f89254e9582a6c17e9a911b65c3aa6d7',
    'program/defaults/pref/config-prefs.js': '6bfd2ed139d18ff5178e0fc62a3b4058540ddbeba3adc912c0d69edb70c17ece',
    'profile/chrome/utils/boot.sys.mjs': '1f0b37d765c7b10b963a465a62a420059e334a18b6b48bd8c09059837e676106',
    'profile/chrome/utils/chrome.manifest': 'd80557b7bdd46f91f0d249f25f1bf66ed83f8c9e620cd0c9334029e4826924d0',
    'profile/chrome/utils/fs.sys.mjs': '1d6302c5484dc914e43685740937f1d89908099f835e53f532338822c31b08af',
    'profile/chrome/utils/module_loader.mjs': 'e7fca8757159751df080e5cbfcd27b508d98c5cdfd6434ea14247832418d1f63',
    'profile/chrome/utils/uc_api.sys.mjs': 'dc7547aecbaac67da94b54e353f8e306a0ca01b2a461e106cc88c63a2e210cac',
    'profile/chrome/utils/utils.sys.mjs': '3fb7c9799864ee01428722939f324acea1e6065cb63a9298e7bbc59e5adbd96a',
  }),
});
export const LOADER_UTILITY_FILES = Object.freeze(['boot.sys.mjs', 'chrome.manifest', 'fs.sys.mjs',
  'module_loader.mjs', 'uc_api.sys.mjs', 'utils.sys.mjs']);
export const BRIDGE_PORT = 39218;
export const APP_SERVER_PORT = 39219;
export const PLAN_KIND = 'egdesk-clean-profile-boot-plan';
export const RECEIPT_KIND = 'egdesk-clean-profile-boot-receipt';
export const RECEIPT_FILE = 'clean-profile-boot-receipt.json';
export const STEP_ORDER = Object.freeze(['preflight', 'ports', 'loader', 'profile', 'isolate', 'bridge',
  'bridge-ready', 'firefox-prepare', 'firefox', 'confirm']);
// Firefox goes before the bridge so the overlay's own shutdown saves can still
// reach the Desk store; the port check comes only after both have exited.
export const CLEANUP_ORDER = Object.freeze(['request-firefox-quit', 'close-mcp', 'stop-firefox',
  'stop-bridge', 'verify-ports-released', 'remove-profile']);
export const DEFAULT_TIMEOUTS = Object.freeze({ bridgeReadyMs: 45000, marionetteMs: 60000,
  mountMs: 60000, exitMs: 20000, portsMs: 5000, pollMs: 250 });

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const BRIDGE_ENTRY = path.join(SCRIPT_DIR, '..', 'helper', 'codex-bridge-server.mjs');
// The bridge must not inherit engine choices or keys from the caller's shell.
const STRIPPED_ENV = /^(EGDESK_|CODEX_|OPENAI_|ANTHROPIC_|CLAUDE_)/i;
const KEPT_ENV = new Set(['EGDESK_CODEX_BIN']);
const USAGE = `Usage: node verify-clean-profile-boot.mjs (--loader-source DIR | --fetch-pinned-loader)
  [--firefox-bin PATH] [--headless] [--marionette-port 2828|2829] [--remote-agent-port N]
  [--fx-autoconfig-url URL] [--timeout-ms N] [--allow-unpinned-loader]
  [--remove-profile-on-pass] [--plan]
--plan prints the execution plan and starts nothing.`;

class UsageError extends Error {}
class InterruptedError extends Error { constructor() { super('interrupted; cleanup ran'); } }

// ---------------------------------------------------------------- options

function defaultFirefoxBin(env, platform, home, exists) {
  if (env.EGDESK_FIREFOX_BIN) return env.EGDESK_FIREFOX_BIN;
  if (platform === 'darwin') {
    const user = path.join(home, 'Applications/Firefox.app/Contents/MacOS/firefox');
    return exists(user) ? user : '/Applications/Firefox.app/Contents/MacOS/firefox';
  }
  if (platform === 'win32') return path.join(env.ProgramFiles || 'C:\\Program Files', 'Mozilla Firefox', 'firefox.exe');
  return '/usr/bin/firefox';
}

export function parseCli(argv, { env = process.env, platform = process.platform, home = os.homedir(),
  exists = fs.existsSync } = {}) {
  const flags = { '--headless': 'headless', '--fetch-pinned-loader': 'fetchPinnedLoader',
    '--allow-unpinned-loader': 'allowUnpinnedLoader', '--remove-profile-on-pass': 'removeProfileOnPass',
    '--plan': 'planOnly', '--help': 'help' };
  const valued = { '--firefox-bin': 'firefoxBin', '--loader-source': 'loaderSource',
    '--fx-autoconfig-url': 'fxAutoconfigUrl', '--marionette-port': 'marionettePort',
    '--remote-agent-port': 'remoteAgentPort', '--timeout-ms': 'timeoutMs' };
  const raw = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (flags[key]) {
      if (raw[flags[key]]) throw new UsageError(`Duplicate ${key}\n${USAGE}`);
      raw[flags[key]] = true;
    } else if (valued[key]) {
      const value = argv[++i];
      if (!value || value.startsWith('--') || raw[valued[key]] !== undefined) throw new UsageError(`Missing or duplicate ${key}\n${USAGE}`);
      raw[valued[key]] = value;
    } else throw new UsageError(`Unknown argument ${key}\n${USAGE}`);
  }
  if (raw.help) return { help: true, usage: USAGE };
  const loaderSource = raw.loaderSource || env.EGDESK_QA_LOADER_SOURCE || null;
  if (raw.fetchPinnedLoader && raw.loaderSource) throw new UsageError(`Choose --loader-source or --fetch-pinned-loader, not both\n${USAGE}`);
  if (!raw.fetchPinnedLoader && !loaderSource) throw new UsageError(`A loader is required: --loader-source DIR or --fetch-pinned-loader\n${USAGE}`);
  if (!raw.fetchPinnedLoader && !path.isAbsolute(loaderSource)) throw new UsageError('--loader-source must be absolute');
  const marionettePort = Number(raw.marionettePort ?? 2829);
  if (![2828, 2829].includes(marionettePort)) throw new UsageError('--marionette-port must be 2828 or 2829 (the QA harness accepts only these)');
  const remoteAgentPort = Number(raw.remoteAgentPort ?? 6001);
  if (!Number.isInteger(remoteAgentPort) || remoteAgentPort < 1024 || remoteAgentPort > 65535
      || [marionettePort, BRIDGE_PORT, APP_SERVER_PORT].includes(remoteAgentPort)) {
    throw new UsageError('--remote-agent-port must be 1024-65535 and differ from Marionette, 39218 and 39219');
  }
  const timeoutMs = Number(raw.timeoutMs ?? 240000);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 30000 || timeoutMs > 1800000) throw new UsageError('--timeout-ms must be 30000-1800000');
  const firefoxBin = raw.firefoxBin || defaultFirefoxBin(env, platform, home, exists);
  if (!path.isAbsolute(firefoxBin)) throw new UsageError('--firefox-bin must be absolute');
  const url = raw.fxAutoconfigUrl || env.EGDESK_FX_AUTOCONFIG_URL || FX_AUTOCONFIG_PIN.repository;
  return {
    firefoxBin, headless: !!raw.headless, marionettePort, remoteAgentPort, timeoutMs,
    loader: raw.fetchPinnedLoader ? { kind: 'fetch', url } : { kind: 'source', path: loaderSource },
    allowUnpinnedLoader: !!raw.allowUnpinnedLoader, removeProfileOnPass: !!raw.removeProfileOnPass,
    planOnly: !!raw.planOnly, timeouts: { ...DEFAULT_TIMEOUTS },
  };
}

// ---------------------------------------------------------------- plan (pure)

export function isolatedPaths(profile) {
  const fixtures = path.join(profile, 'qa-fixtures');
  return { dataDir: path.join(fixtures, 'backend-data'), codexHome: path.join(fixtures, 'codex-home'),
    exportDir: path.join(fixtures, 'exports'), contextRoot: path.join(fixtures, 'real-turn') };
}

export function bridgeEnvironment(baseEnv, paths) {
  const env = {}, stripped = [];
  for (const [key, value] of Object.entries(baseEnv || {})) {
    if (STRIPPED_ENV.test(key) && !KEPT_ENV.has(key)) stripped.push(key);
    else env[key] = value;
  }
  const isolated = { EGDESK_DATA_DIR: paths.dataDir, CODEX_HOME: paths.codexHome,
    EGDESK_EXPORT_DIR: paths.exportDir, EGDESK_CONTEXT_ROOTS: paths.contextRoot };
  return { env: { ...env, ...isolated }, isolated, stripped: stripped.sort() };
}

export function firefoxEnvironment(baseEnv) {
  const env = { ...(baseEnv || {}) };
  for (const key of ['MOZ_REMOTE_ALLOW_SYSTEM_ACCESS', 'MOZ_MARIONETTE', 'MOZ_HEADLESS']) delete env[key];
  env.MOZ_REMOTE_ALLOW_SYSTEM_ACCESS = '1';
  return env;
}

export function firefoxArguments({ profile, headless, marionettePort, remoteAgentPort }) {
  return ['-profile', profile, '--no-remote', '--purgecaches', ...(headless ? ['--headless'] : []),
    '--marionette', '--remote-debugging-port', String(remoteAgentPort), '--remote-allow-hosts', 'localhost',
    'about:blank'];
}

export function buildPlan(options, { profile = '<profile>', evidenceDir = '<evidence>', execPath = process.execPath } = {}) {
  const paths = isolatedPaths(profile);
  const ports = { bridge: BRIDGE_PORT, appServer: APP_SERVER_PORT, marionette: options.marionettePort,
    remoteAgent: options.remoteAgentPort };
  const loader = options.loader.kind === 'fetch'
    ? { kind: 'fetch', url: options.loader.url, commit: FX_AUTOCONFIG_PIN.commit, into: path.join(evidenceDir, 'fx-autoconfig') }
    : { kind: 'source', path: options.loader.path };
  return {
    kind: PLAN_KIND, version: 1, ports, loader,
    bridge: { command: execPath, args: [BRIDGE_ENTRY], cwd: paths.contextRoot,
      env: bridgeEnvironment({}, paths).isolated, strippedEnvPattern: String(STRIPPED_ENV) },
    firefox: { command: options.firefoxBin, args: firefoxArguments({ profile, ...options }),
      env: { MOZ_REMOTE_ALLOW_SYSTEM_ACCESS: '1' } },
    steps: [
      { id: 'preflight', does: 'Firefox exists; its config.js/config-prefs.js and the Firefox MCP tools are present; bootstrap pinned to fx-autoconfig dfdab56' },
      { id: 'ports', does: `require ${Object.values(ports).join(', ')} free on 127.0.0.1; refuse otherwise, stop nothing` },
      { id: 'loader', does: loader.kind === 'fetch' ? 'git fetch the pinned commit, verify 8 SHA-256 values' : 'verify the 6 loader utilities against the pin' },
      { id: 'profile', does: 'new <tmp>/egdesk-chat-test-* profile with marker, chrome/utils and qa-fixtures' },
      { id: 'isolate', does: 'bridge data, CODEX_HOME and exports inside the profile (no real login, no real Desk data)' },
      { id: 'bridge', does: 'spawn the bridge with only the isolated EGDESK_/CODEX_ variables' },
      { id: 'bridge-ready', does: 'GET /health until storage ready, then GET /v1/state (expect logged out)' },
      { id: 'firefox-prepare', does: 'prepareQaFirefox: user.js automation prefs, overlay copy, userChrome.css' },
      { id: 'firefox', does: 'spawn Firefox with -profile, --no-remote and Marionette' },
      { id: 'confirm', does: 'Marionette up, same profile, Desk mounted, logged out; first-use Browser and console errors recorded' },
    ],
    cleanup: [...CLEANUP_ORDER], timeouts: { total: options.timeoutMs, ...options.timeouts },
  };
}

// ---------------------------------------------------------------- loader pin

export function sha256File(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function regularFileHash(file) {
  try {
    const info = fs.lstatSync(file);
    return info.isFile() && !info.isSymbolicLink() ? sha256File(file) : null;
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

export function inspectLoaderDirectory(dir, pin = FX_AUTOCONFIG_PIN) {
  const entries = fs.readdirSync(dir).sort();
  const files = {}, mismatches = [];
  for (const name of LOADER_UTILITY_FILES) {
    files[name] = regularFileHash(path.join(dir, name));
    if (files[name] !== pin.sha256[`profile/chrome/utils/${name}`]) mismatches.push(name);
  }
  const extra = entries.filter(name => !LOADER_UTILITY_FILES.includes(name));
  return { path: dir, commit: pin.commit, files, extra, mismatches,
    matchesPin: mismatches.length === 0 && extra.length === 0 };
}

export function firefoxInstallPaths(executable, platform = process.platform) {
  const resources = platform === 'darwin' ? path.join(path.dirname(path.dirname(executable)), 'Resources')
    : path.dirname(executable);
  return { resources, configJs: path.join(resources, 'config.js'),
    configPrefs: path.join(resources, 'defaults', 'pref', 'config-prefs.js'),
    applicationIni: path.join(resources, 'application.ini') };
}

export function inspectFirefoxInstall(executable, platform = process.platform, pin = FX_AUTOCONFIG_PIN) {
  let real = null;
  try { real = fs.realpathSync.native(executable); if (!fs.statSync(real).isFile()) real = null; }
  catch { real = null; }
  if (!real) return { executable, exists: false, version: null, bootstrap: null };
  const paths = firefoxInstallPaths(real, platform);
  let version = null;
  try { version = fs.readFileSync(paths.applicationIni, 'utf8').match(/^Version=(.+)$/m)?.[1]?.trim() || null; }
  catch { version = null; }
  const configJs = regularFileHash(paths.configJs), configPrefs = regularFileHash(paths.configPrefs);
  const mismatches = [];
  if (configJs !== pin.sha256['program/config.js']) mismatches.push('config.js');
  if (configPrefs !== pin.sha256['program/defaults/pref/config-prefs.js']) mismatches.push('config-prefs.js');
  return { executable: real, exists: true, version, bootstrap: { resources: paths.resources,
    present: !!configJs && !!configPrefs, matchesPin: mismatches.length === 0, mismatches,
    sha256: { 'config.js': configJs, 'config-prefs.js': configPrefs } } };
}

function gitSubcommand(args) {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-c') i++;
    else if (!args[i].startsWith('-')) return args[i];
  }
  return 'command';
}

function runGit(args, { cwd } = {}) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, windowsHide: true, timeout: 120000, maxBuffer: 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (error, stdout, stderr) => {
      if (error) reject(Object.assign(new Error(`git ${gitSubcommand(args)} failed: ${String(stderr || error.message).trim().slice(0, 300)}`), { cause: error }));
      else resolve({ stdout: String(stdout) });
    });
  });
}

// Same sequence as install.sh: shallow fetch of the exact commit, full fetch
// only when the server refuses that, then verify commit and every pinned file.
export async function fetchPinnedLoader({ url = FX_AUTOCONFIG_PIN.repository, dest, pin = FX_AUTOCONFIG_PIN, git = runGit }) {
  if (!path.isAbsolute(dest || '')) throw new Error('Pinned loader destination must be absolute');
  fs.mkdirSync(dest, { recursive: false, mode: 0o700 });
  await git(['-c', 'init.defaultBranch=main', 'init', '-q', dest]);
  await git(['config', 'core.autocrlf', 'false'], { cwd: dest });
  await git(['remote', 'add', 'origin', url], { cwd: dest });
  let route = 'shallow';
  try { await git(['fetch', '-q', '--depth=1', 'origin', pin.commit], { cwd: dest }); }
  catch { route = 'full'; await git(['fetch', '-q', 'origin'], { cwd: dest }); }
  await git(['-c', 'advice.detachedHead=false', 'checkout', '-q', pin.commit], { cwd: dest });
  const head = (await git(['rev-parse', 'HEAD'], { cwd: dest })).stdout.trim();
  if (head !== pin.commit) throw new Error(`fx-autoconfig HEAD ${head} is not the pinned ${pin.commit}`);
  const mismatches = Object.entries(pin.sha256).filter(([rel, hash]) => regularFileHash(path.join(dest, ...rel.split('/'))) !== hash).map(([rel]) => rel);
  const loaderSource = path.join(dest, 'profile', 'chrome', 'utils');
  const extra = fs.readdirSync(loaderSource).filter(name => !LOADER_UTILITY_FILES.includes(name));
  if (mismatches.length || extra.length) {
    throw new Error(`fx-autoconfig files differ from the pin: ${[...mismatches, ...extra.map(name => `extra:${name}`)].join(', ')}`);
  }
  return { dest, url, commit: head, route, loaderSource };
}

// ---------------------------------------------------------------- process helpers

export function trackProcess(name, child, limit = 256 * 1024) {
  let output = '', exit = null, settle;
  const append = chunk => { output = (output + String(chunk)).slice(-limit); };
  const exited = new Promise(resolve => { settle = resolve; });
  const done = (code, signal) => { if (!exit) { exit = { code, signal }; settle(exit); } };
  child.stdout?.on('data', append);
  child.stderr?.on('data', append);
  // A process that never started has no pid and may never emit 'exit'.
  child.on('error', error => { append(`\n[spawn error] ${error.message}\n`); if (!child.pid) done(null, null); });
  if (child.exitCode != null || child.signalCode != null) done(child.exitCode, child.signalCode);
  else child.once('exit', done);
  return { name, child, pid: child.pid, exited,
    get exit() { return exit; }, get running() { return !exit; }, get output() { return output; } };
}

// child_process emits 'spawn' (or 'error') on a later tick, after the caller
// has attached these listeners synchronously.
function waitForSpawn(child) {
  return new Promise((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
}

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new InterruptedError());
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(timer); reject(new InterruptedError()); };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function waitExit(handle, ms) {
  if (!handle.running) return true;
  let timer;
  const timeout = new Promise(resolve => { timer = setTimeout(() => resolve(false), ms); });
  const result = await Promise.race([handle.exited.then(() => true), timeout]);
  clearTimeout(timer);
  return result;
}

// Ends one process this run started: graceful route first, then SIGTERM to that
// process, then SIGKILL to its own process group (spawned detached on POSIX).
async function stopProcess(handle, { gracefulRequested, exitMs, signalProcess }) {
  if (!handle.running) return { via: gracefulRequested ? 'app-quit' : 'already-exited', exit: handle.exit };
  if (gracefulRequested && await waitExit(handle, exitMs)) return { via: 'app-quit', exit: handle.exit };
  await signalProcess(handle, 'SIGTERM', { group: false });
  if (await waitExit(handle, exitMs)) return { via: 'sigterm', exit: handle.exit };
  await signalProcess(handle, 'SIGKILL', { group: true });
  if (await waitExit(handle, exitMs)) return { via: 'sigkill', exit: handle.exit };
  return { via: 'not-exited', exit: null };
}

// ---------------------------------------------------------------- real dependencies

const QUIT_SOURCE = `() => {
  const services = globalThis.Services || ChromeUtils.importESModule('resource://gre/modules/Services.sys.mjs').Services;
  setTimeout(() => services.startup.quit(Ci.nsIAppStartup.eAttemptQuit), 50);
  return 'quit-requested';
}`;
const CONSOLE_ERRORS_SOURCE = `() => {
  const services = globalThis.Services || ChromeUtils.importESModule('resource://gre/modules/Services.sys.mjs').Services;
  const relevant = /eg-?desk|userchromejs|userChrome|chrome:\\/\\/userchrome/i;
  const quiet = Ci.nsIScriptError.warningFlag | Ci.nsIScriptError.infoFlag;
  const errors = [];
  for (const message of services.console.getMessageArray() || []) {
    if (!(message instanceof Ci.nsIScriptError) || (message.flags & quiet)) continue;
    const source = String(message.sourceName || ''), text = String(message.errorMessage || '');
    if (!relevant.test(source) && !relevant.test(text)) continue;
    errors.push({ source: source.slice(-160), line: message.lineNumber, message: text.slice(0, 300) });
  }
  return { count: errors.length, first: errors.slice(0, 5) };
}`;

function isPortFree(port) {
  return new Promise(resolve => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}

function isPortOpen(port) {
  return new Promise(resolve => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    const done = value => { socket.destroy(); resolve(value); };
    socket.setTimeout(1000, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

async function fetchJson(url, timeoutMs = 5000) {
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
  let body = null;
  try { body = await response.json(); } catch { body = null; }
  return { status: response.status, body };
}

function signalProcess(handle, signal, { group = false } = {}) {
  if (!handle?.running || !handle.pid) return false;
  if (process.platform === 'win32') {
    if (signal === 'SIGKILL') {
      execFile('taskkill', ['/PID', String(handle.pid), '/T', '/F'], { windowsHide: true }, () => {});
      return true;
    }
    return handle.child.kill(signal);
  }
  if (group) { try { process.kill(-handle.pid, signal); return true; } catch { /* fall back to the pid */ } }
  return handle.child.kill(signal);
}

async function connectHarness({ profile, marionettePort }) {
  const [{ FirefoxMcpChatHarness }, regression] = await Promise.all([
    import('./firefox-mcp-chat-harness.mjs'), import('./verify-firefox-mcp-headless-ui-regression.mjs')]);
  const harness = new FirefoxMcpChatHarness({ profile, marionettePort });
  try { await harness.connect(); }
  catch (error) { try { await harness.close(); } catch { /* keep the connect error */ } throw error; }
  return {
    profile: harness.profile,
    observeGuard: () => regression.observeGuard(harness),
    observeFirstUse: () => regression.observeFirstUse(harness),
    firstUseIssues: value => regression.initialFirstUseIssues(value),
    consoleErrors: () => harness.evaluateChrome(CONSOLE_ERRORS_SOURCE),
    requestQuit: () => harness.evaluateChrome(QUIT_SOURCE),
    close: () => harness.close(),
  };
}

export function realDependencies() {
  return {
    platform: process.platform, baseEnv: process.env, execPath: process.execPath,
    now: Date.now, isoNow: () => new Date().toISOString(), sleep: delay,
    createEvidenceDir: async () => (await import('./egdesk-qa-platform.mjs')).createPrivateQaTempDirectory('egdesk-clean-boot-'),
    inspectFirefox: executable => inspectFirefoxInstall(executable, process.platform),
    inspectMcpTools: async () => {
      const { CACHED_MCP_ENTRY, CACHED_GECKODRIVER } = await import('./firefox-mcp-chat-harness.mjs');
      const present = file => typeof file === 'string' && path.isAbsolute(file) && fs.existsSync(file);
      return { mcpEntry: present(CACHED_MCP_ENTRY), geckodriver: present(CACHED_GECKODRIVER) };
    },
    isPortFree, isPortOpen,
    fetchPinnedLoader: args => fetchPinnedLoader(args),
    inspectLoader: dir => inspectLoaderDirectory(dir),
    createProfile: async ({ loaderSource }) => (await import('./egdesk-chat-qa-profile.mjs')).bootstrapQaProfile({ loaderSource }),
    prepareIsolation: async created => {
      const paths = isolatedPaths(created.profile);
      for (const dir of [paths.codexHome, paths.exportDir]) fs.mkdirSync(dir, { mode: 0o700 });
      return { ...paths, dataDir: created.backendDataDir || paths.dataDir, contextRoot: created.realTurnCwd || paths.contextRoot };
    },
    spawn: (name, command, args, options) => spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }),
    fetchJson,
    listDir: dir => fs.readdirSync(dir),
    prepareFirefox: async (profile, options) => (await import('./run-firefox-mcp-target.mjs')).prepareQaFirefox(profile, options),
    fingerprintOverlay: async profile => (await import('./egdesk-chat-qa-profile.mjs')).qaProfileSourceFingerprints(profile),
    connectHarness, signalProcess,
    removeProfile: async profile => {
      const { assertQaProfile } = await import('./egdesk-chat-qa-profile.mjs');
      fs.rmSync(assertQaProfile(profile), { recursive: true });
    },
    writeFile: (file, text) => fs.writeFileSync(file, text, { flag: 'wx', mode: 0o600 }),
    gitHead: () => new Promise(resolve => execFile('git', ['rev-parse', 'HEAD'], { cwd: SCRIPT_DIR, windowsHide: true },
      (error, stdout) => resolve(error ? null : String(stdout).trim() || null))),
  };
}

// ---------------------------------------------------------------- runner

function check(receipt, id, passed, { required = true, details } = {}) {
  receipt.checks.push({ id, passed: !!passed, required, ...(details === undefined ? {} : { details }) });
  return !!passed;
}

async function pollUntil(read, accept, { deadline, d, signal, alive, label, intervalMs }) {
  let last, lastError = null;
  for (;;) {
    if (signal?.aborted) throw new InterruptedError();
    if (alive && !alive()) throw new Error(`${label}: process exited before it was ready`);
    try { last = await read(); lastError = null; if (accept(last)) return last; }
    catch (error) { if (error instanceof InterruptedError) throw error; lastError = error; }
    if (d.now() >= deadline) throw new Error(`${label}: timed out${lastError ? ` (${lastError.message})` : ''}`);
    await d.sleep(intervalMs, signal);
  }
}

function healthSubset(body) {
  if (!body || typeof body !== 'object') return null;
  return { ok: body.ok === true, port: body.port, appServerReady: !!body.appServerReady,
    chatStorageReady: !!body.chatStorageReady, profileStorageReady: !!body.profileStorageReady,
    deskStorageReady: !!body.deskStorageReady, node: body.node?.version ?? null };
}

// No account id or email is copied, even from a clean CODEX_HOME.
function stateSubset(body) {
  if (!body || typeof body !== 'object') return null;
  return { protocolVersion: body.protocolVersion ?? null, appServerReady: !!body.appServerReady,
    chatStorageReady: !!body.chatStorageReady, profileStorageReady: !!body.profileStorageReady,
    auth: { isLoggedIn: body.auth?.isLoggedIn ?? null, authMode: body.auth?.authMode ?? null },
    native: { version: body.native?.version ?? null, schemaMatch: body.native?.schemaMatch ?? null },
    bridgeBuild: body.bridge ?? null };
}

export async function runCleanProfileBoot(options, deps = {}, { signal, registry } = {}) {
  const d = { ...realDependencies(), ...deps };
  const timeouts = { ...DEFAULT_TIMEOUTS, ...options.timeouts };
  const started = d.now();
  const deadline = started + options.timeoutMs;
  const until = ms => Math.min(deadline, d.now() + ms);
  const receipt = {
    kind: RECEIPT_KIND, version: 1, ok: false, startedAt: d.isoNow(), finishedAt: null, durationMs: null,
    host: { platform: d.platform, arch: os.arch(), node: process.version },
    source: { gitHead: null, overlay: null },
    plan: null, loader: null, profile: { path: null, retained: true, removed: false },
    bridge: null, firefox: null, steps: [], checks: [], cleanup: [], logs: {},
    providerTurn: 'not-run', interrupted: false, error: null, evidenceDir: null, receiptPath: null,
  };
  const step = (id, status, details) => receipt.steps.push({ id, status, atMs: d.now() - started, ...(details ? { details } : {}) });
  const state = { bridge: null, firefox: null, harness: null, profile: null, paths: null, quitRequested: false };
  const track = (name, child) => { const handle = trackProcess(name, child); registry?.add(handle); return handle; };

  try {
    receipt.evidenceDir = await d.createEvidenceDir();
    receipt.source.gitHead = await d.gitHead?.() ?? null;
    receipt.plan = buildPlan(options, { evidenceDir: receipt.evidenceDir, execPath: d.execPath });

    // preflight: nothing is created or started if this fails.
    const firefox = d.inspectFirefox(options.firefoxBin);
    const tools = await d.inspectMcpTools();
    receipt.firefox = { executable: firefox.executable, version: firefox.version, headless: options.headless,
      marionettePort: options.marionettePort, remoteAgentPort: options.remoteAgentPort, bootstrap: firefox.bootstrap,
      pid: null, exit: null, headlessObserved: null };
    const pinRequired = !options.allowUnpinnedLoader;
    check(receipt, 'firefox-executable', firefox.exists, { details: { executable: firefox.executable } });
    check(receipt, 'firefox-bootstrap-present', !!firefox.bootstrap?.present, { details: { resources: firefox.bootstrap?.resources ?? null } });
    check(receipt, 'firefox-bootstrap-pinned', !!firefox.bootstrap?.matchesPin, { required: pinRequired, details: { mismatches: firefox.bootstrap?.mismatches ?? null } });
    check(receipt, 'mcp-tools-present', tools.mcpEntry && tools.geckodriver, { details: tools });
    if (receipt.checks.some(item => item.required && !item.passed)) {
      step('preflight', 'failed');
      throw new Error('Preflight failed: see checks (Firefox, its autoconfig bootstrap, Firefox MCP tools)');
    }
    step('preflight', 'done');

    const ports = [BRIDGE_PORT, APP_SERVER_PORT, options.marionettePort, options.remoteAgentPort];
    const busy = [];
    for (const port of ports) if (!await d.isPortFree(port)) busy.push(port);
    if (!check(receipt, 'ports-free-before', busy.length === 0, { details: { ports, busy } })) {
      step('ports', 'failed', { busy });
      throw new Error(`Port(s) ${busy.join(', ')} already in use; no existing process was stopped or attached to`);
    }
    step('ports', 'done');

    let loaderSource = options.loader.path, fetched = null;
    if (options.loader.kind === 'fetch') {
      fetched = await d.fetchPinnedLoader({ url: options.loader.url, dest: path.join(receipt.evidenceDir, 'fx-autoconfig') });
      loaderSource = fetched.loaderSource;
    }
    const loader = d.inspectLoader(loaderSource);
    receipt.loader = { kind: options.loader.kind, source: loaderSource, commit: FX_AUTOCONFIG_PIN.commit,
      fetched: fetched && { url: fetched.url, route: fetched.route, commit: fetched.commit },
      matchesPin: loader.matchesPin, mismatches: loader.mismatches, extra: loader.extra, files: loader.files };
    if (!check(receipt, 'loader-pinned', loader.matchesPin, { required: pinRequired,
      details: { mismatches: loader.mismatches, extra: loader.extra } }) && pinRequired) {
      step('loader', 'failed');
      throw new Error('Loader utilities are not fx-autoconfig dfdab56; use --fetch-pinned-loader or --allow-unpinned-loader');
    }
    step('loader', 'done');

    const created = await d.createProfile({ loaderSource });
    state.profile = created.profile;
    receipt.profile.path = created.profile;
    step('profile', 'done');
    state.paths = await d.prepareIsolation(created);
    step('isolate', 'done');

    const bridgeEnv = bridgeEnvironment(d.baseEnv, state.paths);
    const bridgeChild = d.spawn('bridge', d.execPath, [BRIDGE_ENTRY],
      { cwd: state.paths.contextRoot, env: bridgeEnv.env, detached: d.platform !== 'win32' });
    state.bridge = track('bridge', bridgeChild);
    await waitForSpawn(bridgeChild);
    receipt.bridge = { pid: bridgeChild.pid, port: BRIDGE_PORT, cwd: state.paths.contextRoot, env: bridgeEnv.isolated,
      strippedEnvKeys: bridgeEnv.stripped, health: null, state: null, exit: null };
    step('bridge', 'done', { pid: bridgeChild.pid });

    const health = await pollUntil(() => d.fetchJson(`http://127.0.0.1:${BRIDGE_PORT}/health`),
      value => value?.status === 200 && value.body?.ok === true && value.body.chatStorageReady
        && value.body.profileStorageReady && value.body.deskStorageReady,
      { deadline: until(timeouts.bridgeReadyMs), d, signal, alive: () => state.bridge.running,
        label: 'bridge /health', intervalMs: timeouts.pollMs });
    receipt.bridge.health = healthSubset(health.body);
    check(receipt, 'bridge-health', health.body.port === BRIDGE_PORT, { details: receipt.bridge.health });
    check(receipt, 'bridge-owned-process', state.bridge.running, { details: { pid: bridgeChild.pid } });
    const stateResponse = await d.fetchJson(`http://127.0.0.1:${BRIDGE_PORT}/v1/state`);
    receipt.bridge.state = stateSubset(stateResponse.body);
    let dataEntries = [];
    try { dataEntries = d.listDir(state.paths.dataDir); } catch { dataEntries = []; }
    check(receipt, 'bridge-isolated-data', ['chat', 'desk'].every(name => dataEntries.includes(name)),
      { details: { dataDir: state.paths.dataDir, entries: dataEntries.slice(0, 20) } });
    check(receipt, 'bridge-logged-out', stateResponse.status === 200 && receipt.bridge.state?.auth.isLoggedIn === false,
      { details: { status: stateResponse.status, auth: receipt.bridge.state?.auth ?? null } });
    check(receipt, 'bridge-app-server-ready', receipt.bridge.state?.appServerReady, { required: false });
    step('bridge-ready', 'done');

    await d.prepareFirefox(state.profile, { mode: 'automation', marionette: options.marionettePort, remote: options.remoteAgentPort });
    try { receipt.source.overlay = await d.fingerprintOverlay(state.profile); }
    catch (error) { receipt.source.overlay = { error: error.message }; }
    step('firefox-prepare', 'done');

    const args = firefoxArguments({ profile: state.profile, ...options });
    const firefoxChild = d.spawn('firefox', firefox.executable, args,
      { env: firefoxEnvironment(d.baseEnv), detached: d.platform !== 'win32' });
    state.firefox = track('firefox', firefoxChild);
    await waitForSpawn(firefoxChild);
    receipt.firefox.pid = firefoxChild.pid;
    receipt.firefox.args = args;
    step('firefox', 'done', { pid: firefoxChild.pid });

    await pollUntil(() => d.isPortOpen(options.marionettePort), Boolean,
      { deadline: until(timeouts.marionetteMs), d, signal, alive: () => state.firefox.running,
        label: `Marionette ${options.marionettePort}`, intervalMs: timeouts.pollMs });
    state.harness = await d.connectHarness({ profile: state.profile, marionettePort: options.marionettePort });
    check(receipt, 'firefox-profile-bound', state.harness.profile === state.profile, { details: { profile: state.harness.profile } });
    const guard = await pollUntil(() => state.harness.observeGuard(), value => value?.mounted === true,
      { deadline: until(timeouts.mountMs), d, signal, alive: () => state.firefox.running,
        label: 'Desk mount', intervalMs: timeouts.pollMs });
    receipt.firefox.headlessObserved = guard.headless ?? null;
    check(receipt, 'overlay-mounted', guard.documentURI === 'chrome://browser/content/browser.xhtml' && guard.mounted,
      { details: { documentURI: guard.documentURI } });
    check(receipt, 'ui-logged-out', !guard.loggedIn && !guard.accountBound,
      { details: { loggedIn: !!guard.loggedIn, accountBound: !!guard.accountBound } });
    try {
      const firstUse = await state.harness.observeFirstUse();
      const issues = state.harness.firstUseIssues(firstUse);
      check(receipt, 'first-use-browser', issues.length === 0, { required: false,
        details: { issues, mode: firstUse?.mode ?? null, browserCount: firstUse?.browserCount ?? null } });
    } catch (error) { check(receipt, 'first-use-browser', false, { required: false, details: { error: error.message } }); }
    try {
      const errors = await state.harness.consoleErrors();
      check(receipt, 'overlay-console-errors', errors?.count === 0, { required: false, details: errors });
    } catch (error) { check(receipt, 'overlay-console-errors', false, { required: false, details: { error: error.message } }); }
    step('confirm', 'done');
  } catch (error) {
    if (error instanceof InterruptedError || signal?.aborted) receipt.interrupted = true;
    receipt.error = error.message;
    const last = STEP_ORDER.find(id => !receipt.steps.some(item => item.id === id));
    if (last && !receipt.steps.some(item => item.status === 'failed')) step(last, 'failed');
  } finally {
    await cleanup({ receipt, state, options, timeouts, d });
    receipt.finishedAt = d.isoNow();
    receipt.durationMs = d.now() - started;
    const requiredPassed = receipt.checks.every(item => item.passed || !item.required);
    const cleanupClean = receipt.cleanup.every(item => item.status !== 'failed');
    receipt.ok = !receipt.error && !receipt.interrupted && requiredPassed && cleanupClean
      && receipt.steps.some(item => item.id === 'confirm' && item.status === 'done');
    if (receipt.ok && options.removeProfileOnPass && state.profile) {
      try { await d.removeProfile(state.profile); receipt.profile.removed = true; receipt.profile.retained = false;
        receipt.cleanup.find(item => item.id === 'remove-profile').status = 'done'; }
      catch (error) { receipt.cleanup.find(item => item.id === 'remove-profile').status = 'failed';
        receipt.cleanup.find(item => item.id === 'remove-profile').detail = error.message; receipt.ok = false; }
    }
    if (receipt.evidenceDir) {
      for (const handle of [state.bridge, state.firefox].filter(Boolean)) {
        const file = path.join(receipt.evidenceDir, `${handle.name}.log`);
        try { d.writeFile(file, handle.output); receipt.logs[handle.name] = file; }
        catch (error) { receipt.logs[handle.name] = { error: error.message }; }
      }
      receipt.receiptPath = path.join(receipt.evidenceDir, RECEIPT_FILE);
      try { d.writeFile(receipt.receiptPath, `${JSON.stringify(receipt, null, 2)}\n`); }
      catch (error) { receipt.receiptPath = null; receipt.receiptError = error.message; receipt.ok = false; }
    }
  }
  return receipt;
}

async function cleanup({ receipt, state, options, timeouts, d }) {
  const record = (id, status, detail) => receipt.cleanup.push({ id, status, ...(detail === undefined ? {} : { detail }) });
  const signalProcess = (handle, sig, opts) => d.signalProcess(handle, sig, opts);
  // 1. ask Firefox to quit through its own app-startup service
  if (state.harness && state.firefox?.running) {
    try { await state.harness.requestQuit(); state.quitRequested = true; record('request-firefox-quit', 'done'); }
    catch (error) { record('request-firefox-quit', 'failed', error.message); }
  } else record('request-firefox-quit', 'skipped');
  // 2. end the MCP transport (it never signals Firefox itself)
  if (state.harness) {
    try { await state.harness.close(); record('close-mcp', 'done'); }
    catch (error) { record('close-mcp', 'failed', error.message); }
  } else record('close-mcp', 'skipped');
  // 3. Firefox before the bridge
  if (state.firefox) {
    const result = await stopProcess(state.firefox, { gracefulRequested: state.quitRequested, exitMs: timeouts.exitMs, signalProcess });
    receipt.firefox.exit = { via: result.via, code: result.exit?.code ?? null, signal: result.exit?.signal ?? null };
    record('stop-firefox', result.via === 'not-exited' ? 'failed' : 'done', result.via);
    check(receipt, 'firefox-graceful-exit', result.via === 'app-quit', { details: receipt.firefox.exit });
  } else record('stop-firefox', 'skipped');
  // 4. bridge: SIGTERM runs its own shutdown (stores closed, app-server ended)
  if (state.bridge) {
    const result = await stopProcess(state.bridge, { gracefulRequested: false, exitMs: timeouts.exitMs, signalProcess });
    receipt.bridge.exit = { via: result.via, code: result.exit?.code ?? null, signal: result.exit?.signal ?? null };
    record('stop-bridge', result.via === 'not-exited' ? 'failed' : 'done', result.via);
    check(receipt, 'bridge-graceful-exit', result.via === 'sigterm' && result.exit?.code === 0,
      { required: d.platform !== 'win32', details: receipt.bridge.exit });
  } else record('stop-bridge', 'skipped');
  // 5. every port this run used is free again
  if (state.bridge || state.firefox) {
    const ports = [BRIDGE_PORT, APP_SERVER_PORT, options.marionettePort, options.remoteAgentPort];
    const stopAt = d.now() + timeouts.portsMs;
    let busy = ports;
    for (;;) {
      busy = [];
      for (const port of ports) if (!await d.isPortFree(port)) busy.push(port);
      if (!busy.length || d.now() >= stopAt) break;
      await d.sleep(timeouts.pollMs);
    }
    record('verify-ports-released', busy.length ? 'failed' : 'done', busy.length ? { busy } : undefined);
    check(receipt, 'ports-released', busy.length === 0, { details: { ports, busy } });
  } else record('verify-ports-released', 'skipped');
  // 6. decided after the verdict (see runCleanProfileBoot)
  record('remove-profile', 'skipped');
}

// ---------------------------------------------------------------- CLI

export async function main(argv = process.argv.slice(2), { stdout = process.stdout, stderr = process.stderr } = {}) {
  let options;
  try { options = parseCli(argv); }
  catch (error) { stderr.write(`${error.message}\n`); return 2; }
  if (options.help) { stdout.write(`${options.usage}\n`); return 0; }
  if (options.planOnly) { stdout.write(`${JSON.stringify(buildPlan(options), null, 2)}\n`); return 0; }
  const controller = new AbortController(), registry = new Set();
  let signals = 0;
  const onSignal = () => {
    signals += 1;
    if (signals === 1) { stderr.write('Stopping: cleanup is running (send again to force)\n'); controller.abort(); return; }
    for (const handle of registry) signalProcess(handle, 'SIGKILL', { group: true });
    process.exit(130);
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  try {
    const receipt = await runCleanProfileBoot(options, {}, { signal: controller.signal, registry });
    stdout.write(`${JSON.stringify(receipt)}\n`);
    return receipt.ok ? 0 : 1;
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
