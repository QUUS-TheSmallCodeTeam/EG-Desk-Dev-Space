import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { CodexChatRuntime } from './codex-chat-runtime.mjs';
import { openTaskGraph } from './egdesk-task-graph.mjs';
import { openTaskStore } from './egdesk-task-store.mjs';
import { openNativeTaskLedger } from './egdesk-task-native-store.mjs';
import { createNativeTaskAdapter } from './egdesk-task-native.mjs';

const delay = () => new Promise((resolve) => setTimeout(resolve, 2));
function deferred() { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; }
async function until(predicate) {
  for (let count = 0; count < 1000; count += 1) { if (await predicate()) return; await delay(); }
  assert.fail('Expected adapter state did not arrive');
}
function spec(suffix = 'one', approvalRequired = false, dependent = true) {
  return { graphId: `graph-${suffix}`, requestId: `request-${suffix}`, runId: `parent-run-${suffix}`,
    parentTaskId: 'parent-task', requestedBy: 'local-owner', tasks: [
      { taskId: 'a', ownerId: 'worker-a', sourceRef: 'source-a', dependsOn: [], approvalRequired },
      ...(dependent ? [{ taskId: 'b', ownerId: 'worker-b', sourceRef: 'source-b', dependsOn: ['a'], approvalRequired: false }] : []),
    ] };
}
const scope = (value) => Object.fromEntries(['graphId', 'requestId', 'runId', 'parentTaskId', 'requestedBy'].map((key) => [key, value[key]]));
const status = (graph, id, taskId = 'a') => graph.getGraph(id).tasks.find((task) => task.taskId === taskId).status;

async function fixture(t, options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'egdesk-task-native-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const ledger = await openNativeTaskLedger(path.join(directory, 'native'));
  const store = await openTaskStore(path.join(directory, 'graph'));
  const calls = [], events = [], pendingEvents = [], eventErrors = [], replies = [];
  const authority = { ownerKey: 'engine-A', generation: 1, delegationKey: 'delegation-parent', revoked: false };
  const auth = {
    captureScope() {
      if (authority.revoked) throw new Error('Parent delegation revoked');
      const { revoked, ...captured } = authority;
      return captured;
    },
    assertDelegationCurrent(captured) {
      return !authority.revoked && captured.ownerKey === authority.ownerKey &&
        captured.generation === authority.generation && captured.delegationKey === authority.delegationKey;
    },
  };
  let adapter, threadCount = 0, turnCount = 0;
  const resumedTurns = new Map();
  const defaults = async (method, params) => {
    if (method === 'thread/start') return { thread: { id: `native-thread-${++threadCount}` } };
    if (method === 'turn/start') return { turn: { id: `native-turn-${++turnCount}`, status: 'inProgress', items: [] } };
    if (method === 'thread/resume') return { thread: { id: params.threadId, turns: resumedTurns.get(params.threadId) ?? [] } };
    if (method === 'turn/interrupt') return {};
    throw new Error(`Unexpected native RPC ${method}`);
  };
  const chat = new CodexChatRuntime({
    request: async (method, params) => {
      calls.push({ method, params });
      if (method === 'thread/start') assert(ledger.snapshot().attempts.some((item) => item.phase === 'intent'), 'persist intent before child creation');
      return options.request ? options.request(method, params, chat, defaults) : defaults(method, params);
    },
    respond: (...args) => replies.push(args), verifyFile: async () => null,
    emit(event) {
      events.push(event);
      if (adapter) {
        const work = adapter.onChatEvent(event);
        pendingEvents.push(work);
        void work.catch((error) => eventErrors.push(error));
      }
    },
  });
  chat.setConnection(true);
  const resolver = options.resolve ?? (async ({ binding }) => ({ message: `PRIVATE-RESOLVED-${binding.sourceRef}`, cwd: '/authorized/work' }));
  adapter = createNativeTaskAdapter({ chat, ledger: options.wrapLedger?.(ledger) ?? ledger,
    resolveTaskInput: resolver, ...auth });
  const graph = await openTaskGraph({ store, maxConcurrency: 2, ...adapter });
  async function register(value, boardId = `board-${value.graphId}`) {
    const queued = await graph.submitGraph(value);
    await adapter.registerGraph({ boardId, graph: queued });
    return { boardId, scope: scope(value) };
  }
  async function flush() {
    await chat.queue;
    while (pendingEvents.length) await Promise.all(pendingEvents.splice(0));
  }
  async function finish(ids, result = 'completed') {
    await chat.handleNotification({ method: 'turn/completed', params: {
      threadId: ids.conversationId, turn: { id: ids.runId, status: result, items: [] },
    } });
    await flush();
  }
  return { directory, ledger, graph, adapter, chat, calls, events, eventErrors, replies, authority, auth,
    resolver, resumedTurns, register, flush, finish,
    setAdapter(next) { adapter = next; },
  };
}

