/**
 * Local dependency scheduler. It stores only opaque IDs and evidence references;
 * native task payloads, credentials, and external side effects belong to adapters.
 *
 * openTaskGraph({ store?, maxConcurrency, execute, interrupt, requestApproval,
 *                 verifyReceipt }) -> runtime
 * runtime.submitGraph(graph), activateGraph({ graphId, requestId, runId,
 *                                            parentTaskId, requestedBy }),
 *         recordOutcome(receipt), approveTask(receipt), confirmCancellation(receipt),
 *         cancelGraph(scope), retryTask({...scope, taskId, operationId}),
 *         resumeGraph(scope), getGraph(id), getEvents(id?).
 *
 * All receipts carry { receiptId, outcome, binding, evidenceRefs } and are checked
 * against the exact binding sent to the native adapter. verifyReceipt must confirm
 * actual native evidence; a self-declared "verified" flag is never accepted.
 */

const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
const TASK_STATES = new Set(['running', 'completed', 'failed', 'cancelled']);

function error(code, message) {
  const result = new Error(message);
  result.code = code;
  return result;
}

function assert(condition, code, message) {
  if (!condition) throw error(code, message);
}

function id(value, name) {
  assert(typeof value === 'string' && value.length <= 256 && ID.test(value),
    'E_TASK_INPUT', `${name} must be an opaque, nonempty reference ID`);
  return value;
}

function object(value, name, keys) {
  assert(value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).every((key) => keys.includes(key)),
  'E_TASK_INPUT', `${name} has an invalid shape`);
  return value;
}

function clone(value) {
  return structuredClone(value);
}

function frozen(value) {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    for (const child of Object.values(value)) frozen(child);
  }
  return value;
}

function normalizeGraph(input) {
  object(input, 'graph', ['graphId', 'requestId', 'runId', 'parentTaskId', 'requestedBy', 'tasks']);
  const graphId = id(input.graphId, 'graphId');
  const requestId = id(input.requestId, 'requestId');
  const runId = id(input.runId, 'runId');
  assert(Object.hasOwn(input, 'parentTaskId'), 'E_TASK_INPUT', 'parentTaskId must be explicit, even when null');
  const parentTaskId = input.parentTaskId === null ? null : id(input.parentTaskId, 'parentTaskId');
  const requestedBy = id(input.requestedBy, 'requestedBy');
  assert(Array.isArray(input.tasks) && input.tasks.length > 0 && input.tasks.length <= 256,
    'E_TASK_INPUT', 'graph must contain 1–256 tasks');
  const tasks = input.tasks.map((task) => {
    object(task, 'task', ['taskId', 'ownerId', 'sourceRef', 'dependsOn', 'approvalRequired']);
    assert(Array.isArray(task.dependsOn) && task.dependsOn.length <= 256,
      'E_TASK_INPUT', 'dependsOn must be an array');
    assert(task.approvalRequired === undefined || typeof task.approvalRequired === 'boolean',
      'E_TASK_INPUT', 'approvalRequired must be boolean');
    const dependsOn = task.dependsOn.map((dependency) => id(dependency, 'dependency ID')).sort();
    assert(new Set(dependsOn).size === dependsOn.length, 'E_TASK_INPUT', 'duplicate dependency');
    return {
      taskId: id(task.taskId, 'taskId'),
      ownerId: id(task.ownerId, 'ownerId'),
      sourceRef: id(task.sourceRef, 'sourceRef'),
      dependsOn,
      approvalRequired: task.approvalRequired === true,
    };
  }).sort((a, b) => a.taskId.localeCompare(b.taskId));
  const byId = new Map(tasks.map((task) => [task.taskId, task]));
  assert(byId.size === tasks.length, 'E_TASK_INPUT', 'duplicate task ID');
  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      assert(byId.has(dependency), 'E_TASK_INPUT', `missing dependency ${dependency}`);
      assert(dependency !== task.taskId, 'E_TASK_INPUT', 'task cannot depend on itself');
    }
  }
  const visited = new Set();
  const visiting = new Set();
  function visit(taskId) {
    assert(!visiting.has(taskId), 'E_TASK_INPUT', 'dependency cycle');
    if (visited.has(taskId)) return;
    visiting.add(taskId);
    for (const dependency of byId.get(taskId).dependsOn) visit(dependency);
    visiting.delete(taskId);
    visited.add(taskId);
  }
  for (const task of tasks) visit(task.taskId);
  return { graphId, requestId, runId, parentTaskId, requestedBy, tasks };
}

