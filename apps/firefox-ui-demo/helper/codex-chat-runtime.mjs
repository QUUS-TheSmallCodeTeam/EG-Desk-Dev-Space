import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'
import { chatError, explicitFileLinks, MAX_TEXT, publicError, publicNetworkContext, publicText, validateChatCwd, verifyLocalFile } from './codex-chat-values.mjs'
import { READ_ONLY_QA, requestedExecutionPolicy, listNativeMcpServers, qaThreadOverrides, verifyQaNativeThread, verifyQaMcpIsolation, QA_TURN_OVERRIDES } from './codex-chat-execution-policy.mjs'

const TERMINAL = new Set(['completed', 'interrupted', 'failed'])
const ITEM_STATUS = new Set(['inProgress', 'completed', 'failed', 'declined'])
const MAX_RUNS = 32
const MAX_ITEMS = 100
const MAX_THREADS = 32
const MAX_REQUESTS = 128
const MAX_PUBLIC_EVENT_TEXT = 8 * 1024 * 1024
const idText = value => typeof value === 'string' && value.length <= 300 ? value : null
const runKey = (threadId, turnId) => `${threadId}/${turnId}`
const copy = value => JSON.parse(JSON.stringify(value))
const localId = (kind, clientThreadId, requestId) => `${kind}-${createHash('sha256').update(`${clientThreadId}\0${requestId}\0${kind}`).digest('hex').slice(0, 32)}`
const ownerHash = ownerKey => typeof ownerKey === 'string' && ownerKey
  ? createHash('sha256').update(ownerKey).digest('hex') : null
const unknownCoverage = () => ({ scope: 'egdesk-local', status: 'unknown', reasons: [], nativeHistoryComplete: null })
const toolKey = (namespace, name) => `${namespace || ''}\0${name}`

// Shared by live events and history. In particular, reasoning.content, raw tool
// input/results, diffs and shell output never enter the retained state or SSE.
function safeItem(item) {
  if (!item || !idText(item.id)) return null
  const base = { id: item.id, type: item.type }
  switch (item.type) {
    case 'agentMessage': return { ...base, text: typeof item.text === 'string' ? item.text.slice(0, MAX_PUBLIC_EVENT_TEXT) : '', phase: ['commentary', 'final_answer'].includes(item.phase) ? item.phase : null, truncated: typeof item.text === 'string' && item.text.length > MAX_PUBLIC_EVENT_TEXT }
    case 'userMessage': {
      const text = (Array.isArray(item.content) ? item.content : []).filter(part => part.type === 'text').map(part => part.text || '').join('\n')
      return { ...base, clientId: idText(item.clientId), text: publicText(text), truncated: text.length > MAX_TEXT }
    }
    case 'reasoning': return { ...base, summary: Array.isArray(item.summary) ? item.summary.slice(0, 20).map(text => publicText(text, 4000)) : [] }
    case 'plan': return { ...base, text: publicText(item.text) }
    case 'commandExecution': return {
      ...base, status: ITEM_STATUS.has(item.status) ? item.status : 'inProgress',
      command: publicText(item.command, 2000), cwd: publicText(item.cwd, 2000),
      exitCode: Number.isInteger(item.exitCode) ? item.exitCode : null,
      durationMs: Number.isFinite(item.durationMs) ? item.durationMs : null,
    }
    case 'fileChange': return {
      ...base, status: ITEM_STATUS.has(item.status) ? item.status : 'inProgress',
      changes: Array.isArray(item.changes) ? item.changes.slice(0, 30).map(change => ({
        path: typeof change.path === 'string' ? change.path.slice(0, 4096) : '',
        kind: ['add', 'update', 'delete'].includes(change.kind?.type) ? change.kind.type : 'update',
      })) : [],
    }
    case 'mcpToolCall': return {
      ...base, status: ITEM_STATUS.has(item.status) ? item.status : 'inProgress',
      server: publicText(item.server, 120), tool: publicText(item.tool, 120),
      durationMs: Number.isFinite(item.durationMs) ? item.durationMs : null,
    }
    case 'dynamicToolCall': return { ...base, status: ITEM_STATUS.has(item.status) ? item.status : 'inProgress', tool: publicText(item.tool, 120) }
    default: return null
  }
}

function safeTurn(turn) {
  return {
    id: idText(turn?.id),
    status: TERMINAL.has(turn?.status) || turn?.status === 'inProgress' ? turn.status : 'unknown',
    items: Array.isArray(turn?.items) ? turn.items.slice(-MAX_ITEMS).map(safeItem).filter(Boolean) : [],
    error: turn?.error ? publicError(turn.error, 'TURN_FAILED', 'codex') : null,
    itemsView: ['notLoaded', 'summary', 'full'].includes(turn?.itemsView) ? turn.itemsView : 'full',
    // Native completion notifications can intentionally omit their item array;
    // those same items have already arrived in item events. This is not loss.
    truncated: (turn?.items?.length || 0) > MAX_ITEMS,
  }
}

function cleanNotification(method, p) {
  if (!p || !idText(p.threadId)) return null
  const base = { method, threadId: p.threadId, turnId: idText(p.turnId) }
  if (method === 'turn/started' || method === 'turn/completed') return { ...base, turnId: idText(p.turn?.id), turn: safeTurn(p.turn) }
  if (method === 'item/started' || method === 'item/completed') {
    const item = safeItem(p.item)
    return item ? { ...base, item } : null
  }
  if (method === 'item/agentMessage/delta' || method === 'item/reasoning/summaryTextDelta' || method === 'item/plan/delta') {
    return idText(p.itemId) ? { ...base, itemId: p.itemId, delta: typeof p.delta === 'string' ? p.delta.slice(0, MAX_TEXT) : '' } : null
  }
  if (method === 'turn/plan/updated') return {
    ...base, explanation: publicText(p.explanation, 2000),
    plan: Array.isArray(p.plan) ? p.plan.slice(0, 40).map(step => ({ step: publicText(step.step, 1000), status: ['pending', 'inProgress', 'completed'].includes(step.status) ? step.status : 'pending' })) : [],
  }
  if (method === 'error') return { ...base, error: publicError(p.error, 'TURN_ERROR', 'codex'), willRetry: p.willRetry === true }
  if (method === 'thread/tokenUsage/updated') return { ...base, usage: { modelContextWindow: Number.isFinite(p.tokenUsage?.modelContextWindow) ? p.tokenUsage.modelContextWindow : null, usedTokens: Number.isFinite(p.tokenUsage?.last?.totalTokens) ? p.tokenUsage.last.totalTokens : null } }
  if (method === 'serverRequest/resolved') return { ...base, requestId: p.requestId }
  return null
}

export class CodexChatRuntime {
  constructor({ request, respond, emit = () => {}, emitLegacy = () => {}, verifyFile = verifyLocalFile, now = Date.now, contexts = null, toolProviders = [], expectedProcessConfiguration = null, store = null, requireStore = false, getOwnerKey = () => null, qaReady = () => true }) {
    Object.assign(this, { request, respond, emitEvent: emit, emitLegacy, verifyFile, now })
    this.store = store
    this.requireStore = requireStore
    this.getOwnerKey = getOwnerKey
    this.qaReady = qaReady
    this.storeHealthy = true
    this.expectedProcessConfiguration = expectedProcessConfiguration
    this.contexts = contexts
    this.toolProviders = [...(contexts ? [contexts] : []), ...toolProviders]
    for (const provider of this.toolProviders) provider.runtime = this
    this.threadToolOwners = new Map()
    this.streamId = randomUUID()
    this.seq = 0
    this.connection = 'offline'
    this.epoch = 0
    this.threads = new Map()
    this.loadedThreads = new Set()
    this.runs = new Map()
    this.rawMessages = new Map()
    this.visibleMessages = new Map()
    this.pendingStarts = new Map()
    this.pendingResumes = new Map()
    this.pendingApprovals = new Map()
    this.requests = new Map()
    this.persistedRunStates = new Map()
    this.locks = new Set()
    this.uncertainThreads = new Set()
    this.incompleteHistory = new Set()
    this.truncated = false
    this.queue = Promise.resolve()
  }

  assertReady() {
    if (this.connection !== 'ready') throw chatError('BRIDGE_OFFLINE', 'Codex app-server is offline', 503)
  }

  assertStore() {
    if (!this.store || !this.storeHealthy) throw chatError('CHAT_STORE_UNAVAILABLE', 'Local chat history is unavailable; no Codex turn can start', 503)
    return this.store
  }

  collectToolSpecs(qa = false) {
    const specs = [], owners = new Map(), selected = []
    for (const provider of this.toolProviders) {
      if (qa && provider !== this.contexts) continue
      const offered = provider.specs?.() || []
      if (!Array.isArray(offered)) throw chatError('INVALID_TOOL_PROVIDER', 'Tool provider returned an invalid native catalog', 500)
      for (const spec of offered) {
        // The QA policy exposes only two read-only EG-Desk context tools.
        if (qa && (provider !== this.contexts || !['egdesk_list_context', 'egdesk_read_source'].includes(spec?.name))) continue
        const names = spec?.type === 'function' && typeof spec.name === 'string' ? [toolKey(null, spec.name)]
          : spec?.type === 'namespace' && typeof spec.name === 'string' && Array.isArray(spec.tools)
            ? spec.tools.map(tool => tool?.type === 'function' && typeof tool.name === 'string' ? toolKey(spec.name, tool.name) : null)
            : null
        if (!names?.length || names.some(name => !name || owners.has(name))) throw chatError('INVALID_TOOL_PROVIDER', 'Tool provider has an invalid or conflicting native tool name', 500)
        for (const name of names) owners.set(name, provider)
        specs.push(spec)
        if (!selected.includes(provider)) selected.push(provider)
      }
    }
    return { specs, owners, selected }
  }

  additionalToolContext(preparedProviders) {
    const context = {}
    for (const [provider, prepared] of preparedProviders) {
      if (!prepared) continue
      const entries = provider.additionalContext?.(prepared)
      if (entries == null) continue
      if (typeof entries !== 'object' || Array.isArray(entries)) throw chatError('INVALID_TOOL_PROVIDER', 'Tool provider returned invalid native context', 500)
      for (const [key, value] of Object.entries(entries)) {
        if (Object.hasOwn(context, key)) throw chatError('INVALID_TOOL_PROVIDER', 'Tool providers returned conflicting native context keys', 500)
        context[key] = value
      }
    }
    return Object.keys(context).length ? context : null
  }

