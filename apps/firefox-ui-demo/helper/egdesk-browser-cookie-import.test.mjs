import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, webcrypto } from 'node:crypto';
import { createBrowserCookieImporter } from '../overlay/resources/EGDeskBrowserCookieImport.sys.mjs';

const encoder = new TextEncoder();
const NOW = 1_900_000_000_123;
const EPOCH = 11644473600000000n;
const PASSWORD = 'synthetic-passphrase';
const future = ms => String(EPOCH + BigInt(ms) * 1000n + 321n);
const row = (changes = {}) => ({
  host_key: '.example.test', top_frame_site_key: '', has_cross_site_ancestor: 1,
  name: 'synthetic-name', value: 'synthetic-value', encrypted_value: new Uint8Array(),
  path: '/', expires_utc: future(NOW + 86400000), is_secure: 1, is_httponly: 1,
  has_expires: 1, is_persistent: 1, samesite: 2, source_scheme: 2, source_port: 443,
  ...changes,
});

async function ciphertext(host, value, version = 24, password = PASSWORD) {
  const material = await webcrypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveKey']);
  const key = await webcrypto.subtle.deriveKey({ name: 'PBKDF2', salt: encoder.encode('saltysalt'),
    iterations: 1003, hash: 'SHA-1' }, material, { name: 'AES-CBC', length: 128 }, false, ['encrypt']);
  const valueBytes = encoder.encode(value);
  const digest = version === 24 ? new Uint8Array(await webcrypto.subtle.digest('SHA-256', encoder.encode(host))) : new Uint8Array();
  const plain = new Uint8Array(digest.length + valueBytes.length);
  plain.set(digest); plain.set(valueBytes, digest.length);
  const cipher = new Uint8Array(await webcrypto.subtle.encrypt({ name: 'AES-CBC', iv: new Uint8Array(16).fill(32) }, key, plain));
  const bytes = new Uint8Array(3 + cipher.length);
  bytes.set([0x76, 0x31, 0x30]); bytes.set(cipher, 3);
  return bytes;
}

function fixture(rows = [], version = 24) {
  const state = { rows, version, jars: new Map(), identities: [7], calls: [], allowed: true, next: 80,
    baseCount: 0, maxCookies: 3000, scopeBindings: undefined, identityRecords: new Map(),
    watchers: new Map(), inUse: new Set() };
  state.identityRecords.set(7, { userContextId: 7, name: 'Existing', icon: 'fingerprint', color: 'blue', public: true });
  state.invalidate = id => { for (const callback of state.watchers.get(id) || []) callback(); };
  const adapter = {
    platform: 'macosx', crypto: webcrypto, randomUUID, now: () => NOW,
    checkAccess: () => state.allowed,
    async readRoot() { state.calls.push('root'); return [
      { directory: 'Default', name: 'Synthetic Profile', email: 'fixture@example.test' },
      { directory: '../escape', name: 'bad' },
      { directory: 'Profile 2', name: 'Second' },
    ]; },
    async readSqlite(directory, limits) {
      state.calls.push(['sqlite', directory, limits]);
      return { version: state.version, rows: state.rows, totalRows: state.rows.length, scopeBindings: state.scopeBindings };
    },
    async getKeychainPassword() { state.calls.push('keychain'); return PASSWORD; },
    getIdentityIds() { return [...state.identities]; },
    getIdentity(id) { return state.identityRecords.get(id) ?? null; },
    identityInUse(id) { return state.inUse.has(id); },
    watchIdentity(id, callback) {
      const watchers = state.watchers.get(id) || new Set(); watchers.add(callback); state.watchers.set(id, watchers);
      return () => watchers.delete(callback);
    },
    getCookieCapacity() { return { current: state.baseCount + [...state.jars.values()].reduce((n, jar) => n + jar.length, 0),
      max: state.maxCookies }; },
    createIdentity(name) {
      const id = state.next++; state.identities.push(id); state.calls.push(['create', id]);
      const identity = { userContextId: id, name, icon: 'fingerprint', color: 'blue', public: true };
      state.identityRecords.set(id, identity); return { ...identity };
    },
    removeIdentity(id) {
      state.calls.push(['remove', id]);
      const index = state.identities.indexOf(id);
      if (index < 0) return false;
      state.invalidate(id); state.identityRecords.delete(id); state.identities.splice(index, 1); return true;
    },
    cookies: {
      add(cookie, attrs) {
        state.calls.push(['add', attrs.userContextId]);
        const jar = state.jars.get(attrs.userContextId) || [];
        jar.push({ ...cookie, isPartitioned: false, originAttributes: { ...attrs } });
        state.jars.set(attrs.userContextId, jar); return true;
      },
      list(attrs) { return (state.jars.get(attrs.userContextId) || []).map(cookie => ({ ...cookie })); },
      removeAll(attrs) { state.calls.push(['wipe', attrs.userContextId]); state.jars.delete(attrs.userContextId); },
    },
  };
  return { state, adapter, importer: createBrowserCookieImporter({ profileImportPolicy: 'allow',
    privateBrowsingId: 0, adapter }) };
}

async function selected(importer) {
  const result = await importer.listProfiles({ explicitUserRequest: true });
  assert.equal(result.supported, true);
  assert.equal(result.profiles.length, 2);
  assert.notEqual(result.profiles[0].id, 'Default');
  return result.profiles[0].id;
}

test('requires explicit policy, non-private context, user request, consent and enumerated opaque id', async () => {
  const f = fixture([row()]);
  assert.deepEqual(f.importer.availability(), { supported: true, scopeModes: ['preserve', 'standard-web'] });
  assert.equal((await f.importer.listProfiles()).reason, 'explicit-user-request-required');
  assert.deepEqual(f.state.calls, []);
  assert.equal((await f.importer.importProfile({ profileId: 'Default', explicitUserConsent: true })).reason, 'profile-not-enumerated');
  const id = await selected(f.importer);
  assert.equal((await f.importer.importProfile({ profileId: id })).reason, 'explicit-user-consent-required');
  assert.equal(f.state.calls.includes('keychain'), false);
  for (const options of [
    { profileImportPolicy: 'deny', privateBrowsingId: 0 },
    { profileImportPolicy: 'allow', privateBrowsingId: 1 },
    { profileImportPolicy: 'allow' },
  ]) {
    const blocked = createBrowserCookieImporter({ ...options, adapter: f.adapter });
    assert.equal(blocked.availability().supported, false);
    assert.equal((await blocked.listProfiles({ explicitUserRequest: true })).supported, false);
  }
  f.state.allowed = 'policy-denied';
  assert.equal(f.importer.availability().reason, 'policy-denied');
  f.adapter.platform = 'win';
  assert.equal(f.importer.availability().reason, 'platform-unsupported');
});

