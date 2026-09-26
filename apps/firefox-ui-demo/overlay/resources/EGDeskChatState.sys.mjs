// Pure reducer for the additive Codex chat protocol v2.
const copy = value => value == null ? value : JSON.parse(JSON.stringify(value));
export const isRunBusy = run => !!run && !['completed', 'interrupted', 'failed', 'cancelled', 'unavailable'].includes(run.status);
export const runKey = (conversationId, runId) => `${conversationId}/${runId}`;
export function createChatProtocolState() {
  return { requests: {}, runs: {}, streams: {}, histories: {}, streamGeneration: 0, connection: 'offline', unobservedPreviousRun: false };
}
export function resetChatProtocol(state) {
  const unobserved = state.unobservedPreviousRun || Object.values(state.runs).some(run => isRunBusy(run) || run.error?.code === 'RUNTIME_LOST')
    || Object.values(state.requests).some(request => ['submitting', 'unconfirmed'].includes(request.status));
  for (const key of Object.keys(state)) delete state[key];
  Object.assign(state, createChatProtocolState(), { unobservedPreviousRun: !!unobserved });
}
export function canAdmitChatEvent(state, threads, event) {
  const request = event?.requestId && state.requests[event.requestId];
  if (request && event.clientThreadId && request.clientThreadId !== event.clientThreadId) return false;
  return !!request
    || threads.some(thread => thread.conversationId && thread.conversationId === event?.conversationId);
}
export const clientThreadBinding = thread => thread?.clientBindingId || thread?.id || null;
export const freshClientThreadBinding = (thread, nonce) => `${thread.id}-binding-${nonce}`;
export const requestBelongsToThread = (request, thread) => !!thread && (request.localThreadId === thread.id || request.clientThreadId === clientThreadBinding(thread));
export function createChatEpochScope({ makeController = () => new AbortController() } = {}) {
  let epoch = 0;
  const active = new Set();
  return {
    current: () => epoch,
    begin: () => { const controller = makeController(); const token = { epoch, controller, signal: controller.signal }; active.add(token); return token; },
    valid: token => (typeof token === 'number' ? token : token.epoch) === epoch,
    finish: token => active.delete(token),
    reset: () => { epoch++; for (const token of active) token.controller.abort(); active.clear(); },
  };
}
export function codexAccountKey(status) {
  if (!status?.isLoggedIn) return null;
  const identity = status.accountId || status.accountEmail;
  return identity ? `codex:${status.authMode || ''}:${identity}` : null;
}
export function submissionFailureStatus(error) {
  if (error?.resumeRequired === true) return 'unconfirmed';
  if (error?.accepted === false) return 'failed';
  if (error?.status >= 400 && error.status < 500 && error.status !== 408) return 'failed';
  return 'unconfirmed';
}
export function settleReconciledRequests(state, clientThreadId, snapshot) {
  if (snapshot?.historyComplete !== true || snapshot.truncated === true) return 0;
  let count = 0;
  for (const request of Object.values(state.requests)) {
    if ((request.localThreadId === clientThreadId || request.clientThreadId === clientThreadId) && request.status === 'unconfirmed') {
      request.status = 'reconciled';
      count++;
    }
  }
  return count;
}
function ensureStream(state, id) {
  return state.streams[id] ||= { seen: {}, checkpoints: {}, seq: -1, generation: ++state.streamGeneration };
}
export function registerChatRequest(state, request) {
  state.requests[request.requestId] = { ...request, status: 'submitting' };
}
export function buildChatRequest(thread, message, requestId, runtime = {}) {
  const body = { message, requestId, clientThreadId: clientThreadBinding(thread), profileEnabled: thread.profileEnabled === true };
  if (thread.conversationId) body.conversationId = thread.conversationId;
  for (const field of ['cwd', 'model', 'effort']) if (runtime[field]) body[field] = runtime[field];
  if (thread.profileEnabled === true) {
    body.profileEnabled = true;
    for (const field of ['agentProfile', 'systemPrompt', 'toolMode']) if (runtime[field]) body[field] = runtime[field];
  }
  return body;
}
function ensureRun(state, identity) {
  const request = state.requests[identity.requestId];
  const conversationId = identity.conversationId || request?.conversationId;
  const runId = identity.runId || request?.runId;
  if (!conversationId || !runId) return null;
  const key = runKey(conversationId, runId);
  const run = state.runs[key] ||= {
    conversationId, runId, answerId: key, status: 'running', stopRequested: false,
    messages: [], activities: [], artifacts: [], pendingApprovals: [], error: null, summary: '',
  };
  for (const field of ['requestId', 'clientThreadId', 'localThreadId', 'answerId', 'authorName']) {
    if (identity[field] || request?.[field]) run[field] = identity[field] || request[field];
  }
  if (request) Object.assign(request, { conversationId, runId, answerId: run.answerId, status: 'accepted' });
  return run;
}
export function acceptChatRequest(state, response, requestId) {
  if (!response?.accepted) return null;
  return ensureRun(state, { ...response, requestId: response.requestId || requestId });
}
function upsert(items, item, key = 'id') {
  const index = items.findIndex(old => old[key] === item[key]);
  if (index < 0) items.push(item);
  else items[index] = { ...items[index], ...item };
}
export function usableArtifact(artifact) {
  return artifact?.type === 'file' && artifact.status === 'available' && artifact.id
    && typeof artifact.target?.path === 'string' && artifact.target.path.startsWith('/')
    && artifact.relation === 'referenced' && artifact.verifiedAt != null;
}
export function reduceChatEvent(state, event) {
  if (event?.type !== 'chat.event' || event.v !== 2 || event.provider !== 'codex') return null;
  if (!event.streamId || !Number.isSafeInteger(event.seq)) return null;
  const stream = ensureStream(state, event.streamId);
  if (event.seq <= (stream.checkpoints[event.conversationId] ?? -1) || stream.seen[event.seq]) return null;
  stream.seen[event.seq] = true;
  stream.seq = Math.max(stream.seq, event.seq);
  const run = ensureRun(state, event);
  if (!run) return null;
  if (run.streamId && state.streams[run.streamId]?.generation > stream.generation) return null;
  run.streamId = event.streamId;
  run.seq = Math.max(run.seq || -1, event.seq);
  const details = event.details || {};
  if (event.event.startsWith('message.')) {
    const id = details.messageId || event.itemId;
    if (!id) return run;
    let message = run.messages.find(item => item.id === id);
    if (!message) { message = { id, role: 'assistant', content: '', status: 'streaming', createdAt: event.ts }; run.messages.push(message); }
    if (event.event === 'message.started' && !message.content && typeof details.text === 'string') message.content = details.text;
    if (details.phase) message.phase = details.phase;
    if (event.event === 'message.delta' && message.completionConfirmed !== true) {
      message.content += details.delta || '';
      message.status = 'streaming';
    }
    if (event.event === 'message.completed') {
      if (typeof details.text === 'string') message.content = details.text;
      message.status = 'complete';
      message.completionConfirmed = true;
    }
    message.answerId = run.answerId;
    message.runId = run.runId;
  } else if (event.event.startsWith('activity.')) {
    const activity = details.activity || details;
    const id = activity.id || event.itemId;
    if (id) upsert(run.activities, { ...activity, id });
  } else if (event.event === 'plan.updated') {
    run.plan = copy(details.plan || details);
  } else if (event.event === 'summary.delta') {
    run.summary = typeof details.text === 'string' ? details.text : run.summary + (details.delta || '');
  } else if (event.event === 'artifact.available') {
    const artifacts = Array.isArray(details.artifacts) ? details.artifacts : [details.artifact || details];
    for (const artifact of artifacts) if (usableArtifact(artifact)) upsert(run.artifacts, copy(artifact));
  } else if (event.event === 'approval.required') {
    const approval = details.approval || details;
    const id = approval.id || approval.approvalId || event.itemId;
    if (id) upsert(run.pendingApprovals, { ...approval, id });
  } else if (event.event === 'approval.resolved') {
    const id = details.id || details.approvalId || event.itemId;
    run.pendingApprovals = run.pendingApprovals.filter(item => item.id !== id);
  } else if (event.event === 'run.stop_requested') {
    run.stopRequested = true;
    if (isRunBusy(run)) run.status = 'stopping';
  } else if (event.event === 'run.completed') {
    run.status = details.status || 'completed';
    run.error = details.error || null;
    run.pendingApprovals = [];
    for (const message of run.messages) {
      if (message.status === 'streaming') message.status = run.status === 'completed' ? 'complete' : 'partial';
    }
  } else if (event.event === 'run.unavailable') {
    run.error = details.error || { code: 'RUNTIME_LOST', message: '실행 연결이 끊어졌습니다.' };
    if (run.error.code === 'RUNTIME_LOST') {
      state.connection = 'offline';
      run.status = 'failed';
      run.pendingApprovals = [];
      for (const message of run.messages) if (message.status === 'streaming') message.status = 'partial';
    } else {
      run.status = details.status || run.status;
    }
  } else if (event.event === 'run.started' && isRunBusy(run)) {
    run.status = run.stopRequested ? 'stopping' : 'running';
    state.connection = 'ready';
  }
  return run;
}