test('native acceptance and answer items do not complete a task; actual terminal opens dependent gate', async (t) => {
  const h = await fixture(t);
  const value = spec();
  await h.register(value);
  await h.graph.activateGraph(scope(value));
  await until(() => h.adapter.getState(value.graphId).attempts[0]?.phase === 'accepted');
  const first = h.adapter.getState(value.graphId).attempts[0];
  assert.equal(status(h.graph, value.graphId), 'running');
  assert.equal(status(h.graph, value.graphId, 'b'), 'waiting-on-dependency');
  await h.chat.handleNotification({ method: 'item/completed', params: {
    threadId: first.native.conversationId, turnId: first.native.runId,
    item: { id: 'answer-item', type: 'agentMessage', phase: 'final_answer', text: 'done' },
  } });
  await h.flush();
  assert.equal(status(h.graph, value.graphId), 'running');
  await h.finish(first.native);
  await until(() => h.adapter.getState(value.graphId).attempts.length === 2);
  assert.equal(status(h.graph, value.graphId), 'completed');
  await until(() => h.adapter.getState(value.graphId).attempts[1]?.phase === 'accepted');
  assert.equal(h.calls.filter((call) => call.method === 'turn/start').length, 2);
  const file = await readFile(path.join(h.directory, 'native/native-task-ledger.json'), 'utf8');
  assert(!file.includes('PRIVATE-RESOLVED'));
  assert(!file.includes('/authorized/work'));
  assert.deepEqual(h.eventErrors, []);
});

test('early native terminal events bind by request and exact accepted IDs; duplicates are idempotent', async (t) => {
  const h = await fixture(t, { request: async (method, params, chat, defaults) => {
    if (method !== 'turn/start') return defaults(method, params);
    await chat.handleNotification({ method: 'turn/completed', params: {
      threadId: params.threadId, turn: { id: 'early-turn', status: 'completed', items: [] },
    } });
    return { turn: { id: 'early-turn', status: 'inProgress', items: [] } };
  } });
  const value = spec('early', false, false);
  await h.register(value);
  await h.graph.activateGraph(scope(value));
  await until(() => status(h.graph, value.graphId) === 'completed');
  const event = h.events.find((item) => item.event === 'run.completed');
  const attempt = h.ledger.snapshot().attempts[0];
  await h.adapter.onChatEvent(event);
  await h.adapter.onChatEvent({ ...event, runId: 'foreign-turn' });
  const repeated = await h.adapter.execute({ binding: attempt.binding, dependencyReceipts: [], approvalReceiptId: null });
  assert.deepEqual(repeated, attempt.receipt);
  assert.equal(h.calls.filter((call) => call.method === 'turn/start').length, 1);
  assert.equal(h.ledger.snapshot().attempts[0].receipt.receiptId, attempt.receipt.receiptId);
  assert.equal(h.adapter.verifyReceipt({ receipt: { ...repeated, receiptId: 'forged' }, expected: attempt.binding, outcome: 'completed' }), false);
});

test('Board close interrupts only its own native run and waits for the actual stop receipt', async (t) => {
  const h = await fixture(t);
  const a = spec('a'), b = spec('b', false, false);
  await h.register(a, 'board-a'); await h.register(b, 'board-b');
  await h.graph.activateGraph(scope(a)); await h.graph.activateGraph(scope(b));
  await until(() => h.ledger.snapshot().attempts.filter((item) => item.phase === 'accepted').length === 2);
  const nativeA = h.adapter.getState(a.graphId).attempts[0].native;
  const nativeB = h.adapter.getState(b.graphId).attempts[0].native;
  const board = { boardId: 'board-a', requestedBy: 'local-owner' };
  assert.equal((await h.adapter.cancelBoard(h.graph, board)).canClose, false);
  let closed = false;
  const stopped = h.adapter.waitForBoardStop(h.graph, board).then((result) => { closed = true; return result; });
  await until(() => h.calls.some((call) => call.method === 'turn/interrupt'));
  assert.deepEqual(h.calls.filter((call) => call.method === 'turn/interrupt').map((call) => call.params),
    [{ threadId: nativeA.conversationId, turnId: nativeA.runId }]);
  assert.equal(status(h.graph, a.graphId), 'running');
  assert.equal(status(h.graph, a.graphId, 'b'), 'cancelled');
  assert.equal(status(h.graph, b.graphId), 'running');
  assert.equal(closed, false);
  await h.finish(nativeA, 'interrupted');
  assert.equal((await stopped).canClose, true);
  assert.equal(status(h.graph, a.graphId), 'cancelled');
  assert.equal(status(h.graph, b.graphId), 'running');
  await h.finish(nativeB);
  await until(() => status(h.graph, b.graphId) === 'completed');
});

