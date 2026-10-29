import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import childProcess from 'node:child_process';
import { createDecipheriv, createHash, pbkdf2Sync, randomUUID, webcrypto } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import vm from 'node:vm';
import { createBrowserCookieImporter } from '../overlay/resources/EGDeskBrowserCookieImport.sys.mjs';
import {
  COOKIE_NAME, ARTIFACT_STOP_BYTES, OVERLAY_MAX_BYTES, parseCli, treeUsageBytes,
  assertEvidenceOnlyNumbers, cookieHeaderEvidence, syntheticEncryptedValue, syntheticCryptoFixture,
  createChromeFixture, createCookieFixtureServer, writeEvidence, stopOwnedChild, installFixtureIdentityGuard, installImporterFixture,
  observeNativeAvailability, inspectNativeCapabilities, installUiSyntheticFactory,
  restoreUiSyntheticFactory, observeSyntheticWizard, createBrowserDiagnostics, inspectPopupPoint, inspectPopupCards,
  observeBrowserLifecycle, runCli,
} from './verify-firefox-mcp-browser-cookie-import.mjs';

function temporaryDirectory(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'egdesk-cookie-unit-'));
  fs.chmodSync(root, 0o700);
  t.after(() => {
    assert.equal(fs.realpathSync.native(root), root);
    assert.match(path.basename(root), /^egdesk-cookie-unit-/);
    fs.rmSync(root, { recursive: true });
  });
  return root;
}

test('CLI is fixed-scenario, explicit-path and bounded by a near deadline', () => {
  const now = Date.parse('2026-10-29T00:00:00Z');
  const args = ['--evidence-root', '/private/tmp/egdesk-round-fixture', '--deadline-utc', '2026-10-29T00:10:00Z',
    '--firefox', '/fixture/Firefox.app/Contents/MacOS/firefox', '--mcp-entry',
    '/fixture/node_modules/@mozilla/firefox-devtools-mcp-moz/dist.moz/index.js',
    '--geckodriver', '/fixture/geckodriver', '--loader-source', '/fixture/pinned-loader'];
  assert.equal(parseCli(args, now).deadlineMs, now + 600000);
  assert.throws(() => parseCli([...args, '--profile', '/actual/profile'], now));
  assert.throws(() => parseCli([...args, '--scenario', 'core'], now), /fixed synthetic scenario/);
  const tooLate = [...args]; tooLate[3] = '2026-10-29T00:16:00Z';
  assert.throws(() => parseCli(tooLate, now), /15 minutes/);
  const tooSoon = [...args]; tooSoon[3] = '2026-10-29T00:00:10Z';
  assert.throws(() => parseCli(tooSoon, now), /future/);
});

test('fixture v23 and v24 ciphertext use synthetic AES and the v24 host digest', () => {
  const { password, host } = syntheticCryptoFixture();
  const key = pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1');
  for (const version of [23, 24]) {
    const encrypted = syntheticEncryptedValue(version);
    assert.ok(encrypted.subarray(0, 3).equals(Buffer.from('v10')));
    const decipher = createDecipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20));
    const clear = Buffer.concat([decipher.update(encrypted.subarray(3)), decipher.final()]);
    const prefix = version === 24 ? 32 : 0;
    if (version === 24) assert.ok(clear.subarray(0, prefix).equals(createHash('sha256').update(host).digest()));
    assert.equal(cookieHeaderEvidence(`${COOKIE_NAME}=${clear.subarray(prefix).toString()}`, version).onlyExpected, true);
  }
  assert.throws(() => syntheticEncryptedValue(25));
  assert.throws(() => syntheticEncryptedValue(24, 'example.com'));
});

test('fresh, bounded Chrome source contains only synthetic DB v23/v24 rows', t => {
  const runDir = temporaryDirectory(t);
  const fixture = createChromeFixture(runDir, 1793232000000);
  assert.equal(fixture.root, path.join(runDir, 'synthetic-chrome'));
  assert.deepEqual(fixture.profiles.map(item => item.version), [24, 23]);
  assert.ok(treeUsageBytes(fixture.root).bytes < 2 * 1024 * 1024);
  assert.equal(JSON.parse(fs.readFileSync(path.join(fixture.root, 'Local State'), 'utf8')).profile.last_used, 'Default');
  for (const { directory, version } of fixture.profiles) {
    const db = new DatabaseSync(path.join(fixture.root, directory, 'Cookies'), { readOnly: true });
    try {
      assert.equal(Number(db.prepare("SELECT value FROM meta WHERE key='version'").get().value), version);
      const rows = db.prepare(`SELECT host_key, name, value, encrypted_value, has_cross_site_ancestor, source_scheme, source_port,
        CAST(expires_utc AS TEXT) AS expires_utc, has_expires, is_persistent FROM cookies`).all();
      assert.equal(rows.length, 1);
      assert.equal(rows[0].host_key, '127.0.0.1');
      assert.equal(rows[0].name, COOKIE_NAME);
      assert.equal(rows[0].value, '');
      assert.equal(rows[0].has_cross_site_ancestor, 1);
      assert.equal(rows[0].source_scheme, 0);
      assert.equal(rows[0].source_port, -1);
      assert.equal(rows[0].has_expires, version === 24 ? 1 : 0);
      assert.equal(rows[0].is_persistent, version === 24 ? 1 : 0);
      assert.equal(rows[0].expires_utc, version === 24
        ? (1793232000000n * 1000n + 11644473600000000n + 3600n * 1000000n).toString() : '0');
      assert.ok(Buffer.from(rows[0].encrypted_value).equals(syntheticEncryptedValue(version)));
    } finally { db.close(); }
  }
  assert.throws(() => createChromeFixture(runDir), /EEXIST/);
});

