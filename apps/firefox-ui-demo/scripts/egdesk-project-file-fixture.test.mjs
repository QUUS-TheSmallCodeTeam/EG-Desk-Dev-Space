import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { bootstrapQaProfile, canonicalTempRoot, LOADER_FILES } from './egdesk-chat-qa-profile.mjs';
import { createProjectFileFixture, parseProjectTerminalWrite, assertProjectTerminalResponse } from './egdesk-project-file-fixture.mjs';
import { assertRoomFolderStoreEvidence } from './verify-firefox-mcp-project-file-flow.mjs';
import { createEGDeskFileServiceCallbacks, createEGDeskNativeFilePickers } from '../overlay/resources/EGDeskFileView.sys.mjs';
import { terminalScriptLine, createTerminalScriptRun } from '../overlay/resources/EGDeskTerminalState.sys.mjs';

const TOKEN = 'unit-project-fixture-control-token';
const ENV = { EGDESK_QA_PROJECT_FILE_FIXTURE: '1', EGDESK_QA_FIXTURE_TRANSPORT: '1',
  EGDESK_QA_REAL_TURN: '0', EGDESK_QA_FIXTURE_PORT: '49318' };

function setup(t) {
  const source = fs.mkdtempSync(path.join(canonicalTempRoot(), 'egdesk-project-loader-'));
  for (const name of LOADER_FILES) fs.writeFileSync(path.join(source, name), `unit loader ${name}\n`);
  const { profile } = bootstrapQaProfile({ loaderSource: source });
  const fixture = createProjectFileFixture({ profile, token: TOKEN, env: ENV });
  t.after(async () => {
    await fixture.dispose();
    for (const [directory, prefix] of [[profile, 'egdesk-chat-test-'], [source, 'egdesk-project-loader-']]) {
      assert.equal(path.dirname(directory), canonicalTempRoot());
      assert.ok(path.basename(directory).startsWith(prefix));
      assert.equal(fs.realpathSync.native(directory), directory);
      fs.rmSync(directory, { recursive: true });
    }
  });
  return fixture;
}

async function request(fixture, route, body = {}, { method = 'POST', headers = {}, token = false } = {}) {
  const req = Readable.from(method === 'GET' ? [] : [JSON.stringify(body)]);
  Object.assign(req, { method, url: route, socket: { remoteAddress: '127.0.0.1' },
    headers: { host: '127.0.0.1:49318', 'content-type': 'application/json',
      ...(token ? { 'x-egdesk-qa-token': TOKEN } : {}),
      ...Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value])) } });
  let status, packet;
  const handled = await fixture.handle(req, { writeHead(value) { status = value; }, end(value) { packet = JSON.parse(value); } });
  return { handled, status, body: packet };
}

const configure = (fixture, body) => request(fixture, '/__qa/project-file/config', body, { token: true });
function client(fixture) {
  const service = createEGDeskFileServiceCallbacks({ request: async (route, body, options) =>
    (await request(fixture, route, body, { headers: options?.headers })).body });
  const pickers = createEGDeskNativeFilePickers({ service,
    pickDirectory: async () => {
      const response = await request(fixture, '/__qa/project-file/picker');
      assert.equal(response.status, 200); return response.body.selection;
    } });
  return { service, pickers };
}

test('opt-in is mandatory; import/factory starts no listener and owns only a temp workspace', t => {
  assert.throws(() => createProjectFileFixture({ env: {}, token: TOKEN }), /opt-in/);
  const fixture = setup(t), state = fixture.snapshot();
  assert.equal(state.kind, 'egdesk-project-file-fixture');
  assert.ok(state.workspace.startsWith(`${state.profile}${path.sep}`));
  assert.equal(state.currentOriginalSha256, state.originalSha256);
  assert.deepEqual(state.persisted, { projects: [], bindings: [] });
  assert.deepEqual([state.providerTurns, state.nativePickerInvocations, state.nativeProcessSpawns], [0, 0, 0]);
});

