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
 *         resumeGraph(scope), getGraph(id), getEvents(id?),
 *         satisfyGate({ graphId, taskId, gateId, evidence }), openGates(),
 *         gateAnswers(graphId, taskId), reschedule(), drain(), close().
 *
 * Each new journal event is applied to a copy of only the graph it names, and
 * the store gets the whole list but persists just the new tail
 * (egdesk-task-store.mjs), so one event costs the same however long the
 * journal is. A full replay happens only when the journal is opened.
 *
 * Gates (CHAT-06): a task waits on every upstream task in dependsOn (kind
 * "task"), on optional external gates, then on approvalRequired (kind
 * "approval"). External gates are explicit, exact conditions:
 *   { gateId, kind: 'userAction', label?, response? }
 *   { gateId, kind: 'oauth', origin, pathPrefix, cardId? }
 *   { gateId, kind: 'file', root, relativeGlob }          (root = connected rootId)
 *   { gateId, kind: 'terminalExit', sessionId, exitCode? }
 * Satisfying one is journaled with a bounded evidence reference; when the last
 * gate is satisfied the task becomes ready and starts automatically.
 *
 * Question gates (CHAT-06): a userAction gate may carry response, so 대표님
 * answers instead of only confirming. label is the question.
 *   response { kind: 'choice', options: [{ id, label }] }   2-6 options
 *   response { kind: 'text', maxLength? }                   1-500 characters
 * Such a gate opens only through the manual continue (user.action) carrying
 * the answer: evidence.answer { choice: optionId } or { textRef } — the written
 * text itself lives with the task sources, never in this journal. The visible
 * gate shows answer { kind: 'choice', choice } or { kind: 'text' };
 * gateAnswers(graphId, taskId) gives the journaled answers to the step's input.
 *
 * Gate expiry: any external gate may also carry expiresAt (canonical ISO time)
 * or timeoutMs (counted from the moment the gate becomes the task's current
 * wait: graph activation or the last upstream completion, whichever is later).
 * Either is at most 7 days. When it passes, 'task-gate-expired' is journaled:
 * the gate shows status 'expired', the task stays waiting-on-dependency, and
 * only the manual continue (user.action) can still open it. Nothing fails or
 * advances by itself.
 *
 * additionalLaunchReason() (optional, synchronous) is a host-owned soft gate
 * for additional work only. onQueueChange(graphId) observes transient reasons.
 * canStart(context) (optional, synchronous) can hold a ready task back for a
 * moment, e.g. while the conversation it continues in is busy; call
 * reschedule() when that may have changed.
 *
 * All receipts carry { receiptId, outcome, binding, evidenceRefs } and are checked
 * against the exact binding sent to the native adapter. verifyReceipt must confirm
 * actual native evidence; a self-declared "verified" flag is never accepted.
 */

const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
const TASK_STATES = new Set(['running', 'completed', 'failed', 'cancelled']);
const GATE_KINDS = new Set(['userAction', 'oauth', 'file', 'terminalExit']);
// browser.navigated / browser.loaded only ever arrive through the BRW-04
// popup rule (egdesk-await-router.mjs popupLoginFollowUp), never alone.
const GATE_EVIDENCE_TOPICS = new Set(['terminal.exit', 'file.changed', 'browser.oauthCompleted', 'user.action',
  'browser.navigated', 'browser.loaded']);
const MAX_GATES = 8;
const MAX_GATE_WAIT_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_GATE_CHOICES = 6;
export const MAX_GATE_ANSWER_CHARS = 500;
const OPTION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ANSWER_CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/;
const CONTROL = /[\u0000-\u001f\u007f]/;

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

function plainText(value, name, max) {
  assert(typeof value === 'string' && value.trim().length > 0 && value.length <= max && !CONTROL.test(value),
    'E_TASK_INPUT', `${name} must be short plain text`);
  return value;
}

