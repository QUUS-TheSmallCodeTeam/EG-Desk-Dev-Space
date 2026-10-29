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
import { createBrowserCookieImporter } from '../overlay/resources/EGDeskBrowserCookieImport.sys.mjs';
import {
  COOKIE_NAME, ARTIFACT_STOP_BYTES, OVERLAY_MAX_BYTES, parseCli, treeUsageBytes,
  assertEvidenceOnlyNumbers, cookieHeaderEvidence, syntheticEncryptedValue, syntheticCryptoFixture,
  createChromeFixture, createCookieFixtureServer, writeEvidence, stopOwnedChild, installImporterFixture,
  observeNativeAvailability, runCli,
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
      const rows = db.prepare('SELECT host_key, name, value, encrypted_value, has_cross_site_ancestor, source_scheme, source_port FROM cookies').all();
      assert.equal(rows.length, 1);
      assert.equal(rows[0].host_key, '127.0.0.1');
      assert.equal(rows[0].name, COOKIE_NAME);
      assert.equal(rows[0].value, '');
      assert.equal(rows[0].has_cross_site_ancestor, 0);
      assert.equal(rows[0].source_scheme, 0);
      assert.equal(rows[0].source_port, -1);
      assert.ok(Buffer.from(rows[0].encrypted_value).equals(syntheticEncryptedValue(version)));
    } finally { db.close(); }
  }
  assert.throws(() => createChromeFixture(runDir), /EEXIST/);
});

test('committed Core accepts both real synthetic SQLite rows with an injected in-memory writer', async t => {
  const runDir = temporaryDirectory(t), fixture = createChromeFixture(runDir);
  const ids = [], jars = new Map();
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
    createIdentity(name) { const userContextId = nextId++; ids.push(userContextId); return { userContextId, name }; },
    removeIdentity(id) { const index = ids.indexOf(id); if (index < 0) return false; ids.splice(index, 1); return true; },
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
  assert.equal(cookieHeaderEvidence(`${COOKIE_NAME}=${jars.get(v24.userContextId)[0].value}`, 24).onlyExpected, true);
  assert.equal(cookieHeaderEvidence(`${COOKIE_NAME}=${jars.get(v23.userContextId)[0].value}`, 23).onlyExpected, true);
  assert.equal(passwordCalls, 2);
  assert.equal(jars.has(0), false);
  const beforeIds = [...ids], controller = new AbortController();
  const cancelAdapter = { ...adapter, cookies: { ...adapter.cookies, add(cookie, attrs) {
    const result = adapter.cookies.add(cookie, attrs); controller.abort(); return result;
  } } };
  const cancelImporter = createBrowserCookieImporter({ ...options, adapter: cancelAdapter });
  const cancelList = await cancelImporter.listProfiles({ explicitUserRequest: true });
  const cancel = await cancelImporter.importProfile({ profileId: cancelList.profiles[0].id,
    explicitUserConsent: true, signal: controller.signal });
  assert.equal(cancel.status, 'cancelled');
  assert.deepEqual(ids, beforeIds);
  assert.equal(jars.size, 2);
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
    duplicate: 0, popup: 0, restore: 0, exactV23: 0, exactV24: 1, exactDefault: 0,
    exactDuplicate: 0, exactPopup: 0, exactRestore: 0 });
  assertEvidenceOnlyNumbers(counts);
  assert.doesNotMatch(JSON.stringify(counts), /synthetic_v24_only/);
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
  assert.ok(Buffer.byteLength(source) < 12000);
  assert.match(source, /getKeychainPassword\(\) \{ counters\.keychainFixtureCalls\+\+; return password; \}/);
  assert.doesNotMatch(source, /getGenericPassword|Chrome Safe Storage/);
  assert.doesNotMatch(source, /createBrowserCookieImporter\(\s*\)/);
  assert.doesNotMatch(source, /createBrowserCookieImporter\(\s*\{\s*browserWindow/);
  assert.match(source, /services\.cookies\.add/);
  assert.match(source, /Sqlite\.openConnection/);
});

test('native availability and trusted menu check precede synthetic adapter installation', async () => {
  const order = [], values = [
    { supported: true, platform: false, policy: false, privateContext: false, containers: false, logging: false, unavailable: false },
    { x: 20, y: 20 }, true, true, true,
  ];
  const mcp = {
    async evaluate() { order.push('evaluate'); return values.shift(); },
    async clickPoint() { order.push('native-click'); },
    async nativeInput() { order.push('native-escape'); },
  };
  const evidence = { checks: {} };
  await observeNativeAvailability(mcp, evidence, Date.now() + 3000, new AbortController().signal);
  assert.equal(evidence.checks.nativeAvailability, true);
  assert.equal(evidence.checks.nativeMenuEnabled, true);
  assert.deepEqual(order, ['evaluate', 'evaluate', 'native-click', 'evaluate', 'evaluate', 'native-escape', 'evaluate']);
  const source = runCli.toString();
  assert.ok(source.indexOf('observeNativeAvailability') < source.indexOf('mcp.evaluate(installImporterFixture'));
  let clicked = false;
  await assert.rejects(observeNativeAvailability({ async evaluate() { return { supported: false, policy: true }; },
    async clickPoint() { clicked = true; } }, { checks: {} }, Date.now() + 3000, new AbortController().signal));
  assert.equal(clicked, false);
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