function binding(graph, task, attemptId = null) {
  return {
    graphId: graph.spec.graphId,
    requestId: graph.spec.requestId,
    runId: graph.spec.runId,
    parentTaskId: graph.spec.parentTaskId,
    requestedBy: graph.spec.requestedBy,
    taskId: task.spec.taskId,
    ownerId: task.spec.ownerId,
    sourceRef: task.spec.sourceRef,
    attemptId,
  };
}

function nextAttemptId(graph, task) {
  // Percent-encoding keeps the graph/task boundary unambiguous even when an ID
  // itself contains a colon or slash.
  return `${encodeURIComponent(graph.spec.graphId)}:${encodeURIComponent(task.spec.taskId)}:${task.attempts.length + 1}`;
}

function normalizeReceipt(input, expected, outcome) {
  object(input, 'receipt', ['receiptId', 'outcome', 'binding', 'evidenceRefs']);
  assert(input.outcome === outcome, 'E_TASK_RECEIPT', 'receipt outcome mismatch');
  const receiptId = id(input.receiptId, 'receiptId');
  object(input.binding, 'receipt binding', Object.keys(expected));
  assert(Object.keys(expected).length === Object.keys(input.binding).length &&
    Object.keys(expected).every((key) => input.binding[key] === expected[key]),
  'E_TASK_RECEIPT', 'receipt binding mismatch');
  assert(Array.isArray(input.evidenceRefs) && input.evidenceRefs.length <= 32,
    'E_TASK_RECEIPT', 'evidenceRefs must be a bounded array');
  const evidenceRefs = input.evidenceRefs.map((ref) => id(ref, 'evidenceRef'));
  assert(new Set(evidenceRefs).size === evidenceRefs.length,
    'E_TASK_RECEIPT', 'duplicate evidence reference');
  return { receiptId, outcome, binding: clone(expected), evidenceRefs };
}

function taskStatus(graph, task) {
  if (TASK_STATES.has(task.state)) return task.state;
  if (graph.cancelRequested) return 'cancelled';
  if (!graph.activated) return 'queued';
  if (task.spec.dependsOn.some((dependency) => {
    const upstream = graph.tasks.get(dependency);
    return upstream.state !== 'completed' || !upstream.receipt;
  })) return 'waiting-on-dependency';
  if (task.spec.approvalRequired && task.approvalReceipt?.outcome !== 'approved') {
    return 'approval-required';
  }
  return 'ready';
}

