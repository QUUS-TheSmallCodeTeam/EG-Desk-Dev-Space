import test from 'node:test'
import assert from 'node:assert/strict'
import { createCodexBrowserToolProvider } from './codex-browser-tool-provider.mjs'
import { createDecisionClient, decisionTopicRecipient } from './egdesk-decision-client.mjs'
import { normalizeEntry } from './egdesk-decision-calibration-log.mjs'
import { runBrowserReflex } from './egdesk-browser-reflex.mjs'
import { createBrowserTaskStore, createDirectBrowserEntry, entryQuestion, readBrowserEntry, subjectiveNote } from './egdesk-browser-task.mjs'

// L8/C6: the user's chat message goes straight to an objective browser task; the judge picks only among
// code-enumerated options plus fixed ones; need-context / cannot-proceed exit to the subjective model (a mock
// engine here), the user's reply resumes the same task. Synthetic only: UI double + mock Decisions, no Firefox.
const KEY = 'egd-synthetic-not-a-key-0008'
const O = 'https://portal.example.test'
const el = (ref, role, label, extra = {}) => ({ ref, role, label, tag: role === 'link' ? 'a' : role === 'button' ? 'button' : 'input', href: '', value: '', ...extra })
const PAGES = {
  [`${O}/otp`]: [el('o1', 'textbox', '인증번호'), el('o2', 'button', '인증 확인')],
  [`${O}/invoices`]: [el('b1', 'link', '사업자 123-45-67890', { href: `${O}/biz/1` }), el('b2', 'link', '사업자 987-65-43210', { href: `${O}/biz/2` }),
    el('x1', 'link', '자료 삭제', { href: `${O}/purge` }), el('s1', 'button', '발행 제출')],
  [`${O}/biz/1`]: [el('d1', 'link', '이번 달 세금계산서 다운로드', { href: `${O}/download/1.pdf` }), el('c1', 'link', '구독 해지', { href: `${O}/subscription/cancel` })],
  [`${O}/biz/2`]: [el('d2', 'link', '이번 달 세금계산서 다운로드', { href: `${O}/download/2.pdf` }), el('c2', 'link', '구독 해지', { href: `${O}/subscription/cancel` }), el('s2', 'button', '발행 제출')],
  [`${O}/download/1.pdf`]: [], [`${O}/download/2.pdf`]: [],
  [`${O}/only-human`]: [el('x2', 'link', '구독 해지', { href: `${O}/subscription/cancel` }), el('s3', 'button', '결제 제출')],
  [`${O}/single`]: [el('b9', 'link', '사업자 111-22-33333', { href: `${O}/biz/2` })],
}
const choice = (name, value, confidence) => ({ name, type: 'choice', choice: value, confidence, probabilities: [{ value, probability: confidence }] })
const starts = (choices, text) => choices.find(c => c.value.includes(text))?.value

