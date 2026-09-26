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
