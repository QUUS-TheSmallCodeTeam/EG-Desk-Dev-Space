import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Readable } from 'node:stream';
import { openTaskGraph } from './egdesk-task-graph.mjs';
import { createTaskHttpHandler } from './egdesk-task-http.mjs';

const scope = { graphId: 'graph-http', requestId: 'request-http', runId: 'parent-run',
  parentTaskId: 'parent-task', requestedBy: 'owner-A' };
const task = { taskId: 'task-A', ownerId: 'worker-A', sourceRef: 'source-A',
  dependsOn: [], approvalRequired: false };
const spec = { ...scope, tasks: [task] };
const receipt = { receiptId: 'private-receipt', outcome: 'completed', binding: { ...scope, ...task, attemptId: 'attempt-1' },
  evidenceRefs: ['private-evidence'] };

async function request(handler, method, url, body, headers = {}) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  req.method = method;
  req.url = url;
  req.headers = { host: '127.0.0.1:39218', ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers };
  req.socket = { remoteAddress: '127.0.0.1' };
  const res = {
    headers: {}, status: null, body: null,
    setHeader(key, value) { this.headers[key.toLowerCase()] = value; },
    writeHead(status, headersOut) {
      this.status = status;
      for (const [key, value] of Object.entries(headersOut)) this.setHeader(key, value);
    },
    end(value) { this.body = JSON.parse(value); },
  };
  const handled = await handler(req, res);
  return { handled, ...res };
}

function fixture() {
  const calls = [];
  let registered = false, valid = true, authAction = () => {};
  const projection = { ...structuredClone(spec), activated: false, cancelRequested: false,
    tasks: [{ ...structuredClone(task), status: 'queued', blockedBy: [], approvalRequested: false,
      approvalReceipt: { receiptId: 'private-approval' }, receipt, attempts: [
        { attemptId: 'attempt-1', status: 'completed', internal: 'not-public' }],
      uncertain: false, interruptUncertain: false, approvalDeliveryUncertain: false,
      lateOutcomes: [receipt] }] };
  const graph = {
    getGraph(graphId) { return graphId === scope.graphId ? structuredClone(projection) : null; },
    async submitGraph(value) { calls.push(['submit', value]); return structuredClone(projection); },
    async activateGraph(value) { calls.push(['activate', value]); projection.activated = true; },
    async cancelGraph(value) { calls.push(['cancel', value]); projection.cancelRequested = true; },
    async retryTask(value) { calls.push(['retry', value]); },
    async resumeGraph(value) { calls.push(['resume', value]); },
    async approveTask(value) { calls.push(['approve', value]); projection.tasks[0].status = 'ready'; },
  };
  const adapter = {
    assertScope(value, boardId) {
      calls.push(['assertScope', value, boardId]);
      if (!valid || boardId !== 'board-A' || JSON.stringify(value) !== JSON.stringify(scope)) {
        throw Object.assign(new Error('scope changed'), { code: 'TASK_AUTHORITY', httpStatus: 403 });
      }
    },
    getState(graphId) {
      if (!registered || graphId !== scope.graphId) return null;
      return { boardId: 'board-A', scope: structuredClone(scope), fenced: projection.cancelRequested,
        attempts: [], approvals: [{ approvalId: 'approval-A', taskId: 'task-A', status: 'pending' }] };
    },
    boardState(_graph, board) { return { ...board, closing: projection.cancelRequested, canClose: false, graphIds: [scope.graphId] }; },
    async registerGraph(value) { calls.push(['register', value]); registered = true; },
    async fenceGraph(value, boardId) { calls.push(['fence', value, boardId]); },
    async cancelBoard(_graph, board) { calls.push(['cancelBoard', board]); projection.cancelRequested = true; },
    async reconcile(_graph, value) { calls.push(['reconcile', value]); },
    async decideTaskApproval(value) { calls.push(['decision', value]); return structuredClone(receipt); },
  };
  const handler = createTaskHttpHandler({ graph, adapter,
    async ensureAuth() { calls.push(['auth']); await authAction(); } });
  return { handler, calls, graph, adapter, projection,
    setValid(value) { valid = value; }, setAuthAction(value) { authAction = value; } };
}

test('task HTTP queues by ID and exposes state without private completion or approval receipts', async () => {
  const h = fixture();
  const submitted = await request(h.handler, 'POST', '/tasks/submit', { boardId: 'board-A', graph: spec });
  assert.equal(submitted.status, 201);
  assert.deepEqual(h.calls.filter(([name]) => name === 'register').map(([, value]) => value.boardId), ['board-A']);
  const state = await request(h.handler, 'GET', `/tasks/state?graphId=${scope.graphId}`);
  assert.equal(state.status, 200);
  const publicTask = state.body.graph.tasks[0];
  assert.equal(Object.hasOwn(publicTask, 'receipt'), false);
  assert.equal(Object.hasOwn(publicTask, 'approvalReceipt'), false);
  assert.deepEqual(publicTask.attempts, [{ attemptId: 'attempt-1', status: 'completed' }]);
  assert.deepEqual(publicTask.evidenceRefs, ['private-evidence']);
  assert.equal(publicTask.lateOutcomeCount, 1);
  assert.equal(state.body.native.approvals[0].approvalId, 'approval-A');
  assert.equal(JSON.stringify(state.body).includes('private-receipt'), false);
});

