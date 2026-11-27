import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { CodexChatRuntime } from './codex-chat-runtime.mjs'
import { openChatStore } from './egdesk-chat-store.mjs'
import { composeAwaitResume } from './egdesk-await-resume.mjs'
import { createAwaitGateRouter } from './egdesk-await-router.mjs'
import { createWorkflowEventBus } from './egdesk-event-bus.mjs'
import { PLAN_TOOL_NAME, createPlanToolProvider } from './egdesk-plan-tool-provider.mjs'
import { openTaskGraph } from './egdesk-task-graph.mjs'
import { openTaskStore } from './egdesk-task-store.mjs'
import { openWorkflowRuntime } from './egdesk-workflow-runtime.mjs'

// The record rows of one kind in the workflow database (WAL content included).
function storedRows(filename, kind) {
  const db = new DatabaseSync(filename, { readOnly: true })
  try { return db.prepare('SELECT record_json FROM records WHERE kind = ? ORDER BY ord').all(kind).map(row => row.record_json) }
  finally { db.close() }
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(predicate, label = 'expected state') {
  for (let count = 0; count < 1500; count += 1) { if (await predicate()) return; await delay(3) }
  assert.fail(`${label} did not arrive`)
}
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
const close = server => new Promise(resolve => { server.closeAllConnections?.(); server.close(() => resolve()) })
const textOf = turn => turn.input.map(item => item.text).join('\n')

async function bridge(t, { durable = false, dataDir: preset = null } = {}) {
  const dataDir = preset ?? await mkdtemp(path.join(os.tmpdir(), 'egdesk-plans-'))
  const frames = [], turnStarts = [], threadStarts = [], replies = []
  let runtime = null
  let threads = 0, turns = 0
  const owner = { key: 'id:plan-account' }
  const planProvider = createPlanToolProvider({ plans: () => runtime?.plans ?? null })
  const store = durable ? openChatStore({ dataDir: path.join(dataDir, 'chat'), ownerScope: 'plan-test' }) : null
  if (store) t.after(() => { try { store.close() } catch {} })
  const chat = new CodexChatRuntime({
    ...(store ? { store, requireStore: true, getOwnerKey: () => owner.key } : {}),
    request: async (method, params) => {
      if (method === 'thread/start') { threadStarts.push(params); return { thread: { id: `native-thread-${++threads}` }, cwd: dataDir } }
      if (method === 'turn/start') { turnStarts.push(params); return { turn: { id: `native-turn-${++turns}`, status: 'inProgress', items: [] } } }
      if (method === 'turn/interrupt') return {}
      if (method === 'thread/resume') return { thread: { id: params.threadId, turns: [] } }
      throw new Error(`Unexpected native RPC ${method}`)
    },
    respond: (...args) => replies.push(args), verifyFile: async () => null,
    toolProviders: [planProvider],
    emit: event => { frames.push(event); runtime?.onChatEvent(event) },
  })
  chat.setConnection(true)
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    void runtime.handle(req, res, url).then(handled => { if (!handled) { res.writeHead(404); res.end('{}') } })
  })
  const port = await listen(server)
  runtime = await openWorkflowRuntime({ dataDir, chat, port, broadcast: frame => frames.push(frame),
    ensureAuth: async () => {}, getOwnerKey: () => owner.key })
  t.after(async () => { await runtime.close(); await close(server); await rm(dataDir, { recursive: true, force: true }) })
  const base = `http://127.0.0.1:${port}`
  const call = async (method, route, body, headers = {}) => {
    const response = await fetch(`${base}${route}`, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
      ...(body ? { body: JSON.stringify(body) } : {}) })
    return { status: response.status, body: await response.json() }
  }
  async function finishTurn(index, status = 'completed') {
    await chat.handleNotification({ method: 'turn/completed', params: { threadId: turnStarts[index].threadId, turn: { id: `native-turn-${index + 1}`, status, items: [] } } })
    await chat.queue
  }
  let callCount = 0
  async function propose(run, args) {
    const id = `plan-call-${++callCount}`
    await chat.handleServerRequest({ id, method: 'item/tool/call', params: { threadId: run.conversationId, turnId: run.runId,
      callId: `call-${callCount}`, tool: PLAN_TOOL_NAME, arguments: args } })
    await until(() => replies.some(reply => reply[0] === id), 'plan tool reply')
    const reply = replies.find(entry => entry[0] === id)[1]
    return { success: reply.success, result: JSON.parse(reply.contentItems[0].text) }
  }
  const state = async graphId => (await call('GET', `/tasks/state?graphId=${graphId}`)).body
  return { runtime, chat, frames, turnStarts, threadStarts, replies, call, finishTurn, propose, state, dataDir, owner }
}

const taskOf = (state, taskId) => state.graph.tasks.find(entry => entry.taskId === taskId)
const graphScope = value => ({ graphId: value.graphId, requestId: value.requestId, runId: value.runId, parentTaskId: value.parentTaskId, requestedBy: value.requestedBy })

const REPORT_PLAN = {
  title: 'Quarterly report',
  tasks: [
    { taskId: 'collect', title: 'Collect numbers', instructions: 'Collect the Q3 numbers from the finance folder.', dependsOn: [] },
    { taskId: 'publish', title: 'Publish to the wiki', instructions: 'Publish the report to the GitHub wiki.', dependsOn: ['collect'],
      gates: [{ gateId: 'github-login', kind: 'oauth', origin: 'https://github.com', pathPrefix: '/login/oauth/callback', timeoutMs: 600000 }] },
    { taskId: 'review', title: 'Review in a new chat', instructions: 'Review the published wiki page for typos.', dependsOn: ['publish'],
      resumeIn: 'newThread', gates: [{ gateId: 'looks-right', kind: 'userAction', label: 'Report looks right' }] },
  ],
}