async function world(t, { start, mode = 'on', hang = false }) {
  const owner = 'codex:fixture-owner'
  const decisions = [], acts = [], uiKinds = []
  let docSeq = 1
  let cur = { url: start, documentId: 'doc1', revision: 1, values: {} }
  let live = mode
  const snap = () => ({ cardId: 'card', documentId: cur.documentId, revision: cur.revision, url: cur.url, readyState: 'complete', text: ['합성 포털'],
    viewport: { width: 300, height: 200, devicePixelRatio: 1 }, interactiveElements: PAGES[cur.url].map(e => ({ ...e, value: cur.values[e.ref] ?? e.value })) })
  const answerNext = ({ url, evidence, choices }) => {
    const ctx = /Context the user gave in the chat \(not page text\):\n([\s\S]*?)\n\n/.exec(evidence)?.[1] ?? ''
    const downloaded = /\/download\//.test(url)
    if (downloaded) return { next: ['goal_met', 0.9], goalMet: 0.95 }
    if (url.endsWith('/otp')) return { next: ['blocked', 0.9], pageState: 'two_factor_required' }
    if (url.endsWith('/invoices')) return /두 번째/.test(ctx) ? { next: [starts(choices, '987-65'), 0.95] } : { next: ['needs_user_context', 0.9] }
    if (url.endsWith('/biz/2') || url.endsWith('/biz/1')) return { next: [starts(choices, '다운로드'), 0.95] }
    if (url.endsWith('/single')) return { next: [starts(choices, '111-22'), 0.95] }
    return { next: ['blocked', 0.9] }
  }
  const client = createDecisionClient({
    recipientForKey: (value, endpoint, model) => decisionTopicRecipient(value, 1, endpoint, model),
    getApiKey: async () => KEY,
    fetchImpl: async (_endpoint, { body, signal }) => {
      const wire = JSON.parse(body)
      const q0 = wire.questions[0], evidence = wire.input[1].content
      decisions.push({ q: q0.name, image: /image/i.test(body), choices: q0.choices?.map(c => c.value) })
      if (hang) await new Promise((_, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true }))
      if (q0.name === 'browser_entry') {
        const msg = /User message: (.*)/.exec(evidence)?.[1] ?? ''
        const value = /세금계산서|다운로드/.test(msg) ? starts(q0.choices, '[C1]') : 'not_browser_task'
        return { ok: true, text: async () => JSON.stringify({ answers: [choice('browser_entry', value, 0.95)] }) }
      }
      if (q0.name === 'task_resume') {
        const msg = /User message: (.*)/.exec(evidence)?.[1] ?? ''
        const value = /취소/.test(msg) ? 'cancel_task' : /했어|두 번째/.test(msg) ? 'resume_task' : 'unrelated'
        return { ok: true, text: async () => JSON.stringify({ answers: [choice('task_resume', value, 0.95)] }) }
      }
      const url = /URL: (\S+)/.exec(evidence)?.[1]
      const p = answerNext({ url, evidence, choices: q0.choices })
      const nextAnswer = choice('next_step', p.next[0], p.next[1])
      if (p.next[0] === 'needs_user_context') nextAnswer.probabilities.push({ value: starts(q0.choices, '123-45'), probability: 0.05 }, { value: starts(q0.choices, '987-65'), probability: 0.04 })
      return { ok: true, text: async () => JSON.stringify({ answers: [nextAnswer,
        choice('page_state', p.pageState ?? 'content', 0.95), { name: 'goal_met', type: 'predicate', probability: p.goalMet ?? 0 }] }) }
    },
  })
  const transport = { runs: new Map(), hasClient: id => id === 'ui',
    bindRun: (id, thread, transportId) => transport.runs.set(id, { clientThreadId: thread, transportId, ownerKey: owner }),
    unbindRun: id => transport.runs.delete(id),
    async sendToUi(request) {
      uiKinds.push(request.kind)
      const reply = { requestId: request.requestId }
      if (request.kind === 'bind') return { ...reply, status: 'bound', binding: { cardId: 'card', cardEpoch: 'epoch', profileId: 'fixture', accountId: '', userContextId: 0, url: cur.url, engineAccountKey: owner, authorityEpoch: 1 } }
      if (request.kind === 'observe') {
        const wait = request.options?.wait
        return { ...reply, status: 'observed', snapshot: wait ? { ...snap(), wait: { for: wait.for, outcome: 'met', elapsedMs: 1 } } : snap() }
      }
      if (request.kind === 'act') {
        assert.equal(request.cardId, 'card')
        const a = request.action
        acts.push({ type: a.type, ref: a.ref ?? null, url: a.url ?? null, on: cur.url })
        if (a.type === 'fill') cur = { ...cur, revision: cur.revision + 1, values: { ...cur.values, [a.ref]: a.text } }
        if (a.type === 'navigate') cur = { url: a.url, documentId: `doc${++docSeq}`, revision: 1, values: {} }
        return { ...reply, status: 'acted', receipt: { after: snap(), observation: {},
          dispatchReceipt: { actor: 'JSWindowActor', eventDispatched: true, documentStillCurrent: true, inputRoute: a.type === 'fill' ? 'dom-value-setter' : 'chrome-load-uri' } } }
      }
      if (request.kind === 'cancel') return { ...reply, status: 'cancelled' }
      return { ...reply, status: 'rejected' }
    },
  }
  const provider = createCodexBrowserToolProvider({ transport, getOwnerKey: () => owner, decision: {
    mode: () => live, configured: () => true, client, recipient: () => decisionTopicRecipient(KEY, 1, undefined, client.model), generation: () => 0 } })
  provider.runtime = { emit: () => {} }
  const run = { answerId: 'answer', runId: 'run', clientThreadId: 'thread', status: 'inProgress', executionPolicy: { mode: 'browserBounded' } }
  const prepared = provider.prepare({ clientThreadId: 'thread', effectiveExecutionPolicy: 'browserBounded', browserTransportId: 'ui', selectedSources: [{
    id: 'source', kind: 'browser', selectedByUser: true, browserToolPermission: 'interact', browserToolSelection: { token: 'selection', threadId: 'thread' },
    browserToolIdentity: { cardEpoch: 'epoch', userContextId: 0, engineAccountKey: owner, authorityEpoch: 1 },
    sourceRef: { viewId: 'card', profileId: 'fixture', accountId: '', uri: start } }] })
  await provider.bindRun(run, prepared)
  const calibrationRaw = []
  const store = createBrowserTaskStore()
  const entry = createDirectBrowserEntry({ provider, store, calibration: { record: raw => calibrationRaw.push(raw) } })
  // The mock subjective engine: what Codex would receive in the same DM, and the sentence it would answer the user with.
  const engine = { turns: [], received: [], turn(input) {
    this.turns.push(input); this.received.push(input)
    const body = (() => { try { return JSON.parse(input).egdesk_browser_task } catch { return null } })()
    if (!body) return '(ordinary turn)'
    if (body.code === 'choice_needed') return '사업자가 둘입니다. 어느 쪽으로 받을까요?'
    if (body.code === 'two_factor_required') return '2단계 인증이 필요합니다. 직접 마친 뒤 알려주세요.'
    if (body.code === 'human_step') return '남은 단계는 직접 눌러야 하는 단계입니다.'
    if (body.status === 'done') return '내려받았습니다.'
    return '진행할 수 없습니다.'
  } }
  const say = async message => {
    const before = { decisions: decisions.length, acts: acts.length }
    const out = await entry.handle({ run, conversationKey: 'thread', message, hosts: { card: 'portal.example.test' } })
    const reply = out.handled ? engine.turn(out.note) : engine.turn(message)
    return { out, reply, decisions: decisions.length - before.decisions, acts: acts.length - before.acts }
  }
  const counts = () => ({ decisions: decisions.length, byQuestion: decisions.reduce((m, d) => (m[d.q] = (m[d.q] || 0) + 1, m), {}), images: decisions.filter(d => d.image).length,
    subjectiveTurns: engine.turns.length, fills: acts.filter(a => a.type === 'fill').length, navigations: acts.filter(a => a.type === 'navigate').length,
    clicks: acts.filter(a => !['fill', 'navigate'].includes(a.type)).length, submits: acts.filter(a => ['s1', 's2', 's3'].includes(a.ref)).length,
    dangerous: acts.filter(a => /purge|subscription/.test(a.url ?? '') || ['x1', 'c1', 'c2', 'x2'].includes(a.ref)).length })
  return { say, counts, acts, decisions, engine, store, calibrationRaw, human: next => { cur = { url: next, documentId: `doc${++docSeq}`, revision: 1, values: {} } }, setMode: m => { live = m }, cur: () => cur, uiKinds, entry, provider, run }
}

