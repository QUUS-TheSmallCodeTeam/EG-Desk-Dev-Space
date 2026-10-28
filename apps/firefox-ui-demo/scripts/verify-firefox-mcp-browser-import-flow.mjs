#!/usr/bin/env node
// Isolated, headless Browser-import QA. Importing this module has no side effects.
// It never attaches to an existing profile, starts a provider, or uses the
// personal-profile loader default. Evidence and generated fixtures stay in temp.
// macOS only. Supply explicit canonical paths to the Firefox app executable,
// installed MCP package entry, and geckodriver; Node is process.execPath.
// No runtime path is discovered or downloaded by this verifier.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomInt } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assertQaFixtureManifest, assertQaProfile, bootstrapQaProfile,
  canonicalTempRoot, LOADER_FILES } from './egdesk-chat-qa-profile.mjs';
import { materializeQaFixtureIsolation } from './egdesk-qa-fixture-isolation.mjs';
import { FX_AUTOCONFIG_PIN, inspectFirefoxInstall, inspectLoaderDirectory } from './verify-clean-profile-boot.mjs';

export const MARIONETTE_PORT = 28833;
export const REMOTE_PORT = 60833;
const EXCLUDED_PORTS = Object.freeze([28831, 60831, 28832, 60832, 39217, 39218]);
const OVERLAY = fileURLToPath(new URL('../overlay/', import.meta.url));
const APP_ROOT = fileURLToPath(new URL('../', import.meta.url));
const sha256 = value => createHash('sha256').update(value).digest('hex');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const issuedLoaders = new Set();
const issuedProfiles = new WeakSet();
const ownedChildren = new WeakSet();

export function parseCli(argv, now = Date.now()) {
  const values = new Map();
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    assert.ok(['--evidence-root', '--deadline-utc', '--firefox', '--mcp-entry', '--geckodriver', '--loader-source',
      '--expected-surface-sha256', '--scenario'].includes(key)
      && !values.has(key) && argv[i + 1],
    'usage: --evidence-root ABSOLUTE_TEMP_DIRECTORY --deadline-utc YYYY-MM-DDTHH:mm:ssZ --firefox ABSOLUTE_BINARY --mcp-entry ABSOLUTE_ENTRY --geckodriver ABSOLUTE_BINARY --loader-source PINNED_UTILS_DIR [--expected-surface-sha256 SHA256] [--scenario core|ownership|open-file|style-parity]');
    values.set(key, argv[i + 1]);
  }
  assert.ok(['--evidence-root', '--deadline-utc', '--firefox', '--mcp-entry', '--geckodriver', '--loader-source']
    .every(key => values.has(key)), 'evidence root, deadline and all explicit runtime and pinned-loader paths are required');
  const raw = values.get('--deadline-utc');
  assert.match(raw, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/, 'deadline must be unambiguous UTC');
  const deadlineMs = Date.parse(raw);
  assert.ok(Number.isFinite(deadlineMs) && new Date(deadlineMs).toISOString() === raw.replace('Z', '.000Z')
    && deadlineMs > now + 30000, 'deadline must be a valid future UTC timestamp');
  const scenario = values.get('--scenario') || 'core';
  assert.ok(['core', 'ownership', 'open-file', 'style-parity'].includes(scenario), 'unknown QA scenario');
  const runtimes = { firefox: values.get('--firefox'), mcpEntry: values.get('--mcp-entry'),
    geckodriver: values.get('--geckodriver') };
  for (const value of Object.values(runtimes)) assertRuntimePathSyntax(value);
  const loaderSource = values.get('--loader-source');
  assertRuntimePathSyntax(loaderSource);
  const expectedSurfaceSha256 = values.get('--expected-surface-sha256') || null;
  if (expectedSurfaceSha256 !== null) assert.match(expectedSurfaceSha256, /^[0-9a-f]{64}$/, 'expected surface SHA256 must be lowercase hexadecimal');
  return { evidenceRoot: values.get('--evidence-root'), deadlineMs, scenario, runtimes, loaderSource, expectedSurfaceSha256 };
}

export function assertSupportedPlatform(platform = process.platform) {
  assert.equal(platform, 'darwin', 'This headless verifier requires macOS sandbox-exec; other platforms are not tested');
}

export function assertRuntimePathSyntax(value) {
  assert.ok(typeof value === 'string' && path.isAbsolute(value) && path.resolve(value) === value
    && !/["\n\r\\]/.test(value), 'runtime path must be explicit, absolute, normalized and safe for the sandbox');
}

export function assertBeforeDeadline(deadlineMs, now = Date.now()) {
  assert.ok(Number.isFinite(deadlineMs) && now < deadlineMs, 'QA deadline reached; no new actions');
}

export function boundedTimeout(deadlineMs, timeout, now = Date.now()) {
  assertBeforeDeadline(deadlineMs, now);
  assert.ok(Number.isFinite(timeout) && timeout > 0, 'timeout must be positive');
  return Math.max(1, Math.min(timeout, deadlineMs - now));
}

export function assertRunning(deadlineMs, signal, now = Date.now()) {
  assertBeforeDeadline(deadlineMs, now);
  if (signal?.aborted) throw new Error('QA interrupted; no new actions');
}

export function migrationMessageDisposition(name) {
  if (name === 'GetAvailableMigrators') return 'synthetic-list';
  if (name === 'RecordEvent') return 'ignore-telemetry';
  return 'deny';
}

// Only the portable capability is advertised. There is no Desk store or
// provider behind this loopback fixture, and no route is ever forwarded.
export function syntheticBridgeState() {
  return { protocolVersion: 2, provider: 'codex', appServerReady: false, deskStorageReady: false,
    auth: { isLoggedIn: false, loginInProgress: false, accountId: null, accountEmail: null,
      authMode: null, statusText: 'Synthetic local QA only' },
    capabilities: { portable: ['inspect', 'import-as-new'] } };
}

export function providerBoundaryEvidence() {
  return { providerCalls: 'not-measured', providerMode: 'synthetic-loopback-fixture-does-not-forward',
    externalNetwork: 'denied-by-inherited-os-sandbox' };
}

export function openFileRefusalAccepted({ guard, invoked, observed, unchanged, fileRequests, beforeNotice }) {
  return guard?.installed === true && Array.isArray(guard.guarded)
    && guard.guarded.includes('browser') && guard.guarded.includes('library')
    && invoked?.invoked === true && invoked.disabled === false
    && Array.isArray(observed?.commands) && observed.commands.length === 1
    && Array.isArray(observed?.blockedNativeCalls) && observed.blockedNativeCalls.length === 0
    && unchanged === true && Array.isArray(fileRequests) && fileRequests.length === 0
    && typeof observed?.notice === 'string' && observed.notice.length > 0 && observed.notice !== beforeNotice;
}

export function assertPrivateDirectory(directory, parent = null) {
  assert.ok(typeof directory === 'string' && path.isAbsolute(directory)
    && path.resolve(directory) === directory, 'directory must be an absolute normalized path');
  const info = fs.lstatSync(directory);
  assert.ok(info.isDirectory() && !info.isSymbolicLink() && fs.realpathSync.native(directory) === directory,
    'directory must be canonical and not a symlink');
  assert.ok(info.uid === process.getuid() && (info.mode & 0o077) === 0, 'directory must be owned and private');
  if (parent) assert.equal(path.dirname(directory), parent, 'directory escaped its designated parent');
  return directory;
}

export function assertEvidenceRoot(root) {
  assertPrivateDirectory(root);
  assert.ok(root.startsWith('/private/tmp/egdesk-round-') && path.dirname(root) === '/private/tmp',
    'evidence root must be a dedicated /private/tmp/egdesk-round-* directory');
  return root;
}

export function sandboxPolicy({ home, firefoxApp, nodeDir, mcpDir, geckoDir, fixturePort, driverPort }) {
  for (const p of [home, firefoxApp, nodeDir, mcpDir, geckoDir]) {
    assert.ok(path.isAbsolute(p) && !/["\n\r\\]/.test(p), 'unsafe sandbox path');
  }
  assert.ok(Number.isInteger(fixturePort) && fixturePort > 0 && fixturePort <= 65535
    && ![MARIONETTE_PORT, REMOTE_PORT, ...EXCLUDED_PORTS].includes(fixturePort), 'unsafe sandbox fixture port');
  if (driverPort != null) assert.ok(Number.isInteger(driverPort) && driverPort > 0 && driverPort <= 65535
    && ![MARIONETTE_PORT, REMOTE_PORT, ...EXCLUDED_PORTS, fixturePort].includes(driverPort), 'unsafe sandbox driver port');
  const ancestors = new Set();
  for (const item of [firefoxApp, nodeDir, mcpDir, geckoDir]) {
    for (let current = path.dirname(item); current !== home && current.startsWith(home + '/'); current = path.dirname(current)) {
      ancestors.add(current);
    }
  }
  const ancestorMetadata = [...ancestors].map(p => `(allow file-read-metadata (literal "${p}"))`).join('\n');
  return `(version 1)
(allow default)
(deny file-read* (subpath "${home}"))
(deny file-write* (subpath "${home}"))
(allow file-read-metadata (literal "${home}"))
(allow file-read-metadata (literal "${home}/Library"))
(allow file-read-metadata (literal "${home}/Library/Application Support"))
(allow file-read-metadata (literal "${home}/Library/Caches"))
(allow file-read-metadata (literal "${home}/Applications"))
${ancestorMetadata}
(allow file-read* (subpath "${firefoxApp}"))
(allow file-read* (subpath "${nodeDir}"))
(allow file-read* (subpath "${mcpDir}"))
(allow file-read* (subpath "${geckoDir}"))
(deny mach-lookup (global-name "com.apple.securityd"))
(deny mach-lookup (global-name "com.apple.mDNSResponder"))
(deny network-outbound)
${[MARIONETTE_PORT, REMOTE_PORT, fixturePort, ...(driverPort == null ? [] : [driverPort])].map(port =>
    `(allow network-outbound (remote ip "localhost:${port}"))`).join('\n')}`;
}

export function decodeScreenshot(value) {
  assert.ok(value && Number.isSafeInteger(value.width) && Number.isSafeInteger(value.height)
    && value.width > 0 && value.height > 0 && value.width * value.height <= 16777216,
  'invalid screenshot dimensions');
  assert.ok(typeof value.data === 'string' && value.data.length <= 4 * Math.ceil(16 * 1024 * 1024 / 3)
    && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.data),
  'invalid screenshot encoding');
  const bytes = Buffer.from(value.data, 'base64');
  assert.ok(bytes.length >= 33 && bytes.length <= 16 * 1024 * 1024
    && bytes.toString('base64') === value.data
    && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    && bytes.readUInt32BE(8) === 13 && bytes.toString('ascii', 12, 16) === 'IHDR'
    && bytes.readUInt32BE(16) === value.width && bytes.readUInt32BE(20) === value.height,
  'invalid screenshot PNG or mismatched dimensions');
  return bytes;
}

function saveScreenshot(target, value) {
  const runDir = path.dirname(target), parent = path.dirname(runDir), root = path.dirname(parent);
  assertEvidenceRoot(root); assertPrivateDirectory(parent, root); assertPrivateDirectory(runDir, parent);
  assert.equal(path.basename(parent), 'browser-import');
  assert.match(path.basename(runDir), /^run-[A-Za-z0-9]+$/);
  assert.ok(path.isAbsolute(target) && path.resolve(target) === target && /^[a-z0-9-]+\.png$/.test(path.basename(target)),
    'unsafe screenshot destination');
  const bytes = decodeScreenshot(value);
  fs.writeFileSync(target, bytes, { flag: 'wx', mode: 0o600 });
  return { file: target, width: value.width, height: value.height, sha256: sha256(bytes) };
}

// Historical user-only loader description, retained solely to identify the
// comparison baseline. Production-parity runs use the explicitly supplied,
// hash-verified fx-autoconfig loader instead; this source is never launched.
export function loaderSources() {
  return {
    'chrome.manifest': 'content userchromejs ./\ncontent userchrome ../resources/\ncontent egdeskqa ../\n',
    'boot.sys.mjs': `const obs = Cc['@mozilla.org/observer-service;1'].getService(Ci.nsIObserverService);
const boot = win => {
  if (win.document.documentURI !== 'chrome://browser/content/browser.xhtml' || win.__egdeskQaLoaderRan) return;
  win.__egdeskQaLoaderRan = true;
  const loader = Cc['@mozilla.org/moz/jssubscript-loader;1'].getService(Ci.mozIJSSubScriptLoader);
  try { loader.loadSubScript('chrome://egdeskqa/content/JS/eg-desk-surface.uc.js', win, 'UTF-8'); }
  catch (error) { win.__egdeskQaLoaderError = String(error) + '\\n' + (error.stack || ''); }
};
obs.addObserver({ observe(subject) { boot(subject); } }, 'browser-delayed-startup-finished');
`,
    'fs.sys.mjs': '// unused by the isolated test loader\n',
    'module_loader.mjs': '// unused by the isolated test loader\n',
    'uc_api.sys.mjs': '// unused by the isolated test loader\n',
    'utils.sys.mjs': '// unused by the isolated test loader\n',
  };
}

export function assertPinnedLoaderBoundary(source, evidenceRoot) {
  assertRuntimePathSyntax(source);
  assertRuntimePathSyntax(evidenceRoot);
  const within = root => source.startsWith(path.resolve(root) + path.sep);
  assert.ok(within(APP_ROOT) || within(evidenceRoot), 'pinned loader must be inside the repository or owned evidence root');
  assert.ok(!source.split(path.sep).some(part => /^egdesk-chat-test-/i.test(part)),
    'loader source must not be a Firefox profile');
}

export function inspectPinnedLoader(source, evidenceRoot) {
  assertPinnedLoaderBoundary(source, evidenceRoot); // reject private paths before any read
  const info = fs.lstatSync(source);
  assert.ok(info.isDirectory() && !info.isSymbolicLink() && fs.realpathSync.native(source) === source,
    'pinned loader source must be a canonical directory');
  const report = inspectLoaderDirectory(source);
  assert.ok(report.matchesPin, `pinned loader mismatch: ${report.mismatches.join(', ')} ${report.extra.join(', ')}`);
  return report;
}

export function createLoader(runDir, source) {
  assertPrivateDirectory(runDir);
  const parent = path.dirname(runDir), root = path.dirname(parent);
  assertEvidenceRoot(root);
  assertPrivateDirectory(parent, root);
  assert.equal(path.basename(parent), 'browser-import', 'loader must be under browser-import evidence');
  assert.match(path.basename(runDir), /^run-[A-Za-z0-9]+$/, 'loader requires a unique owned run');
  const sourceReport = inspectPinnedLoader(source, root);
  const loader = path.join(runDir, 'pinned-loader');
  fs.mkdirSync(loader, { mode: 0o700 });
  for (const name of LOADER_FILES) {
    fs.copyFileSync(path.join(source, name), path.join(loader, name), fs.constants.COPYFILE_EXCL);
    fs.chmodSync(path.join(loader, name), 0o600);
  }
  const canonical = assertPrivateDirectory(loader, runDir);
  const copiedReport = inspectLoaderDirectory(canonical);
  assert.ok(copiedReport.matchesPin, 'copied pinned loader changed during preparation');
  issuedLoaders.add(canonical);
  return { path: canonical, commit: FX_AUTOCONFIG_PIN.commit, files: copiedReport.files,
    sourceCanonicalSha256: sha256(source), sourceMatchesPin: sourceReport.matchesPin, copiedMatchesPin: copiedReport.matchesPin };
}

// Match the complete, case-insensitive filename selection in the pinned
// fx-autoconfig boot.sys.mjs; any other executable/registered candidate is
// refused before the private profile is started.
export function assertReviewedOverlayCandidates(scriptNames, styleNames) {
  assert.ok(Array.isArray(scriptNames) && Array.isArray(styleNames), 'overlay candidate lists are required');
  const scripts = scriptNames.filter(name => /^[A-Za-z0-9]+.*(\.uc\.js|\.uc\.mjs|\.sys\.mjs)$/i.test(name)).sort();
  const styles = styleNames.filter(name => /^[A-Za-z0-9]+.*\.uc\.css$/i.test(name)).sort();
  assert.deepEqual(scripts, ['eg-desk-surface.uc.js'], 'pinned loader may execute only the reviewed EG-Desk surface script');
  assert.deepEqual(styles, ['eg-desk-surface.uc.css'], 'pinned loader may register only the reviewed EG-Desk surface stylesheet');
  return { scripts, styles };
}

export function prepareProfile({ loader, fixturePort }) {
  assert.ok(Number.isInteger(fixturePort) && fixturePort > 0 && fixturePort <= 65535
    && ![MARIONETTE_PORT, REMOTE_PORT, ...EXCLUDED_PORTS].includes(fixturePort), 'unsafe fixture port');
  assert.ok(issuedLoaders.has(loader), 'loader must be created by this isolated run');
  issuedLoaders.delete(loader);
  assertReviewedOverlayCandidates(fs.readdirSync(path.join(OVERLAY, 'JS')), fs.readdirSync(path.join(OVERLAY, 'CSS')));
  const { profile } = bootstrapQaProfile({ loaderSource: loader }); // never use its default
  assertQaFixtureManifest(profile);
  const chrome = path.join(profile, 'chrome');
  for (const name of ['JS', 'CSS', 'resources']) {
    fs.cpSync(path.join(OVERLAY, name), path.join(chrome, name), { recursive: true,
      filter(source) { assert.ok(!fs.lstatSync(source).isSymbolicLink(), 'linked overlay source refused'); return true; } });
  }
  const { styles: css } = assertReviewedOverlayCandidates(fs.readdirSync(path.join(chrome, 'JS')),
    fs.readdirSync(path.join(chrome, 'CSS')));
  fs.writeFileSync(path.join(chrome, 'userChrome.css'),
    css.map(name => `@import url(${JSON.stringify(`CSS/${name}`)});`).join('\n') + '\n', { flag: 'wx', mode: 0o600 });
  const isolationEnv = { EGDESK_QA_FIXTURE_TRANSPORT: '1', EGDESK_QA_REAL_TURN: '0',
    EGDESK_QA_FIXTURE_PORT: String(fixturePort) };
  const isolation = materializeQaFixtureIsolation(profile, { env: isolationEnv });
  const prefs = {
    'toolkit.legacyUserProfileCustomizations.stylesheets': true,
    'marionette.enabled': true, 'marionette.port': MARIONETTE_PORT,
    'devtools.chrome.enabled': true, 'devtools.debugger.remote-enabled': true,
    'remote.prefs.recommended': false, 'browser.shell.checkDefaultBrowser': false,
    'browser.aboutwelcome.enabled': false, 'browser.startup.page': 0,
    'browser.startup.homepage_override.mstone': 'ignore', 'startup.homepage_welcome_url': '',
    'startup.homepage_welcome_url.additional': '', 'termsofuse.bypassNotification': true,
    'datareporting.policy.dataSubmissionEnabled': false, 'toolkit.telemetry.enabled': false,
    'app.update.auto': false, 'app.update.enabled': false, 'signon.rememberSignons': false,
    'network.dns.disablePrefetch': true, 'network.prefetch-next': false,
    'network.predictor.enabled': false, 'network.captive-portal-service.enabled': false,
    'network.trr.mode': 5, 'browser.tabs.loadBookmarksInTabs': true,
    'browser.tabs.loadBookmarksInBackground': false, 'browser.tabs.loadInBackground': true,
  };
  fs.writeFileSync(path.join(profile, 'user.js'),
    Object.entries(prefs).map(([key, value]) => `user_pref(${JSON.stringify(key)}, ${JSON.stringify(value)});`).join('\n') + '\n',
    { flag: 'wx', mode: 0o600 });
  const cssHash = sha256(fs.readFileSync(path.join(profile, 'chrome/CSS/eg-desk-surface.uc.css')));
  assert.equal(cssHash, sha256(fs.readFileSync(path.join(OVERLAY, 'CSS/eg-desk-surface.uc.css'))),
    'surface CSS changed while copying the QA profile');
  const prepared = Object.freeze({ profile: assertQaProfile(profile), isolation, cssHash,
    sourceHash: sha256(fs.readFileSync(path.join(profile, 'chrome/JS/eg-desk-surface.uc.js'))) });
  issuedProfiles.add(prepared);
  return prepared;
}

export async function assertPortFree(port) {
  await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', () => reject(new Error(`Port ${port} is occupied; no process was stopped`)));
    server.listen({ port, host: '127.0.0.1', exclusive: true }, () => server.close(resolve));
  });
}

export async function listenOwnedFixturePort(server, excluded = []) {
  // Never let the OS choose Popper's reserved 60831, even briefly.
  // These local-only candidates are outside both workers' fixed port pairs.
  for (let attempt = 0; attempt < 20; attempt++) {
    const port = 41000 + randomInt(4000);
    if ([MARIONETTE_PORT, REMOTE_PORT, ...EXCLUDED_PORTS, ...excluded].includes(port)) continue;
    try {
      await new Promise((resolve, reject) => {
        const fail = error => { server.off('listening', ready); reject(error); };
        const ready = () => { server.off('error', fail); resolve(); };
        server.once('error', fail); server.once('listening', ready);
        server.listen({ port, host: '127.0.0.1', exclusive: true });
      });
      return port;
    } catch (error) { if (error.code !== 'EADDRINUSE') throw error; }
  }
  throw new Error('No exclusive fixture port available; no existing process was touched');
}

async function chooseDriverPort(fixturePort) {
  const server = net.createServer();
  const port = await listenOwnedFixturePort(server, [fixturePort]);
  await new Promise(resolve => server.close(resolve));
  assert.ok(![MARIONETTE_PORT, REMOTE_PORT, ...EXCLUDED_PORTS, fixturePort].includes(port), 'driver port collided');
  return port;
}

// Test-process-only preload: keep the installed Selenium code and the product
// unchanged, while making its otherwise-random geckodriver port explicit.
export function mcpDriverPortPreload() {
  return `'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const entry = process.env.EGDESK_QA_MCP_ENTRY;
const port = Number(process.env.EGDESK_QA_DRIVER_PORT);
const driver = process.env.EGDESK_QA_GECKODRIVER;
assert(path.isAbsolute(entry) && path.isAbsolute(driver) && Number.isInteger(port) && port > 0 && port <= 65535);
assert.strictEqual(process.env.PATH.split(path.delimiter)[0], path.dirname(driver));
fs.accessSync(driver, fs.constants.X_OK);
const firefox = createRequire(entry)('selenium-webdriver/firefox.js');
const original = firefox.ServiceBuilder?.prototype?.build;
assert.strictEqual(typeof original, 'function');
firefox.ServiceBuilder.prototype.build = function (...args) {
  this.setPort(port);
  return original.apply(this, args);
};
process.stderr.write('[egdesk-qa-driver-port-configured]\\n');
`;
}

function createMcpDriverPreload(runDir) {
  assertPrivateDirectory(runDir);
  assert.match(path.basename(runDir), /^run-[A-Za-z0-9]+$/);
  const file = path.join(runDir, 'selenium-driver-port.cjs');
  const source = mcpDriverPortPreload();
  fs.writeFileSync(file, source, { flag: 'wx', mode: 0o600 });
  return { file, sha256: sha256(source) };
}

async function startFixtureServer() {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ method: req.method, path: String(req.url).slice(0, 300) });
    if (req.method === 'GET' && req.url === '/v1/state') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store',
        'access-control-allow-origin': '*' });
      res.end(JSON.stringify(syntheticBridgeState()));
    } else if (req.method === 'GET' && /^\/egdesk-browser-import\/(original|bookmark|bookmark-background|history|owner-start-a|owner-start-b|owner-a|owner-b|owner-c|owner-d)$/.test(req.url)) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(`<!doctype html><title>EG-Desk QA ${req.url.split('/').pop()}</title><p>Local synthetic Places fixture.</p>`);
    } else { res.writeHead(503, { 'content-type': 'application/json' }); res.end('{"error":"fixture only"}'); }
  });
  server.on('connect', (req, socket) => { requests.push({ method: 'CONNECT', path: 'blocked' }); socket.destroy(); });
  const port = await listenOwnedFixturePort(server);
  if ([MARIONETTE_PORT, REMOTE_PORT, ...EXCLUDED_PORTS].includes(port)) { await new Promise(r => server.close(r)); throw new Error('Fixture port collided'); }
  return { server, port, requests };
}

