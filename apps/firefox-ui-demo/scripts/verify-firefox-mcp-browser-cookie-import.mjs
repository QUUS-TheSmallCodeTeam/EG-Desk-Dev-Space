#!/usr/bin/env node
// Synthetic, headless cookie-import QA. Importing this module has no side effects.
// It never reads a user's Chrome/Firefox profile, Keychain, or cookie values.
// The executable scenario is intentionally macOS-only and uses the same pinned
// loader, isolated profile, sandbox and privileged MCP as the import-flow QA.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createCipheriv, createHash, pbkdf2Sync } from 'node:crypto';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import {
  assertEvidenceRoot, assertPrivateDirectory, assertRunning, assertSafeRuntimeAllowlist,
  assertSupportedPlatform, assertPortFree, childEnvironment, cleanupOwnedResources, createLoader,
  inspectGeckodriverAfterCleanup, inspectGeckodriverBeforeCleanup, inspectPinnedLoader,
  inspectPortListeners, IsolatedMcp, listenOwnedFixturePort, MARIONETTE_PORT,
  mcpDriverPortPreload, parseCli as parseImportFlowCli, prepareProfile, REMOTE_PORT, sandboxPolicy,
  syntheticBridgeState, validateRuntimePaths,
} from './verify-firefox-mcp-browser-import-flow.mjs';
import { inspectFirefoxInstall } from './verify-clean-profile-boot.mjs';

export const COOKIE_NAME = 'egdesk_synthetic_cookie';
const VALUES = Object.freeze({ 23: 'synthetic_v23_only', 24: 'synthetic_v24_only', 0: 'synthetic_default_only' });
const FIXTURE_PASSWORD = 'egdesk-test-only-not-a-keychain-secret';
const FIXTURE_HOST = '127.0.0.1';
const EPOCH_OFFSET_US = 11644473600000000n;
export const ARTIFACT_STOP_BYTES = 250 * 1024 * 1024;
export const OVERLAY_MAX_BYTES = 32 * 1024 * 1024;

export function parseCli(argv, now = Date.now()) {
  assert.ok(!argv.includes('--scenario'), 'this verifier has exactly one fixed synthetic scenario');
  const options = parseImportFlowCli(argv, now);
  assert.ok(options.deadlineMs <= now + 15 * 60 * 1000, 'cookie QA deadline must be within 15 minutes');
  return options;
}

// Do not follow links while calculating disk use. A bound on entry count also
// makes the monitor fail closed rather than scan an unexpectedly large tree.
export function treeUsageBytes(root, { maxEntries = 20000 } = {}) {
  assert.ok(path.isAbsolute(root) && path.resolve(root) === root && Number.isSafeInteger(maxEntries) && maxEntries > 0);
  let entries = 0, bytes = 0;
  const visit = target => {
    let stat;
    try { stat = fs.lstatSync(target); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    if (++entries > maxEntries) throw new Error('QA artifact entry limit exceeded');
    bytes += stat.size;
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      let names;
      try { names = fs.readdirSync(target); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
      for (const name of names) visit(path.join(target, name));
    }
  };
  visit(root);
  return { bytes, entries };
}

export function assertEvidenceOnlyNumbers(value, seen = new WeakSet()) {
  if (typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return;
  assert.ok(value && typeof value === 'object' && !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value)) && !seen.has(value),
  'evidence must contain only booleans, counts and plain objects');
  seen.add(value);
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    assert.match(key, /^[A-Za-z][A-Za-z0-9_]*$/, 'unsafe evidence key');
    assert.ok(descriptor.enumerable && Object.hasOwn(descriptor, 'value'), 'evidence properties must be plain data');
    assertEvidenceOnlyNumbers(descriptor.value, seen);
  }
  seen.delete(value);
}

export function cookieHeaderEvidence(header, version) {
  assert.ok(Object.hasOwn(VALUES, version), 'unsupported synthetic cookie identity');
  if (typeof header !== 'string' || !header) return { count: 0, onlyExpected: false };
  const fields = header.split(';').map(part => part.trim());
  return { count: fields.length, onlyExpected: fields.length === 1 && fields[0] === `${COOKIE_NAME}=${VALUES[version]}` };
}

// Test data are generated locally; even these values are never included in the
// persisted result. Chrome v24 prepends SHA256(host_key) before encryption.
export function syntheticEncryptedValue(version, host = FIXTURE_HOST) {
  assert.ok(version === 23 || version === 24, 'unsupported fixture database version');
  assert.equal(host, FIXTURE_HOST, 'fixture host must remain loopback');
  const key = pbkdf2Sync(FIXTURE_PASSWORD, 'saltysalt', 1003, 16, 'sha1');
  const cipher = createCipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20));
  const value = Buffer.from(VALUES[version], 'utf8');
  const plaintext = version === 24 ? Buffer.concat([createHash('sha256').update(host).digest(), value]) : value;
  return Buffer.concat([Buffer.from('v10'), cipher.update(plaintext), cipher.final()]);
}

export function syntheticCryptoFixture() {
  // Passed only to an explicitly injected test crypto implementation; no
  // native Keychain operation, subprocess, secret, or ambient profile lookup.
  return { password: FIXTURE_PASSWORD, host: FIXTURE_HOST };
}