test('S1 tax invoices: two business numbers -> ask the user in the DM -> "두 번째 사업자로" -> resume -> download -> done', async t => {
  const w = await world(t, { start: `${O}/invoices` })
  const a = await w.say('거래처 포털에서 이번 달 세금계산서 내려받아줘')
  assert.equal(a.out.handled, true); assert.equal(a.out.status, 'paused')
  assert.equal(a.acts, 0, 'nothing is clicked before the user answers')
  assert.equal(a.reply, '사업자가 둘입니다. 어느 쪽으로 받을까요?')
  assert.deepEqual(a.decisions, 2) // entry + one objective step
  const mid = w.counts()
  const b = await w.say('두 번째 사업자로')
  assert.equal(b.out.resumed, true); assert.equal(b.out.status, 'done')
  assert.equal(b.reply, '내려받았습니다.')
  const end = w.counts()
  t.diagnostic(JSON.stringify({ afterAsk: mid, afterDone: end, acts: w.acts, received: w.engine.received }))
  assert.deepEqual(w.acts.map(x => [x.type, x.url]), [['navigate', `${O}/biz/2`], ['navigate', `${O}/download/2.pdf`]])
  assert.equal(end.submits + end.dangerous + end.clicks + end.fills + end.images, 0)
  assert.equal(end.subjectiveTurns, 2)
  assert.equal(end.byQuestion.browser_entry, 1); assert.equal(end.byQuestion.task_resume, 1)
  // exactly what the subjective model received: closed words, counts, at most three element labels
  const first = JSON.parse(w.engine.received[0]).egdesk_browser_task
  assert.deepEqual(Object.keys(first).sort(), ['actions', 'candidates', 'code', 'id', 'next', 'status', 'stepsDone'])
  assert.deepEqual([first.status, first.code, first.next], ['need_context', 'choice_needed', 'ask_user_in_chat'])
  assert.ok(first.candidates.length <= 3 && first.candidates.every(c => c.length <= 60))
  const second = JSON.parse(w.engine.received[1]).egdesk_browser_task
  assert.deepEqual([second.status, second.id, second.next], ['done', first.id, 'report_to_user'], 'same task id after the round trip')
  for (const text of w.engine.received) assert.doesNotMatch(text, /example\.test|https?:|\/biz|\/download|삭제|해지|제출/)
})

