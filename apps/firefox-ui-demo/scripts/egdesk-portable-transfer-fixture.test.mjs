import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import childProcess from 'node:child_process';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import test from 'node:test';
import { createPortableTransferFixture, portableTransferFixtureEnabled, assertPortableBoardCatalogSeed } from './egdesk-portable-transfer-fixture.mjs';
import { bootstrapQaProfile, canonicalTempRoot, LOADER_FILES } from './egdesk-chat-qa-profile.mjs';
import { createPrivateQaTempDirectory } from './egdesk-qa-platform.mjs';
import { boardToJsonCanvas } from '../helper/egdesk-json-canvas.mjs';

const TOKEN = 'owned-portable-transfer-unit-token';
const ENV = { EGDESK_QA_PORTABLE_TRANSFER_FIXTURE: '1', EGDESK_QA_FIXTURE_TRANSPORT: '1',
  EGDESK_QA_REAL_TURN: '0', EGDESK_QA_FIXTURE_PORT: '49318' };
const sha256 = value => createHash('sha256').update(value).digest('hex');

function setup(t) {
  const loader = createPrivateQaTempDirectory('egdesk-portable-loader-');
  for (const name of LOADER_FILES) fs.writeFileSync(path.join(loader, name), `unit loader ${name}\n`, { mode: 0o600 });
  const { profile } = bootstrapQaProfile({ loaderSource: loader });
  const fixture = createPortableTransferFixture({ profile, token: TOKEN, env: ENV });
  const root = fixture.snapshot().root;
  t.after(() => {
    fixture.dispose();
    for (const [directory, prefix] of [[root, 'egdesk-portable-transfer-'], [profile, 'egdesk-chat-test-'], [loader, 'egdesk-portable-loader-']]) {
      assert.equal(path.dirname(directory), canonicalTempRoot());
      assert.equal(fs.realpathSync.native(directory), directory);
      assert.ok(path.basename(directory).startsWith(prefix));
      fs.rmSync(directory, { recursive: true });
    }
  });
  return fixture;
}

// In-memory HTTP request/response streams only: never a server or socket.
async function request(fixture, method, route, body, options = {}) {
  const bytes = body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))];
  const req = Readable.from(bytes);
  Object.assign(req, { method, url: route, socket: { remoteAddress: options.remoteAddress || '127.0.0.1' },
    headers: { host: '127.0.0.1:49318', ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(options.token ? { 'x-egdesk-qa-token': TOKEN } : {}), ...options.headers } });
  let status, text, endCount = 0;
  const headers = {};
  const res = { setHeader(key, value) { headers[key.toLowerCase()] = value; },
    writeHead(value, supplied) { status = value; for (const [key, content] of Object.entries(supplied || {})) headers[key.toLowerCase()] = content; },
    end(value) { text = String(value); endCount++; } };
  const handled = await fixture.handle(req, res, options.suppliedUrl);
  assert.ok(endCount <= 1, 'one real handler response, not a replaced success plus an error');
  return { handled, status, headers, text, body: text === undefined ? undefined : JSON.parse(text) };
}

test('explicit exclusive opt-in, canonical marked profile and token are checked before new fixture writes', t => {
  const fixture = setup(t), profile = fixture.snapshot().profile;
  const invalid = [{}, { ...ENV, EGDESK_QA_PORTABLE_TRANSFER_FIXTURE: '0' },
    { ...ENV, EGDESK_QA_PORTABLE_TRANSFER_FIXTURE: 'true' }, { ...ENV, EGDESK_QA_REAL_TURN: '1' },
    { ...ENV, EGDESK_QA_FIXTURE_TRANSPORT: '0' }, { ...ENV, EGDESK_QA_FIXTURE_PORT: '39218' },
    { ...ENV, EGDESK_QA_FIXTURE_PORT: undefined }, { ...ENV, EGDESK_QA_FIXTURE_PORT: '65536' },
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
  const posts = [`/profiles/${id}/activate`, `/profiles/${id}/duplicate`, `/profiles/${id}/lifecycle`, '/profiles',
    '/records/activate', '/chat/profile/assign', '/rooms/assign', '/chat/send', '/provider/run', '/terminal/spawn', '/terminal/write', '/__qa/portable-transfer/inject'];
  for (const route of posts) {
    const blocked = await request(fixture, 'POST', route, { revision: 1, profileId: id, roomId: 'owned-room', command: 'must-not-run' });
    assert.equal(blocked.status, 403, route); assert.equal(blocked.body.code, 'QA_PORTABLE_ROUTE_BLOCKED');
  }
  assert.equal((await request(fixture, 'PUT', `/profiles/${id}/draft`, { body: before.seed.revisions[0].body, expectedRevision: 2 })).status, 403);
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