test('task preapproval is server-issued, scope-bound, and separate from native chat approvals', async (t) => {
  const h = await fixture(t);
  const value = spec('approval', true, false);
  const registered = await h.register(value);
  await h.graph.activateGraph(scope(value));
  await until(() => h.adapter.getState(value.graphId).approvals.length === 1);
  const pending = h.adapter.getState(value.graphId).approvals[0];
  assert.equal(h.calls.length, 0);
  await assert.rejects(h.adapter.decideTaskApproval({ ...registered, taskId: 'wrong',
    approvalId: pending.approvalId, decision: 'approved' }), { code: 'TASK_APPROVAL_STALE' });
  const receipt = await h.adapter.decideTaskApproval({ ...registered, taskId: 'a',
    approvalId: pending.approvalId, decision: 'approved' });
  assert.equal(h.adapter.verifyReceipt({ receipt, expected: receipt.binding, outcome: 'approved' }), true);
  await until(() => h.adapter.getState(value.graphId).attempts[0]?.phase === 'accepted');
  await assert.rejects(h.adapter.decideTaskApproval({ ...registered, taskId: 'a',
    approvalId: pending.approvalId, decision: 'approved' }), { code: 'TASK_APPROVAL_STALE' });
  assert.equal(h.replies.length, 0, 'task preapproval never answers a native approval RPC');
});

test('restart reconciles exact native IDs without sending a replacement task', async (t) => {
  const h = await fixture(t);
  const value = spec('restart', false, false);
  await h.register(value); await h.graph.activateGraph(scope(value));
  await until(() => h.adapter.getState(value.graphId).attempts[0]?.phase === 'accepted');
  const original = h.ledger.snapshot().attempts[0];
  h.resumedTurns.set(original.native.conversationId, [{ id: original.native.runId, status: 'completed', items: [], itemsView: 'full' }]);
  const ledger = await openNativeTaskLedger(path.join(h.directory, 'native'));
  const adapter = createNativeTaskAdapter({ chat: h.chat, ledger, resolveTaskInput: h.resolver, ...h.auth });
  h.setAdapter(adapter);
  const graph = await openTaskGraph({ store: await openTaskStore(path.join(h.directory, 'graph')), ...adapter });
  assert.equal(graph.getGraph(value.graphId).recoveryHold, true);
  await assert.rejects(adapter.execute({ binding: original.binding, dependencyReceipts: [], approvalReceiptId: null }),
    { code: 'TASK_RECONCILE_REQUIRED' });
  await adapter.reconcile(graph, scope(value));
  assert.equal(status(graph, value.graphId), 'completed');
  assert.equal(h.calls.filter((call) => call.method === 'turn/start').length, 1);
  assert.equal(h.calls.filter((call) => call.method === 'thread/resume').length, 1);
});

test('unknown lost acceptance and transport failure are held across restart, never resubmitted', async (t) => {
  const h = await fixture(t, { request: async (method, params, chat, defaults) => {
    if (method === 'turn/start') throw new Error('RPC timeout');
    return defaults(method, params);
  } });
  const value = spec('unknown', false, false);
  await h.register(value); await h.graph.activateGraph(scope(value));
  await until(() => h.ledger.snapshot().attempts[0]?.phase === 'unknown');
  const adapter = createNativeTaskAdapter({ chat: h.chat,
    ledger: await openNativeTaskLedger(path.join(h.directory, 'native')), resolveTaskInput: h.resolver, ...h.auth });
  const result = await adapter.reconcile(h.graph, scope(value));
  assert.equal(result.results[0].status, 'unverified');
  assert.equal(status(h.graph, value.graphId), 'running');
  assert.equal(h.calls.filter((call) => call.method === 'turn/start').length, 1);
  assert.equal(h.calls.filter((call) => call.method === 'thread/resume').length, 1);
});

