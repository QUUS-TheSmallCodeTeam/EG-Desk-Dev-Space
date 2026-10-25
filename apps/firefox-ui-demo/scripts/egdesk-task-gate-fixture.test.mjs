import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import childProcess from 'node:child_process';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { DatabaseSync } from 'node:sqlite';
import { createTaskGateFixture, taskGateFixtureEnabled, TASK_GATE_SEED_MESSAGE, TASK_GATE_STATE_ROUTE, TASK_GATE_CONTROL_ROUTE } from './egdesk-task-gate-fixture.mjs';
import { bootstrapQaProfile, canonicalTempRoot, LOADER_FILES } from './egdesk-chat-qa-profile.mjs';
import { createPrivateQaTempDirectory } from './egdesk-qa-platform.mjs';

const TOKEN = 'owned-task-gate-unit-token';
const ENV = { EGDESK_QA_TASK_GATE_FIXTURE: '1', EGDESK_QA_FIXTURE_TRANSPORT: '1', EGDESK_QA_REAL_TURN: '0', EGDESK_QA_FIXTURE_PORT: '49319' };
const hash = value => createHash('sha256').update(value).digest('hex');
const settle = () => new Promise(resolve => setImmediate(resolve));
async function until(read, predicate, label) {
  for (let i = 0; i < 100; i++) { const value = read(); if (predicate(value)) return value; await settle(); }
  assert.fail(label);
}
async function setup(t) {
  const loader = createPrivateQaTempDirectory('egdesk-task-loader-');
  for (const name of LOADER_FILES) fs.writeFileSync(path.join(loader, name), `unit loader ${name}\n`, { mode: 0o600 });
  const { profile } = bootstrapQaProfile({ loaderSource: loader });
  const forwarded = [];
  const fixture = await createTaskGateFixture({ profile, token: TOKEN, env: ENV, broadcast: frame => forwarded.push(structuredClone(frame)) });
  const root = fixture.snapshot().root;
  t.after(async () => {
    await fixture.dispose();
    for (const [directory, prefix] of [[root, 'egdesk-task-gate-'], [profile, 'egdesk-chat-test-'], [loader, 'egdesk-task-loader-']]) {
      assert.equal(path.dirname(directory), canonicalTempRoot()); assert.equal(fs.realpathSync.native(directory), directory);
      assert.ok(path.basename(directory).startsWith(prefix)); fs.rmSync(directory, { recursive: true });
    }
  });
  return { fixture, profile, forwarded };
}
async function request(fixture, method, route, body, options = {}) {
  const bytes = body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))];
  const req = Object.assign(Readable.from(bytes), { method, url: route, socket: { remoteAddress: options.remoteAddress || '127.0.0.1' },
    headers: { host: '127.0.0.1:49319', ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(options.token ? { 'x-egdesk-qa-token': TOKEN } : {}), ...options.headers } });
  let status, text, endings = 0; const headers = {};
  const res = { setHeader(key, value) { headers[key] = value; }, writeHead(value, values) { status = value; Object.assign(headers, values); },
    end(value) { text = String(value); endings++; } };
  const handled = await fixture.handle(req, res, options.suppliedUrl);
  assert.ok(endings <= 1, 'never substitute a second fake response for a production receipt');
  return { handled, status, body: text ? JSON.parse(text) : undefined, headers };
}
const control = (fixture, action) => request(fixture, 'POST', TASK_GATE_CONTROL_ROUTE, { action }, { token: true });
const seed = fixture => request(fixture, 'POST', '/chat/send', { message: TASK_GATE_SEED_MESSAGE,
  clientThreadId: 'qa-original-local-binding', requestId: 'qa-original-request', profileEnabled: false });
function bodyFor(state, taskId, gateId, answer, index = 0) {
  const plan = state.plans[index];
  return { boardId: plan.boardId, scope: plan.scope, taskId, gateId, answer };
}