function project(events) {
  const graphs = new Map();
  const requestKeys = new Map();
  const receiptIds = new Map();
  const retryIds = new Set();
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    assert(event?.seq === index + 1 && typeof event.at === 'string' && typeof event.type === 'string',
      'E_TASK_JOURNAL', 'invalid event sequence');
    if (event.type === 'graph-submitted') {
      const spec = normalizeGraph(event.graph);
      assert(JSON.stringify(spec) === JSON.stringify(event.graph), 'E_TASK_JOURNAL', 'noncanonical graph event');
      const key = `${spec.runId}\0${spec.requestId}`;
      assert(!graphs.has(spec.graphId) && !requestKeys.has(key),
        'E_TASK_JOURNAL', 'duplicate graph or request ID');
      const tasks = new Map(spec.tasks.map((task) => [task.taskId, {
        spec: task, state: null, attempts: [], receipt: null,
        approvalRequested: false, approvalReceipt: null,
        uncertain: false, interruptUncertain: false, approvalDeliveryUncertain: false,
        lateOutcomes: [],
      }]));
      graphs.set(spec.graphId, { spec, tasks, activated: false, cancelRequested: false });
      requestKeys.set(key, spec.graphId);
      continue;
    }
    const graph = graphs.get(event.graphId);
    assert(graph, 'E_TASK_JOURNAL', 'event references missing graph');
    const task = event.taskId ? graph.tasks.get(event.taskId) : null;
    if (event.taskId) assert(task, 'E_TASK_JOURNAL', 'event references missing task');
    switch (event.type) {
      case 'graph-activated':
        assert(!graph.activated && !graph.cancelRequested, 'E_TASK_JOURNAL', 'invalid activation');
        graph.activated = true;
        break;
      case 'graph-cancel-requested':
        assert(!graph.cancelRequested, 'E_TASK_JOURNAL', 'duplicate cancellation');
        graph.cancelRequested = true;
        break;
      case 'graph-resumed':
        assert(graph.activated, 'E_TASK_JOURNAL', 'inactive graph cannot resume');
        break;
      case 'task-approval-requested':
        assert(taskStatus(graph, task) === 'approval-required' && !task.approvalRequested,
          'E_TASK_JOURNAL', 'invalid approval request');
        task.approvalRequested = true;
        break;
      case 'task-approval-resolved':
        assert(taskStatus(graph, task) === 'approval-required' && task.approvalRequested &&
          ['approved', 'rejected'].includes(event.receipt?.outcome),
        'E_TASK_JOURNAL', 'invalid approval decision');
        assert(JSON.stringify(normalizeReceipt(event.receipt, binding(graph, task),
          event.receipt.outcome)) === JSON.stringify(event.receipt),
        'E_TASK_JOURNAL', 'invalid approval receipt binding');
        task.approvalReceipt = event.receipt;
        if (event.receipt.outcome === 'rejected') task.state = 'cancelled';
        break;
      case 'task-started':
        assert(taskStatus(graph, task) === 'ready' &&
          event.attemptId === nextAttemptId(graph, task),
        'E_TASK_JOURNAL', 'invalid task start');
        task.state = 'running';
        task.uncertain = false;
        task.interruptUncertain = false;
        task.attempts.push({ attemptId: event.attemptId, status: 'running', receipt: null });
        break;
      case 'task-outcome-recorded': {
        const attempt = task.attempts.at(-1);
        assert(task.state === 'running' && attempt?.attemptId === event.receipt?.binding?.attemptId &&
          ['completed', 'failed'].includes(event.receipt?.outcome),
        'E_TASK_JOURNAL', 'invalid task outcome');
        assert(JSON.stringify(normalizeReceipt(event.receipt,
          binding(graph, task, attempt.attemptId), event.receipt.outcome)) === JSON.stringify(event.receipt),
        'E_TASK_JOURNAL', 'invalid task outcome binding');
        task.state = event.receipt.outcome;
        task.receipt = event.receipt;
        attempt.status = event.receipt.outcome;
        attempt.receipt = event.receipt;
        break;
      }
      case 'task-cancelled': {
        const attempt = task.attempts.at(-1);
        assert(graph.cancelRequested && task.state === 'running' &&
          attempt?.attemptId === event.receipt?.binding?.attemptId &&
          event.receipt?.outcome === 'cancelled',
        'E_TASK_JOURNAL', 'invalid cancellation confirmation');
        assert(JSON.stringify(normalizeReceipt(event.receipt,
          binding(graph, task, attempt.attemptId), 'cancelled')) === JSON.stringify(event.receipt),
        'E_TASK_JOURNAL', 'invalid cancellation receipt binding');
        task.state = 'cancelled';
        task.receipt = event.receipt;
        attempt.status = 'cancelled';
        attempt.receipt = event.receipt;
        break;
      }
      case 'task-dispatch-skipped': {
        const attempt = task.attempts.at(-1);
        assert(graph.cancelRequested && task.state === 'running' &&
          attempt?.attemptId === event.attemptId,
        'E_TASK_JOURNAL', 'invalid skipped dispatch');
        task.state = 'cancelled';
        attempt.status = 'cancelled';
        break;
      }
      case 'task-late-outcome':
        assert(task.state === 'cancelled' &&
          task.attempts.at(-1)?.attemptId === event.receipt?.binding?.attemptId &&
          ['completed', 'failed'].includes(event.receipt?.outcome),
        'E_TASK_JOURNAL', 'invalid late outcome');
        assert(JSON.stringify(normalizeReceipt(event.receipt,
          binding(graph, task, task.attempts.at(-1).attemptId), event.receipt.outcome)) ===
          JSON.stringify(event.receipt), 'E_TASK_JOURNAL', 'invalid late receipt binding');
        task.lateOutcomes.push(event.receipt);
        break;
      case 'task-execution-uncertain':
        assert(task.state === 'running' && task.attempts.at(-1)?.attemptId === event.attemptId,
          'E_TASK_JOURNAL', 'invalid uncertain execution');
        task.uncertain = true;
        break;
      case 'task-interrupt-uncertain':
        assert(graph.cancelRequested && task.state === 'running' &&
          task.attempts.at(-1)?.attemptId === event.attemptId,
        'E_TASK_JOURNAL', 'invalid uncertain interruption');
        task.interruptUncertain = true;
        break;
      case 'task-approval-delivery-uncertain':
        assert(taskStatus(graph, task) === 'approval-required' && task.approvalRequested,
          'E_TASK_JOURNAL', 'invalid uncertain approval delivery');
        task.approvalDeliveryUncertain = true;
        break;
      case 'task-retry-requested':
        assert(task.state === 'failed' && !graph.cancelRequested &&
          typeof event.operationId === 'string' && !retryIds.has(event.operationId),
        'E_TASK_JOURNAL', 'invalid retry');
        retryIds.add(event.operationId);
        task.state = null;
        task.receipt = null;
        task.approvalRequested = false;
        task.approvalReceipt = null;
        task.uncertain = false;
        break;
      default:
        throw error('E_TASK_JOURNAL', `unknown task event: ${event.type}`);
    }
    if (event.receipt) {
      const prior = receiptIds.get(event.receipt.receiptId);
      assert(!prior || JSON.stringify(prior) === JSON.stringify(event.receipt),
        'E_TASK_JOURNAL', 'receipt ID collision');
      receiptIds.set(event.receipt.receiptId, event.receipt);
    }
  }
  return { graphs, requestKeys, receiptIds, retryIds };
}

