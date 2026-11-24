import test from 'node:test'
import assert from 'node:assert/strict'
import { CodexChatRuntime } from './codex-chat-runtime.mjs'
import { createCodexBrowserToolProvider } from './codex-browser-tool-provider.mjs'
import { createDecisionClient, decisionTopicRecipient } from './egdesk-decision-client.mjs'
import { mkdtempSync, readFileSync, statSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createWikiAdapter, openWikiWrites } from './egdesk-wiki-adapter.mjs'
import { createBrowserEntryConfig } from './egdesk-browser-entry-wiring.mjs'
import { createTurnMemoryConfig } from './egdesk-turn-memory-wiring.mjs'
import { mockJudge } from './egdesk-wiki-reconstruction.fixture.mjs'
import { PS_NAMES, pageStateAnswers, pageStateProbabilities, pageStateWire } from './egdesk-browser-page-state.fixture.mjs'

// L8/C9: the direct browser entry inside the REAL chat runtime (CodexChatRuntime.send), flag decisionContext.browserEntry.mode():
//   absent / 'off'  -> native input byte-identical to today
//   'advisory'      -> one entry decision recorded after dispatch; native input byte-identical; no browser action
//   'on'            -> pre-turn quiet binding, objective loop, closed note in the subjective input; the turn's run adopts the binding
// Synthetic only: the UI is an in-process double, Decisions a mock fetch, the native engine the runtime test harness.
const KEY = 'egd-synthetic-not-a-key-0008'
const OWNER = 'codex:fixture-owner'
const O = 'https://portal.example.test'
const el = (ref, role, label, extra = {}) => ({ ref, role, label, tag: role === 'link' ? 'a' : 'button', href: '', value: '', ...extra })
const PAGES = {
  [`${O}/invoices`]: [el('b1', 'link', '사업자 123-45-67890', { href: `${O}/biz/1` }), el('b2', 'link', '사업자 987-65-43210', { href: `${O}/biz/2` }), el('s1', 'button', '발행 제출')],
  [`${O}/biz/2`]: [el('d2', 'link', '이번 달 세금계산서 다운로드', { href: `${O}/download/2.pdf` })],
  [`${O}/biz/1`]: [], [`${O}/download/2.pdf`]: [],
}
const choice = (name, value, confidence) => ({ name, type: 'choice', choice: value, confidence, probabilities: [{ value, probability: confidence }] })
const starts = (choices, text) => choices.find(c => c.value.includes(text))?.value

function qaHarness(override = {}) {
  const calls = [], events = [], legacy = [], replies = []
  let turnCount = 0, threadCount = 0
  const defaults = async (method, params) => {
    if (method === 'thread/start') return { thread: { id: `thread-${++threadCount}` }, cwd: '/work', model: 'configured-model' }
    if (method === 'thread/resume') return { thread: { id: params.threadId, turns: [] }, cwd: '/work' }
    if (method === 'turn/start') return { turn: { id: `turn-${++turnCount}`, status: 'inProgress', items: [] } }
    if (method === 'turn/interrupt') return {}
    throw new Error(`Unexpected method: ${method}`)
  }
  const chat = new CodexChatRuntime({
    request: async (method, params) => {
      calls.push({ method, params }); override.onRequest?.(method)
      if (override.failTurn && method === 'turn/start') throw Object.assign(new Error('native refused'), { code: -32000 })
      if (method === 'experimentalFeature/list') return { data: ['browser_use', 'browser_use_external', 'computer_use'].map(name => ({ name, enabled: false, stage: 'stable' })), nextCursor: null }
      if (method === 'mcpServerStatus/list') return { data: [], nextCursor: null }
      if (method === 'thread/unsubscribe') return { status: 'unsubscribed' }
      if (method === 'config/read') return { config: { developer_instructions: 'Ordinary instructions' }, layers: [] }
      const result = await defaults(method, params)
      if (method === 'thread/start' || method === 'thread/resume') return { ...result, sandbox: { type: 'readOnly', networkAccess: false }, approvalPolicy: 'never' }
      return result
    },
    respond: (...args) => replies.push(args), emit: event => events.push(event), emitLegacy: event => legacy.push(event),
    toolProviders: override.toolProviders, getOwnerKey: override.getOwnerKey, qaReady: override.qaReady,
    verifyFile: async () => null, decisionContext: override.decisionContext,
  })
  chat.setConnection(true)
  const finish = (run, status = 'completed') => chat.handleNotification({ method: 'turn/completed', params: { threadId: run.conversationId, turn: { id: run.runId, status, items: [] } } })
  return { chat, calls, events, replies, finish }
}

