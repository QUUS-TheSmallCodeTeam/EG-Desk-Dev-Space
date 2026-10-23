// Pure reducer for the additive Codex chat protocol v2.
const copy = value => value == null ? value : JSON.parse(JSON.stringify(value));
export const isRunBusy = run => !!run && run.localHistory !== true && !['completed', 'interrupted', 'failed', 'cancelled', 'unavailable'].includes(run.status);
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

// The durable local key is the UI room ID. Native client bindings may rotate on
// restore or account change, and must never become the history lookup key.
export const localClientThreadId = thread => typeof thread?.id === 'string' && thread.id.trim() ? thread.id : null;

// Extract the old Desk-pref shape without deleting it or inferring any native
// ownership from the account currently signed in. The HTTP adapter can map
// these records to its import payload once the runtime response is fixed.
export function extractLegacyChatRecords(deskSnapshot) {
  const chat = deskSnapshot?.chat;
  if (!Array.isArray(chat?.threads)) return [];
  const seen = new Set();
  const records = [];
  for (const thread of chat.threads) {
    const clientThreadId = localClientThreadId(thread);
    if (!clientThreadId || seen.has(clientThreadId)) continue;
    seen.add(clientThreadId);
    records.push({
      clientThreadId,
      importId: `firefox-pref:egdesk.deskSession.v1:${clientThreadId}`,
      threadSnapshot: copy(thread),
      draft: typeof chat.threadDrafts?.[clientThreadId] === 'string' ? chat.threadDrafts[clientThreadId] : '',
      savedAccountKey: chat.codexAccountKey || null,
      savedAt: deskSnapshot.savedAt ?? null,
    });
  }
  return records;
}

const legacyLocalId = (kind, ...parts) => `legacy-${kind}:${parts.map(value => {
  const part = String(value ?? '');
  return `${part.length}:${part}`;
}).join('')}`;

// Every saved item gets a deterministic local identity. Native IDs are copied
// only when the old record actually had them; local-only/optimistic items are
// still importable, but cannot acquire native resume authority from this data.
export function legacyPublicChatSnapshot(record) {
  const thread = record?.threadSnapshot;
  const clientThreadId = record?.clientThreadId;
  if (!clientThreadId || !Array.isArray(thread?.messages) || !thread.messages.length) return null;
  const threadConversationId = thread.conversationId || thread.retainedNativeBinding?.conversationId || null;
  const provenance = { scope: 'egdesk-local', source: 'firefox-pref', version: 1, importId: record.importId || null };
  const runs = new Map();
  const seenMessages = new Set();
  for (const [index, message] of thread.messages.entries()) {
    if (!['user', 'assistant'].includes(message?.role)) continue;
    const legacyMessageId = typeof message.id === 'string' && message.id ? message.id : `ordinal-${index}`;
    const localMessageId = legacyLocalId('message', clientThreadId, legacyMessageId);
    if (seenMessages.has(localMessageId)) continue;
    seenMessages.add(localMessageId);
    const runId = typeof message.runId === 'string' && message.runId ? message.runId : null;
    const conversationId = typeof message.conversationId === 'string' && message.conversationId
      ? message.conversationId : runId ? threadConversationId : null;
    const messageId = typeof message.providerItemId === 'string' && message.providerItemId
      ? message.providerItemId : typeof message.messageId === 'string' && message.messageId ? message.messageId : null;
    const runSource = runId ? ['native', conversationId, runId]
      : message.requestId ? ['request', message.requestId]
        : message.answerId ? ['answer', message.answerId] : ['message', legacyMessageId];
    const localRunId = legacyLocalId('run', clientThreadId, ...runSource);
    const answerId = message.answerId || (conversationId && runId ? runKey(conversationId, runId) : null);
    const run = runs.get(localRunId) || { localRunId, conversationId, runId, answerId,
      requestId: message.requestId || null, status: 'unavailable', messages: [], activities: [], artifacts: [],
      pendingApprovals: [], historyComplete: false, truncated: true, provenance: copy(provenance) };
    if (!run.requestId && message.requestId) run.requestId = message.requestId;
    if (!run.answerId && answerId) run.answerId = answerId;
    const item = { id: messageId, messageId, localMessageId, localRunId,
      conversationId, runId, answerId, requestId: message.requestId || null,
      role: message.role, text: message.content ?? message.text ?? '',
      status: message.status === 'completed' ? 'complete' : message.status || 'partial',
      createdAt: message.createdAt || null, provenance: copy(provenance) };
    if (message.phase) item.phase = message.phase;
    if (message.inputReferences?.length) item.inputReferences = copy(message.inputReferences);
    if (message.readBy?.length) item.readBy = copy(message.readBy);
    if (message.briefing) item.briefing = copy(message.briefing);
    if (message.contextCaptures?.length) item.contextCaptures = copy(message.contextCaptures);
    if (message.contextEvents?.length) item.contextEvents = copy(message.contextEvents);
    if (message.contextPackets?.length) item.contextPackets = copy(message.contextPackets);
    if (message.artifacts?.length) item.artifacts = message.artifacts.filter(usableArtifact).map(copy);
    run.messages.push(item);
    if (message.role === 'assistant') {
      if (message.authorName) run.authorName = message.authorName;
      if (message.artifacts?.length) run.artifacts = message.artifacts.filter(usableArtifact).map(copy);
      if (message.briefing) run.briefing = copy(message.briefing);
      if (message.contextCaptures?.length) run.contextCaptures = copy(message.contextCaptures);
      if (message.contextEvents?.length) run.contextEvents = copy(message.contextEvents);
      if (message.contextPackets?.length) run.contextPackets = copy(message.contextPackets);
    }
    runs.set(localRunId, run);
  }
  if (!runs.size) return null;
  for (const run of runs.values()) {
    if (run.contextCaptures || run.contextPackets || run.briefing) run.context = {
      captures: copy(run.contextCaptures || []), packets: copy(run.contextPackets || []),
      briefings: run.briefing ? [copy(run.briefing)] : [],
    };
    if (typeof thread.cwd === 'string') run.cwdPublic = thread.cwd;
  }
  const nativeConversationIds = new Set([...runs.values()].map(run => run.conversationId));
  const conversationId = nativeConversationIds.size === 1 && !nativeConversationIds.has(null)
    ? [...nativeConversationIds][0] : null;
  return { protocolVersion: 2, conversationId, streamId: null, seq: 0,
    truncated: true, historyComplete: false, provenance,
    coverage: { scope: 'egdesk-local', status: 'partial', reasons: ['legacy-pref-import'], nativeHistoryComplete: false },
    runs: [...runs.values()] };
}

function sameLocalMessage(a, b) {
  if (!a || !b || (a.role || 'assistant') !== (b.role || 'assistant')) return false;
  for (const field of ['conversationId', 'runId']) {
    if (a[field] && b[field] && a[field] !== b[field]) return false;
  }
  if (a.localMessageId && b.localMessageId && a.localMessageId === b.localMessageId) return true;
  if (a.id && b.id && a.id === b.id) return true;
  const nativeA = a.providerItemId || a.messageId;
  const nativeB = b.providerItemId || b.messageId;
  if (nativeA && nativeB && nativeA === nativeB) return true;
  return a.role === 'user' && !!a.requestId && a.requestId === b.requestId;
}

