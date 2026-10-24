import { createHash } from 'node:crypto'
import path from 'node:path'
import { sendJson } from './codex-bridge-http.mjs'
import { publicText } from './codex-chat-values.mjs'
import { createAwaitGateRouter } from './egdesk-await-router.mjs'
import { createWorkflowEventBus, createWorkflowEventHttpHandler } from './egdesk-event-bus.mjs'
import { createConnectedRootWatcher } from './egdesk-file-watch.mjs'
import { openTaskGraph } from './egdesk-task-graph.mjs'
import { createTaskHttpHandler, publicGraph } from './egdesk-task-http.mjs'
import { createNativeTaskAdapter } from './egdesk-task-native.mjs'
import { nativeHash, nativeTaskError, openNativeTaskLedger } from './egdesk-task-native-store.mjs'
import { createTaskPlanHttpHandler, createTaskPlanService, openTaskPlanStore } from './egdesk-task-plans.mjs'
import { createTaskSourceHttpHandler, openTaskSourceRegistry } from './egdesk-task-sources.mjs'
import { openTaskStore } from './egdesk-task-store.mjs'

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
 */
export async function openWorkflowRuntime({
  dataDir, chat, port = 39218, broadcast = () => {}, ensureAuth, getOwnerKey,
  maxConcurrency = 2, owner = WORKFLOW_OWNER, watch, openStores = null,
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

  const ownerKey = () => {
    const key = getOwnerKey()
    return typeof key === 'string' && key ? hashed('owner', key) : null
  }
  function captureScope(context) {
    const key = ownerKey()
    if (!key) throw nativeTaskError('TASK_AUTHORITY', 'Sign in to run Agent tasks', 403)
    const scope = context?.scope ?? {}
    return { ownerKey: key, generation: authGeneration,
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
  // While a same-thread plan step waits for its conversation, scheduling is
  // retried on chat turn endings and, as a fallback, once a second.
  let heldTimer = null
  let kickQueued = false
  function holdRetry() {
    if (heldTimer || !graph) return
    heldTimer = setTimeout(() => { heldTimer = null; void graph?.reschedule().catch(() => {}) }, 1000)
    heldTimer.unref?.()
  }
  function kick() {
    if (kickQueued) return
    kickQueued = true
    setImmediate(() => {
      kickQueued = false
      taskChat?.pump?.()
      if (heldTimer && graph) void graph.reschedule().catch(() => {})
    })
  }
  try {
    // openStores (tests) may omit sourceDirectory/planDirectory to keep them in memory.
    const stores = openStores ? await openStores() : {
      store: await openTaskStore(path.join(dataDir, 'task-graph')),
      ledger: await openNativeTaskLedger(path.join(dataDir, 'task-native')),
      sourceDirectory: path.join(dataDir, 'task-sources'),
      planDirectory: path.join(dataDir, 'task-plans'),
    }
    sources = await openTaskSourceRegistry({ directory: stores.sourceDirectory ?? null, getOwnerKey: ownerKey })
    const planStore = await openTaskPlanStore({ directory: stores.planDirectory ?? null })
    taskChat = sameThreadChat(chat, { wanted: body => {
      try {
        const attempt = stores.ledger.snapshot().attempts.find(item => item.requestId === body.requestId)
        if (!attempt || attempt.interruptRequested) return false
        const graphId = attempt.binding.graphId
        return !graph?.getGraph(graphId)?.cancelRequested && adapter?.getState(graphId)?.fenced === false
      } catch { return false }
    } })
    adapter = createNativeTaskAdapter({ chat: taskChat, ledger: stores.ledger,
      resolveTaskInput: context => plans?.resolveTaskInput(context) ?? sources.resolve(context),
      captureScope, assertDelegationCurrent })
    graph = await openTaskGraph({ store: stores.store, maxConcurrency, execute: adapter.execute, interrupt: adapter.interrupt,
      requestApproval: adapter.requestApproval, verifyReceipt: adapter.verifyReceipt,
      canStart: context => plans ? plans.canStart(context) : true })
    plans = createTaskPlanService({ store: planStore, sources, graph, adapter, chat, getOwnerKey: ownerKey,
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
    handleTasks = createTaskHttpHandler({ graph, adapter, ensureAuth, port, continueGate: async ({ graphId, taskId, gateId }) => {
      bus.publish({ topic: 'user.action', owner, payload: { graphId, taskId, gateId } })
      await bus.flush()
    } })
    handleSources = createTaskSourceHttpHandler({ sources, ensureAuth, port })
    handlePlans = createTaskPlanHttpHandler({ plans, ensureAuth, port })
  } catch (error) {
    tasksError = publicText(error?.message || 'Local task storage failed to open', 1000)
    unsubscribeGraph()
    unsubscribeGraph = () => {}
    router?.close()
    graph?.close?.()
    taskChat?.close?.()
    graph = null; adapter = null; router = null; handleTasks = null; handleSources = null; handlePlans = null; plans = null; taskChat = null
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
      router?.close()
      graph?.close?.()
      taskChat?.close?.()
      if (heldTimer) clearTimeout(heldTimer)
      heldTimer = null
      unsubscribeGraph()
      unsubscribeSse()
      files.close()
      bus.close()
    },
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