test('v24 decrypts binary host hash, preserves flags, host, session and exact millisecond expiry', async () => {
  const host = '.example.test';
  const encrypted = await ciphertext(host, 'synthetic-encrypted-secret');
  const f = fixture([
    row({ name: 'enc', value: '', encrypted_value: encrypted, samesite: -1 }),
    row({ host_key: 'host.example.test', name: 'host-only', is_secure: 0, is_httponly: 0,
      source_scheme: 0, source_port: -1, has_expires: 0, is_persistent: 0, samesite: 3 }),
    row({ name: 'session-expiry', has_expires: 1, is_persistent: 0 }),
  ]);
  const id = await selected(f.importer);
  const result = await f.importer.importProfile({ profileId: id, explicitUserConsent: true });
  assert.deepEqual(result.counts, { imported: 3, skipped: 0, unsupported: 0, failed: 0 });
  assert.equal(result.status, 'imported');
  assert.equal(result.userContextId, 80);
  assert.equal(result.containerName, 'Chrome - Synthetic Profile');
  assert.equal(JSON.stringify(result).includes('synthetic-encrypted-secret'), false);
  assert.equal(JSON.stringify(result).includes('example.test'), false);
  const jar = f.state.jars.get(80);
  assert.equal(jar[0].host, host);
  assert.equal(jar[0].value, 'synthetic-encrypted-secret');
  assert.equal(jar[0].expiry, NOW + 86400000);
  assert.equal(jar[0].sameSite, 1);
  assert.equal(jar[1].host, 'host.example.test');
  assert.equal(jar[1].isSession, true);
  assert.equal(jar[1].expiry, Number.MAX_SAFE_INTEGER);
  assert.equal(jar[1].sameSite, 1);
  assert.equal(jar[2].isSession, true);
  assert.equal(jar[2].expiry, NOW + 86400000);
  assert.deepEqual(jar[0].originAttributes, { userContextId: 80, privateBrowsingId: 0 });
  assert.equal(f.state.calls.filter(call => call === 'keychain').length, 1);
  const sql = f.state.calls.find(call => Array.isArray(call) && call[0] === 'sqlite');
  assert.deepEqual(sql.slice(1), ['Default', { maxRows: 20000, maxBytes: 33554432 }]);
});

test('v23 plaintext bytes have no v24 prefix; wrong host hash and malformed crypto never create a secret', async () => {
  const encrypted23 = await ciphertext('.example.test', 'v23 synthetic secret', 23);
  const f = fixture([row({ value: '', encrypted_value: encrypted23 })], 23);
  const id = await selected(f.importer);
  assert.equal((await f.importer.importProfile({ profileId: id, explicitUserConsent: true })).status, 'imported');
  assert.equal(f.state.jars.get(80)[0].value, 'v23 synthetic secret');

  const wrongHost = await ciphertext('.other.test', 'synthetic secret');
  const bad = fixture([row({ value: '', encrypted_value: wrongHost })]);
  const badId = await selected(bad.importer);
  const result = await bad.importer.importProfile({ profileId: badId, explicitUserConsent: true });
  assert.equal(result.status, 'failed');
  assert.equal(result.counts.failed, 1);
  assert.deepEqual(bad.state.identities, [7]);
});

test('partition, unrepresentable scopes, unknown encryption and duplicates fail closed and count', async () => {
  const f = fixture([
    row({ name: 'ok' }),
    row({ name: 'partition', top_frame_site_key: 'https://partition.example.test' }),
    row({ name: 'ancestor', has_cross_site_ancestor: 2 }),
    row({ host_key: 'host.example.test', name: 'port-bound', source_port: 443 }),
    row({ name: 'scheme-bound', is_secure: 0, source_scheme: 2 }),
    row({ name: 'nonsecure-scheme', source_scheme: 1 }),
    row({ name: 'unknown', value: '', encrypted_value: Uint8Array.from([0x76, 0x32, 0x30, ...new Array(16).fill(1)]) }),
    row({ name: 'duplicate', source_port: 443 }), row({ name: 'duplicate', source_port: 80 }),
    row({ name: 'expired', expires_utc: future(NOW - 1) }),
  ]);
  const id = await selected(f.importer);
  const result = await f.importer.importProfile({ profileId: id, explicitUserConsent: true });
  assert.equal(result.status, 'partial');
  assert.deepEqual(result.counts, { imported: 1, skipped: 1, unsupported: 8, failed: 0 });
  assert.equal(f.state.jars.get(80).length, 1);
  assert.equal(f.state.calls.includes('keychain'), false);
});

test('unsupported schemas, oversized results and no importable data never create a container', async () => {
  for (const [rows, version, reason] of [
    [[row()], 25, 'unsupported-schema'],
    [[row({ top_frame_site_key: 'https://partition.example.test' })], 24, 'no-importable-cookies'],
    [Array.from({ length: 20001 }, () => row()), 24, 'resource-limit'],
  ]) {
    const f = fixture(rows, version), id = await selected(f.importer);
    const result = await f.importer.importProfile({ profileId: id, explicitUserConsent: true });
    assert.equal(result.status, 'failed');
    assert.equal(result.reason, reason);
    assert.deepEqual(f.state.identities, [7]);
  }
  const empty = fixture([]), id = await selected(empty.importer);
  assert.equal((await empty.importer.importProfile({ profileId: id, explicitUserConsent: true })).status, 'empty');
  assert.deepEqual(empty.state.identities, [7]);
});

