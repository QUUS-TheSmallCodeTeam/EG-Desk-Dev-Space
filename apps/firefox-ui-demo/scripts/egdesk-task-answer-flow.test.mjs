import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createTaskHttpHandler } from '../helper/egdesk-task-http.mjs';
import { normalizeGateAnswer } from '../helper/egdesk-task-graph.mjs';
import { createTaskBoard, taskBoardWithGraph, taskBoardWithState, taskBoardEntry, taskGateView,
  taskBoardView, buildTaskContinueRequest, taskContinueErrorText } from '../overlay/resources/EGDeskChatState.sys.mjs';

// The real HTTP handler and pure browser reducer, without listen(), a provider,
// runtime, native UI, store, filesystem write or a secret source repository.
const scope = { graphId: 'graph-answer', requestId: 'request-answer', runId: 'run-answer',
  parentTaskId: 'parent-answer', requestedBy: 'owner-answer' };
const boardId = 'board-answer', taskId = 'task-answer', gateId = 'gate-answer';
const choice = () => ({ gateId, kind: 'userAction', label: '어떻게 보낼까요?', status: 'waiting',
  response: { kind: 'choice', options: [{ id: 'email', label: '메일로' }, { id: 'kakao', label: '카카오톡으로' }] } });
const freeText = (maxLength) => ({ gateId, kind: 'userAction', label: '덧붙일 말', status: 'waiting',
  response: { kind: 'text', ...(maxLength === undefined ? {} : { maxLength }) } });

async function request(handler, method, url, body) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  Object.assign(req, { method, url, headers: { host: '127.0.0.1:39218',
    ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, socket: { remoteAddress: '127.0.0.1' } });
  const res = { headers: {}, status: null, body: null,
    setHeader(key, value) { this.headers[key.toLowerCase()] = value; },
    writeHead(status, headers) { this.status = status; Object.assign(this.headers, headers); },
    end(value) { this.body = JSON.parse(value); } };
  assert.equal(await handler(req, res), true);
  return res;
}

function fixture(gate = choice()) {
  const projection = { ...scope, activated: true, cancelRequested: false,
    tasks: [{ taskId, ownerId: 'worker-answer', sourceRef: 'source-answer', status: 'queued',
      dependsOn: [], gates: [structuredClone(gate)], attempts: [], lateOutcomes: [] }] };
  const continued = [], authCalls = [];
  const graph = { getGraph(id) { return id === scope.graphId ? structuredClone(projection) : null; } };
  const adapter = {
    getState(id) { return id === scope.graphId ? { boardId, scope: structuredClone(scope), fenced: false, approvals: [] } : null; },
    assertScope(actual, board) {
      if (board !== boardId || JSON.stringify(actual) !== JSON.stringify(scope)) {
        throw Object.assign(new Error('scope mismatch'), { code: 'TASK_AUTHORITY', httpStatus: 403 });
      }
    },
    boardState(_graph, board) { return { ...board, closing: false, canClose: false }; },
  };
  const handler = createTaskHttpHandler({ graph, adapter, ensureAuth: async () => { authCalls.push(true); },
    continueGate: async value => { continued.push(structuredClone(value)); projection.tasks[0].gates[0].status = 'satisfied'; } });
  const payload = () => ({ graph: graph.getGraph(scope.graphId), native: adapter.getState(scope.graphId) });
  return { projection, continued, authCalls, payload, graph, handler,
    board: () => taskBoardWithState(createTaskBoard(), payload()),
    get: () => request(handler, 'GET', `/tasks/state?graphId=${scope.graphId}`),
    post: body => request(handler, 'POST', '/tasks/continue', body),
    body: answer => ({ boardId, scope: { ...scope }, taskId, gateId, ...(answer === undefined ? {} : { answer }) }) };
}
const entry = board => taskBoardEntry(board, scope.graphId);
const condition = board => taskBoardView(board).groups[0].tasks[0].conditions[0];
const build = (board, answer) => buildTaskContinueRequest(entry(board), taskId, gateId, answer);
const invalidAnswer = fn => assert.throws(fn, error => error.code === 'TASK_GATE_ANSWER' && error.status === 400);

