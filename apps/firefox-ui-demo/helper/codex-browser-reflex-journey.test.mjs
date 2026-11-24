import test from 'node:test'
import assert from 'node:assert/strict'
import { createCodexBrowserToolProvider } from './codex-browser-tool-provider.mjs'
import { createDecisionClient, decisionTopicRecipient } from './egdesk-decision-client.mjs'

// L8/C5 journey: one multi-step task through the real provider + Browser service +
// runBrowserReflex, a stateful two-page UI double, and a mock Decisions endpoint.
// Page 1: a form needing two received values and a "다음" link. Page 2: a review list
// with a dangerous-looking link (구독 해지), a submit button and a memo field.
// Synthetic only: no Firefox, no network.
const KEY = 'egd-synthetic-not-a-key-0008'
const O = 'https://example.test'
const el = (ref, role, label, extra = {}) => ({ ref, role, label, tag: role === 'link' ? 'a' : role === 'button' ? 'button' : 'input', href: '', value: '', ...extra })
const PAGES = {
  [`${O}/form`]: [el('f1', 'textbox', '이름'), el('f2', 'email', '이메일'), el('l1', 'link', '다음', { href: `${O}/review` })],
  [`${O}/review/1`]: [el('b1', 'link', '목록', { href: `${O}/review` })],
  [`${O}/review`]: [el('c1', 'link', '구독 해지', { href: `${O}/subscription/cancel` }), el('d1', 'link', '상세 보기', { href: `${O}/review/1` }),
    el('s1', 'button', '제출'), el('m1', 'textbox', '메모')],
}
const choice = (name, value, confidence, rest = []) => ({ name, type: 'choice', choice: value, confidence, probabilities: [{ value, probability: confidence }, ...rest] })
const starts = (choices, prefix) => choices.find(c => c.value.startsWith(prefix))?.value