test('standard-web scope compatibility requires explicit consent and keeps partitioning intact', async () => {
  const rows = [
    row({ host_key: 'host.example.test', name: '__Host-test', source_port: 443 }),
    row({ name: 'http', is_secure: 0, source_scheme: 1 }),
    row({ name: 'https-source', is_secure: 0, source_scheme: 2 }),
    row({ name: 'no-partition-0', has_cross_site_ancestor: 0 }),
    row({ name: 'partition', top_frame_site_key: 'https://partition.example.test' }),
  ];
  const f = fixture(rows), id = await selected(f.importer);
  const denied = await f.importer.importProfile({ profileId: id, explicitUserConsent: true, scopeMode: 'standard-web' });
  assert.equal(denied.reason, 'scope-compatibility-consent-required');
  assert.equal(f.state.calls.some(call => Array.isArray(call) && call[0] === 'sqlite'), false);
  assert.equal((await f.importer.importProfile({ profileId: id, explicitUserConsent: true, scopeMode: 'unexpected' })).reason,
    'scope-mode-unsupported');
  const compatible = await f.importer.importProfile({ profileId: id, explicitUserConsent: true,
    scopeMode: 'standard-web', explicitScopeCompatibilityConsent: true });
  assert.equal(compatible.status, 'partial');
  assert.deepEqual(compatible.counts, { imported: 4, skipped: 0, unsupported: 1, failed: 0 });
  const jar = f.state.jars.get(80);
  assert.equal(jar[0].host, 'host.example.test');
  assert.equal(jar[0].isSecure, true);
  assert.equal(jar[1].schemeMap, 1);
  assert.equal(jar[2].schemeMap, 2);
  assert.ok(jar.every(cookie => cookie.isPartitioned === false));

  const g = fixture(rows), otherId = await selected(g.importer);
  g.state.scopeBindings = { port: true, scheme: true };
  const bound = await g.importer.importProfile({ profileId: otherId, explicitUserConsent: true,
    scopeMode: 'standard-web', explicitScopeCompatibilityConsent: true });
  assert.deepEqual(bound.counts, { imported: 1, skipped: 0, unsupported: 4, failed: 0 });
});

test('quota is checked before container creation and immediately before every add', async () => {
  const f = fixture([row({ name: 'first' }), row({ name: 'second' })]);
  const id = await selected(f.importer);
  f.state.baseCount = 2999;
  const preflight = await f.importer.importProfile({ profileId: id, explicitUserConsent: true });
  assert.equal(preflight.reason, 'cookie-capacity-exceeded');
  assert.deepEqual(f.state.identities, [7]);

  f.state.baseCount = 0;
  const add = f.adapter.cookies.add;
  f.adapter.cookies.add = (cookie, attrs) => {
    const result = add(cookie, attrs); f.state.baseCount = 3000; return result;
  };
  const changed = await f.importer.importProfile({ profileId: id, explicitUserConsent: true });
  assert.equal(changed.reason, 'cookie-capacity-exceeded');
  assert.deepEqual(f.state.identities, [7]);
  assert.equal(f.state.jars.has(80), false);
  assert.equal(f.state.calls.filter(call => Array.isArray(call) && call[0] === 'add').length, 1);
});

test('Keychain failures are distinguished when known, and errors never escape', async () => {
  const encrypted = await ciphertext('.example.test', 'synthetic secret');
  for (const [thrown, expected] of [
    [{ code: 'permission-denied', message: 'synthetic secret' }, 'keychain-permission-denied'],
    [new Error('synthetic secret'), 'keychain-unavailable-or-denied'],
  ]) {
    const f = fixture([row({ value: '', encrypted_value: encrypted })]);
    f.adapter.getKeychainPassword = () => { throw thrown; };
    const id = await selected(f.importer);
    const result = await f.importer.importProfile({ profileId: id, explicitUserConsent: true });
    assert.equal(result.reason, expected);
    assert.equal(JSON.stringify(result).includes('synthetic secret'), false);
    assert.deepEqual(f.state.identities, [7]);
  }
});

test('failed imports clean only unchanged, unused newly owned containers', async () => {
  for (const kind of ['add', 'readback', 'revoked', 'abort']) {
    const f = fixture([row(), row({ name: 'second' })]);
    const id = await selected(f.importer), controller = new AbortController();
    const add = f.adapter.cookies.add, list = f.adapter.cookies.list;
    f.adapter.cookies.add = (cookie, attrs) => {
      const result = add(cookie, attrs);
      if (kind === 'add') throw new Error('synthetic-secret');
      if (kind === 'revoked') f.state.allowed = 'policy-denied';
      if (kind === 'abort') controller.abort();
      return result;
    };
    if (kind === 'readback') f.adapter.cookies.list = attrs => {
      const result = list(attrs);
      return result.length ? [{ ...result[0], value: 'mismatch' }] : result;
    };
    const result = await f.importer.importProfile({ profileId: id, explicitUserConsent: true, signal: controller.signal });
    assert.equal(result.status, kind === 'abort' ? 'cancelled' : 'failed');
    assert.equal(result.counts.imported, 0);
    if (kind === 'readback') {
      assert.equal(result.reason, 'cleanup-incomplete');
      assert.deepEqual(f.state.identities, [7, 80]);
      assert.equal(f.state.jars.get(80).length, 2);
      assert.equal(f.state.calls.some(call => Array.isArray(call) && ['wipe', 'remove'].includes(call[0])), false);
    } else {
      assert.deepEqual(f.state.identities, [7]);
      assert.equal(f.state.jars.has(80), false);
      assert.ok(f.state.calls.some(call => Array.isArray(call) && call[0] === 'wipe' && call[1] === 80));
      assert.ok(f.state.calls.some(call => Array.isArray(call) && call[0] === 'remove' && call[1] === 80));
    }
    assert.equal(JSON.stringify(result).includes('synthetic-secret'), false);
  }
});

test('rollback stops after a wipe observer invalidates, adopts or changes the container', async () => {
  for (const kind of ['invalidated', 'renamed', 'adopted', 'new-cookie', 'same-cookie-readded', 'changed-cookie', 'new-scope']) {
    const f = fixture([row()]), id = await selected(f.importer);
    const add = f.adapter.cookies.add, wipe = f.adapter.cookies.removeAll;
    f.adapter.cookies.add = (cookie, attrs) => { add(cookie, attrs); throw new Error('private synthetic error'); };
    f.adapter.cookies.removeAll = attrs => {
      if (kind === 'new-cookie' || kind === 'same-cookie-readded') {
        const original = f.state.jars.get(80)[0];
        wipe(attrs);
        f.state.jars.set(80, [kind === 'new-cookie' ?
          { ...original, name: 'observer-cookie', value: 'observer-secret' } : { ...original }]);
        return;
      }
      f.state.calls.push(['wipe', attrs.userContextId]);
      if (kind === 'invalidated') f.state.invalidate(80);
      if (kind === 'renamed') f.state.identityRecords.get(80).name = 'Adopted';
      if (kind === 'adopted') f.state.inUse.add(80);
      if (kind === 'changed-cookie') f.state.jars.get(80)[0].value = 'observer-secret';
      if (kind === 'new-scope') f.state.jars.get(80)[0].originAttributes.firstPartyDomain = 'observer.test';
      return;
    };
    const result = await f.importer.importProfile({ profileId: id, explicitUserConsent: true });
    assert.equal(result.status, 'failed', kind);
    assert.equal(result.reason, 'cleanup-incomplete', kind);
    assert.equal(result.userContextId, 80, kind);
    assert.deepEqual(f.state.identities, [7, 80], kind);
    assert.equal(f.state.jars.get(80).length, 1, kind);
    assert.equal(f.state.calls.filter(call => Array.isArray(call) && call[0] === 'wipe').length, 1, kind);
    assert.equal(f.state.calls.some(call => Array.isArray(call) && call[0] === 'remove'), false, kind);
    assert.equal(JSON.stringify(result).includes('secret'), false, kind);
  }
});