test('GET public response survives real state shaping, SSE shaping and Board DTO without any continue request', async () => {
  const h = fixture(), res = await h.get();
  assert.equal(res.status, 200);
  const board = taskBoardWithState(createTaskBoard(), res.body);
  assert.deepEqual(entry(board).graph.tasks[0].gates[0].response, choice().response);
  assert.deepEqual(condition(board).response, choice().response);
  assert.equal(condition(board).continuable, true);
  assert.deepEqual(condition(taskBoardWithGraph(createTaskBoard(), res.body.graph)).response, choice().response);
  assert.equal(h.continued.length, 0);
  assert.equal(condition(board).text, '확인 대기 · 어떻게 보낼까요?');
});

test('legacy gate views are unchanged: no response, key, required-answer flag or private state appears', () => {
  const gate = { gateId, kind: 'userAction', label: '확인', status: 'waiting' };
  assert.deepEqual(taskGateView(gate), { gateId, kind: 'userAction', state: 'waiting', text: '확인 대기 · 확인', time: null, byHand: false });
  assert.equal(Object.hasOwn(condition(fixture(gate).board()), 'response'), false);
});

test('valid choice counts 2 through 6 and label/ID boundaries are kept exactly in order', () => {
  for (let count = 2; count <= 6; count++) {
    const gate = choice();
    gate.response.options = Array.from({ length: count }, (_, i) => ({ id: `o${i}${'a'.repeat(62)}`, label: ` ${'가'.repeat(118)} ` }));
    const view = taskGateView(gate);
    assert.deepEqual(view.response, gate.response);
    assert.notEqual(view.response, gate.response);
    assert.notEqual(view.response.options[0], gate.response.options[0]);
  }
});

test('text DTO exposes the effective 1..500 code-point limit, including the default, for every gate state', () => {
  for (const limit of [undefined, 1, 20, 500]) for (const status of ['waiting', 'expired', 'satisfied', 'rejected']) {
    const view = taskGateView({ ...freeText(limit), status });
    assert.deepEqual(view.response, { kind: 'text', maxLength: limit ?? 500 });
    assert.equal(view.state, status);
  }
});

test('responseKey is stable across equal SSE/refresh copies but changes with question, option identity/order/label or limit', () => {
  const h = fixture(), board = h.board(), first = condition(board).responseKey;
  assert.equal(typeof first, 'string');
  assert.equal(condition(taskBoardWithState(board, h.payload())).responseKey, first);
  assert.equal(condition(taskBoardWithGraph(board, h.graph.getGraph(scope.graphId))).responseKey, first);
  for (const mutate of [gate => { gate.label = '다른 질문'; }, gate => { gate.label = ` ${gate.label} `; }, gate => { gate.response.options.reverse(); },
    gate => { gate.response.options[0].id = 'other'; }, gate => { gate.response.options[0].label = '다른 선택'; }]) {
    const gate = choice(); mutate(gate);
    assert.notEqual(taskGateView(gate).responseKey, first);
  }
  assert.equal(taskGateView(freeText()).responseKey, taskGateView(freeText(500)).responseKey, 'same effective default');
  assert.notEqual(taskGateView(freeText(20)).responseKey, taskGateView(freeText(21)).responseKey);
});