function build({ entryMode, hang = false, withClient = true, outcomes = null, failTurn = false, entryConfig = null, judge = null, contextExtra = null } = {}) {
  const timeline = [], decisions = [], acts = [], uiKinds = []
  let docSeq = 1
  let cur = { url: `${O}/invoices`, documentId: 'doc1', revision: 1 }
  const snap = () => ({ cardId: 'card', documentId: cur.documentId, revision: cur.revision, url: cur.url, readyState: 'complete', text: ['합성 포털'],
    viewport: { width: 300, height: 200, devicePixelRatio: 1 }, interactiveElements: PAGES[cur.url] })
  const client = createDecisionClient({
    recipientForKey: (value, endpoint, model) => decisionTopicRecipient(value, 1, endpoint, model), getApiKey: async () => KEY,
    fetchImpl: async (_e, { body, signal }) => {
      const wire = JSON.parse(body), q0 = wire.questions[0], evidence = wire.input[1].content
      const stepQ = wire.questions.find(q => q.name === 'next_step') ?? (q0.choices ? q0 : { choices: [] }) // c16: a code-decided step asks no next_step
      decisions.push({ q: q0.name, image: /image/i.test(body) }); timeline.push(`decide:${q0.name}`)
      if (hang) await new Promise((_, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true }))
      if (q0.name === 'browser_entry') {
        const msg = /User message: (.*)/.exec(evidence)?.[1] ?? ''
        return { ok: true, text: async () => JSON.stringify({ answers: [choice('browser_entry', /세금계산서|두 번째/.test(msg) ? starts(q0.choices, '[C1]') : 'not_browser_task', 0.95)] }) }
      }
      if (q0.name === 'task_resume') return { ok: true, text: async () => JSON.stringify({ answers: [choice('task_resume', 'resume_task', 0.95)] }) }
      const url = /URL: (\S+)/.exec(evidence)?.[1], ctx = /Context the user gave in the chat \(not page text\):\n([\s\S]*?)\n\n/.exec(evidence)?.[1] ?? ''
      let next, goalMet = 0
      if (/\/download\//.test(url)) { next = 'goal_met'; goalMet = 0.95 }
      else if (url.endsWith('/invoices')) {
        const listed = /it is listed now as (\[L\d+\] [^\n]*?)\.(?:\n|$)/.exec(evidence)
        next = listed ? listed[1].trim() : /두 번째/.test(ctx) ? starts(stepQ.choices, '987-65') : 'needs_user_context'
      }
      else next = starts(stepQ.choices, '다운로드')
      const answer = choice('next_step', next, 0.95)
      if (next === 'needs_user_context') answer.probabilities.push({ value: starts(stepQ.choices, '123-45'), probability: 0.02 }, { value: starts(stepQ.choices, '987-65'), probability: 0.02 })
      return { ok: true, text: async () => JSON.stringify({ answers: [answer, ...pageStateWire('content'), { name: 'goal_met', type: 'predicate', probability: goalMet }] }) }
    },
  })
  const transport = { runs: new Map(), hasClient: id => id === 'ui',
    bindRun: (id, thread, transportId) => { if (transport.runs.has(id)) throw new Error('already bound'); transport.runs.set(id, { clientThreadId: thread, transportId, ownerKey: OWNER }) },
    unbindRun: id => transport.runs.delete(id),
    async sendToUi(request) {
      uiKinds.push({ kind: request.kind, runId: request.runId }); timeline.push(`ui:${request.kind}`)
      const reply = { requestId: request.requestId }
      if (request.kind === 'bind') return { ...reply, status: 'bound', binding: { cardId: 'card', cardEpoch: 'epoch', profileId: 'fixture', accountId: '', userContextId: 0, url: cur.url, engineAccountKey: OWNER, authorityEpoch: 1 } }
      if (request.kind === 'observe') { const wait = request.options?.wait
        return { ...reply, status: 'observed', snapshot: wait ? { ...snap(), wait: { for: wait.for, outcome: 'met', elapsedMs: 1 } } : snap() } }
      if (request.kind === 'act') {
        const a = request.action; acts.push({ type: a.type, url: a.url ?? null, ref: a.ref ?? null })
        if (a.type === 'navigate') cur = { url: a.url, documentId: `doc${++docSeq}`, revision: 1 }
        return { ...reply, status: 'acted', receipt: { after: snap(), observation: {}, dispatchReceipt: { actor: 'JSWindowActor', eventDispatched: true, documentStillCurrent: true, inputRoute: 'chrome-load-uri' } } }
      }
      if (request.kind === 'cancel') return { ...reply, status: 'cancelled' }
      return { ...reply, status: 'rejected' }
    },
  }
  const provider = createCodexBrowserToolProvider({ transport, getOwnerKey: () => OWNER, decision: { mode: () => 'on', configured: () => true, client,
    recipient: () => decisionTopicRecipient(KEY, 1, undefined, client.model), generation: () => 0 } })
  const calibration = []
  const MEMORY_Q = /^(pg_|st_|op_|tn_|tw_|speech_)/
  const ctxClient = judge ? { decide: request => (request.questions.some(q => MEMORY_Q.test(q.name)) ? judge.decide(request) : client.decide(request)) } : client
  const decisionContext = entryMode === undefined && !entryConfig ? undefined : { mode: () => (withClient ? 'on' : 'off'), configured: () => withClient, client: ctxClient, calibrationLog: { record: raw => { calibration.push(raw); return {} }, complete() {} },
    ...(entryConfig ? { browserEntry: entryConfig } : entryMode === 'absent' ? {} : { browserEntry: { mode: () => entryMode, ...(outcomes ? { outcomeSink: outcomes } : {}) } }), ...(contextExtra || {}) }
  const h = qaHarness({ toolProviders: [provider], getOwnerKey: () => OWNER, decisionContext, failTurn, onRequest: method => timeline.push(`native:${method}`) })
  const source = { id: 'selected-source', kind: 'browser', selectedByUser: true, browserToolPermission: 'interact',
    sourceRef: { viewId: 'card', profileId: 'fixture', accountId: '', uri: `${O}/invoices` },
    browserToolIdentity: { cardEpoch: 'epoch', userContextId: 0, engineAccountKey: OWNER, authorityEpoch: 1 },
    browserToolSelection: { token: 'one-time-token', threadId: 'selected-chat' } }
  let n = 0
  const send = async (message, extra = {}) => { n++
    return h.chat.send({ ...extra, message, requestId: `req-${n}`, clientThreadId: 'selected-chat', executionPolicy: { mode: 'browserBounded' },
      selectedSources: [{ ...source, browserToolSelection: { token: `token-${n}`, threadId: 'selected-chat' } }], browserTransportId: 'ui' }) }
  return { h, send, timeline, decisions, acts, uiKinds, calibration, provider }
}
const native = w => JSON.stringify(w.h.calls.filter(c => ['thread/start', 'turn/start'].includes(c.method)))
const allNative = w => JSON.stringify(w.h.calls)
const MSG = '거래처 포털에서 이번 달 세금계산서 내려받아줘'