test('Agent proposes a plan; nothing runs until approval, then steps continue in the same conversation and wait for their conditions', async t => {
  const h = await bridge(t)
  const first = await h.chat.send({ message: 'Prepare the quarterly report end to end.', clientThreadId: 'chat-1' })
  assert.ok(h.threadStarts[0].dynamicTools.some(spec => spec.name === PLAN_TOOL_NAME), 'ordinary threads are offered the plan tool')

  const proposed = await h.propose(first, REPORT_PLAN)
  assert.equal(proposed.success, true)
  assert.equal(proposed.result.status, 'proposed')
  assert.match(proposed.result.planId, /^plan-/)
  assert.equal(proposed.result.taskCount, 3)
  assert.match(proposed.result.message, /대표님 승인을 기다립니다/)
  const { planId, graphId } = proposed.result

  // Saved as proposed only: queued, not activated, no new turn.
  let state = await h.state(graphId)
  assert.equal(state.graph.activated, false)
  assert.deepEqual(state.graph.tasks.map(task => task.status), ['queued', 'queued', 'queued'])
  assert.equal(h.turnStarts.length, 1)
  const chatEvent = h.frames.find(frame => frame.type === 'chat.event' && frame.event === 'plan.proposed')
  assert.equal(chatEvent.details.planId, planId)
  assert.deepEqual(chatEvent.details.tasks.map(task => [task.taskId, task.resumeIn]), [['collect', 'sameThread'], ['publish', 'sameThread'], ['review', 'newThread']])
  assert.equal(JSON.stringify(chatEvent).includes('Collect the Q3'), false, 'instructions stay out of chat history')
  const proposedFrame = h.frames.find(frame => frame.type === 'task.plan' && frame.change === 'proposed')
  assert.equal(proposedFrame.plan.planId, planId)
  assert.equal(proposedFrame.plan.status, 'proposed')

  const detail = await h.call('GET', `/tasks/plans?planId=${planId}`)
  assert.equal(detail.status, 200)
  assert.equal(detail.body.plan.title, 'Quarterly report')
  assert.equal(detail.body.plan.origin.conversationId, first.conversationId)
  assert.deepEqual(detail.body.plan.tasks.map(task => task.instructions), REPORT_PLAN.tasks.map(task => task.instructions))
  const listed = await h.call('GET', '/tasks/plans')
  assert.deepEqual(listed.body.plans.map(plan => plan.planId), [planId])
  assert.equal(Object.hasOwn(listed.body.plans[0].tasks[0], 'instructions'), false)

  // Instructions live in the private task-source rows; the plan row keeps titles and IDs.
  const database = path.join(h.dataDir, 'workflow-store', 'workflow.sqlite')
  assert.equal((await stat(database)).mode & 0o777, 0o600)
  const planRows = storedRows(database, 'plan'), sourceRows = storedRows(database, 'source')
  assert.equal(planRows.length, 1)
  assert.equal(planRows.join('').includes('Collect the Q3'), false)
  assert.equal(sourceRows.join('').includes('Collect the Q3'), true)
  assert.equal([...planRows, ...sourceRows].join('').includes('id:plan-account'), false, 'the owner is stored hashed')

  // Approval activates; the first step waits for the proposing turn to end.
  const approved = await h.call('POST', `/tasks/plans/${planId}/approve`, {})
  assert.equal(approved.status, 200)
  assert.equal(approved.body.plan.status, 'approved')
  assert.equal(approved.body.graph.activated, true)
  assert.equal(taskOf(approved.body, 'collect').status, 'ready')
  assert.ok(h.frames.some(frame => frame.type === 'task.plan' && frame.change === 'approved'))
  await delay(30)
  assert.equal(h.turnStarts.length, 1, 'no step starts while the proposing turn runs')
  assert.equal((await h.call('POST', `/tasks/plans/${planId}/approve`, {})).status, 200, 'approving again is harmless')

  await h.finishTurn(0)
  await until(() => h.turnStarts.length === 2, 'first step in the same conversation')
  assert.equal(h.turnStarts[1].threadId, first.conversationId)
  assert.equal(h.threadStarts.length, 1, 'no new native thread for a same-thread step')
  const resume = textOf(h.turnStarts[1])
  assert.match(resume, /^<egdesk-await-resume>/)
  assert.match(resume, /<status>satisfied<\/status>/)
  assert.match(resume, /Collect the Q3 numbers from the finance folder\./)
  assert.match(resume, /대표님 approved this plan/)

  await h.finishTurn(1)
  await until(async () => taskOf(await h.state(graphId), 'collect').status === 'completed', 'first step completed')
  state = await h.state(graphId)
  const login = taskOf(state, 'publish').gates.find(gate => gate.gateId === 'github-login')
  assert.equal(login.status, 'waiting')
  assert.ok(Date.parse(login.expiresAt) > Date.now(), 'the wait clock started when the step became current')

  // 대표님 keeps chatting in the same conversation while the login happens.
  const chatting = await h.chat.send({ message: 'Also add a revenue chart.', clientThreadId: 'chat-1', conversationId: first.conversationId })
  assert.equal(h.turnStarts.length, 3)
  const oauth = await h.call('POST', '/events/browser', { cardId: 'card-1', kind: 'oauthCompleted', url: 'https://github.com/login/oauth/callback?code=SECRET-CODE-123&state=xyz' })
  assert.equal(oauth.status, 202)
  await until(async () => taskOf(await h.state(graphId), 'publish').status === 'ready', 'login gate satisfied')
  await delay(30)
  assert.equal(h.turnStarts.length, 3, 'the step waits for the running turn instead of interrupting it')
  await h.chat.handleNotification({ method: 'turn/completed', params: { threadId: chatting.conversationId, turn: { id: chatting.runId, status: 'completed', items: [] } } })
  await h.chat.queue
  await until(() => h.turnStarts.length === 4, 'second step after the chat turn ended')
  assert.equal(h.turnStarts[3].threadId, first.conversationId)
  const second = textOf(h.turnStarts[3])
  assert.match(second, /Login finished at https:\/\/github\.com\/login\/oauth\/callback/)
  assert.match(second, /<condition kind="task" gate="task:collect">Step "Collect numbers" \(collect\) completed\.<\/condition>/)
  assert.equal(second.includes('SECRET-CODE'), false)
  assert.equal(second.includes('code='), false)

  // The last step runs in a new conversation once 대표님 confirms.
  await h.finishTurn(3)
  await until(async () => taskOf(await h.state(graphId), 'publish').status === 'completed', 'second step completed')
  state = await h.state(graphId)
  const continued = await h.call('POST', '/tasks/continue', { boardId: state.native.boardId, scope: graphScope(state.graph), taskId: 'review', gateId: 'looks-right' })
  assert.equal(continued.status, 200)
  await until(() => h.turnStarts.length === 5, 'new-thread step')
  assert.equal(h.threadStarts.length, 2)
  assert.equal(h.turnStarts[4].threadId, 'native-thread-2')
  const review = textOf(h.turnStarts[4])
  assert.match(review, /^\[EG-Desk approved plan "Quarterly report" — step "Review in a new chat" \(review\)\]/)
  assert.match(review, /Review the published wiki page for typos\./)
  assert.equal(review.includes('<egdesk-await-resume>'), false)
  await h.finishTurn(4)
  await until(async () => (await h.call('GET', `/tasks/plans?planId=${planId}`)).body.plan.status === 'completed', 'plan completed')
  assert.equal(JSON.stringify(h.frames).includes('SECRET-CODE'), false)
})

