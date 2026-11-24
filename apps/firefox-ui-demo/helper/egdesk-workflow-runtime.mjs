import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'
import { sendJson } from './codex-bridge-http.mjs'
import { publicText } from './codex-chat-values.mjs'
import { appendAnswers } from './egdesk-await-resume.mjs'
import { createAwaitGateRouter } from './egdesk-await-router.mjs'
import { createWorkflowEventBus, createWorkflowEventHttpHandler } from './egdesk-event-bus.mjs'
import { createConnectedRootWatcher } from './egdesk-file-watch.mjs'
import { openTaskGraph } from './egdesk-task-graph.mjs'
import { createTaskHttpHandler, publicGraph } from './egdesk-task-http.mjs'
import { createNativeTaskAdapter } from './egdesk-task-native.mjs'
import { nativeHash, nativeTaskError, openNativeTaskLedger } from './egdesk-task-native-store.mjs'
import { createTaskPlanHttpHandler, createTaskPlanService, gateAnswerFacts, openTaskPlanStore } from './egdesk-task-plans.mjs'
import { createTaskSourceHttpHandler, openTaskSourceRegistry } from './egdesk-task-sources.mjs'
import { openTaskStore } from './egdesk-task-store.mjs'
import { openWorkflowStore } from './egdesk-workflow-store.mjs'

export const WORKFLOW_OWNER = 'egdesk-local'
const hashed = (prefix, value) => `${prefix}-${createHash('sha256').update(String(value)).digest('hex').slice(0, 32)}`

/**
 * Bridge wiring for RT-06 + CHAT-06: the workflow event bus, connected-root
 * file watching, the task graph with its native Codex adapter, the gate router,
 * and their HTTP routes. SSE frames go out through broadcast(frame).
 *
 * SSE (event: codex):
 *   { type: 'workflow.event', v: 1, event: { seq, id, at, topic, source, summary, payload }, ts }
 *   { type: 'task.graph', v: 1, graphId, change, graph, ts }   graph = GET /tasks/state graph
 *   { type: 'task.native', v: 1, ts }   hint: refetch GET /tasks/state (e.g. a preapproval ID was issued)
 *   { type: 'task.plan', v: 1, planId, change: 'proposed'|'approved'|'rejected', plan, ts }
 *     plan = one entry of GET /tasks/plans (no instructions)
 * A gate whose expiresAt/timeoutMs ran out arrives as task.graph with change 'task-gate-expired';
 * the gate shows status 'expired' and opens only through POST /tasks/continue.
 * Routes: /tasks/plans* (egdesk-task-plans.mjs), /tasks/* (egdesk-task-http.mjs),
 * POST /task-sources, POST /events/browser, GET /events/recent.
 *
 * Plan steps that continue in their original conversation (resumeIn 'sameThread')
 * stay ready while that conversation is busy and start after its turn ends.
 *
 * Task storage failing to open leaves events working; task routes answer 503.
 *
 * Storage (RT-07): one SQLite file, dataDir/workflow-store/workflow.sqlite
 * (egdesk-workflow-store.mjs), holds the graph journal, native ledger, task
 * sources, gate answers and plans. The JSON files of earlier versions
 * (dataDir/task-graph, task-native, task-sources, task-plans) are imported
 * once and left as they are.
 *
 * Question gates (CHAT-06): POST /tasks/continue with answer opens a userAction
 * gate that has response. A chosen option is journaled with the gate; written
 * text is kept with the task sources and the journal names it. The bus event
 * stays { graphId, taskId, gateId }, so no answer reaches SSE or /events/recent.
 * The step's message carries the answers (plans: <answers> in the resume block;
 * other graphs: lines after the task's own message).
 */