function visibleGraph(graph, recoveryHold) {
  return {
    ...clone(graph.spec),
    activated: graph.activated,
    cancelRequested: graph.cancelRequested,
    recoveryHold,
    tasks: [...graph.tasks.values()].map((task) => ({
      ...clone(task.spec),
      status: taskStatus(graph, task),
      blockedBy: task.spec.dependsOn.filter((dependency) => {
        const upstream = graph.tasks.get(dependency);
        return upstream.state !== 'completed' || !upstream.receipt;
      }).map((dependency) => ({
        taskId: dependency,
        status: taskStatus(graph, graph.tasks.get(dependency)),
      })),
      approvalRequested: task.approvalRequested,
      approvalReceipt: clone(task.approvalReceipt),
      receipt: clone(task.receipt),
      attempts: clone(task.attempts),
      uncertain: task.uncertain,
      interruptUncertain: task.interruptUncertain,
      approvalDeliveryUncertain: task.approvalDeliveryUncertain,
      lateOutcomes: clone(task.lateOutcomes),
    })),
  };
}

export async function openTaskGraph({ store = null, maxConcurrency = 2, execute, interrupt,
  requestApproval, verifyReceipt } = {}) {
  assert(Number.isSafeInteger(maxConcurrency) && maxConcurrency >= 1 && maxConcurrency <= 32,
    'E_TASK_INPUT', 'maxConcurrency must be 1–32');
  for (const [name, callback] of Object.entries({ execute, interrupt, requestApproval, verifyReceipt })) {
    assert(typeof callback === 'function', 'E_TASK_INPUT', `${name} callback is required`);
  }
  const events = store ? await store.load() : [];
  return new TaskGraphRuntime({ events, store, maxConcurrency, execute, interrupt,
    requestApproval, verifyReceipt });
}

class TaskGraphRuntime {
  #events;
  #projection;
  #store;
  #execute;
  #interrupt;
  #requestApproval;
  #verifyReceipt;
  #maxConcurrency;
  #recoveryHolds;
  #writeTail = Promise.resolve();
  #scheduling = null;
  #scheduleAgain = false;
  #listeners = new Set();
  #dispatched = new Set();

  constructor({ events, store, maxConcurrency, execute, interrupt, requestApproval, verifyReceipt }) {
    this.#events = clone(events);
    this.#projection = project(this.#events);
    this.#store = store;
    this.#maxConcurrency = maxConcurrency;
    this.#execute = execute;
    this.#interrupt = interrupt;
    this.#requestApproval = requestApproval;
    this.#verifyReceipt = verifyReceipt;
    // A reloaded active graph never dispatches, even if its last status was ready.
    this.#recoveryHolds = new Set(this.#projection.graphs.keys());
  }