// DB pages may arrive after a newer live event or optimistic send. Prefer the
// current UI copy of a correlated message, and never match merely by text.
export function mergeLocalChatMessages(current = [], persisted = [], { liveFenceRevision = 0 } = {}) {
  const messages = [];
  for (const stored of Array.isArray(persisted) ? persisted : []) {
    if (!stored || typeof stored !== 'object') continue;
    const index = messages.findIndex(message => sameLocalMessage(message, stored));
    if (index < 0) messages.push(copy(stored));
    else messages[index] = { ...messages[index], ...copy(stored) };
  }
  for (const live of Array.isArray(current) ? current : []) {
    if (!live || typeof live !== 'object') continue;
    const index = messages.findIndex(message => sameLocalMessage(message, live));
    if (index < 0) messages.push(copy(live));
    else {
      const stored = messages[index];
      const liveChangedDuringRead = Number.isSafeInteger(live.liveRevision) && live.liveRevision > liveFenceRevision;
      const ordered = Number.isSafeInteger(stored.localSeq) && Number.isSafeInteger(live.localSeq)
        && stored.localSeq !== live.localSeq;
      const storedNewer = ordered ? stored.localSeq > live.localSeq
        : ['complete', 'completed'].includes(stored.status) && !['complete', 'completed'].includes(live.status);
      const liveNewer = ordered ? live.localSeq > stored.localSeq
        : ['complete', 'completed'].includes(live.status) && !['complete', 'completed'].includes(stored.status);
      const preferLive = liveChangedDuringRead || liveNewer || !storedNewer;
      const merged = preferLive ? { ...stored, ...copy(live) } : { ...copy(live), ...stored };
      merged.id = live.id || stored.id;
      if (live.createdAt) merged.createdAt = live.createdAt;
      messages[index] = merged;
    }
  }
  return messages.map((message, index) => ({ message, index })).sort((a, b) => {
    const seqA = a.message.localSeq, seqB = b.message.localSeq;
    if (Number.isSafeInteger(seqA) && Number.isSafeInteger(seqB) && seqA !== seqB) return seqA - seqB;
    const timeA = a.message.createdAt, timeB = b.message.createdAt;
    if (typeof timeA === 'number' && typeof timeB === 'number' && timeA !== timeB) return timeA - timeB;
    return a.index - b.index;
  }).map(({ message }) => message);
}

// `history` is the single normalized adapter boundary for local DB responses:
// { clientThreadId, localConversationId, threadSnapshot?, messages? }.
// The caller supplies a detached/restored current room; a read never promotes
// a persisted native conversation or replaces a live composer/attachment set.
export function hydrateLocalChatThread(current, history, options = {}) {
  const clientThreadId = localClientThreadId(current);
  if (!clientThreadId || history?.clientThreadId !== clientThreadId) return current;
  if (history.threadSnapshot?.id && history.threadSnapshot.id !== clientThreadId) return current;
  if (current.localConversationId && history.localConversationId && current.localConversationId !== history.localConversationId) return current;
  const saved = history.threadSnapshot || {};
  const persistedMessages = Array.isArray(history.messages) ? history.messages : saved.messages;
  const currentMessages = (current.messages || []).map((message, index) =>
    message.localMessageId || message.localHistory === true || Number.isSafeInteger(message.liveRevision)
      ? message : { ...message, localMessageId: legacyLocalId('message', clientThreadId,
        typeof message.id === 'string' && message.id ? message.id : `ordinal-${index}`) });
  const localRuns = mergeLocalChatRuns(current.localRuns, history.runs);
  return {
    ...copy(saved), ...current,
    id: clientThreadId,
    localConversationId: history.localConversationId || current.localConversationId || saved.localConversationId || null,
    conversationId: current.conversationId || null,
    clientBindingId: current.clientBindingId || null,
    bindingAccountKey: current.bindingAccountKey || null,
    bindingState: current.bindingState || 'fresh',
    retainedNativeBinding: current.retainedNativeBinding || null,
    messages: projectLocalRunRelations(mergeLocalChatMessages(currentMessages, persistedMessages, options), localRuns),
    localRuns,
    localHistoryCoverage: history.coverage || current.localHistoryCoverage || null,
  };
}

// Historical run projections can carry a published Briefing even when the
// bounded message projection does not. Bind by run identity, never by the
// visible/local message ID (Answer ID is the native conversation/run pair).
export function projectLocalRunRelations(messages, runs) {
  const projected = (messages || []).map(copy);
  for (const run of runs || []) {
    const briefing = run.briefing || run.context?.briefings?.at(-1);
    if (!briefing) continue;
    const identity = {
      conversationId: run.conversationId || briefing.conversationId || null,
      runId: run.runId || briefing.runId || null,
      answerId: run.answerId || briefing.answerId || null,
    };
    if (['conversationId', 'runId', 'answerId'].some(key => run[key] && briefing[key] && run[key] !== briefing[key])) continue;
    const candidates = projected.map((message, index) => ({ message, index })).filter(({ message }) => {
      if (message.role !== 'assistant') return false;
      const localMatch = !!run.localRunId && message.localRunId === run.localRunId;
      const nativeMatch = !!run.conversationId && !!run.runId
        && message.conversationId === run.conversationId && message.runId === run.runId;
      if (!localMatch && !nativeMatch) return false;
      return ['conversationId', 'runId', 'answerId'].every(key => !message[key] || !identity[key] || message[key] === identity[key]);
    });
    const target = candidates.findLast(({ message }) => message.phase === 'final_answer') || candidates.at(-1);
    if (!target) continue;
    const next = { ...target.message };
    for (const key of ['conversationId', 'runId', 'answerId']) if (!next[key] && identity[key]) next[key] = identity[key];
    next.briefing = copy(briefing);
    for (const [key, fallback] of [
      ['contextCaptures', run.context?.captures], ['contextPackets', run.context?.packets],
      ['artifacts', run.artifacts],
    ]) {
      const value = run[key] || fallback;
      if ((!Array.isArray(next[key]) || !next[key].length) && Array.isArray(value) && value.length) next[key] = copy(value);
    }
    projected[target.index] = next;
  }
  return projected;
}

export function mergeLocalChatRuns(current = [], persisted = []) {
  const runs = (Array.isArray(current) ? current : []).map(copy);
  for (const incoming of Array.isArray(persisted) ? persisted : []) {
    if (!incoming?.localRunId && !(incoming?.conversationId && incoming?.runId)) continue;
    const index = runs.findIndex(run => incoming.localRunId && run.localRunId === incoming.localRunId
      || incoming.conversationId && incoming.runId && run.conversationId === incoming.conversationId && run.runId === incoming.runId);
    if (index < 0) runs.push(copy(incoming));
    else {
      const previous = runs[index];
      const ordered = Number.isSafeInteger(previous.localSeq) && Number.isSafeInteger(incoming.localSeq);
      const previousNewer = ordered ? previous.localSeq > incoming.localSeq
        : ['completed', 'failed', 'interrupted', 'cancelled'].includes(previous.status)
          && !['completed', 'failed', 'interrupted', 'cancelled'].includes(incoming.status);
      runs[index] = previousNewer ? { ...copy(incoming), ...previous } : { ...previous, ...copy(incoming) };
    }
  }
  return runs;
}