test('C9 flag off / absent / off-mode: native input is byte-identical, no entry decision, no browser action', async () => {
  const baseline = build({}) // no decisionContext at all
  await baseline.send(MSG)
  for (const entryMode of ['absent', 'off']) {
    const w = build({ entryMode })
    await w.send(MSG)
    assert.equal(native(w), native(baseline), 'identical bytes')
    assert.deepEqual(w.decisions, []); assert.deepEqual(w.acts, []); assert.deepEqual(w.uiKinds.map(k => k.kind), ['bind'])
  }
})

test('C9 advisory: native input byte-identical to off, one entry decision recorded after dispatch, no browser action', async () => {
  const baseline = build({}); await baseline.send(MSG)
  const w = build({ entryMode: 'advisory' })
  const run = await w.send(MSG)
  await w.h.chat.browserEntryIdle()
  assert.equal(native(w), native(baseline))
  assert.equal(allNative(w), allNative(baseline), 'every native request, not only thread/turn start')
  assert.deepEqual(w.decisions.map(d => d.q), ['browser_entry'], 'exactly one Decisions request')
  assert.deepEqual(w.acts, []); assert.deepEqual(w.uiKinds.map(k => k.kind), ['bind'])
  assert.deepEqual(w.h.chat.browserEntryShadow.get(run.runId), { would: 'enter' })
  assert.ok(w.timeline.indexOf('native:turn/start') < w.timeline.indexOf('decide:browser_entry'), 'recorded after dispatch, never before the native turn')
  assert.equal(w.calibration.length, 1)
  assert.equal(w.calibration[0].mode, 'advisory'); assert.equal(w.calibration[0].attached, false)
  assert.doesNotMatch(JSON.stringify(w.calibration), /세금|portal|example|card/)
  // not a browser task -> would not enter
  const other = build({ entryMode: 'advisory' }); const r2 = await other.send('오늘 날씨 어때?'); await other.h.chat.browserEntryIdle()
  assert.deepEqual(other.h.chat.browserEntryShadow.get(r2.runId), { would: 'not_browser' })
})

