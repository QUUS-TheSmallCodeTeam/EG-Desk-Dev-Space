import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { createSystemResourceMonitor } from './system-resource-monitor.mjs'
import { CodexChatRuntime } from './codex-chat-runtime.mjs'
import { createChatHttpHandler } from './codex-bridge-http.mjs'
import { openWorkflowRuntime } from './egdesk-workflow-runtime.mjs'
import { createLocalCapacity, LOCAL_CAPACITY_TTL_MS } from './egdesk-local-capacity.mjs'
import { boardSendPlan, boardSendErrorText, boardSendOutcome, boardMemberState } from '../overlay/resources/EGDeskBoardThread.sys.mjs'
import { taskBoardView, taskBoardWithGraph } from '../overlay/resources/EGDeskChatState.sys.mjs'

const now = Date.UTC(2026, 10, 21)
const flush = () => new Promise(resolve => setImmediate(resolve))
async function http(handler, route, body) {
  const req=Readable.from(body===undefined?[]:[Buffer.from(JSON.stringify(body))]); req.url=route; req.method=body===undefined?'GET':'POST'; req.headers={host:'127.0.0.1:39218','content-type':'application/json'}; req.socket={remoteAddress:'127.0.0.1'}
  let status, result
  const res={writeHead(s){status=s;return this},setHeader(){},end(v){result=JSON.parse(v)}}
  assert(await handler(req,res,new URL(route,'http://127.0.0.1:39218')),route)
  return {status,result}
}
const turnStarts=rpc=>rpc.filter(x=>x.method==='turn/start').map(x=>x.params)
const fakeProfileStore={runProfile:(profileId,revision)=>({binding:{profileId,revision:revision??1,hash:`hash-${profileId}`},developerInstructions:`You are ${profileId}`,toolCeiling:null,model:null})}
const members=[{kind:'user',role:'owner'},...['lead','coder','reader','extra'].map(profileId=>({kind:'agent',profileId,label:profileId,role:profileId==='lead'?'admin':'member'}))]
function runtime(emit=()=>{}, localCapacity, beforeRequest = async () => {}) {
  const rpc=[]; let nt=0,nr=0
  const chat=new CodexChatRuntime({localCapacity, request:async(method,params)=>{rpc.push({method,params}); await beforeRequest(method,params); switch(method){
    case 'thread/start':return {thread:{id:`thread-${++nt}`}}
    case 'thread/resume':return {thread:{id:params.threadId,turns:[]}}
    case 'thread/read':return {thread:{id:params.threadId,agentNickname:'Synthetic',status:{type:'active',activeFlags:[]}}}
    case 'turn/start':return {turn:{id:`turn-${++nr}`,status:'inProgress',items:[]}}
    case 'thread/unsubscribe':case 'turn/interrupt':return {}
    default:throw Error(`unexpected native RPC ${method}`)
  }},respond(){},verifyFile:async()=>null,profiles:fakeProfileStore,emit,now:()=>now})
  chat.setConnection(true); const auth=[]; const handle=createChatHttpHandler(chat,async body=>{auth.push(Object.keys(body).sort())})
  const notify=(method,params)=>chat.handleNotification({method,params})
  const finish=(threadId,id)=>notify('turn/completed',{threadId,turn:{id,status:'completed',items:[]}})
  return {chat,rpc,handle,notify,finish,auth}
}

function host(t, mode) {
  let tick = 0, busy = 100, idle = 100, pct = 10, callback, disposed = 0, reads = 0
  const monitor = createSystemResourceMonitor({ platform: 'linux', profilePath: '/synthetic-only', monotonicNow: () => tick,
    now: () => now + tick, readCpus: () => { reads++; return mode === 'missing' ? [] :
      [{ times: { user: busy, idle, nice: 0, sys: 0, irq: 0 } }] }, readTotalMemory: () => 100,
    readFreeMemory: () => 1, // cache-inclusive 99% RAM intentionally has no effect
    readDisk: async () => null, readDiskIo: async () => null, readNetwork: async () => null })
  const capacity = createLocalCapacity({ monitor: { sampleCpu() {
    const sample = monitor.sampleCpu()
    if (mode === 'error') throw Error('synthetic reader failure')
    if (mode === 'wrong-host') return { ...sample, host: 'another-computer' }
    if (mode === 'wrong-scope') return { ...sample, scope: 'engine' }
    if (mode === 'unsupported') return { ...sample, cpu: { ...sample.cpu, status: 'unsupported' } }
    if (mode === 'future') return { ...sample, at: tick + 1 }
    return sample
  } }, now: () => tick,
  setPoll(fn, ms) { assert.equal(ms, 1000); callback = fn; return 1 },
  clearPoll(id) { assert.equal(id, 1); disposed++ } })
  t.after(() => { capacity.close(); monitor.close() })
  function step(level) { pct = level ?? pct; tick += 1000; busy += pct; idle += 100 - pct; callback() }
  return { monitor, capacity, step, repeat: () => callback(), expire: () => { tick += LOCAL_CAPACITY_TTL_MS }, reads: () => reads, disposed: () => disposed }
}