test('S2 2FA page: cannot proceed -> subjective model asks the user -> "했어" -> resume the same task', async t => {
  const w = await world(t, { start: `${O}/otp` })
  const a = await w.say('거래처 포털에서 세금계산서 내려받아줘')
  assert.deepEqual([a.out.status, a.acts], ['paused', 0])
  assert.equal(a.reply, '2단계 인증이 필요합니다. 직접 마친 뒤 알려주세요.')
  const note = JSON.parse(w.engine.received[0]).egdesk_browser_task
  assert.deepEqual([note.status, note.code], ['cannot_proceed', 'two_factor_required'])
  w.human(`${O}/single`) // the person finished 2FA in the card; the card now shows the invoices page
  const b = await w.say('했어')
  assert.equal(b.out.resumed, true); assert.equal(b.out.status, 'done')
  assert.deepEqual(w.acts.map(x => x.type), ['navigate', 'navigate'])
  assert.equal(w.counts().submits + w.counts().dangerous, 0)
  assert.equal(JSON.parse(w.engine.received[1]).egdesk_browser_task.id, note.id)
})

test('S3 only a dangerous link and a submit button remain: human_step, 0 actions', async t => {
  const w = await world(t, { start: `${O}/only-human` })
  const a = await w.say('거래처 포털에서 세금계산서 내려받아줘')
  const note = JSON.parse(w.engine.received[0]).egdesk_browser_task
  assert.deepEqual([a.out.status, note.status, note.code, a.acts], ['paused', 'cannot_proceed', 'human_step', 0])
  assert.equal(w.counts().submits + w.counts().dangerous + w.counts().clicks, 0)
})