test('committed Core accepts both real synthetic SQLite rows with an injected in-memory writer', async t => {
  const runDir = temporaryDirectory(t), fixture = createChromeFixture(runDir);
  const ids = [], jars = new Map(), identities = new Map(), watchers = new Map(), adoptedIds = new Set();
  let nextId = 1, passwordCalls = 0;
  const adapter = {
    platform: 'macosx', crypto: webcrypto, randomUUID, now: Date.now, checkAccess: () => true,
    async readRoot() { return [{ directory: 'Default', name: 'Synthetic v24' }, { directory: 'Profile 1', name: 'Synthetic v23' }]; },
    async readSqlite(directory) {
      assert.ok(['Default', 'Profile 1'].includes(directory));
      const db = new DatabaseSync(path.join(fixture.root, directory, 'Cookies'), { readOnly: true });
      try {
        const version = Number(db.prepare("SELECT value FROM meta WHERE key='version'").get().value);
        const rows = db.prepare(`SELECT host_key,top_frame_site_key,name,value,encrypted_value,path,
          CAST(expires_utc AS TEXT) AS expires_utc,is_secure,is_httponly,has_expires,is_persistent,
          samesite,source_scheme,source_port,has_cross_site_ancestor FROM cookies`).all();
        return { version, rows, totalRows: rows.length };
      } finally { db.close(); }
    },
    getKeychainPassword() { passwordCalls++; return syntheticCryptoFixture().password; },
    getIdentityIds: () => [...ids],
    getIdentity: id => identities.get(id) ?? null,
    identityInUse: id => identities.has(id) ? adoptedIds.has(id) : null,
    watchIdentity(id, invalidate) {
      if (!watchers.has(id)) watchers.set(id, new Set());
      watchers.get(id).add(invalidate);
      return () => watchers.get(id)?.delete(invalidate);
    },
    getCookieCapacity: () => ({ current: [...jars.values()].reduce((sum, list) => sum + list.length, 0), max: 3000 }),
    createIdentity(name) {
      const userContextId = nextId++, identity = { userContextId, name, icon: 'fingerprint', color: 'blue', public: true };
      ids.push(userContextId); identities.set(userContextId, identity); return identity;
    },
    removeIdentity(id) {
      const index = ids.indexOf(id); if (index < 0) return false;
      ids.splice(index, 1); identities.delete(id);
      for (const invalidate of watchers.get(id) || []) invalidate();
      return true;
    },
    cookies: {
      add(cookie, attrs) {
        jars.set(attrs.userContextId, [{ ...cookie, isPartitioned: false, originAttributes: { ...attrs } }]);
        return true;
      },
      list: attrs => jars.get(attrs.userContextId) || [],
      removeAll: attrs => { jars.delete(attrs.userContextId); },
    },
  };
  const options = { adapter, profileImportPolicy: 'allow', privateBrowsingId: 0 };
  const importer = createBrowserCookieImporter(options);
  assert.equal(createBrowserCookieImporter({ ...options, privateBrowsingId: 1 }).availability().supported, false);
  assert.equal(createBrowserCookieImporter({ ...options, profileImportPolicy: 'deny' }).availability().supported, false);
  assert.equal((await importer.listProfiles()).supported, false);
  const listed = await importer.listProfiles({ explicitUserRequest: true });
  assert.equal(listed.supported, true);
  const selected = version => listed.profiles.find(profile => profile.name === `Synthetic v${version}`).id;
  assert.equal((await importer.importProfile({ profileId: selected(24) })).status, 'failed');
  const v24 = await importer.importProfile({ profileId: selected(24), explicitUserConsent: true });
  const v23 = await importer.importProfile({ profileId: selected(23), explicitUserConsent: true });
  assert.equal(v24.status, 'imported'); assert.equal(v23.status, 'imported');
  assert.equal(v24.counts.imported, 1); assert.equal(v23.counts.imported, 1);
  assert.notEqual(v24.userContextId, v23.userContextId);
  assert.equal(adapter.identityInUse(v24.userContextId), false);
  adoptedIds.add(v24.userContextId); // The synthetic Browser adopted this identity.
  assert.equal(adapter.identityInUse(v24.userContextId), true);
  const refused = await importer.discardImport({ userContextId: v24.userContextId });
  assert.equal(refused.status, 'cleanup-required');
  assert.equal(identities.has(v24.userContextId), true);
  assert.equal(jars.has(v24.userContextId), true);
  assert.equal(cookieHeaderEvidence(`${COOKIE_NAME}=${jars.get(v24.userContextId)[0].value}`, 24).onlyExpected, true);
  assert.equal(cookieHeaderEvidence(`${COOKIE_NAME}=${jars.get(v23.userContextId)[0].value}`, 23).onlyExpected, true);
  assert.equal(jars.get(v24.userContextId)[0].isSession, false);
  assert.equal(jars.get(v23.userContextId)[0].isSession, true);
  assert.equal(jars.get(v23.userContextId)[0].expiry, Number.MAX_SAFE_INTEGER);
  assert.equal(passwordCalls, 2);
  assert.equal(jars.has(0), false);
  // The current Core contract conservatively refuses port-scoped host cookies;
  // the realistic secure 443 row must be classified, not silently imported.
  let secureReads = 0;
  const secureAdapter = { ...adapter, async readSqlite(directory) {
    secureReads++;
    const data = await adapter.readSqlite(directory);
    return { ...data, rows: data.rows.map(row => ({ ...row, is_secure: 1, source_scheme: 2, source_port: 443 })) };
  } };
  const secureImporter = createBrowserCookieImporter({ ...options, adapter: secureAdapter });
  const secureList = await secureImporter.listProfiles({ explicitUserRequest: true });
  const beforeSecurePasswords = passwordCalls, beforeSecureIds = [...ids];
  const noCompatibilityConsent = await secureImporter.importProfile({ profileId: secureList.profiles[0].id,
    explicitUserConsent: true, scopeMode: 'standard-web' });
  assert.equal(noCompatibilityConsent.status, 'failed');
  assert.equal(secureReads, 0);
  const secureResult = await secureImporter.importProfile({ profileId: secureList.profiles[0].id, explicitUserConsent: true });
  assert.equal(secureResult.status, 'failed');
  assert.equal(secureResult.counts.unsupported, 1);
  assert.equal(passwordCalls, beforeSecurePasswords);
  assert.deepEqual(ids, beforeSecureIds);
  const compatible = await secureImporter.importProfile({ profileId: secureList.profiles[0].id,
    explicitUserConsent: true, scopeMode: 'standard-web', explicitScopeCompatibilityConsent: true });
  assert.equal(compatible.status, 'imported');
  assert.equal(compatible.counts.imported, 1);
  assert.equal(jars.get(compatible.userContextId)[0].isSecure, true);
  const knownBoundAdapter = { ...secureAdapter, async readSqlite(directory) {
    return { ...await secureAdapter.readSqlite(directory), scopeBindings: { port: true } };
  } };
  const knownBoundImporter = createBrowserCookieImporter({ ...options, adapter: knownBoundAdapter });
  const knownBoundList = await knownBoundImporter.listProfiles({ explicitUserRequest: true });
  const knownBound = await knownBoundImporter.importProfile({ profileId: knownBoundList.profiles[0].id,
    explicitUserConsent: true, scopeMode: 'standard-web', explicitScopeCompatibilityConsent: true });
  assert.equal(knownBound.status, 'failed');
  assert.equal(knownBound.counts.unsupported, 1);
  const beforeIds = [...ids], controller = new AbortController();
  const beforeJars = jars.size;
  const cancelAdapter = { ...adapter, cookies: { ...adapter.cookies, add(cookie, attrs) {
    const result = adapter.cookies.add(cookie, attrs); controller.abort(); return result;
  } } };
  const cancelImporter = createBrowserCookieImporter({ ...options, adapter: cancelAdapter });
  const cancelList = await cancelImporter.listProfiles({ explicitUserRequest: true });
  const cancel = await cancelImporter.importProfile({ profileId: cancelList.profiles[0].id,
    explicitUserConsent: true, signal: controller.signal });
  assert.equal(cancel.status, 'cancelled');
  assert.deepEqual(ids, beforeIds);
  assert.equal(jars.size, beforeJars);
});