function mergeItems(existing, incoming, preferExisting) {
  const result = copy(existing || []);
  for (const item of incoming || []) {
    const id = item.id || item.messageId;
    if (!id) continue;
    const previous = result.find(value => value.id === id);
    upsert(result, preferExisting && previous ? { ...item, ...previous } : { ...item, id });
  }
  return result;
}
export function mergeChatSnapshot(state, snapshot, clientThreadId) {
  if (!snapshot?.conversationId) return [];
  const stream = snapshot.streamId ? ensureStream(state, snapshot.streamId) : null;
  if (!stream || stream.generation === state.streamGeneration) state.connection = snapshot.connection || 'offline';
  const stale = stream && stream.seq > snapshot.seq;
  const previousHistory = state.histories[snapshot.conversationId];
  const historyCurrent = !previousHistory || !stream || (stream.generation > (state.streams[previousHistory.streamId]?.generation || 0))
    || (previousHistory.streamId === snapshot.streamId && snapshot.seq >= previousHistory.seq);
  if (historyCurrent) state.histories[snapshot.conversationId] = {
    streamId: snapshot.streamId, seq: snapshot.seq,
    truncated: snapshot.truncated === true, historyComplete: snapshot.historyComplete === true,
  };
  const changed = [];
  for (const incoming of snapshot.runs || []) {
    const run = ensureRun(state, { ...incoming, conversationId: snapshot.conversationId, clientThreadId });
    if (!run) continue;
    const preserve = (stale && run.streamId === snapshot.streamId && run.seq > snapshot.seq)
      || (stream && run.streamId && state.streams[run.streamId]?.generation > stream.generation);
    for (const key of ['messages', 'activities', 'artifacts']) {
      const values = key === 'artifacts' ? (incoming[key] || []).filter(usableArtifact)
        : key === 'messages' ? (incoming[key] || []).map(message => ({
          ...message, content: message.text ?? message.content ?? '',
          completionConfirmed: message.completionConfirmed === true || run.messages.some(previous => previous.id === (message.id || message.messageId) && previous.completionConfirmed === true),
        })) : incoming[key];
      run[key] = key === 'artifacts' && !preserve && !snapshot.truncated && !incoming.truncated
        ? copy(values) : mergeItems(run[key], values, preserve);
    }
    run.messages = run.messages.map(message => ({ ...message, content: message.content ?? message.text ?? '', status: message.status === 'completed' ? 'complete' : message.status, role: message.role || 'assistant', runId: run.runId, answerId: run.answerId }));
    if (!preserve) {
      for (const key of ['status', 'stopRequested', 'error', 'summary', 'plan', 'pendingApprovals', 'truncated', 'historyComplete']) if (key in incoming) run[key] = copy(incoming[key]);
      run.pendingApprovals = (run.pendingApprovals || []).map(approval => ({ ...approval, id: approval.id || approval.approvalId }));
      if (stream) { run.streamId = snapshot.streamId; run.seq = snapshot.seq; }
    }
    changed.push(run);
  }
  if (stream && Number.isSafeInteger(snapshot.seq)) {
    stream.checkpoints[snapshot.conversationId] = Math.max(stream.checkpoints[snapshot.conversationId] ?? -1, snapshot.seq);
    stream.seq = Math.max(stream.seq, snapshot.seq);
  }
  return changed;
}