test('with durable chat history the step is a turn of the original local chat, and an account change sends nothing', async t => {
  const h = await bridge(t, { durable: true })
  const first = await h.chat.send({ message: 'Plan the launch.', clientThreadId: 'ui-1', requestId: 'req-1' })
  const { result } = await h.propose(first, { title: 'Launch', tasks: [{ taskId: 'draft', title: 'Draft notes', instructions: 'Draft the launch notes.', dependsOn: [] }] })
  assert.equal((await h.call('POST', `/tasks/plans/${result.planId}/approve`, {})).status, 200)
  await h.finishTurn(0)
  await until(() => h.turnStarts.length === 2, 'same-thread step')
  assert.equal(h.turnStarts[1].threadId, first.conversationId)
  let history = h.chat.getLocalHistory({ clientThreadId: 'ui-1', limit: 500 })
  const resumed = history.messages.filter(message => message.role === 'user').at(-1)
  assert.match(resumed.text, /^<egdesk-await-resume>/)
  assert.match(resumed.requestId, /^task-native-/)
  assert.equal(history.runs.at(-1).accountIdentity.status, 'verified')
  await h.finishTurn(1)
  await until(async () => (await h.call('GET', `/tasks/plans?planId=${result.planId}`)).body.plan.status === 'completed', 'step completed')

  // A second plan is approved, then the account changes before its step may start.
  const again = await h.chat.send({ message: 'One more thing.', clientThreadId: 'ui-1', conversationId: first.conversationId, requestId: 'req-2' })
  const next = await h.propose(again, { title: 'Follow-up', tasks: [{ taskId: 'mail', title: 'Mail', instructions: 'Mail the notes.', dependsOn: [] }] })
  assert.equal((await h.call('POST', `/tasks/plans/${next.result.planId}/approve`, {})).status, 200)
  const usersBefore = h.chat.getLocalHistory({ clientThreadId: 'ui-1', limit: 500 }).messages.filter(message => message.role === 'user').length
  h.owner.key = 'id:another-account'
  await h.chat.handleNotification({ method: 'turn/completed', params: { threadId: again.conversationId, turn: { id: again.runId, status: 'completed', items: [] } } })
  await h.chat.queue
  await delay(80)
  assert.equal(h.turnStarts.length, 3, 'nothing is sent for another account')
  history = h.chat.getLocalHistory({ clientThreadId: 'ui-1', limit: 500 })
  assert.equal(history.messages.filter(message => message.role === 'user').length, usersBefore, 'no message was saved for a refused step')
})