test('disk accounting never follows links and is bounded by an entry ceiling', t => {
  const root = temporaryDirectory(t);
  const file = path.join(root, 'small');
  fs.writeFileSync(file, 'abc', { flag: 'wx', mode: 0o600 });
  fs.symlinkSync('/Users', path.join(root, 'outside'));
  const result = treeUsageBytes(root);
  assert.equal(result.entries, 3);
  assert.ok(result.bytes < 1024 * 1024);
  assert.throws(() => treeUsageBytes(root, { maxEntries: 2 }), /entry limit/);
  assert.ok(OVERLAY_MAX_BYTES < ARTIFACT_STOP_BYTES && ARTIFACT_STOP_BYTES < 500 * 1024 * 1024);
});

test('isolated Gecko fixture only cleans its own unused, never-adopted identities', async () => {
  let captured, nextId = 1, removed = 0, cleared = 0, tabs = 0, scanFails = false;
  const runDir = '/private/tmp/egdesk-round-unit/browser-import/run-test';
  const bindings = [], observers = new Map();
  const identities = {
    create: name => ({ userContextId: nextId++, name }),
    remove: () => { removed++; return true; },
    countContainerTabs: () => { if (scanFails) throw new Error('unavailable'); return tabs; },
  };
  const services = {
    cookies: { removeCookiesWithOriginAttributes() { cleared++; } },
    dirsvc: { get: () => ({ path: `${runDir}/tmp/egdesk-chat-test-fake` }) },
    wm: { getEnumerator: () => [{ closed: false, document: { querySelectorAll: () => bindings } }] },
    obs: {
      addObserver(observer, topic) { observers.set(topic, observer); },
      removeObserver(_observer, topic) { observers.delete(topic); },
    },
  };
  const localFile = { path: '', initWithPath(value) { this.path = value; }, exists: () => true,
    isDirectory: () => true, isSymlink: () => false };
  const context = vm.createContext({ window: { crypto: webcrypto }, Services: services,
    document: { documentURI: 'chrome://browser/content/browser.xhtml' },
    Cc: { '@mozilla.org/file/local;1': { createInstance: () => localFile },
      '@mozilla.org/gfx/info;1': { getService: () => ({ isHeadless: true }) } }, Ci: { nsIFile: {}, nsIGfxInfo: {} },
    ChromeUtils: { importESModule(uri) {
      if (uri.includes('Sqlite')) return { Sqlite: {} };
      if (uri.includes('ContextualIdentityService')) return { ContextualIdentityService: identities };
      if (uri.includes('EGDeskBrowserCookieImport')) return { createBrowserCookieImporter(options) {
        captured = options.adapter; throw new Error('fixture adapter captured');
      } };
      throw new Error('unexpected import');
    } },
  });
  const guard = vm.runInContext(`(${installFixtureIdentityGuard.toString()})`, context);
  assert.equal(guard({ root: '/unsafe', runDir }), false);
  assert.equal(guard({ root: `${runDir}/synthetic-chrome`, runDir }), true);
  assert.equal(guard({ root: `${runDir}/synthetic-chrome`, runDir }), false);
  const install = vm.runInContext(`(${installImporterFixture.toString()})`, context);
  await assert.rejects(install({ root: `${runDir}/synthetic-chrome`, runDir }), /fixture adapter captured/);
  assert.equal(captured.identityInUse(99), null);
  assert.throws(() => captured.removeIdentity(99));
  const first = captured.createIdentity('Synthetic').userContextId;
  assert.equal(captured.identityInUse(first), false);
  captured.cookies.removeAll({ userContextId: first, privateBrowsingId: 0 });
  assert.equal(cleared, 1);
  bindings.push({ browsingContext: { originAttributes: { userContextId: first } } });
  assert.equal(captured.identityInUse(first), true);
  bindings.length = 0;
  assert.equal(captured.identityInUse(first), true); // Adoption remains sticky after close.
  assert.throws(() => captured.cookies.removeAll({ userContextId: first, privateBrowsingId: 0 }));
  assert.throws(() => captured.removeIdentity(first));
  const second = captured.createIdentity('Synthetic').userContextId;
  let invalidated = 0;
  const unwatch = captured.watchIdentity(second, () => invalidated++);
  observers.get('browsing-context-attached').observe({ originAttributes: { userContextId: second } }, 'browsing-context-attached');
  assert.equal(invalidated, 1);
  assert.equal(captured.identityInUse(second), true);
  unwatch();
  const third = captured.createIdentity('Synthetic').userContextId;
  scanFails = true;
  assert.equal(captured.identityInUse(third), null);
  assert.throws(() => captured.removeIdentity(third));
  assert.equal(removed, 0);
});

