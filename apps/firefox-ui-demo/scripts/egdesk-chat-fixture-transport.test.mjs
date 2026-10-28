import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHmac, randomUUID, createHash } from 'node:crypto';
import path from 'node:path';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import vm from 'node:vm';
import net from 'node:net';
import http from 'node:http';
import * as BriefingState from '../overlay/resources/EGDeskBriefingState.sys.mjs';
import { bootstrapQaProfile, canonicalTempRoot, LOADER_FILES } from './egdesk-chat-qa-profile.mjs';
import { createQaFixtureTransport, CLAUDE_FIXTURE_QUESTIONS, CLAUDE_FIXTURE_TEXT } from './egdesk-chat-fixture-transport.mjs';
import { chatRunOutputFixtureIds, CHAT_RUN_OUTPUT_MARKER, CHAT_RUN_DIFF_MARKER } from './egdesk-chat-run-outputs-fixture.mjs';
import { TASK_GATE_SEED_MESSAGE } from './egdesk-task-gate-fixture.mjs';
import { CHAT_ORIGIN_FILE_SEED, CHAT_ORIGIN_FILE_TEXT, CHAT_ORIGIN_FILE_OUTPUT } from './egdesk-chat-origin-file-fixture.mjs';
import { prepareQaFirefox } from './run-firefox-mcp-target.mjs';
import { assertNativeTerminalExit, assertQaFixtureArtifact } from './egdesk-chat-qa-contract.sys.mjs';
import { createChatProtocolState, mergeChatSnapshot, projectRunMessages, usableArtifact,
  normalizeLocalHistoryPage, hydrateLocalChatThread, mergeLocalChatMessages } from '../overlay/resources/EGDeskChatState.sys.mjs';
import { createEGDeskFileServiceCallbacks, createEGDeskNativeFilePickers } from '../overlay/resources/EGDeskFileView.sys.mjs';
import { assertPublishedBriefing, assertContextCaptureBatch, assertStoredAgentDelivery,
  captureContextReadEvidence, fingerprintQaBytes } from './egdesk-context-qa-contract.mjs';

const TOKEN = 'unit-fixture-token-no-credentials';
const FIXTURE_ENV = { EGDESK_QA_FIXTURE_TRANSPORT: '1', EGDESK_QA_FIXTURE_PORT: '49318' };

function setup(t, { claude = false, reader = false, projectFile = false, runOutputs = false, portable = false, taskGate = false, originFile = false, stateFixtures = false, sourceChangeSeed = false, briefingComments = false, firstAuth = false, fixturePort = FIXTURE_ENV.EGDESK_QA_FIXTURE_PORT } = {}) {
  const source = fs.mkdtempSync(path.join(canonicalTempRoot(), 'egdesk-loader-fixture-'));
  for (const name of LOADER_FILES) fs.writeFileSync(path.join(source, name), `unit fixture ${name}\n`);
  const { profile } = bootstrapQaProfile({ loaderSource: source });
  t.after(() => {
    for (const [directory, prefix] of [[profile, 'egdesk-chat-test-'], [source, 'egdesk-loader-fixture-']]) {
      assert.equal(path.dirname(directory), canonicalTempRoot());
      assert.ok(path.basename(directory).startsWith(prefix));
      fs.rmSync(directory, { recursive: true, force: false });
    }
  });
  const fetchBefore = globalThis.fetch;
  const eventSourceBefore = globalThis.EventSource;
  const fixtureEnv = { ...FIXTURE_ENV, EGDESK_QA_FIXTURE_PORT: String(fixturePort), ...(projectFile ? { EGDESK_QA_PROJECT_FILE_FIXTURE: '1', EGDESK_QA_REAL_TURN: '0' } : {}),
    ...(firstAuth ? { EGDESK_QA_FIRST_CODEX_AUTH_FIXTURE: '1', EGDESK_QA_REAL_TURN: '0' } : {}),
    ...(stateFixtures || sourceChangeSeed || briefingComments ? { EGDESK_QA_STATE_FIXTURES: '1', EGDESK_QA_REAL_TURN: '0' } : {}),
    ...(sourceChangeSeed ? { EGDESK_QA_CONTEXT_SOURCE_CHANGE_SEED: '1' } : {}),
    ...(briefingComments ? { EGDESK_QA_BRIEFING_COMMENTS_SEED: '1' } : {}),
    ...(runOutputs ? { EGDESK_QA_RUN_OUTPUTS_FIXTURE: '1', EGDESK_QA_REAL_TURN: '0' } : {}),
    ...(portable ? { EGDESK_QA_PORTABLE_TRANSFER_FIXTURE: '1', EGDESK_QA_REAL_TURN: '0' } : {}),
    ...(taskGate ? { EGDESK_QA_TASK_GATE_FIXTURE: '1', EGDESK_QA_REAL_TURN: '0' } : {}),
    ...(originFile ? { EGDESK_QA_CHAT_ORIGIN_FILE_FIXTURE: '1', EGDESK_QA_REAL_TURN: '0' } : {}) };
  prepareQaFirefox(profile, { env: fixtureEnv });
  const transport = createQaFixtureTransport({ profile, token: TOKEN,
    env: { ...fixtureEnv, ...(claude ? { EGDESK_QA_CLAUDE_FIXTURE: '1' } : {}),
      ...(reader ? { EGDESK_QA_CLAUDE_READER_FIXTURE: '1', EGDESK_QA_REAL_TURN: '0' } : {}) } });
  t.after(() => transport.dispose());
  assert.equal(globalThis.fetch, fetchBefore);
  assert.equal(globalThis.EventSource, eventSourceBefore);
  return transport;
}

async function request(handler, method, url, body = null, token = null, onResponse = () => {}, extraHeaders = {}, rawBody) {
  const req = Readable.from(rawBody !== undefined ? [Buffer.from(rawBody)] : body === null ? [] : [Buffer.from(JSON.stringify(body))]);
  Object.assign(req, { method, url, headers: { ...(token ? { 'x-egdesk-qa-token': token } : {}), ...extraHeaders } });
  let status;
  let headers = {};
  let resolve;
  const completed = new Promise((done) => { resolve = done; });
  const res = Object.assign(new EventEmitter(), {
    setHeader(name, value) { headers[name] = value; },
    writeHead(value, nextHeaders = {}) { status = value; headers = nextHeaders; },
    end(value = '') { this.writableEnded = true;
      resolve({ status, body: value ? (/application\/json/.test(headers['Content-Type'] || '') ? JSON.parse(value) : value) : null });
      if (!this.deferFinish) { this.writableFinished = true; this.emit('finish'); }
      if (!this.deferClose) this.emit('close'); },
    destroy() { this.destroyed = true; this.emit('close'); resolve({ status: 0, body: null }); },
    flushHeaders() { this.headersSent = true; },
    write(value, callback) { callback?.(); return true; },
  });
  onResponse(res);
  await handler(req, res);
  return completed;
}

const sendRunOutputs = (handler, scenario = 'RUN_OUTPUTS') => request(handler, 'POST', '/chat/send', {
  message: `EGDESK_QA_${scenario} handler-only unit`, profileEnabled: false,
  clientThreadId: `qa-output-${scenario}`, requestId: `qa-output-${scenario}` });
const outputRoute = (path, run, itemId) => `${path}?${new URLSearchParams({ conversationId: run.conversationId, runId: run.runId,
  ...(itemId === undefined ? {} : { itemId }) })}`;

const commentR = room => ({ engineId: room.engineId, engineProfileId: room.engineProfileId,
  clientThreadId: room.clientThreadId, conversationId: room.conversationId, briefingId: room.briefing.id });
const commentURL = (room, patch = {}) => {
  const { briefingId, ...query } = { ...commentR(room), ...patch };
  return `/context/briefings/${briefingId}/comments?${new URLSearchParams(query)}`;
};
const commentBody = (room, extra = {}) => ({ stepId: room.briefing.steps[0].id, text: 'QA saved comment', clientRequestId: randomUUID(), ...extra });
async function setupComments(t, options = {}) {
  const transport = setup(t, { briefingComments: true, ...options });
  await transport.ready;
  const headers = { host: `${transport.info.host}:${transport.info.port}`, 'content-type': 'application/json', origin: 'chrome://browser' };
  const send = (method, url, body = null, control = false, onResponse = () => {}) => request(transport.handler,
    method, url, body, control ? TOKEN : null, onResponse, headers);
  const state = async () => (await send('GET', '/__qa/state', null, true)).body;
  const seed = (await state()).briefingCommentsSeed;
  return { ...transport, send, state, seed,
    arm: (room, extra = {}) => send('POST', '/__qa/briefing-comments/config', { ...commentR(room), mode: 'hold',
      bindNextPost: true, deadlineAt: Date.now() + 5000, ...extra }, true),
    release: (room, receipt, extra = {}) => send('POST', '/__qa/briefing-comments/release', { ...commentR(room),
      holdId: receipt.holdId, requestId: receipt.requestId, clientRequestId: receipt.clientRequestId, ...extra }, true) };
}
async function waitCommentReceipt(fixture, predicate) {
  const deadline = Date.now() + 3000;
  do {
    const row = (await fixture.state()).briefingComments.receipts.find(predicate);
    if (row) return row;
    await new Promise(resolve => setTimeout(resolve, 2));
  } while (Date.now() < deadline);
  assert.fail('Expected bounded comment receipt did not arrive');
}

function assertPartialCommentResponse(receipt, completedAt) {
  assert.equal(receipt.writeAttempted, true);
  assert.equal(receipt.endReturnedAt, null); assert.equal(receipt.finishAt, null);
  assert.equal(receipt.writableFinishedAtClose, false);
  const fault = receipt.responseFault;
  assert.equal(fault.mode, 'partial-json'); assert.equal(fault.attemptedBodyBytes, 1);
  assert.ok(fault.expectedBodyBytes > fault.attemptedBodyBytes);
  assert.ok(fault.headersFlushedAt >= completedAt);
  assert.ok(fault.writeCompletedAt >= fault.headersFlushedAt);
  assert.ok(fault.cutAt >= fault.writeCompletedAt);
  assert.ok(receipt.closeAt >= fault.cutAt);
}

async function setupOriginMount(t) {
  const transport = setup(t, { originFile: true });
  assert.ok(transport.ready instanceof Promise);
  const headers = { host: '127.0.0.1:49318', 'content-type': 'application/json', origin: 'chrome://browser' };
  const send = (method, route, body = null, token = null, extra = {}) => request(transport.handler, method, route, body, token, () => {}, { ...headers, ...extra });
  const initial = await send('GET', '/__qa/state', null, TOKEN); // Handler waits for the async real mount.
  assert.equal(initial.status, 200); const root = initial.body.chatOriginFile.root;
  t.after(async () => {
    await transport.dispose(); assert.equal(path.dirname(root), canonicalTempRoot());
    assert.equal(fs.realpathSync.native(root), root); assert.ok(path.basename(root).startsWith('egdesk-chat-origin-file-'));
    fs.rmSync(root, { recursive: true });
  });
  const state = async () => (await send('GET', '/__qa/chat-origin-file/state', null, TOKEN)).body;
  const control = (action, extra = {}) => send('POST', '/__qa/chat-origin-file/control', { action, ...extra }, TOKEN);
  const seed = async () => {
    assert.equal((await control('prepare-room', { clientThreadId: 'owned-origin-room' })).status, 200);
    const room = await send('POST', '/v1/files/projects/room-default', { roomId: 'owned-origin-room' });
    assert.equal(room.status, 200); const view = room.body.result;
    const expectedRoomProject = { roomId: view.roomId, status: view.status, source: view.source, boardId: view.inheritance.boardId,
      projectId: view.project.projectId, rootId: view.project.rootId };
    return send('POST', '/chat/send', { message: CHAT_ORIGIN_FILE_SEED, clientThreadId: 'owned-origin-room',
      requestId: 'owned-origin-request', profileEnabled: false, expectedRoomProject });
  };
  return { transport, send, state, seed, control, initial: initial.body, headers };
}

test('Origin async mount owns real Chat and room project reads before every synthetic fallback, no listener/provider', async t => {
  const fetchSpy = t.mock.method(globalThis, 'fetch', () => assert.fail('No external network'));
  const listenSpy = t.mock.method(net.Server.prototype, 'listen', () => assert.fail('No listener'));
  const { transport, send, state, seed, initial } = await setupOriginMount(t);
  await transport.ready;
  assert.equal(initial.chatOriginFileFixture, true); assert.equal(initial.providerTurns, 0);
  assert.deepEqual(initial.chatOriginFile.persisted.origins, []);
  assert.equal(initial.chatOriginFile.effects.profileCatalogWrites, 1);
  assert.equal((await send('GET', '/health')).body.ok, true, 'false handle still reaches discovery');
  const accepted = await seed(); assert.equal(accepted.status, 202); assert.equal(accepted.body.accepted, true);
  const after = await state(); assert.equal(after.persisted.origins.length, 1);
  assert.equal(after.original.runId, accepted.body.runId); assert.equal(after.original.clientThreadId, 'owned-origin-room');
  assert.equal(after.persisted.origins[0].project.startCwd, after.folders.original);
  const room = (await send('POST', '/v1/files/projects/room-default', { roomId: 'owned-origin-room' })).body.result;
  assert.equal(room.project.projectId, after.projects.original.projectId, 'not the common canonical empty default');
  for (const route of ['/chat/state', '/chat/history?clientThreadId=owned-origin-room']) {
    const response = await send('GET', route); assert.equal(response.status, 200); assert.ok(JSON.stringify(response.body).includes(after.original.runId));
  }
  const common = (await send('GET', '/__qa/state', null, TOKEN)).body;
  assert.deepEqual(common.runs, []); assert.deepEqual(common.observed.sends, []); assert.equal(common.observed.roomDefaultReads, undefined);
  assert.deepEqual(common.chatOriginFile.fakeRpc.map(row => row.method), ['thread/start', 'turn/start']);
  assert.equal(fetchSpy.mock.callCount(), 0); assert.equal(listenSpy.mock.callCount(), 0);
});

test('Origin mount forwards unchanged real SSE, pins HISTORIC output and opens CURRENT through actual File/managed-draft SQL', async t => {
  const { transport, send, state, seed, control, headers } = await setupOriginMount(t), frames = [];
  const req = Object.assign(new EventEmitter(), { method: 'GET', url: '/events?chatProtocol=2', headers });
  const res = { writeHead(status) { assert.equal(status, 200); }, write(wire) { frames.push(wire); return true; } };
  await transport.handler(req, res); t.after(() => req.emit('close'));
  await seed(); const before = await state(), original = before.original;
  const events = frames.filter(wire => wire.startsWith('event: codex\n')).map(wire => JSON.parse(wire.split('\ndata: ')[1]));
  for (const frame of before.frames) assert.ok(events.some(event => JSON.stringify(event) === JSON.stringify(frame)));
  assert.ok(events.some(frame => frame.event === 'activity.completed' && frame.itemId === original.itemId));
  const query = new URLSearchParams({ conversationId: original.conversationId, runId: original.runId });
  const outputPath = `/chat/command-output?${query}&itemId=${original.itemId}`;
  const historical = await send('GET', outputPath); assert.equal(historical.body.head + historical.body.tail, CHAT_ORIGIN_FILE_OUTPUT);
  assert.equal((await control('advance-current')).status, 200);
  assert.equal((await control('choose-other-default')).status, 200);
  const origin = await send('GET', `/chat/run-project-origin?${query}`);
  assert.equal(origin.status, 200); assert.equal(origin.body.verified, true);
  assert.equal(origin.body.rootId, before.projects.original.rootId);
  const resolved = await send('POST', '/v1/files/resolve', { rootId: origin.body.rootId, path: before.sourcePath });
  assert.equal(resolved.status, 200); const fileId = resolved.body.result.id;
  const read = await send('POST', '/v1/files/read', { fileId }); assert.equal(read.status, 200);
  assert.match(JSON.stringify(read.body), /CURRENT/); assert.doesNotMatch(JSON.stringify(read.body), /OTHER_BOARD_DO_NOT_READ/);
  assert.equal((await send('POST', '/v1/files/drafts/create', { fileId })).status, 200);
  assert.deepEqual(await send('GET', outputPath), historical);
  const after = await state(); assert.deepEqual(after.persisted.origins, before.persisted.origins);
  assert.equal(after.effects.managedDraftSqlWrites, 1); assert.equal(after.persisted.drafts, 1);
  assert.equal(after.effects.uiOriginalWrites, 0); assert.equal(after.effects.controlledSourceWrites, 1);
  assert.equal(fs.readFileSync(after.sourcePath, 'utf8'), CHAT_ORIGIN_FILE_TEXT.current);
  assert.equal(after.otherSha256, before.otherSha256); assert.deepEqual(after.fakeRpc, before.fakeRpc);
});

test('Origin unknown Chat/File paths and writes are consumed/refused, preserving token/origin/CORS guards', async t => {
  const { send, state } = await setupOriginMount(t);
  assert.equal((await send('OPTIONS', '/chat/run-project-origin')).status, 204);
  assert.equal((await send('OPTIONS', '/v1/files/read')).status, 204);
  assert.equal((await send('GET', '/__qa/chat-origin-file/state')).status, 403);
  assert.equal((await send('GET', '/chat/state', null, null, { origin: 'https://outside.invalid' })).status, 403);
  assert.equal((await send('GET', '/chat/state', null, null, { host: 'outside.invalid' })).status, 400);
  for (const route of ['/chat/approval', '/chat/user-input', '/chat/not-real', '/v1/files/not-real',
    '/v1/files/projects/room-default/save', '/v1/files/picker/begin', '/terminal/spawn', '/providers/start']) {
    assert.equal((await send('POST', route, {})).status, 403, route);
  }
  assert.equal((await send('POST', '/chat/send', { message: 'EGDESK_QA_COMPLETE forbidden fallback',
    profileEnabled: false, clientThreadId: 'room', requestId: 'request' })).status, 403);
  const after = await state(); assert.deepEqual(after.fakeRpc, []); assert.deepEqual(after.persisted.origins, []);
  assert.equal(after.effects.approvalPosts, 2, 'rejected attempts remain distinguishable from successful writes');
  const common = (await send('GET', '/__qa/state', null, TOKEN)).body;
  assert.deepEqual(common.observed.approvals, []); assert.deepEqual(common.observed.userInputs, []);
});

test('Origin mount rejects a prefs-bearing profile before common writes and awaits disposal even during initialization', async t => {
  const transport = setup(t, { originFile: true });
  const closing = transport.dispose(); assert.ok(closing instanceof Promise); assert.equal(transport.dispose(), closing);
  await closing; const fixture = await transport.ready, snapshot = fixture.snapshot();
  assert.equal(snapshot.disposed, true);
  t.after(() => {
    const root = snapshot.root; assert.equal(path.dirname(root), canonicalTempRoot());
    assert.equal(fs.realpathSync.native(root), root); assert.ok(path.basename(root).startsWith('egdesk-chat-origin-file-'));
    fs.rmSync(root, { recursive: true });
  });
  const prefs = path.join(transport.info.profile, 'prefs.js'), before = fs.readFileSync(prefs);
  const mkdir = t.mock.method(fs, 'mkdtempSync', () => assert.fail('No writes before prefs guard'));
  try {
    assert.throws(() => createQaFixtureTransport({ profile: transport.info.profile, token: TOKEN,
      env: { ...FIXTURE_ENV, EGDESK_QA_CHAT_ORIGIN_FILE_FIXTURE: '1', EGDESK_QA_REAL_TURN: '0' } }), /prefs-less/);
    assert.equal(mkdir.mock.callCount(), 0);
  } finally { mkdir.mock.restore(); }
  assert.deepEqual(fs.readFileSync(prefs), before);
  const after = await request(transport.handler, 'POST', '/chat/send', {}, null, () => {}, { host: '127.0.0.1:49318' });
  assert.equal(after.status, 503); assert.equal(after.body.code, 'QA_FIXTURE_CLOSED');
});

async function setupTaskMount(t) {
  const transport = setup(t, { taskGate: true });
  assert.ok(transport.ready instanceof Promise, 'Task adds async readiness without changing the sync factory');
  const headers = { host: '127.0.0.1:49318', 'content-type': 'application/json', origin: 'chrome://browser' };
  const send = (method, route, body = null, token = null, extra = {}) => request(transport.handler, method, route, body, token, () => {}, { ...headers, ...extra });
  // Intentionally issue a request before await ready: the handler must wait,
  // never race the generic synthetic Chat fallback during initialization.
  const initial = await send('GET', '/__qa/state', null, TOKEN);
  assert.equal(initial.status, 200); const root = initial.body.taskGate.root;
  t.after(async () => {
    await transport.dispose();
    assert.equal(path.dirname(root), canonicalTempRoot()); assert.equal(fs.realpathSync.native(root), root);
    assert.ok(path.basename(root).startsWith('egdesk-task-gate-')); fs.rmSync(root, { recursive: true });
  });
  const state = async () => (await send('GET', '/__qa/task-gate/state', null, TOKEN)).body;
  const seed = () => send('POST', '/chat/send', { message: TASK_GATE_SEED_MESSAGE, profileEnabled: false,
    clientThreadId: 'owned-task-mount-room', requestId: 'owned-task-mount-request',
    expectedRoomProject: { roomId: 'owned-task-mount-room', status: 'none', source: null, boardId: null, projectId: null, rootId: null } });
  const control = action => send('POST', '/__qa/task-gate/control', { action }, TOKEN);
  return { transport, send, state, seed, control, initial: initial.body, headers };
}

test('Task async mount owns actual Chat/Task HTTP and workflow SQLite before common fallback, without a listener/provider', async t => {
  const fetchSpy = t.mock.method(globalThis, 'fetch', () => assert.fail('no provider/network request'));
  const listenSpy = t.mock.method(net.Server.prototype, 'listen', () => assert.fail('factory must not listen'));
  const { transport, send, state, seed, initial } = await setupTaskMount(t);
  await transport.ready;
  assert.equal(initial.taskGateFixture, true); assert.equal(initial.providerTurns, 0);
  assert.equal(initial.taskGate.persisted.journalCount, 0);
  assert.equal((await send('GET', '/health')).body.ok, true, 'false sidecar handle reaches normal discovery');
  assert.equal((await send('POST', '/v1/files/projects/room-default', { roomId: 'owned-task-mount-room' })).body.result.status, 'none');
  const sent = await seed(); assert.equal(sent.status, 202); assert.equal(sent.body.accepted, true);
  const after = await state(); assert.equal(after.plans.length, 1);
  assert.equal(after.original.runId, sent.body.runId); assert.equal(after.original.clientThreadId, 'owned-task-mount-room');
  assert.equal(after.fakeProviderTurns.length, 1); assert.equal(after.providerTurns, 0);
  assert.ok(after.persisted.journalCount > 0);
  const graph = await send('GET', `/tasks/state?graphId=${after.plans[0].graphId}`);
  assert.equal(graph.status, 200); assert.equal(graph.body.graph.graphId, after.plans[0].graphId);
  const chat = await send('GET', `/chat/state?conversationId=${after.original.conversationId}`);
  assert.equal(chat.status, 200); assert.ok(JSON.stringify(chat.body).includes(after.original.runId));
  const common = (await send('GET', '/__qa/state', null, TOKEN)).body;
  assert.deepEqual(common.runs, []); assert.deepEqual(common.observed.sends, [], 'generic send was not used');
  assert.equal(common.taskGate.requests.find(row => row.path === '/chat/send').delegated, true);
  assert.equal(fetchSpy.mock.callCount(), 0); assert.equal(listenSpy.mock.callCount(), 0);
});

test('Task broadcasts unchanged real graph/chat frames through existing codex SSE and continue stays real/stale', async t => {
  const { transport, send, state, seed, control, headers } = await setupTaskMount(t), frames = [];
  const req = Object.assign(new EventEmitter(), { method: 'GET', url: '/events?chatProtocol=2', headers });
  const res = { writeHead(status) { assert.equal(status, 200); }, write(wire) { frames.push(wire); return true; } };
  await transport.handler(req, res); t.after(() => req.emit('close'));
  assert.match(frames[0], /^event: ready/);
  await seed(); const before = await state(), plan = before.plans[0];
  const events = frames.filter(wire => wire.startsWith('event: codex\n')).map(wire => JSON.parse(wire.split('\ndata: ')[1]));
  const graphFrame = before.frames.find(frame => frame.type === 'task.graph');
  assert.ok(graphFrame); assert.ok(events.some(frame => JSON.stringify(frame) === JSON.stringify(graphFrame)));
  assert.ok(events.some(frame => frame.type === 'chat.event' && frame.clientThreadId === before.original.clientThreadId));
  const body = { boardId: plan.boardId, scope: plan.scope, taskId: 'send', gateId: 'how', answer: { choice: 'kakao' } };
  assert.equal((await send('POST', '/tasks/continue', body)).status, 200);
  const duplicate = await send('POST', '/tasks/continue', body);
  assert.equal(duplicate.status, 409); assert.equal(duplicate.body.code, 'TASK_GATE_STALE');
  for (let i = 0; i < 100 && (await state()).fakeProviderTurns.length < 2; i++) await new Promise(resolve => setImmediate(resolve));
  const after = await state(); assert.equal(after.fakeProviderTurns.length, 2);
  assert.ok(after.fakeProviderTurns.every(turn => turn.conversationId === before.original.conversationId));
  assert.equal((await control('complete-turn')).status, 200);
  req.emit('close'); assert.equal((await send('GET', '/__qa/state', null, TOKEN)).body.clients, 0);
});

test('Task controls/HTTP keep token, CORS, loopback and refusal semantics; unsupported send cannot fall back', async t => {
  const { send, state } = await setupTaskMount(t);
  assert.equal((await send('OPTIONS', '/tasks/continue')).status, 204);
  assert.equal((await send('GET', '/__qa/task-gate/state')).status, 403);
  assert.equal((await send('POST', '/__qa/task-gate/control', { action: 'refresh' }, TOKEN, { origin: 'https://outside.invalid' })).status, 403);
  assert.equal((await send('GET', '/tasks/state', null, null, { host: 'outside.invalid' })).status, 400);
  for (const route of ['/terminal/spawn', '/providers/start', '/tasks/invented']) {
    assert.equal((await send('POST', route, {})).status, 403);
  }
  assert.equal((await send('POST', '/chat/send', { message: 'EGDESK_QA_COMPLETE must not reach generic fixture',
    profileEnabled: false, clientThreadId: 'wrong-room', requestId: 'wrong-request' })).status, 403);
  assert.equal((await state()).fakeProviderTurns.length, 0);
});

test('awaited Task disposal releases a held real request and refuses post-close dispatch without replay', async t => {
  const { transport, send, state, seed, control } = await setupTaskMount(t);
  await seed(); const before = await state(), plan = before.plans[0];
  await control('hold-next');
  const pending = send('POST', '/tasks/continue', { boardId: plan.boardId, scope: plan.scope,
    taskId: 'send', gateId: 'how', answer: { choice: 'email' } });
  let held;
  for (let i = 0; i < 100; i++) { held = await state(); if (held.held) break; await new Promise(resolve => setImmediate(resolve)); }
  assert.ok(held.held);
  const close = transport.dispose(); assert.ok(close instanceof Promise); assert.equal(transport.dispose(), close);
  await close;
  assert.equal((await pending).status, 503);
  assert.equal((await send('POST', '/chat/send', {})).status, 503);
  assert.equal((await transport.ready).snapshot().disposed, true);
});

test('portable opt-in mounts real Profile/Desk HTTP and SQLite without a second server or provider', async t => {
  const fetchSpy = t.mock.method(globalThis, 'fetch', () => assert.fail('no provider/network forwarding'));
  const transport = setup(t, { portable: true }), { handler } = transport;
  const headers = { host: '127.0.0.1:49318', 'content-type': 'application/json', origin: 'chrome://browser' };
  const send = (method, route, body = null, token = null) => request(handler, method, route, body, token, () => {}, headers);
  const before = (await send('GET', '/__qa/state', null, TOKEN)).body, fixture = before.portableTransfer;
  t.after(() => {
    transport.dispose();
    assert.equal(path.dirname(fixture.root), canonicalTempRoot());
    assert.equal(fs.realpathSync.native(fixture.root), fixture.root);
    assert.ok(path.basename(fixture.root).startsWith('egdesk-portable-transfer-'));
    fs.rmSync(fixture.root, { recursive: true });
  });
  assert.equal(before.portableTransferFixture, true);
  assert.deepEqual([before.providerTurns, before.nativePickerInvocations, before.nativeProcessSpawns], [0, 0, 0]);
  assert.equal((await send('GET', '/auth/status')).body.isLoggedIn, false);
  const seed = fixture.seed;
  assert.equal((await send('GET', '/profiles')).body.profiles.length, 1);
  const board = await send('GET', `/v1/boards/${seed.boardId}/export?format=json-canvas`);
  assert.equal(board.status, 200); assert.ok(JSON.stringify(board.body.canvas).includes(seed.marker + '_SAVED_BOARD_HEAD'));
  for (const revision of seed.revisions) for (const format of ['md', 'codex-toml']) {
    const response = await send('GET', `/profiles/${seed.profileId}/export?format=${format}&revision=${revision.revision}`);
    assert.equal(response.status, 200); assert.equal(response.body.hash, revision.hash);
    assert.equal(response.body.text, revision.exports[format].text);
  }
  const input = { text: fs.readFileSync(seed.importPath, 'utf8'), filename: seed.importFilename, dryRun: true };
  assert.equal(input.text, seed.importText);
  const preview = await send('POST', '/profiles/import', input);
  assert.equal(preview.status, 200); assert.equal(preview.body.dryRun, true);
  const previewState = (await send('GET', '/__qa/portable-transfer/state', null, TOKEN)).body;
  assert.deepEqual(previewState.persisted, fixture.initial, 'read/preview routes cannot fabricate a saved draft');
  const saved = await send('POST', '/profiles/import', { ...input, dryRun: false });
  assert.equal(saved.status, 201); assert.equal(saved.body.profile.activeRevision, null);
  const after = (await send('GET', '/__qa/state', null, TOKEN)).body;
  assert.equal(after.portableTransfer.persisted.profiles.records.length, fixture.initial.profiles.records.length + 1);
  assert.deepEqual(after.portableTransfer.persisted.desk, fixture.initial.desk);
  assert.deepEqual(after.runs, []); assert.deepEqual(after.observed.sends, []); assert.deepEqual(after.observed.authWrites, []);
  assert.deepEqual(fs.readdirSync(fixture.exportsDir), [], 'native export-file writing is not claimed by handler tests');
  assert.equal(fetchSpy.mock.callCount(), 0);
});