test('a rejected plan never runs; plans belong to the proposing account and the routes are guarded', async t => {
  const h = await bridge(t)
  const first = await h.chat.send({ message: 'Plan something.', clientThreadId: 'chat-2' })
  const { result } = await h.propose(first, { title: 'Small plan', tasks: [{ taskId: 'only', title: 'Only step', instructions: 'Do the only step.', dependsOn: [] }] })
  const planId = result.planId
  assert.equal((await h.call('POST', `/tasks/plans/${planId}/approve`, { extra: true })).status, 400)
  assert.equal((await h.call('POST', `/tasks/plans/${planId}/approve`, {}, { origin: 'https://evil.example' })).status, 403)
  assert.equal((await h.call('POST', '/tasks/plans/not-a-plan/approve', {})).status, 404)
  assert.equal((await h.call('POST', '/tasks/plans/plan-missing/approve', {})).status, 404)

  h.owner.key = 'id:someone-else'
  assert.equal((await h.call('GET', `/tasks/plans?planId=${planId}`)).status, 404)
  assert.deepEqual((await h.call('GET', '/tasks/plans')).body.plans, [])
  assert.equal((await h.call('POST', `/tasks/plans/${planId}/approve`, {})).status, 404)
  h.owner.key = 'id:plan-account'

  const rejected = await h.call('POST', `/tasks/plans/${planId}/reject`, {})
  assert.equal(rejected.status, 200)
  assert.equal(rejected.body.plan.status, 'rejected')
  assert.equal(rejected.body.graph.cancelRequested, true)
  assert.deepEqual(rejected.body.graph.tasks.map(task => task.status), ['cancelled'])
  assert.equal((await h.call('POST', `/tasks/plans/${planId}/approve`, {})).status, 409)
  assert.equal((await h.call('POST', `/tasks/plans/${planId}/reject`, {})).status, 200, 'rejecting again is harmless')
  await h.finishTurn(0)
  await delay(30)
  assert.equal(h.turnStarts.length, 1)

  // An approved plan held for its busy conversation can still be cancelled cleanly.
  const second = await h.chat.send({ message: 'Plan again.', clientThreadId: 'chat-2', conversationId: first.conversationId })
  const again = await h.propose(second, { title: 'Second plan', tasks: [{ taskId: 'step', title: 'Step', instructions: 'Do the step.', dependsOn: [] }] })
  const approved = await h.call('POST', `/tasks/plans/${again.result.planId}/approve`, {})
  assert.equal(taskOf(approved.body, 'step').status, 'ready')
  assert.equal((await h.call('POST', `/tasks/plans/${again.result.planId}/reject`, {})).status, 409, 'an approved plan is stopped with /tasks/cancel')
  const cancelled = await h.call('POST', '/tasks/cancel', { boardId: approved.body.plan.boardId, scope: approved.body.plan.scope })
  assert.equal(cancelled.status, 202)
  assert.equal(taskOf(cancelled.body, 'step').status, 'cancelled')
  await h.chat.handleNotification({ method: 'turn/completed', params: { threadId: second.conversationId, turn: { id: second.runId, status: 'completed', items: [] } } })
  await h.chat.queue
  await delay(50)
  assert.equal(h.turnStarts.length, 2, 'nothing is sent for a cancelled step')
  assert.equal((await h.call('GET', `/tasks/plans?planId=${again.result.planId}`)).body.plan.status, 'cancelled')
})

test('an invalid plan is explained to the Agent and saves nothing', async t => {
  const h = await bridge(t)
  const first = await h.chat.send({ message: 'Plan badly.', clientThreadId: 'chat-3' })
  const step = (taskId, extra = {}) => ({ taskId, title: `Step ${taskId}`, instructions: `Do ${taskId}.`, dependsOn: [], ...extra })
  for (const [args, reason] of [
    [{ title: 'Cycle', tasks: [step('a', { dependsOn: ['b'] }), step('b', { dependsOn: ['a'] })] }, /dependency cycle/],
    [{ title: 'Missing', tasks: [step('a', { dependsOn: ['ghost'] })] }, /missing dependency ghost/],
    [{ title: 'Too many', tasks: Array.from({ length: 13 }, (_, index) => step(`s${index}`)) }, /1-12 steps/],
    [{ title: 'Long', tasks: [step('a', { instructions: 'x'.repeat(4001) })] }, /1-4000 characters/],
    [{ title: 'Gate', tasks: [step('a', { gates: [{ gateId: 'g', kind: 'webhook' }] })] }, /Step a: gate kind/],
    [{ title: 'Broad', tasks: [step('a', { gates: [{ gateId: 'g', kind: 'oauth', origin: 'https://github.com', pathPrefix: '/' }] })] }, /pathPrefix/],
    [{ title: 'Week', tasks: [step('a', { gates: [{ gateId: 'g', kind: 'userAction', timeoutMs: 8 * 24 * 3600 * 1000 }] })] }, /7 days/],
    [{ title: 'Where', tasks: [step('a', { resumeIn: 'elsewhere' })] }, /sameThread or newThread/],
    [{ title: 'Extra', tasks: [step('a')], when: 'now' }, /Unknown argument: when/],
  ]) {
    const { success, result } = await h.propose(first, args)
    assert.equal(success, true, args.title)
    assert.equal(result.status, 'invalid', args.title)
    assert.equal(result.code, 'PLAN_INVALID')
    assert.match(result.reason, reason, args.title)
  }
  assert.deepEqual((await h.call('GET', '/tasks/plans')).body.plans, [])
  assert.equal(h.runtime.sources.stats().sources, 0, 'no task text was saved for a refused plan')
  assert.equal(h.frames.some(frame => frame.type === 'task.plan' || frame.event === 'plan.proposed'), false)
})