test('real picker channel/begin/cancel then selection/complete/attach persist and reopen a real project', async t => {
  const fixture = setup(t), { service, pickers } = client(fixture);
  assert.equal((await configure(fixture, { pickerResults: ['cancel', 'select-owned'] })).status, 200);
  assert.equal(await pickers.chooseProjectFolder({ boardId: 'qa-board', title: 'QA Board' }), null);
  const cancelled = fixture.snapshot();
  assert.equal(cancelled.fileRequests.filter(row => row.operation === 'attachProject').length, 0);
  assert.equal(cancelled.persisted.projects.length, 0);
  assert.equal(cancelled.terminalRequests.length, 0);
  const attached = await pickers.chooseProjectFolder({ boardId: 'qa-board', title: 'QA Board' });
  const opened = await service.openProject({ boardId: 'qa-board' });
  assert.equal(opened.project.projectId, attached.projectId);
  assert.equal(opened.project.displayPath, fixture.snapshot().workspace);
  const saved = await service.setProjectScripts({ projectId: attached.projectId,
    scripts: [{ id: 'qa-check', name: 'Owned check', command: fixture.snapshot().command }] });
  assert.equal(saved.scripts.length, 1);
  const persisted = fixture.snapshot();
  assert.equal(persisted.persisted.projects.length, 1);
  assert.equal(persisted.persisted.bindings[0].key, 'qa-board');
  assert.equal((await service.openProject({ boardId: 'qa-board' })).project.scripts[0].command, persisted.command);
  assert.equal(persisted.currentOriginalSha256, persisted.originalSha256);
  assert.equal(persisted.terminalRequests.length, 0);
  assert.deepEqual(persisted.fileRequests.filter(row => row.operation.includes('Picker') || row.operation === 'attachProject')
    .map(row => row.operation), ['openPickerChannel', 'beginPicker', 'completePicker', 'beginPicker', 'completePicker', 'attachProject']);
  assert.ok(persisted.fileRequests.find(row => row.operation === 'openPickerChannel').response.result.tokenPresent);
  assert.ok(!JSON.stringify(persisted).includes('X-EGDesk-Picker-Channel'));
});

test('picker result cannot precede actual begin, cross an origin, substitute a path, or bypass a grant', async t => {
  const fixture = setup(t);
  assert.equal((await configure(fixture, { pickerResults: ['cancel'], nextTerminalOutcome: 'invalid' })).status, 400);
  assert.equal(fixture.snapshot().queuedPickerResults, 0, 'bad config has no partial mutation');
  await configure(fixture, { pickerResults: ['select-owned'] });
  assert.equal((await request(fixture, '/__qa/project-file/picker')).status, 409);
  assert.equal((await request(fixture, '/v1/files/projects/attach', { boardId: 'qa-board', selectionId: 'invented' })).status, 409);
  const channel = (await request(fixture, '/v1/files/picker/channel')).body.result;
  const headers = { 'X-EGDesk-Picker-Channel': channel.token };
  const begin = (await request(fixture, '/v1/files/picker/begin', { purpose: 'folder' }, { headers })).body.result;
  assert.equal((await request(fixture, '/__qa/project-file/picker', {}, { headers: { origin: 'chrome://browser' } })).status, 403);
  assert.equal((await request(fixture, '/__qa/project-file/picker')).status, 200);
  assert.equal((await request(fixture, '/v1/files/picker/complete', { requestId: begin.requestId, absolutePath: '/tmp/foreign' }, { headers })).status, 403);
  assert.equal((await request(fixture, '/v1/files/picker/complete', { requestId: begin.requestId, absolutePath: fixture.snapshot().workspace }, { headers })).status, 200);
  assert.equal((await request(fixture, '/__qa/project-file/state', {}, { method: 'GET' })).status, 403);
  assert.equal((await request(fixture, '/__qa/project-file/state', {}, { method: 'GET', token: true })).status, 200);
  assert.equal((await request(fixture, '/terminal/shells', {}, { method: 'GET', headers: { host: 'foreign' } })).status, 403);
  assert.equal((await request(fixture, '/__qa/project-file/picker', {}, { method: 'OPTIONS' })).status, 403);
  assert.equal(fixture.snapshot().persisted.projects.length, 0);
});