test('portable mount rejects activation/room/provider/terminal mutations before generic fixture fallbacks', async t => {
  const transport = setup(t, { portable: true }), { handler } = transport;
  const headers = { host: '127.0.0.1:49318', 'content-type': 'application/json', origin: 'chrome://browser' };
  const send = (method, route, body = null, token = null, extra = {}) => request(handler, method, route, body, token, () => {}, { ...headers, ...extra });
  const before = (await send('GET', '/__qa/state', null, TOKEN)).body;
  const fixture = before.portableTransfer;
  t.after(() => {
    transport.dispose();
    assert.equal(path.dirname(fixture.root), canonicalTempRoot());
    assert.equal(fs.realpathSync.native(fixture.root), fixture.root);
    assert.ok(path.basename(fixture.root).startsWith('egdesk-portable-transfer-'));
    fs.rmSync(fixture.root, { recursive: true });
  });
  const blocked = [`/profiles/${fixture.seed.profileId}/activate`, '/rooms/assign', '/records',
    '/chat/send', '/auth/signout', '/terminal/spawn', '/terminal/write', '/__qa/delta',
    '/v1/files/projects/room-default/save'];
  for (const route of blocked) assert.equal((await send('POST', route, {})).status, 403, route);
  assert.equal((await send('GET', '/__qa/portable-transfer/state')).status, 403);
  for (const route of ['/profiles', '/profiles/import', `/profiles/${fixture.seed.profileId}/export?format=md&revision=1`,
    `/v1/boards/${fixture.seed.boardId}/export?format=json-canvas`]) assert.equal((await send('OPTIONS', route)).status, 204);
  assert.equal((await send('OPTIONS', `/profiles/${fixture.seed.profileId}/activate`)).status, 403);
  assert.equal((await send('OPTIONS', '/profiles', null, null, { origin: 'https://outside.invalid' })).status, 403);
  assert.equal((await send('GET', '/profiles', null, null, { origin: 'https://outside.invalid' })).status, 403);
  const after = (await send('GET', '/__qa/state', null, TOKEN)).body;
  assert.deepEqual(after.portableTransfer.persisted, fixture.initial);
  assert.deepEqual(after.portableTransfer.forbiddenPosts.map(row => row.path), blocked);
  for (const key of ['sends', 'approvals', 'authWrites', 'events']) assert.deepEqual(after.observed[key], before.observed[key]);
  assert.deepEqual(after.runs, []); assert.equal(after.providerTurns, 0);
  transport.dispose();
  assert.equal((await send('GET', '/profiles')).status, 503, 'disposed sidecar cannot fall through to another handler');
});

test('ordinary Chat, Claude/Reader and RunOutputs read only the canonical empty room default without provider or run effects', async t => {
  const fetchSpy = t.mock.method(globalThis, 'fetch', () => { throw new Error('No provider/network forwarding'); });
  const headers = { host: '127.0.0.1:49318', 'content-type': 'application/json', origin: 'chrome://browser' };
  for (const mode of [{}, { claude: true }, { claude: true, reader: true }, { runOutputs: true }]) {
    const { handler } = setup(t, mode);
    const before = (await request(handler, 'GET', '/__qa/state', null, TOKEN)).body;
    for (const roomId of ['actual-client-binding-not-active-board', '한'.repeat(512), ' opaque binding ']) {
      const read = await request(handler, 'POST', '/v1/files/projects/room-default', { roomId }, null, () => {}, headers);
      assert.equal(read.status, 200);
      assert.deepEqual(read.body, { ok: true, result: { roomId, inheritance: null, override: null, project: null, source: null, status: 'none' } });
    }
    const after = (await request(handler, 'GET', '/__qa/state', null, TOKEN)).body;
    assert.equal(after.observed.roomDefaultReads.length, 3);
    assert.deepEqual(after.runs, before.runs); assert.equal(after.seq, before.seq);
    for (const key of ['sends', 'approvals', 'authWrites', 'events']) assert.deepEqual(after.observed[key], before.observed[key]);
    assert.deepEqual(after.context, before.context);
    if (mode.claude || mode.runOutputs) assert.equal(after.providerTurns, 0);
    if (mode.runOutputs) assert.deepEqual(after.runOutputs, before.runOutputs);
  }
  assert.equal(fetchSpy.mock.callCount(), 0);
});

test('ordinary/Claude/Reader/RunOutputs validate HOST observed-none without ignoring it or inventing a verified project', async t => {
  const fetchSpy = t.mock.method(globalThis, 'fetch', () => assert.fail('no provider/network'));
  const socketSpy = t.mock.method(net.Socket.prototype, 'connect', () => assert.fail('no socket'));
  for (const mode of [{}, { claude: true }, { claude: true, reader: true }, { runOutputs: true }]) {
    const { handler } = setup(t, mode), roomId = 'owned-host-none-room';
    const expectedRoomProject = { roomId, status: 'none', source: null, boardId: null, projectId: null, rootId: null };
    const body = { message: `EGDESK_QA_${mode.claude ? 'CLAUDE_TEXT' : mode.runOutputs ? 'RUN_OUTPUTS' : 'TEXT_ONLY'}`,
      profileEnabled: false, clientThreadId: roomId, requestId: 'owned-host-none-send', ...(mode.claude ? { engineId: 'claude' } : {}) };
    const before = (await request(handler, 'GET', '/__qa/state', null, TOKEN)).body;
    const bad = [
      [{ expectedRoomProject: { ...expectedRoomProject, roomId: 'foreign' } }, 409, 'PROJECT_WORKSPACE_CHANGED'],
      [{ expectedRoomProject: { ...expectedRoomProject, status: 'connected', source: 'room', projectId: 'p', rootId: 'r' } }, 409, 'PROJECT_WORKSPACE_CHANGED'],
      [{ expectedRoomProject: { ...expectedRoomProject, rootId: 'r' } }, 400, 'INVALID_EXPECTED_ROOM_PROJECT'],
      [{ expectedRoomProject: { ...expectedRoomProject, cwd: '/outside' } }, 400, 'INVALID_EXPECTED_ROOM_PROJECT'],
      [{ expectedRoomProject: null }, 400, 'INVALID_EXPECTED_ROOM_PROJECT'],
      [{ expectedRoomProject, clientThreadId: undefined }, 400, 'INVALID_PROJECT_SCOPE'],
      [{ expectedRoomProject, roomId: 'different-room' }, 400, 'INVALID_PROJECT_SCOPE'],
      [{ expectedRoomProject, boardId: 'active-board' }, 409, 'PROJECT_WORKSPACE_CHANGED'],
      [{ projectTarget: { boardId: 'b', projectId: 'p', rootId: 'r' } }, 409, 'PROJECT_TARGET_CHANGED'],
    ];
    for (const [patch, status, code] of bad) {
      const result = await request(handler, 'POST', '/chat/send', { ...body, ...patch });
      assert.deepEqual([result.status, result.body.code], [status, code]);
    }
    const refused = (await request(handler, 'GET', '/__qa/state', null, TOKEN)).body;
    assert.deepEqual(refused.observed, before.observed); assert.deepEqual(refused.runs, before.runs); assert.equal(refused.seq, before.seq);
    const result = await request(handler, 'POST', '/chat/send', { ...body, expectedRoomProject });
    assert.equal(result.status, 202); assert.equal(result.body.accepted, true);
    const after = (await request(handler, 'GET', '/__qa/state', null, TOKEN)).body;
    assert.deepEqual(after.observed.sends[0].expectedRoomProject, expectedRoomProject, 'never strip the exact observation from the request');
    assert.deepEqual(after.observed.roomProjectExpectations, [{ clientThreadId: roomId, expectedRoomProject, result: null, contract: 'fixture-owned-no-project' }]);
    if (mode.claude || mode.runOutputs) assert.equal(after.providerTurns, 0);
    const legacy = await request(handler, 'POST', '/chat/send', { ...body, clientThreadId: `${roomId}-legacy`, requestId: 'legacy-without-expectation' });
    assert.equal(legacy.status, 202, 'legacy send without the new optional field is unchanged');
  }
  assert.equal(fetchSpy.mock.callCount(), 0); assert.equal(socketSpy.mock.callCount(), 0);
});

test('empty-default fallback rejects invalid IDs/bodies/origins and unsupported writes; it never accepts a fake saved default', async t => {
  const { handler } = setup(t);
  const route = '/v1/files/projects/room-default';
  const headers = { host: '127.0.0.1:49318', 'content-type': 'application/json' };
  for (const body of [null, {}, [], 'not-an-object', { roomId: null }, { roomId: 1 }, { roomId: '' },
    { roomId: ' \t\n' }, { roomId: 'has\0nul' }, { roomId: 'x'.repeat(513) },
    { roomId: 'room', boardId: 'active-board' }, { roomId: 'room', cwd: '/outside' },
    { roomId: 'room', result: { status: 'connected' } }, { clientThreadId: 'room' }]) {
    assert.equal((await request(handler, 'POST', route, body, null, () => {}, headers)).status, 400);
  }
  assert.equal((await request(handler, 'POST', route, { roomId: 'room' }, null, () => {}, { ...headers, 'content-type': 'text/plain' })).status, 415);
  assert.equal((await request(handler, 'POST', route, { roomId: 'x'.repeat(70 * 1024) }, null, () => {}, headers)).status, 413);
  assert.equal((await request(handler, 'POST', route + '?roomId=other', { roomId: 'room' }, null, () => {}, headers)).status, 400);
  for (const method of ['GET', 'PUT', 'DELETE']) assert.equal((await request(handler, method, route, null, null, () => {}, headers)).status, 405);
  assert.equal((await request(handler, 'OPTIONS', route, null, null, () => {}, headers)).status, 204);
  for (const extra of [{ origin: 'https://foreign.invalid' }, { 'sec-fetch-site': 'same-site' }]) {
    for (const method of ['POST', 'OPTIONS']) assert.equal((await request(handler, method, route, { roomId: 'room' }, null, () => {}, { ...headers, ...extra })).status, 403);
  }
  assert.equal((await request(handler, 'POST', route, { roomId: 'room' }, null, () => {}, { ...headers, host: 'foreign.invalid' })).status, 400);
  for (const pathname of [route + '/save', '/v1/files/projects/attach', '/v1/files/projects/inherit', '/v1/files/projects/detach']) {
    for (const method of ['POST', 'OPTIONS']) assert.equal((await request(handler, method, pathname,
      { roomId: 'room', boardId: 'active-board', expectedProjectId: 'project', expectedRootId: 'root' }, null, () => {}, headers)).status, 404);
  }
  const state = (await request(handler, 'GET', '/__qa/state', null, TOKEN)).body;
  assert.equal(state.observed.roomDefaultReads, undefined);
  assert.deepEqual(state.runs, []); assert.deepEqual(state.observed.sends, []); assert.deepEqual(state.observed.authWrites, []);
});

test('actual project handler wins before the empty fallback and persists/read-backs real Board inheritance', async t => {
  const { handler } = setup(t, { projectFile: true });
  const headers = { host: '127.0.0.1:49318', 'content-type': 'application/json' };
  const post = (route, body, extra = {}) => request(handler, 'POST', route, body, null, () => {},
    { ...headers, ...Object.fromEntries(Object.entries(extra).map(([key, value]) => [key.toLowerCase(), value])) });
  const projectState = async () => (await request(handler, 'GET', '/__qa/project-file/state', null, TOKEN, () => {}, headers)).body;
  const roomId = 'actual-client-binding', boardId = 'qa-default-handler-board';
  assert.equal((await post('/v1/files/projects/room-default', { roomId })).body.result.status, 'none');
  assert.equal((await projectState()).fileRequests.at(-1).operation, 'readRoomProjectDefault');
  await request(handler, 'POST', '/__qa/project-file/config', { pickerResults: ['select-owned'] }, TOKEN, () => {}, headers);
  const service = createEGDeskFileServiceCallbacks({ request: async (route, body, options) => (await post(route, body, options?.headers)).body });
  const picker = createEGDeskNativeFilePickers({ service, pickDirectory: async () =>
    (await post('/__qa/project-file/picker', {})).body.selection });
  await picker.chooseProjectFolder({ boardId, title: 'Owned Board for routing proof' });
  const project = (await service.openProject({ boardId })).project;
  const saved = await post('/v1/files/projects/room-default/save', { roomId, boardId,
    expectedProjectId: project.projectId, expectedRootId: project.rootId });
  assert.equal(saved.status, 200); assert.equal(saved.body.result.status, 'connected');
  const read = await post('/v1/files/projects/room-default', { roomId });
  assert.equal(read.body.result.source, 'board'); assert.equal(read.body.result.project.projectId, project.projectId);
  assert.deepEqual(read.body.result.inheritance, { boardId });
  const persisted = await projectState();
  assert.deepEqual(persisted.roomDefaults, [{ roomId, boardId }]);
  assert.equal(persisted.fileRequests.filter(row => row.operation === 'saveRoomProjectDefault').length, 1);
  const main = (await request(handler, 'GET', '/__qa/state', null, TOKEN)).body;
  assert.equal(main.observed.roomDefaultReads, undefined, 'real project mode never reaches the empty fallback');
  assert.equal(main.providerTurns, 0); assert.deepEqual(main.runs, []); assert.deepEqual(main.observed.sends, []);
});

test('RunOutputs transport mode is explicit, excludes project/Claude/real turns, and leaves default routes disabled', async t => {
  const fixture = setup(t), { handler, info } = fixture;
  const env = { ...FIXTURE_ENV, EGDESK_QA_REAL_TURN: '0', EGDESK_QA_RUN_OUTPUTS_FIXTURE: '1' };
  for (const patch of [{ EGDESK_QA_RUN_OUTPUTS_FIXTURE: 'yes' }, { EGDESK_QA_REAL_TURN: undefined },
    { EGDESK_QA_REAL_TURN: '1' }, { EGDESK_QA_FIXTURE_TRANSPORT: '0' },
    { EGDESK_QA_PROJECT_FILE_FIXTURE: '1' }, { EGDESK_QA_CLAUDE_FIXTURE: '1' }]) {
    assert.throws(() => createQaFixtureTransport({ profile: info.profile, token: TOKEN, env: { ...env, ...patch } }));
  }
  for (const path of ['/chat/command-output', '/chat/run-changes']) {
    for (const method of ['GET', 'OPTIONS', 'POST']) assert.equal((await request(handler, method, path)).status, 404);
  }
  for (const scenario of ['RUN_OUTPUTS', 'RUN_OUTPUTS_LOST']) assert.equal((await sendRunOutputs(handler, scenario)).status, 400);
  const state = (await request(handler, 'GET', '/__qa/state', null, TOKEN)).body;
  assert.equal(state.runOutputsFixture, undefined); assert.equal(state.runOutputs, undefined);
  assert.equal(state.observed.approvalPostAttempts, undefined);
  assert.deepEqual(state.runs, []); assert.deepEqual(state.observed.sends, []);
});

test('RunOutputs HTTP handler preserves loopback/token/CORS/SSE and GET views leave pending approvals unchanged', async t => {
  const fetchSpy = t.mock.method(globalThis, 'fetch', () => { throw new Error('No provider or network access'); });
  const { handler, info } = setup(t, { runOutputs: true });
  assert.equal(info.runOutputsFixture, true); assert.equal(info.providerTurns, 0);
  assert.equal((await request(handler, 'GET', '/__qa/state')).status, 403);
  const state = async () => (await request(handler, 'GET', '/__qa/state', null, TOKEN)).body;
  const initial = await state();
  assert.equal(initial.runOutputsFixture, true); assert.equal(initial.providerTurns, 0);
  assert.deepEqual(initial.runOutputs.requests, []); assert.equal(initial.observed.approvalPostAttempts, 0);
  const wire = [];
  const streamRequest = Object.assign(new EventEmitter(), { method: 'GET', url: '/events?chatProtocol=2', headers: {} });
  const streamResponse = { writeHead(status, headers) { assert.equal(status, 200); assert.equal(headers['Content-Type'], 'text/event-stream'); },
    write(value) { wire.push(value); return true; } };
  await handler(streamRequest, streamResponse); t.after(() => streamRequest.emit('close'));
  const ack = await sendRunOutputs(handler);
  assert.equal(ack.status, 202);
  const before = await state(), run = before.runs[0], ids = chatRunOutputFixtureIds(run.runId);
  assert.equal(run.fixtureStage, 'run-outputs-ready'); assert.equal(run.pendingApprovals.length, 1);
  assert.equal(run.pendingApprovals[0].status, 'pending');
  assert.equal(before.runOutputs.requests.length, 0, 'metadata delivery must not prefetch output');
  assert.equal(before.observed.events[0].event, 'run.started');
  assert.ok(before.observed.events.some(event => event.event === 'activity.completed'));
  assert.ok(before.observed.events.every(event => event.provider === 'codex' && event.runId === ack.body.runId));
  assert.ok(wire.some(value => value.includes('"event":"approval.required"')));
  assert.ok(!wire.join('').includes(CHAT_RUN_OUTPUT_MARKER) && !wire.join('').includes(CHAT_RUN_DIFF_MARKER));
  let cors;
  const observeHeaders = response => {
    const original = response.writeHead;
    response.writeHead = (status, headers) => { cors = headers; original(status, headers); };
  };
  for (const path of ['/chat/command-output', '/chat/run-changes']) {
    assert.equal((await request(handler, 'OPTIONS', path, null, null, observeHeaders)).status, 204);
    assert.equal(cors['Access-Control-Allow-Origin'], '*');
    assert.ok(cors['Access-Control-Allow-Headers'].includes('X-EGDESK-QA-Token'));
  }
  for (const itemId of [ids.pass, ids.fail]) {
    const response = await request(handler, 'GET', outputRoute('/chat/command-output', run, itemId), null, null, observeHeaders);
    assert.equal(response.status, 200); assert.equal(response.body.complete, true);
    assert.deepEqual([response.body.conversationId, response.body.runId, response.body.itemId], [run.conversationId, run.runId, itemId]);
    assert.ok((response.body.head + response.body.tail).includes(CHAT_RUN_OUTPUT_MARKER));
    assert.equal(cors['Access-Control-Allow-Origin'], '*');
  }
  for (const itemId of [ids.change, ids.proposed]) {
    const response = await request(handler, 'GET', outputRoute('/chat/run-changes', run, itemId));
    assert.equal(response.status, 200); assert.equal(response.body.retained, true);
    assert.equal(response.body.items[0].itemId, itemId); assert.ok(response.body.items[0].files[0].diff.includes(CHAT_RUN_DIFF_MARKER));
  }
  const after = await state();
  assert.deepEqual(after.runs, before.runs); assert.deepEqual(after.observed.events, before.observed.events);
  assert.deepEqual(after.observed.approvals, []); assert.equal(after.observed.approvalPostAttempts, 0);
  assert.equal(after.runOutputs.requests.length, 4);
  assert.ok(after.runOutputs.requests.every(row => row.method === 'GET'));
  assert.equal(after.runOutputs.options.length, 2);
  assert.deepEqual(after.runOutputs.effects, { providerTurns: 0, shellExecutions: 0, fileWrites: 0, approvalPosts: 0 });
  assert.equal(fetchSpy.mock.callCount(), 0);
});

test('RunOutputs HTTP routing rejects crossed identities, writes and injection routes; loss/disposal stay unavailable', async t => {
  t.mock.method(globalThis, 'fetch', () => { throw new Error('No forwarding'); });
  const fixture = setup(t, { runOutputs: true }), { handler } = fixture;
  const state = async () => (await request(handler, 'GET', '/__qa/state', null, TOKEN)).body;
  const ack = (await sendRunOutputs(handler)).body, ids = chatRunOutputFixtureIds(ack.runId);
  const valid = outputRoute('/chat/command-output', ack, ids.pass);
  for (const method of ['GET', 'OPTIONS']) {
    assert.equal((await request(handler, method, `http://127.0.0.1:39218${valid}`)).status, 400);
    assert.equal((await request(handler, method, valid, null, null, () => {}, { host: 'foreign.invalid' })).status, 400);
  }
  assert.equal((await state()).runOutputs.requests.length, 0, 'origin rejection precedes sidecar access');
  assert.equal((await request(handler, 'GET', valid.replace(ack.conversationId, 'other-room'))).body.code, 'RUN_NOT_FOUND');
  assert.equal((await request(handler, 'GET', `${valid}&itemId=duplicate`)).status, 400);
  assert.equal((await request(handler, 'GET', `${valid}&cwd=/outside`)).status, 400);
  const before = await state();
  assert.equal((await request(handler, 'POST', valid, { output: 'must never be injected' })).status, 405);
  assert.equal((await request(handler, 'POST', '/chat/run-changes', { diff: 'must never be injected' })).status, 405);
  assert.equal((await request(handler, 'POST', '/__qa/run-outputs/seed', { event: 'approval.resolved' }, TOKEN)).status, 404);
  assert.deepEqual((await state()).runs, before.runs);
  // This negative handler test intentionally attempts one rejected approval;
  // the native verifier must require this counter to remain zero.
  assert.equal((await request(handler, 'POST', '/chat/approval', { ...ack, approvalId: ids.approval, decision: 'accept' })).status, 400);
  assert.equal((await state()).observed.approvalPostAttempts, 1);
  assert.deepEqual((await state()).observed.approvals, []);
  const lost = (await sendRunOutputs(handler, 'RUN_OUTPUTS_LOST')).body, lostIds = chatRunOutputFixtureIds(lost.runId);
  assert.equal((await request(handler, 'GET', outputRoute('/chat/command-output', lost, lostIds.fail))).body.code, 'COMMAND_OUTPUT_UNAVAILABLE');
  const unavailable = await request(handler, 'GET', outputRoute('/chat/run-changes', lost));
  assert.equal(unavailable.body.retained, false); assert.deepEqual(unavailable.body.items, []);
  const beforeDispose = await state(); await fixture.dispose();
  assert.equal((await request(handler, 'GET', valid)).status, 410);
  const disposed = await state();
  assert.equal(disposed.runOutputs.disposed, true); assert.equal(disposed.runOutputs.retainedBytes, 0);
  assert.deepEqual(disposed.runs, beforeDispose.runs, 'disposal cannot resolve an approval or erase another run');
});

test('project File adapter and synthetic shell are strict opt-in; existing unknown-terminal behavior stays unchanged', async t => {
  t.mock.method(globalThis, 'fetch', () => { throw new Error('No network/provider access'); });
  const original = setup(t);
  assert.equal((await request(original.handler, 'GET', '/__qa/project-file/state', null, TOKEN)).status, 404);
  assert.equal((await request(original.handler, 'GET', '/terminal/shells')).status, 404);
  const fixture = setup(t, { projectFile: true });
  const headers = { host: '127.0.0.1:49318', 'content-type': 'application/json' };
  const state = (await request(fixture.handler, 'GET', '/__qa/project-file/state', null, TOKEN, () => {}, headers)).body;
  assert.equal(state.kind, 'egdesk-project-file-fixture');
  assert.deepEqual(state.persisted, { projects: [], bindings: [] });
  const catalog = (await request(fixture.handler, 'GET', '/terminal/shells', null, null, () => {}, headers)).body;
  assert.equal(catalog.syntheticShell, true);
  assert.equal(catalog.nativeProcessSpawns, 0);
  const auth = (await request(fixture.handler, 'GET', '/auth/status')).body;
  assert.equal(auth.isLoggedIn, false);
  assert.equal(auth.accountId, null);
  assert.equal((await request(fixture.handler, 'GET', '/health')).body.appServerReady, false);
  assert.equal((await request(fixture.handler, 'POST', '/chat/send', { message: 'EGDESK_QA_TEXT unit' })).body.code, 'PROJECT_QA_MODEL_DISABLED');
  const mainState = (await request(fixture.handler, 'GET', '/__qa/state', null, TOKEN)).body;
  assert.equal(mainState.projectFileFixture, true);
  assert.equal(mainState.providerTurns, 0);
  assert.deepEqual(mainState.observed.sends, []);
  assert.deepEqual(mainState.runs, []);
  assert.equal((await request(fixture.handler, 'POST', '/v1/files/git/status', {}, null, () => {}, headers)).status, 403);
});

test('fixture rejects unknown bridge/auth/send/approval URLs without forwarding or replacing globals', async (t) => {
  const fetchBefore = globalThis.fetch;
  const eventSourceBefore = globalThis.EventSource;
  const fetchSpy = t.mock.method(globalThis, 'fetch', () => { throw new Error('Real fetch must never be used by fixture transport'); });
  const { handler } = setup(t);
  for (const [method, route] of [
    ['POST', '/auth/unknown-signout'], ['POST', '/auth/start'], ['POST', '/auth/cancel'],
    ['POST', '/account/login/cancel'], ['GET', '/auth/unknown'],
    ['POST', '/chat/send/unknown'], ['POST', '/chat/approval/unknown'], ['POST', '/chat/user-input/unknown'],
    ['GET', '/v1/unknown'], ['OPTIONS', '/auth/unknown-signout'],
  ]) {
    assert.equal((await request(handler, method, route, {})).status, 404, `${method} ${route}`);
  }
  assert.equal((await request(handler, 'POST', 'http://127.0.0.1:49318/auth/unknown', {})).status, 404);
  assert.equal((await request(handler, 'GET', 'http://127.0.0.1:39218/auth/status')).status, 400);
  assert.equal((await request(handler, 'POST', 'http://127.0.0.1:39219/auth/signout', {})).status, 400);
  const signedOut = await request(handler, 'POST', '/auth/signout', {});
  assert.equal(signedOut.status, 200);
  assert.equal(signedOut.body.isLoggedIn, false);
  assert.equal((await request(handler, 'GET', '/__qa/state', null, TOKEN)).body.observed.authWrites.length, 1);
  assert.equal(fetchSpy.mock.callCount(), 0);
  fetchSpy.mock.restore();
  assert.equal(globalThis.fetch, fetchBefore);
  assert.equal(globalThis.EventSource, eventSourceBefore);
});

test('first Codex auth fixture is exclusive, opt-in and requires explicit real-turn zero', async t => {
  const original = setup(t);
  const create = extra => createQaFixtureTransport({ profile: original.info.profile, token: TOKEN,
    env: { ...FIXTURE_ENV, ...extra } });
  assert.throws(() => create({ EGDESK_QA_FIRST_CODEX_AUTH_FIXTURE: 'yes', EGDESK_QA_REAL_TURN: '0' }), /first Codex auth/i);
  assert.throws(() => create({ EGDESK_QA_FIRST_CODEX_AUTH_FIXTURE: '1' }), /real-turn zero/i);
  assert.throws(() => create({ EGDESK_QA_FIRST_CODEX_AUTH_FIXTURE: '1', EGDESK_QA_REAL_TURN: '1' }), /real-turn zero/i);
  for (const conflicting of ['EGDESK_QA_CLAUDE_FIXTURE', 'EGDESK_QA_PROJECT_FILE_FIXTURE',
    'EGDESK_QA_RUN_OUTPUTS_FIXTURE', 'EGDESK_QA_PORTABLE_TRANSFER_FIXTURE',
    'EGDESK_QA_TASK_GATE_FIXTURE', 'EGDESK_QA_CHAT_ORIGIN_FILE_FIXTURE', 'EGDESK_QA_STATE_FIXTURES']) {
    assert.throws(() => create({ EGDESK_QA_FIRST_CODEX_AUTH_FIXTURE: '1', EGDESK_QA_REAL_TURN: '0',
      [conflicting]: '1' }), /exclus|separate|conflict/i, conflicting);
  }
  assert.equal((await request(original.handler, 'OPTIONS', '/auth/start')).status, 404);
  assert.equal((await request(original.handler, 'POST', '/__qa/auth-result', { outcome: 'success' }, TOKEN)).status, 404);
});

test('first Codex auth fixture has pending, cancelled and completed sessions with no real provider', async t => {
  const fetchSpy = t.mock.method(globalThis, 'fetch', () => { throw new Error('Fixture must not call a provider'); });
  const listenSpy = t.mock.method(http.Server.prototype, 'listen', () => { throw new Error('Factory must not start a listener'); });
  const { handler } = setup(t, { firstAuth: true });
  const status = async () => (await request(handler, 'GET', '/auth/status')).body;
  const state = async () => (await request(handler, 'GET', '/__qa/state', null, TOKEN)).body;
  const send = { message: 'EGDESK_QA_TEXT_ONLY first-auth', clientThreadId: 'first-auth-room',
    requestId: 'first-auth-request', profileEnabled: false };
  assert.equal((await status()).isLoggedIn, false);
  assert.equal((await status()).accountEmail, null);
  assert.equal((await request(handler, 'POST', '/chat/send', send)).body.code, 'AUTH_REQUIRED');
  assert.equal((await request(handler, 'POST', '/chat/send', {})).body.code, 'AUTH_REQUIRED');
  assert.equal((await state()).observed.sends.length, 0);
  assert.equal((await state()).observed.authBlockedSends, 2, 'even malformed pre-auth POSTs are counted');
  assert.equal((await request(handler, 'OPTIONS', '/auth/start')).status, 204);
  assert.equal((await request(handler, 'POST', '/auth/start', { mode: 'device' })).status, 400);

  const first = await request(handler, 'POST', '/auth/start', {});
  assert.equal(first.status, 200); assert.equal(first.body.started, true);
  assert.match(first.body.loginId, /^qa-auth-/);
  assert.equal(first.body.authUrl, null, 'never return a real provider or browser URL');
  assert.equal((await status()).loginInProgress, true);
  assert.equal((await request(handler, 'POST', '/auth/start', {})).body.loginInProgress, true);
  assert.equal((await request(handler, 'POST', '/__qa/auth-result', { outcome: 'cancel', loginId: first.body.loginId })).status, 403);
  assert.equal((await request(handler, 'POST', '/__qa/auth-result', { outcome: 'success', loginId: 'qa-auth-wrong' }, TOKEN)).status, 409);
  assert.equal((await request(handler, 'POST', '/__qa/auth-result', { outcome: 'cancel', loginId: first.body.loginId }, TOKEN)).status, 200);
  assert.equal((await status()).isLoggedIn, false); assert.equal((await status()).loginInProgress, false);
  assert.equal((await request(handler, 'POST', '/__qa/auth-result', { outcome: 'success', loginId: first.body.loginId }, TOKEN)).status, 409);
  assert.equal((await state()).observed.sends.length, 0);

  const second = await request(handler, 'POST', '/auth/start', {});
  assert.notEqual(second.body.loginId, first.body.loginId);
  assert.equal((await request(handler, 'POST', '/__qa/auth-result', { outcome: 'success', loginId: second.body.loginId }, TOKEN)).status, 200);
  assert.equal((await status()).isLoggedIn, true);
  assert.match((await status()).accountEmail, /@egdesk\.invalid$/);
  assert.equal((await state()).observed.sends.length, 0, 'auth completion must never submit the draft');
  assert.equal((await request(handler, 'POST', '/chat/send', { ...send, profileEnabled: true })).body.code, 'QA_PROFILE_DISABLED_REQUIRED');
  const accepted = await request(handler, 'POST', '/chat/send', send);
  assert.equal(accepted.status, 202);
  const final = await state();
  assert.equal(Object.hasOwn(final, 'providerTurns'), false);
  assert.equal(Object.hasOwn(final, 'nativeProcessSpawns'), false);
  assert.deepEqual(final.firstCodexAuthBoundary, {
    kind: 'first-codex-auth-fixture-boundary-v1', auth: 'synthetic-fixture', chat: 'synthetic-fixture',
    providerIntegration: 'none-configured-for-first-auth', providerTurnObservation: 'not-instrumented',
    nativeProcessSpawnObservation: 'not-instrumented',
  });
  assert.equal(final.observed.sends.length, 1);
  assert.equal(final.observed.sends[0].profileEnabled, false);
  assert.equal(final.observed.sends[0].clientThreadId, send.clientThreadId);
  assert.deepEqual(final.observed.authWrites.map(item => item.route), ['/auth/start', '/auth/start']);
  assert.equal(fetchSpy.mock.callCount(), 0); assert.equal(listenSpy.mock.callCount(), 0);
});