export function runsForThread(state, thread) {
  if (!thread) return [];
  return Object.values(state.runs).filter(run => run.localThreadId === thread?.id || run.clientThreadId === clientThreadBinding(thread) || (thread?.conversationId && run.conversationId === thread.conversationId));
}

export function approvalRequestFor(run, approvalId, decision) {
  const approval = run?.pendingApprovals.find(item => (item.approvalId || item.id) === approvalId);
  if (!approval || approval.status !== 'pending' || approval.replyPending || approval.stale || !approval.choices?.includes(decision)) return null;
  if (decision === 'accept' && !approvalScopeKnown(approval)) return null;
  return { approvalId, conversationId: run.conversationId, runId: run.runId, decision };
}

export function approvalScopeKnown(approval) {
  if (!['commandExecution', 'fileChange'].includes(approval?.kind)) return false;
  if (approval.acceptDisabledReason) return false;
  if (approval.networkApprovalContext != null) {
    const context = approval.networkApprovalContext;
    return !!context && typeof context.host === 'string' && !!context.host.trim()
      && typeof context.protocol === 'string' && !!context.protocol.trim();
  }
  return true;
}

export function acknowledgeApprovalReply(run, reply) {
  if (!reply?.accepted || reply.status !== 'replySent' || reply.conversationId !== run?.conversationId || reply.runId !== run?.runId) return false;
  const approval = run.pendingApprovals.find(item => (item.approvalId || item.id) === reply.approvalId);
  if (approval) { approval.status = 'replySent'; approval.replyPending = false; }
  return true;
}

