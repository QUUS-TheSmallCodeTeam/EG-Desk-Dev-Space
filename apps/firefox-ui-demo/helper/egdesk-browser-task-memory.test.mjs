import test from 'node:test'
import assert from 'node:assert/strict'
import { createCodexBrowserToolProvider } from './codex-browser-tool-provider.mjs'
import { createDecisionClient, decisionTopicRecipient } from './egdesk-decision-client.mjs'
import { normalizeEntry } from './egdesk-decision-calibration-log.mjs'
import { runBrowserReflex } from './egdesk-browser-reflex.mjs'
import { createBrowserTaskStore, createDirectBrowserEntry } from './egdesk-browser-task.mjs'
import { createOutcomeToOntology, outcomeCandidate, parseOutcomeText, priorFromMemory, safePath } from './egdesk-browser-task-memory.mjs'
import { buildWiki } from './egdesk-wiki-reconstruction.mjs'
import { SYNTHETIC_PAGES, mockJudge } from './egdesk-wiki-reconstruction.fixture.mjs'
import { createWikiWriter, prepareTurnMemory } from './egdesk-turn-memory.mjs'
import { PS_NAMES, pageStateAnswers, pageStateProbabilities, pageStateWire } from './egdesk-browser-page-state.fixture.mjs'
import { entryAnswersOf, entryWire, isEntryQuestion } from './egdesk-browser-entry.fixture.mjs'

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

async function world(t, { start, mode = 'on', hang = false, memory = null, sink = null, clock = { t: Date.parse('2026-10-19T09:00:00Z') }, owner = 'codex:fixture-owner', pages = null }) {
  const P = pages || PAGES
  const decisions = [], acts = [], uiKinds = []
  let docSeq = 1
  let cur = { url: start, documentId: 'doc1', revision: 1, values: {} }
  let live = mode
  const snap = () => ({ cardId: 'card', documentId: cur.documentId, revision: cur.revision, url: cur.url, readyState: 'complete', text: ['합성 포털'],
    viewport: { width: 300, height: 200, devicePixelRatio: 1 }, interactiveElements: P[cur.url].map(e => ({ ...e, value: cur.values[e.ref] ?? e.value })) })
  const answerNext = ({ url, evidence, choices }) => {
    const ctx = /Context the user gave in the chat \(not page text\):\n([\s\S]*?)\n\n/.exec(evidence)?.[1] ?? ''
    const downloaded = /\/download\//.test(url)
    if (downloaded) return { next: ['goal_met', 0.9], goalMet: 0.95 }
    if (url.endsWith('/otp')) return { next: ['blocked', 0.9], pageState: 'two_factor_required' }
    if (url.endsWith('/invoices')) {
      const listed = /it is listed now as (\[L\d+\] [^\n]*?)\.\n|it is listed now as (\[L\d+\] [^\n]*)\./.exec(evidence)
      if (listed) return { next: [(listed[1] ?? listed[2]).trim(), 0.95] }
      if (/is NOT listed now/.test(evidence)) return { next: [choices.map(c => c.value).find(v => /^\[L1\]/.test(v)), 0.95] } // a confident pick the code must not honour
      return /두 번째/.test(ctx) ? { next: [starts(choices, '987-65'), 0.95] } : { next: ['needs_user_context', 0.9] }
    }
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
      const stepQ = wire.questions.find(q => q.name === 'next_step') ?? (q0.choices ? q0 : { choices: [] }) // c16: a code-decided step asks no next_step
      decisions.push({ q: q0.name, body, image: /image/i.test(body), choices: q0.choices?.map(c => c.value) })
      if (hang) await new Promise((_, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true }))
      if (q0.name === 'browser_entry') { // c20: the entry predicates
  const msg = /User message: (.*)/.exec(evidence)?.[1] ?? ''
        return { ok: true, text: async () => JSON.stringify({ answers: entryWire(wire.questions, { web: /세금계산서|다운로드/.test(msg) ? 0.95 : 0.05 }) }) }
      }
      if (q0.name === 'task_resume') {
        const msg = /User message: (.*)/.exec(evidence)?.[1] ?? ''
        const value = /취소/.test(msg) ? 'cancel_task' : /했어|두 번째/.test(msg) ? 'resume_task' : 'unrelated'
        return { ok: true, text: async () => JSON.stringify({ answers: [choice('task_resume', value, 0.95)] }) }
      }
      const url = /URL: (\S+)/.exec(evidence)?.[1]
      const p = answerNext({ url, evidence, choices: stepQ.choices })
      const nextAnswer = choice('next_step', p.next[0], p.next[1])
      if (p.next[0] === 'needs_user_context') nextAnswer.probabilities.push({ value: starts(stepQ.choices, '123-45'), probability: 0.05 }, { value: starts(stepQ.choices, '987-65'), probability: 0.04 })
      return { ok: true, text: async () => JSON.stringify({ answers: [nextAnswer,
        ...pageStateWire(p.pageState ?? 'content'), { name: 'goal_met', type: 'predicate', probability: p.goalMet ?? 0 }] }) }
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
  const entry = createDirectBrowserEntry({ provider, store, outcomeSink: sink, now: () => clock.t, calibration: { record: raw => calibrationRaw.push(raw) } })
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
    const out = await entry.handle({ run, conversationKey: 'thread', message, hosts: { card: 'portal.example.test' }, memory })
    const reply = out.handled ? engine.turn(out.note) : engine.turn(message)
    return { out, reply, decisions: decisions.length - before.decisions, acts: acts.length - before.acts }
  }
  const counts = () => ({ decisions: decisions.length, byQuestion: decisions.reduce((m, d) => (m[d.q] = (m[d.q] || 0) + 1, m), {}), images: decisions.filter(d => d.image).length,
    subjectiveTurns: engine.turns.length, fills: acts.filter(a => a.type === 'fill').length, navigations: acts.filter(a => a.type === 'navigate').length,
    clicks: acts.filter(a => !['fill', 'navigate'].includes(a.type)).length, submits: acts.filter(a => ['s1', 's2', 's3'].includes(a.ref)).length,
    dangerous: acts.filter(a => /purge|subscription/.test(a.url ?? '') || ['x1', 'c1', 'c2', 'x2'].includes(a.ref)).length })
  const wire = []
  return { wire, say, counts, acts, decisions, engine, store, calibrationRaw, human: next => { cur = { url: next, documentId: `doc${++docSeq}`, revision: 1, values: {} } }, setMode: m => { live = m }, cur: () => cur, uiKinds, entry, provider, run }
}