test('rollback checks use before first wipe and again after the final cookie read', async () => {
  for (const phase of ['before-wipe', 'after-wipe']) {
    const f = fixture([row()]), id = await selected(f.importer);
    const add = f.adapter.cookies.add, list = f.adapter.cookies.list;
    f.adapter.cookies.add = (cookie, attrs) => {
      add(cookie, attrs);
      if (phase === 'before-wipe') f.state.inUse.add(80);
      throw new Error('synthetic error');
    };
    if (phase === 'after-wipe') {
      let reads = 0;
      f.adapter.cookies.list = attrs => {
        const result = list(attrs);
        if (++reads === 3) f.state.inUse.add(80);
        return result;
      };
    }
    const result = await f.importer.importProfile({ profileId: id, explicitUserConsent: true });
    assert.equal(result.reason, 'cleanup-incomplete', phase);
    assert.equal(result.userContextId, 80, phase);
    assert.equal(f.state.identities.includes(80), true, phase);
    assert.equal(f.state.calls.some(call => Array.isArray(call) && call[0] === 'remove'), false, phase);
    assert.equal(f.state.calls.filter(call => Array.isArray(call) && call[0] === 'wipe').length,
      phase === 'before-wipe' ? 0 : 1, phase);
  }
});

test('rollback never retries a failed wipe even if ownership, use and contents appear unchanged', async () => {
  const f = fixture([row()]), id = await selected(f.importer);
  const add = f.adapter.cookies.add, wipe = f.adapter.cookies.removeAll;
  f.adapter.cookies.add = (cookie, attrs) => { add(cookie, attrs); throw new Error('synthetic error'); };
  let attempts = 0;
  f.adapter.cookies.removeAll = attrs => {
    if (++attempts === 1) { f.state.calls.push(['wipe', attrs.userContextId]); throw new Error('synthetic error'); }
    return wipe(attrs);
  };
  const result = await f.importer.importProfile({ profileId: id, explicitUserConsent: true });
  assert.equal(result.status, 'failed');
  assert.equal(result.reason, 'cleanup-incomplete');
  assert.equal(result.userContextId, 80);
  assert.equal(attempts, 1);
  assert.deepEqual(f.state.identities, [7, 80]);
  assert.equal(f.state.jars.get(80).length, 1);
  assert.equal(f.state.calls.some(call => Array.isArray(call) && call[0] === 'remove'), false);
});

test('unconfirmed cleanup retains the owned identity and reports its id without secrets', async () => {
  const f = fixture([row()]), id = await selected(f.importer), add = f.adapter.cookies.add;
  f.adapter.cookies.add = (cookie, attrs) => { add(cookie, attrs); throw new Error('secret'); };
  f.adapter.cookies.removeAll = () => { throw new Error('secret'); };
  const result = await f.importer.importProfile({ profileId: id, explicitUserConsent: true });
  assert.equal(result.status, 'failed');
  assert.equal(result.reason, 'cleanup-incomplete');
  assert.equal(result.userContextId, 80);
  assert.deepEqual(f.state.identities, [7, 80]);
  assert.equal(f.state.jars.get(80).length, 1);
  assert.equal(JSON.stringify(result).includes('synthetic-value'), false);
  assert.equal(f.state.calls.some(call => Array.isArray(call) && call[0] === 'remove'), false);
});

test('never clears preexisting data on unexpected nonempty container', async () => {
  const f = fixture([row()]), id = await selected(f.importer);
  f.state.jars.set(80, [{ value: 'preexisting' }]);
  const result = await f.importer.importProfile({ profileId: id, explicitUserConsent: true });
  assert.equal(result.reason, 'container-not-empty');
  assert.equal(result.userContextId, 80);
  assert.equal(f.state.jars.get(80)[0].value, 'preexisting');
  assert.equal(f.state.calls.some(call => Array.isArray(call) && ['wipe', 'remove'].includes(call[0])), false);
});

test('discard rejects arbitrary, preexisting and other-instance ids; owned success is idempotent', async () => {
  const f = fixture([row()]), id = await selected(f.importer);
  assert.deepEqual(await f.importer.discardImport(null), { status: 'not-owned' });
  assert.deepEqual(await f.importer.discardImport({ userContextId: 7 }), { status: 'not-owned' });
  assert.deepEqual(await f.importer.discardImport({ userContextId: 999 }), { status: 'not-owned' });
  const imported = await f.importer.importProfile({ profileId: id, explicitUserConsent: true });
  assert.equal(imported.status, 'imported');
  const another = createBrowserCookieImporter({ profileImportPolicy: 'allow', privateBrowsingId: 0, adapter: f.adapter });
  assert.deepEqual(await another.discardImport({ userContextId: imported.userContextId }), { status: 'not-owned' });
  assert.deepEqual(await f.importer.discardImport({ userContextId: imported.userContextId }), { status: 'discarded' });
  assert.deepEqual(f.state.identities, [7]);
  assert.equal(f.state.jars.has(80), false);
  const calls = f.state.calls.length;
  assert.deepEqual(await f.importer.discardImport({ userContextId: imported.userContextId }), { status: 'discarded' });
  assert.equal(f.state.calls.length, calls);
});

test('discard refuses changed cookies, identity mutation, recreation and known use', async () => {
  for (const mode of ['cookie', 'identity', 'recreated', 'used', 'unknown-use']) {
    const f = fixture([row()]), id = await selected(f.importer);
    const imported = await f.importer.importProfile({ profileId: id, explicitUserConsent: true });
    assert.equal(imported.status, 'imported');
    if (mode === 'cookie') f.state.jars.get(80)[0].value = 'changed synthetic value';
    if (mode === 'identity') f.state.identityRecords.get(80).name = 'Changed';
    if (mode === 'recreated') f.state.invalidate(80); // even if same ID/name is later presented
    if (mode === 'used') f.state.inUse.add(80);
    if (mode === 'unknown-use') f.adapter.identityInUse = () => null;
    const before = f.state.calls.length;
    const result = await f.importer.discardImport({ userContextId: 80 });
    assert.equal(result.status, 'cleanup-required');
    assert.equal(result.reason, mode === 'cookie' ? 'import-changed' :
      ['used', 'unknown-use'].includes(mode) ? 'identity-in-use-or-unverified' : 'ownership-unverified');
    assert.equal(f.state.jars.has(80), true);
    assert.equal(f.state.identities.includes(80), true);
    assert.equal(f.state.calls.slice(before).some(call => Array.isArray(call) && ['wipe', 'remove'].includes(call[0])), false);
    assert.equal(JSON.stringify(result).includes('synthetic'), false);
    if (mode === 'used') {
      f.state.inUse.delete(80);
      assert.equal((await f.importer.discardImport({ userContextId: 80 })).status, 'cleanup-required');
    }
  }
});