// policy(ctx) -> { next?: [prefix, confidence], pageState?, goalMet? }; ctx = { url, step, choices }
async function journey(t, { policy, values = { 이름: '합성이름', 이메일: 'synthetic@example.test' }, staleNavigateOnce = false, staleFillOnce = false,
  latency = () => 0, maxSteps = 6, calls = 1, popupAtStep = null }) {
  const owner = 'codex:fixture-owner'
  const log = [], decisions = []
  let step = 0, navStale = staleNavigateOnce, fillStale = staleFillOnce, docSeq = 1, coldAgain = true
  let cur = { url: `${O}/form`, documentId: 'doc1', revision: 1, values: {} }
  const snap = () => ({ cardId: 'card', documentId: cur.documentId, revision: cur.revision, url: cur.url, readyState: 'complete',
    text: [popupAtStep === step ? '쿠키 안내 팝업이 열렸습니다' : '합성 페이지'], viewport: { width: 300, height: 200, devicePixelRatio: 1 },
    interactiveElements: PAGES[cur.url].map(e => ({ ...e, value: cur.values[e.ref] ?? e.value })) })
  const client = createDecisionClient({
    recipientForKey: (value, endpoint, model) => decisionTopicRecipient(value, 1, endpoint, model),
    getApiKey: async () => KEY,
    fetchImpl: async (_endpoint, { body, signal }) => {
      const wire = JSON.parse(body)
      const evidence = wire.input[1].content
      const url = /URL: (\S+)/.exec(evidence)?.[1]
      decisions.push({ step, q: wire.questions[0].name, image: /image/i.test(body) })
      const ms = latency({ cold: coldAgain, step })
      if (ms > 0) {
        const done = await new Promise(resolve => { const timer = setTimeout(() => resolve(true), ms); signal.addEventListener('abort', () => { clearTimeout(timer); resolve(false) }, { once: true }) })
        if (!done) { coldAgain = true; throw Object.assign(new Error('aborted'), { name: 'AbortError' }) }
      }
      coldAgain = false
      const q0 = wire.questions[0]
      if (q0.name.startsWith('field_')) {
        const answers = wire.questions.map(q => {
          const key = /named "(.+?)"/.exec(q.instructions)?.[1]
          const hit = q.choices.find(c => c.value.includes(key) && c.value.startsWith('[F'))
          return hit ? choice(q.name, hit.value, 0.95) : choice(q.name, 'no matching field', 0.95)
        })
        return { ok: true, text: async () => JSON.stringify({ answers }) }
      }
      const choices = q0.choices
      const p = policy({ url, step, choices, evidence })
      const [prefix, confidence] = p.next
      const next = starts(choices, prefix) ?? prefix
      const rest = p.runnerUp ? [{ value: starts(choices, p.runnerUp[0]), probability: p.runnerUp[1] }] : []
      return { ok: true, text: async () => JSON.stringify({ answers: [choice('next_step', next, confidence, rest),
        choice('page_state', p.pageState ?? 'content', 0.95), { name: 'goal_met', type: 'predicate', probability: p.goalMet ?? 0 }] }) }
    },
  })
  const transport = { runs: new Map(), hasClient: id => id === 'ui',
    bindRun: (id, thread, transportId) => transport.runs.set(id, { clientThreadId: thread, transportId, ownerKey: owner }),
    unbindRun: id => transport.runs.delete(id),
    async sendToUi(request) {
      const reply = { requestId: request.requestId }
      if (request.kind === 'bind') return { ...reply, status: 'bound', binding: { cardId: 'card', cardEpoch: 'epoch', profileId: 'fixture', accountId: '', userContextId: 0, url: cur.url, engineAccountKey: owner, authorityEpoch: 1 } }
      if (request.kind === 'observe') {
        const wait = request.options?.wait
        if (!wait) step++
        return { ...reply, status: 'observed', snapshot: wait ? { ...snap(), wait: { for: wait.for, outcome: 'met', elapsedMs: 1 } } : snap() }
      }
      if (request.kind === 'act') {
        assert.equal(request.cardId, 'card', 'a popup or other card never receives a request')
        const a = request.action
        log.push({ step, type: a.type, ref: a.ref ?? null, url: a.url ?? null, on: cur.url })
        const stale = (a.type === 'navigate' && navStale && (navStale = false, true)) || (a.type === 'fill' && fillStale && (fillStale = false, true))
        if (stale) { // the document was replaced between decision and action: the live page is a fresh copy
          cur = { url: cur.url, documentId: `doc${++docSeq}`, revision: 1, values: {} }
          return { ...reply, status: 'rejected', dispatchPhase: 'not-dispatched', receipt: { dispatchReceipt: { eventDispatched: false, documentStillCurrent: false } }, timing: {} }
        }
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
    mode: () => 'on', configured: () => true, client, recipient: () => decisionTopicRecipient(KEY, 1, undefined, client.model), generation: () => 0 } })
  provider.runtime = { emit: () => {} }
  const run = { answerId: 'answer', runId: 'run', clientThreadId: 'thread', status: 'inProgress', executionPolicy: { mode: 'browserBounded' } }
  const prepared = provider.prepare({ clientThreadId: 'thread', effectiveExecutionPolicy: 'browserBounded', browserTransportId: 'ui', selectedSources: [{
    id: 'source', kind: 'browser', selectedByUser: true, browserToolPermission: 'interact', browserToolSelection: { token: 'selection', threadId: 'thread' },
    browserToolIdentity: { cardEpoch: 'epoch', userContextId: 0, engineAccountKey: owner, authorityEpoch: 1 },
    sourceRef: { viewId: 'card', profileId: 'fixture', accountId: '', uri: `${O}/form` } }] })
  await provider.bindRun(run, prepared)
  const results = []
  for (let i = 0; i < calls; i++) {
    const response = await provider.dispatch(run, { tool: 'egdesk_browser_reflex', callId: `journey-${i}`, arguments: { cardId: 'card', goal: '양식을 채우고 다음 페이지에서 검토',
      maxSteps, ...(Object.keys(values).length ? { values } : {}) } })
    results.push({ handoff: JSON.parse(response.contentItems[0].text).outcome === 'handoff', ...JSON.parse(response.contentItems[0].text) })
  }
  const perStep = {}
  const row = n => perStep[n] ??= { decisions: 0, images: 0, fills: 0, navigations: 0, clicks: 0, submits: 0 }
  for (const d of decisions) { row(d.step).decisions++; if (d.image) row(d.step).images++ }
  for (const a of log) { const r = row(a.step); if (a.type === 'fill') r.fills++; else if (a.type === 'navigate') r.navigations++; else r.clicks++; if (a.ref === 's1') r.submits++ }
  const totals = { decisions: decisions.length, images: decisions.filter(d => d.image).length, fills: log.filter(a => a.type === 'fill').length,
    navigations: log.filter(a => a.type === 'navigate').length, clicks: log.filter(a => !['fill', 'navigate'].includes(a.type)).length,
    submits: log.filter(a => a.ref === 's1').length, cancelNavigations: log.filter(a => /subscription\/cancel/.test(a.url ?? '')).length,
    handoffs: results.filter(r => r.handoff).length, finalUrl: cur.url }
  t.diagnostic(JSON.stringify({ totals, perStep, results: results.map(({ handoff, ...r }) => r), acts: log }))
  return { totals, perStep, results, log, cur: () => cur }
}

