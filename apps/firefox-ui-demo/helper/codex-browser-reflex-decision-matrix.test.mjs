import test from 'node:test'
import assert from 'node:assert/strict'
import { createCodexBrowserToolProvider } from './codex-browser-tool-provider.mjs'
import { createDecisionClient, decisionTopicRecipient } from './egdesk-decision-client.mjs'

// L8/C2 matrix: the real provider + Browser service + runBrowserReflex, with an
// in-process UI double and a mock Decisions endpoint. Every case counts what
// reached the UI (action requests by type), what the Decisions wire carried
// (images), and what the reasoning model is told. Synthetic only: no Firefox.
const url = 'https://example.test/shop'
const KEY = 'egd-synthetic-not-a-key-0008'
const labelOf = (wire, name) => wire.questions.find(q => q.name === name)?.choices ?? []
const find = (choices, prefix) => choices.find(c => c.value.startsWith(prefix))?.value

const ELEMENTS = [
  { ref: 'el_1', label: 'Pricing', role: 'link', tag: 'a', href: 'https://example.test/pricing', value: '' },
  { ref: 'el_2', label: 'Continue', role: 'button', tag: 'button', href: '', value: '' },
  { ref: 'el_3', label: 'Nickname', role: 'textbox', tag: 'input', href: '', value: '' },
  { ref: 'el_4', label: 'Submit order', role: 'button', tag: 'button', href: '', value: '' },
  { ref: 'el_5', label: 'Docs', role: 'link', tag: 'a', href: 'https://other.example/docs', value: '' },
]
const only = (...refs) => ELEMENTS.filter(el => refs.includes(el.ref))

function choiceAnswer(name, choice, confidence, rest = []) {
  return { name, type: 'choice', choice, confidence, probabilities: [{ value: choice, probability: confidence }, ...rest] }
}

async function run(t, { elements = ELEMENTS, next, nextAnswer, pageState = 'content', goalMet = 0, values, fetchBody, fetchThrows, uiAct, maxSteps = 1 }) {
  const owner = 'codex:fixture-owner'
  const dispatches = [], ui = [], acts = []
  const client = createDecisionClient({
    recipientForKey: (value, endpoint, model) => decisionTopicRecipient(value, 1, endpoint, model),
    getApiKey: async () => KEY,
    fetchImpl: async (_endpoint, { body }) => {
      const wire = JSON.parse(body)
      dispatches.push({ questions: wire.questions.map(q => q.name), image: /image/i.test(JSON.stringify(wire.input)) || /input_image/.test(body) })
      if (fetchThrows) throw fetchThrows
      if (fetchBody !== undefined) return { ok: true, text: async () => JSON.stringify(fetchBody) }
      const q0 = wire.questions[0].name
      if (q0.startsWith('field_')) {
        const field = find(wire.questions[0].choices, '[F1]')
        return { ok: true, text: async () => JSON.stringify({ answers: [choiceAnswer(q0, field, 0.95)] }) }
      }
      const choices = labelOf(wire, 'next_step')
      const answers = [
        nextAnswer ? nextAnswer(choices) : choiceAnswer('next_step', find(choices, next) ?? next, 0.97),
        choiceAnswer('page_state', pageState, 0.95),
        { name: 'goal_met', type: 'predicate', probability: goalMet },
      ]
      return { ok: true, text: async () => JSON.stringify({ answers }) }
    },
  })
  const snapshot = { cardId: 'card', documentId: 'doc', revision: 1, url, text: ['Synthetic shop page'],
    viewport: { width: 300, height: 200, devicePixelRatio: 1 }, interactiveElements: elements }
  let current = snapshot
  const transport = { runs: new Map(), hasClient: id => id === 'ui',
    bindRun: (id, thread, transportId) => transport.runs.set(id, { clientThreadId: thread, transportId, ownerKey: owner }),
    unbindRun: id => transport.runs.delete(id),
    async sendToUi(request) {
      ui.push(request.kind)
      const reply = { requestId: request.requestId }
      if (request.kind === 'bind') return { ...reply, status: 'bound', binding: { cardId: 'card', cardEpoch: 'epoch', profileId: 'fixture',
        accountId: '', userContextId: 0, url, engineAccountKey: owner, authorityEpoch: 1 } }
      if (request.kind === 'observe') return { ...reply, status: 'observed', snapshot: request.options?.wait ? { ...current, readyState: 'complete', wait: { for: request.options.wait.for, outcome: 'met', elapsedMs: 1 } } : current }
      if (request.kind === 'act') {
        acts.push({ type: request.action?.type, ref: request.action?.ref ?? null, url: request.action?.url ?? null })
        if (uiAct) return { ...reply, ...uiAct(request) }
        const target = request.action?.ref ? elements.find(el => el.ref === request.action.ref) : null
        const after = request.action?.type === 'fill' ? { ...snapshot, interactiveElements: elements.map(el => el.ref === target?.ref ? { ...el, value: request.action.text } : el) }
          : request.action?.type === 'navigate' ? { ...snapshot, url: request.action.url, documentId: 'doc2', revision: 2, interactiveElements: [] } : snapshot
        if (request.action?.type === 'navigate') current = after
        return { ...reply, status: 'acted', receipt: { after, observation: {},
          dispatchReceipt: { actor: 'JSWindowActor', eventDispatched: true, documentStillCurrent: true, inputRoute: 'dom-value-setter' } } }
      }
      if (request.kind === 'cancel') return { ...reply, status: 'cancelled' }
      return { ...reply, status: 'rejected' }
    },
  }
  const provider = createCodexBrowserToolProvider({ transport, getOwnerKey: () => owner, decision: {
    mode: () => 'on', configured: () => true, client, recipient: () => decisionTopicRecipient(KEY, 1, undefined, client.model), generation: () => 0 } })
  provider.runtime = { emit: () => {} }
  const runObj = { answerId: 'answer', runId: 'run', clientThreadId: 'thread', status: 'inProgress', executionPolicy: { mode: 'browserBounded' } }
  const prepared = provider.prepare({ clientThreadId: 'thread', effectiveExecutionPolicy: 'browserBounded', browserTransportId: 'ui', selectedSources: [{
    id: 'source', kind: 'browser', selectedByUser: true, browserToolPermission: 'interact', browserToolSelection: { token: 'selection', threadId: 'thread' },
    browserToolIdentity: { cardEpoch: 'epoch', userContextId: 0, engineAccountKey: owner, authorityEpoch: 1 },
    sourceRef: { viewId: 'card', profileId: 'fixture', accountId: '', uri: url },
  }] })
  await provider.bindRun(runObj, prepared)
  const response = await provider.dispatch(runObj, { tool: 'egdesk_browser_reflex', callId: 'matrix', arguments: {
    cardId: 'card', goal: 'Look at the pricing', maxSteps, ...(values ? { values } : {}) } })
  const result = JSON.parse(response.contentItems[0].text)
  const m = { requests: acts.length, clicks: acts.filter(a => /click|press/.test(a.type)).length, fills: acts.filter(a => a.type === 'fill').length,
    navigates: acts.filter(a => a.type === 'navigate').length, submits: acts.filter(a => /submit/.test(a.type) || a.ref === 'el_4').length,
    images: dispatches.filter(d => d.image).length, decisions: dispatches.length, outcome: result.outcome, reason: result.reason ?? null }
  t.diagnostic(JSON.stringify(m))
  return { m, result, acts, dispatches }
}

