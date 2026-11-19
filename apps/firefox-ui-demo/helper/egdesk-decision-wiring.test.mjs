import test from 'node:test'
import assert from 'node:assert/strict'
import { CodexChatRuntime } from './codex-chat-runtime.mjs'
import { collectDecisionCandidates } from './egdesk-decision-candidates.mjs'
import { DecisionError } from './egdesk-decision-client.mjs'

// Pre-turn decision model context setup wired into CodexChatRuntime.startTurn
// (DECISION_MODEL_CONTEXT_SETUP.md §4). Fake decision client, no network.

function fakeClient(answer) {
  const requests = []
  return {
    requests,
    model: 'gpt-6-luna',
    async decide(request) {
      requests.push(request)
      if (typeof answer === 'function') return answer(request)
      const answers = {}
      for (const question of request.questions) {
        if (question.type === 'choice') answers[question.name] = { type: 'choice', choice: question.choices[0].value, confidence: 0.9, probabilities: [{ value: question.choices[0].value, probability: 0.9 }] }
        else answers[question.name] = { type: 'predicate', probability: question.name === 'rel_0' ? 0.95 : 0.05 }
      }
      return { answers, model: 'gpt-6-luna', usage: { inputTokens: 10 }, latencyMs: 12 }
    },
  }
}

