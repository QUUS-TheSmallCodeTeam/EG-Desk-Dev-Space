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
  inspectPortListeners, IsolatedMcp, listenOwnedFixturePort, MARIONETTE_PORT, takeScreenshot,
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
      const persistent = profile.version === 24;
      db.prepare(`INSERT INTO cookies (creation_utc,host_key,name,value,encrypted_value,path,expires_utc,
        is_secure,is_httponly,last_access_utc,has_expires,is_persistent,samesite,source_scheme,source_port)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(stamp, FIXTURE_HOST, COOKIE_NAME, '',
        syntheticEncryptedValue(profile.version), '/', persistent ? stamp + 3600n * 1000000n : 0n,
        0, 1, stamp, Number(persistent), Number(persistent), -1, 0, -1);
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
    duplicate: 0, popup: 0, restore: 0, wizard: 0, exactV23: 0, exactV24: 0, exactDefault: 0,
    exactDuplicate: 0, exactPopup: 0, exactRestore: 0, exactWizard: 0 };
  const telemetry = { geometrySeen: false, geometry: [], trustedOnLink: 0, trustedElsewhere: 0 };
  const routes = new Map([['/cookie/v23', ['v23', 23]], ['/cookie/v24', ['v24', 24]],
    ['/cookie/default', ['default', 0]], ['/cookie/duplicate', ['duplicate', 24]],
    ['/cookie/popup', ['popup', 24]], ['/cookie/restore', ['restore', 24]], ['/cookie/wizard', ['wizard', 24]]]);
  const server = http.createServer((request, response) => {
    counts.requests++;
    if (request.method === 'GET' && request.url === '/v1/state') {
      counts.state++;
      response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      response.end(JSON.stringify(syntheticBridgeState()));
      return;
    }
    if (request.method === 'GET' && typeof request.url === 'string' && request.url.startsWith('/qa/popup-evidence?') && request.url.length <= 200) {
      const params = new URL(request.url, 'http://127.0.0.1').searchParams, geometry = params.get('g'), pointer = params.get('p');
      if (geometry && /^\d{1,9}(,\d{1,9}){5}$/.test(geometry)) {
        telemetry.geometry = geometry.split(',').map(Number); telemetry.geometrySeen = true;
      } else if (pointer === '11') telemetry.trustedOnLink++;
      else if (pointer === '10') telemetry.trustedElsewhere++;
      response.writeHead(204, { 'cache-control': 'no-store' }); response.end(); return;
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
    const telemetryScript = key === 'v24' ? `<script>(()=>{const a=document.getElementById('popup');
      const send=s=>fetch('/qa/popup-evidence?'+s,{cache:'no-store'}).catch(()=>{}),r=a.getBoundingClientRect();
      send('g='+[r.left,r.top,r.right,r.bottom,innerWidth,innerHeight].map(v=>Math.round(v*1000)).join(','));
      document.addEventListener('pointerdown',e=>send('p='+(e.isTrusted?'1':'0')+(a.contains(e.target)?'1':'0')));
    })()</script>` : '';
    response.end('<!doctype html><title>Owned synthetic cookie QA</title><style>body{margin:0}a{position:fixed;top:10px;left:10px;padding:20px;font:20px sans-serif}</style><a id="popup" href="/cookie/popup" target="_blank">Open synthetic popup</a>' + telemetryScript);
  });
  server.on('connect', (_request, socket) => { counts.unexpected++; socket.destroy(); });
  return { server, counts, telemetry };
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

// Installed only in the already-guarded, disposable headless QA chrome window.
// Isolating this small setup keeps each MCP script below its size limit.
export function installFixtureIdentityGuard({ root, runDir }) {
  const services = globalThis.Services || ChromeUtils.importESModule('resource://gre/modules/Services.sys.mjs').Services;
  if (root !== `${runDir}/synthetic-chrome` || !root.startsWith('/private/tmp/egdesk-round-') ||
      !services.dirsvc.get('ProfD', Ci.nsIFile).path.startsWith(`${runDir}/tmp/egdesk-chat-test-`) ||
      Cc['@mozilla.org/gfx/info;1'].getService(Ci.nsIGfxInfo).isHeadless !== true ||
      document.documentURI !== 'chrome://browser/content/browser.xhtml' || window.__egdeskFixtureIdentityGuard) return false;
  let identities;
  try {
    ({ ContextualIdentityService: identities } = ChromeUtils.importESModule('moz-src:///toolkit/components/contextualidentity/ContextualIdentityService.sys.mjs'));
  } catch {
    ({ ContextualIdentityService: identities } = ChromeUtils.importESModule('resource://gre/modules/ContextualIdentityService.sys.mjs'));
  }
  const owned = new Set(), adopted = new Set();
  const guard = {
    owns: id => owned.has(id),
    adopt(id) { if (owned.has(id)) adopted.add(id); },
    inUse(id) {
      if (!owned.has(id)) return null;
      if (adopted.has(id)) return true;
      try {
        if (typeof identities.countContainerTabs !== 'function' || typeof services.wm?.getEnumerator !== 'function') return null;
        const tabs = identities.countContainerTabs(id);
        if (!Number.isSafeInteger(tabs) || tabs < 0) return null;
        if (tabs > 0) { adopted.add(id); return true; }
        let windows = 0, elements = 0;
        for (const win of services.wm.getEnumerator(null)) {
          if (++windows > 100) return null;
          if (win.closed) continue;
          if (typeof win.document?.querySelectorAll !== 'function') return null;
          for (const browser of win.document.querySelectorAll('browser, iframe')) {
            if (++elements > 50000) return null;
            if (browser.browsingContext?.originAttributes?.userContextId === id ||
                browser.getAttribute?.('usercontextid') === String(id)) { adopted.add(id); return true; }
          }
        }
        return false;
      } catch { return null; }
    },
    create(name) {
      const identity = identities.create(name, 'fingerprint', 'blue');
      if (Number.isSafeInteger(identity?.userContextId) && identity.userContextId > 0) owned.add(identity.userContextId);
      return identity;
    },
    remove(id) {
      if (!owned.has(id) || guard.inUse(id) !== false) throw new Error('cleanup identity boundary');
      const removed = identities.remove(id);
      if (removed === true) owned.delete(id);
      return removed;
    },
  };
  window.__egdeskFixtureIdentityGuard = Object.freeze(guard);
  return true;
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
  let identities;
  try {
    ({ ContextualIdentityService: identities } = ChromeUtils.importESModule('moz-src:///toolkit/components/contextualidentity/ContextualIdentityService.sys.mjs'));
  } catch {
    ({ ContextualIdentityService: identities } = ChromeUtils.importESModule('resource://gre/modules/ContextualIdentityService.sys.mjs'));
  }
  const { createBrowserCookieImporter } = ChromeUtils.importESModule('chrome://userchrome/content/EGDeskBrowserCookieImport.sys.mjs');
  const identityGuard = window.__egdeskFixtureIdentityGuard;
  if (!identityGuard || !Object.isFrozen(identityGuard)) throw new Error('fixture identity guard');
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
      if (!Number.isSafeInteger(attrs?.userContextId) || attrs.userContextId <= 0 || attrs.privateBrowsingId !== 0 ||
          !identityGuard.owns(attrs.userContextId) || identityGuard.inUse(attrs.userContextId) !== false) throw new Error('cleanup boundary');
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
    getIdentity: id => identities.getPublicIdentityFromId(id) ?? null,
    identityInUse: id => identityGuard.inUse(id),
    watchIdentity(id, invalidate) {
      const topics = ['contextual-identity-updated', 'contextual-identity-deleted', 'browsing-context-attached'];
      const attached = [];
      const observer = { observe(subject, topic) {
        try {
          const context = topic === 'browsing-context-attached' ? (subject?.QueryInterface?.(Ci.nsILoadContext) ?? subject) : null;
          const changed = context ? context.originAttributes?.userContextId : subject?.wrappedJSObject?.userContextId;
          if (context && changed === id) identityGuard.adopt(id);
          if (changed !== 0 && (!Number.isSafeInteger(changed) || changed <= 0 || changed === id)) invalidate();
        } catch { invalidate(); }
      } };
      try { for (const topic of topics) { services.obs.addObserver(observer, topic); attached.push(topic); } }
      catch (error) { for (const topic of attached) { try { services.obs.removeObserver(observer, topic); } catch {} } throw error; }
      let active = true;
      return () => { if (active) { active = false; for (const topic of attached) { try { services.obs.removeObserver(observer, topic); } catch {} } } };
    },
    createIdentity: name => identityGuard.create(name),
    removeIdentity: id => identityGuard.remove(id),
    getCookieCapacity() {
      // Mirror the native Firefox 142-158 capacity adapter in the disposable
      // profile, including its all-container cookie count and preference cap.
      const version = services.appinfo?.platformVersion;
      if (typeof version !== 'string' || !/^\d{1,3}(?:[.ab]|$)/i.test(version) ||
          Number.parseInt(version, 10) < 142 || Number.parseInt(version, 10) > 158) {
        throw new Error('fixture cookie capacity unsupported');
      }
      const all = services.cookies.cookies;
      const configured = services.prefs.getIntPref('network.cookie.maxNumber', 3000);
      const max = Number.isInteger(configured) && configured >= 1 && configured <= 65535 ? configured : 3000;
      if (!Array.isArray(all)) throw new Error('fixture cookie capacity unavailable');
      return { current: all.length, max };
    },
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
  const ownCookie = (id, value, expectedSession = null) => {
    const cookies = nativeCookies.list({ userContextId: id, privateBrowsingId: 0 });
    return Array.isArray(cookies) && cookies.length === 1 && cookies[0].host === '127.0.0.1' &&
      cookies[0].name === cookieName && cookies[0].value === value && cookies[0].originAttributes?.userContextId === id &&
      (expectedSession === null || cookies[0].isSession === expectedSession);
  };
  checks.nativeReadbackV24 = checks.importedV24 && ownCookie(v24.userContextId, v24Value);
  checks.nativeReadbackV23 = checks.importedV23 && ownCookie(v23.userContextId, v23Value);
  checks.nativePersistentV24 = checks.importedV24 && ownCookie(v24.userContextId, v24Value, false);
  checks.nativeSessionV23 = checks.importedV23 && ownCookie(v23.userContextId, v23Value, true);
  services.cookies.add('127.0.0.1', '/', cookieName, defaultValue, false, true, false,
    Date.now() + 3600 * 1000, { userContextId: 0, privateBrowsingId: 0 }, 256, 0, false);
  checks.defaultReadback = ownCookie(0, defaultValue);
  checks.syntheticPasswordOnly = counters.keychainFixtureCalls >= 2;

  Object.freeze(nativeCookies); Object.freeze(adapter);
  const qa = { checks, counts: counters, identities: {}, cards: {}, snapshot: null,
    popupMethodCounts: { createContentWindow: 0, createContentWindowInFrame: 0, openURI: 0, openURIInFrame: 0 },
    fixtureRoot: root, syntheticAdapter: adapter, createImporter: createBrowserCookieImporter };
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

class OwnedQaConditionTimeout extends Error {}

async function waitFor(condition, deadlineMs, signal, limitMs = 30000) {
  const end = Math.min(deadlineMs, Date.now() + limitMs);
  while (Date.now() < end) {
    assertRunning(deadlineMs, signal);
    if (await condition()) return;
    await sleep(Math.min(150, end - Date.now()));
  }
  throw new OwnedQaConditionTimeout('owned QA condition timed out');
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

async function requireRoute(fixture, route, before, deadlineMs, signal, limitMs = 30000) {
  await waitFor(() => fixture.counts[route] > before.requests, deadlineMs, signal, limitMs);
  const after = snapshotRoute(fixture, route);
  return after.requests - before.requests === after.exact - before.exact;
}

const BROWSER_DIAGNOSTIC_STEPS = Object.freeze(['baseline', 'v24', 'popupPoint', 'popupClick', 'popupRoute',
  'popupContext', 'duplicate', 'duplicateRoute', 'duplicateContext', 'restoreNavigation', 'restoreSetupRoute',
  'restoreCard', 'restoreRoute', 'restoreContext', 'identityChecks', 'v23', 'default', 'placement']);
const POPUP_PROBE_METHODS = Object.freeze(['createContentWindow', 'createContentWindowInFrame', 'openURI', 'openURIInFrame']);

// Fixed labels and boolean/count-only values keep failure evidence free of
// exception text, URLs, DOM content, and even synthetic cookie values.
export function createBrowserDiagnostics() {
  return { steps: Object.fromEntries(BROWSER_DIAGNOSTIC_STEPS.map(name => [name, { started: false, completed: false }])),
    popup: { pointAvailable: false, pointInViewport: false, pointHitsBrowser: false,
      clientWidth: 0, clientHeight: 0, rectWidth: 0, rectHeight: 0, scaleXMilli: 0, scaleYMilli: 0,
      anchorGeometryAvailable: false, fixedPointInsideAnchor: false, projectedPointInsideAnchor: false,
      targetFromGeometry: false, targetFromScale: false, targetHitsBrowser: false, trustedPointerOnAnchor: 0, trustedPointerOutsideAnchor: 0,
      routeTimedOut: false, requests: 0, matchingHeaders: 0,
      observationStarted: false, observationCompleted: false, observationAvailable: false,
      addedCards: 0, connectedCards: 0, originAvailable: false, originMatches: false,
      counterCopyApplied: false, counterReadBefore: false, counterReadAfter: false,
      methods: Object.fromEntries(POPUP_PROBE_METHODS.map(name => [name, { calls: 0 }])) } };
}

async function browserDiagnosticStep(diagnostics, name, action) {
  const step = diagnostics.steps[name];
  assert.ok(step && !step.started, 'invalid browser diagnostic step');
  step.started = true;
  try {
    const result = await action();
    step.completed = true;
    return result;
  } catch (error) {
    if (name === 'popupRoute' && error instanceof OwnedQaConditionTimeout) diagnostics.popup.routeTimedOut = true;
    throw error;
  }
}

// This runs only inside the isolated QA chrome context. Do not persist the
// returned coordinates; they are used solely for the trusted synthetic click.
export function inspectPopupPoint() {
  const qa = window.__egdeskCookieQa, card = document.getElementById(qa.cards.v24);
  const browser = card?._xulBrowser, rect = browser?.getBoundingClientRect();
  if (!rect || !Number.isFinite(rect.width) || !Number.isFinite(rect.height) || rect.width < 80 || rect.height < 80) return null;
  qa.beforePopup = [...document.querySelectorAll('.egd-browser-card')].map(item => item.id);
  const x = Math.round(rect.left + 30), y = Math.round(rect.top + 30);
  const inViewport = x >= 0 && y >= 0 && x < window.innerWidth && y < window.innerHeight;
  const hit = inViewport ? document.elementFromPoint(x, y) : null;
  const safe = value => Number.isFinite(value) && value >= 0 && value <= 1000000 ? Math.round(value) : 0;
  const clientWidth = safe(browser.clientWidth), clientHeight = safe(browser.clientHeight);
  return { x, y, rectLeft: rect.left, rectTop: rect.top, rawRectWidth: rect.width, rawRectHeight: rect.height,
    inViewport, hitsBrowser: hit === browser || !!(hit && browser.contains(hit)), clientWidth, clientHeight,
    rectWidth: safe(rect.width), rectHeight: safe(rect.height), scaleXMilli: clientWidth ? safe(rect.width / clientWidth * 1000) : 0,
    scaleYMilli: clientHeight ? safe(rect.height / clientHeight * 1000) : 0 };
}

// Read only synthetic card counts and origin-attribute equality; no IDs,
// addresses, document contents, cookie values, or exception text are returned.
export function inspectPopupCards() {
  const qa = window.__egdeskCookieQa;
  const empty = { available: false, addedCards: 0, connectedCards: 0, originAvailable: false, originMatches: false };
  if (!Array.isArray(qa?.beforePopup)) return empty;
  const cards = document.querySelectorAll('.egd-browser-card');
  if (cards.length > 1000) return empty;
  const added = [...cards].filter(card => !qa.beforePopup.includes(card.id));
  const attrs = added.length === 1 ? added[0]._xulBrowser?.browsingContext?.originAttributes : null;
  return { available: true, addedCards: added.length, connectedCards: added.filter(card => card.isConnected).length,
    originAvailable: !!attrs, originMatches: !!attrs && attrs.userContextId === qa.identities[24].userContextId &&
      attrs.privateBrowsingId === 0 };
}

export function inspectPopupTarget({ x, y }) {
  const qa = window.__egdeskCookieQa, browser = document.getElementById(qa.cards.v24)?._xulBrowser;
  const hit = document.elementFromPoint(x, y);
  return !!browser && (hit === browser || !!(hit && browser.contains(hit)));
}

// Inject only fixed counters into the exact four known method bodies. The
// result is used solely for this run's already-isolated overlay copy.
export function transformPopupCounterSource(source) {
  const signatures = {
    createContentWindow: 'createContentWindow(aURI, aOpenWindowInfo, aWhere, aFlags, aTriggeringPrincipal, aCsp) {',
    createContentWindowInFrame: 'createContentWindowInFrame(aURI, aParams, aWhere, aFlags, aName) {',
    openURI: 'openURI(aURI, aOpenWindowInfo, aWhere, aFlags, aTriggeringPrincipal, aCsp) {',
    openURIInFrame: 'openURIInFrame(aURI, aParams, aWhere, aFlags, aName) {',
  };
  assert.equal(typeof source, 'string');
  assert.ok(!source.includes('window.__egdeskCookieQa?.popupMethodCounts'), 'popup counters already present');
  for (const [name, anchor] of Object.entries(signatures)) {
    const index = source.indexOf(anchor);
    assert.ok(index >= 0 && index === source.lastIndexOf(anchor), 'popup method anchor missing or duplicated');
    source = source.replace(anchor, `${anchor}\n        try { const counts = window.__egdeskCookieQa?.popupMethodCounts; if (counts) counts.${name}++; } catch {}`);
  }
  return source;
}

export function instrumentOwnedPopupCounters(prepared, runDir) {
  const temp = assertPrivateDirectory(path.join(runDir, 'tmp'), runDir);
  const profile = assertPrivateDirectory(prepared.profile, temp);
  assert.match(path.basename(profile), /^egdesk-chat-test-/);
  const file = path.join(profile, 'chrome/JS/eg-desk-surface.uc.js'), info = fs.lstatSync(file);
  assert.ok(info.isFile() && !info.isSymbolicLink() && info.uid === process.getuid() && info.nlink === 1 &&
    fs.realpathSync.native(file) === file && info.size < OVERLAY_MAX_BYTES, 'unsafe QA overlay copy');
  const original = fs.readFileSync(file, 'utf8'), sha = value => createHash('sha256').update(value).digest('hex');
  assert.equal(sha(original), prepared.sourceHash, 'QA overlay changed before counter instrumentation');
  assert.equal(sha(original), prepared.isolation.files['JS/eg-desk-surface.uc.js'].transformedSha256);
  const transformed = transformPopupCounterSource(original), fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW);
  try {
    const current = fs.fstatSync(fd);
    assert.ok(current.isFile() && current.dev === info.dev && current.ino === info.ino && current.nlink === 1);
    fs.writeFileSync(fd, transformed, 'utf8'); fs.ftruncateSync(fd, Buffer.byteLength(transformed));
  } finally { fs.closeSync(fd); }
  assert.equal(sha(fs.readFileSync(file)), sha(transformed), 'QA overlay counter write did not verify');
}

export function readPopupMethodCounters() {
  const counts = window.__egdeskCookieQa?.popupMethodCounts;
  if (!counts) return null;
  return { createContentWindow: counts.createContentWindow, createContentWindowInFrame: counts.createContentWindowInFrame,
    openURI: counts.openURI, openURIInFrame: counts.openURIInFrame };
}

async function openFixtureCard(mcp, fixture, version, checks, deadlineMs, signal, routeWaitMs = 30000) {
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
  checks[`header${route[0].toUpperCase()}${route.slice(1)}`] = await requireRoute(fixture, route, before, deadlineMs, signal, routeWaitMs);
  checks[`context${route[0].toUpperCase()}${route.slice(1)}`] = await mcp.evaluate(({ route, version }) => {
    const qa = window.__egdeskCookieQa, card = document.getElementById(qa.cards[route]);
    const attrs = card?._xulBrowser?.browsingContext?.originAttributes;
    const expected = version === 0 ? 0 : qa.identities[version].userContextId;
    return !!attrs && attrs.userContextId === expected && attrs.privateBrowsingId === 0;
  }, { route, version });
}

export async function observeBrowserLifecycle(mcp, fixture, checks, deadlineMs, signal, diagnostics, routeWaitMs = 30000, capture = null) {
  assert.ok(Number.isSafeInteger(routeWaitMs) && routeWaitMs > 0 && routeWaitMs <= 30000);
  const baseline = await browserDiagnosticStep(diagnostics, 'baseline', () => mcp.evaluate(() => {
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
  }));
  if (!baseline) throw new Error('current Desk canvas unavailable');
  await browserDiagnosticStep(diagnostics, 'v24', () => openFixtureCard(mcp, fixture, 24, checks, deadlineMs, signal, routeWaitMs));

  const popupBefore = snapshotRoute(fixture, 'popup');
  let methodCountsBefore, popupPoint, fixedPoint;
  try {
    const point = await browserDiagnosticStep(diagnostics, 'popupPoint', () => mcp.evaluate(inspectPopupPoint));
    fixedPoint = { ...point }; popupPoint = point;
    diagnostics.popup.pointAvailable = !!point;
    diagnostics.popup.pointInViewport = point?.inViewport === true;
    diagnostics.popup.pointHitsBrowser = point?.hitsBrowser === true;
    if (!point) throw new Error('popup link unavailable');
    for (const name of ['clientWidth', 'clientHeight', 'rectWidth', 'rectHeight', 'scaleXMilli', 'scaleYMilli']) {
      diagnostics.popup[name] = Number.isSafeInteger(point[name]) && point[name] >= 0 ? point[name] : 0;
    }
    if (capture) { try { await capture('popup-ready'); } catch {} }
    if (fixture.telemetry && !fixture.telemetry.geometrySeen) {
      try { await waitFor(() => fixture.telemetry.geometrySeen, deadlineMs, signal, 1000); } catch {}
    }
    const geometry = fixture.telemetry?.geometrySeen ? fixture.telemetry.geometry : null;
    if (geometry?.[4] > 0 && geometry?.[5] > 0 && point.rawRectWidth > 0 && point.rawRectHeight > 0) {
      popupPoint = { ...point, x: Math.round(point.rectLeft + ((geometry[0] + geometry[2]) / 2 / geometry[4]) * point.rawRectWidth),
        y: Math.round(point.rectTop + ((geometry[1] + geometry[3]) / 2 / geometry[5]) * point.rawRectHeight) };
      diagnostics.popup.targetFromGeometry = true;
    } else if (point.scaleXMilli > 0 && point.scaleYMilli > 0) {
      popupPoint = { ...point, x: Math.round(point.rectLeft + 20 * point.scaleXMilli / 1000),
        y: Math.round(point.rectTop + 20 * point.scaleYMilli / 1000) };
      diagnostics.popup.targetFromScale = true;
    }
    diagnostics.popup.targetHitsBrowser = await mcp.evaluate(inspectPopupTarget, { x: popupPoint.x, y: popupPoint.y }) === true;
    if (!diagnostics.popup.targetHitsBrowser) throw new Error('popup target outside owned browser');
    try {
      const counts = await mcp.evaluate(readPopupMethodCounters);
      if (POPUP_PROBE_METHODS.every(name => Number.isSafeInteger(counts?.[name]) && counts[name] >= 0)) {
        methodCountsBefore = counts; diagnostics.popup.counterReadBefore = true;
      }
    } catch { /* missing diagnostics must not block the trusted click */ }
    // The local page's anchor is activated with trusted native WebDriver input.
    await browserDiagnosticStep(diagnostics, 'popupClick', () => mcp.clickPoint({ x: popupPoint.x, y: popupPoint.y }));
    checks.headerPopup = await browserDiagnosticStep(diagnostics, 'popupRoute',
      () => requireRoute(fixture, 'popup', popupBefore, deadlineMs, signal, routeWaitMs));
    checks.contextPopup = await browserDiagnosticStep(diagnostics, 'popupContext', () => mcp.evaluate(() => {
      const qa = window.__egdeskCookieQa, expected = qa.identities[24].userContextId;
      const added = [...document.querySelectorAll('.egd-browser-card')].filter(card => !qa.beforePopup.includes(card.id));
      if (added.length !== 1) return false;
      qa.cards.popup = added[0].id;
      const attrs = added[0]._xulBrowser?.browsingContext?.originAttributes;
      return attrs?.userContextId === expected && attrs.privateBrowsingId === 0;
    }));
  } finally {
    if (methodCountsBefore) {
      try {
        const after = await mcp.evaluate(readPopupMethodCounters);
        if (POPUP_PROBE_METHODS.every(name => Number.isSafeInteger(after?.[name]) && after[name] >= methodCountsBefore[name])) {
          diagnostics.popup.counterReadAfter = true;
          for (const name of POPUP_PROBE_METHODS) diagnostics.popup.methods[name].calls = after[name] - methodCountsBefore[name];
        }
      } catch { /* optional counter read must not replace the original failure */ }
    }
    if (diagnostics.steps.popupClick.completed && !signal?.aborted && Date.now() < deadlineMs) {
      diagnostics.popup.observationStarted = true;
      try {
        const observed = await mcp.evaluate(inspectPopupCards);
        diagnostics.popup.observationCompleted = true;
        diagnostics.popup.observationAvailable = observed?.available === true;
        diagnostics.popup.addedCards = Number.isSafeInteger(observed?.addedCards) && observed.addedCards >= 0 ? observed.addedCards : 0;
        diagnostics.popup.connectedCards = Number.isSafeInteger(observed?.connectedCards) && observed.connectedCards >= 0 ? observed.connectedCards : 0;
        diagnostics.popup.originAvailable = observed?.originAvailable === true;
        diagnostics.popup.originMatches = observed?.originMatches === true;
      } catch { /* optional read-only diagnostics never replace the original failure */ }
    }
    const popupAfter = snapshotRoute(fixture, 'popup');
    diagnostics.popup.requests = popupAfter.requests - popupBefore.requests;
    diagnostics.popup.matchingHeaders = popupAfter.exact - popupBefore.exact;
    const telemetry = fixture.telemetry;
    if (telemetry?.geometrySeen && popupPoint?.rawRectWidth > 0 && popupPoint?.rawRectHeight > 0) {
      const [left, top, right, bottom, width, height] = telemetry.geometry;
      const x = (popupPoint.x - popupPoint.rectLeft) * width / popupPoint.rawRectWidth;
      const y = (popupPoint.y - popupPoint.rectTop) * height / popupPoint.rawRectHeight;
      const fx = (fixedPoint.x - fixedPoint.rectLeft) * width / fixedPoint.rawRectWidth;
      const fy = (fixedPoint.y - fixedPoint.rectTop) * height / fixedPoint.rawRectHeight;
      diagnostics.popup.anchorGeometryAvailable = width > 0 && height > 0;
      diagnostics.popup.projectedPointInsideAnchor = diagnostics.popup.anchorGeometryAvailable && x >= left && x < right && y >= top && y < bottom;
      diagnostics.popup.fixedPointInsideAnchor = diagnostics.popup.anchorGeometryAvailable && fx >= left && fx < right && fy >= top && fy < bottom;
    }
    diagnostics.popup.trustedPointerOnAnchor = telemetry?.trustedOnLink || 0;
    diagnostics.popup.trustedPointerOutsideAnchor = telemetry?.trustedElsewhere || 0;
  }

  const duplicateBefore = snapshotRoute(fixture, 'duplicate');
  const duplicated = await browserDiagnosticStep(diagnostics, 'duplicate', () => mcp.evaluate(({ port }) => {
    const qa = window.__egdeskCookieQa;
    const copy = window.__egdesk.browserRuntime.duplicate(qa.cards.v24);
    if (!copy?._xulBrowser) return false;
    qa.cards.duplicate = copy.id;
    return !!window.__egdesk.browserRuntime.navigate(copy, `http://127.0.0.1:${port}/cookie/duplicate`);
  }, { port: fixture.port }));
  if (!duplicated) throw new Error('duplicate Browser card unavailable');
  checks.headerDuplicate = await browserDiagnosticStep(diagnostics, 'duplicateRoute',
    () => requireRoute(fixture, 'duplicate', duplicateBefore, deadlineMs, signal, routeWaitMs));
  checks.contextDuplicate = await browserDiagnosticStep(diagnostics, 'duplicateContext', () => mcp.evaluate(() => {
    const qa = window.__egdeskCookieQa, card = document.getElementById(qa.cards.duplicate);
    const attrs = card?._xulBrowser?.browsingContext?.originAttributes;
    return attrs?.userContextId === qa.identities[24].userContextId && attrs.privateBrowsingId === 0;
  }));

  const restoreNavigation = snapshotRoute(fixture, 'restore');
  const navigated = await browserDiagnosticStep(diagnostics, 'restoreNavigation', () => mcp.evaluate(({ port }) =>
    window.__egdesk.browserRuntime.navigate(window.__egdeskCookieQa.cards.v24,
      `http://127.0.0.1:${port}/cookie/restore`), { port: fixture.port }));
  if (!navigated || !await browserDiagnosticStep(diagnostics, 'restoreSetupRoute',
    () => requireRoute(fixture, 'restore', restoreNavigation, deadlineMs, signal, routeWaitMs))) throw new Error('restore setup failed');
  const restoreBefore = snapshotRoute(fixture, 'restore');
  const restored = await browserDiagnosticStep(diagnostics, 'restoreCard', () => mcp.evaluate(async () => {
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
  }));
  if (!restored) throw new Error('Browser card restoration failed');
  checks.headerRestore = await browserDiagnosticStep(diagnostics, 'restoreRoute',
    () => requireRoute(fixture, 'restore', restoreBefore, deadlineMs, signal, routeWaitMs));
  checks.contextRestore = await browserDiagnosticStep(diagnostics, 'restoreContext', () => mcp.evaluate(() => {
    const qa = window.__egdeskCookieQa, card = document.getElementById(qa.cards.v24);
    const attrs = card?._xulBrowser?.browsingContext?.originAttributes;
    return attrs?.userContextId === qa.identities[24].userContextId && attrs.privateBrowsingId === 0;
  }));

  // Test a different profile's token with the same numeric container and a
  // required identity with missing metadata. A rejection must not mount a
  // default-container Browser or initiate the fixture navigation.
  await browserDiagnosticStep(diagnostics, 'identityChecks', async () => { for (const mode of ['foreign', 'portable', 'missing']) {
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
  } });
  await browserDiagnosticStep(diagnostics, 'v23', () => openFixtureCard(mcp, fixture, 23, checks, deadlineMs, signal, routeWaitMs));
  await browserDiagnosticStep(diagnostics, 'default', () => openFixtureCard(mcp, fixture, 0, checks, deadlineMs, signal, routeWaitMs));
  const placement = await browserDiagnosticStep(diagnostics, 'placement', () => mcp.evaluate(() => {
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
  }));
  for (const key of ['sameCanvas', 'sameDesk', 'noNewBoard', 'noNewBrowserWindow']) checks[key] = placement[key] === true;
}