test('bounded and QA threads are never offered the plan tool, and a run with a policy is refused', async () => {
  const provider = createPlanToolProvider({ plans: () => ({ propose: async () => assert.fail('must not propose') }) })
  const chat = new CodexChatRuntime({ request: async () => ({}), respond: () => {}, toolProviders: [provider] })
  assert.ok(chat.collectToolSpecs(null).specs.some(spec => spec.name === PLAN_TOOL_NAME))
  for (const policy of ['readOnlyQa', 'browserBounded', 'fixtureBrowserQa']) {
    assert.equal(chat.collectToolSpecs(policy).specs.some(spec => spec.name === PLAN_TOOL_NAME), false, policy)
  }
  const refused = await provider.dispatch({ answerId: 'a', executionPolicy: { mode: 'readOnlyQa' } }, { callId: 'c', tool: PLAN_TOOL_NAME, arguments: {} })
  assert.equal(refused.success, false)
  assert.deepEqual(JSON.parse(refused.contentItems[0].text), { error: { code: 'PLAN_FORBIDDEN' } })
  const offline = createPlanToolProvider({ plans: () => null })
  assert.equal(JSON.parse((await offline.dispatch({ answerId: 'a' }, { callId: 'c', tool: PLAN_TOOL_NAME, arguments: {} })).contentItems[0].text).error.code, 'PLAN_UNAVAILABLE')
  assert.deepEqual(createPlanToolProvider({ plans: () => null, schemaReady: () => false }).specs(), [])
})

const QUESTION_PLAN = {
  title: '견적서 보내기',
  tasks: [
    { taskId: 'send', title: '견적서 보내기', instructions: 'Send the quote the way 대표님 chose.', dependsOn: [],
      gates: [{ gateId: 'how', kind: 'userAction', label: '어떻게 보낼까요?',
        response: { kind: 'choice', options: [{ id: 'email', label: '메일로' }, { id: 'kakao', label: '카카오톡으로' }] } }] },
    { taskId: 'note', title: '메모 반영', instructions: 'Add the note to the quote file.', dependsOn: ['send'], resumeIn: 'newThread',
      gates: [{ gateId: 'memo', kind: 'userAction', label: '견적서에 덧붙일 말', response: { kind: 'text', maxLength: 200 } }] },
  ],
}

