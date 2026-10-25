import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import childProcess from 'node:child_process';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { createChatOriginFileFixture, chatOriginFileFixtureEnabled, CHAT_ORIGIN_FILE_SEED, CHAT_ORIGIN_FILE_STATE,
  CHAT_ORIGIN_FILE_CONTROL, CHAT_ORIGIN_FILE_TEXT, CHAT_ORIGIN_FILE_OUTPUT } from './egdesk-chat-origin-file-fixture.mjs';
import { bootstrapQaProfile, canonicalTempRoot, LOADER_FILES } from './egdesk-chat-qa-profile.mjs';
import { createPrivateQaTempDirectory } from './egdesk-qa-platform.mjs';
import { assertOriginReadWindow } from './verify-firefox-mcp-chat-origin-file-flow.mjs';

const TOKEN = 'owned-origin-file-unit-token';
const ENV = { EGDESK_QA_CHAT_ORIGIN_FILE_FIXTURE: '1', EGDESK_QA_FIXTURE_TRANSPORT: '1', EGDESK_QA_REAL_TURN: '0', EGDESK_QA_FIXTURE_PORT: '49321' };
const hash = value => createHash('sha256').update(value).digest('hex');
async function setup(t) {
  const loader = createPrivateQaTempDirectory('egdesk-origin-loader-');
  for (const name of LOADER_FILES) fs.writeFileSync(path.join(loader, name), `unit loader ${name}\n`, { mode: 0o600 });
  const { profile } = bootstrapQaProfile({ loaderSource: loader });
  const frames = [];
  const fixture = await createChatOriginFileFixture({ profile, token: TOKEN, env: ENV, broadcast: frame => frames.push(structuredClone(frame)) });
  const root = fixture.snapshot().root;
  t.after(async () => {
    await fixture.dispose();
    for (const [directory, prefix] of [[root, 'egdesk-chat-origin-file-'], [profile, 'egdesk-chat-test-'], [loader, 'egdesk-origin-loader-']]) {
      assert.equal(path.dirname(directory), canonicalTempRoot()); assert.equal(fs.realpathSync.native(directory), directory);
      assert.ok(path.basename(directory).startsWith(prefix)); fs.rmSync(directory, { recursive: true });
    }
  });
  return { fixture, frames, profile };
}
async function request(fixture, method, route, body, options = {}) {
  const req = Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]), {
    method, url: route, socket: { remoteAddress: options.remoteAddress || '127.0.0.1' }, headers: { host: '127.0.0.1:49321',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(options.token ? { 'x-egdesk-qa-token': TOKEN } : {}), ...options.headers } });
  let status, text, endings = 0;
  const handled = await fixture.handle(req, { setHeader() {}, writeHead(value) { status = value; }, end(value) { text = String(value); endings++; } }, options.suppliedUrl);
  assert.ok(endings <= 1, 'No synthetic second response after a production receipt');
  return { handled, status, body: text ? JSON.parse(text) : undefined };
}
const control = (fixture, action, extra = {}) => request(fixture, 'POST', CHAT_ORIGIN_FILE_CONTROL, { action, ...extra }, { token: true });
const query = original => new URLSearchParams({ conversationId: original.conversationId, runId: original.runId });
const origin = fixture => request(fixture, 'GET', `/chat/run-project-origin?${query(fixture.snapshot().original)}`);
const output = fixture => { const original = fixture.snapshot().original; return request(fixture, 'GET', `/chat/command-output?${query(original)}&itemId=${original.itemId}`); };
async function seed(fixture) {
  assert.equal((await control(fixture, 'prepare-room', { clientThreadId: 'qa-origin-room' })).status, 200);
  const view = (await request(fixture, 'POST', '/v1/files/projects/room-default', { roomId: 'qa-origin-room' })).body.result;
  const expectedRoomProject = { roomId: view.roomId, status: view.status, source: view.source, boardId: view.inheritance.boardId,
    projectId: view.project.projectId, rootId: view.project.rootId };
  const result = await request(fixture, 'POST', '/chat/send', { message: CHAT_ORIGIN_FILE_SEED, clientThreadId: 'qa-origin-room',
    requestId: 'qa-origin-request', profileEnabled: false, expectedRoomProject });
  assert.equal(result.status, 202, JSON.stringify(result.body)); assert.equal(result.body.accepted, true);
  return result;
}