// Imported factory's actual global is obtained via Cu, not by changing or
// substituting the production module. All output is boolean; neither native
// exception text nor an nsresult/path is returned or persisted.
export function inspectNativeCapabilities() {
  const read = (value, key) => { try { return value?.[key]; } catch { return undefined; } };
  const callable = (value, key) => typeof read(value, key) === 'function';
  const evaluationGlobal = globalThis, windowGlobal = window;
  const utils = read(evaluationGlobal, 'Cu') || read(read(evaluationGlobal, 'Components'), 'utils') ||
    read(windowGlobal, 'Cu') || read(read(windowGlobal, 'Components'), 'utils');
  const chrome = read(evaluationGlobal, 'ChromeUtils') || read(windowGlobal, 'ChromeUtils');
  let factory = null, moduleGlobal = null, coreImportSucceeded = false;
  try {
    const module = chrome.importESModule('chrome://userchrome/content/EGDeskBrowserCookieImport.sys.mjs');
    coreImportSucceeded = true;
    factory = read(module, 'createBrowserCookieImporter');
  } catch { /* recorded as a boolean */ }
  try { if (typeof factory === 'function' && callable(utils, 'getGlobalForObject')) moduleGlobal = utils.getGlobalForObject(factory); }
  catch { /* no raw exception */ }
  const globals = root => {
    const c = read(root, 'ChromeUtils'), crypto = read(root, 'crypto'), services = read(root, 'Services');
    const policies = read(services, 'policies'), prefs = read(services, 'prefs'), env = read(services, 'env');
    const cookies = read(services, 'cookies');
    const components = read(root, 'Components'), ci = read(root, 'Ci') || read(components, 'interfaces');
    const cc = read(root, 'Cc') || read(components, 'classes'), io = read(root, 'IOUtils');
    const version = read(read(services, 'appinfo'), 'platformVersion');
    const versionKnown = typeof version === 'string' && /^\d{1,3}(?:[.ab]|$)/i.test(version);
    return { chromeUtils: !!c, importESModule: callable(c, 'importESModule'), services: !!services,
      cc: !!read(root, 'Cc'), ci: !!read(root, 'Ci'), ccOrComponents: !!cc, ciOrComponents: !!ci,
      cookieValidationEok: typeof read(read(ci, 'nsICookieValidation'), 'eOK') === 'number',
      ioUtils: !!io, ioRead: callable(io, 'read'), crypto: !!crypto,
      cryptoSubtle: !!read(crypto, 'subtle'), cryptoRandomUUID: callable(crypto, 'randomUUID'),
      platformVersionKnown: versionKnown, platformVersionAtLeast142: versionKnown && Number.parseInt(version, 10) >= 142,
      policyApi: callable(policies, 'isAllowed'), prefsGetBool: callable(prefs, 'getBoolPref'),
      prefsChildList: callable(prefs, 'getChildList'), loggingEnvGet: callable(env, 'get'),
      cookies: !!cookies, cookieAdd: callable(cookies, 'add'), cookieList: callable(cookies, 'getCookiesWithOriginAttributes'),
      cookieRemove: callable(cookies, 'removeCookiesWithOriginAttributes') };
  };
  const importProbe = (root, uri, exportName) => {
    const loader = read(root, 'ChromeUtils');
    const status = { attempted: false, imported: false, exportPresent: false, typeError: false,
      hasNsResult: false, nsNotAvailable: false, nsFileNotFound: false, nsFailure: false };
    let value = null;
    if (!callable(loader, 'importESModule')) return { status, value };
    status.attempted = true;
    try { const module = loader.importESModule(uri); status.imported = true; value = read(module, exportName); status.exportPresent = !!value; }
    catch (error) {
      status.typeError = read(error, 'name') === 'TypeError';
      const result = read(error, 'result'), cr = read(root, 'Cr') || read(evaluationGlobal, 'Cr') || read(windowGlobal, 'Cr');
      status.hasNsResult = typeof result === 'number';
      status.nsNotAvailable = status.hasNsResult && typeof read(cr, 'NS_ERROR_NOT_AVAILABLE') === 'number' && result === cr.NS_ERROR_NOT_AVAILABLE;
      status.nsFileNotFound = status.hasNsResult && typeof read(cr, 'NS_ERROR_FILE_NOT_FOUND') === 'number' && result === cr.NS_ERROR_FILE_NOT_FOUND;
      status.nsFailure = status.hasNsResult && typeof read(cr, 'NS_ERROR_FAILURE') === 'number' && result === cr.NS_ERROR_FAILURE;
    }
    return { status, value };
  };
  const modules = root => {
    const app = importProbe(root, 'resource://gre/modules/AppConstants.sys.mjs', 'AppConstants');
    const priv = importProbe(root, 'resource://gre/modules/PrivateBrowsingUtils.sys.mjs', 'PrivateBrowsingUtils');
    const modern = importProbe(root, 'moz-src:///toolkit/components/contextualidentity/ContextualIdentityService.sys.mjs', 'ContextualIdentityService');
    const legacy = importProbe(root, 'resource://gre/modules/ContextualIdentityService.sys.mjs', 'ContextualIdentityService');
    const sqlite = importProbe(root, 'resource://gre/modules/Sqlite.sys.mjs', 'Sqlite');
    const platform = read(app.value, 'platform'), ids = modern.value || legacy.value;
    return { appConstants: app.status, privateBrowsing: priv.status, contextualIdentityModern: modern.status,
      contextualIdentityLegacy: legacy.status, sqlite: sqlite.status,
      appPlatformKnown: typeof platform === 'string', appPlatformMacosx: platform === 'macosx',
      appPlatformDarwin: platform === 'darwin', appPlatformMac: platform === 'mac',
      privateWindowCheck: callable(priv.value, 'isWindowPrivate'), identityCreate: callable(ids, 'create'),
      identityRemove: callable(ids, 'remove'), identityList: callable(ids, 'getPublicIdentities'),
      sqliteOpen: callable(sqlite.value, 'openConnection') };
  };
  const services = read(windowGlobal, 'Services') || read(evaluationGlobal, 'Services');
  const policies = read(services, 'policies'), prefs = read(services, 'prefs');
  let policyAllowed = false, containersEnabled = false;
  try { policyAllowed = policies?.isAllowed('profileImport') === true; } catch {}
  try { containersEnabled = prefs?.getBoolPref('privacy.userContext.enabled', false) === true; } catch {}
  return { coreImportSucceeded, coreFactoryCallable: typeof factory === 'function',
    getGlobalForObjectAvailable: callable(utils, 'getGlobalForObject'), moduleGlobalResolved: !!moduleGlobal,
    moduleGlobalIsWindow: !!moduleGlobal && moduleGlobal === windowGlobal,
    moduleGlobalIsEvaluation: !!moduleGlobal && moduleGlobal === evaluationGlobal,
    evaluationGlobalIsWindow: evaluationGlobal === windowGlobal,
    evaluationGlobals: globals(evaluationGlobal),
    windowGlobals: globals(windowGlobal), moduleGlobals: globals(moduleGlobal),
    windowModules: modules(windowGlobal), moduleModules: modules(moduleGlobal),
    browserWindow: { isChromeWindow: window.isChromeWindow === true, notClosed: window.closed === false,
      docShell: !!window.docShell, systemPrincipal: document.nodePrincipal?.isSystemPrincipal === true,
      policyApi: callable(policies, 'isAllowed'), policyAllowed, prefsGetBool: callable(prefs, 'getBoolPref'),
      containersEnabled, loggingEnvGet: callable(read(services, 'env'), 'get'), prefsChildList: callable(prefs, 'getChildList') } };
}