test('first Codex auth counts every send POST at entry, including malformed and rejected attempts', async t => {
  const { handler } = setup(t, { firstAuth: true });
  const state = async () => (await request(handler, 'GET', '/__qa/state', null, TOKEN)).body;
  const send = { message: 'EGDESK_QA_TEXT_ONLY counted', clientThreadId: 'counted-room',
    requestId: 'counted-request', profileEnabled: false };
  assert.deepEqual((await state()).observed.chatSendPostAttempts, { total: 0, signedOut: 0, signedIn: 0 });
  assert.equal((await request(handler, 'OPTIONS', '/chat/send')).status, 204);
  assert.equal((await request(handler, 'POST', '/chat/send/unknown', {})).status, 404);
  assert.equal((await request(handler, 'POST', '/chat/send', send, null, () => {}, { host: 'not-the-fixture' })).status, 400);
  assert.equal((await request(handler, 'POST', '/chat/send', null, null, () => {}, {}, '{invalid json')).body.code, 'AUTH_REQUIRED');
  assert.deepEqual((await state()).observed.chatSendPostAttempts, { total: 2, signedOut: 2, signedIn: 0 });
  const auth = await request(handler, 'POST', '/auth/start', {});
  assert.equal((await request(handler, 'POST', '/__qa/auth-result', { outcome: 'success', loginId: auth.body.loginId }, TOKEN)).status, 200);
  assert.equal((await request(handler, 'POST', '/chat/send', null, null, () => {}, {}, '{invalid json')).status, 400);
  assert.equal((await request(handler, 'POST', '/chat/send', {})).status, 400);
  assert.equal((await request(handler, 'POST', '/chat/send', { ...send, profileEnabled: true })).body.code, 'QA_PROFILE_DISABLED_REQUIRED');
  assert.equal((await request(handler, 'POST', '/chat/send', { ...send, message: 'not a QA scenario' })).status, 400);
  let snapshot = await state();
  assert.deepEqual(snapshot.observed.chatSendPostAttempts, { total: 6, signedOut: 2, signedIn: 4 });
  assert.equal(snapshot.observed.sends.length, 0, 'rejected POSTs are not accepted sends');
  assert.equal((await request(handler, 'POST', '/chat/send', send)).status, 202);
  snapshot = await state();
  assert.deepEqual(snapshot.observed.chatSendPostAttempts, { total: 7, signedOut: 2, signedIn: 5 });
  assert.equal(snapshot.observed.sends.length, 1);
});

test('first Codex auth fixture cancellation endpoint invalidates its session without signing in', async t => {
  const { handler } = setup(t, { firstAuth: true });
  const first = (await request(handler, 'POST', '/auth/start', {})).body;
  assert.equal((await request(handler, 'POST', '/auth/cancel', {})).body.status, 'cancelled');
  assert.equal((await request(handler, 'GET', '/auth/status')).body.isLoggedIn, false);
  assert.equal((await request(handler, 'GET', '/auth/status')).body.loginInProgress, false);
  assert.equal((await request(handler, 'POST', '/__qa/auth-result', { outcome: 'success', loginId: first.loginId }, TOKEN)).status, 409);
  assert.equal((await request(handler, 'POST', '/auth/cancel', {})).body.status, 'notFound');
});

test('first Codex auth fixture broadcasts each synthetic status without a verification URL', async t => {
  const { handler } = setup(t, { firstAuth: true });
  const frames = [], req = Object.assign(new EventEmitter(), { method: 'GET', url: '/events?chatProtocol=2', headers: {} });
  const res = { writeHead(status) { assert.equal(status, 200); }, write(frame) { frames.push(frame); return true; } };
  await handler(req, res); t.after(() => req.emit('close'));
  const first = (await request(handler, 'POST', '/auth/start', {})).body;
  await request(handler, 'POST', '/__qa/auth-result', { outcome: 'cancel', loginId: first.loginId }, TOKEN);
  const second = (await request(handler, 'POST', '/auth/start', {})).body;
  await request(handler, 'POST', '/__qa/auth-result', { outcome: 'success', loginId: second.loginId }, TOKEN);
  const statuses = frames.filter(frame => frame.startsWith('event: codex\n'))
    .map(frame => JSON.parse(frame.split('\ndata: ')[1]));
  assert.deepEqual(statuses.map(frame => [frame.type, frame.status.isLoggedIn, frame.status.loginInProgress]), [
    ['auth.status', false, true], ['auth.status', false, false],
    ['auth.status', false, true], ['auth.status', true, false],
  ]);
  assert.ok(statuses.every(frame => frame.provider === 'codex' && !frame.status.authUrl && !frame.status.verificationUrl));
});