  subscribe(listener) {
    assert(typeof listener === 'function', 'E_TASK_INPUT', 'listener must be a function');
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  getEvents(graphId = null) {
    return clone(graphId === null ? this.#events :
      this.#events.filter((event) => event.graphId === graphId ||
        (event.type === 'graph-submitted' && event.graph.graphId === graphId)));
  }

  getGraph(graphId) {
    const graph = this.#projection.graphs.get(graphId);
    return graph ? visibleGraph(graph, this.#recoveryHolds.has(graphId)) : null;
  }

  #scope(input) {
    object(input, 'graph scope', ['graphId', 'requestId', 'runId', 'parentTaskId', 'requestedBy']);
    const graph = this.#projection.graphs.get(id(input.graphId, 'graphId'));
    assert(graph && Object.hasOwn(input, 'parentTaskId') &&
      graph.spec.requestId === input.requestId && graph.spec.runId === input.runId &&
      graph.spec.parentTaskId === input.parentTaskId &&
      graph.spec.requestedBy === input.requestedBy,
    'E_TASK_SCOPE', 'graph request/Run/parent/owner binding mismatch');
    return graph;
  }

  async #append(fields) {
    const operation = this.#writeTail.then(async () => {
      const event = { seq: this.#events.length + 1, at: new Date().toISOString(), ...clone(fields) };
      const nextEvents = [...this.#events, event];
      const nextProjection = project(nextEvents);
      if (this.#store) await this.#store.save(nextEvents);
      this.#events = nextEvents;
      this.#projection = nextProjection;
      for (const listener of this.#listeners) {
        try { listener(clone(event)); } catch { /* observers do not alter the journal */ }
      }
      return event;
    });
    this.#writeTail = operation.catch(() => {});
    return operation;
  }

  async submitGraph(input) {
    const spec = normalizeGraph(input);
    const existing = this.#projection.graphs.get(spec.graphId);
    if (existing) {
      assert(JSON.stringify(existing.spec) === JSON.stringify(spec),
        'E_TASK_IDEMPOTENCY', 'same graph ID has different content');
      return this.getGraph(spec.graphId);
    }
    const requestKey = `${spec.runId}\0${spec.requestId}`;
    assert(!this.#projection.requestKeys.has(requestKey),
      'E_TASK_IDEMPOTENCY', 'same request/Run has another graph ID');
    try {
      await this.#append({ type: 'graph-submitted', graph: spec });
    } catch (cause) {
      if (cause.code !== 'E_TASK_JOURNAL') throw cause;
      const concurrent = this.#projection.graphs.get(spec.graphId);
      assert(concurrent && JSON.stringify(concurrent.spec) === JSON.stringify(spec),
        'E_TASK_IDEMPOTENCY', 'graph or request ID already has different content');
    }
    return this.getGraph(spec.graphId);
  }

  async activateGraph(scope) {
    const graph = this.#scope(scope);
    if (!graph.activated) {
      try {
        await this.#append({ type: 'graph-activated', graphId: graph.spec.graphId });
      } catch (cause) {
        if (cause.code !== 'E_TASK_JOURNAL' ||
            !this.#projection.graphs.get(graph.spec.graphId)?.activated) throw cause;
      }
    }
    await this.#schedule();
    return this.getGraph(graph.spec.graphId);
  }

  async resumeGraph(scope) {
    const graph = this.#scope(scope);
    assert(graph.activated, 'E_TASK_STATE', 'graph is not active');
    assert([...graph.tasks.values()].every((task) => task.state !== 'running'),
      'E_TASK_RECONCILE', 'running attempts require native reconciliation before resume');
    if (this.#recoveryHolds.has(graph.spec.graphId)) {
      await this.#append({ type: 'graph-resumed', graphId: graph.spec.graphId });
      this.#recoveryHolds.delete(graph.spec.graphId);
    }
    await this.#schedule();
    return this.getGraph(graph.spec.graphId);
  }

  async #checkedReceipt(input, expected, outcome) {
    const receipt = normalizeReceipt(input, expected, outcome);
    assert(await this.#verifyReceipt(frozen(clone({ receipt, expected, outcome }))) === true,
      'E_TASK_RECEIPT', 'native receipt was not verified');
    return receipt;
  }