// QA-window-only factory substitution. This is never part of the product or
// its persisted profile source. If the exact method cannot be replaced and
// verified, the caller must not press "find profiles". The substitute can
// only construct the already-created, frozen synthetic adapter; it has no
// production discovery/Keychain fallback.
export function installUiSyntheticFactory() {
  const qa = window.__egdeskCookieQa, api = window.ChromeUtils;
  const uri = 'chrome://userchrome/content/EGDeskBrowserCookieImport.sys.mjs';
  if (!qa || !qa.fixtureRoot?.startsWith('/private/tmp/egdesk-round-') ||
      !Object.isFrozen(qa.syntheticAdapter) || typeof qa.createImporter !== 'function' ||
      typeof qa.syntheticAdapter.getCookieCapacity !== 'function' || typeof qa.syntheticAdapter.cookies?.add !== 'function' ||
      typeof qa.syntheticAdapter.getIdentity !== 'function' || typeof qa.syntheticAdapter.watchIdentity !== 'function' ||
      typeof qa.syntheticAdapter.identityInUse !== 'function' ||
      !api || typeof api.importESModule !== 'function' || qa.uiHook) return false;
  try {
    const suffix = '/synthetic-chrome';
    if (!qa.fixtureRoot.endsWith(suffix)) return false;
    const runDir = qa.fixtureRoot.slice(0, -suffix.length);
    const profile = Services.dirsvc.get('ProfD', Ci.nsIFile).path;
    const prefix = `${runDir}/tmp/egdesk-chat-test-`;
    if (!profile.startsWith(prefix) || profile.slice(prefix.length).includes('/') ||
        window.document?.documentURI !== 'chrome://browser/content/browser.xhtml' ||
        Cc['@mozilla.org/gfx/info;1'].getService(Ci.nsIGfxInfo).isHeadless !== true) return false;
  } catch { return false; }
  const descriptor = Object.getOwnPropertyDescriptor(api, 'importESModule');
  if (descriptor && !descriptor.configurable && (!Object.hasOwn(descriptor, 'value') || !descriptor.writable)) return false;
  if (!descriptor && !Object.isExtensible(api)) return false;
  const original = api.importESModule;
  const ui = { factoryCalls: 0, listCalls: 0, importCalls: 0, consentPassed: false,
    resultImported: false, importedCount: 0, userContextId: 0 };
  const syntheticModule = Object.freeze({ createBrowserCookieImporter(options = {}) {
    if (options.browserWindow !== window || options.profileImportPolicy !== 'allow' || options.privateBrowsingId !== 0) {
      throw new Error('unsafe QA factory request');
    }
    ui.factoryCalls++;
    const importer = qa.createImporter({ ...options, adapter: qa.syntheticAdapter });
    return Object.freeze({
      availability: () => importer.availability(),
      listProfiles(args) { ui.listCalls++; return importer.listProfiles(args); },
      ...(typeof importer.discardImport === 'function' ? { discardImport: args => importer.discardImport(args) } : {}),
      async importProfile(args) {
        ui.importCalls++;
        ui.consentPassed = args?.explicitUserConsent === true;
        const result = await importer.importProfile(args);
        ui.resultImported = result?.status === 'imported';
        ui.importedCount = Number.isSafeInteger(result?.counts?.imported) ? result.counts.imported : 0;
        ui.userContextId = Number.isSafeInteger(result?.userContextId) ? result.userContextId : 0;
        return result;
      },
    });
  } });
  const hook = function(specifier, ...rest) {
    if (specifier === uri) return syntheticModule;
    return Reflect.apply(original, api, [specifier, ...rest]);
  };
  const restore = () => {
    try {
      if (api.importESModule !== hook) return false;
      if (descriptor) Object.defineProperty(api, 'importESModule', descriptor);
      else delete api.importESModule;
      return api.importESModule === original;
    } catch { return false; }
  };
  try {
    const next = descriptor ? { configurable: descriptor.configurable, enumerable: descriptor.enumerable,
      writable: true, value: hook } : { configurable: true, enumerable: false, writable: true, value: hook };
    Object.defineProperty(api, 'importESModule', next);
    if (api.importESModule !== hook || api.importESModule(uri) !== syntheticModule) { restore(); return false; }
    qa.ui = ui;
    qa.uiHook = { api, hook, restore };
    return true;
  } catch { restore(); return false; }
}

