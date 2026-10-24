import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createAwaitGateRouter, gateMatchesEvent, globMatch, pathWithin } from './egdesk-await-router.mjs'
import { createWorkflowEventBus } from './egdesk-event-bus.mjs'
import { openTaskGraph } from './egdesk-task-graph.mjs'
import { openTaskStore } from './egdesk-task-store.mjs'

const OWNER = 'egdesk-local'
const delay = () => new Promise(resolve => setTimeout(resolve, 2))
async function until(predicate) {
  for (let count = 0; count < 500; count += 1) { if (await predicate()) return; await delay() }
  assert.fail('expected state did not arrive')
}

function spec(tasks, suffix = 'one') {
  return { graphId: `graph-${suffix}`, requestId: `request-${suffix}`, runId: `run-${suffix}`, parentTaskId: null, requestedBy: 'local-user',
    tasks: tasks.map(([taskId, dependsOn = [], gates]) => ({ taskId, ownerId: `agent-${taskId}`, sourceRef: `source-${taskId}`, dependsOn,
      approvalRequired: false, ...(gates ? { gates } : {}) })) }
}
const scope = value => ({ graphId: value.graphId, requestId: value.requestId, runId: value.runId, parentTaskId: value.parentTaskId, requestedBy: value.requestedBy })
const task = (runtime, graphId, taskId) => runtime.getGraph(graphId).tasks.find(entry => entry.taskId === taskId)

function harness(options = {}) {
  const starts = []
  const valid = new Set()
  let sequence = 0
  return {
    starts,
    callbacks: {
      store: options.store ?? null, maxConcurrency: options.maxConcurrency ?? 2,
      execute(context) { starts.push(context) },
      interrupt() {}, requestApproval() {},
      verifyReceipt({ receipt }) { return valid.has(receipt.receiptId) },
    },
    complete(context) {
      const receipt = { receiptId: `native-${++sequence}`, outcome: 'completed', binding: structuredClone(context.binding), evidenceRefs: [] }
      valid.add(receipt.receiptId)
      return receipt
    },
  }
}

async function wired(options = {}) {
  const native = harness(options)
  const graph = await openTaskGraph(native.callbacks)
  const bus = createWorkflowEventBus()
  const router = createAwaitGateRouter({ graph, bus, owner: OWNER })
  const publish = async (topic, payload) => { const event = bus.publish({ topic, owner: OWNER, payload }); await bus.flush(); return event }
  return { native, graph, bus, router, publish }
}

const startedIds = native => native.starts.map(context => context.binding.taskId)

test('gate conditions are explicit and exact: broad OAuth paths, wildcard-only globs and unknown kinds are refused', async () => {
  const { graph } = await wired()
  const submit = (gates, suffix) => graph.submitGraph(spec([['a', [], gates]], suffix))
  for (const [bad, label] of [
    [[{ gateId: 'g', kind: 'oauth', origin: 'https://login.example', pathPrefix: '/' }], 'bare slash prefix'],
    [[{ gateId: 'g', kind: 'oauth', origin: 'https://login.example/', pathPrefix: '/cb' }], 'non-canonical origin'],
    [[{ gateId: 'g', kind: 'oauth', origin: '*.example', pathPrefix: '/cb' }], 'wildcard origin'],
    [[{ gateId: 'g', kind: 'oauth', origin: 'https://login.example', pathPrefix: '/cb?code=1' }], 'query in prefix'],
    [[{ gateId: 'g', kind: 'oauth', origin: 'https://login.example', pathPrefix: '/a/../cb' }], 'dot segments'],
    [[{ gateId: 'g', kind: 'oauth', origin: 'javascript:alert(1)', pathPrefix: '/cb' }], 'non-web origin'],
    [[{ gateId: 'g', kind: 'file', root: 'root-1', relativeGlob: '**' }], 'wildcard-only glob'],
    [[{ gateId: 'g', kind: 'file', root: 'root-1', relativeGlob: '*/*' }], 'wildcard-only glob'],
    [[{ gateId: 'g', kind: 'file', root: 'root-1', relativeGlob: '../outside.pdf' }], 'escaping glob'],
    [[{ gateId: 'g', kind: 'file', root: 'root-1', relativeGlob: '/abs.pdf' }], 'absolute glob'],
    [[{ gateId: 'g', kind: 'terminalExit', sessionId: 'term-1', exitCode: 'zero' }], 'non-integer exit code'],
    [[{ gateId: 'g', kind: 'browserAnything', url: 'https://x' }], 'unknown kind'],
    [[{ gateId: 'approval', kind: 'userAction' }], 'reserved gate ID'],
    [[{ gateId: 'task:a', kind: 'userAction' }], 'reserved gate ID'],
    [[{ gateId: 'g', kind: 'userAction' }, { gateId: 'g', kind: 'userAction' }], 'duplicate gate ID'],
    [[{ gateId: 'g', kind: 'userAction', label: 'x', extra: true }], 'extra field'],
  ]) await assert.rejects(submit(bad, `bad-${label.replaceAll(' ', '-')}-${Math.random().toString(36).slice(2, 7)}`), { code: 'E_TASK_INPUT' }, label)
  const accepted = await submit([
    { gateId: 'z-exit', kind: 'terminalExit', sessionId: 'term-1', exitCode: 0 },
    { gateId: 'a-login', kind: 'oauth', origin: 'http://127.0.0.1:8123', pathPrefix: '/oauth/callback', cardId: 'card-1' },
    { gateId: 'm-file', kind: 'file', root: 'root-1', relativeGlob: 'inbox/*.pdf' },
    { gateId: 'u-continue', kind: 'userAction', label: 'GitHub 로그인 후 계속' },
  ], 'ok')
  const gates = accepted.tasks[0].gates
  assert.deepEqual(gates.map(gate => gate.gateId), ['a-login', 'm-file', 'u-continue', 'z-exit'], 'canonical gate order')
  assert.ok(gates.every(gate => gate.status === 'waiting'))
  assert.equal(accepted.tasks[0].status, 'queued')
})

