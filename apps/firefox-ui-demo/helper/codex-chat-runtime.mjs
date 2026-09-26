import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'
import { chatError, explicitFileLinks, MAX_TEXT, publicError, publicText, verifyLocalFile } from './codex-chat-values.mjs'

const TERMINAL = new Set(['completed', 'interrupted', 'failed'])
const ITEM_STATUS = new Set(['inProgress', 'completed', 'failed', 'declined'])
const MAX_RUNS = 32
const MAX_ITEMS = 100
const MAX_THREADS = 32
const MAX_REQUESTS = 128
const idText = value => typeof value === 'string' && value.length <= 300 ? value : null
const runKey = (threadId, turnId) => `${threadId}/${turnId}`
const copy = value => JSON.parse(JSON.stringify(value))

// Shared by live events and history. In particular, reasoning.content, raw tool
// input/results, diffs and shell output never enter the retained state or SSE.
function safeItem(item) {
  if (!item || !idText(item.id)) return null
  const base = { id: item.id, type: item.type }
  switch (item.type) {
    case 'agentMessage': return { ...base, text: typeof item.text === 'string' ? item.text.slice(0, MAX_TEXT) : '', phase: ['commentary', 'final_answer'].includes(item.phase) ? item.phase : null, truncated: typeof item.text === 'string' && item.text.length > MAX_TEXT }
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
  if (method === 'serverRequest/resolved') return { ...base, requestId: p.requestId }
  return null
}

export class CodexChatRuntime {
  constructor({ request, respond, emit = () => {}, emitLegacy = () => {}, verifyFile = verifyLocalFile, now = Date.now }) {
    Object.assign(this, { request, respond, emitEvent: emit, emitLegacy, verifyFile, now })
    this.streamId = randomUUID()
    this.seq = 0
    this.connection = 'offline'
    this.epoch = 0
    this.threads = new Map()
    this.loadedThreads = new Set()
    this.runs = new Map()
    this.rawMessages = new Map()
    this.pendingStarts = new Map()
    this.pendingResumes = new Map()
    this.pendingApprovals = new Map()
    this.requests = new Map()
    this.locks = new Set()
    this.uncertainThreads = new Set()
    this.incompleteHistory = new Set()
    this.truncated = false
    this.queue = Promise.resolve()
  }

  assertReady() {
    if (this.connection !== 'ready') throw chatError('BRIDGE_OFFLINE', 'Codex app-server is offline', 503)
  }

  emit(run, event, details = {}, itemId) {
    this.emitEvent({
      type: 'chat.event', v: 2, provider: 'codex', event,
      streamId: this.streamId, seq: ++this.seq, ts: this.now(),
      requestId: run.requestId, clientThreadId: run.clientThreadId,
      conversationId: run.conversationId, runId: run.runId, answerId: run.answerId,
      ...(itemId ? { itemId } : {}), details: copy(details),
    })
  }

  reset() {
    this.epoch++
    this.streamId = randomUUID()
    this.seq = 0
    this.threads.clear()
    this.loadedThreads.clear()
    this.runs.clear()
    this.rawMessages.clear()
    this.pendingApprovals.clear()
    this.pendingStarts.clear()
    this.pendingResumes.clear()
    this.requests.clear()
    this.uncertainThreads.clear()
    this.incompleteHistory.clear()
    this.truncated = false
  }

  setConnection(ready, { processLost = false } = {}) {
    this.connection = ready ? 'ready' : 'offline'
    if (ready) return
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
      this.emitLegacy({ type: 'assistant-error', conversationId: run.conversationId, messageId: run.answerId, error: run.error.message })
    }
    this.pendingApprovals.clear()
    this.rawMessages.clear()
  }

  trimRuns() {
    while (this.runs.size > MAX_RUNS) {
      const entry = [...this.runs].find(([, run]) => TERMINAL.has(run.status))
      if (!entry) break
      this.runs.delete(entry[0])
      for (const key of this.rawMessages.keys()) if (key.startsWith(`${entry[0]}/`)) this.rawMessages.delete(key)
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
    run = {
      conversationId: threadId, runId: turnId, answerId: key,
      requestId: context?.requestId || null,
      clientThreadId: context?.clientThreadId || this.threads.get(threadId).clientThreadId,
      status: 'inProgress', stopRequested: false, stopConfirmed: false,
      messages: [], activities: [], artifacts: [], pendingApprovals: [], error: null,
      createdAt: this.now(), truncated: false, historyComplete: true,
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
    this.assertReady()
    if (typeof body.message !== 'string' || !body.message.trim()) throw chatError('EMPTY_MESSAGE', 'Message is required')
    if (body.message.length > MAX_TEXT) throw chatError('MESSAGE_TOO_LONG', `Message exceeds ${MAX_TEXT} characters`)
    const requestId = idText(body.requestId) || randomUUID()
    const fingerprint = createHash('sha256').update(JSON.stringify({
      message: body.message, conversationId: body.conversationId, clientThreadId: body.clientThreadId || body.thread?.id,
      cwd: body.cwd, model: body.model, effort: body.effort, profileEnabled: body.profileEnabled === true,
      systemPrompt: body.profileEnabled === true ? body.systemPrompt : undefined,
    })).digest('hex')
    const previous = this.requests.get(requestId)
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw chatError('REQUEST_CONFLICT', 'requestId was already used for another request', 409)
      return previous.promise
    }
    const clientThreadId = idText(body.clientThreadId) || idText(body.thread?.id)
    const conversationId = idText(body.conversationId)
    if (body.conversationId != null && !conversationId) throw chatError('INVALID_THREAD_ID', 'Invalid conversationId')
    const lock = conversationId || `client:${clientThreadId || 'legacy'}`
    if (this.locks.has(lock)) throw chatError('RUN_IN_PROGRESS', 'A request is already starting for this conversation', 409)
    if (this.locks.size >= MAX_RUNS) throw chatError('RUNTIME_BUSY', 'Too many pending requests', 429)
    if (!conversationId && clientThreadId && [...this.threads.values()].some(t => t.clientThreadId === clientThreadId)) {
      throw chatError('CONVERSATION_REQUIRED', 'Continue this conversation using its returned conversationId', 409)
    }
    this.locks.add(lock)
    const record = { fingerprint, settled: false, promise: null }
    record.promise = this.startTurn(body, { requestId, clientThreadId, conversationId }).finally(() => {
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
    if (body.cwd !== undefined) {
      if (typeof body.cwd !== 'string' || !path.isAbsolute(body.cwd) || body.cwd.includes('\0')) throw chatError('INVALID_CWD', 'cwd must be an absolute local path')
      options.cwd = body.cwd
    }
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

  async startTurn(body, context) {
    const epoch = this.epoch
    const overrides = this.threadOverrides(body)
    const effort = body.effort
    // CLI 0.156.1 defines ReasoningEffort as a non-empty model-advertised string.
    if (effort !== undefined && (!idText(effort) || !effort.trim())) throw chatError('INVALID_EFFORT', 'Invalid reasoning effort')
    let cid = context.conversationId
    if (cid) {
      if (this.uncertainThreads.has(cid)) throw chatError('RESUME_REQUIRED', 'Resume the conversation before retrying an uncertain turn', 409)
      if (!this.loadedThreads.has(cid) || body.profileEnabled === true) await this.restoreThread(cid, context.clientThreadId, overrides)
    } else {
      const result = await this.request('thread/start', overrides)
      if (epoch !== this.epoch) throw chatError('ACCOUNT_CHANGED', 'Codex account changed', 409)
      cid = result?.thread?.id
      this.rememberThread(cid, result, context.clientThreadId)
    }
    if (epoch !== this.epoch) throw chatError('ACCOUNT_CHANGED', 'Codex account changed', 409)
    if ([...this.runs.values()].some(run => run.conversationId === cid && !TERMINAL.has(run.status))) {
      throw chatError('RUN_IN_PROGRESS', 'This conversation already has an active or unreconciled turn', 409)
    }
    if ([...this.runs.values()].filter(run => !TERMINAL.has(run.status)).length >= MAX_RUNS) throw chatError('RUNTIME_BUSY', 'Too many active turns', 429)
    const pending = { ...context, conversationId: cid, buffer: [] }
    this.pendingStarts.set(cid, pending)
    try {
      const result = await this.request('turn/start', {
        threadId: cid,
        input: [{ type: 'text', text: body.message, text_elements: [] }],
        clientUserMessageId: context.requestId,
        ...(overrides.cwd ? { cwd: overrides.cwd } : {}),
        ...(overrides.model ? { model: overrides.model } : {}),
        ...(effort !== undefined ? { effort } : {}),
      })
      if (epoch !== this.epoch) throw chatError('ACCOUNT_CHANGED', 'Codex account changed', 409)
      const run = this.ensureRun(cid, result?.turn?.id, context)
      if (!run) throw chatError('INVALID_TURN_RESPONSE', 'Codex did not return a turn ID', 502)
      // Notifications can precede the RPC response. Only the returned turn ID
      // may inherit this request's correlation; other turns remain unclaimed.
      while (pending.buffer.length) await this.apply(pending.buffer.shift())
      if (TERMINAL.has(result.turn.status) && !TERMINAL.has(run.status)) await this.finish(run, safeTurn(result.turn))
      return { accepted: true, conversationId: cid, requestId: context.requestId, runId: run.runId, answerId: run.answerId }
    } catch (error) {
      // A native JSON-RPC error is a definite rejection. A lost/ambiguous reply
      // needs explicit reconciliation before another attempt can start a turn.
      if (epoch === this.epoch && typeof error.code !== 'number') this.uncertainThreads.add(cid)
      throw error
    } finally { if (this.pendingStarts.get(cid) === pending) this.pendingStarts.delete(cid) }
  }

  async restoreThread(cid, clientThreadId, overrides = {}) {
    const epoch = this.epoch
    const pending = { buffer: [] }
    this.pendingResumes.set(cid, pending)
    try {
      await this.queue
      // Never fall back to thread/start if a historical ID is invalid or unavailable.
      const result = await this.request('thread/resume', { threadId: cid, ...overrides })
      if (epoch !== this.epoch) throw chatError('CONTEXT_CHANGED', 'Codex connection or account changed', 409)
      if (result?.thread?.id !== cid) throw chatError('THREAD_MISMATCH', 'Codex resumed a different thread', 502)
      this.rememberThread(cid, result, clientThreadId)
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
        for (const item of turn.items) await this.applyItem(run, item, true, false)
        if (epoch !== this.epoch) throw chatError('CONTEXT_CHANGED', 'Codex connection or account changed', 409)
        run.status = turn.status
        run.stopConfirmed = turn.status === 'interrupted'
        run.error = turn.error
        run.truncated ||= Boolean(turn.truncated)
        run.historyComplete = retainedComplete || turn.itemsView === 'full'
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
    this.assertReady()
    const epoch = this.epoch
    const cid = idText(body.conversationId)
    if (!cid) throw chatError('MISSING_THREAD_ID', 'conversationId is required')
    if (this.locks.has(cid) || this.pendingStarts.has(cid)) throw chatError('RUN_STARTING', 'Conversation request is still starting', 409)
    this.locks.add(cid)
    try {
      await this.restoreThread(cid, idText(body.clientThreadId))
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
    const event = {
      method: 'approval', nativeMethod: message.method, rpcId: message.id,
      threadId: idText(p.threadId), turnId: idText(p.turnId), itemId: idText(p.itemId),
      reason: publicText(p.reason, 2000), command: publicText(p.command, 2000), cwd: publicText(p.cwd, 2000),
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
        } else if (event.method === 'approval') this.respond(event.rpcId, null, { code: -32000, message: 'Bridge event buffer is full' })
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
      if (event.method === 'approval') this.respond(event.rpcId, null, { code: -32601, message: 'No matching EG-Desk run' })
      return
    }
    if (event.method === 'approval') return this.receiveApproval(run, event)
    if (event.method === 'turn/completed') return this.finish(run, event.turn)
    if (TERMINAL.has(run.status)) return
    switch (event.method) {
      case 'turn/started': return
      case 'item/started': return this.applyItem(run, event.item, false)
      case 'item/completed': return this.applyItem(run, event.item, true)
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
    const pending = {
      approvalId, kind, status: 'pending', choices: event.choices, itemId: event.itemId,
      reason: event.reason, ...(command ? { command } : {}), ...(cwd ? { cwd } : {}),
      paths: activity?.detail?.changes?.map(change => change.path) || activity?.sourceRefs.map(ref => ref.target.path) || [],
    }
    this.pendingApprovals.set(approvalId, { ...pending, rpcId: event.rpcId, conversationId: run.conversationId, runId: run.runId })
    run.pendingApprovals.push(pending)
    this.emit(run, 'approval.required', pending, event.itemId)
  }

  messageDelta(run, itemId, delta) {
    let message = run.messages.find(m => m.id === itemId)
    if (!message) {
      message = { id: itemId, messageId: itemId, clientId: null, role: 'assistant', text: '', phase: null, status: 'streaming' }
      this.put(run, 'messages', message)
      this.emit(run, 'message.started', { ...message }, itemId)
    }
    message.status = 'streaming'
    const key = `${run.answerId}/${itemId}`
    const combined = (this.rawMessages.get(key) ?? message.text) + delta
    const raw = combined.slice(0, MAX_TEXT)
    this.rawMessages.set(key, raw)
    if (combined.length > MAX_TEXT) run.truncated = true
    // Retain an unfinished token across deltas so split credentials are redacted
    // before they reach SSE. Completed items flush their authoritative text.
    const safe = publicText(raw.replace(/\S+$/, ''))
    if (!safe.startsWith(message.text)) return
    const addition = safe.slice(message.text.length)
    if (!addition) return
    message.text = safe
    this.emit(run, 'message.delta', { messageId: itemId, delta: addition }, itemId)
    this.emitLegacy({ type: 'assistant-delta', conversationId: run.conversationId, messageId: run.answerId, delta: addition })
  }

  async applyItem(run, item, completed, announce = true) {
    const epoch = this.epoch
    run.truncated ||= Boolean(item.truncated)
    if (item.type === 'agentMessage' || item.type === 'userMessage') {
      const existing = run.messages.find(m => m.id === item.id)
      const assistant = item.type === 'agentMessage'
      const message = {
        id: item.id, messageId: item.id, clientId: assistant ? null : (item.clientId || null), role: assistant ? 'assistant' : 'user',
        text: publicText(item.text), phase: item.phase || null, status: completed ? 'complete' : 'streaming',
      }
      // item/started can arrive after the first delta; do not erase streamed text.
      if (!completed && existing?.text) message.text = existing.text
      this.put(run, 'messages', message)
      if (assistant && announce) {
        if (!existing) this.emit(run, 'message.started', { ...message }, item.id)
        if (completed) {
          const previousText = existing?.text || ''
          if (message.text.startsWith(previousText) && message.text.length > previousText.length) {
            const delta = message.text.slice(previousText.length)
            this.emit(run, 'message.delta', { messageId: item.id, delta }, item.id)
            this.emitLegacy({ type: 'assistant-delta', conversationId: run.conversationId, messageId: run.answerId, delta })
          }
          this.emit(run, 'message.completed', { ...message }, item.id)
        }
      }
      if (completed) {
        this.rawMessages.delete(`${run.answerId}/${item.id}`)
        if (assistant) await this.collectArtifacts(run, item, announce)
      }
      return
    }
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
    this.emit(run, 'run.completed', { status: run.status, stopRequested: run.stopRequested, stopConfirmed: run.stopConfirmed, error: run.error })
    if (run.status === 'completed') this.emitLegacy({ type: 'assistant-complete', conversationId: run.conversationId, messageId: run.answerId })
    else this.emitLegacy({ type: 'assistant-error', conversationId: run.conversationId, messageId: run.answerId, error: run.error?.message || 'Codex response was interrupted.' })
  }

  snapshot(conversationId = null) {
    const runs = [...this.runs.values()].filter(run => !conversationId || run.conversationId === conversationId)
    return copy({
      protocolVersion: 2, streamId: this.streamId, seq: this.seq, lastSeq: this.seq,
      connection: this.connection, conversationId,
      runs, truncated: this.truncated || runs.some(run => run.truncated),
      historyComplete: (!conversationId || this.threads.has(conversationId)) && !this.truncated
        && !(conversationId ? this.incompleteHistory.has(conversationId) : this.incompleteHistory.size)
        && runs.every(run => run.historyComplete && !run.truncated),
    })
  }
}
