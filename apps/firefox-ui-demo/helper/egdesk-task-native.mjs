import { randomUUID } from 'node:crypto';
import { MAX_TEXT, validateChatCwd } from './codex-chat-values.mjs';
import { nativeHash, nativeTaskError, stableJSON } from './egdesk-task-native-store.mjs';

const SCOPE = ['graphId', 'requestId', 'runId', 'parentTaskId', 'requestedBy'];
const BINDING = [...SCOPE, 'taskId', 'ownerId', 'sourceRef', 'attemptId'];
const INPUT = ['message', 'cwd', 'model', 'effort', 'profileEnabled', 'systemPrompt',
  'contextSnapshotIds', 'contextCapabilities'];
const equal = (a, b) => stableJSON(a) === stableJSON(b);
const clone = (value) => structuredClone(value);
const pick = (value, keys) => Object.fromEntries(keys.map((key) => [key, value[key]]));
const keyOf = (binding) => nativeHash(binding);
const scopeOf = (value) => pick(value, SCOPE);
const sameBoard = (value, board) => value.boardId === board.boardId &&
  (value.requestedBy ?? value.scope?.requestedBy ?? value.binding?.requestedBy) === board.requestedBy;

function requireValue(condition, code, message, status = 409) {
  if (!condition) throw nativeTaskError(code, message, status);
}
function ref(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 2048 && !/[\u0000-\u001f]/.test(value);
}
function checkedBinding(value, approval = false) {
  requireValue(value && Object.keys(value).length === BINDING.length &&
    BINDING.every((key) => Object.hasOwn(value, key) &&
      ((key === 'parentTaskId' || (approval && key === 'attemptId')) && value[key] === null || ref(value[key]))),
  'TASK_BINDING', 'Exact task binding is required', 400);
  requireValue(approval ? value.attemptId === null : ref(value.attemptId),
    'TASK_BINDING', 'Invalid task attempt binding', 400);
  return clone(value);
}
function taskBinding(record, task, attemptId = null) {
  return { ...record.scope, taskId: task.taskId, ownerId: task.ownerId,
    sourceRef: task.sourceRef, attemptId };
}
function normalizedInput(value) {
  requireValue(value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).every((key) => INPUT.includes(key)) &&
    typeof value.message === 'string' && value.message.trim() && value.message.length <= MAX_TEXT,
  'TASK_INPUT_UNRESOLVED', 'Trusted task input could not be resolved', 403);
  validateChatCwd(value);
  for (const key of ['model', 'effort']) {
    requireValue(value[key] === undefined || ref(value[key]), 'TASK_INPUT_UNRESOLVED', 'Invalid resolved execution setting', 403);
  }
  requireValue(value.profileEnabled === undefined || typeof value.profileEnabled === 'boolean',
    'TASK_INPUT_UNRESOLVED', 'Invalid resolved profile setting', 403);
  if (value.systemPrompt !== undefined || value.profileEnabled === true) {
    requireValue(value.profileEnabled === true && typeof value.systemPrompt === 'string' &&
      value.systemPrompt.trim() && value.systemPrompt.length <= 8000,
    'TASK_INPUT_UNRESOLVED', 'Invalid resolved profile instruction', 403);
  }
  requireValue(value.contextSnapshotIds === undefined || Array.isArray(value.contextSnapshotIds) &&
    value.contextSnapshotIds.length <= 16 && value.contextSnapshotIds.every(ref),
  'TASK_INPUT_UNRESOLVED', 'Invalid resolved context references', 403);
  const caps = value.contextCapabilities;
  requireValue(caps === undefined || caps && typeof caps === 'object' && !Array.isArray(caps) &&
    Object.keys(caps).every((key) => ['read', 'reader', 'publishBriefing'].includes(key)) &&
    Object.values(caps).every((entry) => typeof entry === 'boolean'),
  'TASK_INPUT_UNRESOLVED', 'Invalid resolved context capabilities', 403);
  return clone(value);
}
function nativeIds(value) {
  if (!['conversationId', 'runId', 'answerId'].every((key) => ref(value?.[key]))) return null;
  return pick(value, ['conversationId', 'runId', 'answerId']);
}
function outcomeOf(proof) {
  if (!proof || !['run.completed', 'resume-snapshot'].includes(proof.kind)) return null;
  if (proof.status === 'interrupted') return proof.stopConfirmed === true ? 'cancelled' : null;
  return ['completed', 'failed'].includes(proof.status) ? proof.status : null;
}
function compactEvent(event) {
  if (event?.type !== 'chat.event' || event.v !== 2 || event.provider !== 'codex' ||
      !['run.started', 'run.completed'].includes(event.event) || !nativeIds(event) ||
      !ref(event.streamId) || !Number.isSafeInteger(event.seq) || event.seq < 0 ||
      event.details?.error?.origin === 'bridge') return null;
  const proof = { kind: event.event, native: nativeIds(event),
    requestId: ref(event.requestId) ? event.requestId : null,
    status: event.event === 'run.started' ? 'inProgress' : event.details?.status,
    stopConfirmed: event.details?.stopConfirmed === true,
    streamId: event.streamId, seq: event.seq };
  if (proof.kind === 'run.completed' && !outcomeOf(proof)) return null;
  return proof;
}
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