// Correlate native items with the submitted request/turn, then preserve role order.
// Matching by text alone would merge repeated prompts or messages in other turns.
export function projectRunMessages(existing, run, now = Date.now()) {
  const messages = existing.map(message => run.requestId && message.requestId === run.requestId && message.role === 'user'
    ? { ...message, status: 'complete', conversationId: run.conversationId, runId: run.runId, answerId: run.answerId }
    : { ...message });
  const ordinal = { user: 0, assistant: 0 };
  for (const incoming of run.messages || []) {
    const role = incoming.role || 'assistant';
    const order = ordinal[role] || 0;
    ordinal[role] = order + 1;
    const sameTurn = message => message.runId === run.runId && (!message.conversationId || message.conversationId === run.conversationId);
    let index = messages.findIndex(message => sameTurn(message) && (message.providerItemId === incoming.id || message.id === incoming.id));
    if (index < 0 && role === 'user') {
      const candidates = messages.map((message, i) => ({ message, i })).filter(({ message }) => sameTurn(message) && message.role === 'user');
      const candidate = candidates[order];
      if (candidate && !candidate.message.providerItemId) index = candidate.i;
    }
    const previous = index >= 0 ? messages[index] : null;
    const projected = {
      ...previous, ...incoming, role, id: previous?.id || incoming.id,
      providerItemId: incoming.id, content: incoming.content ?? incoming.text ?? '',
      authorName: role === 'assistant' ? previous?.authorName || run.authorName || 'Codex' : previous?.authorName,
      createdAt: previous?.createdAt || incoming.createdAt || now,
      conversationId: run.conversationId, runId: run.runId, answerId: run.answerId, artifacts: [],
    };
    if (index < 0) messages.push(projected);
    else messages[index] = projected;
  }
  const last = messages.findLast(message => message.role === 'assistant' && message.runId === run.runId && message.conversationId === run.conversationId);
  if (last) last.artifacts = (run.artifacts || []).filter(usableArtifact);
  return messages;
}