  #findReceiptTarget(input) {
    const target = input?.binding;
    const graph = this.#projection.graphs.get(target?.graphId);
    const task = graph?.tasks.get(target?.taskId);
    assert(graph && task, 'E_TASK_SCOPE', 'receipt targets an unknown task');
    return { graph, task };
  }

  #alreadyRecorded(input) {
    const prior = this.#projection.receiptIds.get(input?.receiptId);
    if (!prior) return false;
    const repeated = normalizeReceipt(input, prior.binding, prior.outcome);
    assert(JSON.stringify(repeated) === JSON.stringify(prior),
      'E_TASK_IDEMPOTENCY', 'receipt ID collision');
    return true;
  }

  async recordOutcome(input) {
    assert(input?.outcome === 'completed' || input?.outcome === 'failed',
      'E_TASK_RECEIPT', 'outcome must be completed or failed');
    const { graph, task } = this.#findReceiptTarget(input);
    if (this.#alreadyRecorded(input)) return this.getGraph(graph.spec.graphId);
    const attempt = task.attempts.at(-1);
    assert(attempt, 'E_TASK_STATE', 'task has no native attempt');
    const receipt = await this.#checkedReceipt(input, binding(graph, task, attempt.attemptId), input.outcome);
    const prior = this.#projection.receiptIds.get(receipt.receiptId);
    if (prior) {
      assert(JSON.stringify(prior) === JSON.stringify(receipt),
        'E_TASK_IDEMPOTENCY', 'receipt ID collision');
      return this.getGraph(graph.spec.graphId);
    }
    const current = this.#projection.graphs.get(graph.spec.graphId).tasks.get(task.spec.taskId);
    try {
      if (current.state === 'cancelled') {
        await this.#append({ type: 'task-late-outcome', graphId: graph.spec.graphId,
          taskId: task.spec.taskId, receipt });
      } else {
        assert(current.state === 'running', 'E_TASK_STATE', 'task attempt is already terminal');
        await this.#append({ type: 'task-outcome-recorded', graphId: graph.spec.graphId,
          taskId: task.spec.taskId, receipt });
      }
    } catch (cause) {
      if (cause.code !== 'E_TASK_JOURNAL' ||
          JSON.stringify(this.#projection.receiptIds.get(receipt.receiptId)) !== JSON.stringify(receipt)) {
        throw cause;
      }
    }
    await this.#schedule();
    return this.getGraph(graph.spec.graphId);
  }

  async approveTask(input) {
    assert(input?.outcome === 'approved' || input?.outcome === 'rejected',
      'E_TASK_RECEIPT', 'approval outcome must be approved or rejected');
    const { graph, task } = this.#findReceiptTarget(input);
    if (this.#alreadyRecorded(input)) return this.getGraph(graph.spec.graphId);
    const receipt = await this.#checkedReceipt(input, binding(graph, task), input.outcome);
    const prior = this.#projection.receiptIds.get(receipt.receiptId);
    if (prior) {
      assert(JSON.stringify(prior) === JSON.stringify(receipt),
        'E_TASK_IDEMPOTENCY', 'receipt ID collision');
      return this.getGraph(graph.spec.graphId);
    }
    assert(taskStatus(graph, task) === 'approval-required' && task.approvalRequested,
      'E_TASK_STATE', 'task is not awaiting approval');
    try {
      await this.#append({ type: 'task-approval-resolved', graphId: graph.spec.graphId,
        taskId: task.spec.taskId, receipt });
    } catch (cause) {
      if (cause.code !== 'E_TASK_JOURNAL' ||
          JSON.stringify(this.#projection.receiptIds.get(receipt.receiptId)) !== JSON.stringify(receipt)) {
        throw cause;
      }
    }
    await this.#schedule();
    return this.getGraph(graph.spec.graphId);
  }

  async confirmCancellation(input) {
    assert(input?.outcome === 'cancelled', 'E_TASK_RECEIPT', 'cancellation receipt required');
    const { graph, task } = this.#findReceiptTarget(input);
    if (this.#alreadyRecorded(input)) return this.getGraph(graph.spec.graphId);
    const attempt = task.attempts.at(-1);
    assert(attempt, 'E_TASK_STATE', 'task has no native attempt');
    const receipt = await this.#checkedReceipt(input, binding(graph, task, attempt.attemptId), 'cancelled');
    const prior = this.#projection.receiptIds.get(receipt.receiptId);
    if (prior) {
      assert(JSON.stringify(prior) === JSON.stringify(receipt),
        'E_TASK_IDEMPOTENCY', 'receipt ID collision');
      return this.getGraph(graph.spec.graphId);
    }
    assert(graph.cancelRequested && task.state === 'running',
      'E_TASK_STATE', 'task is not awaiting native interruption');
    try {
      await this.#append({ type: 'task-cancelled', graphId: graph.spec.graphId,
        taskId: task.spec.taskId, receipt });
    } catch (cause) {
      if (cause.code !== 'E_TASK_JOURNAL' ||
          JSON.stringify(this.#projection.receiptIds.get(receipt.receiptId)) !== JSON.stringify(receipt)) {
        throw cause;
      }
    }
    await this.#schedule();
    return this.getGraph(graph.spec.graphId);
  }

  async cancelGraph(scope) {
    const graph = this.#scope(scope);
    if (graph.cancelRequested) return this.getGraph(graph.spec.graphId);
    try {
      await this.#append({ type: 'graph-cancel-requested', graphId: graph.spec.graphId });
    } catch (cause) {
      if (cause.code !== 'E_TASK_JOURNAL' ||
          !this.#projection.graphs.get(graph.spec.graphId)?.cancelRequested) throw cause;
      return this.getGraph(graph.spec.graphId);
    }
    const current = this.#projection.graphs.get(graph.spec.graphId);
    for (const task of current.tasks.values()) {
      if (task.state !== 'running') continue;
      const attemptId = task.attempts.at(-1).attemptId;
      if (this.#dispatched.has(attemptId)) this.#launchInterrupt(current, task);
      else await this.#append({ type: 'task-dispatch-skipped', graphId: graph.spec.graphId,
        taskId: task.spec.taskId, attemptId });
    }
    return this.getGraph(graph.spec.graphId);
  }

  async retryTask({ graphId, requestId, runId, parentTaskId, requestedBy, taskId, operationId }) {
    const graph = this.#scope({ graphId, requestId, runId, parentTaskId, requestedBy });
    id(taskId, 'taskId');
    id(operationId, 'operationId');
    if (this.#projection.retryIds.has(operationId)) {
      assert(this.#events.some((event) => event.type === 'task-retry-requested' &&
        event.operationId === operationId && event.graphId === graphId && event.taskId === taskId),
      'E_TASK_IDEMPOTENCY', 'retry operation ID belongs to another task');
      return this.getGraph(graphId);
    }
    const task = graph.tasks.get(taskId);
    assert(task?.state === 'failed' && !graph.cancelRequested,
      'E_TASK_STATE', 'only a failed task in an active graph can be retried');
    try {
      await this.#append({ type: 'task-retry-requested', graphId, taskId, operationId });
    } catch (cause) {
      if (cause.code !== 'E_TASK_JOURNAL' ||
          !this.#events.some((event) => event.type === 'task-retry-requested' &&
            event.operationId === operationId && event.graphId === graphId && event.taskId === taskId)) {
        throw cause;
      }
    }
    await this.#schedule();
    return this.getGraph(graphId);
  }

  #nextAction() {
    for (const graph of this.#projection.graphs.values()) {
      if (this.#recoveryHolds.has(graph.spec.graphId) || graph.cancelRequested || !graph.activated) continue;
      for (const task of graph.tasks.values()) {
        if (taskStatus(graph, task) === 'approval-required' && !task.approvalRequested) {
          return { kind: 'approval', graph, task };
        }
      }
    }
    const running = [...this.#projection.graphs.values()].reduce((count, graph) =>
      count + [...graph.tasks.values()].filter((task) => task.state === 'running').length, 0);
    if (running >= this.#maxConcurrency) return null;
    for (const graph of this.#projection.graphs.values()) {
      if (this.#recoveryHolds.has(graph.spec.graphId) || graph.cancelRequested || !graph.activated) continue;
      for (const task of graph.tasks.values()) {
        if (taskStatus(graph, task) === 'ready') return { kind: 'execute', graph, task };
      }
    }
    return null;
  }

  async #schedule() {
    this.#scheduleAgain = true;
    if (this.#scheduling) return this.#scheduling;
    const work = (async () => {
      while (this.#scheduleAgain) {
        this.#scheduleAgain = false;
        let action;
        while ((action = this.#nextAction())) {
          const { graph, task } = action;
          const beforeSeq = this.#events.length;
          try {
            if (action.kind === 'approval') {
              await this.#append({ type: 'task-approval-requested',
                graphId: graph.spec.graphId, taskId: task.spec.taskId });
              this.#launchApproval(graph, task);
            } else {
              const attemptId = nextAttemptId(graph, task);
              await this.#append({ type: 'task-started', graphId: graph.spec.graphId,
                taskId: task.spec.taskId, attemptId });
              this.#launchExecute(graph, task, attemptId);
            }
          } catch (cause) {
            if (cause.code !== 'E_TASK_JOURNAL' || this.#events.length === beforeSeq) throw cause;
          }
        }
      }
    })();
    this.#scheduling = work;
    try {
      await work;
    } finally {
      this.#scheduling = null;
      if (this.#scheduleAgain) await this.#schedule();
    }
  }

  #context(graph, task, attemptId = null) {
    return frozen({
      binding: binding(graph, task, attemptId),
      dependencyReceipts: task.spec.dependsOn.map((dependency) => {
        const upstream = graph.tasks.get(dependency);
        return { taskId: dependency, receiptId: upstream.receipt.receiptId,
          evidenceRefs: clone(upstream.receipt.evidenceRefs) };
      }),
      approvalReceiptId: task.approvalReceipt?.receiptId ?? null,
    });
  }

  #launchExecute(graph, task, attemptId) {
    const context = this.#context(graph, task, attemptId);
    const current = this.#projection.graphs.get(graph.spec.graphId);
    if (current.cancelRequested) return;
    this.#dispatched.add(attemptId);
    let nativeResult;
    try {
      nativeResult = this.#execute(context);
    } catch {
      nativeResult = Promise.reject(error('E_TASK_NATIVE', 'native execution callback failed'));
    }
    void Promise.resolve(nativeResult).then(async (receipt) => {
      if (receipt !== undefined) await this.recordOutcome(receipt);
    }).catch(async () => {
      await this.#markUncertain('task-execution-uncertain', graph.spec.graphId, task.spec.taskId, attemptId);
    }).catch(() => {});
  }

  #launchApproval(graph, task) {
    const context = this.#context(graph, task);
    const current = this.#projection.graphs.get(graph.spec.graphId);
    if (current.cancelRequested) return;
    let nativeResult;
    try {
      nativeResult = this.#requestApproval(context);
    } catch {
      nativeResult = Promise.reject(error('E_TASK_NATIVE', 'native approval callback failed'));
    }
    void Promise.resolve(nativeResult).then(async (receipt) => {
      if (receipt !== undefined) await this.approveTask(receipt);
    }).catch(async () => {
      await this.#markUncertain('task-approval-delivery-uncertain', graph.spec.graphId, task.spec.taskId);
    }).catch(() => {});
  }

  #launchInterrupt(graph, task) {
    const attemptId = task.attempts.at(-1).attemptId;
    const context = this.#context(graph, task, attemptId);
    const current = this.#projection.graphs.get(graph.spec.graphId).tasks.get(task.spec.taskId);
    if (current.state !== 'running') return;
    let nativeResult;
    try {
      nativeResult = this.#interrupt(context);
    } catch {
      nativeResult = Promise.reject(error('E_TASK_NATIVE', 'native interruption callback failed'));
    }
    void Promise.resolve(nativeResult).then(async (receipt) => {
      if (receipt !== undefined) await this.confirmCancellation(receipt);
    }).catch(async () => {
      await this.#markUncertain('task-interrupt-uncertain', graph.spec.graphId, task.spec.taskId, attemptId);
    }).catch(() => {});
  }

  async #markUncertain(type, graphId, taskId, attemptId = null) {
    const graph = this.#projection.graphs.get(graphId);
    const task = graph?.tasks.get(taskId);
    if (!task) return;
    if (type === 'task-approval-delivery-uncertain') {
      if (taskStatus(graph, task) !== 'approval-required' || !task.approvalRequested ||
          task.approvalDeliveryUncertain) return;
    } else if (task.state !== 'running' || task.attempts.at(-1)?.attemptId !== attemptId ||
               (type === 'task-execution-uncertain' && task.uncertain) ||
               (type === 'task-interrupt-uncertain' && task.interruptUncertain)) return;
    try {
      await this.#append({ type, graphId, taskId, ...(attemptId ? { attemptId } : {}) });
    } catch (cause) {
      if (cause.code !== 'E_TASK_JOURNAL') throw cause;
    }
  }
}