export async function openWorkflowRuntime({
  dataDir, chat, port = 39218, broadcast = () => {}, ensureAuth, getOwnerKey,
  maxConcurrency = 2, owner = WORKFLOW_OWNER, watch, openStores = null, localCapacity = null,
  // L1 c25 (U11, only passed with the room-account flag on): ownerKeyFor(slot) = the raw account key of an Agent profile slot; roomSlotOf(origin) = the slot a
  // plan's room runs on; roomKeyed() = flag on. Without them every plan, source and step uses the default sign-in, as before.
  ownerKeyFor = null, roomSlotOf = null, roomKeyed = () => false,
} = {}) {
  if (typeof ensureAuth !== 'function' || typeof getOwnerKey !== 'function') throw new TypeError('ensureAuth and getOwnerKey are required')
  const bus = createWorkflowEventBus()
  const unsubscribeSse = bus.subscribe({ owner }, event => broadcast({ type: 'workflow.event', v: 1, event, ts: Date.now() }))
  const files = createConnectedRootWatcher({ bus, owner, ...(watch ? { watch } : {}) })
  const handleEvents = createWorkflowEventHttpHandler({ bus, owner, port })

  // Account changes are compared in memory only; events carry signedIn alone.
  let authKey = 'false:'
  let authGeneration = 0
  function observeAuth({ signedIn, accountKey }) {
    const next = typeof accountKey === 'string' ? accountKey : `${signedIn === true}:`
    if (next === authKey) return
    authKey = next
    authGeneration += 1
    try { bus.publish({ topic: 'auth.changed', owner, payload: { signedIn: signedIn === true } }) } catch {}
  }

  const rawOwnerKey = slot => (slot && typeof ownerKeyFor === 'function' ? ownerKeyFor(slot) : getOwnerKey())
  const ownerKey = slot => {
    const key = rawOwnerKey(slot)
    return typeof key === 'string' && key ? hashed('owner', key) : null
  }
  // a plan's Board/graph belongs to the room's slot (undefined = default)
  const slotOfGraph = graphId => { try { return plans?.slotOfGraph?.(graphId) } catch { return undefined } }
  const slotOfBoard = boardId => { try { return plans?.slotOfBoard?.(boardId) } catch { return undefined } }
  function captureScope(context) {
    const slot = slotOfGraph(context?.binding?.graphId ?? context?.scope?.graphId)
    const key = ownerKey(slot)
    if (!key) throw nativeTaskError('TASK_AUTHORITY', 'Sign in to run Agent tasks', 403)
    const scope = context?.scope ?? {}
    // a profile slot's scope does not move with the default sign-in: the account key in the scope already ends it when THAT account changes
    return { ownerKey: key, generation: slot ? 0 : authGeneration,
      delegationKey: hashed('delegation', nativeHash({ boardId: context?.boardId ?? null, runId: scope.runId ?? null,
        parentTaskId: scope.parentTaskId ?? null, requestedBy: scope.requestedBy ?? null })) }
  }
  function assertDelegationCurrent(captured, context) {
    try {
      const current = captureScope(context)
      return current.ownerKey === captured.ownerKey && current.generation === captured.generation &&
        current.delegationKey === captured.delegationKey
    } catch { return false }
  }

  let graph = null
  let adapter = null
  let router = null
  let unsubscribeGraph = () => {}
  let handleTasks = null
  let handleSources = null
  let handlePlans = null
  let tasksError = null
  let sources = null
  let plans = null
  let taskChat = null
  let stores = null
  // While a same-thread plan step waits for its conversation, scheduling is
  // retried on chat turn endings and, as a fallback, once a second.
  let heldTimer = null
  let kickQueued = false
  let closed = false
  function holdRetry() {
    if (closed || heldTimer || !graph) return
    heldTimer = setTimeout(() => { heldTimer = null; void graph?.reschedule().catch(() => {}) }, 1000)
    heldTimer.unref?.()
  }
  function kick() {
    if (closed || kickQueued) return
    kickQueued = true
    setImmediate(() => {
      kickQueued = false
      if (closed) return
      taskChat?.pump?.()
      if (heldTimer && graph) void graph.reschedule().catch(() => {})
    })
  }
  try {
    // openStores (tests) returns { store, ledger, sourceOptions?, planOptions?, close? };
    // without sourceOptions/planOptions those stay in memory.
    stores = openStores ? await openStores() : await openDurableStores(dataDir)
    sources = await openTaskSourceRegistry({ ...(stores.sourceOptions ?? {}), getOwnerKey: boardId => ownerKey(slotOfBoard(boardId)) })
    const planStore = await openTaskPlanStore(stores.planOptions ?? {})
    taskChat = sameThreadChat(chat, { wanted: body => {
      try {
        const attempt = stores.ledger.snapshot().attempts.find(item => item.requestId === body.requestId)
        if (!attempt || attempt.interruptRequested) return false
        const graphId = attempt.binding.graphId
        return !graph?.getGraph(graphId)?.cancelRequested && adapter?.getState(graphId)?.fenced === false
      } catch { return false }
    } })
    adapter = createNativeTaskAdapter({ chat: taskChat, ledger: stores.ledger,
      resolveTaskInput: context => plans?.resolveTaskInput(context) ?? withAnswers(sources.resolve(context), context),
      captureScope, assertDelegationCurrent })
    graph = await openTaskGraph({ store: stores.store, maxConcurrency, execute: adapter.execute, interrupt: adapter.interrupt,
      requestApproval: adapter.requestApproval, verifyReceipt: adapter.verifyReceipt,
      canStart: context => plans ? plans.canStart(context) : true,
      additionalLaunchReason: () => localCapacity?.additionalLaunchReason(),
      onQueueChange: (graphId, pressure) => {
        if (pressure) holdRetry()
        if (graphId) broadcast({ type: 'task.graph', v: 1, graphId, change: 'task-queue-changed', graph: publicGraph(graph.getGraph(graphId)), ts: Date.now() })
      } })
    plans = createTaskPlanService({ store: planStore, sources, graph, adapter, chat, getOwnerKey: ownerKey, roomKeyed,
      ...(typeof roomSlotOf === 'function' ? { slotOf: roomSlotOf } : {}),
      broadcast: frame => broadcast(frame), onBlocked: holdRetry })
    unsubscribeGraph = graph.subscribe(journalEvent => {
      const graphId = journalEvent.graphId ?? journalEvent.graph?.graphId
      if (!graphId) return
      broadcast({ type: 'task.graph', v: 1, graphId, change: journalEvent.type, graph: publicGraph(graph.getGraph(graphId)), ts: Date.now() })
    })
    // Native-side changes (a preapproval ID issued, an attempt settled) carry no
    // graph ID; one coalesced hint tells the screen to refetch /tasks/state.
    let hintTimer = null
    const unsubscribeNative = adapter.subscribe(() => {
      if (hintTimer) return
      hintTimer = setTimeout(() => { hintTimer = null; broadcast({ type: 'task.native', v: 1, ts: Date.now() }) }, 50)
      hintTimer.unref?.()
    })
    const unsubscribeJournal = unsubscribeGraph
    unsubscribeGraph = () => { unsubscribeJournal(); unsubscribeNative(); if (hintTimer) clearTimeout(hintTimer); hintTimer = null }
    router = createAwaitGateRouter({ graph, bus, owner })
    handleTasks = createTaskHttpHandler({ graph, adapter, ensureAuth, port, continueGate })
    handleSources = createTaskSourceHttpHandler({ sources, ensureAuth, port })
    handlePlans = createTaskPlanHttpHandler({ plans, ensureAuth, port })
  } catch (error) {
    tasksError = publicText(error?.message || 'Local task storage failed to open', 1000)
    unsubscribeGraph()
    unsubscribeGraph = () => {}
    router?.close()
    graph?.close?.()
    taskChat?.close?.()
    try { stores?.close?.() } catch { /* the open error is the one reported */ }
    graph = null; adapter = null; router = null; handleTasks = null; handleSources = null; handlePlans = null; plans = null; taskChat = null
    stores = null
  }

  // A graph task that is not a plan step still gets 대표님's answers after its own message.
  function withAnswers(input, context) {
    const binding = context?.binding
    const answers = gateAnswerFacts({ graph, sources, graphId: binding?.graphId, taskId: binding?.taskId, boardId: context?.boardId })
    return answers.length ? { ...input, message: appendAnswers(input.message, answers) } : input
  }

  // POST /tasks/continue (already checked by egdesk-task-http.mjs). Without an
  // answer: the user.action event opens the gate through the router, as before.
  // With one: the answer is kept first (written text with the sources), then the
  // gate is satisfied directly with it. The router's own attempt for the same
  // event carries no answer and is refused by the graph, so it cannot open a
  // question gate without its answer.
  async function continueGate({ graphId, taskId, gateId, boardId, answer }) {
    if (answer === undefined) {
      bus.publish({ topic: 'user.action', owner, payload: { graphId, taskId, gateId } })
      await bus.flush()
      return
    }
    const journaled = answer.text === undefined ? { choice: answer.choice }
      : { textRef: (await sources.recordAnswer({ boardId, graphId, taskId, gateId, text: answer.text })).textRef }
    const event = bus.publish({ topic: 'user.action', owner, payload: { graphId, taskId, gateId } })
    await graph.satisfyGate({ graphId, taskId, gateId, evidence: { eventId: event?.id ?? `wfe-${randomUUID()}`,
      topic: 'user.action', at: event?.at ?? new Date().toISOString(), answer: journaled } })
    await bus.flush()
  }

  async function handle(req, res, url) {
    if (await handleEvents(req, res, url)) return true
    const taskRoute = url.pathname.startsWith('/tasks/') || url.pathname === '/task-sources'
    if (!taskRoute) return false
    if (!handleTasks) {
      sendJson(res, 503, { code: 'TASK_STORAGE_UNAVAILABLE', error: 'Local task storage is unavailable' })
      return true
    }
    if (await handleSources(req, res, url)) return true
    if (await handlePlans(req, res, url)) return true
    return handleTasks(req, res)
  }

  return {
    bus, files,
    get sources() { return sources },
    get graph() { return graph },
    get adapter() { return adapter },
    // The plan service egdesk_propose_plan proposes through; null while task storage is unavailable.
    get plans() { return plans },
    handle,
    observeAuth,
    watchRoot: root => files.watchRoot(root),
    publishTerminalExit({ sessionId, exitCode = null, signal = null } = {}) {
      try { bus.publish({ topic: 'terminal.exit', owner, payload: { sessionId, exitCode, signal } }) } catch {}
    },
    // Wire to the chat runtime's v2 emit: run.started/run.completed settle task attempts.
    onChatEvent(event) {
      if (!adapter) return null
      // A turn ending may free a conversation a same-thread plan step waits for.
      if (['run.completed', 'run.unavailable', 'run.reconciled'].includes(event?.event)) kick()
      try { return adapter.onChatEvent(event).catch(() => ({ matched: false })) } catch { return null }
    },
    snapshot() {
      const { seq, dropped } = bus.stats()
      return { tasks: graph ? 'ready' : 'unavailable', taskError: tasksError, maxConcurrency, eventSeq: seq, droppedEvents: dropped, ...files.snapshot() }
    },
    async close() {
      closed = true
      router?.close()
      graph?.close?.()
      taskChat?.close?.()
      if (heldTimer) clearTimeout(heldTimer)
      heldTimer = null
      unsubscribeGraph()
      unsubscribeSse()
      files.close()
      bus.close()
      // Writes already queued finish before the database closes; later ones are refused.
      await Promise.allSettled([graph?.drain?.(), stores?.ledger?.drain?.()])
      try { stores?.close?.() } catch { /* already closed */ }
    },
  }
}

