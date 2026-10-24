import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openTaskGraph } from './egdesk-task-graph.mjs';
import { openTaskStore } from './egdesk-task-store.mjs';

function graph(tasks, suffix = 'one') {
  return {
    graphId: `graph-${suffix}`,
    requestId: `request-${suffix}`,
    runId: `run-${suffix}`,
    parentTaskId: null,
    requestedBy: 'local-user',
    tasks: tasks.map(([taskId, dependsOn = [], options = {}]) => ({
      taskId, ownerId: options.ownerId ?? `agent-${taskId}`,
      sourceRef: options.sourceRef ?? `source-${taskId}`,
      dependsOn, approvalRequired: options.approvalRequired ?? false,
    })),
  };
}

function scope(spec) {
  return { graphId: spec.graphId, requestId: spec.requestId, runId: spec.runId,
    parentTaskId: spec.parentTaskId, requestedBy: spec.requestedBy };
}

function task(runtime, graphId, taskId) {
  return runtime.getGraph(graphId).tasks.find((entry) => entry.taskId === taskId);
}

function harness(options = {}) {
  const starts = [];
  const interrupts = [];
  const approvals = [];
  const validReceipts = new Set();
  let sequence = 0;
  const callbacks = {
    maxConcurrency: options.maxConcurrency ?? 2,
    store: options.store ?? null,
    execute(context) {
      starts.push(context);
      return options.execute?.(context);
    },
    interrupt(context) {
      interrupts.push(context);
      return options.interrupt?.(context);
    },
    requestApproval(context) {
      approvals.push(context);
      return options.requestApproval?.(context);
    },
    verifyReceipt({ receipt }) {
      return validReceipts.has(receipt.receiptId);
    },
  };
  return {
    callbacks, starts, interrupts, approvals,
    receipt(context, outcome, evidenceRefs = []) {
      const receipt = {
        receiptId: `native-${++sequence}`,
        outcome,
        binding: structuredClone(context.binding),
        evidenceRefs,
      };
      validReceipts.add(receipt.receiptId);
      return receipt;
    },
    trust(receipt) { validReceipts.add(receipt.receiptId); },
  };
}

test('validates graph closure and binds an explicit request before any native start', async () => {
  const native = harness();
  const runtime = await openTaskGraph(native.callbacks);
  const missing = graph([['a', ['missing']]], 'missing');
  await assert.rejects(runtime.submitGraph(missing), { code: 'E_TASK_INPUT' });
  const cycle = graph([['a', ['b']], ['b', ['a']]], 'cycle');
  await assert.rejects(runtime.submitGraph(cycle), { code: 'E_TASK_INPUT' });
  const spec = graph([['a'], ['b', ['a']]]);
  assert.equal((await runtime.submitGraph(spec)).tasks[0].status, 'queued');
  assert.equal(native.starts.length, 0);
  assert.equal(runtime.getEvents().length, 1);
  await runtime.submitGraph(spec);
  assert.equal(runtime.getEvents().length, 1);
  await assert.rejects(runtime.submitGraph({ ...spec, requestedBy: 'other-user' }),
    { code: 'E_TASK_IDEMPOTENCY' });
  await assert.rejects(runtime.activateGraph({ ...scope(spec), runId: 'wrong-run' }),
    { code: 'E_TASK_SCOPE' });
  await assert.rejects(runtime.activateGraph({ ...scope(spec), requestedBy: 'other-user' }),
    { code: 'E_TASK_SCOPE' });
  await runtime.activateGraph(scope(spec));
  assert.deepEqual(native.starts.map((entry) => entry.binding.taskId), ['a']);
  assert.equal(task(runtime, spec.graphId, 'b').status, 'waiting-on-dependency');
  assert.deepEqual(native.starts[0].binding, {
    graphId: 'graph-one', requestId: 'request-one', runId: 'run-one',
    parentTaskId: null, requestedBy: 'local-user', taskId: 'a',
    ownerId: 'agent-a', sourceRef: 'source-a', attemptId: 'graph-one:a:1',
  });
});