test('cookie header checks reject missing, wrong, duplicate and unrelated cookies without storing values', () => {
  assert.deepEqual(cookieHeaderEvidence(undefined, 24), { count: 0, onlyExpected: false });
  assert.equal(cookieHeaderEvidence(`${COOKIE_NAME}=synthetic_v24_only`, 24).onlyExpected, true);
  for (const header of [`${COOKIE_NAME}=synthetic_v23_only`, `${COOKIE_NAME}=synthetic_v24_only; other=x`,
    `${COOKIE_NAME}=synthetic_v24_only; ${COOKIE_NAME}=synthetic_v24_only`]) {
    assert.equal(cookieHeaderEvidence(header, 24).onlyExpected, false);
  }
  assert.throws(() => cookieHeaderEvidence('irrelevant', 999));
});

test('loopback handler reports counts only, rejects unknown routes and never forwards', () => {
  const { server, counts } = createCookieFixtureServer();
  const call = (url, cookie, method = 'GET') => {
    const response = { status: null, body: '', writeHead(status) { this.status = status; }, end(body = '') { this.body = body; } };
    server.emit('request', { method, url, headers: cookie ? { cookie } : {} }, response);
    return response;
  };
  assert.equal(call('/cookie/v24', `${COOKIE_NAME}=synthetic_v24_only`).status, 200);
  assert.equal(call('/cookie/default', `${COOKIE_NAME}=synthetic_v24_only`).status, 200);
  assert.equal(call('/v1/state').status, 200);
  assert.equal(call('https://example.com/', '').status, 404);
  let destroyed = false;
  server.emit('connect', {}, { destroy() { destroyed = true; } });
  assert.equal(destroyed, true);
  assert.deepEqual(counts, { requests: 4, state: 1, v23: 0, v24: 1, default: 1, unexpected: 2,
    duplicate: 0, popup: 0, restore: 0, wizard: 0, exactV23: 0, exactV24: 1, exactDefault: 0,
    exactDuplicate: 0, exactPopup: 0, exactRestore: 0, exactWizard: 0 });
  assertEvidenceOnlyNumbers(counts);
  assert.doesNotMatch(JSON.stringify(counts), /synthetic_v24_only/);
});

