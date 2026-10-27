import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import childProcess from 'node:child_process';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Readable } from 'node:stream';
import nodeTest from 'node:test';
import { createPortableTransferFixture, portableTransferFixtureEnabled, assertPortableBoardCatalogSeed } from './egdesk-portable-transfer-fixture.mjs';
import { bootstrapQaProfile, canonicalTempRoot, LOADER_FILES } from './egdesk-chat-qa-profile.mjs';
import { createPrivateQaTempDirectory } from './egdesk-qa-platform.mjs';
import { boardToJsonCanvas } from '../helper/egdesk-json-canvas.mjs';
import { PERSONALITY_LIMITS } from '../helper/egdesk-profile-store.mjs';

const TOKEN = 'owned-portable-transfer-unit-token';
const ENV = { EGDESK_QA_PORTABLE_TRANSFER_FIXTURE: '1', EGDESK_QA_FIXTURE_TRANSPORT: '1',
  EGDESK_QA_REAL_TURN: '0', EGDESK_QA_FIXTURE_PORT: '49318' };
const sha256 = value => createHash('sha256').update(value).digest('hex');
const ACTIVE_DRAFT = { EGDESK_QA_PORTABLE_TRANSFER_PROFILE_VERSION: 'head3-active2' };
// Apart from the explicit Windows guard, tests here need the unsupported fixture.
const test = (name, fn) => nodeTest(name,
  { skip: process.platform === 'win32' ? 'portable fixture is not enabled on Windows' : false }, fn);

function setup(t, env = {}, { makeFixture = createPortableTransferFixture, onDirectory = () => {} } = {}) {
  const tempRoot = canonicalTempRoot(), directories = [];
  const prefixes = new Set(['egdesk-portable-loader-', 'egdesk-chat-test-', 'egdesk-portable-transfer-']);
  let fixture;
  const track = (directory, prefix) => {
    if (directories.some(item => item.directory === directory)) return;
    assert.equal(path.dirname(directory), tempRoot);
    assert.ok(path.basename(directory).startsWith(prefix));
    const info = fs.lstatSync(directory);
    assert.ok(info.isDirectory() && !info.isSymbolicLink());
    directories.push({ directory, prefix, dev: info.dev, ino: info.ino });
    onDirectory(directory, prefix);
  };
  // Register before any allocation, including ones whose constructors throw.
  t.after(() => {
    try { fixture?.dispose(); } finally {
      for (const { directory, prefix, dev, ino } of directories.slice().reverse()) {
        const info = fs.lstatSync(directory, { throwIfNoEntry: false });
        if (!info) continue;
        assert.equal(path.dirname(directory), tempRoot);
        assert.ok(path.basename(directory).startsWith(prefix));
        assert.ok(info.isDirectory() && !info.isSymbolicLink() && info.dev === dev && info.ino === ino);
        assert.equal(fs.realpathSync.native(directory), directory);
        fs.rmSync(directory, { recursive: true });
      }
    }
  });
  // POSIX temp creation can succeed inside a constructor that later throws.
  const mkdtemp = fs.mkdtempSync;
  const capture = t.mock.method(fs, 'mkdtempSync', function(prefix, ...options) {
    const directory = mkdtemp.call(fs, prefix, ...options);
    if (typeof prefix === 'string' && path.dirname(prefix) === tempRoot && prefixes.has(path.basename(prefix))) {
      track(directory, path.basename(prefix));
    }
    return directory;
  });
  try {
    const loader = createPrivateQaTempDirectory('egdesk-portable-loader-');
    track(loader, 'egdesk-portable-loader-');
    for (const name of LOADER_FILES) fs.writeFileSync(path.join(loader, name), `unit loader ${name}\n`, { mode: 0o600 });
    const { profile } = bootstrapQaProfile({ loaderSource: loader });
    track(profile, 'egdesk-chat-test-');
    fixture = makeFixture({ profile, token: TOKEN, env: { ...ENV, ...env } });
    track(fixture.snapshot().root, 'egdesk-portable-transfer-');
    return fixture;
  } finally { capture.mock.restore(); }
}

test('setup cleans only owned temp directories after failures at every allocation stage', t => {
  for (const [stage, expected] of [['loader-write', 1], ['profile-write', 2], ['fixture-validation', 2],
    ['fixture-mkdir', 3], ['snapshot', 3]]) {
    const cleanup = [], directories = [];
    const context = { after: callback => cleanup.push(callback), mock: t.mock };
    const options = { onDirectory: directory => directories.push(directory) };
    let injected, disposed = 0;
    if (stage === 'loader-write' || stage === 'profile-write') {
      const write = fs.writeFileSync;
      injected = t.mock.method(fs, 'writeFileSync', function(file, ...args) {
        if (stage === 'loader-write' && directories[0] && path.dirname(file) === directories[0]
            || stage === 'profile-write' && path.basename(file) === '.egdesk-dedicated-firefox-profile') {
          throw new Error(`injected ${stage}`);
        }
        return write.call(fs, file, ...args);
      });
    } else if (stage === 'fixture-mkdir') {
      const mkdir = fs.mkdirSync;
      injected = t.mock.method(fs, 'mkdirSync', function(directory, ...args) {
        if (path.basename(directory) === 'store' && path.basename(path.dirname(directory)).startsWith('egdesk-portable-transfer-')) {
          throw new Error(`injected ${stage}`);
        }
        return mkdir.call(fs, directory, ...args);
      });
    } else if (stage === 'snapshot') {
      options.makeFixture = args => {
        const real = createPortableTransferFixture(args);
        return { ...real, snapshot() { throw new Error('injected snapshot'); },
          dispose() { disposed++; real.dispose(); } };
      };
    }
    try {
      const env = stage === 'fixture-validation' ? { EGDESK_QA_FIXTURE_PORT: '39218' } : {};
      assert.throws(() => setup(context, env, options), stage === 'fixture-validation' ? /FIXTURE_PORT/ : /injected/);
    } finally {
      injected?.mock.restore();
      assert.equal(cleanup.length, 1);
      for (const callback of cleanup) callback();
    }
    assert.equal(directories.length, expected, stage);
    for (const directory of directories) assert.equal(fs.existsSync(directory), false, stage);
    if (stage === 'snapshot') assert.equal(disposed, 1);
  }
});

test('cleanup refuses a replaced directory and removes the original only after its identity is restored', t => {
  const cleanup = [], directories = [];
  const context = { after: callback => cleanup.push(callback), mock: t.mock };
  setup(context, {}, { onDirectory: directory => directories.push(directory) });
  const root = directories.at(-1), lstat = fs.lstatSync;
  const changed = t.mock.method(fs, 'lstatSync', function(directory, ...args) {
    const info = lstat.call(fs, directory, ...args);
    return directory === root ? { ...info, ino: info.ino + 1,
      isDirectory: () => info.isDirectory(), isSymbolicLink: () => info.isSymbolicLink() } : info;
  });
  try {
    assert.throws(() => cleanup[0]());
    assert.equal(fs.existsSync(root), true);
  } finally {
    changed.mock.restore();
    cleanup[0]();
  }
  for (const directory of directories) assert.equal(fs.existsSync(directory), false);
});

// In-memory HTTP request/response streams only: never a server or socket.
async function request(fixture, method, route, body, options = {}) {
  const bytes = body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))];
  const req = Readable.from(options.chunks ?? bytes);
  Object.assign(req, { method, url: route, socket: { remoteAddress: options.remoteAddress || '127.0.0.1' },
    headers: { host: '127.0.0.1:49318', ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(options.token ? { 'x-egdesk-qa-token': TOKEN } : {}), ...options.headers } });
  let status, text, endCount = 0;
  const headers = {};
  const res = { setHeader(key, value) { headers[key.toLowerCase()] = value; },
    writeHead(value, supplied) { status = value; for (const [key, content] of Object.entries(supplied || {})) headers[key.toLowerCase()] = content; },
    end(value) { text = value === undefined ? '' : String(value); endCount++; } };
  const handled = await fixture.handle(req, res, options.suppliedUrl);
  assert.ok(endCount <= 1, 'one real handler response, not a replaced success plus an error');
  return { handled, status, headers, text, body: text ? JSON.parse(text) : undefined };
}

function profileTables(state) {
  const db = new DatabaseSync(state.databases.profiles, { readOnly: true });
  try {
    // Include any binding/auxiliary tables, not just the fixture's public projection.
    return Object.fromEntries(db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all().map(({ name }) => [name, db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all().map(row => ({ ...row }))]));
  } finally { db.close(); }
}