test('D-X3 uses real room-default read/save routes and SQLite inheritance, never an implicit active Board', async t => {
  const fixture = setup(t), { pickers } = client(fixture), roomId = 'qa-client-binding-not-local-thread-id';
  const read = body => request(fixture, '/v1/files/projects/room-default', body);
  const save = body => request(fixture, '/v1/files/projects/room-default/save', body);
  const empty = (await read({ roomId })).body;
  assert.deepEqual(empty, { ok: true, result: { roomId, inheritance: null, override: null, project: null, source: null, status: 'none' } });
  await configure(fixture, { pickerResults: ['select-owned'] });
  const project = await pickers.chooseProjectFolder({ boardId: 'qa-board', title: 'Owned default project' });
  assert.deepEqual((await read({ roomId })).body, empty, 'a connected Board alone is not this room default');
  const before = fixture.snapshot();
  assert.deepEqual(before.roomDefaults, []);
  const saved = await save({ roomId, boardId: 'qa-board', expectedProjectId: project.projectId, expectedRootId: project.rootId });
  assert.equal(saved.status, 200); assert.equal(saved.body.ok, true);
  assert.equal(saved.body.result.roomId, roomId); assert.equal(saved.body.result.source, 'board');
  assert.equal(saved.body.result.status, 'connected'); assert.equal(saved.body.result.override, null);
  assert.deepEqual(saved.body.result.inheritance, { boardId: 'qa-board' });
  assert.equal(saved.body.result.project.projectId, project.projectId);
  assert.equal(saved.body.result.project.rootId, project.rootId);
  assert.equal(saved.body.result.project.displayPath, before.workspace);
  assert.deepEqual(fixture.snapshot().roomDefaults, [{ roomId, boardId: 'qa-board' }]);
  // Independent subsequent HTTP reads use the actual persisted inheritance.
  assert.deepEqual((await read({ roomId })).body, saved.body);
  assert.equal((await read({ roomId: 'other-client-binding' })).body.result.status, 'none');
  const after = fixture.snapshot();
  assert.deepEqual(after.persisted.bindings, before.persisted.bindings, 'saving inheritance does not forge a room folder attachment');
  assert.equal(after.pickerResults.length, before.pickerResults.length);
  assert.deepEqual(after.terminalRequests, []);
  assert.equal(after.currentOriginalSha256, before.currentOriginalSha256);
  assert.deepEqual([after.providerTurns, after.nativePickerInvocations, after.nativeProcessSpawns], [0, 0, 0]);
});