function harness({ mode = 'on', configured = true, client = fakeClient(), collect, budgetMs } = {}) {
  const calls = [], events = []
  let turns = 0, threads = 0
  const chat = new CodexChatRuntime({
    request: async (method, params) => {
      calls.push({ method, params })
      if (method === 'thread/start') return { thread: { id: `thread-${++threads}` }, cwd: '/work', model: 'configured-model' }
      if (method === 'turn/start') return { turn: { id: `turn-${++turns}`, status: 'inProgress', items: [] } }
      if (method === 'turn/interrupt') return {}
      throw new Error(`Unexpected method: ${method}`)
    },
    respond: () => {}, emit: event => events.push(event), emitLegacy: () => {}, verifyFile: async () => null,
    decisionContext: { mode: () => mode, configured: () => configured, client, budgetMs,
      collect: collect || (async () => [
        { id: 'board:plan', kind: 'board', title: 'Launch plan', summary: 'Q4 launch checklist', timeSlice: 'planned', loadText: () => 'Full launch plan text' },
        { id: 'message:m1', kind: 'conversation', title: '사용자: unrelated', summary: 'unrelated', timeSlice: 'past' },
      ]) },
  })
  chat.setConnection(true)
  const turnParams = () => calls.find(call => call.method === 'turn/start').params
  const decisionRows = () => events.filter(event => event.event === 'activity.completed' && event.details?.kind === 'decisionContext').map(event => event.details)
  // send() answers before the native turn starts; wait for turn/start.
  const send = async body => {
    await chat.send(body)
    for (let i = 0; i < 200 && !calls.some(call => call.method === 'turn/start'); i++) await new Promise(resolve => setTimeout(resolve, 10))
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  return { chat, calls, events, client, turnParams, decisionRows, send }
}

test("mode 'on' attaches the chosen items as egdesk_decision_context and records an activity row", async () => {
  const h = harness()
  await h.send({ message: 'What is left in the plan?' })
  const extra = h.turnParams().additionalContext
  assert.ok(extra?.egdesk_decision_context, 'decision packet attached')
  assert.equal(extra.egdesk_decision_context.kind, 'application')
  assert.match(extra.egdesk_decision_context.value, /\[item id=board:plan kind=board time=planned\]\nFull launch plan text/)
  assert.doesNotMatch(extra.egdesk_decision_context.value, /unrelated/)
  assert.equal(h.client.requests.length, 1)
  const rows = h.decisionRows()
  assert.equal(rows.length, 1)
  const text = JSON.stringify(rows[0])
  assert.match(text, /"attached":true/)
  assert.match(text, /"mode":"on"/)
  assert.match(text, /catalogHash/)
})

test("mode 'advisory' decides and records but attaches nothing", async () => {
  const h = harness({ mode: 'advisory' })
  await h.send({ message: 'What is left in the plan?' })
  assert.equal(h.client.requests.length, 1)
  assert.equal(h.turnParams().additionalContext?.egdesk_decision_context, undefined)
  const text = JSON.stringify(h.decisionRows())
  assert.match(text, /"attached":false/)
  assert.match(text, /기록만/)
})

test("mode 'off' or no saved key: no decision request, no activity, turn params as today", async () => {
  for (const options of [{ mode: 'off' }, { mode: 'on', configured: false }]) {
    const h = harness(options)
    let collected = 0
    const g = harness({ ...options, collect: async () => { collected++; return [] } })
    await h.send({ message: 'Hello' })
    await g.send({ message: 'Hello' })
    assert.equal(h.client.requests.length, 0)
    assert.equal(collected, 0)
    assert.equal(h.turnParams().additionalContext, undefined)
    assert.equal(h.decisionRows().length, 0)
  }
})

test('decision failures, throwing collectors and slow models fall back without blocking the turn', async () => {
  const failing = harness({ client: fakeClient(() => { throw new DecisionError('no_credit', 'no credit') }) })
  await failing.send({ message: 'plan?' })
  assert.equal(failing.turnParams().additionalContext, undefined)
  assert.match(JSON.stringify(failing.decisionRows()), /"reason":"no_credit"/)

  const throwing = harness({ collect: async () => { throw new Error('store broke') } })
  await throwing.send({ message: 'plan?' })
  assert.equal(throwing.turnParams().additionalContext, undefined)

  let aborted = false
  const slow = harness({ budgetMs: 50, client: fakeClient(request => new Promise((resolve, reject) => {
    request.signal?.addEventListener('abort', () => { aborted = true; reject(new DecisionError('aborted', 'cancelled')) })
  })) })
  const started = Date.now()
  await slow.send({ message: 'plan?' })
  assert.ok(Date.now() - started < 2000)
  assert.equal(aborted, true)
  assert.equal(slow.turnParams().additionalContext, undefined)
  assert.match(JSON.stringify(slow.decisionRows()), /"reason":"(timeout|aborted)"/)
})

test('bounded execution policies never run the decision setup', async () => {
  const h = harness()
  await h.chat.send({ message: 'plan?', executionPolicy: { mode: 'read-only-qa' } }).catch(() => {})
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.equal(h.client.requests.length, 0)
  assert.equal(h.decisionRows().length, 0)
})

test('collectDecisionCandidates reads permitted selections, the Board and the ontology; a raw transcript is never a capability', async () => {
  const messages = Array.from({ length: 15 }, (_, index) => ({ localMessageId: `m${index}`, role: index % 2 ? 'assistant' : 'user', text: `message ${index}` }))
  const chatStore = { listMessages: (id, { afterSeq }) => (afterSeq === 0 ? { messages: messages.slice(0, 10), hasMore: true, nextCursor: 10 } : { messages: messages.slice(10), hasMore: false, nextCursor: null }) }
  const deskStore = { board: id => (id === 'b1' ? { id: 'b1', title: '출시 Board', head: { body: { text: 'Board body' } } } : null) }
  const ontologyStore = () => ({ readGraph: async () => ({ snapshots: [{ snapshotId: 's1', label: '11월 계획', timeSlice: 'future' }], nodes: [] }) })
  const { candidates, sources } = await collectDecisionCandidates({
    body: { boardId: 'b1', selectedSources: [{ id: 'src-1', label: 'Spec.pdf', kind: 'file' }], attachments: [{ title: 'No id' }, 'bad'] },
    clientThreadId: 'c1', excludeMessageId: 'm14', chatStore, deskStore, ontologyStore, maxMessages: 4,
  })
  assert.deepEqual(sources, { selected: 2, messages: 0, board: 1, ontology: 1 })
  assert.deepEqual(candidates.map(c => c.id), ['selected:src-1', 'selected:attachments-0', 'board:b1', 'ontology-snapshot:s1'])
  assert.equal(await candidates.find(c => c.id === 'board:b1').loadText(), 'Board body')
  assert.equal(candidates.at(-1).timeSlice, 'planned')
  const broken = await collectDecisionCandidates({ body: { boardId: 'b1' }, clientThreadId: 'c1', chatStore: { listMessages: () => { throw new Error('x') } },
    deskStore: { board: () => { throw new Error('y') } }, ontologyStore: () => ({ readGraph: async () => { throw new Error('z') } }) })
  assert.deepEqual(broken, { candidates: [], sources: { selected: 0, messages: 0, board: -1, ontology: -1 } })
})