function assertDraftTrace(trace, payload, response, before, after) {
  const raw = typeof payload === 'string' ? payload : JSON.stringify(payload);
  assert.deepEqual([trace.method, trace.delegated, trace.status], ['PUT', true, response.status]);
  assert.equal(trace.requestBytes, Buffer.byteLength(raw));
  assert.equal(trace.requestSha256, sha256(raw));
  assert.equal(trace.requestTruncated, false);
  if (typeof payload !== 'string') assert.deepEqual(trace.request, payload, 'trace retains the actual supplied body, not a normalized reconstruction');
  assert.deepEqual(trace.response, response.body); assert.equal(trace.responseSha256, sha256(response.text));
  assert.deepEqual(trace.before, before.persisted); assert.deepEqual(trace.after, after.persisted);
}

nodeTest('Windows keeps the no-process portable fixture lane disabled before export evidence',
  { skip: process.platform !== 'win32' }, t => {
    assert.equal(process.getuid, undefined);
    const loader = createPrivateQaTempDirectory('egdesk-portable-loader-');
    t.after(() => {
      assert.equal(path.dirname(loader), canonicalTempRoot());
      assert.equal(fs.realpathSync.native(loader), loader);
      fs.rmSync(loader, { recursive: true });
    });
    for (const name of LOADER_FILES) fs.writeFileSync(path.join(loader, name), `unit loader ${name}\n`, { mode: 0o600 });
    const { profile } = bootstrapQaProfile({ loaderSource: loader });
    t.after(() => {
      assert.equal(path.dirname(profile), canonicalTempRoot());
      assert.equal(fs.realpathSync.native(profile), profile);
      fs.rmSync(profile, { recursive: true });
    });
    const prefs = path.join(profile, 'prefs.js');
    assert.equal(fs.existsSync(prefs), false);
    assert.throws(() => createPortableTransferFixture({ profile, token: TOKEN, env: ENV }),
      /Portable fixture no-process lane is not enabled on Windows/);
    assert.equal(fs.existsSync(prefs), false);
  });

test('explicit exclusive opt-in, canonical marked profile and token are checked before new fixture writes', t => {
  const fixture = setup(t), profile = fixture.snapshot().profile;
  const invalid = [{}, { ...ENV, EGDESK_QA_PORTABLE_TRANSFER_FIXTURE: '0' },
    { ...ENV, EGDESK_QA_PORTABLE_TRANSFER_FIXTURE: 'true' }, { ...ENV, EGDESK_QA_REAL_TURN: '1' },
    { ...ENV, EGDESK_QA_FIXTURE_TRANSPORT: '0' }, { ...ENV, EGDESK_QA_FIXTURE_PORT: '39218' },
    { ...ENV, EGDESK_QA_FIXTURE_PORT: undefined }, { ...ENV, EGDESK_QA_FIXTURE_PORT: '65536' },
    { ...ENV, EGDESK_QA_PORTABLE_TRANSFER_PROFILE_VERSION: 'head4-active2' },
    ...['EGDESK_QA_PROJECT_FILE_FIXTURE', 'EGDESK_QA_CLAUDE_FIXTURE', 'EGDESK_QA_RUN_OUTPUTS_FIXTURE',
      'EGDESK_QA_READER_FIXTURE', 'EGDESK_QA_BROWSER_NEGATIVE', 'EGDESK_QA_BROWSER_RELAY']
      .map(key => ({ ...ENV, [key]: '1' }))];
  const mkdir = t.mock.method(fs, 'mkdtempSync', () => assert.fail('validation must happen before temp creation'));
  try {
    for (const env of invalid) assert.throws(() => createPortableTransferFixture({ profile, token: TOKEN, env }));
    assert.throws(() => createPortableTransferFixture({ profile, token: 'short', env: ENV }));
    assert.throws(() => createPortableTransferFixture({ profile, token: TOKEN, env: { ...ENV, EGDESK_QA_FIXTURE_TOKEN: 'different-canonical-token' } }));
    assert.throws(() => createPortableTransferFixture({ profile: path.dirname(profile), token: TOKEN, env: ENV }));
    assert.equal(mkdir.mock.callCount(), 0);
  } finally { mkdir.mock.restore(); }
  assert.equal(portableTransferFixtureEnabled({}), false);
  assert.equal(portableTransferFixtureEnabled(ENV), true);
});

test('import and factory launch no listener, native process, provider or OS picker', async t => {
  const spies = [t.mock.method(net.Server.prototype, 'listen', () => assert.fail('no listener')),
    ...['spawn', 'spawnSync', 'execFile', 'execFileSync'].map(name => t.mock.method(childProcess, name, () => assert.fail('no native process')))];
  await import(`./egdesk-portable-transfer-fixture.mjs?no-side-effects=${Date.now()}`);
  const fixture = setup(t), state = fixture.snapshot();
  assert.deepEqual(Object.keys(fixture).sort(), ['dispose', 'handle', 'snapshot']);
  assert.deepEqual([state.providerTurns, state.nativePickerInvocations, state.nativeProcessSpawns], [0, 0, 0]);
  assert.equal(path.dirname(state.root), canonicalTempRoot());
  assert.equal(fs.readFileSync(state.seed.importPath, 'utf8'), state.seed.importText);
  assert.equal(state.currentImportSha256, state.seed.importSha256);
  assert.equal(state.persisted.profiles.records.length, 1);
  assert.deepEqual(state.persisted.profiles.revisions.map(row => row.revision), [1, 2]);
  assert.ok(state.persisted.profiles.records.every(row => row.active_revision === null && row.lifecycle === 'draft'));
  assert.equal(state.persisted.desk.boards.length, 1);
  assert.equal(state.persisted.desk.boards[0].head_revision, 1);
  assert.equal(state.persisted.desk.generations.length, 1);
  assert.equal(state.seed.deskGeneration, 1);
  assert.deepEqual(fs.readdirSync(state.exportsDir), [], 'fixture does not fake a native export-file write');
  for (const spy of spies) assert.equal(spy.mock.callCount(), 0);
});

test('prelaunch catalog is the exact real saved Board, provenance is explicit and tampering is refused', t => {
  const fixture = setup(t), state = fixture.snapshot();
  assert.equal(assertPortableBoardCatalogSeed(state), true);
  assert.equal(state.catalogSeed.coherentBeforeLaunch, true);
  assert.equal(state.catalogSeed.setupOnly, true);
  assert.equal(state.catalogSeed.sqliteRevision, 1);
  assert.equal(state.catalogSeed.boardId, state.seed.boardId);
  const changed = structuredClone(state);
  changed.persisted.desk.revisions[0].body_json = JSON.stringify({ agenda: { id: state.seed.boardId }, cards: [] });
  assert.throws(() => assertPortableBoardCatalogSeed(changed), /same content/);
  fs.appendFileSync(state.catalogSeed.path, '// altered before launch\n');
  assert.throws(() => assertPortableBoardCatalogSeed(state), /bytes changed/);
  const mkdir = t.mock.method(fs, 'mkdtempSync', () => assert.fail('No second fixture or active-profile writes'));
  assert.throws(() => createPortableTransferFixture({ profile: state.profile, token: TOKEN, env: ENV }), /new unused profile/);
  assert.equal(mkdir.mock.callCount(), 0);
});

test('owned picker result queue returns only confirmed DTOs/cancel without performing file IO or profile writes', async t => {
  const fixture = setup(t), before = fixture.snapshot();
  const control = body => request(fixture, 'POST', '/__qa/portable-transfer/control', body, { token: true });
  const pick = body => request(fixture, 'POST', '/__qa/portable-transfer/picker', body);
  assert.equal((await pick({ kind: 'open', accept: '.md' })).status, 409);
  assert.equal((await control({ operation: 'queue-picker', kind: 'open', result: 'cancel' })).status, 200);
  assert.equal((await pick({ kind: 'open', accept: '.md' })).body.result.cancelled, true);
  assert.equal((await control({ operation: 'queue-picker', kind: 'open', result: 'input' })).status, 200);
  assert.equal((await pick({ kind: 'open', accept: '.txt' })).status, 400);
  const opened = await pick({ kind: 'open', accept: '.md' });
  assert.deepEqual(opened.body.result, { path: before.seed.importPath, filename: before.seed.importFilename });
  assert.equal(opened.body.synthetic, true);
  assert.equal((await pick({ kind: 'open', accept: '.md' })).status, 409, 'a selection is consumed once');
  assert.equal((await control({ operation: 'queue-picker', kind: 'save', result: 'path', filename: 'owned-result.canvas' })).status, 200);
  const saved = await pick({ kind: 'save', fileName: 'Suggested.canvas', contentType: 'application/json; charset=utf-8' });
  assert.deepEqual(saved.body.result, { path: path.join(before.exportsDir, 'owned-result.canvas'), filename: 'owned-result.canvas' });
  assert.equal(fs.existsSync(saved.body.result.path), false, 'picker result cannot stand in for the real native write');
  assert.deepEqual(fixture.snapshot().persisted, before.persisted);
  assert.deepEqual(fixture.snapshot().exports, []);
  assert.equal(fixture.snapshot().currentImportSha256, before.seed.importSha256);
});