test('bounded siblings retain verified evidence and failure blocks dependents only', async () => {
  const native = harness({ maxConcurrency: 2 });
  const runtime = await openTaskGraph(native.callbacks);
  const spec = graph([['a'], ['b'], ['c', ['a']], ['d', ['b']], ['e', ['c', 'd']]]);
  await runtime.submitGraph(spec);
  await runtime.activateGraph(scope(spec));
  assert.deepEqual(native.starts.map((entry) => entry.binding.taskId), ['a', 'b']);
  const untrusted = { receiptId: 'untrusted', outcome: 'completed',
    binding: structuredClone(native.starts[0].binding), evidenceRefs: ['evidence-a'] };
  await assert.rejects(runtime.recordOutcome(untrusted), { code: 'E_TASK_RECEIPT' });
  assert.equal(task(runtime, spec.graphId, 'c').status, 'waiting-on-dependency');
  const aReceipt = native.receipt(native.starts[0], 'completed', ['evidence-a']);
  await runtime.recordOutcome(aReceipt);
  assert.deepEqual(native.starts.map((entry) => entry.binding.taskId), ['a', 'b', 'c']);
  assert.deepEqual(native.starts[2].dependencyReceipts,
    [{ taskId: 'a', receiptId: aReceipt.receiptId, evidenceRefs: ['evidence-a'] }]);
  const bFailure = native.receipt(native.starts[1], 'failed', ['failure-b']);
  await runtime.recordOutcome(bFailure);
  const cReceipt = native.receipt(native.starts[2], 'completed', ['evidence-c']);
  await runtime.recordOutcome(cReceipt);
  assert.equal(task(runtime, spec.graphId, 'a').status, 'completed');
  assert.equal(task(runtime, spec.graphId, 'c').status, 'completed');
  assert.equal(task(runtime, spec.graphId, 'd').status, 'waiting-on-dependency');
  assert.deepEqual(task(runtime, spec.graphId, 'd').blockedBy,
    [{ taskId: 'b', status: 'failed' }]);
  assert.equal(task(runtime, spec.graphId, 'e').status, 'waiting-on-dependency');
  assert.equal(native.starts.length, 3);
  await runtime.recordOutcome(aReceipt);
  assert.equal(native.starts.length, 3);
  assert.equal(runtime.getEvents().filter((event) => event.type === 'task-outcome-recorded').length, 3);
});

test('successful sibling tasks feed one integration task with both exact receipts', async () => {
  const native = harness({ maxConcurrency: 2 });
  const runtime = await openTaskGraph(native.callbacks);
  const spec = graph([['report'], ['deck'], ['integrate', ['report', 'deck']]], 'integration');
  await runtime.submitGraph(spec);
  await runtime.activateGraph(scope(spec));
  assert.deepEqual(native.starts.map((entry) => entry.binding.taskId), ['deck', 'report']);
  const deckReceipt = native.receipt(native.starts[0], 'completed', ['deck-output']);
  await runtime.recordOutcome(deckReceipt);
  assert.equal(task(runtime, spec.graphId, 'integrate').status, 'waiting-on-dependency');
  const reportReceipt = native.receipt(native.starts[1], 'completed', ['report-output']);
  await runtime.recordOutcome(reportReceipt);
  assert.equal(native.starts[2].binding.taskId, 'integrate');
  assert.deepEqual(native.starts[2].dependencyReceipts,
    [{ taskId: 'deck', receiptId: deckReceipt.receiptId, evidenceRefs: ['deck-output'] },
      { taskId: 'report', receiptId: reportReceipt.receiptId, evidenceRefs: ['report-output'] }]);
  await runtime.recordOutcome(native.receipt(native.starts[2], 'completed', ['integrated-result']));
  assert.equal(task(runtime, spec.graphId, 'integrate').status, 'completed');
});

