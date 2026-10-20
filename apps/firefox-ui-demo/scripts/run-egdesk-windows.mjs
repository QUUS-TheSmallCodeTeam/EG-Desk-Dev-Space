#!/usr/bin/env node
// Normal Windows launcher for the existing dedicated EG-Desk profile.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { isBuiltin } from 'node:module';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveCodexExecutable } from '../helper/egdesk-native-capabilities.mjs';
import { isOwnedAndPrivate } from '../helper/egdesk-private-files.mjs';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const appRoot = fileURLToPath(new URL('../', import.meta.url));
const bridgeEntry = path.join(appRoot, 'helper', 'codex-bridge-server.mjs');
const MANAGED = '// EG-Desk normal Windows launch preferences.';
const info = target => { try { return fs.lstatSync(target); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };
const within = (root, target) => target === root || target.startsWith(root + path.sep);
const samePath = (a, b) => typeof a === 'string' && typeof b === 'string'
  && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

export function normalFirefoxPreferences() {
  return new Map([
    ['toolkit.legacyUserProfileCustomizations.stylesheets', true],
    ['devtools.debugger.remote-enabled', false],
    ['devtools.debugger.prompt-connection', true],
    ['devtools.debugger.force-local', true],
    ['devtools.chrome.enabled', false],
    ['marionette.enabled', false],
    ['termsofuse.bypassNotification', false],
    ['widget.windows.window_occlusion_tracking.enabled', true],
    ['browser.shell.checkDefaultBrowser', false],
  ]);
}

export function mergeNormalPreferences(original) {
  const managed = normalFirefoxPreferences();
  const retained = original.split(/\r?\n/).filter(line => {
    if (line === MANAGED) return false;
    const key = line.match(/^\s*user_pref\(\s*["']([^"']+)["']\s*,/);
    return !key || !managed.has(key[1]);
  }).join('\n').replace(/\n*$/, '');
  return (retained ? retained + '\n\n' : '') + MANAGED + '\n' + [...managed]
    .map(([key, value]) => 'user_pref(' + JSON.stringify(key) + ', ' + JSON.stringify(value) + ');').join('\n') + '\n';
}

export function normalChildEnvironment(env, { dataDir, codex, root }) {
  const clean = Object.fromEntries(Object.entries(env).filter(([key]) =>
    !/^(?:EGDESK_QA_|EGDESK_BROWSER_FIXTURE_QA(?:_|$)|MOZ_REMOTE_ALLOW_SYSTEM_ACCESS$|MOZ_MARIONETTE$|EGDESK_MARIONETTE_PORT$|EGDESK_FIREFOX_PROFILE$|EGDESK_DATA_DIR$|EGDESK_CONTEXT_ROOTS$|EGDESK_CODEX_BIN$|EGDESK_CODEX_MODEL$|EGDESK_CODEX_EFFORT$|EGDESK_CODEX_DISABLE_MEMORIES$)/i.test(key)));
  return { ...clean, EGDESK_DATA_DIR: dataDir, EGDESK_CONTEXT_ROOTS: root,
    EGDESK_CODEX_BIN: codex, EGDESK_CODEX_DISABLE_MEMORIES: '1' };
}

export function persistentProfilePath(env = process.env) {
  return path.join(env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
    'Mozilla', 'Firefox', 'Profiles', 'egdesk-windows-poc');
}

export function requestedNormalProfile(args, expected = persistentProfilePath()) {
  if (args.length === 0) return expected;
  if (args.length === 2 && args[0] === '--profile' && args[1] === expected) return expected;
  throw new Error('Use no arguments or --profile with the exact dedicated egdesk-windows-poc path');
}

export function assertPersistentProfile(profile, { expected = persistentProfilePath(),
  temporaryRoot = os.tmpdir(), fileSystem = fs } = {}) {
  if (typeof profile !== 'string' || !path.isAbsolute(profile) || /[\r\n\0]/.test(profile)
      || path.resolve(profile) !== profile || profile !== expected) {
    throw new Error('Only the existing dedicated egdesk-windows-poc profile may be launched');
  }
  const stat = fileSystem.lstatSync(profile);
  if (!stat.isDirectory() || stat.isSymbolicLink() || fileSystem.realpathSync.native(profile) !== profile
      || within(path.resolve(temporaryRoot), profile) || path.basename(profile).startsWith('egdesk-chat-test-')) {
    throw new Error('The dedicated profile must be persistent, canonical and not linked or temporary');
  }
  return profile;
}

export function safeDestination(target, root) {
  if (!within(root, target) || target === root) throw new Error('Managed destination escaped its dedicated directory');
  for (let current = target; current !== root; current = path.dirname(current)) {
    const stat = info(current);
    if (stat && (stat.isSymbolicLink() || fs.realpathSync.native(current) !== current
        || (stat.isFile() && stat.nlink !== 1))) throw new Error('Linked managed destination refused: ' + current);
  }
  return info(target);
}

function powershell(script, extra = {}) {
  const executable = path.join(process.env.SystemRoot || 'C:\\Windows',
    'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return execFileSync(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
    { encoding: 'utf8', windowsHide: true, timeout: 10000,
      env: { ...process.env, PSModulePath: path.join(path.dirname(executable), 'Modules'), ...extra } }).trim();
}

export function windowsLockProbe(target) {
  return powershell("$ErrorActionPreference='Stop';try{$f=[IO.File]::Open($env:EGDESK_NORMAL_LOCK,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None);$f.Dispose();'unlocked'}catch [IO.IOException]{if(($_.Exception.HResult -band 65535) -in @(32,33)){'locked'}else{throw}}",
    { EGDESK_NORMAL_LOCK: target });
}

export function profileIsRunning(profile, probe = windowsLockProbe) {
  for (const name of ['parent.lock', '.parentlock', 'lock']) {
    const target = path.join(profile, name), stat = info(target);
    if (!stat) continue;
    if (name !== 'parent.lock' || !stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
      throw new Error('Unsafe or unexpected Firefox profile lock');
    }
    const result = probe(target);
    if (result === 'locked') return true;
    if (result !== 'unlocked') throw new Error('Firefox profile lock status could not be verified');
  }
  return false;
}

function writeManaged(target, content, root) {
  const stat = safeDestination(target, root);
  if (stat && !stat.isFile()) throw new Error('Managed file is not a regular file');
  const temporary = target + '.egdesk-' + process.pid + '-' + Date.now() + '.tmp';
  safeDestination(temporary, root);
  try {
    fs.writeFileSync(temporary, content, { flag: 'wx', mode: 0o600 });
    safeDestination(target, root);
    fs.renameSync(temporary, target);
  } finally { if (info(temporary)) fs.unlinkSync(temporary); }
}

export function synchronizeProfile(profile, { locked = profileIsRunning, overlay = path.join(appRoot, 'overlay') } = {}) {
  if (locked(profile)) return false;
  const chrome = path.join(profile, 'chrome');
  const chromeInfo = safeDestination(chrome, profile);
  if (!chromeInfo?.isDirectory()) throw new Error('Existing EG-Desk chrome/loader directory is required');
  // Preflight every source/destination before performing any overlay write.
  function preflight(source, destination) {
    const sourceInfo = fs.lstatSync(source);
    if (sourceInfo.isSymbolicLink() || (!sourceInfo.isFile() && !sourceInfo.isDirectory())) {
      throw new Error('Linked or non-regular overlay source refused');
    }
    const destinationInfo = safeDestination(destination, profile);
    if (destinationInfo && sourceInfo.isDirectory() !== destinationInfo.isDirectory()) {
      throw new Error('Overlay source/destination type mismatch');
    }
    if (sourceInfo.isDirectory()) for (const name of fs.readdirSync(source)) {
      preflight(path.join(source, name), path.join(destination, name));
    }
  }
  for (const name of ['JS', 'CSS', 'resources']) preflight(path.join(overlay, name), path.join(chrome, name));
  const user = path.join(profile, 'user.js'), css = path.join(chrome, 'userChrome.css');
  for (const target of [user, css]) {
    const stat = safeDestination(target, profile);
    if (stat && !stat.isFile()) throw new Error('A managed profile file is not regular');
  }
  if (locked(profile)) return false;
  for (const name of ['JS', 'CSS', 'resources']) {
    if (locked(profile)) throw new Error('Firefox started during overlay synchronization; retry after closing it');
    fs.cpSync(path.join(overlay, name), path.join(chrome, name), { recursive: true, filter(source, destination) {
      preflight(source, destination);
      return true;
    } });
    if (locked(profile)) throw new Error('Firefox started during overlay synchronization; retry after closing it');
  }
  if (locked(profile)) throw new Error('Firefox started before preference synchronization');
  writeManaged(user, mergeNormalPreferences(info(user) ? fs.readFileSync(user, 'utf8') : ''), profile);
  const imports = fs.readdirSync(path.join(overlay, 'CSS')).filter(name => name.endsWith('.uc.css')).sort();
  const original = info(css) ? fs.readFileSync(css, 'utf8') : '';
  const retained = original.split(/\r?\n/).filter(line => !imports.some(name =>
    /^\s*@import\b/.test(line) && (line.includes('"CSS/' + name + '"') || line.includes("'CSS/" + name + "'")))).join('\n');
  writeManaged(css, imports.map(name => '@import url(' + JSON.stringify('CSS/' + name) + ');').join('\n')
    + '\n' + retained.replace(/^\n+/, ''), profile);
  return true;
}

export function assertHealthyBridge(health, state) {
  if (!health || health.ok !== true || health.fixture === true || health.port !== 39218
      || health.appServerReady !== true || health.chatStorageReady !== true
      || health.native?.schemaMatch !== true || health.native?.qaReadOnly !== true
      || health.memoryIsolation?.status !== 'verified-disabled'
      || state?.provider !== 'codex' || state.protocolVersion !== 1
      || state.appServerReady !== true || state.chatStorageReady !== true
      || state.native?.contractFingerprint !== health.native.contractFingerprint
      || !/^[a-f0-9]{64}$/.test(health.native.contractFingerprint || '')) {
    throw new Error('Port 39218 does not expose a ready compatible EG-Desk production bridge');
  }
  return true;
}

export function validateBridgeReceipt(receipt, identity, { root, dataDir, node, entry = bridgeEntry }) {
  return receipt?.kind === 'egdesk-normal-windows-bridge-v1' && Number.isInteger(receipt.pid)
    && identity?.pid === receipt.pid && typeof receipt.startTime === 'string'
    && identity.startTime === receipt.startTime && samePath(receipt.repoRoot, root)
    && samePath(receipt.dataDir, dataDir) && samePath(receipt.node, node)
    && samePath(identity.executable, node) && typeof identity.commandLine === 'string'
    && identity.commandLine.toLowerCase().includes(entry.toLowerCase());
}

function windowsProcessIdentity(pid = null) {
  if (pid != null && (!Number.isSafeInteger(pid) || pid < 1)) throw new Error('Invalid launcher process identity');
  const script = "$ErrorActionPreference='Stop';$p=$null;"
    + (pid == null
      ? "$owners=@(Get-NetTCPConnection -LocalPort 39218 -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique);if($owners.Count -eq 1){$p=Get-CimInstance Win32_Process -Filter ('ProcessId='+$owners[0])}elseif($owners.Count -gt 1){throw 'Ambiguous bridge port owner'};"
      : "$p=Get-CimInstance Win32_Process -Filter ('ProcessId='+$env:EGDESK_NORMAL_PID);")
    + "if($null -eq $p){'null'}else{[pscustomobject]@{pid=[int]$p.ProcessId;startTime=$p.CreationDate.ToUniversalTime().ToString('o');executable=$p.ExecutablePath;commandLine=$p.CommandLine}|ConvertTo-Json -Compress}";
  return JSON.parse(powershell(script, pid == null ? {} : { EGDESK_NORMAL_PID: String(pid) }));
}

async function readBridge(fetchImpl = fetch) {
  const get = async route => {
    const response = await fetchImpl('http://127.0.0.1:39218' + route,
      { redirect: 'error', signal: AbortSignal.timeout(1800) });
    if (!response.ok) throw new Error('Unexpected bridge HTTP status');
    const text = await response.text();
    if (text.length > 1024 * 1024) throw new Error('Bridge metadata exceeded its bound');
    return JSON.parse(text);
  };
  const [health, state] = await Promise.all([get('/health'), get('/v1/state')]);
  assertHealthyBridge(health, state);
  return { health, state };
}

export async function waitForHealthyBridge({ read = readBridge, now = Date.now,
  pause = ms => new Promise(resolve => setTimeout(resolve, ms)), timeoutMs = 45000 } = {}) {
  const deadline = now() + timeoutMs;
  let lastError;
  do {
    try { return await read(); } catch (error) { lastError = error; }
    if (now() >= deadline) break;
    await pause(Math.min(600, deadline - now()));
  } while (now() < deadline);
  throw new Error('EG-Desk bridge did not become ready within ' + timeoutMs + 'ms: ' + (lastError?.message || 'offline'));
}

async function requireFreePort(port) {
  await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', () => reject(new Error('Required EG-Desk port ' + port + ' is occupied; no existing process was stopped')));
    server.listen(port, '127.0.0.1', () => server.close(resolve));
  });
}