// Exact http(s) origin and a path prefix with at least one segment; a bare "/"
// would match every page of the site, so it is refused.
function normalizeOAuthTarget(origin, pathPrefix) {
  let url = null;
  try { url = new URL(origin); } catch { /* refused below */ }
  assert(typeof origin === 'string' && url && ['http:', 'https:'].includes(url.protocol) && url.origin === origin,
    'E_TASK_INPUT', 'oauth origin must be an exact http(s) origin');
  assert(typeof pathPrefix === 'string' && pathPrefix.length > 1 && pathPrefix.length <= 512 &&
    pathPrefix.startsWith('/') && !CONTROL.test(pathPrefix) && !/[?#\\]/.test(pathPrefix) &&
    !pathPrefix.includes('//') && !pathPrefix.split('/').some((part) => part === '.' || part === '..') &&
    new URL(pathPrefix, origin).pathname === pathPrefix,
  'E_TASK_INPUT', 'oauth pathPrefix must be a canonical path with at least one segment');
  return { origin, pathPrefix };
}

// Root-relative glob: "*" and "?" stay within one segment, "**" spans segments.
// A glob made only of wildcards would match any change in the folder: refused.
function normalizeRelativeGlob(value) {
  assert(typeof value === 'string' && value.length > 0 && value.length <= 512 && !CONTROL.test(value) &&
    !value.startsWith('/') && !value.includes('\\') &&
    !value.split('/').some((part) => part === '' || part === '.' || part === '..') &&
    /[^*?/]/.test(value),
  'E_TASK_INPUT', 'file relativeGlob must be a relative pattern naming at least one literal character');
  return value;
}

// Optional expiry: an absolute canonical ISO time, or a wait length in ms.
function normalizeExpiry(input) {
  assert(input.expiresAt === undefined || input.timeoutMs === undefined,
    'E_TASK_INPUT', 'a gate takes expiresAt or timeoutMs, not both');
  if (input.timeoutMs !== undefined) {
    assert(Number.isSafeInteger(input.timeoutMs) && input.timeoutMs >= 1 && input.timeoutMs <= MAX_GATE_WAIT_MS,
      'E_TASK_INPUT', 'timeoutMs must be a whole number of milliseconds up to 7 days');
    return { timeoutMs: input.timeoutMs };
  }
  if (input.expiresAt === undefined) return {};
  const at = typeof input.expiresAt === 'string' && input.expiresAt.length <= 40 ? Date.parse(input.expiresAt) : NaN;
  assert(!Number.isNaN(at) && new Date(at).toISOString() === input.expiresAt,
    'E_TASK_INPUT', 'expiresAt must be a canonical ISO time such as 2026-10-25T09:00:00.000Z');
  return { expiresAt: input.expiresAt };
}

// What a question gate asks for; options keep the order the Agent gave.
function normalizeResponse(input) {
  assert(input !== null && typeof input === 'object' && !Array.isArray(input) && ['choice', 'text'].includes(input.kind),
    'E_TASK_INPUT', 'response kind must be choice or text');
  if (input.kind === 'choice') {
    object(input, 'choice response', ['kind', 'options']);
    assert(Array.isArray(input.options) && input.options.length >= 2 && input.options.length <= MAX_GATE_CHOICES,
      'E_TASK_INPUT', `a choice response lists 2-${MAX_GATE_CHOICES} options`);
    const options = input.options.map((option) => {
      object(option, 'choice option', ['id', 'label']);
      assert(typeof option.id === 'string' && OPTION_ID.test(option.id),
        'E_TASK_INPUT', 'option id must be 1-64 letters, digits, ".", "_" or "-", starting with a letter or digit');
      return { id: option.id, label: plainText(option.label, 'option label', 120) };
    });
    assert(new Set(options.map((option) => option.id)).size === options.length, 'E_TASK_INPUT', 'duplicate option id');
    return { kind: 'choice', options };
  }
  object(input, 'text response', ['kind', 'maxLength']);
  assert(input.maxLength === undefined ||
    (Number.isSafeInteger(input.maxLength) && input.maxLength >= 1 && input.maxLength <= MAX_GATE_ANSWER_CHARS),
  'E_TASK_INPUT', `maxLength must be 1-${MAX_GATE_ANSWER_CHARS}`);
  return { kind: 'text', ...(input.maxLength === undefined ? {} : { maxLength: input.maxLength }) };
}

function normalizeGate(input) {
  assert(input !== null && typeof input === 'object' && !Array.isArray(input) && GATE_KINDS.has(input.kind),
    'E_TASK_INPUT', 'gate kind must be userAction, oauth, file or terminalExit');
  const gateId = id(input.gateId, 'gateId');
  assert(gateId !== 'approval' && !gateId.startsWith('task:'), 'E_TASK_INPUT', 'gateId is reserved');
  const expiry = ['expiresAt', 'timeoutMs'];
  switch (input.kind) {
    case 'userAction':
      object(input, 'userAction gate', ['gateId', 'kind', 'label', 'response', ...expiry]);
      return { gateId, kind: 'userAction', ...(input.label === undefined ? {} : { label: plainText(input.label, 'label', 200) }),
        ...(input.response === undefined ? {} : { response: normalizeResponse(input.response) }), ...normalizeExpiry(input) };
    case 'oauth': {
      object(input, 'oauth gate', ['gateId', 'kind', 'origin', 'pathPrefix', 'cardId', ...expiry]);
      const target = normalizeOAuthTarget(input.origin, input.pathPrefix);
      return { gateId, kind: 'oauth', ...target, ...(input.cardId === undefined ? {} : { cardId: id(input.cardId, 'cardId') }),
        ...normalizeExpiry(input) };
    }
    case 'file':
      object(input, 'file gate', ['gateId', 'kind', 'root', 'relativeGlob', ...expiry]);
      return { gateId, kind: 'file', root: id(input.root, 'root'), relativeGlob: normalizeRelativeGlob(input.relativeGlob),
        ...normalizeExpiry(input) };
    default:
      object(input, 'terminalExit gate', ['gateId', 'kind', 'sessionId', 'exitCode', ...expiry]);
      assert(input.exitCode === undefined || Number.isSafeInteger(input.exitCode), 'E_TASK_INPUT', 'exitCode must be an integer');
      return { gateId, kind: 'terminalExit', sessionId: id(input.sessionId, 'sessionId'),
        ...(input.exitCode === undefined ? {} : { exitCode: input.exitCode }), ...normalizeExpiry(input) };
  }
}

/** Same gate rules as a submitted graph; for callers that validate before submitting. */
export function normalizeTaskGate(input) {
  return normalizeGate(input);
}

/** An absolute expiresAt must lie in the future and within 7 days of submission. */
export function assertGateWindow(graph, now = Date.now()) {
  for (const task of graph?.tasks ?? []) {
    for (const gate of task.gates ?? []) {
      if (gate?.expiresAt === undefined) continue;
      const at = Date.parse(gate.expiresAt);
      assert(at > now && at - now <= MAX_GATE_WAIT_MS, 'E_TASK_INPUT', 'expiresAt must be in the future and at most 7 days away');
    }
  }
}

/**
 * Checks 대표님's answer against a gate's question, before anything is kept.
 * -> { choice } or { text } (NFC, trimmed, CRLF -> LF); undefined for a gate
 * without a question. Wrong shape, unknown option or bad length: E_TASK_ANSWER.
 * Whether the text looks like a secret is the caller's check (task sources).
 */
export function normalizeGateAnswer(gate, answer) {
  const response = gate?.response;
  if (!response) {
    assert(answer === undefined, 'E_TASK_ANSWER', 'this condition takes no answer');
    return undefined;
  }
  assert(answer !== undefined, 'E_TASK_ANSWER', 'this condition needs an answer');
  assert(answer !== null && typeof answer === 'object' && !Array.isArray(answer) &&
    Object.keys(answer).length === 1 && Object.hasOwn(answer, response.kind),
  'E_TASK_ANSWER', response.kind === 'choice' ? 'answer with { choice }' : 'answer with { text }');
  if (response.kind === 'choice') {
    assert(typeof answer.choice === 'string' && response.options.some((option) => option.id === answer.choice),
      'E_TASK_ANSWER', 'choose one of the offered options');
    return { choice: answer.choice };
  }
  const max = response.maxLength ?? MAX_GATE_ANSWER_CHARS;
  const text = typeof answer.text === 'string' ? answer.text.normalize('NFC').replace(/\r\n?/g, '\n').trim() : '';
  assert(text.length > 0 && Array.from(text).length <= max && !ANSWER_CONTROL.test(text),
    'E_TASK_ANSWER', `the answer must be 1-${max} characters of plain text`);
  return { text };
}

// Whether journaled evidence fits the gate: a question needs its answer, other gates take none.
function answerFits(gate, answer) {
  if (!gate.response) return answer === undefined;
  if (gate.response.kind === 'choice') return answer?.choice !== undefined && gate.response.options.some((option) => option.id === answer.choice);
  return answer?.textRef !== undefined;
}

function normalizeEvidence(input) {
  object(input, 'gate evidence', ['eventId', 'topic', 'at', 'answer']);
  assert(GATE_EVIDENCE_TOPICS.has(input.topic) && typeof input.at === 'string' && input.at.length <= 40 &&
    !Number.isNaN(Date.parse(input.at)), 'E_TASK_INPUT', 'gate evidence must name a known event');
  const evidence = { eventId: id(input.eventId, 'eventId'), topic: input.topic, at: input.at };
  if (input.answer !== undefined) {
    assert(input.topic === 'user.action', 'E_TASK_INPUT', 'only a manual continue carries an answer');
    object(input.answer, 'gate answer', ['choice', 'textRef']);
    assert(Object.keys(input.answer).length === 1, 'E_TASK_INPUT', 'a gate answer is one choice or one textRef');
    if (input.answer.choice !== undefined) {
      assert(typeof input.answer.choice === 'string' && OPTION_ID.test(input.answer.choice), 'E_TASK_INPUT', 'answer choice must be an option id');
      evidence.answer = { choice: input.answer.choice };
    } else {
      evidence.answer = { textRef: id(input.answer.textRef, 'textRef') };
    }
  }
  return evidence;
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
    object(task, 'task', ['taskId', 'ownerId', 'sourceRef', 'dependsOn', 'approvalRequired', 'gates']);
    assert(Array.isArray(task.dependsOn) && task.dependsOn.length <= 256,
      'E_TASK_INPUT', 'dependsOn must be an array');
    assert(task.approvalRequired === undefined || typeof task.approvalRequired === 'boolean',
      'E_TASK_INPUT', 'approvalRequired must be boolean');
    const dependsOn = task.dependsOn.map((dependency) => id(dependency, 'dependency ID')).sort();
    assert(new Set(dependsOn).size === dependsOn.length, 'E_TASK_INPUT', 'duplicate dependency');
    assert(task.gates === undefined || (Array.isArray(task.gates) && task.gates.length <= MAX_GATES),
      'E_TASK_INPUT', `gates must be an array of at most ${MAX_GATES}`);
    const gates = (task.gates ?? []).map(normalizeGate).sort((a, b) => a.gateId.localeCompare(b.gateId));
    assert(new Set(gates.map((gate) => gate.gateId)).size === gates.length, 'E_TASK_INPUT', 'duplicate gate ID');
    return {
      taskId: id(task.taskId, 'taskId'),
      ownerId: id(task.ownerId, 'ownerId'),
      sourceRef: id(task.sourceRef, 'sourceRef'),
      dependsOn,
      approvalRequired: task.approvalRequired === true,
      // Absent when empty so journals written before gates replay unchanged.
      ...(gates.length ? { gates } : {}),
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

/** Pure validation and canonical form of a graph, as submitGraph would store it. */
export function normalizeTaskGraph(input) {
  return normalizeGraph(input);
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
  if ((task.spec.gates ?? []).some((gate) => !task.gatesSatisfied.has(gate.gateId))) return 'waiting-on-dependency';
  if (task.spec.approvalRequired && task.approvalReceipt?.outcome !== 'approved') {
    return 'approval-required';
  }
  return 'ready';
}

function emptyProjection() {
  return { graphs: new Map(), requestKeys: new Map(), receiptIds: new Map(), retryIds: new Set() };
}

// Applies one journal event to a projection (mutating it); E_TASK_JOURNAL when
// the event does not follow from what came before.
function applyEvent({ graphs, requestKeys, receiptIds, retryIds }, event, index) {
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
      lateOutcomes: [], gatesSatisfied: new Map(), gatesExpired: new Map(), completedAt: null,
    }]));
    graphs.set(spec.graphId, { spec, tasks, activated: false, activatedAt: null, cancelRequested: false });
    requestKeys.set(key, spec.graphId);
    return;
  }
  const graph = graphs.get(event.graphId);
  assert(graph, 'E_TASK_JOURNAL', 'event references missing graph');
  const task = event.taskId ? graph.tasks.get(event.taskId) : null;
  if (event.taskId) assert(task, 'E_TASK_JOURNAL', 'event references missing task');
  switch (event.type) {
    case 'graph-activated':
      assert(!graph.activated && !graph.cancelRequested, 'E_TASK_JOURNAL', 'invalid activation');
      graph.activated = true;
      graph.activatedAt = event.at;
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
      if (event.receipt.outcome === 'completed') task.completedAt = event.at;
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
    case 'task-gate-satisfied': {
      const gate = (task.spec.gates ?? []).find((entry) => entry.gateId === event.gateId);
      assert(gate && !graph.cancelRequested && task.state === null && !task.gatesSatisfied.has(event.gateId),
        'E_TASK_JOURNAL', 'invalid gate satisfaction');
      assert(JSON.stringify(normalizeEvidence(event.evidence)) === JSON.stringify(event.evidence),
        'E_TASK_JOURNAL', 'noncanonical gate evidence');
      assert(!task.gatesExpired.has(event.gateId) || event.evidence.topic === 'user.action',
        'E_TASK_JOURNAL', 'an expired gate opens only by hand');
      assert(answerFits(gate, event.evidence.answer), 'E_TASK_JOURNAL', 'gate answer does not fit its question');
      task.gatesSatisfied.set(event.gateId, clone(event.evidence));
      break;
    }
    case 'task-gate-expired': {
      const gate = (task.spec.gates ?? []).find((entry) => entry.gateId === event.gateId);
      assert(gate && (gate.expiresAt !== undefined || gate.timeoutMs !== undefined) && graph.activated &&
        !graph.cancelRequested && task.state === null && !task.gatesSatisfied.has(event.gateId) &&
        !task.gatesExpired.has(event.gateId), 'E_TASK_JOURNAL', 'invalid gate expiry');
      task.gatesExpired.set(event.gateId, event.at);
      break;
    }
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

/** Full replay, used when the journal is opened. */
function project(events) {
  const projection = emptyProjection();
  for (let index = 0; index < events.length; index += 1) applyEvent(projection, events[index], index);
  return projection;
}

/**
 * Validates one new event against the projection without changing it and
 * returns commit(), which applies it. Only the graph the event names is
 * copied, so the cost does not grow with the journal. Every event touches at
 * most that one graph plus the request, receipt and retry indexes.
 */
function stageEvent(projection, event, index) {
  const targetId = event?.type === 'graph-submitted' ? null : event?.graphId;
  const base = targetId === null || targetId === undefined ? undefined : projection.graphs.get(targetId);
  const copy = base ? structuredClone(base) : undefined;
  const added = emptyProjection();
  const overlay = {
    graphs: {
      get: (key) => (copy && key === targetId ? copy : added.graphs.get(key) ?? projection.graphs.get(key)),
      has: (key) => added.graphs.has(key) || projection.graphs.has(key),
      set: (key, value) => { added.graphs.set(key, value); },
    },
    requestKeys: {
      has: (key) => added.requestKeys.has(key) || projection.requestKeys.has(key),
      set: (key, value) => { added.requestKeys.set(key, value); },
    },
    receiptIds: {
      get: (key) => (added.receiptIds.has(key) ? added.receiptIds.get(key) : projection.receiptIds.get(key)),
      set: (key, value) => { added.receiptIds.set(key, value); },
    },
    retryIds: {
      has: (key) => added.retryIds.has(key) || projection.retryIds.has(key),
      add: (key) => { added.retryIds.add(key); },
    },
  };
  applyEvent(overlay, event, index);
  return () => {
    if (copy) projection.graphs.set(targetId, copy);
    for (const [key, value] of added.graphs) projection.graphs.set(key, value);
    for (const [key, value] of added.requestKeys) projection.requestKeys.set(key, value);
    for (const [key, value] of added.receiptIds) projection.receiptIds.set(key, value);
    for (const key of added.retryIds) projection.retryIds.add(key);
  };
}

// When an expiring gate runs out, in ms; null while its clock has not started.
// timeoutMs counts from the later of activation and the last upstream completion.
function gateDeadline(graph, task, gate) {
  if (gate.expiresAt !== undefined) return Date.parse(gate.expiresAt);
  if (gate.timeoutMs === undefined || !graph.activated || !graph.activatedAt) return null;
  let start = Date.parse(graph.activatedAt);
  for (const dependency of task.spec.dependsOn) {
    const upstream = graph.tasks.get(dependency);
    if (upstream.state !== 'completed' || !upstream.receipt || !upstream.completedAt) return null;
    start = Math.max(start, Date.parse(upstream.completedAt));
  }
  return start + gate.timeoutMs;
}

// One list of what a task waits on, in order: upstream tasks, external gates,
// then approval. status is waiting | satisfied | expired (approval may be rejected).
function visibleGates(graph, task) {
  const upstream = task.spec.dependsOn.map((dependency) => {
    const entry = graph.tasks.get(dependency);
    return { gateId: `task:${dependency}`, kind: 'task', taskId: dependency,
      status: entry.state === 'completed' && entry.receipt ? 'satisfied' : 'waiting' };
  });
  const external = (task.spec.gates ?? []).map((gate) => {
    const evidence = task.gatesSatisfied.get(gate.gateId);
    const expiredAt = task.gatesExpired.get(gate.gateId);
    const timed = gate.expiresAt !== undefined || gate.timeoutMs !== undefined;
    const deadline = timed ? gateDeadline(graph, task, gate) : null;
    return { ...clone(gate), status: evidence ? 'satisfied' : expiredAt ? 'expired' : 'waiting',
      ...(evidence ? { satisfiedBy: evidence.topic, satisfiedAt: evidence.at } : {}),
      // The chosen option id, or only that a written answer was given (its text stays private).
      ...(evidence?.answer ? { answer: evidence.answer.choice !== undefined
        ? { kind: 'choice', choice: evidence.answer.choice } : { kind: 'text' } } : {}),
      // expiresAt: when this wait runs out; null while its clock has not started.
      ...(timed ? { expiresAt: deadline === null ? null : new Date(deadline).toISOString() } : {}),
      ...(expiredAt ? { expiredAt } : {}) };
  });
  const approval = task.spec.approvalRequired ? [{ gateId: 'approval', kind: 'approval',
    status: task.approvalReceipt?.outcome === 'approved' ? 'satisfied' :
      task.approvalReceipt?.outcome === 'rejected' ? 'rejected' : 'waiting',
    requested: task.approvalRequested }] : [];
  return [...upstream, ...external, ...approval];
}

function visibleGraph(graph, recoveryHold, queueReasons) {
  return {
    ...clone(graph.spec),
    activated: graph.activated,
    cancelRequested: graph.cancelRequested,
    recoveryHold,
    tasks: [...graph.tasks.values()].map((task) => ({
      ...clone(task.spec),
      status: taskStatus(graph, task),
      ...(taskStatus(graph, task) === 'ready' && queueReasons?.has(task.spec.taskId)
        ? { queueReason: queueReasons.get(task.spec.taskId) } : {}),
      blockedBy: task.spec.dependsOn.filter((dependency) => {
        const upstream = graph.tasks.get(dependency);
        return upstream.state !== 'completed' || !upstream.receipt;
      }).map((dependency) => ({
        taskId: dependency,
        status: taskStatus(graph, graph.tasks.get(dependency)),
      })),
      gates: visibleGates(graph, task),
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
  requestApproval, verifyReceipt, canStart = null, additionalLaunchReason = null, onQueueChange = () => {} } = {}) {
  assert(Number.isSafeInteger(maxConcurrency) && maxConcurrency >= 1 && maxConcurrency <= 32,
    'E_TASK_INPUT', 'maxConcurrency must be 1–32');
  for (const [name, callback] of Object.entries({ execute, interrupt, requestApproval, verifyReceipt })) {
    assert(typeof callback === 'function', 'E_TASK_INPUT', `${name} callback is required`);
  }
  assert(canStart === null || typeof canStart === 'function', 'E_TASK_INPUT', 'canStart must be a function');
  const events = store ? await store.load() : [];
  return new TaskGraphRuntime({ events, store, maxConcurrency, execute, interrupt,
    requestApproval, verifyReceipt, canStart, additionalLaunchReason, onQueueChange });
}

class TaskGraphRuntime {
  #events;
  #projection;
  #store;
  #execute;
  #interrupt;
  #requestApproval;
  #verifyReceipt;
  #canStart;
  #additionalLaunchReason;
  #onQueueChange;
  #queueReasons = new Map();
  #maxConcurrency;
  #recoveryHolds;
  #expiryTimer = null;
  #expiring = false;
  #closed = false;
  #writeTail = Promise.resolve();
  #scheduling = null;
  #scheduleAgain = false;
  #listeners = new Set();
  // Only an attempt claimed by this live scheduler, but not handed to execute
  // yet, can be proven never dispatched. Replayed running attempts are unknown.
  #pendingDispatch = new Set();

  constructor({ events, store, maxConcurrency, execute, interrupt, requestApproval, verifyReceipt, canStart = null, additionalLaunchReason, onQueueChange }) {
    this.#events = clone(events);
    this.#projection = project(this.#events);
    this.#store = store;
    this.#maxConcurrency = maxConcurrency;
    this.#execute = execute;
    this.#interrupt = interrupt;
    this.#requestApproval = requestApproval;
    this.#verifyReceipt = verifyReceipt;
    this.#canStart = canStart;
    this.#additionalLaunchReason = additionalLaunchReason;
    this.#onQueueChange = onQueueChange;
    // A reloaded active graph never dispatches, even if its last status was ready.
    this.#recoveryHolds = new Set(this.#projection.graphs.keys());
    // Expiry only journals a gate's state; it never dispatches, so it also runs
    // for graphs held for recovery (a wait that ran out while closed expires now).
    this.#armExpiry();
  }

  /** Stops the expiry timer; the journal and projection stay readable. */
  close() {
    this.#closed = true;
    if (this.#expiryTimer) clearTimeout(this.#expiryTimer);
    this.#expiryTimer = null;
  }

  /** Resolves once every journal write already queued has finished or failed. */
  async drain() {
    let tail;
    do {
      tail = this.#writeTail;
      await tail;
    } while (tail !== this.#writeTail);
  }

  /** Re-runs scheduling, e.g. after canStart's answer may have changed. */
  async reschedule() {
    await this.#schedule();
  }

  // Every waiting, expiring gate whose clock has started, with its deadline.
  #expiryCandidates() {
    const due = [];
    for (const graph of this.#projection.graphs.values()) {
      if (!graph.activated || graph.cancelRequested) continue;
      for (const task of graph.tasks.values()) {
        if (task.state !== null) continue;
        for (const gate of task.spec.gates ?? []) {
          if (gate.expiresAt === undefined && gate.timeoutMs === undefined) continue;
          if (task.gatesSatisfied.has(gate.gateId) || task.gatesExpired.has(gate.gateId)) continue;
          const deadline = gateDeadline(graph, task, gate);
          if (deadline !== null) due.push({ graphId: graph.spec.graphId, taskId: task.spec.taskId, gateId: gate.gateId, deadline });
        }
      }
    }
    return due;
  }

  #armExpiry() {
    if (this.#expiryTimer) clearTimeout(this.#expiryTimer);
    this.#expiryTimer = null;
    if (this.#closed || this.#expiring) return;
    const next = Math.min(...this.#expiryCandidates().map((entry) => entry.deadline));
    if (!Number.isFinite(next)) return;
    this.#expiryTimer = setTimeout(() => {
      this.#expiryTimer = null;
      void this.#expireDue();
    }, Math.min(Math.max(0, next - Date.now()), 2 ** 31 - 1));
    this.#expiryTimer.unref?.();
  }

  async #expireDue() {
    if (this.#closed || this.#expiring) return;
    this.#expiring = true;
    try {
      const now = Date.now();
      for (const entry of this.#expiryCandidates()) {
        if (entry.deadline > now) continue;
        try {
          await this.#append({ type: 'task-gate-expired', graphId: entry.graphId, taskId: entry.taskId, gateId: entry.gateId });
        } catch { /* satisfied, started or cancelled meanwhile: nothing expires */ }
      }
    } finally {
      this.#expiring = false;
      this.#armExpiry();
    }
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
    return graph ? visibleGraph(graph, this.#recoveryHolds.has(graphId), this.#queueReasons.get(graphId)) : null;
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
      const commit = stageEvent(this.#projection, event, this.#events.length);
      const nextEvents = [...this.#events, event];
      if (this.#store) await this.#store.save(nextEvents);
      this.#events = nextEvents;
      commit();
      for (const listener of this.#listeners) {
        try { listener(clone(event)); } catch { /* observers do not alter the journal */ }
      }
      this.#armExpiry();
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
    assertGateWindow(spec);
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
      if (this.#pendingDispatch.has(attemptId)) {
        await this.#append({ type: 'task-dispatch-skipped', graphId: graph.spec.graphId,
          taskId: task.spec.taskId, attemptId });
        this.#pendingDispatch.delete(attemptId);
      } else {
        // Includes recovered attempts: an empty process-local set is not
        // evidence that the native task never started.
        this.#launchInterrupt(current, task);
      }
    }
    return this.getGraph(graph.spec.graphId);
  }

  /**
   * Latches one external gate. Callers are the gate router (a matching workflow
   * event) and the manual "continue" route; both name the exact gate. Already
   * satisfied is a no-op; a cancelled graph or a started/finished task refuses.
   */
  async satisfyGate(input) {
    object(input, 'gate satisfaction', ['graphId', 'taskId', 'gateId', 'evidence']);
    const graph = this.#projection.graphs.get(id(input.graphId, 'graphId'));
    const task = graph?.tasks.get(id(input.taskId, 'taskId'));
    const gateId = id(input.gateId, 'gateId');
    assert(task && (task.spec.gates ?? []).some((gate) => gate.gateId === gateId),
      'E_TASK_SCOPE', 'gate targets an unknown task gate');
    const evidence = normalizeEvidence(input.evidence);
    if (task.gatesSatisfied.has(gateId)) return this.getGraph(graph.spec.graphId);
    const gate = task.spec.gates.find((entry) => entry.gateId === gateId);
    // A question opens only with its answer, so a bare user.action (or any other event) cannot open it.
    assert(answerFits(gate, evidence.answer), 'E_TASK_ANSWER',
      gate.response ? 'this condition needs an answer' : 'this condition takes no answer');
    assert(!graph.cancelRequested && task.state === null, 'E_TASK_STATE', 'gate is no longer waiting');
    assert(!task.gatesExpired.has(gateId) || evidence.topic === 'user.action',
      'E_TASK_STATE', 'an expired gate opens only by hand');
    try {
      await this.#append({ type: 'task-gate-satisfied', graphId: graph.spec.graphId,
        taskId: task.spec.taskId, gateId, evidence });
    } catch (cause) {
      if (cause.code !== 'E_TASK_JOURNAL' ||
          !this.#projection.graphs.get(graph.spec.graphId)?.tasks.get(task.spec.taskId)?.gatesSatisfied.has(gateId)) {
        throw cause;
      }
    }
    await this.#schedule();
    return this.getGraph(graph.spec.graphId);
  }

  /** Journaled answers to a task's question gates, in gate order: [{ gateId, choice } | { gateId, textRef }]. */
  gateAnswers(graphId, taskId) {
    const task = this.#projection.graphs.get(graphId)?.tasks.get(taskId);
    if (!task) return [];
    return (task.spec.gates ?? []).flatMap((gate) => {
      const answer = task.gatesSatisfied.get(gate.gateId)?.answer;
      return answer ? [{ gateId: gate.gateId, ...clone(answer) }] : [];
    });
  }

  /** External gates still waiting in graphs that are not cancelled; expired ones say expired: true. */
  openGates() {
    const open = [];
    for (const graph of this.#projection.graphs.values()) {
      if (graph.cancelRequested) continue;
      for (const task of graph.tasks.values()) {
        if (task.state !== null) continue;
        for (const gate of task.spec.gates ?? []) {
          if (!task.gatesSatisfied.has(gate.gateId)) {
            open.push({ graphId: graph.spec.graphId, taskId: task.spec.taskId, gate: clone(gate),
              ...(task.gatesExpired.has(gate.gateId) ? { expired: true } : {}) });
          }
        }
      }
    }
    return open;
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
    if (this.#closed) return null;
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
    let pressure = false;
    if (running > 0 && running < this.#maxConcurrency) {
      try { pressure = this.#additionalLaunchReason?.() === 'local-host-pressure'; } catch { /* retain hard cap */ }
    }
    const queued = new Map();
    for (const graph of this.#projection.graphs.values()) {
      const { graphId } = graph.spec;
      if (this.#recoveryHolds.has(graphId) || graph.cancelRequested || !graph.activated) continue;
      for (const task of graph.tasks.values()) {
        if (taskStatus(graph, task) !== 'ready') continue;
        const reason = running >= this.#maxConcurrency ? 'task-concurrency-limit'
          : !this.#mayStart(graph, task) ? null : pressure ? 'local-host-pressure' : false;
        if (reason === false) return { kind: 'execute', graph, task };
        if (!reason) continue;
        if (!queued.has(graphId)) queued.set(graphId, new Map());
        queued.get(graphId).set(task.spec.taskId, reason);
      }
    }
    const previous = this.#queueReasons;
    this.#queueReasons = queued;
    for (const graphId of new Set([...previous.keys(), ...queued.keys()])) {
      const before = previous.get(graphId), after = queued.get(graphId);
      if (before?.size !== after?.size || [...(after ?? [])].some(([id, reason]) => before?.get(id) !== reason)) {
        try { this.#onQueueChange(graphId, after && [...after.values()].includes('local-host-pressure')); } catch {}
      } else if (after && [...after.values()].includes('local-host-pressure')) {
        // Re-arm a bounded retry even when the visible reason is unchanged.
        try { this.#onQueueChange(null, true); } catch {}
      }
    }
    return null;
  }

  // A ready task the canStart hook holds back stays ready (nothing is journaled).
  #mayStart(graph, task) {
    if (!this.#canStart) return true;
    try {
      return this.#canStart(frozen({ graphId: graph.spec.graphId, taskId: task.spec.taskId })) === true;
    } catch {
      return false;
    }
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
              this.#pendingDispatch.add(attemptId);
              try {
                await this.#append({ type: 'task-started', graphId: graph.spec.graphId,
                  taskId: task.spec.taskId, attemptId });
              } catch (cause) {
                this.#pendingDispatch.delete(attemptId);
                throw cause;
              }
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
    this.#pendingDispatch.delete(attemptId);
    if (this.#closed || current.cancelRequested) return;
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
    if (this.#closed || current.cancelRequested) return;
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