test('S4 not a browser task: an ordinary subjective turn, 0 actions, 1 Decisions request', async t => {
  const w = await world(t, { start: `${O}/invoices` })
  const a = await w.say('오늘 날씨 어때?')
  assert.deepEqual([a.out.handled, a.out.reason, a.acts, a.decisions, a.reply], [false, 'not_browser', 0, 1, '(ordinary turn)'])
})

test('S5 mode off: nothing is called at all', async t => {
  const w = await world(t, { start: `${O}/invoices`, mode: 'off' })
  const a = await w.say('거래처 포털에서 세금계산서 내려받아줘')
  assert.deepEqual([a.out.handled, a.out.reason, a.decisions, a.acts], [false, 'mode_off', 0, 0])
})

test('S6 entry deadline: a hung endpoint falls back to the ordinary subjective turn in about 4 s with 0 actions', { timeout: 20000 }, async t => {
  const w = await world(t, { start: `${O}/invoices`, hang: true })
  const started = Date.now()
  const a = await w.say('거래처 포털에서 세금계산서 내려받아줘')
  assert.deepEqual([a.out.handled, a.out.reason, a.acts], [false, 'fallback:timeout', 0])
  assert.ok(Date.now() - started < 6000 && Date.now() - started >= 3500)
})

test('S7 cancel and unrelated replies do not resume; the task stays paused only for unrelated', async t => {
  const w = await world(t, { start: `${O}/invoices` })
  await w.say('거래처 포털에서 세금계산서 내려받아줘')
  const u = await w.say('점심 뭐 먹지')
  assert.deepEqual([u.out.handled, u.out.reason, u.acts], [false, 'unrelated', 0])
  assert.ok(w.store.paused('thread'))
  const c = await w.say('취소할래')
  assert.deepEqual([c.out.handled, c.out.reason], [false, 'task_cancelled'])
  assert.equal(w.store.paused('thread'), null)
})

test('S8 calibration records for the entry decision are content-free and pass the log whitelist', async t => {
  const w = await world(t, { start: `${O}/invoices` })
  await w.say('거래처 포털에서 세금계산서 내려받아줘')
  assert.equal(w.calibrationRaw.length, 1)
  const entry = normalizeEntry(w.calibrationRaw[0])
  assert.equal(entry.feature, 'browser_reflex'); assert.equal(entry.mode, 'on')
  assert.doesNotMatch(JSON.stringify(entry), /세금|portal|example/)
  assert.equal(entry.judgments[0].q, 'choice')
})

test('entry question rides on an existing request: options are code-enumerated cards plus two fixed options', () => {
  const cards = [{ cardId: 'a', host: 'one.example' }, { cardId: 'b', host: 'two.example' }]
  const q = entryQuestion(cards)
  assert.deepEqual(q.choices.map(c => c.value), ['[C1] one.example', '[C2] two.example', 'not_browser_task', 'ask_user'])
  const answers = { browser_entry: { type: 'choice', choice: '[C2] two.example', confidence: 0.9, probabilities: [{ value: '[C2] two.example', probability: 0.9 }, { value: '[C1] one.example', probability: 0.05 }] } }
  assert.deepEqual(readBrowserEntry(answers, cards).cardId, 'b')
  // an invalid or low-confidence entry never starts a task
  assert.equal(readBrowserEntry({ browser_entry: { type: 'choice', choice: '[C1] one.example', confidence: 0.5, probabilities: [{ value: '[C1] one.example', probability: 0.5 }] } }, cards).kind, 'uncertain')
  assert.equal(readBrowserEntry({ browser_entry: { type: 'refusal' } }, cards).kind, 'uncertain')
})