const pressure = 'local-host-pressure'
test('shared CPU window, sustained high, hysteresis, expiry, and polling disposal; RAM ignored', async t => {
  const f = host(t)
  assert.equal(f.capacity.additionalLaunchReason(), null)
  f.step(99)
  f.repeat(); f.repeat()
  assert.equal(f.capacity.additionalLaunchReason(), null, 'cached samples do not count twice')
  f.step(99)
  assert.equal(f.capacity.additionalLaunchReason(), pressure)
  const displayed = await f.monitor.sample()
  assert.equal(displayed.cpu.percent, 99)
  assert.equal(displayed.memory.percent, 99)
  f.step(90); f.step(84); f.step(90)
  assert.equal(f.capacity.additionalLaunchReason(), pressure)
  f.step(85); f.step(10)
  assert.equal(f.capacity.additionalLaunchReason(), null)
  f.step(95); f.step(95)
  assert.equal(f.capacity.additionalLaunchReason(), pressure)
  f.expire()
  assert.equal(f.capacity.additionalLaunchReason(), null)
  f.capacity.close(); f.capacity.close()
  const reads = f.reads()
  f.repeat()
  assert.equal(f.reads(), reads)
  assert.equal(f.disposed(), 1)
})

const room = { id: 'fixture-room', type: 'group', engine: 'codex', agent: { profileId: 'lead', revision: 1 },
  participants: ['나','lead','coder','reader','extra'], participantAgents: Object.fromEntries(['lead','coder','reader','extra'].map(id=>[id,{profileId:id}])) }
const sendBoard = (h, message, requestId, extra) => {
  const plan = boardSendPlan(room, { clientThreadId: room.id, requestId, message, engineId: 'codex', profileId: 'lead', profileRevision: 1 })
  assert.equal(plan.path, '/chat/board/send')
  return http(h.handle, plan.path, { ...plan.body, ...extra })
}
const recipients = res => res.result.recipients.map(({ status, code }) => [status, code ?? null])
const started = ['started', null], held = ['deferred', pressure], full = ['deferred', 'BOARD_CONCURRENCY_LIMIT']
async function boardCase(t, mode, nChildren = 0) {
  const f = host(t, mode); f.step(mode === 'low' ? 10 : 99); f.step()
  if (mode === 'stale') f.expire()
  const h = runtime(undefined, f.capacity)
  const parent = (await http(h.handle, '/chat/send', { clientThreadId: 'fixture-parent', requestId: 'same-parent', message: 'Constant parent' })).result
  for (let i = 1; i <= nChildren; i++) {
    const child = `fixture-child-${i}`
    await h.notify('item/completed',{threadId:parent.conversationId,turnId:parent.runId,item:{id:`spawn-${i}`,type:'collabAgentToolCall',tool:'spawnAgent',status:'completed',senderThreadId:parent.conversationId,receiverThreadIds:[child],agentsStates:{[child]:{status:'running'}}}})
    await h.notify('thread/status/changed',{threadId:child,status:{type:'active',activeFlags:i===2?['waitingOnApproval']:[]}})
  }
  await flush(); await h.chat.queue
  assert.equal(h.chat.snapshot().runs.find(r => r.runId === parent.runId).subAgents.length, nChildren)
  const response = await sendBoard(h, '@coder @reader constant', 'same-board', { hostResourceAdvisory: { cpu: { percent: mode === 'high' ? 10 : 99 }, canary: 'DROP_SYNTHETIC_INPUT' } })
  assert.equal(response.status, 202)
  assert.ok(!JSON.stringify([h.rpc, h.auth]).includes('DROP_SYNTHETIC_INPUT'))
  return { h, f, response, turns: turnStarts(h.rpc) }
}