test('prepared room folder is a real unused picker grant until Save; Cancel writes no binding and inheritance survives override removal', async t => {
  const fixture = setup(t), { pickers } = client(fixture), roomId = 'original-client-binding-not-local-thread';
  const read = () => request(fixture, '/v1/files/projects/room-default', { roomId });
  await configure(fixture, { pickerResults: ['select-owned'] });
  const board = await pickers.chooseProjectFolder({ boardId: 'owned-board', title: 'Owned Board project' });
  const saved = await request(fixture, '/v1/files/projects/room-default/save', { roomId, boardId: 'owned-board',
    expectedProjectId: board.projectId, expectedRootId: board.rootId });
  assert.equal(saved.status, 200);
  const baseline = fixture.snapshot(), attaches = value => value.fileRequests.filter(row => row.operation === 'attachProject');
  await configure(fixture, { pickerResults: ['cancel', 'select-owned-room', 'select-owned-room'] });
  assert.equal(await pickers.prepareProjectFolder({ roomId }), null, 'actual picker cancel completes without selection/attach');
  const osCancelled = fixture.snapshot();
  const prepared = await pickers.prepareProjectFolder({ roomId });
  assert.equal(prepared.displayPath, baseline.roomWorkspace);
  assert.notEqual(prepared.displayPath, baseline.workspace);
  const preview = fixture.snapshot();
  assert.deepEqual(preview.persisted, baseline.persisted); assert.deepEqual(preview.roomDefaults, baseline.roomDefaults);
  assert.equal(attaches(preview).length, attaches(baseline).length);
  assert.equal(prepared.cancel(), true);
  await assert.rejects(prepared.consume(), { code: 'PICKER_PREPARATION_CANCELLED' });
  assert.deepEqual(fixture.snapshot().persisted, baseline.persisted);
  const cancelled = fixture.snapshot();
  const selected = await pickers.prepareProjectFolder({ roomId }), beforeSave = fixture.snapshot();
  assert.equal(attaches(beforeSave).length, attaches(baseline).length);
  const attached = await selected.consume(), afterSave = fixture.snapshot();
  assert.equal(attached.status, 'connected'); assert.equal(attached.source, 'room');
  assert.equal(attached.displayPath, baseline.roomWorkspace);
  assert.notEqual(attached.projectId, board.projectId); assert.notEqual(attached.rootId, board.rootId);
  assert.equal(attaches(afterSave).length, attaches(baseline).length + 1);
  const receipt = attaches(afterSave).at(-1);
  assert.equal(receipt.status, 200); assert.equal(receipt.request.roomId, roomId);
  assert.equal(Object.hasOwn(receipt.request, 'boardId'), false);
  assert.deepEqual(afterSave.roomDefaults, baseline.roomDefaults, 'room attachment cannot overwrite inherited Board');
  assert.deepEqual(afterSave.persisted.bindings.filter(row => row.scope !== 'room'), baseline.persisted.bindings);
  assert.equal(afterSave.persisted.bindings.filter(row => row.scope === 'room').length, 1);
  const view = (await read()).body.result;
  const savedSnapshot = fixture.snapshot();
  assert.equal(view.roomId, roomId); assert.equal(view.source, 'room'); assert.equal(view.project.projectId, attached.projectId);
  assert.deepEqual(view.inheritance, { boardId: 'owned-board' });
  await assert.rejects(selected.consume(), { code: 'PICKER_PREPARATION_USED' });
  assert.equal(attaches(fixture.snapshot()).length, attaches(afterSave).length, 'Save cannot replay a consumed grant');
  const clearPrepared = fixture.snapshot();
  const inherited = await request(fixture, '/v1/files/projects/inherit', { roomId });
  assert.equal(inherited.status, 200); assert.equal(inherited.body.result.inherited, true);
  const restored = (await read()).body.result, final = fixture.snapshot();
  assert.equal(restored.source, 'board'); assert.equal(restored.override, null);
  assert.equal(restored.project.projectId, board.projectId); assert.equal(restored.project.rootId, board.rootId);
  assert.deepEqual(final.roomDefaults, baseline.roomDefaults);
  assert.deepEqual(final.persisted.bindings, baseline.persisted.bindings, 'only the room override binding is removed');
  assert.deepEqual(final.persisted.projects.find(row => row.id === board.projectId), baseline.persisted.projects.find(row => row.id === board.projectId));
  assert.equal(final.fileRequests.some(row => row.operation === 'detachProject'), false);
  assert.deepEqual(final.terminalRequests, []); assert.equal(final.currentOriginalSha256, baseline.currentOriginalSha256);
  assert.deepEqual([final.providerTurns, final.nativePickerInvocations, final.nativeProcessSpawns], [0, 0, 0]);
  const proof = { initial: baseline, osCancelled, preparedCancel: preview, cancelled, preparedSave: beforeSave,
    saved: savedSnapshot, clearPrepared, cleared: final };
  const expected = { roomId, boardId: 'owned-board', projectId: board.projectId, rootId: board.rootId, displayPath: baseline.workspace };
  const expectations = assertRoomFolderStoreEvidence(proof, expected);
  assert.equal(expectations.roomExpectation.source, 'room'); assert.equal(expectations.roomExpectation.boardId, null);
  assert.equal(expectations.boardExpectation.source, 'board'); assert.equal(expectations.boardExpectation.boardId, 'owned-board');
  const polled = structuredClone(proof);
  for (const [index, state] of Object.values(polled).entries()) state.sessions = [{ sessionId: 'existing-owned-terminal', reads: index, writes: 2 }];
  assert.doesNotThrow(() => assertRoomFolderStoreEvidence(polled, expected), 'background idle reads are not shell writes');
  polled.saved.sessions[0].writes++;
  assert.throws(() => assertRoomFolderStoreEvidence(polled, expected), 'any extra shell write still fails');
  for (const corrupt of [
    p => { p.cancelled.persisted.bindings.push({ scope: 'room', key: roomId, projectId: attached.projectId }); },
    p => { p.saved.fileRequests.findLast(row => row.operation === 'attachProject').request.roomId = 'wrong-local-thread'; },
    p => { p.saved.fileRequests.findLast(row => row.operation === 'attachProject').request.boardId = 'active-board'; },
    p => { p.saved.fileRequests.findLast(row => row.operation === 'attachProject').request.selectionId = 'forged'; },
    p => { p.saved.pickerResults.at(-1).selection = baseline.workspace; },
    p => { p.cleared.roomDefaults = []; },
    p => { p.cleared.fileRequests.findLast(row => row.operation === 'inheritRoomProject').operation = 'detachProject'; },
    p => { p.cleared.fileRequests.findLast(row => row.operation === 'readRoomProjectDefault').response.result.source = null; },
    p => { p.clearPrepared.persisted.bindings = []; },
    p => { p.saved.blockedRoutes.push({ route: '/v1/files/projects/detach' }); },
    p => { p.saved.providerTurns = 1; },
  ]) { const changed = structuredClone(proof); corrupt(changed); assert.throws(() => assertRoomFolderStoreEvidence(changed, expected)); }
});

