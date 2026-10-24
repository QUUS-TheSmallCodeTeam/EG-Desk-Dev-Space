import { createHash, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { guardBridgeRequest, readJsonBody, sendJson, setBridgeCors } from './codex-bridge-http.mjs'
import { composeAwaitResume, composePlanStep } from './egdesk-await-resume.mjs'
import { assertGateWindow, normalizeTaskGate, normalizeTaskGraph } from './egdesk-task-graph.mjs'
import { publicGraph } from './egdesk-task-http.mjs'
import { nativeTaskError } from './egdesk-task-native-store.mjs'

/**
 * Agent-proposed plans (egdesk_propose_plan). A plan is an ordinary task graph
 * that is submitted and registered but NOT activated: nothing runs until the
 * screen approves it. Approval activates the graph, after which steps start by
 * themselves in dependency order and wait on their gates as usual.
 *
 * Each step's instructions are task sources (private 0600 file, bound to the
 * Board and the hashed owner). The plan record here keeps only IDs, the plan and
 * step titles, which conversation proposed it and where each step continues.
 *
 * resumeIn 'sameThread' (default): when the step may start, its message is the
 * <egdesk-await-resume> block, sent as the next turn of the proposing
 * conversation (after any turn running there). 'newThread': the step runs in a
 * new conversation, like any other graph task.
 */

export const MAX_PLAN_TASKS = 12
export const MAX_PLAN_INSTRUCTIONS = 4000
export const PLAN_REQUESTER = 'agent-plan'
export const PLAN_OWNER_ID = 'agent'
const FILE_NAME = 'task-plans.json'
const PLAN_ID = /^plan-[A-Za-z0-9-]{1,80}$/
const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/
const CONTROL = /[\u0000-\u001f\u007f]/
const STORED_STATUS = ['proposed', 'approved', 'rejected']
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const isRef = value => typeof value === 'string' && value.length > 0 && value.length <= 2048 && !CONTROL.test(value)
const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)

function planError(code, message, httpStatus = 409) {
  return Object.assign(new Error(message), { code, httpStatus })
}
function invalid(reason) {
  throw planError('PLAN_INVALID', reason, 400)
}

function validRecord(record) {
  const keys = ['planId', 'owner', 'boardId', 'scope', 'title', 'status', 'createdAt', 'decidedAt', 'origin', 'cwd', 'tasks']
  const nullableRef = value => value === null || isRef(value)
  return plainObject(record) && Object.keys(record).length === keys.length && keys.every(key => Object.hasOwn(record, key)) &&
    PLAN_ID.test(record.planId) && isRef(record.owner) && isRef(record.boardId) && typeof record.title === 'string' &&
    STORED_STATUS.includes(record.status) && typeof record.createdAt === 'string' && nullableRef(record.decidedAt) &&
    plainObject(record.scope) && ['graphId', 'requestId', 'runId', 'requestedBy'].every(key => isRef(record.scope[key])) &&
    record.scope.parentTaskId === null && Object.keys(record.scope).length === 5 &&
    plainObject(record.origin) && Object.keys(record.origin).length === 4 &&
    ['conversationId', 'clientThreadId', 'runId', 'engineId'].every(key => Object.hasOwn(record.origin, key) && nullableRef(record.origin[key])) &&
    (record.cwd === null || (typeof record.cwd === 'string' && path.isAbsolute(record.cwd))) &&
    Array.isArray(record.tasks) && record.tasks.length >= 1 && record.tasks.length <= MAX_PLAN_TASKS &&
    record.tasks.every(task => plainObject(task) && Object.keys(task).length === 3 && TASK_ID.test(task.taskId) &&
      typeof task.title === 'string' && ['sameThread', 'newThread'].includes(task.resumeIn))
}

/**
 * openTaskPlanStore({ directory?, maxPlans }) -> { find, byGraph, all, put, update, remove }
 * With a directory, plans persist in one private (0600) file; without, in memory.
 * Records are rows in an array: no model- or user-chosen string becomes a key.
 */