/**
 * Trusted backend seam. captureScope(context) returns opaque {ownerKey,generation,
 * delegationKey}; synchronous assertDelegationCurrent(captured,context) MUST return
 * true only while that account/generation/parent delegation remains current.
 * resolveTaskInput({...ctx,boardId,phase}) MUST be side-effect-free and verify
 * the current owner, Board, source, parent delegation, and every cwd/profile/
 * model/context grant before returning only INPUT fields.
 * sourceRef is never interpreted as a prompt. Resolved payloads stay in memory.
 *
 * registerGraph({boardId,graph}) precedes activation. Wire chat's trusted emit
 * callback to onChatEvent(event). No HTTP event/receipt ingestion route exists.
 * Native chat approvals keep their existing route; task preapproval IDs here
 * are independent. Reopening this adapter never sends or resumes a native task.
 */
export function createNativeTaskAdapter({ chat, resolveTaskInput, ledger, captureScope, assertDelegationCurrent }) {
  requireValue(['send', 'interrupt', 'resume', 'snapshot'].every((key) => typeof chat?.[key] === 'function') &&
    typeof resolveTaskInput === 'function' && typeof ledger?.snapshot === 'function' &&
    typeof ledger?.transact === 'function' && typeof captureScope === 'function' &&
    typeof assertDelegationCurrent === 'function',
  'TASK_ADAPTER_CONFIG', 'Native chat, resolver, authority hooks and ledger are required', 500);
  const executions = new Map();
  const outcomes = new Map();
  const stops = new Map();
  const approvals = new Map();
  const interrupting = new Set();
  const listeners = new Set();
  function notify() { for (const listener of listeners) { try { listener(); } catch {} } }
  function graphRecord(scope, boardId = null, state = ledger.snapshot()) {
    const record = state.graphs.find((item) => item.scope.graphId === scope.graphId);
    requireValue(record && equal(record.scope, scope) && (boardId === null || record.boardId === boardId),
      'TASK_SCOPE', 'Task graph ownership does not match');
    return record;
  }
  function bound(ctx, approval = false) {
    const binding = checkedBinding(ctx?.binding, approval);
    const record = graphRecord(scopeOf(binding));
    const task = record.tasks.find((item) => item.taskId === binding.taskId);
    requireValue(task && equal(taskBinding(record, task, binding.attemptId), binding),
      'TASK_SCOPE', 'Task owner or source does not match');
    return { binding, record, key: keyOf(binding) };
  }
  function fenced(record, state = ledger.snapshot()) {
    return record.fenced || state.boardFences.some((board) => sameBoard(record, board));
  }
  function sameAuthorityOwner(authority, record) {
    return authority?.ownerKey === record.authority?.ownerKey &&
      authority?.delegationKey === record.authority?.delegationKey;
  }
  function grant(record, ctx, phase, captured = null) {
    const context = clone({ ...ctx, boardId: record.boardId, scope: record.scope, phase });
    const authority = captured ? clone(captured) : captureScope(context);
    requireValue(authority && !authority.then && ref(authority.ownerKey) && ref(authority.delegationKey) &&
      (ref(authority.generation) || Number.isSafeInteger(authority.generation)) &&
      Object.keys(authority).every((key) => ['ownerKey', 'generation', 'delegationKey'].includes(key)),
    'TASK_AUTHORITY', 'Current task authority could not be captured', 403);
    requireValue(!record.authority || record.authority.ownerKey === authority.ownerKey &&
      record.authority.delegationKey === authority.delegationKey,
    'TASK_AUTHORITY', 'Task account or delegation no longer matches', 403);
    const capturedValue = clone(authority);
    const check = () => requireValue(assertDelegationCurrent(clone(capturedValue), clone(context)) === true,
      'TASK_AUTHORITY', 'Task account, parent or delegation changed', 403);
    check();
    return { authority: capturedValue, check };
  }
  async function resolve(ctx, record, phase, guard = grant(record, ctx, phase)) {
    const input = await resolveTaskInput(clone({ ...ctx, boardId: record.boardId, phase }));
    guard.check();
    return normalizedInput(input);
  }
  function settle(attempt) {
    if (!attempt?.receipt) return;
    try { grant(graphRecord(scopeOf(attempt.binding)), { binding: attempt.binding }, 'publish', attempt.authority).check(); }
    catch { return; }
    const receipt = clone(attempt.receipt);
    outcomes.get(attempt.key)?.resolve(receipt.outcome === 'cancelled' ? undefined : receipt);
    stops.get(attempt.key)?.resolve(receipt.outcome === 'cancelled' ? receipt : undefined);
    notify();
  }
  function finish(attempt, proof) {
    const outcome = outcomeOf(proof);
    if (!outcome || !attempt.native || !equal(attempt.native, proof.native) || attempt.receipt) return;
    attempt.phase = 'terminal';
    attempt.proof = clone(proof);
    attempt.receipt = { receiptId: `native-${randomUUID()}`, outcome,
      binding: clone(attempt.binding), evidenceRefs: [`native-evidence-${nativeHash(proof)}`] };
  }

  async function registerGraph({ boardId, graph }) {
    requireValue(ref(boardId) && graph && Array.isArray(graph.tasks), 'TASK_SCOPE', 'Board and graph are required', 400);
    const record = { boardId, scope: scopeOf(graph), tasks: graph.tasks.map((task) =>
      pick(task, ['taskId', 'ownerId', 'sourceRef', 'dependsOn', 'approvalRequired'])), fenced: false };
    const guards = [];
    for (const task of record.tasks) {
      const binding = checkedBinding(taskBinding(record, task), true);
      const ctx = { binding, dependencyReceipts: [], approvalReceiptId: null };
      const guard = grant(record, ctx, 'admit');
      guards.push(guard);
      record.authority = pick(guard.authority, ['ownerKey', 'delegationKey']);
      await resolve(ctx, record, 'admit', guard);
    }
    record.fingerprint = nativeHash({ boardId, scope: record.scope, tasks: record.tasks });
    await ledger.transact((state) => {
      guards.forEach((guard) => guard.check());
      requireValue(!state.boardFences.some((board) => sameBoard(record, board)), 'BOARD_CLOSING', 'Board is closing');
      const old = state.graphs.find((item) => item.scope.graphId === record.scope.graphId);
      requireValue(!old || old.fingerprint === record.fingerprint && equal(old.authority, record.authority),
        'TASK_IDEMPOTENCY', 'Graph ID is already bound to other work');
      if (!old) state.graphs.push(record);
    });
    guards.forEach((guard) => guard.check());
    notify();
    return { boardId, scope: clone(record.scope) };
  }

  async function sendInterrupt(key) {
    if (interrupting.has(key)) return;
    const old = ledger.snapshot().attempts.find((item) => item.key === key);
    if (!old?.native || old.receipt || !old.interruptRequested) { settle(old); return; }
    interrupting.add(key);
    let guard;
    try {
      guard = grant(graphRecord(scopeOf(old.binding)), { binding: old.binding }, 'interrupt', old.authority);
      await ledger.transact((state) => {
        guard.check();
        const attempt = state.attempts.find((item) => item.key === key);
        if (!attempt.receipt) attempt.interruptSent = true;
      });
      guard.check();
      const current = ledger.snapshot().attempts.find((item) => item.key === key);
      if (!current.receipt) await chat.interrupt(pick(current.native, ['conversationId', 'runId']));
      guard.check();
      // accepted, alreadyTerminal and stopRequested are dispatch acknowledgments.
      // Only a terminal event or explicit reconciliation may settle the waiter.
    } catch {
      if (!guard) return;
      try { guard?.check(); } catch { return; }
      await ledger.transact((state) => {
        guard.check();
        const attempt = state.attempts.find((item) => item.key === key);
        if (attempt && !attempt.receipt) attempt.phase = 'unknown';
      });
    } finally { interrupting.delete(key); notify(); }
  }

  function execute(ctx) {
    const { binding, record, key } = bound(ctx);
    if (executions.has(key)) return executions.get(key);
    const work = (async () => {
      const existing = ledger.snapshot().attempts.find((item) => item.key === key);
      const guard = grant(record, ctx, 'execute');
      if (existing) {
        requireValue(equal(existing.binding, binding), 'TASK_BINDING', 'Attempt binding changed');
        if (existing.receipt) {
          grant(record, ctx, 'publish', existing.authority).check();
          return existing.receipt.outcome === 'cancelled' ? undefined : clone(existing.receipt);
        }
        throw nativeTaskError('TASK_RECONCILE_REQUIRED', 'Existing native intent must be reconciled before further action');
      }
      requireValue(!fenced(record), 'TASK_FENCED', 'Task graph has stopped admitting work');
      const input = await resolve(ctx, record, 'execute', guard);
      const requestId = `task-native-${randomUUID()}`;
      const clientThreadId = `task-child-${randomUUID()}`;
      const waiter = deferred();
      outcomes.set(key, waiter);
      await ledger.transact((state) => {
        guard.check();
        const current = graphRecord(record.scope, record.boardId, state);
        requireValue(!fenced(current, state), 'TASK_FENCED', 'Task graph has stopped admitting work');
        requireValue(!state.attempts.some((item) => item.key === key), 'TASK_IDEMPOTENCY', 'Attempt intent already exists');
        state.attempts.push({ key, binding, boardId: record.boardId, requestId, clientThreadId,
          candidateConversationId: null, inputHash: nativeHash(input), phase: 'intent', native: null, observed: [],
          interruptRequested: stops.has(key), interruptSent: false, receipt: null, proof: null,
          authority: guard.authority });
      });
      try {
        guard.check();
        const accepted = await chat.send({ ...input, requestId, clientThreadId });
        guard.check();
        requireValue(accepted?.accepted === true && accepted.requestId === requestId && nativeIds(accepted),
          'TASK_NATIVE_ACCEPTANCE', 'Native request acceptance was not correlated');
        const attempt = await ledger.transact((state) => {
          guard.check();
          const current = state.attempts.find((item) => item.key === key);
          current.native = nativeIds(accepted);
          current.phase = 'accepted';
          for (const proof of current.observed) finish(current, proof);
          return current;
        });
        guard.check();
        settle(attempt);
        if (attempt.interruptRequested) void sendInterrupt(key).catch(() => {});
        return await waiter.promise;
      } catch (error) {
        try { guard.check(); } catch { throw error; }
        await ledger.transact((state) => {
          guard.check();
          const current = state.attempts.find((item) => item.key === key);
          if (current && !current.receipt) {
            current.phase = 'unknown';
            // A failed or missing turn/start reply can still expose the native
            // thread ID. It is only a reconciliation lead, never run proof.
            if (ref(error?.conversationId)) current.candidateConversationId = error.conversationId;
          }
        });
        guard.check();
        throw error;
      } finally { outcomes.delete(key); notify(); }
    })();
    executions.set(key, work);
    void work.finally(() => { executions.delete(key); outcomes.delete(key); }).catch(() => {});
    return work;
  }

  function interrupt(ctx) {
    const { key, record, binding } = bound(ctx);
    const old = ledger.snapshot().attempts.find((item) => item.key === key);
    const guard = grant(record, ctx, 'interrupt', old?.authority ?? null);
    if (stops.has(key)) return stops.get(key).promise;
    const waiter = deferred();
    stops.set(key, waiter);
    void ledger.transact((state) => {
      guard.check();
      const attempt = state.attempts.find((item) => item.key === key);
      if (attempt) attempt.interruptRequested = true;
      return attempt ?? null;
    }).then((attempt) => { guard.check(); settle(attempt); return sendInterrupt(key); }).catch(() => notify());
    // Missing/unaccepted intent has no native stop proof. Keep it held.
    return waiter.promise;
  }

  async function onChatEvent(event) {
    const proof = compactEvent(event);
    if (!proof) return { matched: false };
    let guard;
    const attempt = await ledger.transact((state) => {
      const current = state.attempts.find((item) => proof.requestId === item.requestId ||
        (proof.requestId === null && item.native && equal(item.native, proof.native)));
      if (!current) return null;
      if (current.native && !equal(current.native, proof.native)) return null;
      try { guard = grant(graphRecord(scopeOf(current.binding), current.boardId, state),
        { binding: current.binding }, 'native-event', current.authority); }
      catch { return null; }
      if (!current.native) {
        if (!current.observed.some((old) => equal(old, proof)) && current.observed.length < 16) {
          current.observed.push(proof);
        }
      } else finish(current, proof);
      return current;
    });
    if (guard) { try { guard.check(); } catch { return { matched: false }; } }
    settle(attempt);
    return { matched: Boolean(attempt) };
  }

  async function requestApproval(ctx) {
    const { binding, record } = bound(ctx, true);
    const guard = grant(record, ctx, 'preapproval');
    requireValue(!fenced(record), 'TASK_FENCED', 'Task graph is cancelled');
    await resolve(ctx, record, 'preapproval', guard);
    const approval = await ledger.transact((state) => {
      guard.check();
      requireValue(!fenced(graphRecord(record.scope, record.boardId, state), state), 'TASK_FENCED', 'Task graph is cancelled');
      let current = state.approvals.findLast((item) => equal(item.binding, binding) && item.status === 'pending');
      if (current && !equal(current.authority, guard.authority)) { current.status = 'cancelled'; current = null; }
      if (!current) {
        current = { approvalId: `task-approval-${randomUUID()}`, binding, boardId: record.boardId,
          status: 'pending', receipt: null, authority: guard.authority };
        state.approvals.push(current);
      }
      return current;
    });
    guard.check();
    if (!approvals.has(approval.approvalId)) approvals.set(approval.approvalId, deferred());
    const current = ledger.snapshot().approvals.find((item) => item.approvalId === approval.approvalId);
    if (current?.receipt) approvals.get(approval.approvalId).resolve(clone(current.receipt));
    notify();
    return approvals.get(approval.approvalId).promise;
  }

  async function decideTaskApproval({ approvalId, boardId, scope, taskId, decision }) {
    requireValue(['approved', 'rejected'].includes(decision), 'TASK_APPROVAL_DECISION', 'Invalid task preapproval decision', 400);
    const record = graphRecord(scope, boardId);
    const pending = ledger.snapshot().approvals.find((item) => item.approvalId === approvalId);
    requireValue(pending && pending.status === 'pending' && pending.binding.taskId === taskId &&
      equal(scopeOf(pending.binding), scope) && pending.boardId === boardId && !fenced(record),
    'TASK_APPROVAL_STALE', 'Task preapproval is stale or belongs to other work');
    const ctx = { binding: pending.binding, dependencyReceipts: [], approvalReceiptId: null };
    const guard = grant(record, ctx, 'approval-decision', pending.authority);
    await resolve(ctx, record, 'approval-decision', guard);
    const receipt = await ledger.transact((state) => {
      guard.check();
      const current = state.approvals.find((item) => item.approvalId === approvalId);
      requireValue(current?.status === 'pending' && !fenced(graphRecord(scope, boardId, state), state),
        'TASK_APPROVAL_STALE', 'Task preapproval is no longer pending');
      current.status = decision;
      current.receipt = { receiptId: `preapproval-${randomUUID()}`, outcome: decision,
        binding: current.binding, evidenceRefs: [approvalId] };
      return current.receipt;
    });
    guard.check();
    approvals.get(approvalId)?.resolve(clone(receipt));
    approvals.delete(approvalId);
    notify();
    return receipt;
  }

  function verifyReceipt({ receipt, expected, outcome }) {
    if (!receipt || receipt.outcome !== outcome || !equal(receipt.binding, expected)) return false;
    const state = ledger.snapshot();
    if (['approved', 'rejected'].includes(outcome)) {
      const approval = state.approvals.findLast((item) => equal(item.binding, expected));
      const record = state.graphs.find((item) => item.scope.graphId === expected.graphId);
      try { grant(record, { binding: expected }, 'verify', approval?.authority).check(); } catch { return false; }
      return Boolean(approval && record && !fenced(record, state) && equal(approval.receipt, receipt));
    }
    const attempt = state.attempts.find((item) => equal(item.binding, expected));
    try { grant(graphRecord(scopeOf(expected)), { binding: expected }, 'verify', attempt?.authority).check(); }
    catch { return false; }
    return Boolean(attempt && outcomeOf(attempt.proof) === outcome && equal(attempt.receipt, receipt) &&
      equal(attempt.native, attempt.proof.native));
  }

  async function fenceGraph(scope, boardId) {
    const guard = grant(graphRecord(scope, boardId), {}, 'cancel');
    await ledger.transact((state) => {
      guard.check();
      graphRecord(scope, boardId, state).fenced = true;
      for (const approval of state.approvals) {
        if (equal(scopeOf(approval.binding), scope) && approval.status === 'pending') approval.status = 'cancelled';
      }
    });
    guard.check();
    notify();
  }

  async function reconcile(graph, scope) {
    const record = graphRecord(scope);
    const scopeGuard = grant(record, {}, 'reconcile');
    const projection = graph.getGraph(scope.graphId);
    requireValue(projection && equal(scopeOf(projection), scope), 'TASK_SCOPE', 'Graph projection binding changed');
    if (projection.cancelRequested || fenced(record)) {
      await fenceGraph(scope, record.boardId);
      scopeGuard.check();
      if (!projection.cancelRequested) await graph.cancelGraph(scope);
    }
    scopeGuard.check();
    const results = [];
    for (const old of ledger.snapshot().approvals.filter((item) => equal(scopeOf(item.binding), scope))) {
      if (!old.receipt || graph.getGraph(scope.graphId).cancelRequested) continue;
      requireValue(sameAuthorityOwner(old.authority, record), 'TASK_AUTHORITY',
        'Task preapproval belongs to another owner or delegation', 403);
      const ctx = { binding: old.binding, dependencyReceipts: [], approvalReceiptId: null };
      const guard = grant(record, ctx, 'reconcile-approval');
      await resolve(ctx, record, 'reconcile-approval', guard);
      const approval = await ledger.transact((state) => {
        guard.check();
        const current = state.approvals.find((item) => item.approvalId === old.approvalId);
        requireValue(current && equal(current.binding, old.binding) &&
          equal(current.receipt, old.receipt) && !fenced(graphRecord(scope, record.boardId, state), state),
        'TASK_APPROVAL_STALE', 'Task preapproval changed during reconciliation');
        current.authority = guard.authority;
        return current;
      });
      guard.check();
      await graph.approveTask(approval.receipt);
      guard.check();
      approvals.get(approval.approvalId)?.resolve(clone(approval.receipt));
      approvals.delete(approval.approvalId);
      results.push({ taskId: approval.binding.taskId, status: approval.status });
    }
    for (const old of ledger.snapshot().attempts.filter((item) => equal(scopeOf(item.binding), scope))) {
      let attempt = old;
      requireValue(sameAuthorityOwner(old.authority, record), 'TASK_AUTHORITY',
        'Native attempt belongs to another owner or delegation', 403);
      const ctx = { binding: attempt.binding, dependencyReceipts: [], approvalReceiptId: null };
      const guard = grant(record, ctx, 'reconcile');
      await resolve(ctx, record, 'reconcile', guard);
      if (!attempt.receipt) {
        const candidates = attempt.native ? [attempt.native] :
          [...new Map(attempt.observed.map((proof) => [stableJSON(proof.native), proof.native])).values()];
        if (candidates.length > 1 || !candidates.length && !attempt.candidateConversationId) {
          results.push({ taskId: attempt.binding.taskId, status: 'unknown-intent' }); continue;
        }
        const conversationId = candidates[0]?.conversationId ?? attempt.candidateConversationId;
        let snapshot;
        try { snapshot = await chat.resume({ conversationId, clientThreadId: attempt.clientThreadId }); }
        catch { results.push({ taskId: attempt.binding.taskId, status: 'unavailable' }); continue; }
        guard.check();
        const currentSnapshot = chat.snapshot(conversationId);
        const matching = candidates.length ? snapshot?.runs?.filter((item) => equal(nativeIds(item), candidates[0])) :
          snapshot?.runs?.filter((item) => nativeIds(item) && item.clientThreadId === attempt.clientThreadId &&
            (item.requestId === attempt.requestId || item.requestId == null && snapshot.runs.length === 1 &&
              snapshot.historyComplete === true && snapshot.truncated === false));
        const run = matching?.length === 1 ? matching[0] : null;
        const ids = nativeIds(run);
        if (snapshot?.connection !== 'ready' || snapshot.protocolVersion !== 2 ||
            snapshot.streamId !== currentSnapshot?.streamId || !run || !ids ||
            (run.requestId !== null && run.requestId !== undefined && run.requestId !== attempt.requestId) ||
            run.error?.origin === 'bridge') {
          results.push({ taskId: attempt.binding.taskId, status: 'unverified' }); continue;
        }
        const proof = { kind: 'resume-snapshot', native: ids, requestId: attempt.requestId,
          status: run.status, stopConfirmed: run.stopConfirmed === true,
          streamId: snapshot.streamId, seq: snapshot.seq };
        attempt = await ledger.transact((state) => {
          guard.check();
          const current = state.attempts.find((item) => item.key === old.key);
          current.authority = guard.authority;
          if (!current.native) current.native = ids;
          if (!current.receipt) current.phase = 'accepted';
          if (outcomeOf(proof)) finish(current, proof);
          return current;
        });
        guard.check();
      } else {
        // A persisted terminal proof can be reauthorized only for the same
        // owner and parent delegation, never for a replacement account.
        attempt = await ledger.transact((state) => {
          guard.check();
          const current = state.attempts.find((item) => item.key === old.key);
          current.authority = guard.authority;
          return current;
        });
        guard.check();
      }
      if (attempt.receipt) {
        settle(attempt);
        if (attempt.receipt.outcome === 'cancelled') {
          if (graph.getGraph(scope.graphId).cancelRequested) await graph.confirmCancellation(attempt.receipt);
          else { results.push({ taskId: attempt.binding.taskId, status: 'native-interrupted-needs-cancel' }); continue; }
        } else await graph.recordOutcome(attempt.receipt);
        guard.check();
      } else if (graph.getGraph(scope.graphId).cancelRequested) {
        const ctx = { binding: attempt.binding, dependencyReceipts: [], approvalReceiptId: null };
        void interrupt(ctx).then((receipt) => receipt && graph.confirmCancellation(receipt)).catch(() => {});
        void sendInterrupt(attempt.key).catch(() => {});
      }
      results.push({ taskId: attempt.binding.taskId, status: attempt.receipt?.outcome ?? 'running-unconfirmed' });
    }
    scopeGuard.check();
    notify();
    return { graphId: scope.graphId, results };
  }

  function getState(graphId) {
    const state = ledger.snapshot();
    const record = state.graphs.find((item) => item.scope.graphId === graphId);
    if (!record) return null;
    grant(record, {}, 'inspect').check();
    return { boardId: record.boardId, scope: clone(record.scope), fenced: fenced(record, state),
      attempts: state.attempts.filter((item) => item.binding.graphId === graphId).map((item) => ({
        binding: clone(item.binding), phase: item.phase, native: clone(item.native),
        interruptRequested: item.interruptRequested, interruptSent: item.interruptSent,
        outcome: item.receipt?.outcome ?? null,
      })),
      approvals: state.approvals.filter((item) => item.binding.graphId === graphId).map((item) => ({
        approvalId: item.approvalId, taskId: item.binding.taskId, status: item.status,
      })),
    };
  }

  function boardState(graph, board) {
    const state = ledger.snapshot();
    const records = state.graphs.filter((item) => sameBoard(item, board));
    for (const record of records) grant(record, {}, 'inspect').check();
    const closing = state.boardFences.some((item) => sameBoard(item, board));
    const graphsStopped = records.every((item) => {
      const projection = graph.getGraph(item.scope.graphId);
      return projection && equal(scopeOf(projection), item.scope) && projection.tasks.every((task) =>
        ['completed', 'failed', 'cancelled'].includes(task.status));
    });
    const nativeStopped = state.attempts.filter((item) => sameBoard(item, board)).every((item) =>
      item.receipt && outcomeOf(item.proof));
    return { ...board, closing, canClose: closing && graphsStopped && nativeStopped,
      graphIds: records.map((item) => item.scope.graphId) };
  }

  async function cancelBoard(graph, board) {
    requireValue(ref(board?.boardId) && ref(board?.requestedBy), 'TASK_SCOPE', 'Exact Board owner is required', 400);
    const records = ledger.snapshot().graphs.filter((item) => sameBoard(item, board));
    requireValue(records.length > 0, 'TASK_SCOPE', 'No registered work for this Board');
    const guards = records.map((record) => grant(record, {}, 'cancel-board'));
    await ledger.transact((state) => {
      guards.forEach((guard) => guard.check());
      if (!state.boardFences.some((item) => sameBoard(item, board))) state.boardFences.push(pick(board, ['boardId', 'requestedBy']));
    });
    guards.forEach((guard) => guard.check());
    for (const record of ledger.snapshot().graphs.filter((item) => sameBoard(item, board))) {
      await fenceGraph(record.scope, record.boardId);
      await graph.cancelGraph(record.scope);
      guards.forEach((guard) => guard.check());
    }
    notify();
    return boardState(graph, board);
  }

  function waitForBoardStop(graph, board) {
    return new Promise((resolveWait, rejectWait) => {
      let unsubscribe = () => {};
      const cleanup = () => { listeners.delete(check); unsubscribe(); };
      const check = () => {
        try {
          const state = boardState(graph, board);
          if (state.canClose) { cleanup(); resolveWait(state); }
        } catch (error) { cleanup(); rejectWait(error); }
      };
      listeners.add(check);
      unsubscribe = graph.subscribe(check);
      check();
    });
  }

  return { execute, interrupt, requestApproval, verifyReceipt, onChatEvent, reconcile,
    decideTaskApproval, registerGraph, fenceGraph, getState, cancelBoard, boardState,
    waitForBoardStop, assertScope: (scope, boardId) => {
      const record = graphRecord(scope, boardId);
      grant(record, {}, 'access').check();
      return clone(record);
    },
    // Argument-free change hint (approval issued, attempt settled); readers
    // refetch getState through the authority-checked route.
    subscribe(listener) {
      requireValue(typeof listener === 'function', 'TASK_ADAPTER_CONFIG', 'listener must be a function', 500);
      listeners.add(listener);
      return () => listeners.delete(listener);
    } };
}