  dispatchToolProvider(provider, run, event) {
    // ContextRuntime replies through runtime.respond itself. Other providers
    // may instead return a native DynamicToolCallResponse. Neither path may
    // block the ordered native notification queue.
    void Promise.resolve().then(() => provider.dispatch(run, event)).then(response => {
      if (response == null) return
      const valid = typeof response.success === 'boolean' && Array.isArray(response.contentItems) && response.contentItems.length <= 16 &&
        response.contentItems.every(item => item && typeof item === 'object' && (
          (item.type === 'inputText' && typeof item.text === 'string') ||
          (item.type === 'inputImage' && typeof item.imageUrl === 'string') ||
          (item.type === 'inputAudio' && typeof item.audioUrl === 'string')
        )) && JSON.stringify(response).length <= 8 * 1024 * 1024
      if (!valid) throw chatError('INVALID_TOOL_RESPONSE', 'Tool provider returned an invalid native response', 500)
      this.respond(event.rpcId, response)
    }).catch(error => {
      const message = publicText(error?.message || 'Tool provider failed', 1000)
      try { this.respond(event.rpcId, { success: false, contentItems: [{ type: 'inputText', text: JSON.stringify({ error: { code: 'TOOL_PROVIDER_FAILED', message } }) }] }) } catch {}
      run.error = publicError(message, 'TOOL_PROVIDER_FAILED')
      this.emit(run, 'run.unavailable', { status: run.status, error: run.error })
    })
  }

  recoverInterruptedRuns() {
    const store = this.assertStore()
    try {
      const pending = []
      let cursor = null
      do {
        const page = store.listConversations({ cursor, limit: 100 })
        for (const thread of page.threads) {
          let afterSeq = 0
          do {
            const runs = store.listRuns(thread.clientThreadId, { afterSeq, limit: 100 })
            for (const run of runs.runs) if (!TERMINAL.has(run.status) && !['unknown', 'cancelled', 'unavailable'].includes(run.status)) {
              pending.push({ clientThreadId: thread.clientThreadId, run })
            }
            if (!runs.hasMore) break
            if (!Number.isSafeInteger(runs.nextCursor) || runs.nextCursor <= afterSeq) throw chatError('CHAT_STORE_CORRUPT', 'Local run cursor did not advance', 500)
            afterSeq = runs.nextCursor
          } while (true)
        }
        if (!page.hasMore) break
        if (!page.nextCursor || page.nextCursor === cursor) throw chatError('CHAT_STORE_CORRUPT', 'Local thread cursor did not advance', 500)
        cursor = page.nextCursor
      } while (true)
      for (const { clientThreadId, run } of pending) {
        const checkpoint = {
          ...run, status: 'unknown', historyComplete: false, pendingApprovals: [],
          error: publicError('Bridge restarted before this run was confirmed complete', 'RUNTIME_RESTARTED'),
          messages: (run.messages || []).map(message => message.status === 'streaming' ? { ...message, status: 'partial' } : message),
        }
        store.appendEvent({
          clientThreadId, eventKey: `restart:${this.streamId}:${run.localRunId}`, ts: this.now(),
          event: 'run.recovery_unknown', details: { status: 'unknown', error: checkpoint.error },
          localRunId: run.localRunId, ...(run.requestId ? { requestId: run.requestId } : {}),
          ...(run.runId ? { runId: run.runId } : {}), runCheckpoint: checkpoint,
        })
        if (run.requestId && store.getRequest({ clientThreadId, requestId: run.requestId })) store.recordRequestOutcome({
          clientThreadId, requestId: run.requestId, ts: this.now(),
          outcome: { accepted: true, dispatchStatus: 'unknown', runStatus: 'unknown', conversationId: run.conversationId || null, runId: run.runId || null, localRunId: run.localRunId, ...(run.accountIdentity ? { accountIdentity: run.accountIdentity } : {}) },
        })
      }
      return pending.length
    } catch (error) {
      this.storeHealthy = false
      throw error
    }
  }

  listLocalThreads({ cursor = null, limit = 50 } = {}) {
    const page = this.assertStore().listConversations({ cursor, limit })
    return { protocolVersion: 1, ...page }
  }

  getLocalHistory({ clientThreadId, afterSeq = 0, limit = 100 }) {
    const store = this.assertStore()
    const thread = store.getConversation(clientThreadId)
    if (!thread) throw chatError('CONVERSATION_NOT_FOUND', 'Local conversation does not exist', 404)
    const eventsPage = store.listEvents(clientThreadId, { afterSeq, limit })
    const collectLatest = (method, maximum) => {
      const latest = []
      let cursor = 0, truncated = false
      do {
        const page = store[method](clientThreadId, { afterSeq: cursor, limit: 100 })
        latest.push(...page[method === 'listRuns' ? 'runs' : 'messages'])
        if (latest.length > maximum) { latest.splice(0, latest.length - maximum); truncated = true }
        if (!page.hasMore) break
        if (!Number.isSafeInteger(page.nextCursor) || page.nextCursor <= cursor) throw chatError('CHAT_STORE_CORRUPT', 'Local projection cursor did not advance', 500)
        cursor = page.nextCursor
      } while (true)
      return { latest, truncated }
    }
    const runs = collectLatest('listRuns', 32)
    const messages = collectLatest('listMessages', 100)
    const coverage = copy(thread.coverage || unknownCoverage())
    const textOrHistoryTruncated = runs.latest.some(run => run.truncated || run.historyComplete === false)
      || messages.latest.some(message => message.projectionTruncated === true)
    if (runs.truncated || messages.truncated || textOrHistoryTruncated) {
      coverage.status = 'partial'
      coverage.reasons = [...new Set([...coverage.reasons, ...(runs.truncated || messages.truncated ? ['projection-window; page canonical events'] : []), ...(textOrHistoryTruncated ? ['native-or-projection-incomplete'] : [])])]
    }
    const projectedMessages = messages.latest.map(message => ({
      ...message,
      createdAt: message.createdAt ?? (message.requestId ? store.getRequest({ clientThreadId, requestId: message.requestId })?.acceptedAt : null) ?? null,
    }))
    return {
      protocolVersion: 1, thread, runs: runs.latest, messages: projectedMessages,
      events: eventsPage.events, nextCursor: eventsPage.nextCursor, hasMore: eventsPage.hasMore,
      projectionTruncated: runs.truncated || messages.truncated || textOrHistoryTruncated, coverage,
    }
  }

  importLocalHistory({ clientThreadId, importId, snapshot }) {
    const stack = [snapshot]
    let visited = 0
    while (stack.length) {
      const value = stack.pop()
      if (++visited > 1000000) throw chatError('INVALID_HISTORY_IMPORT', 'Legacy snapshot is too complex', 413)
      if (typeof value === 'string' && publicText(value, value.length) !== value) {
        throw chatError('PRIVATE_CHAT_PAYLOAD', 'Legacy snapshot contains unsanitized private text; nothing was imported', 400)
      }
      if (value && typeof value === 'object') stack.push(...Object.values(value))
    }
    return this.assertStore().importSnapshot({ clientThreadId, importId, snapshot })
  }

  emit(run, event, details = {}, itemId) {
    const localMessageId = event.startsWith('message.') && itemId && run.localRunId
      ? localId('msg', run.localRunId, itemId) : null
    const publicEvent = {
      type: 'chat.event', v: 2, provider: 'codex', event,
      streamId: this.streamId, seq: ++this.seq, ts: this.now(),
      requestId: run.requestId, clientThreadId: run.clientThreadId,
      conversationId: run.conversationId, runId: run.runId, answerId: run.answerId,
      localConversationId: run.localConversationId || null,
      localRunId: run.localRunId || null,
      localMessageId,
      ...(itemId ? { itemId } : {}), details: copy(details),
    }
    if (this.store) {
      try {
        if (!this.storeHealthy) throw chatError('CHAT_STORE_UNAVAILABLE', 'Local chat history is unavailable', 503)
        this.store.appendEvent({
          eventKey: `${publicEvent.streamId}:${publicEvent.seq}`,
          clientThreadId: run.clientThreadId,
          ...(run.requestId ? { requestId: run.requestId } : {}),
          ...(run.localRunId ? { localRunId: run.localRunId } : {}),
          ...(localMessageId ? { localMessageId } : {}),
          ...(run.runId ? { runId: run.runId } : {}),
          ...(event.startsWith('message.') && (itemId || details?.messageId) ? { messageId: itemId || details.messageId } : {}),
          event, details: publicEvent.details, ts: publicEvent.ts,
          runCheckpoint: copy(run),
        })
        publicEvent.durable = true
      } catch {
        // The native turn may already be running. Never advertise an unrecorded
        // event as durable or silently dispatch another turn to recover it.
        this.storeHealthy = false
        publicEvent.durable = false
        publicEvent.storageError = { code: 'CHAT_STORE_UNAVAILABLE', message: 'Local chat history is incomplete' }
      }
    }
    this.emitEvent(publicEvent)
  }

  reset() {
    for (const provider of this.toolProviders) provider.reset?.()
    this.epoch++
    this.streamId = randomUUID()
    this.seq = 0
    this.threads.clear()
    this.threadToolOwners.clear()
    this.loadedThreads.clear()
    this.runs.clear()
    this.rawMessages.clear()
    this.visibleMessages.clear()
    this.pendingApprovals.clear()
    this.pendingStarts.clear()
    this.pendingResumes.clear()
    this.requests.clear()
    this.persistedRunStates.clear()
    this.uncertainThreads.clear()
    this.incompleteHistory.clear()
    this.truncated = false
  }