export function createChromeFixture(runDir, now = Date.now()) {
  assertPrivateDirectory(runDir);
  assert.ok(Number.isSafeInteger(now) && now > 0, 'fixture clock must be a positive integer');
  const root = path.join(runDir, 'synthetic-chrome');
  fs.mkdirSync(root, { mode: 0o700 }); // exclusive: never reuse an existing source
  assertPrivateDirectory(root, runDir);
  const profiles = [
    { directory: 'Default', name: 'Synthetic v24', version: 24 },
    { directory: 'Profile 1', name: 'Synthetic v23', version: 23 },
  ];
  const infoCache = {};
  for (const profile of profiles) {
    const directory = path.join(root, profile.directory);
    fs.mkdirSync(directory, { mode: 0o700 });
    assertPrivateDirectory(directory, root);
    const dbPath = path.join(directory, 'Cookies');
    const db = new DatabaseSync(dbPath);
    try {
      db.exec(`CREATE TABLE meta (key LONGVARCHAR NOT NULL UNIQUE PRIMARY KEY, value LONGVARCHAR);
        CREATE TABLE cookies (creation_utc INTEGER NOT NULL, host_key TEXT NOT NULL,
          top_frame_site_key TEXT NOT NULL DEFAULT '', name TEXT NOT NULL, value TEXT NOT NULL,
          encrypted_value BLOB NOT NULL, path TEXT NOT NULL, expires_utc INTEGER NOT NULL,
          is_secure INTEGER NOT NULL, is_httponly INTEGER NOT NULL, last_access_utc INTEGER NOT NULL,
          has_expires INTEGER NOT NULL DEFAULT 1, is_persistent INTEGER NOT NULL DEFAULT 1,
          priority INTEGER NOT NULL DEFAULT 1, samesite INTEGER NOT NULL DEFAULT -1,
          source_scheme INTEGER NOT NULL DEFAULT 0, source_port INTEGER NOT NULL DEFAULT -1,
          last_update_utc INTEGER NOT NULL DEFAULT 0, source_type INTEGER NOT NULL DEFAULT 0,
          has_cross_site_ancestor INTEGER NOT NULL DEFAULT 1);`);
      const meta = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)');
      meta.run('version', String(profile.version));
      meta.run('last_compatible_version', String(profile.version));
      const stamp = BigInt(now) * 1000n + EPOCH_OFFSET_US;
      db.prepare(`INSERT INTO cookies (creation_utc,host_key,name,value,encrypted_value,path,expires_utc,
        is_secure,is_httponly,last_access_utc,has_expires,is_persistent,samesite,source_scheme,source_port)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(stamp, FIXTURE_HOST, COOKIE_NAME, '',
        syntheticEncryptedValue(profile.version), '/', stamp + 3600n * 1000000n, 0, 1, stamp, 1, 1, -1, 0, -1);
      db.exec('UPDATE cookies SET has_cross_site_ancestor = 0');
    } finally { db.close(); }
    fs.chmodSync(dbPath, 0o600);
    assert.ok(fs.statSync(dbPath).size < 1024 * 1024, 'fixture database unexpectedly large');
    infoCache[profile.directory] = { name: profile.name, is_using_default_name: false };
  }
  fs.writeFileSync(path.join(root, 'Local State'), JSON.stringify({ profile: { info_cache: infoCache,
    last_used: 'Default' } }) + '\n', { flag: 'wx', mode: 0o600 });
  assert.ok(treeUsageBytes(root).bytes < 2 * 1024 * 1024, 'synthetic Chrome fixture unexpectedly large');
  return { root, profiles: profiles.map(({ directory, version }) => ({ directory, version })) };
}

export function createCookieFixtureServer() {
  const counts = { requests: 0, state: 0, v23: 0, v24: 0, default: 0, unexpected: 0,
    duplicate: 0, popup: 0, restore: 0, exactV23: 0, exactV24: 0, exactDefault: 0,
    exactDuplicate: 0, exactPopup: 0, exactRestore: 0 };
  const routes = new Map([['/cookie/v23', ['v23', 23]], ['/cookie/v24', ['v24', 24]],
    ['/cookie/default', ['default', 0]], ['/cookie/duplicate', ['duplicate', 24]],
    ['/cookie/popup', ['popup', 24]], ['/cookie/restore', ['restore', 24]]]);
  const server = http.createServer((request, response) => {
    counts.requests++;
    if (request.method === 'GET' && request.url === '/v1/state') {
      counts.state++;
      response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      response.end(JSON.stringify(syntheticBridgeState()));
      return;
    }
    const route = request.method === 'GET' ? routes.get(request.url) : undefined;
    if (route === undefined) {
      counts.unexpected++;
      response.writeHead(404, { 'cache-control': 'no-store' }); response.end(); return;
    }
    const [key, identity] = route;
    const match = cookieHeaderEvidence(request.headers.cookie, identity);
    counts[key]++;
    if (match.onlyExpected) counts[`exact${key[0].toUpperCase()}${key.slice(1)}`]++;
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    response.end('<!doctype html><title>Owned synthetic cookie QA</title><style>body{margin:0}a{position:fixed;top:10px;left:10px;padding:20px;font:20px sans-serif}</style><a id="popup" href="/cookie/popup" target="_blank">Open synthetic popup</a>');
  });
  server.on('connect', (_request, socket) => { counts.unexpected++; socket.destroy(); });
  return { server, counts };
}

export async function listenCookieFixture() {
  const fixture = createCookieFixtureServer();
  fixture.port = await listenOwnedFixturePort(fixture.server);
  return fixture;
}

// Runs are added below the existing verifier's guarded evidence namespace so
// its loader and profile helpers can be reused without changing them.
export function createRunDirectory(evidenceRoot) {
  assertEvidenceRoot(evidenceRoot);
  const parent = path.join(evidenceRoot, 'browser-import');
  if (!fs.existsSync(parent)) fs.mkdirSync(parent, { mode: 0o700 });
  assertPrivateDirectory(parent, evidenceRoot);
  const runDir = fs.mkdtempSync(path.join(parent, 'run-'));
  fs.chmodSync(runDir, 0o700);
  assertPrivateDirectory(runDir, parent);
  return runDir;
}

export function writeEvidence(runDir, evidence) {
  assertPrivateDirectory(runDir);
  assertEvidenceOnlyNumbers(evidence);
  fs.writeFileSync(path.join(runDir, 'cookie-result.json'), JSON.stringify(evidence, null, 2) + '\n',
    { flag: 'wx', mode: 0o600 });
}

// Executed only through IsolatedMcp.evaluate in a newly-created headless
// Firefox profile. The adapter uses Gecko SQLite, WebCrypto, identities and
// Services.cookies; its only filesystem source and password are synthetic.
// No production discovery/Keychain fallback is ever constructed for imports.
export async function installImporterFixture(config) {
  const { root, runDir, password, cookieName, v23Value, v24Value, defaultValue } = config;
  if (root !== `${runDir}/synthetic-chrome` || !root.startsWith('/private/tmp/egdesk-round-')) throw new Error('fixture boundary');
  const services = globalThis.Services || ChromeUtils.importESModule('resource://gre/modules/Services.sys.mjs').Services;
  const { Sqlite } = ChromeUtils.importESModule('resource://gre/modules/Sqlite.sys.mjs');
  const { ContextualIdentityService: identities } = ChromeUtils.importESModule('resource://gre/modules/ContextualIdentityService.sys.mjs');
  const { createBrowserCookieImporter } = ChromeUtils.importESModule('chrome://userchrome/content/EGDeskBrowserCookieImport.sys.mjs');
  const fixtureRoot = Cc['@mozilla.org/file/local;1'].createInstance(Ci.nsIFile);
  fixtureRoot.initWithPath(root);
  if (!fixtureRoot.exists() || !fixtureRoot.isDirectory() || fixtureRoot.isSymlink() || fixtureRoot.path !== root) throw new Error('fixture root');
  const directories = new Set(['Default', 'Profile 1']);
  const counters = { reads: 0, keychainFixtureCalls: 0, nativeWrites: 0 };
  const file = (directory, leaf) => {
    if (!directories.has(directory) || leaf !== 'Cookies') throw new Error('fixture path');
    const parent = fixtureRoot.clone(); parent.append(directory);
    if (!parent.exists() || !parent.isDirectory() || parent.isSymlink()) throw new Error('fixture profile');
    const target = parent.clone(); target.append(leaf);
    if (!target.exists() || !target.isFile() || target.isSymlink() || target.fileSize > 1024 * 1024) throw new Error('fixture database');
    return target;
  };
  const columns = ['host_key', 'top_frame_site_key', 'name', 'value', 'encrypted_value', 'path',
    'expires_utc', 'is_secure', 'is_httponly', 'has_expires', 'is_persistent', 'samesite',
    'source_scheme', 'source_port', 'has_cross_site_ancestor'];
  const nativeCookies = {
    add(cookie, attrs) {
      if (!Number.isSafeInteger(attrs?.userContextId) || attrs.userContextId <= 0 || attrs.privateBrowsingId !== 0 ||
          cookie.host !== '127.0.0.1' || cookie.name !== cookieName) throw new Error('fixture cookie boundary');
      counters.nativeWrites++;
      const result = services.cookies.add(cookie.host, cookie.path, cookie.name, cookie.value,
        cookie.isSecure, cookie.isHttpOnly, cookie.isSession, cookie.expiry, attrs,
        cookie.sameSite, cookie.schemeMap, false);
      return result?.result === Ci.nsICookieValidation.eOK;
    },
    list(attrs) { return services.cookies.getCookiesWithOriginAttributes(JSON.stringify(attrs)); },
    removeAll(attrs) {
      if (!Number.isSafeInteger(attrs?.userContextId) || attrs.userContextId <= 0 || attrs.privateBrowsingId !== 0) throw new Error('cleanup boundary');
      return services.cookies.removeCookiesWithOriginAttributes(JSON.stringify(attrs));
    },
  };
  const adapter = {
    platform: 'macosx', crypto: window.crypto, randomUUID: () => window.crypto.randomUUID(), now: () => Date.now(),
    checkAccess: () => true,
    async readRoot() {
      counters.reads++;
      const stateFile = fixtureRoot.clone(); stateFile.append('Local State');
      if (!stateFile.exists() || !stateFile.isFile() || stateFile.isSymlink() || stateFile.fileSize > 65536) throw new Error('fixture state');
      const cache = JSON.parse(await IOUtils.readUTF8(stateFile.path))?.profile?.info_cache;
      if (!cache || Object.keys(cache).length !== 2 || ![...directories].every(key => Object.hasOwn(cache, key))) throw new Error('fixture state');
      return [...directories].map(directory => ({ directory, name: cache[directory].name }));
    },
    async readSqlite(directory, { maxRows, maxBytes }) {
      counters.reads++;
      if (maxRows < 1 || maxBytes < 1) throw new Error('fixture limits');
      const db = await Sqlite.openConnection({ path: file(directory, 'Cookies').path, readOnly: true });
      try {
        const versionRows = await db.execute("SELECT CAST(value AS TEXT) AS v FROM meta WHERE key = 'version'");
        const version = Number(versionRows[0]?.getResultByName('v'));
        const info = await db.execute('PRAGMA table_info(cookies)');
        const names = info.map(row => row.getResultByName('name'));
        if (versionRows.length !== 1 || names.length !== 20 || !columns.every(name => names.includes(name))) {
          return { version, totalRows: 1, rows: [], schemaSupported: false };
        }
        const selections = columns.map(name => name === 'expires_utc' ? 'CAST(expires_utc AS TEXT) AS expires_utc' : name);
        const rows = await db.execute(`SELECT ${selections.join(', ')} FROM cookies LIMIT 2`);
        if (rows.length !== 1) throw new Error('fixture row count');
        return { version, totalRows: rows.length, rows: rows.map(row => Object.fromEntries(columns.map(name => [name, row.getResultByName(name)]))) };
      } finally { await db.close(); }
    },
    getKeychainPassword() { counters.keychainFixtureCalls++; return password; },
    getIdentityIds: () => identities.getPublicIdentities().map(item => item.userContextId),
    createIdentity: name => identities.create(name, 'fingerprint', 'blue'),
    removeIdentity: id => identities.remove(id),
    cookies: nativeCookies,
  };
  const options = { adapter, profileImportPolicy: 'allow', privateBrowsingId: 0 };
  const importer = createBrowserCookieImporter(options);
  const checks = {};
  checks.privateDenied = !createBrowserCookieImporter({ ...options, privateBrowsingId: 1 }).availability().supported;
  checks.policyDenied = !createBrowserCookieImporter({ ...options, profileImportPolicy: 'deny' }).availability().supported;
  checks.platformDenied = !createBrowserCookieImporter({ ...options, adapter: { ...adapter, platform: 'unsupported' } }).availability().supported;
  checks.accessDenied = !createBrowserCookieImporter({ ...options, adapter: { ...adapter, checkAccess: () => 'policy-denied' } }).availability().supported;
  checks.explicitListRequired = !(await importer.listProfiles()).supported && counters.reads === 0;
  const listed = await importer.listProfiles({ explicitUserRequest: true });
  const byName = Object.fromEntries((listed.profiles || []).map(item => [item.name, item.id]));
  checks.fixtureProfilesListed = listed.supported === true && Object.keys(byName).length === 2 &&
    !!byName['Synthetic v24'] && !!byName['Synthetic v23'];
  const beforeNoConsent = counters.reads;
  const noConsent = await importer.importProfile({ profileId: byName['Synthetic v24'] });
  checks.consentRequired = noConsent.status === 'failed' && counters.reads === beforeNoConsent && counters.keychainFixtureCalls === 0;
  const cancelled = new AbortController(); cancelled.abort();
  const beforeCancel = counters.reads;
  const preCancel = await importer.importProfile({ profileId: byName['Synthetic v24'], explicitUserConsent: true, signal: cancelled.signal });
  checks.cancelBeforeRead = preCancel.status === 'cancelled' && counters.reads === beforeCancel && counters.keychainFixtureCalls === 0;
  const badImporter = createBrowserCookieImporter({ ...options, adapter: { ...adapter,
    async readSqlite() { throw new Error('synthetic read error'); } } });
  const badList = await badImporter.listProfiles({ explicitUserRequest: true });
  const bad = await badImporter.importProfile({ profileId: badList.profiles[0]?.id, explicitUserConsent: true });
  checks.readErrorHandled = bad.status === 'failed';
  const unsupported = createBrowserCookieImporter({ ...options, adapter: { ...adapter,
    async readSqlite() { return { version: 25, rows: [], totalRows: 1, schemaSupported: false }; } } });
  const unsupportedList = await unsupported.listProfiles({ explicitUserRequest: true });
  const unsupportedResult = await unsupported.importProfile({ profileId: unsupportedList.profiles[0]?.id, explicitUserConsent: true });
  checks.schemaDenied = unsupportedResult.status === 'failed' && unsupportedResult.reason === 'unsupported-schema';

  const idsBeforeCancel = adapter.getIdentityIds();
  const midway = new AbortController();
  let cancellationWrite = false;
  const cancelAdapter = { ...adapter, cookies: { ...nativeCookies, add(cookie, attrs) {
    const result = nativeCookies.add(cookie, attrs); cancellationWrite = true; midway.abort(); return result;
  } } };
  const cancelImporter = createBrowserCookieImporter({ ...options, adapter: cancelAdapter });
  const cancelList = await cancelImporter.listProfiles({ explicitUserRequest: true });
  const cancelId = cancelList.profiles.find(item => item.name === 'Synthetic v24')?.id;
  const cancelResult = await cancelImporter.importProfile({ profileId: cancelId, explicitUserConsent: true, signal: midway.signal });
  checks.cancelAfterWriteCleaned = cancellationWrite && cancelResult.status === 'cancelled' &&
    JSON.stringify(adapter.getIdentityIds().sort((a, b) => a - b)) === JSON.stringify(idsBeforeCancel.sort((a, b) => a - b));

  const v24 = await importer.importProfile({ profileId: byName['Synthetic v24'], explicitUserConsent: true });
  const v23 = await importer.importProfile({ profileId: byName['Synthetic v23'], explicitUserConsent: true });
  checks.importedV24 = v24.status === 'imported' && v24.counts?.imported === 1 && v24.userContextId > 0;
  checks.importedV23 = v23.status === 'imported' && v23.counts?.imported === 1 && v23.userContextId > 0;
  checks.distinctContainers = checks.importedV24 && checks.importedV23 && v24.userContextId !== v23.userContextId;
  const ownCookie = (id, value) => {
    const cookies = nativeCookies.list({ userContextId: id, privateBrowsingId: 0 });
    return Array.isArray(cookies) && cookies.length === 1 && cookies[0].host === '127.0.0.1' &&
      cookies[0].name === cookieName && cookies[0].value === value && cookies[0].originAttributes?.userContextId === id;
  };
  checks.nativeReadbackV24 = checks.importedV24 && ownCookie(v24.userContextId, v24Value);
  checks.nativeReadbackV23 = checks.importedV23 && ownCookie(v23.userContextId, v23Value);
  services.cookies.add('127.0.0.1', '/', cookieName, defaultValue, false, true, false,
    Date.now() + 3600 * 1000, { userContextId: 0, privateBrowsingId: 0 }, 256, 0, false);
  checks.defaultReadback = ownCookie(0, defaultValue);
  checks.syntheticPasswordOnly = counters.keychainFixtureCalls >= 2;

  const qa = { checks, counts: counters, identities: {}, cards: {}, snapshot: null };
  if (checks.distinctContainers) {
    // This is fixture setup for the existing production card runtime, not a
    // claim that the trusted-click import wizard has been exercised.
    const scope = window.crypto.randomUUID(), entries = {};
    for (const [version, receipt] of [[24, v24], [23, v23]]) {
      const key = window.crypto.randomUUID(); entries[String(receipt.userContextId)] = key;
      qa.identities[version] = { version: 1, userContextId: receipt.userContextId, profileScopeId: scope,
        browserIdentityKey: key, containerName: receipt.containerName };
    }
    services.prefs.setStringPref('egdesk.browser.identity.registry.v1', JSON.stringify({ version: 1,
      profilePath: services.dirsvc.get('ProfD', Ci.nsIFile).path, profileScopeId: scope, entries }));
  }
  window.__egdeskCookieQa = qa;
  return { checks, counts: { ...counters } };
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(condition, deadlineMs, signal, limitMs = 30000) {
  const end = Math.min(deadlineMs, Date.now() + limitMs);
  while (Date.now() < end) {
    assertRunning(deadlineMs, signal);
    if (await condition()) return;
    await sleep(Math.min(150, end - Date.now()));
  }
  throw new Error('owned QA condition timed out');
}

async function waitForOwnedListener(port, child, deadlineMs, signal) {
  await waitFor(() => {
    if (child.exitCode != null || child.signalCode != null) throw new Error('owned Firefox exited');
    const observed = inspectPortListeners(port);
    if (observed.state === 'listening' && (observed.pids.length !== 1 || observed.pids[0] !== child.pid)) {
      throw new Error('listener ownership changed');
    }
    return observed.state === 'listening';
  }, deadlineMs, signal);
}

async function chooseDriverPort(fixturePort) {
  const reservation = net.createServer();
  const port = await listenOwnedFixturePort(reservation, [fixturePort]);
  await new Promise((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));
  return port;
}

function createPreload(runDir) {
  assertPrivateDirectory(runDir);
  const file = path.join(runDir, 'driver-port.cjs');
  fs.writeFileSync(file, mcpDriverPortPreload(), { flag: 'wx', mode: 0o600 });
  return file;
}

function snapshotRoute(fixture, route) {
  const exactKey = `exact${route[0].toUpperCase()}${route.slice(1)}`;
  return { requests: fixture.counts[route], exact: fixture.counts[exactKey] };
}

async function requireRoute(fixture, route, before, deadlineMs, signal) {
  await waitFor(() => fixture.counts[route] > before.requests, deadlineMs, signal);
  const after = snapshotRoute(fixture, route);
  return after.requests - before.requests === after.exact - before.exact;
}

async function openFixtureCard(mcp, fixture, version, checks, deadlineMs, signal) {
  const route = version === 0 ? 'default' : `v${version}`;
  const before = snapshotRoute(fixture, route);
  const created = await mcp.evaluate(({ route, version, port }) => {
    const qa = window.__egdeskCookieQa, runtime = window.__egdesk?.cardRuntime;
    if (!qa || !runtime || (version !== 0 && !qa.identities[version])) return false;
    const url = `http://127.0.0.1:${port}/cookie/${route}`;
    const card = runtime.openBrowserCard(url, { openMode: 'new',
      ...(version === 0 ? {} : { browserIdentity: qa.identities[version] }) });
    if (!card?._xulBrowser) return false;
    qa.cards[route] = card.id;
    return true;
  }, { route, version, port: fixture.port });
  if (!created) throw new Error('fixture Browser card not created');
  checks[`header${route[0].toUpperCase()}${route.slice(1)}`] = await requireRoute(fixture, route, before, deadlineMs, signal);
  checks[`context${route[0].toUpperCase()}${route.slice(1)}`] = await mcp.evaluate(({ route, version }) => {
    const qa = window.__egdeskCookieQa, card = document.getElementById(qa.cards[route]);
    const attrs = card?._xulBrowser?.browsingContext?.originAttributes;
    const expected = version === 0 ? 0 : qa.identities[version].userContextId;
    return !!attrs && attrs.userContextId === expected && attrs.privateBrowsingId === 0;
  }, { route, version });
}