const expectZero = (r, extra = {}) => {
  assert.equal(r.m.requests, 0); assert.equal(r.m.clicks, 0); assert.equal(r.m.fills, 0); assert.equal(r.m.submits, 0); assert.equal(r.m.images, 0)
  for (const [k, v] of Object.entries(extra)) assert.equal(r.m[k], v, k)
}

test('confident same-site link: exactly one navigate, no click/fill/submit/image', async t => {
  const r = await run(t, { next: '[L1]' })
  assert.deepEqual(r.acts.map(a => a.type), ['navigate']); assert.equal(r.acts[0].url, 'https://example.test/pricing')
  assert.equal(r.m.clicks + r.m.fills + r.m.submits + r.m.images, 0)
})
test('(a) low confidence next_step: 0 action requests, escalated uncertain', async t => {
  const r = await run(t, { nextAnswer: c => choiceAnswer('next_step', find(c, '[L1]'), 0.4) })
  expectZero(r, { outcome: 'escalated', reason: 'uncertain' })
})
test('(a) near tie: 0 action requests', async t => {
  const r = await run(t, { nextAnswer: c => choiceAnswer('next_step', find(c, '[L1]'), 0.5, [{ value: find(c, '[B1]'), probability: 0.48 }]) })
  expectZero(r, { outcome: 'escalated', reason: 'uncertain' })
})
test('(a) exact tie at 0.5/0.5: 0 action requests', async t => {
  const r = await run(t, { nextAnswer: c => choiceAnswer('next_step', find(c, '[L1]'), 0.5, [{ value: find(c, '[B1]'), probability: 0.5 }]) })
  expectZero(r, { outcome: 'escalated', reason: 'uncertain' })
})
test('(a) high confidence but thin margin (0.8/0.7 inconsistent mass): 0 requests', async t => {
  const r = await run(t, { nextAnswer: c => choiceAnswer('next_step', find(c, '[L1]'), 0.8, [{ value: find(c, '[B1]'), probability: 0.7 }]) })
  expectZero(r, { outcome: 'escalated', reason: 'uncertain' })
})
test('(a) out-of-list choice (an unlisted "Delete account"): 0 action requests', async t => {
  const r = await run(t, { nextAnswer: () => choiceAnswer('next_step', 'Delete account', 0.99) })
  expectZero(r, { outcome: 'escalated', reason: 'uncertain' })
})
test('(a) abstain (refusal answer): 0 action requests', async t => {
  const r = await run(t, { nextAnswer: () => ({ name: 'next_step', type: 'refusal' }) })
  expectZero(r, { outcome: 'escalated', reason: 'uncertain' })
})
test('(a) invalid body (no answers array): fallback bad_response, 0 requests', async t => {
  const r = await run(t, { next: '[L1]', fetchBody: { nope: true } })
  expectZero(r, { outcome: 'fallback', reason: 'bad_response' })
})
test('(a) transport failure: fallback unreachable, 0 requests', async t => {
  const r = await run(t, { next: '[L1]', fetchThrows: new TypeError('connect ECONNREFUSED') })
  expectZero(r, { outcome: 'fallback', reason: 'unreachable' })
})
test('(b) confident press of "Continue": escalated press_needs_expected_effect, 0 clicks', async t => {
  const r = await run(t, { next: '[B1]' })
  expectZero(r, { outcome: 'escalated', reason: 'press_needs_expected_effect' })
  assert.equal(r.result.suggestion.option.startsWith('[B1]'), true)
})
test('(b) confident press of a gated "Submit order": not a candidate, 0 requests', async t => {
  const r = await run(t, { elements: only('el_4'), nextAnswer: () => choiceAnswer('next_step', '[B1] Submit order', 0.99) })
  expectZero(r)
})
test('(c) document replaced before navigate: UI reports not-dispatched, 0 input delivered', async t => {
  const r = await run(t, { next: '[L1]', uiAct: () => ({ status: 'rejected', dispatchPhase: 'not-dispatched', receipt: { dispatchReceipt: { eventDispatched: false, documentStillCurrent: false } }, timing: {} }) })
  assert.equal(r.acts.length, 1) // one request reached the UI, which refused it
  assert.equal(r.m.fills + r.m.clicks + r.m.submits, 0)
  assert.equal(r.m.navigates, 1)
})
test('(c) document replaced before fill: refused, no second fill, escalated tool_failed', async t => {
  const r = await run(t, { elements: only('el_3'), next: '[F1]', values: { nickname: 'synthetic-value' }, maxSteps: 3,
    uiAct: () => ({ status: 'rejected', dispatchPhase: 'not-dispatched', receipt: { dispatchReceipt: { eventDispatched: false, documentStillCurrent: false } }, timing: {} }) })
  assert.equal(r.acts.length, 1)
  assert.equal(r.m.outcome, 'escalated'); assert.equal(r.m.reason, 'tool_failed')
})
test('(d) same-site link whose href is a destructive/pay path is not auto-followed', async t => {
  for (const [label, href] of [['Continue', 'https://example.test/account/delete?id=7'], ['More', 'https://example.test/checkout/pay'], ['Here', 'https://example.test/orders/confirm-order']]) {
    const r = await run(t, { elements: [{ ref: 'el_9', label, role: 'link', tag: 'a', href, value: '' }], nextAnswer: c => choiceAnswer('next_step', c[0].value, 0.99) })
    assert.equal(r.m.requests, 0, `${label} -> ${href}`)
  }
})
test('(d) a plain same-site link whose path merely contains a benign word is still followed', async t => {
  const r = await run(t, { elements: [{ ref: 'el_9', label: 'Plans', role: 'link', tag: 'a', href: 'https://example.test/plans/team', value: '' }], nextAnswer: c => choiceAnswer('next_step', c[0].value, 0.99) })
  assert.equal(r.m.navigates, 1)
})
test('(d) fill of a field mapped confidently never submits', async t => {
  const r = await run(t, { elements: only('el_3', 'el_4'), next: '[F1]', values: { nickname: 'synthetic-value' } })
  assert.equal(r.m.fills, 1); assert.equal(r.m.submits, 0); assert.equal(r.m.clicks, 0)
  assert.ok(r.acts.every(a => a.ref !== 'el_4'))
})
test('(d) no matching field: reports needs_free_text/no match, 0 fills', async t => {
  const r = await run(t, { elements: only('el_1'), next: '[L1]', values: { nickname: 'synthetic-value' } })
  assert.equal(r.m.fills, 0)
})