  setConnection(ready, { processLost = false } = {}) {
    this.connection = ready ? 'ready' : 'offline'
    if (ready) return
    for (const provider of this.toolProviders) provider.disconnect?.({ processLost })
    this.epoch++
    this.loadedThreads.clear()
    for (const run of this.runs.values()) {
      if (TERMINAL.has(run.status)) continue
      run.status = processLost ? 'failed' : 'unknown'
      run.historyComplete = false
      run.error = publicError(processLost ? 'Local Codex process exited' : 'Codex connection lost; resume to reconcile', processLost ? 'RUNTIME_LOST' : 'CONNECTION_LOST')
      if (processLost) {
        for (const message of run.messages) if (message.status === 'streaming') message.status = 'error'
        for (const activity of run.activities) if (activity.status === 'inProgress') {
          activity.status = 'failed'
          activity.detail = { ...activity.detail, error: run.error }
        }
      }
      run.pendingApprovals = []
      this.emit(run, 'run.unavailable', { status: run.status, error: run.error })
      if (this.store && run.localRunId) this.persistedRunStates.set(runKey(run.conversationId, run.runId), { status: run.status, historyComplete: run.historyComplete })
      this.emitLegacy({ type: 'assistant-error', conversationId: run.conversationId, messageId: run.answerId, error: run.error.message })
    }
    this.pendingApprovals.clear()
    this.rawMessages.clear()
    this.visibleMessages.clear()
  }

  trimRuns() {
    while (this.runs.size > MAX_RUNS) {
      const entry = [...this.runs].find(([, run]) => TERMINAL.has(run.status))
      if (!entry) break
      this.runs.delete(entry[0])
      for (const key of this.rawMessages.keys()) if (key.startsWith(`${entry[0]}/`)) this.rawMessages.delete(key)
      for (const key of this.visibleMessages.keys()) if (key.startsWith(`${entry[0]}/`)) this.visibleMessages.delete(key)
      this.truncated = true
    }
  }

  rememberThread(id, result = {}, clientThreadId = null) {
    if (!idText(id)) throw chatError('INVALID_THREAD_RESPONSE', 'Codex did not return a thread ID', 502)
    const old = this.threads.get(id) || {}
    this.threads.set(id, {
      id, cwd: typeof result.cwd === 'string' ? result.cwd : (result.thread?.cwd || old.cwd || null),
      model: typeof result.model === 'string' ? result.model : (old.model || null),
      effort: typeof result.reasoningEffort === 'string' ? result.reasoningEffort : (old.effort || null),
      clientThreadId: clientThreadId || old.clientThreadId || null,
      executionPolicy: old.executionPolicy || null,
      qaReceipt: old.qaReceipt || null,
    })
    this.loadedThreads.add(id)
    if (this.threads.size > MAX_THREADS) {
      const oldest = [...this.threads.keys()].find(key => key !== id && ![...this.runs.values()].some(run => run.conversationId === key && !TERMINAL.has(run.status)))
      if (oldest) { this.threads.delete(oldest); this.loadedThreads.delete(oldest); this.truncated = true }
    }
  }

  ensureRun(threadId, turnId, context = null, announce = true) {
    if (!idText(turnId) || !this.threads.has(threadId)) return null
    const key = runKey(threadId, turnId)
    let run = this.runs.get(key)
    if (run) return run
    if (!context && this.store) {
      const clientThreadId = this.threads.get(threadId).clientThreadId
      const thread = clientThreadId ? this.store.getConversation(clientThreadId) : null
      if (thread) {
        let afterSeq = 0
        let prior = null
        for (let page = 0; page < 1000; page++) {
          const result = this.store.listRuns(clientThreadId, { afterSeq, limit: 100 })
          prior = (result.runs || []).find(candidate => candidate.runId === turnId && candidate.conversationId === threadId) || prior
          if (prior || !result.hasMore) break
          if (!Number.isSafeInteger(result.nextCursor) || result.nextCursor <= afterSeq) break
          afterSeq = result.nextCursor
        }
        context = {
          clientThreadId, localConversationId: thread.localConversationId,
          localRunId: prior?.localRunId || localId('run', clientThreadId, turnId),
          requestId: prior?.requestId || null,
          localMessageId: prior?.requestId ? this.store.getRequest({ clientThreadId, requestId: prior.requestId })?.localMessageId || null : null,
        }
        if (prior) this.persistedRunStates.set(runKey(threadId, turnId), { status: prior.status, historyComplete: prior.historyComplete })
      }
    }
    run = {
      conversationId: threadId, runId: turnId, answerId: key,
      requestId: context?.requestId || null,
      clientThreadId: context?.clientThreadId || this.threads.get(threadId).clientThreadId,
      localConversationId: context?.localConversationId || null,
      localRunId: context?.localRunId || null,
      localMessageId: context?.localMessageId || null,
      status: 'inProgress', stopRequested: false, stopConfirmed: false,
      messages: [], activities: [], artifacts: [], pendingApprovals: [], error: null,
      createdAt: this.now(), truncated: false, historyComplete: true,
      ...(this.store ? { accountIdentity: { ownerHash: ownerHash(this.getOwnerKey()), status: 'verified' } } : {}),
      cwdPublic: publicText(this.threads.get(threadId)?.cwd || '', 2000),
    }
    this.runs.set(key, run)
    this.trimRuns()
    if (announce) {
      this.emit(run, 'run.started', { status: 'inProgress' })
      this.emitLegacy({ type: 'assistant-start', conversationId: threadId, runId: turnId, message: { id: key, role: 'assistant', content: '', status: 'streaming', createdAt: run.createdAt } })
    }
    return run
  }

  put(run, collection, value) {
    const index = run[collection].findIndex(item => item.id === value.id)
    if (index >= 0) run[collection][index] = value
    else run[collection].push(value)
    if (run[collection].length > MAX_ITEMS) {
      const removed = run[collection].shift()
      if (collection === 'messages') this.rawMessages.delete(`${run.answerId}/${removed.id}`)
      if (collection === 'activities') this.rawMessages.delete(`${run.answerId}/summary:${removed.id}`)
      run.truncated = true
    }
  }