export async function openTaskPlanStore({ directory = null, maxPlans = 512 } = {}) {
  let plans = []
  let file = null
  let writeTail = Promise.resolve()
  if (directory !== null) {
    if (typeof directory !== 'string' || !path.isAbsolute(directory) || directory === path.parse(directory).root) throw new TypeError('A dedicated absolute task-plan directory is required')
    await fs.mkdir(directory, { recursive: true, mode: 0o700 })
    const info = await fs.lstat(directory)
    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 ||
        (typeof process.getuid === 'function' && info.uid !== process.getuid())) {
      throw new TypeError('Task-plan directory must be private and owned by this user')
    }
    file = path.join(directory, FILE_NAME)
    let bytes = null
    try { bytes = await fs.readFile(file, 'utf8') } catch (error) { if (error.code !== 'ENOENT') throw error }
    if (bytes !== null) {
      let envelope
      try { envelope = JSON.parse(bytes) } catch { envelope = null }
      if (envelope?.version !== 1 || !Array.isArray(envelope.plans) || envelope.digest !== digest(envelope.plans) || !envelope.plans.every(validRecord)) {
        throw Object.assign(new Error('Task plan file failed its version or checksum check'), { code: 'E_TASK_PLANS_CORRUPT' })
      }
      plans = envelope.plans
    }
  }

  async function persist(next) {
    if (!next.every(validRecord)) throw planError('PLAN_STORAGE', 'Plan record is invalid', 500)
    if (!file) { plans = next; return }
    const work = writeTail.then(async () => {
      const temporary = path.join(directory, `.task-plans-${randomUUID()}.tmp`)
      let handle
      try {
        handle = await fs.open(temporary, 'wx', 0o600)
        await handle.writeFile(JSON.stringify({ version: 1, digest: digest(next), plans: next }))
        await handle.sync()
        await handle.close()
        handle = null
        await fs.rename(temporary, file)
        plans = next
      } finally {
        if (handle) await handle.close()
        await fs.unlink(temporary).catch(() => {})
      }
    })
    writeTail = work.catch(() => {})
    return work
  }

  const find = planId => plans.find(plan => plan.planId === planId) ?? null
  return {
    find: planId => structuredClone(find(planId)),
    byGraph: graphId => structuredClone(plans.find(plan => plan.scope.graphId === graphId) ?? null),
    // Read-only view for scheduling checks; callers never mutate it.
    all: () => plans,
    async put(record) {
      const next = [...plans.filter(plan => plan.planId !== record.planId), structuredClone(record)]
      while (next.length > maxPlans) next.shift()
      await persist(next)
    },
    async update(planId, patch) {
      const current = find(planId)
      if (!current) throw planError('PLAN_NOT_FOUND', 'No such plan', 404)
      await persist(plans.map(plan => plan.planId === planId ? { ...structuredClone(plan), ...patch } : plan))
    },
    async remove(planId) {
      await persist(plans.filter(plan => plan.planId !== planId))
    },
  }
}

function plainText(value, name, max) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || CONTROL.test(value)) invalid(`${name} must be 1-${max} characters of plain text`)
  return value.trim()
}