function assertInstalledFile(file, executable = false) {
  assertRuntimePathSyntax(file);
  assert.ok(fs.lstatSync(file).isFile() && !fs.lstatSync(file).isSymbolicLink()
    && fs.realpathSync.native(file) === file, 'expected an explicit canonical installed file');
  if (executable) fs.accessSync(file, fs.constants.X_OK);
}

export function validateRuntimePaths({ firefox, mcpEntry, geckodriver, node = process.execPath }) {
  for (const [file, executable] of [[firefox, true], [mcpEntry, false], [geckodriver, true], [node, true]]) {
    assertInstalledFile(file, executable);
  }
  const macOS = path.dirname(firefox), contents = path.dirname(macOS), firefoxApp = path.dirname(contents);
  assert.ok(path.basename(firefox) === 'firefox' && path.basename(macOS) === 'MacOS'
    && path.basename(contents) === 'Contents' && path.basename(firefoxApp).endsWith('.app'),
  'Firefox must be an explicit executable inside a macOS .app bundle');
  const dist = path.dirname(mcpEntry), packageRoot = path.dirname(dist);
  const scope = path.dirname(packageRoot), mcpDir = path.dirname(scope);
  assert.ok(path.basename(mcpEntry) === 'index.js' && path.basename(dist) === 'dist.moz'
    && path.basename(packageRoot) === 'firefox-devtools-mcp-moz' && path.basename(scope) === '@mozilla'
    && path.basename(mcpDir) === 'node_modules', 'MCP entry must be the explicit installed Mozilla package entry');
  assert.equal(path.basename(geckodriver), 'geckodriver', 'geckodriver must be an explicit executable');
  assert.equal(path.basename(node), 'node', 'Node must be an explicit executable');
  return Object.freeze({ firefox, firefoxApp, mcpEntry, mcpDir, geckodriver, node });
}

export function assertSafeRuntimeAllowlist(home, paths) {
  assertRuntimePathSyntax(home);
  const sensitive = ['Library/Application Support/Firefox', 'Library/Application Support/Google/Chrome',
    'Library/Application Support/Chromium', 'Library/Application Support/BraveSoftware',
    'Library/Application Support/Microsoft Edge', 'Library/Keychains', '.mozilla',
    '.config/google-chrome', '.config/chromium'].map(relative => path.join(home, relative));
  const allow = [paths.firefoxApp, paths.mcpDir, path.dirname(paths.geckodriver), path.dirname(paths.node)];
  const within = (value, root) => value === root || value.startsWith(root + path.sep);
  for (const candidate of allow) {
    assertRuntimePathSyntax(candidate);
    assert.ok(candidate !== '/' && !sensitive.some(root => within(candidate, root) || within(root, candidate)),
      'runtime allowlist must not include or overlap a personal browser profile or keychain location');
  }
}

export function childEnvironment(geckodriver, mcp = null) {
  assertRuntimePathSyntax(geckodriver);
  const env = { PATH: `${path.dirname(geckodriver)}:/usr/bin:/bin:/usr/sbin:/sbin`,
    TMPDIR: canonicalTempRoot(), MOZ_HEADLESS: '1', MOZ_REMOTE_ALLOW_SYSTEM_ACCESS: '1', MOZ_CRASHREPORTER_DISABLE: '1',
    // macOS does not permit a second sandbox_init inside sandbox-exec. All
    // Firefox children inherit the stricter outer process sandbox instead.
    MOZ_DISABLE_CONTENT_SANDBOX: '1', MOZ_DISABLE_GMP_SANDBOX: '1', MOZ_DISABLE_GPU_SANDBOX: '1',
    MOZ_DISABLE_RDD_SANDBOX: '1', MOZ_DISABLE_SOCKET_PROCESS_SANDBOX: '1', MOZ_DISABLE_UTILITY_SANDBOX: '1',
    // Firefox requires the real account's HOME value to locate platform
    // services; the process sandbox denies access to its contents.
    HOME: process.env.HOME, USER: process.env.USER, LANG: 'en_US.UTF-8' };
  if (mcp) {
    assertRuntimePathSyntax(mcp.entry);
    assert.ok(Number.isInteger(mcp.driverPort) && mcp.driverPort > 0 && mcp.driverPort <= 65535);
    env.EGDESK_QA_MCP_ENTRY = mcp.entry;
    env.EGDESK_QA_DRIVER_PORT = String(mcp.driverPort);
    env.EGDESK_QA_GECKODRIVER = geckodriver;
  }
  return env;
}

async function waitForOwnedListener(port, child, deadlineMs, signal) {
  for (let count = 0; count < 150; count++) {
    assertRunning(deadlineMs, signal);
    if (child.exitCode != null || child.signalCode != null) throw new Error(`Owned Firefox exited before port ${port} was ready`);
    try {
      const output = execFileSync('/usr/sbin/lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' });
      const pids = output.trim().split(/\s+/).filter(Boolean).map(Number);
      if (pids.length === 1 && pids[0] === child.pid) return;
      if (pids.length) throw new Error(`Port ${port} is not owned solely by this Firefox`);
    } catch (error) { if (error.message.includes('not owned')) throw error; }
    await pause(200);
  }
  throw new Error(`Owned Firefox did not listen on ${port}`);
}

