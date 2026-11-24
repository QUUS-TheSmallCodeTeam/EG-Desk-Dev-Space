import test from 'node:test'
import assert from 'node:assert/strict'
import { createCodexBrowserToolProvider } from './codex-browser-tool-provider.mjs'
import { createDecisionClient, decisionTopicRecipient } from './egdesk-decision-client.mjs'
import { normalizeEntry } from './egdesk-decision-calibration-log.mjs'
import { runBrowserReflex } from './egdesk-browser-reflex.mjs'
import { createBrowserTaskStore, createDirectBrowserEntry } from './egdesk-browser-task.mjs'
import { createBrowserTaskHistory, safePath, HISTORY_FILE } from './egdesk-browser-task-history.mjs'
import { mkdtempSync, readFileSync, statSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

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

async function world(t, { start, mode = 'on', hang = false, history = null, owner = 'codex:fixture-owner', pages = null }) {
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
      decisions.push({ q: q0.name, body, image: /image/i.test(body), choices: q0.choices?.map(c => c.value) })
      if (hang) await new Promise((_, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true }))
      if (q0.name === 'browser_entry') {
        const msg = /User message: (.*)/.exec(evidence)?.[1] ?? ''
        const value = /세금계산서|다운로드/.test(msg) ? starts(q0.choices, '[C1]') : 'not_browser_task'
        return { ok: true, text: async () => JSON.stringify({ answers: [choice('browser_entry', value, 0.95)] }) }
      }
      if (q0.name === 'history_pick') {
        const lines = evidence.split('\n').filter(l => /^\[H\d+\]/.test(l))
        const hit = lines.findIndex(l => /세금계산서/.test(l))
        const value = hit >= 0 ? q0.choices[hit].value : 'no_prior_record'
        return { ok: true, text: async () => JSON.stringify({ answers: [choice('history_pick', value, 0.95)] }) }
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
  const entry = createDirectBrowserEntry({ provider, store, history, calibration: { record: raw => calibrationRaw.push(raw) } })
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
  const wire = []
  return { wire, say, counts, acts, decisions, engine, store, calibrationRaw, human: next => { cur = { url: next, documentId: `doc${++docSeq}`, revision: 1, values: {} } }, setMode: m => { live = m }, cur: () => cur, uiKinds, entry, provider, run }
}

const DAY = 86400000
const GOAL1 = '거래처 포털에서 이번 달 세금계산서 내려받아줘'
const GOAL2 = '거래처 포털에서 이번 달 세금계산서 내려받아줘 (다음 달)'
const clockStore = (clock, extra = {}) => createBrowserTaskHistory({ now: () => clock.t, ...extra })
const changedInvoices = () => ({ ...PAGES, [`${O}/invoices`]: [el('b1', 'link', '사업자 555-11-22222', { href: `${O}/biz/1` }), el('b2', 'link', '사업자 444-33-55555', { href: `${O}/biz/2` }),
  el('x1', 'link', '자료 삭제', { href: `${O}/purge` }), el('s1', 'button', '발행 제출')] })

test('H1 first run, no history: asks which business, stores a content-minimal record on completion', async t => {
  const clock = { t: Date.parse('2026-10-19T09:00:00Z') }, history = clockStore(clock)
  const w = await world(t, { start: `${O}/invoices`, history })
  const a = await w.say(GOAL1)
  assert.deepEqual([a.out.status, a.acts, a.decisions], ['paused', 0, 2], 'no candidates: no history request')
  assert.equal(history.size, 0, 'a question is not a record')
  const b = await w.say('두 번째 사업자로')
  assert.equal(b.out.status, 'done')
  assert.equal(history.size, 1)
  const [c] = history.candidates({ ownerKey: 'codex:fixture-owner', hosts: ['portal.example.test'] })
  assert.deepEqual([c.day, c.host, c.outcome.status], ['2026-10-19', 'portal.example.test', 'done'])
  const rec = history.fetch({ ownerKey: 'codex:fixture-owner', hosts: ['portal.example.test'], id: c.id })
  t.diagnostic(JSON.stringify(rec))
  assert.deepEqual(rec.trail.map(s => [s.label, s.from, s.to]), [['사업자 987-65-43210', '/invoices', '/biz/2'], ['이번 달 세금계산서 다운로드', '/biz/2', '/download/2.pdf']])
  assert.deepEqual(rec.resolved, [{ asked: 'choice_needed', chose: '사업자 987-65-43210', at: '/invoices' }])
  assert.doesNotMatch(JSON.stringify(rec), /두 번째|https?:|query|token/)
})

test('H2 next month, same task: history answers "which business", no question, 5 Decisions requests, 1 subjective turn', async t => {
  const clock = { t: Date.parse('2026-10-19T09:00:00Z') }, history = clockStore(clock)
  const first = await world(t, { start: `${O}/invoices`, history })
  await first.say(GOAL1); await first.say('두 번째 사업자로')
  clock.t += 31 * DAY
  const w = await world(t, { start: `${O}/invoices`, history })
  const a = await w.say(GOAL2)
  const end = w.counts()
  t.diagnostic(JSON.stringify({ counts: end, received: w.engine.received, acts: w.acts }))
  assert.equal(a.out.status, 'done'); assert.equal(a.out.resumed, undefined)
  assert.deepEqual(w.acts.map(x => [x.type, x.url]), [['navigate', `${O}/biz/2`], ['navigate', `${O}/download/2.pdf`]])
  assert.deepEqual(end.byQuestion, { browser_entry: 1, history_pick: 1, next_step: 3 })
  assert.equal(end.subjectiveTurns, 1); assert.equal(end.submits + end.dangerous + end.fills + end.clicks + end.images, 0)
  assert.equal(JSON.parse(w.engine.received[0]).egdesk_browser_task.status, 'done')
  // the Decision model read the record's content (labels), and the entry request carried the earlier request line
  assert.match(w.decisions.find(d => d.q === 'history_pick').body, /사업자 987-65-43210/)
  assert.match(w.decisions.find(d => d.q === 'browser_entry').body, /Earlier browser tasks on these cards/)
  assert.equal(history.size, 2, 'the second task is recorded too')
})

test('H3 page changed (the earlier choice is not listed): the loop asks the user even though the model picked confidently', async t => {
  const clock = { t: Date.parse('2026-10-19T09:00:00Z') }, history = clockStore(clock)
  const first = await world(t, { start: `${O}/invoices`, history })
  await first.say(GOAL1); await first.say('두 번째 사업자로')
  clock.t += 31 * DAY
  const w = await world(t, { start: `${O}/invoices`, history, pages: changedInvoices() })
  const a = await w.say(GOAL2)
  const note = JSON.parse(w.engine.received[0]).egdesk_browser_task
  assert.deepEqual([a.out.status, note.status, note.code, a.acts], ['paused', 'need_context', 'choice_needed', 0])
  assert.match(w.decisions.find(d => d.q === 'next_step').body, /NOT listed now/)
  assert.ok(note.candidates === undefined || note.candidates.length <= 3)
})

test('H4 unrelated history is ignored: no_prior_record, and the run asks like a first run', async t => {
  const clock = { t: Date.parse('2026-10-19T09:00:00Z') }, history = clockStore(clock)
  history.record({ ownerKey: 'codex:fixture-owner', id: 'bt_aaaaaaaaaaaa', host: 'portal.example.test', goal: '재고 목록 엑스포트', outcome: { status: 'done' },
    trail: [{ op: 'open', label: '재고', from: '/home', to: '/stock' }], resolved: [{ asked: 'choice_needed', chose: '창고 A', at: '/home' }], steps: 3 })
  const w = await world(t, { start: `${O}/invoices`, history })
  const a = await w.say(GOAL1)
  assert.deepEqual([a.out.status, w.counts().byQuestion.history_pick, a.acts], ['paused', 1, 0])
  assert.equal(JSON.parse(w.engine.received[0]).egdesk_browser_task.code, 'choice_needed')
})

test('H5 permission: other owner, other site and expired records are never enumerated, sent or fetched', async t => {
  const clock = { t: Date.parse('2026-10-19T09:00:00Z') }, history = clockStore(clock)
  const rec = (id, extra) => ({ ownerKey: 'codex:fixture-owner', id, host: 'portal.example.test', goal: GOAL1, outcome: { status: 'done' },
    trail: [{ op: 'open', label: '비밀라벨', from: '/a', to: '/b' }], resolved: [], steps: 2, ...extra })
  history.record(rec('bt_111111111111', { ownerKey: 'codex:someone-else' }))
  history.record(rec('bt_222222222222', { host: 'other.example.org' }))
  clock.t += 200 * DAY
  const hosts = ['portal.example.test']
  assert.deepEqual(history.candidates({ ownerKey: 'codex:fixture-owner', hosts }), [], 'nothing for this owner/site')
  clock.t -= 200 * DAY
  history.record(rec('bt_333333333333', {}))
  clock.t += 200 * DAY // expired now
  assert.deepEqual(history.candidates({ ownerKey: 'codex:fixture-owner', hosts }), [])
  assert.equal(history.fetch({ ownerKey: 'codex:fixture-owner', hosts, id: 'bt_333333333333' }), null)
  clock.t -= 200 * DAY
  assert.equal(history.fetch({ ownerKey: 'codex:other', hosts, id: 'bt_333333333333' }), null)
  assert.equal(history.fetch({ ownerKey: 'codex:fixture-owner', hosts: ['other.example.org'], id: 'bt_333333333333' }), null)
  assert.ok(history.fetch({ ownerKey: 'codex:fixture-owner', hosts, id: 'bt_333333333333' }))
  // end to end: only the permitted record's content reaches the wire
  const w = await world(t, { start: `${O}/invoices`, history })
  await w.say(GOAL1)
  const pick = w.decisions.find(d => d.q === 'history_pick')
  assert.ok(pick); assert.equal((pick.body.match(/\[H\d+\]/g) || []).length >= 1, true)
  assert.doesNotMatch(w.decisions.map(d => d.body).join('\n'), /someone-else|other\.example\.org|bt_111111111111|bt_222222222222/)
})

test('H6 mode off or no store: no history request; persisted file is private, whitelisted and survives a reopen', async t => {
  const off = await world(t, { start: `${O}/invoices`, mode: 'off', history: clockStore({ t: Date.now() }) })
  assert.deepEqual([(await off.say(GOAL1)).decisions], [0])
  const dir = mkdtempSync(path.join(tmpdir(), 'egdesk-bth-')); chmodSync(dir, 0o700)
  const clock = { t: Date.parse('2026-10-19T09:00:00Z') }
  const history = clockStore(clock, { dataDir: dir })
  history.record({ ownerKey: 'codex:fixture-owner', id: 'bt_444444444444', host: 'portal.example.test', goal: GOAL1, outcome: { status: 'done' },
    trail: [{ op: 'open', label: '다운로드', from: '/invoices?session=SECRETSESSION', to: '/download/9f8e7d6c5b4a39281716/file.pdf?token=SECRETTOKEN#frag' }],
    resolved: [], steps: 2, fillValue: 'SECRETVALUE', cookie: 'SECRETCOOKIE' })
  const text = readFileSync(path.join(dir, HISTORY_FILE), 'utf8')
  assert.doesNotMatch(text, /SECRET|9f8e7d6c5b4a39281716|frag/)
  assert.equal(statSync(path.join(dir, HISTORY_FILE)).mode & 0o077, 0)
  const again = clockStore(clock, { dataDir: dir })
  assert.equal(again.candidates({ ownerKey: 'codex:fixture-owner', hosts: ['portal.example.test'] }).length, 1)
  assert.equal(safePath('https://x.example/a/b?q=1#z'), '/a/b'); assert.equal(safePath('https://x.example/d/abcdef0123456789abcd'), '/d/*')
})

test('H7 a stuck run (2FA) is recorded as stuck with its closed code, and never shown as done', async t => {
  const clock = { t: Date.parse('2026-10-19T09:00:00Z') }, history = clockStore(clock)
  const w = await world(t, { start: `${O}/otp`, history })
  await w.say('거래처 포털에서 세금계산서 내려받아줘')
  // the page host is only known after an observation; the run observed /otp so the record exists
  const [c] = history.candidates({ ownerKey: 'codex:fixture-owner', hosts: ['portal.example.test'] })
  assert.deepEqual(c.outcome, { status: 'stuck', code: 'two_factor_required' })
})

test('H8 contrast (the c6 behaviour, no history store): next month the same question is asked again', async t => {
  const w = await world(t, { start: `${O}/invoices`, history: null })
  const a = await w.say(GOAL2)
  assert.deepEqual([a.out.status, JSON.parse(w.engine.received[0]).egdesk_browser_task.code, w.counts().byQuestion.history_pick ?? 0], ['paused', 'choice_needed', 0])
})