/** Validates egdesk_propose_plan arguments; reasons are fixed text naming the step. */
export function normalizePlanArgs(args) {
  if (!plainObject(args)) invalid('Arguments must be an object with title and tasks')
  for (const key of Object.keys(args)) if (!['title', 'tasks'].includes(key)) invalid(`Unknown argument: ${key}`)
  const title = plainText(args.title, 'title', 200)
  if (!Array.isArray(args.tasks) || args.tasks.length < 1 || args.tasks.length > MAX_PLAN_TASKS) invalid(`tasks must list 1-${MAX_PLAN_TASKS} steps`)
  const tasks = args.tasks.map((task, index) => {
    if (!plainObject(task)) invalid(`Step ${index + 1} must be an object`)
    const label = typeof task.taskId === 'string' && TASK_ID.test(task.taskId) ? task.taskId : `${index + 1}`
    for (const key of Object.keys(task)) if (!['taskId', 'title', 'instructions', 'dependsOn', 'resumeIn', 'gates'].includes(key)) invalid(`Step ${label}: unknown field ${key}`)
    if (typeof task.taskId !== 'string' || !TASK_ID.test(task.taskId)) invalid(`Step ${index + 1}: taskId must be 1-64 letters, digits, ".", "_" or "-", starting with a letter or digit`)
    const stepTitle = plainText(task.title, `Step ${label} title`, 200)
    if (typeof task.instructions !== 'string' || !task.instructions.trim() || task.instructions.length > MAX_PLAN_INSTRUCTIONS) {
      invalid(`Step ${label}: instructions must be 1-${MAX_PLAN_INSTRUCTIONS} characters`)
    }
    if (!Array.isArray(task.dependsOn) || task.dependsOn.length > MAX_PLAN_TASKS || task.dependsOn.some(item => typeof item !== 'string' || !TASK_ID.test(item))) {
      invalid(`Step ${label}: dependsOn must list taskIds of other steps`)
    }
    if (task.resumeIn !== undefined && !['sameThread', 'newThread'].includes(task.resumeIn)) invalid(`Step ${label}: resumeIn must be sameThread or newThread`)
    if (task.gates !== undefined && (!Array.isArray(task.gates) || task.gates.length > 8)) invalid(`Step ${label}: gates must be a list of at most 8`)
    const gates = (task.gates ?? []).map(gate => {
      try { return normalizeTaskGate(gate) } catch (error) { invalid(`Step ${label}: ${error.message}`) }
    })
    return { taskId: task.taskId, title: stepTitle, instructions: task.instructions, dependsOn: [...task.dependsOn],
      resumeIn: task.resumeIn ?? 'sameThread', gates }
  })
  return { title, tasks }
}

function sameThreadTarget(plan, task) {
  if (task?.resumeIn !== 'sameThread') return null
  const { conversationId, clientThreadId, engineId } = plan.origin
  return isRef(conversationId) && isRef(clientThreadId) && isRef(engineId) ? { conversationId, clientThreadId, engineId } : null
}

/**
 * createTaskPlanService({ store, sources, graph, adapter, chat?, getOwnerKey, broadcast?, onBlocked? })
 *   propose({ run, args })  -> public plan (status 'proposed'); throws PLAN_INVALID with a reason
 *   approve(planId) / reject(planId) -> { plan, graph, native, board }
 *   view(planId) (with instructions) / list()
 *   resolveTaskInput(context) -> INPUT for a plan step, or null for other graphs
 *   canStart({ graphId, taskId }) -> false while a same-thread step's conversation is busy
 * getOwnerKey returns the already hashed owner key (or null when signed out).
 */