// ---- L8 cycle 3 ----
const withField = (...els) => [ELEMENTS[2], ...els]
test('C3-1 next_step is a same-site link while a value is pending: no fill on the page being left', async t => {
  const r = await run(t, { elements: withField(ELEMENTS[0]), next: '[L1]', values: { nickname: 'synthetic-value' }, maxSteps: 1 })
  assert.deepEqual(r.acts.map(a => a.type), ['navigate'])
  assert.equal(r.m.fills, 0)
  assert.ok(!r.dispatches.some(d => d.questions[0].startsWith('field_')), 'no field-mapping Decisions request either')
})
test('C3-1 control: next_step is the field itself: still fills once', async t => {
  const r = await run(t, { elements: withField(ELEMENTS[0]), next: '[F1]', values: { nickname: 'synthetic-value' } })
  assert.deepEqual(r.acts.map(a => a.type), ['fill'])
})
test('C3-1 control: next_step is a same-page button (search button): value is still filled first', async t => {
  const r = await run(t, { elements: withField(ELEMENTS[1]), next: '[B1]', values: { nickname: 'synthetic-value' } })
  assert.deepEqual(r.acts.map(a => a.type), ['fill'])
})
const staleAct = () => ({ status: 'rejected', dispatchPhase: 'not-dispatched', receipt: { dispatchReceipt: { eventDispatched: false, documentStillCurrent: false } }, timing: {} })
test('C3-2 a rejected final step reaches the reasoning model as a public code, no page text', async t => {
  const r = await run(t, { next: '[L1]', uiAct: staleAct })
  assert.equal(r.result.outcome, 'max_steps')
  assert.equal(r.result.reason, 'step_rejected')
  assert.equal(r.result.code, 'BROWSER_OBSERVATION_STALE')
  assert.deepEqual(Object.keys(r.result).sort(), ['code', 'decisions', 'outcome', 'reason', 'steps'])
  assert.doesNotMatch(JSON.stringify(r.result), /example\.test|pricing|Synthetic shop/)
})
test('C3-2 a success after a rejection clears the code', async t => {
  const r = await run(t, { next: '[L1]' })
  assert.equal(r.result.outcome, 'max_steps'); assert.equal(r.result.reason, undefined); assert.equal(r.result.code, undefined)
})