test('approval requires native evidence and preserves exact owner/source binding', async () => {
  const native = harness();
  const runtime = await openTaskGraph(native.callbacks);
  const spec = graph([['a', [], { approvalRequired: true }], ['b', ['a']]]);
  await runtime.submitGraph(spec);
  await runtime.activateGraph(scope(spec));
  assert.equal(task(runtime, spec.graphId, 'a').status, 'approval-required');
  assert.equal(native.starts.length, 0);
  assert.equal(native.approvals.length, 1);
  const wrongBinding = native.receipt(native.approvals[0], 'approved');
  wrongBinding.binding.ownerId = 'other-agent';
  await assert.rejects(runtime.approveTask(wrongBinding), { code: 'E_TASK_RECEIPT' });
  assert.equal(native.starts.length, 0);
  const approval = native.receipt(native.approvals[0], 'approved', ['approval-record']);
  await runtime.approveTask(approval);
  assert.deepEqual(native.starts.map((entry) => entry.binding.taskId), ['a']);
  assert.equal(native.starts[0].approvalReceiptId, approval.receiptId);
  await runtime.recordOutcome(native.receipt(native.starts[0], 'completed', ['result-a']));
  assert.deepEqual(native.starts.map((entry) => entry.binding.taskId), ['a', 'b']);
});

test('cancellation fences starts, requires native stop confirmation, and keeps late evidence terminal', async () => {
  const native = harness({ maxConcurrency: 1 });
  const runtime = await openTaskGraph(native.callbacks);
  const spec = graph([['a'], ['b', ['a']], ['c']]);
  await runtime.submitGraph(spec);
  await runtime.activateGraph(scope(spec));
  assert.deepEqual(native.starts.map((entry) => entry.binding.taskId), ['a']);
  await runtime.cancelGraph(scope(spec));
  assert.equal(task(runtime, spec.graphId, 'a').status, 'running');
  assert.equal(task(runtime, spec.graphId, 'b').status, 'cancelled');
  assert.equal(task(runtime, spec.graphId, 'c').status, 'cancelled');
  assert.equal(native.interrupts.length, 1);
  await runtime.cancelGraph(scope(spec));
  assert.equal(native.interrupts.length, 1);
  const stop = native.receipt(native.interrupts[0], 'cancelled', ['stop-ack']);
  await runtime.confirmCancellation(stop);
  assert.equal(task(runtime, spec.graphId, 'a').status, 'cancelled');
  const late = native.receipt(native.starts[0], 'completed', ['late-result']);
  await runtime.recordOutcome(late);
  assert.equal(task(runtime, spec.graphId, 'a').status, 'cancelled');
  assert.deepEqual(task(runtime, spec.graphId, 'a').lateOutcomes.map((entry) => entry.receiptId),
    [late.receiptId]);
  assert.equal(native.starts.length, 1);
});

test('retry creates a new attempt without rewriting the failed receipt', async () => {
  const native = harness({ maxConcurrency: 1 });
  const runtime = await openTaskGraph(native.callbacks);
  const spec = graph([['a'], ['b', ['a']]]);
  await runtime.submitGraph(spec);
  await runtime.activateGraph(scope(spec));
  const failure = native.receipt(native.starts[0], 'failed', ['failure-a']);
  await runtime.recordOutcome(failure);
  assert.equal(task(runtime, spec.graphId, 'b').status, 'waiting-on-dependency');
  await runtime.retryTask({ ...scope(spec), taskId: 'a', operationId: 'retry-a-1' });
  assert.equal(native.starts[1].binding.attemptId, 'graph-one:a:2');
  await runtime.retryTask({ ...scope(spec), taskId: 'a', operationId: 'retry-a-1' });
  assert.equal(native.starts.length, 2);
  assert.equal(task(runtime, spec.graphId, 'a').attempts[0].receipt.receiptId, failure.receiptId);
  await runtime.recordOutcome(native.receipt(native.starts[1], 'completed', ['result-a']));
  assert.equal(native.starts[2].binding.taskId, 'b');
});