test('owned room picker result cannot be completed as the Board folder or an arbitrary path; Board detach stays disabled', async t => {
  const fixture = setup(t);
  await configure(fixture, { pickerResults: ['select-owned-room'] });
  const channel = (await request(fixture, '/v1/files/picker/channel')).body.result;
  const headers = { 'x-egdesk-picker-channel': channel.token };
  const begin = (await request(fixture, '/v1/files/picker/begin', { purpose: 'folder' }, { headers })).body.result;
  const selection = (await request(fixture, '/__qa/project-file/picker')).body.selection;
  assert.equal(selection, fixture.snapshot().roomWorkspace);
  for (const absolutePath of [fixture.snapshot().workspace, '/tmp/foreign-room']) {
    const result = await request(fixture, '/v1/files/picker/complete', { requestId: begin.requestId, absolutePath }, { headers });
    assert.equal(result.status, 403); assert.equal(result.body.code, 'QA_PICKER_RESULT_MISMATCH');
  }
  assert.equal((await request(fixture, '/v1/files/picker/complete', { requestId: begin.requestId, absolutePath: selection }, { headers })).status, 200);
  assert.equal((await request(fixture, '/v1/files/projects/detach', { boardId: 'owned-board' })).status, 403);
  assert.equal(fixture.snapshot().persisted.projects.length, 0);
});

test('D-X3 wrong IDs, stale project/root, extra paths and cross-origin saves cannot persist a default', async t => {
  const fixture = setup(t), { pickers } = client(fixture);
  await configure(fixture, { pickerResults: ['select-owned'] });
  const project = await pickers.chooseProjectFolder({ boardId: 'qa-board' });
  const body = { roomId: 'qa-client-binding', boardId: 'qa-board', expectedProjectId: project.projectId, expectedRootId: project.rootId };
  for (const patch of [{ roomId: '' }, { roomId: ' ' }, { roomId: 'invalid\0room' },
    { boardId: undefined }, { expectedProjectId: undefined }, { expectedRootId: undefined }]) {
    assert.equal((await request(fixture, '/v1/files/projects/room-default/save', { ...body, ...patch })).status, 400);
  }
  for (const patch of [{ boardId: 'unconnected-board' }, { expectedProjectId: 'stale-project' }, { expectedRootId: 'stale-root' }]) {
    const response = await request(fixture, '/v1/files/projects/room-default/save', { ...body, ...patch });
    assert.equal(response.status, 409); assert.equal(response.body.code, 'PROJECT_TARGET_CHANGED');
  }
  assert.equal((await request(fixture, '/v1/files/projects/room-default/save', { ...body, cwd: fixture.snapshot().workspace })).body.code, 'UNEXPECTED_FIELD');
  assert.equal((await request(fixture, '/v1/files/projects/room-default', { roomId: body.roomId, boardId: body.boardId })).body.code, 'UNEXPECTED_FIELD');
  assert.equal((await request(fixture, '/v1/files/projects/room-default/save', body, { headers: { origin: 'https://foreign.invalid' } })).status, 403);
  assert.equal((await request(fixture, '/v1/files/projects/room-default', {}, { method: 'GET' })).body.code, 'QA_FILE_OPERATION_DISABLED');
  assert.equal((await request(fixture, '/v1/files/projects/inherit', { roomId: body.roomId, boardId: body.boardId })).body.code, 'UNEXPECTED_FIELD');
  assert.equal((await request(fixture, '/v1/files/projects/inherit', {})).status, 400);
  assert.deepEqual(fixture.snapshot().roomDefaults, []);
  assert.deepEqual(fixture.snapshot().terminalRequests, []);
});