test('C9 advisory with the decision model off: no decision, native input unchanged', async () => {
  const baseline = build({}); await baseline.send(MSG)
  const off = build({ entryMode: 'advisory', withClient: false }); await off.send(MSG); await off.h.chat.browserEntryIdle()
  assert.equal(native(off), native(baseline)); assert.deepEqual(off.decisions, [])
})

test('C9 on: pre-turn quiet binding, objective loop first, closed note only in the subjective input, the run adopts the same binding', { timeout: 20000 }, async () => {
  const w = build({ entryMode: 'on' })
  const first = await w.send(MSG)
  const turn = w.h.calls.find(c => c.method === 'turn/start').params
  const start = w.h.calls.find(c => c.method === 'thread/start').params
  // order: bind (pre-turn), entry decision, one objective step, only then the native turn
  const order = w.timeline.filter(x => /^(ui:bind|decide:|native:turn\/start)/.test(x))
  assert.deepEqual(order, ['ui:bind', 'decide:browser_entry', 'decide:next_step', 'native:turn/start'])
  assert.equal(w.uiKinds.filter(k => k.kind === 'bind').length, 1, 'one bind: the single-use selection is not bound twice')
  assert.deepEqual(w.acts, [], 'asking the user needs no action')
  // the only difference to the off-mode input: one application key carrying the closed note
  const base = build({}); await base.send(MSG)
  const baseTurn = base.h.calls.find(c => c.method === 'turn/start').params
  const { additionalContext, ...rest } = turn
  const { additionalContext: baseCtx, ...baseRest } = baseTurn
  assert.deepEqual(rest, baseRest, 'user text, ids and options unchanged')
  assert.deepEqual(JSON.stringify(start), JSON.stringify(base.h.calls.find(c => c.method === 'thread/start').params))
  assert.deepEqual(Object.keys(additionalContext).filter(k => !(baseCtx && k in baseCtx)), ['egdesk_browser_task'])
  assert.equal(additionalContext.egdesk_browser_task.kind, 'application')
  const note = JSON.parse(additionalContext.egdesk_browser_task.value).egdesk_browser_task
  assert.deepEqual([note.status, note.code, note.next], ['need_context', 'choice_needed', 'ask_user_in_chat'])
  assert.doesNotMatch(additionalContext.egdesk_browser_task.value, /https?:|example\.test|\/biz|제출/)
  // the turn's run now holds the grant: a native tool call for it reaches the UI with the original (pre-turn) runId
  const toolCall = id => w.h.chat.handleServerRequest({ id, method: 'item/tool/call', params: { threadId: first.conversationId, turnId: first.runId, callId: id, tool: 'egdesk_browser_observe', arguments: { cardId: 'card' } } })
  await toolCall('obs-1')
  await new Promise(resolve => setImmediate(resolve))
  const reply = w.h.replies.find(r => r[0] === 'obs-1')
  assert.equal(reply?.[1]?.success, true)
  assert.ok(w.uiKinds.some(k => k.kind === 'observe' && k.runId.startsWith('pre-')), 'binding kept its original run id toward the UI')
  // the user's answer resumes the same task through the same entry: closed note says done, same task id
  w.h.finish(first)
  const second = await w.send('두 번째 사업자로', { conversationId: first.conversationId })
  const turn2 = w.h.calls.filter(c => c.method === 'turn/start')[1].params
  const note2 = JSON.parse(turn2.additionalContext.egdesk_browser_task.value).egdesk_browser_task
  assert.deepEqual([note2.status, note2.id], ['done', note.id])
  assert.deepEqual(w.acts.map(a => [a.type, a.url]), [['navigate', `${O}/biz/2`], ['navigate', `${O}/download/2.pdf`]])
  assert.equal(w.acts.filter(a => a.type === 'fill' || a.ref === 's1').length, 0)
  assert.equal(second.accepted, true)
  // the subjective model's own turn text never changed
  assert.equal(turn2.input[0].text, '두 번째 사업자로')
})