test('restart never dispatches until explicit reconciliation and resume', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'egdesk-task-graph-'));
  try {
    const firstNative = harness({ store: await openTaskStore(directory), maxConcurrency: 1 });
    const first = await openTaskGraph(firstNative.callbacks);
    const spec = graph([['a'], ['b', ['a']]]);
    await first.submitGraph(spec);
    await first.activateGraph(scope(spec));
    assert.equal(firstNative.starts.length, 1);
    const secondNative = harness({ store: await openTaskStore(directory), maxConcurrency: 1 });
    const second = await openTaskGraph(secondNative.callbacks);
    assert.equal(second.getGraph(spec.graphId).recoveryHold, true);
    assert.equal(secondNative.starts.length, 0);
    await assert.rejects(second.resumeGraph(scope(spec)), { code: 'E_TASK_RECONCILE' });
    const completion = secondNative.receipt(firstNative.starts[0], 'completed', ['reconciled-a']);
    await second.recordOutcome(completion);
    assert.equal(secondNative.starts.length, 0);
    await second.resumeGraph(scope(spec));
    assert.deepEqual(secondNative.starts.map((entry) => entry.binding.taskId), ['b']);
    assert.equal(secondNative.starts[0].dependencyReceipts[0].receiptId, completion.receiptId);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('native callback uncertainty does not become a fake failure or a retry', async () => {
  const native = harness({ execute: () => { throw new Error('unknown native outcome'); } });
  const runtime = await openTaskGraph(native.callbacks);
  const spec = graph([['a'], ['b', ['a']]]);
  await runtime.submitGraph(spec);
  await runtime.activateGraph(scope(spec));
  for (let index = 0; index < 10 && !task(runtime, spec.graphId, 'a').uncertain; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(task(runtime, spec.graphId, 'a').status, 'running');
  assert.equal(task(runtime, spec.graphId, 'a').uncertain, true);
  assert.equal(task(runtime, spec.graphId, 'b').status, 'waiting-on-dependency');
  assert.equal(native.starts.length, 1);
});

test('concurrent same-ID submissions and receipts do not duplicate starts or events', async () => {
  const native = harness({ maxConcurrency: 1 });
  const runtime = await openTaskGraph(native.callbacks);
  const spec = graph([['a'], ['b', ['a']]]);
  await Promise.all([runtime.submitGraph(spec), runtime.submitGraph(spec)]);
  assert.equal(runtime.getEvents().filter((event) => event.type === 'graph-submitted').length, 1);
  await Promise.all([runtime.activateGraph(scope(spec)), runtime.activateGraph(scope(spec))]);
  assert.equal(native.starts.length, 1);
  const completed = native.receipt(native.starts[0], 'completed', ['result-a']);
  await Promise.all([runtime.recordOutcome(completed), runtime.recordOutcome(completed)]);
  assert.equal(runtime.getEvents().filter((event) => event.type === 'task-outcome-recorded').length, 1);
  assert.equal(native.starts.length, 2);
});

test('old receipt remains idempotent after a failed attempt is retried', async () => {
  const native = harness({ maxConcurrency: 1 });
  const runtime = await openTaskGraph(native.callbacks);
  const spec = graph([['a']]);
  await runtime.submitGraph(spec);
  await runtime.activateGraph(scope(spec));
  const failure = native.receipt(native.starts[0], 'failed', ['failed-attempt']);
  await runtime.recordOutcome(failure);
  await runtime.retryTask({ ...scope(spec), taskId: 'a', operationId: 'retry-a-1' });
  await runtime.recordOutcome(failure);
  assert.equal(task(runtime, spec.graphId, 'a').status, 'running');
  assert.equal(task(runtime, spec.graphId, 'a').attempts.length, 2);
});

test('cancel during a pending dispatch never starts after the cancel event', async () => {
  let releaseStart;
  let reportStart;
  const gate = new Promise((resolve) => { releaseStart = resolve; });
  const startSaving = new Promise((resolve) => { reportStart = resolve; });
  const store = {
    async load() { return []; },
    async save(events) {
      if (events.at(-1).type === 'task-started') {
        reportStart();
        await gate;
      }
    },
  };
  const native = harness({ store, maxConcurrency: 1 });
  const runtime = await openTaskGraph(native.callbacks);
  const spec = graph([['a'], ['b']]);
  await runtime.submitGraph(spec);
  const activating = runtime.activateGraph(scope(spec));
  await startSaving;
  const cancelling = runtime.cancelGraph(scope(spec));
  releaseStart();
  await Promise.all([activating, cancelling]);
  const events = runtime.getEvents();
  const cancelIndex = events.findIndex((event) => event.type === 'graph-cancel-requested');
  assert(cancelIndex >= 0);
  assert.equal(events.slice(cancelIndex + 1).some((event) => event.type === 'task-started'), false);
  if (native.starts.length === 0) {
    assert.equal(task(runtime, spec.graphId, 'a').status, 'cancelled');
    assert.equal(native.interrupts.length, 0);
  } else {
    assert.equal(native.starts.length, 1);
    assert.equal(native.interrupts.length, 1);
  }
  assert.equal(native.starts.some((entry) => entry.binding.taskId === 'b'), false);
});

test('recovered running attempt cannot be cancelled as an undispatched local claim', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'egdesk-task-recovery-cancel-'));
  try {
    const firstNative = harness({ store: await openTaskStore(directory), maxConcurrency: 1 });
    const first = await openTaskGraph(firstNative.callbacks);
    const spec = graph([['a'], ['dependent', ['a']]], 'recovered');
    await first.submitGraph(spec);
    await first.activateGraph(scope(spec));
    assert.equal(firstNative.starts.length, 1);

    // Simulates reopening the journal while the native attempt may still live.
    const recoveredNative = harness({ store: await openTaskStore(directory), maxConcurrency: 1 });
    const recovered = await openTaskGraph(recoveredNative.callbacks);
    await recovered.cancelGraph(scope(spec));
    assert.equal(recoveredNative.interrupts.length, 1);
    assert.deepEqual(recoveredNative.interrupts[0].binding, firstNative.starts[0].binding);
    assert.equal(task(recovered, spec.graphId, 'a').status, 'running');
    assert.equal(task(recovered, spec.graphId, 'dependent').status, 'cancelled');
    assert.equal(recovered.getEvents().some((event) => event.type === 'task-dispatch-skipped'), false);
    await assert.rejects(recovered.resumeGraph(scope(spec)), { code: 'E_TASK_RECONCILE' });

    const unrelated = graph([['free']], 'unrelated');
    await recovered.submitGraph(unrelated);
    await recovered.activateGraph(scope(unrelated));
    assert.equal(task(recovered, unrelated.graphId, 'free').status, 'ready');
    assert.equal(recoveredNative.starts.length, 0, 'uncertain native attempt retains its slot');

    const stopReceipt = recoveredNative.receipt(recoveredNative.interrupts[0], 'cancelled', ['native-stop']);
    await recovered.confirmCancellation(stopReceipt);
    assert.equal(task(recovered, spec.graphId, 'a').status, 'cancelled');
    assert.deepEqual(recoveredNative.starts.map((entry) => entry.binding.taskId), ['free']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('CHAT-06 question gates: response is canonical, opens only with a fitting answer, and the answer is journaled', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'egdesk-question-gates-'));
  const stores = [];
  t.after(async () => { for (const store of stores) store.close(); await rm(directory, { recursive: true, force: true }); });
  const openStore = async () => { const store = await openTaskStore(directory); stores.push(store); return store; };
  const h = harness({ store: await openStore() });
  const runtime = await openTaskGraph(h.callbacks);
  t.after(() => runtime.close());
  const withGates = (gates, suffix) => { const value = graph([['ask']], suffix); value.tasks[0].gates = gates; return value; };
  for (const [response, message] of [
    [{ kind: 'choice', options: [{ id: 'a', label: 'A' }] }, /2-6 options/],
    [{ kind: 'choice', options: Array.from({ length: 7 }, (_, index) => ({ id: `o${index}`, label: `O${index}` })) }, /2-6 options/],
    [{ kind: 'choice', options: [{ id: 'a', label: 'A' }, { id: 'a', label: 'B' }] }, /duplicate option/],
    [{ kind: 'choice', options: [{ id: '../a', label: 'A' }, { id: 'b', label: 'B' }] }, /option id/],
    [{ kind: 'choice', options: [{ id: 'a', label: '' }, { id: 'b', label: 'B' }] }, /option label/],
    [{ kind: 'text', maxLength: 501 }, /maxLength/],
    [{ kind: 'number' }, /choice or text/],
    [{ kind: 'text', placeholder: 'x' }, /invalid shape/],
  ]) {
    await assert.rejects(runtime.submitGraph(withGates([{ gateId: 'q', kind: 'userAction', label: 'Q', response }], `bad-${Math.random().toString(36).slice(2)}`)),
      { code: 'E_TASK_INPUT', message });
  }
  await assert.rejects(runtime.submitGraph(withGates([{ gateId: 'q', kind: 'terminalExit', sessionId: 'term-1', response: { kind: 'text' } }], 'bad-kind')),
    { code: 'E_TASK_INPUT' }, 'only userAction gates ask');

  const value = withGates([
    { gateId: 'pick', kind: 'userAction', label: '어느 쪽?', response: { kind: 'choice', options: [{ id: 'fast', label: '빠른 길' }, { id: 'safe', label: '안전한 길' }] } },
    { gateId: 'memo', kind: 'userAction', label: '메모', response: { kind: 'text', maxLength: 100 } },
  ], 'question');
  await runtime.submitGraph(value);
  await runtime.activateGraph(scope(value));
  const gates = task(runtime, value.graphId, 'ask').gates;
  assert.deepEqual(gates.map((gate) => [gate.gateId, gate.response.kind]), [['memo', 'text'], ['pick', 'choice']]);
  assert.deepEqual(gates.find((gate) => gate.gateId === 'pick').response.options.map((option) => option.id), ['fast', 'safe'], 'options keep their order');
  const evidence = (extra = {}) => ({ eventId: `wfe-${Math.random().toString(36).slice(2)}`, topic: 'user.action', at: new Date().toISOString(), ...extra });

  // The router's bare user.action, a wrong option, the wrong kind or another topic never opens a question.
  for (const [gateId, input, code] of [
    ['pick', evidence(), 'E_TASK_ANSWER'], ['pick', evidence({ answer: { choice: 'slow' } }), 'E_TASK_ANSWER'],
    ['pick', evidence({ answer: { textRef: 'task-answer-1' } }), 'E_TASK_ANSWER'], ['memo', evidence({ answer: { choice: 'fast' } }), 'E_TASK_ANSWER'],
    ['memo', { ...evidence({ answer: { textRef: 'task-answer-1' } }), topic: 'terminal.exit' }, 'E_TASK_INPUT'],
    ['pick', evidence({ answer: { choice: 'fast', textRef: 'task-answer-1' } }), 'E_TASK_INPUT'],
  ]) {
    await assert.rejects(runtime.satisfyGate({ graphId: value.graphId, taskId: 'ask', gateId, evidence: input }), { code }, `${gateId} ${JSON.stringify(input.answer)}`);
  }
  assert.equal(task(runtime, value.graphId, 'ask').status, 'waiting-on-dependency');
  await runtime.satisfyGate({ graphId: value.graphId, taskId: 'ask', gateId: 'pick', evidence: evidence({ answer: { choice: 'safe' } }) });
  assert.equal(h.starts.length, 0, 'one question still open');
  await runtime.satisfyGate({ graphId: value.graphId, taskId: 'ask', gateId: 'memo', evidence: evidence({ answer: { textRef: 'task-answer-7' } }) });
  assert.equal(h.starts.length, 1, 'both answered: the step starts');
  const answered = task(runtime, value.graphId, 'ask').gates;
  assert.deepEqual(answered.map((gate) => [gate.gateId, gate.status, gate.answer]), [['memo', 'satisfied', { kind: 'text' }], ['pick', 'satisfied', { kind: 'choice', choice: 'safe' }]]);
  assert.equal(JSON.stringify(answered).includes('task-answer-7'), false, 'the text reference stays out of the visible graph');
  assert.deepEqual(runtime.gateAnswers(value.graphId, 'ask'), [{ gateId: 'memo', textRef: 'task-answer-7' }, { gateId: 'pick', choice: 'safe' }]);
  assert.deepEqual(runtime.gateAnswers(value.graphId, 'missing'), []);

  // A gate without a question takes no answer.
  const plain = withGates([{ gateId: 'ok', kind: 'userAction', label: 'OK?' }], 'plain');
  await runtime.submitGraph(plain);
  await runtime.activateGraph(scope(plain));
  await assert.rejects(runtime.satisfyGate({ graphId: plain.graphId, taskId: 'ask', gateId: 'ok', evidence: evidence({ answer: { choice: 'fast' } }) }), { code: 'E_TASK_ANSWER' });

  // Journaled answers replay; a journal row whose answer does not fit is refused.
  await runtime.drain();
  const reopened = await openTaskGraph(harness({ store: await openStore() }).callbacks);
  t.after(() => reopened.close());
  assert.deepEqual(reopened.gateAnswers(value.graphId, 'ask'), runtime.gateAnswers(value.graphId, 'ask'));
  const events = runtime.getEvents();
  const forged = events.map((event) => event.type === 'task-gate-satisfied' && event.gateId === 'pick'
    ? { ...event, evidence: { ...event.evidence, answer: { choice: 'slow' } } } : event);
  await assert.rejects(openTaskGraph({ ...h.callbacks, store: { load: async () => forged, save: async () => {} } }), { code: 'E_TASK_JOURNAL' });
});