test('portable controls reject arbitrary paths, body injection, wrong token/origin and unowned replace results', async t => {
  const fixture = setup(t), before = fixture.snapshot(), route = '/__qa/portable-transfer/control';
  const queue = { operation: 'queue-picker', kind: 'save', result: 'path', filename: 'owned.md' };
  assert.equal((await request(fixture, 'POST', route, queue)).status, 403);
  assert.equal((await request(fixture, 'POST', route, queue, { token: true, headers: { origin: 'https://outside.invalid' } })).status, 403);
  for (const body of [{ ...queue, filename: '../outside.md' }, { ...queue, path: '/outside.md' },
    { ...queue, text: 'injected output' }, { ...queue, result: 'replace' }, { operation: 'replace-http-response', result: {} },
    { operation: 'advance-profile-head', expectedHeadRevision: 2, instructions: 'injected' }]) {
    assert.ok((await request(fixture, 'POST', route, body, { token: true })).status >= 400);
  }
  const filename = path.join(before.exportsDir, queue.filename);
  fs.writeFileSync(filename, 'owned existing bytes\n', { flag: 'wx', mode: 0o600 });
  const hash = sha256(fs.readFileSync(filename));
  assert.equal((await request(fixture, 'POST', route, { ...queue, result: 'replace' }, { token: true })).status, 200);
  const replaced = await request(fixture, 'POST', '/__qa/portable-transfer/picker',
    { kind: 'save', fileName: 'agent.md', contentType: 'text/markdown; charset=utf-8' });
  assert.equal(replaced.body.error, 'EEXIST'); assert.equal(replaced.body.result, undefined);
  assert.equal(sha256(fs.readFileSync(filename)), hash);
  assert.deepEqual(fixture.snapshot().persisted, before.persisted);
});

test('controlled new head uses real SQLite while the older visible revision export stays byte-pinned', async t => {
  const fixture = setup(t), before = fixture.snapshot(), seed = before.seed;
  const route = `/profiles/${seed.profileId}/export?format=md&revision=2`;
  const pinnedBefore = await request(fixture, 'GET', route);
  const advance = await request(fixture, 'POST', '/__qa/portable-transfer/control',
    { operation: 'advance-profile-head', expectedHeadRevision: 2 }, { token: true });
  assert.equal(advance.status, 200); assert.equal(advance.body.revision, 3);
  const after = fixture.snapshot();
  assert.deepEqual(after.persisted.profiles.records, before.persisted.profiles.records);
  assert.equal(after.persisted.profiles.revisions.length, before.persisted.profiles.revisions.length + 1);
  assert.equal(after.persisted.profiles.revisions.at(-1).revision, 3);
  assert.deepEqual(after.persisted.desk, before.persisted.desk);
  assert.deepEqual((await request(fixture, 'GET', route)).body, pinnedBefore.body);
  const latest = await request(fixture, 'GET', `/profiles/${seed.profileId}/export?format=md`);
  assert.equal(latest.body.revision, 3); assert.notEqual(latest.body.text, pinnedBefore.body.text);
  assert.equal((await request(fixture, 'POST', '/__qa/portable-transfer/control',
    { operation: 'advance-profile-head', expectedHeadRevision: 2 }, { token: true })).status, 400);
  assert.equal(fixture.snapshot().headAdvances.length, 1);
});

test('actual duplicate POST pins visible v2 at head v3 and records one new draft v1 without changing the original or exports', async t => {
  const fixture = setup(t), before = fixture.snapshot(), id = before.seed.profileId;
  assert.deepEqual(before.duplicateEvents, []);
  const exports = {};
  for (const format of ['md', 'codex-toml']) {
    exports[format] = await request(fixture, 'GET', `/profiles/${id}/export?format=${format}&revision=2`);
    assert.equal(exports[format].status, 200);
  }
  assert.equal((await request(fixture, 'POST', '/__qa/portable-transfer/control',
    { operation: 'advance-profile-head', expectedHeadRevision: 2 }, { token: true })).body.revision, 3);
  const original = await request(fixture, 'GET', `/profiles/${id}`), advanced = fixture.snapshot();
  assert.equal(original.body.headRevision, 3);
  const payload = { revision: 2 }; // The native duplicate button sends exactly this, not a replacement body.
  const route = `/profiles/${id}/duplicate`, copied = await request(fixture, 'POST', route, payload);
  assert.equal(copied.status, 201);
  assert.notEqual(copied.body.id, id);
  assert.deepEqual([copied.body.revision, copied.body.profile.headRevision, copied.body.profile.activeRevision,
    copied.body.profile.lifecycle, copied.body.profile.reviewRequired], [1, 1, null, 'draft', false]);
  const source = before.seed.revisions[1], name = `${source.body.name} 사본`;
  assert.deepEqual(copied.body.profile.head.body, { ...source.body, name });
  assert.deepEqual(copied.body.profile.source.map(({ at, ...entry }) => entry),
    [{ kind: 'duplicate', origin: 'user', profileId: id, revision: 2, hash: source.hash, name: source.body.name }]);
  const after = fixture.snapshot(), traces = after.requests.filter(row => row.method === 'POST' && row.path === route);
  assert.equal(traces.length, 1, 'one native POST must yield one real handler call and one copy');
  const trace = traces[0];
  assert.deepEqual([trace.delegated, trace.status, trace.request, trace.requestTruncated], [true, 201, payload, false]);
  assert.equal(Object.hasOwn(trace.request, 'name'), false, 'an omitted name is not synthesized into request evidence');
  assert.equal(trace.requestBytes, Buffer.byteLength(JSON.stringify(payload)));
  assert.equal(trace.requestSha256, sha256(JSON.stringify(payload)));
  assert.deepEqual(trace.response, copied.body); assert.equal(trace.responseSha256, sha256(copied.text));
  assert.deepEqual(trace.before, advanced.persisted); assert.deepEqual(trace.after, after.persisted);
  assert.deepEqual(after.duplicateEvents, [{ sequence: trace.sequence, sourceProfileId: id, sourceRevision: 2,
    sourceHash: source.hash, profileId: copied.body.id, revision: 1, hash: copied.body.hash, name,
    lifecycle: 'draft', activeRevision: null }]);
  const record = after.persisted.profiles.records.find(row => row.id === copied.body.id);
  const revision = after.persisted.profiles.revisions.find(row => row.profile_id === copied.body.id);
  assert.deepEqual([record.lifecycle, record.active_revision, revision.revision, revision.parent_revision], ['draft', null, 1, null]);
  assert.deepEqual(JSON.parse(record.source_json), copied.body.profile.source);
  assert.deepEqual(JSON.parse(revision.body_json), { ...source.body, name });
  assert.equal(revision.hash, copied.body.hash); assert.equal(revision.hash, sha256(revision.body_json));
  assert.deepEqual(after.persisted.profiles.records.filter(row => row.id !== copied.body.id), advanced.persisted.profiles.records);
  assert.deepEqual(after.persisted.profiles.revisions.filter(row => row.profile_id !== copied.body.id), advanced.persisted.profiles.revisions);
  assert.equal(after.persisted.profiles.records.length, advanced.persisted.profiles.records.length + 1);
  assert.equal(after.persisted.profiles.revisions.length, advanced.persisted.profiles.revisions.length + 1);
  assert.deepEqual((await request(fixture, 'GET', `/profiles/${id}`)).body, original.body);
  for (const format of ['md', 'codex-toml']) {
    assert.equal((await request(fixture, 'GET', `/profiles/${id}/export?format=${format}&revision=2`)).text, exports[format].text);
  }
  assert.deepEqual(after.persisted.desk, advanced.persisted.desk);
  assert.deepEqual(after.exports, before.exports); assert.deepEqual(after.seed, before.seed);
  assert.equal(after.currentImportSha256, before.currentImportSha256);
  assert.deepEqual(after.forbiddenPosts, []);
  assert.deepEqual([after.providerTurns, after.nativePickerInvocations, after.nativeProcessSpawns], [0, 0, 0]);
});