test('C9 on, not a browser task: ordinary turn (no note), binding still adopted and usable', async () => {
  const w = build({ entryMode: 'on' })
  const run = await w.send('오늘 날씨 어때?')
  const turn = w.h.calls.find(c => c.method === 'turn/start').params
  assert.equal(turn.additionalContext?.egdesk_browser_task, undefined)
  assert.deepEqual(w.decisions.map(d => d.q), ['browser_entry']); assert.deepEqual(w.acts, [])
  assert.equal(w.uiKinds.filter(k => k.kind === 'bind').length, 1)
  assert.ok(run.runId)
})

test('C9 on with a hung decision endpoint: falls back to the ordinary turn after the 4 s foreground deadline, nothing acted', { timeout: 20000 }, async () => {
  const w = build({ entryMode: 'on', hang: true })
  const started = performance.now()
  await w.send(MSG)
  const elapsed = performance.now() - started
  const turn = w.h.calls.find(c => c.method === 'turn/start').params
  assert.equal(turn.additionalContext?.egdesk_browser_task, undefined)
  assert.deepEqual(w.acts, [])
  assert.ok(elapsed >= 3000 && elapsed < 9000, `elapsed ${elapsed}`)
})

test('C9 on: a native turn refusal after the pre-turn binding cancels that binding (no leaked grant), nothing acted', async () => {
  const w = build({ entryMode: 'on', failTurn: true })
  await assert.rejects(() => w.send(MSG), /native refused/)
  await new Promise(resolve => setImmediate(resolve))
  const kinds = w.uiKinds.map(k => k.kind)
  assert.deepEqual(kinds.filter(k => k === 'bind').length, 1)
  assert.ok(kinds.includes('cancel'), 'the pre-turn binding was released')
  assert.deepEqual(w.acts, [])
})

// ---- C10: flags on, end to end: entry advisory -> on, memory packet -> objective loop -> outcome persisted -> a later session fetches it ----
function flagged(dir, mode) {
  const log = []
  const judge = mockJudge(log)
  const adapter = createWikiAdapter({ writes: openWikiWrites({ dataDir: dir }) })
  const flag = { value: mode }
  const config = createBrowserEntryConfig({ flag: () => flag.value, getAdapter: () => adapter, wiki: ({ context }) => adapter.snapshot({ context }) })
  return { log, judge, adapter, flag, config }
}
const newDir = () => { const dir = mkdtempSync(path.join(tmpdir(), 'egdesk-c10-')); chmodSync(dir, 0o700); return dir }