export function restoreUiSyntheticFactory() {
  const qa = window.__egdeskCookieQa, owned = qa?.uiHook;
  if (!owned || owned.api.importESModule !== owned.hook) return false;
  const restored = owned.restore();
  if (restored) delete qa.uiHook;
  return restored;
}

export async function observeNativeAvailability(mcp, evidence, deadlineMs, signal, capture) {
  // Availability is the only production-adapter call in this verifier. It
  // checks native services and policy but never enumerates profiles, reads a
  // database, obtains a Keychain item, or performs an import.
  evidence.nativeDiagnostics = await mcp.evaluate(inspectNativeCapabilities);
  const availability = await mcp.evaluate(() => {
    let result = null, threw = false;
    try {
      const { createBrowserCookieImporter } = ChromeUtils.importESModule('chrome://userchrome/content/EGDeskBrowserCookieImport.sys.mjs');
      result = createBrowserCookieImporter({ browserWindow: window, profileImportPolicy: 'allow', privateBrowsingId: 0 }).availability();
    } catch { threw = true; }
    result ||= {};
    return { supported: result.supported === true, platform: result.reason === 'platform-unsupported',
      policy: result.reason === 'policy-denied' || result.reason === 'policy-unavailable' || result.reason === 'policy-unverified',
      privateContext: result.reason === 'private-context-unverified', containers: result.reason === 'containers-disabled',
      logging: result.reason === 'logging-enabled' || result.reason === 'logging-unverified',
      unavailable: result.reason === 'unavailable',
      nativeModuleLoader: result.reason === 'native-module-loader-unavailable',
      nativePlatform: result.reason === 'native-platform-unavailable',
      nativeServices: result.reason === 'native-services-unavailable',
      nativeVersion: result.reason === 'native-version-unavailable' || result.reason === 'gecko-version-unsupported',
      nativePrivateBrowsing: result.reason === 'native-private-browsing-unavailable',
      nativeIdentity: result.reason === 'native-contextual-identity-unavailable',
      nativeSqlite: result.reason === 'native-sqlite-unavailable',
      nativeComponents: result.reason === 'native-components-unavailable',
      nativeCookieApi: result.reason === 'native-cookie-api-unavailable',
      nativeIo: result.reason === 'native-io-unavailable', nativeCrypto: result.reason === 'native-crypto-unavailable', threw };
  });
  evidence.checks.nativeAvailability = availability.supported;
  evidence.nativeAvailability = { ...availability };
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
  await mcp.clickPoint(point);
  await waitFor(() => mcp.evaluate(() => document.querySelectorAll('[data-testid="browser-cookie-import"]').length === 1),
    deadlineMs, signal);
  evidence.checks.nativeMenuEnabled = await mcp.evaluate(() => {
    const nodes = document.querySelectorAll('[data-testid="browser-cookie-import"]');
    return nodes.length === 1 && nodes[0].disabled === false && nodes[0].getAttribute('aria-disabled') !== 'true';
  });
  await capture('menu'); evidence.screenshots.menu = true;
  if (availability.supported && evidence.checks.nativeMenuEnabled) {
    const item = await mcp.evaluate(() => {
      const node = document.querySelector('[data-testid="browser-cookie-import"]');
      if (!node || node.disabled) return null;
      node.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      const rect = node.getBoundingClientRect();
      return { x: Math.round((rect.left + rect.right) / 2), y: Math.round((rect.top + rect.bottom) / 2) };
    });
    if (!item) throw new Error('native menu entry unavailable');
    await mcp.clickPoint(item); // Opens only the intro; never clicks Find or consent.
    await waitFor(() => mcp.evaluate(() => !!document.querySelector('[data-testid="browser-cookie-import-dialog"]') &&
      !!document.querySelector('[data-testid="browser-cookie-find"]')), deadlineMs, signal);
    evidence.checks.nativeDialogIntro = true;
    await capture('dialog'); evidence.screenshots.dialog = true;
    const close = await mcp.evaluate(() => {
      const node = document.querySelector('[data-testid="browser-cookie-close"]');
      if (!node) return null;
      const rect = node.getBoundingClientRect();
      return { x: Math.round((rect.left + rect.right) / 2), y: Math.round((rect.top + rect.bottom) / 2) };
    });
    if (!close) throw new Error('native intro close unavailable');
    await mcp.clickPoint(close);
    await waitFor(() => mcp.evaluate(() => !document.querySelector('[data-testid="browser-cookie-import-dialog"]')),
      deadlineMs, signal);
    evidence.checks.nativeDialogClosed = true;
  } else {
    await mcp.nativeInput([{ type: 'key', id: 'egdesk_cookie_qa_escape', actions: [
      { type: 'keyDown', value: '\uE00C' }, { type: 'keyUp', value: '\uE00C' },
    ] }]);
    await waitFor(() => mcp.evaluate(() => !document.querySelector('[data-testid="browser-cookie-import"]')),
      deadlineMs, signal);
    throw new Error('native availability or menu is disabled');
  }
}