test('malformed descriptors stay explicit and fail closed through raw, state and SSE views', () => {
  const malformed = [null, false, 0, '', [], {}, { kind: 'other' }, { kind: 'text', maxLength: null },
    { kind: 'text', maxLength: 0 }, { kind: 'text', maxLength: 501 }, { kind: 'text', maxLength: 1.5 },
    { kind: 'text', maxLength: '20' }, { kind: 'text', text: 'private-answer' },
    { kind: 'choice' }, { kind: 'choice', options: [] }, { kind: 'choice', options: [{ id: 'a', label: 'A' }] },
    { kind: 'choice', options: Array.from({ length: 7 }, (_, i) => ({ id: `a${i}`, label: 'A' })) },
    { kind: 'choice', options: [{ id: 'same', label: 'A' }, { id: 'same', label: 'B' }] },
    { kind: 'choice', options: [{ id: 'bad/id', label: 'A' }, { id: 'b', label: 'B' }] },
    { kind: 'choice', options: [{ id: 'a'.repeat(65), label: 'A' }, { id: 'b', label: 'B' }] },
    ...[null, {}, { id: 'a', label: '' }, { id: 'a', label: '  ' }, { id: 'a', label: 'a\nb' },
      { id: 'a', label: 'a'.repeat(121) }, { id: 'a', label: '😀'.repeat(61) }, { id: 'a', label: 'A', secret: 'private' }]
      .map(option => ({ kind: 'choice', options: [option, { id: 'b', label: 'B' }] }))];
  for (const response of malformed) {
    const gate = { ...choice(), response }, h = fixture(gate);
    for (const board of [h.board(), taskBoardWithGraph(h.board(), h.graph.getGraph(scope.graphId))]) {
      const view = condition(board);
      assert.equal(view.response, null, JSON.stringify(response));
      assert.equal(view.responseInvalid, true); assert.equal(view.responseKey, null);
      assert.equal(view.continuable, false); assert.match(view.error, /질문 내용을 확인하지 못했습니다/);
      assert.equal(entry(board).graph.tasks[0].gates[0].response, null, 'invalid is retained, not erased');
      invalidAnswer(() => build(board)); invalidAnswer(() => build(board, { text: 'test' }));
    }
    assert.equal(taskGateView(gate).responseInvalid, true);
    assert.equal(h.continued.length, 0);
  }
});

test('question descriptors on non-userAction gates fail closed instead of opening an unrelated condition', () => {
  for (const kind of ['oauth', 'file', 'terminalExit', 'approval', 'task', 'unknown']) {
    const h = fixture({ ...choice(), kind }), board = h.board();
    assert.equal(condition(board).responseInvalid, true); assert.equal(condition(board).continuable, false);
    if (['oauth', 'file', 'terminalExit'].includes(kind)) invalidAnswer(() => build(board, { choice: 'email' }));
    else assert.equal(build(board, { choice: 'email' }), null);
  }
});

test('malicious public labels remain literal values, never promoted into answers, keys or HTML commands', () => {
  const gate = choice(), markup = '<img src=x onerror="bad()">';
  gate.label = markup; gate.response.options[0].label = markup;
  const h = fixture(gate), board = h.board(), view = condition(board);
  assert.ok(view.text.includes(markup)); assert.equal(view.response.options[0].label, markup);
  assert.deepEqual(build(board, { choice: 'email' }).answer, { choice: 'email' });
  assert.equal(JSON.stringify(build(board, { choice: 'email' })).includes(markup), false);
});

test('choice answer builds the exact scoped body and real HTTP accepts it once without claiming task completion', async () => {
  const h = fixture(), board = h.board(), body = build(board, { choice: 'kakao' });
  assert.deepEqual(body, h.body({ choice: 'kakao' }));
  const result = await h.post(body);
  assert.equal(result.status, 200);
  assert.deepEqual(h.continued, [{ graphId: scope.graphId, taskId, gateId, boardId, answer: { choice: 'kakao' } }]);
  const updated = taskBoardWithState(board, result.body), view = taskBoardView(updated);
  assert.equal(view.groups[0].tasks[0].conditions[0].state, 'satisfied');
  assert.equal(view.groups[0].tasks[0].status, 'queued', 'answer accepted does not mean resumed/running/completed');
  assert.equal(build(updated, { choice: 'kakao' }), null);
  const duplicate = await h.post(body);
  assert.deepEqual([duplicate.status, duplicate.body.code], [409, 'TASK_GATE_STALE']);
  assert.equal(h.continued.length, 1);
});