test('one explicitly armed malformed receipt follows actual creation and preserves the real receipt, source and SQLite', async t => {
  const fixture = setup(t), before = fixture.snapshot(), source = before.seed.revisions[1], id = before.seed.profileId;
  const target = { operation: 'arm-duplicate-receipt-fault', profileId: id, revision: 2, hash: source.hash };
  const armed = await request(fixture, 'POST', '/__qa/portable-transfer/control', target, { token: true });
  assert.equal(armed.status, 200); assert.equal(armed.body.state, 'armed');
  assert.deepEqual(fixture.snapshot().persisted, before.persisted);
  const copied = await request(fixture, 'POST', `/profiles/${id}/duplicate`, { revision: 2 });
  assert.equal(copied.status, 201); assert.equal(copied.body.profile, null);
  assert.equal(Number(copied.headers['content-length']), Buffer.byteLength(copied.text));
  const after = fixture.snapshot(), trace = after.requests.at(-1), real = trace.response;
  assert.equal(trace.delegated, true); assert.equal(trace.status, 201);
  assert.deepEqual(copied.body, { ...real, profile: null }); assert.equal(real.profile.id, copied.body.id);
  assert.deepEqual(real.profile.head.body, { ...source.body, name: `${source.body.name} 사본` });
  assert.equal(after.persisted.profiles.records.length, before.persisted.profiles.records.length + 1);
  assert.deepEqual(trace.before, before.persisted); assert.deepEqual(trace.after, after.persisted);
  assert.equal(trace.responseSha256, sha256(JSON.stringify(real)));
  assert.equal(trace.deliveredResponseSha256, sha256(copied.text));
  assert.notEqual(trace.responseSha256, trace.deliveredResponseSha256);
  assert.equal(after.duplicateEvents.length, 1); assert.equal(after.duplicateEvents[0].profileId, real.id);
  assert.equal(after.receiptFaults.length, 1); assert.equal(after.receiptFaults[0].synthetic, true);
  assert.equal(after.duplicateReceiptFault.state, 'consumed');
  assert.equal(after.duplicateReceiptFault.requestSequence, trace.sequence);
  assert.equal((await request(fixture, 'POST', '/__qa/portable-transfer/control', target, { token: true })).status, 409);
  const second = await request(fixture, 'POST', `/profiles/${id}/duplicate`, { revision: 2 });
  assert.equal(second.status, 201); assert.equal(second.body.profile.id, second.body.id, 'No second injected receipt fault');
  assert.equal(fixture.snapshot().receiptFaults.length, 1);
});

test('receipt fault requires the token, exact original identity/revision/hash and cannot affect other or failed replies', async t => {
  const fixture = setup(t), before = fixture.snapshot(), id = before.seed.profileId;
  const route = '/__qa/portable-transfer/control';
  const target = { operation: 'arm-duplicate-receipt-fault', profileId: id, revision: 2, hash: before.seed.revisions[1].hash };
  assert.equal((await request(fixture, 'POST', route, target)).status, 403);
  for (const changed of [{ ...target, profileId: 'other' }, { ...target, revision: '2' }, { ...target, revision: 0 },
    { ...target, hash: '0'.repeat(64) }, { ...target, response: {} }, { ...target, revision: 1 }]) {
    assert.ok((await request(fixture, 'POST', route, changed, { token: true })).status >= 400);
    assert.equal(fixture.snapshot().duplicateReceiptFault, null);
  }
  assert.deepEqual(fixture.snapshot().persisted, before.persisted);
  assert.equal((await request(fixture, 'POST', route, target, { token: true })).status, 200);
  const failed = await request(fixture, 'POST', `/profiles/${id}/duplicate`, { revision: 999 });
  assert.equal(failed.status, 404); assert.equal(failed.body.code, 'PROFILE_REVISION_NOT_FOUND');
  assert.equal(Number(failed.headers['content-length']), Buffer.byteLength(failed.text));
  const otherRevision = await request(fixture, 'POST', `/profiles/${id}/duplicate`, { revision: 1 });
  assert.equal(otherRevision.status, 201); assert.equal(otherRevision.body.profile.id, otherRevision.body.id);
  const otherProfile = await request(fixture, 'POST', `/profiles/${otherRevision.body.id}/duplicate`, { revision: 1 });
  assert.equal(otherProfile.status, 201); assert.equal(otherProfile.body.profile.id, otherProfile.body.id);
  assert.equal(fixture.snapshot().duplicateReceiptFault.state, 'armed');
  assert.deepEqual(fixture.snapshot().receiptFaults, []);
  assert.equal((await request(fixture, 'POST', `/profiles/${id}/duplicate`, { revision: 2 })).body.profile, null);
  assert.equal(fixture.snapshot().receiptFaults.length, 1);
});

test('concurrent real duplicate calls can consume the armed receipt fault only once', async t => {
  const fixture = setup(t), before = fixture.snapshot(), id = before.seed.profileId;
  await request(fixture, 'POST', '/__qa/portable-transfer/control', { operation: 'arm-duplicate-receipt-fault',
    profileId: id, revision: 2, hash: before.seed.revisions[1].hash }, { token: true });
  const results = await Promise.all([1, 2].map(() => request(fixture, 'POST', `/profiles/${id}/duplicate`, { revision: 2 })));
  assert.ok(results.every(row => row.status === 201));
  assert.equal(results.filter(row => row.body.profile === null).length, 1);
  assert.equal(fixture.snapshot().receiptFaults.length, 1); assert.equal(fixture.snapshot().duplicateEvents.length, 2);
});

test('duplicate optional name and omitted revision keep the actual store defaults and trace only supplied fields', async t => {
  const fixture = setup(t), before = fixture.snapshot(), route = `/profiles/${before.seed.profileId}/duplicate`;
  for (const payload of [{ name: 'Owned named copy' }, {}]) {
    const copied = await request(fixture, 'POST', route, payload);
    assert.equal(copied.status, 201);
    const source = before.seed.revisions[1], name = payload.name ?? `${source.body.name} 사본`;
    assert.deepEqual(copied.body.profile.head.body, { ...source.body, name });
    assert.deepEqual([copied.body.profile.source.at(-1).revision, copied.body.revision,
      copied.body.profile.lifecycle, copied.body.profile.activeRevision], [2, 1, 'draft', null]);
    const state = fixture.snapshot(), trace = state.requests.at(-1), event = state.duplicateEvents.at(-1);
    assert.deepEqual(trace.request, payload);
    assert.deepEqual([event.sequence, event.sourceRevision, event.name, event.profileId], [trace.sequence, 2, name, copied.body.id]);
  }
  const after = fixture.snapshot();
  assert.equal(after.duplicateEvents.length, 2);
  assert.equal(new Set(after.duplicateEvents.map(event => event.profileId)).size, 2, 'each POST invokes the real copy operation once');
  assert.deepEqual(after.persisted.profiles.revisions.filter(row => row.profile_id === before.seed.profileId), before.persisted.profiles.revisions);
  assert.deepEqual(after.persisted.desk, before.persisted.desk);
});

test('duplicate route, payload and owner-scope checks grant no extra parameters, account access or other mutations', async t => {
  const fixture = setup(t), before = fixture.snapshot(), id = before.seed.profileId, route = `/profiles/${id}/duplicate`;
  for (const [method, url] of [['GET', route], ['PUT', route], ['POST', `${route}/`], ['POST', `${route}/activate`],
    ['POST', `/profiles/${id}/revisions/2/duplicate`], ['POST', '/profiles/UPPER/duplicate'],
    ['POST', `/profiles/%70${id.slice(1)}/duplicate`], ['POST', `${route}?revision=2`],
    ['POST', `${route}?accountId=other`], ['POST', `${route}?allow=true`]]) {
    const blocked = await request(fixture, method, url, { revision: 2 }, { token: true });
    assert.deepEqual([blocked.status, blocked.body.code], [403, 'QA_PORTABLE_ROUTE_BLOCKED'], url);
    assert.equal(fixture.snapshot().requests.at(-1).delegated, false);
  }
  const cases = [
    [null, 400, 'INVALID_JSON'], [[], 400, 'INVALID_JSON'], ['{malformed', 400, 'INVALID_JSON'],
    [{ revision: '2' }, 400, 'INVALID_PROFILE_REVISION'], [{ revision: 0 }, 400, 'INVALID_PROFILE_REVISION'],
    [{ revision: 999 }, 404, 'PROFILE_REVISION_NOT_FOUND'], [{ revision: 2, name: '' }, 400, 'INVALID_PROFILE'],
    ...['accountId', 'ownerHash', 'profileId', 'body', 'activeRevision', 'activate', 'roomId', 'toolPreset', 'allow']
      .map(key => [{ revision: 2, [key]: 'not-a-grant' }, 400, 'PROFILE_HTTP_INPUT']),
  ];
  for (const [payload, status, code] of cases) {
    const blocked = await request(fixture, 'POST', route, payload, { token: true });
    assert.deepEqual([blocked.status, blocked.body.code], [status, code]);
    assert.equal(fixture.snapshot().requests.at(-1).delegated, true, 'the real HTTP/store validation owns payload errors');
  }
  for (const options of [{ headers: { host: 'evil.invalid' } }, { headers: { origin: 'https://evil.invalid' } },
    { headers: { 'sec-fetch-site': 'same-site' } }, { remoteAddress: '192.0.2.1' },
    { suppliedUrl: new URL(`http://127.0.0.1:49318/profiles/other/duplicate`) }]) {
    const blocked = await request(fixture, 'POST', route, { revision: 2 }, options);
    assert.deepEqual([blocked.status, blocked.body.code], [403, 'QA_LOOPBACK_REQUIRED']);
    assert.equal(fixture.snapshot().requests.at(-1).delegated, false);
  }
  const other = setup(t), otherBefore = other.snapshot();
  const foreign = await request(other, 'POST', route, { revision: 2 }, { token: true });
  assert.deepEqual([foreign.status, foreign.body.code], [404, 'PROFILE_NOT_FOUND']);
  assert.equal(other.snapshot().requests.at(-1).delegated, true, 'a valid foreign ID is resolved only in this fixture owner store');
  assert.deepEqual(other.snapshot().persisted, otherBefore.persisted);
  assert.deepEqual(other.snapshot().duplicateEvents, []);
  const after = fixture.snapshot();
  assert.deepEqual(after.persisted, before.persisted); assert.deepEqual(after.exports, before.exports);
  assert.deepEqual(after.duplicateEvents, []);
  assert.equal(after.forbiddenPosts.length, after.requests.filter(row => row.method === 'POST').length);
});