test('CHAT-06: an Agent asks with choices or a short written answer; the step waits, and the answer reaches it', async t => {
  const h = await bridge(t)
  const first = await h.chat.send({ message: '견적서를 보내 줘.', clientThreadId: 'chat-q' })
  const tooFew = await h.propose(first, { title: 'x', tasks: [{ ...QUESTION_PLAN.tasks[0], gates: [{ gateId: 'how', kind: 'userAction', label: 'q',
    response: { kind: 'choice', options: [{ id: 'only', label: 'only' }] } }] }] })
  assert.deepEqual([tooFew.success, tooFew.result.status], [true, 'invalid'])
  assert.match(tooFew.result.reason, /2-6 options/)
  const { result } = await h.propose(first, QUESTION_PLAN)
  assert.equal(result.status, 'proposed')
  const proposedFrame = h.frames.find(frame => frame.type === 'chat.event' && frame.event === 'plan.proposed')
  assert.deepEqual(proposedFrame.details.tasks[0].gates[0].response.options.map(option => option.id), ['email', 'kakao'])
  assert.equal((await h.call('POST', `/tasks/plans/${result.planId}/approve`, {})).status, 200)
  await h.finishTurn(0)
  await delay(30)
  assert.equal(h.turnStarts.length, 1, 'the step waits for the answer')
  let state = await h.state(result.graphId)
  const how = taskOf(state, 'send').gates.find(gate => gate.gateId === 'how')
  assert.deepEqual([how.status, how.label, how.response.kind, how.response.options.map(option => option.label)], ['waiting', '어떻게 보낼까요?', 'choice', ['메일로', '카카오톡으로']])
  const body = extra => ({ boardId: state.native.boardId, scope: graphScope(state.graph), taskId: 'send', gateId: 'how', ...extra })

  // A question opens only with a fitting answer.
  for (const [extra, code] of [[{}, 'TASK_GATE_ANSWER'], [{ answer: { choice: 'fax' } }, 'TASK_GATE_ANSWER'], [{ answer: { text: '메일' } }, 'TASK_GATE_ANSWER'],
    [{ answer: { choice: 'email', text: 'x' } }, 'TASK_GATE_ANSWER'], [{ answer: 'email' }, 'TASK_GATE_ANSWER']]) {
    const refused = await h.call('POST', '/tasks/continue', body(extra))
    assert.deepEqual([refused.status, refused.body.code], [400, code], JSON.stringify(extra))
  }
  const chosen = await h.call('POST', '/tasks/continue', body({ answer: { choice: 'kakao' } }))
  assert.equal(chosen.status, 200)
  const answered = taskOf(chosen.body, 'send').gates.find(gate => gate.gateId === 'how')
  assert.deepEqual([answered.status, answered.satisfiedBy, answered.answer], ['satisfied', 'user.action', { kind: 'choice', choice: 'kakao' }])
  await until(() => h.turnStarts.length === 2, 'answered step in the same conversation')
  const resume = textOf(h.turnStarts[1])
  assert.match(resume, /<answer gate="how" kind="choice" option="kakao" question="어떻게 보낼까요\?">카카오톡으로<\/answer>/)
  assert.match(resume, /"어떻게 보낼까요\?" was answered by 대표님/)
  assert.match(resume, /following 대표님's answers above/)
  assert.equal((await h.call('POST', '/tasks/continue', body({ answer: { choice: 'email' } }))).status, 409, 'answered once')

  // A written answer: secret-looking text is refused and never kept; a fitting one reaches the next step.
  await h.finishTurn(1)
  await until(async () => taskOf(await h.state(result.graphId), 'send').status === 'completed', 'first step completed')
  state = await h.state(result.graphId)
  const memo = extra => ({ ...body(extra), taskId: 'note', gateId: 'memo' })
  const secret = await h.call('POST', '/tasks/continue', memo({ answer: { text: '로그인 password: hunter2 로 해 줘' } }))
  assert.deepEqual([secret.status, secret.body.code], [400, 'TASK_GATE_ANSWER_PRIVATE'])
  const long = await h.call('POST', '/tasks/continue', memo({ answer: { text: '가'.repeat(201) } }))
  assert.deepEqual([long.status, long.body.code], [400, 'TASK_GATE_ANSWER'], 'the gate maxLength applies')
  const database = path.join(h.dataDir, 'workflow-store', 'workflow.sqlite')
  assert.equal(storedRows(database, 'gate-answer').length, 0, 'refused answers are not kept')
  const note = '  부가세 별도라고\r\n꼭 적어 주세요  '
  const written = await h.call('POST', '/tasks/continue', memo({ answer: { text: note } }))
  assert.equal(written.status, 200)
  assert.deepEqual(taskOf(written.body, 'note').gates.find(gate => gate.gateId === 'memo').answer, { kind: 'text' }, 'the screen sees that it was answered, not the text')
  await until(() => h.turnStarts.length === 3, 'new-thread step with the written answer')
  const step = textOf(h.turnStarts[2])
  assert.match(step, /대표님's answers \(follow them in this step\):\n- "견적서에 덧붙일 말": 부가세 별도라고\n꼭 적어 주세요/)
  assert.match(step, /Add the note to the quote file\./)

  // The text lives only in the private answer row: not in the journal, SSE task/workflow frames or the bus event.
  assert.equal(storedRows(database, 'gate-answer').join('').includes('부가세 별도라고'), true)
  const journal = new DatabaseSync(database, { readOnly: true })
  try {
    const events = journal.prepare('SELECT event_json FROM task_events').all().map(row => row.event_json).join('\n')
    assert.equal(events.includes('부가세'), false)
    assert.match(events, /"answer":\{"choice":"kakao"\}/)
    assert.match(events, /"answer":\{"textRef":"task-answer-[^"]+"\}/)
  } finally { journal.close() }
  const screenFrames = JSON.stringify(h.frames.filter(frame => ['task.graph', 'task.plan', 'task.native', 'workflow.event'].includes(frame.type)))
  assert.equal(screenFrames.includes('부가세'), false)
  const actions = h.frames.filter(frame => frame.type === 'workflow.event' && frame.event.topic === 'user.action')
  assert.ok(actions.length >= 2)
  for (const frame of actions) assert.deepEqual(Object.keys(frame.event.payload).sort(), ['gateId', 'graphId', 'taskId'])
})

test('the JSON files of an earlier version are imported once into the workflow store and left as they were', async t => {
  const { createHash } = await import('node:crypto')
  const { mkdir, writeFile } = await import('node:fs/promises')
  const { nativeHash } = await import('./egdesk-task-native-store.mjs')
  const before = await bridge(t)
  const first = await before.chat.send({ message: 'Prepare the quarterly report end to end.', clientThreadId: 'chat-legacy' })
  const { result } = await before.propose(first, REPORT_PLAN)
  const expected = await before.state(result.graphId)

  // Rewrite what the new store holds in the four file formats used before RT-07.
  const db = new DatabaseSync(path.join(before.dataDir, 'workflow-store', 'workflow.sqlite'), { readOnly: true })
  let events, state, sources, plans
  try {
    events = db.prepare('SELECT event_json FROM task_events ORDER BY seq').all().map(row => JSON.parse(row.event_json))
    const meta = db.prepare('SELECT revision FROM ledger_meta').get()
    state = { version: 1, revision: meta.revision, graphs: [], attempts: [], approvals: [], boardFences: [] }
    for (const row of db.prepare('SELECT collection, row_json FROM ledger_rows ORDER BY collection, pos').all()) state[row.collection].push(JSON.parse(row.row_json))
    sources = db.prepare("SELECT record_key, record_json FROM records WHERE kind = 'source' ORDER BY ord").all().map(row => [row.record_key, JSON.parse(row.record_json)])
    plans = db.prepare("SELECT record_json FROM records WHERE kind = 'plan' ORDER BY ord").all().map(row => JSON.parse(row.record_json))
  } finally { db.close() }
  const sha = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
  const legacyDir = await mkdtemp(path.join(os.tmpdir(), 'egdesk-plans-legacy-'))
  const files = {
    'task-graph/task-events.json': JSON.stringify({ version: 1, digest: sha(events), events }),
    'task-native/native-task-ledger.json': JSON.stringify({ digest: nativeHash(state), state }),
    'task-sources/task-sources.json': JSON.stringify({ version: 1, digest: sha(sources), sources }),
    'task-plans/task-plans.json': JSON.stringify({ version: 1, digest: sha(plans), plans }),
  }
  for (const [name, text] of Object.entries(files)) {
    await mkdir(path.join(legacyDir, path.dirname(name)), { recursive: true, mode: 0o700 })
    await writeFile(path.join(legacyDir, name), text, { mode: 0o600 })
  }

  const after = await bridge(t, { dataDir: legacyDir })
  const listed = await after.call('GET', '/tasks/plans')
  assert.deepEqual(listed.body.plans.map(plan => [plan.planId, plan.title, plan.status]), [[result.planId, 'Quarterly report', 'proposed']])
  const detail = await after.call('GET', `/tasks/plans?planId=${result.planId}`)
  assert.deepEqual(detail.body.plan.tasks.map(task => task.instructions), REPORT_PLAN.tasks.map(task => task.instructions), 'instructions came from the old source file')
  const imported = await after.state(result.graphId)
  assert.deepEqual(imported.graph.tasks.map(task => [task.taskId, task.status]), expected.graph.tasks.map(task => [task.taskId, task.status]))
  assert.equal(imported.graph.recoveryHold, true, 'an imported graph waits for resume like any reloaded one')
  assert.deepEqual(imported.native.scope, expected.native.scope)
  for (const [name, text] of Object.entries(files)) assert.equal(await readFile(path.join(legacyDir, name), 'utf8'), text, `${name} is left as it was`)
  assert.equal((await after.call('POST', `/tasks/plans/${result.planId}/approve`, {})).status, 200, 'an imported plan can still be approved')
  assert.equal((await readFile(path.join(legacyDir, 'task-plans/task-plans.json'), 'utf8')), files['task-plans/task-plans.json'], 'approving writes SQLite only')
})

function graphHarness(store = null) {
  const starts = []
  const valid = new Set()
  return { starts, valid, options: { store, maxConcurrency: 2, execute(context) { starts.push(context) }, interrupt() {}, requestApproval() {},
    verifyReceipt({ receipt }) { return valid.has(receipt.receiptId) } } }
}
const oneGate = (gate, suffix = 'x', extraTasks = []) => ({ graphId: `graph-${suffix}`, requestId: `request-${suffix}`, runId: `run-${suffix}`, parentTaskId: null,
  requestedBy: 'local-user', tasks: [{ taskId: 'wait', ownerId: 'agent', sourceRef: 'source-wait', dependsOn: extraTasks.map(task => task.taskId), approvalRequired: false, gates: [gate] }, ...extraTasks] })
const scopeOf = value => ({ graphId: value.graphId, requestId: value.requestId, runId: value.runId, parentTaskId: value.parentTaskId, requestedBy: value.requestedBy })

test('a gate whose wait runs out is marked expired, journaled and kept waiting; only a manual continue opens it', async t => {
  const directory = path.join(await mkdtemp(path.join(os.tmpdir(), 'egdesk-expiry-')), 'task-graph')
  t.after(() => rm(path.dirname(directory), { recursive: true, force: true }))
  const native = graphHarness(await openTaskStore(directory))
  const graph = await openTaskGraph(native.options)
  t.after(() => graph.close())
  const bus = createWorkflowEventBus()
  const router = createAwaitGateRouter({ graph, bus, owner: 'egdesk-local' })
  t.after(() => router.close())
  const changes = []
  graph.subscribe(event => changes.push(event.type))

  // Validation: one expiry form, at most 7 days, canonical and in the future.
  for (const [gate, message] of [
    [{ gateId: 'g', kind: 'userAction', timeoutMs: 1000, expiresAt: new Date(Date.now() + 60000).toISOString() }, /not both/],
    [{ gateId: 'g', kind: 'userAction', timeoutMs: 7 * 24 * 3600 * 1000 + 1 }, /7 days/],
    [{ gateId: 'g', kind: 'userAction', timeoutMs: 0 }, /7 days/],
    [{ gateId: 'g', kind: 'userAction', expiresAt: '2026-10-25' }, /canonical ISO/],
    [{ gateId: 'g', kind: 'userAction', expiresAt: new Date(Date.now() - 1000).toISOString() }, /future/],
    [{ gateId: 'g', kind: 'userAction', expiresAt: new Date(Date.now() + 8 * 24 * 3600 * 1000).toISOString() }, /7 days/],
  ]) await assert.rejects(graph.submitGraph(oneGate(gate, `bad-${changes.length}-${Math.random().toString(36).slice(2)}`)), { code: 'E_TASK_INPUT', message })

  // The clock of a downstream gate starts only once its upstream step completed.
  const upstream = { taskId: 'before', ownerId: 'agent', sourceRef: 'source-before', dependsOn: [], approvalRequired: false }
  const chained = oneGate({ gateId: 'exit', kind: 'terminalExit', sessionId: 'term-9', timeoutMs: 40 }, 'chain', [upstream])
  await graph.submitGraph(chained)
  await graph.activateGraph(scopeOf(chained))
  let gate = graph.getGraph('graph-chain').tasks.find(task => task.taskId === 'wait').gates.find(entry => entry.gateId === 'exit')
  assert.equal(gate.expiresAt, null)
  await delay(70)
  assert.equal(graph.getGraph('graph-chain').tasks.find(task => task.taskId === 'wait').gates.find(entry => entry.gateId === 'exit').status, 'waiting')
  const started = native.starts.find(context => context.binding.taskId === 'before')
  const receipt = { receiptId: 'native-before', outcome: 'completed', binding: structuredClone(started.binding), evidenceRefs: [] }
  native.valid.add(receipt.receiptId)
  // a1: the reference is the moment just before the completion is recorded (not the moment this line runs, which a loaded machine
  // delays past the 40 ms): a clock counted from activation (70+ ms earlier) would end before it, one counted from the completion after it
  const completing = Date.now()
  await graph.recordOutcome(receipt)
  gate = graph.getGraph('graph-chain').tasks.find(task => task.taskId === 'wait').gates.find(entry => entry.gateId === 'exit')
  assert.ok(Date.parse(gate.expiresAt) >= completing + 40, 'counted from the upstream completion')

  await until(() => graph.getGraph('graph-chain').tasks.find(task => task.taskId === 'wait').gates.find(entry => entry.gateId === 'exit').status === 'expired')
  const waiting = graph.getGraph('graph-chain').tasks.find(task => task.taskId === 'wait')
  assert.equal(waiting.status, 'waiting-on-dependency', 'expiry neither fails nor advances the step')
  assert.ok(waiting.gates.find(entry => entry.gateId === 'exit').expiredAt)
  assert.ok(changes.includes('task-gate-expired'))
  assert.equal(native.starts.length, 1)

  // The awaited event after expiry no longer opens it; the manual continue does.
  bus.publish({ topic: 'terminal.exit', owner: 'egdesk-local', payload: { sessionId: 'term-9', exitCode: 0, signal: null } })
  await bus.flush(); await router.drain()
  assert.equal(native.starts.length, 1)
  assert.deepEqual(graph.openGates().map(open => [open.gate.gateId, open.expired]), [['exit', true]])
  await assert.rejects(graph.satisfyGate({ graphId: 'graph-chain', taskId: 'wait', gateId: 'exit', evidence: { eventId: 'evt-x', topic: 'terminal.exit', at: new Date().toISOString() } }), { code: 'E_TASK_STATE' })

  // Expiry survives a restart (journaled), then the manual continue starts the step.
  graph.close()
  const reopened = await openTaskGraph(graphHarness(await openTaskStore(directory)).options)
  t.after(() => reopened.close())
  assert.equal(reopened.getGraph('graph-chain').tasks.find(task => task.taskId === 'wait').gates.find(entry => entry.gateId === 'exit').status, 'expired')
  assert.ok(reopened.getEvents('graph-chain').some(event => event.type === 'task-gate-expired' && event.gateId === 'exit'))
  await reopened.satisfyGate({ graphId: 'graph-chain', taskId: 'wait', gateId: 'exit', evidence: { eventId: 'evt-y', topic: 'user.action', at: new Date().toISOString() } })
  const opened = reopened.getGraph('graph-chain').tasks.find(task => task.taskId === 'wait').gates.find(entry => entry.gateId === 'exit')
  assert.deepEqual([opened.status, opened.satisfiedBy], ['satisfied', 'user.action'])
})

test('over HTTP an expired gate stays visible, SSE announces it, and POST /tasks/continue still opens it', async t => {
  const h = await bridge(t)
  const boardId = 'board-expiry'
  const source = await h.call('POST', '/task-sources', { boardId, message: 'Continue once the file arrives.' })
  const graph = { graphId: 'graph-expiry', requestId: 'request-expiry', runId: 'run-expiry', parentTaskId: null, requestedBy: 'local-user', tasks: [
    { taskId: 'upload', ownerId: 'agent-ops', sourceRef: source.body.sourceRef, dependsOn: [], approvalRequired: false,
      gates: [{ gateId: 'arrived', kind: 'file', root: 'root-1', relativeGlob: 'in/*.pdf', timeoutMs: 30 }] },
  ] }
  assert.equal((await h.call('POST', '/tasks/submit', { boardId, graph })).status, 201)
  await h.call('POST', '/tasks/activate', { boardId, scope: graphScope(graph) })
  await until(async () => taskOf(await h.state('graph-expiry'), 'upload').gates[0].status === 'expired', 'expired gate')
  const frame = h.frames.find(entry => entry.type === 'task.graph' && entry.change === 'task-gate-expired')
  assert.equal(frame.graph.tasks[0].gates[0].status, 'expired')
  assert.equal(frame.graph.tasks[0].status, 'waiting-on-dependency')
  assert.equal(h.turnStarts.length, 0)
  const continued = await h.call('POST', '/tasks/continue', { boardId, scope: graphScope(graph), taskId: 'upload', gateId: 'arrived' })
  assert.equal(continued.status, 200)
  assert.deepEqual([continued.body.graph.tasks[0].gates[0].status, continued.body.graph.tasks[0].gates[0].satisfiedBy], ['satisfied', 'user.action'])
  await until(() => h.turnStarts.length === 1, 'continued step')
})

test('the resume message carries only public condition facts and keeps long instructions intact', () => {
  const message = composeAwaitResume({
    graphId: 'graph-plan-1', planId: 'plan-1', planTitle: 'Login & publish <now>', task: { taskId: 'publish', title: 'Publish' },
    instructions: `Use ]]> safely. ${'<'.repeat(3990)}`,
    gates: [
      { gateId: 'task:collect', kind: 'task', taskId: 'collect', status: 'satisfied' },
      { gateId: 'login', kind: 'oauth', origin: 'https://github.com', pathPrefix: '/login/oauth/callback', status: 'satisfied', satisfiedBy: 'browser.oauthCompleted', satisfiedAt: '2026-10-24T01:00:00.000Z' },
      { gateId: 'exit', kind: 'terminalExit', sessionId: 'term-1', status: 'satisfied', satisfiedBy: 'user.action', satisfiedAt: '2026-10-24T02:00:00.000Z', expiredAt: '2026-10-24T01:30:00.000Z' },
      { gateId: 'pending', kind: 'userAction', label: 'token=abc123 ok', status: 'waiting' },
    ],
    taskTitles: new Map([['collect', 'Collect']]),
  })
  assert.ok(message.length < 20000, 'fits one chat message')
  assert.match(message, /<await_id>graph-plan-1\/publish<\/await_id>/)
  assert.match(message, /<plan id="plan-1">Login &amp; publish &lt;now&gt;<\/plan>/)
  assert.match(message, /Login finished at https:\/\/github\.com\/login\/oauth\/callback at 2026-10-24T01:00:00\.000Z\./)
  assert.match(message, /Continued by hand instead of waiting for Terminal term-1 to exit \(its wait ran out at 2026-10-24T01:30:00\.000Z\)/)
  assert.match(message, /<instructions><!\[CDATA\[Use \]\]\]\]><!\[CDATA\[> safely\./)
  assert.equal(message.includes('pending'), false, 'unmet conditions are not claimed')
})
