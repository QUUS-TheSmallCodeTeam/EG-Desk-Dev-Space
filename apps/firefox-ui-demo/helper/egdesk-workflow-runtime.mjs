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
 * Routes: /tasks/* (egdesk-task-http.mjs), POST /task-sources, POST /events/browser, GET /events/recent.
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
  let tasksError = null
  let sources = null
  try {
    // openStores (tests) may omit sourceDirectory to keep task sources in memory.
    const stores = openStores ? await openStores() : {
      store: await openTaskStore(path.join(dataDir, 'task-graph')),
      ledger: await openNativeTaskLedger(path.join(dataDir, 'task-native')),
      sourceDirectory: path.join(dataDir, 'task-sources'),
    }
    sources = await openTaskSourceRegistry({ directory: stores.sourceDirectory ?? null, getOwnerKey: ownerKey })
    adapter = createNativeTaskAdapter({ chat, ledger: stores.ledger, resolveTaskInput: context => sources.resolve(context),
      captureScope, assertDelegationCurrent })
    graph = await openTaskGraph({ store: stores.store, maxConcurrency, execute: adapter.execute, interrupt: adapter.interrupt,
      requestApproval: adapter.requestApproval, verifyReceipt: adapter.verifyReceipt })
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
  } catch (error) {
    tasksError = publicText(error?.message || 'Local task storage failed to open', 1000)
    unsubscribeGraph()
    unsubscribeGraph = () => {}
    router?.close()
    graph = null; adapter = null; router = null; handleTasks = null; handleSources = null
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
    return handleTasks(req, res)
  }

  return {
    bus, files,
    get sources() { return sources },
    get graph() { return graph },
    get adapter() { return adapter },
    handle,
    observeAuth,
    watchRoot: root => files.watchRoot(root),
    publishTerminalExit({ sessionId, exitCode = null, signal = null } = {}) {
      try { bus.publish({ topic: 'terminal.exit', owner, payload: { sessionId, exitCode, signal } }) } catch {}
    },
    // Wire to the chat runtime's v2 emit: run.started/run.completed settle task attempts.
    onChatEvent(event) {
      if (!adapter) return null
      try { return adapter.onChatEvent(event).catch(() => ({ matched: false })) } catch { return null }
    },
    snapshot() {
      const { seq, dropped } = bus.stats()
      return { tasks: graph ? 'ready' : 'unavailable', taskError: tasksError, maxConcurrency, eventSeq: seq, droppedEvents: dropped, ...files.snapshot() }
    },
    async close() {
      router?.close()
      unsubscribeGraph()
      unsubscribeSse()
      files.close()
      bus.close()
    },
  }
}