test('strict opt-in, REAL_TURN=0, exclusive modes, nonproduction port, profile and token precede filesystem effects', async t => {
  const { profile } = await setup(t);
  const mkdir = t.mock.method(fs, 'mkdtempSync', () => assert.fail('validation must precede directory creation'));
  try {
    for (const env of [{}, { ...ENV, EGDESK_QA_TASK_GATE_FIXTURE: '0' }, { ...ENV, EGDESK_QA_TASK_GATE_FIXTURE: 'true' },
      { ...ENV, EGDESK_QA_REAL_TURN: '1' }, { ...ENV, EGDESK_QA_REAL_TURN: undefined }, { ...ENV, EGDESK_QA_FIXTURE_TRANSPORT: '0' },
      ...['39218', '65536', undefined].map(port => ({ ...ENV, EGDESK_QA_FIXTURE_PORT: port })),
      ...['EGDESK_QA_PORTABLE_TRANSFER_FIXTURE', 'EGDESK_QA_PROJECT_FILE_FIXTURE', 'EGDESK_QA_RUN_OUTPUTS_FIXTURE', 'EGDESK_QA_CLAUDE_FIXTURE',
        'EGDESK_QA_READER_FIXTURE', 'EGDESK_QA_BROWSER_RELAY', 'EGDESK_QA_BROWSER_NEGATIVE'].map(key => ({ ...ENV, [key]: '1' }))]) {
      await assert.rejects(createTaskGateFixture({ profile, token: TOKEN, env }));
    }
    await assert.rejects(createTaskGateFixture({ profile, token: 'short', env: ENV }));
    await assert.rejects(createTaskGateFixture({ profile: path.dirname(profile), token: TOKEN, env: ENV }));
    await assert.rejects(createTaskGateFixture({ profile, token: TOKEN, env: { ...ENV, EGDESK_QA_FIXTURE_TOKEN: 'other' } }));
    assert.equal(mkdir.mock.callCount(), 0);
  } finally { mkdir.mock.restore(); }
  assert.equal(taskGateFixtureEnabled({}), false); assert.equal(taskGateFixtureEnabled(ENV), true);
});

test('import/factory start no listener/provider/process; actual private workflow SQLite is initially empty', async t => {
  const spies = [t.mock.method(net.Server.prototype, 'listen', () => assert.fail('no listener')),
    t.mock.method(net.Socket.prototype, 'connect', () => assert.fail('no outbound socket')),
    t.mock.method(globalThis, 'fetch', () => assert.fail('no external provider request')),
    ...['spawn', 'spawnSync', 'execFile', 'execFileSync'].map(name => t.mock.method(childProcess, name, () => assert.fail('no process')))];
  await import(`./egdesk-task-gate-fixture.mjs?inert=${Date.now()}`);
  const { fixture } = await setup(t), state = fixture.snapshot();
  assert.deepEqual(Object.keys(fixture).sort(), ['dispose', 'handle', 'snapshot']);
  assert.deepEqual([state.providerTurns, state.nativeProcessSpawns, state.nativeUiVerified], [0, 0, false]);
  assert.equal(state.fakeProviderTurns.length, 0); assert.equal(state.persisted.journalCount, 0);
  assert.equal(fs.statSync(state.database).mode & 0o777, 0o600);
  assert.ok(state.database.startsWith(state.root + path.sep));
  for (const spy of spies) assert.equal(spy.mock.callCount(), 0);
});

test('seed refuses profile/context/provider overrides without a turn; invalid continuation JSON is parsed by production', async t => {
  const { fixture } = await setup(t);
  for (const patch of [{ profileEnabled: true }, { engineId: 'claude' }, { cwd: '/user-work' }, { selectedSources: ['source'] },
    { contextSnapshotIds: ['context'] }, { attachments: [{}] }, { agentProfile: {} }, { systemPrompt: 'override' }, { toolMode: 'tools' }]) {
    const result = await request(fixture, 'POST', '/chat/send', { message: TASK_GATE_SEED_MESSAGE,
      clientThreadId: 'qa-original-local-binding', requestId: 'qa-original-request', profileEnabled: false, ...patch });
    assert.deepEqual([result.status, result.body.code], [403, 'QA_SEED_ONLY']);
    assert.equal(fixture.snapshot().fakeProviderTurns.length, 0);
  }
  const malformed = await request(fixture, 'POST', '/tasks/continue', '{');
  assert.equal(malformed.status, 400);
  assert.equal(fixture.snapshot().requests.at(-1).delegated, true);
  assert.equal(fixture.snapshot().persisted.journalCount, 0);
  assert.equal((await seed(fixture)).status, 202, 'a refused setup does not consume the sole valid seed');
});