export class IsolatedMcp {
  constructor({ prepared, firefox, policy, paths, preload, driverPort, deadlineMs, signal }) {
    assert.ok(prepared && issuedProfiles.has(prepared), 'refusing a profile not created by this run');
    assert.ok(firefox && Number.isSafeInteger(firefox.pid), 'an owned Firefox process is required');
    issuedProfiles.delete(prepared);
    this.profile = assertQaFixtureManifest(prepared.profile).profile;
    this.firefox = firefox;
    assertRunning(deadlineMs, signal);
    this.deadlineMs = deadlineMs;
    this.signal = signal;
    this.policy = policy;
    this.paths = paths;
    this.preload = preload;
    this.driverPort = driverPort;
    this.pending = new Map(); this.id = 0; this.buffer = ''; this.stderr = ''; this.context = null;
    this.documentUri = 'chrome://browser/content/browser.xhtml';
  }
  request(method, params = {}, timeout = 30000) {
    assertRunning(this.deadlineMs, this.signal);
    const waitMs = boundedTimeout(this.deadlineMs, timeout);
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      const finish = (callback, value) => { clearTimeout(timer); this.signal?.removeEventListener('abort', onAbort);
        this.pending.delete(id); callback(value); };
      const onAbort = () => finish(reject, new Error('QA interrupted; no new actions'));
      const timer = setTimeout(() => finish(reject, new Error(`MCP ${method} timed out or deadline reached`)), waitMs);
      this.pending.set(id, { resolve: value => finish(resolve, value), reject: error => finish(reject, error) });
      this.signal?.addEventListener('abort', onAbort, { once: true });
      try { this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); }
      catch (error) { finish(reject, error); }
    });
  }
  async call(name, args = {}) {
    assertRunning(this.deadlineMs, this.signal);
    const result = await this.request('tools/call', { name, arguments: args });
    const text = (result?.content || []).filter(x => x.type === 'text').map(x => x.text).join('\n');
    if (result?.isError || /^Error:/m.test(text.trim())) throw new Error(`${name}: ${text}`);
    return { result, text };
  }
  async connect() {
    assertRunning(this.deadlineMs, this.signal);
    assertQaProfile(this.profile);
    // The installed MCP searches PATH before any cache/download fallback. Keep
    // the explicit driver first and revalidate it immediately before launch.
    assertInstalledFile(this.paths.geckodriver, true);
    assertInstalledFile(this.paths.mcpEntry, false);
    assertInstalledFile(this.paths.node, true);
    this.proc = spawn('/usr/bin/sandbox-exec', ['-p', this.policy, this.paths.node, '--require', this.preload, this.paths.mcpEntry,
      '--connectExisting', '--marionettePort', String(MARIONETTE_PORT), '--enablePrivilegedContext', '--enableScript'],
    { env: childEnvironment(this.paths.geckodriver, { entry: this.paths.mcpEntry, driverPort: this.driverPort }),
      cwd: this.profile, stdio: ['pipe', 'pipe', 'pipe'] });
    ownedChildren.add(this.proc);
    this.proc.stdout.on('data', chunk => {
      this.buffer += chunk; let end;
      while ((end = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, end).trim(); this.buffer = this.buffer.slice(end + 1);
        let message; try { message = JSON.parse(line); } catch { continue; }
        const item = this.pending.get(message.id); if (!item) continue;
        this.pending.delete(message.id);
        if (message.error) item.reject(new Error(JSON.stringify(message.error))); else item.resolve(message.result);
      }
    });
    this.proc.stderr.on('data', chunk => { this.stderr = (this.stderr + chunk).slice(-5000); });
    const rejectAll = error => { for (const item of this.pending.values()) item.reject(error); this.pending.clear(); };
    this.proc.on('error', rejectAll); this.proc.stdin.on('error', rejectAll);
    this.proc.on('exit', (code, signal) => rejectAll(new Error(`MCP exited ${code ?? signal}`)));
    await this.request('initialize', { protocolVersion: '2024-11-05', capabilities: {},
      clientInfo: { name: 'egdesk-isolated-browser-import-qa', version: '1' } });
    assert.match(this.stderr, /\[egdesk-qa-driver-port-configured\]/, 'MCP driver-port preload did not run');
    this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    const listed = await this.call('list_privileged_contexts');
    this.context = listed.text.match(/([0-9a-f-]{36})\s*:\s*chrome:\/\/browser\/content\/browser\.xhtml/i)?.[1];
    assert.ok(this.context, 'browser chrome context not found');
    await this.call('select_privileged_context', { contextId: this.context });
    const guard = await this.evaluate(() => ({ profile: Services.dirsvc.get('ProfD', Ci.nsIFile).path,
      headless: Cc['@mozilla.org/gfx/info;1'].getService(Ci.nsIGfxInfo).isHeadless,
      document: document.documentURI }));
    assert.equal(guard.profile, this.profile); assert.equal(guard.headless, true);
    assert.equal(guard.document, 'chrome://browser/content/browser.xhtml');
    return { profileCanonicalSha256: sha256(guard.profile), exactProfileMatch: true,
      headless: guard.headless, document: guard.document };
  }
  async evaluate(fn, arg = null) {
    assertRunning(this.deadlineMs, this.signal);
    assertQaProfile(this.profile);
    const source = `async () => {
      const Services = globalThis.Services || ChromeUtils.importESModule('resource://gre/modules/Services.sys.mjs').Services;
      if (Services.dirsvc.get('ProfD', Ci.nsIFile).path !== ${JSON.stringify(this.profile)} ||
          Cc['@mozilla.org/gfx/info;1'].getService(Ci.nsIGfxInfo).isHeadless !== true ||
          document.documentURI !== ${JSON.stringify(this.documentUri)}) throw new Error('Refusing non-owned or non-headless context');
      try { return JSON.stringify({ ok: true, value: await (${fn.toString()})(${JSON.stringify(arg)}) }); }
      catch (e) { return JSON.stringify({ ok: false, error: e.message || String(e) }); }
    }`;
    assert.ok(Buffer.byteLength(source) < 16384, 'evaluation too large');
    const { result, text } = await this.call('evaluate_privileged_script', { context: this.context, function: source });
    let raw = result.structuredContent;
    if (raw == null) {
      const fenced = text.match(/```json\s*\n([\s\S]*?)\n```/);
      try { raw = JSON.parse(fenced ? fenced[1] : text.replace(/^Result:\s*/, '')); }
      catch { throw new Error(`Unrecognized MCP script result: ${text.slice(0, 1200)}`); }
    }
    const value = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!value?.ok) throw new Error(`Chrome evaluation: ${value?.error || text}`);
    return value.value;
  }
  async listContexts() {
    const text = (await this.call('list_privileged_contexts')).text;
    return text.split('\n').map(line => line.match(/^\s*([0-9a-f-]{36}):\s+(\S+)/i))
      .filter(Boolean).map(match => ({ id: match[1], uri: match[2] }));
  }
  async selectContext(uri, expectedId = null) {
    assert.ok(['chrome://browser/content/browser.xhtml', 'chrome://browser/content/places/places.xhtml'].includes(uri),
      'Only the owned browser and Places Library contexts are permitted');
    if (expectedId != null) assert.match(expectedId, /^[0-9a-f-]{36}$/i, 'unsafe context ID');
    const matches = (await this.listContexts()).filter(context => context.uri === uri && (!expectedId || context.id === expectedId));
    assert.equal(matches.length, 1, `Expected exactly one owned context for ${uri}`);
    await this.call('select_privileged_context', { contextId: matches[0].id });
    this.context = matches[0].id; this.documentUri = uri;
    await this.evaluate(() => true); // Recheck the profile and headless target after changing contexts.
    return this.context;
  }
  async nativeInput(actions) {
    const viewport = await this.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight,
      root: window.docShell?.browsingContext?.parent === null && window.docShell?.browsingContext?.isContent === false }));
    assert.ok(viewport.root && viewport.width > 0 && viewport.height > 0, 'native input requires a live root chrome window');
    assertOwnedListener(MARIONETTE_PORT, this.firefox);
    await this.call('send_bidi_command', { method: 'input.performActions', params: { context: this.context, actions } });
  }
  async clickPoint(point) {
    assert.ok(Number.isSafeInteger(point.x) && Number.isSafeInteger(point.y) && point.x >= 0 && point.y >= 0,
      'unsafe native click coordinate');
    const viewport = await this.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
    assert.ok(point.x < viewport.width && point.y < viewport.height, 'native click outside viewport');
    await this.nativeInput([{ type: 'pointer', id: 'egdesk_qa_places_mouse', parameters: { pointerType: 'mouse' },
      actions: [{ type: 'pointerMove', origin: 'viewport', x: point.x, y: point.y, duration: 0 },
        { type: 'pointerDown', button: 0 }, { type: 'pointerUp', button: 0 }] }]);
    return { mechanism: 'firefox-bidi-native-click', ...point };
  }
  async pressEnter() {
    await this.nativeInput([{ type: 'key', id: 'egdesk_qa_places_keyboard',
      actions: [{ type: 'keyDown', value: '\uE007' }, { type: 'keyUp', value: '\uE007' }] }]);
    return { mechanism: 'firefox-bidi-native-enter' };
  }
  async pressBackgroundEnter() {
    await this.nativeInput([{ type: 'key', id: 'egdesk_qa_places_background_keyboard', actions: [
      { type: 'keyDown', value: '\uE03D' }, { type: 'keyDown', value: '\uE008' },
      { type: 'keyDown', value: '\uE007' }, { type: 'keyUp', value: '\uE007' },
      { type: 'keyUp', value: '\uE008' }, { type: 'keyUp', value: '\uE03D' },
    ] }]);
    return { mechanism: 'firefox-bidi-native-meta-shift-enter' };
  }
  async click(selector) {
    const visible = await this.evaluate(value => {
      const nodes = [...document.querySelectorAll(value)];
      if (nodes.length !== 1) return { count: nodes.length, visible: false };
      const node = nodes[0], rect = node.getBoundingClientRect(), style = getComputedStyle(node);
      return { count: 1, visible: rect.width > 0 && rect.height > 0 && style.display !== 'none'
        && style.visibility !== 'hidden', disabled: !!node.disabled };
    }, selector);
    assert.ok(visible.count === 1 && visible.visible && !visible.disabled, `native click target unavailable: ${selector}`);
    const snapshot = await this.call('take_snapshot', { selector, includeAll: true, includeAttributes: true, maxLines: 50 });
    const uid = snapshot.text.match(/\buid\s*[=:]\s*["']?([^\s"'<>\[\],}]+)/i)?.[1];
    assert.ok(uid, `native click UID missing for ${selector}`);
    // No retry after an ambiguous action result.
    assertOwnedListener(MARIONETTE_PORT, this.firefox);
    await this.evaluate(() => true);
    await this.call('click_by_uid', { uid });
    return { selector, uid, mechanism: 'firefox-mcp-native-click' };
  }
  async fillAndEnter(selector, value) {
    assert.ok(/^http:\/\/127\.0\.0\.1:\d+\/egdesk-browser-import\/(original|owner-start-a|owner-start-b)$/.test(value),
      'Only owned local synthetic setup pages may be typed');
    const snapshot = await this.call('take_snapshot', { selector, includeAll: true, includeAttributes: true, maxLines: 50 });
    const uid = snapshot.text.match(/\buid\s*[=:]\s*["']?([^\s"'<>\[\],}]+)/i)?.[1];
    assert.ok(uid, 'native address-input UID missing');
    assertOwnedListener(MARIONETTE_PORT, this.firefox);
    await this.evaluate(() => true);
    await this.call('fill_by_uid', { uid, value });
    assertOwnedListener(MARIONETTE_PORT, this.firefox);
    await this.evaluate(() => true);
    await this.call('press_key', { uid, key: 'Enter' });
    return { selector, mechanism: 'firefox-mcp-native-fill-and-enter', url: value };
  }
  async close() {
    if (!this.proc || this.proc.exitCode != null || this.proc.signalCode != null) return;
    this.proc.stdin.end();
    await waitForExit(this.proc, 5000);
  }
}

export async function takeScreenshot(mcp, target) {
  const value = await mcp.evaluate(async () => {
    const width = window.innerWidth, height = window.innerHeight, dpr = window.devicePixelRatio;
    if (width < 1 || height < 1 || width * height * dpr * dpr > 16777216) throw new Error('screenshot bounds refused');
    const wg = window.docShell?.browsingContext?.currentWindowGlobal;
    if (!wg || wg.isCurrentGlobal !== true) throw new Error('stale Chrome screenshot target');
    const bitmap = await wg.drawSnapshot(new DOMRect(0, 0, width, height), dpr, 'rgb(255,255,255)', { drawView: true });
    try {
      const canvas = document.createElementNS('http://www.w3.org/1999/xhtml', 'canvas');
      canvas.width = bitmap.width; canvas.height = bitmap.height;
      canvas.getContext('2d').drawImage(bitmap, 0, 0);
      return { width: bitmap.width, height: bitmap.height, data: canvas.toDataURL('image/png').split(',')[1] };
    } finally { bitmap.close(); }
  });
  return saveScreenshot(target, value);
}

async function waitForMount(mcp, deadlineMs) {
  for (let i = 0; i < 120; i++) {
    assertBeforeDeadline(deadlineMs);
    const mounted = await mcp.evaluate(() => !!window.__egdesk && !!document.querySelector('#egd-dock'));
    if (mounted) return;
    await pause(250);
  }
  throw new Error('EG-Desk surface did not mount');
}

async function observePinnedLoader(mcp) {
  return mcp.evaluate(() => {
    const node = document.querySelector('.egd-card-nav-btn');
    const inspector = globalThis.InspectorUtils || window.InspectorUtils;
    if (!window.__egdesk || !document.querySelector('#egd-dock') || !node || !inspector?.getMatchingCSSRules) {
      throw new Error('Pinned loader or stylesheet inspector did not mount; no fallback is permitted');
    }
    const rules = Array.from(inspector.getMatchingCSSRules(node, null));
    const modes = [...new Set(rules.filter(rule => (rule.parentStyleSheet?.href || '').includes('eg-desk-surface.uc.css'))
      .map(rule => rule.parentStyleSheet.parsingMode))].sort();
    return { method: 'pinned-fx-autoconfig', alreadyMounted: true, stylesheetModes: modes,
      nativeStyleUri: 'chrome://userstyles/skin/eg-desk-surface.uc.css', exactCssOnly: true };
  });
}

export async function observeBaseline(mcp) {
  return mcp.evaluate(() => {
    const nodes = [...document.querySelectorAll('menuitem, button, [role="menuitem"]')];
    const matches = nodes.filter(node => /import|bookmark|history|가져오|북마크|방문 기록/i.test(
      [node.id, node.getAttribute('label'), node.getAttribute('aria-label'), node.textContent].join(' ')))
      .slice(0, 60).map(node => ({ id: node.id, label: node.getAttribute('label') || node.getAttribute('aria-label') ||
        node.textContent?.trim().slice(0, 100), command: node.getAttribute('command'),
      oncommand: node.getAttribute('oncommand'), hidden: node.hidden }));
    const api = window.__egdesk;
    const snap = api?.surface?.snapshot?.();
    return { matches, cards: [...document.querySelectorAll('.egd-browser-card')].map(card => ({ id: card.id,
      hidden: card.hidden, width: card.getBoundingClientRect().width, height: card.getBoundingClientRect().height })),
    surface: snap || null, loaderRan: !!window.__egdesk && !!document.querySelector('#egd-dock') };
  });
}

async function seedPlaces(mcp, fixturePort) {
  return mcp.evaluate(async port => {
    const { PlacesUtils } = ChromeUtils.importESModule('resource://gre/modules/PlacesUtils.sys.mjs');
    const root = `http://127.0.0.1:${port}/egdesk-browser-import`;
    const bookmark = await PlacesUtils.bookmarks.insert({ parentGuid: PlacesUtils.bookmarks.unfiledGuid,
      title: 'EG-Desk QA Bookmark', url: `${root}/bookmark` });
    const background = await PlacesUtils.bookmarks.insert({ parentGuid: PlacesUtils.bookmarks.unfiledGuid,
      title: 'EG-Desk QA Background Bookmark', url: `${root}/bookmark-background` });
    await PlacesUtils.history.insert({ url: `${root}/history`, title: 'EG-Desk QA History',
      visits: [{ date: new Date(), transition: PlacesUtils.history.TRANSITIONS.LINK }] });
    return { bookmarkGuid: bookmark.guid, bookmark: `${root}/bookmark`, backgroundBookmarkGuid: background.guid,
      backgroundBookmark: `${root}/bookmark-background`, history: `${root}/history`,
      provenance: 'synthetic-localhost-only' };
  }, fixturePort);
}

async function inspectLibrary(mcp) {
  return mcp.evaluate(() => {
    const library = Services.wm.getMostRecentWindow('Places:Organizer');
    if (!library || library.closed) return null;
    const doc = library.document;
    const tree = doc.querySelector('#placeContent');
    let rows = [];
    try {
      const view = tree?.view, count = Math.min(view?.rowCount || 0, 30);
      for (let i = 0; i < count; i++) {
        const node = view.nodeForTreeIndex?.(i);
        rows.push({ index: i, title: node?.title || null, uri: node?.uri || null,
          container: !!view.isContainer?.(i) });
      }
    } catch (error) { rows = [{ error: error.message }]; }
    const r = tree?.getBoundingClientRect();
    return { uri: doc.documentURI, ready: doc.readyState, title: doc.title,
      tree: tree ? { localName: tree.localName, id: tree.id, rows, rowCount: tree.view?.rowCount ?? null,
        rect: r ? { x: r.x, y: r.y, width: r.width, height: r.height } : null } : null,
      anchors: [...doc.querySelectorAll('[id]')].filter(node => /place|content|search|tree/i.test(node.id))
        .slice(0, 35).map(node => ({ id: node.id, localName: node.localName })) };
  });
}

async function surfaceConsoleEvidence(mcp) {
  return mcp.evaluate(() => {
    try {
      return Services.console.getMessageArray().map(item => item.message || '')
        .filter(message => /Firefox Library (?:setup|open)|eg-desk-surface.*(?:error|failed)/i.test(message))
        .slice(-20).map(message => message.slice(0, 1200));
    } catch { return []; }
  });
}

async function browserStyleDiagnostics(mcp) {
  return mcp.evaluate(() => {
    const profile = Services.dirsvc.get('ProfD', Ci.nsIFile);
    const clean = value => value == null ? null : String(value).replaceAll(profile.path, '<owned-qa-profile>').slice(0, 800);
    const cssUrl = 'chrome://userstyles/skin/eg-desk-surface.uc.css';
    const expectedCss = profile.clone(); expectedCss.append('chrome'); expectedCss.append('CSS');
    expectedCss.append('eg-desk-surface.uc.css');
    const userChrome = profile.clone(); userChrome.append('chrome'); userChrome.append('userChrome.css');
    let resolution;
    try {
      const registry = Cc['@mozilla.org/chrome/chrome-registry;1'].getService(Ci.nsIChromeRegistry);
      const uri = registry.convertChromeURL(Services.io.newURI(cssUrl));
      const file = uri.QueryInterface(Ci.nsIFileURL).file;
      resolution = { uri: cssUrl, resolvedScheme: uri.scheme, matchesOwnedProfileCss: file.path === expectedCss.path,
        targetExists: file.exists() };
    } catch (error) { resolution = { uri: cssUrl, error: clean(error.message || String(error)) }; }
    const sheets = [...document.styleSheets].slice(0, 100).map(sheet => {
      let ruleCount = null, error = null;
      try { ruleCount = sheet.cssRules.length; } catch (caught) { error = clean(caught.message || String(caught)); }
      return { href: clean(sheet.href), ownerTag: sheet.ownerNode?.localName || null, disabled: !!sheet.disabled,
        ruleCount, error };
    });
    const computed = selector => {
      const node = document.querySelector(selector);
      if (!node) return null;
      const style = getComputedStyle(node);
      return { namespace: node.namespaceURI, localName: node.localName, className: node.className,
        disabled: !!node.disabled, appearance: style.appearance,
        background: style.backgroundColor, borderStyle: style.borderStyle, borderWidth: style.borderWidth,
        minHeight: style.minHeight, width: style.width, height: style.height, padding: style.padding,
        font: style.font, fontFamily: style.fontFamily, fontSize: style.fontSize, fontWeight: style.fontWeight,
        fontStyle: style.fontStyle, lineHeight: style.lineHeight, textAlign: style.textAlign };
    };
    let matchedRules = null, inspectorError = null, inspectorMethod = null;
    try {
      const inspector = globalThis.InspectorUtils || window.InspectorUtils;
      const method = inspector?.getMatchingCSSRules || inspector?.getCSSStyleRules;
      if (method) {
        inspectorMethod = inspector.getMatchingCSSRules ? 'getMatchingCSSRules' : 'getCSSStyleRules';
        const node = document.querySelector('.egd-browser-menu-item');
        const properties = ['appearance', 'font', 'font-weight', 'font-size', 'padding', 'width', 'min-height', 'background', 'border'];
        matchedRules = Array.from(method.call(inspector, node, null)).map(rule => {
          const declarations = Object.fromEntries(properties.map(name => [name, rule.style?.getPropertyValue(name) || ''])
            .filter(([, value]) => value));
          return { selector: rule.selectorText || null, href: clean(rule.parentStyleSheet?.href),
            parsingMode: rule.parentStyleSheet?.parsingMode || null, declarations };
        }).filter(rule => Object.keys(rule.declarations).length || /egd-browser-menu|egd-edge\s+button/i.test(rule.selector || ''))
          .slice(-50);
      }
    } catch (error) { inspectorError = clean(error.message || String(error)); }
    let consoleCssErrors = [];
    try {
      consoleCssErrors = Services.console.getMessageArray().map(entry => entry.message || '')
        .filter(message => /css|stylesheet|userchrome/i.test(message) && /error|failed|not found|unable|refused/i.test(message))
        .slice(-20).map(clean);
    } catch (error) { consoleCssErrors = [clean(`console sample unavailable: ${error.message}`)]; }
    return { documentUri: clean(document.documentURI), chromeCssRoot: resolution,
      userChromeExists: userChrome.exists(), surfaceCssExists: expectedCss.exists(),
      stylesheetPreference: Services.prefs.getBoolPref('toolkit.legacyUserProfileCustomizations.stylesheets', false),
      documentSheets: sheets, inspectorMethod, matchedRules, inspectorError, consoleCssErrors,
      consoleScope: 'bounded sample from owned Firefox process; not an exhaustive stylesheet audit',
      menuItem: computed('.egd-browser-menu-item'), navButton: computed('.egd-card-nav-btn'),
      dockButton: computed('.egd-dock-btn') };
  });
}

export function styleOriginModes(diagnostics) {
  return [...new Set((diagnostics?.matchedRules || [])
    .filter(rule => rule.selector === '.egd-browser-menu-item' &&
      typeof rule.href === 'string' && rule.href.includes('eg-desk-surface.uc.css'))
    .map(rule => rule.parsingMode).filter(Boolean))].sort();
}

export function sameStyleFixtureState(before, after) {
  return !!before && !!after && JSON.stringify(before) === JSON.stringify(after);
}

async function observeStyleFixtureState(mcp, cardId) {
  return mcp.evaluate(id => {
    const card = document.getElementById(id), menu = document.querySelector('.egd-browser-menu');
    const state = window.__egdesk?.state, browser = window.__egdesk?.browserRuntime?.state(card);
    if (!card || !menu || !state || !browser) throw new Error('Style comparison state is unavailable');
    const active = document.activeElement;
    return { documentUri: document.documentURI, cardId: card.id, uri: browser.uri,
      nativeUri: card._xulBrowser?.currentURI?.spec || null, activeCardId: state.activeEntityId,
      fullscreenCardId: state.cardFullscreen?.cardId || null, pan: { ...state.pan }, panTarget: { ...state.panTarget },
      zoom: state.zoom, zoomTarget: state.zoomTarget, viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
      focus: { tag: active?.localName || null, id: active?.id || null, className: active?.className || null },
      menu: [...menu.querySelectorAll('[role="menuitem"]')].map(node => ({ text: node.textContent.trim(), disabled: !!node.disabled })) };
  }, cardId);
}

async function changePinnedAuthorSheet(mcp, operation) {
  assert.ok(['remove', 'restore'].includes(operation), 'unsupported author-sheet operation');
  return mcp.evaluate(action => {
    const uri = Services.io.newURI('chrome://userstyles/skin/eg-desk-surface.uc.css');
    const inspector = globalThis.InspectorUtils || window.InspectorUtils;
    const node = document.querySelector('.egd-browser-menu-item');
    if (!node || !inspector?.getMatchingCSSRules) throw new Error('Cannot inspect the exact author stylesheet');
    const count = () => Array.from(inspector.getMatchingCSSRules(node, null)).filter(rule =>
      rule.selectorText === '.egd-browser-menu-item' && rule.parentStyleSheet?.href === uri.spec
        && rule.parentStyleSheet.parsingMode === 'author').length;
    const before = count();
    if (action === 'remove') {
      if (before !== 1) throw new Error('Expected exactly one pinned author rule before removal');
      window.windowUtils.removeSheet(uri, Ci.nsIDOMWindowUtils.AUTHOR_SHEET);
    } else {
      if (before !== 0) throw new Error('Refusing to add a duplicate pinned author sheet');
      const service = Cc['@mozilla.org/content/style-sheet-service;1'].getService(Ci.nsIStyleSheetService);
      const sheet = service.preloadSheet(uri, service.AUTHOR_SHEET);
      window.windowUtils.addSheet(sheet, Ci.nsIDOMWindowUtils.AUTHOR_SHEET);
    }
    return { operation: action, uri: uri.spec, before, after: count(), sheetType: 'AUTHOR_SHEET' };
  }, operation);
}

async function observeStyleParity(mcp, result, fixturePort, deadlineMs) {
  result.actions = [];
  const original = `http://127.0.0.1:${fixturePort}/egdesk-browser-import/original`;
  result.actions.push(await mcp.fillAndEnter('[data-testid="first-use-address"]', original));
  let initial;
  for (let i = 0; i < 80; i++) {
    assertBeforeDeadline(deadlineMs);
    const cards = await observeBrowserCards(mcp);
    initial = cards.find(card => card.uri === original && card.nativeUri === original && !card.loading);
    if (initial) break;
    await pause(150);
  }
  assert.ok(initial && /^[A-Za-z0-9_-]+$/.test(initial.id), 'Style comparison requires the loaded synthetic Browser');
  result.actions.push(await mcp.click(`#${initial.id} .egd-card-dot-max`));
  let ready = false;
  for (let i = 0; i < 60; i++) {
    assertBeforeDeadline(deadlineMs);
    ready = await mcp.evaluate(id => {
      const card = document.getElementById(id), dock = document.querySelector('#egd-dock');
      const box = dock?.getBoundingClientRect(), css = dock && getComputedStyle(dock);
      return !!card && !window.__egdesk.state.cardFullscreen && !!box && box.width > 0 && box.height > 0
        && css.display !== 'none' && css.visibility !== 'hidden';
    }, initial.id);
    if (ready) break;
    await pause(150);
  }
  assert.ok(ready, 'Style comparison requires the visible Desk dock');
  result.actions.push(await mcp.click(`#${initial.id} [data-testid="browser-menu"]`));
  let beforeState = null, stableSamples = 0;
  for (let i = 0; i < 40 && stableSamples < 2; i++) {
    assertBeforeDeadline(deadlineMs);
    const nextState = await observeStyleFixtureState(mcp, initial.id);
    stableSamples = sameStyleFixtureState(beforeState, nextState) ? stableSamples + 1 : 0;
    beforeState = nextState;
    if (stableSamples < 2) await pause(150);
  }
  assert.equal(stableSamples, 2, 'Style comparison window and camera must settle before capture');
  const authorBefore = await browserStyleDiagnostics(mcp);
  const authorBeforeScreenshot = await takeScreenshot(mcp, path.join(result.runDir, 'style-author-before.png'));
  result.screenshots.push(authorBeforeScreenshot);
  assert.deepEqual(styleOriginModes(authorBefore), ['author', 'user'], 'Pinned loader did not register both stylesheet origins');
  let removal, userOnly, userState, userScreenshot, restored = false, restoration;
  try {
    removal = await changePinnedAuthorSheet(mcp, 'remove');
    assert.equal(removal.after, 0, 'Pinned author stylesheet was not removed');
    await pause(250);
    userState = await observeStyleFixtureState(mcp, initial.id);
    userOnly = await browserStyleDiagnostics(mcp);
    userScreenshot = await takeScreenshot(mcp, path.join(result.runDir, 'style-user-only.png'));
    result.screenshots.push(userScreenshot);
    assert.deepEqual(styleOriginModes(userOnly), ['user'], 'User-only baseline still has an author stylesheet');
  } finally {
    if (removal?.operation === 'remove') {
      restoration = await changePinnedAuthorSheet(mcp, 'restore');
      restored = restoration.after === 1;
    }
  }
  assert.ok(restored, 'Pinned author stylesheet was not restored');
  await pause(250);
  const afterState = await observeStyleFixtureState(mcp, initial.id);
  const authorAfter = await browserStyleDiagnostics(mcp);
  const authorAfterScreenshot = await takeScreenshot(mcp, path.join(result.runDir, 'style-author-restored.png'));
  result.screenshots.push(authorAfterScreenshot);
  const stateUnchanged = sameStyleFixtureState(beforeState, userState) && sameStyleFixtureState(beforeState, afterState);
  const restoredComputed = ['menuItem', 'navButton', 'dockButton']
    .every(key => !!authorBefore[key] && JSON.stringify(authorBefore[key]) === JSON.stringify(authorAfter[key]));
  const originParity = JSON.stringify(styleOriginModes(authorAfter)) === JSON.stringify(['author', 'user']);
  result.styleParity = { method: 'single-window-identical-state-remove-and-restore-exact-pinned-author-sheet',
    sameWindowContext: mcp.context, stateUnchanged, restoredComputed, originParity, removal, restoration,
    beforeState, userState, afterState,
    authorBefore: { diagnostics: authorBefore, screenshot: authorBeforeScreenshot },
    userOnly: { diagnostics: userOnly, screenshot: userScreenshot },
    authorRestored: { diagnostics: authorAfter, screenshot: authorAfterScreenshot } };
  result.checks.push({ name: 'pinned author sheet is removed and restored without changing the window or Desk state',
    passed: stateUnchanged && restored && originParity });
  result.checks.push({ name: 'restored author sheet reproduces menu, dock and navigation computed styles', passed: restoredComputed });
}

async function nativeTabEvidence(mcp) {
  return mcp.evaluate(() => [...(window.gBrowser?.tabs || [])].map(tab => ({
    selected: !!tab.selected, uri: tab.linkedBrowser?.currentURI?.spec || null,
  })));
}

async function observeBrowserCards(mcp) {
  return mcp.evaluate(() => [...document.querySelectorAll('.egd-browser-card')].map(card => {
    const state = window.__egdesk.browserRuntime.state(card), browser = card._xulBrowser;
    const rect = card.getBoundingClientRect(), content = browser?.getBoundingClientRect(), css = getComputedStyle(card);
    const left = Math.max(0, content?.left ?? rect.left), top = Math.max(0, content?.top ?? rect.top);
    const right = Math.min(innerWidth, content?.right ?? rect.right), bottom = Math.min(innerHeight, content?.bottom ?? rect.bottom);
    const hit = right - left >= 200 && bottom - top >= 100
      ? document.elementFromPoint((left + right) / 2, (top + bottom) / 2) : null;
    return { id: card.id, uri: state?.uri || null, title: state?.title || null, loading: !!state?.loading,
      nativeUri: browser?.currentURI?.spec || null, nativeTitle: browser?.contentTitle || null,
      rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom },
      contentVisiblePixels: { width: Math.max(0, right - left), height: Math.max(0, bottom - top) },
      visible: !!hit && (card === hit || card.contains(hit)) && css.visibility !== 'hidden' && css.display !== 'none' };
  }));
}

export function sameCardGeometry(left, right) {
  return !!left && !!right && left.id === right.id && ['left', 'top', 'right', 'bottom']
    .every(key => Math.abs(left.rect[key] - right.rect[key]) < 1);
}

export function sameFullscreenCamera(before, after) {
  if (!before || !after || !before.cardId || before.cardId !== after.cardId ||
      before.fullscreenCardId !== before.cardId || after.fullscreenCardId !== before.cardId ||
      before.activeCardId !== before.cardId || after.activeCardId !== before.cardId ||
      !before.rect || !after.rect || !before.pan || !after.pan || !before.panTarget || !after.panTarget ||
      !before.viewport || !after.viewport) return false;
  const close = (left, right, tolerance = 1) => Number.isFinite(left) && Number.isFinite(right)
    && Math.abs(left - right) < tolerance;
  return ['left', 'top', 'right', 'bottom'].every(key => close(before.rect[key], after.rect[key]))
    && ['x', 'y'].every(key => close(before.pan[key], after.pan[key]) && close(before.panTarget[key], after.panTarget[key]))
    && close(before.zoom, after.zoom, 0.001) && close(before.zoomTarget, after.zoomTarget, 0.001)
    && before.viewport.width === after.viewport.width && before.viewport.height === after.viewport.height;
}

export function fullscreenEdgesUncropped(camera) {
  const rect = camera?.rect, viewport = camera?.viewport;
  return !!rect && !!viewport && ['left', 'top', 'right', 'bottom'].every(key => Number.isFinite(rect[key]))
    && Number.isFinite(viewport.width) && Number.isFinite(viewport.height) && viewport.width > 0 && viewport.height > 0
    && rect.left >= -2 && rect.top >= -2 && rect.right <= viewport.width + 2 && rect.bottom <= viewport.height + 2;
}

async function observeFullscreenCamera(mcp, cardId) {
  return mcp.evaluate(id => {
    const card = document.getElementById(id), state = window.__egdesk?.state;
    if (!card || !state) throw new Error('fullscreen Browser camera target is unavailable');
    const rect = card.getBoundingClientRect();
    return { cardId: card.id, fullscreenCardId: state.cardFullscreen?.cardId || null,
      activeCardId: state.activeEntityId || null, rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom },
      pan: { x: state.pan.x, y: state.pan.y }, panTarget: { x: state.panTarget.x, y: state.panTarget.y },
      zoom: state.zoom, zoomTarget: state.zoomTarget, viewport: { width: innerWidth, height: innerHeight } };
  }, cardId);
}

async function captureLibrary(mcp, target) {
  const value = await mcp.evaluate(async () => {
    const library = Services.wm.getMostRecentWindow('Places:Organizer');
    if (!library || library.closed || library.document.documentURI !== 'chrome://browser/content/places/places.xhtml') {
      throw new Error('Owned Firefox Library not available');
    }
    const width = library.innerWidth, height = library.innerHeight, dpr = library.devicePixelRatio;
    if (width < 1 || height < 1 || width * height * dpr * dpr > 16777216) throw new Error('Library screenshot bounds refused');
    const wg = library.docShell?.browsingContext?.currentWindowGlobal;
    if (!wg || wg.isCurrentGlobal !== true) throw new Error('stale Library screenshot target');
    const bitmap = await wg.drawSnapshot(new library.DOMRect(0, 0, width, height), dpr, 'rgb(255,255,255)', { drawView: true });
    try {
      const canvas = library.document.createElementNS('http://www.w3.org/1999/xhtml', 'canvas');
      canvas.width = bitmap.width; canvas.height = bitmap.height;
      canvas.getContext('2d').drawImage(bitmap, 0, 0);
      return { width: bitmap.width, height: bitmap.height, data: canvas.toDataURL('image/png').split(',')[1] };
    } finally { bitmap.close(); }
  });
  return saveScreenshot(target, value);
}

async function findTreePoint(mcp, selector, uri) {
  return mcp.evaluate(({ selector, uri }) => {
    const tree = document.querySelector(selector), view = tree?.view;
    if (!tree || !view) throw new Error('Places tree unavailable');
    let index = -1;
    for (let i = 0; i < view.rowCount; i++) {
      const node = view.nodeForTreeIndex(i);
      if (node?.uri === uri || (uri === 'unfiled' && String(node?.uri).includes('unfiled_____'))) { index = i; break; }
    }
    if (index < 0) return null;
    const body = tree.treeBody?.getBoundingClientRect(), rowHeight = tree.rowHeight, first = tree.getFirstVisibleRow();
    if (!body || !rowHeight) throw new Error('Places tree geometry unavailable');
    const x = Math.floor(body.x + Math.min(70, body.width / 2));
    const y = Math.floor(body.y + (index - first + 0.5) * rowHeight);
    const hit = tree.getCellAt(x, y);
    if (hit.row !== index || y < body.y || y >= body.bottom) throw new Error('Places row is not visibly clickable');
    return { x, y, index, uri: view.nodeForTreeIndex(index)?.uri || null };
  }, { selector, uri });
}

async function installPlacesObserver(mcp) {
  return mcp.evaluate(() => {
    const slot = '__egdeskQaPlacesObserver';
    if (window[slot]) throw new Error('Places observer already installed');
    const original = window.openTrustedLinkIn, keys = [];
    const onKey = event => { if (event.key === 'Enter') keys.push({ trusted: event.isTrusted,
      meta: event.metaKey, shift: event.shiftKey, ctrl: event.ctrlKey,
      target: event.target?.localName || null, selectedUri: document.querySelector('#placeContent')?.selectedNode?.uri || null }); };
    document.addEventListener('keydown', onKey, true);
    window[slot] = { original, keys, onKey };
    const owner = window[Symbol.for('egdesk.firefox.library.routing.v1')];
    const placesDescriptor = Object.getOwnPropertyDescriptor(window, 'PlacesUIUtils');
    return { installed: true, previousFunctionName: original.name || null,
      ownerPresent: !!owner, ownerInstalled: owner?.isInstalled?.() ?? null,
      ownerChecks: owner?.installationChecks?.() ?? null,
      openPreferencesName: window.openPreferences?.name || null,
      placesDescriptor: placesDescriptor ? { configurable: placesDescriptor.configurable,
        writable: placesDescriptor.writable ?? null, getter: typeof placesDescriptor.get === 'function' } : null,
      placesOpenNodeName: window.PlacesUIUtils?.openNodeWithEvent?.name || null,
      placesOpenTabsetName: window.PlacesUIUtils?.openTabset?.name || null,
      preferences: { loadBookmarksInTabs: Services.prefs.getBoolPref('browser.tabs.loadBookmarksInTabs', false),
        loadInBackground: Services.prefs.getBoolPref('browser.tabs.loadInBackground', false) } };
  });
}

async function collectPlacesObserver(mcp) {
  return mcp.evaluate(() => {
    const slot = '__egdeskQaPlacesObserver', observer = window[slot];
    if (!observer) throw new Error('Places observer ownership changed');
    document.removeEventListener('keydown', observer.onKey, true);
    delete window[slot];
    return { enterEvents: observer.keys, openFunctionUnchanged: window.openTrustedLinkIn === observer.original };
  });
}

async function observeNativeLibrary(mcp, result, fixturePort, deadlineMs) {
  assertBeforeDeadline(deadlineMs);
  result.syntheticPlaces = await seedPlaces(mcp, fixturePort);
  const original = `http://127.0.0.1:${fixturePort}/egdesk-browser-import/original`;
  result.actions = [await mcp.fillAndEnter('[data-testid="first-use-address"]', original)];
  let originalBrowser;
  for (let i = 0; i < 80; i++) {
    assertBeforeDeadline(deadlineMs);
    originalBrowser = await mcp.evaluate(() => {
      const snapshot = window.__egdesk.surface.snapshot(), card = document.getElementById(snapshot.browserCardId);
      return { cardId: card?.id || null, uri: window.__egdesk.browserRuntime.state(card)?.uri || null,
        nativeUri: card?._xulBrowser?.currentURI?.spec || null };
    });
    if (originalBrowser.uri === original && originalBrowser.nativeUri === original) break;
    await pause(150);
  }
  assert.ok(originalBrowser.uri === original && originalBrowser.nativeUri === original,
    'nonempty original Browser fixture did not load');
  result.originalBrowser = originalBrowser;
  result.screenshots.push(await takeScreenshot(mcp, path.join(result.runDir, 'original-browser.png')));
  assertBeforeDeadline(deadlineMs);
  result.actions.push(await mcp.click('[data-testid="browser-menu"]'));
  result.menu = await mcp.evaluate(() => [...document.querySelectorAll('.egd-browser-menu [role="menuitem"]')]
    .map(node => ({ text: node.textContent.trim(), testid: node.dataset.testid || null, disabled: !!node.disabled })));
  result.menuStyle = await mcp.evaluate(() => {
    const panel = document.querySelector('.egd-browser-menu'), item = panel?.querySelector('.egd-browser-menu-item');
    if (!panel || !item) throw new Error('Browser menu style target missing');
    const root = getComputedStyle(document.documentElement), menu = getComputedStyle(panel), button = getComputedStyle(item);
    return { legacyUserStylesheetsEnabled: Services.prefs.getBoolPref('toolkit.legacyUserProfileCustomizations.stylesheets', false),
      tokenOnSurface: root.getPropertyValue('--egd-on-surface').trim(),
      panel: { display: menu.display, position: menu.position, width: menu.width, background: menu.backgroundColor,
        border: menu.borderWidth, radius: menu.borderRadius, boxShadow: menu.boxShadow },
      item: { appearance: button.appearance, background: button.backgroundColor, backgroundImage: button.backgroundImage,
        borderStyle: button.borderStyle, borderWidth: button.borderWidth, borderRadius: button.borderRadius,
        color: button.color, minHeight: button.minHeight },
      surfaceRulesObserved: menu.position === 'fixed' && menu.display === 'flex'
        && button.minHeight === '28px' && !!root.getPropertyValue('--egd-on-surface').trim(),
      visualApproval: 'not-run; computed styles and screenshot are diagnostic only' };
  });
  result.styleDiagnostics = await browserStyleDiagnostics(mcp);
  result.screenshots.push(await takeScreenshot(mcp, path.join(result.runDir, 'browser-menu.png')));
  assert.ok(result.menu.some(item => item.testid === 'browser-library-bookmarks'), 'bookmark command missing from Browser menu');
  assertBeforeDeadline(deadlineMs);
  result.actions.push(await mcp.click('[data-testid="browser-library-bookmarks"]'));
  let library;
  for (let i = 0; i < 80; i++) {
    assertBeforeDeadline(deadlineMs);
    library = await inspectLibrary(mcp);
    if (library?.ready === 'complete' && library.tree) break;
    await pause(150);
  }
  assert.ok(library?.tree, 'native Places Library did not open');
  result.library = library;
  result.privilegedContextsAfterLibrary = (await mcp.call('list_privileged_contexts')).text;
  result.screenshots.push(await captureLibrary(mcp, path.join(result.runDir, 'library-bookmarks.png')));
  await mcp.selectContext('chrome://browser/content/places/places.xhtml');
  let folderPoint = await findTreePoint(mcp, '#placesList', 'unfiled');
  assert.ok(folderPoint, 'fixture bookmark folder is not visible');
  assertBeforeDeadline(deadlineMs);
  result.actions.push(await mcp.clickPoint(folderPoint));
  let bookmarkPoint;
  for (let i = 0; i < 80; i++) {
    assertBeforeDeadline(deadlineMs);
    bookmarkPoint = await findTreePoint(mcp, '#placeContent', result.syntheticPlaces.bookmark);
    if (bookmarkPoint) break;
    await pause(150);
  }
  assert.ok(bookmarkPoint, 'synthetic bookmark did not appear in native Library');
  result.screenshots.push(await takeScreenshot(mcp, path.join(result.runDir, 'bookmark-row.png')));
  assertBeforeDeadline(deadlineMs);
  result.actions.push(await mcp.clickPoint(bookmarkPoint));
  const selected = await mcp.evaluate(() => ({ title: document.querySelector('#placeContent')?.selectedNode?.title || null,
    uri: document.querySelector('#placeContent')?.selectedNode?.uri || null }));
  assert.equal(selected.uri, result.syntheticPlaces.bookmark, 'native bookmark selection did not match fixture');
  result.nativeBookmarkSelection = selected;
  result.bookmarkObserver = await installPlacesObserver(mcp);
  assertBeforeDeadline(deadlineMs);
  result.actions.push(await mcp.pressEnter());
  result.bookmarkNativeCall = await collectPlacesObserver(mcp);
  result.checks.push({ name: 'bookmark uses trusted native Enter on the selected Places row', passed:
    result.bookmarkNativeCall.enterEvents.some(event => event.trusted && event.selectedUri === result.syntheticPlaces.bookmark)
      && result.bookmarkNativeCall.openFunctionUnchanged });
  await mcp.selectContext('chrome://browser/content/browser.xhtml');
  const before = result.originalBrowser;
  let after, previousTarget = null, stableSamples = 0;
  for (let i = 0; i < 60; i++) {
    assertBeforeDeadline(deadlineMs);
    after = await observeBrowserCards(mcp);
    const target = after.find(card => card.id !== before.cardId && card.uri === result.syntheticPlaces.bookmark
      && card.nativeUri === result.syntheticPlaces.bookmark && card.nativeTitle === 'EG-Desk QA bookmark'
      && !card.loading && card.visible);
    stableSamples = target ? (sameCardGeometry(previousTarget, target) ? stableSamples + 1 : 1) : 0;
    previousTarget = target;
    if (stableSamples >= 2) break;
    await pause(150);
  }
  result.afterBookmark = after;
  result.nativeTabsAfterBookmark = await nativeTabEvidence(mcp);
  result.consoleAfterBookmark = await surfaceConsoleEvidence(mcp);
  result.screenshots.push(await takeScreenshot(mcp, path.join(result.runDir, 'after-bookmark.png')));
  const preserved = after.some(card => card.id === before.cardId && card.uri === before.uri && card.nativeUri === before.nativeUri);
  const opened = after.some(card => card.id !== before.cardId && card.uri === result.syntheticPlaces.bookmark
    && card.nativeUri === result.syntheticPlaces.bookmark && card.nativeTitle === 'EG-Desk QA bookmark'
    && !card.loading && card.visible) && stableSamples >= 2;
  result.checks.push({ name: 'native bookmark opens a visible new Browser card', passed: opened });
  result.checks.push({ name: 'native unmodified bookmark is foreground despite background-tab preference', passed:
    opened && result.bookmarkObserver.preferences.loadInBackground === true });
  result.checks.push({ name: 'original Browser URL remains unchanged', passed: preserved });
  result.checks.push({ name: 'bookmark does not also open in a hidden Firefox tab', passed:
    result.nativeTabsAfterBookmark.every(tab => tab.uri !== result.syntheticPlaces.bookmark) });
  result.bookmarkPassed = opened && preserved;
}

async function observeHistoryLibrary(mcp, result, deadlineMs) {
  const candidate = result.afterBookmark.find(card => card.visible);
  assert.ok(candidate && /^[A-Za-z0-9_-]+$/.test(candidate.id), 'No visible Browser card for the history story');
  assertBeforeDeadline(deadlineMs);
  result.actions.push(await mcp.click(`#${candidate.id} .egd-card-dot-max`));
  let fullscreenBefore, previousFullscreen = null, stableFullscreen = 0;
  for (let i = 0; i < 60; i++) {
    assertBeforeDeadline(deadlineMs);
    fullscreenBefore = await observeFullscreenCamera(mcp, candidate.id);
    stableFullscreen = sameFullscreenCamera(previousFullscreen, fullscreenBefore) ? stableFullscreen + 1 : 0;
    previousFullscreen = fullscreenBefore;
    if (stableFullscreen >= 1) break;
    await pause(150);
  }
  assert.ok(stableFullscreen >= 1 && fullscreenBefore.fullscreenCardId === candidate.id,
    'history source Browser did not reach stable fullscreen');
  result.historyFullscreenBefore = fullscreenBefore;
  result.screenshots.push(await takeScreenshot(mcp, path.join(result.runDir, 'history-fullscreen-before.png')));
  assertBeforeDeadline(deadlineMs);
  result.actions.push(await mcp.click(`#${candidate.id} [data-testid="browser-menu"]`));
  result.actions.push(await mcp.click('[data-testid="browser-library-history"]'));
  let library;
  for (let i = 0; i < 80; i++) {
    assertBeforeDeadline(deadlineMs);
    library = await inspectLibrary(mcp);
    if (library?.ready === 'complete' && library.tree) break;
    await pause(150);
  }
  assert.ok(library?.tree, 'native history Library did not open');
  let selectedHistory;
  for (let i = 0; i < 20; i++) {
    selectedHistory = await mcp.evaluate(() => Services.wm.getMostRecentWindow('Places:Organizer')
      ?.document.querySelector('#placesList')?.selectedNode?.uri || null);
    if (selectedHistory === 'place:type=3&sort=4') break;
    await pause(100);
  }
  result.historyMenuSelected = selectedHistory;
  result.checks.push({ name: 'history menu switches the reused native Library to History',
    passed: selectedHistory === 'place:type=3&sort=4' });
  result.historyLibrary = library;
  result.screenshots.push(await captureLibrary(mcp, path.join(result.runDir, 'library-history.png')));
  await mcp.selectContext('chrome://browser/content/places/places.xhtml');
  result.historyTrees = await mcp.evaluate(() => Object.fromEntries(['#placesList', '#placeContent'].map(selector => {
    const tree = document.querySelector(selector), rows = [];
    for (let index = 0; index < Math.min(tree?.view?.rowCount || 0, 50); index++) {
      const node = tree.view.nodeForTreeIndex(index);
      rows.push({ index, title: node?.title || null, uri: node?.uri || null, container: !!tree.view.isContainer(index) });
    }
    return [selector, rows];
  })));
  const historyRoot = result.historyTrees['#placesList'].find(row => row.uri === 'place:type=3&sort=4');
  assert.ok(historyRoot, 'native history root is not present');
  const historyRootPoint = await findTreePoint(mcp, '#placesList', historyRoot.uri);
  assert.ok(historyRootPoint, 'native history root is not visible');
  assertBeforeDeadline(deadlineMs);
  result.actions.push(await mcp.clickPoint(historyRootPoint));
  await pause(300);
  result.historyRowsAfterRootClick = await mcp.evaluate(() => {
    const tree = document.querySelector('#placeContent'), rows = [];
    for (let index = 0; index < Math.min(tree?.view?.rowCount || 0, 50); index++) {
      const node = tree.view.nodeForTreeIndex(index);
      rows.push({ index, title: node?.title || null, uri: node?.uri || null, container: !!tree.view.isContainer(index) });
    }
    return rows;
  });
  result.screenshots.push(await takeScreenshot(mcp, path.join(result.runDir, 'history-root.png')));
  const day = result.historyRowsAfterRootClick.find(row => row.container && row.uri?.startsWith('place:'));
  assert.ok(day, 'native history date container not available');
  const twisty = await mcp.evaluate(() => {
    const tree = document.querySelector('#placesList'), view = tree.view, body = tree.treeBody.getBoundingClientRect();
    const index = Array.from({ length: view.rowCount }, (_, i) => i)
      .find(i => view.nodeForTreeIndex(i)?.uri === 'place:type=3&sort=4');
    if (index == null) throw new Error('native history root not found');
    if (view.isContainerOpen(index)) return { alreadyOpen: true };
    const y = Math.floor(body.y + (index - tree.getFirstVisibleRow() + 0.5) * tree.rowHeight);
    for (let x = Math.ceil(body.left); x < Math.min(body.left + 30, body.right); x++) {
      const hit = tree.getCellAt(x, y);
      if (hit.row === index && hit.childElt === 'twisty') return { x, y, index };
    }
    throw new Error('native history expander is not visibly clickable');
  });
  if (!twisty.alreadyOpen) {
    assertBeforeDeadline(deadlineMs);
    result.actions.push(await mcp.clickPoint(twisty));
  }
  let dayPoint;
  for (let i = 0; i < 40; i++) {
    assertBeforeDeadline(deadlineMs);
    dayPoint = await findTreePoint(mcp, '#placesList', day.uri);
    if (dayPoint) break;
    await pause(150);
  }
  assert.ok(dayPoint, 'native history date row did not appear');
  result.actions.push(await mcp.clickPoint(dayPoint));
  let historyPoint;
  for (let i = 0; i < 60; i++) {
    assertBeforeDeadline(deadlineMs);
    historyPoint = await findTreePoint(mcp, '#placeContent', result.syntheticPlaces.history);
    if (historyPoint) break;
    await pause(150);
  }
  assert.ok(historyPoint, 'synthetic history entry did not appear in native Library');
  result.screenshots.push(await takeScreenshot(mcp, path.join(result.runDir, 'history-row.png')));
  result.actions.push(await mcp.clickPoint(historyPoint));
  const selected = await mcp.evaluate(() => ({ title: document.querySelector('#placeContent')?.selectedNode?.title || null,
    uri: document.querySelector('#placeContent')?.selectedNode?.uri || null }));
  assert.equal(selected.uri, result.syntheticPlaces.history, 'native history selection did not match fixture');
  result.nativeHistorySelection = selected;
  result.historyObserver = await installPlacesObserver(mcp);
  assertBeforeDeadline(deadlineMs);
  result.actions.push(await mcp.pressEnter());
  result.historyNativeCall = await collectPlacesObserver(mcp);
  result.checks.push({ name: 'history uses trusted native Enter on the selected Places row', passed:
    result.historyNativeCall.enterEvents.some(event => event.trusted && event.selectedUri === result.syntheticPlaces.history)
      && result.historyNativeCall.openFunctionUnchanged });
  await mcp.selectContext('chrome://browser/content/browser.xhtml');
  let historyCards, previousTarget = null, stableSamples = 0;
  for (let i = 0; i < 60; i++) {
    assertBeforeDeadline(deadlineMs);
    historyCards = await observeBrowserCards(mcp);
    const target = historyCards.find(card => card.uri === result.syntheticPlaces.history
      && card.nativeUri === result.syntheticPlaces.history && card.nativeTitle === 'EG-Desk QA history'
      && !card.loading && card.visible);
    stableSamples = target ? (sameCardGeometry(previousTarget, target) ? stableSamples + 1 : 1) : 0;
    previousTarget = target;
    if (stableSamples >= 2) break;
    await pause(150);
  }
  result.afterHistory = historyCards;
  result.historyFullscreenAfter = await observeFullscreenCamera(mcp, candidate.id);
  result.nativeTabsAfterHistory = await nativeTabEvidence(mcp);
  result.consoleAfterHistory = await surfaceConsoleEvidence(mcp);
  result.screenshots.push(await takeScreenshot(mcp, path.join(result.runDir, 'after-history.png')));
  result.historyPassed = historyCards.some(card => card.uri === result.syntheticPlaces.history
    && card.nativeUri === result.syntheticPlaces.history && card.nativeTitle === 'EG-Desk QA history'
    && !card.loading && card.visible) && stableSamples >= 2;
  result.checks.push({ name: 'native history selection opens in a visible Browser card', passed: result.historyPassed });
  result.checks.push({ name: 'same-card fullscreen history keeps camera and all card edges unchanged', passed:
    historyCards.some(card => card.id === candidate.id && card.uri === result.syntheticPlaces.history && card.visible)
      && fullscreenEdgesUncropped(result.historyFullscreenBefore) && fullscreenEdgesUncropped(result.historyFullscreenAfter)
      && sameFullscreenCamera(result.historyFullscreenBefore, result.historyFullscreenAfter) });
  result.checks.push({ name: 'history does not also open in a hidden Firefox tab', passed:
    result.nativeTabsAfterHistory.every(tab => tab.uri !== result.syntheticPlaces.history) });
}

async function observeBackgroundBookmark(mcp, result, deadlineMs) {
  const sourceId = result.historyFullscreenAfter?.cardId;
  assert.ok(sourceId && /^[A-Za-z0-9_-]+$/.test(sourceId), 'No owned fullscreen Browser for background test');
  const before = await observeFullscreenCamera(mcp, sourceId);
  assert.equal(before.fullscreenCardId, sourceId, 'Background test requires the source card fullscreen');
  result.actions.push(await mcp.click(`#${sourceId} [data-testid="browser-menu"]`));
  result.actions.push(await mcp.click('[data-testid="browser-library-bookmarks"]'));
  let library;
  for (let i = 0; i < 60; i++) {
    assertBeforeDeadline(deadlineMs);
    library = await inspectLibrary(mcp);
    if (library?.ready === 'complete' && library.tree) break;
    await pause(150);
  }
  assert.ok(library?.tree, 'native Library unavailable for background bookmark');
  await mcp.selectContext('chrome://browser/content/places/places.xhtml');
  const folder = await findTreePoint(mcp, '#placesList', 'unfiled');
  assert.ok(folder, 'background bookmark folder is unavailable');
  result.actions.push(await mcp.clickPoint(folder));
  let point;
  for (let i = 0; i < 60; i++) {
    assertBeforeDeadline(deadlineMs);
    point = await findTreePoint(mcp, '#placeContent', result.syntheticPlaces.backgroundBookmark);
    if (point) break;
    await pause(150);
  }
  assert.ok(point, 'background bookmark row is unavailable');
  result.actions.push(await mcp.clickPoint(point));
  const selected = await mcp.evaluate(() => document.querySelector('#placeContent')?.selectedNode?.uri || null);
  assert.equal(selected, result.syntheticPlaces.backgroundBookmark, 'native selected a different background bookmark');
  result.backgroundObserver = await installPlacesObserver(mcp);
  result.actions.push(await mcp.pressBackgroundEnter());
  result.backgroundNativeCall = await collectPlacesObserver(mcp);
  await mcp.selectContext('chrome://browser/content/browser.xhtml');
  let cards, target;
  for (let i = 0; i < 80; i++) {
    assertBeforeDeadline(deadlineMs);
    cards = await observeBrowserCards(mcp);
    target = cards.find(card => card.id !== sourceId && card.uri === result.syntheticPlaces.backgroundBookmark
      && card.nativeUri === result.syntheticPlaces.backgroundBookmark && card.nativeTitle === 'EG-Desk QA bookmark-background'
      && !card.loading);
    if (target) break;
    await pause(150);
  }
  const after = await observeFullscreenCamera(mcp, sourceId);
  const tabs = await nativeTabEvidence(mcp);
  const trusted = result.backgroundNativeCall.enterEvents.some(event => event.trusted && event.meta && event.shift
    && event.selectedUri === result.syntheticPlaces.backgroundBookmark) && result.backgroundNativeCall.openFunctionUnchanged;
  const source = cards.find(card => card.id === sourceId);
  result.backgroundObservation = { before, after, target: target || null, source, tabs };
  result.checks.push({ name: 'background bookmark uses trusted native Meta+Shift+Enter', passed: trusted });
  result.checks.push({ name: 'background bookmark loads a separate Browser card without changing fullscreen focus or camera',
    passed: !!target && !!source?.visible && source.uri === result.syntheticPlaces.history
      && source.nativeUri === result.syntheticPlaces.history && sameFullscreenCamera(before, after) });
  result.checks.push({ name: 'background bookmark does not open in a hidden Firefox tab',
    passed: tabs.every(tab => tab.uri !== result.syntheticPlaces.backgroundBookmark) });
  result.screenshots.push(await takeScreenshot(mcp, path.join(result.runDir, 'background-bookmark.png')));
}

async function seedOwnershipPlaces(mcp, fixturePort) {
  return mcp.evaluate(async port => {
    const { PlacesUtils } = ChromeUtils.importESModule('resource://gre/modules/PlacesUtils.sys.mjs');
    Services.prefs.setBoolPref('browser.tabs.loadBookmarksInTabs', false);
    const root = `http://127.0.0.1:${port}/egdesk-browser-import`, urls = {};
    for (const suffix of ['owner-a', 'owner-b', 'owner-c', 'owner-d']) {
      urls[suffix] = `${root}/${suffix}`;
      await PlacesUtils.bookmarks.insert({ parentGuid: PlacesUtils.bookmarks.unfiledGuid,
        title: `EG-Desk QA ${suffix}`, url: urls[suffix] });
    }
    return { urls, loadBookmarksInTabs: Services.prefs.getBoolPref('browser.tabs.loadBookmarksInTabs'),
      provenance: 'synthetic-localhost-only' };
  }, fixturePort);
}

async function waitForOwnedCard(mcp, cardId, url, deadlineMs) {
  let cards = [];
  for (let i = 0; i < 80; i++) {
    assertBeforeDeadline(deadlineMs);
    cards = await observeBrowserCards(mcp);
    const target = cards.find(card => card.id === cardId && card.uri === url && card.nativeUri === url && !card.loading);
    if (target) return { target, cards };
    await pause(150);
  }
  return { target: null, cards };
}

async function ownershipBookmarkSelection(mcp, result, { owner, other, url, otherExpected, label }, deadlineMs) {
  const browserUri = 'chrome://browser/content/browser.xhtml';
  await mcp.selectContext(browserUri, owner.context);
  const before = await observeBrowserCards(mcp);
  const targetBefore = before.find(card => card.id === owner.cardId);
  assert.ok(targetBefore?.visible, `Owner ${owner.name} Browser is not visible for input`);
  result.actions.push(await mcp.click(`#${owner.cardId} [data-testid="browser-menu"]`));
  result.actions.push(await mcp.click('[data-testid="browser-library-bookmarks"]'));
  let library;
  for (let i = 0; i < 60; i++) {
    assertBeforeDeadline(deadlineMs);
    library = await inspectLibrary(mcp);
    if (library?.ready === 'complete' && library.tree) break;
    await pause(150);
  }
  assert.ok(library?.tree, 'owned Library did not open for transfer');
  await mcp.selectContext('chrome://browser/content/places/places.xhtml');
  const folder = await findTreePoint(mcp, '#placesList', 'unfiled');
  assert.ok(folder, 'owned bookmark folder is unavailable');
  result.actions.push(await mcp.clickPoint(folder));
  let point;
  for (let i = 0; i < 60; i++) {
    assertBeforeDeadline(deadlineMs);
    point = await findTreePoint(mcp, '#placeContent', url);
    if (point) break;
    await pause(150);
  }
  assert.ok(point, 'owned bookmark row is unavailable');
  result.actions.push(await mcp.clickPoint(point));
  const selection = await mcp.evaluate(() => document.querySelector('#placeContent')?.selectedNode?.uri || null);
  assert.equal(selection, url, 'native selected a different bookmark');
  const observer = await installPlacesObserver(mcp);
  result.actions.push(await mcp.pressEnter());
  const input = await collectPlacesObserver(mcp);
  const trusted = input.enterEvents.some(event => event.trusted && event.selectedUri === url) && input.openFunctionUnchanged;
  await mcp.selectContext(browserUri, owner.context);
  const target = await waitForOwnedCard(mcp, owner.cardId, url, deadlineMs);
  const ownerTabs = await nativeTabEvidence(mcp);
  result.screenshots.push(await takeScreenshot(mcp, path.join(result.runDir, `ownership-${label}.png`)));
  let otherCard = null, otherTabs = [], preserved = true;
  if (other) {
    await mcp.selectContext(browserUri, other.context);
    const otherCards = await observeBrowserCards(mcp);
    otherCard = otherCards.find(card => card.id === other.cardId);
    otherTabs = await nativeTabEvidence(mcp);
    preserved = !!otherCard && otherCard.uri === otherExpected && otherCard.nativeUri === otherExpected;
  }
  const noHiddenTab = [...ownerTabs, ...otherTabs].every(tab => tab.uri !== url);
  const passed = trusted && observer.ownerInstalled === true && target.target?.visible === true && preserved && noHiddenTab;
  const step = { label, owner: owner.name, other: other?.name || null, trustedNativeEnter: trusted,
    ownerInstalled: observer.ownerInstalled, ownerChecks: observer.ownerChecks,
    target: target.target, ownerCards: target.cards, otherCard, otherExpected, ownerTabs, otherTabs, noHiddenTab, passed };
  result.ownershipSteps.push(step);
  result.checks.push({ name: `native Library ownership ${label} routes only to ${owner.name}`, passed });
  if (!passed) throw new Error(`Native Library ownership ${label} failed; no later UI actions were attempted`);
}

async function observeMultiWindowOwnership(mcp, result, fixturePort, deadlineMs) {
  const browserUri = 'chrome://browser/content/browser.xhtml';
  result.actions = []; result.ownershipSteps = [];
  result.ownershipFixture = await seedOwnershipPlaces(mcp, fixturePort);
  assert.equal(result.ownershipFixture.loadBookmarksInTabs, false, 'ownership scenario requires current-card navigation');
  const primaryId = mcp.context;
  const initial = await observeBrowserCards(mcp), first = initial.find(card => card.visible);
  assert.ok(first && /^[A-Za-z0-9_-]+$/.test(first.id), 'Primary owned Browser is not visible');
  const startA = `http://127.0.0.1:${fixturePort}/egdesk-browser-import/owner-start-a`;
  const startB = `http://127.0.0.1:${fixturePort}/egdesk-browser-import/owner-start-b`;
  result.actions.push(await mcp.fillAndEnter(`#${first.id} .egd-card-url`, startA));
  assert.ok((await waitForOwnedCard(mcp, first.id, startA, deadlineMs)).target, 'Primary setup page did not load');
  const initialContexts = await mcp.listContexts();
  assert.equal(initialContexts.filter(context => context.uri === browserUri).length, 1, 'Primary browser context is ambiguous');
  assertBeforeDeadline(deadlineMs);
  const created = await mcp.evaluate(() => {
    const second = window.openDialog('chrome://browser/content/browser.xhtml', '_blank', 'chrome,all,dialog=no', 'about:blank');
    if (!second) throw new Error('Second owned headless browser window was not created');
    second.__egdeskQaOwnedSecondWindow = true;
    window.__egdeskQaSecondWindow = second;
    return { created: true };
  });
  result.actions.push({ mechanism: 'fixture-created-second-headless-window', ...created });
  let secondId;
  for (let i = 0; i < 80; i++) {
    assertBeforeDeadline(deadlineMs);
    const contexts = (await mcp.listContexts()).filter(context => context.uri === browserUri);
    const fresh = contexts.filter(context => !initialContexts.some(item => item.id === context.id));
    if (contexts.length === 2 && fresh.length === 1) { secondId = fresh[0].id; break; }
    await pause(150);
  }
  assert.ok(secondId && secondId !== primaryId, 'Second owned browser context was not uniquely identified');
  await mcp.selectContext(browserUri, secondId);
  await waitForMount(mcp, deadlineMs);
  let second;
  for (let i = 0; i < 60; i++) {
    const cards = await observeBrowserCards(mcp);
    second = cards.find(card => card.visible);
    if (second) break;
    await pause(150);
  }
  assert.ok(second && /^[A-Za-z0-9_-]+$/.test(second.id), 'Second owned Browser is not visible');
  result.actions.push(await mcp.fillAndEnter(`#${second.id} .egd-card-url`, startB));
  assert.ok((await waitForOwnedCard(mcp, second.id, startB, deadlineMs)).target, 'Second setup page did not load');
  const a = { name: 'A', context: primaryId, cardId: first.id };
  const b = { name: 'B', context: secondId, cardId: second.id };
  result.ownershipWindows = { A: a, B: b, createdByHarness: true, headless: true };
  await ownershipBookmarkSelection(mcp, result, { owner: a, other: b,
    url: result.ownershipFixture.urls['owner-a'], otherExpected: startB, label: 'a1' }, deadlineMs);
  await ownershipBookmarkSelection(mcp, result, { owner: b, other: a,
    url: result.ownershipFixture.urls['owner-b'], otherExpected: result.ownershipFixture.urls['owner-a'], label: 'b' }, deadlineMs);
  await ownershipBookmarkSelection(mcp, result, { owner: a, other: b,
    url: result.ownershipFixture.urls['owner-c'], otherExpected: result.ownershipFixture.urls['owner-b'], label: 'a2' }, deadlineMs);
  await mcp.selectContext(browserUri, a.context);
  assertBeforeDeadline(deadlineMs);
  const closed = await mcp.evaluate(() => {
    const second = window.__egdeskQaSecondWindow;
    if (!second || second === window || second.closed || second.__egdeskQaOwnedSecondWindow !== true ||
        second.document.documentURI !== 'chrome://browser/content/browser.xhtml') {
      throw new Error('Refusing to close an unowned browser window');
    }
    second.close();
    return { requested: true, ownedHeadlessWindow: true };
  });
  result.actions.push({ mechanism: 'close-test-owned-headless-window', ...closed });
  let secondGone = false;
  for (let i = 0; i < 60; i++) {
    assertBeforeDeadline(deadlineMs);
    const contexts = await mcp.listContexts();
    if (!contexts.some(context => context.id === b.context)) { secondGone = true; break; }
    await pause(150);
  }
  assert.ok(secondGone, 'Owned second window did not close');
  result.checks.push({ name: 'owned B window closed without closing A', passed: secondGone });
  await ownershipBookmarkSelection(mcp, result, { owner: a, other: null,
    url: result.ownershipFixture.urls['owner-d'], otherExpected: null, label: 'after-b-close' }, deadlineMs);
}

async function installOpenFileGuard(mcp) {
  return mcp.evaluate(() => {
    const slot = '__egdeskQaOpenFileGuard';
    if (window[slot]) throw new Error('Open File guard already exists');
    const library = Services.wm.getMostRecentWindow('Places:Organizer');
    if (!library || library.closed || library.document.documentURI !== 'chrome://browser/content/places/places.xhtml') {
      throw new Error('Owned Library is unavailable');
    }
    const state = { entries: [], blocked: [], commands: [], keys: [], listener: null, keyListener: null };
    const restore = () => {
      if (state.listener) library.removeEventListener('command', state.listener, true);
      if (state.keyListener) library.removeEventListener('keydown', state.keyListener, true);
      for (const entry of state.entries.reverse()) {
        if (entry.target.openFileWindow !== entry.blocker) continue;
        if (entry.descriptor) Object.defineProperty(entry.target, 'openFileWindow', entry.descriptor);
        else delete entry.target.openFileWindow;
      }
    };
    try {
      for (const [label, owner] of [['browser', window], ['library', library]]) {
        const target = owner.BrowserCommands;
        if (!target || typeof target.openFileWindow !== 'function') throw new Error(`Native ${label} Open File boundary unavailable`);
        const existing = state.entries.find(entry => entry.target === target);
        if (existing) { existing.labels.push(label); continue; }
        const descriptor = Object.getOwnPropertyDescriptor(target, 'openFileWindow');
        if (descriptor && !descriptor.configurable && !descriptor.writable) throw new Error(`Native ${label} Open File cannot be guarded`);
        const blocker = () => { state.blocked.push(label); return undefined; };
        state.entries.push({ target, descriptor, blocker, labels: [label] });
        target.openFileWindow = blocker;
        if (target.openFileWindow !== blocker) throw new Error(`Native ${label} Open File guard did not install`);
      }
      state.listener = event => {
        if (event.target?.id === 'Browser:OpenFile') state.commands.push({ trusted: event.isTrusted,
          defaultPrevented: event.defaultPrevented });
      };
      state.keyListener = event => {
        if (event.key?.toLowerCase() === 'o') state.keys.push({ trusted: event.isTrusted, meta: event.metaKey });
      };
      library.addEventListener('command', state.listener, true);
      library.addEventListener('keydown', state.keyListener, true);
      state.restore = restore;
      window[slot] = state;
      return { installed: state.entries.every(entry => entry.target.openFileWindow === entry.blocker),
        guarded: state.entries.flatMap(entry => entry.labels).sort(), nativePickerFallback: 'blocked' };
    } catch (error) { restore(); throw error; }
  });
}

async function observeOpenFileCommand(mcp, result, fixture, deadlineMs) {
  result.actions = [];
  result.actions.push(await mcp.click('[data-testid="browser-menu"]'));
  result.actions.push(await mcp.click('[data-testid="browser-library-bookmarks"]'));
  let library;
  for (let i = 0; i < 60; i++) {
    assertBeforeDeadline(deadlineMs);
    library = await inspectLibrary(mcp);
    if (library?.ready === 'complete' && library.tree) break;
    await pause(150);
  }
  assert.ok(library?.tree, 'Native Library is unavailable for Open File');
  const beforeCards = await observeBrowserCards(mcp), beforeTabs = await nativeTabEvidence(mcp);
  const beforeContexts = await mcp.listContexts();
  const beforeNotice = await mcp.evaluate(() => document.getElementById('egd-board-notice')?.textContent?.trim() || null);
  const cursor = fixture.requests.length;
  result.openFileGuard = await installOpenFileGuard(mcp);
  assert.ok(result.openFileGuard.installed && result.openFileGuard.guarded.includes('browser')
    && result.openFileGuard.guarded.includes('library'), 'Both native Open File paths must be guarded');
  try {
    await mcp.selectContext('chrome://browser/content/places/places.xhtml');
    assertBeforeDeadline(deadlineMs);
    const ready = await mcp.evaluate(() => {
      const browser = Services.wm.getMostRecentWindow('navigator:browser'), guard = browser?.__egdeskQaOpenFileGuard;
      if (!guard || !guard.entries.every(entry => entry.target.openFileWindow === entry.blocker)) {
        throw new Error('Open File guard changed; command was not invoked');
      }
      const command = document.getElementById('Browser:OpenFile');
      if (!command || typeof command.doCommand !== 'function') throw new Error('Native Open File command is unavailable');
      return { disabled: !!command.disabled };
    });
    let invoked = { invoked: false, disabled: ready.disabled, mechanism: 'disabled-native-command' };
    if (!ready.disabled) {
      await mcp.nativeInput([{ type: 'key', id: 'egdesk_qa_open_file_keyboard', actions: [
        { type: 'keyDown', value: '\uE03D' }, { type: 'keyDown', value: 'o' },
        { type: 'keyUp', value: 'o' }, { type: 'keyUp', value: '\uE03D' },
      ] }]);
      result.actions.push({ mechanism: 'firefox-bidi-native-command-shortcut', shortcut: 'Meta+O' });
      await pause(300);
      const shortcut = await mcp.evaluate(() => {
        const browser = Services.wm.getMostRecentWindow('navigator:browser'), guard = browser?.__egdeskQaOpenFileGuard;
        if (!guard || !guard.entries.every(entry => entry.target.openFileWindow === entry.blocker)) {
          throw new Error('Open File guard changed after shortcut');
        }
        return { commands: [...guard.commands], keys: [...guard.keys], blocked: [...guard.blocked] };
      });
      result.openFileShortcut = shortcut;
      if (shortcut.commands.length > 0 || shortcut.blocked.length > 0) {
        invoked = { invoked: shortcut.commands.length > 0, disabled: false,
          mechanism: 'firefox-bidi-native-command-shortcut' };
      } else {
        // Headless Mac may not dispatch a menu accelerator. Only when no
        // command or picker fallback was observed, exercise the actual XUL
        // command once and label it separately from the native input attempt.
        invoked = await mcp.evaluate(() => {
          const browser = Services.wm.getMostRecentWindow('navigator:browser'), guard = browser?.__egdeskQaOpenFileGuard;
          const command = document.getElementById('Browser:OpenFile');
          if (!guard || guard.commands.length || guard.blocked.length ||
              !guard.entries.every(entry => entry.target.openFileWindow === entry.blocker) ||
              !command || command.disabled || typeof command.doCommand !== 'function') {
            throw new Error('Open File fallback is unsafe; command was not invoked');
          }
          command.doCommand();
          return { invoked: true, disabled: false, mechanism: 'native-xul-command-doCommand' };
        });
      }
    }
    result.actions.push(invoked);
    await pause(300);
    await mcp.selectContext('chrome://browser/content/browser.xhtml');
    const afterCards = await observeBrowserCards(mcp), afterTabs = await nativeTabEvidence(mcp);
    const afterContexts = await mcp.listContexts();
    const observed = await mcp.evaluate(() => {
      const guard = window.__egdeskQaOpenFileGuard;
      if (!guard || !guard.entries.every(entry => entry.target.openFileWindow === entry.blocker)) {
        throw new Error('Open File guard was lost');
      }
      return { blockedNativeCalls: [...guard.blocked], commands: [...guard.commands], keys: [...guard.keys],
        notice: document.getElementById('egd-board-notice')?.textContent?.trim() || null };
    });
    const cardSig = cards => cards.map(card => ({ id: card.id, uri: card.uri, nativeUri: card.nativeUri }));
    const fileRequests = fixture.requests.slice(cursor).filter(request => /^\/(?:v1\/files|v1\/portable|file)(?:\/|\?|$)/.test(request.path));
    const contextSig = contexts => contexts.map(context => `${context.id} ${context.uri}`).sort();
    const unchanged = JSON.stringify(cardSig(beforeCards)) === JSON.stringify(cardSig(afterCards))
      && JSON.stringify(beforeTabs) === JSON.stringify(afterTabs)
      && JSON.stringify(contextSig(beforeContexts)) === JSON.stringify(contextSig(afterContexts));
    result.openFileObservation = { invoked, ...observed, beforeNotice, unchanged, fileRequests,
      beforeCards: cardSig(beforeCards), afterCards: cardSig(afterCards), beforeTabs, afterTabs,
      beforeContexts, afterContexts };
    const passed = openFileRefusalAccepted({ guard: result.openFileGuard, invoked, observed,
      unchanged, fileRequests, beforeNotice });
    result.checks.push({ name: 'native Library Open File is refused with no file-picker or navigation side effect', passed });
    result.screenshots.push(await takeScreenshot(mcp, path.join(result.runDir, 'open-file-refused.png')));
  } finally {
    if (mcp.documentUri !== 'chrome://browser/content/browser.xhtml') await mcp.selectContext('chrome://browser/content/browser.xhtml');
    result.openFileGuardRestored = await mcp.evaluate(() => {
      const guard = window.__egdeskQaOpenFileGuard;
      if (!guard) return false;
      guard.restore();
      const restored = guard.entries.every(entry => entry.target.openFileWindow !== entry.blocker);
      delete window.__egdeskQaOpenFileGuard;
      return restored;
    });
  }
}

async function installMigrationFixture(mcp) {
  return mcp.evaluate(async rules => {
    const slot = '__egdeskIsolatedMigrationFixture';
    if (window[slot]) throw new Error('Migration fixture already exists');
    const { MigrationUtils } = ChromeUtils.importESModule('resource:///modules/MigrationUtils.sys.mjs');
    const { MigrationWizardParent } = ChromeUtils.importESModule('resource:///actors/MigrationWizardParent.sys.mjs');
    const proto = MigrationWizardParent?.prototype, descriptor = proto && Object.getOwnPropertyDescriptor(proto, 'receiveMessage');
    const names = ['getMigrator', 'getFileMigrator', 'migratorExists', 'getMigratorKeyForDefaultBrowser',
      'startupMigration', 'asyncStartupMigration', 'availableMigratorKeys', 'availableFileMigrators'];
    if (!proto || !descriptor?.configurable || typeof descriptor.value !== 'function' || !Object.isExtensible(MigrationUtils) ||
        names.some(name => Object.getOwnPropertyDescriptor(MigrationUtils, name)?.configurable === false)) {
      throw new Error('Migration fixture cannot replace every enumerator; wizard must remain closed');
    }
    const state = { messages: [], blocked: [], probing: false };
    const fake = Object.freeze({ type: 'browser', key: 'chrome', displayName: 'EG-Desk QA synthetic browser',
      profile: Object.freeze({ id: 'egdesk-qa-only', name: 'Fixture only' }),
      resourceTypes: Object.freeze(['BOOKMARKS', 'HISTORY']), hasPermissions: true, lastModifiedDate: 0 });
    const fixtureReceive = async function(message) {
      const name = message?.name || 'unknown';
      if (!message?.__egdeskProbe) state.messages.push(name);
      const disposition = Object.prototype.hasOwnProperty.call(rules, name) ? rules[name] : 'deny';
      if (disposition === 'synthetic-list') return [{ ...fake, profile: { ...fake.profile }, resourceTypes: [...fake.resourceTypes] }];
      if (disposition === 'ignore-telemetry') return null;
      if (!state.probing) state.blocked.push(`actor:${name}`);
      throw new Error('QA migration fixture denies every non-enumeration actor action');
    };
    for (const name of names) {
      const deny = () => { if (!state.probing) state.blocked.push(`enumerator:${name}`); throw new Error('QA migration enumerator blocked'); };
      const getter = ['availableMigratorKeys', 'availableFileMigrators'].includes(name);
      Object.defineProperty(MigrationUtils, name, getter
        ? { get: deny, configurable: false } : { value: deny, writable: false, configurable: false });
    }
    Object.defineProperty(proto, 'receiveMessage', { value: fixtureReceive, writable: false, configurable: false });
    const smoke = await proto.receiveMessage.call({}, { name: 'GetAvailableMigrators', __egdeskProbe: true });
    state.probing = true;
    const negativeProbes = [];
    try {
      for (const name of names) {
        try {
          const value = MigrationUtils[name];
          if (typeof value === 'function') await value.call(MigrationUtils, 'egdesk-qa-probe');
          throw new Error(`enumerator probe unexpectedly succeeded: ${name}`);
        } catch (error) {
          if (error.message !== 'QA migration enumerator blocked') throw error;
          negativeProbes.push(name);
        }
      }
      for (const name of ['Migrate', 'CheckPermissions', 'GetPermissions', 'RequestSafariPermissions',
        'SelectManualPasswordFile', 'LaunchMacOSPasswordsApp', 'OpenURL']) {
        try {
          await proto.receiveMessage.call({}, { name, __egdeskProbe: true });
          throw new Error(`actor probe unexpectedly succeeded: ${name}`);
        } catch (error) {
          if (error.message !== 'QA migration fixture denies every non-enumeration actor action') throw error;
          negativeProbes.push(`actor:${name}`);
        }
      }
    } finally { state.probing = false; }
    const guarded = names.every(name => {
      const entry = Object.getOwnPropertyDescriptor(MigrationUtils, name);
      return entry && entry.configurable === false && (typeof entry.get === 'function' ||
        (typeof entry.value === 'function' && entry.writable === false));
    });
    if (!guarded || proto.receiveMessage !== fixtureReceive || smoke.length !== 1 || smoke[0].profile.id !== 'egdesk-qa-only') {
      throw new Error('Migration guard verification failed; wizard must remain closed');
    }
    Object.defineProperty(window, slot, { value: state, configurable: false, writable: false });
    return { actorMethodReplaced: true, immutable: true, noOriginalActorCalls: true,
      deniedEnumerators: names, negativeProbes, syntheticSmoke: { count: smoke.length, profileId: smoke[0].profile.id },
      allowOnly: ['GetAvailableMigrators', 'RecordEvent'], allOtherActorMessages: 'deny' };
  }, { GetAvailableMigrators: migrationMessageDisposition('GetAvailableMigrators'),
    RecordEvent: migrationMessageDisposition('RecordEvent') });
}

async function inspectMigrationFixture(mcp) {
  return mcp.evaluate(() => {
    const state = window.__egdeskIsolatedMigrationFixture;
    if (!state) throw new Error('Migration guard vanished');
    let dialog = null;
    const windows = Services.wm.getEnumerator(null);
    while (windows.hasMoreElements()) {
      const win = windows.getNext();
      if (win.document?.documentURI === 'chrome://browser/content/migration/migration-dialog-window.html') {
        const wizard = win.document.querySelector('migration-wizard');
        dialog = { uri: win.document.documentURI, ready: win.document.readyState,
          wizard: !!wizard, fixtureVisible: !!wizard?.shadowRoot?.textContent?.includes('EG-Desk QA synthetic browser') };
      }
    }
    return { messages: [...state.messages], blocked: [...state.blocked], dialog };
  });
}

async function captureMigrationDialog(mcp, target) {
  const value = await mcp.evaluate(async () => {
    const windows = Services.wm.getEnumerator(null); let dialog = null;
    while (windows.hasMoreElements()) {
      const win = windows.getNext();
      if (win.document?.documentURI === 'chrome://browser/content/migration/migration-dialog-window.html') dialog = win;
    }
    if (!dialog || dialog.closed) throw new Error('Owned migration dialog not available');
    const width = dialog.innerWidth, height = dialog.innerHeight, dpr = dialog.devicePixelRatio;
    if (width < 1 || height < 1 || width * height * dpr * dpr > 16777216) throw new Error('dialog screenshot bounds refused');
    const wg = dialog.docShell?.browsingContext?.currentWindowGlobal;
    if (!wg || wg.isCurrentGlobal !== true) throw new Error('stale migration screenshot target');
    const bitmap = await wg.drawSnapshot(new dialog.DOMRect(0, 0, width, height), dpr, 'rgb(255,255,255)', { drawView: true });
    try {
      const canvas = dialog.document.createElementNS('http://www.w3.org/1999/xhtml', 'canvas');
      canvas.width = bitmap.width; canvas.height = bitmap.height; canvas.getContext('2d').drawImage(bitmap, 0, 0);
      return { width: bitmap.width, height: bitmap.height, data: canvas.toDataURL('image/png').split(',')[1] };
    } finally { bitmap.close(); }
  });
  return saveScreenshot(target, value);
}

async function observeMigrationWizard(mcp, result, deadlineMs, fixture) {
  assertBeforeDeadline(deadlineMs);
  // Every actor message is intercepted, and every direct enumerator is denied
  // before the real command can create a wizard. Never fall back on failure.
  result.migrationGuard = await installMigrationFixture(mcp);
  assert.ok(result.migrationGuard.actorMethodReplaced && result.migrationGuard.immutable
    && result.migrationGuard.syntheticSmoke.profileId === 'egdesk-qa-only');
  const card = (result.afterHistory || result.afterBookmark).find(item => item.visible);
  assert.ok(card && /^[A-Za-z0-9_-]+$/.test(card.id), 'No visible Browser for the migration command');
  const deskImportBefore = await mcp.evaluate(() => {
    const entry = document.getElementById('egd-desk-menu-open');
    return { entryPresent: !!entry, entryAdvertised: !!entry && !entry.hidden,
      portableDialogOpen: !!document.getElementById('egd-portable-dialog') };
  });
  const requestCursor = fixture.requests.length;
  assertBeforeDeadline(deadlineMs);
  result.actions.push(await mcp.click(`#${card.id} [data-testid="browser-menu"]`));
  result.actions.push(await mcp.click('[data-testid="browser-library-import"]'));
  let observation;
  for (let i = 0; i < 80; i++) {
    assertBeforeDeadline(deadlineMs);
    observation = await inspectMigrationFixture(mcp);
    if (observation.dialog?.ready === 'complete' && observation.messages.includes('GetAvailableMigrators')) break;
    await pause(150);
  }
  result.migrationObservation = observation;
  if (observation?.dialog) result.screenshots.push(await captureMigrationDialog(mcp, path.join(result.runDir, 'migration-fixture.png')));
  const passed = !!observation?.dialog?.wizard && observation.dialog.fixtureVisible
    && observation.messages.includes('GetAvailableMigrators')
    && observation.blocked.length === 0;
  result.wizard = passed ? 'synthetic-only-guarded' : 'not-verified';
  result.checks.push({ name: 'native import command reaches a fully synthetic guarded migration wizard', passed });
  const deskImportAfter = await mcp.evaluate(() => {
    const entry = document.getElementById('egd-desk-menu-open');
    return { entryPresent: !!entry, entryAdvertised: !!entry && !entry.hidden,
      portableDialogOpen: !!document.getElementById('egd-portable-dialog') };
  });
  const portableRequests = fixture.requests.slice(requestCursor).filter(request => request.path.startsWith('/v1/portable/'));
  result.browserVsDeskImport = { before: deskImportBefore, after: deskImportAfter, portableRequests,
    capabilitySource: 'synthetic-local-bridge-advertisement-only', deskTransfer: 'not-executed' };
  result.checks.push({ name: 'Browser import does not invoke advertised .egdesk import', passed:
    deskImportBefore.entryAdvertised && deskImportAfter.entryAdvertised && !deskImportBefore.portableDialogOpen
      && !deskImportAfter.portableDialogOpen && portableRequests.length === 0 });
}

async function stopOwned(child) {
  if (!child || child.exitCode != null || child.signalCode != null) return;
  assert.ok(ownedChildren.has(child), 'Refusing to stop a process not spawned by this verifier');
  child.kill('SIGTERM');
  await waitForExit(child, 10000);
  if (child.exitCode == null && child.signalCode == null) throw new Error(`Owned process ${child.pid} did not terminate`);
}

// Each operation is attempted even if an earlier close or stop fails. The
// production caller supplies only its own ChildProcess handles, never PIDs.
export async function cleanupOwnedResources({ mcp, firefox, fixtureServer, stopChild = stopOwned }) {
  const errors = [];
  const attempt = async (step, action) => {
    try { await action(); } catch (error) { errors.push({ step, message: error?.message || String(error) }); }
  };
  await attempt('mcp.close', async () => { if (mcp) await mcp.close(); });
  await attempt('mcp.stop', async () => { if (mcp?.proc) await stopChild(mcp.proc); });
  await attempt('firefox.stop', async () => { if (firefox) await stopChild(firefox); });
  await attempt('fixture.close', async () => {
    if (!fixtureServer?.listening) return;
    await new Promise((resolve, reject) => {
      let settled = false;
      const finish = error => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        if (error) reject(error); else resolve();
      };
      const timer = setTimeout(() => finish(new Error('Owned fixture server did not close in time')), 5000);
      try { fixtureServer.close(finish); } catch (error) { finish(error); }
    });
  });
  return { firefoxExited: !firefox || firefox.exitCode != null || firefox.signalCode != null,
    mcpExited: !mcp?.proc || mcp.proc.exitCode != null || mcp.proc.signalCode != null,
    fixtureServerClosed: !fixtureServer?.listening, errors };
}