test('lost reply holds partial history, then reconciles a known native thread without resending', async (t) => {
  const h = await fixture(t, { request: async (method, params, chat, defaults) => {
    if (method === 'turn/start') throw new Error('lost RPC reply');
    return defaults(method, params);
  } });
  const value = spec('lost-reply', false, false);
  await h.register(value); await h.graph.activateGraph(scope(value));
  await until(() => h.ledger.snapshot().attempts[0]?.phase === 'unknown');
  await until(() => h.graph.getGraph(value.graphId).tasks[0].uncertain);
  const original = h.ledger.snapshot().attempts[0];
  const nativeThread = h.calls.find((call) => call.method === 'turn/start').params.threadId;
  assert.equal(original.candidateConversationId, nativeThread);
  assert.equal(original.native, null);
  h.resumedTurns.set(nativeThread, [{ id: 'native-lost-turn', status: 'completed', items: [], itemsView: 'summary' }]);
  const adapter = createNativeTaskAdapter({ chat: h.chat,
    ledger: await openNativeTaskLedger(path.join(h.directory, 'native')), resolveTaskInput: h.resolver, ...h.auth });
  h.setAdapter(adapter);
  const graph = await openTaskGraph({ store: await openTaskStore(path.join(h.directory, 'graph')), ...adapter });
  const held = await adapter.reconcile(graph, scope(value));
  assert.equal(held.results[0].status, 'unverified');
  assert.equal(status(graph, value.graphId), 'running');
  h.resumedTurns.set(nativeThread, [{ id: 'native-lost-turn', status: 'completed', items: [], itemsView: 'full' }]);
  await adapter.reconcile(graph, scope(value));
  assert.equal(status(graph, value.graphId), 'completed');
  assert.equal(h.calls.filter((call) => call.method === 'turn/start').length, 1);
  assert.equal(h.calls.filter((call) => call.method === 'thread/resume').length, 2);
  assert.deepEqual(adapter.getState(value.graphId).attempts[0].native,
    { conversationId: nativeThread, runId: 'native-lost-turn', answerId: `${nativeThread}/native-lost-turn` });
});

test('delayed resolver authority reset prevents any native child dispatch', async (t) => {
  const entered = deferred(), release = deferred();
  const h = await fixture(t, { resolve: async ({ phase }) => {
    if (phase === 'execute') { entered.resolve(); await release.promise; }
    return { message: 'resolved private instruction' };
  } });
  const value = spec('resolver-revoked', false, false);
  await h.register(value); await h.graph.activateGraph(scope(value));
  await entered.promise;
  h.authority.ownerKey = 'engine-B'; h.authority.generation += 1;
  release.resolve();
  await until(() => h.graph.getGraph(value.graphId).tasks[0].uncertain);
  assert.equal(h.calls.length, 0);
  assert.equal(h.ledger.snapshot().attempts.length, 0);
  assert.throws(() => h.adapter.getState(value.graphId), { code: 'TASK_AUTHORITY' });
});

test('authority change during durable intent write prevents chat.send after the await', async (t) => {
  const entered = deferred(), release = deferred();
  const h = await fixture(t, { wrapLedger: (ledger) => ({ snapshot: () => ledger.snapshot(),
    async transact(change) {
      const before = ledger.snapshot().attempts.length;
      const result = await ledger.transact(change);
      if (ledger.snapshot().attempts.length > before) { entered.resolve(); await release.promise; }
      return result;
    },
  }) });
  const value = spec('ledger-revoked', false, false);
  await h.register(value); await h.graph.activateGraph(scope(value));
  await entered.promise;
  h.authority.revoked = true;
  release.resolve();
  await until(() => h.graph.getGraph(value.graphId).tasks[0].uncertain);
  assert.equal(h.calls.length, 0);
  assert.equal(h.ledger.snapshot().attempts[0].native, null);
  assert.equal(h.ledger.snapshot().attempts[0].receipt, null);
});

test('late acceptance and terminal event cannot publish under another engine authority', async (t) => {
  const entered = deferred(), release = deferred();
  const h = await fixture(t, { request: async (method, params, chat, defaults) => {
    if (method !== 'turn/start') return defaults(method, params);
    entered.resolve(); await release.promise;
    return { turn: { id: 'late-turn', status: 'inProgress', items: [] } };
  } });
  const value = spec('late-authority', false, false);
  await h.register(value); await h.graph.activateGraph(scope(value));
  await entered.promise;
  h.authority.generation += 1;
  release.resolve();
  await until(() => h.graph.getGraph(value.graphId).tasks[0].uncertain);
  const run = h.chat.snapshot().runs[0];
  await h.finish(run);
  assert.equal(status(h.graph, value.graphId), 'running');
  assert.equal(h.ledger.snapshot().attempts[0].receipt, null);
  assert.equal(h.ledger.snapshot().attempts[0].native, null);
});