test('text normalization is byte-for-byte identical to backend NFC, CRLF/CR, trim and code-point semantics', async () => {
  for (const raw of [' 부가세 별도\r\n ', ' e\u0301\r\n다음\r줄\t끝 ', '😀'.repeat(20), '\u1100\u1161'.repeat(20),
    '\t 첫 줄\n둘째 줄 \t', '한'.repeat(20), 'x\u2028y\u2029z', '\ud800']) {
    const h = fixture(freeText(20)), board = h.board(), answer = { text: raw };
    const expected = normalizeGateAnswer(freeText(20), answer), body = build(board, answer);
    assert.deepEqual(body.answer, expected);
    assert.equal(answer.text, raw, 'caller draft is not normalized in place');
    const result = await h.post(body);
    assert.equal(result.status, 200, JSON.stringify(raw));
    assert.deepEqual(h.continued[0].answer, expected);
  }
});

test('default 500 and custom code-point boundaries accept complete answers and never silently clip', async () => {
  for (const limit of [1, 20, 500]) {
    const gate = freeText(limit === 500 ? undefined : limit), h = fixture(gate), board = h.board();
    const value = '😀'.repeat(limit);
    assert.equal(build(board, { text: value }).answer.text, value, 'UTF-16 length may be twice the permitted code-point count');
    assert.equal((await h.post(build(board, { text: value }))).status, 200);
    const tooLong = { text: value + '😀' }, fresh = fixture(gate);
    invalidAnswer(() => build(fresh.board(), tooLong));
    assert.throws(() => normalizeGateAnswer(gate, tooLong), { code: 'E_TASK_ANSWER' });
    assert.equal((await fresh.post(fresh.body(tooLong))).body.code, 'TASK_GATE_ANSWER');
    assert.equal(fresh.continued.length, 0);
  }
});

test('missing/wrong/extra choice answers are refused locally and by actual HTTP before continuation', async () => {
  for (const answer of [undefined, null, [], 'email', {}, { choice: 'fax' }, { choice: ' email ' }, { choice: 1 },
    { text: 'email' }, { choice: 'email', text: 'extra' }, { choice: 'email', private: 'secret' }]) {
    const h = fixture(), board = h.board();
    invalidAnswer(() => build(board, answer));
    assert.throws(() => normalizeGateAnswer(choice(), answer), { code: 'E_TASK_ANSWER' });
    const rejected = await h.post(h.body(answer));
    assert.deepEqual([rejected.status, rejected.body.code], [400, 'TASK_GATE_ANSWER']);
    assert.equal(h.continued.length, 0);
  }
});

test('invalid text shape, blank, excessive length and control characters match backend rejection without echoing input', async () => {
  for (const answer of [undefined, null, [], 7, {}, { text: null }, { text: 4 }, { text: '' }, { text: '  \t\r\n ' },
    { text: '가'.repeat(21) }, { text: 'a\u0007b' }, { text: 'a\u000bb' }, { text: 'a\u001fb' }, { text: 'a\u007fb' },
    { choice: 'email' }, { text: 'private-value', hidden: 'extra' }]) {
    const h = fixture(freeText(20)), board = h.board();
    assert.throws(() => build(board, answer), error => {
      assert.equal(error.code, 'TASK_GATE_ANSWER'); assert.equal(error.message.includes('private-value'), false); return true;
    });
    assert.throws(() => normalizeGateAnswer(freeText(20), answer), { code: 'E_TASK_ANSWER' });
    const rejected = await h.post(h.body(answer));
    assert.deepEqual([rejected.status, rejected.body.code], [400, 'TASK_GATE_ANSWER']);
    assert.equal(h.continued.length, 0);
  }
});

test('legacy external gate requests retain their exact four fields and old continueGate callback shape', async () => {
  for (const kind of ['userAction', 'oauth', 'file', 'terminalExit']) {
    const h = fixture({ gateId, kind, status: 'waiting' }), board = h.board();
    const body = build(board);
    assert.deepEqual(body, { boardId, scope, taskId, gateId });
    assert.equal(Object.hasOwn(body, 'answer'), false);
    assert.deepEqual(build(board, undefined), body);
    for (const extra of [null, {}, { text: 'hello' }, { choice: 'email' }]) invalidAnswer(() => build(board, extra));
    assert.equal((await h.post(body)).status, 200);
    assert.deepEqual(h.continued, [{ graphId: scope.graphId, taskId, gateId }], 'no new boardId/answer passed to old callback');
  }
});