const SCOPE = { allowedScopes: ['dm:this-room'], writeScope: 'dm:this-room' }
const GOAL1 = '거래처 포털에서 이번 달 세금계산서 내려받아줘'
const FIRST = { kind: 'first', reason: 'no_native_thread' }
const changedInvoices = () => ({ ...PAGES, [`${O}/invoices`]: [el('b1', 'link', '사업자 555-11-22222', { href: `${O}/biz/1` }), el('b2', 'link', '사업자 444-33-55555', { href: `${O}/biz/2` }),
  el('x1', 'link', '자료 삭제', { href: `${O}/purge` }), el('s1', 'button', '발행 제출')] })

// The general feature: one wiki, one Decision stand-in for memory fetch and the per-turn write judgment (the lexical mock),
// one write path with its flag and permission. The browser task only consumes the packet and hands over the outcome.
function general({ enabled = true, pages = SYNTHETIC_PAGES, writeFlag = enabled } = {}) {
  const wiki = buildWiki(pages), log = []
  const judge = mockJudge(log)
  const writer = createWikiWriter(wiki, { enabled: writeFlag, canWrite: () => true })
  return { wiki, log, judge, writer,
    sink: createOutcomeToOntology({ wiki, client: judge, writer, scope: SCOPE, enabled, now: () => Date.parse('2026-10-19T09:00:00Z') }),
    async fetchMemory(message, askedAt) {
      const before = log.length
      const r = await prepareTurnMemory({ message, wiki, client: judge, scope: SCOPE, askedAt, position: FIRST, threadKey: 'native-1', ontologyWrite: false })
      return { packet: r.packet, pages: r.memory.picks.map(p => wiki.pages.get(p.id)).filter(Boolean), scope: SCOPE, calls: log.length - before } } }
}
const OCT = Date.parse('2026-10-19T09:00:00Z'), NOV = Date.parse('2026-11-19T09:00:00Z')
async function month1(t, g) {
  const w = await world(t, { start: `${O}/invoices`, sink: g.sink.write.bind(g.sink), clock: { t: OCT } })
  const a = await w.say(GOAL1)
  const b = await w.say('두 번째 사업자로')
  return { w, a, b }
}