// Read-only diagnostics. A port with an unrelated or unknown listener is
// reported as occupied/unknown, never terminated or attributed to this run.
export function inspectPortListeners(port, run = execFileSync) {
  assert.ok(Number.isInteger(port) && port > 0 && port <= 65535 && !EXCLUDED_PORTS.includes(port),
    'unsafe diagnostic port');
  try {
    const output = String(run('/usr/sbin/lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })).trim();
    if (!output) return { state: 'free', pids: [] };
    const parts = output.split(/\s+/);
    if (parts.some(part => !/^[1-9]\d*$/.test(part) || !Number.isSafeInteger(Number(part)))) {
      return { state: 'unknown', pids: [] };
    }
    return { state: 'listening', pids: [...new Set(parts.map(Number))].sort((a, b) => a - b) };
  } catch (error) {
    if (error?.status === 1 && !String(error.stdout || '').trim() && !String(error.stderr || '').trim()) {
      return { state: 'free', pids: [] };
    }
    return { state: 'unknown', pids: [] };
  }
}

function processSnapshot(pid, run) {
  if (!Number.isSafeInteger(pid) || pid <= 1) return { state: 'unknown' };
  try {
    const field = name => String(run('/bin/ps', ['-p', String(pid), '-o', `${name}=`],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })).trim();
    const start = field('lstart'), parent = field('ppid'), executable = field('comm'), end = field('lstart');
    if (!start || start !== end || !/^[1-9]\d*$/.test(parent) || !executable) return { state: 'unknown' };
    return { state: 'present', parentPid: Number(parent), executableName: path.basename(executable),
      identitySha256: sha256(`${start}\0${executable}`) };
  } catch (error) {
    if (error?.status === 1 && !String(error.stdout || '').trim() && !String(error.stderr || '').trim()) {
      return { state: 'absent' };
    }
    return { state: 'unknown' };
  }
}

export function inspectGeckodriverBeforeCleanup({ driverPort, mcpChild, executable, run = execFileSync }) {
  if (!driverPort || !mcpChild || !Number.isSafeInteger(mcpChild.pid) || mcpChild.exitCode != null || mcpChild.signalCode != null) {
    return { state: 'not-verified', reason: 'owned MCP process unavailable' };
  }
  const listener = inspectPortListeners(driverPort, run);
  if (listener.state !== 'listening' || listener.pids.length !== 1) {
    return { state: 'not-verified', reason: 'driver listener is absent, ambiguous or unreadable', listenerState: listener.state };
  }
  const pid = listener.pids[0], snapshot = processSnapshot(pid, run);
  if (snapshot.state !== 'present' || snapshot.parentPid !== mcpChild.pid ||
      snapshot.executableName !== path.basename(executable)) {
    return { state: 'not-verified', reason: 'driver listener is not a verified direct MCP child' };
  }
  return { state: 'verified-mcp-child-listener', pid, parentPid: mcpChild.pid,
    executableName: snapshot.executableName, identitySha256: snapshot.identitySha256 };
}

export function inspectGeckodriverAfterCleanup(before, run = execFileSync) {
  if (before?.state !== 'verified-mcp-child-listener') return { state: 'not-measured' };
  const snapshot = processSnapshot(before.pid, run);
  if (snapshot.state === 'absent') return { state: 'exited' };
  if (snapshot.state !== 'present') return { state: 'unknown' };
  if (snapshot.identitySha256 !== before.identitySha256 || snapshot.executableName !== before.executableName) {
    return { state: 'identity-changed' };
  }
  return { state: 'still-running' };
}

function waitForExit(child, timeout) {
  if (child.exitCode != null || child.signalCode != null) return Promise.resolve();
  return new Promise(resolve => {
    const done = () => { clearTimeout(timer); child.off('exit', done); resolve(); };
    const timer = setTimeout(done, timeout);
    child.once('exit', done);
  });
}

function assertOwnedListener(port, child) {
  assert.ok(child && child.exitCode == null && child.signalCode == null, 'owned Firefox is no longer running');
  let pids;
  try {
    pids = execFileSync('/usr/sbin/lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' })
      .trim().split(/\s+/).filter(Boolean).map(Number);
  } catch { throw new Error(`Owned Firefox listener ${port} is unavailable`); }
  assert.deepEqual(pids, [child.pid], `Firefox listener ${port} changed owner`);
}