test('a graph journal written before gates replays unchanged, and tasks without gates keep the old spec shape', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'egdesk-gates-compat-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const store = await openTaskStore(directory)
  const old = { graphId: 'graph-old', requestId: 'request-old', runId: 'run-old', parentTaskId: null, requestedBy: 'local-user',
    tasks: [{ taskId: 'a', ownerId: 'agent-a', sourceRef: 'source-a', dependsOn: [], approvalRequired: false }] }
  await store.load()
  await store.save([{ seq: 1, at: new Date().toISOString(), type: 'graph-submitted', graph: old }])
  const graph = await openTaskGraph({ ...harness().callbacks, store: await openTaskStore(directory) })
  assert.equal(graph.getGraph('graph-old').tasks[0].status, 'queued')
  assert.deepEqual(graph.getGraph('graph-old').tasks[0].gates, [])
  const fresh = await graph.submitGraph(spec([['a']], 'fresh'))
  assert.equal(Object.hasOwn(graph.getEvents('graph-fresh')[0].graph.tasks[0], 'gates'), false)
  assert.deepEqual(fresh.tasks[0].gates, [])
})

test('matching is exact: same origin, path on a "/" boundary, same card, same session and exit code, same root and glob', () => {
  const oauth = { gateId: 'login', kind: 'oauth', origin: 'http://127.0.0.1:8123', pathPrefix: '/oauth/callback', cardId: 'card-1' }
  const done = (origin, path, cardId = 'card-1', topic = 'browser.oauthCompleted') => ({ topic, payload: { cardId, origin, path } })
  assert.equal(gateMatchesEvent(oauth, done('http://127.0.0.1:8123', '/oauth/callback')), true)
  assert.equal(gateMatchesEvent(oauth, done('http://127.0.0.1:8123', '/oauth/callback/github')), true)
  assert.equal(gateMatchesEvent(oauth, done('http://127.0.0.1:8123', '/oauth/callbackevil')), false)
  assert.equal(gateMatchesEvent(oauth, done('http://localhost:8123', '/oauth/callback')), false)
  assert.equal(gateMatchesEvent(oauth, done('https://127.0.0.1:8123', '/oauth/callback')), false)
  assert.equal(gateMatchesEvent(oauth, done('http://127.0.0.1:8124', '/oauth/callback')), false)
  assert.equal(gateMatchesEvent(oauth, done('http://127.0.0.1:8123', '/oauth/callback', 'card-2')), false)
  assert.equal(gateMatchesEvent(oauth, done('http://127.0.0.1:8123', '/oauth/callback', 'card-1', 'browser.navigated')), false, 'navigation alone is not completion')
  assert.equal(pathWithin('/a/', '/a/'), true)
  assert.equal(pathWithin('/a', '/a/'), false)
  assert.equal(pathWithin('/anything', '/'), false)

  const exit = { gateId: 'e', kind: 'terminalExit', sessionId: 'term-1', exitCode: 0 }
  assert.equal(gateMatchesEvent(exit, { topic: 'terminal.exit', payload: { sessionId: 'term-1', exitCode: 0 } }), true)
  assert.equal(gateMatchesEvent(exit, { topic: 'terminal.exit', payload: { sessionId: 'term-1', exitCode: 1 } }), false)
  assert.equal(gateMatchesEvent(exit, { topic: 'terminal.exit', payload: { sessionId: 'term-2', exitCode: 0 } }), false)
  assert.equal(gateMatchesEvent({ ...exit, exitCode: undefined }, { topic: 'terminal.exit', payload: { sessionId: 'term-1', exitCode: 1 } }), true)

  const file = { gateId: 'f', kind: 'file', root: 'root-1', relativeGlob: 'inbox/**/*.pdf' }
  const changed = (rootId, relativePath) => ({ topic: 'file.changed', payload: { rootId, relativePath, change: 'rename' } })
  assert.equal(gateMatchesEvent(file, changed('root-1', 'inbox/a.pdf')), true)
  assert.equal(gateMatchesEvent(file, changed('root-1', 'inbox/2026/10/a.pdf')), true)
  assert.equal(gateMatchesEvent(file, changed('root-1', 'inbox/a.pdf.tmp')), false)
  assert.equal(gateMatchesEvent(file, changed('root-2', 'inbox/a.pdf')), false)
  assert.equal(globMatch('*.pdf', 'sub/a.pdf'), false)
  assert.equal(globMatch('report-??.csv', 'report-07.csv'), true)
  assert.equal(globMatch('a.(x)+[y]', 'a.(x)+[y]'), true, 'regex characters are literal')

  const manual = { topic: 'user.action', payload: { graphId: 'g1', taskId: 't1', gateId: 'login' } }
  assert.equal(gateMatchesEvent(oauth, manual, { graphId: 'g1', taskId: 't1' }), true, 'manual continue is the fallback for any kind')
  assert.equal(gateMatchesEvent(oauth, manual, { graphId: 'g1', taskId: 't2' }), false)
  assert.equal(gateMatchesEvent({ gateId: 'u', kind: 'userAction' }, { topic: 'terminal.exit', payload: { sessionId: 'u', exitCode: 0 } }), false)
})