test('popup point observation checks viewport and chrome hit without storing page content', () => {
  const browser = { getBoundingClientRect: () => ({ left: 10, top: 20, width: 150, height: 120 }), contains: () => false };
  const qa = { cards: { v24: 'synthetic-card' } }, win = { __egdeskCookieQa: qa, innerWidth: 200, innerHeight: 200 };
  const doc = { getElementById: () => ({ _xulBrowser: browser }),
    querySelectorAll: () => [{ id: 'synthetic-card' }], elementFromPoint: () => browser };
  const context = vm.createContext({ window: win, document: doc });
  const inspect = vm.runInContext(`(${inspectPopupPoint.toString()})`, context);
  const point = inspect();
  assert.equal(point.inViewport, true); assert.equal(point.hitsBrowser, true);
  win.innerWidth = 20;
  const outside = inspect();
  assert.equal(outside.inViewport, false); assert.equal(outside.hitsBrowser, false);
});

test('popup observation reports only added card counts and origin equality', () => {
  const qa = { beforePopup: ['existing'], identities: { 24: { userContextId: 17 } } };
  const cards = [{ id: 'existing', isConnected: true }, { id: 'synthetic-popup', isConnected: true,
    _xulBrowser: { browsingContext: { originAttributes: { userContextId: 17, privateBrowsingId: 0 } } } }];
  const context = vm.createContext({ window: { __egdeskCookieQa: qa }, document: { querySelectorAll: () => cards } });
  const observe = vm.runInContext(`(${inspectPopupCards.toString()})`, context);
  const result = observe();
  assert.equal(result.available, true); assert.equal(result.addedCards, 1); assert.equal(result.connectedCards, 1);
  assert.equal(result.originAvailable, true); assert.equal(result.originMatches, true);
  assert.doesNotMatch(JSON.stringify(result), /synthetic-popup|existing/);
});

function syntheticLifecycle({ point = { x: 40, y: 50, inViewport: true, hitsBrowser: true },
  requests = 0, matching = 0, clickThrows = false, popupCard = false } = {}) {
  const fixture = { port: 44001, counts: { v24: 0, exactV24: 0, popup: 0, exactPopup: 0,
    duplicate: 0, exactDuplicate: 0 } };
  let evaluations = 0;
  const mcp = {
    async evaluate(fn) {
      if (fn === inspectPopupCards) return { available: true, addedCards: Number(popupCard),
        connectedCards: Number(popupCard), originAvailable: popupCard, originMatches: popupCard };
      evaluations++;
      if (evaluations === 1) return true; // baseline
      if (evaluations === 2) { fixture.counts.v24++; fixture.counts.exactV24++; return true; }
      if (evaluations === 3) return true; // v24 context
      if (evaluations === 4) return point;
      if (evaluations === 5) return false; // popup context
      throw new Error('fixture stops at duplicate');
    },
    async clickPoint() {
      if (clickThrows) throw new Error('raw exception must never be recorded');
      fixture.counts.popup += requests; fixture.counts.exactPopup += matching;
    },
  };
  return { fixture, mcp, diagnostics: createBrowserDiagnostics(), checks: {} };
}

test('popup diagnostics distinguish unavailable point, failed click and request timeout', async () => {
  const signal = new AbortController().signal;
  const unavailable = syntheticLifecycle({ point: null });
  await assert.rejects(observeBrowserLifecycle(unavailable.mcp, unavailable.fixture, unavailable.checks,
    Date.now() + 3000, signal, unavailable.diagnostics, 10));
  assert.equal(unavailable.diagnostics.steps.v24.completed, true);
  assert.equal(unavailable.diagnostics.steps.popupPoint.completed, true);
  assert.equal(unavailable.diagnostics.popup.pointAvailable, false);
  assert.equal(unavailable.diagnostics.steps.popupClick.started, false);

  const click = syntheticLifecycle({ clickThrows: true });
  await assert.rejects(observeBrowserLifecycle(click.mcp, click.fixture, click.checks,
    Date.now() + 3000, signal, click.diagnostics, 10));
  assert.equal(click.diagnostics.popup.pointInViewport, true);
  assert.equal(click.diagnostics.popup.pointHitsBrowser, true);
  assert.equal(click.diagnostics.steps.popupClick.started, true);
  assert.equal(click.diagnostics.steps.popupClick.completed, false);
  assert.equal(click.diagnostics.steps.popupRoute.started, false);
  assert.doesNotMatch(JSON.stringify(click.diagnostics), /raw exception/);

  const timeout = syntheticLifecycle();
  await assert.rejects(observeBrowserLifecycle(timeout.mcp, timeout.fixture, timeout.checks,
    Date.now() + 3000, signal, timeout.diagnostics, 10));
  assert.equal(timeout.diagnostics.steps.popupClick.completed, true);
  assert.equal(timeout.diagnostics.steps.popupRoute.started, true);
  assert.equal(timeout.diagnostics.steps.popupRoute.completed, false);
  assert.equal(timeout.diagnostics.popup.routeTimedOut, true);
  assert.equal(timeout.diagnostics.popup.requests, 0);
  assert.equal(timeout.diagnostics.steps.popupContext.started, false);
  assert.equal(timeout.diagnostics.popup.observationCompleted, true);
  assert.equal(timeout.diagnostics.popup.addedCards, 0);
  assertEvidenceOnlyNumbers(timeout.diagnostics);

  const blankPopup = syntheticLifecycle({ popupCard: true });
  await assert.rejects(observeBrowserLifecycle(blankPopup.mcp, blankPopup.fixture, blankPopup.checks,
    Date.now() + 3000, signal, blankPopup.diagnostics, 10));
  assert.equal(blankPopup.diagnostics.popup.routeTimedOut, true);
  assert.equal(blankPopup.diagnostics.popup.requests, 0);
  assert.equal(blankPopup.diagnostics.popup.addedCards, 1);
  assert.equal(blankPopup.diagnostics.popup.connectedCards, 1);
  assert.equal(blankPopup.diagnostics.popup.originMatches, true);
});