test('C10 end to end: advisory records only; month 1 asks and persists the outcome; month 2 (new runtime, reopened store) fetches it and does not ask', { timeout: 30000 }, async () => {
  const dir = newDir()
  // advisory: the entry decision only; no memory fetch, no write, native input identical
  const adv = flagged(dir, 'advisory')
  const baseline = build({}); await baseline.send(MSG)
  const a = build({ entryConfig: adv.config, judge: adv.judge })
  const run = await a.send(MSG); await a.h.chat.browserEntryIdle()
  assert.equal(allNative(a), allNative(baseline))
  assert.deepEqual(a.h.chat.browserEntryShadow.get(run.runId), { would: 'enter' })
  assert.deepEqual(a.decisions.map(d => d.q), ['browser_entry']); assert.equal(adv.log.length, 0, 'advisory fetches no memory and writes nothing')
  assert.equal(adv.adapter.snapshot && (await adv.adapter.snapshot({ context: { clientThreadId: 'selected-chat' } })).pages.size, 0)

  // month 1, on: nothing remembered yet -> asks; the answer resumes; the outcome is written through the persistent path
  const m1 = flagged(dir, 'on')
  const w1 = build({ entryConfig: m1.config, judge: m1.judge })
  const first = await w1.send(MSG)
  const note1 = JSON.parse(w1.h.calls.find(c => c.method === 'turn/start').params.additionalContext.egdesk_browser_task.value).egdesk_browser_task
  assert.deepEqual([note1.status, note1.code], ['need_context', 'choice_needed'])
  const fetchCalls1 = m1.log.length
  w1.h.finish(first)
  await w1.send('두 번째 사업자로', { conversationId: first.conversationId })
  // L7 c17: the outcome of a Browser task is written by a code rule (an agent_note page), with no write judgment: no Decision request at all
  assert.deepEqual(m1.log.slice(fetchCalls1).map(l => l.questions.some(q => /^(pg_|st_|op_)/.test(q)) ? 'fetch' : l.questions.some(q => q.startsWith('tw_')) ? 'write-judgment' : 'other'), [], 'the answer to a paused task fetches no memory again and asks nothing to store its outcome')
  await new Promise(resolve => setTimeout(resolve, 50))
  const file = path.join(dir, 'egdesk-wiki-writes.json')
  assert.equal(statSync(file).mode & 0o077, 0, 'private file')
  const stored = JSON.parse(readFileSync(file, 'utf8')).pages
  assert.equal(stored.length, 1)
  assert.match(stored[0].id, /^browser-task\/bt_[0-9a-f]{12}$/)
  assert.equal(stored[0].provenance.kind, 'agent_note'); assert.equal(stored[0].scope, 'dm:selected-chat'); assert.equal(stored[0].ref, undefined, 'the outcome text is the body, not a message reference')
  assert.match(stored[0].body, /사업자 987-65-43210 @ \/invoices \[choice_needed\]/)
  assert.doesNotMatch(readFileSync(file, 'utf8'), /두 번째|https?:|\?|SECRET/)

  // month 2: a NEW runtime, adapter and store object over the same file; the memory feature fetches the record, the loop does not ask
  const m2 = flagged(dir, 'on')
  const w2 = build({ entryConfig: m2.config, judge: m2.judge })
  await w2.send(MSG)
  const note2 = JSON.parse(w2.h.calls.find(c => c.method === 'turn/start').params.additionalContext.egdesk_browser_task.value).egdesk_browser_task
  assert.deepEqual([note2.status, note2.code], ['done', undefined])
  assert.deepEqual(w2.acts.map(x => [x.type, x.url]), [['navigate', `${O}/biz/2`], ['navigate', `${O}/download/2.pdf`]])
  // c16: on /invoices the recorded choice is taken by code; that request asks the page-state predicates and goal_met, never "which" (4 requests, as before)
  assert.deepEqual(w2.decisions.reduce((m, d) => (m[d.q] = (m[d.q] || 0) + 1, m), {}), { browser_entry: 1, ps_sign_in: 1, next_step: 2 })
  assert.equal(w2.acts.filter(x => x.type === 'fill' || x.ref === 's1').length, 0)
  assert.ok(m2.log.length >= 1, 'the general memory feature ran its own Decisions calls')
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).pages.length, 2, 'the second outcome is persisted too')
})