test('real file list/read/draft service works while Git, originals and unrelated routes remain disabled', async t => {
  const fixture = setup(t), { service, pickers } = client(fixture);
  await configure(fixture, { pickerResults: ['select-owned'] });
  const project = await pickers.chooseProjectFolder({ boardId: 'qa-board' });
  const listing = await service.listDirectory({ directoryId: project.directoryId });
  const entry = listing.entries.find(row => row.name === 'qa-project.txt');
  assert.ok(entry?.id);
  const draft = await service.createDraft({ fileId: entry.id });
  assert.equal(draft.text, fixture.snapshot().originalText);
  for (const route of ['/v1/files/git/status', '/v1/files/git/changes', '/v1/files/drafts/save-original',
    '/v1/files/save-as', '/v1/files/roots', '/v1/files/search']) {
    assert.equal((await request(fixture, route, {})).body.code, 'QA_FILE_OPERATION_DISABLED');
  }
  assert.equal(fixture.snapshot().currentOriginalSha256, fixture.snapshot().originalSha256);
  assert.equal((await request(fixture, '/unrelated')).handled, false);
});

test('typed shell responses carry the actual generated nonce and split exit marker; unarmed second write is refused', async t => {
  const fixture = setup(t), state = fixture.snapshot();
  assert.equal(assertProjectTerminalResponse('/terminal/shells', (await request(fixture, '/terminal/shells', {}, { method: 'GET' })).body), true);
  const spawn = (await request(fixture, '/terminal/spawn', { shellId: 'sh', cols: 80, rows: 24 })).body;
  assert.equal(assertProjectTerminalResponse('/terminal/spawn', spawn), true);
  const data = terminalScriptLine({ command: state.command, cwd: state.workspace, nonce: 'abc123456789', shell: 'posix' });
  assert.equal(parseProjectTerminalWrite(data, state), 'abc123456789');
  assert.throws(() => parseProjectTerminalWrite(terminalScriptLine({ command: 'unowned-command', cwd: state.workspace,
    nonce: 'abc123456789', shell: 'posix' }), state), /differs/);
  const body = { sessionId: spawn.sessionId, data };
  assert.equal((await request(fixture, '/terminal/write', { ...body, data: 'wrong\r' })).status, 400);
  const write = await request(fixture, '/terminal/write', body);
  assert.equal(assertProjectTerminalResponse('/terminal/write', write.body, spawn.sessionId), true);
  assert.equal((await request(fixture, '/terminal/write', body)).body.code, 'QA_DUPLICATE_WRITE');
  const chunks = [];
  for (let i = 0; i < 2; i++) {
    const read = (await request(fixture, '/terminal/read', { sessionId: spawn.sessionId })).body;
    assert.equal(assertProjectTerminalResponse('/terminal/read', read, spawn.sessionId), true); chunks.push(read.data);
  }
  assert.equal(chunks.join(''), `${state.outputMarker}\r\n[egdesk-run:abc123456789:exit=0]\r\n`);
  assert.throws(() => assertProjectTerminalResponse('/terminal/read', { ...spawn, data: '', exited: true }), /false/);
  assert.equal(fixture.snapshot().sessions[0].writes, 1);
  assert.equal(fixture.snapshot().nativeProcessSpawns, 0);
});

