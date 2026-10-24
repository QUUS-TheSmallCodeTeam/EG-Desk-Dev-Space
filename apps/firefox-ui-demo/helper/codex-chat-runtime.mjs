import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'
import { chatError, explicitFileLinks, MAX_TEXT, publicError, publicNetworkContext, publicText, validateChatCwd, verifyLocalFile } from './codex-chat-values.mjs'
import { READ_ONLY_QA, BROWSER_BOUNDED, FIXTURE_BROWSER_QA, requestedExecutionPolicy, loadQaThreadOverrides, verifyQaNativeThread, verifyQaMcpIsolation, QA_TURN_OVERRIDES } from './codex-chat-execution-policy.mjs'
import { classifyPublicToolError } from './codex-tool-errors.mjs'
import { specManifestEntries, verifiedManifestOwners } from './codex-native-tool-manifest.mjs'
import { nativeQaCommandReceipt, validateQaCommandNonce, validateQaOutputMarkers } from './codex-qa-command-receipt.mjs'
import { MAX_COMPOSED } from './egdesk-profile-store.mjs'
import { browserRefusal, ceilingAllowsBrowserTool, ceilingApprovalRefusal, ceilingBrowserSelection, ceilingNarrows, ceilingReportNotices, CEILING_MESSAGES, effectiveToolCeiling, liveBrowserSelected, loadCeilingThreadOverrides, mergeCeilingOverrides, recordedToolCeiling, verifyCeilingNativeThread } from './codex-chat-tool-ceiling.mjs'
import { engineError } from './engine-adapter.mjs'
import { createCodexEngineAdapter } from './codex-engine-adapter.mjs'
import { EngineRegistry } from './engine-registry.mjs'
import { assertModelSelection } from './codex-model-catalog.mjs'
import { mcpControlKind, nativeMcpServerKind, strongerControlKind } from './codex-inherited-mcp.mjs'
import { DEFAULT_COMPUTER_CONTROL_POLICY, loadComputerControlOffOverrides, normalizeComputerControlPolicy, verifyComputerControlOff } from './codex-computer-control.mjs'

const TERMINAL = new Set(['completed', 'interrupted', 'failed'])
const ITEM_STATUS = new Set(['inProgress', 'completed', 'failed', 'declined'])
const MAX_RUNS = 32
const MAX_ITEMS = 100
const MAX_THREADS = 32
const MAX_REQUESTS = 128
const MAX_PUBLIC_EVENT_TEXT = 8 * 1024 * 1024
const BOUNDED_MODES = [READ_ONLY_QA, BROWSER_BOUNDED, FIXTURE_BROWSER_QA]
const USER_INPUT_METHOD = 'item/tool/requestUserInput'
const MAX_INPUT_QUESTIONS = 8
const MAX_INPUT_OPTIONS = 12
const MAX_INPUT_ANSWER = 4000
const MAX_SUBAGENTS = 32
const COLLAB_TOOLS = new Set(['spawnAgent', 'sendInput', 'resumeAgent', 'wait', 'closeAgent', 'sendMessage', 'followupTask', 'interruptAgent', 'listAgents'])
const COLLAB_STATUS = new Set(['inProgress', 'completed', 'failed', 'interrupted'])
const REVIVE_TOOLS = new Set(['resumeAgent', 'sendInput', 'followupTask'])
const AGENT_STATE = { pendingInit: 'starting', running: 'running', completed: 'completed', errored: 'errored', interrupted: 'interrupted', shutdown: 'closed', notFound: 'notFound' }
const ACTIVITY_STATE = { started: 'running', interacted: 'running', interrupted: 'interrupted', completed: 'completed' }
const SUBAGENT_DONE = new Set(['completed', 'errored', 'interrupted', 'closed', 'notFound'])
// Guarded Browser tools a selected Card with an interaction grant may call.
// Observation alone never unlocks them; same-site, focus and wait budgets are
// enforced again by the Browser provider and the actor.
const BROWSER_INTERACTION_TOOLS = ['egdesk_browser_navigate', 'egdesk_browser_click', 'egdesk_browser_fill', 'egdesk_browser_scroll', 'egdesk_browser_press', 'egdesk_browser_wait']
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
    // controlKind (CU-01): what the server can drive, from its name and plugin
    // id; the plugin id, arguments, results and images are never kept.
    case 'mcpToolCall': return {
      ...base, status: ITEM_STATUS.has(item.status) ? item.status : 'inProgress',
      server: publicText(item.server, 120), tool: publicText(item.tool, 120),
      durationMs: Number.isFinite(item.durationMs) ? item.durationMs : null,
      controlKind: mcpControlKind(nativeMcpServerKind({ name: typeof item.server === 'string' ? item.server : '', pluginId: typeof item.pluginId === 'string' ? item.pluginId : null })),
    }
    case 'dynamicToolCall': return { ...base, status: ITEM_STATUS.has(item.status) ? item.status : 'inProgress', tool: publicText(item.tool, 120) }
    // Native keys agentsStates by model-chosen thread IDs. Never keep that
    // object shape: a key such as "secret" would poison the durable store.
    case 'collabAgentToolCall': {
      const states = item.agentsStates && typeof item.agentsStates === 'object' && !Array.isArray(item.agentsStates) ? Object.entries(item.agentsStates) : []
      const receivers = [...new Set((Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds : []).slice(0, MAX_SUBAGENTS * 2).map(idText).filter(Boolean))]
      return {
        ...base, tool: COLLAB_TOOLS.has(item.tool) ? item.tool : 'unknown',
        status: COLLAB_STATUS.has(item.status) ? item.status : 'inProgress',
        receiverThreadIds: receivers.slice(0, MAX_SUBAGENTS),
        taskPreview: publicText(item.prompt, 160) || null,
        model: idText(item.model) ? publicText(item.model, 120) || null : null,
        agentStates: states.slice(0, MAX_SUBAGENTS * 2).filter(([threadId]) => idText(threadId)).slice(0, MAX_SUBAGENTS)
          .map(([threadId, value]) => ({ threadId, state: AGENT_STATE[value?.status] || 'unknown', message: publicText(value?.message, 500) || null })),
        truncated: receivers.length > MAX_SUBAGENTS || states.length > MAX_SUBAGENTS,
      }
    }
    case 'subAgentActivity': return {
      ...base, agentThreadId: idText(item.agentThreadId), agentPath: publicText(item.agentPath, 120) || null,
      kind: Object.hasOwn(ACTIVITY_STATE, item.kind) ? item.kind : null,
      model: idText(item.model) ? publicText(item.model, 120) || null : null,
    }
    default: return null
  }
}

// Public question copy plus the private original labels. Only an option index
// crosses back from the UI; redacted public labels are never sent to native.
function safeUserInputQuestions(value) {
  if (!Array.isArray(value) || !value.length || value.length > MAX_INPUT_QUESTIONS) return null
  const ids = new Set(), questions = []
  for (const question of value) {
    if (!question || typeof question !== 'object' || !idText(question.id) || ids.has(question.id)) return null
    if (typeof question.header !== 'string' || question.header.length > 200) return null
    if (typeof question.question !== 'string' || !question.question.trim() || question.question.length > 2000) return null
    let options = question.options ?? null
    if (options !== null && (!Array.isArray(options) || options.length > MAX_INPUT_OPTIONS)) return null
    if (options?.length === 0) options = null
    if (options?.some(option => !option || typeof option !== 'object' || typeof option.label !== 'string' || !option.label.trim() || option.label.length > 200 ||
        (option.description != null && (typeof option.description !== 'string' || option.description.length > 1000)))) return null
    ids.add(question.id)
    questions.push({
      questionId: question.id, header: publicText(question.header, 200), question: publicText(question.question, 2000),
      options: options && options.map(option => ({ label: publicText(option.label, 200), description: publicText(option.description, 1000) })),
      allowsOther: Boolean(options), isSecret: question.isSecret === true,
      rawLabels: options && options.map(option => option.label),
    })
  }
  return questions
}