test('secret-looking answers remain the real HTTP authority: rejected before continueGate, safe Korean error, no Board retention', async () => {
  for (const secret of ['pw: hunter2', 'sk-proj-abc123', '비밀번호: keep-private', '인증번호: 123456', 'AKIA1234567890ABCDEF']) {
    const h = fixture(freeText()), board = h.board(), draft = { text: secret };
    const response = await h.post(build(board, draft));
    assert.deepEqual([response.status, response.body.code], [400, 'TASK_GATE_ANSWER_PRIVATE']);
    assert.equal(h.continued.length, 0);
    assert.equal(JSON.stringify(response.body).includes(secret), false);
    assert.equal(JSON.stringify(board).includes(secret), false);
    assert.equal(JSON.stringify(taskBoardView(board)).includes(secret), false);
    assert.equal(draft.text, secret, 'only the caller owns the transient failed draft');
    assert.match(taskContinueErrorText(response.body), /해당 값을 빼고 다시 답해 주세요/);
  }
});

test('request and response DTOs copy nested public data, with no aliases to the input gate, Board or draft', () => {
  const h = fixture(), payload = h.payload(), board = taskBoardWithState(createTaskBoard(), payload);
  const view = condition(board), answer = { choice: 'email' }, body = build(board, answer);
  payload.graph.tasks[0].gates[0].response.options[0].label = 'input changed';
  view.response.options[0].id = 'view changed';
  body.answer.choice = 'request changed'; body.scope.requestedBy = 'request changed';
  assert.equal(condition(board).response.options[0].label, '메일로');
  assert.equal(condition(board).response.options[0].id, 'email');
  assert.equal(answer.choice, 'email'); assert.equal(entry(board).scope.requestedBy, scope.requestedBy);
});

test('late state reads cannot replace a newer question definition; new choices invalidate the old answer', () => {
  const h = fixture(), initial = h.board(), oldPayload = h.payload(), rev = entry(initial).rev;
  const updatedGraph = h.graph.getGraph(scope.graphId);
  updatedGraph.tasks[0].gates[0].response.options = [{ id: 'new-a', label: '새 항목 A' }, { id: 'new-b', label: '새 항목 B' }];
  const latest = taskBoardWithGraph(initial, updatedGraph);
  const afterLate = taskBoardWithState(latest, oldPayload, { ifRev: rev });
  assert.equal(condition(afterLate).responseKey, condition(latest).responseKey);
  assert.notEqual(condition(afterLate).responseKey, condition(initial).responseKey);
  invalidAnswer(() => build(afterLate, { choice: 'email' }));
  assert.deepEqual(build(afterLate, { choice: 'new-a' }).answer, { choice: 'new-a' });
});

test('same-question SSE/refresh/error retain the descriptor identity and do not consume caller drafts', () => {
  const h = fixture(freeText()), initial = h.board(), draft = { text: ' 아직 보내지 않은 답변\r\n ' };
  const before = structuredClone(draft), key = condition(initial).responseKey;
  const refreshed = taskBoardWithState(taskBoardWithGraph(initial, h.graph.getGraph(scope.graphId)), h.payload());
  const continuing = { graphId: scope.graphId, taskId, gateId, responseKey: key, phase: 'error', error: '다시 확인해 주세요.' };
  const view = taskBoardView(refreshed, { continuing }).groups[0].tasks[0].conditions[0];
  assert.equal(view.responseKey, key); assert.equal(view.error, continuing.error);
  build(refreshed, draft);
  assert.deepEqual(draft, before); assert.equal(h.continued.length, 0, 'building is not sending');
  assert.equal(JSON.stringify(refreshed).includes('아직 보내지 않은'), false);
});

