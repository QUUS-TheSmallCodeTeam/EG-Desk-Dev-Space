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
  validateQaFixtureIsolation, assertQaProfileBridge, QA_ISOLATION_MANIFEST, QA_RUN_OUTPUTS_FILES,
  QA_PORTABLE_TRANSFER_FILES, QA_PORTABLE_PICKER_FILE, transformPortablePickerResults } from './egdesk-qa-fixture-isolation.mjs';
import { QA_TASK_GATE_SOURCE_FILES, QA_CHAT_ORIGIN_FILE_SOURCE_FILES } from './egdesk-qa-fixture-isolation.mjs';
import { chatOriginFileFixtureEnabled } from './egdesk-chat-origin-file-fixture.mjs';
import { projectFileFixtureEnabled, transformProjectPickerResult, QA_PROJECT_PICKER_FILE } from './egdesk-qa-fixture-isolation.mjs';
import { transformRoomProjectPickerResult, QA_ROOM_PROJECT_PICKER_FILE } from './egdesk-qa-fixture-isolation.mjs';

const ENV = Object.freeze({ EGDESK_QA_FIXTURE_TRANSPORT: '1', EGDESK_QA_FIXTURE_PORT: '39220' });
const overlay = fileURLToPath(new URL('../overlay/', import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const token = 'unit-isolation-no-credentials';
const TASK_ENV = { ...ENV, EGDESK_QA_TASK_GATE_FIXTURE: '1', EGDESK_QA_REAL_TURN: '0' };
const ORIGIN_ENV = { ...ENV, EGDESK_QA_CHAT_ORIGIN_FILE_FIXTURE: '1', EGDESK_QA_REAL_TURN: '0' };
const PROJECT_ENV = { ...ENV, EGDESK_QA_PROJECT_FILE_FIXTURE: '1', EGDESK_QA_REAL_TURN: '0' };

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

test('task and origin source root has no trailing separator for Windows drive and UNC module URLs', () => {
  // Evaluate the actual root initializer with Windows URL/path semantics;
  // this does not access either simulated Windows filesystem location.
  const source = fs.readFileSync(new URL('./egdesk-qa-fixture-isolation.mjs', import.meta.url), 'utf8');
  const initializer = source.match(/^const APP_ROOT = (.+);$/m)?.[1];
  assert.ok(initializer);
  const evaluate = new Function('path', 'fileURLToPath', 'moduleUrl',
    `return ${initializer.replaceAll('import.meta.url', 'moduleUrl')};`);
  for (const [moduleUrl, expectedRoot] of [
    ['file:///C:/repo/EG%20Desk/apps/firefox-ui-demo/scripts/egdesk-qa-fixture-isolation.mjs',
      String.raw`C:\repo\EG Desk\apps\firefox-ui-demo`],
    ['file://server/share/repo/apps/firefox-ui-demo/scripts/egdesk-qa-fixture-isolation.mjs',
      String.raw`\\server\share\repo\apps\firefox-ui-demo`],
  ]) {
    const root = evaluate(path.win32, url => fileURLToPath(url, { windows: true }), moduleUrl);
    assert.equal(root, expectedRoot);
    assert.ok(path.win32.join(root, 'scripts', 'egdesk-task-gate-fixture.mjs').startsWith(root + path.win32.sep));
  }
});

test('Task opt-in binds four unchanged QA sources and existing real runtime fingerprints without injecting those sources', t => {
  assert.deepEqual(QA_TASK_GATE_SOURCE_FILES, ['scripts/egdesk-task-gate-fixture.mjs', 'scripts/egdesk-task-gate-fixture.test.mjs',
    'scripts/verify-firefox-mcp-task-gate-flow.mjs', 'scripts/verify-firefox-mcp-task-gate-flow.test.mjs']);
  const root = path.dirname(overlay.slice(0, -1));
  const before = Object.fromEntries(QA_TASK_GATE_SOURCE_FILES.map(name => [name, fs.readFileSync(path.join(root, name))]));
  const profile = setup(t); prepareQaFirefox(profile, { env: TASK_ENV });
  const manifest = validateQaFixtureIsolation(profile, { env: TASK_ENV });
  assert.deepEqual(Object.keys(manifest.qaSourceFiles), QA_TASK_GATE_SOURCE_FILES);
  for (const name of QA_TASK_GATE_SOURCE_FILES) {
    assert.deepEqual(manifest.qaSourceFiles[name], { originalSha256: hash(before[name]), transformedSha256: hash(before[name]),
      kind: 'unchanged-qa-source-not-profile-injected' });
    assert.deepEqual(fs.readFileSync(path.join(root, name)), before[name]);
    assert.equal(fs.existsSync(path.join(profile, 'chrome', name)), false);
  }
  assert.ok(manifest.files['JS/eg-desk-surface.uc.js']);
  assert.ok(manifest.files['resources/EGDeskChatState.sys.mjs']);
  assert.equal(manifest.files[QA_PORTABLE_PICKER_FILE].portablePickerTransform, undefined);
  assert.throws(() => validateQaFixtureIsolation(profile, { env: ENV }), /mismatch/, 'Task source manifest is not ordinary mode');
});

test('Task invalid or mixed modes reject before copying or preference/provenance writes', t => {
  const profile = setup(t);
  const copy = t.mock.method(fs, 'cpSync', () => assert.fail('No copy before mode validation'));
  const write = t.mock.method(fs, 'writeFileSync', () => assert.fail('No write before mode validation'));
  try {
    for (const patch of [{ EGDESK_QA_TASK_GATE_FIXTURE: 'true' }, { EGDESK_QA_REAL_TURN: '1' },
      { EGDESK_QA_FIXTURE_TRANSPORT: '0' }, { EGDESK_QA_REAL_TURN: undefined },
      ...['EGDESK_QA_PROJECT_FILE_FIXTURE', 'EGDESK_QA_PORTABLE_TRANSFER_FIXTURE', 'EGDESK_QA_RUN_OUTPUTS_FIXTURE',
        'EGDESK_QA_CLAUDE_FIXTURE', 'EGDESK_QA_CLAUDE_READER_FIXTURE', 'EGDESK_QA_BROWSER_NEGATIVE',
        'EGDESK_QA_BROWSER_RELAY', 'EGDESK_QA_CHAT_ORIGIN_FILE_FIXTURE'].map(key => ({ [key]: '1' }))]) {
      assert.throws(() => prepareQaFirefox(profile, { env: { ...TASK_ENV, ...patch } }));
    }
    assert.equal(copy.mock.callCount(), 0); assert.equal(write.mock.callCount(), 0);
  } finally { copy.mock.restore(); write.mock.restore(); }
});

test('Task source manifest missing/tampered entries and changed source bytes fail closed without editing source originals', t => {
  const profile = setup(t); prepareQaFirefox(profile, { env: TASK_ENV });
  const manifestPath = path.join(profile, QA_ISOLATION_MANIFEST), original = fs.readFileSync(manifestPath), manifest = JSON.parse(original);
  for (const name of QA_TASK_GATE_SOURCE_FILES) {
    for (const change of [value => { delete value.qaSourceFiles[name]; },
      value => { value.qaSourceFiles[name].originalSha256 = '0'.repeat(64); },
      value => { value.qaSourceFiles[name].transformedSha256 = '1'.repeat(64); }]) {
      const changed = structuredClone(manifest); change(changed);
      fs.writeFileSync(manifestPath, JSON.stringify(changed));
      assert.throws(() => validateQaFixtureIsolation(profile, { env: TASK_ENV }), /mismatch/);
    }
  }
  fs.writeFileSync(manifestPath, original);
  const target = path.join(path.dirname(overlay.slice(0, -1)), QA_TASK_GATE_SOURCE_FILES[0]);
  const sourceBefore = fs.readFileSync(target), read = fs.readFileSync;
  const changedRead = t.mock.method(fs, 'readFileSync', function(file, ...args) {
    if (file === target) return Buffer.concat([sourceBefore, Buffer.from('\n// simulated source drift\n')]);
    return read.call(fs, file, ...args);
  });
  try { assert.throws(() => validateQaFixtureIsolation(profile, { env: TASK_ENV }), /mismatch/); }
  finally { changedRead.mock.restore(); }
  assert.deepEqual(fs.readFileSync(target), sourceBefore);
  assert.deepEqual(fs.readFileSync(manifestPath), original);
});

test('Task missing canonical QA source refuses materialization before endpoint rewrites', t => {
  const profile = setup(t); prepareQaFirefox(profile, { env: {} });
  const surface = path.join(profile, 'chrome', 'JS/eg-desk-surface.uc.js'), before = fs.readFileSync(surface);
  const target = path.join(path.dirname(overlay.slice(0, -1)), QA_TASK_GATE_SOURCE_FILES[2]), stat = fs.lstatSync;
  const missing = t.mock.method(fs, 'lstatSync', function(file, ...args) {
    if (file === target) throw Object.assign(new Error('Unit missing canonical Task source'), { code: 'ENOENT' });
    return stat.call(fs, file, ...args);
  });
  try { assert.throws(() => materializeQaFixtureIsolation(profile, { env: TASK_ENV }), /missing canonical Task source/); }
  finally { missing.mock.restore(); }
  assert.deepEqual(fs.readFileSync(surface), before);
  assert.equal(fs.existsSync(path.join(profile, QA_ISOLATION_MANIFEST)), false);
});

test('Origin source provenance binds exactly four unchanged Halley files without injected profile copies or picker transforms', t => {
  assert.deepEqual(QA_CHAT_ORIGIN_FILE_SOURCE_FILES, ['scripts/egdesk-chat-origin-file-fixture.mjs', 'scripts/egdesk-chat-origin-file-fixture.test.mjs',
    'scripts/verify-firefox-mcp-chat-origin-file-flow.mjs', 'scripts/verify-firefox-mcp-chat-origin-file-flow.test.mjs']);
  const root = path.dirname(overlay.slice(0, -1));
  const before = Object.fromEntries(QA_CHAT_ORIGIN_FILE_SOURCE_FILES.map(name => [name, fs.readFileSync(path.join(root, name))]));
  const profile = setup(t); prepareQaFirefox(profile, { env: ORIGIN_ENV });
  const manifest = validateQaFixtureIsolation(profile, { env: ORIGIN_ENV });
  assert.deepEqual(Object.keys(manifest.qaSourceFiles), QA_CHAT_ORIGIN_FILE_SOURCE_FILES);
  for (const name of QA_CHAT_ORIGIN_FILE_SOURCE_FILES) {
    assert.deepEqual(manifest.qaSourceFiles[name], { originalSha256: hash(before[name]), transformedSha256: hash(before[name]),
      kind: 'unchanged-qa-source-not-profile-injected' });
    assert.deepEqual(fs.readFileSync(path.join(root, name)), before[name]);
    assert.equal(fs.existsSync(path.join(profile, 'chrome', name)), false);
  }
  assert.ok(manifest.files['JS/eg-desk-surface.uc.js']);
  assert.equal(manifest.files[QA_PROJECT_PICKER_FILE].projectPickerTransform, undefined);
  assert.equal(manifest.files[QA_PORTABLE_PICKER_FILE].portablePickerTransform, undefined);
  assert.throws(() => validateQaFixtureIsolation(profile, { env: ENV }), /mismatch/);
  assert.throws(() => validateQaFixtureIsolation(profile, { env: TASK_ENV }), /mismatch/);
});

test('Origin bootstrap gate agrees with actual factory gate and rejects mixed/invalid flags before all copying/writes', t => {
  assert.equal(chatOriginFileFixtureEnabled(ORIGIN_ENV), true); assert.equal(qaBridgeConfig(ORIGIN_ENV).fixture, true);
  const profile = setup(t);
  const copy = t.mock.method(fs, 'cpSync', () => assert.fail('No copy before Origin mode validation'));
  const write = t.mock.method(fs, 'writeFileSync', () => assert.fail('No write before Origin mode validation'));
  try {
    for (const patch of [{ EGDESK_QA_CHAT_ORIGIN_FILE_FIXTURE: 'true' }, { EGDESK_QA_REAL_TURN: '1' },
      { EGDESK_QA_FIXTURE_TRANSPORT: '0' }, { EGDESK_QA_REAL_TURN: undefined },
      ...['EGDESK_QA_PROJECT_FILE_FIXTURE', 'EGDESK_QA_PORTABLE_TRANSFER_FIXTURE', 'EGDESK_QA_RUN_OUTPUTS_FIXTURE',
        'EGDESK_QA_CLAUDE_FIXTURE', 'EGDESK_QA_CLAUDE_READER_FIXTURE', 'EGDESK_QA_BROWSER_NEGATIVE',
        'EGDESK_QA_BROWSER_RELAY', 'EGDESK_QA_TASK_GATE_FIXTURE'].map(key => ({ [key]: '1' }))]) {
      const env = { ...ORIGIN_ENV, ...patch };
      assert.throws(() => chatOriginFileFixtureEnabled(env)); assert.throws(() => prepareQaFirefox(profile, { env }));
    }
    assert.equal(copy.mock.callCount(), 0); assert.equal(write.mock.callCount(), 0);
  } finally { copy.mock.restore(); write.mock.restore(); }
});

test('Origin manifest missing/tampered source hashes fail closed while originals remain unchanged', t => {
  const profile = setup(t); prepareQaFirefox(profile, { env: ORIGIN_ENV });
  const file = path.join(profile, QA_ISOLATION_MANIFEST), original = fs.readFileSync(file), manifest = JSON.parse(original);
  const root = path.dirname(overlay.slice(0, -1));
  const sourceBytes = Object.fromEntries(QA_CHAT_ORIGIN_FILE_SOURCE_FILES.map(name => [name, fs.readFileSync(path.join(root, name))]));
  for (const name of QA_CHAT_ORIGIN_FILE_SOURCE_FILES) {
    for (const modify of [value => { delete value.qaSourceFiles[name]; },
      value => { value.qaSourceFiles[name].originalSha256 = '0'.repeat(64); },
      value => { value.qaSourceFiles[name].transformedSha256 = '1'.repeat(64); }]) {
      const changed = structuredClone(manifest); modify(changed); fs.writeFileSync(file, JSON.stringify(changed));
      assert.throws(() => validateQaFixtureIsolation(profile, { env: ORIGIN_ENV }), /mismatch/);
    }
  }
  fs.writeFileSync(file, original);
  for (const name of QA_CHAT_ORIGIN_FILE_SOURCE_FILES) assert.deepEqual(fs.readFileSync(path.join(root, name)), sourceBytes[name]);
});

test('Origin missing or linked QA source refuses materialization before changing endpoint copies', t => {
  const profile = setup(t); prepareQaFirefox(profile, { env: {} });
  const surface = path.join(profile, 'chrome', 'JS/eg-desk-surface.uc.js'), before = fs.readFileSync(surface);
  const target = path.join(path.dirname(overlay.slice(0, -1)), QA_CHAT_ORIGIN_FILE_SOURCE_FILES[0]), stat = fs.lstatSync;
  for (const kind of ['missing', 'linked']) {
    const injectedStat = t.mock.method(fs, 'lstatSync', function(file, ...args) {
      if (file !== target) return stat.call(fs, file, ...args);
      if (kind === 'missing') throw Object.assign(new Error('Unit missing Origin source'), { code: 'ENOENT' });
      const info = stat.call(fs, file, ...args);
      return new Proxy(info, { get(object, key) { return key === 'isSymbolicLink' ? () => true : object[key]; } });
    });
    try { assert.throws(() => materializeQaFixtureIsolation(profile, { env: ORIGIN_ENV }), /missing Origin source|noncanonical/); }
    finally { injectedStat.mock.restore(); }
    assert.deepEqual(fs.readFileSync(surface), before); assert.equal(fs.existsSync(path.join(profile, QA_ISOLATION_MANIFEST)), false);
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

test('project picker transform is explicit and replaces only the OS-result function boundary', () => {
  const original = fs.readFileSync(path.join(overlay, QA_PROJECT_PICKER_FILE), 'utf8');
  const ordinary = transformQaFixtureSource(QA_PROJECT_PICKER_FILE, original, 39220);
  assert.equal(ordinary.projectPickerTransform, undefined);
  assert.match(ordinary.text, /picker\.open\(result =>/);
  const transformed = transformQaFixtureSource(QA_PROJECT_PICKER_FILE, original, 39220, { projectFileFixture: true });
  const from = ordinary.text.indexOf('  function pickNativeFileDirectory() {');
  const end = ordinary.text.indexOf('  function pickNativeFileSaveFile(');
  const replacementEnd = transformed.text.indexOf('  function pickNativeFileSaveFile(');
  assert.equal(transformed.text.slice(0, from), ordinary.text.slice(0, from));
  assert.equal(transformed.text.slice(replacementEnd), ordinary.text.slice(end));
  assert.equal(transformed.projectPickerTransform.sourceBoundarySha256, hash(ordinary.text.slice(from, end)));
  assert.equal(transformed.projectPickerTransform.replacementSha256, hash(transformed.text.slice(from, replacementEnd)));
  assert.equal(transformed.replacements.osPickerResultBoundaries, 1);
  const replacement = transformed.text.slice(from, replacementEnd);
  assert.match(replacement, /\/__qa\/project-file\/picker/);
  assert.doesNotMatch(replacement, /createInstance|openProject|attachProject|completePicker|__egdesk|window\[/);
  assert.throws(() => transformProjectPickerResult(original + original, 39220), /ambiguous/);
  assert.throws(() => transformProjectPickerResult(original.replace('picker.file.path', 'changed.path'), 39220), /boundary changed/);
  assert.throws(() => transformProjectPickerResult(original, 39218), /FIXTURE_PORT/);
  assert.equal(projectFileFixtureEnabled({}), false);
  assert.equal(projectFileFixtureEnabled({ ...ENV, EGDESK_QA_PROJECT_FILE_FIXTURE: '1', EGDESK_QA_REAL_TURN: '0' }), true);
  for (const env of [{ ...ENV, EGDESK_QA_PROJECT_FILE_FIXTURE: 'yes' },
    { ...ENV, EGDESK_QA_PROJECT_FILE_FIXTURE: '1' },
    { ...ENV, EGDESK_QA_PROJECT_FILE_FIXTURE: '1', EGDESK_QA_REAL_TURN: '1' },
    { ...ENV, EGDESK_QA_PROJECT_FILE_FIXTURE: '1', EGDESK_QA_REAL_TURN: '0', EGDESK_QA_CLAUDE_FIXTURE: '1' }]) {
    assert.throws(() => projectFileFixtureEnabled(env));
  }
});

// Reviewed signature: the dialog title is a parameter because the Board's
// project folder picker reuses this one native boundary with its own title.
const ROOM_PICKER_SIGNATURE = "function pickNativeRoomProjectDirectory(title = '이 방에서 사용할 프로젝트 폴더')";

function roomPickerParts(source) {
  const start = source.indexOf(`  ${ROOM_PICKER_SIGNATURE} {`);
  assert.notEqual(start, -1, 'reviewed room picker signature must exist');
  const from = source.indexOf('\n', start) + 1, to = source.indexOf('\n  }', from);
  return { prefix: source.slice(0, from), body: source.slice(from, to), suffix: source.slice(to),
    functionSource: source.slice(start, to + '\n  }'.length) };
}

// Only source generation is simulated. The generated picker runs after the
// real process.platform has been restored and does not touch the filesystem.
function transformOnPlatform(platform, transform, source) {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  try {
    Object.defineProperty(process, 'platform', { ...descriptor, value: platform });
    return transform(source, 39220);
  } finally {
    Object.defineProperty(process, 'platform', descriptor);
  }
}

function transformedPicker(source, name, response) {
  const match = source.match(new RegExp(`  (?:async )?function ${name}\\([^\\n]*\\) \\{[\\s\\S]*?\\n  \\}`));
  assert.ok(match, `transformed ${name} must exist`);
  return new Function('fetch', `return (${match[0]});`)(async () => response);
}

test('room picker transform replaces exactly one reviewed OS-result body and leaves all surrounding real flows byte-identical', () => {
  const original = fs.readFileSync(path.join(overlay, QA_ROOM_PROJECT_PICKER_FILE), 'utf8');
  const ordinary = transformQaFixtureSource(QA_ROOM_PROJECT_PICKER_FILE, original, 39220);
  assert.equal(ordinary.roomProjectPickerTransform, undefined);
  const transformed = transformQaFixtureSource(QA_ROOM_PROJECT_PICKER_FILE, original, 39220, { projectFileFixture: true });
  const before = roomPickerParts(ordinary.text), after = roomPickerParts(transformed.text);
  assert.equal(after.prefix, before.prefix); assert.equal(after.suffix, before.suffix);
  assert.deepEqual(transformed.roomProjectPickerTransform, { kind: 'chat-room-project-os-directory-result-v1',
    functionName: 'pickNativeRoomProjectDirectory', sourceBodySha256: hash(before.body), replacementBodySha256: hash(after.body),
    synthetic: 'OS-picker-result-only', nativePickerInvocations: 0, endpoint: 'http://127.0.0.1:39220/__qa/project-file/picker' });
  assert.equal(transformed.replacements.osPickerResultBoundaries, 1);
  assert.doesNotMatch(after.body, /createInstance|prepareRoomProjectFolder|prepareProjectFolder|completePicker|attachProject|openProject|IOUtils|__egdesk|window\[/);
  assert.ok(after.suffix.includes('createEGDeskNativeFilePickers({ service, pickDirectory: pickNativeRoomProjectDirectory })'));
  assert.deepEqual(fs.readFileSync(path.join(overlay, QA_ROOM_PROJECT_PICKER_FILE), 'utf8'), original);
});

test('room picker body returns only string/null and rejects errors or malformed results once with no native fallback', async () => {
  const original = fs.readFileSync(path.join(overlay, QA_ROOM_PROJECT_PICKER_FILE), 'utf8');
  const { functionSource } = roomPickerParts(transformRoomProjectPickerResult(original, 39220).text);
  const good = selection => ({ kind: 'egdesk-project-file-picker-result', synthetic: true, selection });
  for (const selection of [null, '/owned/qa/방 전용 폴더']) {
    const calls = [];
    const picker = new Function('fetch', `return (${functionSource});`)(async (url, options) => {
      calls.push({ url, options }); return { ok: true, json: async () => good(selection) };
    });
    assert.equal(await picker(), selection);
    assert.deepEqual(calls, [{ url: 'http://127.0.0.1:39220/__qa/project-file/picker', options: {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' } }]);
  }
  for (const response of [
    { ok: false, json: async () => good('/owned/qa') },
    ...[{}, null, { ...good(null), synthetic: false }, { ...good(null), kind: 'fake' },
      good(undefined), good({ path: '/owned/qa' }), good(['owned']), good('relative'), good('/owned/\nqa')]
      .map(packet => ({ ok: true, json: async () => packet })),
    { ok: true, json: async () => { throw new Error('invalid JSON'); } },
    new Error('connection unavailable'),
  ]) {
    let calls = 0;
    const picker = new Function('fetch', `return (${functionSource});`)(async () => {
      calls++; if (response instanceof Error) throw response; return response;
    });
    await assert.rejects(picker()); assert.equal(calls, 1, 'no retry, fallback or alternate input path');
  }
});

test('project and room picker results use the generating platform absolute-path rules', async () => {
  const project = fs.readFileSync(path.join(overlay, QA_PROJECT_PICKER_FILE), 'utf8');
  const room = fs.readFileSync(path.join(overlay, QA_ROOM_PROJECT_PICKER_FILE), 'utf8');
  const variants = [
    ['darwin', ['/owned/qa/방 전용 폴더'], ['relative', String.raw`C:\owned\qa`, String.raw`\\server\share\qa`]],
    ['win32', [String.raw`C:\owned\qa`, 'C:/owned/qa', String.raw`\\server\share\qa`, '//server/share/qa'],
      ['relative', '/root-relative', String.raw`\root-relative`, String.raw`C:relative`, String.raw`\\server`,
        String.raw`\\server` + String.fromCharCode(92), String.raw`\\?\C:\owned`,
        String.raw`\\.\pipe\owned`, String.raw`\\server\..\owned`]],
  ];
  for (const [platform, accepted, rejected] of variants) {
    for (const [source, transform, name] of [[project, transformProjectPickerResult, 'pickNativeFileDirectory'],
      [room, transformRoomProjectPickerResult, 'pickNativeRoomProjectDirectory']]) {
      const text = transformOnPlatform(platform, transform, source).text;
      for (const selection of [null, ...accepted]) {
        const picker = transformedPicker(text, name, { ok: true, json: async () =>
          ({ kind: 'egdesk-project-file-picker-result', synthetic: true, selection }) });
        assert.equal(await picker(), selection, `${platform} ${name} accepts ${selection}`);
      }
      for (const selection of [...rejected, '/owned/\nqa']) {
        const picker = transformedPicker(text, name, { ok: true, json: async () =>
          ({ kind: 'egdesk-project-file-picker-result', synthetic: true, selection }) });
        await assert.rejects(picker(), undefined, `${platform} ${name} rejects ${selection}`);
      }
    }
  }
});

test('room picker missing/duplicate/changed signatures and body drift fail closed instead of installing implementation', () => {
  const original = fs.readFileSync(path.join(overlay, QA_ROOM_PROJECT_PICKER_FILE), 'utf8');
  const { functionSource } = roomPickerParts(original);
  for (const source of ['', original.replace(functionSource, ''), original + functionSource,
    original + functionSource.replace(ROOM_PICKER_SIGNATURE, 'function  pickNativeRoomProjectDirectory ()'),
    original.replace(ROOM_PICKER_SIGNATURE, 'function pickNativeRoomProjectDirectory(options)'),
    original.replace(ROOM_PICKER_SIGNATURE, 'function pickNativeRoomProjectDirectory()'),
    original.replace(ROOM_PICKER_SIGNATURE, "function pickNativeRoomProjectDirectory(title = '다른 제목')"),
    original.replace(functionSource, functionSource.replace('window.browsingContext, title,', "window.browsingContext, '이 방에서 사용할 프로젝트 폴더',")),
    original.replace(functionSource, functionSource.replace('picker.file.path', 'changed.path')),
    original.replace(functionSource, functionSource.replace('return new Promise', 'IOUtils.read("outside"); return new Promise')),
    original.replace(functionSource, functionSource.replace('returnOK', 'returnReplace')),
    original.replace(functionSource, functionSource.slice(0, -1))]) {
    assert.throws(() => transformRoomProjectPickerResult(source, 39220), /room project picker/);
  }
  assert.throws(() => transformRoomProjectPickerResult(original, 39218), /FIXTURE_PORT/);
  assert.throws(() => transformQaFixtureSource(QA_ROOM_PROJECT_PICKER_FILE, original, 39220,
    { projectFileFixture: true, portableTransferFixture: true }), /mutually exclusive/);
});

test('room picker is project-only; every other standalone fixture retains the native body without a room transform', t => {
  const source = fs.readFileSync(path.join(overlay, QA_ROOM_PROJECT_PICKER_FILE), 'utf8'), body = roomPickerParts(source).body;
  for (const key of [null, 'EGDESK_QA_CLAUDE_FIXTURE', 'EGDESK_QA_CLAUDE_READER_FIXTURE', 'EGDESK_QA_RUN_OUTPUTS_FIXTURE',
    'EGDESK_QA_PORTABLE_TRANSFER_FIXTURE', 'EGDESK_QA_TASK_GATE_FIXTURE', 'EGDESK_QA_CHAT_ORIGIN_FILE_FIXTURE',
    'EGDESK_QA_BROWSER_NEGATIVE', 'EGDESK_QA_BROWSER_RELAY']) {
    const env = { ...ENV, EGDESK_QA_REAL_TURN: '0', ...(key ? { [key]: '1' } : {}) };
    const profile = setup(t); prepareQaFirefox(profile, { env });
    const manifest = validateQaFixtureIsolation(profile, { env });
    assert.equal(manifest.files[QA_ROOM_PROJECT_PICKER_FILE].roomProjectPickerTransform, undefined, key || 'ordinary');
    assert.equal(roomPickerParts(fs.readFileSync(path.join(profile, 'chrome', QA_ROOM_PROJECT_PICKER_FILE), 'utf8')).body, body);
  }
});

test('project mode conflicts and malformed flags fail before all bootstrap copy/preference writes', t => {
  const profile = setup(t), spies = ['cpSync', 'writeFileSync'].map(name => t.mock.method(fs, name, () => assert.fail('unexpected prevalidation write')));
  try {
    for (const patch of [{ EGDESK_QA_PROJECT_FILE_FIXTURE: 'true' }, { EGDESK_QA_REAL_TURN: '1' },
      { EGDESK_QA_REAL_TURN: undefined }, { EGDESK_QA_FIXTURE_TRANSPORT: '0' },
      ...['EGDESK_QA_CLAUDE_FIXTURE', 'EGDESK_QA_CLAUDE_READER_FIXTURE', 'EGDESK_QA_RUN_OUTPUTS_FIXTURE',
        'EGDESK_QA_PORTABLE_TRANSFER_FIXTURE', 'EGDESK_QA_TASK_GATE_FIXTURE', 'EGDESK_QA_CHAT_ORIGIN_FILE_FIXTURE',
        'EGDESK_QA_BROWSER_NEGATIVE', 'EGDESK_QA_BROWSER_RELAY'].map(key => ({ [key]: '1' }))]) {
      assert.throws(() => prepareQaFirefox(profile, { env: { ...PROJECT_ENV, ...patch } }), /fixture/i);
    }
    for (const spy of spies) assert.equal(spy.mock.callCount(), 0);
  } finally { for (const spy of spies) spy.mock.restore(); }
});

test('missing actual room picker rejects materialization before endpoint/body writes', t => {
  const profile = setup(t); prepareQaFirefox(profile, { env: {} });
  const source = path.join(overlay, QA_ROOM_PROJECT_PICKER_FILE), original = fs.readFileSync(source);
  const copyPath = path.join(profile, 'chrome', QA_ROOM_PROJECT_PICKER_FILE), copyBefore = fs.readFileSync(copyPath);
  const read = fs.readFileSync;
  const missing = t.mock.method(fs, 'readFileSync', function(file, ...args) {
    if (file === source) return Buffer.from(original.toString().replace(ROOM_PICKER_SIGNATURE, 'function removedRoomPicker()'));
    return read.call(fs, file, ...args);
  });
  const write = t.mock.method(fs, 'writeFileSync', () => assert.fail('missing function must precede any write'));
  try { assert.throws(() => materializeQaFixtureIsolation(profile, { env: PROJECT_ENV }), /room project picker/); assert.equal(write.mock.callCount(), 0); }
  finally { missing.mock.restore(); write.mock.restore(); }
  assert.deepEqual(fs.readFileSync(source), original); assert.deepEqual(fs.readFileSync(copyPath), copyBefore);
  assert.equal(fs.existsSync(path.join(profile, QA_ISOLATION_MANIFEST)), false);
});

test('room picker whole-source/body provenance rejects missing or tampered manifests and copied bytes; originals stay intact', t => {
  const profile = setup(t), source = path.join(overlay, QA_ROOM_PROJECT_PICKER_FILE), before = fs.readFileSync(source);
  prepareQaFirefox(profile, { env: PROJECT_ENV });
  const manifest = validateQaFixtureIsolation(profile, { env: PROJECT_ENV }), entry = manifest.files[QA_ROOM_PROJECT_PICKER_FILE];
  const copy = path.join(profile, 'chrome', QA_ROOM_PROJECT_PICKER_FILE), copyBytes = fs.readFileSync(copy);
  assert.equal(entry.originalSha256, hash(before)); assert.equal(entry.transformedSha256, hash(copyBytes));
  assert.notEqual(entry.originalSha256, entry.transformedSha256);
  assert.equal(entry.roomProjectPickerTransform.sourceBodySha256, hash(roomPickerParts(before.toString()).body));
  assert.equal(entry.roomProjectPickerTransform.replacementBodySha256, hash(roomPickerParts(copyBytes.toString()).body));
  const fileModule = 'resources/EGDeskFileView.sys.mjs';
  assert.equal(manifest.files[fileModule].originalSha256, manifest.files[fileModule].transformedSha256, 'actual prepare/grant/consume module unchanged');
  const manifestPath = path.join(profile, QA_ISOLATION_MANIFEST), manifestBytes = fs.readFileSync(manifestPath);
  for (const mutate of [e => { delete e.roomProjectPickerTransform; }, e => { e.originalSha256 = '0'.repeat(64); },
    e => { e.transformedSha256 = '0'.repeat(64); }, e => { e.roomProjectPickerTransform.sourceBodySha256 = '0'.repeat(64); },
    e => { e.roomProjectPickerTransform.replacementBodySha256 = '0'.repeat(64); },
    e => { e.roomProjectPickerTransform.kind = 'forged'; }]) {
    const changed = structuredClone(manifest); mutate(changed.files[QA_ROOM_PROJECT_PICKER_FILE]);
    fs.writeFileSync(manifestPath, JSON.stringify(changed));
    assert.throws(() => validateQaFixtureIsolation(profile, { env: PROJECT_ENV }), /mismatch/);
  }
  fs.writeFileSync(manifestPath, manifestBytes);
  fs.appendFileSync(copy, '\n// changed owned QA copy\n');
  assert.throws(() => validateQaFixtureIsolation(profile, { env: PROJECT_ENV }), /hash mismatch/);
  fs.writeFileSync(copy, copyBytes);
  assert.deepEqual(materializeQaFixtureIsolation(profile, { env: PROJECT_ENV }), manifest);
  assert.throws(() => validateQaFixtureIsolation(profile, { env: ENV }), /mismatch/);
  assert.deepEqual(fs.readFileSync(source), before);
});

test('project picker copy, exact boundary descriptor and opt-in are bound into provenance', t => {
  const profile = setup(t);
  const env = { ...ENV, EGDESK_QA_PROJECT_FILE_FIXTURE: '1', EGDESK_QA_REAL_TURN: '0' };
  const source = fs.readFileSync(path.join(overlay, QA_PROJECT_PICKER_FILE));
  prepareQaFirefox(profile, { env });
  const manifest = validateQaFixtureIsolation(profile, { env });
  const entry = manifest.files[QA_PROJECT_PICKER_FILE];
  assert.equal(entry.originalSha256, hash(source));
  assert.equal(entry.transformedSha256, hash(fs.readFileSync(path.join(profile, 'chrome', QA_PROJECT_PICKER_FILE))));
  assert.equal(entry.projectPickerTransform.kind, 'project-file-os-directory-result-v1');
  assert.equal(entry.projectPickerTransform.synthetic, 'OS-picker-result-only');
  for (const name of ['resources/EGDeskFileView.sys.mjs', 'resources/EGDeskFileCardState.sys.mjs',
    'resources/EGDeskRunResult.sys.mjs', 'resources/EGDeskDiffView.sys.mjs', 'resources/EGDeskChangeReview.mjs']) {
    assert.equal(manifest.files[name].originalSha256, hash(fs.readFileSync(path.join(overlay, name))));
    assert.equal(manifest.files[name].transformedSha256, hash(fs.readFileSync(path.join(profile, 'chrome', name))));
  }
  assert.deepEqual(fs.readFileSync(path.join(overlay, QA_PROJECT_PICKER_FILE)), source);
  assert.throws(() => validateQaFixtureIsolation(profile, { env: ENV }), /mismatch/);
  assert.deepEqual(materializeQaFixtureIsolation(profile, { env }), manifest);
  const manifestFile = path.join(profile, QA_ISOLATION_MANIFEST);
  const changed = structuredClone(manifest);
  changed.files[QA_PROJECT_PICKER_FILE].projectPickerTransform.replacementSha256 = '0'.repeat(64);
  fs.writeFileSync(manifestFile, JSON.stringify(changed));
  assert.throws(() => validateQaFixtureIsolation(profile, { env }), /mismatch/);
});

const RUN_OUTPUTS_ENV = Object.freeze({ ...ENV, EGDESK_QA_RUN_OUTPUTS_FIXTURE: '1', EGDESK_QA_REAL_TURN: '0' });
const PORTABLE_ENV = Object.freeze({ ...ENV, EGDESK_QA_PORTABLE_TRANSFER_FIXTURE: '1', EGDESK_QA_REAL_TURN: '0' });

// Parser/transform specimens only. They are never installed into a profile or
// used to claim an actual UI run while the shipped glue is missing.
const portablePickerSpecimen = `const untouchedBefore = 1;
  function pickNativeTextOpenFile({ accept, signal }) {
    return new Promise(resolve => {
      const picker = Cc['@mozilla.org/filepicker;1'].createInstance(Ci.nsIFilePicker);
      picker.init(window.browsingContext, 'Open', Ci.nsIFilePicker.modeOpen);
      picker.open(result => resolve(result === Ci.nsIFilePicker.returnCancel ? { cancelled: true } : { path: picker.file.path, filename: picker.file.leafName }));
    });
  }
  function pickNativeTextSaveFile({ fileName, contentType, signal }) {
    return new Promise(resolve => {
      const picker = Cc['@mozilla.org/filepicker;1'].createInstance(Ci.nsIFilePicker);
      picker.init(window.browsingContext, 'Save', Ci.nsIFilePicker.modeSave);
      picker.open(result => resolve(result === Ci.nsIFilePicker.returnCancel ? { cancelled: true } : { path: picker.file.path, filename: picker.file.leafName }));
    });
  }
  function actualIoOutsidePicker() { return IOUtils.write(path, bytes, { mode: 'create', flush: true }); }
`;

test('portable picker source transform replaces exactly two native-result bodies and fingerprints both', () => {
  const transformed = transformPortablePickerResults(portablePickerSpecimen, 39220);
  assert.equal(transformed.descriptor.kind, 'portable-text-os-picker-results-v1');
  assert.equal(transformed.descriptor.functions.length, 2);
  for (const name of ['pickNativeTextOpenFile', 'pickNativeTextSaveFile']) {
    const body = source => source.slice(source.indexOf('\n', source.indexOf('  function ' + name)) + 1,
      source.indexOf('\n  }', source.indexOf('  function ' + name)));
    const descriptor = transformed.descriptor.functions.find(row => row.name === name);
    assert.equal(descriptor.sourceBodySha256, hash(body(portablePickerSpecimen)));
    assert.equal(descriptor.replacementBodySha256, hash(body(transformed.text)));
    assert.ok(!/IOUtils|\.open\(|createInstance|beginWrite|readText|saveText/.test(body(transformed.text)));
  }
  const eraseBodies = source => source.replace(/(  function pickNativeText(?:Open|Save)File\([^\n]+\) \{\n)[\s\S]*?(\n  \})/g, '$1BODY$2');
  assert.equal(eraseBodies(transformed.text), eraseBodies(portablePickerSpecimen));
  assert.ok(transformed.text.includes("IOUtils.write(path, bytes, { mode: 'create', flush: true })"));
  assert.equal(transformQaFixtureSource(QA_PORTABLE_PICKER_FILE, portablePickerSpecimen, 39220).text, portablePickerSpecimen);
  assert.equal(transformQaFixtureSource(QA_PORTABLE_PICKER_FILE, portablePickerSpecimen, 39220,
    { portableTransferFixture: true }).replacements.osPickerResultBoundaries, 2);
});

test('portable open/save picker results validate absolute paths and filenames for each generating platform', async () => {
  const actualSource = fs.readFileSync(path.join(overlay, QA_PORTABLE_PICKER_FILE), 'utf8');
  const variants = [
    ['darwin', [['/owned/input.md', 'input.md']],
      [['relative/input.md', 'input.md'], [String.raw`C:\owned\input.md`, 'input.md']]],
    ['win32', [[String.raw`C:\owned\input.md`, 'input.md'], ['C:/owned/input.md', 'input.md'],
      [String.raw`\\server\share\owned\input.md`, 'input.md'], ['//server/share/owned/input.md', 'input.md']],
    [['/root-relative/input.md', 'input.md'], [String.raw`C:relative\input.md`, 'input.md'],
      [String.raw`\root-relative\input.md`, 'input.md'], [String.raw`\\server`, 'server'],
      [String.raw`\\?\C:\owned\input.md`, 'input.md'], [String.raw`\\.\pipe\input.md`, 'input.md']]],
  ];
  for (const source of [portablePickerSpecimen, actualSource]) {
    for (const [platform, accepted, rejected] of variants) {
      const text = transformOnPlatform(platform, transformPortablePickerResults, source).text;
      for (const [name, operation, args] of [['pickNativeTextOpenFile', 'open', { accept: '.md' }],
        ['pickNativeTextSaveFile', 'save', { fileName: 'input.md', contentType: 'text/markdown; charset=utf-8' }]]) {
        const make = result => transformedPicker(text, name, { ok: true, json: async () =>
          ({ kind: 'egdesk-portable-picker-result', operation, synthetic: true, result }) });
        assert.deepEqual(await make({ cancelled: true })(args), { cancelled: true });
        for (const [chosenPath, filename] of accepted) {
          assert.deepEqual(await make({ path: chosenPath, filename })(args), { path: chosenPath, filename },
            `${platform} ${name} accepts ${chosenPath}`);
        }
        for (const [chosenPath, filename] of [...rejected, ...accepted.map(([chosenPath]) => [chosenPath, 'other.md']),
          ['/owned/\ninput.md', 'input.md'], ['', ''], ['/owned/', ''], ['/owned/..', '..']]) {
          await assert.rejects(make({ path: chosenPath, filename })(args), undefined,
            `${platform} ${name} rejects ${chosenPath}`);
        }
        await assert.rejects(make({ path: accepted[0][0], filename: accepted[0][1], extra: true })(args));
        await assert.rejects(make({ cancelled: true, path: accepted[0][0] })(args));
        const valid = { kind: 'egdesk-portable-picker-result', operation, synthetic: true,
          result: { path: accepted[0][0], filename: accepted[0][1] } };
        for (const packet of [{ ...valid, kind: 'untrusted' }, { ...valid, operation: operation === 'open' ? 'save' : 'open' },
          { ...valid, synthetic: false }, { ...valid, error: 'unexpected' }]) {
          const picker = transformedPicker(text, name, { ok: true, json: async () => packet });
          await assert.rejects(picker(args));
        }
        const refused = transformedPicker(text, name, { ok: false, json: async () => valid });
        await assert.rejects(refused(args));
        const exists = transformedPicker(text, name, { ok: true, json: async () =>
          ({ kind: 'egdesk-portable-picker-result', operation, synthetic: true, error: 'EEXIST' }) });
        if (operation === 'save') await assert.rejects(exists(args), { code: 'EEXIST' });
        else await assert.rejects(exists(args));
        let calls = 0;
        const match = text.match(new RegExp(`  (?:async )?function ${name}\\([^\\n]*\\) \\{[\\s\\S]*?\\n  \\}`));
        const cancelled = new Function('fetch', `return (${match[0]});`)(() => { calls++; throw new Error('unexpected fetch'); });
        assert.deepEqual(await cancelled({ ...args, signal: { aborted: true } }), { cancelled: true });
        assert.equal(calls, 0);
      }
    }
  }
});

test('portable picker source missing/duplicate/changed boundaries fail instead of installing fake product glue', () => {
  for (const source of ['', 'const productNotImplementedYet = true;', portablePickerSpecimen + portablePickerSpecimen,
    portablePickerSpecimen.replace('function pickNativeTextOpenFile', 'function absentOpenFile'),
    portablePickerSpecimen.replace('{ accept, signal }', '{ signal }'),
    portablePickerSpecimen.replace('Ci.nsIFilePicker.modeOpen', 'Ci.nsIFilePicker.modeGetFolder'),
    portablePickerSpecimen.replace('picker.open(result', 'IOUtils.read(result'),
    portablePickerSpecimen.replace('    return new Promise(resolve => {', '    return readText(); new Promise(resolve => {')]) {
    assert.throws(() => transformPortablePickerResults(source, 39220), /portable picker/);
  }
  assert.throws(() => transformPortablePickerResults(portablePickerSpecimen, 39218), /FIXTURE_PORT/);
});

test('portable mode fingerprints actual flow/presenter/IO adapter sources without replacing their bodies', t => {
  assert.deepEqual(QA_PORTABLE_TRANSFER_FILES, ['resources/EGDeskBoardExport.sys.mjs', 'resources/EGDeskProfileTransfer.sys.mjs',
    'resources/EGDeskProfileTransferView.sys.mjs', 'resources/EGDeskNativeFilePickers.sys.mjs']);
  const before = Object.fromEntries(QA_PORTABLE_TRANSFER_FILES.map(name => [name, fs.readFileSync(path.join(overlay, name))]));
  const profile = setup(t); prepareQaFirefox(profile, { env: PORTABLE_ENV });
  const manifest = validateQaFixtureIsolation(profile, { env: PORTABLE_ENV });
  for (const name of QA_PORTABLE_TRANSFER_FILES) {
    assert.deepEqual(manifest.files[name], { originalSha256: hash(before[name]), transformedSha256: hash(before[name]),
      replacements: { endpointUrls: 0, helperPortConstants: 0 } });
    assert.deepEqual(fs.readFileSync(path.join(profile, 'chrome', name)), before[name]);
    assert.deepEqual(fs.readFileSync(path.join(overlay, name)), before[name]);
  }
  assert.equal(manifest.files[QA_PROJECT_PICKER_FILE].projectPickerTransform, undefined);
  assert.deepEqual(materializeQaFixtureIsolation(profile, { env: PORTABLE_ENV }), manifest);
  assert.throws(() => validateQaFixtureIsolation(profile, { env: ENV }), /mismatch/);
});

test('portable mixed modes fail before copies/preferences/provenance writes', t => {
  const profile = setup(t);
  const writes = ['writeFileSync', 'renameSync', 'cpSync'].map(method => t.mock.method(fs, method, () => {
    throw new Error('mode validation must precede profile writes');
  }));
  for (const patch of [{ EGDESK_QA_PORTABLE_TRANSFER_FIXTURE: 'yes' }, { EGDESK_QA_REAL_TURN: '1' },
    { EGDESK_QA_REAL_TURN: undefined }, { EGDESK_QA_FIXTURE_TRANSPORT: '0' },
    ...['EGDESK_QA_PROJECT_FILE_FIXTURE', 'EGDESK_QA_RUN_OUTPUTS_FIXTURE', 'EGDESK_QA_CLAUDE_FIXTURE',
      'EGDESK_QA_BROWSER_NEGATIVE', 'EGDESK_QA_BROWSER_RELAY'].map(key => ({ [key]: '1' }))]) {
    const env = { ...PORTABLE_ENV, ...patch };
    assert.throws(() => qaBridgeConfig(env));
    assert.throws(() => prepareQaFirefox(profile, { env }));
  }
  for (const spy of writes) assert.equal(spy.mock.callCount(), 0);
});

test('portable provenance rejects missing/tampered module entries and copied bytes', t => {
  const profile = setup(t); prepareQaFirefox(profile, { env: PORTABLE_ENV });
  const filename = path.join(profile, QA_ISOLATION_MANIFEST), original = fs.readFileSync(filename);
  for (const name of QA_PORTABLE_TRANSFER_FILES) {
    const missing = JSON.parse(original); delete missing.files[name];
    fs.writeFileSync(filename, JSON.stringify(missing));
    assert.throws(() => validateQaFixtureIsolation(profile, { env: PORTABLE_ENV }), /mismatch/);
    const tampered = JSON.parse(original); tampered.files[name].originalSha256 = '0'.repeat(64);
    fs.writeFileSync(filename, JSON.stringify(tampered));
    assert.throws(() => validateQaFixtureIsolation(profile, { env: PORTABLE_ENV }), /mismatch/);
    fs.writeFileSync(filename, original);
    const copyPath = path.join(profile, 'chrome', name), bytes = fs.readFileSync(copyPath);
    fs.appendFileSync(copyPath, '\n// invalid QA copy\n');
    assert.throws(() => validateQaFixtureIsolation(profile, { env: PORTABLE_ENV }), /hash mismatch/);
    fs.writeFileSync(copyPath, bytes);
  }
  assert.ok(validateQaFixtureIsolation(profile, { env: PORTABLE_ENV }));
});

test('RunOutputs opt-in fingerprints exactly its two Chat presenters and three unchanged renderers', t => {
  assert.deepEqual(QA_RUN_OUTPUTS_FILES, ['resources/EGDeskChatRunResult.sys.mjs', 'resources/EGDeskChatChangeReview.sys.mjs',
    'resources/EGDeskRunResult.sys.mjs', 'resources/EGDeskDiffView.sys.mjs', 'resources/EGDeskChangeReview.mjs']);
  const before = Object.fromEntries(QA_RUN_OUTPUTS_FILES.map(name => [name, fs.readFileSync(path.join(overlay, name))]));
  const ordinary = setup(t); prepareQaFirefox(ordinary, { env: ENV });
  const ordinaryManifest = validateQaFixtureIsolation(ordinary, { env: ENV });
  for (const name of QA_RUN_OUTPUTS_FILES) assert.equal(ordinaryManifest.files[name], undefined);
  const profile = setup(t); prepareQaFirefox(profile, { env: RUN_OUTPUTS_ENV });
  const manifest = validateQaFixtureIsolation(profile, { env: RUN_OUTPUTS_ENV });
  assert.deepEqual(Object.keys(manifest.files).filter(name => !ordinaryManifest.files[name]), QA_RUN_OUTPUTS_FILES);
  for (const name of QA_RUN_OUTPUTS_FILES) {
    assert.deepEqual(manifest.files[name], { originalSha256: hash(before[name]), transformedSha256: hash(before[name]),
      replacements: { endpointUrls: 0, helperPortConstants: 0 } });
    assert.deepEqual(fs.readFileSync(path.join(profile, 'chrome', name)), before[name]);
    assert.deepEqual(fs.readFileSync(path.join(overlay, name)), before[name], 'product module bytes must remain unchanged');
  }
  assert.equal(manifest.files[QA_PROJECT_PICKER_FILE].projectPickerTransform, undefined);
  assert.deepEqual(materializeQaFixtureIsolation(profile, { env: RUN_OUTPUTS_ENV }), manifest);
  assert.throws(() => validateQaFixtureIsolation(profile, { env: ENV }), /mismatch/);
});

test('RunOutputs invalid/mixed gates fail before profile preferences, overlay copies or provenance writes', t => {
  const profile = setup(t);
  const writes = ['writeFileSync', 'renameSync', 'cpSync'].map(method => t.mock.method(fs, method, () => {
    throw new Error('A profile write must not precede mode validation');
  }));
  for (const patch of [{ EGDESK_QA_RUN_OUTPUTS_FIXTURE: 'yes' }, { EGDESK_QA_REAL_TURN: '1' },
    { EGDESK_QA_REAL_TURN: undefined }, { EGDESK_QA_FIXTURE_TRANSPORT: '0' },
    { EGDESK_QA_PROJECT_FILE_FIXTURE: '1' }, { EGDESK_QA_CLAUDE_FIXTURE: '1' }]) {
    const env = { ...RUN_OUTPUTS_ENV, ...patch };
    assert.throws(() => qaBridgeConfig(env), /fixture|isolated|Run outputs/i);
    assert.throws(() => prepareQaFirefox(profile, { env }), /fixture|isolated|Run outputs/i);
    assert.throws(() => materializeQaFixtureIsolation(profile, { env }), /fixture|isolated|Run outputs/i);
  }
  for (const spy of writes) { assert.equal(spy.mock.callCount(), 0); spy.mock.restore(); }
  assert.equal(fs.existsSync(path.join(profile, QA_ISOLATION_MANIFEST)), false);
});

test('RunOutputs missing/tampered copies or manifest entries fail closed for every required module', t => {
  const profile = setup(t); prepareQaFirefox(profile, { env: RUN_OUTPUTS_ENV });
  const manifestFile = path.join(profile, QA_ISOLATION_MANIFEST), manifestBytes = fs.readFileSync(manifestFile);
  const manifest = JSON.parse(manifestBytes);
  for (const name of QA_RUN_OUTPUTS_FILES) {
    const file = path.join(profile, 'chrome', name), original = fs.readFileSync(file);
    fs.unlinkSync(file);
    assert.throws(() => validateQaFixtureIsolation(profile, { env: RUN_OUTPUTS_ENV }), /ENOENT|missing/);
    fs.writeFileSync(file, Buffer.concat([original, Buffer.from('\n// changed owned QA copy\n')]), { mode: 0o600 });
    assert.throws(() => validateQaFixtureIsolation(profile, { env: RUN_OUTPUTS_ENV }), /hash mismatch/);
    fs.writeFileSync(file, original);
    for (const mutate of [value => { delete value.files[name]; },
      value => { value.files[name].originalSha256 = '0'.repeat(64); },
      value => { value.files[name].transformedSha256 = '0'.repeat(64); }]) {
      const changed = structuredClone(manifest); mutate(changed); fs.writeFileSync(manifestFile, JSON.stringify(changed));
      assert.throws(() => validateQaFixtureIsolation(profile, { env: RUN_OUTPUTS_ENV }), /mismatch/);
    }
    fs.writeFileSync(manifestFile, manifestBytes);
    assert.deepEqual(fs.readFileSync(path.join(overlay, name)), original);
  }
  assert.deepEqual(validateQaFixtureIsolation(profile, { env: RUN_OUTPUTS_ENV }), manifest);
});

test('RunOutputs linked or missing copies reject materialization before even endpoint rewrites', t => {
  const profile = setup(t); prepareQaFirefox(profile, { env: {} });
  const surface = path.join(profile, 'chrome', 'JS/eg-desk-surface.uc.js'), surfaceBytes = fs.readFileSync(surface);
  for (const name of QA_RUN_OUTPUTS_FILES) {
    const file = path.join(profile, 'chrome', name), parked = path.join(profile, path.basename(name));
    fs.renameSync(file, parked);
    assert.throws(() => materializeQaFixtureIsolation(profile, { env: RUN_OUTPUTS_ENV }), /ENOENT|missing/);
    fs.symlinkSync(parked, file);
    assert.throws(() => materializeQaFixtureIsolation(profile, { env: RUN_OUTPUTS_ENV }), /linked|noncanonical/);
    fs.unlinkSync(file); fs.linkSync(parked, file);
    assert.throws(() => materializeQaFixtureIsolation(profile, { env: RUN_OUTPUTS_ENV }), /linked|noncanonical/);
    fs.unlinkSync(file); fs.renameSync(parked, file);
    assert.deepEqual(fs.readFileSync(surface), surfaceBytes);
    assert.equal(fs.existsSync(path.join(profile, QA_ISOLATION_MANIFEST)), false);
  }
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