export function createTaskPlanService({ store, sources, graph, adapter, chat = null, getOwnerKey, broadcast = () => {},
  onBlocked = () => {}, now = () => new Date().toISOString(), makeId = randomUUID }) {
  const owner = () => {
    const key = getOwnerKey()
    if (typeof key !== 'string' || !key) throw nativeTaskError('TASK_AUTHORITY', 'Sign in to plan Agent tasks', 403)
    return key
  }
  function owned(planId) {
    const key = getOwnerKey()
    const plan = typeof planId === 'string' && PLAN_ID.test(planId) ? store.find(planId) : null
    if (!plan || !key || plan.owner !== key) throw planError('PLAN_NOT_FOUND', 'No such plan for this account', 404)
    return plan
  }
  function cwdOf(conversationId) {
    try {
      const cwd = chat?.threads?.get?.(conversationId)?.cwd
      return typeof cwd === 'string' && path.isAbsolute(cwd) && !cwd.includes('\0') ? cwd : null
    } catch { return null }
  }
  function instructionsOf(plan, task) {
    try { return sources.resolve({ binding: { sourceRef: task.sourceRef }, boardId: plan.boardId }).message } catch { return null }
  }

  function view(plan, { detail = false } = {}) {
    const projection = graph.getGraph(plan.scope.graphId)
    const steps = new Map((projection?.tasks ?? []).map(task => [task.taskId, task]))
    const statuses = [...steps.values()].map(task => task.status)
    const status = plan.status === 'rejected' ? 'rejected'
      : projection?.cancelRequested ? 'cancelled'
        : plan.status === 'approved' && statuses.length && statuses.every(value => value === 'completed') ? 'completed'
          : plan.status
    return {
      planId: plan.planId, title: plan.title, status, createdAt: plan.createdAt, decidedAt: plan.decidedAt,
      boardId: plan.boardId, scope: structuredClone(plan.scope), graphId: plan.scope.graphId,
      origin: { conversationId: plan.origin.conversationId, clientThreadId: plan.origin.clientThreadId },
      tasks: plan.tasks.map(task => {
        const step = steps.get(task.taskId)
        return { taskId: task.taskId, title: task.title, resumeIn: task.resumeIn, status: step?.status ?? 'unknown',
          dependsOn: step?.dependsOn ?? [], gates: step?.gates ?? [],
          ...(detail ? { instructions: step ? instructionsOf(plan, step) : null } : {}) }
      }),
    }
  }
  function notify(plan, change) {
    try { broadcast({ type: 'task.plan', v: 1, planId: plan.planId, change, plan: view(plan), ts: Date.now() }) } catch {}
  }
  function decision(plan) {
    const graphId = plan.scope.graphId
    return { plan: view(plan), graph: publicGraph(graph.getGraph(graphId)), native: adapter.getState(graphId),
      board: adapter.boardState(graph, { boardId: plan.boardId, requestedBy: plan.scope.requestedBy }) }
  }

  async function propose({ run, args } = {}) {
    if (!plainObject(run)) throw planError('PLAN_FORBIDDEN', 'Plans are proposed from an Agent run', 403)
    if (run.executionPolicy) throw planError('PLAN_FORBIDDEN', 'Plans are not offered in bounded or QA conversations', 403)
    const ownerKey = owner()
    const input = normalizePlanArgs(args)
    const planId = `plan-${makeId()}`
    const boardId = `board-${planId}`
    const runId = typeof run.runId === 'string' && run.runId.length <= 200 && ID.test(run.runId) ? run.runId
      : `run-${createHash('sha256').update(String(run.runId)).digest('hex').slice(0, 32)}`
    const scope = { graphId: `graph-${planId}`, requestId: `request-${planId}`, runId, parentTaskId: null, requestedBy: PLAN_REQUESTER }
    const draft = { ...scope, tasks: input.tasks.map(task => ({ taskId: task.taskId, ownerId: PLAN_OWNER_ID, sourceRef: 'task-source-pending',
      dependsOn: task.dependsOn, approvalRequired: false, ...(task.gates.length ? { gates: task.gates } : {}) })) }
    try { normalizeTaskGraph(draft); assertGateWindow(draft) } catch (error) {
      if (error.code === 'E_TASK_INPUT') invalid(error.message)
      throw error
    }
    const origin = {
      conversationId: isRef(run.conversationId) ? run.conversationId : null,
      clientThreadId: isRef(run.clientThreadId) ? run.clientThreadId : null,
      runId: isRef(run.runId) ? run.runId : null,
      engineId: isRef(run.engine?.id) ? run.engine.id : 'codex',
    }
    const cwd = origin.conversationId ? cwdOf(origin.conversationId) : null
    const record = { planId, owner: ownerKey, boardId, scope, title: input.title, status: 'proposed', createdAt: now(), decidedAt: null,
      origin, cwd, tasks: [] }
    // A step asks for the same conversation only when that conversation can be named exactly.
    record.tasks = input.tasks.map(task => ({ taskId: task.taskId, title: task.title,
      resumeIn: task.resumeIn === 'sameThread' && sameThreadTarget(record, { resumeIn: 'sameThread' }) ? 'sameThread' : 'newThread' }))
    const sourceRefs = []
    for (const task of input.tasks) sourceRefs.push((await sources.register({ boardId, message: task.instructions, ...(cwd ? { cwd } : {}) })).sourceRef)
    await store.put(record)
    try {
      const submitted = await graph.submitGraph({ ...draft, tasks: draft.tasks.map((task, index) => ({ ...task, sourceRef: sourceRefs[index] })) })
      await adapter.registerGraph({ boardId, graph: submitted })
    } catch (error) {
      await store.remove(planId).catch(() => {})
      if (error.code === 'E_TASK_INPUT') invalid(error.message)
      throw error
    }
    notify(record, 'proposed')
    return view(record)
  }

  async function approve(planId) {
    const plan = owned(planId)
    if (plan.status === 'rejected') throw planError('PLAN_STALE', 'This plan was rejected')
    adapter.assertScope(plan.scope, plan.boardId)
    if (adapter.getState(plan.scope.graphId)?.fenced) throw nativeTaskError('TASK_FENCED', 'This plan was cancelled')
    const changed = plan.status === 'proposed'
    if (changed) await store.update(planId, { status: 'approved', decidedAt: now() })
    // Idempotent: an approved plan whose activation was interrupted is activated again.
    await graph.activateGraph(plan.scope)
    const current = store.find(planId)
    if (changed) notify(current, 'approved')
    return decision(current)
  }

  async function reject(planId) {
    const plan = owned(planId)
    if (plan.status === 'approved') throw planError('PLAN_STALE', 'An approved plan is stopped with POST /tasks/cancel')
    adapter.assertScope(plan.scope, plan.boardId)
    const changed = plan.status === 'proposed'
    if (changed) await store.update(planId, { status: 'rejected', decidedAt: now() })
    await adapter.fenceGraph(plan.scope, plan.boardId)
    if (!graph.getGraph(plan.scope.graphId)?.cancelRequested) await graph.cancelGraph(plan.scope)
    const current = store.find(planId)
    if (changed) notify(current, 'rejected')
    return decision(current)
  }

  function resolveTaskInput(context) {
    const plan = store.byGraph(context?.binding?.graphId)
    if (!plan) return null
    const key = getOwnerKey()
    const task = plan.tasks.find(entry => entry.taskId === context.binding.taskId)
    if (!key || plan.owner !== key || plan.boardId !== context.boardId || !task) {
      throw nativeTaskError('TASK_INPUT_UNRESOLVED', 'Plan step is unavailable for this Board or account', 403)
    }
    const base = sources.resolve(context)
    const step = graph.getGraph(plan.scope.graphId)?.tasks.find(entry => entry.taskId === task.taskId)
    const gates = step?.gates ?? []
    const taskTitles = new Map(plan.tasks.map(entry => [entry.taskId, entry.title]))
    const target = sameThreadTarget(plan, task)
    if (target) {
      return { message: composeAwaitResume({ graphId: plan.scope.graphId, planId: plan.planId, planTitle: plan.title, task,
        instructions: base.message, gates, taskTitles }), ...target }
    }
    return { message: composePlanStep({ planTitle: plan.title, task, instructions: base.message, gates, taskTitles }),
      ...(base.cwd === undefined ? {} : { cwd: base.cwd }) }
  }

  // Never throws: a hold is only a delay, and an unknown graph is not held.
  function canStart({ graphId, taskId } = {}) {
    try {
      const plan = store.all().find(entry => entry.scope.graphId === graphId)
      const target = plan ? sameThreadTarget(plan, plan.tasks.find(entry => entry.taskId === taskId)) : null
      if (!target) return true
      if (typeof chat?.conversationBusy === 'function' && chat.conversationBusy(target.conversationId)) { onBlocked(); return false }
      // One same-thread step at a time per conversation.
      for (const other of store.all()) {
        if (other.status !== 'approved' || other.origin.conversationId !== target.conversationId) continue
        const running = graph.getGraph(other.scope.graphId)?.tasks.some(entry => entry.status === 'running' &&
          sameThreadTarget(other, other.tasks.find(step => step.taskId === entry.taskId)))
        if (running) { onBlocked(); return false }
      }
      return true
    } catch { return true }
  }

  return {
    propose, approve, reject, resolveTaskInput, canStart,
    view: planId => view(owned(planId), { detail: true }),
    list() {
      const key = owner()
      return store.all().filter(plan => plan.owner === key).slice(-50).reverse().map(plan => view(plan))
    },
    byGraph: graphId => store.byGraph(graphId),
  }
}