function resolveInstalledCodex(env) {
  let executable;
  try { executable = resolveCodexExecutable(env); } catch {}
  const temporary = candidate => candidate && (within(path.resolve(os.tmpdir()), candidate)
    || within(path.join(repoRoot, '.tmp'), candidate));
  if (temporary(executable)) executable = null;
  if (!executable) try { executable = resolveCodexExecutable({ ...env, EGDESK_CODEX_BIN: '' }); } catch {}
  if (temporary(executable)) executable = null;
  const nativeDirectory = path.join(env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'OpenAI', 'Codex', 'bin');
  if (!executable && info(nativeDirectory)?.isDirectory()) {
    executable = fs.readdirSync(nativeDirectory).map(name => path.join(nativeDirectory, name, 'codex.exe'))
      .filter(item => info(item)?.isFile()).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
  }
  if (!executable || !path.isAbsolute(executable) || path.basename(executable).toLowerCase() !== 'codex.exe'
      || !info(executable)?.isFile() || temporary(executable)) throw new Error('An installed native Codex executable is required; QA tool copies are refused');
  return fs.realpathSync.native(executable);
}

export function ensureStorage(directory) {
  for (let target = directory; target !== path.dirname(target); target = path.dirname(target)) {
    const stat = info(target);
    if (stat && (stat.isSymbolicLink() || !stat.isDirectory() || fs.realpathSync.native(target) !== target)) {
      throw new Error('Linked or unsafe persistent launcher storage refused');
    }
  }
  if (!info(directory)) {
    // Apply the private descriptor at creation. Never tighten an existing
    // user directory or inherit LocalAppData's broader read permissions.
    powershell(`$ErrorActionPreference='Stop';
$target=$env:EGDESK_NORMAL_STORAGE;
if(Test-Path -LiteralPath $target){throw 'Storage was created concurrently; retry'};
$self=[Security.Principal.WindowsIdentity]::GetCurrent().User;
$acl=New-Object Security.AccessControl.DirectorySecurity;
$acl.SetAccessRuleProtection($true,$false);$acl.SetOwner($self);
foreach($sid in @($self.Value,'S-1-5-18','S-1-5-32-544')){
$rule=New-Object Security.AccessControl.FileSystemAccessRule([Security.Principal.SecurityIdentifier]$sid,[Security.AccessControl.FileSystemRights]::FullControl,([Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit),[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow);
$acl.AddAccessRule($rule)};
[void][IO.Directory]::CreateDirectory($target,$acl);`, { EGDESK_NORMAL_STORAGE: directory });
  }
  const canonical = fs.realpathSync.native(directory);
  if (!isOwnedAndPrivate(canonical, fs.lstatSync(canonical), 0o077)) {
    throw new Error('Persistent launcher storage must already be private to this user');
  }
  return canonical;
}