test('Board: 10 vs 99, missing/stale/future/mismatched/unsupported/error, client spoof, native observations, unchanged wire', async t => {
  const low = await boardCase(t, 'low', 2)
  assert.deepEqual(recipients(low.response), [started, started])
  for (const mode of ['missing', 'stale', 'wrong-host', 'wrong-scope', 'unsupported', 'future', 'error']) {
    const x = await boardCase(t, mode)
    assert.deepEqual(recipients(x.response), [started, started], mode)
    assert.deepEqual(x.turns, low.turns, mode)
    assert.deepEqual(x.h.auth, low.h.auth, mode)
  }
  const high = await boardCase(t, 'high', 2)
  assert.deepEqual(recipients(high.response), [started, held])
  assert.deepEqual(high.turns, low.turns.slice(0, 2))
  assert.deepEqual(high.h.auth, low.h.auth)
  assert.equal(boardMemberState('reader', boardSendOutcome(high.response.result, 'same-board')).label, 'CPU 포화로 미실행')
  assert.match(boardSendErrorText(pressure), /보류된 Agent만/)
  const retry = await sendBoard(high.h, '@coder @reader constant', 'same-board');
  assert.deepEqual(recipients(retry), [started, held], 'already accepted recipient is not misreported as unsent')
  assert.equal(turnStarts(high.h.rpc).length, 2)
  await high.h.finish(high.turns[1].threadId, 'turn-2')
  assert.equal(turnStarts(high.h.rpc).length, 2, 'Board does not silently dispatch deferred recipients')
  assert.deepEqual(recipients(await sendBoard(high.h, '@reader retry', 'explicit-retry')), [started])
  assert.equal(turnStarts(high.h.rpc).length, 3)
  high.f.step(10); high.f.step(10)
  assert.deepEqual(recipients(await sendBoard(high.h, '@extra after recovery', 'after-recovery')), [started])
  high.f.step(99); high.f.step(99)
  assert.deepEqual(recipients(await sendBoard(high.h, '@lead room full', 'full')), [full])
})

test('Board overlapping starts reserve both hard and pressure caps before native acknowledgement', async t => {
  for (const [level, expected] of [[99, [held, held]], [10, [started, full]]]) {
    const f = host(t); f.step(level); f.step(level)
    let unblock, reached
    const waiting = new Promise(resolve => { unblock = resolve })
    const entered = new Promise(resolve => { reached = resolve })
    const h = runtime(undefined, f.capacity, async (method, params) => {
      if (method === 'turn/start' && params.threadId === 'thread-1') { reached(); await waiting }
    })
    const first = sendBoard(h, '@coder delayed', 'wait')
    try {
      await entered
      const second = await sendBoard(h, '@reader @extra while first is pending', 'race')
      assert.deepEqual(recipients(second), expected)
    } finally { unblock() }
    assert.deepEqual(recipients(await first), [started])
    assert.equal(turnStarts(h.rpc).length, level === 99 ? 1 : 2)
  }
})

async function until(fn, label) { for (let i = 0; i < 450; i++) { if (fn()) return; await new Promise(r => setTimeout(r, 5)) } assert.fail(label) }
async function workflow(t, f, broadcast = () => {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'local-capacity-'))
  t.after(() => rm(dataDir, { recursive: true, force: true }))
  let w
  const h = runtime(e => w?.onChatEvent(e))
  const options = { dataDir, chat: h.chat, ensureAuth: async () => {}, getOwnerKey: () => 'fixture-owner', localCapacity: f.capacity, broadcast }
  w = await openWorkflowRuntime(options)
  assert.equal(w.snapshot().tasks, 'ready')
  const scope = { graphId: 'fixture-graph', requestId: 'fixture-graph-request', runId: 'fixture-graph-parent', parentTaskId: null, requestedBy: 'fixture-user' }
  const boardId = 'fixture-board'; const tasks = []
  for (const id of ['a', 'b', 'c']) {
    const row = await http(w.handle, '/task-sources', { boardId, message: `constant task ${id}` })
    assert.equal(row.status, 201)
    tasks.push({ taskId: id, ownerId: `agent-${id}`, sourceRef: row.result.sourceRef, dependsOn: [], approvalRequired: false })
  }
  assert.equal((await http(w.handle, '/tasks/submit', { boardId, graph: { ...scope, tasks, queueReason: pressure } })).status, 400)
  assert.equal((await http(w.handle, '/tasks/submit', { boardId, graph: { ...scope, tasks } })).status, 201)
  const activated = await http(w.handle, '/tasks/activate', { boardId, scope })
  assert.equal(activated.status, 200)
  const states = () => w.graph.getGraph(scope.graphId).tasks.map(({ status, queueReason }) => [status, queueReason ?? null])
  return { h, w, states, activated, options, scope, boardId }
}
const workflowTurns = rpc => turnStarts(rpc).map(({ clientUserMessageId, ...wire }) => {
  assert.match(clientUserMessageId, /^task-native-[0-9a-f-]{36}$/)
  return wire
})
const running = ['running', null], graphHeld = ['ready', pressure], graphFull = ['ready', 'task-concurrency-limit']