test('discard does not delete a cookie changed while the commitment is being checked', async () => {
  const f = fixture([row()]), id = await selected(f.importer);
  let mutate = false;
  f.adapter.crypto = {
    getRandomValues: bytes => webcrypto.getRandomValues(bytes),
    subtle: { importKey: webcrypto.subtle.importKey.bind(webcrypto.subtle),
      deriveKey: webcrypto.subtle.deriveKey.bind(webcrypto.subtle), decrypt: webcrypto.subtle.decrypt.bind(webcrypto.subtle),
      async digest(...args) {
        const digest = await webcrypto.subtle.digest(...args);
        if (mutate) f.state.jars.get(80)[0].value = 'changed synthetic value';
        return digest;
      } },
  };
  await f.importer.importProfile({ profileId: id, explicitUserConsent: true });
  mutate = true;
  const result = await f.importer.discardImport({ userContextId: 80 });
  assert.deepEqual(result, { status: 'cleanup-required', reason: 'import-changed' });
  assert.equal(f.state.jars.has(80), true);
  assert.equal(f.state.identities.includes(80), true);
});

test('discard cleanup failure remains visible and never removes an unconfirmed container', async () => {
  const f = fixture([row()]), id = await selected(f.importer);
  await f.importer.importProfile({ profileId: id, explicitUserConsent: true });
  f.adapter.cookies.removeAll = () => { throw new Error('synthetic secret'); };
  const result = await f.importer.discardImport({ userContextId: 80 });
  assert.deepEqual(result, { status: 'cleanup-required', reason: 'cleanup-unconfirmed' });
  assert.equal(f.state.jars.has(80), true);
  assert.equal(f.state.identities.includes(80), true);
  assert.equal(f.state.calls.some(call => Array.isArray(call) && call[0] === 'remove'), false);
  assert.equal(JSON.stringify(result).includes('synthetic secret'), false);
});

test('identity invalidated during import stops further writes and reports manual cleanup', async () => {
  const f = fixture([row({ name: 'one' }), row({ name: 'two' })]), id = await selected(f.importer);
  const add = f.adapter.cookies.add;
  f.adapter.cookies.add = (cookie, attrs) => { const result = add(cookie, attrs); f.state.invalidate(80); return result; };
  const result = await f.importer.importProfile({ profileId: id, explicitUserConsent: true });
  assert.equal(result.status, 'failed');
  assert.equal(result.reason, 'cleanup-incomplete');
  assert.equal(result.userContextId, 80);
  assert.equal(f.state.jars.get(80).length, 1);
  assert.equal(f.state.calls.filter(call => Array.isArray(call) && call[0] === 'add').length, 1);
  assert.equal(f.state.calls.some(call => Array.isArray(call) && ['wipe', 'remove'].includes(call[0])), false);
});

test('permission errors and cancellation during a pending source read do not create containers', async () => {
  const f = fixture([row()]), id = await selected(f.importer);
  f.adapter.readSqlite = () => { throw { code: 'permission-denied', message: 'secret' }; };
  const denied = await f.importer.importProfile({ profileId: id, explicitUserConsent: true });
  assert.equal(denied.reason, 'permission-denied');
  assert.equal(JSON.stringify(denied).includes('secret'), false);
  let finish;
  f.adapter.readSqlite = () => new Promise(resolve => { finish = resolve; });
  const controller = new AbortController();
  const pending = f.importer.importProfile({ profileId: id, explicitUserConsent: true, signal: controller.signal });
  controller.abort();
  finish({ version: 24, rows: [row()], totalRows: 1 });
  assert.equal((await pending).status, 'cancelled');
  assert.deepEqual(f.state.identities, [7]);
});