/**
 * One SQLite store for the graph journal, native ledger, sources and plans,
 * importing the JSON files of earlier versions once (they stay untouched).
 */
async function openDurableStores(dataDir) {
  const workflowStore = openWorkflowStore({ directory: path.join(dataDir, 'workflow-store') })
  try {
    return {
      store: await openTaskStore({ store: workflowStore, legacyDirectory: path.join(dataDir, 'task-graph') }),
      ledger: await openNativeTaskLedger({ store: workflowStore, legacyDirectory: path.join(dataDir, 'task-native') }),
      sourceOptions: { store: workflowStore, legacyDirectory: path.join(dataDir, 'task-sources') },
      planOptions: { store: workflowStore, legacyDirectory: path.join(dataDir, 'task-plans') },
      close: () => workflowStore.close(),
    }
  } catch (error) {
    workflowStore.close()
    throw error
  }
}

/**
 * The chat the task adapter sends through. A send naming an existing
 * conversation (a same-thread plan step) goes out only while that conversation
 * is idle: the busy check and the start of chat.send happen in one tick, so the
 * send takes the conversation's start lock before anyone else can. Otherwise it
 * waits, and is dropped (never sent) if its task was cancelled meanwhile.
 */
function sameThreadChat(chat, { wanted }) {
  if (!['send', 'interrupt', 'resume', 'snapshot'].every(key => typeof chat?.[key] === 'function')) return chat
  const waiting = []
  let timer = null
  const busy = conversationId => typeof chat.conversationBusy === 'function' && chat.conversationBusy(conversationId)
  function pump() {
    for (let index = 0; index < waiting.length;) {
      const entry = waiting[index]
      if (busy(entry.body.conversationId)) { index += 1; continue }
      waiting.splice(index, 1)
      if (!wanted(entry.body)) { entry.reject(nativeTaskError('TASK_FENCED', 'The task stopped before its conversation was free')); continue }
      try { entry.resolve(chat.send(entry.body)) } catch (error) { entry.reject(error) }
    }
    if (waiting.length && !timer) {
      timer = setTimeout(() => { timer = null; pump() }, 250)
      timer.unref?.()
    }
  }
  return {
    send(body) {
      const conversationId = body?.conversationId
      if (typeof conversationId !== 'string' || (!busy(conversationId) && !waiting.some(entry => entry.body.conversationId === conversationId))) {
        return chat.send(body)
      }
      return new Promise((resolve, reject) => { waiting.push({ body, resolve, reject }); pump() })
    },
    interrupt: (...args) => chat.interrupt(...args),
    resume: (...args) => chat.resume(...args),
    snapshot: (...args) => chat.snapshot(...args),
    pump,
    close() { if (timer) clearTimeout(timer); timer = null },
  }
}