test('Desk readiness has an exact real initial generation; current reads and refused autosaves cannot change it or the Board', async t => {
  const fixture = setup(t), before = fixture.snapshot();
  assert.deepEqual(before.seed.deskState, { version: 1, savedAt: Date.parse('2026-10-25T00:00:00Z'),
    cards: [], shapes: [], qaMarker: `${before.seed.marker}_INITIAL_DESK` });
  assert.deepEqual(before.deskReadiness, { storeOpen: true, seedGeneration: 1, currentReads: 0 });
  const current = await request(fixture, 'GET', '/v1/desk/current');
  assert.equal(current.status, 200); assert.equal(current.body.generation, 1);
  assert.deepEqual(current.body.state, before.seed.deskState);
  assert.equal(current.body.stateHash, before.persisted.desk.generations[0].state_hash);
  assert.equal(fixture.snapshot().deskReadiness.currentReads, 1);
  assert.equal(fixture.snapshot().requests.at(-1).delegated, true);
  for (const [method, route, body] of [['PUT', '/v1/desk/current', { state: { cards: ['unwanted'] }, parentGeneration: 1 }],
    ['POST', '/v1/desk/import', { desk: {} }], ['POST', '/v1/desk/restore', { generation: 1 }]]) {
    assert.equal((await request(fixture, method, route, body)).status, 403);
  }
  await request(fixture, 'GET', `/v1/boards/${before.seed.boardId}/export?format=json-canvas`);
  assert.deepEqual(fixture.snapshot().persisted.desk, before.persisted.desk);
});

test('read-only Profile list/detail/revisions are actual saved SQLite records', async t => {
  const fixture = setup(t), before = fixture.snapshot(), id = before.seed.profileId;
  const listed = await request(fixture, 'GET', '/profiles');
  assert.equal(listed.status, 200); assert.equal(listed.body.profiles.length, 1);
  assert.equal(listed.body.profiles[0].id, id);
  const detail = await request(fixture, 'GET', `/profiles/${id}`);
  assert.equal(detail.status, 200); assert.equal(detail.body.headRevision, 2); assert.equal(detail.body.activeRevision, null);
  assert.equal(detail.body.head.body.instructions, before.seed.revisions[1].body.instructions);
  const revisions = await request(fixture, 'GET', `/profiles/${id}/revisions`);
  assert.deepEqual(revisions.body.revisions.map(row => row.revision), [2, 1]);
  const revision = await request(fixture, 'GET', `/profiles/${id}/revisions/1`);
  assert.equal(revision.body.hash, before.seed.revisions[0].hash);
  assert.deepEqual(fixture.snapshot().persisted, before.persisted);
  assert.ok(fixture.snapshot().requests.every(row => row.delegated && row.status === 200));
});

test('head3-active2 is an explicit setup-only seed; the default import/duplicate seed remains head2 draft', async t => {
  const fixture = setup(t, ACTIVE_DRAFT), before = fixture.snapshot(), id = before.seed.profileId;
  assert.equal(before.seed.profileVersion, 'head3-active2');
  const detail = await request(fixture, 'GET', `/profiles/${id}`);
  assert.deepEqual([detail.status, detail.body.headRevision, detail.body.activeRevision, detail.body.lifecycle], [200, 3, 2, 'active']);
  assert.deepEqual(detail.body.head.body, before.seed.revisions[2].body);
  assert.deepEqual(detail.body.active.body, before.seed.revisions[1].body);
  assert.notDeepEqual(detail.body.head.body, detail.body.active.body);
  assert.deepEqual(before.persisted.profiles.revisions.map(row => [row.revision, row.parent_revision]), [[1, null], [2, 1], [3, 2]]);
  assert.deepEqual(before.initial, before.persisted);
  assert.deepEqual(before.headAdvances, []);
  assert.equal((await request(fixture, 'POST', '/__qa/portable-transfer/control',
    { operation: 'advance-profile-head', expectedHeadRevision: 2 }, { token: true })).status, 400);
  assert.equal((await request(fixture, 'POST', `/profiles/${id}/activate`, { revision: 3, expectedActiveRevision: 2 })).status, 403);
  assert.deepEqual(fixture.snapshot().persisted, before.persisted);
  const original = setup(t).snapshot();
  assert.equal(original.seed.profileVersion, 'head2-draft');
  assert.deepEqual(original.seed.revisions.map(row => row.revision), [1, 2]);
  assert.deepEqual([original.persisted.profiles.records[0].active_revision, original.persisted.profiles.records[0].lifecycle], [null, 'draft']);
});