const confident = ({ url, step }) => {
  if (url.endsWith('/form')) return { next: [step === 1 ? '[F1]' : step === 2 ? '[F2]' : '[L1]', 0.97] }
  return { next: ['[L1]', 0.9], pageState: 'content' }
}
const filledOnForm = ({ url, evidence }) => {
  if (url.endsWith('/form')) return { next: [evidence.includes('filled [F2]') ? '[L1]' : evidence.includes('filled [F1]') ? '[F2]' : '[F1]', 0.97] }
  return { next: ['blocked', 0.9] }
}

test('J1 happy path: both values fill only on the form, 다음 navigates once after a stale refusal, 구독 해지 never followed, submit never sent', async t => {
  const j = await journey(t, { policy: filledOnForm, staleNavigateOnce: true, maxSteps: 8 })
  assert.deepEqual(j.log.filter(a => a.type === 'fill').map(a => [a.ref, a.on]), [['f1', `${O}/form`], ['f2', `${O}/form`]])
  assert.equal(j.totals.fills, 2)
  assert.equal(j.log.filter(a => a.type === 'navigate' && a.url === `${O}/review`).length, 2, 'stale refusal then one accepted navigate')
  assert.equal(j.totals.cancelNavigations, 0)
  assert.equal(j.totals.submits, 0); assert.equal(j.totals.clicks, 0); assert.equal(j.totals.images, 0)
  assert.equal(j.cur().url, `${O}/review`)
  assert.ok(j.log.filter(a => a.on.endsWith('/review')).length === 0, 'nothing is acted on the review page')
  assert.equal(j.results[0].outcome, 'escalated'); assert.equal(j.results[0].reason, 'blocked')
})
test('J2 popup/modal page_state mid-way: 0 actions that step, escalated with a public reason, no request reaches another card', async t => {
  const j = await journey(t, { policy: ctx => ctx.step === 3 ? { next: ['[L1]', 0.97], pageState: 'modal_blocking' } : filledOnForm(ctx), popupAtStep: 3, maxSteps: 8 })
  assert.equal(j.totals.fills, 2); assert.equal(j.totals.navigations, 0)
  assert.equal(j.results[0].outcome, 'escalated'); assert.equal(j.results[0].reason, 'modal_blocking')
})
test('J3 sensitive_flow on the review page: handoff to the human, no submit, no cancel navigation', async t => {
  const j = await journey(t, { policy: ctx => ctx.url.endsWith('/review') ? { next: ['blocked', 0.9], pageState: 'sensitive_flow' } : filledOnForm(ctx), maxSteps: 8 })
  assert.equal(j.totals.handoffs, 1); assert.equal(j.results[0].outcome, 'handoff')
  assert.equal(j.totals.submits, 0); assert.equal(j.totals.cancelNavigations, 0)
})
test('J4 low confidence on the second field: stops with uncertain after exactly 1 fill', async t => {
  const j = await journey(t, { policy: ctx => /filled \[F1\]/.test(ctx.evidence) && !/filled \[F2\]/.test(ctx.evidence) && ctx.step <= 2 ? { next: ['[F2]', 0.4] } : filledOnForm(ctx), maxSteps: 4, calls: 1 })
  assert.equal(j.totals.fills, 1)
  assert.equal(j.results[0].outcome, 'escalated'); assert.equal(j.results[0].reason, 'uncertain')
})
test('J5 document replaced before the first fill: refused, nothing else sent, public code reaches the model', async t => {
  const j = await journey(t, { policy: filledOnForm, staleFillOnce: true, maxSteps: 4 })
  assert.equal(j.log.filter(a => a.type === 'fill').length, 1)
  assert.equal(j.totals.navigations, 0); assert.equal(j.totals.submits, 0)
  assert.equal(j.results[0].outcome, 'escalated'); assert.equal(j.results[0].reason, 'tool_failed'); assert.equal(j.results[0].code, 'BROWSER_OBSERVATION_STALE')
})
test('J6 only dangerous/submit elements and a confident out-of-list pick: never acted on', async t => {
  const j = await journey(t, { values: {}, policy: ctx => ctx.url.endsWith('/review') ? { next: ['[B1] 제출', 0.99] } : { next: ['[L1]', 0.97] }, maxSteps: 4 })
  assert.equal(j.totals.submits, 0); assert.equal(j.totals.cancelNavigations, 0); assert.equal(j.totals.clicks, 0)
})
test('J7 value for a page-1 field is not typed on page 2 (no matching field there)', async t => {
  const j = await journey(t, { policy: ctx => ctx.url.endsWith('/form') ? { next: ['[L1]', 0.97] } : { next: ['[L1]', 0.9] }, maxSteps: 4 })
  // The link is decided on page 1 while both values are pending: nothing is typed on the page being left; page 2 maps to no field.
  assert.equal(j.log.filter(a => a.type === 'fill' && a.on.endsWith('/review')).length, 0)
  assert.equal(j.totals.cancelNavigations, 0)
})
test('J8 cold connection (2.0 s cold, 0.4 s warm): the first decision of a run gets the cold-tolerant deadline and the run proceeds', { timeout: 30000 }, async t => {
  const j = await journey(t, { policy: filledOnForm, latency: ({ cold }) => (cold ? 2000 : 400), maxSteps: 4 })
  assert.equal(j.totals.fills, 2)
  assert.notEqual(j.results[0].outcome, 'fallback')
})
test('J8b a hung endpoint: falls back cleanly (fallback/timeout, 0 actions) after the 4 s first-decision deadline', { timeout: 30000 }, async t => {
  const started = Date.now()
  const j = await journey(t, { policy: filledOnForm, latency: () => 60000, maxSteps: 4 })
  assert.equal(j.totals.fills + j.totals.navigations + j.totals.clicks + j.totals.submits, 0)
  assert.deepEqual([j.results[0].outcome, j.results[0].reason], ['fallback', 'timeout'])
  assert.equal(j.totals.decisions, 1)
  assert.ok(Date.now() - started < 6000)
})
test('J9 warm connection: deadline is not hit', { timeout: 30000 }, async t => {
  const j = await journey(t, { policy: filledOnForm, latency: () => 300, maxSteps: 4 })
  assert.equal(j.totals.fills, 2)
})