const ordinaryThreadConfig = config => ({ ...(config || {}), features: { ...(config?.features || {}), default_mode_request_user_input: true } })
// CHAT-09 session of a recorded native binding; null for an ordinary thread.
function threadSession(details) {
  const from = details?.forkedFrom
  const forkedFrom = from && typeof from === 'object' && idText(from.conversationId)
    ? { conversationId: from.conversationId, turnId: idText(from.turnId), clientThreadId: idText(from.clientThreadId) } : null
  return details?.stateless === true || forkedFrom ? { stateless: details.stateless === true, forkedFrom } : null
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
  constructor({ request, respond, engines = null, emit = () => {}, emitLegacy = () => {}, verifyFile = verifyLocalFile, now = Date.now, contexts = null, toolProviders = [], expectedProcessConfiguration = null, store = null, requireStore = false, getOwnerKey = () => null, qaReady = () => true, getNativeContractFingerprint = () => null, profiles = null, mcpServerKind = null, computerControlPolicy = null, computerControlStore = null, onComputerControlChange = () => {} }) {
    Object.assign(this, { emitEvent: emit, emitLegacy, verifyFile, now })
    // CU-07/CU-01: the inherited MCP kind of a server name (codex-inherited-mcp
    // kindOf), or null; it can only strengthen an activity row's controlKind.
    this.mcpServerKind = typeof mcpServerKind === 'function' ? mcpServerKind : () => null
    // CU-01 stage 1: whether ordinary Codex threads keep the user's computer
    // control ('inherit') or turn it off ('off'). verified: true after the last
    // ordinary thread under 'off' read back as off, false after a refusal,
    // null when nothing is confirmed (inherit, not checked yet, or a Codex
    // build that cannot report thread features).
    // computerControlStore (egdesk-bridge-settings.mjs) keeps the policy across
    // restarts: { policy: saved policy or null, persisted: whether a choice can
    // be kept, save(policy) → boolean }. With a store the snapshot ends with
    // persisted: whether the current policy is saved for the next start.
    // Policy order: an explicit computerControlPolicy, the saved one, then
    // DEFAULT_COMPUTER_CONTROL_POLICY.
    this.computerControlStore = computerControlStore
    this.computerControl = {
      policy: normalizeComputerControlPolicy(computerControlPolicy ?? computerControlStore?.policy ?? DEFAULT_COMPUTER_CONTROL_POLICY),
      verified: null,
      ...(computerControlStore ? { persisted: computerControlStore.persisted === true } : {}),
    }
    this.onComputerControlChange = onComputerControlChange
    // Engines: an EngineRegistry, or adapters to register. Without either the
    // given request/respond become the Codex adapter, which calls them with
    // the same methods and params as before.
    this.engines = engines instanceof EngineRegistry ? engines : new EngineRegistry()
    if (!(engines instanceof EngineRegistry)) for (const adapter of engines || [createCodexEngineAdapter({ request, respond })]) this.engines.register(adapter)
    const codex = this.engines.get('codex')
    if (typeof codex?.request !== 'function') throw chatError('INVALID_ENGINE_ADAPTER', 'The Codex engine adapter is required', 500)
    // Codex-only escape hatch (config/read, bounded-QA proofs) and responder.
    this.request = codex.request
    this.nativeRespond = codex.respond
    this.threadEngines = new Map()
    // CHAT-09: conversationId → { stateless, forkedFrom } of ordinary threads
    // started without saved history or branched from another conversation.
    this.threadSessions = new Map()
    this.profiles = profiles
    this.dynamicRequestProviders = new Map()
    this.respond = (id, result, error) => {
      if (result && typeof result.success === 'boolean' && Array.isArray(result.contentItems)) {
        const pending = this.dynamicRequestProviders.get(id)
        const engineId = this.runEngine(pending?.run)
        if (!pending || pending.epoch !== this.epochOf(engineId) || this.connectionOf(engineId) !== 'ready' || pending.run.status !== 'inProgress') return false
        this.dynamicRequestProviders.delete(id)
        if (result.success === false) {
          let rawCode = null
          try { rawCode = JSON.parse(result.contentItems[0]?.text)?.error?.code } catch {}
          const failure = classifyPublicToolError({ code: rawCode }, { browser: pending.provider?.providerId === 'egdesk-browser', context: pending.provider === this.contexts })
          result = { success: false, contentItems: [{ type: 'inputText', text: JSON.stringify({ error: failure }) }] }
        }
      }
      return error === undefined ? this.nativeRespond(id, result) : this.nativeRespond(id, result, error)
    }
    this.store = store
    this.requireStore = requireStore
    this.getOwnerKey = getOwnerKey
    this.qaReady = qaReady
    this.getNativeContractFingerprint = getNativeContractFingerprint
    this.storeHealthy = true
    this.expectedProcessConfiguration = expectedProcessConfiguration
    this.contexts = contexts
    this.toolProviders = [...(contexts ? [contexts] : []), ...toolProviders]
    this.threadToolOwners = new Map()
    this.threadToolManifests = new Map()
    this.threadToolManifestStatus = new Map()
    this.browserRegisteredThreads = new Set()
    const providerRuntime = Object.freeze({ emit: (...args) => this.emit(...args), browserRegisteredThreads: this.browserRegisteredThreads, currentEpoch: () => this.epoch })
    for (const provider of this.toolProviders) provider.runtime = provider === contexts ? this : providerRuntime
    this.ownedRuns = new WeakSet()
    this.qaOutputMarkersByRun = new Map()
    this.streamId = randomUUID()
    this.seq = 0
    // Codex connection and epoch keep their original fields (tool providers
    // read this.epoch); other engines keep theirs in engineStates.
    this.connection = 'offline'
    this.epoch = 0
    this.engineStates = new Map()
    this.threads = new Map()
    this.loadedThreads = new Set()
    this.runs = new Map()
    this.rawMessages = new Map()
    this.visibleMessages = new Map()
    this.pendingStarts = new Map()
    this.pendingResumes = new Map()
    this.pendingApprovals = new Map()
    // Separate from approvals: a question carries rpcId and original option
    // labels here only. Answers are never retained anywhere.
    this.pendingUserInputs = new Map()
    this.requests = new Map()
    this.persistedRunStates = new Map()
    this.locks = new Set()
    this.uncertainThreads = new Set()
    this.incompleteHistory = new Set()
    this.truncated = false
    this.queue = Promise.resolve()
  }

  assertReady(engineId = 'codex') {
    if (engineId !== 'codex') {
      if (this.connectionOf(engineId) !== 'ready') throw engineError('ENGINE_UNAVAILABLE', 'This AI engine is offline')
      return
    }
    if (this.connection !== 'ready') throw chatError('BRIDGE_OFFLINE', 'Codex app-server is offline', 503)
  }

  engineState(engineId) {
    let state = this.engineStates.get(engineId)
    if (!state) this.engineStates.set(engineId, state = { connection: 'offline', epoch: 0 })
    return state
  }

  connectionOf(engineId = 'codex') { return engineId === 'codex' ? this.connection : this.engineState(engineId).connection }
  epochOf(engineId = 'codex') { return engineId === 'codex' ? this.epoch : this.engineState(engineId).epoch }

  // Runtime state belongs to one engine: a run by its engine record, a thread
  // by its binding, a `${threadId}/…` key by its thread. Unbound means Codex.
  runEngine(run) { return run?.engine?.id || 'codex' }
  threadEngine(conversationId) { return this.threadEngines.get(conversationId) || 'codex' }
  keyEngine(key) {
    for (const [conversationId, engineId] of this.threadEngines) if (engineId !== 'codex' && key.startsWith(`${conversationId}/`)) return engineId
    return 'codex'
  }

  // The engine a native conversation runs on. Unknown or pre-engine threads are Codex.
  engineOf(conversationId) {
    return this.engines.get(this.threadEngine(conversationId))
  }

  requestedEngine(body) {
    if (body.engineId === undefined || body.engineId === null) return null
    return this.engines.require(body.engineId).id
  }

  // Which engine, version and engine account slot ran a turn; stored with the
  // Run and the native binding. Not the Agent profile (run.profileBinding).
  engineRecord(engineId) {
    const engine = this.engines.get(engineId)
    let row = null
    try { row = engine.describe() } catch {}
    const profile = Array.isArray(row?.profiles) ? row.profiles.find(candidate => candidate?.active === true) : null
    return { id: engine.id, version: idText(row?.version) ? publicText(row.version, 64) : null, engineProfileId: idText(profile?.id) ? profile.id : `${engine.id}-default` }
  }

  assertStore() {
    if (!this.store || !this.storeHealthy) throw chatError('CHAT_STORE_UNAVAILABLE', 'Local chat history is unavailable; no Codex turn can start', 503)
    return this.store
  }

  providerFailure(error, provider) {
    const failure = classifyPublicToolError(error, { browser: provider?.providerId === 'egdesk-browser', context: provider === this.contexts })
    const status = failure.code !== 'TOOL_PROVIDER_FAILED' && Number.isInteger(error?.httpStatus) ? error.httpStatus : 502
    return chatError(failure.code, failure.message, status)
  }

  async callProvider(provider, method, ...args) {
    try { return await provider[method]?.(...args) }
    catch (error) { throw this.providerFailure(error, provider) }
  }

  collectToolSpecs(policy = null, { forManifest = false, browserInteraction = false, toolCeiling = null } = {}) {
    const specs = [], owners = new Map(), selected = [], manifest = []
    for (const [index, provider] of this.toolProviders.entries()) {
      const providerId = provider === this.contexts ? 'egdesk-context-v1' : provider.providerId
      // Ordinary Browser attachments are immutable Context sources, not live
      // actor grants. Keep older persisted Browser manifests verifiable without
      // advertising new uncallable Browser tools on ordinary native threads.
      if (policy === null && providerId === 'egdesk-browser' && !forManifest) continue
      if (this.store && provider.specs && (typeof providerId !== 'string' || !providerId)) throw chatError('INVALID_TOOL_PROVIDER', 'Durable tool providers require a stable identity', 500)
      let offered
      try { offered = provider.specs?.() || [] }
      catch (error) { throw this.providerFailure(error, provider) }
      if (!Array.isArray(offered)) throw chatError('INVALID_TOOL_PROVIDER', 'Tool provider returned an invalid native catalog', 500)
      for (const spec of offered) {
        const contextRead = provider === this.contexts && ['egdesk_list_context', 'egdesk_read_source'].includes(spec?.name)
        const browser = provider.providerId === 'egdesk-browser' && spec?.name?.startsWith('egdesk_browser_')
        if (policy === READ_ONLY_QA && !contextRead && !(browser && spec.name === 'egdesk_browser_observe')) continue
        if (policy === BROWSER_BOUNDED && !contextRead && !(browser && (spec.name === 'egdesk_browser_observe'
          || (browserInteraction && BROWSER_INTERACTION_TOOLS.includes(spec.name))))) continue
        if (policy === FIXTURE_BROWSER_QA && !contextRead && !(browser && ['egdesk_browser_observe', 'egdesk_browser_click', 'egdesk_browser_fill'].includes(spec.name))) continue
        // AGENT-04: a new thread's catalog never offers Browser tools the Agent may not use.
        if (browser && !ceilingAllowsBrowserTool(toolCeiling, spec.name)) continue
        const names = spec?.type === 'function' && typeof spec.name === 'string' ? [toolKey(null, spec.name)]
          : spec?.type === 'namespace' && typeof spec.name === 'string' && Array.isArray(spec.tools)
            ? spec.tools.map(tool => tool?.type === 'function' && typeof tool.name === 'string' ? toolKey(spec.name, tool.name) : null)
            : null
        if (!names?.length || names.some(name => !name || owners.has(name))) throw chatError('INVALID_TOOL_PROVIDER', 'Tool provider has an invalid or conflicting native tool name', 500)
        let entries
        try { entries = specManifestEntries(spec, providerId || `local-provider-${index}`) }
        catch (error) { throw this.providerFailure(error, provider) }
        if (!entries || entries.length !== names.length || entries.some((entry, entryIndex) => entry.key !== names[entryIndex])) throw chatError('INVALID_TOOL_PROVIDER', 'Tool provider has an unverifiable native schema', 500)
        for (const name of names) owners.set(name, provider)
        manifest.push(...entries)
        specs.push(spec)
        if (!selected.includes(provider)) selected.push(provider)
      }
    }
    return { specs, owners, selected, manifest }
  }

  additionalToolContext(preparedProviders) {
    const context = {}
    for (const [provider, prepared] of preparedProviders) {
      if (!prepared) continue
      let entries
      try { entries = provider.additionalContext?.(prepared) }
      catch (error) { throw this.providerFailure(error, provider) }
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
    const engineId = this.runEngine(run)
    const epoch = this.epochOf(engineId)
    const current = () => epoch === this.epochOf(engineId) && this.connectionOf(engineId) === 'ready' && run.status === 'inProgress'
    void Promise.resolve().then(() => current() ? provider.dispatch(run, event) : null).then(response => {
      if (response == null) return
      if (!current()) return
      const valid = typeof response.success === 'boolean' && Array.isArray(response.contentItems) && response.contentItems.length <= 16 &&
        response.contentItems.every(item => item && typeof item === 'object' && (
          (item.type === 'inputText' && typeof item.text === 'string') ||
          (item.type === 'inputImage' && typeof item.imageUrl === 'string') ||
          (item.type === 'inputAudio' && typeof item.audioUrl === 'string')
        )) && JSON.stringify(response).length <= 8 * 1024 * 1024
      if (!valid) throw chatError('INVALID_TOOL_RESPONSE', 'Tool provider returned an invalid native response', 500)
      this.respond(event.rpcId, response)
    }).catch(error => {
      if (!current()) return
      const failure = classifyPublicToolError(error)
      try { this.respond(event.rpcId, { success: false, contentItems: [{ type: 'inputText', text: JSON.stringify({ error: failure }) }] }) } catch {}
      run.error = publicError(failure.message, failure.code)
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
          ...run, status: 'unknown', historyComplete: false, pendingApprovals: [], pendingUserInputs: [],
          ...(Array.isArray(run.subAgents) ? { subAgents: run.subAgents.map(row => SUBAGENT_DONE.has(row?.state) ? row : { ...row, state: 'unknown' }) } : {}),
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
    if (event === 'context.read.failed') {
      const failure = classifyPublicToolError({ code: details.code }, { context: true })
      details = { ...details, code: failure.code, message: failure.message }
    }
    const localMessageId = event.startsWith('message.') && itemId && run.localRunId
      ? localId('msg', run.localRunId, itemId) : null
    const publicEvent = {
      // provider stays 'codex' until the overlay accepts other engines.
      type: 'chat.event', v: 2, provider: 'codex', engineId: this.runEngine(run), event,
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

  // Account change or sign-out of one engine (Codex by default). Other
  // engines' runs, threads and pending requests stay; the event stream
  // restarts, so viewers resync from the snapshot.
  reset(engineId = 'codex') {
    const codex = engineId === 'codex'
    const own = [...this.runs].filter(([, run]) => this.runEngine(run) === engineId)
    if (codex) for (const provider of this.toolProviders) provider.reset?.()
    else for (const [, run] of own) for (const provider of this.toolProviders) try { provider.cancelRun?.(run) } catch {}
    if (codex) this.epoch++
    else this.engineState(engineId).epoch++
    this.streamId = randomUUID()
    this.seq = 0
    const ownThread = conversationId => this.threadEngine(conversationId) === engineId
    for (const map of [this.threads, this.threadToolOwners, this.threadToolManifests, this.threadToolManifestStatus, this.threadSessions, this.pendingStarts, this.pendingResumes]) {
      for (const conversationId of [...map.keys()]) if (ownThread(conversationId)) map.delete(conversationId)
    }
    for (const set of [this.browserRegisteredThreads, this.loadedThreads, this.uncertainThreads, this.incompleteHistory]) {
      for (const conversationId of [...set]) if (ownThread(conversationId)) set.delete(conversationId)
    }
    this.ownedRuns = new WeakSet([...this.runs.values()].filter(run => this.runEngine(run) !== engineId && this.ownedRuns.has(run)))
    for (const [key] of own) this.runs.delete(key)
    for (const map of [this.qaOutputMarkersByRun, this.rawMessages, this.visibleMessages, this.persistedRunStates]) {
      for (const key of [...map.keys()]) if (this.keyEngine(key) === engineId) map.delete(key)
    }
    this.forgetPendingRequests(engineId)
    for (const [requestId, record] of [...this.requests]) if ((record.engineId || 'codex') === engineId) this.requests.delete(requestId)
    if (!this.runs.size) this.truncated = false
  }

  forgetPendingRequests(engineId) {
    for (const map of [this.pendingApprovals, this.pendingUserInputs]) {
      for (const [id, pending] of [...map]) if (this.threadEngine(pending.conversationId) === engineId) map.delete(id)
    }
    for (const [id, pending] of [...this.dynamicRequestProviders]) if (this.runEngine(pending.run) === engineId) this.dynamicRequestProviders.delete(id)
  }

  // setConnection(engineId, ready, options); the original setConnection(ready,
  // options) still means Codex. Only that engine's runs and requests change.
  setConnection(engineId, ready, options) {
    if (typeof engineId === 'boolean') [engineId, ready, options] = ['codex', engineId, ready]
    const { processLost = false } = options || {}
    const codex = engineId === 'codex'
    if (codex) this.connection = ready ? 'ready' : 'offline'
    else this.engineState(engineId).connection = ready ? 'ready' : 'offline'
    if (ready) return
    if (codex) {
      for (const provider of this.toolProviders) provider.disconnect?.({ processLost })
      this.epoch++
    } else this.engineState(engineId).epoch++
    for (const conversationId of [...this.loadedThreads]) if (this.threadEngine(conversationId) === engineId) this.loadedThreads.delete(conversationId)
    for (const run of this.runs.values()) {
      if (this.runEngine(run) !== engineId) continue
      // Tool providers keep serving the other engines; stop only this run.
      if (!codex) for (const provider of this.toolProviders) try { provider.cancelRun?.(run) } catch {}
      // A child Agent can outlive its parent turn; its last state is now unknown.
      this.updateSubAgentRows(run, (run.subAgents || []).filter(row => !SUBAGENT_DONE.has(row.state) && row.state !== 'unknown').map(row => ({ threadId: row.threadId, state: 'unknown' })), true)
      if (TERMINAL.has(run.status)) continue
      run.status = processLost ? 'failed' : 'unknown'
      run.historyComplete = false
      run.error = publicError(processLost ? (codex ? 'Local Codex process exited' : 'Local AI engine process exited') : (codex ? 'Codex connection lost; resume to reconcile' : 'AI engine connection lost; resume to reconcile'), processLost ? 'RUNTIME_LOST' : 'CONNECTION_LOST')
      if (processLost) {
        for (const message of run.messages) if (message.status === 'streaming') message.status = 'error'
        for (const activity of run.activities) if (activity.status === 'inProgress') {
          activity.status = 'failed'
          activity.detail = { ...activity.detail, error: run.error }
        }
      }
      run.pendingApprovals = []
      this.clearUserInputs(run)
      this.emit(run, 'run.unavailable', { status: run.status, error: run.error })
      if (this.store && run.localRunId) this.persistedRunStates.set(runKey(run.conversationId, run.runId), { status: run.status, historyComplete: run.historyComplete })
      this.emitLegacy({ type: 'assistant-error', conversationId: run.conversationId, messageId: run.answerId, error: run.error.message })
    }
    this.forgetPendingRequests(engineId)
    for (const map of [this.qaOutputMarkersByRun, this.rawMessages, this.visibleMessages]) {
      for (const key of [...map.keys()]) if (this.keyEngine(key) === engineId) map.delete(key)
    }
  }

  trimRuns() {
    while (this.runs.size > MAX_RUNS) {
      const entry = [...this.runs].find(([, run]) => TERMINAL.has(run.status))
      if (!entry) break
      this.runs.delete(entry[0])
      this.qaOutputMarkersByRun.delete(entry[0])
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
    let owned = Boolean(context?.requestId && context.nativeTurnId === turnId && context.conversationId === threadId)
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
        const request = prior?.requestId ? this.store.getRequest({ clientThreadId, requestId: prior.requestId }) : null
        owned = Boolean(prior && request?.outcome?.accepted === true && request.outcome.runId === turnId && request.outcome.conversationId === threadId)
        context = {
          clientThreadId, localConversationId: thread.localConversationId,
          localRunId: prior?.localRunId || localId('run', clientThreadId, turnId),
          requestId: prior?.requestId || null,
          localMessageId: request?.localMessageId || null,
          profileBinding: prior?.profileBinding,
          toolCeiling: prior?.toolCeiling,
          engine: prior?.engine,
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
      messages: [], activities: [], artifacts: [], pendingApprovals: [], pendingUserInputs: [], subAgents: [], error: null,
      createdAt: this.now(), truncated: false, historyComplete: true,
      ...(this.store ? { accountIdentity: { ownerHash: ownerHash(this.getOwnerKey()), status: 'verified' } } : {}),
      cwdPublic: publicText(this.threads.get(threadId)?.cwd || '', 2000),
      // Runs from before engine records, or seen only in native history, keep
      // the thread's engine with an unknown version and account slot.
      engine: context?.engine && typeof context.engine.id === 'string'
        ? { id: context.engine.id, version: context.engine.version ?? null, engineProfileId: context.engine.engineProfileId ?? null }
        : { id: this.threadEngine(threadId), version: null, engineProfileId: null },
      ...(this.threadSessions.get(threadId)?.stateless ? { stateless: true } : {}),
    }
    // Which saved profile revision ran. Restored runs keep the recorded binding
    // so a later checkpoint never drops it from local history.
    const profileBinding = context?.profileRun?.binding || context?.profileBinding
    if (profileBinding && typeof profileBinding.profileId === 'string' && Number.isSafeInteger(profileBinding.revision) && typeof profileBinding.hash === 'string') {
      run.profileBinding = { profileId: profileBinding.profileId, revision: profileBinding.revision, hash: profileBinding.hash }
      // AGENT-04: the tool ceiling this run enforced, beside the revision it came from.
      const toolCeiling = context?.profileRun ? context.profileRun.toolCeiling : recordedToolCeiling(context?.toolCeiling)
      if (toolCeiling) run.toolCeiling = { ...toolCeiling }
    }
    this.runs.set(key, run)
    if (owned) this.ownedRuns.add(run)
    this.trimRuns()
    if (announce) {
      this.emit(run, 'run.started', { status: 'inProgress', ...(run.profileBinding ? { profileBinding: run.profileBinding } : {}), ...(run.toolCeiling ? { toolCeiling: run.toolCeiling } : {}), ...(run.stateless ? { stateless: true } : {}) })
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
    const requestedEngineId = this.requestedEngine(body)
    const engineId = this.engines.resolve({ requested: requestedEngineId, bound: this.threadEngines.get(idText(body.conversationId)) })
    // Durable ownership is still the Codex account hash. Fail closed rather
    // than bind another engine's conversation to it.
    if (this.store && engineId !== 'codex') throw engineError('ENGINE_UNAVAILABLE', 'Local chat history can bind only Codex conversations so far')
    this.assertReady(engineId)
    if (typeof body.message !== 'string' || !body.message.trim()) throw chatError('EMPTY_MESSAGE', 'Message is required')
    if (body.message.length > MAX_TEXT) throw chatError('MESSAGE_TOO_LONG', `Message exceeds ${MAX_TEXT} characters`)
    const profileRun = this.resolveProfile(body)
    // Ceilings are applied through Codex thread settings; refuse rather than run an unlimited Agent elsewhere.
    if (ceilingNarrows(profileRun?.toolCeiling) && engineId !== 'codex') throw chatError('PROFILE_CEILING_UNSUPPORTED', 'This AI engine cannot enforce the Agent tool limits yet', 409)
    const instructions = this.threadOverrides(body, profileRun).developerInstructions || ''
    const requestedPolicy = requestedExecutionPolicy(body.executionPolicy)
    const legacyQaNonce = validateQaCommandNonce(body.qaCommandNonce)
    const qaOutputMarkers = validateQaOutputMarkers(body.qaOutputMarkers)
    if (legacyQaNonce && qaOutputMarkers) throw chatError('INVALID_QA_OUTPUT_MARKERS', 'Choose one QA marker contract per request', 400)
    const qaMarkers = qaOutputMarkers || (legacyQaNonce ? [legacyQaNonce] : null)
    if (qaOutputMarkers && (body.message.includes(qaOutputMarkers[0]) || instructions.includes(qaOutputMarkers[0]))) {
      throw chatError('QA_PRIVATE_MARKER_SPOILED', 'The first QA fixture marker must be absent from model-visible request text', 400)
    }
    if (requestedPolicy && !this.qaReady()) throw chatError('QA_POLICY_UNAVAILABLE', 'Bounded execution requires a verified native policy contract', 503)
    if (requestedPolicy && !this.engines.get(engineId).capabilities().has('boundedQa')) throw chatError('QA_POLICY_UNAVAILABLE', 'This AI engine cannot prove bounded execution', 503)
    if (qaMarkers && requestedPolicy && requestedPolicy !== READ_ONLY_QA) throw chatError('QA_COMMAND_POLICY_REQUIRED', 'Native QA command receipt requires readOnlyQa policy', 400)
    if (body.effort !== undefined && (!idText(body.effort) || !body.effort.trim())) throw chatError('INVALID_EFFORT', 'Invalid reasoning effort')
    // CHAT-09: a one-time conversation keeps no native history (ephemeral).
    // Only a new conversation can start that way; nothing is saved on refusal.
    if (body.stateless !== undefined && typeof body.stateless !== 'boolean') throw chatError('INVALID_STATELESS', 'stateless must be true or false', 400)
    const stateless = body.stateless === true
    if (stateless && body.conversationId != null) throw chatError('STATELESS_REQUIRES_NEW', 'Only a new conversation can be started without saved history', 400)
    if (stateless && !this.engines.get(engineId).capabilities().has('ephemeralThreads')) throw chatError('STATELESS_UNSUPPORTED', 'This AI engine cannot start a conversation without saved history', 409)
    const requestId = idText(body.requestId) || randomUUID()
    const fingerprint = createHash('sha256').update(JSON.stringify({
      // Native conversationId is a routing hint that can be learned after a
      // lost response. It must not change the identity of the original input.
      message: body.message, clientThreadId: body.clientThreadId || body.thread?.id,
      cwd: body.cwd, model: body.model, effort: body.effort, profileEnabled: body.profileEnabled === true,
      // A saved profile is identified by its immutable revision and hash; the
      // free-text persona stays for older UI requests (unchanged fingerprint).
      systemPrompt: !profileRun && body.profileEnabled === true ? body.systemPrompt : undefined,
      profile: profileRun ? profileRun.binding : undefined,
      contextSnapshotIds: body.contextSnapshotIds, contextCapabilities: body.contextCapabilities, attachments: body.attachments,
      // CTX-03: only a send that names chosen suggestions changes identity.
      contextResolution: body.contextResolution,
      executionPolicy: body.executionPolicy,
      selectedSources: body.selectedSources, browserTransportId: body.browserTransportId,
      qaCommandNonce: body.qaCommandNonce, qaOutputMarkers: body.qaOutputMarkers,
      // Only an explicit engine changes identity, so a request accepted
      // before engine selection existed replays with the same fingerprint.
      engineId: typeof body.engineId === 'string' ? body.engineId : undefined,
      // Same rule: only an explicit one-time request changes identity.
      stateless: stateless || undefined,
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
    // A new request (replays above keep their first answer) may name only a
    // model the engine lists, and only an effort that model lists. Without a
    // list nothing changes. Unchosen settings still meet assertProcessConfiguration.
    if (body.model !== undefined || body.effort !== undefined) {
      const engine = this.engines.get(engineId)
      let listed = null
      try { listed = typeof engine?.models === 'function' ? engine.models() : null } catch {}
      assertModelSelection(listed, {
        model: body.model, effort: body.effort,
        currentModel: conversationId ? this.threads.get(conversationId)?.model ?? null : this.expectedProcessConfiguration?.model ?? null,
      })
    }
    const lock = conversationId || `client:${clientThreadId || 'legacy'}`
    if (this.locks.has(lock)) throw chatError('RUN_IN_PROGRESS', 'A request is already starting for this conversation', 409)
    if (this.locks.size >= MAX_RUNS) throw chatError('RUNTIME_BUSY', 'Too many pending requests', 429)
    const registered = !conversationId && clientThreadId ? [...this.threads.values()].find(t => t.clientThreadId === clientThreadId) : null
    if (registered) {
      if (stateless) throw chatError('STATELESS_REQUIRES_NEW', 'Only a new conversation can be started without saved history', 400)
      throw Object.assign(chatError('CONVERSATION_REQUIRED', 'Continue this conversation using its returned conversationId', 409), {
        conversationId: registered.id, requestId, resumeRequired: this.uncertainThreads.has(registered.id),
      })
    }
    let acceptedLocal = null
    let boundPolicy = this.threads.get(conversationId)?.executionPolicy || null
    if (!this.store && requestedPolicy && boundPolicy && requestedPolicy !== boundPolicy) throw chatError('POLICY_TRANSITION_FORBIDDEN', 'Start an explicit new conversation to change bounded execution modes', 409)
    if (!this.store && conversationId && requestedPolicy === FIXTURE_BROWSER_QA && !boundPolicy) throw chatError('FIXTURE_QA_NEW_CONVERSATION_REQUIRED', 'Start an explicit new fixture QA conversation with its narrowed native tool catalog', 409)
    if (!this.store && qaMarkers && (requestedPolicy || boundPolicy) !== READ_ONLY_QA) throw chatError('QA_COMMAND_POLICY_REQUIRED', 'Native QA command receipt requires readOnlyQa policy', 400)
    if (this.store) {
      if (!this.storeHealthy) throw chatError('CHAT_STORE_UNAVAILABLE', 'Local chat history cannot accept this message', 503)
      try {
        let thread = this.store.getConversation(clientThreadId)
        if (stateless && thread?.conversationId) throw chatError('STATELESS_REQUIRES_NEW', 'Only a new conversation can be started without saved history', 400)
        if (thread?.conversationId && !conversationId) {
          throw Object.assign(chatError('CONVERSATION_REQUIRED', 'Continue this conversation using its returned conversationId', 409), {
            conversationId: thread.conversationId, requestId, resumeRequired: true,
          })
        }
        if (conversationId && (!thread || thread.conversationId !== conversationId)) throw chatError('NATIVE_BINDING_MISMATCH', 'Native conversation is not bound to this local chat', 409)
        // Schema v2 also locks the local chat to the engine of its first send.
        if (requestedEngineId && thread?.engineId && thread.engineId !== requestedEngineId) throw engineError('ENGINE_MISMATCH', 'This conversation runs on another AI engine; continue in a new conversation')
        if (conversationId) boundPolicy = this.assertNativeAccount(clientThreadId, conversationId, requestedEngineId)
        if (requestedPolicy && boundPolicy && requestedPolicy !== boundPolicy) throw chatError('POLICY_TRANSITION_FORBIDDEN', 'Start an explicit new conversation to change bounded execution modes', 409)
        if (conversationId && requestedPolicy === FIXTURE_BROWSER_QA && !boundPolicy) throw chatError('FIXTURE_QA_NEW_CONVERSATION_REQUIRED', 'Start an explicit new fixture QA conversation with its narrowed native tool catalog', 409)
        if (qaMarkers && (requestedPolicy || boundPolicy) !== READ_ONLY_QA) throw chatError('QA_COMMAND_POLICY_REQUIRED', 'Native QA command receipt requires readOnlyQa policy', 400)
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
        if (['REQUEST_CONFLICT', 'CONVERSATION_REQUIRED', 'STATELESS_REQUIRES_NEW', 'NATIVE_BINDING_MISMATCH', 'NATIVE_ACCOUNT_MISMATCH', 'NATIVE_ACCOUNT_UNVERIFIED', 'POLICY_TRANSITION_FORBIDDEN', 'FIXTURE_QA_NEW_CONVERSATION_REQUIRED', 'QA_COMMAND_POLICY_REQUIRED', 'ENGINE_MISMATCH', 'ENGINE_UNAVAILABLE'].includes(error?.code)) throw error
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
      qaOutputMarkers: qaMarkers,
      policyUpgrade: Boolean(conversationId && requestedPolicy && !boundPolicy),
      profileRun,
      stateless,
      // A stored binding may have named the engine after the early lookup.
      engine: this.engineRecord(conversationId ? this.threadEngines.get(conversationId) || engineId : engineId),
    }
    const record = { fingerprint, settled: false, promise: null, engineId: context.engine.id }
    record.promise = this.startTurn(body, context).catch(error => {
      const failure = error instanceof Error ? error : new Error('Codex request failed')
      if (this.store && acceptedLocal && !context.turnStartAttempted && [
        'QA_POLICY_UNVERIFIED', 'QA_TOOL_ISOLATION_UNVERIFIED', 'QA_POLICY_UNAVAILABLE',
        'BROWSER_POLICY_REQUIRED', 'INVALID_BROWSER_SELECTION', 'BROWSER_UI_UNAVAILABLE',
        'BROWSER_TOOLS_UNAVAILABLE', 'QA_REQUIRES_NEW_CONVERSATION',
        'PROFILE_CEILING_UNAVAILABLE', 'PROFILE_CEILING_UNVERIFIED',
      ].includes(failure.code)) {
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

  // AGENT-03: a saved Agent profile's active (or named) revision becomes the
  // native developer instructions. Resolved once per send so the request
  // fingerprint, the instructions and the Run record name the same revision.
  resolveProfile(body) {
    if (body.profileId === undefined || body.profileId === null) return null
    if (body.profileEnabled === false) throw chatError('INVALID_PROFILE', 'Choose an Agent profile or turn profiles off, not both')
    if (!this.profiles) throw chatError('PROFILE_STORE_UNAVAILABLE', 'Local profile storage is unavailable', 503)
    // Store failures carry their own code and HTTP status (404 missing, 409 not active).
    const resolved = this.profiles.runProfile(body.profileId, body.profileRevision ?? undefined)
    const binding = resolved?.binding, instructions = resolved?.developerInstructions
    if (!binding || typeof binding.profileId !== 'string' || !Number.isSafeInteger(binding.revision) || typeof binding.hash !== 'string' ||
        typeof instructions !== 'string' || !instructions.trim() || instructions.length > MAX_COMPOSED) {
      throw chatError('INVALID_PROFILE', `A saved profile must compose 1 to ${MAX_COMPOSED} characters of instructions`, 500)
    }
    // AGENT-04: the binding hash covers the ceiling, so the fingerprint already names it.
    return { binding: { profileId: binding.profileId, revision: binding.revision, hash: binding.hash }, developerInstructions: instructions, toolCeiling: effectiveToolCeiling(resolved.toolCeiling) }
  }

  threadOverrides(body, profileRun = null) {
    const options = {}
    const cwd = validateChatCwd(body)
    if (cwd !== undefined) options.cwd = cwd
    if (body.model !== undefined) {
      if (!idText(body.model) || !body.model.trim()) throw chatError('INVALID_MODEL', 'Invalid model')
      options.model = body.model
    }
    if (profileRun) options.developerInstructions = profileRun.developerInstructions
    else if (body.profileEnabled === true) {
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

  assertNativeAccount(clientThreadId, conversationId, engineId = null) {
    if (!this.store) return this.threads.get(conversationId)?.executionPolicy || null
    const expected = ownerHash(this.getOwnerKey())
    if (!expected) throw chatError('NATIVE_ACCOUNT_UNVERIFIED', 'Current Codex account identity is unavailable', 403)
    let afterSeq = 0
    let recorded = null
    let executionPolicy = null
    let browserToolsRegistered = false
    let toolManifest = null
    let recordedEngine = 'codex'
    let session = null
    for (let page = 0; page < 1000; page++) {
      const result = this.store.listEvents(clientThreadId, { afterSeq, limit: 500 })
      for (const event of result.events || []) if (event.event === 'native.thread.bound' && event.details?.conversationId === conversationId) {
        recorded = event.details.ownerHash || null
        // Bindings recorded before engine records are Codex.
        recordedEngine = idText(event.details.engine?.id) ? event.details.engine.id : 'codex'
        executionPolicy = event.details.executionPolicy || null
        browserToolsRegistered = event.details.browserToolsRegistered === true
        toolManifest = event.details.toolManifest ?? null
        session = threadSession(event.details)
      } else if (event.event === 'native.executionPolicy.bound' && event.details?.conversationId === conversationId) {
        executionPolicy = event.details.executionPolicy
      }
      if (!result.hasMore) break
      if (!Number.isSafeInteger(result.nextCursor) || result.nextCursor <= afterSeq) throw chatError('NATIVE_ACCOUNT_UNVERIFIED', 'Native account checkpoint is incomplete', 409)
      afterSeq = result.nextCursor
      if (page === 999) throw chatError('NATIVE_ACCOUNT_UNVERIFIED', 'Native account checkpoint exceeds the bounded read', 409)
    }
    if (!recorded) throw chatError('NATIVE_ACCOUNT_UNVERIFIED', 'Native account ownership was not recorded', 409)
    if (engineId && engineId !== recordedEngine) throw engineError('ENGINE_MISMATCH', 'This conversation runs on another AI engine; continue in a new conversation')
    // Durable ownership is the Codex account hash until engine accounts land.
    if (recordedEngine !== 'codex') throw engineError('ENGINE_UNAVAILABLE', 'This conversation\'s AI engine is not available')
    if (recorded !== expected) throw chatError('NATIVE_ACCOUNT_MISMATCH', 'This native conversation belongs to a different Codex account', 403)
    if (executionPolicy !== null && ![READ_ONLY_QA, BROWSER_BOUNDED, FIXTURE_BROWSER_QA].includes(executionPolicy)) throw chatError('QA_POLICY_UNVERIFIED', 'Stored native execution policy is unknown', 409)
    if (browserToolsRegistered) this.browserRegisteredThreads.add(conversationId)
    else this.browserRegisteredThreads.delete(conversationId)
    this.threadToolManifests.set(conversationId, toolManifest)
    this.threadEngines.set(conversationId, recordedEngine)
    if (session) this.threadSessions.set(conversationId, session)
    else this.threadSessions.delete(conversationId)
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
        details: { conversationId, ownerHash: identityHash, executionPolicy: context.executionPolicy || null, browserToolsRegistered: context.browserToolsRegistered === true, toolManifest: context.toolManifest || [], engine: context.engine, ...(context.stateless ? { stateless: true } : {}) }, ts: this.now(),
      })
      this.store.bindNative({ clientThreadId: context.clientThreadId, conversationId, engineId: context.engine.id, engineProfileId: context.engine.engineProfileId })
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
        details: { conversationId, executionPolicy: context.executionPolicy }, ts: this.now(),
      })
    } catch {
      this.storeHealthy = false
      throw chatError('CHAT_STORE_UNAVAILABLE', 'Read-only policy binding could not be saved; no Codex turn was started', 503)
    }
  }

  async startTurn(body, context) {
    const engine = this.engines.get(context.engine.id)
    const epoch = this.epochOf(engine.id)
    const overrides = this.threadOverrides(body, context.profileRun)
    const policy = context.executionPolicy
    const qa = policy === READ_ONLY_QA
    const bounded = qa || policy === BROWSER_BOUNDED || policy === FIXTURE_BROWSER_QA
    // AGENT-04: the Agent's tool ceiling narrows this run; it never widens it.
    const ceiling = context.profileRun?.toolCeiling || null
    if (ceilingNarrows(ceiling) && engine.id !== 'codex') throw chatError('PROFILE_CEILING_UNSUPPORTED', 'This AI engine cannot enforce the Agent tool limits yet', 409)
    // CU-01: 'off' applies to ordinary Codex threads; bounded threads already disable it all.
    const computerOff = !bounded && engine.id === 'codex' && this.computerControl.policy === 'off'
    context.ceilingNotices = []
    const preparedProviders = new Map()
    for (const provider of this.toolProviders) if ((!bounded && provider.providerId !== 'egdesk-browser') ||
        (bounded && (provider === this.contexts || provider.providerId === 'egdesk-browser'))) {
      let input = body
      if (provider.providerId === 'egdesk-browser' && ceiling?.browser === 'none') {
        // No Browser grant at all, even for a Card the user selected.
        if (liveBrowserSelected(body.selectedSources)) context.ceilingNotices.push({ key: 'browser-selection', axis: 'browser', title: CEILING_MESSAGES.browserDropped })
        continue
      }
      if (provider.providerId === 'egdesk-browser') {
        const narrowed = ceilingBrowserSelection(ceiling, body.selectedSources)
        if (narrowed.downgraded) {
          input = { ...body, selectedSources: narrowed.sources }
          context.ceilingNotices.push({ key: 'browser-selection', axis: 'browser', title: CEILING_MESSAGES.browserDowngraded })
        }
      }
      preparedProviders.set(provider, await this.callProvider(provider, 'prepare', { ...input, effectiveExecutionPolicy: policy }) || null)
    }
    const browserInteractionRequested = policy === BROWSER_BOUNDED && [...preparedProviders]
      .some(([provider, prepared]) => provider.providerId === 'egdesk-browser' && prepared?.interactionRequested === true)
    const additionalContext = this.additionalToolContext(preparedProviders)
    if (epoch !== this.epochOf(engine.id)) throw chatError('ACCOUNT_CHANGED', 'Codex account or connection changed', 409)
    if (bounded && !this.qaReady()) throw chatError('QA_POLICY_UNAVAILABLE', 'Bounded execution requires a verified native policy contract', 503)
    const qaOverrides = bounded ? await loadQaThreadOverrides(this.request, {
      threadId: context.conversationId && this.loadedThreads.has(context.conversationId) ? context.conversationId : null,
      cwd: overrides.cwd || this.threads.get(context.conversationId)?.cwd || null,
    }) : null
    if (epoch !== this.epochOf(engine.id)) throw chatError('ACCOUNT_CHANGED', 'Codex account or connection changed', 409)
    // A continued thread reads its settings after its history (and cwd) is restored.
    const ceilingOverrides = () => loadCeilingThreadOverrides(this.request, ceiling, {
      bounded, cwd: overrides.cwd || this.threads.get(context.conversationId)?.cwd || null,
    })
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
        const readOnlyNames = new Set([toolKey(null, 'egdesk_list_context'), toolKey(null, 'egdesk_read_source'), toolKey(null, 'egdesk_browser_observe')])
        if (qa && (!registered || [...registered.keys()].some(name => !readOnlyNames.has(name)))) {
          throw chatError('QA_REQUIRES_NEW_CONVERSATION', 'This thread has unknown or broader dynamic tools; start a new read-only QA conversation', 409)
        }
        if ([BROWSER_BOUNDED, FIXTURE_BROWSER_QA].includes(policy) && !this.browserRegisteredThreads.has(cid)) throw chatError('BROWSER_TOOLS_UNAVAILABLE', 'This native thread predates Browser tools; keep its history and choose an explicit new conversation', 409)
      }
      for (const provider of preparedProviders.keys()) await this.callProvider(provider, 'requireThread', cid, preparedProviders.get(provider))
      if (epoch !== this.epochOf(engine.id)) throw chatError('ACCOUNT_CHANGED', 'Codex account or connection changed', 409)
      if (this.uncertainThreads.has(cid)) throw chatError('RESUME_REQUIRED', 'Resume the conversation before retrying an uncertain turn', 409)
      // Hydrate native history before deciding whether a new turn is safe.
      // This also supplies the historical cwd for profile-off config/read.
      const justRestored = !this.loadedThreads.has(cid)
      if (justRestored) await this.restoreThread(cid, context.clientThreadId, qaOverrides || {}, { policy })
      if ([...this.runs.values()].some(run => run.conversationId === cid && !TERMINAL.has(run.status))) {
        throw chatError('RUN_IN_PROGRESS', 'This conversation already has an active or unreconciled turn', 409)
      }
      if (body.profileEnabled === true || body.profileEnabled === false) {
        // Ordinary instructions come from Codex config; an engine without the
        // Codex escape hatch has none, so profile-off sends no instructions.
        if (body.profileEnabled === false && typeof engine.request !== 'function') overrides.developerInstructions = ''
        else if (body.profileEnabled === false) {
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
        if (epoch !== this.epochOf(engine.id)) throw chatError('CONTEXT_CHANGED', 'Codex connection or account changed', 409)
      }
      // Read-only QA re-asserts and verifies its effective native thread policy
      // before *every* provider turn, including after reconnect or a profile
      // change. A loaded thread must be detached first so resume overrides take.
      // A saved profile takes the same path, so a newly activated revision is
      // applied to this thread on its next send.
      // A thread loaded without verified 'off' settings (or with them, after a
      // switch back to 'inherit') is reloaded so the current policy takes.
      const computerOffApplied = this.threads.get(cid)?.computerControl === 'off'
      const computerReload = !bounded && engine.id === 'codex' && (computerOff ? !computerOffApplied : computerOffApplied)
      const mustReload = (bounded && !justRestored) || body.profileEnabled === true || body.profileEnabled === false || Boolean(context.profileRun) || computerReload
      if (mustReload && this.loadedThreads.has(cid)) {
        const detached = await engine.releaseThread(cid)
        this.loadedThreads.delete(cid)
        if (!['unsubscribed', 'notLoaded'].includes(detached?.status)) throw chatError('PROFILE_TRANSITION_UNAVAILABLE', 'Could not detach this native thread for a profile change', 409)
      }
      if (!this.loadedThreads.has(cid)) {
        // A saved profile always reloads the thread, so a changed ceiling is re-applied here.
        const extra = ceilingNarrows(ceiling) ? await ceilingOverrides() : null
        const computerExtra = computerOff ? await this.computerControlOffOverrides(overrides.cwd || this.threads.get(cid)?.cwd || null) : null
        if (epoch !== this.epochOf(engine.id)) throw chatError('CONTEXT_CHANGED', 'Codex connection or account changed', 409)
        // A bounded thread resumed with the ceiling's shell_tool false must read it back off.
        const resumed = await this.restoreThread(cid, context.clientThreadId, mergeCeilingOverrides(mergeCeilingOverrides({ ...overrides, ...(qaOverrides || {}) }, extra), computerExtra?.overrides), { policy, shellOff: Boolean(extra) && ceiling?.terminal === 'none' })
        if (!bounded) context.ceilingNotices.push(...ceilingReportNotices(ceiling, await verifyCeilingNativeThread(this.request, ceiling, resumed, cid)))
        if (computerExtra) {
          await this.verifyComputerControl(cid, computerExtra)
          this.threads.get(cid).computerControl = 'off'
        }
        if (epoch !== this.epochOf(engine.id)) throw chatError('CONTEXT_CHANGED', 'Codex connection or account changed', 409)
      }
      if (bounded) this.persistExecutionPolicy(context, cid)
    } else {
      const nativeTools = this.collectToolSpecs(policy, { browserInteraction: browserInteractionRequested, toolCeiling: ceiling })
      if (nativeTools.specs.length) overrides.dynamicTools = nativeTools.specs
      if (bounded) Object.assign(overrides, qaOverrides)
      // Ordinary Agent questions may arrive outside Plan mode. Bounded threads never ask.
      else overrides.config = ordinaryThreadConfig(overrides.config)
      if (context.stateless) overrides.ephemeral = true
      if (ceilingNarrows(ceiling)) {
        mergeCeilingOverrides(overrides, await ceilingOverrides())
        if (epoch !== this.epochOf(engine.id)) throw chatError('ACCOUNT_CHANGED', 'Codex account changed', 409)
      }
      const computerExtra = computerOff ? await this.computerControlOffOverrides(overrides.cwd || null) : null
      if (computerExtra) {
        mergeCeilingOverrides(overrides, computerExtra.overrides)
        if (epoch !== this.epochOf(engine.id)) throw chatError('ACCOUNT_CHANGED', 'Codex account changed', 409)
      }
      const result = await engine.startThread(overrides)
      if (epoch !== this.epochOf(engine.id)) throw chatError('ACCOUNT_CHANGED', 'Codex account changed', 409)
      cid = result?.thread?.id
      if (!idText(cid)) throw chatError('INVALID_THREAD_RESPONSE', 'Codex did not return a thread ID', 502)
      // Never call a thread one-time when the engine says it saved it.
      if (context.stateless && result.thread.ephemeral === false) throw chatError('STATELESS_UNVERIFIED', 'The AI engine saved this conversation; it was not bound as one-time', 502)
      this.threadEngines.set(cid, engine.id)
      if (context.stateless) this.threadSessions.set(cid, { stateless: true, forkedFrom: null })
      let qaReceipt = null
      if (bounded) {
        qaReceipt = verifyQaNativeThread(result, policy)
        // A terminal 'none' ceiling sent shell_tool false (loadCeilingThreadOverrides); confirm it.
        qaReceipt = await verifyQaMcpIsolation(this.request, cid, qaReceipt, { shellOff: ceilingNarrows(ceiling) && ceiling.terminal === 'none' })
      } else context.ceilingNotices.push(...ceilingReportNotices(ceiling, await verifyCeilingNativeThread(this.request, ceiling, result, cid)))
      if (computerExtra) await this.verifyComputerControl(cid, computerExtra)
      if (epoch !== this.epochOf(engine.id)) throw chatError('ACCOUNT_CHANGED', 'Codex account changed', 409)
      this.rememberThread(cid, result, context.clientThreadId)
      // rememberThread rebuilds the record; any later load drops this mark.
      if (computerExtra) this.threads.get(cid).computerControl = 'off'
      this.threadToolOwners.set(cid, nativeTools.owners)
      this.threadToolManifests.set(cid, nativeTools.manifest)
      this.threadToolManifestStatus.set(cid, 'verified')
      context.toolManifest = nativeTools.manifest
      context.browserToolsRegistered = nativeTools.specs.some(spec => spec.name === 'egdesk_browser_observe')
      if (context.browserToolsRegistered) this.browserRegisteredThreads.add(cid)
      if (bounded) Object.assign(this.threads.get(cid), { executionPolicy: policy, qaReceipt })
      context.conversationId = cid
      if (this.store) this.persistNativeBinding(context, cid)
      for (const provider of nativeTools.selected) await this.callProvider(provider, 'registerThread', cid)
    }
    if (epoch !== this.epochOf(engine.id)) throw chatError('ACCOUNT_CHANGED', 'Codex account changed', 409)
    if (browserInteractionRequested && !['egdesk_browser_observe', 'egdesk_browser_click', 'egdesk_browser_fill']
      .every(name => this.threadToolOwners.get(cid)?.has(toolKey(null, name)))) {
      throw chatError('BROWSER_TOOLS_UNAVAILABLE', 'This native conversation has no original click/fill catalog; keep its history, start an explicit new Chat and reselect the Browser', 409)
    }
    if ([...preparedProviders.values()].some(Boolean) && this.threadToolManifestStatus.get(cid) !== 'verified') {
      throw chatError('NATIVE_TOOL_MANIFEST_UNVERIFIED', 'This native thread has no verified original tool ownership; keep its history and choose an explicit new conversation', 409)
    }
    // The expected configuration is the Codex app-server's process setting.
    if (engine.id === 'codex') this.assertProcessConfiguration(this.threads.get(cid), { model: body.model, effort })
    if ([...this.runs.values()].some(run => run.conversationId === cid && !TERMINAL.has(run.status))) {
      throw chatError('RUN_IN_PROGRESS', 'This conversation already has an active or unreconciled turn', 409)
    }
    if ([...this.runs.values()].filter(run => !TERMINAL.has(run.status)).length >= MAX_RUNS) throw chatError('RUNTIME_BUSY', 'Too many active turns', 429)
    const nativePolicyReceipt = bounded ? this.threads.get(cid)?.qaReceipt : null
    // This copy belongs only to the current run. Do not store it on the
    // native thread or persist it as a policy binding for following sends.
    const verifiedPolicyReceipt = nativePolicyReceipt && browserInteractionRequested
      ? { ...nativePolicyReceipt, browserEffects: 'selected-card-observe-click-fill-this-run' }
      : nativePolicyReceipt
    if (bounded && !verifiedPolicyReceipt) throw chatError('QA_POLICY_UNVERIFIED', 'Verified bounded policy receipt was lost before turn/start', 502)
    const pending = { ...context, conversationId: cid, buffer: [] }
    this.pendingStarts.set(cid, pending)
    let turnStartAttempted = false
    try {
      turnStartAttempted = context.turnStartAttempted = true
      const result = await engine.startTurn({
        threadId: cid,
        input: [{ type: 'text', text: body.message, text_elements: [] }],
        clientUserMessageId: context.requestId,
        ...(bounded ? QA_TURN_OVERRIDES : {}),
        ...(additionalContext ? { additionalContext } : {}),
        ...(overrides.cwd ? { cwd: overrides.cwd } : {}),
        ...(overrides.model ? { model: overrides.model } : {}),
        ...(effort !== undefined ? { effort } : {}),
      })
      if (epoch !== this.epochOf(engine.id)) throw chatError('ACCOUNT_CHANGED', 'Codex account changed', 409)
      context.nativeTurnId = idText(result?.turn?.id)
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
      if (context.qaOutputMarkers && policy === READ_ONLY_QA) this.qaOutputMarkersByRun.set(run.answerId, context.qaOutputMarkers)
      if (bounded) {
        run.executionPolicy = verifiedPolicyReceipt
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
      for (const provider of preparedProviders.keys()) await this.callProvider(provider, 'bindRun', run, preparedProviders.get(provider), readerConfiguration)
      if (epoch !== this.epochOf(engine.id)) throw chatError('ACCOUNT_CHANGED', 'Codex account or connection changed', 409)
      for (const notice of context.ceilingNotices) this.noteCeiling(run, notice.key, notice)
      // Notifications can precede the RPC response. Only the returned turn ID
      // may inherit this request's correlation; other turns remain unclaimed.
      while (pending.buffer.length) await this.apply(pending.buffer.shift())
      if (TERMINAL.has(result.turn.status) && !TERMINAL.has(run.status)) await this.finish(run, safeTurn(result.turn))
      return {
        accepted: true, durable: !this.store || this.storeHealthy,
        conversationId: cid, requestId: context.requestId, runId: run.runId, answerId: run.answerId,
        clientThreadId: context.clientThreadId, localConversationId: context.localConversationId,
        localRunId: context.localRunId, localMessageId: context.localMessageId,
        ...(bounded ? { executionPolicy: run.executionPolicy } : {}),
        ...(run.profileBinding ? { profileBinding: run.profileBinding } : {}),
        ...(run.toolCeiling ? { toolCeiling: run.toolCeiling } : {}),
        ...(run.stateless ? { stateless: true } : {}),
      }
    } catch (error) {
      // A native JSON-RPC error is a definite rejection. A lost/ambiguous reply
      // needs explicit reconciliation before another attempt can start a turn.
      if (epoch === this.epochOf(engine.id) && (context.nativeTurnId || (turnStartAttempted && typeof error.code !== 'number'))) this.uncertainThreads.add(cid)
      if (context.nativeTurnId && epoch === this.epochOf(engine.id)) {
        for (const event of pending.buffer.splice(0)) if (event.method === 'dynamic' || event.method === 'approval') {
          try { this.respond(event.rpcId, null, { code: -32000, message: 'Run binding failed; no tool authority was granted' }) } catch {}
        }
        const run = this.runs.get(runKey(cid, context.nativeTurnId))
        if (run) {
          for (const provider of this.toolProviders) try { provider.cancelRun?.(run) } catch {}
          run.status = 'unknown'
          run.historyComplete = false
          run.error = publicError(error, 'RUN_BINDING_FAILED')
          this.emit(run, 'run.unavailable', { status: run.status, error: run.error })
        }
        await engine.interruptTurn(cid, context.nativeTurnId).catch(() => {})
      }
      if (this.store) {
        try {
          this.store.recordRequestOutcome({
            clientThreadId: context.clientThreadId, requestId: context.requestId, ts: this.now(),
            outcome: {
              accepted: Boolean(context.nativeTurnId), dispatchStatus: context.nativeTurnId || (turnStartAttempted && typeof error.code !== 'number') ? 'unknown' : 'rejected',
              conversationId: cid || null, runId: context.nativeTurnId || null, localRunId: context.localRunId,
              error: publicError(error, 'TURN_START_FAILED'),
            },
          })
        } catch { this.storeHealthy = false }
      }
      throw error
    } finally { if (this.pendingStarts.get(cid) === pending) this.pendingStarts.delete(cid) }
  }

  async restoreThread(cid, clientThreadId, overrides = {}, { policy = null, shellOff = false } = {}) {
    const engineId = this.threadEngine(cid)
    const epoch = this.epochOf(engineId)
    const pending = { buffer: [] }
    this.pendingResumes.set(cid, pending)
    try {
      await this.queue
      // Never fall back to thread/start if a historical ID is invalid or unavailable.
      const result = await this.engineOf(cid).resumeThread({ threadId: cid, ...overrides, ...(policy ? {} : { config: ordinaryThreadConfig(overrides.config) }) })
      if (epoch !== this.epochOf(engineId)) throw chatError('CONTEXT_CHANGED', 'Codex connection or account changed', 409)
      if (result?.thread?.id !== cid) throw chatError('THREAD_MISMATCH', 'Codex resumed a different thread', 502)
      let qaReceipt = null
      if (policy) {
        qaReceipt = verifyQaNativeThread(result, policy)
        qaReceipt = await verifyQaMcpIsolation(this.request, cid, qaReceipt, { shellOff })
      }
      if (epoch !== this.epochOf(engineId)) throw chatError('CONTEXT_CHANGED', 'Codex connection or account changed', 409)
      this.rememberThread(cid, result, clientThreadId)
      const currentCatalog = this.collectToolSpecs(null, { forManifest: true })
      const verifiedTools = verifiedManifestOwners(this.threadToolManifests.get(cid), currentCatalog.manifest, currentCatalog.owners)
      this.threadToolOwners.set(cid, verifiedTools.owners)
      this.threadToolManifestStatus.set(cid, verifiedTools.status)
      if (policy) Object.assign(this.threads.get(cid), { executionPolicy: policy, qaReceipt })
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
        if (policy && !TERMINAL.has(turn.status)) {
          // Current thread policy was reverified, but the original active
          // turn's effective policy is not independently recoverable. Restore
          // the restrictive approval guard without claiming turn verification.
          run.executionPolicy = { mode: policy, status: 'recovered-active-guard', approvalPolicy: 'never' }
        }
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
        if (epoch !== this.epochOf(engineId)) throw chatError('CONTEXT_CHANGED', 'Codex connection or account changed', 409)
        run.status = turn.status
        run.stopConfirmed = turn.status === 'interrupted'
        run.error = turn.error
        run.truncated ||= Boolean(turn.truncated)
        run.historyComplete = retainedComplete || turn.itemsView === 'full'
        for (const provider of this.toolProviders) await this.callProvider(provider, 'restoreRun', run)
        if (epoch !== this.epochOf(engineId)) throw chatError('CONTEXT_CHANGED', 'Codex connection or account changed', 409)
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
      if (epoch !== this.epochOf(engineId)) throw chatError('CONTEXT_CHANGED', 'Codex connection or account changed', 409)
      this.uncertainThreads.delete(cid)
      this.trimRuns()
      return result
    } finally { if (this.pendingResumes.get(cid) === pending) this.pendingResumes.delete(cid) }
  }

  async resume(body) {
    if (this.requireStore) this.assertStore()
    const engineId = this.threadEngine(idText(body.conversationId))
    this.assertReady(engineId)
    const epoch = this.epochOf(engineId)
    const cid = idText(body.conversationId)
    if (!cid) throw chatError('MISSING_THREAD_ID', 'conversationId is required')
    const requestedEngineId = this.requestedEngine(body)
    this.engines.resolve({ requested: requestedEngineId, bound: this.threadEngines.get(cid) })
    let boundPolicy = this.threads.get(cid)?.executionPolicy || null
    if (this.store) {
      const clientThreadId = idText(body.clientThreadId)
      if (!clientThreadId) throw chatError('INVALID_CLIENT_THREAD_ID', 'clientThreadId is required to resume a durable chat', 400)
      const thread = this.store.getConversation(clientThreadId)
      if (!thread || thread.conversationId !== cid) throw chatError('NATIVE_BINDING_MISMATCH', 'Native conversation is not bound to this local chat', 409)
      boundPolicy = this.assertNativeAccount(clientThreadId, cid, requestedEngineId)
    }
    if (this.locks.has(cid) || this.pendingStarts.has(cid)) throw chatError('RUN_STARTING', 'Conversation request is still starting', 409)
    this.locks.add(cid)
    try {
      const bounded = [READ_ONLY_QA, BROWSER_BOUNDED, FIXTURE_BROWSER_QA].includes(boundPolicy)
      if (bounded && !this.qaReady()) throw chatError('QA_POLICY_UNAVAILABLE', 'Bounded execution requires a verified native policy contract', 503)
      const qaOverrides = bounded ? await loadQaThreadOverrides(this.request, {
        threadId: this.loadedThreads.has(cid) ? cid : null,
        cwd: this.threads.get(cid)?.cwd || null,
      }) : {}
      if (bounded && this.loadedThreads.has(cid)) {
        const detached = await this.engineOf(cid).releaseThread(cid)
        this.loadedThreads.delete(cid)
        if (!['unsubscribed', 'notLoaded'].includes(detached?.status)) throw chatError('QA_POLICY_UNVERIFIED', 'Could not detach native QA thread before policy verification', 409)
      }
      await this.restoreThread(cid, idText(body.clientThreadId), qaOverrides, { policy: boundPolicy })
      await this.queue
      // Revalidate previously retained links without claiming files were generated.
      for (const run of this.runs.values()) if (run.conversationId === cid) {
        const available = []
        for (const artifact of run.artifacts) if (await this.verifyFile(artifact.target.path, { artifact: true })) available.push(artifact)
        if (epoch !== this.epochOf(engineId)) throw chatError('CONTEXT_CHANGED', 'Codex connection or account changed', 409)
        run.artifacts = available
      }
      this.seq++
      return this.snapshot(cid)
    } finally { this.locks.delete(cid) }
  }

  // CHAT-09: branch a native conversation into a new local chat. thread/fork
  // makes a new native thread (through fromTurnId when given) for the same
  // account and engine; the new chat records where it came from. Like any
  // conversation this runtime has not loaded, the branch hydrates its history
  // on its first send or resume.
  async fork(body) {
    const store = this.assertStore()
    const conversationId = idText(body.conversationId)
    if (!conversationId) throw chatError('MISSING_THREAD_ID', 'conversationId is required')
    const clientThreadId = idText(body.clientThreadId)
    if (!clientThreadId?.trim()) throw chatError('INVALID_CLIENT_THREAD_ID', 'clientThreadId of the new conversation is required', 400)
    const fromTurnId = body.fromTurnId == null ? null : idText(body.fromTurnId)
    if (body.fromTurnId != null && !fromTurnId?.trim()) throw chatError('INVALID_TURN_ID', 'Invalid fromTurnId', 400)
    const requestedEngineId = this.requestedEngine(body)
    const source = store.getConversationByNative(conversationId)
    if (!source) throw chatError('CONVERSATION_NOT_FOUND', 'This native conversation is not bound to a local chat', 404)
    if (source.clientThreadId === clientThreadId) throw chatError('FORK_TARGET_EXISTS', 'Branch into a new conversation', 409)
    // The source's account and engine are checked as for any continued send.
    const policy = this.assertNativeAccount(source.clientThreadId, conversationId, requestedEngineId)
    const forkedFrom = { conversationId, turnId: fromTurnId, clientThreadId: source.clientThreadId }
    const target = store.getConversation(clientThreadId)
    if (target?.conversationId) {
      // A retry after a lost reply gets the branch it already made.
      if (target.forkedFrom?.conversationId !== conversationId || target.forkedFrom.turnId !== fromTurnId) throw chatError('FORK_TARGET_EXISTS', 'Branch into a new conversation', 409)
      this.assertNativeAccount(clientThreadId, target.conversationId)
      return { accepted: true, duplicate: true, durable: this.storeHealthy, conversationId: target.conversationId, clientThreadId, localConversationId: target.localConversationId, forkedFrom: target.forkedFrom, engineId: this.threadEngine(target.conversationId) }
    }
    if (target && store.listEvents(clientThreadId, { limit: 1 }).events.length) throw chatError('FORK_TARGET_EXISTS', 'Branch into a new conversation', 409)
    if (policy) throw chatError('FORK_BOUNDED_FORBIDDEN', 'A bounded QA conversation cannot be branched', 409)
    if (this.threadSessions.get(conversationId)?.stateless) throw chatError('FORK_STATELESS_FORBIDDEN', 'A one-time conversation has no saved history to branch', 409)
    const engine = this.engineOf(conversationId)
    this.assertReady(engine.id)
    if (!engine.capabilities().has('threadFork') || typeof engine.forkThread !== 'function') throw chatError('FORK_UNSUPPORTED', 'This AI engine cannot branch a conversation', 409)
    const from = fromTurnId ? this.runs.get(runKey(conversationId, fromTurnId)) : null
    if (from && !TERMINAL.has(from.status)) throw chatError('RUN_IN_PROGRESS', 'Branch from a finished turn', 409)
    const lock = `client:${clientThreadId}`
    if (this.locks.has(lock) || [...this.threads.values()].some(thread => thread.clientThreadId === clientThreadId)) throw chatError('RUN_IN_PROGRESS', 'A request is already starting for this conversation', 409)
    if (this.locks.size >= MAX_RUNS) throw chatError('RUNTIME_BUSY', 'Too many pending requests', 429)
    const identityHash = ownerHash(this.getOwnerKey())
    const epoch = this.epochOf(engine.id)
    // The branch carries the source's native tools, so it inherits their record.
    const toolManifest = this.threadToolManifests.get(conversationId) ?? null
    const browserToolsRegistered = this.browserRegisteredThreads.has(conversationId)
    this.locks.add(lock)
    try {
      const result = await engine.forkThread({ threadId: conversationId, ...(fromTurnId ? { lastTurnId: fromTurnId } : {}), excludeTurns: true, config: ordinaryThreadConfig() })
      if (epoch !== this.epochOf(engine.id) || ownerHash(this.getOwnerKey()) !== identityHash) throw chatError('ACCOUNT_CHANGED', 'Codex account or connection changed', 409)
      const cid = result?.thread?.id
      if (!idText(cid) || cid === conversationId) throw chatError('INVALID_THREAD_RESPONSE', 'Codex did not return a new thread ID', 502)
      if (result.thread.forkedFromId != null && result.thread.forkedFromId !== conversationId) throw chatError('THREAD_MISMATCH', 'Codex branched a different thread', 502)
      const engineRecord = this.engineRecord(engine.id)
      let local
      try {
        local = target || store.createConversation({ clientThreadId, createdAt: this.now() })
        store.appendEvent({
          eventKey: `native-fork:${cid}`, clientThreadId, event: 'native.thread.bound', ts: this.now(),
          details: { conversationId: cid, ownerHash: identityHash, executionPolicy: null, browserToolsRegistered, toolManifest, engine: engineRecord, forkedFrom },
        })
        store.bindNative({ clientThreadId, conversationId: cid, engineId: engineRecord.id, engineProfileId: engineRecord.engineProfileId })
      } catch {
        this.storeHealthy = false
        throw chatError('CHAT_STORE_UNAVAILABLE', 'Local chat history could not save the branch', 503)
      }
      this.threadEngines.set(cid, engine.id)
      this.threadSessions.set(cid, { stateless: false, forkedFrom })
      this.threadToolManifests.set(cid, toolManifest)
      if (browserToolsRegistered) this.browserRegisteredThreads.add(cid)
      const providerIds = new Set(Array.isArray(toolManifest) ? toolManifest.map(entry => entry?.providerId) : [])
      for (const provider of this.toolProviders) {
        if (providerIds.has(provider === this.contexts ? 'egdesk-context-v1' : provider.providerId)) await this.callProvider(provider, 'registerThread', cid)
      }
      return { accepted: true, durable: this.storeHealthy, conversationId: cid, clientThreadId, localConversationId: local.localConversationId, forkedFrom, engineId: engine.id }
    } finally { this.locks.delete(lock) }
  }

  findRun(body) {
    const run = this.runs.get(runKey(idText(body.conversationId), idText(body.runId)))
    if (!run) throw chatError('RUN_NOT_FOUND', 'No matching local run', 404)
    return run
  }

  async interrupt(body) {
    // Readiness first, as before: an unknown run is checked against Codex.
    this.assertReady(this.runEngine(this.runs.get(runKey(idText(body.conversationId), idText(body.runId)))))
    const run = this.findRun(body)
    if (TERMINAL.has(run.status)) return { accepted: false, alreadyTerminal: true, conversationId: run.conversationId, runId: run.runId, status: run.status }
    for (const provider of this.toolProviders) provider.cancelRun?.(run)
    if (run.stopRequested) return { accepted: true, stopRequested: true, conversationId: run.conversationId, runId: run.runId }
    await this.engineOf(run.conversationId).interruptTurn(run.conversationId, run.runId)
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
    if (body.decision === 'accept' && !this.ownedRuns.has(run)) throw chatError('NATIVE_RUN_UNBOUND', 'This native run has no verified EG-Desk dispatch binding', 409)
    if (body.decision === 'accept' && ([READ_ONLY_QA, BROWSER_BOUNDED, FIXTURE_BROWSER_QA].includes(run.executionPolicy?.mode) ||
        [READ_ONLY_QA, BROWSER_BOUNDED, FIXTURE_BROWSER_QA].includes(this.threads.get(run.conversationId)?.executionPolicy))) {
      throw chatError('BOUNDED_APPROVAL_FORBIDDEN', 'Bounded execution never grants an interactive approval', 403)
    }
    if (body.decision === 'accept' && ceilingApprovalRefusal(run.toolCeiling, { kind: approval.kind, network: Boolean(approval.networkApprovalContext) })) {
      throw chatError('PROFILE_CEILING_FORBIDDEN', 'This Agent profile does not allow that action', 403)
    }
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

  // Answer text reaches only the native response. Errors use fixed wording.
  userInputAnswers(input, answers) {
    const invalid = () => chatError('INVALID_USER_INPUT_ANSWER', 'Answer every question exactly once with one listed choice or allowed text')
    if (!Array.isArray(answers) || answers.length !== input.questions.length) throw invalid()
    const values = new Map()
    for (const answer of answers) {
      if (!answer || typeof answer !== 'object' || Array.isArray(answer)) throw invalid()
      const index = input.questions.findIndex(question => question.questionId === answer.questionId)
      if (index < 0 || values.has(index)) throw invalid()
      const question = input.questions[index]
      const hasOption = answer.optionIndex !== undefined, hasText = answer.text !== undefined
      if (hasOption === hasText) throw invalid()
      if (hasOption) {
        if (!question.options || !Number.isInteger(answer.optionIndex) || answer.optionIndex < 0 || answer.optionIndex >= question.options.length) throw invalid()
        values.set(index, input.rawLabels[index][answer.optionIndex])
      } else {
        if (question.options && !question.allowsOther) throw invalid()
        const text = typeof answer.text === 'string' ? answer.text : ''
        const trimmed = text.trim()
        // A private answer is sent exactly as typed; surrounding spaces may matter.
        if (!trimmed || trimmed.length > MAX_INPUT_ANSWER || text.includes('\0') || (question.isSecret && text.length > MAX_INPUT_ANSWER)) throw invalid()
        values.set(index, question.isSecret ? text : trimmed)
      }
    }
    return Object.fromEntries(input.questions.map((question, index) => [question.questionId, { answers: [values.get(index)] }]))
  }

  async replyUserInput(body) {
    this.assertReady()
    const input = typeof body.userInputId === 'string' ? this.pendingUserInputs.get(body.userInputId) : null
    if (!input || input.conversationId !== body.conversationId || input.runId !== body.runId || input.status !== 'pending') {
      throw chatError('STALE_USER_INPUT', 'Question is stale, already answered, or belongs to another run', 409)
    }
    if (!['submit', 'skip'].includes(body.action)) throw chatError('INVALID_USER_INPUT_ANSWER', 'Unsupported answer action')
    const run = this.findRun(body)
    if (TERMINAL.has(run.status)) throw chatError('STALE_USER_INPUT', 'Run has ended', 409)
    let answers = null
    if (body.action === 'submit') {
      answers = this.userInputAnswers(input, body.answers)
      if (!this.ownedRuns.has(run)) throw chatError('NATIVE_RUN_UNBOUND', 'This native run has no verified EG-Desk dispatch binding', 409)
      if (this.boundedRun(run)) throw chatError('BOUNDED_INPUT_FORBIDDEN', 'Bounded execution never answers an Agent question', 403)
    }
    // Mark before sending: a synchronous resolved event must not be overwritten.
    input.status = 'replySent'
    try {
      if (answers) this.respond(input.rpcId, { answers })
      else this.respond(input.rpcId, null, { code: -32000, message: 'User skipped the question' })
    } catch (error) {
      input.status = 'pending'
      throw error
    }
    const pending = run.pendingUserInputs.find(item => item.userInputId === input.userInputId)
    if (pending) pending.status = 'replySent'
    this.seq++
    return { accepted: true, userInputId: input.userInputId, conversationId: run.conversationId, runId: run.runId, status: 'replySent' }
  }

  boundedRun(run) {
    return BOUNDED_MODES.includes(run.executionPolicy?.mode) || BOUNDED_MODES.includes(this.threads.get(run.conversationId)?.executionPolicy)
  }

  handleNotification(message) {
    const event = cleanNotification(message.method, message.params)
    if (!event) return Promise.resolve()
    if (message.method === 'item/completed' && message.params?.item?.type === 'commandExecution') {
      const run = this.runs.get(runKey(event.threadId, event.turnId))
      const pending = this.pendingStarts.get(event.threadId)
      const mode = run?.executionPolicy?.mode || pending?.executionPolicy
      const markers = (run && this.qaOutputMarkersByRun.get(run.answerId)) || pending?.qaOutputMarkers
      if (mode === READ_ONLY_QA && markers) {
        event.qaCommandReceipt = nativeQaCommandReceipt(message.params.item, markers)
        event.qaOutputMarkers = markers
      }
    }
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
    // Keep the approval envelope so buffering, binding failure, unowned-run and
    // bounded-QA refusals apply unchanged. Invalid questions arrive as null.
    if (message.method === USER_INPUT_METHOD) return this.enqueue({
      method: 'approval', nativeMethod: message.method, rpcId: message.id,
      threadId: idText(p.threadId), turnId: idText(p.turnId), itemId: idText(p.itemId),
      isBlocking: p.isBlocking !== false, questions: safeUserInputQuestions(p.questions), choices: [],
    })
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
    const engineId = this.threadEngine(event.threadId)
    const epoch = this.epochOf(engineId)
    this.queue = this.queue.then(() => epoch === this.epochOf(engineId) ? this.apply(event) : undefined).catch(() => {
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
      for (const [id, input] of this.pendingUserInputs) if (input.rpcId === event.requestId && input.conversationId === event.threadId) {
        this.pendingUserInputs.delete(id)
        const run = this.runs.get(runKey(input.conversationId, input.runId))
        if (run) { run.pendingUserInputs = run.pendingUserInputs.filter(item => item.userInputId !== id); this.emit(run, 'userInput.resolved', { userInputId: id }) }
      }
      return
    }
    const run = this.runs.get(runKey(event.threadId, event.turnId))
    if (!run || !this.ownedRuns.has(run)) {
      if (event.method === 'approval' || event.method === 'dynamic') this.respond(event.rpcId, null, { code: -32601, message: 'No matching EG-Desk run' })
      // A child Agent thread never gains authority; its parent row shows the stall.
      if (!run && event.method === 'approval' && event.nativeMethod !== USER_INPUT_METHOD) this.markSubAgentBlocked(event.threadId)
      return
    }
    if (event.method === 'approval') return this.receiveApproval(run, event)
    if (event.method === 'dynamic') {
      if (run.status !== 'inProgress' || this.connectionOf(this.runEngine(run)) !== 'ready') {
        this.respond(event.rpcId, null, { code: -32601, message: 'EG-Desk run is no longer active' })
        return
      }
      const mode = run.executionPolicy?.mode || null
      const contextRead = !event.namespace && ['egdesk_list_context', 'egdesk_read_source'].includes(event.tool)
      const browser = !event.namespace && typeof event.tool === 'string' && event.tool.startsWith('egdesk_browser_')
      const selectedBrowser = browser && run.browserBinding?.cards?.find(card => card.cardId === event.arguments?.cardId)
      const boundedBrowser = selectedBrowser && ['observe', 'interact'].includes(selectedBrowser.permission)
        && (event.tool === 'egdesk_browser_observe' || (selectedBrowser.permission === 'interact'
          && BROWSER_INTERACTION_TOOLS.includes(event.tool)))
      if ((mode === READ_ONLY_QA && !contextRead && !(browser && event.tool === 'egdesk_browser_observe')) ||
          (mode === BROWSER_BOUNDED && !contextRead && !boundedBrowser) ||
          (mode === FIXTURE_BROWSER_QA && !contextRead && !(browser && ['egdesk_browser_observe', 'egdesk_browser_click', 'egdesk_browser_fill'].includes(event.tool))) ||
          (!mode && browser)) {
        this.respond(event.rpcId, null, { code: -32601, message: 'This run does not authorize the requested dynamic tool' })
        return
      }
      // AGENT-04: the Agent's ceiling wins over a Card's interaction grant.
      if (browser && !ceilingAllowsBrowserTool(run.toolCeiling, event.tool)) {
        this.respond(event.rpcId, null, { code: -32601, message: 'This Agent profile does not allow the requested Browser tool' })
        this.noteCeiling(run, `rpc:${typeof event.rpcId}:${event.rpcId}`, { ...browserRefusal(run.toolCeiling), tool: event.tool })
        return
      }
      const provider = this.threadToolOwners.get(run.conversationId)?.get(toolKey(event.namespace, event.tool))
      if (!provider?.dispatch) this.respond(event.rpcId, null, { code: -32601, message: 'Unsupported dynamic tool' })
      else if (this.dynamicRequestProviders.size >= 512 || this.dynamicRequestProviders.has(event.rpcId)) this.respond(event.rpcId, null, { code: -32000, message: 'Native tool callback capacity or ID conflict' })
      else {
        this.dynamicRequestProviders.set(event.rpcId, { provider, run, epoch: this.epochOf(this.runEngine(run)) })
        this.dispatchToolProvider(provider, run, event)
      }
      return
    }
    if (event.method === 'turn/completed') return this.finish(run, event.turn)
    // Item completion can be delivered asynchronously after the turn metadata.
    // Keep its authoritative public item without reopening or re-running the turn.
    if (event.method === 'item/completed') {
      await this.applyItem(run, { ...event.item, completionConfirmed: true }, true)
      if (event.qaCommandReceipt && run.executionPolicy?.mode === READ_ONLY_QA &&
          JSON.stringify(this.qaOutputMarkersByRun.get(run.answerId)) === JSON.stringify(event.qaOutputMarkers) &&
          !run.qaCommandReceipts?.some(receipt => receipt.nativeItemId === event.qaCommandReceipt.nativeItemId) &&
          (run.qaCommandReceipts?.length || 0) < 8) {
        const receipt = { ...event.qaCommandReceipt, originalProviderId: 'codex-native', nativeProviderId: 'codex-built-in-command', bridgeEpoch: this.epoch,
          contractFingerprint: this.getNativeContractFingerprint() || null }
        run.qaCommandReceipts ||= []
        run.qaCommandReceipts.push(receipt)
        this.emit(run, 'qa.command.receipt', receipt, event.item.id)
      }
      return
    }
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
    if ([READ_ONLY_QA, BROWSER_BOUNDED, FIXTURE_BROWSER_QA].includes(run.executionPolicy?.mode) ||
        [READ_ONLY_QA, BROWSER_BOUNDED, FIXTURE_BROWSER_QA].includes(this.threads.get(run.conversationId)?.executionPolicy)) {
      // A QA turn never grants an interactive escalation, even if native
      // unexpectedly asks despite approvalPolicy=never.
      const supported = ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(event.nativeMethod)
      if (supported) this.respond(event.rpcId, { decision: 'decline' })
      else this.respond(event.rpcId, null, { code: -32601, message: 'Read-only QA has no interactive approval capability' })
      run.error = publicError('Native read-only QA requested an approval; it was declined', 'QA_SCOPE_VIOLATION')
      this.emit(run, 'run.unavailable', { status: run.status, error: run.error })
      void this.engineOf(run.conversationId).interruptTurn(run.conversationId, run.runId).catch(() => {})
      return
    }
    if (event.nativeMethod === USER_INPUT_METHOD) return this.receiveUserInput(run, event)
    const kinds = { 'item/commandExecution/requestApproval': 'commandExecution', 'item/fileChange/requestApproval': 'fileChange' }
    const kind = kinds[event.nativeMethod]
    // AGENT-04: an action outside the Agent's ceiling is declined without a
    // card; the turn continues and the activity says why. Never auto-accepted.
    const refusal = kind && !TERMINAL.has(run.status) ? ceilingApprovalRefusal(run.toolCeiling, { kind, network: event.isNetworkApproval }) : null
    if (refusal) {
      this.respond(event.rpcId, { decision: 'decline' })
      const command = kind === 'commandExecution' ? event.command || run.activities.find(a => a.id === event.itemId)?.detail?.command : null
      this.noteCeiling(run, `rpc:${typeof event.rpcId}:${event.rpcId}`, { ...refusal, ...(command ? { command } : {}) })
      return
    }
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

  receiveUserInput(run, event) {
    if (TERMINAL.has(run.status) || this.connectionOf(this.runEngine(run)) !== 'ready') {
      this.respond(event.rpcId, null, { code: -32601, message: 'EG-Desk run is no longer active' })
      return
    }
    if (!event.questions) {
      this.respond(event.rpcId, null, { code: -32602, message: 'Invalid user input request' })
      run.error = publicError('Codex asked a question EG-Desk cannot safely display; nothing was answered', 'INVALID_USER_INPUT_REQUEST')
      this.emit(run, 'run.unavailable', { status: run.status, error: run.error })
      return
    }
    const userInputId = `input:${this.streamId}:${this.epoch}:${typeof event.rpcId}:${event.rpcId}`
    if (this.pendingUserInputs.has(userInputId)) return
    if (this.pendingApprovals.size + this.pendingUserInputs.size >= MAX_ITEMS) {
      this.respond(event.rpcId, null, { code: -32000, message: 'Too many pending user input requests' })
      return
    }
    const pending = {
      userInputId, kind: 'userInput', status: 'pending', itemId: event.itemId, isBlocking: event.isBlocking,
      questions: event.questions.map(({ rawLabels, ...question }) => question),
    }
    this.pendingUserInputs.set(userInputId, { ...pending, rpcId: event.rpcId, conversationId: run.conversationId, runId: run.runId, rawLabels: event.questions.map(question => question.rawLabels) })
    run.pendingUserInputs.push(pending)
    this.emit(run, 'userInput.required', pending, event.itemId)
  }

  // AGENT-04: one activity row per refusal (or narrowed selection) so the
  // activity record shows what the Agent's ceiling stopped. A 'completed' row
  // is a notice from the thread check (external browser MCP still inherited,
  // or feature state this Codex build could not report). Fixed keys only.
  noteCeiling(run, key, { axis, title, status = 'declined', command = null, tool = null, externalBrowserToolsStillInherited = false, nativeFeatureCheck = null }) {
    const activity = {
      id: `ceiling-${createHash('sha256').update(`${run.answerId}\0${key}`).digest('hex').slice(0, 24)}`,
      kind: 'toolCeiling', status: status === 'completed' ? 'completed' : 'declined', title,
      detail: {
        axis, limit: run.toolCeiling?.[axis] ?? null, ...(command ? { command: publicText(command, 2000) } : {}), ...(tool ? { tool: publicText(tool, 120) } : {}),
        ...(externalBrowserToolsStillInherited === true ? { externalBrowserToolsStillInherited: true } : {}),
        ...(nativeFeatureCheck === 'unavailable' ? { nativeFeatureCheck: 'unavailable' } : {}),
      },
      sourceRefs: [],
    }
    this.put(run, 'activities', activity)
    this.emit(run, 'activity.completed', activity)
  }

  clearUserInputs(run) {
    for (const [id, input] of this.pendingUserInputs) if (input.conversationId === run.conversationId && input.runId === run.runId) this.pendingUserInputs.delete(id)
    const cleared = run.pendingUserInputs || []
    run.pendingUserInputs = []
    for (const input of cleared) this.emit(run, 'userInput.resolved', { userInputId: input.userInputId })
  }

  // Display only: the child's request was already refused without authority.
  markSubAgentBlocked(threadId) {
    if (!threadId) return
    const run = [...this.runs.values()].reverse().find(candidate => this.ownedRuns.has(candidate) && candidate.subAgents?.some(row => row.threadId === threadId))
    if (run) this.updateSubAgentRows(run, [{ threadId, create: false, blockedApproval: true }], true)
  }

  updateSubAgents(run, item, announce) {
    const updates = []
    if (item.type === 'collabAgentToolCall') {
      const revive = REVIVE_TOOLS.has(item.tool)
      const states = new Map(item.agentStates.map(entry => [entry.threadId, entry]))
      for (const threadId of new Set([...item.receiverThreadIds, ...states.keys()])) {
        if (threadId === run.conversationId) continue
        const entry = states.get(threadId)
        const receiver = item.receiverThreadIds.includes(threadId)
        updates.push({
          threadId, revive,
          ...(receiver ? { lastTool: item.tool } : {}),
          ...(receiver && item.tool === 'spawnAgent' ? { taskPreview: item.taskPreview, model: item.model, initialState: item.status === 'failed' ? 'unknown' : 'starting' } : {}),
          ...(entry ? { state: entry.state, message: entry.message } : {}),
        })
      }
    } else if (item.type === 'subAgentActivity' && item.agentThreadId && item.agentThreadId !== run.conversationId) {
      const state = ACTIVITY_STATE[item.kind]
      updates.push({ threadId: item.agentThreadId, label: item.agentPath, model: item.model, ...(state ? { state, revive: item.kind === 'started' || item.kind === 'interacted' } : {}) })
    }
    this.updateSubAgentRows(run, updates, announce)
  }

  // One bounded row per child thread; IDs stay values, never object keys.
  updateSubAgentRows(run, updates, announce) {
    if (!updates.length) return
    run.subAgents ||= []
    const changed = new Set()
    for (const update of updates) {
      let row = run.subAgents.find(candidate => candidate.threadId === update.threadId)
      if (!row) {
        if (update.create === false) continue
        if (run.subAgents.length >= MAX_SUBAGENTS) { run.truncated = true; continue }
        row = { threadId: update.threadId, label: null, taskPreview: null, model: null, state: update.initialState || 'unknown', message: null, lastTool: null, blocked: null, updatedAt: this.now(), parentEnded: false }
        run.subAgents.push(row)
        changed.add(row)
      }
      const before = JSON.stringify({ ...row, updatedAt: 0 })
      for (const key of ['label', 'taskPreview', 'model', 'lastTool']) if (update[key]) row[key] = update[key]
      // Only resume-type signals may reopen a finished child; stale snapshots may not.
      const regress = SUBAGENT_DONE.has(row.state) && ['running', 'starting'].includes(update.state) && !update.revive
      if (update.state && !regress) {
        row.state = update.state
        if (update.message !== undefined) row.message = update.message
      }
      const approval = update.blockedApproval || (row.blocked?.reason === 'approvalRequested' && !SUBAGENT_DONE.has(row.state) && !update.revive)
      row.blocked = row.state === 'errored' ? { reason: 'errored' } : row.state === 'notFound' ? { reason: 'notFound' } : approval ? { reason: 'approvalRequested' } : null
      if (JSON.stringify({ ...row, updatedAt: 0 }) !== before) { row.updatedAt = this.now(); changed.add(row) }
    }
    if (announce) for (const row of changed) this.emit(run, 'subagent.updated', { subAgent: row })
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
    const epoch = this.epochOf(this.runEngine(run))
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
        if (epoch !== this.epochOf(this.runEngine(run))) return
        if (target) activity.sourceRefs.push({ type: 'file', target: { path: target }, status: 'available', openable: true })
      }
    } else if (item.type === 'mcpToolCall') {
      activity.status = item.status
      activity.title = `${item.server} / ${item.tool}`
      activity.detail = { server: item.server, tool: item.tool, durationMs: item.durationMs, controlKind: this.mcpCallControlKind(run, item) }
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
    } else if (item.type === 'collabAgentToolCall') {
      // Prompt text stays out of activity detail; only the row keeps a short preview.
      activity.status = item.status
      activity.title = item.tool
      activity.detail = { tool: item.tool, status: item.status, receiverCount: item.receiverThreadIds.length, states: item.agentStates.map(entry => entry.state) }
    } else if (item.type === 'subAgentActivity') {
      activity.title = 'Sub-agent'
      activity.detail = { status: item.kind, state: ACTIVITY_STATE[item.kind] || 'unknown' }
    } else return
    this.put(run, 'activities', activity)
    if (announce) this.emit(run, completed ? 'activity.completed' : 'activity.started', activity, item.id)
    if (item.type !== 'collabAgentToolCall' && item.type !== 'subAgentActivity') return
    if (this.boundedRun(run)) {
      // Bounded threads disable multi_agent; any collaboration is out of scope.
      if (item.type === 'collabAgentToolCall' && announce && !TERMINAL.has(run.status) && run.error?.code !== 'QA_SCOPE_VIOLATION') {
        run.error = publicError('Bounded execution attempted to start or steer another Agent; the turn was stopped', 'QA_SCOPE_VIOLATION')
        this.emit(run, 'run.unavailable', { status: run.status, error: run.error })
        void this.engineOf(run.conversationId).interruptTurn(run.conversationId, run.runId).catch(() => {})
      }
      return
    }
    this.updateSubAgents(run, item, announce)
  }

  async collectArtifacts(run, item, announce) {
    const epoch = this.epochOf(this.runEngine(run))
    for (const link of explicitFileLinks(item.text)) {
      const target = await this.verifyFile(link.path, { artifact: true })
      if (epoch !== this.epochOf(this.runEngine(run))) return
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
    const epoch = this.epochOf(this.runEngine(run))
    if (TERMINAL.has(run.status) && run.error?.origin !== 'bridge') return
    for (const item of turn.items) await this.applyItem(run, item, true)
    if (epoch !== this.epochOf(this.runEngine(run))) return
    if (!TERMINAL.has(turn.status)) return
    // A disconnect/interruption may omit item/completed. Retain received public
    // text, but never invent an answer or infer task success from that text.
    for (const message of [...run.messages]) if (message.role === 'assistant' && message.status === 'streaming') {
      const raw = this.rawMessages.get(`${run.answerId}/${message.id}`)
      if (raw !== undefined) await this.applyItem(run, { id: message.id, type: 'agentMessage', text: raw, phase: message.phase }, true)
    }
    if (epoch !== this.epochOf(this.runEngine(run))) return
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
    for (const [id, pending] of this.dynamicRequestProviders) if (pending.run === run) this.dynamicRequestProviders.delete(id)
    run.pendingApprovals = []
    this.clearUserInputs(run)
    // Child Agents may keep running after this turn; do not invent their outcome.
    for (const row of run.subAgents || []) row.parentEnded = true
    for (const key of this.rawMessages.keys()) if (key.startsWith(`${run.answerId}/`)) this.rawMessages.delete(key)
    for (const key of this.visibleMessages.keys()) if (key.startsWith(`${run.answerId}/`)) this.visibleMessages.delete(key)
    this.emit(run, 'run.completed', { status: run.status, stopRequested: run.stopRequested, stopConfirmed: run.stopConfirmed, error: run.error })
    if (run.status === 'completed') this.emitLegacy({ type: 'assistant-complete', conversationId: run.conversationId, messageId: run.answerId })
    else this.emitLegacy({ type: 'assistant-error', conversationId: run.conversationId, messageId: run.answerId, error: run.error?.message || 'Codex response was interrupted.' })
  }

  // True while a send would be refused or queued behind other work: a request
  // is starting or resuming, a turn is active or unreconciled, or the thread
  // needs an explicit resume. Synchronous, so a caller that sees false and
  // calls send() in the same tick takes the conversation's start lock first.
  conversationBusy(conversationId) {
    const cid = idText(conversationId)
    if (!cid) return false
    return this.locks.has(cid) || this.pendingStarts.has(cid) || this.pendingResumes.has(cid) || this.uncertainThreads.has(cid)
      || [...this.runs.values()].some(run => run.conversationId === cid && !TERMINAL.has(run.status))
  }

  // controlKind of an MCP call: the call's own kind, strengthened by the
  // inherited Codex classification of its server name (Codex runs only; a
  // node_repl declared with a Computer Use marker becomes 'computer').
  mcpCallControlKind(run, item) {
    let inherited = null
    if (this.runEngine(run) === 'codex') { try { inherited = this.mcpServerKind(item.server) } catch {} }
    return strongerControlKind(item.controlKind || 'other', inherited ? mcpControlKind(inherited) : 'other')
  }

  computerControlSnapshot() {
    const { policy, verified, persisted } = this.computerControl
    return this.computerControlStore ? { policy, verified, persisted } : { policy, verified }
  }

  // POST /settings/computer-control. A changed policy is unconfirmed until the
  // next ordinary thread is read back; loaded threads are reloaded on their next send.
  // With a store the policy is saved too; a failed save still applies the
  // policy and reports persisted: false.
  setComputerControlPolicy(value) {
    const policy = normalizeComputerControlPolicy(value)
    const patch = policy !== this.computerControl.policy ? { policy, verified: null } : {}
    if (this.computerControlStore) {
      let saved = false
      try { saved = this.computerControlStore.save(policy) === true } catch {}
      patch.persisted = saved
    }
    this.updateComputerControl(patch)
    return this.computerControlSnapshot()
  }

  updateComputerControl(patch) {
    const next = { ...this.computerControl, ...patch }
    if (next.policy === this.computerControl.policy && next.verified === this.computerControl.verified && next.persisted === this.computerControl.persisted) return
    this.computerControl = next
    try { this.onComputerControlChange(this.computerControlSnapshot()) } catch {}
  }

  // 'off' thread settings for an ordinary Codex thread; a failure is recorded as unconfirmed.
  async computerControlOffOverrides(cwd) {
    try { return await loadComputerControlOffOverrides(this.request, { cwd }) }
    catch (error) {
      if (this.computerControl.policy === 'off') this.updateComputerControl({ verified: false })
      throw error
    }
  }

  // Reads the thread back and records the result; the caller marks the loaded
  // thread as off only after this returns.
  async verifyComputerControl(cid, prepared) {
    let report
    try { report = await verifyComputerControlOff(this.request, cid, prepared.plan) }
    catch (error) {
      if (this.computerControl.policy === 'off') this.updateComputerControl({ verified: false })
      throw error
    }
    if (this.computerControl.policy === 'off') this.updateComputerControl({ verified: report.nativeFeatures === 'verified' ? true : null })
    return report
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