test('ephemeral HTTP draft PUT appends one real revision; GET, SQLite and evidence agree without changing active/past/other rows or exports', async t => {
  let fixture;
  const server = http.createServer(async (req, res) => {
    if (!await fixture.handle(req, res)) { res.writeHead(404); res.end(); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const port = server.address().port, origin = `http://127.0.0.1:${port}`;
  fixture = setup(t, { ...ACTIVE_DRAFT, EGDESK_QA_FIXTURE_PORT: String(port) });
  const send = async (method, route, payload, headers = {}) => {
    const response = await fetch(origin + route, { method, headers: { 'content-type': 'application/json', ...headers },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) });
    const text = await response.text();
    return { status: response.status, headers: Object.fromEntries(response.headers), text, body: text ? JSON.parse(text) : undefined };
  };
  const state = fixture.snapshot(), id = state.seed.profileId, route = `/profiles/${id}/draft`;
  const preflight = await send('OPTIONS', route, undefined, { origin: 'chrome://browser', 'access-control-request-method': 'PUT',
    'access-control-request-headers': 'content-type' });
  assert.equal(preflight.status, 204); assert.equal(preflight.text, '');
  assert.equal(preflight.headers['access-control-allow-origin'], 'chrome://browser');
  assert.equal(preflight.headers['access-control-allow-methods'], 'PUT, OPTIONS');
  assert.equal(fixture.snapshot().requests.at(-1).delegated, false, 'only this sidecar answers preflight');
  assert.equal((await send('POST', '/profiles/import', { text: state.seed.importText, filename: state.seed.importFilename })).status, 201);
  assert.equal((await send('POST', `/profiles/${id}/duplicate`, { revision: 2 })).status, 201);
  const pins = {};
  for (const revision of [1, 2, 3]) for (const format of ['md', 'codex-toml']) {
    const path = `/profiles/${id}/export?format=${format}&revision=${revision}`;
    pins[path] = (await send('GET', path)).text;
  }
  // Pre-existing file sentinel only, not a claim about native UI export IO.
  fs.writeFileSync(path.join(state.exportsDir, 'before-draft.md'), 'Owned pre-existing export bytes\n', { flag: 'wx', mode: 0o600 });
  const detail = await send('GET', `/profiles/${id}`), before = fixture.snapshot(), tablesBefore = profileTables(before);
  const payload = { body: { ...detail.body.head.body, personality: { ...detail.body.head.body.personality,
    examples: [{ user: ' 오늘 할 일? ', reply: '첫 번째 일을 정리해요.\r\n다음으로 확인해요.' }], avoid: [' 절대로 확실해 '] } }, expectedRevision: 3 };
  const saved = await send('PUT', route, payload, { origin: 'chrome://browser' }), after = fixture.snapshot();
  assert.deepEqual([saved.status, saved.body.id, saved.body.revision, saved.body.unchanged], [200, id, 4, false]);
  const trace = after.requests.at(-1);
  assertDraftTrace(trace, payload, saved, before, after);
  assert.equal(after.requests.filter(row => row.method === 'PUT').length, 1);
  const fetched = await send('GET', `/profiles/${id}`);
  assert.equal(fetched.status, 200); assert.deepEqual(fetched.body, saved.body.profile);
  assert.deepEqual([fetched.body.headRevision, fetched.body.activeRevision, fetched.body.lifecycle], [4, 2, 'active']);
  assert.deepEqual(fetched.body.active, detail.body.active);
  assert.deepEqual(fetched.body.head.body, { ...payload.body, personality: { ...payload.body.personality,
    examples: [{ user: '오늘 할 일?', reply: '첫 번째 일을 정리해요.\n다음으로 확인해요.' }], avoid: ['절대로 확실해'] } });
  const added = after.persisted.profiles.revisions.filter(row => row.profile_id === id && row.revision === 4);
  assert.equal(added.length, 1); assert.equal(added[0].parent_revision, 3);
  assert.equal(added[0].hash, saved.body.hash); assert.equal(added[0].hash, sha256(added[0].body_json));
  assert.deepEqual(JSON.parse(added[0].body_json), fetched.body.head.body);
  assert.deepEqual(after.persisted.profiles.records, before.persisted.profiles.records);
  assert.deepEqual(after.persisted.profiles.revisions.filter(row => row.profile_id !== id || row.revision !== 4), before.persisted.profiles.revisions);
  const tablesAfter = profileTables(after);
  assert.equal(tablesAfter.profile_revisions.length, tablesBefore.profile_revisions.length + 1);
  tablesAfter.profile_revisions = tablesAfter.profile_revisions.filter(row => row.profile_id !== id || row.revision !== 4);
  const originalRecord = tablesBefore.profiles.find(row => row.id === id), changedRecord = tablesAfter.profiles.find(row => row.id === id);
  assert.ok(changedRecord.updated_at >= originalRecord.updated_at, 'only the real draft-save timestamp may advance');
  changedRecord.updated_at = originalRecord.updated_at;
  assert.deepEqual(tablesAfter, tablesBefore, 'all old profile rows and any binding/auxiliary tables are preserved');
  assert.deepEqual(after.persisted.desk, before.persisted.desk);
  for (const key of ['exports', 'seed', 'catalogSeed', 'currentImportSha256', 'duplicateEvents', 'pickerResults', 'headAdvances', 'forbiddenPosts']) {
    assert.deepEqual(after[key], before[key]);
  }
  for (const [path, text] of Object.entries(pins)) assert.equal((await send('GET', path)).text, text);
  assert.deepEqual([after.providerTurns, after.nativePickerInvocations, after.nativeProcessSpawns], [0, 0, 0]);
});

test('unchanged and exact retry saves add no revision; stale changed body returns real 409 without overwriting head or active', async t => {
  const fixture = setup(t, ACTIVE_DRAFT), seed = fixture.snapshot().seed, route = `/profiles/${seed.profileId}/draft`;
  const original = { body: seed.revisions[2].body, expectedRevision: 3 }, before = fixture.snapshot();
  const unchanged = await request(fixture, 'PUT', route, original);
  assert.deepEqual([unchanged.status, unchanged.body.revision, unchanged.body.unchanged], [200, 3, true]);
  assertDraftTrace(fixture.snapshot().requests.at(-1), original, unchanged, before, before);
  assert.deepEqual(fixture.snapshot().persisted, before.persisted);
  const payload = { ...original, body: { ...original.body, personality: { ...original.body.personality, avoid: ['Changed once'] } } };
  const saved = await request(fixture, 'PUT', route, payload), changed = fixture.snapshot();
  assert.deepEqual([saved.status, saved.body.revision, saved.body.unchanged], [200, 4, false]);
  for (const expectedRevision of [4, 3]) {
    const retry = { ...payload, expectedRevision }, response = await request(fixture, 'PUT', route, retry);
    assert.deepEqual([response.status, response.body.revision, response.body.unchanged], [200, 4, true]);
    assertDraftTrace(fixture.snapshot().requests.at(-1), retry, response, changed, changed);
  }
  const stale = await request(fixture, 'PUT', route, original), after = fixture.snapshot();
  assert.deepEqual([stale.status, stale.body.code, stale.body.headRevision, stale.body.activeRevision], [409, 'PROFILE_REVISION_CONFLICT', 4, 2]);
  assertDraftTrace(after.requests.at(-1), original, stale, changed, changed);
  assert.deepEqual(after.persisted, changed.persisted);
  assert.deepEqual((await request(fixture, 'GET', `/profiles/${seed.profileId}`)).body, saved.body.profile);
  assert.deepEqual(after.forbiddenPosts, [], 'legacy POST evidence is not repurposed for PUT');
});

test('draft invalid shapes and oversized bodies are handled by real validation, fully evidenced when bounded, and add no revision', async t => {
  const fixture = setup(t, ACTIVE_DRAFT), before = fixture.snapshot(), route = `/profiles/${before.seed.profileId}/draft`;
  const payload = { body: before.seed.revisions[2].body, expectedRevision: 3 };
  const cases = [null, [], '{malformed', {}, { body: payload.body }, { expectedRevision: 3 },
    { ...payload, body: null }, { ...payload, body: [] }, { ...payload, expectedRevision: '3' }, { ...payload, expectedRevision: 0 },
    ...['accountId', 'ownerHash', 'profileId', 'activeRevision', 'activate', 'roomId', 'toolPreset']
      .map(key => ({ ...payload, [key]: 'not-a-grant' }))];
  for (const body of cases) {
    const response = await request(fixture, 'PUT', route, body), after = fixture.snapshot();
    assert.equal(response.status, 400, JSON.stringify(body));
    assertDraftTrace(after.requests.at(-1), body, response, before, before);
    assert.deepEqual(after.persisted, before.persisted);
  }
  for (const size of [65536, 140 * 1024]) {
    const body = { ...payload, body: { ...payload.body, instructions: 'x'.repeat(size) } }, raw = JSON.stringify(body);
    const response = await request(fixture, 'PUT', route, raw), after = fixture.snapshot(), trace = after.requests.at(-1);
    assert.deepEqual([response.status, response.body.code], [413, 'BODY_TOO_LARGE']);
    assert.equal(trace.delegated, true); assert.equal(trace.requestBytes, Buffer.byteLength(raw));
    assert.equal(trace.requestSha256, sha256(raw)); assert.equal(trace.requestTruncated, size > 128 * 1024);
    if (!trace.requestTruncated) assert.deepEqual(trace.request, body);
    else assert.equal(Object.hasOwn(trace, 'request'), false, 'never present partial JSON as the actual request object');
    assert.deepEqual(trace.response, response.body); assert.equal(trace.responseSha256, sha256(response.text));
    assert.deepEqual(trace.before, before.persisted); assert.deepEqual(trace.after, before.persisted);
    assert.deepEqual(after.persisted, before.persisted);
  }
});

test('chunked draft evidence hashes original UTF-8 bytes and never substitutes normalized text or an unread oversized tail', async t => {
  const fixture = setup(t, ACTIVE_DRAFT), before = fixture.snapshot(), route = `/profiles/${before.seed.profileId}/draft`;
  const payload = { body: { ...before.seed.revisions[2].body, personality: {
    ...before.seed.revisions[2].body.personality, examples: [{ user: ` ${'e\u0301'.repeat(100)} `, reply: '😀\r\n🧭' }], avoid: [' e\u0301 '] } }, expectedRevision: 3 };
  const raw = JSON.stringify(payload, null, 2), bytes = Buffer.from(raw);
  const chunks = Array.from({ length: Math.ceil(bytes.length / 7) }, (_, i) => bytes.subarray(i * 7, (i + 1) * 7));
  const response = await request(fixture, 'PUT', route, raw, { chunks }), after = fixture.snapshot();
  assert.equal(response.status, 200);
  assertDraftTrace(after.requests.at(-1), raw, response, before, after);
  assert.deepEqual(after.requests.at(-1).request, payload);
  assert.deepEqual(response.body.profile.head.body.personality.examples, [{ user: 'é'.repeat(100), reply: '😀\n🧭' }]);
  assert.deepEqual(response.body.profile.head.body.personality.avoid, ['é']);
  const large = Buffer.from(JSON.stringify({ body: { ...payload.body, instructions: 'x'.repeat(200 * 1024) }, expectedRevision: 4 }));
  const delayedChunks = (async function* () {
    for (let offset = 0; offset < large.length; offset += 8192) {
      await new Promise(resolve => setImmediate(resolve));
      yield large.subarray(offset, offset + 8192);
    }
  })();
  const rejected = await request(fixture, 'PUT', route, large.toString('utf8'), { chunks: delayedChunks });
  assert.deepEqual([rejected.status, rejected.body.code], [413, 'BODY_TOO_LARGE']);
  const trace = fixture.snapshot().requests.at(-1);
  assert.ok(trace.requestBytes > 65536 && trace.requestBytes <= large.length);
  assert.equal(trace.requestSha256, sha256(large.subarray(0, trace.requestBytes)), 'hash only the bytes actually observed before rejection');
  assert.equal(Object.hasOwn(trace, 'request'), false, 'a partial JSON request is not reconstructed');
  assert.deepEqual(fixture.snapshot().persisted, after.persisted);
});

test('personality boundaries use backend Unicode code-point limits, reject overflow without truncating, and preserve multiline replies', async t => {
  assert.deepEqual(PERSONALITY_LIMITS, { examples: 3, exampleUser: 100, exampleReply: 280, avoid: 8, avoidItem: 80 });
  const fixture = setup(t, ACTIVE_DRAFT), before = fixture.snapshot(), route = `/profiles/${before.seed.profileId}/draft`;
  const base = before.seed.revisions[2].body, L = PERSONALITY_LIMITS;
  const personality = { ...base.personality,
    examples: Array.from({ length: L.examples }, (_, i) => ({ user: `${i}${'😀'.repeat(L.exampleUser - 1)}`,
      reply: `${i}${'😀'.repeat(138)}\n${'🧭'.repeat(140)}` })),
    avoid: Array.from({ length: L.avoid }, (_, i) => `${i}${'😀'.repeat(L.avoidItem - 1)}`) };
  assert.equal([...personality.examples[0].user].length, 100); assert.equal([...personality.examples[0].reply].length, 280);
  assert.ok(personality.examples[0].user.length > 100, 'astral characters count once, not as UTF-16 units');
  const invalid = [
    { examples: [...personality.examples, personality.examples[0]] },
    { examples: [{ user: '😀'.repeat(L.exampleUser + 1), reply: 'a' }] },
    { examples: [{ user: 'q', reply: '😀'.repeat(L.exampleReply + 1) }] },
    { examples: [{ user: '', reply: 'a' }] }, { examples: [{ user: 'q', reply: ' \n ' }] },
    { examples: [{ user: 'first\nsecond', reply: 'a' }] }, { examples: [{ user: 'q', reply: 'a', extra: true }] },
    { examples: ['q → a'] }, { examples: 'q' },
    { avoid: [...personality.avoid, personality.avoid[0]] }, { avoid: ['😀'.repeat(L.avoidItem + 1)] },
    { avoid: ['first\nsecond'] }, { avoid: [' '] }, { avoid: 'x' },
  ];
  for (const fields of invalid) {
    const payload = { body: { ...base, personality: { ...base.personality, ...fields } }, expectedRevision: 3 };
    const response = await request(fixture, 'PUT', route, payload), after = fixture.snapshot();
    assert.deepEqual([response.status, response.body.code], [400, 'INVALID_PROFILE']);
    assertDraftTrace(after.requests.at(-1), payload, response, before, before);
    assert.deepEqual(after.persisted, before.persisted);
  }
  const payload = { body: { ...base, personality }, expectedRevision: 3 }, saved = await request(fixture, 'PUT', route, payload);
  assert.deepEqual([saved.status, saved.body.revision, saved.body.unchanged], [200, 4, false]);
  assert.deepEqual(saved.body.profile.head.body.personality, personality, 'no clipping of valid boundary strings');
  assertDraftTrace(fixture.snapshot().requests.at(-1), payload, saved, before, fixture.snapshot());
  assert.deepEqual((await request(fixture, 'GET', `/profiles/${before.seed.profileId}`)).body.head.body, payload.body);
});

test('empty examples and avoid arrays remove optional keys through the actual save without touching other fields or active', async t => {
  const fixture = setup(t, ACTIVE_DRAFT), before = fixture.snapshot(), id = before.seed.profileId, base = before.seed.revisions[2].body;
  const payload = { body: { ...base, personality: { ...base.personality, examples: [], avoid: [] } }, expectedRevision: 3 };
  const saved = await request(fixture, 'PUT', `/profiles/${id}/draft`, payload);
  assert.equal(saved.status, 200); assert.equal(saved.body.revision, 4);
  const { examples, avoid, ...otherPersonality } = base.personality;
  assert.deepEqual(saved.body.profile.head.body, { ...base, personality: otherPersonality });
  assert.deepEqual(saved.body.profile.active.body, before.seed.revisions[1].body);
  assert.deepEqual((await request(fixture, 'GET', `/profiles/${id}`)).body, saved.body.profile);
});

test('draft PUT and OPTIONS allow only the literal seeded path; other IDs, methods, queries, suffixes and normalized aliases cannot write', async t => {
  const fixture = setup(t), initial = fixture.snapshot(), id = initial.seed.profileId, route = `/profiles/${id}/draft`;
  const copy = await request(fixture, 'POST', `/profiles/${id}/duplicate`, { revision: 2 });
  const before = fixture.snapshot(), payload = { body: before.seed.revisions[1].body, expectedRevision: 2 };
  const paths = [`/profiles/${copy.body.id}/draft`, '/profiles/other/draft', `${route}/`, `${route}/activate`, `${route}?`,
    `${route}?expectedRevision=2`, `${route}?accountId=other`, `${route}#`, `${route}#ignored`,
    `/profiles/${id.toUpperCase()}/draft`, `/profiles/%${id.charCodeAt(0).toString(16)}${id.slice(1)}/draft`,
    `/profiles/${id}/%64raft`, `/profiles/other/../${id}/draft`, `/profiles/${id}/./draft`,
    `/profiles/${id}/draft/../draft`, `/profiles/${id}\\draft`, `http://127.0.0.1:49318${route}`];
  for (const method of ['PUT', 'OPTIONS']) for (const path of paths) {
    const response = await request(fixture, method, path, method === 'PUT' ? payload : undefined);
    const code = path.startsWith('http:') ? 'QA_LOOPBACK_REQUIRED' : 'QA_PORTABLE_ROUTE_BLOCKED';
    assert.deepEqual([response.status, response.body.code], [403, code], `${method} ${path}`);
    assert.equal(fixture.snapshot().requests.at(-1).delegated, false);
    assert.ok(!response.headers['access-control-allow-methods']?.includes('PUT'));
  }
  for (const method of ['GET', 'HEAD', 'POST', 'PATCH', 'DELETE']) {
    assert.equal((await request(fixture, method, route, payload)).status, 403);
    assert.equal(fixture.snapshot().requests.at(-1).delegated, false);
  }
  const wrongMethod = await request(fixture, 'OPTIONS', route, undefined, { headers: { 'access-control-request-method': 'DELETE' } });
  assert.equal(wrongMethod.status, 403);
  const allowed = await request(fixture, 'OPTIONS', route, undefined, { headers: { origin: 'chrome://browser', 'access-control-request-method': 'PUT' } });
  assert.equal(allowed.status, 204); assert.equal(allowed.headers['access-control-allow-methods'], 'PUT, OPTIONS');
  const control = await request(fixture, 'OPTIONS', '/__qa/portable-transfer/control');
  assert.equal(control.status, 204); assert.ok(!control.headers['access-control-allow-methods']?.includes('PUT'), 'shared preflight is unchanged');
  for (const options of [{ headers: { host: 'evil.invalid' } }, { headers: { origin: 'https://evil.invalid' } },
    { headers: { 'sec-fetch-site': 'same-site' } }, { remoteAddress: '192.0.2.1' },
    { suppliedUrl: new URL('http://127.0.0.1:49318/profiles/other/draft') }]) {
    for (const method of ['PUT', 'OPTIONS']) {
      const response = await request(fixture, method, route, method === 'PUT' ? payload : undefined, options);
      assert.deepEqual([response.status, response.body.code], [403, 'QA_LOOPBACK_REQUIRED']);
      assert.equal(fixture.snapshot().requests.at(-1).delegated, false);
      assert.equal(response.headers['access-control-allow-origin'], undefined);
    }
  }
  assert.deepEqual(fixture.snapshot().persisted, before.persisted);
  assert.deepEqual(fixture.snapshot().exports, before.exports);
});

test('saved-head .canvas export is actual conversion, omits attachments and creates no Board or Desk revision', async t => {
  const fixture = setup(t), before = fixture.snapshot(), boardId = before.seed.boardId;
  const route = `/v1/boards/${boardId}/export?format=json-canvas`;
  const exported = await request(fixture, 'GET', route);
  assert.equal(exported.status, 200);
  assert.deepEqual(Object.keys(exported.body).sort(), ['canvas', 'report']);
  const savedBody = JSON.parse(before.persisted.desk.revisions[0].body_json);
  assert.deepEqual(exported.body, boardToJsonCanvas(savedBody, { title: before.persisted.desk.boards[0].title, includeAttachments: false }));
  assert.ok(exported.body.canvas.nodes.find(node => node.id === 'qa-result').text.includes(`${before.seed.marker}_SAVED_BOARD_HEAD`));
  assert.equal(exported.body.canvas.nodes.find(node => node.id === 'qa-file').egdesk.omitted, 'attachment');
  assert.ok(!exported.text.includes(before.seed.importPath)); assert.ok(!exported.text.includes(before.filesDir));
  const injected = await request(fixture, 'GET', route, { body: { agenda: { title: 'caller-injected' }, cards: [] } });
  assert.equal(injected.text, exported.text, 'GET cannot substitute a renderer-provided Board for the saved head');
  assert.deepEqual(fixture.snapshot().persisted, before.persisted);
});

test('Markdown preview followed by cancellation/no confirm creates zero records; one original confirm creates exactly one unactivated draft', async t => {
  const fixture = setup(t), before = fixture.snapshot(), { importText, importFilename, importSha256 } = before.seed;
  const preview = await request(fixture, 'POST', '/profiles/import', { text: importText, filename: importFilename, dryRun: true });
  assert.equal(preview.status, 200); assert.equal(preview.body.dryRun, true); assert.equal(preview.body.format, 'md');
  assert.ok(preview.body.body.instructions.includes(`${before.seed.marker}_IMPORT_ORIGINAL`));
  assert.deepEqual(fixture.snapshot().persisted, before.persisted, 'preview only, including abandoning it, must create no profile');
  // No invented cancel endpoint: native Cancel will simply avoid this confirm.
  const cancelled = await request(fixture, 'GET', '/profiles');
  assert.equal(cancelled.body.profiles.length, 1);
  assert.deepEqual(fixture.snapshot().persisted, before.persisted);
  const confirmed = await request(fixture, 'POST', '/profiles/import', { text: importText, filename: importFilename, dryRun: false });
  assert.equal(confirmed.status, 201); assert.equal(confirmed.body.revision, 1);
  assert.notEqual(confirmed.body.id, before.seed.profileId);
  assert.deepEqual(confirmed.body.profile.head.body, preview.body.body, 'the original file bytes, not a reconstructed preview result, are confirmed');
  assert.equal(confirmed.body.profile.reviewRequired, true); assert.equal(confirmed.body.profile.activeRevision, null);
  const after = fixture.snapshot();
  assert.equal(after.persisted.profiles.records.length, 2); assert.equal(after.persisted.profiles.revisions.length, 3);
  const saved = after.persisted.profiles.records.find(row => row.id === confirmed.body.id);
  assert.equal(saved.lifecycle, 'draft'); assert.equal(saved.active_revision, null);
  assert.deepEqual(JSON.parse(saved.source_json).map(({ at, ...source }) => source),
    [{ kind: 'import', format: 'md', flavor: 'claude-code', name: 'owned-portable-import' }]);
  const revision = after.persisted.profiles.revisions.find(row => row.profile_id === confirmed.body.id);
  assert.deepEqual(JSON.parse(revision.body_json), preview.body.body);
  assert.equal(revision.hash, confirmed.body.hash);
  assert.deepEqual(after.persisted.desk, before.persisted.desk);
  const imports = after.requests.filter(row => row.path === '/profiles/import');
  assert.deepEqual(imports.map(row => [row.status, row.request.dryRun, row.request.textSha256]),
    [[200, true, importSha256], [201, false, importSha256]]);
  assert.deepEqual(after.forbiddenPosts, []);
});

test('MD and TOML exports pin exact revision bytes and hashes without activating the profile', async t => {
  const fixture = setup(t), before = fixture.snapshot(), id = before.seed.profileId;
  for (const revision of [1, 2]) for (const format of ['md', 'codex-toml']) {
    const route = `/profiles/${id}/export?format=${format}&revision=${revision}`;
    const exported = await request(fixture, 'GET', route);
    const expected = before.seed.revisions[revision - 1], file = expected.exports[format];
    assert.equal(exported.status, 200);
    assert.equal(exported.body.revision, revision); assert.equal(exported.body.hash, expected.hash);
    assert.equal(exported.body.text, file.text); assert.equal(sha256(exported.body.text), file.sha256);
    assert.equal(Buffer.byteLength(exported.body.text), file.bytes);
    assert.equal(exported.body.filename, file.filename); assert.equal(exported.body.mediaType, file.mediaType);
    assert.ok(exported.body.text.includes(`${before.seed.marker}_REVISION_${revision}`));
    assert.ok(!exported.body.text.includes(`${before.seed.marker}_REVISION_${revision === 1 ? 2 : 1}`));
    assert.equal((await request(fixture, 'GET', route)).text, exported.text);
  }
  const latest = await request(fixture, 'GET', `/profiles/${id}/export?format=md`);
  assert.equal(latest.body.revision, 2, 'explicit revision=1 is materially different from the current head');
  assert.deepEqual(fixture.snapshot().persisted, before.persisted);
});

test('activation, record/room assignment, provider, terminal and other writes are refused and forbidden POST attempts remain visible', async t => {
  const fixture = setup(t), before = fixture.snapshot(), id = before.seed.profileId;
  const posts = [`/profiles/${id}/activate`, `/profiles/${id}/lifecycle`, '/profiles',
    '/records/activate', '/chat/profile/assign', '/rooms/assign', '/chat/send', '/provider/run', '/providers/config',
    '/auth/login', '/auth/logout', '/terminal/spawn', '/terminal/write', '/__qa/portable-transfer/inject'];
  for (const route of posts) {
    const blocked = await request(fixture, 'POST', route, { revision: 1, profileId: id, roomId: 'owned-room', command: 'must-not-run' });
    assert.equal(blocked.status, 403, route); assert.equal(blocked.body.code, 'QA_PORTABLE_ROUTE_BLOCKED');
  }
  assert.equal((await request(fixture, 'PUT', '/profiles/other/draft', { body: before.seed.revisions[0].body, expectedRevision: 2 })).status, 403);
  assert.equal((await request(fixture, 'PUT', `/v1/boards/${before.seed.boardId}`, { body: {}, expectedRevision: 1 })).status, 403);
  assert.equal((await request(fixture, 'GET', '/terminal/shells')).status, 403);
  const after = fixture.snapshot();
  assert.deepEqual(after.forbiddenPosts.map(row => row.path), posts);
  assert.ok(after.requests.every(row => !row.delegated && row.status === 403));
  assert.deepEqual(after.persisted, before.persisted);
  assert.deepEqual([after.providerTurns, after.nativePickerInvocations, after.nativeProcessSpawns], [0, 0, 0]);
  assert.equal((await request(fixture, 'GET', '/health')).handled, false, 'unrelated read-only routes remain owned by the future transport');
});

test('actual handler errors remain errors; loopback/token guards cannot be bypassed by a supplied URL', async t => {
  const fixture = setup(t), before = fixture.snapshot(), id = before.seed.profileId;
  for (const [route, status] of [[`/profiles/${id}/export?revision=999&format=md`, 404],
    [`/profiles/${id}/export?revision=1&revision=2&format=md`, 400], [`/profiles/${id}/export?format=exe`, 400],
    [`/v1/boards/${before.seed.boardId}/export?format=json-canvas&includeAttachments=true`, 400]]) {
    assert.equal((await request(fixture, 'GET', route)).status, status);
    assert.equal(fixture.snapshot().requests.at(-1).delegated, true);
  }
  assert.equal((await request(fixture, 'POST', '/profiles/import', { text: 'not an Agent file' })).status, 400);
  assert.equal((await request(fixture, 'POST', '/profiles/import', '{malformed')).status, 400);
  assert.equal((await request(fixture, 'POST', '/profiles/import', { text: 'x'.repeat(140 * 1024) })).status, 413);
  assert.deepEqual(fixture.snapshot().forbiddenPosts.map(row => row.code), ['AGENT_FILE_FORMAT', 'INVALID_JSON', 'BODY_TOO_LARGE']);
  for (const options of [{ headers: { host: 'evil.invalid' } }, { headers: { origin: 'https://evil.invalid' } },
    { headers: { 'sec-fetch-site': 'same-site' } }, { remoteAddress: '192.0.2.1' },
    { suppliedUrl: new URL('http://127.0.0.1:49318/profiles/foreign') }]) {
    const blocked = await request(fixture, 'GET', '/profiles', undefined, options);
    assert.equal(blocked.status, 403); assert.equal(blocked.headers['access-control-allow-origin'], undefined);
  }
  assert.equal((await request(fixture, 'GET', '/__qa/portable-transfer/state')).status, 403);
  assert.equal((await request(fixture, 'GET', '/__qa/portable-transfer/state', undefined, { token: true })).status, 200);
  assert.ok(!JSON.stringify(fixture.snapshot()).includes(TOKEN), 'control credentials are not saved in evidence');
  assert.deepEqual(fixture.snapshot().persisted, before.persisted);
  const trusted = await request(fixture, 'GET', '/profiles', undefined, { headers: { origin: 'chrome://browser' } });
  assert.equal(trusted.status, 200); assert.equal(trusted.headers['access-control-allow-origin'], 'chrome://browser');
});

test('disposal closes real stores without deleting evidence and independent fixtures cannot read one another', async t => {
  const first = setup(t), second = setup(t), a = first.snapshot(), b = second.snapshot();
  assert.notEqual(a.root, b.root); assert.notEqual(a.databases.profiles, b.databases.profiles);
  assert.equal((await request(second, 'GET', `/profiles/${a.seed.profileId}`)).status, 404);
  first.dispose(); first.dispose();
  assert.equal((await request(first, 'GET', '/profiles')).status, 503);
  assert.equal(first.snapshot().disposed, true);
  assert.equal(fs.readFileSync(a.seed.importPath, 'utf8'), a.seed.importText);
  assert.deepEqual(first.snapshot().persisted, a.persisted);
  assert.equal((await request(second, 'GET', '/profiles')).status, 200);
});