test('when the matching event arrives the gate is satisfied and the waiting downstream task starts by itself', async () => {
  const { native, graph, publish } = await wired()
  const value = spec([['build'], ['deploy', ['build'], [{ gateId: 'build-exit', kind: 'terminalExit', sessionId: 'term-7', exitCode: 0 }]]])
  await graph.submitGraph(value)
  await graph.activateGraph(scope(value))
  assert.deepEqual(startedIds(native), ['build'])
  await graph.recordOutcome(native.complete(native.starts[0]))
  const waiting = task(graph, value.graphId, 'deploy')
  assert.equal(waiting.status, 'waiting-on-dependency')
  assert.deepEqual(waiting.gates.map(gate => [gate.gateId, gate.kind, gate.status]), [['task:build', 'task', 'satisfied'], ['build-exit', 'terminalExit', 'waiting']])
  await publish('terminal.exit', { sessionId: 'term-8', exitCode: 0 })
  await publish('terminal.exit', { sessionId: 'term-7', exitCode: 2 })
  assert.deepEqual(startedIds(native), ['build'], 'another session or exit code does not count')
  const event = await publish('terminal.exit', { sessionId: 'term-7', exitCode: 0 })
  await until(() => native.starts.length === 2)
  const started = task(graph, value.graphId, 'deploy')
  assert.equal(started.status, 'running')
  assert.deepEqual(started.gates[1], { gateId: 'build-exit', kind: 'terminalExit', sessionId: 'term-7', exitCode: 0, status: 'satisfied', satisfiedBy: 'terminal.exit', satisfiedAt: event.at })
  assert.equal(graph.getEvents(value.graphId).filter(entry => entry.type === 'task-gate-satisfied').length, 1)
})

test('an event that arrives while upstream work is still running is kept; the task starts as soon as upstream completes', async () => {
  const { native, graph, publish } = await wired()
  const value = spec([['fetch'], ['summarize', ['fetch'], [{ gateId: 'arrival', kind: 'file', root: 'root-dl', relativeGlob: '*.csv' }]]], 'latched')
  await graph.submitGraph(value)
  await graph.activateGraph(scope(value))
  await publish('file.changed', { rootId: 'root-dl', relativePath: 'sales.csv', change: 'rename' })
  assert.equal(task(graph, value.graphId, 'summarize').gates[1].status, 'satisfied')
  assert.deepEqual(startedIds(native), ['fetch'])
  await graph.recordOutcome(native.complete(native.starts[0]))
  assert.deepEqual(startedIds(native), ['fetch', 'summarize'])
})