// This is the only v1 HTTP-to-UI adapter. Historical events are retained as
// data, never dispatched through reduceChatEvent (which would replay effects).
export function normalizeLocalHistoryPage(page, clientThreadId) {
  if (page?.protocolVersion !== 1 || !page.thread || page.thread.clientThreadId !== clientThreadId) return null;
  const localConversationId = page.thread.localConversationId;
  if (typeof localConversationId !== 'string' || !localConversationId) return null;
  const asMessage = (message, event = {}) => ({
    ...copy(message),
    localMessageId: message.localMessageId || event.localMessageId || undefined,
    localRunId: message.localRunId || event.localRunId || undefined,
    messageId: message.messageId || event.messageId || undefined,
    id: message.localMessageId || event.localMessageId || message.id || message.messageId || event.messageId,
    providerItemId: message.providerItemId || message.messageId || event.messageId || undefined,
    content: message.content ?? message.text ?? '',
    localSeq: event.seq ?? message.localSeq,
    localHistory: true,
  });
  const asRun = (run, event = {}) => ({
    ...copy(run), localRunId: run.localRunId || event.localRunId || undefined,
    runId: run.runId || event.runId || undefined,
    localSeq: event.seq ?? run.localSeq,
    localHistory: true, localThreadId: clientThreadId, localConversationId,
    pendingApprovals: (run.pendingApprovals || []).map(approval => ({ ...approval, stale: true })),
    pendingUserInputs: (Array.isArray(run.pendingUserInputs) ? run.pendingUserInputs : []).map(publicUserInput).filter(Boolean).map(input => ({ ...input, stale: true })),
    subAgents: (Array.isArray(run.subAgents) ? run.subAgents : []).map(publicSubAgent).filter(Boolean).slice(0, MAX_SUB_AGENTS),
  });
  const events = copy(Array.isArray(page.events) ? page.events : []);
  const eventMessages = [];
  const eventRuns = [];
  for (const event of events) {
    if (event.details?.message) {
      const item = asMessage(event.details.message, event);
      const index = eventMessages.findIndex(previous => sameLocalMessage(previous, item));
      if (index < 0) eventMessages.push(item);
      else eventMessages[index] = { ...eventMessages[index], ...item };
    }
    if (event.details?.run) eventRuns.push(asRun(event.details.run, event));
  }
  const messages = mergeLocalChatMessages(eventMessages,
    (Array.isArray(page.messages) ? page.messages : []).map(message => asMessage(message)).filter(message => !!message.id));
  const runs = mergeLocalChatRuns((Array.isArray(page.runs) ? page.runs : []).map(run => asRun(run)), eventRuns);
  const coverage = copy(page.coverage || null);
  const missingCheckpoint = page.projectionTruncated === true && events.some(event => !event.details?.message && !event.details?.run);
  return {
    clientThreadId, localConversationId, threadSnapshot: { ...copy(page.thread), id: clientThreadId },
    messages, runs, events,
    coverage, nextCursor: page.nextCursor ?? null,
    hasMore: page.hasMore === true, projectionTruncated: page.projectionTruncated === true,
    knownGap: missingCheckpoint || page.projectionTruncated === true && events.length === 0,
  };
}
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
const identityText = value => typeof value === 'string' ? value.trim() : '';
const markerText = value => identityText(value).toLowerCase().replace(/[\s_-]+/g, '');
function isProviderIdentity(value, ...providerNames) {
  const markers = new Set(['chatgpt', 'apikey', 'api', 'codex', 'openai', 'oauth', 'oauth2', 'unknown', 'none', 'null', 'undefined', ...providerNames.map(markerText)]);
  const candidate = markerText(value);
  return !candidate || markers.has(candidate);
}
export function codexAccountKey(status) {
  if (!status?.isLoggedIn || status.identityStatus === 'unknown') return null;
  const id = identityText(status.accountId);
  const email = identityText(status.accountEmail).toLowerCase();
  const identity = id && !isProviderIdentity(id, status.provider, status.authMode)
    ? id : /^[^\s@]+@[^\s@]+$/.test(email) ? email : null;
  return identity ? `codex:${identityText(status.authMode)}:${identity}` : null;
}
export function codexAccountChanged(previousKey, status) {
  const nextKey = codexAccountKey(status);
  if (!nextKey || typeof previousKey !== 'string' || !previousKey.startsWith('codex:')) return false;
  const [, mode, ...identity] = previousKey.split(':');
  // An old cached provider-only key never proved which account owned the session.
  if (isProviderIdentity(identity.join(':'), mode)) return false;
  return nextKey !== previousKey;
}
export function knownCodexAccountKey(key) {
  if (typeof key !== 'string' || !key.startsWith('codex:')) return false;
  const [, mode, ...identity] = key.split(':');
  return !isProviderIdentity(identity.join(':'), mode);
}
export function detachNativeThread(thread, savedAccountKey, nonce) {
  const prior = thread.retainedNativeBinding;
  const activeId = thread.conversationId;
  const conversationId = activeId || prior?.conversationId || null;
  const accountKey = activeId || !prior
    ? (Object.hasOwn(thread, 'bindingAccountKey') ? thread.bindingAccountKey : savedAccountKey)
    : prior?.accountKey ?? null;
  const retained = conversationId || prior || thread.messages?.length ? {
    conversationId,
    clientThreadId: activeId || !prior ? clientThreadBinding(thread) : prior.clientThreadId,
    accountKey: accountKey || null,
    reason: conversationId && knownCodexAccountKey(accountKey) ? 'awaiting-identity' : 'ownership-unverified',
  } : null;
  return {
    ...thread, conversationId: null, clientBindingId: freshClientThreadBinding(thread, nonce),
    bindingAccountKey: null, retainedNativeBinding: retained,
    bindingState: retained ? retained.reason === 'awaiting-identity' ? 'awaiting-identity' : 'quarantined' : 'fresh',
    resuming: false, preparingInput: false, sendError: null,
  };
}
export function reconcileNativeThread(thread, authStatus) {
  const key = codexAccountKey(authStatus);
  const retained = thread.retainedNativeBinding;
  if (!key || !retained || thread.conversationId) return thread;
  if (typeof retained.conversationId === 'string' && retained.conversationId && knownCodexAccountKey(retained.accountKey) && retained.accountKey === key) {
    return { ...thread, conversationId: retained.conversationId, bindingAccountKey: retained.accountKey, bindingState: 'verified' };
  }
  return { ...thread, bindingState: 'quarantined', retainedNativeBinding: { ...retained, reason: knownCodexAccountKey(retained.accountKey) ? 'identity-mismatch' : 'ownership-unverified' } };
}
export const nativeBindingHeld = thread => !!thread?.retainedNativeBinding && !thread.conversationId;
export function canResumeNativeThread(thread, authStatus) {
  return !!thread?.conversationId && thread.bindingState === 'verified'
    && knownCodexAccountKey(thread.bindingAccountKey)
    && thread.bindingAccountKey === codexAccountKey(authStatus);
}
export function nativeBindingForRun(thread, run) {
  const established = !!thread.conversationId && thread.conversationId === run.conversationId
    && thread.bindingState === 'verified' && knownCodexAccountKey(thread.bindingAccountKey);
  // Preserve proof for the same native conversation, never borrow it for a new CID.
  const accountKey = established ? thread.bindingAccountKey : run.accountKey ?? null;
  return { bindingAccountKey: accountKey, bindingState: knownCodexAccountKey(accountKey) ? 'verified' : 'live-unverified' };
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
export function registerChatRequest(state, request, authStatus) {
  state.requests[request.requestId] = { ...request, accountKey: codexAccountKey(authStatus), status: 'submitting' };
}
export function snapshotChatDraft(thread, text, revision = 0) {
  return { text, revision, inputSources: copy(thread?.inputSources || []), briefingInputs: copy(thread?.briefingInputs || []) };
}
export function chatDraftMatches(thread, text, revision, submitted) {
  return text === submitted.text && revision === submitted.revision
    && JSON.stringify(thread?.inputSources || []) === JSON.stringify(submitted.inputSources)
    && JSON.stringify(thread?.briefingInputs || []) === JSON.stringify(submitted.briefingInputs);
}
export function buildChatRequest(thread, message, requestId, runtime = {}) {
  const body = { message, requestId, clientThreadId: clientThreadBinding(thread), profileEnabled: thread.profileEnabled === true };
  if (thread.conversationId) body.conversationId = thread.conversationId;
  const cwd = runtime.cwd !== undefined ? runtime.cwd : thread.cwd;
  if (cwd !== undefined) body.cwd = cwd;
  for (const field of ['model', 'effort']) if (runtime[field]) body[field] = runtime[field];
  // The bridge binds a conversation to this engine and refuses a different one later.
  if (isEngineId(runtime.engineId)) body.engineId = runtime.engineId;
  if (Array.isArray(runtime.contextSnapshotIds)) body.contextSnapshotIds = [...new Set(runtime.contextSnapshotIds)];
  if (runtime.contextCapabilities) body.contextCapabilities = { read: true, reader: true, publishBriefing: true };
  if (thread.profileEnabled === true) {
    body.profileEnabled = true;
    // A stored Agent Profile is composed by the bridge from its saved revision;
    // the legacy systemPrompt envelope is only for bridges without profiles.
    if (isProfileId(runtime.profileId)) {
      body.profileId = runtime.profileId;
      if (Number.isSafeInteger(runtime.profileRevision) && runtime.profileRevision > 0) body.profileRevision = runtime.profileRevision;
    } else for (const field of ['agentProfile', 'systemPrompt', 'toolMode']) if (runtime[field]) body[field] = runtime[field];
  }
  return body;
}
export function contextCapabilitiesForRequest(thread, auth, sourceIds = []) {
  // Plain legacy conversations must not require tools never registered on that
  // native thread. An explicit context request never silently replaces it.
  return sourceIds.length || (codexAccountKey(auth) && (!thread.conversationId || thread.contextToolsAvailable === true))
    ? { read: true, reader: true, publishBriefing: true } : null;
}
function ensureRun(state, identity) {
  const request = state.requests[identity.requestId];
  const conversationId = identity.conversationId || request?.conversationId;
  const runId = identity.runId || request?.runId;
  if (!conversationId || !runId) return null;
  const key = runKey(conversationId, runId);
  const run = state.runs[key] ||= {
    conversationId, runId, answerId: key, status: 'running', stopRequested: false,
    messages: [], activities: [], artifacts: [], pendingApprovals: [], pendingUserInputs: [], subAgents: [], error: null, summary: '',
  };
  for (const field of ['requestId', 'clientThreadId', 'localThreadId', 'answerId', 'authorName', 'authorAvatar']) {
    if (identity[field] || request?.[field]) run[field] = identity[field] || request[field];
  }
  if (request && !run.submissionOwnerCaptured) {
    run.accountKey = request.accountKey;
    run.submissionOwnerCaptured = true;
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
export function reduceChatEvent(state, event, engineIds = [DEFAULT_CHAT_ENGINE_ID]) {
  // An engine the bridge has not listed is ignored, never shown as Codex.
  if (event?.type !== 'chat.event' || event.v !== 2 || !engineIds.includes(chatEventEngineId(event))) return null;
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
  } else if (event.event === 'context.bound') {
    run.contextCaptures = copy(details.captures || []);
  } else if (/^(context\.read|reader)\.(started|completed|failed)$/.test(event.event)) {
    run.contextEvents ||= [];
    run.contextEvents.push({ id: `${event.streamId}:${event.seq}`, event: event.event, ts: event.ts, details: copy(details) });
  } else if (event.event === 'briefing.published') {
    run.briefing = copy(details.briefing);
  } else if (event.event === 'approval.required') {
    const approval = details.approval || details;
    const id = approval.id || approval.approvalId || event.itemId;
    if (id) upsert(run.pendingApprovals, { ...approval, id });
  } else if (event.event === 'approval.resolved') {
    const id = details.id || details.approvalId || event.itemId;
    run.pendingApprovals = run.pendingApprovals.filter(item => item.id !== id);
  } else if (event.event === 'userInput.required') {
    // A malformed or late question is dropped; it never becomes answerable.
    const input = publicUserInput(details.userInput || details);
    if (input && isRunBusy(run)) upsert(run.pendingUserInputs ||= [], input, 'userInputId');
  } else if (event.event === 'userInput.resolved') {
    run.pendingUserInputs = (run.pendingUserInputs || []).filter(item => item.userInputId !== details.userInputId);
  } else if (event.event === 'subagent.updated') {
    const row = publicSubAgent(details.subAgent);
    const rows = run.subAgents ||= [];
    const index = row ? rows.findIndex(item => item.threadId === row.threadId) : -1;
    if (index >= 0) rows[index] = { ...rows[index], ...row };
    else if (row && rows.length < MAX_SUB_AGENTS) rows.push(row);
  } else if (event.event === 'run.stop_requested') {
    run.stopRequested = true;
    if (isRunBusy(run)) run.status = 'stopping';
  } else if (event.event === 'run.completed') {
    run.status = details.status || 'completed';
    run.error = details.error || null;
    run.pendingApprovals = [];
    run.pendingUserInputs = [];
    for (const message of run.messages) {
      if (message.status === 'streaming') message.status = run.status === 'completed' ? 'complete' : 'partial';
    }
  } else if (event.event === 'run.unavailable') {
    run.error = details.error || { code: 'RUNTIME_LOST', message: '실행 연결이 끊어졌습니다.' };
    if (run.error.code === 'RUNTIME_LOST') {
      state.connection = 'offline';
      run.status = 'failed';
      run.pendingApprovals = [];
      run.pendingUserInputs = [];
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
      const localInputs = run.pendingUserInputs || [];
      for (const key of ['status', 'stopRequested', 'error', 'summary', 'plan', 'pendingApprovals', 'pendingUserInputs', 'subAgents', 'truncated', 'historyComplete', 'contextCaptures', 'contextEvents', 'briefing']) if (key in incoming) run[key] = copy(incoming[key]);
      run.pendingApprovals = (run.pendingApprovals || []).map(approval => ({ ...approval, id: approval.id || approval.approvalId }));
      // A snapshot never rewinds a local in-flight/sent/stale reply on the same question.
      run.pendingUserInputs = (Array.isArray(run.pendingUserInputs) ? run.pendingUserInputs : []).map(publicUserInput).filter(Boolean).map(input => {
        const local = localInputs.find(item => item.userInputId === input.userInputId);
        if (!local) return input;
        const merged = { ...input, status: local.status === 'replySent' ? 'replySent' : input.status };
        for (const flag of ['replyPending', 'stale', 'error']) if (local[flag]) merged[flag] = local[flag];
        return merged;
      });
      run.subAgents = (Array.isArray(run.subAgents) ? run.subAgents : []).map(publicSubAgent).filter(Boolean).slice(0, MAX_SUB_AGENTS);
      if (incoming.context) {
        run.contextCaptures = copy(incoming.context.captures || []);
        run.contextPackets = copy(incoming.context.packets || []);
        if (incoming.context.briefings?.length) run.briefing = copy(incoming.context.briefings.at(-1));
      }
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
  const live = Object.values(state.runs).filter(run => run.localThreadId === thread.id || run.clientThreadId === clientThreadBinding(thread) || (thread.conversationId && run.conversationId === thread.conversationId));
  const stored = (thread.localRuns || []).filter(run => !live.some(current => current.localRunId && current.localRunId === run.localRunId
    || current.conversationId && current.runId && current.conversationId === run.conversationId && current.runId === run.runId));
  return [...stored, ...live];
}

export function approvalRequestFor(run, approvalId, decision) {
  if (run?.localHistory === true) return null;
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

// Agent questions (helper contract: run.pendingUserInputs). Model text is
// bounded display text only; IDs stay opaque and are never parsed here.
const MAX_SUB_AGENTS = 32;
const MAX_USER_INPUT_ANSWER = 4000;
const nonEmptyId = value => typeof value === 'string' && value.length > 0 && value.length <= 512 ? value : null;
const shownText = (value, limit) => typeof value === 'string' ? value.slice(0, limit) : '';
function publicUserInput(value) {
  const userInputId = nonEmptyId(value?.userInputId);
  if (!userInputId || !['pending', 'replySent'].includes(value.status)) return null;
  const source = Array.isArray(value.questions) ? value.questions : [];
  if (source.length < 1 || source.length > 8) return null;
  const questions = source.map(question => {
    const questionId = nonEmptyId(question?.questionId);
    const text = shownText(question?.question, 2000);
    if (!questionId || !text.trim()) return null;
    const rawOptions = question.options == null || (Array.isArray(question.options) && !question.options.length) ? null : question.options;
    if (rawOptions && (!Array.isArray(rawOptions) || rawOptions.length > 12)) return null;
    const options = rawOptions && rawOptions.map(option => typeof option?.label === 'string' && option.label.trim()
      ? { label: shownText(option.label, 200), description: shownText(option.description, 1000) } : null);
    if (options?.includes(null)) return null;
    return { questionId, header: shownText(question.header, 200), question: text, options,
      allowsOther: !!options && question.allowsOther === true, isSecret: question.isSecret === true };
  });
  if (questions.includes(null) || new Set(questions.map(question => question.questionId)).size !== questions.length) return null;
  return { userInputId, kind: 'userInput', status: value.status, itemId: nonEmptyId(value.itemId), isBlocking: value.isBlocking === true, questions };
}

export const pendingUserInputCount = run => run?.localHistory === true ? 0
  : (run?.pendingUserInputs || []).filter(input => input.status === 'pending' && !input.stale).length;

const answerText = value => {
  const text = typeof value === 'string' ? value.trim() : '';
  return text && text.length <= MAX_USER_INPUT_ANSWER && !text.includes('\u0000') ? text : null;
};

// The single gate for the card buttons and the bridge. `draft` is the UI-only
// [{ questionId, choice: optionIndex | 'other' | null, text }] list.
export function userInputRequestFor(run, userInputId, draft, action = 'submit') {
  if (run?.localHistory === true || !isRunBusy(run) || !['submit', 'skip'].includes(action)) return null;
  const input = (run.pendingUserInputs || []).find(item => item.userInputId === userInputId);
  if (!input || input.status !== 'pending' || input.replyPending || input.stale) return null;
  const identity = { userInputId, conversationId: run.conversationId, runId: run.runId, action };
  if (action === 'skip') return identity;
  const entries = Array.isArray(draft) ? draft : [];
  if (entries.some(entry => !input.questions.some(question => question.questionId === entry?.questionId))) return null;
  const answers = [];
  for (const question of input.questions) {
    const matches = entries.filter(entry => entry.questionId === question.questionId);
    if (matches.length !== 1) return null;
    const { choice, text } = matches[0];
    const freeText = question.options ? choice === 'other' && question.allowsOther : choice == null;
    if (question.options && Number.isSafeInteger(choice) && choice >= 0 && choice < question.options.length) answers.push({ questionId: question.questionId, optionIndex: choice });
    else if (freeText && answerText(text)) answers.push({ questionId: question.questionId, text: answerText(text) });
    else return null;
  }
  return { ...identity, answers };
}

export function acknowledgeUserInputReply(run, reply) {
  if (!reply?.accepted || reply.status !== 'replySent' || typeof reply.userInputId !== 'string'
    || reply.conversationId !== run?.conversationId || reply.runId !== run?.runId) return false;
  const input = (run.pendingUserInputs || []).find(item => item.userInputId === reply.userInputId);
  if (input) { input.status = 'replySent'; input.replyPending = false; input.error = null; }
  return true;
}

// Sub-agent rows (helper contract: run.subAgents). Display only; no authority.
const SUB_AGENT_STATE_LABELS = { starting: '준비 중', running: '진행 중', completed: '완료', closed: '종료',
  errored: '오류', notFound: '찾을 수 없음', interrupted: '중단됨', unknown: '상태 확인 필요' };
const SUB_AGENT_BLOCKED_LABELS = { approvalRequested: '승인 요청으로 멈춤', errored: '오류로 멈춤', notFound: '찾을 수 없음' };
function publicSubAgent(value) {
  const threadId = nonEmptyId(value?.threadId);
  if (!threadId) return null;
  const optional = (text, limit) => typeof text === 'string' && text.trim() ? text.slice(0, limit) : null;
  const reason = value.blocked?.reason;
  return { threadId, label: optional(value.label, 120), taskPreview: optional(value.taskPreview, 160),
    model: optional(value.model, 120), state: Object.hasOwn(SUB_AGENT_STATE_LABELS, value.state) ? value.state : 'unknown',
    message: optional(value.message, 500), lastTool: optional(value.lastTool, 40),
    blocked: Object.hasOwn(SUB_AGENT_BLOCKED_LABELS, reason) ? { reason } : null,
    updatedAt: value.updatedAt ?? null, parentEnded: value.parentEnded === true };
}

export function subAgentDisplay(row, run) {
  // Once the parent run is no longer observed, a "running" child is unconfirmed.
  const observed = !!run && run.localHistory !== true && isRunBusy(run) && row.parentEnded !== true;
  let state = Object.hasOwn(SUB_AGENT_STATE_LABELS, row.state) ? row.state : 'unknown';
  if (!observed && ['starting', 'running'].includes(state)) state = 'unknown';
  const reason = Object.hasOwn(SUB_AGENT_BLOCKED_LABELS, row.blocked?.reason) ? row.blocked.reason
    : ['errored', 'notFound'].includes(state) ? state : null;
  const status = reason ? 'blocked' : ['starting', 'running'].includes(state) ? 'active'
    : ['completed', 'closed'].includes(state) ? 'done' : 'stopped';
  const stateLabel = SUB_AGENT_STATE_LABELS[state];
  const blockedLabel = reason && SUB_AGENT_BLOCKED_LABELS[reason] !== stateLabel ? SUB_AGENT_BLOCKED_LABELS[reason] : null;
  return { status, state, stateLabel, blockedLabel, name: row.label || `하위 Agent ${row.threadId.slice(0, 8)}` };
}

export function subAgentSummary(run) {
  const rows = (Array.isArray(run?.subAgents) ? run.subAgents : []).map(publicSubAgent).filter(Boolean)
    .slice(0, MAX_SUB_AGENTS).map(row => ({ row, display: subAgentDisplay(row, run) }));
  return { total: rows.length, blocked: rows.filter(({ display }) => display.status === 'blocked').length, rows };
}

// Correlate native items with the submitted request/turn, then preserve role order.
// Matching by text alone would merge repeated prompts or messages in other turns.
export function projectRunMessages(existing, run, now = Date.now()) {
  const priorAnswer = existing.findLast(message => message.role === 'assistant'
    && message.runId === run.runId && message.conversationId === run.conversationId);
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
      ...(role === 'assistant' ? { authorAvatar: publicProfileAvatar(previous?.authorAvatar || run.authorAvatar) } : {}),
      createdAt: previous?.createdAt || incoming.createdAt || now,
      conversationId: run.conversationId, runId: run.runId, answerId: run.answerId, artifacts: [], briefing: null, contextCaptures: [], contextEvents: [], contextPackets: [],
    };
    if (index < 0) messages.push(projected);
    else messages[index] = projected;
  }
  const last = messages.findLast(message => message.role === 'assistant' && message.runId === run.runId && message.conversationId === run.conversationId);
  if (last) {
    last.artifacts = (run.artifacts || []).filter(usableArtifact);
    last.briefing = copy(run.briefing !== undefined ? run.briefing : priorAnswer?.briefing || null);
    last.contextCaptures = copy(run.contextCaptures !== undefined ? run.contextCaptures : priorAnswer?.contextCaptures || []);
    last.contextEvents = copy(run.contextEvents !== undefined ? run.contextEvents : priorAnswer?.contextEvents || []);
    last.contextPackets = copy(run.contextPackets !== undefined ? run.contextPackets : priorAnswer?.contextPackets || []);
  }
  return messages;
}

// Agent Profiles (helper contract: /profiles). Screen-side mirror of the store
// rules so the form can answer in Korean before a request; the bridge stays
// the authority and rejects anything this misses.
export const PROFILE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,79}$/;
export const isProfileId = value => typeof value === 'string' && PROFILE_ID_PATTERN.test(value);
// Six swatches from docs/egdesk-approved-desktop-style.html :root tokens
// (same order as helper AVATAR_PALETTE; the index picks the CSS tone class).
export const PROFILE_AVATAR_PALETTE = ['#49634f', '#a9c5a9', '#958879', '#7b8079', '#252a26', '#f5f0df'];
export const PROFILE_TONE_OPTIONS = [
  { value: 'plain', label: '담백' }, { value: 'warm', label: '따뜻' }, { value: 'concise', label: '간결' },
  { value: 'formal', label: '격식' }, { value: 'playful', label: '유쾌' },
];
export const PROFILE_FORM_LIMITS = { name: 40, role: 80, traits: 6, traitLength: 40, speechNotes: 500,
  expertise: 8, expertiseLength: 80, instructions: 8000, toolPreferences: 20, toolLength: 64 };
export const PROFILE_CONFLICT_TEXT = '다른 곳에서 바뀌었습니다. 최신 내용을 불러왔습니다.';
const PROFILE_LIFECYCLE_LABELS = [['active', '사용 중'], ['draft', '초안'], ['disabled', '사용 중지'], ['archived', '보관됨'], ['deleted', '삭제됨']];
const PROFILE_ORIGINS = ['user', 'template'];
const SINGLE_LINE_BAD = /[\u0000-\u001f\u007f\u2028\u2029]/;
const MULTI_LINE_BAD = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const TOOL_NAME = /^[A-Za-z0-9_.:-]+$/;
const textLength = value => Array.from(value).length;
const lookup = (pairs, value) => pairs.find(([key]) => key === value)?.[1] ?? null;
function graphemesOf(text) {
  if (typeof Intl?.Segmenter === 'function') return [...new Intl.Segmenter('und', { granularity: 'grapheme' }).segment(text)].map(part => part.segment);
  return Array.from(text);
}
const isOneEmoji = text => text.length > 0 && text.length <= 32 && graphemesOf(text).length === 1
  && /\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(text);
const isInitial = text => /^[\p{L}\p{N}]{1,2}$/u.test(text);

export function publicProfileAvatar(value) {
  if (!value || typeof value !== 'object' || !['emoji', 'initial'].includes(value.kind) || typeof value.value !== 'string') return null;
  const text = value.value.normalize('NFC').trim();
  if (value.kind === 'emoji' ? !isOneEmoji(text) : !isInitial(text)) return null;
  const color = typeof value.color === 'string' ? value.color.toLowerCase() : PROFILE_AVATAR_PALETTE[0];
  return { kind: value.kind, value: text, color: PROFILE_AVATAR_PALETTE.includes(color) ? color : PROFILE_AVATAR_PALETTE[0] };
}

/** Avatar to draw: the saved emoji/initial, else the name's first letter; tone indexes the palette. */
export function profileAvatarView(avatar, name = '') {
  const saved = publicProfileAvatar(avatar);
  const first = graphemesOf(typeof name === 'string' ? name.trim() : '')[0] || '?';
  return { kind: saved?.kind || 'initial', text: saved?.value || first.toUpperCase(), tone: saved ? PROFILE_AVATAR_PALETTE.indexOf(saved.color) : 0, saved: !!saved };
}

/** Catalog rows from GET /profiles; malformed rows are dropped, never repaired into another identity. */
export function normalizeProfileCatalog(payload) {
  const rows = Array.isArray(payload?.profiles) ? payload.profiles.slice(0, 1000) : [];
  const seen = new Set();
  const revision = value => Number.isSafeInteger(value) && value > 0 ? value : null;
  return rows.flatMap(row => {
    if (!row || !isProfileId(row.id) || seen.has(row.id) || !lookup(PROFILE_LIFECYCLE_LABELS, row.lifecycle) || revision(row.headRevision) === null) return [];
    if (typeof row.name !== 'string' || !row.name.trim()) return [];
    seen.add(row.id);
    return [{ id: row.id, lifecycle: row.lifecycle, origin: PROFILE_ORIGINS.includes(row.origin) ? row.origin : 'user',
      activeRevision: revision(row.activeRevision), headRevision: revision(row.headRevision), hasDraft: row.hasDraft === true,
      name: row.name.trim().slice(0, 40), role: typeof row.role === 'string' ? row.role.trim().slice(0, 80) : '',
      avatar: publicProfileAvatar(row.avatar), updatedAt: Number.isFinite(row.updatedAt) ? row.updatedAt : null }];
  });
}
export const profileRunnable = profile => !!profile && profile.lifecycle === 'active' && Number.isSafeInteger(profile.activeRevision);

export function profileStatusView(profile) {
  const lifecycle = profile?.lifecycle;
  const label = lookup(PROFILE_LIFECYCLE_LABELS, lifecycle) || '상태 확인 필요';
  const detail = lifecycle === 'active'
    ? `버전 ${profile.activeRevision} 사용 중${profile.hasDraft ? ' · 아직 쓰지 않은 초안 있음' : ''}`
    : lifecycle === 'draft' ? '초안 저장됨 · 아직 사용할 수 없음'
      : lifecycle === 'disabled' ? '새 대화에서 고를 수 없음'
        : lifecycle === 'archived' ? '보관함에 있음' : lifecycle === 'deleted' ? '삭제됨' : '';
  return { label, detail, lifecycle: lifecycle || 'unknown', usable: profileRunnable(profile), example: profile?.origin === 'template' };
}

function formLine(value) { return typeof value === 'string' ? value.normalize('NFC').trim() : ''; }
function formBlock(value) { return typeof value === 'string' ? value.normalize('NFC').replace(/\r\n?/g, '\n').trim() : ''; }
function formList(value) {
  const items = (Array.isArray(value) ? value : []).map(formLine).filter(Boolean);
  return [...new Set(items)];
}

/** Editable form fields from a saved body (or an empty new Agent). */
export function profileFormFromBody(body = null) {
  const avatar = publicProfileAvatar(body?.avatar);
  const tone = PROFILE_TONE_OPTIONS.some(option => option.value === body?.personality?.tone) ? body.personality.tone : 'plain';
  return {
    name: typeof body?.name === 'string' ? body.name : '',
    avatarKind: avatar?.kind || 'initial', avatarValue: avatar?.value || '', avatarColor: avatar?.color || PROFILE_AVATAR_PALETTE[0],
    role: typeof body?.role === 'string' ? body.role : '', tone,
    traits: Array.isArray(body?.personality?.traits) ? body.personality.traits.filter(item => typeof item === 'string') : [],
    speechNotes: typeof body?.personality?.speechNotes === 'string' ? body.personality.speechNotes : '',
    expertise: Array.isArray(body?.expertise) ? body.expertise.filter(item => typeof item === 'string') : [],
    instructions: typeof body?.instructions === 'string' ? body.instructions : '',
    toolPreferences: Array.isArray(body?.toolPreferences) ? body.toolPreferences.filter(item => typeof item === 'string') : [],
    model: body?.model && typeof body.model === 'object' ? copy(body.model) : null,
  };
}

/** Korean field errors as {field, message} records, plus the request body when valid. */
export function validateProfileForm(form = {}) {
  const limits = PROFILE_FORM_LIMITS;
  const errors = [];
  const add = (field, message) => { if (!errors.some(error => error.field === field)) errors.push({ field, message }); };
  const name = formLine(form.name);
  if (!name) add('name', '담당자 이름을 입력해 주세요.');
  else if (SINGLE_LINE_BAD.test(name)) add('name', '담당자 이름은 한 줄로 입력해 주세요.');
  else if (textLength(name) > limits.name) add('name', `담당자 이름은 ${limits.name}자 이하로 입력해 주세요.`);
  const kind = form.avatarKind === 'emoji' ? 'emoji' : 'initial';
  let avatarValue = formLine(form.avatarValue);
  if (!avatarValue && kind === 'initial' && name) {
    const first = graphemesOf(name)[0] || '';
    avatarValue = isInitial(first) ? first.toUpperCase() : '';
  }
  if (avatarValue && kind === 'emoji' && !isOneEmoji(avatarValue)) add('avatar', '아바타 이모지는 하나만 넣어 주세요.');
  if (avatarValue && kind === 'initial' && !isInitial(avatarValue)) add('avatar', '이니셜은 글자나 숫자 1~2자로 넣어 주세요.');
  const color = typeof form.avatarColor === 'string' ? form.avatarColor.toLowerCase() : '';
  if (!PROFILE_AVATAR_PALETTE.includes(color)) add('avatarColor', '아바타 색은 준비된 6가지 중에서 골라 주세요.');
  const role = formLine(form.role);
  if (SINGLE_LINE_BAD.test(role) || textLength(role) > limits.role) add('role', `역할은 한 줄, ${limits.role}자 이하로 적어 주세요.`);
  const tone = PROFILE_TONE_OPTIONS.some(option => option.value === form.tone) ? form.tone : null;
  if (!tone) add('tone', '말투를 다시 골라 주세요.');
  const traits = formList(form.traits);
  if (traits.length > limits.traits) add('traits', `성격 특징은 ${limits.traits}개까지 넣을 수 있습니다.`);
  else if (traits.some(item => SINGLE_LINE_BAD.test(item) || textLength(item) > limits.traitLength)) add('traits', `성격 특징 하나는 한 줄, ${limits.traitLength}자 이하로 적어 주세요.`);
  const speechNotes = formBlock(form.speechNotes);
  if (MULTI_LINE_BAD.test(speechNotes) || textLength(speechNotes) > limits.speechNotes) add('speechNotes', `말투 메모는 ${limits.speechNotes}자 이하로 적어 주세요.`);
  const expertise = formList(form.expertise);
  if (expertise.length > limits.expertise) add('expertise', `맡길 일은 ${limits.expertise}개까지 넣을 수 있습니다.`);
  else if (expertise.some(item => SINGLE_LINE_BAD.test(item) || textLength(item) > limits.expertiseLength)) add('expertise', `맡길 일 하나는 한 줄, ${limits.expertiseLength}자 이하로 적어 주세요.`);
  const instructions = formBlock(form.instructions);
  if (MULTI_LINE_BAD.test(instructions) || textLength(instructions) > limits.instructions) add('instructions', `지침은 ${limits.instructions}자 이하로 적어 주세요.`);
  const toolPreferences = formList(form.toolPreferences);
  if (toolPreferences.length > limits.toolPreferences) add('toolPreferences', `선호 도구는 ${limits.toolPreferences}개까지 넣을 수 있습니다.`);
  else if (toolPreferences.some(item => !TOOL_NAME.test(item) || item.length > limits.toolLength)) add('toolPreferences', '선호 도구 이름은 영문·숫자와 _ . : - 만 쓸 수 있습니다.');
  if (errors.length) return { ok: false, errors, body: null };
  return { ok: true, errors, body: {
    name, avatar: avatarValue ? { kind, value: avatarValue, color } : null, role,
    personality: { tone, traits, speechNotes }, expertise, instructions, toolPreferences,
    model: form.model && typeof form.model === 'object' ? copy(form.model) : null,
  } };
}

const PROFILE_DIFF_LABELS = [['name', '담당자 이름'], ['avatar', '아바타'], ['role', '역할'], ['personality.tone', '말투'],
  ['personality.traits', '성격 특징'], ['personality.speechNotes', '말투 메모'], ['expertise', '맡길 일'],
  ['instructions', '지침'], ['toolPreferences', '선호 도구'], ['model', '실행 모델']];
function diffValueText(field, value) {
  if (value === null || value === undefined) return '없음';
  if (field === 'personality.tone') return PROFILE_TONE_OPTIONS.find(option => option.value === value)?.label || '확인 안 됨';
  if (field === 'avatar') return value?.kind === 'emoji' ? `이모지 ${value.value}` : `이니셜 ${value?.value ?? ''}`;
  if (field === 'model') return typeof value?.modelId === 'string' ? value.modelId : '확인 안 됨';
  if (Array.isArray(value)) return value.length ? value.join(', ') : '없음';
  const text = String(value);
  return text ? (text.length > 300 ? `${text.slice(0, 300)}…` : text) : '비어 있음';
}
/** Rows for GET /profiles/:id/diff changes; unknown fields are skipped. */
export function profileDiffRows(changes) {
  return (Array.isArray(changes) ? changes : []).flatMap(change => {
    const label = lookup(PROFILE_DIFF_LABELS, change?.field);
    return label ? [{ field: change.field, label, before: diffValueText(change.field, change.before), after: diffValueText(change.field, change.after) }] : [];
  });
}

/** Korean text for a failed /profiles request; server messages stay internal. */
export function profileRequestErrorText(error) {
  const code = error?.code;
  if (code === 'PROFILE_REVISION_CONFLICT') return PROFILE_CONFLICT_TEXT;
  if (code === 'PROFILE_LIFECYCLE_CONFLICT') return '지금 상태에서는 할 수 없는 작업입니다. 최신 상태를 불러왔습니다.';
  if (code === 'PROFILE_LIMIT') return 'Agent를 더 만들 수 없습니다. 쓰지 않는 Agent를 삭제한 뒤 다시 시도해 주세요.';
  if (code === 'PROFILE_REVISION_LIMIT') return '이 Agent는 버전을 더 저장할 수 없습니다.';
  if (code === 'INVALID_PROFILE' || code === 'PROFILE_HTTP_INPUT') return '입력 내용을 저장할 수 없습니다. 항목을 확인해 주세요.';
  if (code === 'PROFILE_NOT_FOUND' || code === 'PROFILE_REVISION_NOT_FOUND') return '이 Agent 또는 버전을 찾을 수 없습니다. 목록을 다시 불러왔습니다.';
  if (code === 'PROFILE_STORE_UNAVAILABLE' || code === 'PROFILE_ROUTE_NOT_FOUND' || code === 'PROFILE_LOOPBACK_REQUIRED' || !error?.status || error.status === 404 || error.status === 503) {
    return 'Agent 저장소에 연결하지 못했습니다. 코덱스 연결을 확인한 뒤 다시 시도해 주세요.';
  }
  return '요청을 처리하지 못했습니다. 잠시 뒤 다시 시도해 주세요.';
}
/** Korean text for /chat/send profile failures (runtime runProfile codes). */
export function profileSendErrorText(code) {
  if (code === 'PROFILE_NOT_RUNNABLE') return '이 대화방의 Agent는 지금 사용 중이 아닙니다. 설정에서 사용을 시작하거나 다른 Agent를 골라 주세요.';
  if (code === 'PROFILE_NOT_FOUND') return '이 대화방의 Agent를 찾을 수 없습니다. 다른 Agent를 골라 주세요.';
  if (code === 'PROFILE_REVISION_NOT_FOUND') return '이 Agent의 해당 버전을 찾을 수 없습니다. 설정을 다시 불러온 뒤 보내 주세요.';
  if (code === 'INVALID_PROFILE') return 'Agent 설정을 확인하지 못해 보내지 않았습니다. 잠시 뒤 다시 보내거나 다른 Agent를 골라 주세요.';
  if (code === 'PROFILE_STORE_UNAVAILABLE') return 'Agent 저장소를 열 수 없어 보내지 않았습니다. 잠시 뒤 다시 보내거나 기본 Codex로 바꿔 주세요.';
  return null;
}

// ChatGPT plan and usage (helper contract: auth.planType, auth.rateLimits, auth.usage).
const PLAN_LABELS = [['free', '무료'], ['go', 'Go'], ['plus', 'Plus'], ['pro', 'Pro'], ['prolite', 'Pro Lite'], ['promax', 'Pro Max'],
  ['team', 'Team'], ['self_serve_business_prolite', 'Business'], ['self_serve_business_usage_based', 'Business 사용량제'],
  ['business', 'Business'], ['ent26', 'Enterprise'], ['enterprise_cbp_automation', 'Enterprise'],
  ['enterprise_cbp_usage_based', 'Enterprise 사용량제'], ['enterprise', 'Enterprise'], ['edu', 'Edu'], ['edu_plus', 'Edu Plus'], ['edu_pro', 'Edu Pro']];
export const codexPlanLabel = planType => typeof planType === 'string' ? lookup(PLAN_LABELS, planType) : null;

// AI engines (helper contract: /v1/state engines[] {id, label, status, version, capabilities};
// chat.event carries engineId, and older bridges only provider:'codex').
export const DEFAULT_CHAT_ENGINE_ID = 'codex';
const isEngineId = value => typeof value === 'string' && /^[a-z][a-z0-9-]{0,31}$/.test(value);
const engineRows = engines => (Array.isArray(engines) ? engines : []).filter(row => isEngineId(row?.id));
const ENGINE_STATUS_TEXT = [['ready', '사용 가능'], ['starting', '준비 중'], ['offline', '연결 끊김'], ['notInstalled', '설치 안 됨'],
  ['versionUnsupported', '지원하지 않는 버전'], ['loginRequired', '로그인 필요'], ['decisionPending', '연결 방식 결정 대기'], ['disabled', '사용 중지됨']];
const RUNNABLE_ENGINE_STATUSES = ['ready', 'starting', 'offline', 'loginRequired'];

/** Engines whose chat events this screen admits: the bridge's engines[] and always Codex. */
export function knownChatEngineIds(engines) {
  return [...new Set([DEFAULT_CHAT_ENGINE_ID, ...engineRows(engines).map(row => row.id)])];
}
/** An envelope's engine: engineId, else the older provider field. */
export function chatEventEngineId(event) {
  if (event?.engineId !== undefined) return isEngineId(event.engineId) ? event.engineId : null;
  return isEngineId(event?.provider) ? event.provider : null;
}

/**
 * Engine picker rows. Codex is always choosable and reads the live login, not
 * the engines[] snapshot; another engine is choosable only while it can run
 * turns, so Claude stays disabled with '연결 방식 결정 대기'.
 */
export function chatEngineChoices(engines, auth = null) {
  const rows = engineRows(engines);
  if (!rows.some(row => row.id === DEFAULT_CHAT_ENGINE_ID)) rows.unshift({ id: DEFAULT_CHAT_ENGINE_ID, label: 'Codex' });
  return [...new Map(rows.map(row => [row.id, row])).values()].map(row => {
    const label = typeof row.label === 'string' && row.label.trim() ? row.label.trim().slice(0, 40) : row.id;
    const capabilities = Array.isArray(row.capabilities) ? row.capabilities.filter(name => typeof name === 'string') : [];
    if (row.id === DEFAULT_CHAT_ENGINE_ID) {
      const plan = auth?.isLoggedIn ? codexPlanLabel(auth.planType) : null;
      return { id: row.id, label, selectable: true, capabilities,
        account: auth?.isLoggedIn ? `ChatGPT${plan ? ` ${plan}` : ''}` : null, note: auth?.isLoggedIn ? '사용 가능' : '로그인 필요' };
    }
    const status = lookup(ENGINE_STATUS_TEXT, row.status) ? row.status : 'offline';
    const version = typeof row.version === 'string' && /^\d+\.\d+\.\d+$/.test(row.version) ? row.version : null;
    const text = lookup(ENGINE_STATUS_TEXT, status);
    return { id: row.id, label, selectable: RUNNABLE_ENGINE_STATUSES.includes(status), capabilities, account: null,
      note: version && status !== 'notInstalled' ? `설치됨 ${version} · ${text}` : text };
  });
}

/** A room is tied to its engine once it has a conversation, a held record, or any message (D3). */
export const chatThreadEngineLocked = thread => !!thread && (!!thread.conversationId || !!thread.retainedNativeBinding
  || (Array.isArray(thread.messages) && thread.messages.length > 0));
/** The room's engine: its locked one (older rooms are Codex), else its pick, else the app-wide recent engine (D4). */
export function chatThreadEngineId(thread, { recentEngineId = null, engines = null } = {}) {
  if (chatThreadEngineLocked(thread)) return isEngineId(thread.engineId) ? thread.engineId : DEFAULT_CHAT_ENGINE_ID;
  const choices = chatEngineChoices(engines);
  return [thread?.engineId, recentEngineId].find(id => choices.some(choice => choice.id === id && choice.selectable)) || DEFAULT_CHAT_ENGINE_ID;
}

// ReasoningEffort is a model-advertised string (SDK type: minimal|low|medium|high|xhigh).
// The picker offers the common three; '기본' sends nothing so the model default applies.
export const CHAT_EFFORT_CHOICES = Object.freeze([
  Object.freeze({ value: null, label: '기본' }), Object.freeze({ value: 'low', label: '낮음' }),
  Object.freeze({ value: 'medium', label: '보통' }), Object.freeze({ value: 'high', label: '높음' })]);
export const chatEffortValue = value => CHAT_EFFORT_CHOICES.some(choice => choice.value && choice.value === value) ? value : null;
/** Effort choices only when the engine reports per-turn effort selection. */
export const chatEffortChoices = choice => choice?.capabilities?.includes('effortSelect.perTurn') ? CHAT_EFFORT_CHOICES : [];
/** Model line: no model catalog is published yet, so only the default (with its verified name when reported). */
export function chatModelLabel(engineConfiguration) {
  const model = typeof engineConfiguration?.effectiveModel === 'string' ? engineConfiguration.effectiveModel.trim().slice(0, 80) : '';
  return model ? `기본 모델 · ${model}` : '기본 모델';
}

/** Header chip and room badge: the engine name, plus the effort when one is chosen. */
export function chatEngineChipView(thread, { recentEngineId = null, engines = null, auth = null, engineConfiguration = null } = {}) {
  const engineId = chatThreadEngineId(thread, { recentEngineId, engines });
  const choice = chatEngineChoices(engines, auth).find(row => row.id === engineId) || { id: engineId, label: engineId, account: null, capabilities: [] };
  const locked = chatThreadEngineLocked(thread);
  const effort = chatEffortChoices(choice).find(row => row.value && row.value === chatEffortValue(thread?.effort)) || null;
  return {
    engineId, label: choice.label, locked, text: effort ? `${choice.label} · ${effort.label}` : choice.label,
    title: [`AI 엔진 ${choice.label}`, choice.account, locked ? '이 대화에 고정' : '새 대화에 사용',
      chatModelLabel(engineConfiguration), effort ? `추론 강도 ${effort.label}` : null].filter(Boolean).join(' · '),
  };
}

/** Local clock for a reset, e.g. '오후 3:20'; another day adds '10월 27일 '. */
export function formatResetClock(at, now = Date.now()) {
  if (!Number.isFinite(at) || at <= 0) return null;
  const date = new Date(at), today = new Date(now);
  const hours = date.getHours();
  const clock = `${hours < 12 ? '오전' : '오후'} ${hours % 12 || 12}:${String(date.getMinutes()).padStart(2, '0')}`;
  const sameDay = date.getFullYear() === today.getFullYear() && date.getMonth() === today.getMonth() && date.getDate() === today.getDate();
  const year = date.getFullYear() === today.getFullYear() ? '' : `${date.getFullYear()}년 `;
  return sameDay ? clock : `${year}${date.getMonth() + 1}월 ${date.getDate()}일 ${clock}`;
}

const usedPercentOf = window => Number.isFinite(window?.usedPercent) ? Math.min(100, Math.max(0, window.usedPercent)) : null;
/** Small usage ring: a reported value or grey '확인 안 됨' (never an invented 0%). Null when signed out. */
export function usageRingView(auth) {
  if (!auth?.isLoggedIn) return null;
  const usage = auth.usage && typeof auth.usage === 'object' ? auth.usage : null;
  const level = ['ok', 'warn', 'limit'].includes(usage?.level) ? usage.level : 'unknown';
  if (level === 'unknown') {
    return { level, percent: null, text: '확인 안 됨', label: '사용 한도 확인 안 됨', title: '사용 한도 확인 안 됨 · 아직 보고된 사용량이 없습니다', stale: false, resetLabel: null };
  }
  const reported = [auth.rateLimits?.primary, auth.rateLimits?.secondary].map(usedPercentOf).filter(value => value !== null);
  const parsed = Number.parseInt(String(usage.percentLabel || '').match(/^(\d{1,3})%/)?.[1] ?? '', 10);
  const percent = level === 'limit' ? 100 : reported.length ? Math.floor(Math.max(...reported)) : Number.isFinite(parsed) ? Math.min(100, parsed) : null;
  const stale = usage.stale === true;
  const percentText = typeof usage.percentLabel === 'string' && usage.percentLabel ? usage.percentLabel : percent === null ? '사용량 확인 안 됨' : `${percent}% 사용`;
  const parts = [typeof usage.windowLabel === 'string' ? usage.windowLabel : null, percentText,
    typeof usage.resetLabel === 'string' ? usage.resetLabel : null, stale ? '확인한 지 오래되어 실제와 다를 수 있음' : null].filter(Boolean);
  return { level, percent, text: level === 'limit' ? '한도' : percent === null ? '?' : `${percent}%`,
    label: `사용 한도 ${parts.slice(0, 2).join(' ')}`.trim(), title: parts.join(' · '), stale, resetLabel: typeof usage.resetLabel === 'string' ? usage.resetLabel : null };
}

const ERROR_KIND_VALUES = ['auth', 'quota', 'permission', 'network', 'model', 'unknown'];
/** Run error copy by kind (helper contract: run.error.kind, retryAt); model/unknown keep the reported text. */
export function runErrorNotice(error, usage = null, now = Date.now()) {
  if (!error) return null;
  if (typeof error === 'string') return { kind: 'unknown', text: error, action: null };
  const kind = ERROR_KIND_VALUES.includes(error.kind) ? error.kind : 'unknown';
  if (kind === 'auth') return { kind, text: '다시 로그인이 필요합니다.', action: 'login' };
  if (kind === 'quota') {
    const resetAt = Number.isFinite(error.retryAt) && error.retryAt > now ? error.retryAt
      : Number.isFinite(usage?.resetsAt) && usage.resetsAt > now ? usage.resetsAt : null;
    const clock = formatResetClock(resetAt, now);
    return { kind, text: clock ? `사용 한도에 도달했습니다. ${clock}에 다시 쓸 수 있습니다.` : '사용 한도에 도달했습니다. 다시 쓸 수 있는 시각은 아직 확인되지 않았습니다.', action: null };
  }
  if (kind === 'permission') return { kind, text: '권한이 부족합니다.', action: null };
  if (kind === 'network') return { kind, text: '연결이 불안정합니다. 다시 시도해 주세요.', action: 'retry' };
  return { kind, text: error.message || error.code || '실행 오류', action: null };
}