export async function runCli(argv = process.argv.slice(2)) {
  assertSupportedPlatform();
  const { evidenceRoot, deadlineMs, scenario, runtimes, loaderSource, expectedSurfaceSha256 } = parseCli(argv);
  assert.equal(process.version, 'v24.22.1', 'use the project Node 24.22.1 runtime');
  const paths = validateRuntimePaths(runtimes);
  const accountHome = fs.realpathSync.native(os.userInfo().homedir);
  assert.equal(fs.realpathSync.native(process.env.HOME), accountHome, 'refusing a changed account HOME');
  assertSafeRuntimeAllowlist(accountHome, paths);
  assertEvidenceRoot(evidenceRoot);
  inspectPinnedLoader(loaderSource, evidenceRoot);
  const install = inspectFirefoxInstall(paths.firefox);
  assert.ok(install.bootstrap?.matchesPin, 'Firefox autoconfig bootstrap does not match the pinned loader');
  await Promise.all([assertPortFree(MARIONETTE_PORT), assertPortFree(REMOTE_PORT)]);
  assertBeforeDeadline(deadlineMs);
  const parent = path.join(evidenceRoot, 'browser-import');
  if (!fs.existsSync(parent)) fs.mkdirSync(parent, { mode: 0o700 });
  assertPrivateDirectory(parent, evidenceRoot);
  const runDir = fs.mkdtempSync(path.join(parent, 'run-'));
  fs.chmodSync(runDir, 0o700); assertPrivateDirectory(runDir, parent);
  const result = { kind: 'egdesk-browser-import-headless-qa', scenario, ok: false, ...providerBoundaryEvidence(),
    runtimeEvidence: { platform: process.platform, nodeVersion: process.version, explicitPathsValidated: true,
      firefoxPathSha256: sha256(paths.firefox), mcpEntryPathSha256: sha256(paths.mcpEntry),
      geckodriverPathSha256: sha256(paths.geckodriver), nodePathSha256: sha256(paths.node),
      firefoxVersion: install.version, bootstrapMatchesPin: install.bootstrap.matchesPin,
      bootstrapSha256: install.bootstrap.sha256 },
    wizard: 'not-run', checks: [], screenshots: [], runDir };
  let fixture, firefox, mcp, preparedProfile = null, firefoxLog = '', firefoxLogHead = '';
  const interruption = new AbortController();
  const onSigint = () => { result.interruptedBy = 'SIGINT'; interruption.abort(); };
  const onSigterm = () => { result.interruptedBy = 'SIGTERM'; interruption.abort(); };
  process.on('SIGINT', onSigint); process.on('SIGTERM', onSigterm);
  try {
    assertRunning(deadlineMs, interruption.signal);
    fixture = await startFixtureServer();
    assertRunning(deadlineMs, interruption.signal);
    const loader = createLoader(runDir, loaderSource);
    result.pinnedLoader = { commit: loader.commit, files: loader.files, sourceCanonicalSha256: loader.sourceCanonicalSha256,
      sourceMatchesPin: loader.sourceMatchesPin, copiedMatchesPin: loader.copiedMatchesPin };
    assertRunning(deadlineMs, interruption.signal);
    const prepared = prepareProfile({ loader: loader.path, fixturePort: fixture.port });
    preparedProfile = prepared.profile;
    result.profileEvidence = { exists: fs.existsSync(prepared.profile), canonicalSha256: sha256(prepared.profile),
      fixtureManifestVerified: true };
    result.surfaceSha256 = prepared.sourceHash;
    result.surfaceCssSha256 = prepared.cssHash;
    result.overlaySourceSha256 = prepared.isolation.files['JS/eg-desk-surface.uc.js']?.originalSha256 || null;
    result.expectedSurfaceSha256 = expectedSurfaceSha256;
    if (expectedSurfaceSha256) assert.equal(result.overlaySourceSha256, expectedSurfaceSha256,
      'copied overlay source SHA256 does not match the explicitly requested revision');
    result.fixturePort = fixture.port;
    const driverPort = await chooseDriverPort(fixture.port);
    await assertPortFree(driverPort);
    const preload = createMcpDriverPreload(runDir);
    result.driverPort = driverPort;
    result.driverPortPreloadSha256 = preload.sha256;
    const policy = sandboxPolicy({ home: accountHome, firefoxApp: paths.firefoxApp,
      nodeDir: path.dirname(paths.node), mcpDir: paths.mcpDir,
      geckoDir: path.dirname(paths.geckodriver), fixturePort: fixture.port, driverPort });
    result.sandboxPolicySha256 = sha256(policy);
    assertRunning(deadlineMs, interruption.signal);
    await Promise.all([assertPortFree(MARIONETTE_PORT), assertPortFree(REMOTE_PORT)]);
    assertRunning(deadlineMs, interruption.signal);
    validateRuntimePaths(paths);
    firefox = spawn('/usr/bin/sandbox-exec', ['-p', policy, paths.firefox, '-profile', prepared.profile, '--no-remote',
      '--marionette', '--remote-debugging-port', String(REMOTE_PORT), '--remote-allow-hosts', 'localhost', 'about:blank'],
    { env: childEnvironment(paths.geckodriver), cwd: prepared.profile, stdio: ['ignore', 'pipe', 'pipe'] });
    ownedChildren.add(firefox);
    const captureLog = chunk => { firefoxLogHead = (firefoxLogHead + chunk).slice(0, 10000);
      firefoxLog = (firefoxLog + chunk).slice(-10000); };
    firefox.stdout.on('data', captureLog);
    firefox.stderr.on('data', captureLog);
    await new Promise((resolve, reject) => { firefox.once('spawn', resolve); firefox.once('error', reject); });
    const profileIndex = firefox.spawnargs.indexOf('-profile');
    assert.ok(profileIndex > 0 && firefox.spawnargs.lastIndexOf('-profile') === profileIndex,
      'Firefox argv must contain exactly one profile argument');
    const argvProfile = fs.realpathSync.native(firefox.spawnargs[profileIndex + 1]);
    assert.equal(argvProfile, prepared.profile, 'Firefox argv profile is not the owned QA profile');
    result.profileEvidence.argvProfileCanonicalSha256 = sha256(argvProfile);
    result.firefoxPid = firefox.pid;
    await waitForOwnedListener(MARIONETTE_PORT, firefox, deadlineMs, interruption.signal);
    await waitForOwnedListener(REMOTE_PORT, firefox, deadlineMs, interruption.signal);
    result.portsOwned = [MARIONETTE_PORT, REMOTE_PORT];
    await assertPortFree(driverPort);
    mcp = new IsolatedMcp({ prepared, firefox, policy, paths, preload: preload.file, driverPort,
      deadlineMs, signal: interruption.signal });
    result.contextGuard = await mcp.connect();
    result.geckodriverBeforeCleanup = inspectGeckodriverBeforeCleanup({ driverPort, mcpChild: mcp.proc,
      executable: paths.geckodriver });
    assertBeforeDeadline(deadlineMs);
    await waitForMount(mcp, deadlineMs);
    result.loader = await observePinnedLoader(mcp);
    assert.ok(result.loader.stylesheetModes.includes('user') && result.loader.stylesheetModes.includes('author'),
      'Pinned stylesheet must be present in both user and author origins');
    result.baseline = await observeBaseline(mcp);
    result.screenshots.push(await takeScreenshot(mcp, path.join(runDir, 'baseline.png')));
    result.checks.push({ name: 'headless mounted surface', passed: result.baseline.loaderRan });
    if (scenario === 'core') {
      await observeNativeLibrary(mcp, result, fixture.port, deadlineMs);
      await observeHistoryLibrary(mcp, result, deadlineMs);
      await observeBackgroundBookmark(mcp, result, deadlineMs);
      await observeMigrationWizard(mcp, result, deadlineMs, fixture);
      for (const page of ['original', 'bookmark', 'bookmark-background', 'history']) {
        const route = `/egdesk-browser-import/${page}`;
        result.checks.push({ name: `localhost fixture ${page} was served`,
          passed: fixture.requests.some(request => request.method === 'GET' && request.path === route) });
      }
    } else if (scenario === 'ownership') await observeMultiWindowOwnership(mcp, result, fixture.port, deadlineMs);
    else if (scenario === 'style-parity') await observeStyleParity(mcp, result, fixture.port, deadlineMs);
    else await observeOpenFileCommand(mcp, result, fixture, deadlineMs);
    // The core scenario never opens a wizard before its enumeration is fully
    // replaced. The ownership scenario never opens a migration wizard at all.
    result.observationCompleted = true;
    result.acceptance = 'scoped-fixture-only';
    result.ok = result.checks.every(check => check.passed) && (scenario === 'core'
      ? result.wizard === 'synthetic-only-guarded' : scenario === 'ownership'
        ? result.ownershipSteps.length === 4 : scenario === 'style-parity'
          ? result.styleParity?.originParity === true && result.styleParity?.restoredComputed === true
          : result.openFileGuardRestored === true);
    result.notCovered = ['real Chrome data', 'personal accounts', 'real provider', '.egdesk transfer',
      ...(scenario === 'core' ? ['multi-window routing', 'native Open File command']
        : scenario === 'ownership' ? ['migration wizard', 'new-card preference', 'history navigation']
          : scenario === 'style-parity' ? ['migration wizard', 'multi-window routing', 'real-user visual approval']
            : ['migration wizard', 'multi-window routing', 'actual file picker', 'file contents'])];
    result.firefoxLogTail = firefoxLog;
    result.firefoxLogHead = firefoxLogHead;
  } catch (error) {
    result.error = error.message; result.mcpLogTail = mcp?.stderr || null;
    if (mcp?.context) {
      try { result.screenshots.push(await takeScreenshot(mcp, path.join(runDir, 'failure.png'))); } catch {}
    }
  }
  finally {
    const redactProfile = value => preparedProfile ? value.replaceAll(preparedProfile, '<owned-qa-profile>') : value;
    result.firefoxLogTail = redactProfile(firefoxLog);
    result.firefoxLogHead = redactProfile(firefoxLogHead);
    if (result.error) result.error = redactProfile(result.error);
    if (result.mcpLogTail) result.mcpLogTail = redactProfile(result.mcpLogTail);
    result.fixtureRequests = fixture?.requests || [];
    const driverBefore = result.geckodriverBeforeCleanup || inspectGeckodriverBeforeCleanup({
      driverPort: result.driverPort, mcpChild: mcp?.proc, executable: paths.geckodriver });
    result.cleanup = await cleanupOwnedResources({ mcp, firefox, fixtureServer: fixture?.server });
    result.cleanup.errors = result.cleanup.errors.map(error => ({ ...error, message: redactProfile(error.message) }));
    const ports = [
      ...(firefox ? [['marionette', MARIONETTE_PORT], ['remote', REMOTE_PORT]] : []),
      ...(result.driverPort ? [['geckodriver', result.driverPort]] : []),
      ...(fixture?.port ? [['fixture', fixture.port]] : []),
    ];
    result.cleanup.portListenersAfter = Object.fromEntries(ports.map(([name, port]) => {
      const probe = inspectPortListeners(port);
      return [name, { port, state: probe.state, listenerCount: probe.state === 'unknown' ? null : probe.pids.length }];
    }));
    result.cleanup.allObservedPortsFree = ports.every(([name]) => result.cleanup.portListenersAfter[name].state === 'free');
    result.cleanup.geckodriver = { before: driverBefore, after: inspectGeckodriverAfterCleanup(driverBefore),
      directSignalSent: false, observation: 'read-only process identity and listener checks' };
    const driverExitUnverified = !!result.contextGuard && result.cleanup.geckodriver.after.state !== 'exited';
    if (result.cleanup.errors.length || !result.cleanup.firefoxExited || !result.cleanup.mcpExited ||
        !result.cleanup.fixtureServerClosed || !result.cleanup.allObservedPortsFree || driverExitUnverified) result.ok = false;
    fs.writeFileSync(path.join(runDir, 'result.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    process.removeListener('SIGINT', onSigint); process.removeListener('SIGTERM', onSigterm);
  }
  process.stdout.write(JSON.stringify(result) + '\n');
  if (!result.ok) process.exitCode = 1;
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await runCli(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