/**
 * GET  /tasks/plans                     -> 200 { plans: [plan] } (this account, newest first, at most 50)
 * GET  /tasks/plans?planId=ID           -> 200 { plan } with each step's instructions
 * POST /tasks/plans/:planId/approve {}  -> 200 { plan, graph, native, board }; steps start by themselves
 * POST /tasks/plans/:planId/reject {}   -> 200 { plan, graph, native, board }; the graph is cancelled
 * Loopback + Origin guarded and signed-in only, like /tasks/*.
 */
export function createTaskPlanHttpHandler({ plans, ensureAuth, port = 39218 }) {
  if (typeof ensureAuth !== 'function') throw new TypeError('ensureAuth is required')
  return async (req, res, parsedUrl = null) => {
    let url
    try { url = parsedUrl || new URL(req.url, `http://127.0.0.1:${port}`) } catch { return false }
    if (url.pathname !== '/tasks/plans' && !url.pathname.startsWith('/tasks/plans/')) return false
    if (!guardBridgeRequest(req, port)) {
      sendJson(res, 403, { code: 'TASK_LOOPBACK_REQUIRED', error: 'Untrusted task request origin' })
      return true
    }
    setBridgeCors(req, res)
    try {
      if (req.method === 'GET' && url.pathname === '/tasks/plans') {
        if ([...url.searchParams.keys()].some(key => key !== 'planId')) throw planError('TASK_HTTP_INPUT', 'Only planId may be given', 400)
        await ensureAuth()
        const planId = url.searchParams.get('planId')
        sendJson(res, 200, planId ? { plan: plans.view(planId) } : { plans: plans.list() })
        return true
      }
      const match = /^\/tasks\/plans\/(plan-[A-Za-z0-9-]{1,80})\/(approve|reject)$/.exec(url.pathname)
      if (req.method !== 'POST' || !match) {
        sendJson(res, 404, { code: 'TASK_ROUTE_NOT_FOUND', error: 'Unknown plan endpoint' })
        return true
      }
      const body = await readJsonBody(req, { maxBytes: 1024 })
      if (Object.keys(body).length) throw planError('TASK_HTTP_INPUT', 'Plan decisions take an empty body', 400)
      await ensureAuth()
      sendJson(res, 200, match[2] === 'approve' ? await plans.approve(match[1]) : await plans.reject(match[1]))
    } catch (error) {
      const fallback = error?.code === 'E_TASK_INPUT' ? 400
        : ['E_TASK_SCOPE', 'E_TASK_STATE', 'E_TASK_IDEMPOTENCY'].includes(error?.code) ? 409 : 500
      const status = Number.isInteger(error?.httpStatus) && error.httpStatus >= 400 && error.httpStatus <= 599 ? error.httpStatus : fallback
      sendJson(res, status, { code: typeof error?.code === 'string' ? error.code : 'PLAN_ERROR',
        error: status >= 500 ? 'Plan request could not be completed' : error.message })
    }
    return true
  }
}