test('normalizeGateAnswer: the request form of an answer, checked against the question', async () => {
  const { normalizeGateAnswer } = await import('./egdesk-task-graph.mjs');
  const choice = { gateId: 'q', kind: 'userAction', response: { kind: 'choice', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] } };
  const text = { gateId: 'q', kind: 'userAction', response: { kind: 'text' } };
  assert.deepEqual(normalizeGateAnswer(choice, { choice: 'b' }), { choice: 'b' });
  assert.deepEqual(normalizeGateAnswer(text, { text: ' 줄1\r\n줄2 ' }), { text: '줄1\n줄2' });
  assert.equal(normalizeGateAnswer({ gateId: 'q', kind: 'oauth' }, undefined), undefined);
  assert.equal(normalizeGateAnswer(text, { text: '가'.repeat(500) }).text.length, 500);
  for (const [gate, answer] of [[choice, undefined], [choice, { choice: 'c' }], [text, { text: '' }], [text, { text: '가'.repeat(501) }],
    [text, { text: 'tab\tok but bell \u0007' }], [{ gateId: 'q', kind: 'file' }, { text: 'x' }], [choice, { choice: 'a', extra: 1 }]]) {
    assert.throws(() => normalizeGateAnswer(gate, answer), { code: 'E_TASK_ANSWER' }, JSON.stringify(answer));
  }
});
