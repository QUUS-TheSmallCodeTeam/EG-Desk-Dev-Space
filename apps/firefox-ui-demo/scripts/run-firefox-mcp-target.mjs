#!/usr/bin/env node
// Portable launcher for newly isolated QA profiles, not personal profiles.
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assertQaProfile, assertQaFixtureManifest } from './egdesk-chat-qa-profile.mjs';
import { isOwnedAndPrivate } from './egdesk-qa-platform.mjs';
import { qaBridgeConfig, assertFreshQaFixtureProfile, assertQaProfileBridge,
  materializeQaFixtureIsolation, QA_ISOLATION_MANIFEST } from './egdesk-qa-fixture-isolation.mjs';

function existingInfo(target) {
  try { return fs.lstatSync(target); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function safeDestination(target, profile) {
  if (!target.startsWith(profile + path.sep)) throw new Error('QA destination escaped its profile');
  for (let current = target; current !== profile; current = path.dirname(current)) {
    const info = existingInfo(current);
    if (info && (info.isSymbolicLink() || fs.realpathSync.native(current) !== current
        || (info.isFile() && info.nlink !== 1))) throw new Error('Linked QA destination refused');
  }
  return existingInfo(target);
}

function refuseLockedProfile(profile) {
  for (const name of ['parent.lock', '.parentlock', 'lock']) {
    const target = path.join(profile, name), info = existingInfo(target);
    if (!info) continue;
    if (process.platform !== 'win32' || name !== 'parent.lock' || !info.isFile() || info.isSymbolicLink()) {
      throw new Error('Refusing to prepare a locked QA profile');
    }
    // Windows keeps parent.lock after shutdown. An exclusive, open-existing
    // handle distinguishes that closed file from an active Firefox lock.
    const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const locked = execFileSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      "$ErrorActionPreference='Stop';try{$f=[IO.File]::Open($env:EGDESK_QA_LOCK,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None);$f.Dispose();'unlocked'}catch [IO.IOException]{'locked'}"],
    { encoding: 'utf8', windowsHide: true, timeout: 10000, env: { ...process.env, EGDESK_QA_LOCK: target } }).trim();
    if (locked !== 'unlocked') throw new Error('Refusing to prepare a locked QA profile');
  }
}

export function qaAutomationPorts(marionette = 2828, remote = 6000) {
  const valid = value => /^[1-9][0-9]{0,4}$/.test(String(value)) && Number(value) <= 65535;
  if (![2828, 2829, 28831, 28832, 28833].includes(Number(marionette)) || !valid(remote) || Number(remote) === Number(marionette)) {
    throw new Error('QA requires Marionette 2828/2829/28831/28832/28833 and a distinct valid remote-agent port');
  }
  return { marionette: Number(marionette), remote: Number(remote) };
}

export function qaFirefoxPreferences({ mode = 'automation', marionette = 2828, remote = 6000 } = {}) {
  if (!['automation', 'normal'].includes(mode)) throw new Error('Expected normal or automation mode');
  const ports = qaAutomationPorts(marionette, remote), automation = mode === 'automation';
  return new Map([
    ['toolkit.legacyUserProfileCustomizations.stylesheets', true],
    ['devtools.debugger.remote-enabled', automation], ['devtools.debugger.remote-port', ports.remote],
    ['devtools.debugger.prompt-connection', !automation], ['devtools.chrome.enabled', true],
    ['devtools.debugger.remote-host', '127.0.0.1'],
    ['marionette.enabled', automation], ['marionette.port', ports.marionette],
    ['remote.prefs.recommended', false], ['browser.shell.checkDefaultBrowser', false],
    ['browser.aboutwelcome.enabled', false], ['browser.startup.homepage_override.mstone', 'ignore'],
    ['startup.homepage_welcome_url', ''], ['startup.homepage_welcome_url.additional', ''],
    ['datareporting.policy.dataSubmissionEnabled', false],
    // Same test-only notification preference as Mozilla's automation defaults;
    // do not write acceptedVersion/acceptedDate or enterprise acceptance policy.
    ['termsofuse.bypassNotification', automation],
    ['widget.windows.window_occlusion_tracking.enabled', !automation],
  ]);
}