test('Workflow: real HTTP/SQLite/native adapter; recovery and completion automatically re-drain once', async t => {
  const lowHost = host(t); lowHost.step(10); lowHost.step(10)
  const low = await workflow(t, lowHost)
  t.after(() => low.w.close())
  await until(() => turnStarts(low.h.rpc).length === 2, 'two initial launches at 10%')
  assert.deepEqual(low.states(), [running, running, graphFull])
  const highHost = host(t); highHost.step(99); highHost.step(99)
  const frames = []; const high = await workflow(t, highHost, evt => frames.push(evt))
  t.after(() => high.w.close())
  await until(() => turnStarts(high.h.rpc).length === 1, 'first launch at 99%')
  assert.deepEqual(high.states(), [running, graphHeld, graphHeld])
  const state = await http(high.w.handle, `/tasks/state?graphId=${high.scope.graphId}`)
  assert.equal(state.result.graph.tasks[1].queueReason, pressure)
  assert.ok(frames.some(e => e.change === 'task-queue-changed' && e.graph.tasks[1].queueReason === pressure))
  const view = taskBoardView(taskBoardWithGraph(null, state.result.graph))
  assert.match(view.groups[0].tasks[1].statusText, /CPU/)
  assert.deepEqual(workflowTurns(high.h.rpc), workflowTurns(low.h.rpc).slice(0, 1))
  highHost.step(10); highHost.step(10)
  await until(() => turnStarts(high.h.rpc).length === 2, 'automatic re-drain while first is still running')
  assert.deepEqual(high.states(), [running, running, graphFull])
  assert.deepEqual(workflowTurns(high.h.rpc), workflowTurns(low.h.rpc))
  const first = turnStarts(high.h.rpc)[0]
  await high.h.finish(first.threadId, 'turn-1')
  await until(() => turnStarts(high.h.rpc).length === 3, 'completion releases hard-cap slot')
  await Promise.all([high.w.graph.reschedule(), high.w.graph.reschedule()])
  assert.equal(turnStarts(high.h.rpc).length, 3)
})

test('Workflow: under ongoing pressure completion admits first work; close/restart do not re-launch', async t => {
  const f = host(t); f.step(99); f.step(99)
  const x = await workflow(t, f)
  await until(() => turnStarts(x.h.rpc).length === 1, 'first task')
  await x.h.finish(turnStarts(x.h.rpc)[0].threadId, 'turn-1')
  await until(() => turnStarts(x.h.rpc).length === 2, 'first task following completion at 99%')
  assert.deepEqual(x.states(), [['completed', null], running, graphHeld])
  await x.w.close()
  f.expire()
  const reopened = await openWorkflowRuntime(x.options)
  t.after(() => reopened.close())
  assert.equal(reopened.graph.getGraph(x.scope.graphId).recoveryHold, true)
  await reopened.graph.reschedule()
  await new Promise(resolve => setTimeout(resolve, 1050))
  assert.equal(turnStarts(x.h.rpc).length, 2)
})

test('Board: a native timeout is uncertain, not pressure-deferred, and releases its provisional slot', async t => {
  const f = host(t); f.step(99); f.step(99)
  const h = runtime(undefined, f.capacity, async (method, params) => {
    if (method === 'turn/start' && params.threadId === 'thread-1') throw Object.assign(Error('synthetic timeout'), { code: 'RPC_TIMEOUT' })
  })
  const timedOut = await sendBoard(h, '@coder delayed', 'timeout')
  assert.equal(timedOut.result.recipients[0].dispatchStatus, 'unknown')
  assert.equal(timedOut.result.recipients[0].resumeRequired, true)
  const replay = await sendBoard(h, '@coder delayed', 'timeout')
  assert.equal(replay.result.recipients[0].dispatchStatus, 'unknown')
  assert.equal(turnStarts(h.rpc).length, 1)
  assert.deepEqual(recipients(await sendBoard(h, '@reader independent', 'next')), [started])
  assert.equal(turnStarts(h.rpc).length, 2)
})

test('Workflow: expired pressure cannot hold a ready second task indefinitely', async t => {
  const f = host(t); f.step(99); f.step(99)
  const x = await workflow(t, f); t.after(() => x.w.close())
  assert.deepEqual(x.states(), [running, graphHeld, graphHeld])
  f.expire()
  await until(() => turnStarts(x.h.rpc).length === 2, 'expired advisory releases second launch even with first running')
  assert.deepEqual(x.states(), [running, running, graphFull])
})