test('popup request with wrong header stays a failed check and is distinguishable from timeout', async () => {
  for (const matching of [0, 1]) {
    const run = syntheticLifecycle({ requests: 1, matching });
    await assert.rejects(observeBrowserLifecycle(run.mcp, run.fixture, run.checks,
      Date.now() + 3000, new AbortController().signal, run.diagnostics, 10), /fixture stops at duplicate/);
    assert.equal(run.diagnostics.steps.popupRoute.completed, true);
    assert.equal(run.diagnostics.popup.routeTimedOut, false);
    assert.equal(run.diagnostics.popup.requests, 1);
    assert.equal(run.diagnostics.popup.matchingHeaders, matching);
    assert.equal(run.checks.headerPopup, matching === 1);
    assert.equal(run.diagnostics.steps.popupContext.completed, true);
    assert.equal(run.checks.contextPopup, false);
    assert.equal(run.diagnostics.steps.duplicate.started, true);
    assert.equal(run.diagnostics.steps.duplicate.completed, false);
    assertEvidenceOnlyNumbers(run.diagnostics);
  }
});

test('only explicitly owned process handles can be signalled', async () => {
  const child = new EventEmitter();
  child.exitCode = null; child.signalCode = null;
  let signals = 0;
  child.kill = signal => { assert.equal(signal, 'SIGTERM'); signals++; queueMicrotask(() => {
    child.signalCode = 'SIGTERM'; child.emit('exit');
  }); };
  await assert.rejects(stopOwnedChild(child, []), /unowned/);
  assert.equal(signals, 0);
  await stopOwnedChild(child, [child]);
  assert.equal(signals, 1);
  await stopOwnedChild(child, [child]);
  assert.equal(signals, 1);
});

