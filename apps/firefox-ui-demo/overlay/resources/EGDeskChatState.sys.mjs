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
    if (message.outputs?.length) item.outputs = publishedOutputs(message.outputs);
    if (message.contextCaptures?.length) item.contextCaptures = copy(message.contextCaptures);
    if (message.contextEvents?.length) item.contextEvents = copy(message.contextEvents);
    if (message.contextPackets?.length) item.contextPackets = copy(message.contextPackets);
    if (message.artifacts?.length) item.artifacts = message.artifacts.filter(usableArtifact).map(copy);
    run.messages.push(item);
    if (message.role === 'assistant') {
      if (message.authorName) run.authorName = message.authorName;
      if (message.artifacts?.length) run.artifacts = message.artifacts.filter(usableArtifact).map(copy);
      if (message.briefing) run.briefing = copy(message.briefing);
      if (message.outputs?.length) run.outputs = publishedOutputs(message.outputs);
      if (message.contextCaptures?.length) run.contextCaptures = copy(message.contextCaptures);
      if (message.contextEvents?.length) run.contextEvents = copy(message.contextEvents);
      if (message.contextPackets?.length) run.contextPackets = copy(message.contextPackets);
    }
    runs.set(localRunId, run);
  }
  if (!runs.size) return null;
  for (const run of runs.values()) {
    if (run.contextCaptures || run.contextPackets || run.briefing || run.outputs) run.context = {
      captures: copy(run.contextCaptures || []), packets: copy(run.contextPackets || []),
      briefings: run.briefing ? [copy(run.briefing)] : [],
      outputs: copy(run.outputs || []),
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

// A legacy import into a new store allocates a new local conversation ID.
// The room ID alone is not proof: require the original pref snapshot plus
// the store's immutable import receipt and every exact imported checkpoint.
// Missing/paged-out proof leaves the normal identity guard in force.
export function reconcileImportedLocalHistoryThread(current, page, record) {
  const clientThreadId = localClientThreadId(current);
  const localConversationId = page?.thread?.localConversationId;
  if (!clientThreadId || typeof current.localConversationId !== 'string' || !current.localConversationId
      || typeof localConversationId !== 'string' || !localConversationId || current.localConversationId === localConversationId
      || page?.protocolVersion !== 1 || page.thread.clientThreadId !== clientThreadId
      || record?.clientThreadId !== clientThreadId || record.importId !== `firefox-pref:egdesk.deskSession.v1:${clientThreadId}`
      || record.threadSnapshot?.id !== clientThreadId || record.threadSnapshot.localConversationId !== current.localConversationId
      || current.localRuns != null && (!Array.isArray(current.localRuns) || current.localRuns.length)) return current;
  const expected = legacyPublicChatSnapshot(record);
  if (!expected || page.thread.conversationId !== expected.conversationId
      || JSON.stringify(legacyPublicChatSnapshot({ ...record, threadSnapshot: current })) !== JSON.stringify(expected)) return current;
  const events = Array.isArray(page.events) ? page.events : [];
  const receipts = events.filter(event => event.event === 'history.imported');
  const receipt = receipts[0];
  if (receipts.length !== 1 || receipt.seq !== 1 || receipt.details?.importId !== record.importId
      || receipt.details.runCount !== expected.runs.length || receipt.details.truncated !== expected.truncated
      || receipt.details.historyComplete !== expected.historyComplete) return current;
  const imported = events.filter(event => event.event === 'run.imported');
  if (imported.length !== expected.runs.length || imported.some((event, index) =>
    !Number.isSafeInteger(event.seq) || event.seq <= (index ? imported[index - 1].seq : receipt.seq)
    || event.localRunId !== expected.runs[index].localRunId || event.runId !== expected.runs[index].runId
    || JSON.stringify(event.details?.run) !== JSON.stringify(expected.runs[index]))) return current;
  const importedMessages = new Map(expected.runs.flatMap(run => run.messages).map(message => [message.localMessageId, message]));
  return {
    ...current, localConversationId,
    messages: current.messages.map((message, index) => {
      const imported = importedMessages.get(legacyLocalId('message', clientThreadId,
        typeof message?.id === 'string' && message.id ? message.id : `ordinal-${index}`));
      if (!imported || imported.role !== message?.role) return message;
      // Keep the UI/native identity and content; only the proven local-store
      // identities change. Old-store sequences must not order the new store.
      const { localSeq, ...saved } = message;
      return { ...saved, localMessageId: imported.localMessageId, localRunId: imported.localRunId };
    }),
  };
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

// CHAT-01: the Agent the chat store recorded for a room (thread.agent from
// /chat/history/threads and /chat/history: null, or {profileId, revision,
// setAt}), checked. Anything that is not an Agent profile ID is no Agent.
export function roomAgentRecord(agent) {
  if (!agent || typeof agent !== 'object' || !isProfileId(agent.profileId)) return null;
  return { profileId: agent.profileId,
    revision: Number.isSafeInteger(agent.revision) && agent.revision > 0 ? agent.revision : null,
    setAt: Number.isSafeInteger(agent.setAt) ? agent.setAt : null };
}

// CHAT-01: which Agent a restored room answers as. The Desk pref — the
// screen's own saved thread (serializeDeskSnapshot) — wins while it is alive:
// a room whose current fields already pick an Agent (profileEnabled true)
// keeps that pick. Only a room that picks none — fresh from the store listing,
// or a pref that says nothing — takes the Agent the store recorded for it
// (recordRoomAgent after a send, setRoomAgent from the ⋯ menu). The pick is
// restored by ID alone: a missing, archived or stopped Agent stays itself, so
// the existing '찾을 수 없는 Agent' placeholder and send block show rather than
// another Agent answering. revision and setAt are carried on thread.agent for
// the request and peek layers and are not applied here (the room follows the
// catalog's active revision). thread.agent is the store's record, so it is
// always taken from the snapshot — the copy a pref kept is replaced — and a
// snapshot from an older bridge without the field leaves the room's own.
export function restoredRoomAgentFields(current, saved) {
  if (!saved || typeof saved !== 'object' || !Object.hasOwn(saved, 'agent')) return {};
  const agent = roomAgentRecord(saved.agent);
  return current?.profileEnabled === true || !agent ? { agent } : { agent, profileEnabled: true, agentProfileId: agent.profileId };
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
    ...restoredRoomAgentFields(current, saved),
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

// Historical run projections can carry a published Briefing (and CHAT-08
// published results) even when the bounded message projection does not. Bind
// by run identity, never by the visible/local message ID (Answer ID is the
// native conversation/run pair).
export function projectLocalRunRelations(messages, runs) {
  const projected = (messages || []).map(copy);
  for (const run of runs || []) {
    const briefing = run.briefing || run.context?.briefings?.at(-1);
    const outputs = publishedOutputs(run.outputs?.length ? run.outputs : run.context?.outputs);
    if (!briefing && !outputs.length) continue;
    const anchor = briefing || outputs[0];
    const identity = {
      conversationId: run.conversationId || anchor.conversationId || null,
      runId: run.runId || anchor.runId || null,
      answerId: run.answerId || anchor.answerId || null,
    };
    if (['conversationId', 'runId', 'answerId'].some(key => run[key] && anchor[key] && run[key] !== anchor[key])) continue;
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
    if (briefing) next.briefing = copy(briefing);
    if (outputs.length && !(Array.isArray(next.outputs) && next.outputs.length)) next.outputs = outputs;
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
    ...copy(run), ...localComputerFields(run, event), ...localRateLimitFields(run, event, page.thread),
    localRunId: run.localRunId || event.localRunId || undefined,
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
    const storedRun = event.details?.run;
    if (storedRun) Object.assign(storedRun, localRateLimitFields(storedRun, event, page.thread));
    if (event.event === 'run.rateLimit') {
      const projectedRun = (Array.isArray(page.runs) ? page.runs : []).find(run =>
        event.localRunId && run.localRunId === event.localRunId || event.runId && run.runId === event.runId);
      const rateLimit = publicRunRateLimit(event.details?.rateLimit, event, storedRun, projectedRun, page.thread);
      event.details = { ...(storedRun ? { run: storedRun } : {}), rateLimit,
        error: quotaErrorForRateLimit(rateLimit, event.details?.error) };
    }
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
  const generations = new Map();
  const generation = scope => generations.get(scope) || 0;
  const profileKey = (scope, profile) => JSON.stringify([scope, profile]);
  return {
    current: () => epoch,
    begin: (scope = 'codex', profile = null) => { const controller = makeController();
      const token = { epoch, scope, profile, generation: generation(scope),
        profileGeneration: generation(profileKey(scope, profile)), controller, signal: controller.signal };
      active.add(token); return token; },
    valid: token => typeof token === 'number' ? token === epoch
      : token.epoch === epoch && token.generation === generation(token.scope)
        && token.profileGeneration === generation(profileKey(token.scope, token.profile)),
    finish: token => active.delete(token),
    reset: (scope, profile = null) => {
      if (scope === undefined) { epoch++; generations.clear(); }
      else {
        const key = profile === null ? scope : profileKey(scope, profile); generations.set(key, generation(key) + 1);
        // Legacy run callbacks have no recorded slot: they cannot outlive an
        // account change of that engine, but known other slots stay valid.
        if (profile !== null) generations.set(profileKey(scope, null), generation(profileKey(scope, null)) + 1);
      }
      for (const token of active) if (scope === undefined || token.scope === scope && (profile === null || token.profile === null || token.profile === profile)) {
        token.controller.abort(); active.delete(token);
      }
    },
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
  // Claude's durable binding is checked by /chat/resume, not a Codex account
  // key from Desk preferences. Keep the original local/native routing pair.
  if (thread.engineId === 'claude') return {
    ...thread, conversationId: thread.conversationId || thread.retainedNativeBinding?.conversationId || null,
    clientBindingId: thread.retainedNativeBinding?.clientThreadId || thread.clientBindingId || null,
    bindingAccountKey: null, bindingState: 'server-check-required', retainedNativeBinding: null,
    resuming: false, preparingInput: false, sendError: null,
  };
  const prior = thread.retainedNativeBinding;
  const activeId = thread.conversationId;
  const conversationId = activeId || prior?.conversationId || null;
  const accountKey = activeId || !prior
    ? (Object.hasOwn(thread, 'bindingAccountKey') ? thread.bindingAccountKey : savedAccountKey)
    : prior?.accountKey ?? null;
  // An old reducer could restore the CID while leaving the isolation nonce
  // active. Do not overwrite its intact original pair on another detach.
  const sameRetainedPair = prior?.conversationId === conversationId && prior?.accountKey === accountKey
    && typeof prior?.clientThreadId === 'string' && !!prior.clientThreadId.trim();
  const retained = conversationId || prior || thread.messages?.length ? {
    conversationId,
    clientThreadId: sameRetainedPair ? prior.clientThreadId : activeId || !prior ? clientThreadBinding(thread) : prior.clientThreadId,
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
  if (thread.engineId === 'claude') return thread.retainedNativeBinding?.conversationId
    ? detachNativeThread(thread, null, null) : thread;
  const key = codexAccountKey(authStatus);
  const retained = thread.retainedNativeBinding;
  if (!key || !retained || thread.conversationId) return thread;
  if (typeof retained.conversationId === 'string' && retained.conversationId.trim()
      && typeof retained.clientThreadId === 'string' && retained.clientThreadId.trim()
      && knownCodexAccountKey(retained.accountKey) && retained.accountKey === key) {
    // Matching local identity only permits the helper's ownership check. Its
    // durable resume contract requires the original client/native pair.
    return { ...thread, conversationId: retained.conversationId, clientBindingId: retained.clientThreadId,
      bindingAccountKey: retained.accountKey, bindingState: 'verified' };
  }
  return { ...thread, bindingState: 'quarantined', retainedNativeBinding: { ...retained,
    reason: knownCodexAccountKey(retained.accountKey) && retained.accountKey !== key ? 'identity-mismatch' : 'ownership-unverified' } };
}
export const nativeBindingHeld = thread => !!thread?.retainedNativeBinding && !thread.conversationId;
export function canResumeNativeThread(thread, authStatus, context = {}) {
  // This permits the server check, never grants native ownership locally.
  if (thread?.engineId === 'claude') return !!thread.conversationId && chatThreadReadiness(thread, context).ready;
  return !!thread?.conversationId && thread.bindingState === 'verified'
    && knownCodexAccountKey(thread.bindingAccountKey)
    && thread.bindingAccountKey === codexAccountKey(authStatus);
}
export function nativeBindingForRun(thread, run) {
  if (thread.engineId === 'claude') return { bindingAccountKey: null,
    bindingState: run.accountIdentity?.status === 'verified' ? 'server-verified' : 'server-check-required' };
  const established = !!thread.conversationId && thread.conversationId === run.conversationId
    && thread.bindingState === 'verified' && knownCodexAccountKey(thread.bindingAccountKey);
  // Preserve proof for the same native conversation, never borrow it for a new CID.
  const accountKey = established ? thread.bindingAccountKey : run.accountKey ?? null;
  return { bindingAccountKey: accountKey, bindingState: knownCodexAccountKey(accountKey) ? 'verified' : 'live-unverified' };
}
export function submissionFailureStatus(error) {
  // Durable replay carries the dispatch outcome even when the original
  // HTTP-only resume flag was not stored. Unknown is not a refusal.
  if (error?.resumeRequired === true || error?.dispatchStatus === 'unknown') return 'unconfirmed';
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
export function registerChatRequest(state, request, authStatus, engineId = 'codex') {
  state.requests[request.requestId] = { ...request, ...(engineId === 'claude' ? { engineId } : {}),
    accountKey: engineId === 'claude' ? null : codexAccountKey(authStatus), status: 'submitting' };
}
const REQUEST_PROJECT_TARGET_IDS = ['boardId', 'projectId', 'rootId'];
const REQUEST_PROJECT_TARGET_PRESENTATION = ['title', 'displayPath'];
const REQUEST_PROJECT_TARGET_FIELDS = new Set([...REQUEST_PROJECT_TARGET_IDS, ...REQUEST_PROJECT_TARGET_PRESENTATION]);
const REQUEST_PROJECT_TARGET_DISPLAY_LIMITS = { title: 120, displayPath: 1000 };

// An explicit selection for this request draft, not room ownership or authority.
// Copy only data fields; extra path/permission fields and accessors are refused.
// The bridge alone resolves these opaque IDs and checks their actual binding.
export function normalizeRequestProjectTarget(target) {
  if (target == null) return null;
  const invalid = () => new TypeError('Invalid request project target');
  if (typeof target !== 'object' || Array.isArray(target)) throw invalid();
  // Firefox windows and shared ES modules have different Object.prototype
  // identities. Check record structure without reading constructor/toString
  // (or Symbol.toStringTag), which could invoke an input object's accessors.
  const prototype = Object.getPrototypeOf(target);
  if (prototype !== null && Object.getPrototypeOf(prototype) !== null) throw invalid();
  const fields = Object.getOwnPropertyDescriptors(target);
  for (const key of Reflect.ownKeys(fields)) {
    if (!REQUEST_PROJECT_TARGET_FIELDS.has(key) || !Object.hasOwn(fields[key], 'value')) throw invalid();
  }
  const normalized = {};
  for (const key of REQUEST_PROJECT_TARGET_IDS) {
    const value = Object.hasOwn(fields, key) ? fields[key].value : undefined;
    // Match the bridge's projectTarget contract without interpreting ID syntax.
    if (typeof value !== 'string' || !value.trim() || value.length > 512 || value.includes('\0')) throw invalid();
    normalized[key] = value;
  }
  for (const key of REQUEST_PROJECT_TARGET_PRESENTATION) {
    if (!Object.hasOwn(fields, key)) continue;
    if (typeof fields[key].value !== 'string') throw invalid();
    normalized[key] = taskLine(fields[key].value, REQUEST_PROJECT_TARGET_DISPLAY_LIMITS[key]);
  }
  return normalized;
}

// Keep the submitted choice detached and immutable across asynchronous reads.
// Use normalizeRequestProjectTarget for a separate, mutable editor value.
export function snapshotRequestProjectTarget(target) {
  const snapshot = normalizeRequestProjectTarget(target);
  return snapshot ? Object.freeze(snapshot) : null;
}

export function requestProjectTargetsMatch(left, right) {
  try {
    return JSON.stringify(normalizeRequestProjectTarget(left)) === JSON.stringify(normalizeRequestProjectTarget(right));
  } catch {
    // A malformed current or submitted choice must never clear the composer.
    return false;
  }
}

// Applying/removing only returns draft state. Cancel discards the editor value
// without calling this helper; neither operation submits or grants execution.
export function applyRequestProjectTarget(thread, target) {
  const normalized = normalizeRequestProjectTarget(target);
  const next = { ...thread };
  if (normalized) next.requestProjectTarget = normalized;
  else delete next.requestProjectTarget;
  return next;
}

export function snapshotChatDraft(thread, text, revision = 0) {
  return { text, revision, inputSources: copy(thread?.inputSources || []), briefingInputs: copy(thread?.briefingInputs || []),
    requestProjectTarget: snapshotRequestProjectTarget(thread?.requestProjectTarget) };
}
export function chatDraftMatches(thread, text, revision, submitted) {
  return text === submitted.text && revision === submitted.revision
    && JSON.stringify(thread?.inputSources || []) === JSON.stringify(submitted.inputSources)
    && JSON.stringify(thread?.briefingInputs || []) === JSON.stringify(submitted.briefingInputs)
    && requestProjectTargetsMatch(thread?.requestProjectTarget, submitted.requestProjectTarget);
}
export function buildChatRequest(thread, message, requestId, runtime = {}) {
  // The caller passes submittedDraft.requestProjectTarget, never a live Board
  // or the current thread draft after an await. Absence keeps the old wire shape.
  const projectTarget = snapshotRequestProjectTarget(runtime.projectTarget);
  const body = { message, requestId, clientThreadId: clientThreadBinding(thread), profileEnabled: thread.profileEnabled === true };
  if (thread.conversationId) body.conversationId = thread.conversationId;
  const cwd = runtime.cwd !== undefined ? runtime.cwd : thread.cwd;
  if (cwd !== undefined) body.cwd = cwd;
  if (projectTarget) body.projectTarget = {
    boardId: projectTarget.boardId, projectId: projectTarget.projectId, rootId: projectTarget.rootId,
  };
  for (const field of ['model', 'effort']) if (runtime[field]) body[field] = runtime[field];
  // The bridge binds a conversation to this engine and refuses a different one later.
  if (isEngineId(runtime.engineId)) body.engineId = runtime.engineId;
  if (typeof runtime.engineProfileId === 'string' && runtime.engineProfileId) body.engineProfileId = runtime.engineProfileId;
  // CHAT-09: '기록 없이 시작' applies to the first send of a new conversation only.
  if (runtime.stateless === true && !thread.conversationId) body.stateless = true;
  if (Array.isArray(runtime.contextSnapshotIds)) body.contextSnapshotIds = [...new Set(runtime.contextSnapshotIds)];
  if (runtime.engineId === 'claude' && runtime.expectedContextScope) body.expectedContextScope = runtime.expectedContextScope;
  if (runtime.contextCapabilities) body.contextCapabilities = runtime.engineId === 'claude'
    ? { read: true, reader: runtime.contextCapabilities.reader === true, publishBriefing: false } : { read: true, reader: true, publishBriefing: true };
  // CTX-03: which suggestion list this turn answered, and the refs taken from it.
  if (typeof runtime.contextResolution?.resolutionId === 'string' && Array.isArray(runtime.contextResolution.chosen)) {
    body.contextResolution = { resolutionId: runtime.contextResolution.resolutionId, chosen: [...runtime.contextResolution.chosen] };
  }
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

// CTX-03 '이것도 붙일까요?': the helper only suggests (policy suggest-only).
// Relevance (reasons, score) and permission (requiresConsent, excludedBy) stay
// separate; card names come from the screen's own cards, never from the helper.
export const CONTEXT_REASON_TEXT = Object.freeze({
  explicit: '직접 고른 자료', focused: '지금 보고 있는 카드', activeBoardMember: '지금 Board에 있는 카드',
  sameCluster: '보고 있는 카드 옆에 모여 있음', visibleLarge: '화면에 크게 보이는 카드', recentlyUsed: '최근 30분 안에 쓴 자료',
});
export const CONTEXT_CONSENT_TEXT = '로그인된 페이지·Browser 내용이에요. 직접 확인하고 붙여 주세요';
export const CONTEXT_EXCLUSION_TEXT = Object.freeze({ otherAccount: '다른 계정의 자료라 붙일 수 없어요', noPermission: '읽을 권한이 없는 자료예요' });
export const CONTEXT_BOARD_MATCH_TEXT = Object.freeze({ active: '지금 Board', focused: '보고 있는 카드의 Board', visibleArea: '화면에 가장 많이 보이는 Board' });
export const CONTEXT_SUGGEST_TITLE = '이것도 붙일까요?';
export const CONTEXT_RESOLVER_RECORD_TITLE = '이번에 Agent가 볼 자료 · 고른 이유';
// The helper keeps a resolution for 15 minutes; an unchosen one is sent only while clearly fresh.
export const CONTEXT_RESOLUTION_FRESH_MS = 14 * 60 * 1000;
const CONTEXT_REF = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,191}$/;
const CONTEXT_KIND_LABEL = Object.freeze({ browser: 'Browser', file: '파일', 'board-element': 'Canvas 요소' });
const contextRef = value => typeof value === 'string' && CONTEXT_REF.test(value);

export function normalizeContextResolution(payload) {
  if (!payload || typeof payload !== 'object' || payload.policy !== 'suggest-only') return null;
  if (typeof payload.resolutionId !== 'string' || !/^[\da-f-]{36}$/i.test(payload.resolutionId)) return null;
  const candidates = [];
  for (const item of Array.isArray(payload.candidates) ? payload.candidates.slice(0, 12) : []) {
    if (!item || !contextRef(item.ref) || !CONTEXT_KIND_LABEL[item.kind] || candidates.some(entry => entry.ref === item.ref)) continue;
    const candidate = { ref: item.ref, kind: item.kind, score: Number.isFinite(item.score) ? item.score : 0,
      reasons: Array.isArray(item.reasons) ? item.reasons.filter(reason => Object.hasOwn(CONTEXT_REASON_TEXT, reason)) : [],
      // Unknown consent means consent: nothing is attached without a person's own check.
      requiresConsent: item.requiresConsent !== false };
    if (item.excludedBy !== undefined && item.excludedBy !== null) candidate.excludedBy = String(item.excludedBy);
    candidates.push(candidate);
  }
  const board = payload.board && contextRef(payload.board.boardId) && CONTEXT_BOARD_MATCH_TEXT[payload.board.matchedBy]
    ? { boardId: payload.board.boardId, matchedBy: payload.board.matchedBy } : null;
  return { resolutionId: payload.resolutionId, policy: 'suggest-only',
    resolvedAt: Number.isSafeInteger(payload.resolvedAt) ? payload.resolvedAt : null, board, candidates };
}

export function contextReasonText(reasons = []) {
  return (Array.isArray(reasons) ? reasons : []).map(reason => CONTEXT_REASON_TEXT[reason]).filter(Boolean).join(' · ');
}

export function contextBoardText(board, boardTitleFor = () => null) {
  const match = board && CONTEXT_BOARD_MATCH_TEXT[board.matchedBy];
  if (!match) return null;
  const title = boardTitleFor(board.boardId);
  return title ? `${match} · ${title}` : match;
}

const contextExclusionText = code => CONTEXT_EXCLUSION_TEXT[code] || '지금은 붙일 수 없는 자료예요';

// Rows for the suggestion area. Already attached cards and cards no longer on
// the screen are left out. 'pick' rows can be added together; 'consent' rows
// only one at a time by their own checkbox; 'excluded' rows only show why.
export function contextSuggestionRows(resolution, { attachedRefs = [], picked = [], labelFor = () => null, boardTitleFor = () => null } = {}) {
  const attached = new Set(attachedRefs);
  const pickedSet = new Set(picked);
  const rows = [];
  for (const candidate of resolution?.candidates || []) {
    if (attached.has(candidate.ref)) continue;
    const label = labelFor(candidate.ref, candidate.kind);
    if (!label) continue;
    const mode = candidate.excludedBy ? 'excluded' : candidate.requiresConsent ? 'consent' : 'pick';
    rows.push({ ref: candidate.ref, kind: candidate.kind, label, mode, score: candidate.score,
      reasonText: contextReasonText(candidate.reasons),
      note: mode === 'excluded' ? contextExclusionText(candidate.excludedBy) : mode === 'consent' ? CONTEXT_CONSENT_TEXT : null,
      picked: mode !== 'excluded' && pickedSet.has(candidate.ref) });
  }
  return { rows, bulkRefs: rows.filter(row => row.mode === 'pick').map(row => row.ref),
    pickedRefs: rows.filter(row => row.picked).map(row => row.ref), boardText: contextBoardText(resolution?.board, boardTitleFor) };
}

// Whether '이것도 붙일까요?' has anything to draw for one room: a list, or an
// error line. Loading, idle and a closed area draw nothing, so an answer that
// keeps it that way needs no redraw of the Chat.
export function contextSuggestionShown(entry) {
  if (!entry || typeof entry !== 'object' || entry.dismissed === true) return false;
  return !!entry.resolution || (entry.status === 'error' && typeof entry.error === 'string' && entry.error.length > 0);
}

// The refs a person attached from the suggestion area (marked resolverRef on
// the attached source) and still sends now. Nothing chosen sends chosen: [].
export function contextResolutionForSend(entry, sources = [], { now = Date.now(), accountKey = null } = {}) {
  const resolution = entry?.resolution;
  if (!resolution?.resolutionId || (entry.accountKey ?? null) !== (accountKey ?? null)) return null;
  const candidates = new Map((resolution.candidates || []).map(candidate => [candidate.ref, candidate]));
  const chosen = [];
  for (const source of Array.isArray(sources) ? sources : []) {
    const ref = source?.resolverRef;
    if (!ref || source.sourceRef?.viewId !== ref || chosen.includes(ref)) continue;
    const candidate = candidates.get(ref);
    if (candidate && !candidate.excludedBy) chosen.push(ref);
  }
  const age = now - entry.receivedAt;
  if (!chosen.length && !(Number.isFinite(age) && age >= 0 && age < CONTEXT_RESOLUTION_FRESH_MS)) return null;
  return { resolutionId: resolution.resolutionId, chosen: chosen.slice(0, 16) };
}

export function contextResolverErrorText(code) {
  return ({
    RESOLUTION_EXPIRED: '자료 추천이 오래되어 새로 불러왔어요. 추천을 확인한 뒤 다시 보내 주세요.',
    RESOLVER_CHOICE_FORBIDDEN: '고른 자료 중 다른 계정의 자료나 읽을 권한이 없는 자료가 있어 보내지 않았어요. 그 자료를 빼고 다시 보내 주세요.',
    RESOLVER_CHOICE_UNKNOWN: '고른 자료가 추천 목록에 없어 보내지 않았어요. 추천을 다시 확인해 주세요.',
    RESOLVER_CHOICE_UNCAPTURED: '고른 자료를 첨부하지 못해 보내지 않았어요. 자료를 다시 붙여 주세요.',
    INVALID_RESOLVER_CHOICE: '고른 자료 정보를 확인하지 못해 보내지 않았어요. 추천을 다시 불러온 뒤 보내 주세요.',
    INVALID_RESOLVER_SIGNAL: '화면 정보를 읽지 못해 자료 추천을 보여 드리지 못했어요. 필요한 자료는 ＋ 첨부로 붙여 주세요.',
    CONTEXT_LOOPBACK_REQUIRED: '이 기기의 EG-Desk 화면에서만 자료 추천을 받을 수 있어요.',
  })[code] || null;
}

export function claudeContextSendErrorText(code, engineId = 'claude') {
  const text = ({
    CLAUDE_CONTEXT_UNSUPPORTED: '현재 Claude 연결에서는 선택한 자료를 사용할 수 없어 보내지 않았습니다. 자료를 제외한 뒤 다시 보내세요.',
    CONTEXT_SCOPE_CHANGED: 'Claude 연결이 바뀌어 자료를 보내지 않았습니다. 현재 연결 계정을 확인한 뒤 다시 보내세요. 초안과 선택 자료는 유지됩니다.',
    CLAUDE_CONTEXT_READER_UNSUPPORTED: '현재 Claude 연결에서는 이 자료의 Smart Read를 지원하지 않아 보내지 않았습니다. 더 작은 완전한 자료를 선택하거나 Codex 대화에서 다시 시도해 주세요. 초안과 선택 자료는 유지됩니다.',
    CONTEXT_CAPTURE_INCOMPLETE: '선택한 자료가 일부만 캡처되어 보내지 않았습니다. 초안과 선택 자료는 유지됩니다.',
    UNSUPPORTED_SOURCE_FORMAT: '현재 연결에서 읽을 수 없는 자료 형식이라 보내지 않았습니다. 초안과 선택 자료는 유지됩니다.',
    CONTEXT_THREAD_MISMATCH: '선택한 고정 캡처가 이 대화에 속하지 않아 보내지 않았습니다. 원래 대화에서 확인해 주세요. 초안과 선택 자료는 유지됩니다.',
    CONTEXT_TOOLS_UNAVAILABLE: '기존 대화의 자료 읽기 도구를 확인할 수 없어 보내지 않았습니다. 새 대화로 바꾸지 않았으며 초안과 선택 자료는 유지됩니다.',
  })[code];
  if (typeof text === 'string') return text;
  const readError = engineId === 'claude' ? claudeContextReadErrorText(code) : null;
  return readError ? `${readError} 전송하지 않았으며 초안과 선택 자료는 유지됩니다.` : null;
}

// Used by the activity record after a run has started as well as pre-dispatch
// refusals. Reading, main delivery and send acceptance are distinct outcomes.
export function claudeContextReadErrorText(code) {
  const text = ({
    ENGINE_CAPACITY_UNKNOWN: '모델의 자료 읽기 용량을 확인하지 못했습니다. 연결 상태를 확인해 주세요.',
    CONTEXT_CAPACITY_REQUIRED: '현재 대화에 자료를 전달할 여유가 부족합니다. 첨부 범위를 줄이거나 새 대화에서 다시 시도해 주세요.',
    ENGINE_CONTEXT_CONFIGURATION_ERROR: '자료 읽기 설정을 확인하지 못했습니다. 연결 상태를 확인해 주세요.',
    PACKET_ADMISSION_REQUIRED: '읽은 자료를 현재 대화에 전달할 수 있는 범위를 초과했습니다. 첨부 범위를 줄이거나 새 대화에서 다시 시도해 주세요.',
    READER_UNAVAILABLE: '자료 읽기 준비 상태를 확인하지 못했습니다. 연결 상태를 확인한 뒤 다시 시도해 주세요.',
    READER_ISOLATION_UNAVAILABLE: '독립된 자료 읽기 환경을 확인하지 못했습니다. 연결 설정을 확인해 주세요.',
    READER_FAILED: '자료 읽기 처리에 실패했습니다. 상태를 확인한 뒤 다시 시도해 주세요.',
    READER_RECEIPT_INVALID: '자료 읽기 결과의 근거를 확인하지 못했습니다. 입력 기록과 연결 상태를 확인해 주세요.',
    ABORTED: '요청한 자료 읽기가 중단되었습니다.',
    READ_CANCELLED: '요청한 자료 읽기가 중단되었습니다.',
  })[code];
  if (typeof text === 'string') return text;
  if (['READER_CONFIGURATION_REQUIRED','READER_CONFIGURATION_MISMATCH'].includes(code))
    return '자료 읽기의 모델·설정을 확인하지 못했습니다. 연결 설정을 확인해 주세요.';
  if (['READER_BUSY','READER_SESSION_LIMIT','READER_STOP_PENDING'].includes(code))
    return '이전 자료 읽기의 종료를 확인한 뒤 다시 시도해 주세요. 자동으로 다시 시도하지 않습니다.';
  if (['READER_OFFLINE','READER_TIMEOUT'].includes(code))
    return '자료 읽기의 완료를 확인하지 못했습니다. 연결과 입력 기록을 확인해 주세요.';
  if (['READER_INPUT_INVALID','READER_SESSION_MISMATCH','READER_SCOPE_VIOLATION','READER_PROTOCOL_ERROR',
    'READER_INVALID_PACKET','READER_INVALID_CITATION','READER_EVENT_LIMIT','READER_OUTPUT_LIMIT'].includes(code))
    return '자료 읽기 범위나 결과를 검증하지 못했습니다. 입력 기록과 연결 설정을 확인해 주세요.';
  return null;
}

// CTX-04 '왜 이것이 붙었나': names from the screen (or the capture label),
// reason words and scores only. No captured text.
export function contextResolverRecordView(resolver, { labelFor = () => null, captures = [], boardTitleFor = () => null } = {}) {
  if (!resolver || typeof resolver !== 'object' || !Array.isArray(resolver.candidates)) return null;
  const captureList = Array.isArray(captures) ? captures.filter(Boolean) : [];
  const rows = [];
  const covered = new Set();
  let suggested = 0;
  let chosen = 0;
  for (const candidate of resolver.candidates) {
    if (!candidate || !contextRef(candidate.ref)) continue;
    const explicit = Array.isArray(candidate.reasons) && candidate.reasons.includes('explicit');
    if (candidate.chosen === true) chosen++;
    if (!candidate.excludedBy && (!explicit || candidate.chosen === true)) suggested++;
    if (candidate.chosen !== true && !explicit) continue;
    const capture = captureList.find(item => (candidate.sourceId && item.sourceId === candidate.sourceId) || item.sourceRef?.viewId === candidate.ref);
    if (capture?.sourceId) covered.add(capture.sourceId);
    rows.push({ ref: candidate.ref, chosen: candidate.chosen === true,
      label: labelFor(candidate.ref, candidate.kind) || (typeof capture?.label === 'string' && capture.label) || CONTEXT_KIND_LABEL[candidate.kind] || '자료',
      reasonText: contextReasonText(candidate.reasons) || CONTEXT_REASON_TEXT.explicit,
      scoreText: Number.isFinite(candidate.score) ? `점수 ${candidate.score}` : null });
  }
  for (const capture of captureList) {
    if (!capture.sourceId || covered.has(capture.sourceId)) continue;
    rows.push({ ref: null, chosen: false, label: typeof capture.label === 'string' && capture.label ? capture.label : '자료',
      reasonText: CONTEXT_REASON_TEXT.explicit, scoreText: null });
  }
  return { title: CONTEXT_RESOLVER_RECORD_TITLE, boardText: contextBoardText(resolver.board, boardTitleFor), rows,
    summary: suggested ? `추천 ${suggested}개 중 ${chosen}개를 골라 붙였어요` : '추천 없이 직접 고른 자료만 붙였어요' };
}
// Display provenance only; native ownership and account proof stay on the server.
function runEngineMatches(value, engineId) {
  return [value?.engineId, value?.engine?.id].every(id => id === undefined || id === engineId);
}
function ensureRun(state, identity) {
  const request = state.requests[identity.requestId];
  const conversationId = identity.conversationId || request?.conversationId;
  const runId = identity.runId || request?.runId;
  if (!conversationId || !runId) return null;
  const key = runKey(conversationId, runId);
  const engineId = identity.engineId ?? identity.engine?.id;
  const engineProfileId = identity.engine?.engineProfileId ?? identity.engineProfileId;
  if (engineId !== undefined && (!isEngineId(engineId) || !runEngineMatches(identity, engineId)
    || !runEngineMatches(state.runs[key], engineId))) return null;
  if (engineProfileId !== undefined && (typeof engineProfileId !== 'string' || !engineProfileId.trim()
      || state.runs[key]?.engineProfileId && state.runs[key].engineProfileId !== engineProfileId)) return null;
  const run = state.runs[key] ||= {
    conversationId, runId, answerId: key, status: 'running', stopRequested: false,
    messages: [], activities: [], artifacts: [], pendingApprovals: [], pendingUserInputs: [], subAgents: [], error: null, summary: '',
  };
  if (engineId !== undefined) run.engineId = engineId;
  if (engineProfileId !== undefined) run.engineProfileId = engineProfileId;
  for (const field of ['requestId', 'clientThreadId', 'localThreadId', 'localMessageId', 'answerId', 'authorName', 'authorAvatar']) {
    if (identity[field] || request?.[field]) run[field] = identity[field] || request[field];
  }
  if (request && !run.submissionOwnerCaptured) {
    run.accountKey = request.accountKey;
    run.submissionOwnerCaptured = true;
  }
  if (request) Object.assign(request, { conversationId, runId, answerId: run.answerId, status: 'accepted' });
  return run;
}
// AGENT-04: the ceiling a run was started under (send response, run.started,
// /v1/state runs[]). Only a well-formed ceiling is kept; it is never cleared by
// a later record that omits it.
function recordRunToolCeiling(run, value) {
  const ceiling = run ? publicToolCeiling(value) : null;
  if (ceiling) run.toolCeiling = ceiling;
}
// CU-01: the computer control policy an ordinary Codex run started under
// (run.started details.computerControl); never cleared by a later record.
function recordRunComputerControl(run, value) {
  if (run && COMPUTER_CONTROL_POLICIES.includes(value?.policy)) run.computerControl = { policy: value.policy };
}
// SSE computer.used: the bridge's count and time; server names come from snapshots only.
function computerUseWithEvent(current, details) {
  const before = publicComputerUse(current) || { calls: 0, lastAt: null, servers: [], active: false };
  const next = publicComputerUse(details) || before;
  return { calls: Math.max(before.calls, next.calls), lastAt: next.lastAt ?? before.lastAt, servers: before.servers, active: next.active };
}
function endComputerUse(run) {
  if (run.computerUse?.active) run.computerUse = { ...run.computerUse, active: false };
}
// A stored run keeps computerUse; its policy is read from its run.started event.
function localComputerFields(run, event) {
  const fields = {};
  if (run && 'computerUse' in run) fields.computerUse = publicComputerUse(run.computerUse);
  const policy = event.event === 'run.started' ? event.details?.computerControl?.policy : run?.computerControl?.policy;
  if (COMPUTER_CONTROL_POLICIES.includes(policy)) fields.computerControl = { policy };
  return fields;
}
function localRateLimitFields(run, event, thread) {
  if (!run || !Object.hasOwn(run, 'rateLimit')) return {};
  const rateLimit = publicRunRateLimit(run.rateLimit, run, event, thread);
  const error = quotaErrorForRateLimit(rateLimit, run.error);
  return { rateLimit, ...(error || run.error?.kind === 'quota' ? { error } : {}) };
}
export function acceptChatRequest(state, response, requestId) {
  if (!response?.accepted) return null;
  const run = ensureRun(state, { ...response, requestId: response.requestId || requestId });
  recordRunToolCeiling(run, response.toolCeiling);
  return run;
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
  const engineId = chatEventEngineId(event);
  if (event?.type !== 'chat.event' || event.v !== 2 || !engineIds.includes(engineId)) return null;
  if (!event.streamId || !Number.isSafeInteger(event.seq)) return null;
  const previous = state.runs[runKey(event.conversationId, event.runId)];
  if (!runEngineMatches(event, engineId) || !runEngineMatches(previous, engineId)) return null;
  const details = event.details || {};
  const rateLimit = event.event === 'run.rateLimit' ? publicRunRateLimit(details.rateLimit, event, previous) : null;
  if (event.event === 'run.rateLimit' && (!rateLimit || engineId !== 'claude'
    || previous?.streamId === event.streamId && previous.seq >= event.seq)) return null;
  const stream = ensureStream(state, event.streamId);
  if (event.seq <= (stream.checkpoints[event.conversationId] ?? -1) || stream.seen[event.seq]) return null;
  stream.seen[event.seq] = true;
  stream.seq = Math.max(stream.seq, event.seq);
  const run = ensureRun(state, { ...event, engineId });
  if (!run) return null;
  if (run.streamId && state.streams[run.streamId]?.generation > stream.generation) return null;
  run.seq = run.streamId === event.streamId ? Math.max(run.seq ?? -1, event.seq) : event.seq;
  run.streamId = event.streamId;
  if (event.event === 'run.started') {
    recordRunToolCeiling(run, details.toolCeiling);
    recordRunComputerControl(run, details.computerControl);
  }
  if (event.event.startsWith('message.')) {
    const id = details.messageId || event.itemId;
    if (!id) return run;
    let message = run.messages.find(item => item.id === id);
    if (!message) { message = { id, role: 'assistant', content: '', status: 'streaming', createdAt: event.ts }; run.messages.push(message); }
    // CHAT-03: the store's name for this bubble rides on the event, so a live answer can be moved without a reload.
    if (typeof event.localMessageId === 'string' && event.localMessageId && !message.localMessageId) message.localMessageId = event.localMessageId;
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
    run.contextResolver = copy(details.resolver || null);
  } else if (/^(context\.read|reader)\.(started|completed|failed)$/.test(event.event)) {
    run.contextEvents ||= [];
    run.contextEvents.push({ id: `${event.streamId}:${event.seq}`, event: event.event, ts: event.ts, details: copy(details) });
  } else if (event.event === 'briefing.published') {
    run.briefing = copy(details.briefing);
  } else if (event.event === 'output.published') {
    // CHAT-08 / D-K4: one chip per outputKey; a revision is the next version
    // of the same chip. The event carries metadata only — the body is read
    // from the bridge when the chip is pressed.
    run.outputs = upsertPublishedOutput(run.outputs, details.output);
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
  } else if (event.event === 'computer.used') {
    run.computerUse = computerUseWithEvent(run.computerUse, details);
  } else if (event.event === 'run.rateLimit') {
    run.rateLimit = rateLimit;
    const error = quotaErrorForRateLimit(rateLimit, details.error);
    if (error || details.error === null) run.error = error;
  } else if (event.event === 'run.stop_requested') {
    run.stopRequested = true;
    if (isRunBusy(run)) run.status = 'stopping';
  } else if (event.event === 'run.completed') {
    run.status = details.status || 'completed';
    run.error = quotaErrorForRateLimit(publicRunRateLimit(run.rateLimit, run), details.error) || details.error || null;
    endComputerUse(run);
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
      endComputerUse(run);
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
  if (snapshot.streamId && !Number.isSafeInteger(snapshot.seq)) return [];
  // A refused envelope must not advance the checkpoint and swallow valid SSE.
  for (const incoming of snapshot.runs || []) {
    const previous = state.runs[runKey(snapshot.conversationId, incoming.runId)];
    const engineId = incoming.engineId ?? incoming.engine?.id ?? snapshot.engineId;
    if (engineId !== undefined && (!isEngineId(engineId) || !runEngineMatches(incoming, engineId)
      || !runEngineMatches(snapshot, engineId) || !runEngineMatches(previous, engineId))) return [];
    if (incoming.rateLimit != null && !publicRunRateLimit(incoming.rateLimit, incoming, snapshot, previous)) return [];
  }
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
    const previous = state.runs[runKey(snapshot.conversationId, incoming.runId)];
    const rateLimit = publicRunRateLimit(incoming.rateLimit, incoming, snapshot, previous);
    const run = ensureRun(state, { ...incoming, ...(snapshot.engineId !== undefined ? { engineId: snapshot.engineId } : {}),
      conversationId: snapshot.conversationId, clientThreadId });
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
    recordRunToolCeiling(run, incoming.toolCeiling);
    if (!preserve) {
      const localInputs = run.pendingUserInputs || [];
      for (const key of ['status', 'stopRequested', 'error', 'summary', 'plan', 'pendingApprovals', 'pendingUserInputs', 'subAgents', 'truncated', 'historyComplete', 'contextCaptures', 'contextEvents', 'briefing']) if (key in incoming) run[key] = copy(incoming[key]);
      if ('rateLimit' in incoming && (stream || !run.streamId)) run.rateLimit = rateLimit;
      const quotaError = quotaErrorForRateLimit(publicRunRateLimit(run.rateLimit, run), run.error);
      if (quotaError) run.error = quotaError;
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
      // CU-01: the bridge's count replaces this screen's; a run that never drove the Mac has none.
      if ('computerUse' in incoming) run.computerUse = publicComputerUse(incoming.computerUse);
      if (Array.isArray(incoming.outputs)) run.outputs = publishedOutputs(incoming.outputs);
      if (incoming.context) {
        run.contextCaptures = copy(incoming.context.captures || []);
        run.contextPackets = copy(incoming.context.packets || []);
        if (incoming.context.resolver) run.contextResolver = copy(incoming.context.resolver);
        if (incoming.context.briefings?.length) run.briefing = copy(incoming.context.briefings.at(-1));
        // CHAT-08: the bridge lists every stored version; the screen keeps one entry per outputKey.
        if (incoming.context.outputs?.length) run.outputs = publishedOutputs(incoming.context.outputs);
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
  if (run?.localHistory === true || !['accept', 'acceptForSession', 'decline', 'cancel'].includes(decision)) return null;
  const approval = run?.pendingApprovals?.find(item => (item.approvalId || item.id) === approvalId);
  if (!approval || approval.status !== 'pending' || approval.replyPending || approval.stale
    || !Array.isArray(approval.choices) || !approval.choices.includes(decision)) return null;
  if (['accept', 'acceptForSession'].includes(decision) && !approvalScopeKnown(approval)) return null;
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
  if (reply?.accepted !== true || reply.status !== 'replySent' || reply.conversationId !== run?.conversationId || reply.runId !== run?.runId) return false;
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
      allowsOther: !!options && question.allowsOther === true, isSecret: question.isSecret === true,
      ...(question.multiSelect === true ? { multiSelect: true } : {}) };
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
// [{ questionId, choice: optionIndex | 'other' | null, text }] list, with
// optionIndices only for multi-select. Other clears the selected indices.
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
    const { choice, text, optionIndices } = matches[0];
    const freeText = question.options ? choice === 'other' && question.allowsOther : choice == null;
    const hasIndices = Object.hasOwn(matches[0], 'optionIndices');
    if (question.multiSelect === true) {
      if (hasIndices && !Array.isArray(optionIndices)) return null;
      if (freeText) {
        if (optionIndices?.length || !answerText(text)) return null;
        answers.push({ questionId: question.questionId, text: answerText(text) });
      } else {
        if (!question.options || choice != null || !hasIndices || !optionIndices.length || optionIndices.length > question.options.length
          || new Set(optionIndices).size !== optionIndices.length
          || [...optionIndices].some(index => !Number.isSafeInteger(index) || index < 0 || index >= question.options.length)
          || text != null && (typeof text !== 'string' || text.trim())) return null;
        answers.push({ questionId: question.questionId, optionIndices: [...optionIndices] });
      }
      continue;
    }
    if (hasIndices) return null;
    if (question.options && Number.isSafeInteger(choice) && choice >= 0 && choice < question.options.length) answers.push({ questionId: question.questionId, optionIndex: choice });
    else if (freeText && answerText(text)) answers.push({ questionId: question.questionId, text: answerText(text) });
    else return null;
  }
  return { ...identity, answers };
}

export function acknowledgeUserInputReply(run, reply) {
  if (reply?.accepted !== true || reply.status !== 'replySent' || typeof reply.userInputId !== 'string'
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
    ? { ...message, status: 'complete', conversationId: run.conversationId, runId: run.runId, answerId: run.answerId,
      // run.localMessageId may belong to a later assistant message event.
      // Only the separately checked live acceptance can name this user row.
      ...(run.acceptedInputMessageId && !message.localMessageId ? { localMessageId: run.acceptedInputMessageId } : {}) }
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
      ...(role === 'user' && previous?.localMessageId ? { localMessageId: previous.localMessageId } : {}),
      providerItemId: incoming.id, content: incoming.content ?? incoming.text ?? '',
      authorName: role === 'assistant' ? previous?.authorName || run.authorName || 'Codex' : previous?.authorName,
      ...(role === 'assistant' ? { authorAvatar: displayProfileAvatar(previous?.authorAvatar || run.authorAvatar) } : {}),
      createdAt: previous?.createdAt || incoming.createdAt || now,
      conversationId: run.conversationId, runId: run.runId, answerId: run.answerId, artifacts: [], briefing: null, outputs: [], contextCaptures: [], contextEvents: [], contextPackets: [],
    };
    if (index < 0) messages.push(projected);
    else messages[index] = projected;
  }
  const last = messages.findLast(message => message.role === 'assistant' && message.runId === run.runId && message.conversationId === run.conversationId);
  if (last) {
    last.artifacts = (run.artifacts || []).filter(usableArtifact);
    last.briefing = copy(run.briefing !== undefined ? run.briefing : priorAnswer?.briefing || null);
    last.outputs = copy(run.outputs !== undefined ? run.outputs : priorAnswer?.outputs || []);
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
  examples: 3, exampleUser: 100, exampleReply: 280, avoid: 8, avoidItem: 80,
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

// AGENT-05 / D-A3: the avatar as the Chat draws it — a public emoji/initial, or
// a saved photo reference (its initial stands in until the bytes arrive).
export const displayProfileAvatar = value => publicProfileAvatar(value) || profileImageReference(value);

/** Avatar to draw: the saved emoji/initial, else the name's first letter; tone indexes the palette. A photo adds `assetId`. */
export function profileAvatarView(avatar, name = '') {
  const saved = displayProfileAvatar(avatar);
  const first = graphemesOf(typeof name === 'string' ? name.trim() : '')[0] || '?';
  return { kind: saved?.kind || 'initial', text: saved?.value || first.toUpperCase(), tone: saved ? PROFILE_AVATAR_PALETTE.indexOf(saved.color) : 0, saved: !!saved,
    ...(saved?.kind === 'image' ? { assetId: saved.assetId } : {}) };
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
      avatar: displayProfileAvatar(row.avatar), updatedAt: Number.isFinite(row.updatedAt) ? row.updatedAt : null }];
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

// AGENT-04 tool ceiling (helper body.toolCeiling): the most an Agent may do per
// tool kind, five axes in the store's order, narrowest value first. null keeps
// today's behavior on every axis; `open` is that behavior for one axis. A
// `limit` phrase exists only for values that narrow something. Terminal
// 'allow' still runs as 'ask' (no automatic approval yet), so it is pending.
export const PROFILE_TOOL_CEILING_AXES = Object.freeze([
  { axis: 'browser', label: '브라우저', open: 'interact', options: [
    { value: 'none', label: '쓰지 않음', limit: '브라우저 쓰지 않음' }, { value: 'observe', label: '보기만', limit: '브라우저 보기만' },
    { value: 'interact', label: '보기와 조작' }] },
  { axis: 'files', label: '파일', open: 'write', options: [
    { value: 'read', label: '읽기만', limit: '파일 읽기만' }, { value: 'write', label: '읽기와 쓰기' }] },
  { axis: 'terminal', label: '터미널 명령', open: 'ask', options: [
    { value: 'none', label: '실행 안 함', limit: '터미널 실행 안 함' }, { value: 'ask', label: '실행 전에 묻기' },
    { value: 'allow', label: '묻지 않고 실행', pending: true }] },
  { axis: 'network', label: '인터넷', open: 'on', options: [
    { value: 'off', label: '연결 안 함', limit: '인터넷 연결 안 함' }, { value: 'on', label: '연결 허용' }] },
  { axis: 'mcp', label: '연결된 외부 도구', open: 'inherited', options: [
    { value: 'none', label: '쓰지 않음', limit: '외부 도구 쓰지 않음' }, { value: 'inherited', label: '내 설정 그대로' }] },
].map(axis => Object.freeze({ ...axis, options: Object.freeze(axis.options.map(option => Object.freeze(option))) })));
export const PROFILE_TOOL_CEILING_PRESETS = Object.freeze([
  Object.freeze({ id: 'research', label: '리서치 Agent', ceiling: Object.freeze({ browser: 'observe', files: 'read', terminal: 'none', network: 'on', mcp: 'inherited' }) }),
]);
export const TOOL_CEILING_OFF_TEXT = '제한 없음 · 지금처럼';
export const TOOL_CEILING_EXTERNAL_BROWSER_NOTE = '직접 연결한 브라우저 도구(예: firefox-devtools)는 계속 쓸 수 있습니다';
const ceilingAxis = axis => PROFILE_TOOL_CEILING_AXES.find(item => item.axis === axis) || null;
const ceilingOption = (axis, value) => ceilingAxis(axis)?.options.find(option => option.value === value) || null;
/** Every axis at today's behavior (the switch turned on before any pick). */
export const openToolCeiling = () => Object.fromEntries(PROFILE_TOOL_CEILING_AXES.map(({ axis, open }) => [axis, open]));
/** Five known keys in store order, a missing axis filled with its open value; anything else is null. */
export function publicToolCeiling(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (Object.keys(value).some(key => !ceilingAxis(key))) return null;
  const ceiling = {};
  for (const { axis, open } of PROFILE_TOOL_CEILING_AXES) {
    const chosen = value[axis] === undefined || value[axis] === null ? open : value[axis];
    if (!ceilingOption(axis, chosen)) return null;
    ceiling[axis] = chosen;
  }
  return ceiling;
}
/** Korean phrases for the axes a ceiling narrows, in axis order. */
export function toolCeilingLimits(value) {
  const ceiling = publicToolCeiling(value);
  return ceiling ? PROFILE_TOOL_CEILING_AXES.flatMap(({ axis }) => ceilingOption(axis, ceiling[axis])?.limit || []) : [];
}
/** One line: the narrowed axes, or '제한 없음' when nothing is narrowed. */
export function toolCeilingSummary(value) {
  const limits = toolCeilingLimits(value);
  return limits.length ? limits.join(' · ') : '제한 없음';
}
/** The run's recorded ceiling as '도구 제한: …', or null when it narrows nothing. */
export function toolCeilingRunLine(run) {
  const limits = toolCeilingLimits(run?.toolCeiling);
  return limits.length ? `도구 제한: ${limits.join(' · ')}` : null;
}
/** Notes under the form's ceiling picks. */
export function toolCeilingNotes(value) {
  const ceiling = publicToolCeiling(value);
  if (!ceiling) return [];
  const notes = [];
  if (ceiling.browser !== 'interact' && ceiling.mcp === 'inherited') notes.push(TOOL_CEILING_EXTERNAL_BROWSER_NOTE);
  if (ceiling.terminal === 'allow') notes.push('자동 승인은 제공하지 않으며 현재 승인 설정을 따릅니다.');
  return notes;
}
/** The preset this ceiling matches exactly, or null. */
export function toolCeilingPresetId(value) {
  const ceiling = publicToolCeiling(value);
  if (!ceiling) return null;
  return PROFILE_TOOL_CEILING_PRESETS.find(preset => PROFILE_TOOL_CEILING_AXES.every(({ axis }) => preset.ceiling[axis] === ceiling[axis]))?.id || null;
}
/** Every axis spelled out (diffs compare whole ceilings). */
function toolCeilingFullText(value) {
  const ceiling = publicToolCeiling(value);
  if (!ceiling) return TOOL_CEILING_OFF_TEXT;
  return PROFILE_TOOL_CEILING_AXES.map(({ axis, label }) => `${label} ${ceilingOption(axis, ceiling[axis]).label}`).join(' · ');
}
/** A toolCeiling activity row: its status word, the refused command, and notes from the detail keys. */
export function toolCeilingActivityView(activity) {
  if (activity?.kind !== 'toolCeiling') return null;
  const detail = activity.detail && typeof activity.detail === 'object' && !Array.isArray(activity.detail) ? activity.detail : {};
  const notes = [];
  if (detail.externalBrowserToolsStillInherited === true) notes.push('직접 연결한 브라우저 도구는 이 Agent에서도 쓸 수 있습니다');
  if (detail.nativeFeatureCheck === 'unavailable') notes.push('Codex 버전이 확인을 지원하지 않아 일부 제한을 확인하지 못했습니다');
  return { statusLabel: activity.status === 'declined' ? '도구 제한으로 막음' : '안내', notes,
    command: typeof detail.command === 'string' && detail.command.trim() ? detail.command : null };
}

function formLine(value) { return typeof value === 'string' ? value.normalize('NFC').trim() : ''; }
function formBlock(value) { return typeof value === 'string' ? value.normalize('NFC').replace(/\r\n?/g, '\n').trim() : ''; }
function formList(value) {
  const items = (Array.isArray(value) ? value : []).map(formLine).filter(Boolean);
  return [...new Set(items)];
}

// Unlike JSON round-tripping, this retains invalid rows/extra undefined keys
// for validation. Do not silently repair a saved/input field while copying it.
function copyProfileFormField(value, seen = new Map()) {
  if (!value || typeof value !== 'object') return value;
  if (seen.has(value)) return seen.get(value);
  const result = Array.isArray(value) ? new Array(value.length) : Object.create(Object.getPrototypeOf(value));
  seen.set(value, result);
  for (const key of Object.keys(value)) Object.defineProperty(result, key, {
    value: copyProfileFormField(value[key], seen), enumerable: true, writable: true, configurable: true,
  });
  return result;
}
function profileRecordShape(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  // Saved JSON and editor objects can come from another JS realm. Recognize
  // that realm's Object.prototype, not just this module's reference; a class
  // or invented prototype must not pass, and constructor getters never run.
  if (prototype !== null) {
    const constructor = Object.getOwnPropertyDescriptor(prototype, 'constructor')?.value;
    if (Object.getPrototypeOf(prototype) !== null || typeof constructor !== 'function'
      || constructor.prototype !== prototype
      || Function.prototype.toString.call(constructor) !== Function.prototype.toString.call(Object)) return false;
  }
  return Object.keys(value).every(key => keys.includes(key));
}
function profileExampleShape(value) { return profileRecordShape(value, ['user', 'reply']); }
// Match the store's existing image-reference rules; image bytes are never
// accepted here, and the store still checks that the asset actually exists.
function profileImageReference(value) {
  if (!profileRecordShape(value, ['kind', 'value', 'color', 'assetId']) || value.kind !== 'image'
    || typeof value.value !== 'string' || typeof value.assetId !== 'string' || !/^img-[0-9a-f]{64}$/.test(value.assetId)) return null;
  const text = formLine(value.value);
  const color = value.color === undefined ? PROFILE_AVATAR_PALETTE[0] : typeof value.color === 'string' ? value.color.toLowerCase() : null;
  if (!isInitial(text) || !PROFILE_AVATAR_PALETTE.includes(color)) return null;
  return { kind: 'image', value: text, color, assetId: value.assetId };
}
function formPersonalityText(value, field, label, max, multiline, add) {
  if (typeof value !== 'string') { add(field, `${label}은 글자로 입력해 주세요.`); return null; }
  const text = multiline ? formBlock(value) : formLine(value);
  if (!text) { add(field, `${label}을 입력해 주세요.`); return null; }
  if ((multiline ? MULTI_LINE_BAD : SINGLE_LINE_BAD).test(text)) {
    add(field, multiline ? `${label}에 사용할 수 없는 제어 문자가 있습니다.` : `${label}은 한 줄로 입력해 주세요.`);
    return null;
  }
  if (textLength(text) > max) { add(field, `${label}은 ${max}자 이하로 입력해 주세요.`); return null; }
  return text;
}
function formPersonalityExamples(value, limits, add) {
  const field = 'personalityExamples';
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) { add(field, '말투 예시는 질문과 답변을 짝지은 목록으로 입력해 주세요.'); return []; }
  if (value.length > limits.examples) {
    add(field, `말투 예시는 ${limits.examples}쌍까지 넣을 수 있습니다. ${limits.examples + 1}행부터는 삭제해 주세요.`);
    return [];
  }
  const pairs = new Map();
  for (let index = 0; index < value.length; index++) {
    const item = value[index], label = `말투 예시 ${index + 1}행`;
    if (!profileExampleShape(item)) { add(field, `${label}에는 질문과 답변만 넣어 주세요.`); return []; }
    const user = formPersonalityText(item.user, field, `${label}의 질문`, limits.exampleUser, false, add);
    const reply = formPersonalityText(item.reply, field, `${label}의 답변`, limits.exampleReply, true, add);
    if (user === null || reply === null) return [];
    const pair = { user, reply }, key = JSON.stringify(pair);
    if (!pairs.has(key)) pairs.set(key, pair);
  }
  return [...pairs.values()];
}
function formPersonalityAvoid(value, limits, add) {
  const field = 'personalityAvoid';
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) { add(field, '피할 표현은 문구 목록으로 입력해 주세요.'); return []; }
  if (value.length > limits.avoid) {
    add(field, `피할 표현은 ${limits.avoid}개까지 넣을 수 있습니다. ${limits.avoid + 1}행부터는 삭제해 주세요.`);
    return [];
  }
  const items = new Set();
  for (let index = 0; index < value.length; index++) {
    const text = formPersonalityText(value[index], field, `피할 표현 ${index + 1}행`, limits.avoidItem, false, add);
    if (text === null) return [];
    items.add(text);
  }
  return [...items];
}

/** Editable form fields from a saved body (or an empty new Agent). */
export function profileFormFromBody(body = null) {
  // The editor can select initials or emoji but not photos. Keep the original
  // image reference separately so unrelated edits cannot replace it.
  const image = body?.avatar?.kind === 'image' ? copyProfileFormField(body.avatar) : null;
  const avatar = image ? null : publicProfileAvatar(body?.avatar);
  const tone = PROFILE_TONE_OPTIONS.some(option => option.value === body?.personality?.tone) ? body.personality.tone : 'plain';
  return {
    name: typeof body?.name === 'string' ? body.name : '',
    avatarKind: image ? 'image' : avatar?.kind || 'initial',
    avatarValue: image ? (typeof image.value === 'string' ? image.value : '') : avatar?.value || '',
    avatarColor: image ? (image.color === undefined ? PROFILE_AVATAR_PALETTE[0] : image.color) : avatar?.color || PROFILE_AVATAR_PALETTE[0],
    ...(image ? { avatarImage: image } : {}),
    role: typeof body?.role === 'string' ? body.role : '', tone,
    traits: Array.isArray(body?.personality?.traits) ? body.personality.traits.filter(item => typeof item === 'string') : [],
    speechNotes: typeof body?.personality?.speechNotes === 'string' ? body.personality.speechNotes : '',
    // Preserve the established form keys, absence and every row for validation.
    ...(Object.hasOwn(body?.personality ?? {}, 'examples') ? { personalityExamples: copyProfileFormField(body.personality.examples) } : {}),
    ...(Object.hasOwn(body?.personality ?? {}, 'avoid') ? { personalityAvoid: copyProfileFormField(body.personality.avoid) } : {}),
    expertise: Array.isArray(body?.expertise) ? body.expertise.filter(item => typeof item === 'string') : [],
    instructions: typeof body?.instructions === 'string' ? body.instructions : '',
    toolPreferences: Array.isArray(body?.toolPreferences) ? body.toolPreferences.filter(item => typeof item === 'string') : [],
    model: body?.model && typeof body.model === 'object' ? copy(body.model) : null,
    // A revision saved before AGENT-04 has no toolCeiling key: the switch starts off.
    // The picks stay when the switch is turned off and on again.
    toolCeilingOn: !!publicToolCeiling(body?.toolCeiling),
    toolCeiling: publicToolCeiling(body?.toolCeiling) || openToolCeiling(),
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
  const image = form.avatarKind === 'image' ? profileImageReference(form.avatarImage) : null;
  if (form.avatarKind === 'image' && !image) add('avatar', '저장된 아바타 사진을 확인할 수 없습니다. 다시 선택해 주세요.');
  if (form.avatarKind === 'image' && typeof form.avatarValue !== 'string') add('avatar', '이니셜은 글자나 숫자 1~2자로 넣어 주세요.');
  // Editing the photo's fallback initial or color does not replace the photo.
  // Only an explicit selection of the initial or emoji kind does so.
  const kind = form.avatarKind === 'emoji' ? 'emoji' : form.avatarKind === 'image' ? 'image' : 'initial';
  let avatarValue = formLine(form.avatarValue);
  if (!avatarValue && (kind === 'initial' || kind === 'image') && name) {
    const first = graphemesOf(name)[0] || '';
    avatarValue = isInitial(first) ? first.toUpperCase() : '';
  }
  if (avatarValue && kind === 'emoji' && !isOneEmoji(avatarValue)) add('avatar', '아바타 이모지는 하나만 넣어 주세요.');
  if ((kind === 'image' || (kind === 'initial' && avatarValue)) && !isInitial(avatarValue)) add('avatar', '이니셜은 글자나 숫자 1~2자로 넣어 주세요.');
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
  const examples = formPersonalityExamples(Object.hasOwn(form, 'personalityExamples') ? form.personalityExamples : undefined, limits, add);
  const avoid = formPersonalityAvoid(Object.hasOwn(form, 'personalityAvoid') ? form.personalityAvoid : undefined, limits, add);
  const expertise = formList(form.expertise);
  if (expertise.length > limits.expertise) add('expertise', `맡길 일은 ${limits.expertise}개까지 넣을 수 있습니다.`);
  else if (expertise.some(item => SINGLE_LINE_BAD.test(item) || textLength(item) > limits.expertiseLength)) add('expertise', `맡길 일 하나는 한 줄, ${limits.expertiseLength}자 이하로 적어 주세요.`);
  const instructions = formBlock(form.instructions);
  if (MULTI_LINE_BAD.test(instructions) || textLength(instructions) > limits.instructions) add('instructions', `지침은 ${limits.instructions}자 이하로 적어 주세요.`);
  const toolPreferences = formList(form.toolPreferences);
  if (toolPreferences.length > limits.toolPreferences) add('toolPreferences', `선호 도구는 ${limits.toolPreferences}개까지 넣을 수 있습니다.`);
  else if (toolPreferences.some(item => !TOOL_NAME.test(item) || item.length > limits.toolLength)) add('toolPreferences', '선호 도구 이름은 영문·숫자와 _ . : - 만 쓸 수 있습니다.');
  // Switch off sends null (no ceiling, today's behavior); on sends all five keys.
  const toolCeiling = form.toolCeilingOn === true ? publicToolCeiling(form.toolCeiling) : null;
  if (form.toolCeilingOn === true && !toolCeiling) add('toolCeiling', '쓸 수 있는 도구를 다시 골라 주세요.');
  if (errors.length) return { ok: false, errors, body: null };
  return { ok: true, errors, body: {
    name, avatar: avatarValue ? { kind, value: avatarValue, color, ...(kind === 'image' ? { assetId: image.assetId } : {}) } : null, role,
    personality: { tone, traits, speechNotes,
      ...(examples.length ? { examples } : {}),
      ...(avoid.length ? { avoid } : {}),
    }, expertise, instructions, toolPreferences,
    model: form.model && typeof form.model === 'object' ? copy(form.model) : null,
    toolCeiling,
  } };
}

/**
 * AGENT-02 사용 준비: what a saved body still leaves empty. It never blocks
 * 사용 시작; the list names the gaps and the missing count goes beside it.
 */
export function profileReadinessView(body) {
  const saved = body && typeof body === 'object' ? body : {};
  const items = [
    { key: 'name', label: '담당자 이름', done: !!formLine(saved.name), missingText: '비어 있음' },
    { key: 'avatar', label: '아바타', done: !!publicProfileAvatar(saved.avatar), missingText: '정하지 않음' },
    { key: 'role', label: '역할 한 줄', done: !!formLine(saved.role), missingText: '비어 있음' },
    { key: 'expertise', label: '맡길 일', done: formList(saved.expertise).length > 0, missingText: '비어 있음' },
    { key: 'instructions', label: '지침', done: !!formBlock(saved.instructions), missingText: '비어 있음' },
  ].map(({ missingText, ...item }) => ({ ...item, state: item.done ? '채움' : missingText }));
  const missing = items.filter(item => !item.done).length;
  const ceiling = publicToolCeiling(saved.toolCeiling);
  return { items, missing, ready: missing === 0,
    title: missing ? `사용 준비 · 빠진 항목 ${missing}개` : '사용할 준비가 됐습니다',
    countText: missing ? `빠진 항목 ${missing}개` : null,
    tools: ceiling ? toolCeilingSummary(ceiling) : TOOL_CEILING_OFF_TEXT };
}

/**
 * AGENT-05: the '[···] Agent 작업 중' bubble at the end of the conversation.
 * Shown only while the run is busy and the bridge can say so; it carries no
 * thought text. A run held on 대표님 names what it waits for instead.
 */
export function agentWorkingView(run, { connected = true } = {}) {
  if (!isRunBusy(run) || !connected || run.stopUnconfirmed) return null;
  if (run.pendingApprovals?.length) return { state: 'approval', text: '승인을 기다리는 중' };
  if (pendingUserInputCount(run)) return { state: 'question', text: '답변을 기다리는 중' };
  if (run.stopPending || run.stopRequested || run.status === 'stopping') return { state: 'stopping', text: '중지하는 중' };
  // CU-01: while a computer-control call is in progress the bubble says so.
  if (publicComputerUse(run.computerUse)?.active) return { state: 'computer', text: COMPUTER_USE_ACTIVE_TEXT };
  return { state: 'working', text: 'Agent 작업 중' };
}

/**
 * CHAT-07: what the profile peek shows for an answer's author. `profile` is
 * the room's Agent (null for a plain Codex room); `detail` is GET
 * /profiles/:id once loaded. The model line is the engine chip's own text.
 */
export function agentPeekView({ author = 'Codex', authorAvatar = null, profile = null, detail = null, detailStatus = 'idle',
  modelText = '', boardTitle = '', threadType = 'dm' } = {}) {
  const board = `${boardTitle || 'EG-Desk'}${threadType === 'group' ? ' · Board Thread' : ' · 지금 열린 Board'}`;
  const base = { model: modelText || '확인 안 됨', board, profileId: null, loading: false, note: null, expertiseEmpty: '정하지 않음' };
  if (!profile) {
    return { ...base, name: author || 'Codex', avatar: displayProfileAvatar(authorAvatar), role: '기본 Codex 대화 · 따로 정한 Agent 없음',
      tone: '정하지 않음', expertise: [], tools: '제한 없음' };
  }
  const name = profile.name || author || 'Agent';
  const note = author && author !== name ? `이 답변을 보낸 당시 이름: ${author}` : null;
  if (profile.server !== true) {
    return { ...base, name, avatar: displayProfileAvatar(profile.avatar) || displayProfileAvatar(authorAvatar), role: profile.summary || profile.role || '역할 미설정',
      tone: '정하지 않음', expertise: [], tools: '제한 없음', note };
  }
  const body = detail?.active?.body || null;
  const pending = !body && detailStatus === 'loading' ? '불러오는 중…' : !body ? '확인하지 못했습니다' : null;
  const tone = body ? PROFILE_TONE_OPTIONS.find(option => option.value === body.personality?.tone)?.label || '담백' : null;
  const traits = body ? formList(body.personality?.traits).slice(0, 3) : [];
  return { ...base, name, avatar: displayProfileAvatar(body?.avatar) || displayProfileAvatar(profile.avatar) || displayProfileAvatar(authorAvatar),
    role: formLine(body?.role) || profile.role || '역할 미설정', profileId: profile.id, loading: !!pending && detailStatus === 'loading', note,
    tone: pending || [tone, traits.join(', ')].filter(Boolean).join(' · '),
    expertise: body ? formList(body.expertise) : [],
    expertiseEmpty: pending || '정하지 않음',
    tools: pending || toolCeilingSummary(body.toolCeiling) };
}

const PROFILE_DIFF_LABELS = [['name', '담당자 이름'], ['avatar', '아바타'], ['role', '역할'], ['personality.tone', '말투'],
  ['personality.traits', '성격 특징'], ['personality.speechNotes', '말투 메모'],
  ['personality.examples', '말투 예시'], ['personality.avoid', '피할 표현'], ['expertise', '맡길 일'],
  ['instructions', '지침'], ['toolPreferences', '선호 도구'], ['model', '실행 모델'], ['toolCeiling', '쓸 수 있는 도구']];
function diffValueText(field, value) {
  if (field === 'toolCeiling') return toolCeilingFullText(value);
  if (value === null || value === undefined) return '없음';
  if (field === 'personality.examples') {
    if (!Array.isArray(value)) return '확인 안 됨';
    return value.length ? Array.from(value, (pair, index) => profileExampleShape(pair) && typeof pair.user === 'string' && typeof pair.reply === 'string'
      ? `${index + 1}. 질문: ${pair.user}\n답변: ${pair.reply}` : `${index + 1}. 확인 안 됨`).join('\n\n') : '없음';
  }
  if (field === 'personality.avoid') {
    if (!Array.isArray(value)) return '확인 안 됨';
    return value.length ? Array.from(value, item => typeof item === 'string' ? item : '확인 안 됨').join(', ') : '없음';
  }
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

/**
 * Settings is a passive projection of the bridge's public engines[] snapshot.
 * Authentication, engine availability and bridge connectivity are separate:
 * no status implies a subscription, quota, successful chat or Reader readiness.
 * Public rows do not contain a check time, so even a connected snapshot is
 * described as the last report, not as a freshly verified current account.
 */
export function claudeSettingsView(engines, { connected = false } = {}) {
  const rows = engineRows(engines).filter(row => row.id === 'claude');
  const row = rows.length === 1 ? rows[0] : null;
  const profiles = (Array.isArray(row?.profiles) ? row.profiles : []).filter(profile => profile?.active === true);
  const reportedAuth = row?.installed === false || row?.status === 'notInstalled' || profiles.length !== 1
    ? null : profiles[0]?.auth?.status;
  const authStatus = reportedAuth === 'signedIn' || reportedAuth === 'signedOut' ? reportedAuth : 'unknown';
  // The existing first line introduces the source for the whole status block.
  const source = row ? '연결 프로그램의 마지막 보고 기준' : '연결 프로그램의 보고 확인 안 됨';
  const authLabel = authStatus === 'signedIn' ? '인증됨' : authStatus === 'signedOut' ? '인증 안 됨' : '확인 안 됨';
  const authText = `${source} · 인증: ${authLabel}`;

  const statuses = {
    ready: '준비됨', starting: '준비 중', offline: '사용 상태 확인 안 됨',
    notInstalled: '설치되지 않음', versionUnsupported: '사용할 수 없음',
    loginRequired: '사용 전 인증 확인 필요', decisionPending: '연결 방식 확인 필요', disabled: '사용 중지됨',
  };
  let engineStatus = row?.installed === false ? 'notInstalled'
    : Object.hasOwn(statuses, row?.status) ? row.status : 'unknown';
  if (engineStatus === 'ready' && row?.statusReason) engineStatus = 'attention';
  const engineLabel = engineStatus === 'attention' ? '사용 전 확인 필요' : statuses[engineStatus];
  const engineText = `엔진: ${engineLabel || '확인 안 됨'}`;
  const connectionText = connected === true ? null : 'EG-Desk에 연결되지 않아 현재 상태는 확인할 수 없습니다.';
  const version = row?.installed !== false && row?.status !== 'notInstalled' && typeof row?.version === 'string'
    && /^\d{1,9}\.\d{1,9}\.\d{1,9}(?:[-+][0-9A-Za-z.-]{1,40})?$/.test(row.version) ? row.version : null;
  return { authStatus, authText, engineStatus, engineText, connectionText,
    versionText: version ? `버전 ${version}` : null };
}

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
  // An unavailable explicit choice still expresses intent; the server refuses it.
  if (isEngineId(thread?.engineId)) return thread.engineId;
  if (chatThreadEngineLocked(thread)) return isEngineId(thread.engineId) ? thread.engineId : DEFAULT_CHAT_ENGINE_ID;
  const choices = chatEngineChoices(engines);
  return [thread?.engineId, recentEngineId].find(id => choices.some(choice => choice.id === id && choice.selectable)) || DEFAULT_CHAT_ENGINE_ID;
}

// Routing hints, never an owner grant. A recorded slot wins over today's active
// slot; source-site account/profile ids are intentionally not consulted here.
export function chatThreadEngineProfileId(thread, context = {}) {
  if (typeof thread?.engineProfileId === 'string' && thread.engineProfileId.trim()) return thread.engineProfileId;
  const engineId = chatThreadEngineId(thread, context);
  const profiles = engineRows(context.engines).find(row => row.id === engineId)?.profiles;
  const active = (Array.isArray(profiles) ? profiles : []).filter(profile => profile?.active === true && typeof profile.id === 'string' && profile.id !== 'unknown');
  return active.length === 1 ? active[0].id : engineId === 'codex' ? 'codex-default' : null;
}
export function chatContextRequestScope(thread, context = {}) {
  const scope = { engineId: chatThreadEngineId(thread, context), engineProfileId: chatThreadEngineProfileId(thread, context),
    clientThreadId: clientThreadBinding(thread), ...(thread?.conversationId ? { conversationId: thread.conversationId } : {}) };
  if (!scope.engineProfileId || !scope.clientThreadId) throw new Error('자료를 사용할 대화 연결을 확인하지 못했습니다. 초안은 유지됩니다.');
  return scope;
}
export function supportsClaudeContext(descriptor, scope) {
  return descriptor?.contract === 'egdesk-context-b2' && descriptor.engineId === 'claude'
    && typeof descriptor.expectedContextScope === 'string' && descriptor.expectedContextScope.trim().length > 0 && descriptor.expectedContextScope.length <= 512
    && (!descriptor.engineProfileId || descriptor.engineProfileId === scope.engineProfileId)
    && descriptor.selectedAttachments === true && descriptor.immutableRead === true
    && (descriptor.nativeReader === false || descriptor.nativeReader === true && descriptor.largeReader === true
      && descriptor.reader?.ready === true && descriptor.reader.engineId === 'claude' && descriptor.reader.code === null)
    && Array.isArray(descriptor.tools) && descriptor.tools.length === 2
    && ['egdesk_list_context', 'egdesk_read_source'].every(tool => descriptor.tools.includes(tool));
}
// Public identity is sufficient to invalidate local async work, not to confer
// ownership. Same slot + changed account is a change; billing/usage is not.
export function changedClaudeEngineProfiles(previous, next) {
  const rows = value => {
    const row = engineRows(value).find(item => item.id === 'claude');
    return new Map((Array.isArray(row?.profiles) ? row.profiles : []).map(profile => [profile.id,
      JSON.stringify([profile.active === true, row.status === 'ready' && !row.statusReason,
        profile.auth?.status, profile.auth?.method, identityText(profile.auth?.account).toLowerCase()])]));
  };
  const before = rows(previous), after = rows(next);
  return [...before.keys()].filter(id => before.get(id) !== after.get(id));
}

/** UI eligibility only. The helper remains authoritative for engine/account binding. */
export function chatThreadReadiness(thread, context = {}) {
  const engineId = chatThreadEngineId(thread, context);
  const auth = context.authStatus || context.auth;
  if (engineId === 'codex') return { engineId, ready: !!auth?.isLoggedIn && context.connected === true,
    reason: !auth?.isLoggedIn ? 'Codex 연결 후 전송할 수 있습니다' : !context.connected ? 'Codex 연결을 확인해 주세요' : null };
  const row = engineRows(context.engines).find(entry => entry.id === engineId);
  const profiles = (Array.isArray(row?.profiles) ? row.profiles : []).filter(profile => profile?.active === true);
  const signedIn = profiles.length === 1 && typeof profiles[0].id === 'string' && profiles[0].id !== 'unknown'
    && profiles[0].auth?.status === 'signedIn'
    && (!thread?.engineProfileId || thread.engineProfileId === profiles[0].id);
  const ready = engineId === 'claude' && row?.status === 'ready' && signedIn && !row.statusReason;
  return { engineId, ready, reason: ready ? null : row?.status === 'loginRequired' || profiles[0]?.auth?.status === 'signedOut'
    ? 'Claude 로그인이 필요합니다' : row?.statusReason === 'CLAUDE_API_KEY_DETECTED'
      ? 'Claude 연결 설정을 확인해 주세요' : 'Claude 연결을 확인해 주세요' };
}

// A local receipt may be reused only while the same identifiable Claude CLI
// account occupies the same selected slot. This is a UI fence, not a grant:
// the Context service still verifies the durable account and room binding.
export function claudeInputReceiptOwner(thread, context = {}) {
  if (chatThreadEngineId(thread, context) !== 'claude' || !chatThreadReadiness(thread, context).ready) return null;
  const profileId = chatThreadEngineProfileId(thread, context);
  const row = engineRows(context.engines).find(entry => entry.id === 'claude');
  const profiles = (Array.isArray(row?.profiles) ? row.profiles : []).filter(profile => profile?.active === true && profile.id === profileId);
  const auth = profiles.length === 1 ? profiles[0].auth : null;
  const account = identityText(auth?.account).toLowerCase(), method = identityText(auth?.method);
  return account && method ? JSON.stringify([profileId, method, account]) : null;
}

// ReasoningEffort is a model-advertised string (SDK type: minimal|low|medium|high|xhigh).
// Without a model list the picker offers the common three; '기본' sends nothing so the model default applies.
export const CHAT_EFFORT_CHOICES = Object.freeze([
  Object.freeze({ value: null, label: '기본' }), Object.freeze({ value: 'low', label: '낮음' }),
  Object.freeze({ value: 'medium', label: '보통' }), Object.freeze({ value: 'high', label: '높음' })]);
export const chatEffortValue = value => CHAT_EFFORT_CHOICES.some(choice => choice.value && choice.value === value) ? value : null;
/** Effort choices only when the engine reports per-turn effort selection. */
export const chatEffortChoices = choice => choice?.capabilities?.includes('effortSelect.perTurn') ? CHAT_EFFORT_CHOICES : [];
/** Model line without a model list: only the default (with its verified name when reported). */
export function chatModelLabel(engineConfiguration) {
  const model = typeof engineConfiguration?.effectiveModel === 'string' ? engineConfiguration.effectiveModel.trim().slice(0, 80) : '';
  return model ? `기본 모델 · ${model}` : '기본 모델';
}

// The account's models (helper contract: engines[] row models: null | [{ id, displayName,
// isDefault, supportedEfforts, defaultEffort }], in /v1/state and SSE engine.status).
// null is unknown (signed out, not read yet, account just changed): the panel then
// shows '기본 모델' alone. An effort shows as a Korean word; a value this screen does
// not know reads '기타 강도 N', never the raw token.
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const EFFORT_TOKEN = /^[a-z][a-z0-9_-]{0,31}$/;
const MODEL_LIST_LIMIT = 50;
const EFFORT_LABELS = [['none', '없음'], ['minimal', '최소'], ['low', '낮음'], ['medium', '보통'], ['high', '높음'],
  ['xhigh', '매우 높음'], ['max', '최대'], ['ultra', '초고']];
const modelName = (value, id) => (typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').trim().slice(0, 80) : '') || id;

/** The engine's listed models in bridge order (unique ids, at most one default), or null when unknown. */
export function chatModelCatalog(engines, engineId = DEFAULT_CHAT_ENGINE_ID) {
  const row = engineRows(engines).find(entry => entry.id === engineId);
  if (!Array.isArray(row?.models)) return null;
  const models = [];
  for (const raw of row.models) {
    const id = typeof raw?.id === 'string' && MODEL_ID.test(raw.id) ? raw.id : null;
    if (!id || models.some(model => model.id === id)) continue;
    const supportedEfforts = [...new Set((Array.isArray(raw.supportedEfforts) ? raw.supportedEfforts : [])
      .filter(value => typeof value === 'string' && EFFORT_TOKEN.test(value)))].slice(0, 16);
    models.push({ id, displayName: modelName(raw.displayName, id), isDefault: raw.isDefault === true && !models.some(model => model.isDefault),
      supportedEfforts, defaultEffort: supportedEfforts.includes(raw.defaultEffort) ? raw.defaultEffort : null });
    if (models.length === MODEL_LIST_LIMIT) break;
  }
  return models.length ? models : null;
}

/** Korean word for an effort; an unknown value is numbered among the unknown ones of its model. */
export function chatEffortLabel(value, efforts = []) {
  const known = lookup(EFFORT_LABELS, value);
  if (known) return known;
  const unknown = (Array.isArray(efforts) ? efforts : []).filter(effort => !lookup(EFFORT_LABELS, effort));
  const index = unknown.indexOf(value);
  return `기타 강도 ${index >= 0 ? index + 1 : unknown.length + 1}`;
}

/**
 * The room's model and effort as the panel shows them and /chat/send carries them.
 * With a list: the room's model when it is listed, else the default one, which is
 * what Codex runs when no model is named (the verified launch model when listed,
 * else the bridge's isDefault); the room's effort when that model lists it, else
 * the model's default effort. Without a list: '기본 모델' and the common effort
 * picks, as before the list existed.
 */
export function chatModelView(thread, { engineId = DEFAULT_CHAT_ENGINE_ID, engines = null, auth = null, engineConfiguration = null } = {}) {
  const choice = chatEngineChoices(engines, auth).find(row => row.id === engineId) || null;
  const models = chatModelCatalog(engines, engineId);
  if (!models) {
    const effortChoices = chatEffortChoices(choice);
    return { listed: false, models: null, model: null, defaultModel: null, modelChoices: [],
      effortChoices, effort: effortChoices.length ? chatEffortValue(thread?.effort) : null };
  }
  const launched = typeof engineConfiguration?.effectiveModel === 'string' ? engineConfiguration.effectiveModel.trim() : '';
  const defaultModel = models.find(row => row.id === launched) || models.find(row => row.isDefault) || null;
  const model = models.find(row => row.id === thread?.model) || defaultModel;
  const efforts = model ? model.supportedEfforts : [];
  return {
    listed: true, models, model, defaultModel,
    modelChoices: [
      ...(defaultModel ? [] : [{ value: null, id: null, label: '기본 모델', note: '계정 기본값', selected: !model }]),
      ...models.map(row => ({ value: row === defaultModel ? null : row.id, id: row.id, label: row.displayName,
        note: row === defaultModel ? '기본' : null, selected: row === model })),
    ],
    effortChoices: efforts.map(value => ({ value, label: chatEffortLabel(value, efforts), isDefault: value === model.defaultEffort })),
    effort: efforts.includes(thread?.effort) ? thread.effort : model?.defaultEffort ?? null,
  };
}
const modelViewContext = (thread, context = {}) => ({ ...context,
  engineId: chatThreadEngineId(thread, { recentEngineId: context.recentEngineId ?? null, engines: context.engines ?? null }) });
/** A model pick from the panel: null for the default model, the id for another listed one, undefined when not offered. */
export function chatModelPick(thread, value, context = {}) {
  const option = chatModelView(thread, modelViewContext(thread, context)).modelChoices.find(row => row.value === value);
  return option ? option.value : undefined;
}
/** An effort pick from the panel: kept only when the room's model offers it, else null (its default). */
export function chatEffortPick(thread, value, context = {}) {
  return chatModelView(thread, modelViewContext(thread, context)).effortChoices.some(row => row.value && row.value === value) ? value : null;
}

/**
 * /chat/send model and effort. With a list the effort goes with the model; the
 * default model is left out, except when this conversation last ran another
 * model (Codex keeps a turn's model for later turns, so going back names it) or
 * after a refusal (nameModelNext), so the effort is checked against that model.
 */
export function chatModelSendFields(thread, view) {
  if (!view?.listed) return view?.effort ? { effort: view.effort } : {};
  const fields = {};
  const sentOther = !!thread?.conversationId && typeof thread.sentModel === 'string' && thread.sentModel !== view.model?.id;
  if (view.model && (view.model !== view.defaultModel || sentOther || thread?.nameModelNext === true)) fields.model = view.model.id;
  if (view.effort) fields.effort = view.effort;
  return fields;
}

/** Korean text for a refused model or effort; the choice then returns to the default. */
export function chatModelSendErrorText(code) {
  if (code === 'MODEL_UNAVAILABLE') return '선택한 모델을 지금 계정에서 쓸 수 없어 보내지 않았습니다. 기본 모델로 되돌렸으니 다시 보내 주세요.';
  if (code === 'EFFORT_UNSUPPORTED') return '선택한 모델이 이 추론 강도를 지원하지 않아 보내지 않았습니다. 기본 강도로 되돌렸으니 다시 보내 주세요.';
  return null;
}
/**
 * The room fields a refusal resets: both for a model, the effort alone for an
 * effort. The next send names the model, so a conversation that runs another
 * model than the one shown cannot be refused the same way again.
 */
export function chatModelRejectionReset(code) {
  if (code === 'MODEL_UNAVAILABLE') return { model: null, effort: null, nameModelNext: true };
  if (code === 'EFFORT_UNSUPPORTED') return { effort: null, nameModelNext: true };
  return null;
}

// SSE engine.status sends the engines[] rows whenever one changes. Right after
// connecting, Codex reports '로그인 필요' for a moment before it signs in; a change
// into that status is held this long and dropped when a newer row arrives first.
export const ENGINE_LOGIN_FLICKER_MS = 1500;
const codexRowStatus = engines => engineRows(engines).find(row => row.id === DEFAULT_CHAT_ENGINE_ID)?.status ?? null;
export function chatEngineStatusHeld(current, next) {
  return codexRowStatus(next) === 'loginRequired' && codexRowStatus(current) !== 'loginRequired';
}
export function createEngineStatusDebouncer({ current, apply, delayMs = ENGINE_LOGIN_FLICKER_MS,
  setTimer = globalThis.setTimeout, clearTimer = globalThis.clearTimeout } = {}) {
  let timer = null;
  let pending = null;
  const stop = () => { if (timer !== null) clearTimer(timer); timer = null; pending = null; };
  return {
    push(engines) {
      const rows = Array.isArray(engines) ? engines : null;
      if (chatEngineStatusHeld(current(), rows)) {
        pending = rows;
        if (timer === null) timer = setTimer(() => { const held = pending; timer = null; pending = null; apply(held); }, delayMs);
        return false;
      }
      stop();
      apply(rows);
      return true;
    },
    cancel: stop,
  };
}

const shortModelName = name => { const chars = Array.from(name); return chars.length > 14 ? `${chars.slice(0, 13).join('')}…` : name; };
/** Header chip and room badge: the engine name, the model (short) when listed, plus the effort when one is chosen. */
export function chatEngineChipView(thread, { recentEngineId = null, engines = null, auth = null, engineConfiguration = null } = {}) {
  const engineId = chatThreadEngineId(thread, { recentEngineId, engines });
  const choice = chatEngineChoices(engines, auth).find(row => row.id === engineId) || { id: engineId, label: engineId, account: null, capabilities: [] };
  const locked = chatThreadEngineLocked(thread);
  const view = chatModelView(thread, { engineId, engines, auth, engineConfiguration });
  const effort = view.effortChoices.find(row => row.value && row.value === thread?.effort) || null;
  const model = view.listed ? view.model : null;
  const effective = view.listed ? view.effortChoices.find(row => row.value === view.effort) || null : effort;
  return {
    engineId, label: choice.label, locked,
    text: [choice.label, model ? shortModelName(model.displayName) : null, effort?.label].filter(Boolean).join(' · '),
    title: [`AI 엔진 ${choice.label}`, choice.account, locked ? '이 대화에 고정' : '새 대화에 사용',
      !view.listed ? chatModelLabel(engineConfiguration) : model ? `모델 ${model.displayName}${model === view.defaultModel ? ' (기본)' : ''}` : '기본 모델',
      effective ? `추론 강도 ${effective.label}` : null].filter(Boolean).join(' · '),
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
// Mirrors the runtime's public Claude allowlists and bounds. Incoming reset
// timestamps are already milliseconds; never parse provider strings here.
const RUN_RATE_LIMIT_STATUSES = ['allowed', 'allowed_warning', 'rejected'];
const RUN_RATE_LIMIT_WINDOWS = [
  ['fiveHour', '5시간 한도'], ['weekly', '주간 한도'], ['weeklyOpus', 'Opus 주간 한도'],
  ['weeklySonnet', 'Sonnet 주간 한도'], ['weeklyIncluded', '주간 포함 사용량 한도'], ['overage', '추가 사용량 한도'],
];
const rateLimitEpochMs = value => Number.isFinite(value) && value >= 946684800000 && value <= 253402300799999 ? Math.round(value) : null;
function publicRunRateLimit(value, ...envelopes) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.engineId !== 'claude'
    || !RUN_RATE_LIMIT_STATUSES.includes(value.status) || envelopes.some(envelope => !runEngineMatches(envelope, 'claude'))) return null;
  const fraction = (number, max) => Number.isFinite(number) ? Math.min(max, Math.max(0, number)) : null;
  return {
    engineId: 'claude', status: value.status,
    window: RUN_RATE_LIMIT_WINDOWS.some(([name]) => name === value.window) ? value.window : null,
    windowMinutes: Number.isSafeInteger(value.windowMinutes) && value.windowMinutes > 0 && value.windowMinutes <= 525600 ? value.windowMinutes : null,
    resetsAt: rateLimitEpochMs(value.resetsAt), utilization: fraction(value.utilization, 1), usedPercent: fraction(value.usedPercent, 100),
    overageStatus: RUN_RATE_LIMIT_STATUSES.includes(value.overageStatus) ? value.overageStatus : null,
    creditsRequired: value.creditsRequired === true, autoResume: false,
  };
}
function quotaErrorForRateLimit(rateLimit, error) {
  if (!rateLimit || rateLimit.status !== 'rejected' && !rateLimit.creditsRequired && error?.kind !== 'quota') return null;
  return { code: rateLimit.creditsRequired ? 'CLAUDE_CREDITS_REQUIRED' : 'CLAUDE_RATE_LIMIT', origin: 'claude', kind: 'quota',
    message: rateLimit.creditsRequired ? 'Claude 사용을 계속하려면 추가 사용량이 필요합니다.' : 'Claude 사용 한도에 도달했습니다.',
    retryAt: rateLimit.resetsAt };
}

/** A reported quota observation, never availability proof or a resend action. */
export function runRateLimitNotice(run, now = Date.now()) {
  const rateLimit = publicRunRateLimit(run?.rateLimit, run);
  if (!rateLimit) return null;
  const level = rateLimit.status === 'rejected' || rateLimit.creditsRequired ? 'limit' : rateLimit.status === 'allowed_warning' ? 'warn' : 'ok';
  const windowLabel = RUN_RATE_LIMIT_WINDOWS.find(([name]) => name === rateLimit.window)?.[1] || null;
  const at = Number.isFinite(now) && Number.isFinite(new Date(now).getTime()) ? now : Date.now();
  const clock = formatResetClock(rateLimit.resetsAt, at);
  const resetLabel = clock ? `${rateLimit.resetsAt > at ? '초기화 예정' : '보고된 초기화 시각'}: ${clock}` : null;
  const parts = [windowLabel, rateLimit.usedPercent === null ? null : `사용량 ${Math.round(rateLimit.usedPercent * 10) / 10}%`, resetLabel].filter(Boolean);
  const text = rateLimit.creditsRequired ? 'Claude 사용을 계속하려면 추가 사용량이 필요합니다.' : level === 'limit' ? 'Claude 사용 한도에 도달했습니다.'
    : level === 'warn' ? 'Claude 사용 한도에 가까워졌습니다.' : 'Claude 사용량을 확인했습니다.';
  return { kind: 'quota', level, text: `${text}${parts.length ? ` ${parts.join(' · ')}.` : ''}`,
    action: null, resetLabel, usedPercent: rateLimit.usedPercent };
}

/** Run error copy by kind (helper contract: run.error.kind, retryAt); model/unknown keep the reported text. */
export function runErrorNotice(error, usage = null, now = Date.now()) {
  if (!error) return null;
  if (typeof error === 'string') return { kind: 'unknown', text: error, action: null };
  const kind = ERROR_KIND_VALUES.includes(error.kind) ? error.kind : 'unknown';
  const readError = error.code === 'ABORTED' && error.origin !== 'claude' ? null : claudeContextReadErrorText(error.code);
  if (readError) return { kind, text: readError, action: null };
  if (kind === 'auth') return { kind, text: '다시 로그인이 필요합니다.', action: 'login' };
  if (kind === 'quota') {
    if (error.origin === 'claude') {
      const notice = runRateLimitNotice({ rateLimit: { engineId: 'claude', status: 'rejected', resetsAt: error.retryAt,
        creditsRequired: error.code === 'CLAUDE_CREDITS_REQUIRED' } }, now);
      return { kind, text: notice.text, action: null };
    }
    const resetAt = Number.isFinite(error.retryAt) && error.retryAt > now ? error.retryAt
      : Number.isFinite(usage?.resetsAt) && usage.resetsAt > now ? usage.resetsAt : null;
    const clock = formatResetClock(resetAt, now);
    return { kind, text: clock ? `사용 한도에 도달했습니다. ${clock}에 다시 쓸 수 있습니다.` : '사용 한도에 도달했습니다. 다시 쓸 수 있는 시각은 아직 확인되지 않았습니다.', action: null };
  }
  if (kind === 'permission') return { kind, text: '권한이 부족합니다.', action: null };
  if (kind === 'network') return { kind, text: '연결이 불안정합니다. 다시 시도해 주세요.', action: 'retry' };
  const computerControl = computerControlSendErrorText(error.code);
  if (computerControl) return { kind, text: computerControl, action: null };
  return { kind, text: error.message || error.code || '실행 오류', action: null };
}

/** Compact conversation copy; the original remains available as detail/activity. */
export function chatOperationalNotice(value, { run = false } = {}) {
  const detail = typeof value === 'string' ? value : '';
  if (!detail.trim()) return null;
  const conciseKorean = detail.length <= 90 && !/[\r\n]/.test(detail) && /[가-힣]/.test(detail);
  if (conciseKorean) return { text: detail, detail: null };
  return { text: run ? '실행을 마치지 못했습니다. 활동에서 확인해 주세요.' : '문제가 발생했습니다. 자세히를 확인해 주세요.', detail };
}

// CHAT-09 one-time and branched conversations (helper contract: /chat/history
// threads[] and thread carry stateless and forkedFrom; /v1/state capabilities.chat
// lists 'stateless' and 'fork' when the bridge can do them).
const capabilityListed = (capabilities, name) => Array.isArray(capabilities) && capabilities.includes(name);
/** The room's session kind: 'stateless' (one-time), 'forked' (branched), or null for an ordinary room. */
export function chatSessionKind(thread) {
  if (thread?.stateless === true) return 'stateless';
  if (thread?.forkedFrom && typeof thread.forkedFrom === 'object' && typeof thread.forkedFrom.conversationId === 'string' && thread.forkedFrom.conversationId) return 'forked';
  return null;
}

/** The '기록 없이 시작' switch on a new room: shown until the first send; on only when the bridge supports it. */
export function chatStatelessStartView(thread, capabilities) {
  const supported = capabilityListed(capabilities, 'stateless');
  const open = !!thread && !chatThreadEngineLocked(thread);
  const on = supported && open && thread.startStateless === true;
  const note = !Array.isArray(capabilities) ? '코덱스 연결을 확인한 뒤 고를 수 있습니다.'
    : !supported ? '지금 연결된 브리지는 기록 없이 시작을 지원하지 않습니다.'
      : on ? '코덱스에 대화 기록을 남기지 않습니다. 나중에 이어서 대화하지 못할 수 있고, 분기할 수 없습니다. 이 화면의 대화 내용은 이 기기에 남습니다.'
        : '켜면 코덱스에 기록을 남기지 않는 일회성 대화로 시작합니다.';
  return { available: supported && open, on, note };
}

/** Korean text for /chat/send one-time failures. */
export function chatStatelessErrorText(code) {
  if (code === 'STATELESS_REQUIRES_NEW') return '기록 없이 시작은 새 대화에서만 할 수 있습니다. 새 대화를 열어 다시 보내 주세요.';
  if (code === 'INVALID_STATELESS') return '기록 없이 시작 요청을 확인하지 못해 보내지 않았습니다.';
  if (code === 'STATELESS_UNSUPPORTED') return '이 AI 엔진은 기록 없이 시작을 지원하지 않습니다. 선택을 끄고 다시 보내 주세요.';
  if (code === 'STATELESS_UNVERIFIED') return '코덱스가 기록 없이 시작을 확인해 주지 않아 대화를 연결하지 않았습니다. 다시 보내거나 선택을 끄고 보내 주세요.';
  return null;
}

const BOUNDED_EXECUTION_MODES = ['readOnlyQa', 'browserBounded', 'fixtureBrowserQa'];
/** A room that ran with a bounded policy (QA or a selected Browser): the bridge refuses to branch it. */
export function chatThreadBounded(thread, runs = []) {
  if (thread?.executionBounded === true) return true;
  return [...(Array.isArray(runs) ? runs : []), ...(Array.isArray(thread?.localRuns) ? thread.localRuns : [])]
    .some(run => BOUNDED_EXECUTION_MODES.includes(run?.executionPolicy?.mode ?? run?.executionPolicy));
}

/** Where a message can branch from: its turn in this room's current conversation, else null. */
export function chatMessageForkPoint(thread, message) {
  if (!thread?.conversationId || !message || !['user', 'assistant'].includes(message.role)) return null;
  if (typeof message.runId !== 'string' || !message.runId) return null;
  if (message.conversationId && message.conversationId !== thread.conversationId) return null;
  return message.runId;
}

/**
 * Whether '대화 분기' / '이 지점에서 분기' can run now, and the reason shown
 * when it cannot. A one-time or bounded room never can; others wait for the
 * connection, the account and any running turn.
 */
export function chatForkAvailability(thread, { connected = false, auth = null, capabilities = null, busy = false, runs = [], fromTurnId = null } = {}) {
  const no = reason => ({ available: false, reason });
  if (!thread) return no('대화방을 찾지 못했습니다.');
  if (chatSessionKind(thread) === 'stateless') return no('일회성 대화는 코덱스에 기록이 남지 않아 분기할 수 없습니다.');
  if (chatThreadBounded(thread, runs)) return no('점검이나 Browser 조작으로 제한해 실행한 대화는 분기할 수 없습니다.');
  if (!thread.conversationId) return no(nativeBindingHeld(thread) ? '이전 대화의 계정 소유를 확인한 뒤 분기할 수 있습니다.' : '아직 시작하지 않은 대화는 분기할 수 없습니다.');
  if (!connected || !auth?.isLoggedIn) return no('코덱스에 연결해 로그인하면 분기할 수 있습니다.');
  if (!capabilityListed(capabilities, 'fork')) return no('지금 연결된 브리지는 대화 분기를 지원하지 않습니다.');
  if (!canResumeNativeThread(thread, auth)) return no('지금 로그인한 계정의 대화인지 확인한 뒤 분기할 수 있습니다.');
  const from = fromTurnId ? (Array.isArray(runs) ? runs : []).find(run => run?.runId === fromTurnId && run.conversationId === thread.conversationId) : null;
  if (from && isRunBusy(from)) return no('이 응답이 끝난 뒤 이 지점에서 분기할 수 있습니다.');
  if (busy) return no('진행 중인 실행이 끝난 뒤 분기할 수 있습니다.');
  return { available: true, reason: null };
}

/** POST /chat/fork body: the source's native conversation, the new room's binding, and the turn to branch after. */
export function buildChatForkRequest(source, clientThreadId, fromTurnId = null, engineId = null) {
  const body = { conversationId: source.conversationId, clientThreadId };
  if (typeof fromTurnId === 'string' && fromTurnId) body.fromTurnId = fromTurnId;
  if (isEngineId(engineId)) body.engineId = engineId;
  return body;
}

/**
 * The new room after a 201/200 fork reply, or null when the reply does not
 * name a new conversation for this room. It keeps the source's verified
 * account so /chat/resume can load the branched history.
 */
export function forkedThreadFromResult(target, source, result) {
  const conversationId = typeof result?.conversationId === 'string' && result.conversationId ? result.conversationId : null;
  if (result?.accepted !== true || !conversationId || conversationId === source?.conversationId) return null;
  if (result.clientThreadId !== clientThreadBinding(target)) return null;
  const from = result.forkedFrom && typeof result.forkedFrom === 'object' ? result.forkedFrom : {};
  const text = value => typeof value === 'string' && value ? value : null;
  return {
    ...target,
    conversationId,
    localConversationId: text(result.localConversationId) || target.localConversationId || null,
    engineId: isEngineId(result.engineId) ? result.engineId : target.engineId,
    bindingAccountKey: source.bindingAccountKey || null,
    bindingState: knownCodexAccountKey(source.bindingAccountKey) ? 'verified' : 'live-unverified',
    retainedNativeBinding: null,
    stateless: false,
    startStateless: false,
    forkedFrom: {
      conversationId: text(from.conversationId) || source.conversationId,
      turnId: text(from.turnId),
      clientThreadId: text(from.clientThreadId) || clientThreadBinding(source),
    },
  };
}

/** The room a branch came from: same native conversation first, then its local binding. */
export function findForkSourceThread(threads, forkedFrom) {
  if (!forkedFrom || typeof forkedFrom !== 'object') return null;
  const rows = Array.isArray(threads) ? threads : [];
  const { conversationId, clientThreadId } = forkedFrom;
  return (conversationId && rows.find(thread => thread.conversationId === conversationId || thread.retainedNativeBinding?.conversationId === conversationId))
    || (clientThreadId && rows.find(thread => thread.id === clientThreadId || thread.clientBindingId === clientThreadId
      || thread.retainedNativeBinding?.clientThreadId === clientThreadId || clientThreadId.startsWith(`${thread.id}-binding-`)))
    || null;
}

/** Korean text for a failed /chat/fork; the bridge message stays internal. */
export function chatForkErrorText(error) {
  const code = error?.code;
  if (code === 'FORK_TARGET_EXISTS') return '분기할 새 대화방이 이미 쓰이고 있습니다. 다시 분기해 주세요.';
  if (code === 'FORK_BOUNDED_FORBIDDEN') return '점검이나 Browser 조작으로 제한해 실행한 대화는 분기할 수 없습니다.';
  if (code === 'FORK_STATELESS_FORBIDDEN') return '일회성 대화는 코덱스에 기록이 남지 않아 분기할 수 없습니다.';
  if (code === 'FORK_UNSUPPORTED') return '이 AI 엔진은 대화 분기를 지원하지 않습니다.';
  if (code === 'RUN_IN_PROGRESS') return '진행 중인 실행이 끝난 뒤 분기할 수 있습니다.';
  if (code === 'CONVERSATION_NOT_FOUND') return '원본 대화의 기록을 이 기기에서 찾지 못해 분기하지 못했습니다.';
  if (code === 'NATIVE_ACCOUNT_MISMATCH') return '지금 로그인한 계정의 대화가 아니어서 분기할 수 없습니다.';
  if (code === 'LOGIN_REQUIRED') return '로그인한 뒤 분기할 수 있습니다.';
  if (code === 'CHAT_STORE_UNAVAILABLE') return '이 기기의 대화 기록 저장소를 열 수 없어 분기하지 못했습니다.';
  if (code === 'INVALID_THREAD_RESPONSE' || code === 'THREAD_MISMATCH') return '코덱스의 분기 결과를 확인하지 못했습니다. 원본 대화는 그대로입니다.';
  if (!error?.status) return '브리지에 연결하지 못해 분기하지 못했습니다. 연결을 확인한 뒤 다시 시도해 주세요.';
  return '대화를 분기하지 못했습니다. 원본 대화는 그대로입니다. 잠시 뒤 다시 시도해 주세요.';
}

// CU-07 inherited external tools (helper contract: /v1/state.inheritedMcp is
// null when unknown, else [{ name, enabled, status, controlsExternal, kind }];
// SSE codex { type: 'mcp.inherited', inheritedMcp } replaces it).
const MCP_STATUS_TEXT = [['connected', '연결됨'], ['starting', '시작 중'], ['notStarted', '시작 전'], ['available', '사용 가능'],
  ['authenticationRequired', '로그인 필요'], ['failed', '실패'], ['cancelled', '취소됨'], ['disabled', '꺼짐']];
const MCP_STATUS_TONE = { connected: 'ok', available: 'ok', starting: 'idle', notStarted: 'idle', authenticationRequired: 'warn', failed: 'warn', cancelled: 'off', disabled: 'off' };
const MCP_KIND_TEXT = [['browser', '브라우저 제어'], ['desktop', '컴퓨터 조작'], ['repl', '코드 실행'], ['other', '기타']];
/**
 * Settings rows for the inherited tools: Korean status and kind; 'unknown' when
 * the bridge cannot say. With computer control off (CU-01), a tool that can
 * drive this Mac reads 'EG-Desk 대화에서는 꺼짐' instead of its connection state.
 */
export function inheritedMcpView(value, { computerControl = null } = {}) {
  if (!Array.isArray(value)) return { status: 'unknown', rows: [] };
  const controlOff = normalizeComputerControl(computerControl)?.policy === 'off';
  const rows = value.filter(row => row && typeof row === 'object' && typeof row.name === 'string' && row.name.trim()).slice(0, 64).map(row => {
    const status = lookup(MCP_STATUS_TEXT, row.status) ? row.status : null;
    const kind = lookup(MCP_KIND_TEXT, row.kind) ? row.kind : 'other';
    const off = controlOff && kind === 'desktop';
    return {
      name: row.name.trim().slice(0, 80),
      statusLabel: off ? COMPUTER_CONTROL_OFF_ROW_TEXT : status ? lookup(MCP_STATUS_TEXT, status) : '확인 안 됨',
      tone: off ? 'off' : status ? MCP_STATUS_TONE[status] : 'idle',
      kind, kindLabel: lookup(MCP_KIND_TEXT, kind),
      controlsExternal: row.controlsExternal === true,
      controlOff: off,
    };
  });
  return { status: rows.length ? 'listed' : 'empty', rows };
}

// CU-01 stage 1 computer control (helper contract: /v1/state.computerControl
// { policy: 'inherit'|'off', verified: true|false|null }; SSE codex
// { type: 'computer.control', computerControl } replaces it; POST
// /settings/computer-control { policy } -> 200 { policy, verified } |
// 400 INVALID_COMPUTER_CONTROL_POLICY | 403 SETTINGS_LOOPBACK_REQUIRED; a send the
// bridge could not confirm fails with COMPUTER_CONTROL_UNVERIFIED). The screen
// shows the bridge's value as it is (today 'inherit') and decides nothing.
export const COMPUTER_CONTROL_POLICIES = Object.freeze(['inherit', 'off']);
export const COMPUTER_CONTROL_APPLY_NOTE = '다음에 보내는 메시지부터 적용됩니다';
export const COMPUTER_CONTROL_OFF_ROW_TEXT = 'EG-Desk 대화에서는 꺼짐';
export const COMPUTER_CONTROL_UNVERIFIED_TEXT = '컴퓨터 조작이 꺼졌는지 확인하지 못해 보내지 않았습니다';
/** { policy, verified } as the bridge reports it, or null when it does not say. */
export function normalizeComputerControl(value) {
  if (!value || typeof value !== 'object' || !COMPUTER_CONTROL_POLICIES.includes(value.policy)) return null;
  // persisted (bridge with a settings store): false when the choice holds only until the bridge restarts.
  return { policy: value.policy, verified: typeof value.verified === 'boolean' ? value.verified : null,
    ...(typeof value.persisted === 'boolean' ? { persisted: value.persisted } : {}) };
}
export const COMPUTER_CONTROL_UNSAVED_TEXT = '이번 실행에서만 적용(저장 안 됨)';
export const COMPUTER_CONTROL_SAVED_TEXT = '설정을 저장했습니다. EG-Desk를 다시 시작해도 그대로입니다.';
export const COMPUTER_CONTROL_SAVE_FAILED_TEXT = '아직 저장하지 못했습니다. 이번 실행에서만 적용됩니다. 잠시 뒤 다시 저장해 주세요.';
// The bridge applied the choice but could not save it: it holds until the bridge restarts.
const computerControlUnsaved = current => current.persisted === false
  ? { label: COMPUTER_CONTROL_UNSAVED_TEXT, note: 'EG-Desk를 다시 시작하면 전에 저장된 설정으로 돌아갈 수 있습니다.', action: '다시 저장' } : null;
/** Everything the Settings '컴퓨터 조작' row draws. */
export function computerControlView(value) {
  const current = normalizeComputerControl(value);
  if (!current) {
    return { status: 'unknown', policy: null, on: false, available: false, statusLabel: '확인할 수 없음', check: null,
      note: '코덱스 연결이 준비되면 다시 확인합니다.' };
  }
  if (current.policy === 'inherit') {
    return { status: 'inherit', policy: 'inherit', on: true, available: true, statusLabel: '켜 둠 · 내 Codex 설정 그대로', check: null,
      note: '내 Codex 설정에서 켜 둔 컴퓨터 조작 도구를 EG-Desk 대화의 Agent도 쓸 수 있습니다. 쓸 때마다 대화에 횟수가 남습니다.',
      unsaved: computerControlUnsaved(current) };
  }
  const check = current.verified === true ? { label: '꺼진 것을 확인함', tone: 'ok' }
    : current.verified === false ? { label: '확인 실패', tone: 'warn' } : { label: '아직 확인 안 됨', tone: 'idle' };
  return { status: 'off', policy: 'off', on: false, available: true, statusLabel: 'EG-Desk 대화에서는 끔', check,
    note: '대화를 보낼 때마다 꺼졌는지 확인하고, 확인이 안 되면 보내지 않습니다. Codex 앱 설정은 바뀌지 않습니다.',
    unsaved: computerControlUnsaved(current) };
}
/**
 * POST /settings/computer-control for a real change, or null (unknown, or not a
 * policy). The same policy is sent again only while the bridge reports it
 * unsaved (persisted: false): the bridge then retries the save.
 */
export function buildComputerControlRequest(value, policy) {
  const current = normalizeComputerControl(value);
  if (!current || !COMPUTER_CONTROL_POLICIES.includes(policy)) return null;
  if (policy === current.policy && current.persisted !== false) return null;
  return { path: '/settings/computer-control', body: { policy } };
}
/** Korean text for a refused switch; the setting stays as it was. */
export function computerControlErrorText(error) {
  const code = error?.code;
  if (code === 'INVALID_COMPUTER_CONTROL_POLICY') return '바꿀 수 없는 값이라 설정을 그대로 두었습니다.';
  if (code === 'SETTINGS_LOOPBACK_REQUIRED' || error?.status === 403) return '이 컴퓨터의 EG-Desk에서만 바꿀 수 있습니다. 설정은 그대로입니다.';
  if (error?.status === 404 || error?.status === 405) return '지금 연결된 EG-Desk는 이 설정을 지원하지 않습니다.';
  if (!error?.status) return 'EG-Desk에 연결하지 못해 바꾸지 못했습니다. 연결을 확인한 뒤 다시 시도해 주세요.';
  return '설정을 바꾸지 못했습니다. 잠시 뒤 다시 시도해 주세요.';
}
/** Korean text for /chat/send refused because computer control could not be confirmed off. */
export function computerControlSendErrorText(code) {
  if (code === 'COMPUTER_CONTROL_UNVERIFIED') return `${COMPUTER_CONTROL_UNVERIFIED_TEXT}. 잠시 뒤 다시 보내거나 설정의 컴퓨터 조작 상태를 확인해 주세요.`;
  return null;
}
// An activity row of an MCP tool call names what its server can drive (detail.controlKind).
const MCP_CONTROL_BADGES = [['computer', '컴퓨터 조작'], ['browser', '브라우저 제어'], ['repl', '코드 실행']];
/** The badge for an mcpToolCall row, or null; no argument text is ever read. */
export function mcpControlBadge(activity) {
  if (activity?.kind !== 'mcpToolCall' || !activity.detail || typeof activity.detail !== 'object') return null;
  const label = lookup(MCP_CONTROL_BADGES, activity.detail.controlKind);
  return label ? { kind: activity.detail.controlKind, label } : null;
}
/**
 * The badge drawn beside an activity title: none when the title already names
 * it (the bridge titles computer-control rows '컴퓨터 조작 · {tool}'), so one
 * row says '컴퓨터 조작' once.
 */
export function activityControlBadge(activity) {
  const badge = mcpControlBadge(activity);
  return badge && !(typeof activity.title === 'string' && activity.title.startsWith(badge.label)) ? badge : null;
}

// CU-01 (Q1 (다)) how often an answer drove this Mac (helper contract 0387f73:
// run.computerUse { calls, lastAt: ms | null, servers: ≤8 names, active } on
// snapshots and stored runs, absent when the run never drove the Mac; SSE
// chat.event 'computer.used' details { runId, calls, lastAt, active } after a
// call starts or ends, with active false before run.completed and
// run.unavailable; run.started details.computerControl { policy } for an
// ordinary Codex run; mcpToolCall rows carry sizes only: argumentsBytes,
// resultImageCount, resultTextBytes). No call content ever reaches the screen.
export const COMPUTER_USE_ACTIVE_TEXT = '컴퓨터 조작 중';
const MAX_COMPUTER_SERVERS = 8;
/** { calls, lastAt, servers, active } as the bridge reports it, or null. */
export function publicComputerUse(value) {
  if (!value || typeof value !== 'object') return null;
  return {
    calls: Number.isSafeInteger(value.calls) && value.calls >= 0 ? value.calls : 0,
    lastAt: Number.isFinite(value.lastAt) && value.lastAt > 0 ? value.lastAt : null,
    servers: (Array.isArray(value.servers) ? value.servers : []).filter(name => typeof name === 'string' && name.trim())
      .map(name => name.trim().slice(0, 120)).slice(0, MAX_COMPUTER_SERVERS),
    active: value.active === true,
  };
}
const isComputerActivity = activity => mcpControlBadge(activity)?.kind === 'computer';
const clockText = at => {
  const date = new Date(at);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
};
/**
 * The one line under an answer whose run drove this Mac: '이 답변에서 컴퓨터를
 * N번 조작했어요 · 마지막 HH:MM', or null when it never did. While a call is in
 * progress the working bubble says '컴퓨터 조작 중', so the line only counts
 * ('이 답변에서 컴퓨터 조작 N번 · …') and is tinted. activityId is the run's
 * latest computer-control row, where pressing the line goes.
 */
export function computerUseView(run, { formatTime = clockText } = {}) {
  const use = publicComputerUse(run?.computerUse);
  const active = !!use?.active && isRunBusy(run);
  if (!use || (use.calls <= 0 && !active)) return null;
  const time = use.lastAt ? formatTime(use.lastAt) : null;
  const head = active ? `이 답변에서 컴퓨터 조작 ${use.calls}번` : `이 답변에서 컴퓨터를 ${use.calls}번 조작했어요`;
  const text = [head, time ? `마지막 ${time}` : null].filter(Boolean).join(' · ');
  const rows = (Array.isArray(run.activities) ? run.activities : []).filter(isComputerActivity);
  return { calls: use.calls, active, lastAt: use.lastAt, text, label: `${text}${active ? ' · 지금 조작 중' : ''} · 활동 기록에서 보기`, activityId: rows.at(-1)?.id || null };
}
/** The activity record's line under a run head: count and tools, or the policy it ran under; null when unknown. */
export function computerUseRunLine(run, { formatTime = clockText } = {}) {
  const use = publicComputerUse(run?.computerUse);
  if (use && use.calls > 0) {
    return [`컴퓨터 조작 ${use.calls}번`, use.lastAt ? `마지막 ${formatTime(use.lastAt)}` : null,
      use.active && isRunBusy(run) ? '지금 조작 중' : null, use.servers.length ? use.servers.join(', ') : null].filter(Boolean).join(' · ');
  }
  if (run?.computerControl?.policy === 'off') return '컴퓨터 조작 끈 채로 실행';
  if (run?.computerControl?.policy === 'inherit') return '컴퓨터 조작 켜 둠 · 이 실행에서는 조작 안 함';
  return null;
}
const byteText = bytes => bytes < 1024 ? `${bytes}바이트`
  : bytes < 1024 * 1024 ? `${Number((bytes / 1024).toFixed(1))}KB` : `${Number((bytes / 1024 / 1024).toFixed(1))}MB`;
const sizeOf = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
/**
 * The detail line of an MCP call row: '{server} · 인자 N바이트 · 화면 N장 ·
 * 글 N바이트 · N초', sizes and counts only; null for other rows.
 */
export function mcpCallDetailText(activity) {
  if (activity?.kind !== 'mcpToolCall' || !activity.detail || typeof activity.detail !== 'object') return null;
  const { server, argumentsBytes, resultImageCount, resultTextBytes, durationMs } = activity.detail;
  const parts = [typeof server === 'string' && server.trim() ? server.trim().slice(0, 120) : null];
  if (sizeOf(argumentsBytes) !== null) parts.push(`인자 ${byteText(argumentsBytes)}`);
  if (sizeOf(resultImageCount) !== null) parts.push(`화면 ${resultImageCount}장`);
  if (sizeOf(resultTextBytes)) parts.push(`글 ${byteText(resultTextBytes)}`);
  if (Number.isFinite(durationMs) && durationMs >= 0) parts.push(durationMs < 1000 ? `${Math.round(durationMs)}ms` : `${Number((durationMs / 1000).toFixed(1))}초`);
  const text = parts.filter(Boolean).join(' · ');
  return text || null;
}

// CHAT-06 Await task list (helper contract: GET /tasks/state?graphId= -> { graph,
// native: { boardId, scope }, board }; SSE codex { type: 'task.graph', graphId,
// change, graph } with graph as the state route shows it, { type: 'task.native' }
// as a hint to read the state again, { type: 'task.plan', plan } with step titles;
// POST /tasks/continue { boardId, scope, taskId, gateId } for one waiting or
// expired outside gate -> 200 state | 409 TASK_GATE_STALE; POST /tasks/approval
// { boardId, scope, taskId, approvalId, decision: 'approved'|'rejected' } with the
// approvalId from state.native.approvals; POST /tasks/resume { boardId, scope }
// after a bridge restart left the graph on recoveryHold). The screen keeps only
// the graphs it has seen, at most TASK_BOARD_LIMIT, first seen first, and shows
// only graphs that were started (an Agent's plan joins once approved). No task,
// gate, approval or source ID and no English status ever reaches the screen text.
export const TASK_BOARD_LIMIT = 12;
const TASK_REF = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const TASK_SCOPE_KEYS = ['graphId', 'requestId', 'runId', 'parentTaskId', 'requestedBy'];
const TASK_STATUS_TEXT = [['queued', '대기 중'], ['waiting-on-dependency', '대기 중'], ['approval-required', '대기 중'],
  ['ready', '준비됨'], ['running', '실행 중'], ['completed', '완료'], ['failed', '실패'], ['cancelled', '취소']];
const TASK_WAITING_STATUSES = ['queued', 'waiting-on-dependency', 'approval-required', 'ready'];
const TASK_DONE_STATUSES = ['completed', 'failed', 'cancelled'];
const TASK_GATE_KEYS = ['gateId', 'kind', 'status', 'taskId', 'origin', 'pathPrefix', 'root', 'relativeGlob', 'label',
  'satisfiedBy', 'satisfiedAt', 'expiresAt', 'expiredAt', 'requested', 'response'];
/** Outside conditions the user may continue by hand; an upstream task or an approval never. */
export const TASK_CONTINUE_GATE_KINDS = Object.freeze(['userAction', 'oauth', 'file', 'terminalExit']);
export const taskRef = value => typeof value === 'string' && TASK_REF.test(value);
const taskLine = (value, max) => typeof value === 'string'
  ? value.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '';
const taskTime = value => {
  const at = typeof value === 'string' && value.length <= 40 ? Date.parse(value) : NaN;
  return Number.isFinite(at) ? at : null;
};

/** Korean word for a task status; an unknown value never shows as the raw token. */
export const taskStatusText = status => lookup(TASK_STATUS_TEXT, status) || '상태 확인 중';

// Only the fields the list shows are kept from a frame or state read.
function taskGraphShape(graph) {
  if (!graph || typeof graph !== 'object' || !taskRef(graph.graphId) || !Array.isArray(graph.tasks) || graph.tasks.length > 256) return null;
  const tasks = [];
  for (const raw of graph.tasks) {
    if (!raw || typeof raw !== 'object' || !taskRef(raw.taskId) || tasks.some(task => task.taskId === raw.taskId)) continue;
    const gates = (Array.isArray(raw.gates) ? raw.gates : []).slice(0, 272)
      .filter(gate => gate && typeof gate === 'object' && typeof gate.gateId === 'string' && typeof gate.kind === 'string')
      .map(gate => Object.fromEntries(TASK_GATE_KEYS.filter(key => gate[key] !== undefined)
        // Copy only the public question schema. Invalid descriptors keep an
        // explicit null sentinel; dropping them would turn a question into a
        // legacy no-answer gate. Never retain an answer or a private textRef.
        .map(key => [key, key === 'response' ? taskGateView(gate).response : gate[key]])));
    tasks.push({ taskId: raw.taskId, status: typeof raw.status === 'string' ? raw.status : null, approvalRequested: raw.approvalRequested === true, gates });
  }
  return {
    ...Object.fromEntries(TASK_SCOPE_KEYS.map(key => [key, graph[key] ?? null])),
    activated: graph.activated === true, cancelRequested: graph.cancelRequested === true, recoveryHold: graph.recoveryHold === true,
    tasks,
  };
}
function taskScopeShape(scope) {
  if (!scope || typeof scope !== 'object') return null;
  const ok = TASK_SCOPE_KEYS.every(key => key === 'parentTaskId' ? scope[key] === null || taskRef(scope[key]) : taskRef(scope[key]));
  return ok ? Object.fromEntries(TASK_SCOPE_KEYS.map(key => [key, scope[key]])) : null;
}
const taskGraphDone = graph => !!graph && graph.tasks.every(task => TASK_DONE_STATUSES.includes(task.status));

export const createTaskBoard = () => ({ graphs: [], seen: 0 });
export const taskBoardEntry = (board, graphId) => (board?.graphs || []).find(entry => entry.graphId === graphId) || null;

// One entry per graph. rev counts graph updates so an older state read cannot
// replace a newer SSE frame.
function upsertTaskEntry(board, graphId, change) {
  const current = board && Array.isArray(board.graphs) ? board : createTaskBoard();
  const existing = taskBoardEntry(current, graphId);
  const seen = (current.seen || 0) + (existing ? 0 : 1);
  const entry = { ...(existing || { graphId, graph: null, rev: 0, boardId: null, scope: null, titles: {}, planTitle: null, approvals: [], order: seen }), ...change(existing) };
  let graphs = existing ? current.graphs.map(row => row.graphId === graphId ? entry : row) : [...current.graphs, entry];
  // Over the limit: a finished graph leaves first, then one nobody started, then the oldest.
  while (graphs.length > TASK_BOARD_LIMIT) {
    const drop = graphs.find(row => row.graphId !== graphId && taskGraphDone(row.graph))
      || graphs.find(row => row.graphId !== graphId && row.graph && row.graph.activated !== true) || graphs.find(row => row.graphId !== graphId);
    graphs = graphs.filter(row => row !== drop);
  }
  return { graphs, seen };
}

/** A task.graph frame (or a state read's graph): the graph as shown now. */
export function taskBoardWithGraph(board, graph) {
  const shaped = taskGraphShape(graph);
  if (!shaped) return board || createTaskBoard();
  return upsertTaskEntry(board, shaped.graphId, existing => ({ graph: shaped, rev: (existing?.rev || 0) + 1 }));
}

/**
 * GET /tasks/state or a POST /tasks/* reply: the Board and exact scope the
 * continue request needs, the approval requests the graph has issued, and the
 * graph unless a newer frame arrived since the read began (ifRev = the entry's
 * rev when the read started).
 */
export function taskBoardWithState(board, payload, { ifRev } = {}) {
  const shaped = taskGraphShape(payload?.graph);
  if (!shaped) return board || createTaskBoard();
  const boardId = taskRef(payload?.native?.boardId) ? payload.native.boardId : null;
  const scope = taskScopeShape(payload?.native?.scope);
  const approvals = Array.isArray(payload?.native?.approvals) ? payload.native.approvals
    .filter(item => taskRef(item?.approvalId) && taskRef(item?.taskId) && typeof item.status === 'string').slice(-256)
    .map(item => ({ approvalId: item.approvalId, taskId: item.taskId, status: item.status })) : null;
  return upsertTaskEntry(board, shaped.graphId, existing => {
    const fresh = ifRev === undefined || (existing?.rev || 0) === ifRev;
    return { ...(fresh ? { graph: shaped, rev: (existing?.rev || 0) + 1 } : {}),
      ...(boardId ? { boardId } : {}), ...(scope && scope.graphId === shaped.graphId ? { scope } : {}), ...(approvals ? { approvals } : {}) };
  });
}

/** A task.plan frame: step titles (and the plan's Board) for that graph. */
export function taskBoardWithPlan(board, plan) {
  if (!plan || typeof plan !== 'object' || !taskRef(plan.graphId) || !Array.isArray(plan.tasks)) return board || createTaskBoard();
  const titles = Object.fromEntries(plan.tasks.filter(task => taskRef(task?.taskId) && taskLine(task.title, 200))
    .slice(0, 256).map(task => [task.taskId, taskLine(task.title, 200)]));
  const scope = taskScopeShape(plan.scope);
  return upsertTaskEntry(board, plan.graphId, () => ({ titles, planTitle: taskLine(plan.title, 200) || null,
    ...(taskRef(plan.boardId) ? { boardId: plan.boardId } : {}), ...(scope && scope.graphId === plan.graphId ? { scope } : {}) }));
}

export function taskBoardWithout(board, graphId) {
  const current = board && Array.isArray(board.graphs) ? board : createTaskBoard();
  return { ...current, graphs: current.graphs.filter(entry => entry.graphId !== graphId) };
}

/** Graphs still worth reading again (any task not finished). */
export const taskBoardOpenGraphIds = board => (board?.graphs || [])
  .filter(entry => !entry.graph || !taskGraphDone(entry.graph)).map(entry => entry.graphId);

// A graph nobody started yet (an Agent's plan before approval) is not a task to wait on.
const taskBoardShown = board => (board?.graphs || []).filter(entry => entry.graph?.activated === true);

/** '진행 N건 · 대기 M건' (running; not started yet), or what finished when nothing is left. */
export function taskBoardSummary(board) {
  const tasks = taskBoardShown(board).flatMap(entry => entry.graph.tasks);
  const count = statuses => tasks.filter(task => statuses.includes(task.status)).length;
  const running = count(['running']);
  const waiting = count(TASK_WAITING_STATUSES);
  const completed = count(['completed']), failed = count(['failed']), cancelled = count(['cancelled']);
  const text = running || waiting ? `진행 ${running}건 · 대기 ${waiting}건`
    : ['작업 끝남', completed ? `완료 ${completed}건` : '', failed ? `실패 ${failed}건` : '', cancelled ? `취소 ${cancelled}건` : ''].filter(Boolean).join(' · ');
  return { visible: tasks.length > 0, running, waiting, completed, failed, cancelled, text };
}

const originHost = origin => { try { return new URL(origin).host || null; } catch { return null; } };

/**
 * One condition line. waiting: what the task waits for; satisfied: what happened
 * with a check and the time; expired: the wait ran out (only a hand can open it).
 */
export function taskGateView(gate, { taskNames = {}, folderName = null, now = Date.now() } = {}) {
  const kind = gate?.kind;
  const status = ['waiting', 'satisfied', 'expired', 'rejected'].includes(gate?.status) ? gate.status : 'waiting';
  // Mirrors the helper's public response schema, without importing a Node
  // runtime module. Text answer length is Unicode code points, not textarea
  // maxLength's UTF-16 units. The server remains the authority for secrets.
  // Legacy gates omit these fields. A present but malformed response is not a
  // legacy gate: UI and request construction both fail closed.
  let question = {};
  if (gate?.response !== undefined) {
    const raw = gate.response;
    const shape = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value)
      && Object.keys(value).every(key => keys.includes(key));
    let response = null;
    if (kind === 'userAction' && shape(raw, ['kind', 'options']) && raw.kind === 'choice'
        && Array.isArray(raw.options) && raw.options.length >= 2 && raw.options.length <= 6
        && raw.options.every(option => shape(option, ['id', 'label'])
          && typeof option.id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(option.id)
          && typeof option.label === 'string' && option.label.trim().length > 0 && option.label.length <= 120
          && !/[\u0000-\u001f\u007f]/.test(option.label))
        && new Set(raw.options.map(option => option.id)).size === raw.options.length) {
      response = { kind: 'choice', options: raw.options.map(option => ({ id: option.id, label: option.label })) };
    } else if (kind === 'userAction' && shape(raw, ['kind', 'maxLength']) && raw.kind === 'text'
        && (raw.maxLength === undefined || Number.isSafeInteger(raw.maxLength) && raw.maxLength >= 1 && raw.maxLength <= 500)) {
      response = { kind: 'text', maxLength: raw.maxLength ?? 500 };
    }
    // Equality key for the UI's account/room/graph/task/gate-scoped draft.
    // Stable across equal SSE/refresh copies; changes with the original question,
    // option order/labels/IDs or effective text limit. Never contains an answer
    // and is not an authority token or user-facing text.
    question = response ? { response, responseKey: JSON.stringify([kind, typeof gate.label === 'string' ? gate.label : null, response]) }
      : { response: null, responseKey: null, responseInvalid: true,
        responseError: '질문 내용을 확인하지 못했습니다. 목록을 다시 불러와 주세요.' };
  }
  let waitingText, doneText;
  if (kind === 'task') {
    const name = taskNames[gate.taskId] || '앞 작업';
    waitingText = `${name} 완료 대기`; doneText = `${name} 완료`;
  } else if (kind === 'oauth') {
    const host = originHost(gate.origin);
    waitingText = host ? `로그인 완료 대기 · ${host}` : '로그인 완료 대기'; doneText = host ? `로그인 완료 · ${host}` : '로그인 완료';
  } else if (kind === 'file') {
    const folder = taskLine(typeof folderName === 'function' ? folderName(gate.root) : null, 80) || '연결된 폴더';
    const pattern = taskLine(gate.relativeGlob, 160);
    const where = pattern ? `${folder}/${pattern}` : folder;
    waitingText = `${where} 도착 대기`; doneText = `${where} 도착`;
  } else if (kind === 'terminalExit') {
    waitingText = '터미널 종료 대기'; doneText = '터미널 종료';
  } else if (kind === 'userAction') {
    const label = taskLine(gate.label, 200);
    waitingText = label ? `확인 대기 · ${label}` : '확인 대기'; doneText = label ? `확인됨 · ${label}` : '확인됨';
  } else if (kind === 'approval') {
    waitingText = '승인 대기'; doneText = '승인됨';
  } else {
    waitingText = '조건 대기'; doneText = '조건 충족';
  }
  const byHand = status === 'satisfied' && gate.satisfiedBy === 'user.action' && kind !== 'userAction';
  const clock = value => { const at = taskTime(value); return at === null ? null : formatResetClock(at, now); };
  if (status === 'satisfied') return { gateId: gate.gateId, kind, state: status, text: byHand ? `${doneText} · 직접 진행` : doneText, time: clock(gate.satisfiedAt), byHand, ...question };
  if (status === 'rejected') return { gateId: gate.gateId, kind, state: status, text: '승인 거절됨', time: null, byHand: false, ...question };
  if (status === 'expired') return { gateId: gate.gateId, kind, state: status, text: `${waitingText} · 시간 초과`, time: clock(gate.expiredAt), byHand: false, ...question };
  const until = clock(gate.expiresAt);
  return { gateId: gate.gateId, kind, state: status, text: waitingText, time: until ? `${until}까지` : null, byHand: false, ...question };
}

/** The '계속' fallback: an outside condition still waiting (or run out) in a started, not cancelled graph. */
export function taskGateContinuable(graph, task, gate) {
  return !!graph && graph.activated === true && graph.cancelRequested !== true
    && ['queued', 'waiting-on-dependency'].includes(task?.status)
    && TASK_CONTINUE_GATE_KINDS.includes(gate?.kind) && ['waiting', 'expired'].includes(gate?.status) && taskRef(gate?.gateId);
}

/**
 * POST /tasks/continue body, or null while the Board is unknown or the gate is
 * no longer continuable. Optional answer is exactly {choice: optionId} or
 * {text}; required only for a question. Invalid answers/descriptors throw a
 * path/input-free {code:'TASK_GATE_ANSWER', status:400}; use
 * taskContinueErrorText() for display. Legacy no-answer bodies are unchanged.
 * Text normalization/validation matches helper normalizeGateAnswer: NFC,
 * CRLF/CR -> LF, trim, then 1..maxLength Unicode code points (default 500),
 * allowing tab/LF but not the helper's other control characters. No clipping.
 * No answer is kept in Board state. The UI owns transient drafts scoped to
 * account/room/graph/task/gate/question; failures retain that same draft only.
 * Build/send only on explicit Continue, never selection, typing or Enter. The
 * host must compare the captured responseKey and binding with the current row
 * before sending, and lock duplicate submits until its result is known. A
 * satisfied question means answer accepted, not that its task resumed/finished.
 */
export function buildTaskContinueRequest(entry, taskId, gateId, answer) {
  const graph = entry?.graph;
  const task = graph?.tasks.find(row => row.taskId === taskId);
  const gate = task?.gates.find(row => row.gateId === gateId);
  if (!taskRef(entry?.boardId) || !taskGateContinuable(graph, task, gate)) return null;
  const scope = entry.scope || taskScopeShape(graph);
  if (!scope || scope.graphId !== graph.graphId) return null;
  const question = taskGateView(gate);
  const refuse = () => { throw Object.assign(new Error(taskContinueErrorText({ code: 'TASK_GATE_ANSWER' })),
    { code: 'TASK_GATE_ANSWER', status: 400 }); };
  let normalized;
  if (question.responseInvalid) refuse();
  if (!question.response) {
    if (answer !== undefined) refuse();
  } else {
    const response = question.response;
    if (answer === null || typeof answer !== 'object' || Array.isArray(answer)
        || Object.keys(answer).length !== 1 || !Object.hasOwn(answer, response.kind)) refuse();
    if (response.kind === 'choice') {
      if (typeof answer.choice !== 'string' || !response.options.some(option => option.id === answer.choice)) refuse();
      normalized = { choice: answer.choice };
    } else {
      const value = typeof answer.text === 'string' ? answer.text.normalize('NFC').replace(/\r\n?/g, '\n').trim() : '';
      if (!value.length || Array.from(value).length > response.maxLength || /[\u0000-\u0008\u000b-\u001f\u007f]/.test(value)) refuse();
      normalized = { text: value };
    }
  }
  return { boardId: entry.boardId, scope: { ...scope }, taskId, gateId,
    ...(normalized === undefined ? {} : { answer: normalized }) };
}

/** Korean text for a refused continue; the bridge message stays internal. */
export function taskContinueErrorText(error) {
  const code = error?.code;
  if (code === 'TASK_GATE_ANSWER') return '답변을 확인해 주세요. 제시된 항목 하나를 선택하거나 글자 수 제한에 맞는 내용을 입력해 주세요.';
  if (code === 'TASK_GATE_ANSWER_PRIVATE') return '비밀번호·키·인증번호·개인정보처럼 보이는 내용은 보낼 수 없습니다. 해당 값을 빼고 다시 답해 주세요.';
  if (code === 'TASK_GATE_STALE') return '이 조건은 이미 풀렸거나 더 이상 기다리지 않습니다. 목록을 다시 확인했습니다.';
  if (code === 'TASK_FENCED') return '취소된 작업이라 진행할 수 없습니다.';
  if (code === 'TASK_NOT_FOUND') return '이 작업을 더 이상 찾을 수 없습니다.';
  if (code === 'TASK_ROUTE_NOT_FOUND') return '지금 연결된 EG-Desk는 수동 진행을 지원하지 않습니다.';
  if (code === 'LOGIN_REQUIRED') return '로그인한 뒤 진행할 수 있습니다.';
  if (code === 'BRIDGE_OFFLINE') return 'AI 엔진이 아직 준비되지 않아 진행하지 못했습니다. 잠시 뒤 다시 시도해 주세요.';
  if (code === 'TASK_SCOPE' || code === 'E_TASK_SCOPE' || code === 'TASK_RECONCILE_REQUIRED' || error?.status === 409)
    return '작업 상태가 바뀌어 진행하지 못했습니다. 목록을 다시 확인한 뒤 시도해 주세요.';
  if (!error?.status) return 'EG-Desk에 연결하지 못해 진행하지 못했습니다. 연결을 확인한 뒤 다시 시도해 주세요.';
  return '진행하지 못했습니다. 잠시 뒤 다시 시도해 주세요.';
}

/** The approval a waiting task asked for (state.native.approvals), or null: never for an unstarted or cancelled graph. */
export function taskApprovalId(entry, taskId) {
  const graph = entry?.graph;
  const task = graph?.tasks.find(row => row.taskId === taskId);
  if (!graph || graph.activated !== true || graph.cancelRequested === true) return null;
  if (task?.status !== 'approval-required' || task.approvalRequested !== true) return null;
  const gate = task.gates.find(row => row.kind === 'approval');
  if (gate && gate.status !== 'waiting') return null;
  const pending = (entry.approvals || []).filter(row => row.taskId === taskId && row.status === 'pending');
  return pending.length ? pending.at(-1).approvalId : null;
}

/** POST /tasks/approval body for 대표님's own decision, or null while nothing is waiting for one. */
export function buildTaskApprovalRequest(entry, taskId, decision) {
  if (!['approved', 'rejected'].includes(decision) || !taskRef(entry?.boardId)) return null;
  const approvalId = taskApprovalId(entry, taskId);
  if (!approvalId) return null;
  const scope = entry.scope || taskScopeShape(entry.graph);
  if (!scope || scope.graphId !== entry.graph.graphId) return null;
  return { boardId: entry.boardId, scope: { ...scope }, taskId, approvalId, decision };
}

/** Korean text for a refused approval decision; the bridge message stays internal. */
export function taskApprovalErrorText(error) {
  const code = error?.code;
  if (code === 'TASK_APPROVAL_STALE') return '이 승인 요청은 이미 처리되었거나 바뀌었습니다. 목록을 다시 확인했습니다.';
  if (code === 'TASK_FENCED') return '취소된 작업이라 승인 여부를 정할 수 없습니다.';
  if (code === 'TASK_NOT_FOUND') return '이 작업을 더 이상 찾을 수 없습니다.';
  if (code === 'TASK_ROUTE_NOT_FOUND') return '지금 연결된 EG-Desk는 작업 승인을 지원하지 않습니다.';
  if (code === 'LOGIN_REQUIRED') return '로그인한 뒤 승인할 수 있습니다.';
  if (code === 'BRIDGE_OFFLINE') return 'AI 엔진이 아직 준비되지 않아 처리하지 못했습니다. 잠시 뒤 다시 시도해 주세요.';
  if (code === 'TASK_SCOPE' || code === 'E_TASK_SCOPE' || code === 'TASK_RECONCILE_REQUIRED' || error?.status === 409)
    return '작업 상태가 바뀌어 처리하지 못했습니다. 목록을 다시 확인한 뒤 시도해 주세요.';
  if (!error?.status) return 'EG-Desk에 연결하지 못해 처리하지 못했습니다. 연결을 확인한 뒤 다시 시도해 주세요.';
  return '처리하지 못했습니다. 잠시 뒤 다시 시도해 주세요.';
}

/** Graphs a bridge restart left on hold: started, not cancelled, not finished. Only '이어서 진행' moves them on. */
export const taskBoardHeldEntries = board => (board?.graphs || []).filter(entry => {
  const graph = entry.graph;
  return !!graph && graph.recoveryHold === true && graph.activated === true && graph.cancelRequested !== true && !taskGraphDone(graph);
});

/** POST /tasks/resume body for one held graph, or null while its Board is unknown or it is not held. */
export function buildTaskResumeRequest(entry) {
  if (!taskRef(entry?.boardId) || !taskBoardHeldEntries({ graphs: [entry] }).length) return null;
  const scope = entry.scope || taskScopeShape(entry.graph);
  if (!scope || scope.graphId !== entry.graph.graphId) return null;
  return { boardId: entry.boardId, scope: { ...scope } };
}

/** Korean text for a refused resume. */
export function taskResumeErrorText(error) {
  const code = error?.code;
  if (code === 'TASK_FENCED') return '취소된 작업이라 이어 갈 수 없습니다.';
  if (code === 'TASK_NOT_FOUND') return '이 작업을 더 이상 찾을 수 없습니다.';
  if (code === 'TASK_ROUTE_NOT_FOUND') return '지금 연결된 EG-Desk는 이어 가기를 지원하지 않습니다.';
  if (code === 'LOGIN_REQUIRED') return '로그인한 뒤 이어 갈 수 있습니다.';
  if (code === 'BRIDGE_OFFLINE') return 'AI 엔진이 아직 준비되지 않아 이어 가지 못했습니다. 잠시 뒤 다시 시도해 주세요.';
  if (error?.status === 409) return '작업 상태를 아직 확인하는 중이라 이어 가지 못했습니다. 잠시 뒤 다시 시도해 주세요.';
  if (!error?.status) return 'EG-Desk에 연결하지 못해 이어 가지 못했습니다. 연결을 확인한 뒤 다시 시도해 주세요.';
  return '이어 가지 못했습니다. 잠시 뒤 다시 시도해 주세요.';
}

/**
 * Everything the list draws: the hold notice, the summary, then each started
 * graph's tasks in order with their conditions. A step title names a task when a
 * plan gave one; otherwise '작업 N' in graph order.
 * continuing = { graphId, taskId, gateId, responseKey?, phase, error } ('계속');
 * For questions, capture responseKey with the transient draft/notice so an
 * older question's phase or error cannot appear on a changed descriptor.
 * approving = { graphId, taskId, decision, phase, error } (승인/거절);
 * resuming = { phase, error } ('이어서 진행').
 */
export function taskBoardView(board, { folderName = null, continuing = null, approving = null, resuming = null, now = Date.now() } = {}) {
  const summary = taskBoardSummary(board);
  if (!summary.visible) return { visible: false, summary: '', counts: summary, held: null, groups: [] };
  const heldCount = taskBoardHeldEntries(board).length;
  const held = heldCount ? { count: heldCount, text: '브리지가 다시 시작돼 작업이 멈춰 있습니다',
    phase: resuming?.phase || null, error: resuming?.phase === 'error' ? resuming.error || null : null } : null;
  const entries = taskBoardShown(board).filter(entry => entry.graph.tasks.length);
  const groups = [...entries].sort((a, b) => b.order - a.order).map(entry => {
    const graph = entry.graph;
    const taskNames = Object.fromEntries(graph.tasks.map((task, index) => [task.taskId, entry.titles?.[task.taskId] || `작업 ${index + 1}`]));
    const tasks = graph.tasks.map(task => ({
      taskId: task.taskId, name: taskNames[task.taskId], status: task.status, statusText: taskStatusText(task.status),
      conditions: task.gates.map(gate => {
        const condition = taskGateView(gate, { taskNames, folderName, now });
        const here = continuing && continuing.graphId === entry.graphId && continuing.taskId === task.taskId && continuing.gateId === gate.gateId
          && (continuing.responseKey === undefined || continuing.responseKey === condition.responseKey);
        const deciding = gate.kind === 'approval' && approving && approving.graphId === entry.graphId && approving.taskId === task.taskId ? approving : null;
        return { ...condition, continuable: !condition.responseInvalid && taskGateContinuable(graph, task, gate),
          phase: here ? continuing.phase : null,
          approvable: gate.kind === 'approval' && !!taskApprovalId(entry, task.taskId),
          approvalPhase: deciding ? deciding.phase : null, approvalDecision: deciding ? deciding.decision : null,
          error: here && continuing.phase === 'error' ? continuing.error || null : deciding?.phase === 'error' ? deciding.error || null : condition.responseError || null };
      }),
    }));
    const title = entry.planTitle || (entries.length > 1 ? `작업 묶음 ${entries.indexOf(entry) + 1}` : null);
    return { graphId: entry.graphId, title, tasks };
  });
  return { visible: true, summary: summary.text, counts: summary, held, groups };
}

// CHAT-06 Await: plans an Agent proposed (helper contract: chat.event
// 'plan.proposed' on the proposing run, details { planId, graphId, boardId, title,
// status, callId, tasks: [{ taskId, title, resumeIn, dependsOn, gates: [{ gateId,
// kind }] }] }; SSE codex { type: 'task.plan', planId, change, plan } and GET
// /tasks/plans -> { plans } with plan = { planId, title, status, boardId, scope,
// graphId, origin: { conversationId, clientThreadId }, tasks: [{ taskId, title,
// resumeIn, status, dependsOn, gates }] }; GET /tasks/plans?planId= adds each
// step's instructions (this account's plans only); POST
// /tasks/plans/:planId/approve|reject with an empty body -> { plan, graph, native,
// board }). Nothing runs before 대표님 approves, and the screen never approves by
// itself: approving takes one confirm. The card sits under the Agent answer that
// proposed it. Plan, step, graph and gate IDs never reach the screen text.
export const PLAN_PROPOSAL_LIMIT = 24;
const PLAN_REF = /^plan-[A-Za-z0-9-]{1,80}$/;
const PLAN_STATUSES = ['proposed', 'approved', 'rejected', 'cancelled', 'completed'];
const PLAN_STATUS_TEXT = [['proposed', '승인 대기'], ['approved', '승인됨'], ['rejected', '거절됨'], ['cancelled', '취소됨'],
  ['completed', '완료'], ['missing', '찾을 수 없음']];
const PLAN_STATUS_NOTE = [['approved', '단계가 조건대로 저절로 진행됩니다. 진행 상황은 작업 목록에서 볼 수 있습니다.'],
  ['rejected', '거절한 계획은 실행되지 않습니다.'], ['cancelled', '취소되어 더 진행하지 않습니다.'], ['completed', '모든 단계가 끝났습니다.'],
  ['missing', '이 계획을 더 이상 찾을 수 없습니다.']];
const PLAN_STEP_LIMIT = 12;
const PLAN_GATE_KEYS = ['gateId', 'kind', 'origin', 'pathPrefix', 'root', 'relativeGlob', 'label', 'timeoutMs', 'expiresAt'];
export const planRef = value => typeof value === 'string' && PLAN_REF.test(value);
// Step instructions keep their lines; other control characters go.
const planInstructions = value => typeof value === 'string'
  ? value.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f\u2028\u2029]/g, '').trim().slice(0, 4000) || null : null;
// A decided plan never goes back to waiting on a late frame.
const planStatusAfter = (previous, incoming) => !PLAN_STATUSES.includes(incoming) ? previous || 'proposed'
  : previous && previous !== 'proposed' && incoming === 'proposed' ? previous : incoming;

function planStepsShape(tasks) {
  if (!Array.isArray(tasks)) return null;
  const steps = [];
  for (const raw of tasks.slice(0, PLAN_STEP_LIMIT)) {
    if (!raw || typeof raw !== 'object' || !taskRef(raw.taskId) || steps.some(step => step.taskId === raw.taskId)) continue;
    steps.push({
      taskId: raw.taskId, title: taskLine(raw.title, 200), resumeIn: raw.resumeIn === 'newThread' ? 'newThread' : 'sameThread',
      dependsOn: (Array.isArray(raw.dependsOn) ? raw.dependsOn : []).filter(taskRef).slice(0, PLAN_STEP_LIMIT),
      // An upstream step is named through dependsOn; only outside waits are listed.
      gates: (Array.isArray(raw.gates) ? raw.gates : []).slice(0, 16)
        .filter(gate => gate && typeof gate === 'object' && typeof gate.gateId === 'string' && typeof gate.kind === 'string' && gate.kind !== 'task')
        .map(gate => Object.fromEntries(PLAN_GATE_KEYS.filter(key => gate[key] !== undefined).map(key => [key, gate[key]]))),
    });
  }
  return steps;
}

export const createPlanProposals = () => ({ plans: [], seen: 0 });
export const planProposalEntry = (store, planId) => (store?.plans || []).find(entry => entry.planId === planId) || null;

function upsertPlanEntry(store, planId, change) {
  const current = store && Array.isArray(store.plans) ? store : createPlanProposals();
  const existing = planProposalEntry(current, planId);
  const seen = (current.seen || 0) + (existing ? 0 : 1);
  const entry = { ...(existing || { planId, graphId: null, boardId: null, scope: null, title: '', status: 'proposed',
    conversationId: null, clientThreadId: null, runId: null, steps: [], instructions: null, detail: 'idle',
    openSteps: [], decision: null, order: seen }), ...change(existing) };
  let plans = existing ? current.plans.map(row => row.planId === planId ? entry : row) : [...current.plans, entry];
  while (plans.length > PLAN_PROPOSAL_LIMIT) {
    const drop = plans.find(row => row.planId !== planId && row.status !== 'proposed') || plans.find(row => row.planId !== planId);
    plans = plans.filter(row => row !== drop);
  }
  return { plans, seen };
}
const patchPlanEntry = (store, planId, change) => planProposalEntry(store, planId)
  ? upsertPlanEntry(store, planId, change) : store || createPlanProposals();

/** chat.event 'plan.proposed' on the run that proposed it: where the card goes. */
export function planProposalsWithEvent(store, run, details) {
  const steps = planStepsShape(details?.tasks);
  if (!planRef(details?.planId) || !steps || !nonEmptyId(run?.conversationId) || !nonEmptyId(run?.runId)) return store || createPlanProposals();
  return upsertPlanEntry(store, details.planId, existing => ({
    graphId: taskRef(details.graphId) ? details.graphId : existing?.graphId ?? null,
    boardId: taskRef(details.boardId) ? details.boardId : existing?.boardId ?? null,
    title: taskLine(details.title, 200) || existing?.title || '',
    status: planStatusAfter(existing?.status, details.status ?? 'proposed'),
    conversationId: run.conversationId, clientThreadId: nonEmptyId(run.clientThreadId) || existing?.clientThreadId || null, runId: run.runId,
    // The event names only each wait's kind; a plan frame's fuller steps stay.
    steps: existing?.steps?.length ? existing.steps : steps,
  }));
}

/** A task.plan frame, a GET /tasks/plans row or detail, or a decision reply's plan. */
export function planProposalsWithPlan(store, plan) {
  const steps = planStepsShape(plan?.tasks);
  if (!plan || typeof plan !== 'object' || !planRef(plan.planId) || !steps) return store || createPlanProposals();
  const scope = taskScopeShape(plan.scope);
  const detailed = plan.tasks.some(task => task && typeof task === 'object' && Object.hasOwn(task, 'instructions'));
  const instructions = detailed ? Object.fromEntries(plan.tasks.filter(task => taskRef(task?.taskId)).slice(0, PLAN_STEP_LIMIT)
    .map(task => [task.taskId, planInstructions(task.instructions)])) : null;
  return upsertPlanEntry(store, plan.planId, existing => ({
    graphId: taskRef(plan.graphId) ? plan.graphId : scope?.graphId ?? existing?.graphId ?? null,
    boardId: taskRef(plan.boardId) ? plan.boardId : existing?.boardId ?? null,
    scope: scope || existing?.scope || null,
    title: taskLine(plan.title, 200) || existing?.title || '',
    status: planStatusAfter(existing?.status, plan.status),
    conversationId: nonEmptyId(plan.origin?.conversationId) || existing?.conversationId || null,
    clientThreadId: nonEmptyId(plan.origin?.clientThreadId) || existing?.clientThreadId || null,
    // The proposing run: from the event, else the plan's own scope.
    runId: existing?.runId || scope?.runId || null,
    steps,
    ...(instructions ? { instructions, detail: 'loaded' } : {}),
  }));
}

/** 'loading' | 'error' while the step instructions are read. */
export const planProposalsWithDetail = (store, planId, detail) => patchPlanEntry(store, planId, () => ({ detail }));
/** Opens or folds one step's instructions. */
export const planProposalsWithStep = (store, planId, taskId) => patchPlanEntry(store, planId, existing => ({
  openSteps: existing.openSteps.includes(taskId) ? existing.openSteps.filter(id => id !== taskId) : [...existing.openSteps, taskId] }));
/** decision = { action: 'approve'|'reject', phase: 'confirm'|'sending'|'error', error } or null. */
export const planProposalsWithDecision = (store, planId, decision) => patchPlanEntry(store, planId, () => ({
  decision: decision ? { action: decision.action, phase: decision.phase, error: decision.error || null } : null }));
/** The bridge no longer has this plan for this account. */
export const planProposalsWithMissing = (store, planId) => patchPlanEntry(store, planId, () => ({ status: 'missing' }));

/** Whether a plan's graph belongs in the task list: once approved, also after it finished or stopped. */
export const planOnTaskBoard = plan => !['proposed', 'rejected', 'missing'].includes(plan?.status);

/** The plans a conversation proposed, first proposed first. */
export function planProposalsForThread(store, thread) {
  if (!thread) return [];
  const binding = clientThreadBinding(thread);
  return (store?.plans || []).filter(entry => (thread.conversationId && entry.conversationId === thread.conversationId)
    || (binding && entry.clientThreadId === binding)).sort((a, b) => a.order - b.order);
}

/**
 * Where each card goes: after the last shown Agent answer of the run that
 * proposed it. A plan still waiting whose answer is not shown goes after the
 * conversation; a decided one with no answer to sit under is not shown.
 */
export function planProposalPlacement(entries, messages) {
  const byMessageId = new Map();
  const trailing = [];
  for (const entry of entries || []) {
    const anchor = entry.runId ? (messages || []).findLast(message => message.role === 'assistant' && message.runId === entry.runId
      && !(message.status === 'streaming' && !message.content)
      && (!entry.conversationId || !message.conversationId || message.conversationId === entry.conversationId)) : null;
    if (anchor) byMessageId.set(anchor.id, [...(byMessageId.get(anchor.id) || []), entry]);
    else if (entry.status === 'proposed') trailing.push(entry);
  }
  return { byMessageId, trailing };
}

function durationText(ms) {
  const minutes = Math.max(1, Math.round(ms / 60000));
  if (minutes < 60) return `${minutes}분`;
  const hours = Math.floor(minutes / 60), rest = minutes % 60;
  if (!rest && hours >= 24 && hours % 24 === 0) return `${hours / 24}일`;
  return rest ? `${hours}시간 ${rest}분` : `${hours}시간`;
}

/** One wait of a proposed step, in the task list's words, with how long it may wait. */
function planWaitText(gate, { folderName, now }) {
  const shown = taskGateView({ ...gate, status: 'waiting' }, { folderName, now });
  const limit = Number.isSafeInteger(gate.timeoutMs) && gate.timeoutMs > 0 ? `최대 ${durationText(gate.timeoutMs)}` : null;
  return [shown.text, shown.time, limit].filter(Boolean).join(' · ');
}

/** Everything one approval card draws. */
export function planProposalView(entry, { folderName = null, now = Date.now() } = {}) {
  if (!entry) return null;
  const titles = new Map(entry.steps.map((step, index) => [step.taskId, step.title || `${index + 1}단계`]));
  const numbers = new Map(entry.steps.map((step, index) => [step.taskId, index + 1]));
  const steps = entry.steps.map((step, index) => {
    const open = entry.openSteps.includes(step.taskId);
    const after = step.dependsOn.filter(id => titles.has(id) && id !== step.taskId).map(id => `${numbers.get(id)}. ${titles.get(id)}`);
    const text = entry.instructions ? entry.instructions[step.taskId] ?? null : null;
    const instructions = !open ? null
      : entry.instructions ? (text ? { state: 'loaded', text } : { state: 'empty', text: '이 단계의 지침을 볼 수 없습니다.' })
        : entry.detail === 'error' ? { state: 'error', text: '지침을 불러오지 못했습니다.' }
          : { state: 'loading', text: '지침을 불러오는 중…' };
    return {
      taskId: step.taskId, number: index + 1, title: step.title || `${index + 1}단계`,
      after: after.length ? `먼저 끝낼 단계 · ${after.join(', ')}` : null,
      waits: step.gates.map(gate => planWaitText(gate, { folderName, now })),
      where: step.resumeIn === 'newThread' ? '새 대화에서 진행' : null,
      open, instructions,
    };
  });
  const decision = entry.decision ? { action: entry.decision.action, phase: entry.decision.phase, error: entry.decision.error || null } : null;
  return {
    planId: entry.planId, title: entry.title || '제목 없는 계획', status: entry.status,
    statusText: lookup(PLAN_STATUS_TEXT, entry.status) || '상태 확인 중',
    note: lookup(PLAN_STATUS_NOTE, entry.status),
    decidable: entry.status === 'proposed', sending: decision?.phase === 'sending', decision,
    steps: entry.status === 'proposed' ? steps : [],
    stepCount: steps.length,
    showTaskList: ['approved', 'completed', 'cancelled'].includes(entry.status),
  };
}

/**
 * POST /tasks/plans/:planId/approve|reject with an empty body, or null: only a
 * plan still waiting, only one decision at a time, and approving only after its
 * confirm ('승인하면 단계가 조건대로 저절로 진행됩니다').
 */
export function buildPlanDecisionRequest(entry, action) {
  if (!['approve', 'reject'].includes(action) || !planRef(entry?.planId) || entry.status !== 'proposed') return null;
  if (entry.decision?.phase === 'sending') return null;
  if (action === 'approve' && !(entry.decision?.action === 'approve' && entry.decision.phase === 'confirm')) return null;
  return { path: `/tasks/plans/${entry.planId}/${action}`, body: {} };
}

/** Korean text for a refused plan decision; the bridge message stays internal. */
export function planDecisionErrorText(error, action) {
  const verb = action === 'approve' ? '승인' : '거절';
  const code = error?.code;
  if (code === 'PLAN_NOT_FOUND') return '이 계획을 찾을 수 없습니다. 이미 정리되었거나 다른 계정의 계획입니다.';
  if (code === 'PLAN_STALE') return action === 'approve' ? '이미 거절된 계획이라 승인할 수 없습니다.' : '이미 승인된 계획이라 거절할 수 없습니다.';
  if (code === 'TASK_FENCED') return action === 'approve' ? '취소된 계획이라 승인할 수 없습니다.' : '이미 취소된 계획입니다.';
  if (code === 'TASK_ROUTE_NOT_FOUND') return '지금 연결된 EG-Desk는 계획 승인을 지원하지 않습니다.';
  if (code === 'LOGIN_REQUIRED' || code === 'TASK_AUTHORITY') return `로그인한 뒤 ${verb}할 수 있습니다.`;
  if (code === 'BRIDGE_OFFLINE') return `AI 엔진이 아직 준비되지 않아 ${verb}하지 못했습니다. 잠시 뒤 다시 시도해 주세요.`;
  if (error?.status === 409) return `계획 상태가 바뀌어 ${verb}하지 못했습니다. 다시 확인한 뒤 시도해 주세요.`;
  if (!error?.status) return `EG-Desk에 연결하지 못해 ${verb}하지 못했습니다. 연결을 확인한 뒤 다시 시도해 주세요.`;
  return `${verb}하지 못했습니다. 잠시 뒤 다시 시도해 주세요.`;
}

// CHAT-06 Await: an approved same-thread step comes back into its conversation
// as a user turn that starts with <egdesk-await-resume> (helper
// egdesk-await-resume.mjs). It reads as one system line, never as 대표님's
// bubble and never as raw XML; only the step title and what was met are kept.
const AWAIT_RESUME_TAG = '<egdesk-await-resume>';
const AWAIT_CONDITION_TEXT = [['task', ['앞 단계 완료']], ['approval', ['계획 승인됨']], ['oauth', ['로그인 완료', '로그인 대기 건너뜀']],
  ['file', ['파일 도착', '파일 대기 건너뜀']], ['terminalExit', ['터미널 종료', '터미널 대기 건너뜀']], ['userAction', ['확인됨']]];
const xmlText = value => String(value).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');

/** The system line for a plan step resumed in place, or null for any other message. */
export function awaitResumeMessageView(message) {
  if (message?.role !== 'user') return null;
  const raw = typeof message.content === 'string' && message.content ? message.content : typeof message.text === 'string' ? message.text : '';
  if (!raw.trimStart().startsWith(AWAIT_RESUME_TAG)) return null;
  // Words 대표님 typed on this screen stay a bubble, whatever they start with.
  if ([message.requestId, message.clientId].some(id => typeof id === 'string' && id.startsWith('request-'))) return null;
  const pick = pattern => { const match = pattern.exec(raw); return match ? taskLine(xmlText(match[1]), 120) : ''; };
  const step = pick(/<next_task\b[^>]{0,400}>\s*<title>([\s\S]{0,1200}?)<\/title>/);
  const plan = pick(/<plan\b[^>]{0,400}>([\s\S]{0,1200}?)<\/plan>/);
  const met = [];
  for (const match of raw.matchAll(/<condition\b([^>]{0,400})>/g)) {
    const words = lookup(AWAIT_CONDITION_TEXT, /\bkind="([A-Za-z]+)"/.exec(match[1])?.[1]);
    const word = words ? (/\bby="user\.action"/.test(match[1]) && words[1]) || words[0] : '조건 충족';
    if (!met.includes(word)) met.push(word);
    if (met.length > 8) break;
  }
  const shown = met.length > 3 ? [...met.slice(0, 3), `외 ${met.length - 3}건`] : met;
  const summary = [step || plan, ...shown].filter(Boolean).join(' · ');
  const text = '대기 조건이 풀려 작업을 이어갑니다';
  return { text, summary, line: summary ? `${text} · ${summary}` : text };
}

// BRW-13: 대표님 took a Browser Card back while an Agent held it. A room whose
// run held that Card gets one quiet system line per hold; nothing is sent.
export const BROWSER_USER_CONTROL_LINE = '사용자가 Browser를 직접 조작 중입니다';
export function addBrowserUserControlNotice(list, { clientThreadId, host = '', at = Date.now() } = {}, limit = 40) {
  const previous = Array.isArray(list) ? list : [];
  if (typeof clientThreadId !== 'string' || !clientThreadId || clientThreadId.length > 160) return previous;
  const seq = (previous.at(-1)?.seq || 0) + 1;
  return [...previous, { id: `browser-user-control-${seq}`, seq, clientThreadId,
    host: typeof host === 'string' ? host.slice(0, 253) : '', at: Number.isFinite(at) ? at : Date.now() }].slice(-limit);
}
/** This room's lines, oldest first. */
export function browserUserControlNoticesFor(list, clientThreadId) {
  if (!Array.isArray(list) || typeof clientThreadId !== 'string' || !clientThreadId) return [];
  return list.filter(notice => notice?.clientThreadId === clientThreadId && Number.isFinite(notice.at))
    .sort((left, right) => left.at - right.at);
}
export function browserUserControlNoticeView(notice) {
  const refused = 'Agent의 조작 요청은 거절됩니다';
  return { line: BROWSER_USER_CONTROL_LINE, detail: notice?.host ? `${notice.host} · ${refused}` : refused };
}

// CHAT-04/08 result cards. Chat ends in conversation: a long result body is not
// pasted into Chat but reached through a chip to its Canvas result. An Agent
// answer becomes a result card only when 대표님 presses '카드로 보기' (or
// '카드로 펼치기' on a long answer); nothing moves to the Canvas by itself. The
// card is a Board memo holding a copy of that answer (no file is written; files
// the answer pointed to open through the existing flow) and where it came from,
// so it leads back to the answer in Chat. A long answer keeps its whole text in
// the message; Chat only draws a folded preview of it.
// The copy is saved with the Desk and Boards, so a very long answer keeps its
// opening here and the rest stays in Chat (the card says so and links back).
export const RESULT_CARD_TEXT_LIMIT = 20000;
export const RESULT_CARD_ARTIFACT_LIMIT = 24;
const resultRef = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value) ? value : null;
const resultLine = (value, max) => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '';
const groupDigits = value => String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

// CHAT-08: Agent-published Canvas results. The bridge keeps the markdown
// (egdesk_publish_output, at most 20,000 characters) and sends metadata only;
// Chat shows one chip per outputKey and, per D-K4, a revision of the same
// result is the next version of that chip, never a second one. Nothing opens
// by itself. Mirrors helper/egdesk-context-runtime.mjs OUTPUT_KEY_PATTERN.
export const OUTPUT_KEY_PATTERN = /^[a-z0-9-]{1,64}$/;
const OUTPUT_ID_PATTERN = /^[\da-f-]{36}$/i;
const outputId = value => typeof value === 'string' && OUTPUT_ID_PATTERN.test(value) ? value : null;

/** One published result's metadata, checked (an event payload, a stored record or a chip entry), or null. */
export function publishedOutputRecord(value) {
  if (!value || typeof value !== 'object' || !outputId(value.id)) return null;
  if (typeof value.outputKey !== 'string' || !OUTPUT_KEY_PATTERN.test(value.outputKey)) return null;
  if (!Number.isSafeInteger(value.version) || value.version < 1) return null;
  const title = resultLine(value.title, 120);
  if (!title) return null;
  return {
    id: value.id, outputKey: value.outputKey, version: value.version, title,
    charCount: Number.isSafeInteger(value.charCount) && value.charCount >= 0 ? value.charCount : null,
    createdAt: Number.isFinite(value.createdAt) ? value.createdAt : null,
    previousId: outputId(value.previousId),
    conversationId: resultRef(value.conversationId), runId: resultRef(value.runId), answerId: resultRef(value.answerId),
  };
}

/** run.outputs with one more published result folded in: one entry per outputKey, showing its latest version and keeping the versions behind it. */
export function upsertPublishedOutput(list, value) {
  const entries = (Array.isArray(list) ? list : []).map(copy);
  const output = publishedOutputRecord(value);
  if (!output) return entries;
  const index = entries.findIndex(entry => entry.outputKey === output.outputKey);
  const current = index >= 0 ? entries[index] : null;
  const versions = [...(current?.versions || []).filter(item => item.id !== output.id),
    { id: output.id, version: output.version, title: output.title, charCount: output.charCount, createdAt: output.createdAt }]
    .sort((a, b) => a.version - b.version || (a.createdAt || 0) - (b.createdAt || 0));
  const latest = versions.at(-1);
  const { versions: _known, ...head } = latest.id === output.id || !current ? output : current;
  const entry = { ...head, versions };
  if (index >= 0) entries[index] = entry; else entries.push(entry);
  return entries;
}

/** Chip entries from a list of published results (every stored version, or entries saved earlier). */
export function publishedOutputs(list) {
  let entries = [];
  for (const item of Array.isArray(list) ? list : []) {
    if (Array.isArray(item?.versions) && item.versions.length) for (const version of item.versions) entries = upsertPublishedOutput(entries, { ...item, ...version });
    else entries = upsertPublishedOutput(entries, item);
  }
  return entries;
}

/** Whether this answer can be kept as a result card now (a finished Agent answer with something in it). */
export function canKeepResultCard(thread, message) {
  if (!thread?.id || nativeBindingHeld(thread) || message?.role !== 'assistant') return false;
  if (message.status === 'streaming' || ['error', 'failed'].includes(message.status)) return false;
  if (!resultRef(message.id) && !resultRef(message.answerId)) return false;
  return (typeof message.content === 'string' && message.content.trim() !== '') || (Array.isArray(message.artifacts) && message.artifacts.some(usableArtifact));
}

// The first readable line, without markdown marks or code; else '<author>의 답변'.
function resultCardTitle(text, author) {
  let fenced = false;
  for (const raw of String(text || '').split('\n')) {
    const trimmed = raw.trim();
    if (trimmed.startsWith('```')) { fenced = !fenced; continue; }
    if (fenced || !trimmed) continue;
    const line = trimmed.replace(/^#{1,6}\s+/, '').replace(/^>\s*/, '').replace(/^[-*+]\s+/, '').replace(/^\d+[.)]\s+/, '')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[*_`~]/g, '').trim();
    if (line) return line.length > 60 ? `${line.slice(0, 59)}…` : line;
  }
  return `${author || 'Codex'}의 답변`;
}

/** A stored card record, checked and capped (also for one read back from the Desk or a Board), or null. */
export function restoreResultCardRecord(value) {
  if (!value || typeof value !== 'object' || value.version !== 1) return null;
  const source = value.source && typeof value.source === 'object' ? value.source : {};
  const threadId = resultRef(source.threadId);
  const messageId = resultRef(source.messageId), answerId = resultRef(source.answerId);
  if (!threadId || (!messageId && !answerId)) return null;
  const text = typeof value.text === 'string' ? value.text.slice(0, RESULT_CARD_TEXT_LIMIT) : '';
  const artifacts = (Array.isArray(value.artifacts) ? value.artifacts : []).filter(usableArtifact).slice(0, RESULT_CARD_ARTIFACT_LIMIT).map(copy);
  if (!text.trim() && !artifacts.length) return null;
  const totalChars = Number.isSafeInteger(value.totalChars) && value.totalChars >= text.length ? value.totalChars : text.length;
  const author = resultLine(source.author, 40) || 'Codex';
  // CHAT-08: a card opened from a published-result chip remembers which result
  // and version it shows; all three travel together or not at all.
  const published = outputId(source.outputId) && typeof source.outputKey === 'string' && OUTPUT_KEY_PATTERN.test(source.outputKey)
    && Number.isSafeInteger(source.outputVersion) && source.outputVersion >= 1
    ? { outputId: source.outputId, outputKey: source.outputKey, outputVersion: source.outputVersion } : {};
  return {
    version: 1, title: resultLine(value.title, 80) || resultCardTitle(text, author),
    text, totalChars, truncated: totalChars > text.length, artifacts,
    source: {
      threadId, threadTitle: resultLine(source.threadTitle, 80), conversationId: resultRef(source.conversationId),
      runId: resultRef(source.runId), answerId, messageId, author,
      answeredAt: Number.isFinite(source.answeredAt) ? source.answeredAt : null,
      ...published,
    },
    createdAt: Number.isFinite(value.createdAt) ? value.createdAt : null,
  };
}

// D-K3 is still open (how a result card is saved). This card copies the body
// (at most RESULT_CARD_TEXT_LIMIT, the same cap as a published result) into
// the Desk/Board record, as the CHAT-04 card does, so a saved Board restores
// it without the bridge; the bridge's blob stays the version history. If
// D-K3 lands on 'reference only', drop `text` here and read on restore.
/** The card record for an Agent-published result the chip just read from the bridge, or null. */
export function publishedOutputCardRecord(thread, message, output, markdown, { author = 'Codex', now = Date.now() } = {}) {
  const published = publishedOutputRecord(output);
  if (!thread?.id || !published || typeof markdown !== 'string' || !markdown.trim()) return null;
  const name = resultLine(author, 40) || 'Codex';
  return restoreResultCardRecord({
    version: 1, title: published.title, text: markdown.slice(0, RESULT_CARD_TEXT_LIMIT), totalChars: markdown.length, artifacts: [],
    source: {
      threadId: thread.id, threadTitle: thread.title, conversationId: published.conversationId || message?.conversationId || thread.conversationId || null,
      runId: published.runId || message?.runId || null, answerId: published.answerId || message?.answerId || null,
      messageId: message?.id || null, author: name, answeredAt: published.createdAt ?? message?.createdAt ?? null,
      outputId: published.id, outputKey: published.outputKey, outputVersion: published.version,
    },
    createdAt: now,
  });
}

/** The card record for one answer, at the moment 대표님 asks for it, or null. */
export function resultCardRecord(thread, message, { author = 'Codex', now = Date.now() } = {}) {
  if (!canKeepResultCard(thread, message)) return null;
  const full = typeof message.content === 'string' ? message.content : '';
  const name = resultLine(author, 40) || 'Codex';
  return restoreResultCardRecord({
    version: 1, title: resultCardTitle(full, name), text: full.slice(0, RESULT_CARD_TEXT_LIMIT), totalChars: full.length,
    artifacts: (message.artifacts || []).filter(usableArtifact),
    source: {
      threadId: thread.id, threadTitle: thread.title, conversationId: message.conversationId || thread.conversationId || null,
      runId: message.runId || null, answerId: message.answerId || null, messageId: message.id || null, author: name,
      answeredAt: message.createdAt,
    },
    createdAt: now,
  });
}

/** One open card per answer: the same answer asked for again focuses its card. A published result is one card per outputKey, whatever its version. */
export function resultCardKey(record) {
  const source = record?.source;
  const room = source?.conversationId || source?.threadId;
  if (room && source?.outputKey) return `${room}/output/${source.outputKey}`;
  const answer = source?.answerId || source?.messageId;
  return room && answer ? `${room}/${answer}` : null;
}

/** The card's '출처' line and the note for a copy cut at the limit. */
export function resultCardSourceView(record, { formatTime = null } = {}) {
  const source = record?.source || {};
  const room = source.threadTitle || '이름 없는';
  const time = typeof formatTime === 'function' && Number.isFinite(source.answeredAt) ? formatTime(source.answeredAt) : '';
  const parts = [`${room} 대화`, `${source.author || 'Codex'}의 답변`,
    source.outputVersion ? `게시한 결과 · 버전 ${source.outputVersion}` : null, time].filter(Boolean);
  return {
    line: `출처 · ${parts.join(' · ')}`,
    truncatedNote: record?.truncated ? `답변이 길어 앞부분 ${groupDigits(record.text.length)}자만 담았습니다. 전체는 채팅에서 볼 수 있습니다.` : null,
  };
}

/** The room and the answer a card came from, for '채팅에서 보기'; the message is null when the room no longer has it. */
export function findResultCardMessage(threads, source) {
  if (!source || !Array.isArray(threads)) return null;
  const thread = threads.find(item => item?.id === source.threadId)
    || (source.conversationId ? threads.find(item => item?.conversationId === source.conversationId) : null);
  if (!thread) return null;
  const messages = Array.isArray(thread.messages) ? thread.messages : [];
  const message = (source.answerId && messages.find(item => item?.role === 'assistant' && item.answerId === source.answerId
      && (!source.runId || !item.runId || item.runId === source.runId)))
    || (source.messageId && messages.find(item => item?.id === source.messageId)) || null;
  return { thread, message };
}

// A finished answer this long reads as a folded preview in Chat.
export const LONG_ANSWER_LIMITS = Object.freeze({ chars: 4000, lines: 80, codeBlocks: 3, codeChars: 1600, previewChars: 1200, previewLines: 16 });
/** Whether an answer folds, and the preview Chat draws (a cut code block is closed so it still reads as code). */
export function longAnswerView(text, limits = LONG_ANSWER_LIMITS) {
  const value = typeof text === 'string' ? text : '';
  const lines = value.split('\n');
  const codeBlocks = (value.match(/```[\w+-]*\n?[\s\S]*?```/g) || []).length;
  const folded = { long: false, preview: value, totalChars: value.length, lineCount: lines.length, codeBlocks, summary: '' };
  if (!(value.length > limits.chars || lines.length > limits.lines || (codeBlocks >= limits.codeBlocks && value.length > limits.codeChars))) return folded;
  const kept = [];
  let used = 0;
  for (const line of lines) {
    if (kept.length >= limits.previewLines || used >= limits.previewChars) break;
    const room = limits.previewChars - used;
    if (line.length > room) {
      const cut = line.slice(0, room);
      const space = cut.lastIndexOf(' ');
      kept.push(`${space > room * 0.6 ? cut.slice(0, space) : cut}…`);
      break;
    }
    kept.push(line);
    used += line.length + 1;
  }
  let preview = kept.join('\n').replace(/\s+$/, '');
  if ((preview.match(/```/g) || []).length % 2) preview += '\n```';
  if (preview.length >= value.length) return folded;
  const summary = ['긴 답변이라 앞부분만 보여 드립니다', `전체 ${groupDigits(value.length)}자`, codeBlocks ? `코드 ${codeBlocks}개` : null].filter(Boolean).join(' · ');
  return { ...folded, long: true, preview, summary };
}