test('C10 flag off by default: the bridge-style config with no flag never fetches, writes or opens a file', async () => {
  const dir = newDir(), x = flagged(dir, undefined)
  const w = build({ entryConfig: x.config, judge: x.judge })
  await w.send(MSG)
  const baseline = build({}); await baseline.send(MSG)
  assert.deepEqual(w.decisions, []); assert.equal(x.log.length, 0); assert.deepEqual(w.acts, [])
  assert.equal(allNative(w), allNative(baseline))
})

// L3/C11: with the heartbeat flag on, the pre-turn task loop feeds the conversation's heartbeat read-only facts. Everything the
// entry does and everything the native engine receives is identical to the run without the flag.
test('C11 on + heartbeat: the task loop feeds step count and waiting state to the heartbeat; native input and browser actions are unchanged', { timeout: 20000 }, async () => {
  const base = build({ entryMode: 'on' }); await base.send(MSG)
  const w = build({ entryMode: 'on' })
  w.h.chat.decisionContext.conversationFlow = { mode: () => 'on' }
  const first = await w.send(MSG)
  try {
    const sameTask = text => text.replace(/bt_[0-9a-f]{12}/g, 'bt') // the task id is random per task
    assert.equal(sameTask(native(w)), sameTask(native(base)), 'identical native bytes with the heartbeat on (apart from the random task id)')
    assert.deepEqual(w.decisions, base.decisions); assert.deepEqual(w.acts, base.acts); assert.deepEqual(w.uiKinds.map(k => k.kind), base.uiKinds.map(k => k.kind))
    const hb = w.h.chat.heartbeatFor('selected-chat')
    assert.equal(hb.state, 'running')
    const facts = hb.facts()
    assert.equal(facts.phase, 'thinking', 'the question is still being worded: the person is not awaited yet')
    const row = facts.sources.browser_task
    assert.deepEqual([row.active, row.phase, row.waitingOnUser, row.stepsDone, row.stepsRemaining, row.task, row.awaiting, row.awaitingCode], [true, 'handing_off', false, 1, 23, 'handing_off', 'need_context', 'choice_needed'])
    assert.deepEqual(Object.keys(row).sort(), ['active', 'awaiting', 'awaitingCode', 'idleMs', 'lastActionAgeMs', 'phase', 'stepsDone', 'stepsRemaining', 'task', 'waitingOnUser'])
    assert.doesNotMatch(JSON.stringify(facts), /세금|portal|example|사업자/)
    assert.equal(base.h.chat.heartbeatFor('selected-chat'), null, 'no heartbeat without the flag')
    w.h.finish(first)
    await new Promise(resolve => setImmediate(resolve))
    // The run ended; the conversation's session goes on at the idle tempo until it idles out or the conversation is closed.
    assert.deepEqual([hb.state, hb.tempo, w.h.chat.heartbeats.size], ['running', 'idle', 1])
    assert.equal(w.h.chat.closeSession('selected-chat'), true)
    assert.deepEqual([hb.state, hb.stopReason, w.h.chat.heartbeats.size], ['stopped', 'closed', 0])
  } finally { w.h.chat.heartbeats.stopAll('restart') }
})