test('privileged importer fixture fits the isolated MCP script limit', () => {
  const source = installImporterFixture.toString();
  const runDir = `/private/tmp/egdesk-round-${'a'.repeat(200)}/browser-import/run-ABC123`;
  const profile = `${runDir}/tmp/egdesk-chat-test-ABC123`;
  const args = { root: `${runDir}/synthetic-chrome`, runDir, password: syntheticCryptoFixture().password,
    cookieName: COOKIE_NAME, v23Value: 'synthetic_v23_only', v24Value: 'synthetic_v24_only', defaultValue: 'synthetic_default_only' };
  // Match IsolatedMcp.evaluate's wrapper, including a long but valid owned
  // run/profile path, not merely the bare function's source length.
  const wrapped = `async () => {
      const Services = globalThis.Services || ChromeUtils.importESModule('resource://gre/modules/Services.sys.mjs').Services;
      if (Services.dirsvc.get('ProfD', Ci.nsIFile).path !== ${JSON.stringify(profile)} ||
          Cc['@mozilla.org/gfx/info;1'].getService(Ci.nsIGfxInfo).isHeadless !== true ||
          document.documentURI !== ${JSON.stringify('chrome://browser/content/browser.xhtml')}) throw new Error('Refusing non-owned or non-headless context');
      try { return JSON.stringify({ ok: true, value: await (${source})(${JSON.stringify(args)}) }); }
      catch (e) { return JSON.stringify({ ok: false, error: e.message || String(e) }); }
    }`;
  assert.ok(Buffer.byteLength(wrapped) < 16384);
  assert.ok(Buffer.byteLength(wrapped.replace(source, installFixtureIdentityGuard.toString())) < 16384);
  assert.match(source, /getKeychainPassword\(\) \{ counters\.keychainFixtureCalls\+\+; return password; \}/);
  assert.doesNotMatch(source, /getGenericPassword|Chrome Safe Storage/);
  assert.doesNotMatch(source, /createBrowserCookieImporter\(\s*\)/);
  assert.doesNotMatch(source, /createBrowserCookieImporter\(\s*\{\s*browserWindow/);
  assert.match(source, /services\.cookies\.add/);
  assert.match(source, /Sqlite\.openConnection/);
});

test('native diagnostics resolve the factory global and report only bounded booleans', () => {
  const calls = [], factory = () => assert.fail('diagnostic must not invoke the importer');
  const makeRealm = () => {
    const realm = { Cc: {}, Ci: {}, IOUtils: {}, crypto: { subtle: {}, randomUUID() {} },
      Services: { cookies: { add() {}, getCookiesWithOriginAttributes() {}, removeCookiesWithOriginAttributes() {} },
        policies: { isAllowed: () => true }, prefs: { getBoolPref: () => true, getChildList: () => [] }, env: { get() {} } } };
    realm.ChromeUtils = { importESModule(uri) {
      calls.push(uri);
      if (uri.includes('EGDeskBrowserCookieImport')) return { createBrowserCookieImporter: factory };
      if (uri.includes('AppConstants')) return { AppConstants: { platform: 'macosx' } };
      if (uri.includes('PrivateBrowsingUtils')) return { PrivateBrowsingUtils: { isWindowPrivate() {} } };
      if (uri.includes('moz-src:')) return { ContextualIdentityService: { create() {}, remove() {}, getPublicIdentities() {} } };
      if (uri.includes('ContextualIdentityService')) throw new Error('SECRET_NATIVE_ERROR_MUST_NOT_ESCAPE');
      if (uri.includes('Sqlite')) return { Sqlite: { openConnection() {} } };
      throw new Error('unknown');
    } };
    return realm;
  };
  const moduleRealm = makeRealm(), browserRealm = makeRealm();
  browserRealm.Components = { utils: { getGlobalForObject: value => value === factory ? moduleRealm : null } };
  browserRealm.window = { isChromeWindow: true, closed: false, docShell: {} };
  browserRealm.document = { nodePrincipal: { isSystemPrincipal: true } };
  const result = vm.runInNewContext(`(${inspectNativeCapabilities.toString()})()`, browserRealm);
  assert.equal(result.coreImportSucceeded, true);
  assert.equal(result.moduleGlobalResolved, true);
  assert.equal(result.moduleGlobals.importESModule, true);
  assert.equal(result.moduleModules.appPlatformMacosx, true);
  assert.equal(result.moduleModules.contextualIdentityModern.imported, true);
  assert.equal(result.moduleModules.contextualIdentityLegacy.imported, false);
  assert.equal(result.browserWindow.policyAllowed, true);
  assert.doesNotMatch(JSON.stringify(result), /SECRET_NATIVE_ERROR/);
  assert.ok(calls.some(uri => uri.startsWith('moz-src:')));
  assert.ok(Buffer.byteLength(inspectNativeCapabilities.toString()) < 12000);
});

test('UI factory injection is temporary, synthetic-only and rejects unsafe fallback', async () => {
  const original = () => ({ original: true }), api = { importESModule: original }, calls = [];
  const adapter = Object.freeze({ synthetic: true, getCookieCapacity: () => ({ current: 0, max: 3000 }),
    getIdentity: () => null, identityInUse: () => true, watchIdentity: () => () => {},
    cookies: Object.freeze({ add: () => true }) });
  const qa = { fixtureRoot: '/private/tmp/egdesk-round-unit/synthetic-chrome', syntheticAdapter: adapter,
    createImporter(options) {
      calls.push(options);
      return { availability: () => ({ supported: true }), listProfiles: async () => ({ supported: true, profiles: [] }),
        importProfile: async () => ({ status: 'imported', counts: { imported: 1 }, userContextId: 7 }) };
    } };
  const win = { ChromeUtils: api, __egdeskCookieQa: qa,
    document: { documentURI: 'chrome://browser/content/browser.xhtml' } };
  const globals = { Services: { dirsvc: { get: () => ({ path: '/private/tmp/egdesk-round-unit/tmp/egdesk-chat-test-fake' }) } },
    Ci: { nsIFile: {}, nsIGfxInfo: {} }, Cc: { '@mozilla.org/gfx/info;1': { getService: () => ({ isHeadless: true }) } } };
  const context = vm.createContext({ window: win, ...globals });
  assert.equal(vm.runInContext(`(${installUiSyntheticFactory.toString()})()`, context), true);
  const importer = api.importESModule('chrome://userchrome/content/EGDeskBrowserCookieImport.sys.mjs');
  assert.throws(() => importer.createBrowserCookieImporter({}), /unsafe QA factory/);
  const wrapped = importer.createBrowserCookieImporter({ browserWindow: win, profileImportPolicy: 'allow', privateBrowsingId: 0,
    adapter: { unsafe: true } });
  assert.equal(calls[0].adapter, adapter);
  assert.equal((await wrapped.listProfiles({ explicitUserRequest: true })).supported, true);
  assert.equal((await wrapped.importProfile({ explicitUserConsent: true })).status, 'imported');
  assert.equal(qa.ui.listCalls, 1); assert.equal(qa.ui.importCalls, 1);
  assert.equal(api.importESModule('other').original, true);
  assert.equal(vm.runInContext(`(${restoreUiSyntheticFactory.toString()})()`, context), true);
  assert.equal(api.importESModule, original);
  const locked = {};
  Object.defineProperty(locked, 'importESModule', { value: original, writable: false, configurable: false });
  const lockedContext = vm.createContext({ window: { ChromeUtils: locked, __egdeskCookieQa: qa, document: win.document }, ...globals });
  assert.equal(vm.runInContext(`(${installUiSyntheticFactory.toString()})()`, lockedContext), false);
  assert.equal(locked.importESModule, original);
  const foreground = vm.createContext({ window: win, ...globals,
    Cc: { '@mozilla.org/gfx/info;1': { getService: () => ({ isHeadless: false }) } } });
  assert.equal(vm.runInContext(`(${installUiSyntheticFactory.toString()})()`, foreground), false);
  assert.equal(api.importESModule, original);
});

test('wizard never clicks Find when the synthetic factory was not captured', async () => {
  const point = { x: 20, y: 20 };
  const values = [true, true, point, true, 1, point, true, false, true];
  let clicks = 0;
  const mcp = { async evaluate() { return values.shift(); }, async clickPoint() { clicks++; } };
  const evidence = { checks: {}, screenshots: {} };
  await assert.rejects(observeSyntheticWizard(mcp, {}, evidence, Date.now() + 3000,
    new AbortController().signal, async () => assert.fail('must not reach screenshots')));
  assert.equal(clicks, 2); // menu + intro; no Find, consent, or import
  assert.equal(evidence.checks.uiFactoryCaptured, false);
  assert.equal(evidence.checks.uiInjectionRestored, true);
});

test('wizard orchestration requires selection, consent, new same-canvas card and matching local header', async () => {
  const point = { x: 20, y: 20 }, clicks = [], captures = [];
  const values = [true, true, point, true, 1, point, true, true, point, true,
    { syntheticReader: true, expectedOption: true }, point, true, point, true, point, true,
    { imported: true, newCard: true, sameCanvas: true, sameDesk: true, noNewBoard: true, noNewWindow: true },
    point, true, true, true];
  const fixture = { counts: { wizard: 0, exactWizard: 0 }, port: 44001 };
  const mcp = { async evaluate(fn) {
    if (fn.toString().includes('browserRuntime.navigate')) { fixture.counts.wizard++; fixture.counts.exactWizard++; }
    return values.shift();
  }, async clickPoint(value) { clicks.push(value); }, async nativeInput() {} };
  const evidence = { checks: {}, screenshots: {} };
  await observeSyntheticWizard(mcp, fixture, evidence, Date.now() + 3000, new AbortController().signal,
    async name => captures.push(name));
  assert.equal(values.length, 0);
  assert.equal(clicks.length, 7);
  assert.deepEqual(captures, ['wizard-choice', 'wizard-result']);
  for (const check of ['uiInjectionInstalled', 'uiFactoryCaptured', 'uiSyntheticReader', 'uiProfileSelected',
    'uiConsentEnabledConfirm', 'uiImportResult', 'uiNewCard', 'uiSameCanvas', 'uiInjectionRestored', 'uiHeader']) {
    assert.equal(evidence.checks[check], true);
  }
});

test('native availability, trusted menu and intro capture precede synthetic adapter installation', async () => {
  const order = [], values = [
    { coreImportSucceeded: true },
    { supported: true, platform: false, policy: false, privateContext: false, containers: false, logging: false, unavailable: false },
    { x: 20, y: 20 }, true, true, { x: 30, y: 30 }, true, { x: 40, y: 40 }, true,
  ];
  const mcp = {
    async evaluate() { order.push('evaluate'); return values.shift(); },
    async clickPoint() { order.push('native-click'); },
    async nativeInput() { order.push('native-escape'); },
  };
  const evidence = { checks: {}, screenshots: {} };
  await observeNativeAvailability(mcp, evidence, Date.now() + 3000, new AbortController().signal,
    async name => order.push(`capture-${name}`));
  assert.equal(evidence.checks.nativeAvailability, true);
  assert.equal(evidence.checks.nativeMenuEnabled, true);
  assert.equal(evidence.checks.nativeDialogIntro, true);
  assert.equal(evidence.checks.nativeDialogClosed, true);
  assert.deepEqual(evidence.screenshots, { menu: true, dialog: true });
  assert.deepEqual(order, ['evaluate', 'evaluate', 'evaluate', 'native-click', 'evaluate', 'evaluate', 'capture-menu',
    'evaluate', 'native-click', 'evaluate', 'capture-dialog', 'evaluate', 'native-click', 'evaluate']);
  const source = runCli.toString();
  assert.ok(source.indexOf('observeNativeAvailability') < source.indexOf('mcp.evaluate(installImporterFixture'));
  const disabledValues = [{ coreImportSucceeded: true }, { supported: false, policy: true }, { x: 20, y: 20 }, true, false, true];
  let clicks = 0; const captures = [], disabledEvidence = { checks: {}, screenshots: {} };
  await assert.rejects(observeNativeAvailability({ async evaluate() { return disabledValues.shift(); },
    async clickPoint() { clicks++; }, async nativeInput() {} }, disabledEvidence, Date.now() + 3000,
  new AbortController().signal, async name => captures.push(name)));
  assert.equal(clicks, 1);
  assert.deepEqual(captures, ['menu']);
  assert.equal(disabledEvidence.screenshots.menu, true);
});

test('result writer allows only boolean and count evidence and refuses overwrite', t => {
  const root = temporaryDirectory(t);
  for (const invalid of [{ value: 'cookie' }, { value: null }, { value: [true] }, { value: -1 },
    { value: 1.2 }, { 'bad-key': true }, { value: new Date() },
    { get value() { return true; } }]) assert.throws(() => assertEvidenceOnlyNumbers(invalid));
  const cyclic = {}; cyclic.self = cyclic;
  assert.throws(() => assertEvidenceOnlyNumbers(cyclic));
  const evidence = { ok: false, checks: { isolated: true }, counts: { imported: 2 } };
  writeEvidence(root, evidence);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'cookie-result.json'), 'utf8')), evidence);
  assert.throws(() => writeEvidence(root, evidence), /EEXIST/);
});

test('importing the verifier does not launch processes, create servers or write files', async t => {
  const refuse = () => assert.fail('module import must have no effects');
  const mocks = [t.mock.method(childProcess, 'spawn', refuse), t.mock.method(fs, 'writeFileSync', refuse),
    t.mock.method(net, 'createServer', refuse), t.mock.method(http, 'createServer', refuse)];
  syncBuiltinESMExports();
  try { await import('./verify-firefox-mcp-browser-cookie-import.mjs?import-safety-check'); }
  finally { for (const mock of mocks) mock.mock.restore(); syncBuiltinESMExports(); }
});