// Fake Gecko globals exercise the production adapter's path, policy, Sqlite,
// Keychain, cookie and identity glue. Every path/data item below is synthetic.
function fakeGecko({ platform = 'macosx', geckoVersion = '158.0.1', failedImports = [], noLoader = false,
  missingCookieValidation = false, timerDelay } = {}) {
  const base = '/Users/synthetic/Library/Application Support/Google/Chrome';
  const state = { files: new Map(), opened: [], closed: 0, transactionTypes: [], keychainCalls: 0,
    identities: [7], jars: new Map(), policy: true, logging: false, envLogging: false,
    sqlFailure: false, pauseSql: false, pendingSqlReject: null, interruptions: 0, nativeMax: 3000,
    expiryRejected: false, nativeIdentityRecords: new Map(), observers: new Map(),
    windows: [], nativeTabIds: new Set(),
    rows: [row()], version: 24, imports: [] };
  for (const path of ['/Users/synthetic', '/Users/synthetic/Library',
    '/Users/synthetic/Library/Application Support', '/Users/synthetic/Library/Application Support/Google',
    base, `${base}/Default`]) state.files.set(path, { type: 'directory' });
  const stateText = JSON.stringify({ profile: { info_cache: { Default: { name: 'Synthetic Profile' } } } });
  state.files.set(`${base}/Local State`, { type: 'file', bytes: encoder.encode(stateText) });
  const dbHeader = new Uint8Array(50);
  dbHeader.set(encoder.encode('SQLite format 3\u0000')); dbHeader[18] = dbHeader[19] = 1;
  state.files.set(`${base}/Default/Cookies`, { type: 'file', bytes: dbHeader });
  class FakeFile {
    constructor(path) { this.path = path; }
    clone() { return new FakeFile(this.path); }
    append(leaf) { this.path += `/${leaf}`; }
    normalize() { if (state.files.get(this.path)?.resolvedPath) this.path = state.files.get(this.path).resolvedPath; }
    exists() { return state.files.has(this.path); }
    isSymlink() { return state.files.get(this.path)?.type === 'symlink'; }
    isDirectory() { return state.files.get(this.path)?.type === 'directory'; }
    isFile() { return state.files.get(this.path)?.type === 'file'; }
    isReadable() { return state.files.get(this.path)?.readable !== false; }
    get fileSize() { return state.files.get(this.path)?.bytes?.length || 0; }
  }
  const asRow = data => ({ getResultByName: name => data[name] });
  const columns = ['creation_utc', 'host_key', 'top_frame_site_key', 'name', 'value', 'encrypted_value',
    'path', 'expires_utc', 'is_secure', 'is_httponly', 'last_access_utc', 'has_expires', 'is_persistent',
    'priority', 'samesite', 'source_scheme', 'source_port', 'last_update_utc', 'source_type', 'has_cross_site_ancestor'];
  const sqlite = {
    async openConnection(options) {
      state.opened.push(options);
      return {
        TRANSACTION_DEFERRED: 'DEFERRED',
        async executeTransaction(callback, type) { state.transactionTypes.push(type); return callback(this); },
        interrupt() { state.interruptions++; state.pendingSqlReject?.(new Error('synthetic interrupted')); },
        async execute(sql) {
          if (state.sqlFailure && sql.startsWith('PRAGMA table_xinfo')) throw new Error('synthetic-secret');
          if (state.pauseSql && sql.startsWith('PRAGMA table_xinfo')) {
            return new Promise((_resolve, reject) => { state.pendingSqlReject = reject; });
          }
          if (sql.startsWith('SELECT name FROM sqlite_master')) return [asRow({ name: 'meta' }), asRow({ name: 'cookies' })];
          if (sql.startsWith('SELECT COUNT(*)')) return [asRow({ n: state.rows.length })];
          if (sql.startsWith('SELECT CAST(value')) return [asRow({ v: String(state.version) })];
          if (sql.startsWith('PRAGMA table_xinfo')) return columns.map(name => asRow({ name,
            type: name === 'encrypted_value' ? 'BLOB' : ['host_key', 'top_frame_site_key', 'name', 'value', 'path'].includes(name) ? 'TEXT' : 'INTEGER',
            notnull: 1, hidden: 0 }));
          if (sql.startsWith('SELECT CAST(COALESCE')) return [asRow({ n: '1000' })];
          if (sql.startsWith('SELECT ') && sql.endsWith(' FROM cookies')) return state.rows.map(asRow);
          throw new Error('unexpected query');
        },
        async close() { state.closed++; },
      };
    },
  };
  state.nativeIdentityRecords.set(7, { userContextId: 7, name: 'Existing', icon: 'fingerprint', color: 'blue', public: true });
  const identities = {
    getPublicIdentities: () => state.identities.map(userContextId => state.nativeIdentityRecords.get(userContextId)),
    getPublicIdentityFromId: id => state.nativeIdentityRecords.get(id),
    countContainerTabs: id => state.nativeTabIds.has(id) ? 1 : 0,
    create: name => { const identity = { userContextId: 80, name, icon: 'fingerprint', color: 'blue', public: true };
      state.identities.push(80); state.nativeIdentityRecords.set(80, identity); return { ...identity }; },
    remove: id => { state.nativeIdentityRecords.delete(id); state.identities = state.identities.filter(n => n !== id); return true; },
  };
  const services = {
    dirsvc: { get: () => new FakeFile('/Users/synthetic') },
    appinfo: { platformVersion: geckoVersion },
    obs: {
      addObserver(observer, topic) { const set = state.observers.get(topic) || new Set(); set.add(observer); state.observers.set(topic, set); },
      removeObserver(observer, topic) { state.observers.get(topic)?.delete(observer); },
    },
    wm: { getEnumerator: () => state.windows },
    policies: { isAllowed: feature => feature === 'profileImport' && state.policy },
    env: { get: () => state.envLogging ? 'cookie:5' : '' },
    prefs: { getBoolPref: () => true, getIntPref: () => state.nativeMax,
      getChildList: () => state.logging ? ['logging.cookie'] : [] },
    cookies: {
      get cookies() { return [...state.jars.values()].flat(); },
      add(host, path, name, value, isSecure, isHttpOnly, isSession, expiry, attrs, sameSite, schemeMap, isPartitioned) {
        if (state.expiryRejected) return { result: 42 };
        const jar = state.jars.get(attrs.userContextId) || [];
        jar.push({ host, path, name, value, isSecure, isHttpOnly, isSession, expiry, sameSite,
          schemeMap, isPartitioned, originAttributes: { ...attrs } });
        state.jars.set(attrs.userContextId, jar); return { result: 0 };
      },
      getCookiesWithOriginAttributes: pattern => state.jars.get(JSON.parse(pattern).userContextId) || [],
      removeCookiesWithOriginAttributes: pattern => state.jars.delete(JSON.parse(pattern).userContextId),
    },
  };
  const globals = {
    crypto: webcrypto, Services: services, Ci: { nsIFile: {},
      nsICookieValidation: missingCookieValidation ? undefined : { eOK: 0, eRejectedAttributeExpiryOversize: 42 }, nsIKeychainMigrationUtils: {} },
    Cc: { '@mozilla.org/profile/migrator/keychainmigrationutils;1': { getService: () => ({
      getGenericPassword(service, account) {
        assert.equal(service, 'Chrome Safe Storage'); assert.equal(account, 'Chrome'); state.keychainCalls++; return PASSWORD;
      },
    }) } },
    IOUtils: { async read(path, { maxBytes }) { return state.files.get(path).bytes.slice(0, maxBytes); } },
    ChromeUtils: noLoader ? {} : { importESModule(url) {
      state.imports.push(url);
      if (failedImports.includes(url)) throw new Error('synthetic-sensitive-error');
      if (url === 'resource://gre/modules/AppConstants.sys.mjs') return { AppConstants: { platform } };
      if (url === 'resource://gre/modules/PrivateBrowsingUtils.sys.mjs') return { PrivateBrowsingUtils: { isWindowPrivate: win => win.isPrivate } };
      if (url === 'moz-src:///toolkit/components/contextualidentity/ContextualIdentityService.sys.mjs') {
        return { ContextualIdentityService: identities };
      }
      if (url === 'resource://gre/modules/ContextualIdentityService.sys.mjs') return { ContextualIdentityService: identities };
      if (url === 'resource://gre/modules/Sqlite.sys.mjs') return { Sqlite: sqlite };
      if (url === 'resource://gre/modules/Timer.sys.mjs') return {
        setTimeout: (callback, delay) => setTimeout(callback, timerDelay ?? delay), clearTimeout,
      };
      throw new Error('unexpected import');
    } },
  };
  const descriptors = Object.fromEntries(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const restore = () => { for (const [key, descriptor] of Object.entries(descriptors)) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
  } };
  const browserWindow = { closed: false, isChromeWindow: true, isPrivate: false, docShell: {},
    document: { nodePrincipal: { isSystemPrincipal: true } } };
  const importer = createBrowserCookieImporter({ browserWindow, profileImportPolicy: 'allow', privateBrowsingId: 0 });
  return { state, importer, restore, browserWindow, base };
}