  async send(body) {
    validateChatCwd(body)
    if (this.requireStore) this.assertStore()
    this.assertReady()
    if (typeof body.message !== 'string' || !body.message.trim()) throw chatError('EMPTY_MESSAGE', 'Message is required')
    if (body.message.length > MAX_TEXT) throw chatError('MESSAGE_TOO_LONG', `Message exceeds ${MAX_TEXT} characters`)
    this.threadOverrides(body)
    const requestedPolicy = requestedExecutionPolicy(body.executionPolicy)
    if (requestedPolicy && !this.qaReady()) throw chatError('QA_POLICY_UNAVAILABLE', 'Read-only QA requires a verified native policy contract', 503)
    if (body.effort !== undefined && (!idText(body.effort) || !body.effort.trim())) throw chatError('INVALID_EFFORT', 'Invalid reasoning effort')
    const requestId = idText(body.requestId) || randomUUID()
    const fingerprint = createHash('sha256').update(JSON.stringify({
      // Native conversationId is a routing hint that can be learned after a
      // lost response. It must not change the identity of the original input.
      message: body.message, clientThreadId: body.clientThreadId || body.thread?.id,
      cwd: body.cwd, model: body.model, effort: body.effort, profileEnabled: body.profileEnabled === true,
      systemPrompt: body.profileEnabled === true ? body.systemPrompt : undefined,
      contextSnapshotIds: body.contextSnapshotIds, contextCapabilities: body.contextCapabilities, attachments: body.attachments,
      executionPolicy: body.executionPolicy,
    })).digest('hex')
    const previous = this.requests.get(requestId)
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw chatError('REQUEST_CONFLICT', 'requestId was already used for another request', 409)
      return previous.promise
    }
    const clientThreadId = idText(body.clientThreadId) || idText(body.thread?.id)
    const conversationId = idText(body.conversationId)
    if (body.conversationId != null && !conversationId) throw chatError('INVALID_THREAD_ID', 'Invalid conversationId')
    if (this.store && !clientThreadId) throw chatError('INVALID_CLIENT_THREAD_ID', 'clientThreadId is required for durable chat', 400)
    const requestOwnerHash = this.store ? ownerHash(this.getOwnerKey()) : null
    if (this.store) {
      const knownThread = this.store.getConversation(clientThreadId)
      const knownRequest = knownThread ? this.store.getRequest({ clientThreadId, requestId }) : null
      if (knownRequest) {
        if (knownRequest.fingerprint !== fingerprint) throw chatError('REQUEST_CONFLICT', 'requestId was already used for another request', 409)
        const outcome = knownRequest.outcome || {}
        return {
          ...outcome, accepted: outcome.accepted === true, durable: true, duplicate: true,
          dispatchStatus: outcome.dispatchStatus || 'unknown', requestId, clientThreadId,
          localConversationId: knownThread.localConversationId,
          localRunId: localId('run', clientThreadId, requestId),
          localMessageId: knownRequest.localMessageId,
          conversationId: outcome.conversationId || knownThread.conversationId || null,
          runId: outcome.runId || null,
        }
      }
    }
    if (this.store && !requestOwnerHash) throw chatError('NATIVE_ACCOUNT_UNVERIFIED', 'Codex account identity is unavailable; local history remains readable', 403)
    const lock = conversationId || `client:${clientThreadId || 'legacy'}`
    if (this.locks.has(lock)) throw chatError('RUN_IN_PROGRESS', 'A request is already starting for this conversation', 409)
    if (this.locks.size >= MAX_RUNS) throw chatError('RUNTIME_BUSY', 'Too many pending requests', 429)
    const registered = !conversationId && clientThreadId ? [...this.threads.values()].find(t => t.clientThreadId === clientThreadId) : null
    if (registered) {
      throw Object.assign(chatError('CONVERSATION_REQUIRED', 'Continue this conversation using its returned conversationId', 409), {
        conversationId: registered.id, requestId, resumeRequired: this.uncertainThreads.has(registered.id),
      })
    }
    let acceptedLocal = null
    let boundPolicy = this.threads.get(conversationId)?.executionPolicy || null
    if (this.store) {
      if (!this.storeHealthy) throw chatError('CHAT_STORE_UNAVAILABLE', 'Local chat history cannot accept this message', 503)
      try {
        let thread = this.store.getConversation(clientThreadId)
        if (thread?.conversationId && !conversationId) {
          throw Object.assign(chatError('CONVERSATION_REQUIRED', 'Continue this conversation using its returned conversationId', 409), {
            conversationId: thread.conversationId, requestId, resumeRequired: true,
          })
        }
        if (conversationId && (!thread || thread.conversationId !== conversationId)) throw chatError('NATIVE_BINDING_MISMATCH', 'Native conversation is not bound to this local chat', 409)
        if (conversationId) boundPolicy = this.assertNativeAccount(clientThreadId, conversationId)
        if (!thread) thread = this.store.createConversation({ clientThreadId, createdAt: this.now() })
        const localRunId = localId('run', clientThreadId, requestId)
        const localMessageId = localId('msg', clientThreadId, requestId)
        const accepted = this.store.acceptRequest({
          clientThreadId, requestId, fingerprint, ts: this.now(), localMessageId,
          message: {
            messageId: null, clientId: requestId, role: 'user',
            text: publicText(body.message, body.message.length), phase: null,
            status: 'accepted', localRunId, requestId,
          },
        })
        acceptedLocal = {
          ...accepted, clientThreadId, localConversationId: thread.localConversationId,
          localRunId, localMessageId,
        }
      } catch (error) {
        if (['REQUEST_CONFLICT', 'CONVERSATION_REQUIRED', 'NATIVE_BINDING_MISMATCH', 'NATIVE_ACCOUNT_MISMATCH', 'NATIVE_ACCOUNT_UNVERIFIED'].includes(error?.code)) throw error
        this.storeHealthy = false
        throw chatError('CHAT_STORE_UNAVAILABLE', 'Local chat history could not save the message; no Codex turn was started', 503)
      }
      if (!acceptedLocal?.localConversationId || !acceptedLocal?.request || !acceptedLocal?.message) {
        this.storeHealthy = false
        throw chatError('CHAT_STORE_UNAVAILABLE', 'Local chat history did not confirm the message; no Codex turn was started', 503)
      }
      if (!acceptedLocal.accepted) return {
        ...(acceptedLocal.request.outcome || {}),
        accepted: acceptedLocal.request.outcome?.accepted === true,
        durable: true, duplicate: true,
        dispatchStatus: acceptedLocal.request.outcome?.dispatchStatus || 'unknown',
        requestId, clientThreadId,
        localConversationId: acceptedLocal.localConversationId,
        localRunId: acceptedLocal.localRunId,
        localMessageId: acceptedLocal.localMessageId,
        conversationId: acceptedLocal.request.outcome?.conversationId || conversationId || null,
        runId: acceptedLocal.request.outcome?.runId || null,
      }
    }
    this.locks.add(lock)
    const context = {
      requestId, clientThreadId: acceptedLocal?.clientThreadId || clientThreadId,
      conversationId, localConversationId: acceptedLocal?.localConversationId || null,
      localRunId: acceptedLocal?.localRunId || null,
      localMessageId: acceptedLocal?.localMessageId || null,
      ownerHash: requestOwnerHash,
      executionPolicy: requestedPolicy || boundPolicy,
      policyUpgrade: Boolean(conversationId && requestedPolicy && !boundPolicy),
    }
    const record = { fingerprint, settled: false, promise: null }
    record.promise = this.startTurn(body, context).catch(error => {
      const failure = error instanceof Error ? error : new Error('Codex request failed')
      if (this.store && acceptedLocal && !context.turnStartAttempted && ['QA_POLICY_UNVERIFIED', 'QA_TOOL_ISOLATION_UNVERIFIED', 'QA_POLICY_UNAVAILABLE'].includes(failure.code)) {
        try {
          this.store.recordRequestOutcome({
            clientThreadId: context.clientThreadId, requestId, ts: this.now(),
            outcome: { accepted: false, dispatchStatus: 'rejected', conversationId: context.conversationId || null, localRunId: context.localRunId, error: publicError(failure, 'QA_POLICY_UNVERIFIED') },
          })
        } catch { this.storeHealthy = false }
      }
      failure.conversationId = context.conversationId || ''
      failure.requestId = requestId
      failure.resumeRequired = Boolean(context.conversationId && this.uncertainThreads.has(context.conversationId))
      failure.saved = Boolean(acceptedLocal)
      failure.durable = Boolean(this.store && this.storeHealthy)
      failure.clientThreadId = context.clientThreadId
      failure.localConversationId = context.localConversationId
      failure.localRunId = context.localRunId
      failure.localMessageId = context.localMessageId
      failure.dispatchStatus = failure.resumeRequired ? 'unknown' : 'rejected'
      if (typeof failure.code === 'number' && !failure.httpStatus) failure.httpStatus = 400
      throw failure
    }).finally(() => {
      this.locks.delete(lock)
      record.settled = true
      while (this.requests.size > MAX_REQUESTS) {
        const first = [...this.requests].find(([, r]) => r.settled)
        if (!first) break
        this.requests.delete(first[0])
      }
    })
    this.requests.set(requestId, record)
    return record.promise
  }

  threadOverrides(body) {
    const options = {}
    const cwd = validateChatCwd(body)
    if (cwd !== undefined) options.cwd = cwd
    if (body.model !== undefined) {
      if (!idText(body.model) || !body.model.trim()) throw chatError('INVALID_MODEL', 'Invalid model')
      options.model = body.model
    }
    if (body.profileEnabled === true) {
      const prompt = typeof body.systemPrompt === 'string' ? body.systemPrompt.trim() : ''
      if (!prompt || prompt.length > 8000) throw chatError('INVALID_PROFILE', 'An enabled profile needs a systemPrompt of at most 8000 characters')
      options.developerInstructions = prompt
    }
    return options
  }

  assertProcessConfiguration(thread, { model, effort } = {}) {
    // An explicit per-turn selection is allowed to differ from the process
    // default. Ordinary UI turns must not silently use a contrary native value.
    if (!this.expectedProcessConfiguration || model !== undefined || effort !== undefined) return
    const expected = this.expectedProcessConfiguration
    if ((expected.model && thread?.model && thread.model !== expected.model) ||
        (expected.effort && thread?.effort && thread.effort !== expected.effort)) {
      throw chatError('NATIVE_CONFIGURATION_MISMATCH', 'Native thread settings differ from the process-scoped Codex configuration', 409)
    }
  }

  assertNativeAccount(clientThreadId, conversationId) {
    if (!this.store) return this.threads.get(conversationId)?.executionPolicy || null
    const expected = ownerHash(this.getOwnerKey())
    if (!expected) throw chatError('NATIVE_ACCOUNT_UNVERIFIED', 'Current Codex account identity is unavailable', 403)
    let afterSeq = 0
    let recorded = null
    let executionPolicy = null
    for (let page = 0; page < 1000; page++) {
      const result = this.store.listEvents(clientThreadId, { afterSeq, limit: 500 })
      for (const event of result.events || []) if (event.event === 'native.thread.bound' && event.details?.conversationId === conversationId) {
        recorded = event.details.ownerHash || null
        executionPolicy = event.details.executionPolicy || null
      } else if (event.event === 'native.executionPolicy.bound' && event.details?.conversationId === conversationId) {
        executionPolicy = event.details.executionPolicy
      }
      if (!result.hasMore) break
      if (!Number.isSafeInteger(result.nextCursor) || result.nextCursor <= afterSeq) throw chatError('NATIVE_ACCOUNT_UNVERIFIED', 'Native account checkpoint is incomplete', 409)
      afterSeq = result.nextCursor
      if (page === 999) throw chatError('NATIVE_ACCOUNT_UNVERIFIED', 'Native account checkpoint exceeds the bounded read', 409)
    }
    if (!recorded) throw chatError('NATIVE_ACCOUNT_UNVERIFIED', 'Native account ownership was not recorded', 409)
    if (recorded !== expected) throw chatError('NATIVE_ACCOUNT_MISMATCH', 'This native conversation belongs to a different Codex account', 403)
    if (executionPolicy !== null && executionPolicy !== READ_ONLY_QA) throw chatError('QA_POLICY_UNVERIFIED', 'Stored native execution policy is unknown', 409)
    return executionPolicy
  }

  persistNativeBinding(context, conversationId) {
    if (!this.store) return
    const identityHash = ownerHash(this.getOwnerKey())
    if (!identityHash || identityHash !== context.ownerHash) throw chatError('ACCOUNT_CHANGED', 'Codex account changed before native thread binding', 409)
    try {
      this.store.appendEvent({
        eventKey: `native-thread:${context.requestId}`, clientThreadId: context.clientThreadId,
        requestId: context.requestId,
        localRunId: context.localRunId, event: 'native.thread.bound',
        details: { conversationId, ownerHash: identityHash, executionPolicy: context.executionPolicy || null }, ts: this.now(),
      })
      this.store.bindNative({ clientThreadId: context.clientThreadId, conversationId })
    } catch {
      this.storeHealthy = false
      throw chatError('CHAT_STORE_UNAVAILABLE', 'Native thread binding could not be saved; no Codex turn was started', 503)
    }
  }

  persistExecutionPolicy(context, conversationId) {
    if (!this.store || !context.policyUpgrade) return
    if (ownerHash(this.getOwnerKey()) !== context.ownerHash) throw chatError('ACCOUNT_CHANGED', 'Codex account changed before policy binding', 409)
    try {
      this.store.appendEvent({
        eventKey: `native-policy:${context.requestId}`, clientThreadId: context.clientThreadId,
        requestId: context.requestId, localRunId: context.localRunId,
        event: 'native.executionPolicy.bound',
        details: { conversationId, executionPolicy: READ_ONLY_QA }, ts: this.now(),
      })
    } catch {
      this.storeHealthy = false
      throw chatError('CHAT_STORE_UNAVAILABLE', 'Read-only policy binding could not be saved; no Codex turn was started', 503)
    }
  }

  async startTurn(body, context) {
    const epoch = this.epoch
    const overrides = this.threadOverrides(body)
    const qa = context.executionPolicy === READ_ONLY_QA
    const preparedProviders = new Map()
    for (const provider of this.toolProviders) if (!qa || provider === this.contexts) preparedProviders.set(provider, await provider.prepare?.(body) || null)
    const additionalContext = this.additionalToolContext(preparedProviders)
    if (epoch !== this.epoch) throw chatError('ACCOUNT_CHANGED', 'Codex account or connection changed', 409)
    if (qa && !this.qaReady()) throw chatError('QA_POLICY_UNAVAILABLE', 'Read-only QA requires a verified native policy contract', 503)
    const qaOverrides = qa ? qaThreadOverrides(await listNativeMcpServers(this.request, context.conversationId && this.loadedThreads.has(context.conversationId) ? context.conversationId : null)) : null
    if (epoch !== this.epoch) throw chatError('ACCOUNT_CHANGED', 'Codex account or connection changed', 409)
    const effort = body.effort
    // CLI 0.156.1 defines ReasoningEffort as a non-empty model-advertised string.
    if (effort !== undefined && (!idText(effort) || !effort.trim())) throw chatError('INVALID_EFFORT', 'Invalid reasoning effort')
    if (this.store) {
      try {
        this.store.appendEvent({
          eventKey: `dispatch:${context.requestId}`, clientThreadId: context.clientThreadId,
          requestId: context.requestId, localRunId: context.localRunId,
          localMessageId: context.localMessageId, event: 'run.dispatching',
          details: { status: 'dispatching' }, ts: this.now(),
        })
        this.store.recordRequestOutcome({
          clientThreadId: context.clientThreadId, requestId: context.requestId, ts: this.now(),
          outcome: { accepted: false, dispatchStatus: 'dispatching', localRunId: context.localRunId },
        })
      } catch {
        this.storeHealthy = false
        throw chatError('CHAT_STORE_UNAVAILABLE', 'Local chat history could not record dispatch; no Codex turn was started', 503)
      }
    }
    let cid = context.conversationId
    if (cid) {
      if (context.policyUpgrade) {
        // thread/resume cannot replace a thread's persisted dynamicTools. Do
        // not claim a clean QA catalog if an older ordinary thread could still
        // advertise write-capable EG-Desk or Browser tools to the model.
        const registered = this.threadToolOwners.get(cid)
        const readOnlyNames = new Set([toolKey(null, 'egdesk_list_context'), toolKey(null, 'egdesk_read_source')])
        if (!registered || [...registered.keys()].some(name => !readOnlyNames.has(name))) {
          throw chatError('QA_REQUIRES_NEW_CONVERSATION', 'This thread has unknown or broader dynamic tools; start a new read-only QA conversation', 409)
        }
      }
      for (const provider of preparedProviders.keys()) await provider.requireThread?.(cid, preparedProviders.get(provider))
      if (epoch !== this.epoch) throw chatError('ACCOUNT_CHANGED', 'Codex account or connection changed', 409)
      if (this.uncertainThreads.has(cid)) throw chatError('RESUME_REQUIRED', 'Resume the conversation before retrying an uncertain turn', 409)
      // Hydrate native history before deciding whether a new turn is safe.
      // This also supplies the historical cwd for profile-off config/read.
      const justRestored = !this.loadedThreads.has(cid)
      if (justRestored) await this.restoreThread(cid, context.clientThreadId, qaOverrides || {}, { qa })
      if ([...this.runs.values()].some(run => run.conversationId === cid && !TERMINAL.has(run.status))) {
        throw chatError('RUN_IN_PROGRESS', 'This conversation already has an active or unreconciled turn', 409)
      }
      if (body.profileEnabled === true || body.profileEnabled === false) {
        if (body.profileEnabled === false) {
          // Read only the effective ordinary instruction setting, never expose
          // the config payload. Null/absent means an explicit empty override.
          const config = await this.request('config/read', {
            includeLayers: false,
            cwd: overrides.cwd || this.threads.get(cid)?.cwd || null,
          })
          const ordinary = config?.config?.developer_instructions
          if (!config?.config || (ordinary != null && typeof ordinary !== 'string')) throw chatError('PROFILE_CONFIG_UNAVAILABLE', 'Could not resolve ordinary Codex instructions', 502)
          overrides.developerInstructions = ordinary ?? ''
        }
        if (epoch !== this.epoch) throw chatError('CONTEXT_CHANGED', 'Codex connection or account changed', 409)
      }
      // Read-only QA re-asserts and verifies its effective native thread policy
      // before *every* provider turn, including after reconnect or a profile
      // change. A loaded thread must be detached first so resume overrides take.
      const mustReload = (qa && !justRestored) || body.profileEnabled === true || body.profileEnabled === false
      if (mustReload && this.loadedThreads.has(cid)) {
        const detached = await this.request('thread/unsubscribe', { threadId: cid })
        this.loadedThreads.delete(cid)
        if (!['unsubscribed', 'notLoaded'].includes(detached?.status)) throw chatError('PROFILE_TRANSITION_UNAVAILABLE', 'Could not detach this native thread for a profile change', 409)
      }
      if (!this.loadedThreads.has(cid)) await this.restoreThread(cid, context.clientThreadId, { ...overrides, ...(qaOverrides || {}) }, { qa })
      if (qa) this.persistExecutionPolicy(context, cid)
    } else {
      const nativeTools = this.collectToolSpecs(qa)
      if (nativeTools.specs.length) overrides.dynamicTools = nativeTools.specs
      if (qa) Object.assign(overrides, qaOverrides)
      const result = await this.request('thread/start', overrides)
      if (epoch !== this.epoch) throw chatError('ACCOUNT_CHANGED', 'Codex account changed', 409)
      cid = result?.thread?.id
      if (!idText(cid)) throw chatError('INVALID_THREAD_RESPONSE', 'Codex did not return a thread ID', 502)
      let qaReceipt = null
      if (qa) {
        qaReceipt = verifyQaNativeThread(result)
        qaReceipt = await verifyQaMcpIsolation(this.request, cid, qaReceipt)
      }
      if (epoch !== this.epoch) throw chatError('ACCOUNT_CHANGED', 'Codex account changed', 409)
      this.rememberThread(cid, result, context.clientThreadId)
      this.threadToolOwners.set(cid, nativeTools.owners)
      if (qa) Object.assign(this.threads.get(cid), { executionPolicy: READ_ONLY_QA, qaReceipt })
      context.conversationId = cid
      if (this.store) this.persistNativeBinding(context, cid)
      for (const provider of nativeTools.selected) await provider.registerThread?.(cid)
    }
    if (epoch !== this.epoch) throw chatError('ACCOUNT_CHANGED', 'Codex account changed', 409)
    this.assertProcessConfiguration(this.threads.get(cid), { model: body.model, effort })
    if ([...this.runs.values()].some(run => run.conversationId === cid && !TERMINAL.has(run.status))) {
      throw chatError('RUN_IN_PROGRESS', 'This conversation already has an active or unreconciled turn', 409)
    }
    if ([...this.runs.values()].filter(run => !TERMINAL.has(run.status)).length >= MAX_RUNS) throw chatError('RUNTIME_BUSY', 'Too many active turns', 429)
    const pending = { ...context, conversationId: cid, buffer: [] }
    this.pendingStarts.set(cid, pending)
    let turnStartAttempted = false
    try {
      turnStartAttempted = context.turnStartAttempted = true
      const result = await this.request('turn/start', {
        threadId: cid,
        input: [{ type: 'text', text: body.message, text_elements: [] }],
        clientUserMessageId: context.requestId,
        ...(qa ? QA_TURN_OVERRIDES : {}),
        ...(additionalContext ? { additionalContext } : {}),
        ...(overrides.cwd ? { cwd: overrides.cwd } : {}),
        ...(overrides.model ? { model: overrides.model } : {}),
        ...(effort !== undefined ? { effort } : {}),
      })
      if (epoch !== this.epoch) throw chatError('ACCOUNT_CHANGED', 'Codex account changed', 409)
      if (this.store) {
        try {
          this.store.bindNative({ clientThreadId: context.clientThreadId, conversationId: cid, localRunId: context.localRunId, runId: result?.turn?.id })
          this.store.recordRequestOutcome({
            clientThreadId: context.clientThreadId, requestId: context.requestId, ts: this.now(),
            outcome: { accepted: true, dispatchStatus: 'confirmed', conversationId: cid, runId: result?.turn?.id, localRunId: context.localRunId, accountIdentity: { ownerHash: context.ownerHash, status: 'verified' } },
          })
        } catch { this.storeHealthy = false }
      }
      const run = this.ensureRun(cid, result?.turn?.id, context)
      if (!run) throw chatError('INVALID_TURN_RESPONSE', 'Codex did not return a turn ID', 502)
      if (qa) {
        run.executionPolicy = this.threads.get(cid)?.qaReceipt || null
        if (!run.executionPolicy) throw chatError('QA_POLICY_UNVERIFIED', 'Verified read-only policy receipt was lost', 502)
        this.emit(run, 'run.executionPolicy', { executionPolicy: run.executionPolicy })
      }
      const threadConfiguration = this.threads.get(cid)
      const nativeTurnModel = idText(result?.model) || idText(result?.turn?.model)
      const nativeTurnEffort = idText(result?.reasoningEffort) || idText(result?.turn?.reasoningEffort)
      const readerConfiguration = {
        model: nativeTurnModel || overrides.model || threadConfiguration?.model || null,
        effort: nativeTurnEffort || effort || threadConfiguration?.effort || null,
        modelSource: nativeTurnModel ? 'native-turn' : overrides.model ? 'turn-request' : 'native-thread',
        effortSource: nativeTurnEffort ? 'native-turn' : effort !== undefined ? 'turn-request' : 'native-thread',
      }
      run.parentTurnConfiguration = readerConfiguration
      this.emit(run, 'run.configuration', { configuration: readerConfiguration })
      for (const provider of preparedProviders.keys()) await provider.bindRun?.(run, preparedProviders.get(provider), readerConfiguration)
      if (epoch !== this.epoch) throw chatError('ACCOUNT_CHANGED', 'Codex account or connection changed', 409)
      // Notifications can precede the RPC response. Only the returned turn ID
      // may inherit this request's correlation; other turns remain unclaimed.
      while (pending.buffer.length) await this.apply(pending.buffer.shift())
      if (TERMINAL.has(result.turn.status) && !TERMINAL.has(run.status)) await this.finish(run, safeTurn(result.turn))
      return {
        accepted: true, durable: !this.store || this.storeHealthy,
        conversationId: cid, requestId: context.requestId, runId: run.runId, answerId: run.answerId,
        clientThreadId: context.clientThreadId, localConversationId: context.localConversationId,
        localRunId: context.localRunId, localMessageId: context.localMessageId,
        ...(qa ? { executionPolicy: run.executionPolicy } : {}),
      }
    } catch (error) {
      // A native JSON-RPC error is a definite rejection. A lost/ambiguous reply
      // needs explicit reconciliation before another attempt can start a turn.
      if (epoch === this.epoch && turnStartAttempted && typeof error.code !== 'number') this.uncertainThreads.add(cid)
      if (this.store) {
        try {
          this.store.recordRequestOutcome({
            clientThreadId: context.clientThreadId, requestId: context.requestId, ts: this.now(),
            outcome: {
              accepted: false, dispatchStatus: turnStartAttempted && typeof error.code !== 'number' ? 'unknown' : 'rejected',
              conversationId: cid || null, localRunId: context.localRunId,
              error: publicError(error, 'TURN_START_FAILED'),
            },
          })
        } catch { this.storeHealthy = false }
      }
      throw error
    } finally { if (this.pendingStarts.get(cid) === pending) this.pendingStarts.delete(cid) }
  }

  async restoreThread(cid, clientThreadId, overrides = {}, { qa = false } = {}) {
    const epoch = this.epoch
    const pending = { buffer: [] }
    this.pendingResumes.set(cid, pending)
    try {
      await this.queue
      // Never fall back to thread/start if a historical ID is invalid or unavailable.
      const result = await this.request('thread/resume', { threadId: cid, ...overrides })
      if (epoch !== this.epoch) throw chatError('CONTEXT_CHANGED', 'Codex connection or account changed', 409)
      if (result?.thread?.id !== cid) throw chatError('THREAD_MISMATCH', 'Codex resumed a different thread', 502)
      let qaReceipt = null
      if (qa) {
        qaReceipt = verifyQaNativeThread(result)
        qaReceipt = await verifyQaMcpIsolation(this.request, cid, qaReceipt)
      }
      if (epoch !== this.epoch) throw chatError('CONTEXT_CHANGED', 'Codex connection or account changed', 409)
      this.rememberThread(cid, result, clientThreadId)
      this.threadToolOwners.set(cid, this.collectToolSpecs(qa).owners)
      if (qa) Object.assign(this.threads.get(cid), { executionPolicy: READ_ONLY_QA, qaReceipt })
      const turns = Array.isArray(result.thread.turns) ? result.thread.turns : []
      if (result.turnsBackwardsCursor || result.itemsBackwardsCursor) this.incompleteHistory.add(cid)
      else this.incompleteHistory.delete(cid)
      this.truncated ||= turns.length > MAX_RUNS
      for (const original of turns.slice(-MAX_RUNS)) {
        const turn = safeTurn(original)
        const retainedComplete = this.runs.get(runKey(cid, turn.id))?.historyComplete === true
        const run = this.ensureRun(cid, turn.id, null, false)
        if (!run) continue
        run.clientThreadId = clientThreadId || run.clientThreadId
        for (const item of turn.items) {
          // An active turn's history carries text snapshots, not item-completed
          // evidence. Preserve observed completions; otherwise keep accepting deltas.
          const ended = item.type !== 'agentMessage' || TERMINAL.has(turn.status)
          await this.applyItem(run, item, ended, false)
          if (item.type === 'agentMessage' && ['failed', 'interrupted'].includes(turn.status)) {
            const message = run.messages.find(message => message.id === item.id)
            if (message && !message.completionConfirmed) message.status = turn.status === 'failed' ? 'error' : 'interrupted'
          }
        }
        if (epoch !== this.epoch) throw chatError('CONTEXT_CHANGED', 'Codex connection or account changed', 409)
        run.status = turn.status
        run.stopConfirmed = turn.status === 'interrupted'
        run.error = turn.error
        run.truncated ||= Boolean(turn.truncated)
        run.historyComplete = retainedComplete || turn.itemsView === 'full'
        for (const provider of this.toolProviders) await provider.restoreRun?.(run)
        if (epoch !== this.epoch) throw chatError('CONTEXT_CHANGED', 'Codex connection or account changed', 409)
        const persisted = this.persistedRunStates.get(runKey(cid, turn.id))
        if (this.store && persisted && (persisted.status !== run.status || persisted.historyComplete !== run.historyComplete)) {
          this.emit(run, 'run.reconciled', { status: run.status, historyComplete: run.historyComplete, error: run.error })
          if (this.storeHealthy && run.requestId && this.store.getRequest({ clientThreadId: run.clientThreadId, requestId: run.requestId })) {
            try {
              this.store.recordRequestOutcome({
                clientThreadId: run.clientThreadId, requestId: run.requestId, ts: this.now(),
                outcome: { accepted: true, dispatchStatus: 'confirmed', runStatus: run.status, conversationId: cid, runId: turn.id, localRunId: run.localRunId, accountIdentity: run.accountIdentity },
              })
            } catch { this.storeHealthy = false }
          }
          this.persistedRunStates.set(runKey(cid, turn.id), { status: run.status, historyComplete: run.historyComplete })
        }
      }
      // Live events/approval requests may be delivered before the resume result.
      // Hydrate first, then apply these newer events to the matching native run.
      while (pending.buffer.length) await this.apply(pending.buffer.shift())
      if (epoch !== this.epoch) throw chatError('CONTEXT_CHANGED', 'Codex connection or account changed', 409)
      this.uncertainThreads.delete(cid)
      this.trimRuns()
      return result
    } finally { if (this.pendingResumes.get(cid) === pending) this.pendingResumes.delete(cid) }
  }

  async resume(body) {
    if (this.requireStore) this.assertStore()
    this.assertReady()
    const epoch = this.epoch
    const cid = idText(body.conversationId)
    if (!cid) throw chatError('MISSING_THREAD_ID', 'conversationId is required')
    let boundPolicy = this.threads.get(cid)?.executionPolicy || null
    if (this.store) {
      const clientThreadId = idText(body.clientThreadId)
      if (!clientThreadId) throw chatError('INVALID_CLIENT_THREAD_ID', 'clientThreadId is required to resume a durable chat', 400)
      const thread = this.store.getConversation(clientThreadId)
      if (!thread || thread.conversationId !== cid) throw chatError('NATIVE_BINDING_MISMATCH', 'Native conversation is not bound to this local chat', 409)
      boundPolicy = this.assertNativeAccount(clientThreadId, cid)
    }
    if (this.locks.has(cid) || this.pendingStarts.has(cid)) throw chatError('RUN_STARTING', 'Conversation request is still starting', 409)
    this.locks.add(cid)
    try {
      const qa = boundPolicy === READ_ONLY_QA
      if (qa && !this.qaReady()) throw chatError('QA_POLICY_UNAVAILABLE', 'Read-only QA requires a verified native policy contract', 503)
      const qaOverrides = qa ? qaThreadOverrides(await listNativeMcpServers(this.request, this.loadedThreads.has(cid) ? cid : null)) : {}
      if (qa && this.loadedThreads.has(cid)) {
        const detached = await this.request('thread/unsubscribe', { threadId: cid })
        this.loadedThreads.delete(cid)
        if (!['unsubscribed', 'notLoaded'].includes(detached?.status)) throw chatError('QA_POLICY_UNVERIFIED', 'Could not detach native QA thread before policy verification', 409)
      }
      await this.restoreThread(cid, idText(body.clientThreadId), qaOverrides, { qa })
      await this.queue
      // Revalidate previously retained links without claiming files were generated.
      for (const run of this.runs.values()) if (run.conversationId === cid) {
        const available = []
        for (const artifact of run.artifacts) if (await this.verifyFile(artifact.target.path, { artifact: true })) available.push(artifact)
        if (epoch !== this.epoch) throw chatError('CONTEXT_CHANGED', 'Codex connection or account changed', 409)
        run.artifacts = available
      }
      this.seq++
      return this.snapshot(cid)
    } finally { this.locks.delete(cid) }
  }

  findRun(body) {
    const run = this.runs.get(runKey(idText(body.conversationId), idText(body.runId)))
    if (!run) throw chatError('RUN_NOT_FOUND', 'No matching local run', 404)
    return run
  }

  async interrupt(body) {
    this.assertReady()
    const run = this.findRun(body)
    if (TERMINAL.has(run.status)) return { accepted: false, alreadyTerminal: true, conversationId: run.conversationId, runId: run.runId, status: run.status }
    for (const provider of this.toolProviders) provider.cancelRun?.(run)
    if (run.stopRequested) return { accepted: true, stopRequested: true, conversationId: run.conversationId, runId: run.runId }
    await this.request('turn/interrupt', { threadId: run.conversationId, turnId: run.runId })
    run.stopRequested = true
    this.emit(run, 'run.stop_requested', { stopRequested: true, status: run.status })
    return { accepted: true, stopRequested: true, conversationId: run.conversationId, runId: run.runId }
  }

  async replyApproval(body) {
    this.assertReady()
    const approval = this.pendingApprovals.get(body.approvalId)
    if (!approval || approval.conversationId !== body.conversationId || approval.runId !== body.runId || approval.status !== 'pending') {
      throw chatError('STALE_APPROVAL', 'Approval is stale, already answered, or belongs to another run', 409)
    }
    if (!approval.choices.includes(body.decision)) throw chatError('INVALID_DECISION', 'Unsupported approval choice')
    const run = this.findRun(body)
    if (TERMINAL.has(run.status)) throw chatError('STALE_APPROVAL', 'Run has ended', 409)
    // Mark before sending: a synchronous resolved event must not be overwritten.
    approval.status = 'replySent'
    try { this.respond(approval.rpcId, { decision: body.decision }) } catch (error) {
      approval.status = 'pending'
      throw error
    }
    const pending = run.pendingApprovals.find(item => item.approvalId === approval.approvalId)
    if (pending) pending.status = 'replySent'
    this.seq++
    return { accepted: true, approvalId: approval.approvalId, conversationId: run.conversationId, runId: run.runId, status: 'replySent' }
  }

  handleNotification(message) {
    const event = cleanNotification(message.method, message.params)
    if (!event) return Promise.resolve()
    return this.enqueue(event)
  }

  handleServerRequest(message) {
    const p = message.params || {}
    if (message.method === 'item/tool/call') {
      if (typeof p.tool !== 'string' || typeof p.callId !== 'string' || JSON.stringify(p.arguments ?? {}).length > 65536) {
        this.respond(message.id, null, { code: -32602, message: 'Invalid dynamic tool request' })
        return Promise.resolve()
      }
      return this.enqueue({ method: 'dynamic', rpcId: message.id, threadId: idText(p.threadId), turnId: idText(p.turnId), callId: p.callId, tool: p.tool, namespace: p.namespace || null, arguments: p.arguments })
    }
    const event = {
      method: 'approval', nativeMethod: message.method, rpcId: message.id,
      threadId: idText(p.threadId), turnId: idText(p.turnId), itemId: idText(p.itemId),
      reason: publicText(p.reason, 2000), command: publicText(p.command, 2000), cwd: publicText(p.cwd, 2000),
      nativeKind: p.kind ?? 'command',
      isNetworkApproval: p.networkApprovalContext != null,
      networkApprovalContext: publicNetworkContext(p.networkApprovalContext),
      choices: Array.isArray(p.availableDecisions) ? p.availableDecisions.filter(value => ['accept', 'decline', 'cancel'].includes(value)) : ['accept', 'decline', 'cancel'],
    }
    return this.enqueue(event)
  }

  enqueue(event) {
    const pending = this.pendingStarts.get(event.threadId) || this.pendingResumes.get(event.threadId)
    if (pending) {
      if (pending.buffer.length < 512) pending.buffer.push(event)
      else {
        this.truncated = true
        if (event.method === 'turn/completed' || event.method === 'item/completed') {
          const expendable = pending.buffer.findIndex(entry => entry.method.endsWith('/delta'))
          pending.buffer.splice(expendable < 0 ? 0 : expendable, 1)
          pending.buffer.push(event)
        } else if (event.method === 'approval' || event.method === 'dynamic') this.respond(event.rpcId, null, { code: -32000, message: 'Bridge event buffer is full' })
      }
      return Promise.resolve()
    }
    const epoch = this.epoch
    this.queue = this.queue.then(() => epoch === this.epoch ? this.apply(event) : undefined).catch(() => {
      const run = this.runs.get(runKey(event.threadId, event.turnId))
      if (run) {
        run.error = publicError('Bridge could not process a Codex event', 'EVENT_PROCESSING_FAILED')
        this.emit(run, 'run.unavailable', { status: run.status, error: run.error })
      }
    })
    return this.queue
  }

  async apply(event) {
    if (event.method === 'serverRequest/resolved') {
      for (const [id, approval] of this.pendingApprovals) if (approval.rpcId === event.requestId && approval.conversationId === event.threadId) {
        this.pendingApprovals.delete(id)
        const run = this.runs.get(runKey(approval.conversationId, approval.runId))
        if (run) { run.pendingApprovals = run.pendingApprovals.filter(a => a.approvalId !== id); this.emit(run, 'approval.resolved', { approvalId: id }) }
      }
      return
    }
    const run = this.ensureRun(event.threadId, event.turnId)
    if (!run) {
      if (event.method === 'approval' || event.method === 'dynamic') this.respond(event.rpcId, null, { code: -32601, message: 'No matching EG-Desk run' })
      return
    }
    if (event.method === 'approval') return this.receiveApproval(run, event)
    if (event.method === 'dynamic') {
      if (run.executionPolicy?.mode === READ_ONLY_QA && (event.namespace || !['egdesk_list_context', 'egdesk_read_source'].includes(event.tool))) {
        this.respond(event.rpcId, null, { code: -32601, message: 'Read-only QA does not expose this dynamic tool' })
        return
      }
      const provider = this.threadToolOwners.get(run.conversationId)?.get(toolKey(event.namespace, event.tool))
      if (!provider?.dispatch) this.respond(event.rpcId, null, { code: -32601, message: 'Unsupported dynamic tool' })
      else this.dispatchToolProvider(provider, run, event)
      return
    }
    if (event.method === 'turn/completed') return this.finish(run, event.turn)
    // Item completion can be delivered asynchronously after the turn metadata.
    // Keep its authoritative public item without reopening or re-running the turn.
    if (event.method === 'item/completed') return this.applyItem(run, { ...event.item, completionConfirmed: true }, true)
    if (TERMINAL.has(run.status)) return
    switch (event.method) {
      case 'turn/started': return
      case 'thread/tokenUsage/updated': run.contextUsage = { ...event.usage, deliveryDebt: 0 }; this.seq++; return
      case 'item/started': return this.applyItem(run, event.item, false)
      case 'item/agentMessage/delta': return this.messageDelta(run, event.itemId, event.delta)
      case 'turn/plan/updated': {
        this.put(run, 'activities', { id: `${run.runId}:plan`, kind: 'plan', status: 'inProgress', title: 'Plan', detail: { explanation: event.explanation, plan: event.plan }, sourceRefs: [] })
        this.emit(run, 'plan.updated', { explanation: event.explanation, plan: event.plan })
        return
      }
      case 'item/plan/delta': {
        const old = run.activities.find(a => a.id === event.itemId)
        const activity = { id: event.itemId, kind: 'plan', status: 'inProgress', title: 'Plan', detail: { text: publicText((old?.detail?.text || '') + event.delta) }, sourceRefs: [] }
        this.put(run, 'activities', activity)
        this.emit(run, 'plan.updated', { itemId: event.itemId, text: activity.detail.text }, event.itemId)
        return
      }
      case 'item/reasoning/summaryTextDelta': {
        const old = run.activities.find(a => a.id === event.itemId)
        const key = `${run.answerId}/summary:${event.itemId}`
        const raw = ((this.rawMessages.get(key) || '') + event.delta).slice(0, 4000)
        this.rawMessages.set(key, raw)
        const text = publicText(raw.replace(/\S+$/, ''), 4000)
        this.put(run, 'activities', { id: event.itemId, kind: 'summary', status: 'inProgress', title: 'Summary', detail: { text }, sourceRefs: [] })
        const previous = old?.detail?.text || ''
        this.emit(run, 'summary.delta', { text, delta: text.startsWith(previous) ? text.slice(previous.length) : '', itemId: event.itemId }, event.itemId)
        return
      }
      case 'error': run.error = event.error; this.seq++; return
    }
  }

  receiveApproval(run, event) {
    if (run.executionPolicy?.mode === READ_ONLY_QA) {
      // A QA turn never grants an interactive escalation, even if native
      // unexpectedly asks despite approvalPolicy=never.
      const supported = ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(event.nativeMethod)
      if (supported) this.respond(event.rpcId, { decision: 'decline' })
      else this.respond(event.rpcId, null, { code: -32601, message: 'Read-only QA has no interactive approval capability' })
      run.error = publicError('Native read-only QA requested an approval; it was declined', 'QA_SCOPE_VIOLATION')
      this.emit(run, 'run.unavailable', { status: run.status, error: run.error })
      void this.request('turn/interrupt', { threadId: run.conversationId, turnId: run.runId }).catch(() => {})
      return
    }
    const kinds = { 'item/commandExecution/requestApproval': 'commandExecution', 'item/fileChange/requestApproval': 'fileChange' }
    const kind = kinds[event.nativeMethod]
    if (!kind || !event.choices.length || TERMINAL.has(run.status)) {
      this.respond(event.rpcId, null, { code: -32601, message: 'This interactive request is not supported by EG-Desk' })
      run.error = publicError('Codex requested an unsupported interaction; no permission was granted', 'UNSUPPORTED_INTERACTION')
      this.emit(run, 'run.unavailable', { status: run.status, error: run.error })
      return
    }
    const approvalId = `${this.streamId}:${this.epoch}:${typeof event.rpcId}:${event.rpcId}`
    if (this.pendingApprovals.has(approvalId)) return
    if (this.pendingApprovals.size >= MAX_ITEMS) {
      this.respond(event.rpcId, null, { code: -32000, message: 'Too many pending approval requests' })
      return
    }
    const activity = run.activities.find(a => a.id === event.itemId)
    const command = event.command || activity?.detail?.command
    const cwd = event.cwd || activity?.detail?.cwd
    let acceptDisabledReason = null
    if (event.isNetworkApproval && !event.networkApprovalContext) acceptDisabledReason = 'Network target or protocol is missing or unsupported.'
    else if (kind === 'commandExecution' && event.nativeKind !== 'command') acceptDisabledReason = 'This terminal-input approval type is not supported.'
    else if (kind === 'commandExecution' && !event.isNetworkApproval && !command) acceptDisabledReason = 'Command details are unavailable.'
    const choices = acceptDisabledReason ? event.choices.filter(choice => choice !== 'accept') : event.choices
    if (!choices.length) {
      this.respond(event.rpcId, null, { code: -32601, message: 'Approval target cannot be safely displayed' })
      run.error = publicError('Approval target is unavailable; no permission was granted', 'UNSUPPORTED_APPROVAL_TARGET')
      this.emit(run, 'run.unavailable', { status: run.status, error: run.error })
      return
    }
    const networkReason = event.networkApprovalContext
      ? `Network access: ${event.networkApprovalContext.protocol} ${event.networkApprovalContext.host} (this request).`
      : ''
    const pending = {
      approvalId, kind, status: 'pending', choices, itemId: event.itemId,
      scope: 'request',
      networkApprovalContext: event.networkApprovalContext,
      ...(acceptDisabledReason ? { acceptDisabledReason } : {}),
      reason: [networkReason, event.reason, acceptDisabledReason].filter(Boolean).join('\n'),
      ...(command ? { command } : {}), ...(cwd ? { cwd } : {}),
      paths: activity?.detail?.changes?.map(change => change.path) || activity?.sourceRefs.map(ref => ref.target.path) || [],
    }
    this.pendingApprovals.set(approvalId, { ...pending, rpcId: event.rpcId, conversationId: run.conversationId, runId: run.runId })
    run.pendingApprovals.push(pending)
    this.emit(run, 'approval.required', pending, event.itemId)
  }

  messageDelta(run, itemId, delta) {
    let message = run.messages.find(m => m.id === itemId)
    if (message?.completionConfirmed) return
    if (!message) {
      message = { id: itemId, messageId: itemId, clientId: null, role: 'assistant', text: '', phase: null, status: 'streaming', completionConfirmed: false, localMessageId: run.localRunId ? localId('msg', run.localRunId, itemId) : null, createdAt: this.now() }
      this.put(run, 'messages', message)
      this.emit(run, 'message.started', { ...message }, itemId)
    }
    message.status = 'streaming'
    const key = `${run.answerId}/${itemId}`
    const combined = (this.rawMessages.get(key) ?? message.text) + delta
    const raw = combined.slice(0, MAX_PUBLIC_EVENT_TEXT)
    this.rawMessages.set(key, raw)
    if (combined.length > MAX_PUBLIC_EVENT_TEXT) run.truncated = true
    // Retain an unfinished token across deltas so split credentials are redacted
    // before they reach SSE. Completed items flush their authoritative text.
    const safe = publicText(raw.replace(/\S+$/, ''), MAX_PUBLIC_EVENT_TEXT)
    const previous = this.visibleMessages.get(key) || ''
    if (!safe.startsWith(previous)) return
    const addition = safe.slice(previous.length)
    if (!addition) return
    this.visibleMessages.set(key, safe)
    message.text = safe.slice(0, MAX_TEXT)
    if (safe.length > MAX_TEXT) { run.truncated = true; message.projectionTruncated = true }
    this.emit(run, 'message.delta', { messageId: itemId, delta: addition, ...(safe.length > MAX_TEXT ? { projectionTruncated: true } : {}) }, itemId)
    this.emitLegacy({ type: 'assistant-delta', conversationId: run.conversationId, messageId: run.answerId, delta: addition })
  }

  async applyItem(run, item, completed, announce = true) {
    const epoch = this.epoch
    if (item.type === 'agentMessage' || item.type === 'userMessage') {
      const existing = run.messages.find(m => m.id === item.id)
      const assistant = item.type === 'agentMessage'
      // Only the live item/completed handler can set this flag. safeItem strips
      // arbitrary history fields, so history cannot manufacture completion proof.
      if (assistant && existing?.completionConfirmed && !item.completionConfirmed) return
      run.truncated ||= Boolean(item.truncated) || Boolean(assistant && item.text.length > MAX_TEXT)
      const message = {
        id: item.id, messageId: item.id, clientId: assistant ? null : (item.clientId || null), role: assistant ? 'assistant' : 'user',
        text: publicText(item.text), phase: item.phase || null, status: completed ? 'complete' : 'streaming',
        localMessageId: assistant ? (run.localRunId ? localId('msg', run.localRunId, item.id) : null)
          : item.clientId === run.requestId ? run.localMessageId || null : null,
        createdAt: existing?.createdAt || this.now(),
        ...(assistant && item.text.length > MAX_TEXT ? { projectionTruncated: true } : {}),
        ...(assistant ? { completionConfirmed: item.completionConfirmed === true } : {}),
      }
      if (assistant && !completed) {
        const key = `${run.answerId}/${item.id}`
        const retained = this.rawMessages.get(key) ?? existing?.text ?? ''
        const incoming = item.text || ''
        // A newer partial snapshot can extend received text; an older/summary
        // snapshot must not shorten or replace it. Seed the next delta's prefix.
        const raw = incoming.startsWith(retained) ? incoming : retained
        this.rawMessages.set(key, raw)
        message.text = publicText(raw, MAX_TEXT)
      } else if (!completed && existing?.text) message.text = existing.text
      this.put(run, 'messages', message)
      if (assistant && announce) {
        if (!existing) this.emit(run, 'message.started', { ...message }, item.id)
        if (completed) {
          const finalText = publicText(item.text, item.text.length)
          const previousText = this.visibleMessages.get(`${run.answerId}/${item.id}`) || existing?.text || ''
          if (finalText.startsWith(previousText) && finalText.length > previousText.length) {
            const delta = finalText.slice(previousText.length)
            this.emit(run, 'message.delta', { messageId: item.id, delta }, item.id)
            this.emitLegacy({ type: 'assistant-delta', conversationId: run.conversationId, messageId: run.answerId, delta })
          }
          this.emit(run, 'message.completed', { ...message, text: finalText, ...(finalText.length > MAX_TEXT ? { projectionTruncated: true } : {}) }, item.id)
        }
      }
      if (completed) {
        this.rawMessages.delete(`${run.answerId}/${item.id}`)
        this.visibleMessages.delete(`${run.answerId}/${item.id}`)
        if (!assistant && item.clientId === run.requestId && this.store && run.clientThreadId && run.localMessageId) {
          try { this.store.bindNative({ clientThreadId: run.clientThreadId, localMessageId: run.localMessageId, messageId: item.id }) }
          catch { this.storeHealthy = false }
        }
        if (assistant) await this.collectArtifacts(run, item, announce)
      }
      return
    }
    run.truncated ||= Boolean(item.truncated)
    let activity = { id: item.id, kind: item.type, status: completed ? 'completed' : 'inProgress', title: item.type, detail: {}, sourceRefs: [] }
    if (item.type === 'commandExecution') {
      activity = { ...activity, status: item.status, title: item.command || 'Command', detail: { command: item.command, cwd: item.cwd, exitCode: item.exitCode, durationMs: item.durationMs } }
    } else if (item.type === 'fileChange') {
      activity.status = item.status
      activity.title = `File changes (${item.changes.length})`
      activity.detail = { changeCount: item.changes.length, changes: [] }
      for (const change of item.changes) {
        if (/^[a-zA-Z][a-zA-Z\d+.-]*:|^\/\//.test(change.path)) continue
        const cwd = this.threads.get(run.conversationId)?.cwd
        const candidate = path.isAbsolute(change.path) ? change.path : cwd ? path.resolve(cwd, change.path) : ''
        if (candidate) activity.detail.changes.push({ path: publicText(candidate, 4096), kind: change.kind })
        const target = await this.verifyFile(candidate)
        if (epoch !== this.epoch) return
        if (target) activity.sourceRefs.push({ type: 'file', target: { path: target }, status: 'available', openable: true })
      }
    } else if (item.type === 'mcpToolCall') {
      activity.status = item.status
      activity.title = `${item.server} / ${item.tool}`
      activity.detail = { server: item.server, tool: item.tool, durationMs: item.durationMs }
    } else if (item.type === 'dynamicToolCall') {
      activity.status = item.status
      activity.title = item.tool
      activity.detail = { tool: item.tool }
    } else if (item.type === 'reasoning') {
      activity.kind = 'summary'
      activity.title = 'Summary'
      activity.detail = { text: publicText(item.summary.join('\n'), 4000) }
      if (completed) this.rawMessages.delete(`${run.answerId}/summary:${item.id}`)
      if (!activity.detail.text) return
    } else if (item.type === 'plan') {
      activity.title = 'Plan'
      activity.detail = { text: item.text }
    } else return
    this.put(run, 'activities', activity)
    if (announce) this.emit(run, completed ? 'activity.completed' : 'activity.started', activity, item.id)
  }

  async collectArtifacts(run, item, announce) {
    const epoch = this.epoch
    for (const link of explicitFileLinks(item.text)) {
      const target = await this.verifyFile(link.path, { artifact: true })
      if (epoch !== this.epoch) return
      if (!target) continue
      const id = `artifact-${createHash('sha256').update(`${run.answerId}\0${target}`).digest('hex').slice(0, 24)}`
      const artifact = {
        id, type: 'file', target: { path: target }, label: link.label || path.basename(target), status: 'available',
        conversationId: run.conversationId, runId: run.runId, answerId: run.answerId, sourceItemId: item.id,
        relation: 'referenced', verifiedAt: this.now(),
      }
      const isNew = !run.artifacts.some(a => a.id === id)
      this.put(run, 'artifacts', artifact)
      if (announce && isNew) this.emit(run, 'artifact.available', artifact, item.id)
    }
  }

  async finish(run, turn) {
    const epoch = this.epoch
    if (TERMINAL.has(run.status) && run.error?.origin !== 'bridge') return
    for (const item of turn.items) await this.applyItem(run, item, true)
    if (epoch !== this.epoch) return
    if (!TERMINAL.has(turn.status)) return
    // A disconnect/interruption may omit item/completed. Retain received public
    // text, but never invent an answer or infer task success from that text.
    for (const message of [...run.messages]) if (message.role === 'assistant' && message.status === 'streaming') {
      const raw = this.rawMessages.get(`${run.answerId}/${message.id}`)
      if (raw !== undefined) await this.applyItem(run, { id: message.id, type: 'agentMessage', text: raw, phase: message.phase }, true)
    }
    if (epoch !== this.epoch) return
    run.status = turn.status
    for (const provider of this.toolProviders) provider.cancelRun?.(run)
    run.stopConfirmed = turn.status === 'interrupted'
    run.error = turn.error
    for (const message of run.messages) if (message.status === 'streaming') {
      message.status = run.status === 'failed' ? 'error' : run.status === 'interrupted' ? 'interrupted' : 'complete'
    }
    run.truncated ||= Boolean(turn.truncated)
    if (turn.itemsView === 'full') run.historyComplete = true
    for (const [id, approval] of this.pendingApprovals) if (approval.conversationId === run.conversationId && approval.runId === run.runId) this.pendingApprovals.delete(id)
    run.pendingApprovals = []
    for (const key of this.rawMessages.keys()) if (key.startsWith(`${run.answerId}/`)) this.rawMessages.delete(key)
    for (const key of this.visibleMessages.keys()) if (key.startsWith(`${run.answerId}/`)) this.visibleMessages.delete(key)
    this.emit(run, 'run.completed', { status: run.status, stopRequested: run.stopRequested, stopConfirmed: run.stopConfirmed, error: run.error })
    if (run.status === 'completed') this.emitLegacy({ type: 'assistant-complete', conversationId: run.conversationId, messageId: run.answerId })
    else this.emitLegacy({ type: 'assistant-error', conversationId: run.conversationId, messageId: run.answerId, error: run.error?.message || 'Codex response was interrupted.' })
  }

  snapshot(conversationId = null) {
    const runs = [...this.runs.values()].filter(run => !conversationId || run.conversationId === conversationId)
    return copy({
      protocolVersion: 2, streamId: this.streamId, seq: this.seq, lastSeq: this.seq,
      connection: this.connection, conversationId,
      localHistoryDurable: Boolean(this.store && this.storeHealthy),
      runs, truncated: this.truncated || runs.some(run => run.truncated),
      historyComplete: (!conversationId || this.threads.has(conversationId)) && !this.truncated
        && !(conversationId ? this.incompleteHistory.has(conversationId) : this.incompleteHistory.size)
        && runs.every(run => run.historyComplete && !run.truncated),
    })
  }
}