test('an explicitly armed second run reuses the same real terminal session with a new nonce, never a replay', async t => {
  const fixture = setup(t), state = fixture.snapshot();
  const sessionId = (await request(fixture, '/terminal/spawn', { shellId: 'sh', cols: 80, rows: 24 })).body.sessionId;
  const data = nonce => terminalScriptLine({ command: state.command, cwd: state.workspace, nonce });
  assert.equal((await request(fixture, '/terminal/write', { sessionId, data: data('firstrun1234') })).status, 200);
  await request(fixture, '/terminal/read', { sessionId }); await request(fixture, '/terminal/read', { sessionId });
  assert.equal((await request(fixture, '/terminal/write', { sessionId, data: data('secondrun1234') })).status, 409);
  await configure(fixture, { nextTerminalOutcome: 'output-loss' });
  assert.equal((await request(fixture, '/terminal/write', { sessionId, data: data('firstrun1234') })).status, 409);
  assert.equal((await request(fixture, '/terminal/write', { sessionId, data: data('secondrun1234') })).status, 200);
  assert.equal((await request(fixture, '/terminal/read', { sessionId })).body.code, 'QA_OUTPUT_LOST');
  assert.equal(fixture.snapshot().sessions.length, 1);
  assert.equal(fixture.snapshot().sessions[0].writes, 2);
  assert.deepEqual(fixture.snapshot().sessions[0].nonces, ['firstrun1234', 'secondrun1234']);
  assert.equal(fixture.snapshot().writeArmed, false);
});

test('synthetic output-loss follows an accepted write, never invents exit or replay; idle reads stay bounded', async t => {
  const fixture = setup(t), state = fixture.snapshot();
  await configure(fixture, { nextTerminalOutcome: 'output-loss' });
  const sessionId = (await request(fixture, '/terminal/spawn', { shellId: 'sh', cols: 80, rows: 24 })).body.sessionId;
  for (let i = 0; i < 520; i++) assert.equal((await request(fixture, '/terminal/read', { sessionId })).status, 200);
  assert.equal(fixture.snapshot().terminalRequests.length, 1);
  await request(fixture, '/terminal/write', { sessionId,
    data: terminalScriptLine({ command: state.command, cwd: state.workspace, nonce: 'loss12345678', shell: 'posix' }) });
  for (let i = 0; i < 2; i++) assert.equal((await request(fixture, '/terminal/read', { sessionId })).body.code, 'QA_OUTPUT_LOST');
  assert.equal(fixture.snapshot().terminalRequests.filter(row => row.outputLost).length, 1);
  assert.equal(fixture.snapshot().sessions[0].writes, 1);
});

test('real ScriptRun collector consumes only nonce-matching synthetic reads and resolves unknown on loss', async t => {
  const fixture = setup(t), state = fixture.snapshot();
  for (const outcome of ['complete', 'output-loss']) {
    await configure(fixture, { nextTerminalOutcome: outcome });
    const sessionId = (await request(fixture, '/terminal/spawn', { shellId: 'sh', cols: 80, rows: 24 })).body.sessionId;
    let submitted;
    const run = createTerminalScriptRun({ command: state.command, cwd: state.workspace, shell: 'posix',
      nonce: outcome === 'complete' ? 'collector1234' : 'losscollector1234',
      write(data) { submitted = request(fixture, '/terminal/write', { sessionId, data }); return submitted; } });
    const result = run.start();
    assert.equal((await submitted).status, 200);
    assert.equal(run.start(), result, 'a repeated start cannot write again');
    for (let i = 0; i < 2; i++) {
      const response = await request(fixture, '/terminal/read', { sessionId });
      if (response.status !== 200) { run.cancel(); break; }
      run.onData(response.body.data);
    }
    const receipt = await result;
    assert.equal(receipt.status, outcome === 'complete' ? 'completed' : 'unknown');
    assert.equal(receipt.exitCode, outcome === 'complete' ? 0 : null);
    if (outcome === 'complete') assert.ok(receipt.output.head.includes(state.outputMarker));
    assert.equal(fixture.snapshot().sessions.find(row => row.sessionId === sessionId).writes, 1);
  }
});