test('native adapter uses readonly locked deferred transaction, closes, prompts only after consent', async () => {
  const f = fakeGecko();
  try {
    f.state.rows = [row({ value: '', encrypted_value: await ciphertext('.example.test', 'only synthetic') })];
    const list = await f.importer.listProfiles({ explicitUserRequest: true });
    const id = list.profiles[0].id;
    assert.equal(f.state.keychainCalls, 0);
    const result = await f.importer.importProfile({ profileId: id, explicitUserConsent: true });
    assert.equal(result.status, 'imported');
    assert.equal(f.state.keychainCalls, 1);
    assert.deepEqual(f.state.opened, [{ path: `${f.base}/Default/Cookies`, readOnly: true, ignoreLockingMode: false,
      sharedMemoryCache: false, openNotExclusive: true }]);
    assert.deepEqual(f.state.transactionTypes, ['DEFERRED']);
    assert.equal(f.state.closed, 1);
    assert.equal(f.state.jars.get(80)[0].value, 'only synthetic');
    assert.ok(f.state.imports.includes('moz-src:///toolkit/components/contextualidentity/ContextualIdentityService.sys.mjs'));
    assert.equal(f.state.imports.includes('resource://gre/modules/ContextualIdentityService.sys.mjs'), false);
    assert.deepEqual(await f.importer.discardImport({ userContextId: 80 }), { status: 'discarded' });
    assert.deepEqual(f.state.identities, [7]);
    assert.equal(f.state.jars.has(80), false);
    assert.ok([...f.state.observers.values()].every(set => set.size === 0));
  } finally { f.restore(); }
});

test('native SameSite uses explicit Lax for unspecified and deprecated values in both scope modes', async () => {
  for (const mode of ['preserve', 'standard-web']) {
    const f = fakeGecko();
    try {
      f.state.rows = [-1, 3, 0, 1, 2].map(samesite => row({ name: `samesite-${samesite}`, samesite }));
      const id = (await f.importer.listProfiles({ explicitUserRequest: true })).profiles[0].id;
      const result = await f.importer.importProfile({ profileId: id, explicitUserConsent: true, scopeMode: mode,
        ...(mode === 'standard-web' ? { explicitScopeCompatibilityConsent: true } : {}) });
      assert.equal(result.status, 'imported');
      assert.deepEqual(f.state.jars.get(80).map(cookie => cookie.sameSite), [1, 1, 0, 1, 2]);
      assert.equal(f.state.jars.get(80).some(cookie => cookie.sameSite === 256), false);
    } finally { f.restore(); }
  }
});

test('native cleanup refuses visible native use and observed context or identity adoption', async () => {
  for (const mode of ['tab', 'embedded-browser', 'context-attached', 'identity-deleted']) {
    const f = fakeGecko();
    try {
      const id = (await f.importer.listProfiles({ explicitUserRequest: true })).profiles[0].id;
      assert.equal((await f.importer.importProfile({ profileId: id, explicitUserConsent: true })).status, 'imported');
      if (mode === 'tab') f.state.nativeTabIds.add(80);
      if (mode === 'embedded-browser') f.state.windows.push({ closed: false, document: {
        querySelectorAll: () => [{ browsingContext: { originAttributes: { userContextId: 80 } }, getAttribute: () => null }],
      } });
      if (mode === 'context-attached') {
        for (const observer of f.state.observers.get('browsing-context-attached')) {
          observer.observe({ QueryInterface: () => ({ originAttributes: { userContextId: 80 } }) }, 'browsing-context-attached');
        }
      }
      if (mode === 'identity-deleted') {
        for (const observer of f.state.observers.get('contextual-identity-deleted')) {
          observer.observe({ wrappedJSObject: { userContextId: 80 } }, 'contextual-identity-deleted');
        }
      }
      const result = await f.importer.discardImport({ userContextId: 80 });
      assert.equal(result.status, 'cleanup-required');
      assert.equal(f.state.identities.includes(80), true);
      assert.equal(f.state.jars.has(80), true);
    } finally { f.restore(); }
  }
});

test('native adapter uses the legacy identity URI only if the modern URI fails', () => {
  const modern = 'moz-src:///toolkit/components/contextualidentity/ContextualIdentityService.sys.mjs';
  const legacy = 'resource://gre/modules/ContextualIdentityService.sys.mjs';
  const f = fakeGecko({ failedImports: [modern] });
  try {
    assert.deepEqual(f.importer.availability(), { supported: true, scopeModes: ['preserve', 'standard-web'] });
    assert.ok(f.state.imports.indexOf(modern) < f.state.imports.indexOf(legacy));
  } finally { f.restore(); }
});

test('native failures and old Gecko are not misreported as an unsupported OS', () => {
  const modern = 'moz-src:///toolkit/components/contextualidentity/ContextualIdentityService.sys.mjs';
  const legacy = 'resource://gre/modules/ContextualIdentityService.sys.mjs';
  const cases = [
    [{ noLoader: true }, 'native-module-loader-unavailable'],
    [{ failedImports: ['resource://gre/modules/AppConstants.sys.mjs'] }, 'native-platform-unavailable'],
    [{ platform: 'win' }, 'platform-unsupported'],
    [{ geckoVersion: '141.0' }, 'gecko-version-unsupported'],
    [{ geckoVersion: 'unknown' }, 'native-version-unavailable'],
    [{ failedImports: ['resource://gre/modules/PrivateBrowsingUtils.sys.mjs'] }, 'native-private-browsing-unavailable'],
    [{ failedImports: [modern, legacy] }, 'native-contextual-identity-unavailable'],
    [{ failedImports: ['resource://gre/modules/Sqlite.sys.mjs'] }, 'native-sqlite-unavailable'],
    [{ missingCookieValidation: true }, 'native-cookie-api-unavailable'],
  ];
  for (const [options, reason] of cases) {
    const f = fakeGecko(options);
    try {
      const result = f.importer.availability();
      assert.deepEqual(result, { supported: false, reason });
      assert.equal(JSON.stringify(result).includes('synthetic-sensitive-error'), false);
      assert.equal(f.state.keychainCalls, 0);
      assert.equal(f.state.opened.length, 0);
    } finally { f.restore(); }
  }
});