async function observeBrowserLifecycle(mcp, fixture, checks, deadlineMs, signal) {
  const baseline = await mcp.evaluate(() => {
    const qa = window.__egdeskCookieQa, desk = window.__egdesk;
    const canvas = document.getElementById('egd-canvas-layer');
    const viewport = document.getElementById('egd-canvas-viewport');
    if (!qa || !desk?.state || !desk.agenda?.readStore || !canvas || !viewport) return false;
    const windows = Services.wm.getEnumerator('navigator:browser');
    let windowCount = 0;
    while (windows.hasMoreElements()) { windows.getNext(); windowCount++; }
    qa.canvasBaseline = { canvas, viewport, agendaId: desk.state.agenda.activeAgendaId,
      boardIds: Object.keys(desk.state.boards.projections).sort(),
      savedBoardIds: Object.keys(desk.agenda.readStore().agendas).sort(),
      activeProjectionId: desk.state.boards.activeProjectionId, windowCount };
    return true;
  });
  if (!baseline) throw new Error('current Desk canvas unavailable');
  await openFixtureCard(mcp, fixture, 24, checks, deadlineMs, signal);

  const popupBefore = snapshotRoute(fixture, 'popup');
  const point = await mcp.evaluate(() => {
    const qa = window.__egdeskCookieQa, card = document.getElementById(qa.cards.v24);
    const browser = card?._xulBrowser, rect = browser?.getBoundingClientRect();
    if (!rect || rect.width < 80 || rect.height < 80) return null;
    qa.beforePopup = [...document.querySelectorAll('.egd-browser-card')].map(item => item.id);
    return { x: Math.round(rect.left + 30), y: Math.round(rect.top + 30) };
  });
  if (!point) throw new Error('popup link unavailable');
  // The local page's anchor is activated with trusted native WebDriver input.
  await mcp.clickPoint(point);
  checks.headerPopup = await requireRoute(fixture, 'popup', popupBefore, deadlineMs, signal);
  checks.contextPopup = await mcp.evaluate(() => {
    const qa = window.__egdeskCookieQa, expected = qa.identities[24].userContextId;
    const added = [...document.querySelectorAll('.egd-browser-card')].filter(card => !qa.beforePopup.includes(card.id));
    if (added.length !== 1) return false;
    qa.cards.popup = added[0].id;
    const attrs = added[0]._xulBrowser?.browsingContext?.originAttributes;
    return attrs?.userContextId === expected && attrs.privateBrowsingId === 0;
  });

  const duplicateBefore = snapshotRoute(fixture, 'duplicate');
  const duplicated = await mcp.evaluate(({ port }) => {
    const qa = window.__egdeskCookieQa;
    const copy = window.__egdesk.browserRuntime.duplicate(qa.cards.v24);
    if (!copy?._xulBrowser) return false;
    qa.cards.duplicate = copy.id;
    return !!window.__egdesk.browserRuntime.navigate(copy, `http://127.0.0.1:${port}/cookie/duplicate`);
  }, { port: fixture.port });
  if (!duplicated) throw new Error('duplicate Browser card unavailable');
  checks.headerDuplicate = await requireRoute(fixture, 'duplicate', duplicateBefore, deadlineMs, signal);
  checks.contextDuplicate = await mcp.evaluate(() => {
    const qa = window.__egdeskCookieQa, card = document.getElementById(qa.cards.duplicate);
    const attrs = card?._xulBrowser?.browsingContext?.originAttributes;
    return attrs?.userContextId === qa.identities[24].userContextId && attrs.privateBrowsingId === 0;
  });

  const restoreNavigation = snapshotRoute(fixture, 'restore');
  const navigated = await mcp.evaluate(({ port }) => window.__egdesk.browserRuntime.navigate(
    window.__egdeskCookieQa.cards.v24, `http://127.0.0.1:${port}/cookie/restore`), { port: fixture.port });
  if (!navigated || !await requireRoute(fixture, 'restore', restoreNavigation, deadlineMs, signal)) throw new Error('restore setup failed');
  const restoreBefore = snapshotRoute(fixture, 'restore');
  const restored = await mcp.evaluate(async () => {
    const qa = window.__egdeskCookieQa, runtime = window.__egdesk;
    const snapshot = runtime.deskSession.serialize(), id = qa.cards.v24;
    const record = snapshot.cards.find(item => item.id === id);
    if (!record?.runtimeState?.browserIdentity || record.sourceRef?.browserIdentityRequired !== true) return false;
    snapshot.cards = [record]; snapshot.shapes = [];
    snapshot.boardProjections = { projections: {}, activeProjectionId: null };
    snapshot.agenda.memberCardIds = [id];
    qa.snapshot = JSON.parse(JSON.stringify(snapshot));
    const closed = await runtime.cardRuntime.closeCard(document.getElementById(id));
    return closed === true && runtime.deskSession.restore(snapshot, { merge: true }) === true && !!document.getElementById(id);
  });
  if (!restored) throw new Error('Browser card restoration failed');
  checks.headerRestore = await requireRoute(fixture, 'restore', restoreBefore, deadlineMs, signal);
  checks.contextRestore = await mcp.evaluate(() => {
    const qa = window.__egdeskCookieQa, card = document.getElementById(qa.cards.v24);
    const attrs = card?._xulBrowser?.browsingContext?.originAttributes;
    return attrs?.userContextId === qa.identities[24].userContextId && attrs.privateBrowsingId === 0;
  });

  // Test a different profile's token with the same numeric container and a
  // required identity with missing metadata. A rejection must not mount a
  // default-container Browser or initiate the fixture navigation.
  for (const mode of ['foreign', 'portable', 'missing']) {
    const before = snapshotRoute(fixture, 'restore');
    const blocked = await mcp.evaluate(({ mode }) => {
      const qa = window.__egdeskCookieQa, snapshot = JSON.parse(JSON.stringify(qa.snapshot));
      const record = snapshot.cards[0], id = `egd-cookie-qa-${mode}`;
      const before = new Set([...document.querySelectorAll('.egd-browser-card')]);
      record.id = id; snapshot.agenda.memberCardIds = [id];
      if (mode === 'foreign') record.runtimeState.browserIdentity.profileScopeId = window.crypto.randomUUID();
      else if (mode === 'portable') {
        record.runtimeState.browserIdentity.profileScopeId = null;
        record.runtimeState.browserIdentity.browserIdentityKey = null;
        record.sourceRef.browserIdentityKey = null;
      } else delete record.runtimeState.browserIdentity;
      try { window.__egdesk.deskSession.restore(snapshot, { merge: true }); } catch { /* rejection is expected */ }
      const added = [...document.querySelectorAll('.egd-browser-card')].filter(card => !before.has(card));
      return added.every(card => !card._xulBrowser?.browsingContext);
    }, { mode });
    await sleep(300);
    checks[mode === 'foreign' ? 'foreignIdentityRejected' : mode === 'portable' ? 'portableIdentityRejected' : 'missingIdentityRejected'] =
      blocked && snapshotRoute(fixture, 'restore').requests === before.requests;
  }
  await openFixtureCard(mcp, fixture, 23, checks, deadlineMs, signal);
  await openFixtureCard(mcp, fixture, 0, checks, deadlineMs, signal);
  const placement = await mcp.evaluate(() => {
    const qa = window.__egdeskCookieQa, desk = window.__egdesk, before = qa.canvasBaseline;
    const windows = Services.wm.getEnumerator('navigator:browser');
    let windowCount = 0;
    while (windows.hasMoreElements()) { windows.getNext(); windowCount++; }
    return {
      sameCanvas: before.canvas === document.getElementById('egd-canvas-layer') &&
        before.viewport === document.getElementById('egd-canvas-viewport') &&
        Object.values(qa.cards).every(id => before.canvas.contains(document.getElementById(id))),
      sameDesk: before.agendaId === desk.state.agenda.activeAgendaId,
      noNewBoard: JSON.stringify(before.boardIds) === JSON.stringify(Object.keys(desk.state.boards.projections).sort()) &&
        JSON.stringify(before.savedBoardIds) === JSON.stringify(Object.keys(desk.agenda.readStore().agendas).sort()) &&
        before.activeProjectionId === desk.state.boards.activeProjectionId,
      noNewBrowserWindow: before.windowCount === windowCount,
    };
  });
  for (const key of ['sameCanvas', 'sameDesk', 'noNewBoard', 'noNewBrowserWindow']) checks[key] = placement[key] === true;
}

