import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { bootstrapQaProfile, canonicalTempRoot, LOADER_FILES, QA_STAGE1_MODULES,
  qaProfileSourceFingerprints } from './egdesk-chat-qa-profile.mjs';
import { prepareQaFirefox } from './run-firefox-mcp-target.mjs';
import { createQaFixtureTransport } from './egdesk-chat-fixture-transport.mjs';
import { loopbackJson, observeChatEvents } from './egdesk-qa-ui-flow.mjs';
import { qaBridgeConfig, qaBridgeUrl, transformQaFixtureSource, materializeQaFixtureIsolation,
  validateQaFixtureIsolation, assertQaProfileBridge, QA_ISOLATION_MANIFEST } from './egdesk-qa-fixture-isolation.mjs';

const ENV = Object.freeze({ EGDESK_QA_FIXTURE_TRANSPORT: '1', EGDESK_QA_FIXTURE_PORT: '39220' });
const overlay = fileURLToPath(new URL('../overlay/', import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const token = 'unit-isolation-no-credentials';

function setup(t) {
  const source = fs.mkdtempSync(path.join(canonicalTempRoot(), 'egdesk-isolation-loader-'));
  for (const name of LOADER_FILES) fs.writeFileSync(path.join(source, name), `unit loader ${name}\n`);
  const { profile } = bootstrapQaProfile({ loaderSource: source });
  t.after(() => {
    for (const [directory, prefix] of [[profile, 'egdesk-chat-test-'], [source, 'egdesk-isolation-loader-']]) {
      assert.equal(path.dirname(directory), canonicalTempRoot());
      assert.ok(path.basename(directory).startsWith(prefix));
      assert.equal(fs.realpathSync.native(directory), directory);
      fs.rmSync(directory, { recursive: true });
    }
  });
  return profile;
}

test('fixture config is explicit, loopback only, never 39218; real-provider default is unchanged', () => {
  assert.deepEqual(qaBridgeConfig({}), { fixture: false, host: '127.0.0.1', port: 39218, origin: 'http://127.0.0.1:39218' });
  for (const port of [undefined, '', '0', '39218', '039220', '65536', '-1', '39220x',
    '39220\n', 'http://127.0.0.1:39220', '0.0.0.0:39220', 39220]) {
    assert.throws(() => qaBridgeConfig({ ...ENV, EGDESK_QA_FIXTURE_PORT: port }), /FIXTURE_PORT/);
  }
  assert.throws(() => qaBridgeConfig({ EGDESK_QA_FIXTURE_PORT: '39220' }), /fixture mode/);
  assert.throws(() => qaBridgeConfig({ ...ENV, EGDESK_QA_FIXTURE_TRANSPORT: 'yes' }), /mode/);
  assert.equal(qaBridgeUrl('/events?chatProtocol=2', ENV), 'http://127.0.0.1:39220/events?chatProtocol=2');
  for (const route of ['//evil.test/auth/status', '/\\evil.test', 'http://evil.test', '/\nauth/status']) {
    assert.throws(() => qaBridgeUrl(route, ENV), /route/);
  }
});

test('only approved endpoint literals and named constants change, not numbers or log text', () => {
  const original = "const untouched = 39218; // a log :39218\n"
    + "fetch('http://127.0.0.1:39218/system/resources');\n"
    + 'fetch(`http://127.0.0.1:39218${path}`);\n'
    + "new EventSource('http://127.0.0.1:39218/events?chatProtocol=2');\n"
    + 'const EGDESK_HELPER_PORT = 39218;\n';
  const transformed = transformQaFixtureSource('JS/eg-desk-surface.uc.js', original, 39220);
  assert.deepEqual(transformed.replacements, { endpointUrls: 3, helperPortConstants: 1 });
  assert.match(transformed.text, /const untouched = 39218; \/\/ a log :39218/);
  assert.equal((transformed.text.match(/39220/g) || []).length, 4);
  assert.throws(() => transformQaFixtureSource('resources/unapproved.mjs', original, 39220), /unapproved/);
  assert.throws(() => transformQaFixtureSource('JS/eg-desk-surface.uc.js',
    "fetch('http://127.0.0.1:39218/new-route')", 39220), /unapproved/);
  assert.throws(() => transformQaFixtureSource('JS/eg-desk-surface.uc.js', original, 39218), /FIXTURE_PORT/);
});

test('fresh copy provenance binds every hash/count/port, leaves product bytes untouched and reapplies exactly', t => {
  const profile = setup(t);
  prepareQaFirefox(profile, { env: {} });
  const originals = qaProfileSourceFingerprints(profile);
  const sourceBefore = Object.fromEntries(Object.keys(originals).filter(name => originals[name])
    .map(name => [name, hash(fs.readFileSync(path.join(overlay, name)))]));
  const manifest = materializeQaFixtureIsolation(profile, { env: ENV });
  assert.equal(manifest.port, 39220);
  assert.equal(manifest.qaOnly, true);
  for (const [name, entry] of Object.entries(manifest.files)) {
    assert.equal(entry.originalSha256, originals[name], name);
    assert.equal(hash(fs.readFileSync(path.join(overlay, name))), sourceBefore[name], name);
    assert.equal(hash(fs.readFileSync(path.join(profile, 'chrome', name))), entry.transformedSha256, name);
    assert.equal(entry.originalSha256 === entry.transformedSha256,
      entry.replacements.endpointUrls + entry.replacements.helperPortConstants === 0, name);
  }
  for (const name of QA_STAGE1_MODULES) assert.ok(manifest.files[name], name);
  assert.ok(manifest.files['resources/surface/EGDeskSurfaceFileCard.mjs'].replacements.endpointUrls > 0);
  assert.equal(manifest.files['resources/surface/EGDeskSurfaceTerminal.mjs'].replacements.helperPortConstants, 1);
  assert.equal(manifest.files['resources/egdesk-terminal-init.js'].replacements.helperPortConstants, 1);
  const manifestBytes = fs.readFileSync(path.join(profile, QA_ISOLATION_MANIFEST));
  assert.deepEqual(materializeQaFixtureIsolation(profile, { env: ENV }), manifest);
  prepareQaFirefox(profile, { env: ENV, marionette: 2829, remote: 6001 });
  assert.deepEqual(validateQaFixtureIsolation(profile, { env: ENV }), manifest);
  assert.deepEqual(fs.readFileSync(path.join(profile, QA_ISOLATION_MANIFEST)), manifestBytes);
  assert.throws(() => assertQaProfileBridge(profile, {}), /real-provider/);
  assert.throws(() => validateQaFixtureIsolation(profile, { env: { ...ENV, EGDESK_QA_FIXTURE_PORT: '39221' } }), /mismatch/);
  assert.throws(() => prepareQaFirefox(profile, { env: {} }), /real-provider/);
  assert.deepEqual(fs.readFileSync(path.join(profile, QA_ISOLATION_MANIFEST)), manifestBytes);
});

test('fixture factory refuses missing/mismatched manifest or changed transformed bytes before any listener', t => {
  const profile = setup(t);
  const make = (env = ENV) => createQaFixtureTransport({ profile, token, env });
  assert.throws(() => make({ ...ENV, EGDESK_QA_FIXTURE_PORT: undefined }), /FIXTURE_PORT/);
  assert.throws(() => make({ ...ENV, EGDESK_QA_FIXTURE_PORT: '39218' }), /FIXTURE_PORT/);
  prepareQaFirefox(profile, { env: {} });
  assert.throws(() => make(), /ENOENT/);
  prepareQaFirefox(profile, { env: ENV });
  const fixture = make();
  t.after(() => fixture.dispose());
  assert.equal(fixture.info.port, 39220);
  assert.equal(fixture.info.host, '127.0.0.1');
  assert.throws(() => make({ ...ENV, EGDESK_QA_FIXTURE_PORT: '39221' }), /mismatch/);
  const file = path.join(profile, 'chrome', 'JS/eg-desk-surface.uc.js');
  fs.appendFileSync(file, '\n// changed copy\n');
  assert.throws(() => make(), /hash mismatch/);
  assert.throws(() => prepareQaFirefox(profile, { env: ENV }), /hash mismatch/);
});

test('personal, locked, used, linked and hard-linked copies fail without changing targets', t => {
  assert.throws(() => materializeQaFixtureIsolation(os.homedir(), { env: ENV }), /Refusing/);
  const profile = setup(t);
  prepareQaFirefox(profile, { env: {} });
  for (const name of ['lock', '.parentlock', 'parent.lock', 'compatibility.ini', 'places.sqlite']) {
    const sentinel = path.join(profile, name);
    fs.writeFileSync(sentinel, 'owned test sentinel');
    assert.throws(() => materializeQaFixtureIsolation(profile, { env: ENV }), /locked|unused/);
    fs.unlinkSync(sentinel);
  }
  const link = path.join(profile, '.parentlock');
  fs.symlinkSync('missing-owned-test-lock', link);
  assert.throws(() => materializeQaFixtureIsolation(profile, { env: ENV }), /locked/);
  fs.unlinkSync(link);
  const target = path.join(profile, 'chrome', 'resources', 'egdesk-terminal-init.js');
  const original = fs.readFileSync(target), parked = path.join(profile, 'parked-terminal.js');
  fs.renameSync(target, parked);
  fs.symlinkSync(parked, target);
  assert.throws(() => materializeQaFixtureIsolation(profile, { env: ENV }), /noncanonical/);
  assert.deepEqual(fs.readFileSync(parked), original);
  fs.unlinkSync(target);
  fs.linkSync(parked, target);
  assert.throws(() => materializeQaFixtureIsolation(profile, { env: ENV }), /linked/);
  assert.deepEqual(fs.readFileSync(parked), original);
});

test('all declared stage1 modules must exist; undeclared absent modules remain explicit null fingerprints', t => {
  const profile = setup(t);
  prepareQaFirefox(profile, { env: {} });
  const surface = path.join(profile, 'chrome', 'JS/eg-desk-surface.uc.js');
  for (const name of QA_STAGE1_MODULES) {
    const file = path.join(profile, 'chrome', name), bytes = fs.readFileSync(file);
    fs.appendFileSync(surface, `\n// declares ${path.basename(name)}\n`);
    fs.unlinkSync(file);
    assert.throws(() => qaProfileSourceFingerprints(profile), /Declared.*missing/);
    fs.writeFileSync(file, bytes, { mode: 0o600 });
  }
  fs.writeFileSync(surface, '// no stage1 declarations in this synthetic copy\n');
  for (const name of QA_STAGE1_MODULES) fs.unlinkSync(path.join(profile, 'chrome', name));
  const fingerprints = qaProfileSourceFingerprints(profile);
  for (const name of QA_STAGE1_MODULES) assert.equal(fingerprints[name], null);
});

test('manifest symlink, forged hash/count and profile/port substitutions are refused', t => {
  const profile = setup(t);
  prepareQaFirefox(profile, { env: ENV });
  const file = path.join(profile, QA_ISOLATION_MANIFEST);
  const original = fs.readFileSync(file), manifest = JSON.parse(original);
  for (const mutate of [value => { value.port = 39218; }, value => { value.profile = '/personal'; },
    value => { value.files['JS/eg-desk-surface.uc.js'].originalSha256 = '0'.repeat(64); },
    value => { value.files['JS/eg-desk-surface.uc.js'].replacements.endpointUrls++; }]) {
    const changed = structuredClone(manifest); mutate(changed);
    fs.writeFileSync(file, JSON.stringify(changed));
    assert.throws(() => validateQaFixtureIsolation(profile, { env: ENV }), /mismatch/);
  }
  fs.writeFileSync(file, original);
  const parked = path.join(profile, 'parked-manifest.json');
  fs.renameSync(file, parked);
  fs.symlinkSync(parked, file);
  assert.throws(() => validateQaFixtureIsolation(profile, { env: ENV }), /linked/);
  assert.deepEqual(fs.readFileSync(parked), original);
});

test('HTTP control and observed SSE share the selected fixture port without network access', async t => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/events?chatProtocol=2')) {
      return { ok: true, body: new ReadableStream({ start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"type":"chat.event","v":2,"provider":"codex","clientThreadId":"unit-thread"}\n\n'));
        controller.close();
      } }) };
    }
    return { ok: true, json: async () => ({ fixture: true }) };
  });
  assert.deepEqual(await loopbackJson('/__qa/state', { token, env: ENV }), { fixture: true });
  const observed = await observeChatEvents('unit-thread', { env: ENV });
  await observed.close();
  assert.equal(observed.events.length, 1);
  assert.deepEqual(calls.map(call => call.url), ['http://127.0.0.1:39220/__qa/state',
    'http://127.0.0.1:39220/events?chatProtocol=2']);
  assert.ok(calls.every(call => call.options.redirect === 'error'));
  await assert.rejects(loopbackJson('/auth/status', { env: { ...ENV, EGDESK_QA_FIXTURE_PORT: undefined } }), /FIXTURE_PORT/);
  assert.equal(calls.length, 2);
});