// ---- C14: the merged memory code with its newer switches on (turn memory 'on', one packet, the at-page speech design) ----
test('C14 turn memory on + onePacket + at-page: the browser hook still gets last month\'s outcome page with its body, and the bounded turn carries only the task note', { timeout: 30000 }, async () => {
  const dir = newDir()
  const wired = () => {
    const log = [], judge = mockJudge(log)
    const adapter = createWikiAdapter({ writes: openWikiWrites({ dataDir: dir }) })
    const tm = createTurnMemoryConfig({ settings: { turnMemory: { mode: 'on' } }, getAdapter: () => adapter, onePacket: true })
    // bridge-style: the browser entry shares the turn-memory adapter and its snapshot builder
    const config = createBrowserEntryConfig({ flag: () => 'on', getAdapter: () => tm.getAdapter(), wiki: args => tm.wiki(args) })
    // The runtime reads the switch as decisionContext.turnMemory.onePacket; it is set here exactly where the runtime looks for it.
    return { log, judge, adapter, tm, config, contextExtra: { turnMemory: { ...tm, onePacket: true }, speechDesign: 'at-page' } }
  }
  const file = path.join(dir, 'egdesk-wiki-writes.json')
  // What the at-page design leaves in the same store: an utterance page that is only a reference to the chat message (no body).
  const seed = wired(), ctx = { clientThreadId: 'selected-chat' }
  const referenced = seed.adapter.writerFor(await seed.adapter.snapshot({ context: ctx }), { enabled: true, canWrite: () => true })
    .apply({ op: 'new_page', time: { slice: 'past' }, status: 'done', provenance: { kind: 'utterance' }, links: [], spokenAt: null },
      { message: '지난달 세금계산서는 두 번째 사업자로 받았어', messageRef: 'chat-message:m-1', scope: seed.adapter.scopeFor(ctx), operationId: 'utterance-1' })
  assert.equal(referenced.status, 'stored')
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).pages.map(p => [typeof p.body, p.ref]), [['undefined', 'chat-message:m-1']])

  // month 1: asks, the answer resumes, the outcome page is written with its body
  const m1 = wired()
  assert.deepEqual([m1.contextExtra.turnMemory.mode(), m1.contextExtra.turnMemory.onePacket, m1.contextExtra.turnMemory.ontologyWrite, m1.contextExtra.speechDesign], ['on', true, true, 'at-page'])
  const w1 = build({ entryConfig: m1.config, judge: m1.judge, contextExtra: m1.contextExtra })
  const first = await w1.send(MSG)
  w1.h.finish(first)
  await w1.send('두 번째 사업자로', { conversationId: first.conversationId })
  await new Promise(resolve => setTimeout(resolve, 50))
  const stored = JSON.parse(readFileSync(file, 'utf8')).pages
  const outcome = stored.find(p => p.id.startsWith('browser-task/'))
  assert.deepEqual([stored.length, outcome.provenance.kind, typeof outcome.body, outcome.ref], [2, 'agent_note', 'string', undefined], 'the outcome keeps its own text; it is not turned into a reference')
  assert.match(outcome.body, /선택: 사업자 987-65-43210 @ \/invoices \[choice_needed\]/)

  // month 2: a new runtime over the same file, the same switches on
  const m2 = wired()
  const got = await m2.config.memory({ body: { message: MSG }, context: ctx, client: m2.judge, askedAt: Date.parse('2026-11-19T09:00:00Z') })
  assert.deepEqual(got.pages.map(p => [p.id.startsWith('browser-task/'), typeof p.body]), [[true, 'string']], 'the hook is handed the outcome page, body included')
  assert.match(got.packet, /사업자 987-65-43210/)
  const w2 = build({ entryConfig: m2.config, judge: m2.judge, contextExtra: m2.contextExtra })
  await w2.send(MSG)
  const turn = w2.h.calls.find(c => c.method === 'turn/start').params
  const note = JSON.parse(turn.additionalContext.egdesk_browser_task.value).egdesk_browser_task
  assert.deepEqual([note.status, w2.acts.map(a => a.url)], ['done', [`${O}/biz/2`, `${O}/download/2.pdf`]], 'no question: the record answered it')
  // the general turn-memory packet and the one-packet merge are for ordinary turns: a bounded browser turn gets neither
  assert.deepEqual(Object.keys(turn.additionalContext).filter(k => /memory|decision|context/i.test(k)), [])
  // c16: on /invoices the recorded choice is taken by code; that request asks the page-state predicates and goal_met, never "which" (4 requests, as before)
  assert.deepEqual(w2.decisions.reduce((m, d) => (m[d.q] = (m[d.q] || 0) + 1, m), {}), { browser_entry: 1, ps_sign_in: 1, next_step: 2 })
})