test('native seed route delegates real Chat and seeds a real approved plan waiting on choices in the exact original thread', async t => {
  const { fixture, forwarded } = await setup(t), result = await seed(fixture), state = fixture.snapshot();
  assert.equal(result.status, 202); assert.equal(result.body.accepted, true);
  assert.equal(state.original.conversationId, result.body.conversationId); assert.equal(state.original.runId, result.body.runId);
  assert.equal(state.original.clientThreadId, 'qa-original-local-binding');
  assert.equal(state.plans.length, 1); assert.equal(state.plans[0].origin.conversationId, state.original.conversationId);
  assert.equal(state.fakeProviderTurns.length, 1); assert.equal(state.fakeProviderTurns[0].completed, true);
  assert.ok(state.persisted.journalCount > 0); assert.ok(state.persisted.records.some(row => row.kind === 'plan' && row.count === 1));
  const response = await request(fixture, 'GET', `/tasks/state?graphId=${state.plans[0].graphId}`);
  assert.equal(response.status, 200); assert.equal(response.body.graph.activated, true);
  const gate = response.body.graph.tasks.find(value => value.taskId === 'send').gates.find(value => value.gateId === 'how');
  assert.deepEqual(gate.response.options.map(value => value.id), ['email', 'kakao']); assert.equal(gate.status, 'waiting');
  assert.ok(forwarded.some(frame => frame.type === 'task.graph' && frame.graphId === state.plans[0].graphId));
  assert.ok(forwarded.some(frame => frame.type === 'chat.event' && frame.clientThreadId === state.original.clientThreadId));
  assert.equal((await seed(fixture)).status, 403, 'no accidental second original room');
});

test('real continue accepts one choice, resumes only original conversation, and duplicate gets real stale response', async t => {
  const { fixture } = await setup(t); await seed(fixture);
  const before = fixture.snapshot(), body = bodyFor(before, 'send', 'how', { choice: 'kakao' });
  const result = await request(fixture, 'POST', '/tasks/continue', body);
  assert.equal(result.status, 200);
  const resumed = await until(() => fixture.snapshot(), value => value.fakeProviderTurns.length === 2, 'fake resume turn');
  assert.equal(resumed.fakeProviderTurns[1].conversationId, before.original.conversationId);
  assert.equal(resumed.fakeProviderTurns[1].hasAnswers, true);
  assert.equal(resumed.graphs[0].tasks.find(value => value.taskId === 'send').gates.find(value => value.gateId === 'how').status, 'satisfied');
  const duplicate = await request(fixture, 'POST', '/tasks/continue', body);
  assert.deepEqual([duplicate.status, duplicate.body.code], [409, 'TASK_GATE_STALE']);
  assert.equal(fixture.snapshot().fakeProviderTurns.length, 2);
  assert.equal((await control(fixture, 'complete-turn')).status, 200);
});