async function nativeClickTestId(mcp, testId) {
  assert.match(testId, /^browser-(?:menu|cookie-import|cookie-find|cookie-profile|cookie-consent|cookie-confirm|cookie-close)$/);
  const point = await mcp.evaluate(id => {
    const nodes = document.querySelectorAll(`[data-testid="${id}"]`);
    if (nodes.length !== 1 || nodes[0].disabled) return null;
    nodes[0].scrollIntoView({ block: 'nearest', inline: 'nearest' });
    const rect = nodes[0].getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    return { x: Math.round((rect.left + rect.right) / 2), y: Math.round((rect.top + rect.bottom) / 2) };
  }, testId);
  if (!point) throw new Error('owned wizard control unavailable');
  await mcp.clickPoint(point);
}

export async function observeSyntheticWizard(mcp, fixture, evidence, deadlineMs, signal, capture) {
  const checks = evidence.checks;
  const baseline = await mcp.evaluate(() => {
    const qa = window.__egdeskCookieQa, desk = window.__egdesk;
    const canvas = document.getElementById('egd-canvas-layer');
    if (!qa || !desk?.agenda?.readStore || !canvas) return false;
    const windows = Services.wm.getEnumerator('navigator:browser');
    let windowCount = 0;
    while (windows.hasMoreElements()) { windows.getNext(); windowCount++; }
    qa.uiBaseline = { canvas, agendaId: desk.state.agenda.activeAgendaId,
      boardIds: Object.keys(desk.state.boards.projections).sort(),
      savedBoardIds: Object.keys(desk.agenda.readStore().agendas).sort(),
      activeProjectionId: desk.state.boards.activeProjectionId,
      cards: [...document.querySelectorAll('.egd-browser-card')].map(card => card.id),
      windowCount, reads: qa.counts.reads, passwords: qa.counts.keychainFixtureCalls };
    return true;
  });
  if (!baseline) throw new Error('wizard baseline unavailable');
  checks.uiInjectionInstalled = await mcp.evaluate(installUiSyntheticFactory);
  if (!checks.uiInjectionInstalled) throw new Error('synthetic factory could not be isolated');
  try {
    await nativeClickTestId(mcp, 'browser-menu');
    await waitFor(() => mcp.evaluate(() => !!document.querySelector('[data-testid="browser-cookie-import"]')),
      deadlineMs, signal);
    const menuFactoryCalls = await mcp.evaluate(() => {
      const qa = window.__egdeskCookieQa, node = document.querySelector('[data-testid="browser-cookie-import"]');
      return qa?.uiHook?.api.importESModule === qa.uiHook.hook && !node?.disabled ? qa.ui.factoryCalls : 0;
    });
    if (menuFactoryCalls < 1) throw new Error('menu did not capture synthetic factory');
    await nativeClickTestId(mcp, 'browser-cookie-import');
    await waitFor(() => mcp.evaluate(() => !!document.querySelector('[data-testid="browser-cookie-find"]')),
      deadlineMs, signal);
    checks.uiFactoryCaptured = await mcp.evaluate(previous => {
      const qa = window.__egdeskCookieQa;
      return qa?.uiHook?.api.importESModule === qa.uiHook.hook && qa.ui.factoryCalls > previous &&
        qa.ui.listCalls === 0 && qa.counts.reads === qa.uiBaseline.reads &&
        qa.counts.keychainFixtureCalls === qa.uiBaseline.passwords;
    }, menuFactoryCalls);
    // This is the only step that starts profile enumeration. Never press it
    // unless the opened UI demonstrably obtained our locked synthetic factory.
    if (!checks.uiFactoryCaptured) throw new Error('wizard did not capture synthetic factory');
    await nativeClickTestId(mcp, 'browser-cookie-find');
    await waitFor(() => mcp.evaluate(() => !!document.querySelector('[data-testid="browser-cookie-profile"]')),
      deadlineMs, signal);
    const listed = await mcp.evaluate(() => {
      const qa = window.__egdeskCookieQa, select = document.querySelector('[data-testid="browser-cookie-profile"]');
      return { syntheticReader: qa?.uiHook?.api.importESModule === qa.uiHook.hook && qa.ui.listCalls === 1 &&
          qa.counts.reads === qa.uiBaseline.reads + 1 && qa.counts.keychainFixtureCalls === qa.uiBaseline.passwords,
        expectedOption: !!select && select.options.length === 3 && select.options[1].textContent.includes('Synthetic v24') };
    });
    checks.uiSyntheticReader = listed.syntheticReader && listed.expectedOption;
    if (!checks.uiSyntheticReader) throw new Error('synthetic profile listing not verified');
    await nativeClickTestId(mcp, 'browser-cookie-profile');
    await mcp.nativeInput([{ type: 'key', id: 'egdesk_cookie_qa_select', actions: [
      { type: 'keyDown', value: '\uE011' }, { type: 'keyUp', value: '\uE011' },
      { type: 'keyDown', value: '\uE015' }, { type: 'keyUp', value: '\uE015' },
      { type: 'keyDown', value: '\uE007' }, { type: 'keyUp', value: '\uE007' },
    ] }]);
    await waitFor(() => mcp.evaluate(() => document.querySelector('[data-testid="browser-cookie-profile"]')?.selectedIndex === 1),
      deadlineMs, signal);
    checks.uiProfileSelected = true;
    await nativeClickTestId(mcp, 'browser-cookie-consent');
    checks.uiConsentEnabledConfirm = await mcp.evaluate(() => {
      const consent = document.querySelector('[data-testid="browser-cookie-consent"]');
      const confirm = document.querySelector('[data-testid="browser-cookie-confirm"]');
      const qa = window.__egdeskCookieQa;
      return consent?.checked === true && confirm?.disabled === false && qa?.uiHook?.api.importESModule === qa.uiHook.hook;
    });
    if (!checks.uiConsentEnabledConfirm) throw new Error('synthetic consent not verified');
    await capture('wizard-choice'); evidence.screenshots.wizardChoice = true;
    await nativeClickTestId(mcp, 'browser-cookie-confirm'); // no retry after this action
    await waitFor(() => mcp.evaluate(() => !!document.querySelector('[data-testid="browser-cookie-result"]')),
      deadlineMs, signal);
    const outcome = await mcp.evaluate(() => {
      const qa = window.__egdeskCookieQa, desk = window.__egdesk, before = qa.uiBaseline;
      const added = [...document.querySelectorAll('.egd-browser-card')].filter(card => !before.cards.includes(card.id));
      const match = added.filter(card => card._browserIdentity?.userContextId === qa.ui.userContextId);
      if (match.length === 1) qa.cards.wizard = match[0].id;
      const attrs = match[0]?._xulBrowser?.browsingContext?.originAttributes;
      const windows = Services.wm.getEnumerator('navigator:browser');
      let windowCount = 0; while (windows.hasMoreElements()) { windows.getNext(); windowCount++; }
      return {
        imported: qa.ui.importCalls === 1 && qa.ui.consentPassed && qa.ui.resultImported && qa.ui.importedCount === 1 &&
          qa.ui.userContextId > 0 && qa.counts.keychainFixtureCalls === before.passwords + 1,
        newCard: match.length === 1 && attrs?.userContextId === qa.ui.userContextId && attrs.privateBrowsingId === 0 &&
          match[0]._sourceRef?.browserIdentityRequired === true && !!match[0]._sourceRef?.browserIdentityKey,
        sameCanvas: !!match[0] && before.canvas === document.getElementById('egd-canvas-layer') && before.canvas.contains(match[0]),
        sameDesk: before.agendaId === desk.state.agenda.activeAgendaId,
        noNewBoard: JSON.stringify(before.boardIds) === JSON.stringify(Object.keys(desk.state.boards.projections).sort()) &&
          JSON.stringify(before.savedBoardIds) === JSON.stringify(Object.keys(desk.agenda.readStore().agendas).sort()) &&
          before.activeProjectionId === desk.state.boards.activeProjectionId,
        noNewWindow: before.windowCount === windowCount,
      };
    });
    checks.uiImportResult = outcome.imported;
    checks.uiNewCard = outcome.newCard;
    checks.uiSameCanvas = outcome.sameCanvas && outcome.sameDesk && outcome.noNewBoard && outcome.noNewWindow;
    await capture('wizard-result'); evidence.screenshots.wizardResult = true;
    await nativeClickTestId(mcp, 'browser-cookie-close');
    await waitFor(() => mcp.evaluate(() => !document.querySelector('[data-testid="browser-cookie-import-dialog"]')),
      deadlineMs, signal);
    if (!checks.uiImportResult || !checks.uiNewCard || !checks.uiSameCanvas) throw new Error('synthetic wizard result incomplete');
  } finally {
    try { checks.uiInjectionRestored = await mcp.evaluate(restoreUiSyntheticFactory); } catch { checks.uiInjectionRestored = false; }
  }
  if (!checks.uiInjectionRestored) throw new Error('synthetic factory restoration unverified');
  const before = snapshotRoute(fixture, 'wizard');
  const navigated = await mcp.evaluate(({ port }) => window.__egdesk.browserRuntime.navigate(
    window.__egdeskCookieQa.cards.wizard, `http://127.0.0.1:${port}/cookie/wizard`), { port: fixture.port });
  if (!navigated) throw new Error('synthetic wizard Browser navigation failed');
  checks.uiHeader = await requireRoute(fixture, 'wizard', before, deadlineMs, signal);
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
    'distinctContainers', 'nativeReadbackV24', 'nativeReadbackV23', 'nativePersistentV24', 'nativeSessionV23',
    'defaultReadback', 'syntheticPasswordOnly'];
  const checkNames = ['nativeAvailability', 'nativeMenuEnabled', 'nativeDialogIntro', 'nativeDialogClosed', ...importerCheckNames,
    'uiInjectionInstalled', 'uiFactoryCaptured', 'uiSyntheticReader', 'uiProfileSelected', 'uiConsentEnabledConfirm',
    'uiImportResult', 'uiNewCard', 'uiSameCanvas', 'uiInjectionRestored', 'uiHeader',
    'headerV24', 'contextV24', 'headerV23', 'contextV23', 'headerDefault', 'contextDefault',
    'headerPopup', 'contextPopup', 'headerDuplicate', 'contextDuplicate', 'headerRestore', 'contextRestore',
    'foreignIdentityRejected', 'portableIdentityRejected', 'missingIdentityRejected',
    'sameCanvas', 'sameDesk', 'noNewBoard', 'noNewBrowserWindow'];
  const evidence = { ok: false, stages: { fixture: false, profile: false, sandbox: false, firefox: false,
    mcp: false, native: false, importer: false, wizard: false, browser: false }, checks: Object.fromEntries(checkNames.map(name => [name, false])),
    nativeAvailability: { supported: false, platform: false, policy: false, privateContext: false,
      containers: false, logging: false, unavailable: false },
    nativeDiagnostics: {}, browserDiagnostics: createBrowserDiagnostics(),
    screenshots: { menu: false, dialog: false, wizardChoice: false, wizardResult: false, popupReady: false },
    counts: { fixtureBytes: 0, overlayBytes, artifactBytes: 0, fixtureRequests: 0, unexpectedRequests: 0,
      syntheticPasswordCalls: 0, nativeWrites: 0 }, failures: { fixture: false, profile: false, sandbox: false,
      firefox: false, mcp: false, native: false, importer: false, wizard: false, browser: false, interrupted: false, artifactLimit: false },
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
    instrumentOwnedPopupCounters(prepared, runDir);
    evidence.browserDiagnostics.popup.counterCopyApplied = true;
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
    const capture = async name => {
      assert.ok(['menu', 'dialog', 'wizard-choice', 'wizard-result', 'popup-ready'].includes(name));
      await takeScreenshot(mcp, path.join(runDir, `cookie-${name}.png`));
      if (name === 'popup-ready') evidence.screenshots.popupReady = true;
    };
    await observeNativeAvailability(mcp, evidence, options.deadlineMs, interruption.signal, capture);
    evidence.stages.native = true;
    stage = 'importer'; assertRunning(options.deadlineMs, interruption.signal);
    assert.equal(await mcp.evaluate(installFixtureIdentityGuard, { root: chromeFixture.root, runDir }), true);
    const observed = await mcp.evaluate(installImporterFixture, { root: chromeFixture.root, runDir,
      password: FIXTURE_PASSWORD, cookieName: COOKIE_NAME, v23Value: VALUES[23], v24Value: VALUES[24], defaultValue: VALUES[0] });
    for (const key of Object.keys(observed.checks)) if (Object.hasOwn(evidence.checks, key)) evidence.checks[key] = observed.checks[key] === true;
    evidence.counts.syntheticPasswordCalls = observed.counts.keychainFixtureCalls;
    evidence.counts.nativeWrites = observed.counts.nativeWrites;
    evidence.stages.importer = true;
    assert.ok(importerCheckNames.every(name => evidence.checks[name]), 'synthetic importer acceptance failed');
    stage = 'wizard'; assertRunning(options.deadlineMs, interruption.signal);
    await observeSyntheticWizard(mcp, fixture, evidence, options.deadlineMs, interruption.signal, capture);
    evidence.stages.wizard = true;
    stage = 'browser'; assertRunning(options.deadlineMs, interruption.signal);
    await observeBrowserLifecycle(mcp, fixture, evidence.checks, options.deadlineMs, interruption.signal, evidence.browserDiagnostics, 30000, capture);
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