test('first Codex auth fixture serves loopback HTTP and SSE through an origin-restricted test fetch', async t => {
  const server = http.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port, base = `http://127.0.0.1:${port}`;
  const { handler } = setup(t, { firstAuth: true, fixturePort: port });
  server.on('request', handler);
  const nativeFetch = globalThis.fetch;
  const fetchSpy = t.mock.method(globalThis, 'fetch', (url, options) => {
    assert.equal(new URL(url).origin, base, 'the only allowed network destination is this owned fixture');
    return nativeFetch(url, options);
  });
  const controller = new AbortController();
  t.after(async () => {
    controller.abort();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  const call = async (route, { method = 'GET', body, control = false } = {}) => {
    const response = await fetch(`${base}${route}`, { method, redirect: 'error',
      headers: { Origin: 'chrome://browser', ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(control ? { 'X-EGDESK-QA-Token': TOKEN } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, headers: response.headers, body: response.status === 204 ? null : await response.json() };
  };
  const preflight = await call('/auth/start', { method: 'OPTIONS' });
  assert.equal(preflight.status, 204); assert.equal(preflight.headers.get('access-control-allow-origin'), '*');
  const response = await fetch(`${base}/events?chatProtocol=2`, { signal: controller.signal });
  assert.equal(response.status, 200);
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let buffered = '';
  const nextFrame = async () => {
    while (!buffered.includes('\n\n')) {
      let timer;
      const chunk = await Promise.race([reader.read(), new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Timed out waiting for fixture SSE')), 3000);
      })]).finally(() => clearTimeout(timer));
      assert.equal(chunk.done, false); buffered += decoder.decode(chunk.value, { stream: true });
    }
    const boundary = buffered.indexOf('\n\n'), frame = buffered.slice(0, boundary);
    buffered = buffered.slice(boundary + 2);
    return frame;
  };
  assert.match(await nextFrame(), /^event: ready/);
  const start = (await call('/auth/start', { method: 'POST', body: {} })).body;
  assert.equal(JSON.parse((await nextFrame()).split('\ndata: ')[1]).status.loginInProgress, true);
  assert.equal((await call('/__qa/auth-result', { method: 'POST', body: { loginId: start.loginId, outcome: 'cancel' }, control: true })).status, 200);
  assert.equal(JSON.parse((await nextFrame()).split('\ndata: ')[1]).status.isLoggedIn, false);
  const retry = (await call('/auth/start', { method: 'POST', body: {} })).body;
  assert.equal(JSON.parse((await nextFrame()).split('\ndata: ')[1]).status.loginInProgress, true);
  assert.equal((await call('/__qa/auth-result', { method: 'POST', body: { loginId: retry.loginId, outcome: 'success' }, control: true })).status, 200);
  assert.equal(JSON.parse((await nextFrame()).split('\ndata: ')[1]).status.isLoggedIn, true);
  const before = (await call('/__qa/state', { control: true })).body;
  assert.equal(before.observed.sends.length, 0);
  assert.deepEqual(before.observed.chatSendPostAttempts, { total: 0, signedOut: 0, signedIn: 0 });
  assert.equal(before.firstCodexAuthBoundary.providerTurnObservation, 'not-instrumented');
  const sent = await call('/chat/send', { method: 'POST', body: { message: 'EGDESK_QA_TEXT_ONLY HTTP',
    clientThreadId: 'http-first-room', requestId: 'http-first-request', profileEnabled: false } });
  assert.equal(sent.status, 202);
  const after = (await call('/__qa/state', { control: true })).body;
  assert.equal(after.observed.sends.length, 1);
  assert.deepEqual(after.observed.chatSendPostAttempts, { total: 1, signedOut: 0, signedIn: 1 });
  assert.equal(after.firstCodexAuthBoundary.nativeProcessSpawnObservation, 'not-instrumented');
  assert.ok(fetchSpy.mock.callCount() >= 8);
});

const claudeSend = async (handler, scenario, extra = {}) => request(handler, 'POST', '/chat/send', {
  message: `EGDESK_QA_CLAUDE_${scenario} unit`, engineId: 'claude', profileEnabled: false,
  ...(scenario === 'CONTEXT' && !Object.hasOwn(extra, 'expectedContextScope')
    ? { expectedContextScope: await claudeScope(handler, extra) } : {}),
  clientThreadId: 'qa-claude-thread', requestId: `qa-claude-${scenario}`, ...extra,
});

test('Claude fixture is separately gated, Codex-offline and refuses unsupported Context bodies without provider I/O', async t => {
  t.mock.method(globalThis, 'fetch', () => { throw new Error('No provider I/O in Claude fixture'); });
  const original = setup(t);
  assert.equal((await claudeSend(original.handler, 'TEXT')).status, 409);
  const { handler } = setup(t, { claude: true });
  const health = (await request(handler, 'GET', '/health')).body;
  const state = (await request(handler, 'GET', '/v1/state')).body;
  assert.equal(health.claudeFixture, true);
  assert.equal(health.providerTurns, 0);
  assert.equal(health.appServerReady, false);
  assert.equal(state.auth.isLoggedIn, false);
  assert.equal(state.engines.find(row => row.id === 'codex').status, 'offline');
  const claude = state.engines.find(row => row.id === 'claude');
  assert.equal(claude.status, 'ready');
  assert.equal(claude.profiles[0].auth.status, 'signedIn');
  assert.equal(claude.runtime.residentProcesses, 0);
  assert.equal((await claudeSend(handler, 'TEXT', { engineId: 'codex' })).body.code, 'ENGINE_UNAVAILABLE');
  for (const extra of [{ contextSnapshotIds: ['capture-1'] }, { selectedSources: [{ id: 's' }] },
    { attachments: [{ id: 's' }] }, { contextResolution: { resolutionId: 'r' } }]) {
    assert.equal((await claudeSend(handler, 'TEXT', extra)).body.code, 'CLAUDE_CONTEXT_UNSUPPORTED');
  }
  assert.equal((await request(handler, 'POST', '/context/captures', { sources: [] })).body.code, 'INVALID_CONTEXT_ROUTING');
  await request(handler, 'POST', '/__qa/context-config', { claudeCapabilities: false }, TOKEN);
  assert.equal((await request(handler, 'POST', '/context/captures', { engineId: 'claude', clientThreadId: 'qa-claude-thread', attachments: [] })).body.code, 'CLAUDE_CONTEXT_UNSUPPORTED');
  const control = await fixtureState(handler);
  assert.deepEqual(control.observed.sends, []);
  assert.deepEqual(control.runs, []);
  assert.deepEqual(control.observed.authWrites, []);
});

test('Claude fixture text and event identities remain Claude with the legacy SSE provider field', async t => {
  const { handler } = setup(t, { claude: true });
  assert.equal((await claudeSend(handler, 'TEXT')).status, 202);
  const state = await fixtureState(handler), run = state.runs[0];
  assert.equal(run.engine.id, 'claude');
  assert.equal(run.status, 'completed');
  assert.equal(run.messages.find(item => item.role === 'assistant').text, CLAUDE_FIXTURE_TEXT);
  assert.ok(state.observed.events.every(event => event.provider === 'codex' && event.engineId === 'claude'));
  assert.equal((await request(handler, 'GET', `/chat/state?conversationId=${run.conversationId}`)).body.connection, 'ready');
});

test('Claude session choice requires an offered valid rule; absent, wrong-run and duplicate replies are rejected', async t => {
  const { handler } = setup(t, { claude: true });
  for (const [scenario, decision] of [['SESSION_APPROVAL', 'acceptForSession'], ['APPROVAL_NO_SESSION', 'decline']]) {
    const sent = (await claudeSend(handler, scenario)).body;
    const run = (await fixtureState(handler)).runs.find(run => run.runId === sent.runId);
    const approval = run.pendingApprovals[0];
    assert.equal(approval.choices.includes('acceptForSession'), scenario === 'SESSION_APPROVAL');
    assert.equal(run.fixtureApprovalOffer.adapterExecutionVerified, false);
    if (scenario === 'SESSION_APPROVAL') {
      assert.equal(run.fixtureApprovalOffer.sessionRule.destination, 'session');
      assert.deepEqual(run.fixtureApprovalOffer.sessionRule.rules, [{ toolName: 'Bash', ruleContent: approval.command }]);
    } else assert.equal(run.fixtureApprovalOffer.sessionRule, null);
    const reply = { ...sent, approvalId: approval.approvalId, decision };
    assert.equal((await request(handler, 'POST', '/chat/approval', { ...reply, runId: 'wrong' })).status, 409);
    if (scenario === 'APPROVAL_NO_SESSION') assert.equal((await request(handler, 'POST', '/chat/approval',
      { ...reply, decision: 'acceptForSession' })).status, 400);
    assert.equal((await request(handler, 'POST', '/chat/approval', reply)).status, 202);
    assert.equal((await request(handler, 'POST', '/chat/approval', reply)).status, 409);
    assert.equal((await request(handler, 'POST', '/__qa/release', { runId: sent.runId, phase: 'approval' }, TOKEN)).status, 200);
    assert.equal((await request(handler, 'POST', '/__qa/release', { runId: sent.runId, phase: 'run' }, TOKEN)).status, 200);
  }
  assert.deepEqual((await fixtureState(handler)).observed.approvals.map(reply => reply.decision), ['acceptForSession', 'decline']);
});

test('Claude multi-select survives snapshot restore and accepts only valid index arrays without dropping single-choice coverage', async t => {
  const { handler } = setup(t, { claude: true });
  const sent = (await claudeSend(handler, 'MULTI_SELECT')).body;
  for (const extra of [{}, { engineId: 'codex' }, { engineId: 'claude', clientThreadId: 'foreign' }]) {
    assert.equal((await request(handler, 'POST', '/chat/resume', { conversationId: sent.conversationId,
      clientThreadId: 'qa-claude-thread', ...extra })).body.code, 'ENGINE_MISMATCH');
  }
  const snapshot = (await request(handler, 'POST', '/chat/resume', { conversationId: sent.conversationId,
    clientThreadId: 'qa-claude-thread', engineId: 'claude' })).body;
  const input = snapshot.runs[0].pendingUserInputs[0];
  assert.deepEqual(input.questions, CLAUDE_FIXTURE_QUESTIONS);
  assert.equal(snapshot.engineId, 'claude');
  assert.equal(snapshot.connection, 'ready');
  const reply = answers => request(handler, 'POST', '/chat/user-input', {
    userInputId: input.userInputId, conversationId: sent.conversationId, runId: sent.runId, action: 'submit', answers,
  });
  for (const optionIndices of [[], [0, 0], [-1], [3], ['0'], [0.5]]) {
    assert.equal((await reply([{ questionId: 'q0', optionIndices }, { questionId: 'q1', optionIndex: 0 }])).status, 400);
  }
  assert.equal((await reply([{ questionId: 'q0', optionIndices: [0], optionIndex: 1 }, { questionId: 'q1', optionIndex: 0 }])).status, 400);
  assert.equal((await reply([{ questionId: 'q0', optionIndices: [0] }, { questionId: 'q1', optionIndices: [0] }])).status, 400);
  assert.equal((await reply([{ questionId: 'q0', optionIndices: [0, 2] }, { questionId: 'q1', optionIndex: 1 }])).status, 200);
  const answer = (await fixtureState(handler)).observed.userInputs[0].answers;
  assert.deepEqual(answer[0].optionIndices, [0, 2]);
  assert.deepEqual(answer[0].labels, ['문서', '검증']);
  assert.equal(answer[1].optionIndex, 1);
  assert.equal((await reply([{ questionId: 'q0', optionIndices: [0, 2] }, { questionId: 'q1', optionIndex: 1 }])).status, 409);
});

test('Claude rate-limit warning/rejection retain reset time and schedule no retry or automatic send', async t => {
  const { handler } = setup(t, { claude: true });
  const sent = (await claudeSend(handler, 'RATE_LIMIT')).body;
  const before = await fixtureState(handler), warning = before.runs[0].rateLimit;
  assert.equal(warning.status, 'allowed_warning');
  assert.equal(warning.usedPercent, 90);
  assert.equal(warning.autoResume, false);
  const timer = t.mock.method(globalThis, 'setTimeout', () => { throw new Error('Quota must not schedule a timer'); });
  assert.equal((await request(handler, 'POST', '/__qa/release', { runId: sent.runId, phase: 'claude-rate-rejected' }, TOKEN)).status, 200);
  const after = await fixtureState(handler), rejected = after.runs[0];
  assert.equal(rejected.rateLimit.status, 'rejected');
  assert.equal(rejected.rateLimit.autoResume, false);
  assert.equal(rejected.error.retryAt, rejected.rateLimit.resetsAt);
  assert.equal(rejected.error.kind, 'quota');
  assert.equal(rejected.status, 'failed');
  assert.deepEqual(after.observed.sends, before.observed.sends);
  assert.deepEqual(after.observed.resumes, before.observed.resumes);
  assert.equal(timer.mock.callCount(), 0);
});

const CLAUDE_ROUTE = { engineId: 'claude', engineProfileId: 'claude-default', clientThreadId: 'qa-claude-thread' };
const contextRoute = (sourceId, overrides = {}) => `/context/captures/${sourceId}?${new URLSearchParams({ ...CLAUDE_ROUTE, ...overrides })}`;
const claudeScope = async (handler, overrides = {}) => {
  const scope = Object.fromEntries(Object.entries({ ...CLAUDE_ROUTE, ...overrides })
    .filter(([key]) => ['engineId', 'engineProfileId', 'clientThreadId', 'conversationId'].includes(key)));
  return (await request(handler, 'GET', `/context/capabilities?${new URLSearchParams(scope)}`)).body.expectedContextScope;
};
const claudeCapture = async (handler, attachments, overrides = {}) => request(handler, 'POST', '/context/captures', {
  ...CLAUDE_ROUTE, attachments, ...(!Object.hasOwn(overrides, 'expectedContextScope')
    ? { expectedContextScope: await claudeScope(handler, overrides) } : {}), ...overrides });

test('Claude B2 capability and capture routes require UI routing hints, never UI authority or Codex auth', async t => {
  const { handler, info } = setup(t, { claude: true });
  const route = `/context/capabilities?${new URLSearchParams(CLAUDE_ROUTE)}`;
  const descriptor = (await request(handler, 'GET', route)).body;
  assert.match(descriptor.expectedContextScope, /^[a-f0-9]{64}$/);
  assert.deepEqual(descriptor, { contract: 'egdesk-context-b2', engineId: 'claude', engineProfileId: 'claude-default',
    selectedAttachments: true, immutableRead: true, nativeReader: false, tools: ['egdesk_list_context', 'egdesk_read_source'],
    expectedContextScope: descriptor.expectedContextScope });
  assert.equal((await request(handler, 'GET', '/auth/status')).body.isLoggedIn, false);
  for (const extra of [{ ownerKey: 'forged' }, { epoch: 0 }, { contextAuthority: { ownerKey: 'forged' } }]) {
    assert.equal((await claudeCapture(handler, [attachment('A', { path: info.artifactPath })], extra)).status, 400);
  }
  for (const suffix of ['&ownerKey=forged', '&epoch=0']) assert.equal((await request(handler, 'GET', route + suffix)).status, 400);
  for (const extra of [{ engineId: 'codex' }, { engineProfileId: 'other' }, { clientThreadId: '' }]) {
    assert.ok((await claudeCapture(handler, [attachment('A', { path: info.artifactPath })], extra)).status >= 400);
  }
  await request(handler, 'POST', '/__qa/context-config', { claudeCapabilities: false }, TOKEN);
  assert.equal((await request(handler, 'GET', route)).status, 404);
  assert.equal((await claudeCapture(handler, [attachment('A', { path: info.artifactPath })])).body.code, 'CLAUDE_CONTEXT_UNSUPPORTED');
  const state = await fixtureState(handler);
  assert.equal(state.context.captureBatches, 0);
  assert.deepEqual(state.observed.sends, []);
  assert.deepEqual(state.observed.authWrites, []);
});

test('Claude B2 exact immutable source survives live mutation and resume; synthetic full read never clips at 40 lines', async t => {
  const fetchSpy = t.mock.method(globalThis, 'fetch', () => { throw new Error('No provider or real bridge'); });
  const { handler, info } = setup(t, { claude: true });
  const file = path.join(info.profile, 'qa-fixtures', 'claude-original.txt');
  const original = Array.from({ length: 80 }, (_, index) => `V1-${index + 1}`).join('\n');
  fs.writeFileSync(file, original, { flag: 'wx', mode: 0o600 });
  const receipt = await claudeCapture(handler, [attachment('file-A', { path: file })]);
  assert.equal(receipt.status, 200);
  const [capture] = receipt.body.captures;
  const before = captureContextReadEvidence((await request(handler, 'GET', contextRoute(capture.sourceId))).body);
  assert.equal(before.delivered, null);
  assert.deepEqual(before.bindings, []);
  assert.equal(before.source.text, original);
  fs.writeFileSync(file, 'LIVE V2 MUST NOT REPLACE V1');
  const sent = await claudeSend(handler, 'CONTEXT', { engineProfileId: 'claude-default', contextSnapshotIds: [capture.sourceId] });
  assert.equal(sent.status, 202);
  let state = await fixtureState(handler), run = state.runs[0];
  assert.deepEqual(run.fixtureContextTools, ['egdesk_list_context', 'egdesk_read_source']);
  assert.deepEqual(run.contextCaptures, [capture]);
  assert.equal(state.context.deliveries.length, 0, 'capture/bind is not delivery');
  assert.equal((await request(handler, 'POST', '/__qa/context-release', { runId: run.runId, phase: 'read' }, TOKEN)).status, 200);
  state = await fixtureState(handler);
  const [delivery] = state.context.deliveries;
  const inspected = captureContextReadEvidence((await request(handler, 'GET', contextRoute(capture.sourceId,
    { conversationId: run.conversationId, packetId: delivery.packet.packetId }))).body);
  assert.equal(inspected.source.text, original);
  assert.deepEqual(inspected.capture, before.capture);
  const payload = JSON.parse(delivery.packet.text);
  assert.equal(payload.fixtureOnly, true);
  assert.equal(payload.text, original);
  assert.equal(payload.sourceHash, fingerprintQaBytes(original).sha256);
  assert.equal(payload.snapshotId, capture.sourceId);
  assert.equal(payload.version, capture.version);
  assert.deepEqual(payload.coverage.range, { startLine: 1, endLine: 80 });
  assert.equal(payload.coverage.complete, true);
  assert.equal(payload.coverage.sourceTruncated, false);
  assert.equal(inspected.delivered.hash, fingerprintQaBytes(delivery.packet.text).sha256);
  assert.equal((await request(handler, 'POST', '/__qa/context-release', { runId: run.runId, phase: 'briefing' }, TOKEN)).body.code, 'CONTEXT_TOOL_UNSUPPORTED');
  await request(handler, 'POST', '/__qa/context-release', { runId: run.runId, phase: 'complete' }, TOKEN);
  const resumed = (await request(handler, 'POST', '/chat/resume', { ...CLAUDE_ROUTE, conversationId: run.conversationId })).body;
  assert.deepEqual(resumed.runs[0].contextCaptures, [capture]);
  assert.equal(resumed.runs[0].status, 'completed');
  assert.equal((await fixtureState(handler)).context.captureBatches, 1, 'resume does not recapture');
  assert.equal((await fixtureState(handler)).providerTurns, 0);
  assert.equal(fetchSpy.mock.callCount(), 0);
});

test('Claude B2 source site identity is independent; wrong engine/account/client/conversation are denied', async t => {
  const { handler } = setup(t, { claude: true });
  const source = attachment('site', { url: 'https://example.invalid/qa', viewId: 'qa-browser',
    profileId: 'site-profile-not-engine-profile', accountId: 'site-person@egdesk.invalid',
    browserProfileId: 'website-profile', siteAccount: 'website-user@egdesk.invalid' }, 'browser', 'Different site account; same explicitly selected immutable text.');
  const [capture] = (await claudeCapture(handler, [source])).body.captures;
  assert.equal(capture.sourceRef.accountId, 'site-person@egdesk.invalid');
  assert.equal(capture.sourceRef.browserProfileId, 'website-profile');
  assert.equal(capture.sourceRef.siteAccount, 'website-user@egdesk.invalid');
  assert.equal((await request(handler, 'GET', contextRoute(capture.sourceId, { engineId: 'codex' }))).status, 403);
  assert.equal((await request(handler, 'GET', contextRoute(capture.sourceId, { engineProfileId: 'foreign' }))).status, 403);
  assert.equal((await request(handler, 'GET', contextRoute(capture.sourceId, { clientThreadId: 'foreign' }))).body.code, 'CONTEXT_THREAD_MISMATCH');
  assert.equal((await claudeSend(handler, 'CONTEXT', { clientThreadId: 'foreign', contextSnapshotIds: [capture.sourceId] })).body.code, 'CONTEXT_THREAD_MISMATCH');
  const first = await claudeSend(handler, 'CONTEXT', { contextSnapshotIds: [capture.sourceId] });
  const other = await claudeSend(handler, 'TEXT');
  assert.equal((await claudeSend(handler, 'CONTEXT', { conversationId: other.body.conversationId, contextSnapshotIds: [capture.sourceId] })).body.code, 'CONTEXT_THREAD_MISMATCH');
  assert.equal((await request(handler, 'GET', contextRoute(capture.sourceId, { conversationId: other.body.conversationId }))).body.code, 'CONTEXT_THREAD_MISMATCH');
  await request(handler, 'POST', '/__qa/account-change', { variant: 'b' }, TOKEN);
  assert.equal((await request(handler, 'GET', contextRoute(capture.sourceId))).status, 200, 'Codex account change does not invalidate Claude');
  await request(handler, 'POST', '/__qa/account-change', { engineId: 'claude', variant: 'b' }, TOKEN);
  assert.equal((await request(handler, 'GET', contextRoute(capture.sourceId))).status, 404);
  assert.equal((await request(handler, 'POST', '/__qa/context-release', { runId: first.body.runId, phase: 'read' }, TOKEN)).body.code, 'ACCOUNT_CHANGED');
  assert.equal((await fixtureState(handler)).context.deliveries.length, 0);
});

test('Claude B2 late capture epoch cannot release success into a different engine account', async t => {
  const { handler, info } = setup(t, { claude: true });
  await request(handler, 'POST', '/__qa/context-config', { holdNextCapture: true }, TOKEN);
  const pending = claudeCapture(handler, [attachment('A', { path: info.artifactPath })]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await fixtureState(handler)).pendingContextCaptures, 1);
  await request(handler, 'POST', '/__qa/account-change', { engineId: 'claude', variant: 'b' }, TOKEN);
  const release = await request(handler, 'POST', '/__qa/context-release', { phase: 'capture', clientThreadId: CLAUDE_ROUTE.clientThreadId }, TOKEN);
  assert.equal(release.body.code, 'ACCOUNT_CHANGED');
  assert.equal((await pending).body.code, 'ACCOUNT_CHANGED');
  const state = await fixtureState(handler);
  assert.equal(state.observed.sends.length, 0);
  assert.equal(state.context.deliveries.length, 0);
});

test('Claude B2 capability-A/late-SSE/account-B rejects stale capture and send before any new store or binding', async t => {
  const { handler, info } = setup(t, { claude: true });
  const attachments = [attachment('A', { path: info.artifactPath })];
  const scopeA = await claudeScope(handler);
  const first = await claudeCapture(handler, attachments, { expectedContextScope: scopeA });
  assert.equal(first.status, 200);
  const ids = first.body.captures.map(row => row.sourceId);
  assert.ok(first.body.captures.every(row => !Object.hasOwn(row, 'expectedContextScope')), 'Expectation is not persisted as snapshot authority');
  await request(handler, 'POST', '/__qa/account-change', { engineId: 'claude', variant: 'b' }, TOKEN);
  // Deliberately do not consult state/events or refresh the descriptor: model
  // the unbound UI's old request arriving before it sees the account SSE.
  const before = await fixtureState(handler);
  for (const expectedContextScope of [scopeA, undefined, '', 'forged']) {
    const captured = await claudeCapture(handler, attachments, { expectedContextScope });
    assert.equal(captured.status, 409);
    assert.equal(captured.body.code, 'CONTEXT_SCOPE_CHANGED');
    const sent = await claudeSend(handler, 'CONTEXT', { expectedContextScope, contextSnapshotIds: ids });
    assert.equal(sent.status, 409);
    assert.equal(sent.body.code, 'CONTEXT_SCOPE_CHANGED');
  }
  const after = await fixtureState(handler);
  assert.deepEqual(after.context, before.context, 'No B file read/capture/bind/delivery');
  assert.deepEqual(after.runs, []);
  assert.deepEqual(after.observed.sends, []);
  assert.deepEqual(after.observed.captures, before.observed.captures);
  const scopeB = await claudeScope(handler);
  assert.notEqual(scopeB, scopeA);
  assert.notEqual(scopeB, await claudeScope(handler, { clientThreadId: 'another-ui-thread' }));
  assert.equal((await claudeCapture(handler, attachments, { expectedContextScope: scopeB,
    clientThreadId: 'another-ui-thread' })).body.code, 'CONTEXT_SCOPE_CHANGED');
  const second = await claudeCapture(handler, attachments, { expectedContextScope: scopeB });
  assert.equal(second.status, 200, 'A fresh explicit user attempt may use B after confirming B');
  const sent = await claudeSend(handler, 'CONTEXT', { expectedContextScope: scopeB,
    contextSnapshotIds: second.body.captures.map(row => row.sourceId) });
  assert.equal(sent.status, 202);
  assert.equal(await claudeScope(handler, { conversationId: sent.body.conversationId }), scopeB, 'Native binding does not change the expectation');
  await request(handler, 'POST', '/__qa/account-change', { variant: 'b' }, TOKEN);
  assert.equal(await claudeScope(handler), scopeB, 'Other engine account changes do not invalidate Claude');
  await request(handler, 'POST', '/__qa/account-change', { engineId: 'claude', variant: 'b' }, TOKEN);
  assert.notEqual(await claudeScope(handler), scopeB, 'Own epoch changes invalidate even the same account identity');
  assert.equal((await claudeCapture(handler, attachments, { expectedContextScope: scopeB })).body.code, 'CONTEXT_SCOPE_CHANGED');
  const restarted = createQaFixtureTransport({ profile: info.profile, token: TOKEN,
    env: { ...FIXTURE_ENV, EGDESK_QA_CLAUDE_FIXTURE: '1' } });
  t.after(() => restarted.dispose());
  assert.notEqual(await claudeScope(restarted.handler), scopeA, 'Fresh fixture lifetime invalidates old expectations');
  assert.equal((await claudeCapture(restarted.handler, attachments, { expectedContextScope: scopeA })).body.code, 'CONTEXT_SCOPE_CHANGED');
});

test('Claude B2 large/truncated/binary/Reader/publish inputs fail without partial binding or a Codex fallback', async t => {
  const { handler, info } = setup(t, { claude: true });
  const file = path.join(info.profile, 'qa-fixtures', 'claude-large.txt');
  fs.writeFileSync(file, 'QA immutable large source '.repeat(600), { flag: 'wx', mode: 0o600 });
  const inputs = [attachment('small', { path: info.artifactPath }), attachment('large', { path: file })];
  const captures = (await claudeCapture(handler, inputs)).body.captures;
  const extra = { contextSnapshotIds: captures.map(row => row.sourceId) };
  assert.equal((await claudeSend(handler, 'CONTEXT', extra)).body.code, 'CLAUDE_CONTEXT_READER_UNSUPPORTED');
  for (const ref of captures) assert.deepEqual((await request(handler, 'GET', contextRoute(ref.sourceId))).body.bindings, []);
  assert.equal((await claudeSend(handler, 'CONTEXT', { ...extra, contextCapabilities: { read: true, reader: true } })).body.code, 'CLAUDE_CONTEXT_READER_UNSUPPORTED');
  assert.equal((await claudeSend(handler, 'CONTEXT', { ...extra, contextCapabilities: { read: true, publishBriefing: true } })).body.code, 'CONTEXT_TOOL_UNSUPPORTED');
  const truncated = attachment('truncated', { viewId: 'qa-browser' }, 'browser', 'Incomplete text');
  truncated.content.truncated = true;
  assert.equal((await claudeCapture(handler, [truncated])).body.code, 'CONTEXT_CAPTURE_INCOMPLETE');
  const binary = attachment('binary', { viewId: 'qa-browser' }, 'browser', 'binary\0content');
  assert.equal((await claudeCapture(handler, [binary])).body.code, 'UNSUPPORTED_SOURCE_FORMAT');
  const state = await fixtureState(handler);
  assert.deepEqual(state.observed.sends, []);
  assert.deepEqual(state.runs, []);
  assert.equal(state.context.deliveries.length, 0);
  assert.equal(state.context.captureBatches, 1);
  assert.equal(state.observed.events.some(row => row.event.startsWith('reader.')), false);
});

const readerRelease = (handler, run, phase) => request(handler, 'POST', '/__qa/context-release', { runId: run.runId, phase }, TOKEN);
async function startLargeReader(t) {
  const transport = setup(t, { claude: true, reader: true });
  const { handler, info } = transport;
  const file = path.join(info.profile, 'qa-fixtures', 'claude-b3-large.txt');
  const original = Array.from({ length: 620 }, (_, n) => `QA_ORIGINAL_${n} synthetic source only; no model proof.`).join('\n');
  fs.writeFileSync(file, original, { flag: 'wx', mode: 0o600 });
  const receipt = await claudeCapture(handler, [attachment('large', { path: file })]);
  assert.equal(receipt.status, 200);
  const [captured] = receipt.body.captures;
  const sent = await claudeSend(handler, 'CONTEXT', { ...CLAUDE_ROUTE, contextSnapshotIds: [captured.sourceId],
    contextCapabilities: { read: true, reader: true, publishBriefing: false } });
  assert.equal(sent.status, 202);
  return { ...transport, file, original, captured, run: (await fixtureState(handler)).runs[0] };
}

test('B3 synthetic Reader is opt-in; verified nativeReader changes neither B2 scope nor list/read tools', async t => {
  const { handler, info } = setup(t, { claude: true });
  assert.equal((await request(handler, 'POST', '/__qa/context-config', { claudeReader: true }, TOKEN)).body.code, 'CLAUDE_CONTEXT_READER_UNSUPPORTED');
  for (const extra of [{}, { EGDESK_QA_CLAUDE_FIXTURE: '1' }, { EGDESK_QA_CLAUDE_FIXTURE: '1', EGDESK_QA_REAL_TURN: '1' }]) {
    assert.throws(() => createQaFixtureTransport({ profile: info.profile, token: TOKEN,
      env: { ...FIXTURE_ENV, EGDESK_QA_CLAUDE_READER_FIXTURE: '1', ...extra } }));
  }
  const enabled = setup(t, { claude: true, reader: true });
  const route = `/context/capabilities?${new URLSearchParams(CLAUDE_ROUTE)}`;
  const before = (await request(enabled.handler, 'GET', route)).body;
  assert.equal(before.nativeReader, true);
  assert.equal(before.contract, 'egdesk-context-b2');
  assert.equal(before.selectedAttachments && before.immutableRead, true);
  assert.deepEqual(before.tools, ['egdesk_list_context', 'egdesk_read_source']);
  await request(enabled.handler, 'POST', '/__qa/context-config', { claudeReader: false }, TOKEN);
  assert.deepEqual((await request(enabled.handler, 'GET', route)).body, { ...before, nativeReader: false, largeReader: false,
    reader: { ready: false, engineId: 'claude', code: 'CLAUDE_CONTEXT_READER_UNSUPPORTED' } });
  assert.equal((await fixtureState(enabled.handler)).providerTurns, 0);
});

test('B3 bounded Reader separates capture/processing/Main receipt, continues the same snapshot, and resumes exact old input', async t => {
  const fetchSpy = t.mock.method(globalThis, 'fetch', () => { throw new Error('No native adapter or provider'); });
  const { handler, file, original, captured, run } = await startLargeReader(t);
  fs.writeFileSync(file, 'LIVE CHANGED AFTER CAPTURE; never Reader input');
  assert.equal((await fixtureState(handler)).context.deliveries.length, 0);
  assert.equal((await request(handler, 'GET', contextRoute(captured.sourceId))).body.delivered, null);
  let sessionId, complete = false, partitions = 0;
  while (!complete && partitions < 8) {
    assert.equal((await readerRelease(handler, run, 'read')).status, 200);
    const started = await fixtureState(handler);
    const event = started.observed.events.at(-1);
    assert.equal(event.event, 'reader.started');
    assert.equal(event.details.nextPartition, partitions);
    sessionId ||= event.details.readerSessionId;
    assert.equal(event.details.readerSessionId, sessionId);
    assert.ok(event.details.totalPartitions > 1);
    assert.equal((await readerRelease(handler, run, 'complete')).status, 409, 'Processing is not Main completion');
    assert.equal((await readerRelease(handler, run, 'reader-deliver')).status, 409);
    assert.equal((await readerRelease(handler, run, 'reader-processed')).status, 200);
    const processed = await fixtureState(handler);
    const receipt = processed.context.readerProcessed.at(-1), input = JSON.parse(receipt.inputPayload.text);
    assert.equal(receipt.adapterExecutionVerified, false);
    assert.equal(receipt.inputPayload.hash, fingerprintQaBytes(receipt.inputPayload.text).sha256);
    assert.equal(input.sourceId, captured.sourceId);
    assert.equal(input.sourceHash, captured.hash);
    assert.equal(input.sourceText, original.slice(input.range.startOffset, input.range.endOffset));
    assert.equal(processed.context.deliveries.length, partitions, 'Reader processing alone is not Main receipt');
    assert.equal(processed.observed.events.at(-1).details.deliveryStatus, 'prepared');
    assert.equal((await readerRelease(handler, run, 'reader-processed')).status, 409, 'One bounded partition per step');
    assert.equal((await readerRelease(handler, run, 'reader-deliver')).status, 200);
    const delivered = await fixtureState(handler), packet = delivered.context.deliveries.at(-1).packet;
    const value = JSON.parse(packet.text);
    partitions++;
    assert.equal(value.fixtureOnly && value.synthetic, true);
    assert.equal(value.adapterExecutionVerified, false);
    assert.equal(value.mode, 'reader');
    assert.ok(value.summary.text.includes('no model invoked') && value.summary.structure.length > 0);
    assert.equal(value.sourceHash, captured.hash);
    assert.equal(value.version, 1);
    assert.equal(value.coverage.reviewedPartitions, partitions);
    assert.equal(value.coverage.complete, partitions === value.coverage.totalPartitions);
    complete = value.coverage.complete;
    assert.deepEqual(value.coverage.continuation, complete ? null : { readerSessionId: sessionId, nextPartition: partitions });
    assert.equal(packet.deliveryStatus, 'sent-to-app-server');
    assert.equal(packet.hash, fingerprintQaBytes(packet.text).sha256);
    const inspected = captureContextReadEvidence((await request(handler, 'GET', contextRoute(captured.sourceId,
      { conversationId: run.conversationId, packetId: packet.packetId }))).body);
    assert.equal(inspected.source.text, original.split('\n').slice(0, 200).join('\n'));
    assert.equal(inspected.delivered.text, packet.text);
    assert.equal((await readerRelease(handler, run, 'reader-deliver')).status, 409);
    if (!complete) assert.equal((await readerRelease(handler, run, 'complete')).status, 409);
  }
  assert.equal(complete, true);
  const before = await fixtureState(handler);
  const inputs = before.context.readerProcessed.map(row => JSON.parse(row.inputPayload.text));
  assert.equal(inputs.map(row => row.sourceText).join(''), original, 'Every assigned original byte was processed once');
  for (let n = 1; n < inputs.length; n++) assert.equal(inputs[n].range.startOffset, inputs[n - 1].range.endOffset);
  assert.equal((await readerRelease(handler, run, 'complete')).status, 200);
  const resumed = (await request(handler, 'POST', '/chat/resume', { ...CLAUDE_ROUTE, conversationId: run.conversationId })).body;
  assert.equal(resumed.runs[0].status, 'completed');
  assert.deepEqual(resumed.runs[0].contextCaptures, [captured]);
  assert.deepEqual(resumed.runs[0].contextEvents, before.runs[0].contextEvents);
  const after = await fixtureState(handler);
  assert.deepEqual(after.context, before.context, 'Resume neither recaptures nor processes nor delivers again');
  assert.equal(after.runs.length, 1, 'Internal Reader is not a delegated Chat');
  assert.deepEqual(after.runs[0].subAgents, []);
  assert.equal(after.providerTurns, 0);
  assert.equal(fetchSpy.mock.callCount(), 0);
});

test('B3 failure and explicit cancel discard prepared output and cannot complete or auto-fallback', async t => {
  for (const outcome of ['failure', 'cancel']) {
    const { handler, captured, run } = await startLargeReader(t);
    await readerRelease(handler, run, 'read');
    await readerRelease(handler, run, 'reader-processed');
    if (outcome === 'failure') assert.equal((await readerRelease(handler, run, 'reader-fail')).status, 200);
    else {
      assert.equal((await request(handler, 'POST', '/chat/interrupt', { ...run, engineId: 'codex' })).body.code, 'ENGINE_MISMATCH');
      await request(handler, 'POST', '/__qa/account-change', { variant: 'b' }, TOKEN); // Other engine is unrelated.
      assert.equal((await request(handler, 'POST', '/chat/interrupt', { ...run, engineId: 'claude' })).status, 202);
      assert.equal((await request(handler, 'POST', '/chat/interrupt', { ...run, engineId: 'claude' })).status, 409);
      assert.equal((await fixtureState(handler)).runs[0].status, 'inProgress', 'Stop ACK is not confirmed termination');
      assert.equal((await request(handler, 'POST', '/__qa/release', { runId: run.runId, phase: 'run' }, TOKEN)).status, 200);
    }
    for (const phase of ['read', 'reader-processed', 'reader-deliver', 'complete']) assert.ok((await readerRelease(handler, run, phase)).status >= 400);
    const state = await fixtureState(handler);
    assert.equal(state.runs[0].status, outcome === 'failure' ? 'failed' : 'interrupted');
    assert.deepEqual(state.runs[0].contextCaptures, [captured]);
    assert.equal(state.observed.events.some(event => event.event === 'run.completed' && event.details.status === 'completed'), false);
    assert.equal(state.observed.events.some(event => event.event === 'context.read.completed'), false);
    assert.equal(state.context.deliveries.length, 0);
    assert.equal((await request(handler, 'GET', contextRoute(captured.sourceId))).body.delivered, null);
    assert.equal(state.observed.sends.length, 1);
    assert.equal(state.observed.resumes.length, 0);
    assert.equal(state.observed.authWrites.length, 0);
    assert.equal(state.runs[0].messages.some(message => message.role === 'assistant'), false);
    assert.equal(state.providerTurns, 0);
  }
});

test('B3 missing authoritative capacity or unavailable Reader rejects before bind and never guesses a model window', async t => {
  const { handler, info } = setup(t, { claude: true, reader: true });
  const file = path.join(info.profile, 'qa-fixtures', 'b3-capacity.txt');
  fs.writeFileSync(file, 'synthetic large source\n'.repeat(900), { flag: 'wx', mode: 0o600 });
  const [captured] = (await claudeCapture(handler, [attachment('large', { path: file })])).body.captures;
  const body = { contextSnapshotIds: [captured.sourceId], contextCapabilities: { read: true, reader: true, publishBriefing: false } };
  await request(handler, 'POST', '/__qa/context-config', { claudeCapacityKnown: false }, TOKEN);
  assert.equal((await claudeSend(handler, 'CONTEXT', body)).body.code, 'ENGINE_CAPACITY_UNKNOWN');
  await request(handler, 'POST', '/__qa/context-config', { claudeCapacityKnown: true, claudeReader: false }, TOKEN);
  assert.equal((await claudeSend(handler, 'CONTEXT', body)).body.code, 'CLAUDE_CONTEXT_READER_UNSUPPORTED');
  assert.deepEqual((await request(handler, 'GET', contextRoute(captured.sourceId))).body.bindings, []);
  const state = await fixtureState(handler);
  assert.deepEqual(state.runs, []);
  assert.deepEqual(state.observed.sends, []);
  assert.deepEqual(state.context.deliveries, []);
});

test('B3 late Reader/prepared/resume work is invalidated only by its own engine account epoch', async t => {
  for (const prepared of [false, true]) {
    const { handler, captured, run } = await startLargeReader(t);
    const scopeA = await claudeScope(handler);
    await readerRelease(handler, run, 'read');
    if (prepared) await readerRelease(handler, run, 'reader-processed');
    await request(handler, 'POST', '/__qa/account-change', { variant: 'b' }, TOKEN);
    assert.equal(await claudeScope(handler), scopeA);
    await request(handler, 'POST', '/__qa/hold-resume', { hold: true }, TOKEN);
    const pending = request(handler, 'POST', '/chat/resume', { ...CLAUDE_ROUTE, conversationId: run.conversationId });
    await new Promise(resolve => setImmediate(resolve));
    await request(handler, 'POST', '/__qa/account-change', { engineId: 'claude', variant: 'b' }, TOKEN);
    const before = await fixtureState(handler);
    for (const phase of ['reader-processed', 'reader-deliver', 'complete']) assert.equal((await readerRelease(handler, run, phase)).body.code, 'ACCOUNT_CHANGED');
    assert.equal((await request(handler, 'POST', '/chat/interrupt', { ...run, engineId: 'claude' })).body.code, 'ACCOUNT_CHANGED');
    assert.equal((await request(handler, 'GET', contextRoute(captured.sourceId))).status, 404);
    assert.equal((await request(handler, 'GET', `/chat/state?conversationId=${run.conversationId}`)).body.code, 'ACCOUNT_CHANGED');
    await request(handler, 'POST', '/__qa/release-resume', {}, TOKEN);
    assert.equal((await pending).body.code, 'ACCOUNT_CHANGED');
    const after = await fixtureState(handler);
    assert.deepEqual(after.context, before.context);
    assert.deepEqual(after.observed.events, before.observed.events, 'No late success into the changed account');
    assert.deepEqual(after.observed.sends, before.observed.sends);
    assert.equal(after.context.deliveries.length, 0);
  }
});

test('fixture refuses ordinary prompts and unauthenticated control routes', async (t) => {
  const { handler } = setup(t);
  assert.equal((await request(handler, 'POST', '/chat/send', { message: 'ordinary real user request', profileEnabled: false })).status, 400);
  assert.equal((await request(handler, 'POST', '/chat/send', { message: 'EGDESK_QA_UNHANDLED test' })).status, 400);
  assert.equal((await request(handler, 'POST', '/__qa/reconnect', {})).status, 403);
  assert.equal((await request(handler, 'GET', '/__qa/state')).status, 403);
  const state = await request(handler, 'GET', '/__qa/state', null, TOKEN);
  assert.equal(state.body.observed.sends.length, 0);
  assert.equal(state.body.runs.length, 0);
});

test('fixture changes synthetic email while keeping generic accountId chatgpt unchanged', async (t) => {
  const { handler } = setup(t);
  const before = (await request(handler, 'GET', '/auth/status')).body;
  assert.equal((await request(handler, 'POST', '/__qa/account-change', { variant: 'b' })).status, 403);
  assert.equal((await request(handler, 'POST', '/__qa/account-change', { variant: 'b' }, TOKEN)).status, 200);
  const after = (await request(handler, 'GET', '/auth/status')).body;
  assert.equal(before.accountId, 'chatgpt');
  assert.equal(after.accountId, before.accountId);
  assert.notEqual(after.accountEmail, before.accountEmail);
  assert.equal(after.isLoggedIn, true);
  assert.equal((await request(handler, 'GET', '/__qa/state', null, TOKEN)).body.observed.authWrites.length, 0);
});

test('fixture-only approval/stop acknowledgements remain usable during auth lookup failure', async (t) => {
  const { handler } = setup(t);
  const sent = await request(handler, 'POST', '/chat/send', { message: 'EGDESK_QA_APPROVAL unit',
    clientThreadId: 'unit-thread', requestId: 'unit-request', profileEnabled: false });
  assert.equal(sent.status, 202);
  const identity = sent.body;
  const snapshot = await request(handler, 'GET', `/chat/state?conversationId=${identity.conversationId}`);
  const approval = snapshot.body.runs[0].pendingApprovals[0];
  assert.deepEqual(approval.choices, ['decline', 'cancel']);
  await request(handler, 'POST', '/__qa/auth-refresh', { fail: true }, TOKEN);
  assert.equal((await request(handler, 'GET', '/auth/status')).status, 503);
  const reply = { approvalId: approval.approvalId, conversationId: identity.conversationId, runId: identity.runId, decision: 'decline' };
  assert.equal((await request(handler, 'POST', '/chat/approval', { ...reply, decision: 'accept' })).status, 400);
  const accepted = await request(handler, 'POST', '/chat/approval', reply);
  assert.equal(accepted.body.status, 'replySent');
  assert.equal((await request(handler, 'POST', '/chat/approval', reply)).status, 409);
  const state = await request(handler, 'GET', `/chat/state?conversationId=${identity.conversationId}`);
  assert.equal(state.body.runs[0].status, 'running');
  assert.equal(state.body.runs[0].pendingApprovals[0].status, 'replySent');
  assert.deepEqual(state.body.runs[0].artifacts, []);
  const stopped = await request(handler, 'POST', '/chat/interrupt', { conversationId: identity.conversationId, runId: identity.runId });
  assert.equal(stopped.body.stopRequested, true);
  assert.equal((await request(handler, 'GET', `/chat/state?conversationId=${identity.conversationId}`)).body.runs[0].status, 'running');
});

const startStop = async handler => (await request(handler, 'POST', '/chat/send', {
  message: 'EGDESK_QA_STOP held ACK unit', clientThreadId: 'stop-thread', requestId: 'stop-request', profileEnabled: false,
})).body;
const stopIdentity = run => ({ conversationId: run.conversationId, runId: run.runId, requestId: run.requestId });
const fixtureState = async handler => (await request(handler, 'GET', '/__qa/state', null, TOKEN)).body;

// Importing the rendered CLI would connect to Firefox. Evaluate only its real
// pure predicate; no copied implementation and no browser/runtime startup.
const chatVerifierSource = fs.readFileSync(new URL('./verify-firefox-mcp-chat-fixture-flow.mjs', import.meta.url), 'utf8');
const artifactReadinessSource = chatVerifierSource.slice(chatVerifierSource.indexOf('function createArtifactClickReadiness()'),
  chatVerifierSource.indexOf('async function observeArtifactClickTarget('));
const makeArtifactReadiness = vm.runInNewContext(`(${artifactReadinessSource.trim()})`);
const rectangle = (left, top, width, height) => ({ left, top, right: left + width, bottom: top + height, width, height });
const artifactObservation = (top = 573.72, hittable = true) => ({ matchCount: 1, artifactId: 'qa-artifact', runId: 'qa-run', answerId: 'qa-conversation/qa-run',
  rect: rectangle(603.85, top, 146.65, 30.83), logRect: rectangle(557.6, 237.12, 404.73, 401.65), scrollTop: 500,
  viewport: rectangle(0, 0, 1440, 900), clippingAncestors: [{ rect: rectangle(557.6, 237.12, 404.73, 401.65), x: true, y: true }],
  visible: true, disabled: false, hittable });

test('Chat artifact waits out the observed End smooth-scroll trace, then needs three stable hit-tested observations', () => {
  const ready = makeArtifactReadiness();
  // Central native click at (677,658) hit chat-run-status while the chip was
  // below its clipping log; a second click is not an acceptable workaround.
  for (const top of [670.07, 654.8, 642.45]) assert.equal(ready(artifactObservation(top, false)), false);
  assert.equal(ready(artifactObservation(590)), false);
  assert.equal(ready(artifactObservation(580)), false);
  assert.equal(ready(artifactObservation()), false);
  assert.equal(ready(artifactObservation()), false);
  assert.equal(ready(artifactObservation()), true);
});

test('Chat artifact readiness resets on occlusion, clipping, drift, identity change or invalid geometry', () => {
  for (const mutate of [row => { row.hittable = false; }, row => { row.matchCount = 2; }, row => { row.disabled = true; },
    row => { row.visible = false; }, row => { row.rect.left = -1; }, row => { row.rect.bottom = 640; },
    row => { row.rect.top = NaN; }, row => { row.scrollTop = undefined; },
    row => { row.clippingAncestors[0].rect.bottom = 590; }, row => { row.logRect = null; }]) {
    const ready = makeArtifactReadiness();
    assert.equal(ready(artifactObservation()), false);
    assert.equal(ready(artifactObservation()), false);
    const changed = artifactObservation(); mutate(changed); assert.equal(ready(changed), false);
    assert.equal(ready(artifactObservation()), false);
    assert.equal(ready(artifactObservation()), false);
    assert.equal(ready(artifactObservation()), true);
  }
  for (const mutate of [row => { row.artifactId = 'different'; }, row => { row.scrollTop += 1; }, row => { row.rect.top += 1; }]) {
    const ready = makeArtifactReadiness();
    ready(artifactObservation()); ready(artifactObservation());
    const changed = artifactObservation(); mutate(changed);
    assert.equal(ready(changed), false);
    assert.equal(ready(changed), false);
    assert.equal(ready(changed), true);
  }
});

test('Chat artifact readiness is observation-only before the existing one native click, keeping all 72 assertions', () => {
  const stage = chatVerifierSource.slice(chatVerifierSource.indexOf('const artifactChip ='));
  assert.ok(stage.indexOf("await harness.scrollWithKey('.egd-codex-messages', 'End')") < stage.indexOf('const clickReady ='));
  assert.ok(stage.indexOf('}, clickReady,') < stage.indexOf('await harness.click(artifactChip)'));
  assert.equal((chatVerifierSource.match(/await harness\.click\(artifactChip\)/g) || []).length, 1);
  assert.equal((chatVerifierSource.match(/check\(/g) || []).length, 72);
  const observe = chatVerifierSource.slice(chatVerifierSource.indexOf('async function observeArtifactClickTarget('),
    chatVerifierSource.indexOf('async function beginArtifactClickDiagnostics('));
  assert.doesNotMatch(artifactReadinessSource + observe, /dispatchEvent|\.click\(|\.focus\(|scrollIntoView|scrollTop\s*=|\.style\.\w+\s*=/);
});

test('Codex COMPLETE artifact stays usable and points to exact owned bytes after message release, SSE replay and hydration', async t => {
  const fetchSpy = t.mock.method(globalThis, 'fetch', () => { throw new Error('No provider or file HTTP request'); });
  const { handler, info } = setup(t);
  const frames = [];
  const stream = request(handler, 'GET', '/events?chatProtocol=2', null, null, response => {
    response.write = frame => { frames.push(frame); return true; };
  });
  await new Promise(resolve => setImmediate(resolve));
  const callbacks = [];
  const timer = t.mock.method(globalThis, 'setTimeout', (callback, ms) => {
    assert.ok([14, 15, 80].includes(ms)); callbacks.push(callback); return callbacks.length;
  });
  let sent;
  try {
    const pending = request(handler, 'POST', '/chat/send', {
      message: 'EGDESK_QA_COMPLETE artifact regression', profileEnabled: false,
      clientThreadId: 'artifact-client', requestId: 'artifact-request', engineId: 'codex', engineProfileId: 'codex-default',
    });
    await new Promise(resolve => setImmediate(resolve));
    for (let count = 0; callbacks.length; count++) {
      assert.ok(count < 100, 'Bounded fixture stream only'); callbacks.shift()();
    }
    sent = await pending;
  } finally { timer.mock.restore(); }
  assert.equal(sent.status, 202);
  const before = await fixtureState(handler), runId = sent.body.runId;
  assert.equal(before.runs[0].fixtureStage, 'streaming-visible');
  assert.deepEqual(before.runs[0].artifacts, []);
  await request(handler, 'POST', '/__qa/release', { runId, phase: 'message' }, TOKEN);
  const afterMessage = await fixtureState(handler), run = afterMessage.runs[0];
  assert.equal(run.status, 'running', 'Artifact must not fabricate run completion');
  assert.equal(run.artifacts.length, 1);
  const artifact = run.artifacts[0];
  assertQaFixtureArtifact(info.profile, artifact);
  assert.equal(usableArtifact(artifact), true);
  assert.equal(artifact.target.path, info.artifactPath);
  assert.equal(fs.readFileSync(artifact.target.path, 'utf8'), 'EG-Desk deterministic QA fixture reference only.\n');
  const original = fs.readFileSync(artifact.target.path);
  await request(handler, 'POST', '/__qa/release', { runId, phase: 'run' }, TOKEN);
  await request(handler, 'POST', '/__qa/replay', {}, TOKEN);
  const events = frames.filter(frame => frame.startsWith('event: codex\n'))
    .map(frame => JSON.parse(frame.split('\ndata: ')[1].trim()));
  assert.equal(events.some(event => event.type === 'engine.status'), false, 'Claude engine rows must not leak into Codex SSE');
  const artifactEvents = events.filter(event => event.event === 'artifact.available');
  assert.equal(artifactEvents.length, 2);
  assert.deepEqual(artifactEvents[0].details.artifact, artifact);
  assert.deepEqual(artifactEvents[1].details.artifact, artifact);
  const snapshot = (await request(handler, 'GET', `/chat/state?conversationId=${run.conversationId}`)).body;
  const [hydrated] = mergeChatSnapshot(createChatProtocolState(), snapshot, run.clientThreadId);
  const messages = projectRunMessages([], hydrated);
  const chips = messages.flatMap(message => message.artifacts || []);
  assert.deepEqual(chips, [artifact], 'Real UI hydration retains one usable artifact, not a stale or duplicate reference');
  assert.equal(usableArtifact(chips[0]), true);
  assert.deepEqual(fs.readFileSync(artifact.target.path), original);
  assert.equal((await request(handler, 'GET', '/v1/state')).body.auth.isLoggedIn, true);
  assert.equal(Object.hasOwn((await request(handler, 'GET', '/v1/state')).body, 'engines'), false);
  await request(handler, 'POST', '/__qa/reconnect', {}, TOKEN);
  await stream;
  assert.equal(fetchSpy.mock.callCount(), 0);
});

test('Codex STOP exposes a streaming message before the delayed POST ACK, including partial-history refresh', async t => {
  const { handler } = setup(t);
  const delayed = [];
  const timer = t.mock.method(globalThis, 'setTimeout', (callback, ms) => {
    assert.equal(ms, 80);
    delayed.push(callback);
    return 1;
  });
  const pending = startStop(handler);
  await new Promise(resolve => setImmediate(resolve));
  try {
    const before = await fixtureState(handler), run = before.runs[0];
    assert.equal(run.status, 'running');
    assert.equal(before.observed.sends[0].respondedAt, undefined, 'POST is still pending');
    await request(handler, 'POST', '/__qa/history', { partial: true }, TOKEN);
    const snapshot = (await request(handler, 'GET', `/chat/state?conversationId=${run.conversationId}`)).body;
    assert.equal(snapshot.historyComplete, false);
    assert.equal((await request(handler, 'POST', '/__qa/delta', { runId: run.runId, delta: ' QA-RESUMED-DELTA' }, TOKEN)).status, 200);
    const updated = (await fixtureState(handler)).runs[0].messages.filter(row => row.role === 'assistant');
    assert.equal(updated.length, 1);
    assert.equal(updated[0].text, 'Waiting for stop. QA-RESUMED-DELTA');
    assert.equal(updated[0].status, 'streaming');
  } finally {
    timer.mock.restore();
    for (const callback of delayed) callback();
    await pending;
  }
  const after = await fixtureState(handler);
  assert.equal(after.observed.events.filter(row => row.event === 'message.started').length, 1, 'ACK cannot restart the message');
  assert.equal(after.runs[0].messages.find(row => row.role === 'assistant').text, 'Waiting for stop. QA-RESUMED-DELTA');
});

test('explicit Stop hold withholds HTTP and SSE until one exact release, never terminal completion', async t => {
  const fetchSpy = t.mock.method(globalThis, 'fetch', () => { throw new Error('No real provider or forwarding'); });
  const { handler } = setup(t);
  const id = stopIdentity(await startStop(handler));
  const hold = { ...id, deadlineAt: Date.now() + 10000 };
  assert.equal((await request(handler, 'POST', '/__qa/hold-stop', hold)).status, 403);
  assert.equal((await request(handler, 'POST', '/__qa/hold-stop', { ...hold, requestId: 'foreign' }, TOKEN)).status, 404);
  assert.equal((await request(handler, 'POST', '/__qa/hold-stop', { ...hold, deadlineAt: Date.now() + 60000 }, TOKEN)).status, 400);
  assert.equal((await request(handler, 'POST', '/__qa/hold-stop', hold, TOKEN)).status, 200);
  assert.equal((await request(handler, 'POST', '/__qa/hold-stop', hold, TOKEN)).status, 409);
  assert.equal((await request(handler, 'POST', '/__qa/release-stop', id, TOKEN)).status, 409);
  let settled = false;
  const nativeStopBody = { conversationId: id.conversationId, runId: id.runId };
  const pending = request(handler, 'POST', '/chat/interrupt', nativeStopBody).then(value => { settled = true; return value; });
  await new Promise(resolve => setImmediate(resolve));
  const held = await fixtureState(handler);
  assert.equal(settled, false, 'HTTP ACK must still be withheld');
  assert.equal(held.runs[0].stopAckHold.state, 'pending');
  assert.equal(held.runs[0].stopRequested, false);
  assert.equal(held.runs[0].status, 'running');
  assert.equal(held.observed.events.some(event => ['run.stop_requested', 'run.completed'].includes(event.event)), false);
  assert.equal((await request(handler, 'POST', '/chat/interrupt', id)).status, 409);
  assert.equal((await request(handler, 'POST', '/chat/interrupt', { ...id, conversationId: 'foreign' })).status, 404);
  assert.equal((await request(handler, 'POST', '/__qa/release-stop', id)).status, 403);
  assert.equal((await request(handler, 'POST', '/__qa/release-stop', { ...id, requestId: 'foreign' }, TOKEN)).status, 404);
  assert.equal((await request(handler, 'POST', '/__qa/release', { runId: id.runId, phase: 'run' }, TOKEN)).status, 409);
  assert.equal(settled, false, 'refused controls cannot release the pending response');
  assert.equal((await request(handler, 'POST', '/__qa/release-stop', id, TOKEN)).status, 200);
  assert.deepEqual(await pending, { status: 202, body: { accepted: true, stopRequested: true } });
  const ack = await fixtureState(handler);
  assert.equal(ack.runs[0].status, 'running');
  assert.equal(ack.runs[0].stopRequested, true);
  assert.equal(ack.runs[0].stopAckHold.state, 'released');
  assert.equal(ack.observed.events.filter(event => event.event === 'run.stop_requested').length, 1);
  assert.equal(ack.observed.events.some(event => event.event === 'run.completed'), false);
  assert.equal((await request(handler, 'POST', '/__qa/release-stop', id, TOKEN)).status, 409);
  assert.equal((await request(handler, 'POST', '/chat/interrupt', id)).status, 409);
  assert.equal((await request(handler, 'POST', '/__qa/release', { runId: id.runId, phase: 'run' }, TOKEN)).status, 200);
  const terminal = await fixtureState(handler);
  assert.equal(terminal.runs[0].status, 'interrupted');
  assert.equal(terminal.observed.events.filter(event => event.event === 'run.completed').length, 1);
  assert.equal(terminal.observed.sends.length, 1);
  assert.equal(terminal.observed.interrupts.length, 1);
  assert.equal(terminal.observed.authWrites.length, 0);
  assert.equal(fetchSpy.mock.callCount(), 0);
});

test('Stop hold deadline, client close and disposal cannot leak an ACK or retain a pending response', async t => {
  for (const action of ['deadline', 'close', 'dispose']) {
    const transport = setup(t);
    const { handler } = transport;
    const id = stopIdentity(await startStop(handler));
    t.mock.timers.enable({ apis: ['setTimeout'] });
    assert.equal((await request(handler, 'POST', '/__qa/hold-stop', { ...id, deadlineAt: Date.now() + 1000 }, TOKEN)).status, 200);
    let response;
    const pending = request(handler, 'POST', '/chat/interrupt', id, null, value => { response = value; });
    await new Promise(resolve => setImmediate(resolve));
    if (action === 'deadline') t.mock.timers.tick(1000);
    else if (action === 'close') response.destroy();
    else transport.dispose();
    assert.equal((await pending).status, action === 'close' ? 0 : 408);
    t.mock.timers.reset();
    const state = await fixtureState(handler);
    assert.equal(state.runs[0].stopAckHold.state, { deadline: 'expired', close: 'cancelled', dispose: 'disposed' }[action]);
    assert.equal(state.runs[0].stopRequested, false);
    assert.equal(state.observed.events.some(event => ['run.stop_requested', 'run.completed'].includes(event.event)), false);
    assert.equal(state.observed.interrupts.length, 1);
    assert.equal((await request(handler, 'POST', '/__qa/release-stop', id, TOKEN)).status, 409);
    assert.equal((await request(handler, 'POST', '/chat/interrupt', id)).status, 409);
  }
});

test('default Stop fixture still acknowledges immediately without the opt-in hold', async t => {
  const { handler } = setup(t);
  const id = stopIdentity(await startStop(handler));
  assert.equal((await request(handler, 'POST', '/chat/interrupt', id)).status, 202);
  const state = await fixtureState(handler);
  assert.equal(state.runs[0].stopAckHold, null);
  assert.equal(state.runs[0].stopRequested, true);
  assert.equal(state.runs[0].status, 'running');
});

test('Terminal fixture is explicit and missing-session output never becomes native exit proof', async (t) => {
  const { handler } = setup(t);
  assert.equal((await request(handler, 'POST', '/terminal/spawn', {})).status, 403);
  await request(handler, 'POST', '/__qa/terminal-mode', { mode: 'unknown' }, TOKEN);
  const spawned = await request(handler, 'POST', '/terminal/spawn', { cols: 80, rows: 24 });
  const sessionId = spawned.body.sessionId;
  const killed = await request(handler, 'POST', '/terminal/kill', { sessionId });
  assert.equal(killed.status, 200);
  assert.equal(killed.body.status, 'STOP_REQUESTED');
  assert.equal(killed.body.exitConfirmed, false);
  const missing = await request(handler, 'POST', '/terminal/read', { sessionId });
  assert.equal(missing.status, 404);
  assert.equal(missing.body.status, 'UNKNOWN');
  assert.equal(missing.body.exited, null);
  assert.equal(missing.body.exitConfirmed, false);
  assert.throws(() => assertNativeTerminalExit(killed.body, sessionId));
  assert.throws(() => assertNativeTerminalExit(missing.body, sessionId));
});

const attachment = (id, sourceRef, kind = 'file', text = '') => ({ id, kind, label: `QA ${id}`, sourceRef,
  capturedAt: 1700000000000, captureScope: { type: kind === 'file' ? 'file' : kind === 'browser' ? 'document-text' : 'board-selection' },
  ...(kind === 'file' ? {} : { content: { mime: 'text/plain', text, truncated: false } }) });

const sourceRoute = (r, extra = {}, prefix = '/context/sources') => `${prefix}?${new URLSearchParams({
  engineId: r.engineId, engineProfileId: r.engineProfileId, clientThreadId: r.clientThreadId,
  conversationId: r.conversationId, ...extra })}`;
const sourceControl = (handler, key, value) => request(handler, 'POST', '/__qa/context-config', { [key]: value }, TOKEN);
const sourceRelease = async (handler, r, requestId = null) => {
  // Test callers read the GET ID from bounded server evidence, never invent it
  // from a route/hold ID or treat an armed control as a received request.
  requestId ??= (await fixtureState(handler)).sourceStatus.receipts.findLast(receipt => receipt.requestId
    && Object.keys(r).every(key => receipt.R[key] === r[key]))?.requestId;
  return request(handler, 'POST', '/__qa/context-release', { phase: 'sources', ...r, requestId }, TOKEN);
};
async function sourceRoom(handler, clientThreadId, captures = null) {
  if (!captures) captures = (await request(handler, 'POST', '/context/captures', { clientThreadId,
    attachments: [attachment(`selection-${clientThreadId}`, { viewId: `view-${clientThreadId}` }, 'browser', 'Immutable CTX04 source')] })).body.captures;
  const result = await request(handler, 'POST', '/chat/send', { message: 'EGDESK_QA_CONTEXT unit source status', profileEnabled: false,
    clientThreadId, requestId: `request-${clientThreadId}`, contextSnapshotIds: captures.map(c => c.sourceId),
    contextCapabilities: { read: true, reader: true, publishBriefing: true } });
  assert.equal(result.status, 202, JSON.stringify(result.body));
  return { r: { engineId: 'codex', engineProfileId: 'codex-default', clientThreadId,
    conversationId: result.body.conversationId, sourceId: captures[0].sourceId }, captures, run: result.body };
}

test('CTX04 state fixture is opt-in; exact Codex capture routing preserves legacy GET and rejects query widening', async t => {
  const { handler } = setup(t);
  const { r, captures } = await sourceRoom(handler, 'source-route-A');
  const capturePath = `/context/captures/${r.sourceId}`;
  assert.equal((await request(handler, 'GET', capturePath)).status, 200);
  assert.equal((await request(handler, 'GET', sourceRoute(r, {}, capturePath))).status, 200);
  assert.equal((await request(handler, 'GET', sourceRoute(r))).status, 404);
  assert.equal((await sourceControl(handler, 'sourceStatus', { ...r, state: 'active', reason: null, changedAt: null })).status, 403);
  for (const extra of [{ unknown: '1' }, { ownerKey: 'a' }, { epoch: '0' }, { sourceId: r.sourceId },
    { engineId: 'claude' }, { engineProfileId: 'other' }, { clientThreadId: 'wrong' }, { conversationId: 'wrong' },
    { engineId: '' }, { packetId: '' }, { clientThreadId: '\0' }]) {
    assert.ok((await request(handler, 'GET', sourceRoute(r, extra, capturePath))).status >= 400, JSON.stringify(extra));
  }
  assert.equal((await request(handler, 'GET', sourceRoute(r, {}, capturePath) + '&engineId=codex')).status, 400);
  assert.equal((await request(handler, 'GET', capturePath + '/extra')).status, 404);
  const preview = (await request(handler, 'POST', '/context/captures', { clientThreadId: r.clientThreadId,
    attachments: [attachment('preview-only', { viewId: 'preview' }, 'browser', 'Unsent preview')] })).body.captures[0];
  const unsent = await request(handler, 'GET', sourceRoute(r, {}, `/context/captures/${preview.sourceId}`));
  assert.equal(unsent.status, 200, 'legacy same-client preview remains readable in an existing conversation before send');
  assert.equal(unsent.body.delivered, null); assert.deepEqual(unsent.body.bindings, []);
  assert.notEqual(captures[0].id, r.sourceId);
});

test('legacy opt-in-off Claude unsent capture remains readable in its same-client conversation without granting tracking or another owner', async t => {
  const { handler } = setup(t, { claude: true });
  const started = await claudeSend(handler, 'TEXT', CLAUDE_ROUTE);
  assert.equal(started.status, 202);
  const route = { ...CLAUDE_ROUTE, conversationId: started.body.conversationId };
  const captured = await claudeCapture(handler, [attachment('unsent-claude', { viewId: 'unsent-view' }, 'browser', 'Immutable preview')], route);
  assert.equal(captured.status, 200);
  const sourceId = captured.body.captures[0].sourceId;
  const read = overrides => request(handler, 'GET', contextRoute(sourceId, { ...route, ...overrides }));
  const before = await read({});
  assert.equal(before.status, 200, 'legacy 200 must not become a tracking-related read denial');
  assert.equal(before.body.source.text, 'Immutable preview'); assert.equal(before.body.delivered, null);
  assert.deepEqual(before.body.bindings, []);
  for (const patch of [{ clientThreadId: 'other-client' }, { conversationId: 'other-room' },
    { engineId: 'codex' }, { engineProfileId: 'codex-default' }]) assert.ok((await read(patch)).status >= 400);
  await request(handler, 'POST', '/__qa/account-change', { variant: 'b', engineId: 'claude' }, TOKEN);
  assert.ok((await read({})).status >= 400);
});

test('CTX04 same stored capture has independent per-conversation status and packets, with no recapture or redelivery', async t => {
  const { handler } = setup(t, { stateFixtures: true });
  const a = await sourceRoom(handler, 'status-A');
  const b = await sourceRoom(handler, 'status-B', a.captures);
  for (const value of [a, b]) assert.equal((await request(handler, 'POST', '/__qa/context-release', { phase: 'read', runId: value.run.runId }, TOKEN)).status, 200);
  const read = r => request(handler, 'GET', sourceRoute(r, {}, `/context/captures/${r.sourceId}`));
  const originalA = (await read(a.r)).body, originalB = (await read(b.r)).body;
  assert.notEqual(originalA.delivered.packetId, originalB.delivered.packetId);
  assert.equal(originalA.delivered.binding.conversationId, a.r.conversationId);
  assert.equal(originalB.delivered.binding.conversationId, b.r.conversationId);
  assert.equal((await request(handler, 'GET', sourceRoute(b.r, { packetId: originalA.delivered.packetId }, `/context/captures/${b.r.sourceId}`))).status, 404);
  const before = await fixtureState(handler);
  for (const reason of ['fileChanged', 'navigated', 'unknown']) {
    assert.equal((await sourceControl(handler, 'sourceStatus', { ...a.r, state: 'stale', reason, changedAt: 1700000000123 })).status, 200);
    const statusA = (await request(handler, 'GET', sourceRoute(a.r))).body;
    const statusB = (await request(handler, 'GET', sourceRoute(b.r))).body;
    assert.equal(statusA.conversationId, a.r.conversationId);
    assert.deepEqual(statusA.sources, [{ sourceId: a.r.sourceId, kind: 'browser', viewId: 'view-status-A',
      state: 'stale', reason, changedAt: 1700000000123, announcedAt: null }]);
    assert.equal(statusB.sources[0].state, 'active'); assert.equal(statusB.sources[0].changedAt, null);
    assert.deepEqual((await read(a.r)).body, originalA); assert.deepEqual((await read(b.r)).body, originalB);
  }
  assert.equal((await sourceControl(handler, 'sourceStatus', { ...a.r, state: 'active', reason: null, changedAt: null })).status, 200);
  assert.equal((await sourceControl(handler, 'sourceStatus', { ...a.r, state: 'missing', reason: null, changedAt: null })).status, 200);
  assert.deepEqual((await request(handler, 'GET', sourceRoute(a.r))).body.sources, []);
  assert.equal((await request(handler, 'GET', sourceRoute(b.r))).body.sources.length, 1);
  assert.deepEqual((await read(a.r)).body, originalA, 'missing status never destroys historical source/payload');
  assert.equal((await sourceControl(handler, 'sourceStatus', { ...a.r, state: 'active', reason: null, changedAt: null })).status, 200, 'only an explicit control restores the still-tracked synthetic row');
  const after = await fixtureState(handler);
  assert.equal(after.context.captureBatches, before.context.captureBatches);
  assert.equal(after.context.fileCaptureOperations, before.context.fileCaptureOperations);
  assert.deepEqual(after.context.deliveries, before.context.deliveries);
  assert.deepEqual(after.observed.sends, before.observed.sends);
});

test('CTX04 controls reject wrong account/engine/profile/room/selection and malformed reason/time without altering old capture flags', async t => {
  const { handler } = setup(t, { stateFixtures: true });
  const { r, captures } = await sourceRoom(handler, 'control-A');
  const valid = { ...r, state: 'stale', reason: 'unknown', changedAt: 1700000000000 };
  const prior = (await request(handler, 'GET', sourceRoute(r))).body;
  for (const patch of [{ sourceId: captures[0].id }, { sourceId: '00000000-0000-0000-0000-000000000000' },
    { conversationId: 'wrong' }, { clientThreadId: 'wrong' }, { engineId: 'claude' }, { engineProfileId: 'other' },
    { ownerKey: 'a' }, { state: 'failed' }, { reason: 'latest' }, { changedAt: '1700000000000' },
    { changedAt: -1 }, { changedAt: 1.5 }, { changedAt: null }, { state: 'active' }, { reason: null }]) {
    assert.ok((await sourceControl(handler, 'sourceStatus', { ...valid, ...patch })).status >= 400, JSON.stringify(patch));
  }
  assert.deepEqual((await request(handler, 'GET', sourceRoute(r))).body, prior);
  assert.equal((await request(handler, 'POST', '/__qa/context-config', { sourceStatus: valid })).status, 403);
  assert.equal((await request(handler, 'POST', '/__qa/context-config', { sourceStatus: valid, failNextCapture: true }, TOKEN)).status, 400);
  await request(handler, 'POST', '/__qa/context-config', { failNextCapture: true }, TOKEN);
  assert.equal((await sourceControl(handler, 'sourceStatus', valid)).status, 200);
  assert.equal((await request(handler, 'POST', '/context/captures', { clientThreadId: r.clientThreadId, attachments: [] })).status, 503);
  for (const suffix of ['&ownerKey=a', '&conversationId=another', '&extra=1', '&engineId=codex']) {
    assert.equal((await request(handler, 'GET', sourceRoute(r) + suffix)).status, 400);
  }
  for (const method of ['POST', 'PUT', 'DELETE']) assert.equal((await request(handler, method, sourceRoute(r), {})).status, 405);
  await request(handler, 'POST', '/__qa/account-change', { variant: 'b' }, TOKEN);
  assert.equal((await request(handler, 'GET', sourceRoute(r))).status, 403);
  assert.equal((await sourceControl(handler, 'sourceStatus', valid)).status, 403);
});

test('CTX04 held response delivers original snapshot after room switch; failure/hold never blocks immutable payload', async t => {
  const { handler } = setup(t, { stateFixtures: true });
  const a = await sourceRoom(handler, 'late-A'), b = await sourceRoom(handler, 'late-B');
  await request(handler, 'POST', '/__qa/context-release', { runId: a.run.runId, phase: 'read' }, TOKEN);
  const capturePath = sourceRoute(a.r, {}, `/context/captures/${a.r.sourceId}`);
  const original = (await request(handler, 'GET', capturePath)).body;
  assert.equal((await sourceControl(handler, 'sourceStatusResponse', { ...a.r, mode: 'error' })).status, 200);
  assert.equal((await request(handler, 'GET', sourceRoute(b.r))).status, 200);
  assert.equal((await request(handler, 'GET', sourceRoute(a.r))).status, 503);
  assert.deepEqual((await request(handler, 'GET', capturePath)).body, original);
  assert.equal((await request(handler, 'GET', sourceRoute(a.r))).status, 200, 'error is one shot');
  await sourceControl(handler, 'sourceStatusResponse', { ...a.r, mode: 'hold', deadlineAt: Date.now() + 20000 });
  const pending = request(handler, 'GET', sourceRoute(a.r));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual((await request(handler, 'GET', capturePath)).body, original);
  await sourceControl(handler, 'sourceStatus', { ...a.r, state: 'stale', reason: 'fileChanged', changedAt: 1700000000000 });
  assert.equal((await request(handler, 'GET', sourceRoute(b.r))).body.conversationId, b.r.conversationId);
  const originalRequestId = (await fixtureState(handler)).sourceStatus.responses.find(row => row.sourceId === a.r.sourceId).requestId;
  assert.equal((await sourceRelease(handler, b.r, originalRequestId)).status, 409);
  assert.equal((await sourceRelease(handler, a.r)).status, 200);
  const late = await pending;
  assert.equal(late.status, 200); assert.equal(late.body.conversationId, a.r.conversationId);
  assert.equal(late.body.sources[0].state, 'active', 'actual old snapshot delivered; UI guard must discard it');
  assert.equal((await request(handler, 'GET', sourceRoute(a.r))).body.sources[0].state, 'stale');
  assert.equal((await sourceRelease(handler, a.r)).status, 409);
});

test('CTX04 hold deadline, closed client, dispose and account epoch all bound response lifetime', async t => {
  const transport = setup(t, { stateFixtures: true }), { handler } = transport;
  const { r } = await sourceRoom(handler, 'expiry-A');
  for (const deadlineAt of [null, Date.now() - 1, Date.now() + 31000, 'later']) {
    assert.equal((await sourceControl(handler, 'sourceStatusResponse', { ...r, mode: 'hold', deadlineAt })).status, 400);
  }
  const hold = () => sourceControl(handler, 'sourceStatusResponse', { ...r, mode: 'hold', deadlineAt: Date.now() + 20000 });
  await sourceControl(handler, 'sourceStatusResponse', { ...r, mode: 'hold', deadlineAt: Date.now() + 60 });
  const expired = request(handler, 'GET', sourceRoute(r));
  await new Promise(resolve => setTimeout(resolve, 90));
  assert.equal((await expired).status, 504); assert.equal((await sourceRelease(handler, r)).status, 409);
  const expiryReceipt = (await fixtureState(handler)).sourceStatus.receipts.at(-1);
  assert.equal(expiryReceipt.terminalCause, 'expiry'); assert.equal(expiryReceipt.responseStatus, 504);
  assert.ok(expiryReceipt.finishAt); assert.equal(expiryReceipt.writableFinishedAtClose, true);
  await hold(); assert.equal((await hold()).status, 409);
  let response;
  const closed = request(handler, 'GET', sourceRoute(r), null, null, res => { response = res; });
  await new Promise(resolve => setImmediate(resolve)); response.destroy(); await closed;
  assert.deepEqual((await fixtureState(handler)).sourceStatus.responses, []);
  await hold(); const changed = request(handler, 'GET', sourceRoute(r));
  await new Promise(resolve => setImmediate(resolve));
  await request(handler, 'POST', '/__qa/account-change', { variant: 'b' }, TOKEN);
  const changedResult = await changed;
  assert.equal(changedResult.body.code, 'ACCOUNT_CHANGED');
  assert.equal(changedResult.body.receipt.terminalCause, 'account-change');
  await request(handler, 'POST', '/__qa/account-change', { variant: 'a' }, TOKEN);
  assert.equal((await sourceRelease(handler, r)).status, 403, 'ABA cannot revive the old response');
  await hold(); const disposed = request(handler, 'GET', sourceRoute(r));
  await new Promise(resolve => setImmediate(resolve)); await transport.dispose();
  const disposedResult = await disposed;
  assert.equal(disposedResult.status, 503); assert.equal(disposedResult.body.receipt.terminalCause, 'server-close');
});

test('CTX04 terminal receipt separates armed, received, write attempt and finish; an old close cannot delete a rearmed same-route entry', async t => {
  const { handler } = setup(t, { stateFixtures: true });
  const { r } = await sourceRoom(handler, 'receipt-identity');
  const original = (await request(handler, 'GET', sourceRoute(r))).body;
  const realSetTimeout = globalThis.setTimeout, timerCallbacks = [];
  t.mock.method(globalThis, 'setTimeout', (callback, delay, ...args) => {
    timerCallbacks.push(callback); return realSetTimeout(callback, delay, ...args);
  });
  const hold = () => sourceControl(handler, 'sourceStatusResponse', { ...r, mode: 'hold', deadlineAt: Date.now() + 20000 });
  const armed = await hold();
  assert.equal(armed.body.requestId, null); assert.match(armed.body.holdId, /^[\da-f-]{36}$/);
  let receipt = (await fixtureState(handler)).sourceStatus.receipts.at(-1);
  assert.equal(receipt.holdId, armed.body.holdId); assert.equal(receipt.requestId, null);
  assert.equal(receipt.receivedAt, null); assert.equal(receipt.snapshotHash, null);
  assert.equal(receipt.writeAttempted, false); assert.deepEqual(receipt.R, r);
  assert.equal(receipt.account, 'a'); assert.equal(receipt.epoch, 0); assert.equal(receipt.heldSourceId, r.sourceId);
  assert.equal((await request(handler, 'POST', '/__qa/context-release', { phase: 'sources', ...r }, TOKEN)).status, 400);
  assert.equal((await sourceRelease(handler, r, armed.body.holdId)).body.code, 'QA_SOURCE_RESPONSE_NOT_FOUND');
  let oldResponse;
  const pending = request(handler, 'GET', sourceRoute(r), null, null, res => {
    oldResponse = res; res.deferFinish = true; res.deferClose = true;
  });
  await new Promise(resolve => setImmediate(resolve));
  receipt = (await fixtureState(handler)).sourceStatus.receipts.at(-1);
  const requestId = receipt.requestId;
  assert.match(requestId, /^[\da-f-]{36}$/); assert.notEqual(requestId, receipt.holdId);
  assert.ok(receipt.receivedAt >= receipt.armedAt);
  assert.equal(receipt.snapshotHash, fingerprintQaBytes(JSON.stringify(original)).sha256);
  assert.equal(receipt.finishAt, null);
  await sourceControl(handler, 'sourceStatus', { ...r, state: 'stale', reason: 'unknown', changedAt: 1700000000000 });
  assert.equal((await sourceRelease(handler, { ...r, sourceId: '00000000-0000-0000-0000-000000000000' }, requestId)).status, 404);
  const released = await sourceRelease(handler, r, requestId);
  assert.equal(released.status, 200); assert.equal(released.body.receipt.writeAttempted, true);
  assert.ok(released.body.receipt.endReturnedAt); assert.equal(released.body.receipt.finishAt, null, '200 is not finish or browser callback proof');
  assert.deepEqual((await pending).body, original, 'received snapshot never changes with later status controls');
  const secondArm = await hold();
  const next = request(handler, 'GET', sourceRoute(r));
  await new Promise(resolve => setImmediate(resolve));
  const nextReceipt = (await fixtureState(handler)).sourceStatus.receipts.at(-1);
  assert.equal(nextReceipt.holdId, secondArm.body.holdId); assert.notEqual(nextReceipt.requestId, requestId);
  timerCallbacks[0](); // Already-queued old expiry after clearTimeout/rearm.
  // The old finish and close are intentionally delivered after same-key rearm.
  oldResponse.writableFinished = true; oldResponse.emit('finish'); oldResponse.emit('close');
  const afterOldClose = await fixtureState(handler);
  assert.equal(afterOldClose.sourceStatus.responses.length, 1);
  assert.equal(afterOldClose.sourceStatus.expired, 0);
  assert.equal(afterOldClose.sourceStatus.responses[0].requestId, nextReceipt.requestId);
  const oldReceipt = afterOldClose.sourceStatus.receipts.find(row => row.requestId === requestId);
  assert.equal(oldReceipt.terminalCause, 'finished'); assert.ok(oldReceipt.finishAt); assert.ok(oldReceipt.closeAt);
  assert.equal(oldReceipt.writableFinishedAtClose, true);
  assert.equal((await sourceRelease(handler, r, requestId)).body.code, 'QA_SOURCE_RESPONSE_ALREADY_RELEASED');
  assert.equal((await sourceRelease(handler, r, nextReceipt.requestId)).status, 200);
  assert.equal((await next).body.sources[0].state, 'stale');
});

test('CTX04 peer cancellation is a retained exact-request terminal receipt, not NOT_HELD or expiry success', async t => {
  const { handler } = setup(t, { stateFixtures: true });
  const { r } = await sourceRoom(handler, 'receipt-cancel');
  await sourceControl(handler, 'sourceStatusResponse', { ...r, mode: 'hold', deadlineAt: Date.now() + 140 });
  let response;
  const pending = request(handler, 'GET', sourceRoute(r), null, null, res => { response = res; });
  await new Promise(resolve => setImmediate(resolve));
  const received = (await fixtureState(handler)).sourceStatus.receipts.at(-1);
  response.destroy(); assert.equal((await pending).status, 0);
  await new Promise(resolve => setTimeout(resolve, 170));
  const released = await sourceRelease(handler, r, received.requestId);
  assert.equal(released.status, 409); assert.equal(released.body.code, 'QA_SOURCE_RESPONSE_ALREADY_CLOSED');
  const receipt = released.body.receipt;
  assert.equal(receipt.terminalCause, 'peer-close-before-finish'); assert.ok(receipt.closeAt);
  assert.equal(receipt.writableFinishedAtClose, false); assert.equal(receipt.finishAt, null);
  assert.equal(receipt.writeAttempted, false); assert.equal(receipt.endReturnedAt, null);
  assert.equal(receipt.responseStatus, null); assert.equal(receipt.releaseAttempts, 1); assert.ok(receipt.releaseAttemptAt);
  assert.equal(receipt.snapshotHash, received.snapshotHash);
  assert.equal((await fixtureState(handler)).sourceStatus.expired, 0, 'peer-close clears its own expiry timer');
});

test('CTX04 expiry before GET stays armed-only evidence and a failed write never becomes finished delivery', async t => {
  const { handler } = setup(t, { stateFixtures: true });
  const { r } = await sourceRoom(handler, 'receipt-errors');
  const armed = await sourceControl(handler, 'sourceStatusResponse', { ...r, mode: 'hold', deadlineAt: Date.now() + 60 });
  await new Promise(resolve => setTimeout(resolve, 90));
  const expired = (await fixtureState(handler)).sourceStatus.receipts.find(row => row.holdId === armed.body.holdId);
  assert.equal(expired.terminalCause, 'expiry'); assert.equal(expired.requestId, null); assert.equal(expired.receivedAt, null);
  assert.equal(expired.snapshotHash, null); assert.equal(expired.writeAttempted, false); assert.equal(expired.finishAt, null);
  assert.equal((await sourceRelease(handler, r, armed.body.holdId)).body.code, 'QA_SOURCE_RESPONSE_NOT_FOUND');
  await sourceControl(handler, 'sourceStatusResponse', { ...r, mode: 'hold', deadlineAt: Date.now() + 20000 });
  const failed = request(handler, 'GET', sourceRoute(r), null, null, res => { res.writeHead = () => { throw new Error('Synthetic write failure'); }; });
  await new Promise(resolve => setImmediate(resolve));
  const received = (await fixtureState(handler)).sourceStatus.receipts.at(-1);
  const released = await sourceRelease(handler, r, received.requestId);
  assert.equal(released.status, 409); assert.equal(released.body.receipt.terminalCause, 'write-error');
  assert.equal(released.body.receipt.writeAttempted, true); assert.equal(released.body.receipt.endReturnedAt, null);
  assert.equal(released.body.receipt.finishAt, null); assert.equal(released.body.receipt.writableFinishedAtClose, false);
  assert.equal((await failed).status, 0);
});

test('CTX04 account change after end but before finish keeps its cause and cannot remove a newer hold', async t => {
  const { handler } = setup(t, { stateFixtures: true });
  const { r } = await sourceRoom(handler, 'receipt-inflight');
  await sourceControl(handler, 'sourceStatusResponse', { ...r, mode: 'hold', deadlineAt: Date.now() + 20000 });
  let response;
  const pending = request(handler, 'GET', sourceRoute(r), null, null, res => { response = res; res.deferFinish = true; res.deferClose = true; });
  await new Promise(resolve => setImmediate(resolve));
  const first = (await fixtureState(handler)).sourceStatus.receipts.at(-1);
  assert.equal((await sourceRelease(handler, r, first.requestId)).status, 200); await pending;
  await request(handler, 'POST', '/__qa/account-change', { variant: 'b' }, TOKEN);
  let receipt = (await fixtureState(handler)).sourceStatus.receipts.find(row => row.requestId === first.requestId);
  assert.equal(receipt.terminalCause, 'account-change'); assert.equal(receipt.responseStatus, 200); assert.equal(receipt.finishAt, null);
  await request(handler, 'POST', '/__qa/account-change', { variant: 'a' }, TOKEN);
  const second = await sourceControl(handler, 'sourceStatusResponse', { ...r, mode: 'hold', deadlineAt: Date.now() + 20000 });
  response.writableFinished = true; response.emit('finish'); response.emit('close');
  const state = await fixtureState(handler);
  receipt = state.sourceStatus.receipts.find(row => row.requestId === first.requestId);
  assert.equal(receipt.terminalCause, 'account-change'); assert.ok(receipt.finishAt); assert.ok(receipt.closeAt);
  assert.equal(state.sourceStatus.responses[0].holdId, second.body.holdId);
});

test('CTX04 terminal receipts are bounded at 64 without evicting live holds or treating an evicted receipt as cancellation proof', async t => {
  const { handler } = setup(t, { stateFixtures: true });
  const a = await sourceRoom(handler, 'receipt-retained'), b = await sourceRoom(handler, 'receipt-bounded');
  const hold = r => sourceControl(handler, 'sourceStatusResponse', { ...r, mode: 'hold', deadlineAt: Date.now() + 20000 });
  await hold(a.r);
  const retained = request(handler, 'GET', sourceRoute(a.r));
  await new Promise(resolve => setImmediate(resolve));
  const live = (await fixtureState(handler)).sourceStatus.receipts.at(-1);
  let oldest;
  for (let n = 0; n < 65; n++) {
    await hold(b.r); let response;
    const canceled = request(handler, 'GET', sourceRoute(b.r), null, null, res => { response = res; });
    await new Promise(resolve => setImmediate(resolve));
    if (!oldest) oldest = (await fixtureState(handler)).sourceStatus.receipts.at(-1).requestId;
    response.destroy(); await canceled;
  }
  const state = await fixtureState(handler);
  assert.equal(state.sourceStatus.receipts.length, 64);
  assert.equal(new Set(state.sourceStatus.receipts.map(r => r.holdId)).size, 64);
  assert.ok(state.sourceStatus.receipts.some(row => row.requestId === live.requestId && row.terminalCause === null));
  assert.equal((await sourceRelease(handler, b.r, oldest)).body.code, 'QA_SOURCE_RESPONSE_NOT_FOUND');
  assert.equal((await sourceRelease(handler, a.r, live.requestId)).status, 200); assert.equal((await retained).status, 200);
});

test('CTX04 ephemeral HTTP AbortController cancellation and successful server finish have different exact-request receipts', async t => {
  let handler;
  const server = http.createServer((req, res) => handler(req, res));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const port = server.address().port;
  const transport = setup(t, { stateFixtures: true, fixturePort: port }); handler = transport.handler;
  const { r } = await sourceRoom(handler, 'receipt-http');
  const origin = `http://127.0.0.1:${port}`;
  const httpJson = async (route, body) => {
    const response = await fetch(origin + route, { method: body === undefined ? 'GET' : 'POST',
      headers: { 'x-egdesk-qa-token': TOKEN, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  };
  const state = async () => (await httpJson('/__qa/state')).body.sourceStatus;
  const hold = () => httpJson('/__qa/context-config', { sourceStatusResponse: { ...r, mode: 'hold', deadlineAt: Date.now() + 20000 } });
  const firstHold = await hold(), controller = new AbortController();
  const canceled = fetch(origin + sourceRoute(r), { signal: controller.signal }).then(() => assert.fail('Aborted held GET must not complete'), error => error);
  let first;
  await waitFor(async () => { first = (await state()).receipts.find(row => row.holdId === firstHold.body.holdId); return first?.requestId; });
  controller.abort(); assert.equal((await canceled).name, 'AbortError');
  await waitFor(async () => (await state()).receipts.find(row => row.requestId === first.requestId)?.closeAt);
  const release = requestId => httpJson('/__qa/context-release', { phase: 'sources', ...r, requestId });
  const canceledRelease = await release(first.requestId);
  assert.equal(canceledRelease.status, 409); assert.equal(canceledRelease.body.code, 'QA_SOURCE_RESPONSE_ALREADY_CLOSED');
  assert.equal(canceledRelease.body.receipt.terminalCause, 'peer-close-before-finish');
  assert.equal(canceledRelease.body.receipt.writeAttempted, false); assert.equal(canceledRelease.body.receipt.finishAt, null);
  assert.equal(canceledRelease.body.receipt.writableFinishedAtClose, false);
  const secondHold = await hold();
  const received = fetch(origin + sourceRoute(r)).then(async response => ({ status: response.status, body: await response.json() }));
  let second;
  await waitFor(async () => { second = (await state()).receipts.find(row => row.holdId === secondHold.body.holdId); return second?.requestId; });
  assert.notEqual(first.requestId, second.requestId); assert.notEqual(first.holdId, second.holdId);
  assert.equal((await release(first.requestId)).status, 409, 'old closed GET cannot release the newer same-route hold');
  assert.equal((await state()).responses[0].requestId, second.requestId);
  assert.equal((await release(second.requestId)).status, 200);
  const successful = await received;
  assert.equal(successful.status, 200); assert.equal(successful.body.conversationId, r.conversationId);
  await waitFor(async () => (await state()).receipts.find(row => row.requestId === second.requestId)?.finishAt);
  const receipt = (await state()).receipts.find(row => row.requestId === second.requestId);
  assert.equal(receipt.terminalCause, 'finished'); assert.equal(receipt.responseStatus, 200);
  assert.equal(receipt.writeAttempted, true); assert.ok(receipt.endReturnedAt); assert.ok(receipt.finishAt);
  assert.equal(receipt.snapshotHash, fingerprintQaBytes(JSON.stringify(successful.body)).sha256);
  assert.equal(receipt.heldSourceId, r.sourceId); assert.deepEqual(receipt.R, r); assert.equal(receipt.account, 'a');
  // This asserts this unit HTTP client's result only, not a product/UI callback.
});

test('CTX04 previews, unsupported selections and bounded tracking eviction stay missing instead of borrowing a first/latest row', async t => {
  const { handler } = setup(t, { stateFixtures: true });
  const original = await sourceRoom(handler, 'bounded-A');
  const capture = async (id, kind = 'browser') => (await request(handler, 'POST', '/context/captures', {
    clientThreadId: original.r.clientThreadId, attachments: [attachment(id, { viewId: id }, kind, 'bounded source')] })).body.captures[0];
  const preview = await capture('never-sent');
  assert.equal((await sourceControl(handler, 'sourceStatusResponse', { ...original.r, sourceId: preview.sourceId, mode: 'error' })).status, 403);
  const board = await capture('untracked-board', 'board');
  const bind = async captures => {
    const result = await request(handler, 'POST', '/chat/send', { message: 'EGDESK_QA_CONTEXT bounded tracking', profileEnabled: false,
      clientThreadId: original.r.clientThreadId, conversationId: original.r.conversationId, requestId: `bounded-${captures[0].sourceId}`,
      contextSnapshotIds: captures.map(row => row.sourceId), contextCapabilities: { read: true, reader: true, publishBriefing: true } });
    assert.equal(result.status, 202, JSON.stringify(result.body));
  };
  await bind([board]);
  assert.equal((await sourceControl(handler, 'sourceStatus', { ...original.r, sourceId: board.sourceId, state: 'active', reason: null, changedAt: null })).status, 409);
  assert.equal((await request(handler, 'GET', sourceRoute(original.r))).body.sources.length, 1);
  for (let batch = 0; batch < 2; batch++) {
    const captures = (await request(handler, 'POST', '/context/captures', { clientThreadId: original.r.clientThreadId,
      attachments: Array.from({ length: 16 }, (_, n) => attachment(`bounded-${batch}-${n}`, { viewId: `bounded-${batch}-${n}` }, 'browser', 'Bounded data')) })).body.captures;
    await bind(captures);
  }
  const rows = (await request(handler, 'GET', sourceRoute(original.r))).body.sources;
  assert.equal(rows.length, 32); assert.ok(!rows.some(row => [original.r.sourceId, preview.sourceId, board.sourceId].includes(row.sourceId)));
  assert.equal((await sourceControl(handler, 'sourceStatus', { ...original.r, state: 'active', reason: null, changedAt: null })).status, 409);
  for (let index = 0; index < 64; index++) await sourceRoom(handler, `bounded-room-${index}`, original.captures);
  assert.deepEqual((await request(handler, 'GET', sourceRoute(original.r))).body.sources, []);
  assert.equal((await request(handler, 'GET', sourceRoute(original.r, {}, `/context/captures/${original.r.sourceId}`))).status, 200);
});

test('CTX04 seed gates refuse sidecars and non-fresh profiles without overwriting existing scene or prefs', async t => {
  const { info } = setup(t);
  const seedEnv = { ...FIXTURE_ENV, EGDESK_QA_STATE_FIXTURES: '1', EGDESK_QA_REAL_TURN: '0', EGDESK_QA_CONTEXT_SOURCE_CHANGE_SEED: '1' };
  for (const patch of [{ EGDESK_QA_STATE_FIXTURES: '0' }, { EGDESK_QA_REAL_TURN: '1' }, { EGDESK_QA_CONTEXT_SOURCE_CHANGE_SEED: 'yes' },
    { EGDESK_QA_CLAUDE_FIXTURE: '1' }, { EGDESK_QA_PORTABLE_TRANSFER_FIXTURE: '1' }, { EGDESK_QA_PROJECT_FILE_FIXTURE: '1' }]) {
    assert.throws(() => createQaFixtureTransport({ profile: info.profile, token: TOKEN, env: { ...seedEnv, ...patch } }));
  }
  assert.equal(fs.existsSync(path.join(info.profile, 'qa-fixtures', 'source-change-seed')), false);
  const prefsPath = path.join(info.profile, 'prefs.js');
  fs.writeFileSync(prefsPath, '// already opened profile\n', { flag: 'wx' });
  const seeded = createQaFixtureTransport({ profile: info.profile, token: TOKEN, env: seedEnv });
  await assert.rejects(seeded.ready, /prefs-less/); await seeded.dispose();
  assert.equal(fs.readFileSync(prefsPath, 'utf8'), '// already opened profile\n');
});

test('CTX04 seed resume alone defaults an omitted profile without changing the logged request or weakening exact account/room/Context scope', async t => {
  const { handler, ready } = setup(t, { sourceChangeSeed: true });
  await ready;
  const initial = await fixtureState(handler), [a, b] = initial.sourceChangeSeed.identities;
  const omitted = { engineId: a.engineId, clientThreadId: a.clientThreadId, conversationId: a.conversationId };
  const explicit = { ...omitted, engineProfileId: a.engineProfileId };
  const resume = body => request(handler, 'POST', '/chat/resume', body);
  for (const body of [omitted, explicit]) {
    const result = await resume(body);
    assert.equal(result.status, 200); assert.equal(result.body.conversationId, a.conversationId);
    assert.equal(result.body.runs[0].answerId, a.answerId);
  }
  const logs = (await fixtureState(handler)).observed.resumes;
  assert.equal(logs.length, 2);
  assert.deepEqual(logs[0].sourceChangeResume, { requestBody: omitted, engineProfileIdDefaulted: true,
    validatedRoute: explicit });
  assert.equal(Object.hasOwn(logs[0].sourceChangeResume.requestBody, 'engineProfileId'), false);
  assert.deepEqual(logs[1].sourceChangeResume, { requestBody: explicit, engineProfileIdDefaulted: false,
    validatedRoute: explicit });
  for (const patch of [{ engineProfileId: null }, { engineProfileId: '' }, { engineProfileId: 'wrong' },
    { engineId: 'claude' }, { conversationId: 'not-a-seeded-conversation' }]) {
    assert.equal((await resume({ ...omitted, ...patch })).status, 403, JSON.stringify(patch));
  }
  for (const patch of [{ clientThreadId: b.clientThreadId }, { conversationId: b.conversationId },
    { clientThreadId: `${a.clientThreadId}-binding-new-nonce` }]) {
    const denied = await resume({ ...omitted, ...patch });
    assert.equal(denied.status, 409); assert.equal(denied.body.code, 'NATIVE_BINDING_MISMATCH');
  }
  const scopeWithoutProfile = new URLSearchParams(omitted);
  for (const route of ['/context/sources', `/context/captures/${a.sources[0].sourceId}`]) {
    assert.equal((await request(handler, 'GET', `${route}?${scopeWithoutProfile}`)).status, 403, 'Context GET still requires the exact profile');
  }
  assert.equal((await sourceControl(handler, 'sourceStatus', { ...omitted, sourceId: a.sources[0].sourceId,
    state: 'active', reason: null, changedAt: null })).status, 403, 'Context control still requires exact R');
  await request(handler, 'POST', '/__qa/account-change', { variant: 'b' }, TOKEN);
  assert.equal((await resume(omitted)).status, 403); assert.equal((await resume(explicit)).status, 403);
  const after = await fixtureState(handler);
  assert.deepEqual(after.observed.resumes, logs, 'denied requests create no accepted resume entry');
  assert.deepEqual(after.sourceChangeSeed, initial.sourceChangeSeed);
  assert.deepEqual(after.context, initial.context);
  assert.deepEqual(after.observed.sends, []);
});

test('CTX04 seed rejects rotated or crossed client pairs with the real resume 409 before provider work', async t => {
  const [{ CodexChatRuntime }, { createChatHttpHandler }] = await Promise.all([
    import('../helper/codex-chat-runtime.mjs'), import('../helper/codex-bridge-http.mjs'),
  ]);
  const { handler, ready } = setup(t, { sourceChangeSeed: true });
  await ready;
  const initial = await fixtureState(handler), [a, b] = initial.sourceChangeSeed.identities;
  const rows = [a, b].map(({ clientThreadId, conversationId }) => ({ clientThreadId, conversationId }));
  const before = structuredClone(rows);
  let providerCalls = 0, nativeFallbackReads = 0;
  const forbiddenProvider = () => { providerCalls++; throw new Error('No provider work in resume pairing audit'); };
  // The real handler/runtime checks these read-only stored pairs. No native
  // provider, SQLite write, or fixture authority substitution is involved.
  const runtime = new CodexChatRuntime({ requireStore: true,
    store: { getConversation: id => rows.find(row => row.clientThreadId === id) || null,
      getConversationByNative: () => { nativeFallbackReads++; throw new Error('Resume must not rebind by native ID'); } },
    request: forbiddenProvider, respond: forbiddenProvider });
  const actualHandler = createChatHttpHandler(runtime, async () => {});
  const actual = (req, res) => actualHandler(req, res, new URL(req.url, 'http://fixture.invalid'));
  for (const clientThreadId of [`${a.clientThreadId}-binding-new-nonce`, b.clientThreadId]) {
    for (const profile of [{}, { engineProfileId: a.engineProfileId }]) {
      const body = { engineId: a.engineId, clientThreadId, conversationId: a.conversationId, ...profile };
      const real = await request(actual, 'POST', '/chat/resume', body, null, () => {}, { 'content-type': 'application/json' });
      assert.equal(real.status, 409); assert.equal(real.body.code, 'NATIVE_BINDING_MISMATCH');
      const fixture = await request(handler, 'POST', '/chat/resume', body);
      assert.equal(fixture.status, real.status); assert.equal(fixture.body.code, real.body.code);
    }
  }
  assert.equal(providerCalls, 0); assert.equal(nativeFallbackReads, 0); assert.deepEqual(rows, before);
  const after = await fixtureState(handler);
  assert.deepEqual(after.observed.resumes, []); assert.deepEqual(after.observed.sends, []);
  assert.deepEqual(after.context, initial.context); assert.deepEqual(after.sourceChangeSeed, initial.sourceChangeSeed);
});

test('CTX04 seed-only prelaunch Chat layout fits 1280x800 and 1366x768 reserved chrome while unseeded scene prefs stay absent', async t => {
  for (const options of [{}, { stateFixtures: true }, { sourceChangeSeed: true }]) {
    const { handler, info, ready } = setup(t, options);
    await ready;
    const prefs = {};
    const prefPath = path.join(info.profile, 'user.js'), before = fs.readFileSync(prefPath, 'utf8');
    vm.runInNewContext(before, { user_pref: (key, value) => { prefs[key] = value; } });
    const state = await fixtureState(handler);
    if (!options.sourceChangeSeed) {
      assert.equal(state.sourceChangeSeed, options.stateFixtures ? null : undefined);
      assert.equal(prefs['egdesk.deskSession.v1'], undefined);
      assert.equal(prefs['egdesk.surfaceLifecycle.v1'], undefined);
      assert.equal(fs.existsSync(path.join(info.profile, 'qa-fixtures', 'source-change-seed')), false);
    } else {
      const desk = JSON.parse(prefs['egdesk.deskSession.v1']), g = desk.cards[0].geometry;
      assert.deepEqual(g, { x: 160, y: 80, width: 1000, height: 620, zIndex: 1 });
      assert.deepEqual(desk.desk.pan, { x: 0, y: 0 }); assert.equal(desk.desk.zoom, 1);
      // QA layout bounds only, not rendered hit proof: 1280x800 is the
      // proposed reference; 1366x768 is Main's observed failure viewport.
      // Neither fixture changes the native window size. Reserve the current
      // topbar (52), bag right edge (78), and Dock bottom band (46 + 12).
      for (const viewport of [{ width: 1280, height: 800 }, { width: 1366, height: 768 }]) {
        assert.ok(g.x >= 78 + 16, 'clear of the PresetBag');
        assert.ok(g.y >= 52 + 16, 'below the topbar');
        assert.ok(g.x + g.width <= viewport.width - 16, 'inside the viewport right edge');
        assert.ok(viewport.height - 58 - (g.y + g.height) >= 10, 'at least 10px above the reserved Dock band');
      }
    }
    assert.equal(fs.readFileSync(prefPath, 'utf8'), before, 'state reads cannot move the scene or rewrite prefs');
    assert.equal(state.context.captureBatches, 0); assert.deepEqual(state.context.deliveries, []);
    assert.deepEqual(state.observed.sends, []); assert.deepEqual(state.observed.resumes, []);
  }
});

test('CTX04 optional prelaunch scene uses real immutable stores and SQLite history, distinct stored IDs, standard prefs, zero runtime work', async t => {
  const fetchSpy = t.mock.method(globalThis, 'fetch', () => assert.fail('No external network'));
  const listenSpy = t.mock.method(net.Server.prototype, 'listen', () => assert.fail('No listener'));
  const transport = setup(t, { sourceChangeSeed: true }), { handler, info } = transport;
  await transport.ready;
  const state = await fixtureState(handler), seed = state.sourceChangeSeed;
  assert.equal(seed.setupOnly, true); assert.equal(seed.synthetic, true); assert.equal(seed.ready, true);
  assert.equal(seed.identities.length, 2);
  assert.deepEqual(seed.counts.seed, { conversations: 2, captures: 2, bindings: 2, packets: 2, deliveryRecords: 2, historyRuns: 2, historyMessages: 4 });
  assert.deepEqual(seed.counts.runtimeAtSetup, { captureBatches: 0, fileCaptureOperations: 0, sends: 0, deliveries: 0 });
  assert.equal(state.context.captureBatches, 0); assert.deepEqual(state.context.deliveries, []);
  assert.deepEqual(state.observed.sends, []); assert.deepEqual(state.runs, []);
  const prefs = {};
  vm.runInNewContext(fs.readFileSync(path.join(info.profile, 'user.js'), 'utf8'), { user_pref: (key, value) => { prefs[key] = value; } });
  const desk = JSON.parse(prefs['egdesk.deskSession.v1']);
  assert.equal(JSON.parse(prefs['egdesk.surfaceLifecycle.v1']).mode, 'desk');
  assert.equal(desk.chat.threads.length, 2); assert.equal(desk.chat.activeThreadId, seed.initialState.activeThreadId);
  assert.equal(desk.cards.length, 1); assert.equal(desk.cards[0].type, 'chat');
  assert.equal(desk.cards[0].id, seed.initialState.chatCardId); assert.equal(seed.initialState.entryBypassed, true);
  assert.equal(prefs['egdesk.agendaState.v1'], undefined, 'no Board seed');
  const list = (await request(handler, 'GET', '/chat/history/threads')).body;
  assert.equal(list.threads.length, 2);
  for (const room of seed.identities) {
    assert.equal(room.answerId, `${room.conversationId}/${room.runId}`);
    const source = room.sources[0];
    const r = { engineId: room.engineId, engineProfileId: room.engineProfileId, clientThreadId: room.clientThreadId,
      conversationId: room.conversationId, sourceId: source.sourceId };
    assert.notEqual(source.selectionId, source.sourceId); assert.equal(source.snapshotId, source.sourceId);
    const history = (await request(handler, 'GET', `/chat/history?clientThreadId=${room.clientThreadId}`)).body;
    assert.equal(history.runs.length, 1); assert.equal(history.messages.length, 2);
    const reference = history.messages.find(m => m.role === 'user').inputReferences[0];
    assert.equal(reference.localSource.id, source.selectionId); assert.equal(reference.sourceId, source.sourceId);
    assert.equal(reference.snapshotId, source.snapshotId); assert.equal(reference.contextScope.conversationId, room.conversationId);
    const readUrl = sourceRoute(r, { packetId: source.packetId }, `/context/captures/${source.sourceId}`);
    const before = (await request(handler, 'GET', readUrl)).body;
    assert.equal(before.source.hash, source.captureHash); assert.equal(before.delivered.hash, source.payloadHash);
    assert.equal(before.delivered.binding.conversationId, room.conversationId);
    assert.equal(before.delivered.binding.answerId, room.answerId);
    assert.equal(history.runs[0].answerId, room.answerId);
    assert.ok(history.messages.every(message => message.answerId === room.answerId));
    if (source.path) fs.writeFileSync(source.path, 'Owned original changed after seed');
    assert.equal((await sourceControl(handler, 'sourceStatus', { ...r, state: 'stale', reason: source.kind === 'file' ? 'fileChanged' : 'navigated', changedAt: 1700000000000 })).status, 200);
    assert.deepEqual((await request(handler, 'GET', readUrl)).body, before);
    assert.equal((await request(handler, 'GET', sourceRoute(r))).body.sources[0].sourceId, source.snapshotId);
    assert.equal((await sourceControl(handler, 'sourceStatusResponse', { ...r, sourceId: source.selectionId, mode: 'error' })).status, 400);
    const snapshot = (await request(handler, 'GET', `/chat/state?conversationId=${room.conversationId}`)).body;
    assert.equal(snapshot.runs[0].runId, room.runId);
    assert.equal((await request(handler, 'POST', '/chat/resume', r)).status, 200);
  }
  assert.equal((await request(handler, 'POST', '/chat/history/import', {})).status, 405);
  for (const route of ['/context/captures', '/chat/send']) assert.equal((await request(handler, 'POST', route, {})).body.code, 'QA_SOURCE_CHANGE_READ_ONLY');
  const final = await fixtureState(handler);
  assert.equal(final.context.captureBatches, 0); assert.equal(final.context.fileCaptureOperations, 0);
  assert.deepEqual(final.context.deliveries, []); assert.deepEqual(final.observed.sends, []);
  assert.equal(fetchSpy.mock.callCount(), 0); assert.equal(listenSpy.mock.callCount(), 0);
  const restart = createQaFixtureTransport({ profile: info.profile, token: TOKEN, env: { ...FIXTURE_ENV,
    EGDESK_QA_CONTEXT_SOURCE_CHANGE_SEED: '1', EGDESK_QA_STATE_FIXTURES: '1', EGDESK_QA_REAL_TURN: '0' } });
  await assert.rejects(restart.ready, /Existing scene|EEXIST/); await restart.dispose();
  assert.equal((await request(handler, 'GET', '/chat/history/threads')).body.threads.length, 2, 'restart cannot duplicate seed');
});

test('CTX04 seeded native message identity keeps both rooms at two messages through history and repeated resume without changing source or sequence', async t => {
  const { handler, info, ready } = setup(t, { sourceChangeSeed: true });
  await ready;
  const initial = await fixtureState(handler), prefs = {};
  vm.runInNewContext(fs.readFileSync(path.join(info.profile, 'user.js'), 'utf8'), { user_pref: (key, value) => { prefs[key] = value; } });
  const desk = JSON.parse(prefs['egdesk.deskSession.v1']);
  const messageIdentity = messages => messages.map(message => Object.fromEntries(
    ['id', 'localMessageId', 'requestId', 'conversationId', 'runId', 'answerId', 'role'].map(key => [key, message[key]])));
  for (const room of initial.sourceChangeSeed.identities) {
    const source = room.sources[0], thread = desk.chat.threads.find(row => row.id === room.clientThreadId);
    assert.deepEqual(thread.messages, [], 'prelaunch prefs never duplicate stored messages');
    const route = { engineId: room.engineId, engineProfileId: room.engineProfileId,
      clientThreadId: room.clientThreadId, conversationId: room.conversationId };
    const historyUrl = `/chat/history?clientThreadId=${room.clientThreadId}`;
    const history = (await request(handler, 'GET', historyUrl)).body;
    const readUrl = sourceRoute({ ...route, sourceId: source.sourceId }, { packetId: source.packetId }, `/context/captures/${source.sourceId}`);
    const original = (await request(handler, 'GET', readUrl)).body;
    assert.equal(original.source.hash, source.captureHash); assert.equal(original.delivered.hash, source.payloadHash);
    let hydrated = hydrateLocalChatThread(thread, normalizeLocalHistoryPage(history, room.clientThreadId));
    assert.equal(hydrated.messages.length, 2);
    const identities = messageIdentity(hydrated.messages), protocol = createChatProtocolState();
    const originalInput = structuredClone(hydrated.messages.find(message => message.role === 'user').inputReferences);
    for (let pass = 0; pass < 2; pass++) {
      const resumed = await request(handler, 'POST', '/chat/resume', route);
      assert.equal(resumed.status, 200);
      // Mirror the existing production history -> snapshot -> non-live sync
      // path unchanged; do not deduplicate by text or add a fixture-only merge.
      for (const run of mergeChatSnapshot(protocol, resumed.body, thread.clientBindingId)) {
        hydrated.messages = mergeLocalChatMessages(hydrated.messages, projectRunMessages(hydrated.messages, run));
      }
      assert.equal(hydrated.messages.length, 2, `${room.title}: no extra assistant after resume ${pass + 1}`);
      assert.equal(hydrated.messages.filter(message => message.role === 'assistant').length, 1);
      assert.deepEqual(messageIdentity(hydrated.messages), identities);
      const user = hydrated.messages.find(message => message.role === 'user');
      const assistant = hydrated.messages.find(message => message.role === 'assistant');
      assert.deepEqual(user.inputReferences, originalInput);
      assert.equal(assistant.contextCaptures.length, 1); assert.equal(assistant.contextPackets.length, 1);
      assert.equal(assistant.contextCaptures[0].sourceId, source.sourceId);
      assert.equal(assistant.contextCaptures[0].hash, source.captureHash);
      assert.equal(assistant.contextPackets[0].packetId, source.packetId);
      assert.equal(assistant.contextPackets[0].hash, source.payloadHash);
      assert.ok(hydrated.messages.every(message => message.providerItemId === message.messageId));
    }
    assert.ok(history.messages.every(message => message.messageId === message.id));
    assert.ok(history.runs[0].messages.every(message => message.messageId === message.id));
    assert.deepEqual((await request(handler, 'GET', historyUrl)).body, history, 'history rows, events and seq are unchanged');
    assert.deepEqual((await request(handler, 'GET', readUrl)).body, original, 'immutable source and delivered payload are unchanged');
  }
  const final = await fixtureState(handler);
  assert.deepEqual(final.sourceChangeSeed, initial.sourceChangeSeed);
  assert.equal(final.context.captureBatches, 0); assert.equal(final.context.fileCaptureOperations, 0);
  assert.deepEqual(final.context.deliveries, []); assert.deepEqual(final.observed.sends, []);
  assert.equal(final.observed.resumes.length, 4);
});

test('Briefing comments seed is exclusive; default/source-change routes stay off and malformed flags cannot seed', async t => {
  for (const options of [{}, { sourceChangeSeed: true }]) {
    const ordinary = setup(t, options); await ordinary.ready;
    const state = await fixtureState(ordinary.handler);
    assert.equal(state.briefingCommentsSeed, undefined); assert.equal(state.briefingComments, undefined);
    assert.equal((await request(ordinary.handler, 'GET', `/context/briefings/${randomUUID()}/comments`)).status, 404);
  }
  const { info } = setup(t);
  const env = { ...FIXTURE_ENV, EGDESK_QA_BRIEFING_COMMENTS_SEED: '1', EGDESK_QA_STATE_FIXTURES: '1', EGDESK_QA_REAL_TURN: '0' };
  for (const patch of [{ EGDESK_QA_BRIEFING_COMMENTS_SEED: 'yes' }, { EGDESK_QA_STATE_FIXTURES: '0' },
    { EGDESK_QA_REAL_TURN: '1' }, { EGDESK_QA_CONTEXT_SOURCE_CHANGE_SEED: '1' }, { EGDESK_QA_CLAUDE_FIXTURE: '1' },
    { EGDESK_QA_PORTABLE_TRANSFER_FIXTURE: '1' }, { EGDESK_QA_PROJECT_FILE_FIXTURE: '1' },
    { EGDESK_QA_RUN_OUTPUTS_FIXTURE: '1' }, { EGDESK_QA_TASK_GATE_FIXTURE: '1' }]) {
    assert.throws(() => createQaFixtureTransport({ profile: info.profile, token: TOKEN, env: { ...env, ...patch } }));
  }
  assert.equal(fs.existsSync(path.join(info.profile, 'qa-fixtures/briefing-comments-seed')), false);
});

test('Briefing comments seed uses real Context records and Chat SQLite with two drafts and one immutable attachment per room', async t => {
  const fetchSpy = t.mock.method(globalThis, 'fetch', () => assert.fail('No network'));
  const listenSpy = t.mock.method(net.Server.prototype, 'listen', () => assert.fail('No listener'));
  const f = await setupComments(t), prefs = {};
  const { ImmutableContextStore } = await import('../helper/egdesk-context-store.mjs');
  const { DatabaseSync } = await import('node:sqlite');
  const store = new ImmutableContextStore({ dataDir: f.seed.storage.dataDir });
  assert.equal(f.seed.setupOnly, true); assert.equal(f.seed.synthetic, true);
  assert.equal(f.seed.storage.comments, 'context-json-records'); assert.equal(f.seed.storage.chat, 'sqlite');
  assert.equal((await f.state()).sourceChangeSeed, null);
  assert.deepEqual(f.seed.counts.seed, { conversations: 2, captures: 2, bindings: 2, packets: 2, deliveryRecords: 2,
    historyRuns: 2, historyMessages: 4, briefings: 2, comments: 0 });
  vm.runInNewContext(fs.readFileSync(path.join(f.info.profile, 'user.js'), 'utf8'), { user_pref: (key, value) => { prefs[key] = value; } });
  const desk = JSON.parse(prefs['egdesk.deskSession.v1']);
  for (const room of f.seed.identities) {
    assert.match(room.briefing.id, /^[0-9a-f-]{36}$/);
    const thread = desk.chat.threads.find(row => row.id === room.clientThreadId);
    assert.ok(room.preservation.draftText.length > 0);
    assert.equal(desk.chat.threadDrafts[thread.id], room.preservation.draftText);
    for (const key of ['inputSources', 'briefingInputs', 'briefingCommentRefs']) assert.deepEqual(thread[key], room.preservation[key]);
    assert.equal(thread.briefingInputs.length, 1); assert.equal(thread.briefingInputs[0].sourceId, room.sources[0].sourceId);
    assert.equal(thread.briefingInputs[0].hash, room.sources[0].captureHash);
    assert.equal(thread.briefingInputs[0].contextScope.conversationId, room.conversationId);
    const record = await store.getRecord('a', 'briefings', room.briefing.id);
    assert.equal(record.conversationId, room.conversationId); assert.equal(record.answerId, room.answerId);
    assert.deepEqual(record.steps.map(step => ({ id: step.id, sourceIds: [step.target.sourceId] })), room.briefing.steps);
    const history = (await f.send('GET', `/chat/history?clientThreadId=${room.clientThreadId}`)).body;
    assert.equal(history.messages.length, 2); assert.equal(history.runs[0].context.briefings[0].id, room.briefing.id);
    assert.deepEqual((await f.send('GET', commentURL(room))).body, { briefingId: room.briefing.id, comments: [] });
  }
  const file = fs.readdirSync(f.seed.storage.dataDir).find(name => name.endsWith('.sqlite'));
  const db = new DatabaseSync(path.join(f.seed.storage.dataDir, file), { readOnly: true });
  try { assert.equal(db.prepare('SELECT COUNT(*) AS n FROM messages').get().n, 4); } finally { db.close(); }
  const beforeReceipts = (await f.state()).briefingComments.receipts.length;
  for (let n = 0; n < 3; n++) {
    const state = await f.state();
    assert.equal(state.briefingComments.receipts.length, beforeReceipts, 'QA inspection never fabricates a production GET');
    assert.equal(state.briefingComments.storeInspection.kind, 'qa-read-only-store');
    assert.equal(state.context.captureBatches, 0); assert.deepEqual(state.observed.sends, []);
  }
  assert.equal(fetchSpy.mock.callCount(), 0); assert.equal(listenSpy.mock.callCount(), 0);
});

test('Briefing comments real handler saves once, normalizes retries, conflicts on changed payload and reopens actual records', async t => {
  const f = await setupComments(t), [a, b] = f.seed.identities, body = commentBody(a, { text: '  QA saved\ncomment  ' });
  const saved = await f.send('POST', commentURL(a), body);
  assert.equal(saved.status, 201); const comment = saved.body.comment;
  assert.equal(comment.text, body.text.trim()); assert.equal(comment.seq, 1);
  assert.equal(comment.clientRequestId, body.clientRequestId); assert.equal(comment.conversationId, a.conversationId);
  assert.equal(comment.requestDigest, undefined); assert.equal(comment.ownerScope, undefined);
  const repeated = await f.send('POST', commentURL(a), { ...body, text: body.text.trim(), sourceIds: [a.sources[0].sourceId, a.sources[0].sourceId] });
  assert.equal(repeated.status, 201); assert.deepEqual(repeated.body.comment, comment);
  const conflict = await f.send('POST', commentURL(a), { ...body, text: 'Different' });
  assert.equal(conflict.status, 409); assert.equal(conflict.body.code, 'BRIEFING_COMMENT_CONFLICT');
  assert.deepEqual((await f.send('GET', commentURL(a))).body.comments, [comment]);
  assert.deepEqual((await f.send('GET', commentURL(b))).body.comments, []);
  const inspection = (await f.state()).briefingComments.storeInspection.briefings.find(row => row.briefingId === a.briefing.id);
  assert.equal(inspection.count, 1); assert.equal(inspection.truncated, false);
  assert.equal(inspection.comments[0].textHash, createHash('sha256').update(comment.text).digest('hex'));
  assert.equal(inspection.comments[0].text, undefined);
  const [{ ImmutableContextStore }, { ContextRuntime }, { createContextHttpHandler }] = await Promise.all([
    import('../helper/egdesk-context-store.mjs'), import('../helper/egdesk-context-runtime.mjs'), import('../helper/egdesk-context-http.mjs')]);
  const store = new ImmutableContextStore({ dataDir: f.seed.storage.dataDir });
  const disk = await store.getRecord('a', 'briefing-comments', comment.id);
  assert.equal(inspection.comments[0].storedHash, createHash('sha256').update(JSON.stringify(disk)).digest('hex'));
  const runtime = new ContextRuntime({ store, getAuthority: hints => ({ ...hints, ownerKey: 'a', epoch: 0 }) });
  const actual = createContextHttpHandler(runtime, async () => {});
  const opened = await request((req, res) => actual(req, res, new URL(req.url, `http://${f.info.host}:${f.info.port}`)), 'GET', commentURL(a));
  assert.equal(opened.status, 200); assert.deepEqual(opened.body.comments, [comment]);
  const final = await f.state();
  assert.deepEqual(final.briefingCommentsSeed, f.seed); assert.deepEqual(final.observed.sends, []);
  assert.equal(final.context.captureBatches, 0); assert.deepEqual(final.context.deliveries, []);
});

test('Briefing comments reject wrong scope, query aliases, other methods and unsupported mutations without a fallback', async t => {
  const f = await setupComments(t), [a, b] = f.seed.identities, body = commentBody(a);
  for (const patch of [{ engineId: 'claude' }, { engineProfileId: 'wrong' }, { clientThreadId: b.clientThreadId },
    { conversationId: b.conversationId }, { ownerKey: 'a' }, { epoch: '0' }]) {
    assert.ok([400, 403].includes((await f.send('POST', commentURL(a, patch), body)).status));
  }
  for (const url of [commentURL(a) + '&engineId=codex', commentURL(a) + '&other=x',
    `/context/briefings/${a.briefing.id}/comments`, commentURL(a).replace('/comments?', '/comments/?'),
    commentURL(a).replace('/comments?', '/%63omments?')]) assert.ok((await f.send('POST', url, body)).status >= 400);
  assert.equal((await f.send('POST', commentURL(b, { briefingId: a.briefing.id }), body)).status, 403);
  assert.equal((await f.send('POST', commentURL(a, { briefingId: randomUUID() }), body)).status, 404);
  for (const method of ['PUT', 'DELETE', 'PATCH']) assert.equal((await f.send(method, commentURL(a), body)).status, 405);
  assert.equal((await f.send('POST', `/context/briefing-comments/${randomUUID()}`, { resolved: true })).status, 404);
  assert.equal((await f.send('OPTIONS', commentURL(a))).status, 204);
  assert.equal((await request(f.handler, 'POST', commentURL(a), body, null, () => {}, {
    host: `127.0.0.1:${f.info.port}`, 'content-type': 'application/json', origin: 'https://example.invalid' })).status, 403);
  await f.send('POST', '/__qa/account-change', { variant: 'b' }, true);
  assert.equal((await f.send('POST', commentURL(a), body)).status, 403);
  assert.equal((await f.state()).briefingComments.storeInspection.briefings.every(row => row.count === 0), true);
});

for (const variants of [['b'], ['b', 'a']]) test(`Briefing comments reject account ${['a', ...variants].join('→')} during POST body receipt before any real save`, async t => {
  const f = await setupComments(t), [a] = f.seed.identities, body = commentBody(a);
  let bodyStarted;
  const started = new Promise(resolve => { bodyStarted = resolve; });
  const response = await request(async (req, res) => {
    const heldBody = Object.assign(new Readable({ read() { bodyStarted(); } }), {
      method: req.method, url: req.url, headers: req.headers, socket: req.socket });
    const pending = f.handler(heldBody, res);
    await started; // Initial authority is captured; the original body has not completed.
    for (const variant of variants) assert.equal((await f.send('POST', '/__qa/account-change', { variant }, true)).status, 200);
    heldBody.push(Buffer.from(JSON.stringify(body))); heldBody.push(null);
    await pending;
  }, 'POST', commentURL(a), null, null, () => {}, {
    host: `${f.info.host}:${f.info.port}`, 'content-type': 'application/json', origin: 'chrome://browser' });
  const state = await f.state();
  assert.equal(state.briefingComments.storeInspection.briefings.every(row => row.count === 0), true, 'Stale original authority must never reach the real save');
  const receipt = state.briefingComments.receipts.find(row => row.clientRequestId === body.clientRequestId);
  assert.ok(receipt); assert.equal(receipt.committedAt, null); assert.equal(receipt.commentId, null); assert.equal(receipt.storedHash, null);
  assert.equal(receipt.account, 'a'); assert.equal(receipt.epoch, 0); assert.deepEqual(receipt.R, commentR(a));
  assert.equal(response.status, 403); assert.equal(response.body.code, 'ACCOUNT_CHANGED');
  assert.equal(receipt.responseStatus, 403); assert.equal(receipt.terminalCause, 'account-change');
  assert.equal(receipt.writeAttempted, true); assert.ok(receipt.finishAt);
  assert.equal(state.context.captureBatches, 0); assert.deepEqual(state.context.deliveries, []); assert.deepEqual(state.observed.sends, []);
});

test('Briefing comments real caps reject oversized bytes, 2001 characters and 7 raw sources without truncation', async t => {
  const f = await setupComments(t), [a] = f.seed.identities, sourceId = a.sources[0].sourceId;
  const good = commentBody(a, { text: 'x'.repeat(2000), sourceIds: Array(6).fill(sourceId) });
  const saved = await f.send('POST', commentURL(a), good);
  assert.equal(saved.status, 201); assert.equal(saved.body.comment.text.length, 2000);
  assert.deepEqual(saved.body.comment.sourceIds, [sourceId]);
  for (const patch of [{ text: 'x'.repeat(2001) }, { text: '😀'.repeat(1001) }, { text: ' ' }, { text: 1 },
    { sourceIds: Array(7).fill(sourceId) }, { sourceIds: [randomUUID()] }, { sourceIds: null },
    { clientRequestId: 'not-a-uuid' }, { extra: true }]) {
    assert.ok((await f.send('POST', commentURL(a), commentBody(a, patch))).status >= 400);
  }
  const tooLarge = await f.send('POST', commentURL(a), commentBody(a, { text: ' '.repeat(17 * 1024) + 'ok' }));
  assert.equal(tooLarge.status, 413); assert.equal(tooLarge.body.code, 'BODY_TOO_LARGE');
  const state = await f.state(), inspection = state.briefingComments.storeInspection.briefings[0];
  assert.equal(inspection.count, 1); assert.deepEqual(state.observed.sends, []); assert.equal(state.context.captureBatches, 0);
});

test('Briefing comments 200-record cap is real, retains exact retry at the cap and bounds terminal receipts to 64', async t => {
  const f = await setupComments(t), [a] = f.seed.identities, first = commentBody(a);
  const original = await f.send('POST', commentURL(a), first); assert.equal(original.status, 201);
  for (let n = 2; n <= 200; n++) {
    const saved = await f.send('POST', commentURL(a), commentBody(a, { text: `QA comment ${n}` }));
    assert.equal(saved.status, 201); assert.equal(saved.body.comment.seq, n);
  }
  const overflow = await f.send('POST', commentURL(a), commentBody(a));
  assert.equal(overflow.status, 409); assert.equal(overflow.body.code, 'BRIEFING_COMMENT_LIMIT');
  const repeat = await f.send('POST', commentURL(a), first);
  assert.equal(repeat.status, 201); assert.deepEqual(repeat.body.comment, original.body.comment);
  assert.equal((await f.send('POST', commentURL(a), { ...first, text: 'different' })).body.code, 'BRIEFING_COMMENT_CONFLICT');
  const listed = await f.send('GET', commentURL(a)); assert.equal(listed.body.comments.length, 200);
  const state = await f.state();
  assert.equal(state.briefingComments.receipts.length, 64);
  assert.equal(state.briefingComments.storeInspection.briefings[0].count, 200);
  assert.equal(state.briefingComments.storeInspection.briefings[0].truncated, false);
});

test('Briefing comments next-POST hold binds once to exact room/Briefing and preserves its saved response across room B work', async t => {
  const f = await setupComments(t), [a, b] = f.seed.identities;
  const armed = await f.arm(a); assert.equal(armed.status, 200);
  assert.equal(armed.body.requestId, null); assert.equal(armed.body.clientRequestId, null);
  await f.send('GET', commentURL(a));
  const bodyB = commentBody(b), savedB = await f.send('POST', commentURL(b), bodyB); assert.equal(savedB.status, 201);
  let state = await f.state();
  const pre = state.briefingComments.receipts.find(row => row.holdId === armed.body.holdId);
  assert.equal(pre.receivedAt, null); assert.equal(pre.clientRequestId, null, 'GET and other room POST cannot consume next-POST arm');
  const bodyA = commentBody(a), pending = f.send('POST', commentURL(a), bodyA);
  const receipt = await waitCommentReceipt(f, row => row.holdId === armed.body.holdId && row.committedAt !== null);
  assert.equal(receipt.clientRequestId, bodyA.clientRequestId); assert.match(receipt.requestId, /^[0-9a-f-]{36}$/);
  assert.deepEqual(receipt.R, commentR(a)); assert.equal(receipt.account, 'a'); assert.equal(receipt.writeAttempted, false);
  assert.equal(receipt.responseFault, null);
  assert.equal(receipt.finishAt, null); assert.equal(receipt.responseStatus, 201);
  state = await f.state();
  const disk = state.briefingComments.storeInspection.briefings.find(row => row.briefingId === a.briefing.id).comments[0];
  assert.equal(disk.id, receipt.commentId); assert.equal(disk.storedHash, receipt.storedHash);
  assert.equal((await f.release(b, receipt)).status, 409);
  assert.equal((await f.release(a, receipt, { clientRequestId: randomUUID() })).status, 409);
  assert.equal((await f.release(a, receipt, { requestId: randomUUID() })).status, 409);
  const release = await f.release(a, receipt); assert.equal(release.status, 200);
  const delivered = await pending; assert.equal(delivered.status, 201); assert.equal(delivered.body.comment.id, disk.id);
  state = await f.state(); const final = state.briefingComments.receipts.find(row => row.requestId === receipt.requestId);
  assert.equal(final.terminalCause, 'finished'); assert.equal(final.writeAttempted, true); assert.ok(final.finishAt);
  assert.equal(final.responseFault, null);
  assert.deepEqual((await f.send('GET', commentURL(b))).body.comments, [savedB.body.comment]);
  assert.equal((await f.release(a, receipt)).body.code, 'QA_COMMENT_ALREADY_RELEASED');
});

test('Briefing comments concurrent same-key POSTs save one row; an old close cannot delete a new same-scope arm', async t => {
  const f = await setupComments(t), [a, b] = f.seed.identities, body = commentBody(a), concurrentBody = commentBody(b);
  const simultaneous = await Promise.all([f.send('POST', commentURL(b), concurrentBody), f.send('POST', commentURL(b), concurrentBody)]);
  assert.equal(simultaneous[0].status, 201); assert.equal(simultaneous[1].status, 201);
  assert.deepEqual(simultaneous[0].body.comment, simultaneous[1].body.comment);
  assert.equal((await f.state()).briefingComments.storeInspection.briefings[1].count, 1);
  const armed = await f.send('POST', '/__qa/briefing-comments/config', { ...commentR(a), clientRequestId: body.clientRequestId,
    mode: 'hold', deadlineAt: Date.now() + 5000 }, true);
  assert.equal(armed.status, 200);
  let oldRes;
  const first = f.send('POST', commentURL(a), body, false, res => { oldRes = res; res.deferFinish = true; res.deferClose = true; });
  const receipt = await waitCommentReceipt(f, row => row.holdId === armed.body.holdId && row.committedAt !== null);
  const second = await f.send('POST', commentURL(a), body);
  assert.equal(second.status, 201); assert.equal(second.body.comment.id, receipt.commentId); assert.equal(second.body.comment.seq, 1);
  assert.equal((await f.state()).briefingComments.storeInspection.briefings[0].count, 1);
  assert.equal((await f.release(a, receipt)).status, 200); assert.equal((await first).status, 201);
  const next = await f.arm(a); assert.equal(next.status, 200);
  oldRes.writableFinished = true; oldRes.emit('finish'); oldRes.emit('close');
  assert.equal((await f.state()).briefingComments.armed[0].holdId, next.body.holdId);
  const nextBody = commentBody(a), nextPending = f.send('POST', commentURL(a), nextBody);
  const nextReceipt = await waitCommentReceipt(f, row => row.holdId === next.body.holdId && row.committedAt !== null);
  assert.equal((await f.release(a, nextReceipt)).status, 200); assert.equal((await nextPending).status, 201);
});

test('Briefing comments committed-response-lost is saved before close; QA inspection is not product recovery GET', async t => {
  const f = await setupComments(t), [a] = f.seed.identities;
  const arm = await f.send('POST', '/__qa/briefing-comments/config', { ...commentR(a), bindNextPost: true, mode: 'committed-response-lost' }, true);
  assert.equal(arm.status, 200);
  const body = commentBody(a), lost = await f.send('POST', commentURL(a), body); assert.equal(lost.status, 0);
  let state = await f.state(), receipt = state.briefingComments.receipts.find(row => row.holdId === arm.body.holdId);
  assert.equal(receipt.terminalCause, 'committed-response-lost'); assert.ok(receipt.committedAt);
  assertPartialCommentResponse(receipt, receipt.committedAt);
  assert.equal(receipt.clientRequestId, body.clientRequestId); assert.equal(receipt.responseStatus, 201);
  const record = state.briefingComments.storeInspection.briefings[0].comments[0];
  assert.equal(record.id, receipt.commentId); assert.equal(record.storedHash, receipt.storedHash);
  for (let n = 0; n < 3; n++) state = await f.state();
  assert.equal(state.briefingComments.receipts.filter(row => row.method === 'GET').length, 0);
  const recovered = await f.send('GET', commentURL(a)); assert.equal(recovered.status, 200);
  assert.equal(recovered.body.comments[0].clientRequestId, body.clientRequestId);
  state = await f.state();
  assert.equal(state.briefingComments.receipts.filter(row => row.method === 'POST').length, 1, 'recovery performs no re-POST');
  const reads = state.briefingComments.receipts.filter(row => row.method === 'GET'); assert.equal(reads.length, 1);
  assert.deepEqual(reads[0].listed, [{ id: record.id, clientRequestId: body.clientRequestId, seq: record.seq }]);
  assert.equal((await f.release(a, receipt)).body.code, 'QA_COMMENT_ALREADY_CLOSED');
  assert.equal(state.context.captureBatches, 0); assert.deepEqual(state.context.deliveries, []); assert.deepEqual(state.observed.sends, []);
});

for (const mode of ['callback-error', 'callback-timeout', 'peer-close', 'account-change']) {
  test(`Briefing comments partial response ${mode} records the actual terminal cause without a false completed cut`, async t => {
    const f = await setupComments(t), [a] = f.seed.identities;
    const arm = await f.send('POST', '/__qa/briefing-comments/config',
      { ...commentR(a), bindNextPost: true, mode: 'committed-response-lost' }, true);
    let callback, response;
    const pending = f.send('POST', commentURL(a), commentBody(a), false, res => {
      response = res;
      res.write = (value, done) => { callback = done;
        if (mode === 'callback-error') done(new Error('unit write failed'));
        return true; };
    });
    await waitCommentReceipt(f, row => row.holdId === arm.body.holdId && Number.isFinite(row.responseFault?.headersFlushedAt));
    if (mode === 'peer-close') response.destroy();
    if (mode === 'account-change') await f.send('POST', '/__qa/account-change', { variant: 'b' }, true);
    await pending;
    if (mode === 'peer-close' || mode === 'account-change') {
      callback(); // A late write callback cannot revive a canceled entry.
      await new Promise(resolve => setTimeout(resolve, 35));
    }
    const state = await f.state(), receipt = state.briefingComments.receipts.find(row => row.holdId === arm.body.holdId);
    assert.equal(receipt.terminalCause, mode === 'peer-close' ? 'peer-close-before-finish'
      : mode === 'account-change' ? 'account-change' : 'write-error');
    assert.ok(receipt.committedAt); assert.equal(receipt.writeAttempted, true);
    assert.equal(receipt.responseFault.writeCompletedAt, null); assert.equal(receipt.responseFault.cutAt, null);
    assert.equal(receipt.endReturnedAt, null); assert.equal(receipt.finishAt, null);
    assert.equal(receipt.writableFinishedAtClose, false);
    assert.equal(state.briefingComments.storeInspection.briefings[0].count, 1);
  });
}

test('Briefing comments control refusal, expiry, peer close, account change and disposal retain distinct terminal receipts', async t => {
  const f = await setupComments(t), [a, b] = f.seed.identities;
  for (const patch of [{ bindNextPost: true, clientRequestId: randomUUID() }, { bindNextPost: false },
    { mode: 'hold', deadlineAt: Date.now() + 31000 }, { mode: 'other' }, { account: 'a' }]) {
    assert.equal((await f.arm(a, patch)).status, 400);
  }
  assert.equal((await f.arm(a, { conversationId: b.conversationId })).status, 403);
  assert.equal((await f.send('POST', '/__qa/briefing-comments/config', { ...commentR(a), mode: 'hold', bindNextPost: true, deadlineAt: Date.now() + 1000 })).status, 403);
  const expired = await f.arm(a, { deadlineAt: Date.now() + 30 }); assert.equal(expired.status, 200);
  await new Promise(resolve => setTimeout(resolve, 60));
  const expiry = (await f.state()).briefingComments.receipts.find(row => row.holdId === expired.body.holdId);
  assert.equal(expiry.terminalCause, 'expiry'); assert.equal(expiry.requestId, null); assert.equal(expiry.committedAt, null);
  await f.arm(a); let res;
  const pending = f.send('POST', commentURL(a), commentBody(a), false, value => { res = value; });
  const peer = await waitCommentReceipt(f, row => row.committedAt !== null && row.terminalCause === null);
  res.destroy(); assert.equal((await pending).status, 0);
  assert.equal((await f.release(a, peer)).body.receipt.terminalCause, 'peer-close-before-finish');
  await f.arm(a); const accountPending = f.send('POST', commentURL(a), commentBody(a));
  const account = await waitCommentReceipt(f, row => row.committedAt !== null && row.terminalCause === null);
  await f.send('POST', '/__qa/account-change', { variant: 'b' }, true); assert.equal((await accountPending).status, 0);
  await f.send('POST', '/__qa/account-change', { variant: 'a' }, true);
  assert.equal((await f.release(a, account)).status, 403);
  assert.equal((await f.state()).briefingComments.receipts.find(row => row.requestId === account.requestId).terminalCause, 'account-change');
  await f.arm(a); const closing = f.send('POST', commentURL(a), commentBody(a));
  await waitCommentReceipt(f, row => row.committedAt !== null && row.terminalCause === null);
  await f.dispose(); assert.equal((await closing).status, 0);
  assert.equal((await f.send('GET', commentURL(a))).status, 503);
});

test('Briefing comments optional recovery GET loss is exact-scoped and manual same-UUID retry deduplicates the saved body', async t => {
  const f = await setupComments(t), [a, b] = f.seed.identities;
  const config = { ...commentR(a), mode: 'committed-response-lost', bindNextPost: true, recoveryGetResponseLostOnce: true };
  const armed = await f.send('POST', '/__qa/briefing-comments/config', config, true);
  assert.equal(armed.status, 200);
  assert.equal((await f.send('GET', commentURL(a))).status, 200, 'GET before committed POST cannot consume recovery loss');
  const body = commentBody(a, { text: '수동 재시도 원문\nunchanged', sourceIds: [a.sources[0].sourceId] });
  assert.equal((await f.send('POST', commentURL(a), body)).status, 0);
  let state = await f.state();
  const post = state.briefingComments.receipts.find(row => row.holdId === armed.body.holdId);
  assert.ok(post.committedAt <= post.recoveryGet.armedAt);
  assert.ok(post.recoveryGet.deadlineAt - post.recoveryGet.armedAt <= 30000);
  assert.equal(post.recoveryGet.requestId, null);
  const saved = state.briefingComments.storeInspection.briefings[0].comments[0];
  assert.equal(saved.textHash, createHash('sha256').update(body.text, 'utf8').digest('hex'));
  assert.equal((await f.send('POST', '/__qa/briefing-comments/config', config, true)).body.code, 'QA_COMMENT_ALREADY_ARMED');
  assert.equal((await f.send('GET', commentURL(b))).status, 200);
  assert.equal((await f.send('GET', commentURL(a, { clientThreadId: b.clientThreadId }))).status, 403);
  for (let n = 0; n < 3; n++) state = await f.state();
  assert.equal(state.briefingComments.receipts.find(row => row.requestId === post.requestId).recoveryGet.requestId, null);
  assert.equal((await f.send('GET', commentURL(a))).status, 0);
  state = await f.state();
  const get = state.briefingComments.receipts.find(row => row.recoveryOf);
  assert.deepEqual(get.R, commentR(a)); assert.equal(get.account, post.account); assert.equal(get.epoch, post.epoch);
  assert.deepEqual(get.recoveryOf, { holdId: post.holdId, requestId: post.requestId, clientRequestId: body.clientRequestId });
  assert.equal(get.responseStatus, 200); assert.ok(get.readCompletedAt);
  assert.deepEqual(get.listed, [{ id: saved.id, clientRequestId: body.clientRequestId, seq: saved.seq }]);
  assert.equal(get.terminalCause, 'recovery-get-response-lost'); assertPartialCommentResponse(get, get.readCompletedAt);
  const parent = state.briefingComments.receipts.find(row => row.requestId === post.requestId);
  assert.equal(parent.recoveryGet.requestId, get.requestId); assert.equal(parent.recoveryGet.terminalCause, get.terminalCause);
  assert.equal(state.briefingComments.receipts.filter(row => row.method === 'POST' && row.receivedAt !== null).length, 1, 'no automatic retry');
  const retry = await f.send('POST', commentURL(a), body); assert.equal(retry.status, 201);
  assert.equal(retry.body.comment.id, saved.id); assert.equal(retry.body.comment.seq, saved.seq);
  assert.equal((await f.send('GET', commentURL(a))).status, 200, 'loss is one-shot');
  state = await f.state();
  assert.deepEqual(state.briefingComments.storeInspection.briefings[0].comments, [saved]);
  assert.equal(state.briefingComments.storeInspection.briefings[1].count, 0);
  assert.equal(state.briefingComments.receipts.filter(row => row.method === 'POST' && row.receivedAt !== null).length, 2);
  assert.equal(state.context.captureBatches, 0); assert.deepEqual(state.context.deliveries, []); assert.deepEqual(state.observed.sends, []);
});

test('Briefing comments recovery GET option rejects invalid controls and requires a committed POST', async t => {
  const f = await setupComments(t), [a] = f.seed.identities;
  for (const value of [true, false, null, 'true', 1]) assert.equal((await f.arm(a, { recoveryGetResponseLostOnce: value })).status, 400);
  const config = { ...commentR(a), mode: 'committed-response-lost', bindNextPost: true };
  for (const value of [null, 'true', 1]) {
    assert.equal((await f.send('POST', '/__qa/briefing-comments/config', { ...config, recoveryGetResponseLostOnce: value }, true)).status, 400);
  }
  await f.send('POST', '/__qa/briefing-comments/config', { ...config, recoveryGetResponseLostOnce: true }, true);
  assert.equal((await f.send('POST', commentURL(a), commentBody(a, { text: '' }))).status, 400);
  assert.equal((await f.send('GET', commentURL(a))).status, 200);
  assert.equal((await f.state()).briefingComments.receipts.some(row => row.recoveryGet || row.recoveryOf), false);
  await f.send('POST', '/__qa/briefing-comments/config', { ...config, recoveryGetResponseLostOnce: false }, true);
  assert.equal((await f.send('POST', commentURL(a), commentBody(a))).status, 0);
  assert.equal((await f.send('GET', commentURL(a))).status, 200, 'explicit false preserves original lost-POST-only behavior');
});

test('Briefing comments recovery GET is once-only under concurrent GETs and expires or cancels on account epoch change', async t => {
  const f = await setupComments(t), [a] = f.seed.identities;
  const arm = async () => {
    const result = await f.send('POST', '/__qa/briefing-comments/config', { ...commentR(a), mode: 'committed-response-lost',
      bindNextPost: true, recoveryGetResponseLostOnce: true }, true);
    assert.equal(result.status, 200);
    assert.equal((await f.send('POST', commentURL(a), commentBody(a))).status, 0);
    return result.body.holdId;
  };
  await arm();
  const concurrent = await Promise.all([f.send('GET', commentURL(a)), f.send('GET', commentURL(a))]);
  assert.deepEqual(concurrent.map(result => result.status).sort(), [0, 200]);
  const expiring = await arm(), future = Date.now() + 31000;
  const clock = t.mock.method(Date, 'now', () => future);
  try { assert.equal((await f.send('GET', commentURL(a))).status, 200); } finally { clock.mock.restore(); }
  let state = await f.state();
  const expired = state.briefingComments.receipts.find(row => row.holdId === expiring);
  assert.equal(expired.recoveryGet.terminalCause, 'expiry'); assert.equal(expired.recoveryGet.requestId, null);
  const changing = await arm();
  await f.send('POST', '/__qa/account-change', { variant: 'b' }, true);
  assert.equal((await f.send('GET', commentURL(a))).status, 403);
  await f.send('POST', '/__qa/account-change', { variant: 'a' }, true);
  assert.equal((await f.send('GET', commentURL(a))).status, 200);
  state = await f.state();
  const changed = state.briefingComments.receipts.find(row => row.holdId === changing);
  assert.equal(changed.recoveryGet.terminalCause, 'account-change'); assert.equal(changed.recoveryGet.requestId, null);
});

test('Briefing comments ephemeral HTTP manual retry after both committed POST and recovery GET response loss keeps one stored record', async t => {
  let handler;
  const server = http.createServer((req, res) => handler(req, res));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const f = await setupComments(t, { fixturePort: server.address().port }); handler = f.handler;
  const [a] = f.seed.identities, base = `http://127.0.0.1:${server.address().port}`;
  const qaHeaders = { 'content-type': 'application/json', 'x-egdesk-qa-token': TOKEN };
  const config = await fetch(base + '/__qa/briefing-comments/config', { method: 'POST', headers: qaHeaders,
    body: JSON.stringify({ ...commentR(a), mode: 'committed-response-lost', bindNextPost: true, recoveryGetResponseLostOnce: true }) });
  assert.equal(config.status, 200); await config.json();
  const body = commentBody(a), postOptions = { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
  const lostPost = await fetch(base + commentURL(a), postOptions);
  assert.equal(lostPost.status, 201); await assert.rejects(lostPost.json());
  const inspect = async () => (await fetch(base + '/__qa/state', { headers: qaHeaders })).json();
  const before = await inspect(), saved = before.briefingComments.storeInspection.briefings[0].comments[0];
  assert.equal(before.briefingComments.receipts.filter(row => row.method === 'GET').length, 0);
  const lostGet = await fetch(base + commentURL(a));
  assert.equal(lostGet.status, 200); await assert.rejects(lostGet.json());
  const lost = await inspect(), get = lost.briefingComments.receipts.find(row => row.method === 'GET');
  assert.equal(get.terminalCause, 'recovery-get-response-lost'); assert.ok(get.readCompletedAt);
  assert.equal(get.responseStatus, 200); assertPartialCommentResponse(get, get.readCompletedAt);
  const post = lost.briefingComments.receipts.find(row => row.method === 'POST');
  assertPartialCommentResponse(post, post.committedAt);
  assert.equal(lost.briefingComments.receipts.filter(row => row.method === 'POST' && row.receivedAt !== null).length, 1);
  const manual = await fetch(base + commentURL(a), postOptions); assert.equal(manual.status, 201);
  const value = await manual.json(); assert.equal(value.comment.id, saved.id); assert.equal(value.comment.seq, saved.seq);
  const after = await inspect(); assert.deepEqual(after.briefingComments.storeInspection.briefings[0].comments, [saved]);
  assert.equal(after.briefingComments.receipts.filter(row => row.method === 'POST' && row.receivedAt !== null).length, 2);
  // Explicit unit client retry; no claim that the product callback or button ran.
});

test('Briefing comments ephemeral HTTP loses only the post-commit response and GET recovers the exact saved UUID without another POST', async t => {
  let handler;
  const server = http.createServer((req, res) => handler(req, res));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const f = await setupComments(t, { fixturePort: server.address().port }); handler = f.handler;
  const [a] = f.seed.identities, base = `http://127.0.0.1:${server.address().port}`;
  const qaHeaders = { 'content-type': 'application/json', 'x-egdesk-qa-token': TOKEN };
  const inspect = async () => {
    const response = await fetch(`${base}/__qa/state`, { headers: qaHeaders });
    assert.equal(response.status, 200); return response.json();
  };
  const config = await fetch(`${base}/__qa/briefing-comments/config`, { method: 'POST', headers: qaHeaders,
    body: JSON.stringify({ ...commentR(a), bindNextPost: true, mode: 'committed-response-lost' }) });
  assert.equal(config.status, 200); const armed = await config.json();
  const body = commentBody(a, { text: 'Native HTTP saved bytes' });
  const lostResponse = await fetch(base + commentURL(a), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal(lostResponse.status, 201);
  const reader = lostResponse.body.getReader(), prefix = await reader.read();
  assert.equal(Buffer.from(prefix.value).toString(), '{');
  assert.ok(Number(lostResponse.headers.get('content-length')) > prefix.value.byteLength);
  await assert.rejects(reader.read());
  const before = await inspect(), receipt = before.briefingComments.receipts.find(row => row.holdId === armed.holdId);
  assert.equal(receipt.terminalCause, 'committed-response-lost'); assert.ok(receipt.committedAt);
  assertPartialCommentResponse(receipt, receipt.committedAt);
  assert.equal(before.briefingComments.receipts.filter(row => row.method === 'GET').length, 0);
  const stored = before.briefingComments.storeInspection.briefings[0].comments[0];
  assert.equal(stored.id, receipt.commentId); assert.equal(stored.clientRequestId, body.clientRequestId);
  assert.equal(stored.textHash, createHash('sha256').update(body.text).digest('hex'));
  const response = await fetch(base + commentURL(a)); assert.equal(response.status, 200);
  assert.equal((await response.json()).comments[0].id, stored.id);
  const after = await inspect();
  assert.equal(after.briefingComments.receipts.filter(row => row.method === 'POST' && row.receivedAt !== null).length, 1);
  const get = after.briefingComments.receipts.find(row => row.method === 'GET');
  assert.deepEqual(get.listed, [{ id: stored.id, clientRequestId: body.clientRequestId, seq: 1 }]);
  assert.equal(get.terminalCause, 'finished'); assert.ok(get.finishAt);
  assert.equal(after.context.captureBatches, 0); assert.deepEqual(after.context.deliveries, []); assert.deepEqual(after.observed.sends, []);
  // This is an ephemeral unit HTTP client, not proof of a product UI callback.
});

for (const recoveryGetResponseLostOnce of [false, true]) {
  test(`Briefing comments real controller sees incomplete HTTP JSON (recovery loss ${recoveryGetResponseLostOnce}) without automatic inclusion or rePOST`, async t => {
    let handler;
    const server = http.createServer((req, res) => handler(req, res));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
    const f = await setupComments(t, { fixturePort: server.address().port }); handler = f.handler;
    const [a] = f.seed.identities, base = `http://127.0.0.1:${server.address().port}`;
    await f.send('POST', '/__qa/briefing-comments/config', { ...commentR(a), bindNextPost: true,
      mode: 'committed-response-lost', recoveryGetResponseLostOnce }, true);
    const storedBriefing = JSON.parse(fs.readFileSync(path.join(f.seed.storage.dataDir, 'context',
      createHash('sha256').update('a').digest('hex'), 'briefings', `${a.briefing.id}.json`), 'utf8'));
    const calls = []; let includes = 0;
    const controller = BriefingState.createBriefingComments({ session: BriefingState.beginBriefing(storedBriefing, {}),
      record: {}, current: () => true, makeId: randomUUID, included: () => false, include: () => { includes++; },
      request: async (method, body) => {
        calls.push(method);
        const response = await fetch(base + commentURL(a), { method, headers: { 'content-type': 'application/json' },
          ...(body ? { body: JSON.stringify(body) } : {}) });
        assert.equal(response.status, method === 'POST' ? 201 : 200);
        return response.json(); // The failure must reach the application body reader.
      } });
    await controller.submit('실제 JSON 읽기 실패 후 저장 복구');
    assert.deepEqual(calls, ['POST', 'GET']); assert.equal(includes, 0);
    assert.equal(controller.view().phase, recoveryGetResponseLostOnce ? 'unknown' : 'saved');
    const before = await f.state(), records = before.briefingComments.storeInspection.briefings[0].comments;
    assert.equal(records.length, 1);
    assert.equal(before.briefingComments.receipts.filter(row => row.method === 'POST' && row.receivedAt !== null).length, 1);
    if (recoveryGetResponseLostOnce) {
      await controller.retry();
      assert.deepEqual(calls, ['POST', 'GET', 'POST']); assert.equal(controller.view().phase, 'saved');
      assert.equal(includes, 0);
      assert.deepEqual((await f.state()).briefingComments.storeInspection.briefings[0].comments, records);
    }
    controller.dispose();
  });
}

test('short Browser fixture URL serves only the canonical document in this marked profile', async t => {
  const { handler, info } = setup(t);
  const document = path.join(info.profile, 'qa-fixtures', 'context-browser-012345abcd.html');
  const html = '<title>QA source</title><pre>same long content lives here</pre>';
  fs.writeFileSync(document, html, { flag: 'wx', mode: 0o600 });
  const loaded = await request(handler, 'GET', '/__qa/browser-document/012345abcd');
  assert.equal(loaded.status, 200);
  assert.equal(loaded.body, html);
  assert.equal((await request(handler, 'GET', '/__qa/browser-document/not-an-id')).status, 404);
  fs.unlinkSync(document); fs.symlinkSync('/etc/hosts', document);
  assert.equal((await request(handler, 'GET', '/__qa/browser-document/012345abcd')).status, 400);
});

test('final fixture GET paginates immutable source bytes without live rereads or claimed delivery', async t => {
  const { handler, info } = setup(t);
  const file = path.join(info.profile, 'qa-fixtures', 'context-original.txt');
  const lines = Array.from({ length: 610 }, (_, index) => `QA_OLD_${index + 1}`);
  const original = lines.join('\n');
  fs.writeFileSync(file, original, { flag: 'wx', mode: 0o600 });
  const body = { clientThreadId: 'wire-A', attachments: [{ ...attachment('file-A', { path: file }),
    content: { mime: 'text/plain', text: 'must not replace actual file bytes', truncated: false } }] };
  const capture = await request(handler, 'POST', '/context/captures', body);
  assert.equal(capture.status, 200);
  assert.equal(assertContextCaptureBatch(body, capture.body), true);
  const ref = capture.body.captures[0];
  assert.equal(ref.hash, fingerprintQaBytes(original).sha256);
  const first = await request(handler, 'GET', `/context/captures/${ref.sourceId}`);
  assert.equal(first.status, 200);
  assert.equal(captureContextReadEvidence(first.body).source.text, lines.slice(0, 200).join('\n'));
  assert.equal(first.body.source.nextLine, 201);
  assert.equal(first.body.delivered, null);
  assert.deepEqual(first.body.bindings, []);
  fs.writeFileSync(file, 'QA_NEW_LIVE_CONTENT\n');
  const page = await request(handler, 'GET', `/context/captures/${ref.sourceId}?startLine=201&endLine=240`);
  assert.equal(captureContextReadEvidence(page.body).source.text, lines.slice(200, 240).join('\n'));
  assert.equal(page.body.source.hash, ref.hash);
  assert.equal(page.body.source.rangeHash, fingerprintQaBytes(lines.slice(200, 240).join('\n')).sha256);
  assert.equal((await request(handler, 'GET', `/context/captures/${ref.sourceId}?startLine=1&endLine=501`)).status, 400);
  assert.equal((await request(handler, 'GET', `/context/captures/${ref.sourceId}?unknown=true`)).status, 400);
  const final = await request(handler, 'GET', `/context/captures/${ref.sourceId}?startLine=601`);
  assert.equal(final.body.source.nextLine, null);
  const stats = (await request(handler, 'GET', '/__qa/state', null, TOKEN)).body;
  assert.equal(stats.context.captureBatches, 1);
  assert.equal(stats.context.fileCaptureOperations, 1);
  assert.equal(stats.context.inspectorReads.length, 3);
  assert.equal(stats.context.deliveries.length, 0);
  assert.equal(stats.observed.sends.length, 0);
});

test('fixture capture rejects out-of-root files and remains isolated across synthetic accounts', async t => {
  const fetchSpy = t.mock.method(globalThis, 'fetch', () => { throw new Error('Fixture must not forward HTTP'); });
  const { handler, info } = setup(t);
  assert.equal((await request(handler, 'POST', '/context/captures', { clientThreadId: 'wire-A', attachments: [attachment('outside', { path: '/etc/hosts' })] })).status, 400);
  const alias = path.join(info.profile, 'qa-fixtures', 'outside-link');
  fs.symlinkSync('/etc/hosts', alias);
  assert.equal((await request(handler, 'POST', '/context/captures', { clientThreadId: 'wire-A', attachments: [attachment('alias', { path: alias })] })).status, 400);
  const body = { clientThreadId: 'wire-A', attachments: [attachment('browser', { url: 'https://example.invalid/qa', viewId: 'qa-browser' }, 'browser', 'Visible QA text'),
    attachment('board', { viewId: 'qa-shape' }, 'board', 'Selected QA Board element')] };
  const result = await request(handler, 'POST', '/context/captures', body);
  assert.equal(assertContextCaptureBatch(body, result.body), true);
  await request(handler, 'POST', '/__qa/account-change', { variant: 'b' }, TOKEN);
  assert.equal((await request(handler, 'GET', `/context/captures/${result.body.captures[0].sourceId}`)).status, 404);
  assert.equal(fetchSpy.mock.callCount(), 0);
});

test('fixture context handoff records separate exact packets and same-answer Briefing only after explicit release', async t => {
  const { handler } = setup(t);
  const body = { clientThreadId: 'wire-A', attachments: [attachment('A', { viewId: 'qa-A' }, 'browser', 'First captured source'),
    attachment('B', { viewId: 'qa-B' }, 'board', 'Second captured source')] };
  const captures = (await request(handler, 'POST', '/context/captures', body)).body.captures;
  const sent = await request(handler, 'POST', '/chat/send', { message: 'EGDESK_QA_CONTEXT unit', profileEnabled: false,
    clientThreadId: 'wire-A', requestId: 'request-A', contextSnapshotIds: captures.map(c => c.sourceId),
    contextCapabilities: { publishBriefing: true, read: true, reader: true } });
  assert.equal(sent.status, 202);
  const identity = sent.body;
  const first = await request(handler, 'GET', `/context/captures/${captures[0].sourceId}`);
  assert.equal(first.body.delivered, null);
  assert.equal(first.body.bindings[0].answerId, identity.answerId);
  assert.equal((await request(handler, 'POST', '/__qa/context-release', { runId: identity.runId, phase: 'read' })).status, 403);
  await request(handler, 'POST', '/__qa/context-release', { runId: identity.runId, phase: 'read' }, TOKEN);
  const state = (await request(handler, 'GET', '/__qa/state', null, TOKEN)).body;
  const observed = state.context.deliveries[0];
  const inspected = captureContextReadEvidence((await request(handler, 'GET', `/context/captures/${captures[0].sourceId}?packetId=${observed.packet.packetId}`)).body);
  assert.equal(assertStoredAgentDelivery(inspected.delivered, { packetId: observed.packet.packetId,
    binding: { conversationId: identity.conversationId, runId: identity.runId, answerId: identity.answerId }, expectedToolText: observed.packet.text }), true);
  assert.notEqual(inspected.source.text, inspected.delivered.text);
  assert.equal(observed.fixtureOnly, true); // Never a real native-tool assertion.
  assert.equal((await request(handler, 'GET', `/context/captures/${captures[0].sourceId}?packetId=missing`)).status, 404);
  await request(handler, 'POST', '/__qa/context-release', { runId: identity.runId, phase: 'briefing' }, TOKEN);
  const run = (await request(handler, 'GET', `/chat/state?conversationId=${identity.conversationId}`)).body.runs[0];
  assert.equal(run.status, 'completed');
  assert.equal(assertPublishedBriefing(run.briefing, { identity, captures }), true);
  assert.equal((await request(handler, 'GET', '/__qa/state', null, TOKEN)).body.observed.sends.length, 1);
});

test('one configured fixture capture failure cannot create a send or silently retry capture', async t => {
  const { handler } = setup(t);
  await request(handler, 'POST', '/__qa/context-config', { failNextCapture: true }, TOKEN);
  const body = { clientThreadId: 'wire-A', attachments: [attachment('A', { viewId: 'qa-A' }, 'browser', 'QA')] };
  assert.equal((await request(handler, 'POST', '/context/captures', body)).status, 503);
  const first = (await request(handler, 'GET', '/__qa/state', null, TOKEN)).body;
  assert.equal(first.context.captureBatches, 0);
  assert.equal(first.observed.contextCaptureFailures, 1);
  assert.equal(first.observed.sends.length, 0);
  assert.equal((await request(handler, 'POST', '/context/captures', body)).status, 200);
  assert.equal((await request(handler, 'GET', '/__qa/state', null, TOKEN)).body.context.captureBatches, 1);
});

test('delayed capture fixture releases only the selected wire thread and never creates a model send', async t => {
  const { handler } = setup(t);
  await request(handler, 'POST', '/__qa/context-config', { holdNextCapture: true }, TOKEN);
  const body = { clientThreadId: 'wire-A', attachments: [attachment('A', { viewId: 'qa-A' }, 'browser', 'QA held')] };
  const pending = request(handler, 'POST', '/context/captures', body);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await request(handler, 'GET', '/__qa/state', null, TOKEN)).body.pendingContextCaptures, 1);
  assert.equal((await request(handler, 'POST', '/__qa/context-release', { phase: 'capture', clientThreadId: 'wire-B' }, TOKEN)).status, 409);
  assert.equal((await request(handler, 'POST', '/__qa/context-release', { phase: 'capture', clientThreadId: 'wire-A' }, TOKEN)).status, 200);
  assert.equal((await pending).status, 200);
  const state = (await request(handler, 'GET', '/__qa/state', null, TOKEN)).body;
  assert.equal(state.pendingContextCaptures, 0);
  assert.equal(state.observed.sends.length, 0);
});

const QUESTION_KEYS = ['questionId', 'header', 'question', 'options', 'allowsOther', 'isSecret'];
const SUBAGENT_KEYS = ['threadId', 'label', 'taskPreview', 'model', 'state', 'message', 'lastTool', 'blocked', 'updatedAt', 'parentEnded'];
const PRIVATE_ANSWER = 'QA-PRIVATE-ANSWER-never-retained-7d1c';
const startUserInput = async handler => (await request(handler, 'POST', '/chat/send', {
  message: 'EGDESK_QA_USER_INPUT unit', clientThreadId: 'question-thread', requestId: 'question-request', profileEnabled: false,
})).body;
const waitFor = async (accept, deadline = Date.now() + 2000) => {
  while (!(await accept())) {
    if (Date.now() > deadline) throw new Error('Fixture state did not change in time');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
};
const conversation = async (handler, id) => (await request(handler, 'GET', `/chat/state?conversationId=${id.conversationId}`)).body;

test('USER_INPUT publishes the public question shape and waits without any automatic reply', async t => {
  const { handler, info } = setup(t);
  assert.equal((await request(handler, 'OPTIONS', '/chat/user-input')).status, 204);
  const capabilities = (await request(handler, 'GET', '/v1/state')).body.capabilities.chat;
  assert.ok(['user-input', 'subagent-status'].every(name => capabilities.includes(name)));
  const id = await startUserInput(handler);
  const run = (await conversation(handler, id)).runs[0];
  assert.equal(run.status, 'running');
  assert.equal(run.pendingUserInputs.length, 1);
  const input = run.pendingUserInputs[0];
  assert.deepEqual(Object.keys(input), ['userInputId', 'kind', 'status', 'itemId', 'isBlocking', 'questions']);
  assert.ok(input.userInputId.startsWith(`input:${info.streamId}:`));
  assert.equal(input.kind, 'userInput');
  assert.equal(input.status, 'pending');
  assert.equal(input.isBlocking, true);
  assert.equal(input.questions.length, 2);
  for (const question of input.questions) assert.deepEqual(Object.keys(question), QUESTION_KEYS);
  const [choice, privateNote] = input.questions;
  assert.equal(choice.options.length, 2);
  assert.ok(choice.options.every(option => Object.keys(option).join() === 'label,description'));
  assert.equal(choice.allowsOther, true);
  assert.equal(choice.isSecret, false);
  assert.equal(privateNote.options, null);
  assert.equal(privateNote.allowsOther, false);
  assert.equal(privateNote.isSecret, true);
  const state = await fixtureState(handler);
  const required = state.observed.events.filter(event => event.event === 'userInput.required');
  assert.equal(required.length, 1);
  assert.deepEqual(required[0].details, input);
  assert.equal(required[0].runId, id.runId);
  assert.equal(required[0].itemId, input.itemId);
  assert.equal(state.observed.userInputs.length, 0);
  assert.equal(state.runs[0].fixtureStage, 'user-input-pending');
  assert.equal((await request(handler, 'POST', '/__qa/release', { runId: id.runId, phase: 'userInput' }, TOKEN)).status, 409);
  assert.equal((await request(handler, 'POST', '/__qa/release', { runId: id.runId, phase: 'run' }, TOKEN)).status, 409);
});

test('USER_INPUT submit validates every answer, then records only shape and keyed digest', async t => {
  const fetchSpy = t.mock.method(globalThis, 'fetch', () => { throw new Error('No real provider or forwarding'); });
  const { handler } = setup(t);
  const id = await startUserInput(handler);
  const input = (await conversation(handler, id)).runs[0].pendingUserInputs[0];
  const reply = { userInputId: input.userInputId, conversationId: id.conversationId, runId: id.runId, action: 'submit' };
  const good = [{ questionId: 'qa_scope', optionIndex: 1 }, { questionId: 'qa_private_note', text: `  ${PRIVATE_ANSWER}  ` }];
  const bodies = [];
  const send = async body => { const value = await request(handler, 'POST', '/chat/user-input', body); bodies.push(value.body); return value; };
  for (const answers of [undefined, [], [good[0]], [...good, good[0]], [good[0], good[0]],
    [good[0], { questionId: 'unknown', text: PRIVATE_ANSWER }], [{ questionId: 'qa_scope', optionIndex: 2 }, good[1]],
    [{ questionId: 'qa_scope', optionIndex: -1 }, good[1]], [{ questionId: 'qa_scope', optionIndex: 0.5 }, good[1]],
    [{ questionId: 'qa_scope', optionIndex: '1' }, good[1]], [{ questionId: 'qa_scope', optionIndex: 0, text: 'both' }, good[1]],
    [{ questionId: 'qa_scope' }, good[1]], [good[0], { questionId: 'qa_private_note', optionIndex: 0 }],
    [good[0], { questionId: 'qa_private_note', text: '   ' }], [good[0], { questionId: 'qa_private_note', text: 'x'.repeat(4001) }],
    [good[0], { questionId: 'qa_private_note', text: `${PRIVATE_ANSWER}\0` }], [good[0], { ...good[1], extra: true }],
    [good[0], { questionId: 'qa_private_note', text: 42 }], [null, good[1]]]) {
    const result = await send({ ...reply, answers });
    assert.equal(result.status, 400, JSON.stringify(answers)?.slice(0, 80));
    assert.equal(result.body.code, 'INVALID_USER_INPUT_ANSWER');
  }
  assert.equal((await send({ ...reply, action: 'accept', answers: good })).status, 400);
  assert.equal((await send({ ...reply, answers: good, clientThreadId: 'unexpected' })).status, 400);
  for (const stale of [{ runId: 'foreign' }, { conversationId: 'foreign' }, { userInputId: `${input.userInputId}:other` }]) {
    const result = await send({ ...reply, answers: good, ...stale });
    assert.equal(result.status, 409);
    assert.equal(result.body.code, 'STALE_USER_INPUT');
  }
  await request(handler, 'POST', '/__qa/auth-refresh', { fail: true }, TOKEN);
  assert.equal((await send({ ...reply, answers: good })).status, 503, 'submit is not a safety response');
  await request(handler, 'POST', '/__qa/auth-refresh', { fail: false }, TOKEN);
  let state = await fixtureState(handler);
  assert.equal(state.observed.userInputs.length, 0);
  assert.equal(state.runs[0].pendingUserInputs[0].status, 'pending');
  const seqBefore = state.seq;
  const accepted = await send({ ...reply, answers: [...good].reverse() });
  assert.equal(accepted.status, 200);
  assert.deepEqual(accepted.body, { accepted: true, userInputId: input.userInputId, conversationId: id.conversationId, runId: id.runId, status: 'replySent' });
  assert.equal((await send({ ...reply, answers: good })).body.code, 'STALE_USER_INPUT');
  assert.equal((await send({ ...reply, action: 'skip' })).status, 409);
  state = await fixtureState(handler);
  assert.ok(state.seq > seqBefore, 'replySent advances the snapshot sequence');
  assert.equal(state.runs[0].status, 'running');
  assert.equal(state.runs[0].pendingUserInputs[0].status, 'replySent');
  assert.equal(state.runs[0].fixtureStage, 'user-input-reply-sent');
  assert.deepEqual(state.observed.userInputs.map(({ repliedAt, ...entry }) => entry), [{
    userInputId: input.userInputId, conversationId: id.conversationId, runId: id.runId, action: 'submit', answers: [
      { questionId: 'qa_scope', isSecret: false, optionIndex: 1, label: '근거 포함' },
      { questionId: 'qa_private_note', isSecret: true, textLength: PRIVATE_ANSWER.length,
        textDigest: createHmac('sha256', TOKEN).update(PRIVATE_ANSWER).digest('hex') },
    ] }]);
  const snapshot = await conversation(handler, id);
  for (const value of [state, snapshot, bodies]) assert.equal(JSON.stringify(value).includes(PRIVATE_ANSWER), false);
  assert.equal(state.observed.events.some(event => JSON.stringify(event).includes('QA-PRIVATE')), false);

  assert.equal((await request(handler, 'POST', '/__qa/release', { runId: id.runId, phase: 'run' }, TOKEN)).status, 409);
  assert.equal((await request(handler, 'POST', '/__qa/release', { runId: id.runId, phase: 'userInput' })).status, 403);
  assert.equal((await request(handler, 'POST', '/__qa/release', { runId: id.runId, phase: 'userInput' }, TOKEN)).status, 200);
  state = await fixtureState(handler);
  const resolved = state.observed.events.filter(event => event.event === 'userInput.resolved');
  assert.deepEqual(resolved.map(event => event.details), [{ userInputId: input.userInputId }]);
  assert.deepEqual(state.runs[0].pendingUserInputs, []);
  assert.equal(state.runs[0].status, 'running', 'resolution is not run completion');
  assert.equal(state.observed.events.filter(event => event.event === 'userInput.required')[0].details.status, 'pending');
  assert.equal((await request(handler, 'POST', '/__qa/release', { runId: id.runId, phase: 'userInput' }, TOKEN)).status, 409);
  assert.equal((await send({ ...reply, answers: good })).status, 409);
  assert.equal((await request(handler, 'POST', '/__qa/release', { runId: id.runId, phase: 'run' }, TOKEN)).status, 200);
  state = await fixtureState(handler);
  const terminal = state.runs[0];
  assert.equal(terminal.status, 'completed');
  assert.equal(terminal.runId, id.runId);
  assert.equal(terminal.messages.find(message => message.role === 'assistant').status, 'completed');
  const order = state.observed.events.filter(event => event.runId === id.runId).map(event => event.event);
  assert.ok(order.indexOf('userInput.resolved') < order.indexOf('message.started'));
  assert.equal(order.at(-1), 'run.completed');
  assert.equal(state.observed.sends.length, 1);
  assert.equal(state.observed.userInputs.length, 1);
  assert.equal(JSON.stringify(state).includes(PRIVATE_ANSWER), false);
  assert.equal(fetchSpy.mock.callCount(), 0);
});

test('USER_INPUT skip is a fail-safe reply that still waits for explicit resolution', async t => {
  const { handler } = setup(t);
  const id = await startUserInput(handler);
  const input = (await conversation(handler, id)).runs[0].pendingUserInputs[0];
  const skip = { userInputId: input.userInputId, conversationId: id.conversationId, runId: id.runId, action: 'skip' };
  assert.equal((await request(handler, 'POST', '/chat/user-input', { ...skip, answers: [{ questionId: 'qa_scope', optionIndex: 0 }] })).status, 400);
  await request(handler, 'POST', '/__qa/auth-refresh', { fail: true }, TOKEN);
  const skipped = await request(handler, 'POST', '/chat/user-input', skip);
  assert.equal(skipped.status, 200);
  assert.equal(skipped.body.status, 'replySent');
  assert.equal((await request(handler, 'POST', '/chat/user-input', skip)).status, 409);
  let state = await fixtureState(handler);
  assert.deepEqual(state.observed.userInputs.map(entry => [entry.action, entry.answers]), [['skip', []]]);
  assert.equal(state.runs[0].status, 'running');
  await request(handler, 'POST', '/__qa/release', { runId: id.runId, phase: 'userInput' }, TOKEN);
  await request(handler, 'POST', '/__qa/release', { runId: id.runId, phase: 'run' }, TOKEN);
  state = await fixtureState(handler);
  assert.equal(state.runs[0].status, 'completed');
  assert.deepEqual(state.runs[0].pendingUserInputs, []);
});

test('USER_INPUT stop and offline paths never accept an answer for an ended or unreachable run', async t => {
  const { handler } = setup(t);
  const id = await startUserInput(handler);
  const input = (await conversation(handler, id)).runs[0].pendingUserInputs[0];
  const reply = { userInputId: input.userInputId, conversationId: id.conversationId, runId: id.runId, action: 'skip' };
  assert.equal((await request(handler, 'POST', '/chat/interrupt', { conversationId: id.conversationId, runId: id.runId })).status, 202);
  assert.equal((await request(handler, 'POST', '/__qa/release', { runId: id.runId, phase: 'run' }, TOKEN)).status, 200);
  const state = await fixtureState(handler);
  assert.equal(state.runs[0].status, 'interrupted');
  assert.deepEqual(state.runs[0].pendingUserInputs, []);
  assert.equal(state.observed.events.some(event => event.event === 'message.started' && event.runId === id.runId), false);
  assert.equal((await request(handler, 'POST', '/chat/user-input', reply)).body.code, 'STALE_USER_INPUT');
  const lost = await request(handler, 'POST', '/chat/send', { message: 'EGDESK_QA_LOST unit', profileEnabled: false });
  await waitFor(async () => (await conversation(handler, lost.body)).connection === 'offline');
  const offline = await request(handler, 'POST', '/chat/user-input', reply);
  assert.equal(offline.status, 503);
  assert.equal(offline.body.code, 'BRIDGE_OFFLINE');
  assert.equal((await fixtureState(handler)).observed.userInputs.length, 0);
});

test('SUBAGENT publishes bounded sub-agent rows with blocked reasons and never a run per child thread', async t => {
  const { handler } = setup(t);
  const sent = await request(handler, 'POST', '/chat/send', { message: 'EGDESK_QA_SUBAGENT unit',
    clientThreadId: 'subagent-thread', requestId: 'subagent-request', profileEnabled: false });
  assert.equal(sent.status, 202);
  const id = sent.body;
  let state = await fixtureState(handler);
  assert.equal(state.runs.length, 1, 'child threads never become EG-Desk runs');
  let run = state.runs[0];
  assert.equal(run.fixtureStage, 'subagents-visible');
  assert.equal(run.subAgents.length, 3);
  for (const row of run.subAgents) {
    assert.deepEqual(Object.keys(row), SUBAGENT_KEYS);
    assert.ok(row.taskPreview.length <= 160);
    assert.equal(row.parentEnded, false);
  }
  const [done, errored, waiting] = run.subAgents;
  assert.deepEqual([done.label, done.state, done.blocked], ['researcher', 'running', null]);
  assert.deepEqual([errored.label, errored.state, errored.blocked], [null, 'errored', { reason: 'errored' }]);
  assert.ok(errored.message.length <= 500);
  assert.deepEqual([waiting.label, waiting.state, waiting.blocked], ['reviewer', 'running', { reason: 'approvalRequested' }]);
  const updates = state.observed.events.filter(event => event.event === 'subagent.updated');
  assert.equal(updates.length, 5);
  for (const update of updates) assert.deepEqual(Object.keys(update.details), ['subAgent']);
  for (const row of run.subAgents) assert.deepEqual(updates.findLast(update => update.details.subAgent.threadId === row.threadId).details.subAgent, row);
  assert.equal(updates.find(update => update.details.subAgent.threadId === errored.threadId).details.subAgent.state, 'starting');
  const collab = run.activities.find(activity => activity.kind === 'collabAgentToolCall');
  assert.deepEqual(collab.detail, { tool: 'spawnAgent', status: 'inProgress', receiverCount: 3 });
  assert.equal(JSON.stringify(run.activities).includes('prompt'), false);
  assert.equal(run.activities.filter(activity => activity.kind !== 'collabAgentToolCall').length, 1);
  assert.deepEqual(run.pendingUserInputs, []);
  assert.equal((await request(handler, 'POST', '/__qa/release', { runId: id.runId, phase: 'run' }, TOKEN)).status, 409);
  assert.equal((await request(handler, 'POST', '/__qa/release', { runId: id.runId, phase: 'subagent' }, TOKEN)).status, 200);
  assert.equal((await request(handler, 'POST', '/__qa/release', { runId: id.runId, phase: 'subagent' }, TOKEN)).status, 409);
  run = (await conversation(handler, id)).runs[0];
  assert.deepEqual(run.subAgents.map(row => [row.state, row.blocked?.reason || null]),
    [['completed', null], ['errored', 'errored'], ['running', 'approvalRequested']]);
  assert.equal(run.activities.find(activity => activity.kind === 'collabAgentToolCall').status, 'completed');
  assert.equal(run.status, 'running');
  assert.equal((await request(handler, 'POST', '/__qa/release', { runId: id.runId, phase: 'run' }, TOKEN)).status, 200);
  state = await fixtureState(handler);
  run = state.runs[0];
  assert.equal(run.status, 'completed');
  assert.ok(run.subAgents.every(row => row.parentEnded));
  assert.ok(run.activities.every(activity => activity.status === 'completed'));
  assert.equal(run.messages.some(message => message.role === 'assistant'), false, 'sub-agent status never becomes a chat message');
  assert.equal(state.observed.events.filter(event => event.event === 'subagent.updated').length, 9);
  assert.equal(state.observed.sends.length, 1);
  assert.equal((await request(handler, 'POST', '/chat/user-input', { userInputId: 'input:none', conversationId: id.conversationId,
    runId: id.runId, action: 'skip' })).status, 409);
});