test('origin fixture: strict exclusive opt-in, owned fresh profile and token before new effects', async t => {
  assert.equal(chatOriginFileFixtureEnabled({}), false);
  const { profile } = await setup(t);
  const mkdir = t.mock.method(fs, 'mkdtempSync', () => assert.fail('No effects before validation'));
  for (const env of [{}, { ...ENV, EGDESK_QA_REAL_TURN: '1' }, { ...ENV, EGDESK_QA_FIXTURE_TRANSPORT: '0' },
    { ...ENV, EGDESK_QA_CHAT_ORIGIN_FILE_FIXTURE: 'true' }, { ...ENV, EGDESK_QA_FIXTURE_PORT: '39218' },
    ...['EGDESK_QA_PROJECT_FILE_FIXTURE', 'EGDESK_QA_TASK_GATE_FIXTURE', 'EGDESK_QA_RUN_OUTPUTS_FIXTURE', 'EGDESK_QA_BROWSER_RELAY'].map(key => ({ ...ENV, [key]: '1' }))]) {
    await assert.rejects(createChatOriginFileFixture({ profile, token: TOKEN, env }));
  }
  await assert.rejects(createChatOriginFileFixture({ profile, token: 'short', env: ENV }));
  await assert.rejects(createChatOriginFileFixture({ profile: path.dirname(profile), token: TOKEN, env: ENV }));
  await assert.rejects(createChatOriginFileFixture({ profile, token: TOKEN, env: ENV }), /pre-existing preferences/);
  assert.equal(mkdir.mock.callCount(), 0);
});

test('origin fixture: import/factory have no listener, network, native provider, git or process; origin table starts empty', async t => {
  const spies = [t.mock.method(net.Server.prototype, 'listen', () => assert.fail('No listener')),
    t.mock.method(net.Socket.prototype, 'connect', () => assert.fail('No outbound socket')), t.mock.method(globalThis, 'fetch', () => assert.fail('No network')),
    ...['spawn', 'spawnSync', 'execFile', 'execFileSync'].map(name => t.mock.method(childProcess, name, () => assert.fail('No process')))];
  await import(`./egdesk-chat-origin-file-fixture.mjs?inert=${Date.now()}`);
  const { fixture, profile } = await setup(t), initial = fixture.snapshot();
  assert.deepEqual(Object.keys(fixture).sort(), ['dispose', 'handle', 'snapshot']);
  assert.deepEqual(initial.persisted.origins, []); assert.equal(initial.persisted.requests, 0); assert.equal(initial.persisted.drafts, 0);
  assert.equal(initial.effects.setupPickerGrants, 2); assert.equal(initial.effects.setupSourceWrites, 2);
  assert.equal(initial.effects.profileCatalogWrites, 1); assert.equal(initial.fakeRpc.length, 0);
  assert.match(fs.readFileSync(path.join(profile, 'prefs.js'), 'utf8'), /egdesk\.agendaState\.v1/);
  await seed(fixture);
  for (const spy of spies) assert.equal(spy.mock.callCount(), 0);
});

test('origin fixture: real accepted send writes private origin; state/history/output/origin share that runtime', async t => {
  const { fixture, frames } = await setup(t), accepted = await seed(fixture), state = fixture.snapshot();
  assert.equal(state.persisted.origins.length, 1); assert.equal(state.persisted.requests, 1);
  const stored = state.persisted.origins[0];
  assert.equal(stored.conversationId, accepted.body.conversationId); assert.equal(stored.runId, accepted.body.runId);
  assert.equal(stored.project.projectId, state.projects.original.projectId); assert.equal(stored.project.startCwd, state.folders.original);
  assert.deepEqual(state.fakeRpc.map(value => value.method), ['thread/start', 'turn/start']);
  assert.ok(frames.some(frame => frame.event === 'run.started' && frame.runId === stored.runId));
  assert.ok(frames.some(frame => frame.event === 'activity.completed' && frame.itemId === state.original.itemId));
  const current = await request(fixture, 'GET', '/chat/state');
  assert.equal(current.body.runs[0].runId, stored.runId); assert.equal(current.body.runs[0].status, 'completed');
  const history = await request(fixture, 'GET', '/chat/history?clientThreadId=qa-origin-room');
  assert.equal(history.status, 200); assert.match(JSON.stringify(history.body), new RegExp(stored.runId));
  assert.doesNotMatch(JSON.stringify([current.body, history.body, frames]), /fsIdentity|privateProjectOrigin|fileOwnerScope|startCwd/);
  const retained = await output(fixture); assert.equal(retained.status, 200); assert.equal(retained.body.head + retained.body.tail, CHAT_ORIGIN_FILE_OUTPUT);
  const verified = await origin(fixture);
  assert.equal(verified.body.verified, true); assert.equal(verified.body.rootId, state.projects.original.rootId);
  assert.equal(verified.body.displayPath, state.folders.original);
  assert.equal(fixture.snapshot().fakeRpc.length, 2, 'History/output/origin do not call provider RPC');
});