test('private answer, evidence and source fields never enter shaped gate/descriptor identity', () => {
  const h = fixture(), payload = h.payload();
  Object.assign(payload.graph.tasks[0].gates[0], { answer: { text: 'private-answer' }, textRef: 'private-ref', evidence: 'private-evidence' });
  const board = taskBoardWithState(createTaskBoard(), payload), value = JSON.stringify({ board, view: taskBoardView(board) });
  assert.equal(/private-answer|private-ref|private-evidence/.test(value), false);
  assert.equal(condition(board).responseKey, taskGateView(choice()).responseKey);
});

test('stale/cancelled/unstarted/completed/approval/upstream gates preserve the old null request contract', () => {
  for (const change of [h => { h.projection.activated = false; }, h => { h.projection.cancelRequested = true; },
    h => { h.projection.tasks[0].status = 'running'; }, h => { h.projection.tasks[0].status = 'completed'; },
    h => { h.projection.tasks[0].gates[0].status = 'satisfied'; }, h => { h.projection.tasks[0].gates[0].status = 'rejected'; },
    h => { h.projection.tasks[0].gates[0].kind = 'task'; }, h => { h.projection.tasks[0].gates[0].kind = 'approval'; }]) {
    const h = fixture(); change(h);
    assert.equal(build(h.board(), { choice: 'email' }), null);
  }
  const h = fixture(), board = h.board();
  assert.equal(buildTaskContinueRequest({ ...entry(board), boardId: null }, taskId, gateId, { choice: 'email' }), null);
  assert.equal(buildTaskContinueRequest({ ...entry(board), scope: { ...scope, graphId: 'another' } }, taskId, gateId, { choice: 'email' }), null);
  assert.equal(buildTaskContinueRequest(entry(board), taskId, 'different-gate', { choice: 'email' }), null);
});

test('expired questions accept answers with the same contract; backend scope mismatch still prevents continuation', async () => {
  const gate = choice(); gate.status = 'expired';
  const h = fixture(gate), body = build(h.board(), { choice: 'email' });
  assert.equal((await h.post({ ...body, boardId: 'another-board' })).status, 403);
  assert.equal(h.continued.length, 0);
  assert.equal((await h.post(body)).status, 200); assert.equal(h.continued.length, 1);
});

test('answer-specific Korean errors override generic connection/status text and never echo raw details', () => {
  for (const code of ['TASK_GATE_ANSWER', 'TASK_GATE_ANSWER_PRIVATE']) {
    const result = taskContinueErrorText({ code, status: 409, message: '/private/path raw-secret' });
    assert.match(result, /답변|답해/); assert.equal(result.includes('/private/path'), false); assert.equal(result.includes('raw-secret'), false);
    assert.equal(taskContinueErrorText({ code }), result);
  }
  assert.match(taskContinueErrorText({ code: 'TASK_GATE_STALE' }), /더 이상 기다리지 않습니다/);
  assert.match(taskContinueErrorText({ code: 'BRIDGE_OFFLINE' }), /아직 준비되지 않아/);
});

test('descriptor-scoped pending/error notices do not follow another question with the same IDs', () => {
  const h = fixture(freeText(20)), board = h.board(), originalKey = condition(board).responseKey;
  h.projection.tasks[0].gates[0].response.maxLength = 10;
  const changed = taskBoardWithState(board, h.payload());
  for (const phase of ['sending', 'error']) {
    const continuing = { graphId: scope.graphId, taskId, gateId, responseKey: originalKey, phase, error: 'old notice' };
    const oldRow = taskBoardView(board, { continuing }).groups[0].tasks[0].conditions[0];
    const newRow = taskBoardView(changed, { continuing }).groups[0].tasks[0].conditions[0];
    assert.equal(oldRow.phase, phase);
    assert.equal(newRow.phase, null); assert.equal(newRow.error, null);
  }
  const legacy = fixture({ gateId, kind: 'userAction', status: 'waiting' }).board();
  const row = taskBoardView(legacy, { continuing: { graphId: scope.graphId, taskId, gateId, phase: 'error', error: 'legacy error' } })
    .groups[0].tasks[0].conditions[0];
  assert.equal(row.error, 'legacy error', 'old no-answer caller does not need a new descriptor key');
});