test('real private/invalid text rejection persists nothing; accepted code-point boundary is stored exactly and kept out of public SSE', async t => {
  const { fixture } = await setup(t); await seed(fixture);
  await request(fixture, 'POST', '/tasks/continue', bodyFor(fixture.snapshot(), 'send', 'how', { choice: 'email' }));
  await until(() => fixture.snapshot(), state => state.fakeProviderTurns.length === 2, 'first resumed turn');
  await control(fixture, 'complete-turn');
  for (const [answer, code] of [[{ text: 'pw: hunter2' }, 'TASK_GATE_ANSWER_PRIVATE'], [{ text: '😀'.repeat(21) }, 'TASK_GATE_ANSWER'],
    [{ text: '  ' }, 'TASK_GATE_ANSWER'], [{ choice: 'email' }, 'TASK_GATE_ANSWER']]) {
    const result = await request(fixture, 'POST', '/tasks/continue', bodyFor(fixture.snapshot(), 'note', 'memo', answer));
    assert.deepEqual([result.status, result.body.code], [400, code]);
    assert.equal(fixture.snapshot().persisted.answers.length, 0);
  }
  const text = '😀'.repeat(20), accepted = await request(fixture, 'POST', '/tasks/continue', bodyFor(fixture.snapshot(), 'note', 'memo', { text: ` ${text}\r\n ` }));
  assert.equal(accepted.status, 200);
  const state = await until(() => fixture.snapshot(), value => value.fakeProviderTurns.length === 3, 'second resumed turn');
  assert.deepEqual(state.persisted.answers.map(value => [value.codePoints, value.textSha256]), [[20, hash(text)]]);
  assert.equal(state.fakeProviderTurns[2].conversationId, state.original.conversationId);
  assert.equal(JSON.stringify(state.frames).includes(text), false); assert.equal(JSON.stringify(state).includes('hunter2'), false);
  const db = new DatabaseSync(state.database, { readOnly: true });
  try {
    const records = db.prepare('SELECT record_json FROM records').all().map(row => row.record_json).join('');
    assert.equal(records.includes('hunter2'), false); assert.ok(records.includes(text));
    assert.equal(db.prepare('SELECT event_json FROM task_events').all().some(row => row.event_json.includes(text)), false);
  } finally { db.close(); }
});

test('replay uses a captured real task.graph; next question has new graph/gate identity on the original conversation', async t => {
  const { fixture, forwarded } = await setup(t); await seed(fixture);
  const before = fixture.snapshot(), frame = before.frames.findLast(value => value.type === 'task.graph');
  assert.equal((await control(fixture, 'replay')).status, 200);
  assert.deepEqual(forwarded.at(-1), frame);
  assert.equal((await control(fixture, 'next-question')).status, 200);
  const after = fixture.snapshot();
  assert.notEqual(after.plans[1].graphId, after.plans[0].graphId);
  assert.equal(after.plans[1].origin.conversationId, before.original.conversationId);
  assert.deepEqual(after.plans[1].questions[0].response, { kind: 'text', maxLength: 8 });
  assert.equal(after.plans[1].questions[0].gateId, 'next-memo');
  assert.equal((await control(fixture, 'next-question')).status, 409);
});