test('origin fixture: real rejected send has no private origin, fake turn or replacement request identity', async t => {
  const { fixture } = await setup(t);
  await control(fixture, 'prepare-room', { clientThreadId: 'qa-origin-room' });
  const body = { message: CHAT_ORIGIN_FILE_SEED, clientThreadId: 'qa-origin-room', requestId: 'observed-none', profileEnabled: false,
    expectedRoomProject: { roomId: 'qa-origin-room', status: 'none', source: null, boardId: null, projectId: null, rootId: null } };
  const denied = await request(fixture, 'POST', '/chat/send', body);
  assert.equal(denied.status, 409); assert.equal(denied.body.code, 'PROJECT_WORKSPACE_CHANGED');
  assert.equal(denied.body.dispatchStatus, 'rejected');
  const state = fixture.snapshot();
  assert.equal(state.original, null); assert.equal(state.persisted.origins.length, 0); assert.equal(state.persisted.requests, 1);
  assert.deepEqual(state.fakeRpc, []); assert.equal(state.retainedOutputSha256, null);
  assert.deepEqual(state.requests.at(-1).request.expectedRoomProject, body.expectedRoomProject, 'Fixture does not override the incoming expectation');
  const replay = await request(fixture, 'POST', '/chat/send', body);
  assert.equal(replay.body.accepted, false); assert.equal(replay.body.code, 'PROJECT_WORKSPACE_CHANGED');
  assert.deepEqual(fixture.snapshot().fakeRpc, []);
});

test('origin fixture: CURRENT source is separately counted while HISTORIC output and original root survive another Board', async t => {
  const { fixture } = await setup(t); await seed(fixture);
  const old = await output(fixture), before = fixture.snapshot();
  assert.equal((await control(fixture, 'advance-current')).status, 200);
  assert.equal((await control(fixture, 'choose-other-default')).status, 200);
  const room = (await request(fixture, 'POST', '/v1/files/projects/room-default', { roomId: before.preparedRoom })).body.result;
  assert.equal(room.project.projectId, before.projects.other.projectId);
  const beforeReads = fixture.snapshot();
  const verified = (await origin(fixture)).body;
  assert.equal(verified.rootId, before.projects.original.rootId); assert.notEqual(verified.rootId, before.projects.other.rootId);
  const listed = await request(fixture, 'POST', '/v1/files/list', { directoryId: verified.directoryId, cursor: 0, limit: 100 });
  assert.equal(listed.status, 200);
  const resolved = await request(fixture, 'POST', '/v1/files/resolve', { rootId: verified.rootId, path: before.sourcePath });
  assert.equal(resolved.status, 200);
  const fileId = resolved.body.result.id;
  const read = await request(fixture, 'POST', '/v1/files/read', { fileId });
  assert.equal(read.status, 200); assert.match(JSON.stringify(read.body), /CURRENT/); assert.doesNotMatch(JSON.stringify(read.body), /OTHER_BOARD_DO_NOT_READ/);
  const draft = await request(fixture, 'POST', '/v1/files/drafts/create', { fileId });
  assert.equal(draft.status, 200);
  const reread = await request(fixture, 'POST', '/v1/files/drafts/read', { draftId: draft.body.result.id });
  assert.equal(reread.status, 200);
  assert.equal((await origin(fixture)).body.rootId, verified.rootId);
  assert.deepEqual(assertOriginReadWindow(beforeReads, fixture.snapshot()), {
    fileId, draftId: draft.body.result.id, originReads: 2, managedDraftSqlWrites: 1,
  }, 'The verifier validates actual runtime/file-service receipts, not only model inputs');
  assert.deepEqual(await output(fixture), old, 'Retained bytes and identity never become the current file');
  const after = fixture.snapshot();
  assert.equal(after.effects.controlledSourceWrites, 1); assert.equal(after.effects.uiOriginalWrites, 0); assert.equal(after.effects.uiOriginalWriteAttempts, 0);
  assert.equal(after.effects.managedDraftSqlWrites, 1); assert.equal(after.persisted.drafts, 1);
  assert.deepEqual(after.persisted.origins, before.persisted.origins);
  assert.equal(after.sourceSha256, hash(CHAT_ORIGIN_FILE_TEXT.current)); assert.equal(after.otherSha256, before.otherSha256);
  assert.deepEqual(after.registrations, before.registrations); assert.deepEqual(after.fakeRpc, before.fakeRpc);
});