export async function observeNativeAvailability(mcp, evidence, deadlineMs, signal) {
  // Availability is the only production-adapter call in this verifier. It
  // checks native services and policy but never enumerates profiles, reads a
  // database, obtains a Keychain item, or performs an import.
  const availability = await mcp.evaluate(() => {
    const { createBrowserCookieImporter } = ChromeUtils.importESModule('chrome://userchrome/content/EGDeskBrowserCookieImport.sys.mjs');
    const result = createBrowserCookieImporter({ browserWindow: window, profileImportPolicy: 'allow', privateBrowsingId: 0 }).availability();
    return { supported: result.supported === true, platform: result.reason === 'platform-unsupported',
      policy: result.reason === 'policy-denied' || result.reason === 'policy-unavailable' || result.reason === 'policy-unverified',
      privateContext: result.reason === 'private-context-unverified', containers: result.reason === 'containers-disabled',
      logging: result.reason === 'logging-enabled' || result.reason === 'logging-unverified',
      unavailable: result.reason === 'unavailable' };
  });
  evidence.checks.nativeAvailability = availability.supported;
  evidence.nativeAvailability = { ...availability };
  if (!availability.supported) throw new Error('native availability failed');
  let point = null;
  await waitFor(async () => {
    point = await mcp.evaluate(() => {
      const targets = [...document.querySelectorAll('.egd-browser-card [data-testid="browser-menu"]')]
        .filter(node => { const r = node.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
      if (targets.length !== 1) return null;
      const rect = targets[0].getBoundingClientRect();
      return { x: Math.round((rect.left + rect.right) / 2), y: Math.round((rect.top + rect.bottom) / 2) };
    });
    return !!point;
  }, deadlineMs, signal);
  await mcp.clickPoint(point); // native WebDriver input; do not open the importer
  await waitFor(() => mcp.evaluate(() => document.querySelectorAll('[data-testid="browser-cookie-import"]').length === 1),
    deadlineMs, signal);
  evidence.checks.nativeMenuEnabled = await mcp.evaluate(() => {
    const nodes = document.querySelectorAll('[data-testid="browser-cookie-import"]');
    return nodes.length === 1 && nodes[0].disabled === false && nodes[0].getAttribute('aria-disabled') !== 'true';
  });
  await mcp.nativeInput([{ type: 'key', id: 'egdesk_cookie_qa_escape', actions: [
    { type: 'keyDown', value: '\uE00C' }, { type: 'keyUp', value: '\uE00C' },
  ] }]);
  await waitFor(() => mcp.evaluate(() => !document.querySelector('[data-testid="browser-cookie-import"]')),
    deadlineMs, signal);
  if (!evidence.checks.nativeMenuEnabled) throw new Error('native menu is disabled');
}

export async function stopOwnedChild(child, owned) {
  assert.ok(owned.includes(child), 'refusing to signal an unowned process');
  if (child.exitCode != null || child.signalCode != null) return;
  await new Promise((resolve, reject) => {
    const done = () => { clearTimeout(timer); child.off('exit', done); resolve(); };
    const timer = setTimeout(done, 10000);
    child.once('exit', done);
    try { child.kill('SIGTERM'); } catch (error) { clearTimeout(timer); child.off('exit', done); reject(error); }
    if (child.exitCode != null || child.signalCode != null) done();
  });
  if (child.exitCode == null && child.signalCode == null) throw new Error('owned process did not terminate');
}

export async function runCli(argv = process.argv.slice(2)) {
  assertSupportedPlatform();
  const options = parseCli(argv);
  assert.equal(process.version, 'v24.22.1', 'use the project Node 24.22.1 runtime');
  const paths = validateRuntimePaths(options.runtimes);
  const home = fs.realpathSync.native(os.userInfo().homedir);
  assert.equal(fs.realpathSync.native(process.env.HOME), home, 'refusing a changed account HOME');
  assertSafeRuntimeAllowlist(home, paths);
  assertEvidenceRoot(options.evidenceRoot);
  inspectPinnedLoader(options.loaderSource, options.evidenceRoot);
  assert.ok(inspectFirefoxInstall(paths.firefox).bootstrap?.matchesPin, 'Firefox bootstrap does not match pinned loader');
  const overlay = fileURLToPath(new URL('../overlay/', import.meta.url));
  const importerFile = path.join(overlay, 'resources/EGDeskBrowserCookieImport.sys.mjs');
  const importerInfo = fs.lstatSync(importerFile);
  assert.ok(importerInfo.isFile() && !importerInfo.isSymbolicLink() && importerInfo.size < 1024 * 1024,
    'integrated cookie importer is required');
  const overlayBytes = ['JS', 'CSS', 'resources'].reduce((total, name) => total + treeUsageBytes(path.join(overlay, name)).bytes, 0);
  assert.ok(overlayBytes < OVERLAY_MAX_BYTES, 'overlay copy would exceed the QA budget');
  await Promise.all([assertPortFree(MARIONETTE_PORT), assertPortFree(REMOTE_PORT)]);
  assertRunning(options.deadlineMs);
  const runDir = createRunDirectory(options.evidenceRoot);
  const importerCheckNames = ['privateDenied', 'policyDenied', 'platformDenied', 'accessDenied',
    'explicitListRequired', 'fixtureProfilesListed', 'consentRequired', 'cancelBeforeRead',
    'readErrorHandled', 'schemaDenied', 'cancelAfterWriteCleaned', 'importedV24', 'importedV23',
    'distinctContainers', 'nativeReadbackV24', 'nativeReadbackV23', 'defaultReadback', 'syntheticPasswordOnly'];
  const checkNames = ['nativeAvailability', 'nativeMenuEnabled', ...importerCheckNames,
    'headerV24', 'contextV24', 'headerV23', 'contextV23', 'headerDefault', 'contextDefault',
    'headerPopup', 'contextPopup', 'headerDuplicate', 'contextDuplicate', 'headerRestore', 'contextRestore',
    'foreignIdentityRejected', 'portableIdentityRejected', 'missingIdentityRejected',
    'sameCanvas', 'sameDesk', 'noNewBoard', 'noNewBrowserWindow'];
  const evidence = { ok: false, stages: { fixture: false, profile: false, sandbox: false, firefox: false,
    mcp: false, native: false, importer: false, browser: false }, checks: Object.fromEntries(checkNames.map(name => [name, false])),
    nativeAvailability: { supported: false, platform: false, policy: false, privateContext: false,
      containers: false, logging: false, unavailable: false },
    counts: { fixtureBytes: 0, overlayBytes, artifactBytes: 0, fixtureRequests: 0, unexpectedRequests: 0,
      syntheticPasswordCalls: 0, nativeWrites: 0 }, failures: { fixture: false, profile: false, sandbox: false,
      firefox: false, mcp: false, native: false, importer: false, browser: false, interrupted: false, artifactLimit: false },
    cleanup: { firefoxExited: false, mcpExited: false, fixtureClosed: false, driverExitVerified: false,
      portsFree: false, errorCount: 0 } };
  let stage = 'fixture', fixture, firefox, mcp, driverPort, driverBefore, monitor;
  const oldTmp = process.env.TMPDIR;
  const interruption = new AbortController();
  const interrupt = () => { evidence.failures.interrupted = true; interruption.abort(); };
  const deadlineTimer = setTimeout(interrupt, Math.max(1, options.deadlineMs - Date.now()));
  deadlineTimer.unref();
  process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
  try {
    const temp = path.join(runDir, 'tmp');
    fs.mkdirSync(temp, { mode: 0o700 }); assertPrivateDirectory(temp, runDir);
    process.env.TMPDIR = temp; // all owned profile/temp files stay under this run
    const chromeFixture = createChromeFixture(runDir);
    evidence.counts.fixtureBytes = treeUsageBytes(chromeFixture.root).bytes;
    fixture = await listenCookieFixture();
    evidence.stages.fixture = true;
    stage = 'profile'; assertRunning(options.deadlineMs, interruption.signal);
    const loader = createLoader(runDir, options.loaderSource);
    const prepared = prepareProfile({ loader: loader.path, fixturePort: fixture.port });
    fs.appendFileSync(path.join(prepared.profile, 'user.js'),
      '\nuser_pref("browser.cache.disk.enable", false);\nuser_pref("privacy.userContext.enabled", true);\n', { encoding: 'utf8' });
    if (options.expectedSurfaceSha256) assert.equal(prepared.isolation.files['JS/eg-desk-surface.uc.js']?.originalSha256,
      options.expectedSurfaceSha256, 'surface source does not match requested revision');
    evidence.stages.profile = true;
    monitor = setInterval(() => {
      try {
        const bytes = treeUsageBytes(runDir).bytes;
        evidence.counts.artifactBytes = Math.max(evidence.counts.artifactBytes, bytes);
        if (bytes >= ARTIFACT_STOP_BYTES) { evidence.failures.artifactLimit = true; interruption.abort(); }
      } catch { evidence.failures.artifactLimit = true; interruption.abort(); }
    }, 1000);
    monitor.unref();
    stage = 'sandbox'; assertRunning(options.deadlineMs, interruption.signal);
    driverPort = await chooseDriverPort(fixture.port);
    await assertPortFree(driverPort);
    const preload = createPreload(runDir);
    const policy = sandboxPolicy({ home, firefoxApp: paths.firefoxApp, nodeDir: path.dirname(paths.node),
      mcpDir: paths.mcpDir, geckoDir: path.dirname(paths.geckodriver), fixturePort: fixture.port, driverPort });
    evidence.stages.sandbox = true;
    stage = 'firefox'; assertRunning(options.deadlineMs, interruption.signal);
    await Promise.all([assertPortFree(MARIONETTE_PORT), assertPortFree(REMOTE_PORT)]);
    firefox = spawn('/usr/bin/sandbox-exec', ['-p', policy, paths.firefox, '-profile', prepared.profile, '--no-remote',
      '--marionette', '--remote-debugging-port', String(REMOTE_PORT), '--remote-allow-hosts', 'localhost', 'about:blank'],
    { env: childEnvironment(paths.geckodriver), cwd: prepared.profile, stdio: ['ignore', 'pipe', 'pipe'] });
    firefox.stdout.resume(); firefox.stderr.resume();
    await new Promise((resolve, reject) => { firefox.once('spawn', resolve); firefox.once('error', reject); });
    assert.equal(firefox.spawnargs.filter(value => value === '-profile').length, 1);
    assert.equal(fs.realpathSync.native(firefox.spawnargs[firefox.spawnargs.indexOf('-profile') + 1]), prepared.profile);
    await waitForOwnedListener(MARIONETTE_PORT, firefox, options.deadlineMs, interruption.signal);
    await waitForOwnedListener(REMOTE_PORT, firefox, options.deadlineMs, interruption.signal);
    evidence.stages.firefox = true;
    stage = 'mcp'; assertRunning(options.deadlineMs, interruption.signal);
    await assertPortFree(driverPort);
    mcp = new IsolatedMcp({ prepared, firefox, policy, paths, preload, driverPort,
      deadlineMs: options.deadlineMs, signal: interruption.signal });
    const guard = await mcp.connect();
    assert.ok(guard.exactProfileMatch && guard.headless);
    driverBefore = inspectGeckodriverBeforeCleanup({ driverPort, mcpChild: mcp.proc, executable: paths.geckodriver });
    assert.equal(driverBefore.state, 'verified-mcp-child-listener');
    await waitFor(() => mcp.evaluate(() => !!window.__egdesk?.cardRuntime && !!window.__egdesk?.deskSession),
      options.deadlineMs, interruption.signal);
    evidence.stages.mcp = true;
    stage = 'native'; assertRunning(options.deadlineMs, interruption.signal);
    await observeNativeAvailability(mcp, evidence, options.deadlineMs, interruption.signal);
    evidence.stages.native = true;
    stage = 'importer'; assertRunning(options.deadlineMs, interruption.signal);
    const observed = await mcp.evaluate(installImporterFixture, { root: chromeFixture.root, runDir,
      password: FIXTURE_PASSWORD, cookieName: COOKIE_NAME, v23Value: VALUES[23], v24Value: VALUES[24], defaultValue: VALUES[0] });
    for (const key of Object.keys(observed.checks)) if (Object.hasOwn(evidence.checks, key)) evidence.checks[key] = observed.checks[key] === true;
    evidence.counts.syntheticPasswordCalls = observed.counts.keychainFixtureCalls;
    evidence.counts.nativeWrites = observed.counts.nativeWrites;
    evidence.stages.importer = true;
    assert.ok(importerCheckNames.every(name => evidence.checks[name]), 'synthetic importer acceptance failed');
    stage = 'browser'; assertRunning(options.deadlineMs, interruption.signal);
    await observeBrowserLifecycle(mcp, fixture, evidence.checks, options.deadlineMs, interruption.signal);
    evidence.stages.browser = true;
  } catch {
    if (Object.hasOwn(evidence.failures, stage)) evidence.failures[stage] = true;
  } finally {
    clearTimeout(deadlineTimer); if (monitor) clearInterval(monitor);
    try { fixture?.server?.closeAllConnections(); } catch { /* cleanup continues */ }
    const owned = [firefox, mcp?.proc].filter(Boolean);
    const cleaned = await cleanupOwnedResources({ mcp, firefox, fixtureServer: fixture?.server,
      stopChild: child => stopOwnedChild(child, owned) });
    evidence.cleanup.firefoxExited = cleaned.firefoxExited;
    evidence.cleanup.mcpExited = cleaned.mcpExited;
    evidence.cleanup.fixtureClosed = cleaned.fixtureServerClosed;
    evidence.cleanup.errorCount = cleaned.errors.length;
    const afterDriver = inspectGeckodriverAfterCleanup(driverBefore);
    evidence.cleanup.driverExitVerified = driverBefore?.state === 'verified-mcp-child-listener' && afterDriver.state === 'exited';
    const ports = [firefox && MARIONETTE_PORT, firefox && REMOTE_PORT, driverPort, fixture?.port].filter(Boolean);
    evidence.cleanup.portsFree = ports.every(port => inspectPortListeners(port).state === 'free');
    evidence.counts.fixtureRequests = fixture?.counts.requests || 0;
    evidence.counts.unexpectedRequests = fixture?.counts.unexpected || 0;
    try { evidence.counts.artifactBytes = Math.max(evidence.counts.artifactBytes, treeUsageBytes(runDir).bytes); }
    catch { evidence.failures.artifactLimit = true; }
    if (evidence.counts.artifactBytes >= ARTIFACT_STOP_BYTES) evidence.failures.artifactLimit = true;
    if (oldTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = oldTmp;
    process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
    evidence.ok = Object.values(evidence.stages).every(Boolean) && Object.values(evidence.checks).every(Boolean) &&
      !Object.values(evidence.failures).some(Boolean) && evidence.cleanup.firefoxExited && evidence.cleanup.mcpExited &&
      evidence.cleanup.fixtureClosed && evidence.cleanup.driverExitVerified && evidence.cleanup.portsFree && evidence.cleanup.errorCount === 0;
    writeEvidence(runDir, evidence);
  }
  process.stdout.write(JSON.stringify(evidence) + '\n');
  process.stderr.write(`Cookie QA evidence: ${path.join(runDir, 'cookie-result.json')}\n`);
  if (!evidence.ok) process.exitCode = 1;
  return evidence;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await runCli(); } catch { console.error('Cookie QA could not finish; inspect the owned run evidence if present'); process.exitCode = 1; }
}