test('terminal ledger write after scope reset stays private until explicit reconciliation', async (t) => {
  const entered = deferred(), release = deferred();
  const h = await fixture(t, { wrapLedger: (ledger) => ({ snapshot: () => ledger.snapshot(),
    async transact(change) {
      const hadReceipt = ledger.snapshot().attempts.some((item) => item.receipt);
      const result = await ledger.transact(change);
      if (!hadReceipt && ledger.snapshot().attempts.some((item) => item.receipt)) {
        entered.resolve(); await release.promise;
      }
      return result;
    },
  }) });
  const value = spec('terminal-scope', false, false);
  await h.register(value); await h.graph.activateGraph(scope(value));
  await until(() => h.adapter.getState(value.graphId).attempts[0]?.phase === 'accepted');
  const native = h.adapter.getState(value.graphId).attempts[0].native;
  const completing = h.finish(native);
  await entered.promise;
  h.authority.generation += 1;
  release.resolve();
  await completing;
  assert.equal(status(h.graph, value.graphId), 'running');
  assert(h.ledger.snapshot().attempts[0].receipt, 'terminal proof is retained privately');
  await h.adapter.reconcile(h.graph, scope(value));
  await until(() => status(h.graph, value.graphId) === 'completed');
  assert.equal(h.calls.filter((call) => call.method === 'turn/start').length, 1);
});

test('persisted preapproval decision is replayed after authority reset without a second decision', async (t) => {
  const entered = deferred(), release = deferred();
  const h = await fixture(t, { wrapLedger: (ledger) => ({ snapshot: () => ledger.snapshot(),
    async transact(change) {
      const hadDecision = ledger.snapshot().approvals.some((item) => item.receipt);
      const result = await ledger.transact(change);
      if (!hadDecision && ledger.snapshot().approvals.some((item) => item.receipt)) {
        entered.resolve(); await release.promise;
      }
      return result;
    },
  }) });
  const value = spec('approval-replay', true, false);
  const registered = await h.register(value);
  await h.graph.activateGraph(scope(value));
  await until(() => h.adapter.getState(value.graphId).approvals.length === 1);
  const approvalId = h.adapter.getState(value.graphId).approvals[0].approvalId;
  const deciding = h.adapter.decideTaskApproval({ ...registered, taskId: 'a', approvalId, decision: 'approved' });
  await entered.promise;
  h.authority.generation += 1;
  release.resolve();
  await assert.rejects(deciding, { code: 'TASK_AUTHORITY' });
  assert.equal(status(h.graph, value.graphId), 'approval-required');
  await h.adapter.reconcile(h.graph, scope(value));
  await until(() => h.adapter.getState(value.graphId).attempts[0]?.phase === 'accepted');
  assert.equal(h.ledger.snapshot().approvals.length, 1);
  assert.equal(h.calls.filter((call) => call.method === 'turn/start').length, 1);
});

test('reconciliation resumes a persisted Board fence before any dependent dispatch', async (t) => {
  const h = await fixture(t);
  const value = spec('fence-replay');
  await h.register(value, 'closing-board');
  await h.graph.activateGraph(scope(value));
  await until(() => h.adapter.getState(value.graphId).attempts[0]?.phase === 'accepted');
  await h.ledger.transact((state) => { state.boardFences.push({ boardId: 'closing-board', requestedBy: value.requestedBy }); });
  await h.adapter.reconcile(h.graph, scope(value));
  assert.equal(h.graph.getGraph(value.graphId).cancelRequested, true);
  await until(() => h.calls.some((call) => call.method === 'turn/interrupt'));
  const native = h.adapter.getState(value.graphId).attempts[0].native;
  await h.finish(native, 'interrupted');
  await until(() => status(h.graph, value.graphId) === 'cancelled');
  assert.equal(h.calls.filter((call) => call.method === 'turn/start').length, 1);
});

test('native ledger corruption is preserved and refuses recovery reset', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'egdesk-native-corrupt-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'native-task-ledger.json');
  await writeFile(filename, '{broken-native-ledger');
  await assert.rejects(openNativeTaskLedger(directory), { code: 'NATIVE_LEDGER_CORRUPT' });
  assert.equal(await readFile(filename, 'utf8'), '{broken-native-ledger');
});