async function detached(executable, args, env, cwd, output) {
  const fd = fs.openSync(output, 'a', 0o600);
  try {
    const child = spawn(executable, args, { env, cwd, detached: true, windowsHide: true,
      shell: false, stdio: ['ignore', fd, fd] });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    child.unref();
    return child.pid;
  } finally { fs.closeSync(fd); }
}

export async function launchNormalWindows({ args = process.argv.slice(2) } = {}) {
  if (process.platform !== 'win32' || Number(process.versions.node.split('.')[0]) < 24 || !isBuiltin('node:sqlite')) {
    throw new Error('This EG-Desk launcher requires Windows and Node.js 24+ with node:sqlite');
  }
  const dataDir = ensureStorage(path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'EG-Desk'));
  const logs = ensureStorage(path.join(dataDir, 'logs'));
  const logPath = path.join(logs, 'windows-launcher.log');
  safeDestination(logPath, dataDir);
  const log = (event, message = '') => fs.appendFileSync(logPath,
    JSON.stringify({ at: new Date().toISOString(), event, message }) + '\n', { mode: 0o600 });
  let claim = null;
  try {
    const profile = assertPersistentProfile(requestedNormalProfile(args));
    if (profileIsRunning(profile)) { log('already-running'); return { status: 'already-running', profile }; }
    const firefox = path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Mozilla Firefox', 'firefox.exe');
    if (!info(firefox)?.isFile()) throw new Error('Installed Firefox was not found');
    const claimPath = path.join(logs, 'windows-launch-in-progress.json');
    safeDestination(claimPath, dataDir);
    if (info(claimPath)) {
      const previous = JSON.parse(fs.readFileSync(claimPath, 'utf8'));
      const owner = windowsProcessIdentity(previous.pid);
      if (owner?.startTime === previous.startTime && samePath(owner.executable, process.execPath)) {
        log('launch-in-progress'); return { status: 'launch-in-progress', profile };
      }
      fs.unlinkSync(claimPath);
    }
    const self = windowsProcessIdentity(process.pid);
    if (!self?.startTime) throw new Error('Launcher process identity could not be verified');
    claim = { path: claimPath, bytes: JSON.stringify({ pid: process.pid, startTime: self.startTime }) };
    try { fs.writeFileSync(claim.path, claim.bytes, { flag: 'wx', mode: 0o600 }); }
    catch (error) {
      claim = null;
      if (error.code === 'EEXIST') { log('launch-in-progress'); return { status: 'launch-in-progress', profile }; }
      throw error;
    }
    const root = fs.realpathSync.native(repoRoot);
    const codex = resolveInstalledCodex(process.env);
    const env = normalChildEnvironment(process.env, { dataDir, codex, root });
    const receiptPath = path.join(logs, 'windows-bridge-receipt.json');
    safeDestination(receiptPath, dataDir);
    const expected = { root, dataDir, node: fs.realpathSync.native(process.execPath) };
    const owner = windowsProcessIdentity();
    if (owner) {
      const receipt = info(receiptPath) ? JSON.parse(fs.readFileSync(receiptPath, 'utf8')) : null;
      if (!validateBridgeReceipt(receipt, owner, expected)) throw new Error('An existing bridge is not owned by this persistent launcher; close it separately before launching EG-Desk');
      await waitForHealthyBridge();
      log('reused-owned-bridge');
    } else {
      await Promise.all([requireFreePort(39218), requireFreePort(39219)]);
      const output = path.join(logs, 'codex-bridge.log');
      safeDestination(output, dataDir);
      const pid = await detached(process.execPath, [bridgeEntry], env, root, output);
      const identity = windowsProcessIdentity(pid);
      if (!identity?.startTime) throw new Error('Started bridge identity is unavailable; inspect codex-bridge.log');
      writeManaged(receiptPath, JSON.stringify({ kind: 'egdesk-normal-windows-bridge-v1',
        pid, startTime: identity.startTime, repoRoot: root, dataDir, node: expected.node }) + '\n', dataDir);
      await waitForHealthyBridge();
      const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
      if (!validateBridgeReceipt(receipt, windowsProcessIdentity(), expected)) throw new Error('Ready bridge port belongs to another process');
      log('started-owned-bridge');
    }
    if (profileIsRunning(profile) || !synchronizeProfile(profile)) {
      log('already-running'); return { status: 'already-running', profile };
    }
    if (profileIsRunning(profile)) { log('already-running'); return { status: 'already-running', profile }; }
    const output = path.join(logs, 'firefox.log');
    safeDestination(output, dataDir);
    const pid = await detached(firefox, ['-profile', profile, '--no-remote', '--purgecaches', 'about:blank'],
      env, root, output);
    log('launched-firefox');
    return { status: 'launched', profile, pid, logPath };
  } catch (error) {
    log('failed', error.message);
    throw new Error(error.message + ' (log: ' + logPath + ')');
  } finally {
    if (claim && info(claim.path) && fs.readFileSync(claim.path, 'utf8') === claim.bytes) fs.unlinkSync(claim.path);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  launchNormalWindows().then(result => process.stdout.write(JSON.stringify(result) + '\n'))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