test('origin fixture: missing source, disconnected root, changed account and replaced root never fall back', async t => {
  for (const action of ['missing-file', 'disconnect-root', 'account-change', 'replace-root']) await t.test(action, async t => {
    const { fixture } = await setup(t); await seed(fixture); await control(fixture, 'advance-current');
    const before = fixture.snapshot(), retained = await output(fixture);
    assert.equal((await control(fixture, action)).status, 200);
    const verified = await origin(fixture);
    assert.equal(verified.status, action === 'account-change' ? 403 : 200);
    if (action === 'missing-file') {
      assert.equal(verified.body.verified, true);
      const missing = await request(fixture, 'POST', '/v1/files/resolve', { rootId: verified.body.rootId, path: before.sourcePath });
      assert.notEqual(missing.status, 200);
    } else {
      if (action !== 'account-change') assert.equal(verified.body.verified, false);
      assert.equal(Object.hasOwn(verified.body, 'rootId'), false);
    }
    assert.deepEqual(await output(fixture), retained, 'Origin refusal does not replace the already retained output');
    const after = fixture.snapshot();
    assert.equal(after.retainedOutputSha256, before.retainedOutputSha256, 'Denial does not rewrite the retained HISTORIC bytes');
    assert.deepEqual(after.registrations, before.registrations); assert.deepEqual(after.fakeRpc, before.fakeRpc);
    assert.equal(after.effects.uiOriginalWrites, 0); assert.equal(after.effects.managedDraftSqlWrites, 0);
    assert.equal(after.otherSha256, before.otherSha256);
    assert.equal(after.requests.some(row => row.path === '/v1/files/read'), false);
  });
});

test('origin fixture: token/origin/route guards consume unsafe routes without a synthetic fallback', async t => {
  const { fixture } = await setup(t);
  assert.equal((await request(fixture, 'GET', CHAT_ORIGIN_FILE_STATE)).status, 403);
  assert.equal((await request(fixture, 'GET', CHAT_ORIGIN_FILE_STATE, undefined, { token: true, headers: { origin: 'https://outside.invalid' } })).status, 403);
  assert.equal((await request(fixture, 'GET', '/chat/state', undefined, { remoteAddress: '192.0.2.1' })).status, 403);
  for (const route of ['/chat/unknown', '/chat/approval', '/chat/user-input', '/chat/resume', '/chat/history/import', '/terminal/spawn', '/providers/start',
    '/v1/files/picker/begin', '/v1/files/roots', '/v1/files/drafts/save-original', '/v1/files/git/status', '/v1/files/drafts/update']) {
    const result = await request(fixture, 'POST', route, {}); assert.equal(result.handled, true); assert.equal(result.status, 403);
  }
  assert.equal((await request(fixture, 'GET', '/v1/state')).handled, false, 'Only non-Chat common transport state may be delegated to the host');
  assert.equal(fixture.snapshot().effects.uiOriginalWriteAttempts, 1); assert.equal(fixture.snapshot().effects.uiOriginalWrites, 0);
  assert.equal(fixture.snapshot().fakeRpc.length, 0);
  await seed(fixture);
  const invalid = await request(fixture, 'GET', `/chat/run-project-origin?${query(fixture.snapshot().original)}&itemId=forbidden`);
  assert.equal(invalid.status, 400); assert.equal(invalid.body.code, 'INVALID_RUN_ORIGIN_QUERY');
  assert.equal(fixture.snapshot().requests.at(-1).delegated, true);
  const root = fixture.snapshot().root;
  await fixture.dispose(); await fixture.dispose();
  assert.equal(fs.existsSync(root), true, 'Disposal preserves owned evidence');
  assert.equal((await request(fixture, 'GET', '/chat/state')).status, 503);
});