export function prepareQaFirefox(profilePath, options = {}) {
  const env = options.env || process.env;
  const bridge = qaBridgeConfig(env);
  const profile = assertQaProfile(profilePath);
  assertQaFixtureManifest(profile);
  refuseLockedProfile(profile);
  if (bridge.fixture) {
    assertFreshQaFixtureProfile(profile);
    const ports = qaAutomationPorts(options.marionette, options.remote);
    if ([ports.marionette, ports.remote].includes(bridge.port)) throw new Error('Fixture and automation ports must be distinct');
  }
  if (existingInfo(path.join(profile, QA_ISOLATION_MANIFEST))) assertQaProfileBridge(profile, env);
  const managed = qaFirefoxPreferences(options), target = path.join(profile, 'user.js');
  const userInfo = safeDestination(target, profile);
  if (userInfo && (!userInfo.isFile() || !isOwnedAndPrivate(target, userInfo))) {
    throw new Error('Refusing a linked or non-regular user.js');
  }
  const original = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
  const marker = '// EG-Desk isolated QA automation (managed by run-firefox-mcp-target.mjs).';
  const retained = original.split(/\r?\n/).filter(line => {
    if (line === marker) return false;
    const match = line.match(/^\s*user_pref\(\s*["']([^"']+)["']\s*,[^;]*\);\s*(?:\/\/.*)?$/);
    return !match || !managed.has(match[1]);
  }).join('\n').replace(/\n*$/, '');
  const temporary = `${target}.egdesk-${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, `${retained ? retained + '\n\n' : ''}${marker}\n${[...managed]
      .map(([key, value]) => `user_pref(${JSON.stringify(key)}, ${JSON.stringify(value)});`).join('\n')}\n`,
    { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, target);
  } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  const overlay = fileURLToPath(new URL('../overlay/', import.meta.url));
  const chrome = path.join(profile, 'chrome');
  const chromeInfo = safeDestination(chrome, profile);
  if (!chromeInfo?.isDirectory() || !isOwnedAndPrivate(chrome, chromeInfo)) throw new Error('Unsafe QA chrome directory');
  for (const name of ['JS', 'CSS', 'resources']) {
    const source = path.join(overlay, name), destination = path.join(chrome, name);
    if (fs.existsSync(destination) && (fs.lstatSync(destination).isSymbolicLink()
        || fs.realpathSync.native(destination) !== destination)) throw new Error('Linked overlay destination refused');
    fs.cpSync(source, destination, { recursive: true, filter(source, destination) {
      if (fs.lstatSync(source).isSymbolicLink()) throw new Error('Linked overlay source refused');
      safeDestination(destination, profile);
      return true;
    } });
  }
  const cssTarget = path.join(chrome, 'userChrome.css');
  const cssInfo = safeDestination(cssTarget, profile);
  if (cssInfo && (!cssInfo.isFile() || !isOwnedAndPrivate(cssTarget, cssInfo))) throw new Error('Unsafe userChrome.css refused');
  const css = fs.readdirSync(path.join(chrome, 'CSS')).filter(name => name.endsWith('.uc.css')).sort();
  fs.writeFileSync(cssTarget, css.map(name => `@import url(${JSON.stringify(`CSS/${name}`)});`).join('\n') + '\n', { mode: 0o600 });
  if (bridge.fixture) materializeQaFixtureIsolation(profile, { env });
  return profile;
}

async function requireFreePort(port) {
  await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', () => reject(new Error(`QA port ${port} is already in use; no existing process was stopped`)));
    server.listen(port, '127.0.0.1', () => server.close(resolve));
  });
}

export async function launchQaFirefox({ profile, executable, mode = 'automation', marionette = 2828,
  remote = 6000, startUrl = 'about:blank' }) {
  qaBridgeConfig(); // Missing/unsafe fixture ports fail before any port probe or launch.
  if (!path.isAbsolute(executable || '') || !fs.statSync(executable).isFile()) throw new Error('An installed Firefox executable is required');
  if (startUrl !== 'about:blank' && !/^http:\/\/127\.0\.0\.1:\d+\/egdesk-qa\/[A-Za-z0-9_-]{20,80}$/.test(startUrl)) {
    throw new Error('QA start URL must be about:blank or an explicit owned loopback fixture');
  }
  const ports = qaAutomationPorts(marionette, remote);
  if (mode === 'automation') await Promise.all([requireFreePort(ports.marionette), requireFreePort(ports.remote)]);
  const canonical = prepareQaFirefox(profile, { mode, ...ports });
  const env = { ...process.env };
  delete env.MOZ_REMOTE_ALLOW_SYSTEM_ACCESS; delete env.MOZ_MARIONETTE;
  const args = ['-profile', canonical, '--no-remote', '--purgecaches'];
  if (mode === 'automation') {
    env.MOZ_REMOTE_ALLOW_SYSTEM_ACCESS = '1';
    args.push('--marionette', '--remote-debugging-port', String(ports.remote), '--remote-allow-hosts', 'localhost');
  }
  args.push(startUrl);
  const child = spawn(executable, args, { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  child.stdout.on('data', data => process.stderr.write(data));
  child.stderr.on('data', data => process.stderr.write(data));
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  return { child, profile: canonical, mode, ...ports };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2), options = {};
    const keys = { '--profile': 'profile', '--firefox-bin': 'executable', '--mode': 'mode', '--prepare-only': 'prepareOnly',
      '--marionette-port': 'marionette', '--remote-agent-port': 'remote', '--start-url': 'startUrl' };
    for (let i = 0; i < args.length; i += 2) {
      if (!keys[args[i]] || !args[i + 1] || options[keys[args[i]]] !== undefined) throw new Error('Unknown, duplicate or incomplete QA launcher argument');
      options[keys[args[i]]] = args[i + 1];
    }
    options.profile ||= process.env.EGDESK_FIREFOX_PROFILE;
    options.executable ||= process.env.EGDESK_FIREFOX_BIN || (process.platform === 'win32'
      ? path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Mozilla Firefox', 'firefox.exe') : '/usr/bin/firefox');
    if (options.prepareOnly !== undefined && options.prepareOnly !== '1') throw new Error('--prepare-only must be 1');
    if (options.prepareOnly === '1') {
      const profile = prepareQaFirefox(options.profile, options);
      process.stdout.write(`${JSON.stringify({ kind: 'isolated-qa-firefox-prepared', profile,
        bridge: qaBridgeConfig(), launched: false })}\n`);
    } else {
      const launch = await launchQaFirefox(options);
      process.stdout.write(`${JSON.stringify({ kind: 'isolated-qa-firefox', pid: launch.child.pid,
        profile: launch.profile, mode: launch.mode, marionettePort: launch.marionette, remoteAgentPort: launch.remote })}\n`);
      launch.child.once('exit', code => { process.exitCode = code ?? 1; });
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