// ---- L8 cycle 11: the c4 classifier vocabulary through the provider path on the merged code ----
test('C11 vocabulary: session end, account closure, ordering, permission grants, contract cancellation (labels and destinations) are never candidates and never acted on', async t => {
  const link = (ref, label, href) => ({ ref, label, role: 'link', tag: 'a', href: `https://example.test${href}`, value: '' })
  const button = (ref, label) => ({ ref, label, role: 'button', tag: 'button', href: '', value: '' })
  const vocabulary = [link('v1', '로그아웃', '/a'), link('v2', 'Log out', '/b'), link('v3', '회원 탈퇴', '/c'), link('v4', '계정 폐쇄', '/d'), button('v5', '주문하기'), button('v6', '주문 하기'),
    button('v7', '알림 허용'), button('v8', '위치 허용'), button('v9', '권한 부여'), link('v10', '계약 해지', '/e'), link('v11', '구독 취소', '/f'), button('v12', 'Close my account'),
    link('v13', '계속', '/logout'), link('v14', '다음', '/account/close'), link('v15', '더 보기', '/order/place'), link('v16', '설정', '/grant/allow'), link('v17', '보기', '/subscriptions/cancel'),
    link('v18', '확인하기', '/ko/로그아웃'), link('v19', '이동', '/permissions/allow'), link('v20', '열기', '/contract/terminate')]
  const safe = link('ok', 'Pricing', '/pricing')
  const { buildReflexCandidates } = await import('./egdesk-browser-reflex.mjs')
  const built = buildReflexCandidates({ url, revision: 1, interactiveElements: [...vocabulary, safe] })
  assert.deepEqual(built.options.map(o => o.item.element.ref), ['ok'], 'only the plain link is offered')
  assert.equal(built.excluded.gated, vocabulary.length)
  for (const element of vocabulary) {
    const guess = `[${element.role === 'link' ? 'L' : 'B'}1] ${element.label}`
    const r = await run(t, { elements: [element, safe], nextAnswer: () => choiceAnswer('next_step', guess, 0.99) })
    assert.equal(r.m.requests, 0, `${element.label} ${element.href}`)
    assert.equal(r.m.outcome, 'escalated')
  }
  // control: with the same page the plain link is still followed
  const ok = await run(t, { elements: [...vocabulary, safe], nextAnswer: c => choiceAnswer('next_step', c[0].value, 0.99) })
  assert.deepEqual(ok.acts.map(a => [a.type, a.url]), [['navigate', 'https://example.test/pricing']])
})