test('resume state: a value filled before the pause is never filled again after the user answers', async t => {
  const form = { url: 'https://x.example.test/form', documentId: 'd1', revision: 1 }
  const fields = (vals = {}) => [el('f1', 'textbox', '이름', { value: vals.f1 ?? '' }), el('f2', 'email', '이메일', { value: vals.f2 ?? '' })]
  const filled = {}, calls = []
  const callTool = async (name, args) => {
    calls.push({ name, ref: args.ref })
    if (name === 'egdesk_browser_observe') return { observationId: `o${calls.length}`, snapshot: { ...form, text: ['폼'], interactiveElements: fields(filled) } }
    if (name === 'egdesk_browser_fill') { filled[args.ref] = args.text; return { status: 'postcondition-observed' } }
    return { status: 'ok' }
  }
  let askUser = true
  const client = createDecisionClient({
    recipientForKey: (value, endpoint, model) => decisionTopicRecipient(value, 1, endpoint, model), getApiKey: async () => KEY,
    fetchImpl: async (_e, { body }) => {
      const wire = JSON.parse(body), q0 = wire.questions[0], ev = wire.input[1].content
      if (q0.name.startsWith('field_')) {
        return { ok: true, text: async () => JSON.stringify({ answers: wire.questions.map(q => { const k = /named "(.+?)"/.exec(q.instructions)[1]; return choice(q.name, q.choices.find(c => c.value.includes(k)).value, 0.95) }) }) }
      }
      const v = ev.includes('filled [F1]') ? (askUser ? 'needs_user_context' : '[F2] 이메일') : '[F1] 이름'
      const done = ev.includes('filled [F2]')
      return { ok: true, text: async () => JSON.stringify({ answers: [choice('next_step', done ? 'goal_met' : v === '[F2] 이메일' ? q0.choices.find(c => c.value.startsWith('[F2]')).value : v === '[F1] 이름' ? q0.choices.find(c => c.value.startsWith('[F1]')).value : v, 0.95),
        choice('page_state', 'content', 0.95), { name: 'goal_met', type: 'predicate', probability: done ? 0.95 : 0 }] }) }
    },
  })
  const values = { 이름: '합성이름', 이메일: 'synthetic@example.test' }
  const first = await runBrowserReflex({ cardId: 'c', goal: '양식 채우기', values, callTool, client, maxSteps: 4 })
  assert.equal(first.outcome, 'needs_user_context')
  assert.deepEqual(calls.filter(c => c.name === 'egdesk_browser_fill').map(c => c.ref), ['f1'])
  askUser = false
  const second = await runBrowserReflex({ cardId: 'c', goal: '양식 채우기', callTool, client, maxSteps: 4, resumeState: first.state, userContext: ['이메일도 넣어줘'] })
  assert.equal(second.outcome, 'done')
  assert.deepEqual(calls.filter(c => c.name === 'egdesk_browser_fill').map(c => c.ref), ['f1', 'f2'], 'f1 once, f2 once')
  // Contrast (the pre-C6 round trip: a fresh tool call with no task state): the same pending value is typed again.
  for (const k of Object.keys(filled)) delete filled[k]
  calls.length = 0; askUser = true
  const stateless = await runBrowserReflex({ cardId: 'c', goal: '양식 채우기', values, callTool, client, maxSteps: 4 })
  const again = await runBrowserReflex({ cardId: 'c', goal: '양식 채우기', values, callTool, client, maxSteps: 4 })
  assert.equal(stateless.outcome, 'needs_user_context'); assert.equal(again.outcome, 'needs_user_context')
  assert.equal(calls.filter(c => c.name === 'egdesk_browser_fill' && c.ref === 'f1').length, 2, 'without resumeState f1 is filled again on the same page')
})

test('subjectiveNote never carries a URL or free text; an unsafe detail is dropped', () => {
  const task = { taskId: 'bt_1', steps: 3, actions: { fill: 0, navigate: 1, scroll: 0 } }
  const text = subjectiveNote(task, { status: 'cannot_proceed', code: 'tool_failed', detail: 'see https://secret.example/x' })
  assert.doesNotMatch(text, /secret|https/)
  assert.match(subjectiveNote(task, { status: 'cannot_proceed', code: 'tool_failed', detail: 'BROWSER_OBSERVATION_STALE' }), /BROWSER_OBSERVATION_STALE/)
})