test('native adapter rechecks enterprise policy, window privacy and rejects symlink paths', async () => {
  const f = fakeGecko();
  try {
    f.state.policy = false;
    assert.equal(f.importer.availability().reason, 'policy-denied');
    f.state.policy = true; f.browserWindow.isPrivate = true;
    assert.equal(f.importer.availability().reason, 'private-context-unverified');
    f.browserWindow.isPrivate = false;
    f.state.logging = true;
    assert.equal(f.importer.availability().reason, 'logging-enabled');
    f.state.logging = false; f.state.envLogging = true;
    assert.equal(f.importer.availability().reason, 'logging-enabled');
    f.state.envLogging = false;
    f.state.files.set(`${f.base}/Default`, { type: 'symlink' });
    const result = await f.importer.listProfiles({ explicitUserRequest: true });
    assert.equal(result.supported, false);
    assert.equal(result.reason, 'unsafe-path');
    assert.equal(f.state.opened.length, 0);
  } finally { f.restore(); }
});

test('native adapter recognizes explicit positive source binding flags but does not infer disabled state', async () => {
  const f = fakeGecko();
  try {
    const stateText = JSON.stringify({ browser: { enabled_labs_experiments: ['bind-cookies-to-port@1'] },
      profile: { info_cache: { Default: { name: 'Synthetic Profile' } } } });
    f.state.files.get(`${f.base}/Local State`).bytes = encoder.encode(stateText);
    f.state.rows = [row({ host_key: 'host.example.test', name: '__Host-test', source_port: 443 }),
      row({ name: 'normal-domain' })];
    const id = (await f.importer.listProfiles({ explicitUserRequest: true })).profiles[0].id;
    const result = await f.importer.importProfile({ profileId: id, explicitUserConsent: true,
      scopeMode: 'standard-web', explicitScopeCompatibilityConsent: true });
    assert.equal(result.status, 'partial');
    assert.deepEqual(result.counts, { imported: 1, skipped: 0, unsupported: 1, failed: 0 });
  } finally { f.restore(); }
});

test('native quota and expiry cap fail safely without removing existing cookies', async () => {
  for (const mode of ['capacity', 'future-version', 'expiry']) {
    const f = fakeGecko(mode === 'future-version' ? { geckoVersion: '159.0' } : {});
    try {
      f.state.jars.set(7, [{ value: 'unrelated synthetic cookie' }]);
      if (mode === 'capacity') f.state.nativeMax = 1;
      if (mode === 'expiry') f.state.expiryRejected = true;
      if (mode === 'future-version') {
        assert.deepEqual(f.importer.availability(), { supported: false, reason: 'cookie-capacity-unverified' });
        assert.equal((await f.importer.listProfiles({ explicitUserRequest: true })).supported, false);
        assert.equal(f.state.opened.length, 0);
        assert.equal(f.state.keychainCalls, 0);
        continue;
      }
      const id = (await f.importer.listProfiles({ explicitUserRequest: true })).profiles[0].id;
      const result = await f.importer.importProfile({ profileId: id, explicitUserConsent: true });
      assert.equal(result.status, 'failed');
      assert.equal(result.reason, mode === 'capacity' ? 'cookie-capacity-exceeded' :
        'cookie-expiry-cap-exceeded');
      assert.equal(f.state.jars.get(7)[0].value, 'unrelated synthetic cookie');
      assert.deepEqual(f.state.identities, [7]);
      assert.equal(JSON.stringify(result).includes('unrelated synthetic cookie'), false);
    } finally { f.restore(); }
  }
});

test('native adapter reads WAL with normal locks and rejects active rollback journal or symlink', async () => {
  for (const mode of ['header-wal', 'sidecar-wal', 'active-journal', 'sidecar-symlink']) {
    const f = fakeGecko();
    try {
      const id = (await f.importer.listProfiles({ explicitUserRequest: true })).profiles[0].id;
      if (mode === 'header-wal') {
        f.state.files.get(`${f.base}/Default/Cookies`).bytes[18] = 2;
        f.state.files.get(`${f.base}/Default/Cookies`).bytes[19] = 2;
      }
      if (mode === 'sidecar-wal') f.state.files.set(`${f.base}/Default/Cookies-wal`, { type: 'file', bytes: new Uint8Array() });
      if (mode === 'active-journal') f.state.files.set(`${f.base}/Default/Cookies-journal`, { type: 'file', bytes: new Uint8Array([1]) });
      if (mode === 'sidecar-symlink') f.state.files.set(`${f.base}/Default/Cookies-wal`, { type: 'symlink' });
      const result = await f.importer.importProfile({ profileId: id, explicitUserConsent: true });
      if (mode === 'header-wal' || mode === 'sidecar-wal') {
        assert.equal(result.status, 'imported');
        assert.equal(f.state.opened.length, 1);
        assert.equal(f.state.closed, 1);
        assert.deepEqual(f.state.transactionTypes, ['DEFERRED']);
      } else {
        assert.equal(result.status, 'failed');
        assert.equal(result.reason, mode === 'active-journal' ? 'source-busy' : 'unsafe-path');
        assert.equal(f.state.opened.length, 0);
        assert.deepEqual(f.state.identities, [7]);
      }
      assert.equal(f.state.keychainCalls, 0);
    } finally { f.restore(); }
  }
});

test('native adapter closes a failed transaction without exposing its error', async () => {
  const f = fakeGecko();
  try {
    const id = (await f.importer.listProfiles({ explicitUserRequest: true })).profiles[0].id;
    f.state.sqlFailure = true;
    const result = await f.importer.importProfile({ profileId: id, explicitUserConsent: true });
    assert.equal(result.status, 'failed');
    assert.equal(f.state.closed, 1);
    assert.equal(JSON.stringify(result).includes('synthetic-secret'), false);
    assert.deepEqual(f.state.identities, [7]);
  } finally { f.restore(); }
});

test('native pending queries are interrupted on cancellation or time limit and connection closes', async () => {
  for (const timed of [false, true]) {
    const f = fakeGecko(timed ? { timerDelay: 20 } : {});
    try {
      const id = (await f.importer.listProfiles({ explicitUserRequest: true })).profiles[0].id;
      f.state.pauseSql = true;
      const controller = new AbortController();
      const pending = f.importer.importProfile({ profileId: id, explicitUserConsent: true, signal: controller.signal });
      while (!f.state.pendingSqlReject) await new Promise(resolve => setImmediate(resolve));
      if (!timed) controller.abort();
      const result = await pending;
      assert.equal(result.status, timed ? 'failed' : 'cancelled');
      if (timed) assert.equal(result.reason, 'source-timeout');
      assert.equal(f.state.interruptions, 1);
      assert.equal(f.state.closed, 1);
      assert.deepEqual(f.state.identities, [7]);
    } finally { f.restore(); }
  }
});