test('M1 month 1: asks which business, then the outcome goes through the general write path (flag on) as an agent_note page', async t => {
  const g = general()
  const before = g.wiki.pages.size
  const { a, b } = await month1(t, g)
  assert.deepEqual([a.out.status, a.acts], ['paused', 0])
  assert.equal(a.out.memoryWrite, undefined, 'a question is not an outcome')
  assert.equal(b.out.status, 'done')
  assert.equal(b.out.memoryWrite.status, 'stored')
  assert.equal(g.wiki.pages.size, before + 1)
  const page = g.wiki.pages.get(b.out.memoryWrite.pageId)
  t.diagnostic(JSON.stringify({ id: page.id, provenance: page.provenance, time: page.time, status: page.status, body: page.body }))
  assert.match(page.id, /^browser-task\/bt_[0-9a-f]{12}$/)
  assert.deepEqual([page.provenance.kind, page.provenance.by], ['agent_note', 'browser_task'])
  assert.equal(page.time.slice, 'past'); assert.equal(page.status, 'done')
  assert.equal(page.scope, 'dm:this-room')
  const parsed = parseOutcomeText(page.body)
  assert.deepEqual(parsed.resolved, [{ asked: 'choice_needed', chose: '사업자 987-65-43210', at: '/invoices' }])
  assert.deepEqual(parsed.trail.map(s => [s.label, s.from, s.to]), [['사업자 987-65-43210', '/invoices', '/biz/2'], ['이번 달 세금계산서 다운로드', '/biz/2', '/download/2.pdf']])
  assert.doesNotMatch(page.body, /두 번째|https?:|\?|#|SECRET/, 'no user reply, URL or query in the page')
})

test('M2 flag off: the same task writes nothing and says so', async t => {
  const g = general({ enabled: false })
  const before = g.wiki.pages.size
  const { b } = await month1(t, g)
  assert.deepEqual([b.out.status, b.out.memoryWrite.status, g.wiki.pages.size], ['done', 'flag_off', before])
  const g2 = general({ enabled: true, writeFlag: false }) // the judge may run but the host write path is off
  const m2 = await month1(t, g2)
  assert.equal(m2.b.out.memoryWrite.status, 'disabled'); assert.equal(g2.wiki.pages.size, 33 - 1)
})

test('M3 month 2: the memory feature fetches the record, the browser loop does not ask, 4 task Decisions requests, 1 subjective turn', async t => {
  const g = general()
  await month1(t, g)
  const memory = await g.fetchMemory(GOAL1, NOV)
  t.diagnostic(JSON.stringify({ memoryCalls: memory.calls, picked: memory.pages.map(p => p.id) }))
  assert.ok(memory.pages.some(p => p.id.startsWith('browser-task/')), 'the general fetch picked the earlier outcome page')
  assert.match(memory.packet, /사업자 987-65-43210/)
  const w = await world(t, { start: `${O}/invoices`, sink: g.sink.write.bind(g.sink), memory, clock: { t: NOV } })
  const a = await w.say(GOAL1)
  const end = w.counts()
  t.diagnostic(JSON.stringify({ counts: end, acts: w.acts, received: w.engine.received, write: a.out.memoryWrite }))
  assert.equal(a.out.status, 'done'); assert.equal(a.out.resumed, undefined)
  assert.deepEqual(w.acts.map(x => [x.type, x.url]), [['navigate', `${O}/biz/2`], ['navigate', `${O}/download/2.pdf`]])
  // c16: the recorded choice is taken by code on /invoices; that request asks the page-state predicates and goal_met only (no "which" question)
  assert.deepEqual(end.byQuestion, { browser_entry: 1, ps_sign_in: 1, next_step: 2 }, 'no history request of its own')
  const recordedAsk = w.decisions.find(d => d.q === 'ps_sign_in')
  assert.deepEqual(JSON.parse(recordedAsk.body).questions.map(q => q.name), [...PS_NAMES, 'goal_met'])
  assert.equal(end.subjectiveTurns, 1); assert.equal(end.submits + end.dangerous + end.fills + end.clicks + end.images, 0)
  assert.equal(JSON.parse(w.engine.received[0]).egdesk_browser_task.status, 'done')
  // c15 (real result: the packet lowered the entry from 0.93 to 0.76): the fetched memory is step evidence only, never entry evidence
  // c16: with a record parsed from the fetched pages the steps get its facts as History lines; the general packet would repeat them
  for (const d of w.decisions) assert.doesNotMatch(d.body, /Stored memory fetched for this turn/)
  for (const d of w.decisions.filter(d => d.q === 'next_step')) assert.match(d.body, /History \(earlier run of this task/)
  assert.equal(a.out.memoryWrite.status, 'stored', 'the second outcome is written through the same path')
})

test('M4 page changed (the earlier choice is not listed): code asks the person which, listing the page\'s candidates; the model is not asked which', async t => {
  const g = general()
  await month1(t, g)
  const memory = await g.fetchMemory(GOAL1, NOV)
  const w = await world(t, { start: `${O}/invoices`, sink: g.sink.write.bind(g.sink), memory, pages: changedInvoices(), clock: { t: NOV } })
  const a = await w.say(GOAL1)
  const note = JSON.parse(w.engine.received[0]).egdesk_browser_task
  assert.deepEqual([a.out.status, note.status, note.code, a.acts], ['paused', 'need_context', 'choice_needed', 0])
  assert.deepEqual(note.candidates, ['사업자 555-11-22222', '사업자 444-33-55555'], 'the which comes from code: the businesses on the page now')
  assert.equal(w.decisions.filter(d => d.q === 'next_step').length, 0, 'no which-question to the model (the real answer here was flat: 0.21 / 0.22)')
})

test('M5 unrelated memory is ignored: other-site task page, a forged page, an unreadable-scope page and unrelated wiki pages never become facts', async t => {
  const g = general()
  const { b } = await month1(t, g)
  const real = g.wiki.pages.get(b.out.memoryWrite.pageId)
  const body = real.body
  const forged = { id: 'memo/forged', title: 'x', body, revision: '1', provenance: { kind: 'utterance', by: 'user' }, time: { slice: 'past' }, status: 'done', scope: 'dm:this-room' }
  const otherSite = { ...real, id: 'browser-task/bt_aaaaaaaaaaaa', body: body.replace('portal.example.test', 'other.example.org') }
  const hidden = { ...real, id: 'browser-task/bt_bbbbbbbbbbbb', scope: 'dm:someone-else' }
  const hosts = ['portal.example.test']
  assert.equal(priorFromMemory([forged], { scope: SCOPE, hosts }), null, 'wrong id and provenance')
  assert.equal(priorFromMemory([otherSite], { scope: SCOPE, hosts }), null, 'other site')
  assert.equal(priorFromMemory([hidden], { scope: SCOPE, hosts }), null, 'not readable in this scope')
  assert.ok(priorFromMemory([real], { scope: SCOPE, hosts }))
  // end to end: a fresh wiki with only unrelated pages: the fetch returns nothing and the run asks like a first run
  const g2 = general()
  const memory = await g2.fetchMemory(GOAL1, NOV)
  assert.equal(memory.pages.some(p => p.id.startsWith('browser-task/')), false)
  const w = await world(t, { start: `${O}/invoices`, memory, clock: { t: NOV } })
  const a = await w.say(GOAL1)
  assert.deepEqual([a.out.status, JSON.parse(w.engine.received[0]).egdesk_browser_task.code, a.acts], ['paused', 'choice_needed', 0])
})

test('M6 stuck outcome (2FA) is written with its closed code; the write path is idempotent per task', async t => {
  const g = general()
  const w = await world(t, { start: `${O}/otp`, sink: g.sink.write.bind(g.sink), clock: { t: OCT } })
  const a = await w.say('거래처 포털에서 세금계산서 내려받아줘')
  assert.equal(a.out.memoryWrite.status, 'stored')
  const page = g.wiki.pages.get(a.out.memoryWrite.pageId)
  assert.match(page.id, /-stuck$/)
  assert.deepEqual(parseOutcomeText(page.body).outcome, { status: 'stuck', code: 'two_factor_required' })
  // replaying the same candidate through the writer does not add a second page
  const again = g.writer.apply({ op: 'new_page', time: { slice: 'past' }, status: 'unknown', provenance: { kind: 'agent_note' }, links: [], spokenAt: null }, { message: page.body, scope: SCOPE, operationId: `browser-task:${page.id.slice(13)}` })
  assert.ok(['stored', 'conflict'].includes(again.status))
})

test('M7 content limits: secrets, queries, values and replies never reach the candidate', () => {
  const cand = outcomeCandidate({ taskId: 'bt_0123456789ab', goal: '내려받아줘', host: 'portal.example.test', now: OCT, outcome: { status: 'done' },
    trail: [{ op: 'open', label: '다운로드', from: '/invoices?session=SECRETSESSION', to: '/download/9f8e7d6c5b4a39281716/file.pdf?token=SECRETTOKEN#frag' }],
    resolved: [{ asked: 'choice_needed', chose: '사업자 987', at: '/invoices' }], fillValue: 'SECRETVALUE', cookie: 'SECRETCOOKIE', reply: 'SECRETREPLY' })
  assert.doesNotMatch(cand.text, /SECRET|9f8e7d6c5b4a39281716|frag|\?/)
  assert.ok(parseOutcomeText(cand.text))
  assert.equal(outcomeCandidate({ taskId: 'bad', goal: 'x', host: 'h.example', outcome: { status: 'done' } }), null)
  assert.equal(outcomeCandidate({ taskId: 'bt_0123456789ab', goal: 'x', host: 'h.example', outcome: { status: 'stuck', code: 'free text' } }), null)
  assert.equal(safePath('https://x.example/a/b?q=1#z'), '/a/b'); assert.equal(safePath('https://x.example/d/abcdef0123456789abcd'), '/d/*')
})

test('M8 contrast (c6, no memory handed in): next month the same question is asked again', async t => {
  const w = await world(t, { start: `${O}/invoices`, clock: { t: NOV } })
  const a = await w.say(GOAL1)
  assert.deepEqual([a.out.status, JSON.parse(w.engine.received[0]).egdesk_browser_task.code], ['paused', 'choice_needed'])
})

test('M3b c16: the choice code took from the record is written again, so month 3 still does not ask (month 2 used to write no choice line)', async t => {
  const g = general()
  await month1(t, g)
  const m2memory = await g.fetchMemory(GOAL1, NOV)
  const w2 = await world(t, { start: `${O}/invoices`, sink: g.sink.write.bind(g.sink), memory: m2memory, clock: { t: NOV } })
  const b = await w2.say(GOAL1)
  assert.equal(b.out.memoryWrite.status, 'stored')
  const page2 = g.wiki.pages.get(b.out.memoryWrite.pageId)
  assert.deepEqual(parseOutcomeText(page2.body).resolved, [{ asked: 'choice_needed', chose: '사업자 987-65-43210', at: '/invoices' }])
  const DEC = Date.parse('2026-12-19T09:00:00Z')
  const m3memory = await g.fetchMemory(GOAL1, DEC)
  const w3 = await world(t, { start: `${O}/invoices`, sink: g.sink.write.bind(g.sink), memory: m3memory, clock: { t: DEC } })
  const c = await w3.say(GOAL1)
  assert.deepEqual([c.out.status, w3.acts.map(x => x.url)], ['done', [`${O}/biz/2`, `${O}/download/2.pdf`]])
  assert.equal(w3.decisions.filter(d => d.q === 'next_step' && /\/invoices\n/.test(d.body)).length, 0, 'no which-question in month 3 either')
})

// ---- L7 c17: a task outcome is a system result, written by a code rule ----
test('a Browser task outcome is stored as an agent_note page by code: no Decision request, done -> done, stuck -> unknown, time past, no links', async () => {
  const wiki = buildWiki(SYNTHETIC_PAGES), writer = createWikiWriter(wiki, { enabled: true, canWrite: ({ op }) => op === 'new_page' })
  let asked = 0
  const client = { async decide() { asked++; return { answers: {} } } }
  const sink = createOutcomeToOntology({ wiki, client, writer, scope: SCOPE, enabled: true, now: () => Date.parse('2026-10-19T09:00:00Z') })
  const done = outcomeCandidate({ taskId: 'bt_0123456789ab', goal: '이번 달 세금계산서 내려받기', host: 'portal.example.test', now: Date.parse('2026-10-19T09:00:00Z'), outcome: { status: 'done' } })
  const out = await sink.write(done)
  assert.deepEqual([out.status, out.pageId, asked], ['stored', 'browser-task/bt_0123456789ab', 0])
  const page = wiki.pages.get(out.pageId)
  assert.deepEqual([page.provenance.kind, page.provenance.by, page.status, page.time.slice, page.body, wiki.links(page.id)], ['agent_note', 'browser_task', 'done', 'past', done.text, []])
  const stuck = outcomeCandidate({ taskId: 'bt_aaaaaaaaaaaa', goal: '이번 달 세금계산서 내려받기', host: 'portal.example.test', now: Date.parse('2026-10-19T09:00:00Z'), outcome: { status: 'stuck', code: 'two_factor_required' } })
  const out2 = await sink.write(stuck)
  assert.deepEqual([out2.status, wiki.pages.get(out2.pageId).status], ['stored', 'unknown'])
  assert.equal((await sink.write(done)).replay, undefined) // same operation id: the writer's own idempotency answers
  // off, no writer, or a run whose models may not see Browser data: nothing is stored
  assert.equal((await createOutcomeToOntology({ wiki, writer, enabled: false }).write(done)).status, 'flag_off')
  assert.equal((await createOutcomeToOntology({ wiki, writer: null, enabled: true }).write(done)).status, 'unavailable')
  assert.equal((await createOutcomeToOntology({ wiki, writer, enabled: true, egress: { allows: kind => kind !== 'browser_task_record' } }).write(done)).reason, 'egress')
})