test('one event can open several gates, but at most maxConcurrency tasks run; the rest start as slots free up', async () => {
  const { native, graph, publish } = await wired({ maxConcurrency: 2 })
  const gate = id => [{ gateId: `wait-${id}`, kind: 'file', root: 'root-1', relativeGlob: 'ready.flag' }]
  const value = spec([['a', [], gate('a')], ['b', [], gate('b')], ['c', [], gate('c')]], 'fanout')
  await graph.submitGraph(value)
  await graph.activateGraph(scope(value))
  assert.equal(native.starts.length, 0)
  await publish('file.changed', { rootId: 'root-1', relativePath: 'ready.flag', change: 'change' })
  await until(() => native.starts.length === 2)
  assert.deepEqual(startedIds(native), ['a', 'b'])
  assert.equal(task(graph, value.graphId, 'c').status, 'ready')
  await graph.recordOutcome(native.complete(native.starts[0]))
  assert.deepEqual(startedIds(native), ['a', 'b', 'c'])
})

test('manual continue (user.action) satisfies only the named gate, and a cancelled graph ignores later events', async () => {
  const { native, graph, publish } = await wired()
  const value = spec([['a', [], [{ gateId: 'login', kind: 'oauth', origin: 'https://github.com', pathPrefix: '/login/oauth' }, { gateId: 'confirm', kind: 'userAction' }]]], 'manual')
  await graph.submitGraph(value)
  await graph.activateGraph(scope(value))
  await publish('user.action', { graphId: value.graphId, taskId: 'a', gateId: 'login' })
  assert.deepEqual(task(graph, value.graphId, 'a').gates.map(gate => [gate.gateId, gate.status, gate.satisfiedBy ?? null]), [['confirm', 'waiting', null], ['login', 'satisfied', 'user.action']])
  await publish('user.action', { graphId: value.graphId, taskId: 'other', gateId: 'confirm' })
  assert.equal(native.starts.length, 0)
  await publish('user.action', { graphId: value.graphId, taskId: 'a', gateId: 'confirm' })
  assert.deepEqual(startedIds(native), ['a'])

  const cancelled = spec([['b', [], [{ gateId: 'exit', kind: 'terminalExit', sessionId: 'term-9' }]]], 'cancelled')
  await graph.submitGraph(cancelled)
  await graph.activateGraph(scope(cancelled))
  await graph.cancelGraph(scope(cancelled))
  assert.equal(graph.openGates().some(open => open.graphId === cancelled.graphId), false)
  await publish('terminal.exit', { sessionId: 'term-9', exitCode: 0 })
  assert.equal(task(graph, cancelled.graphId, 'b').status, 'cancelled')
  assert.equal(task(graph, cancelled.graphId, 'b').gates[0].status, 'waiting')
  await assert.rejects(graph.satisfyGate({ graphId: cancelled.graphId, taskId: 'b', gateId: 'exit',
    evidence: { eventId: 'wfe-1', topic: 'terminal.exit', at: new Date().toISOString() } }), { code: 'E_TASK_STATE' })
  await assert.rejects(graph.satisfyGate({ graphId: value.graphId, taskId: 'a', gateId: 'nope',
    evidence: { eventId: 'wfe-1', topic: 'terminal.exit', at: new Date().toISOString() } }), { code: 'E_TASK_SCOPE' })
  await assert.rejects(graph.satisfyGate({ graphId: value.graphId, taskId: 'a', gateId: 'login',
    evidence: { eventId: 'wfe-1', topic: 'chat.whatever', at: new Date().toISOString() } }), { code: 'E_TASK_INPUT' })
})

test('a satisfied gate is journaled and survives a restart; the reloaded graph waits for resume before starting', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'egdesk-gates-journal-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const first = await wired({ store: await openTaskStore(directory) })
  const value = spec([['a', [], [{ gateId: 'login', kind: 'oauth', origin: 'http://127.0.0.1:9000', pathPrefix: '/callback' }, { gateId: 'exit', kind: 'terminalExit', sessionId: 'term-1' }]]], 'journal')
  await first.graph.submitGraph(value)
  await first.graph.activateGraph(scope(value))
  await first.publish('browser.oauthCompleted', { cardId: 'card-1', origin: 'http://127.0.0.1:9000', path: '/callback' })
  first.router.close()
  const second = await wired({ store: await openTaskStore(directory) })
  const reloaded = task(second.graph, value.graphId, 'a')
  assert.deepEqual(reloaded.gates.map(gate => [gate.gateId, gate.status]), [['exit', 'waiting'], ['login', 'satisfied']])
  await second.publish('terminal.exit', { sessionId: 'term-1', exitCode: 0 })
  assert.equal(task(second.graph, value.graphId, 'a').status, 'ready')
  assert.equal(second.native.starts.length, 0, 'recovery hold: no start before resume')
  await second.graph.resumeGraph(scope(value))
  assert.deepEqual(startedIds(second.native), ['a'])
})