test('refresh forwards the exact production task.native hint, and both real question sets remain independently answerable', async t => {
  const { fixture, forwarded } = await setup(t); await seed(fixture);
  await request(fixture, 'POST', '/tasks/continue', bodyFor(fixture.snapshot(), 'send', 'how', { choice: 'email' }));
  await until(() => fixture.snapshot(), value => value.fakeProviderTurns.length === 2, 'choice continuation');
  await control(fixture, 'complete-turn');
  const rejected = await request(fixture, 'POST', '/tasks/continue', bodyFor(fixture.snapshot(), 'note', 'memo', { text: 'pw: hunter2' }));
  assert.equal(rejected.body.code, 'TASK_GATE_ANSWER_PRIVATE');
  for (let i = 0; i < 100 && !fixture.snapshot().frames.some(frame => frame.type === 'task.native'); i++) {
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  const hint = fixture.snapshot().frames.findLast(frame => frame.type === 'task.native');
  assert.ok(hint, 'real runtime coalesces a task refresh hint');
  assert.equal((await control(fixture, 'refresh')).status, 200); assert.deepEqual(forwarded.at(-1), hint);
  assert.equal((await control(fixture, 'next-question')).status, 200);
  assert.equal((await request(fixture, 'POST', '/tasks/continue', bodyFor(fixture.snapshot(), 'note', 'memo', { text: '😀'.repeat(20) }))).status, 200);
  await until(() => fixture.snapshot(), value => value.fakeProviderTurns.length === 3, 'original text continuation');
  await control(fixture, 'complete-turn');
  assert.equal((await request(fixture, 'POST', '/tasks/continue', bodyFor(fixture.snapshot(), 'next-note', 'next-memo', { text: '다음 답변' }, 1))).status, 200);
  const final = await until(() => fixture.snapshot(), value => value.fakeProviderTurns.length === 4, 'new question continuation');
  assert.equal(final.persisted.answers.length, 2);
  assert.ok(final.fakeProviderTurns.every(turn => turn.conversationId === final.original.conversationId));
  assert.equal(final.providerTurns, 0);
});

test('held real UI request races an actual backend acceptance then receives actual TASK_GATE_STALE, not a fake handler packet', async t => {
  const { fixture } = await setup(t); await seed(fixture);
  assert.equal((await control(fixture, 'hold-next')).status, 200);
  const body = bodyFor(fixture.snapshot(), 'send', 'how', { choice: 'email' });
  const pending = request(fixture, 'POST', '/tasks/continue', body);
  await until(() => fixture.snapshot(), state => state.held !== null, 'held incoming continue');
  assert.equal(fixture.snapshot().requests.at(-1).delegated, false);
  assert.equal((await control(fixture, 'accept-held')).status, 200);
  assert.equal((await control(fixture, 'release')).status, 200);
  const result = await pending;
  assert.deepEqual([result.status, result.body.code], [409, 'TASK_GATE_STALE']);
  assert.equal(fixture.snapshot().requests.at(-1).delegated, true);
  assert.equal(fixture.snapshot().pauseBroadcast, true);
  assert.equal((await control(fixture, 'flush')).status, 200);
  assert.equal(fixture.snapshot().queuedFrames, 0);
});

test('fixture state/control require token and loopback, foreign task scope and out-of-scope writes cannot execute', async t => {
  const { fixture } = await setup(t);
  assert.equal((await request(fixture, 'GET', TASK_GATE_STATE_ROUTE)).status, 403);
  assert.equal((await request(fixture, 'GET', TASK_GATE_STATE_ROUTE, undefined, { token: true, remoteAddress: '192.0.2.1' })).status, 403);
  assert.equal((await request(fixture, 'GET', TASK_GATE_STATE_ROUTE, undefined, { token: true, suppliedUrl: new URL('http://127.0.0.1:49319/wrong') })).status, 403);
  for (const route of ['/tasks/submit', '/tasks/activate', '/tasks/cancel', '/task-sources', '/terminal/spawn', '/provider/run']) {
    assert.equal((await request(fixture, 'POST', route, {})).status, 403);
  }
  await seed(fixture);
  const body = bodyFor(fixture.snapshot(), 'send', 'how', { choice: 'email' });
  assert.equal((await request(fixture, 'POST', '/tasks/continue', { ...body, boardId: 'foreign' })).status, 409);
  assert.equal(fixture.snapshot().fakeProviderTurns.length, 1);
  assert.equal((await request(fixture, 'GET', '/health')).handled, false, 'common transport retains unrelated read-only routes');
});

test('dispose releases a held request without dispatch and closes only owned resources, retaining evidence', async t => {
  const { fixture } = await setup(t); await seed(fixture); await control(fixture, 'hold-next');
  const pending = request(fixture, 'POST', '/tasks/continue', bodyFor(fixture.snapshot(), 'send', 'how', { choice: 'email' }));
  await until(() => fixture.snapshot(), state => state.held !== null, 'held incoming continue');
  const closing = fixture.dispose(); assert.equal(fixture.dispose(), closing); await closing;
  assert.equal((await pending).status, 503);
  assert.equal(fixture.snapshot().disposed, true); assert.ok(fs.existsSync(fixture.snapshot().database));
});
