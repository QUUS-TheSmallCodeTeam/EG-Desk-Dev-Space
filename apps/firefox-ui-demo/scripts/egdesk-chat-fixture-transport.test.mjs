import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHmac } from 'node:crypto';
import path from 'node:path';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import vm from 'node:vm';
import { bootstrapQaProfile, canonicalTempRoot, LOADER_FILES } from './egdesk-chat-qa-profile.mjs';
import { createQaFixtureTransport, CLAUDE_FIXTURE_QUESTIONS, CLAUDE_FIXTURE_TEXT } from './egdesk-chat-fixture-transport.mjs';
import { chatRunOutputFixtureIds, CHAT_RUN_OUTPUT_MARKER, CHAT_RUN_DIFF_MARKER } from './egdesk-chat-run-outputs-fixture.mjs';
import { prepareQaFirefox } from './run-firefox-mcp-target.mjs';
import { assertNativeTerminalExit, assertQaFixtureArtifact } from './egdesk-chat-qa-contract.sys.mjs';
import { createChatProtocolState, mergeChatSnapshot, projectRunMessages, usableArtifact } from '../overlay/resources/EGDeskChatState.sys.mjs';
import { assertPublishedBriefing, assertContextCaptureBatch, assertStoredAgentDelivery,
  captureContextReadEvidence, fingerprintQaBytes } from './egdesk-context-qa-contract.mjs';

const TOKEN = 'unit-fixture-token-no-credentials';
const FIXTURE_ENV = { EGDESK_QA_FIXTURE_TRANSPORT: '1', EGDESK_QA_FIXTURE_PORT: '49318' };

function setup(t, { claude = false, reader = false, projectFile = false, runOutputs = false } = {}) {
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
  const fixtureEnv = { ...FIXTURE_ENV, ...(projectFile ? { EGDESK_QA_PROJECT_FILE_FIXTURE: '1', EGDESK_QA_REAL_TURN: '0' } : {}),
    ...(runOutputs ? { EGDESK_QA_RUN_OUTPUTS_FIXTURE: '1', EGDESK_QA_REAL_TURN: '0' } : {}) };
  prepareQaFirefox(profile, { env: fixtureEnv });
  const transport = createQaFixtureTransport({ profile, token: TOKEN,
    env: { ...fixtureEnv, ...(claude ? { EGDESK_QA_CLAUDE_FIXTURE: '1' } : {}),
      ...(reader ? { EGDESK_QA_CLAUDE_READER_FIXTURE: '1', EGDESK_QA_REAL_TURN: '0' } : {}) } });
  t.after(() => transport.dispose());
  assert.equal(globalThis.fetch, fetchBefore);
  assert.equal(globalThis.EventSource, eventSourceBefore);
  return transport;
}

async function request(handler, method, url, body = null, token = null, onResponse = () => {}, extraHeaders = {}) {
  const req = Readable.from(body === null ? [] : [JSON.stringify(body)]);
  Object.assign(req, { method, url, headers: { ...(token ? { 'x-egdesk-qa-token': token } : {}), ...extraHeaders } });
  let status;
  let headers = {};
  let resolve;
  const completed = new Promise((done) => { resolve = done; });
  const res = Object.assign(new EventEmitter(), {
    writeHead(value, nextHeaders = {}) { status = value; headers = nextHeaders; },
    end(value = '') { this.writableEnded = true; resolve({ status, body: value ? (/application\/json/.test(headers['Content-Type'] || '') ? JSON.parse(value) : value) : null }); this.emit('close'); },
    destroy() { this.destroyed = true; this.emit('close'); resolve({ status: 0, body: null }); },
    write() { return true; },
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