test('task routes cover activate, retry, resume, approval and exact Board cancellation', async () => {
  const h = fixture();
  await request(h.handler, 'POST', '/tasks/submit', { boardId: 'board-A', graph: spec });
  assert.equal((await request(h.handler, 'POST', '/tasks/activate', { boardId: 'board-A', scope })).status, 200);
  assert.equal((await request(h.handler, 'POST', '/tasks/retry', { boardId: 'board-A', scope,
    taskId: 'task-A', operationId: 'retry-1' })).status, 200);
  assert.equal((await request(h.handler, 'POST', '/tasks/resume', { boardId: 'board-A', scope })).status, 200);
  h.projection.tasks[0].status = 'approval-required';
  assert.equal((await request(h.handler, 'POST', '/tasks/approval', { boardId: 'board-A', scope,
    taskId: 'task-A', approvalId: 'approval-A', decision: 'approved' })).status, 200);
  assert.equal((await request(h.handler, 'POST', '/tasks/cancel', { boardId: 'board-A', scope,
    closeBoard: true })).status, 202);
  assert.deepEqual(h.calls.filter(([name]) => ['activate', 'retry', 'reconcile', 'resume', 'decision',
    'approve', 'cancelBoard'].includes(name)).map(([name]) => name),
  ['activate', 'retry', 'reconcile', 'resume', 'decision', 'approve', 'cancelBoard']);
  assert.deepEqual(h.calls.find(([name]) => name === 'cancelBoard')[1],
    { boardId: 'board-A', requestedBy: 'owner-A' });
  assert.equal(h.calls.some(([name]) => name === 'cancel'), false);
});

test('HTTP refuses receipt injection, execution settings, foreign Boards and cross-origin callers', async () => {
  const h = fixture();
  const foreign = await request(h.handler, 'POST', '/tasks/submit', { boardId: 'board-A', graph: spec },
    { origin: 'https://untrusted.example' });
  assert.equal(foreign.status, 403);
  assert.equal(h.calls.length, 0);
  assert.equal((await request(h.handler, 'POST', '/tasks/receipt', { receipt })).status, 404);
  assert.equal((await request(h.handler, 'POST', '/tasks/submit', { boardId: 'board-A', graph: spec,
    cwd: '/foreign/work' })).status, 400);
  await request(h.handler, 'POST', '/tasks/submit', { boardId: 'board-A', graph: spec });
  assert.equal((await request(h.handler, 'POST', '/tasks/activate', { boardId: 'board-A', scope,
    model: 'arbitrary-model', profileEnabled: true })).status, 400);
  assert.equal((await request(h.handler, 'POST', '/tasks/cancel', { boardId: 'board-B', scope,
    closeBoard: true })).status, 403);
  assert.equal(h.calls.some(([name]) => ['activate', 'cancelBoard'].includes(name)), false);
});

test('nested task prompts are rejected by the graph contract before adapter registration', async () => {
  const graph = await openTaskGraph({ execute() {}, interrupt() {}, requestApproval() {}, verifyReceipt() { return false; } });
  let registered = false;
  const handler = createTaskHttpHandler({ graph, adapter: {
    registerGraph() { registered = true; },
  }, ensureAuth: async () => {} });
  const bad = { ...spec, tasks: [{ ...task, prompt: 'client-supplied execution text' }] };
  const response = await request(handler, 'POST', '/tasks/submit', { boardId: 'board-A', graph: bad });
  assert.equal(response.status, 400);
  assert.equal(response.body.code, 'E_TASK_INPUT');
  assert.equal(registered, false);
  assert.equal(graph.getGraph(scope.graphId), null);
});

test('authority is rechecked after authentication and reconciliation awaits', async () => {
  const h = fixture();
  await request(h.handler, 'POST', '/tasks/submit', { boardId: 'board-A', graph: spec });
  h.setAuthAction(() => { h.setValid(false); });
  const activation = await request(h.handler, 'POST', '/tasks/activate', { boardId: 'board-A', scope });
  assert.equal(activation.status, 403);
  assert.equal(h.calls.some(([name]) => name === 'activate'), false);
  h.setValid(true);
  h.setAuthAction(() => {});
  h.adapter.reconcile = async () => { h.setValid(false); };
  const resumed = await request(h.handler, 'POST', '/tasks/resume', { boardId: 'board-A', scope });
  assert.equal(resumed.status, 403);
  assert.equal(h.calls.some(([name]) => name === 'resume'), false);
});
