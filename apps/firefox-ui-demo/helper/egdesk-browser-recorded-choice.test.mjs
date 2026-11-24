import test from 'node:test'
import assert from 'node:assert/strict'
import { runBrowserReflex, buildReflexCandidates } from './egdesk-browser-reflex.mjs'
import { MIN_IDENTIFIER_DIGITS, identifiersOf, recordedChoice, sameByCode } from './egdesk-browser-task-memory.mjs'

// L8 c16: the recorded choice is compared by code (R3). Real measurement 2026-11-25 (browser-live-v1): with the record as evidence the
// model picked the recorded business at 0.76 (top .79 / .05), one hundredth above the bar; on a page where it was gone it answered flat
// (next_step needs_user_context 0.26, top .21 / .22) and named no candidate. Synthetic pages and scripted clients; nothing is sent.
const O = 'https://portal.example.test'
const GOAL = '거래처 포털에서 이번 달 세금계산서 내려받아줘'
const el = (ref, role, label, extra = {}) => ({ ref, role, label, tag: role === 'link' ? 'a' : 'button', href: '', value: '', ...extra })
const biz = (ref, label, n) => el(ref, 'link', label, { href: `${O}/biz/${n}` })
const page = (elements, text = ['세금계산서 조회', '조회할 사업자를 선택하세요.'], path = '/invoices') => ({ cardId: 'card', documentId: 'doc1', revision: 1, url: `${O}${path}`, readyState: 'complete', text, interactiveElements: elements })
const prior = (chose = '사업자 987-65-43210', goal = GOAL) => ({ goal, host: 'portal.example.test', day: '2026-10-19', outcome: { status: 'done' },
  resolved: [{ asked: 'choice_needed', chose, at: '/invoices' }], trail: [{ op: 'open', label: chose, from: '/invoices', to: '/biz/2' }] })
const BASE = [biz('b1', '사업자 123-45-67890', 1), biz('b2', '사업자 987-65-43210', 2), el('h1', 'link', '도움말', { href: `${O}/help` }), el('x1', 'link', '구독 해지', { href: `${O}/subscription/cancel` })]

// One step of the product loop over one page; answers(request) scripts the Decisions reply; records each request's question names and text.
async function step(snapshot, { answers = defaults, priorRun = prior(), goal = GOAL, userContext = [] } = {}) {
  const sent = [], acts = []
  const client = { decide: async request => { sent.push({ names: request.questions.map(q => q.name), questions: request.questions, text: request.input.map(m => m.content).join('\n') }); return { answers: answers(request), usage: null, latencyMs: 1 } } }
  const callTool = async (name, args) => { if (name === 'egdesk_browser_observe') return { observationId: 'o1', snapshot }; acts.push({ name, url: args.url ?? null, ref: args.ref ?? null }); return { status: 'ok' } }
  const result = await runBrowserReflex({ cardId: 'card', goal, callTool, client, maxSteps: 1, priorRun, userContext })
  return { result, sent, acts, navigated: acts.filter(a => a.name === 'egdesk_browser_navigate').map(a => new URL(a.url).pathname) }
}
const ans = (pageState = 'content', goalMet = 0.02, same = []) => ({ ...pageStateAnswers(pageState, 0.98),
  goal_met: { type: 'predicate', probability: goalMet }, ...Object.fromEntries(same.map((p, i) => [`same_${i}`, { type: 'predicate', probability: p }])) })
const defaults = () => ans()
const modelPick = value => () => ({ ...ans(), next_step: { type: 'choice', choice: value, confidence: 0.95, probabilities: [{ value, probability: 0.95 }] } })

test('one match: code takes the recorded step with no "which" question; page state and goal are still asked; normalisation is NFKC, case and spacing only', async () => {
  const s = await step(page(BASE))
  assert.deepEqual(s.sent.map(r => r.names), [[...PS_NAMES, 'goal_met']])
  assert.deepEqual(s.navigated, ['/biz/2'])
  assert.doesNotMatch(s.sent[0].text, /Stored memory|History \(earlier run|987-65-43210"/, 'the code-decided request carries no record and no memory packet')
  // full-width digits and extra spaces are the same label; a different number is not
  const wide = await step(page([biz('b1', '사업자 123-45-67890', 1), biz('b2', '사업자  ９８７-６５-４３２１０', 2)]))
  assert.deepEqual(wide.navigated, ['/biz/2'])
  assert.equal(recordedChoice(prior(), page(BASE), buildReflexCandidates(page(BASE)).options, { goal: GOAL }).kind, 'one')
})

test('one match still passes the element and href guards: a recorded label that is now a person-only control or a dangerous href is not offered, so nothing is taken', async () => {
  // the same label now points at a delete address: the fail-closed href filter withholds it; the person is asked among what is offered
  const moved = await step(page([biz('b1', '사업자 123-45-67890', 1), el('b2', 'link', '사업자 987-65-43210', { href: `${O}/account/delete` })]))
  assert.deepEqual([moved.result.outcome, moved.acts.length], ['needs_user_context', 0])
  assert.deepEqual(moved.result.candidates, ['[L1] 사업자 123-45-67890'])
  // a record that names a submit button (never offered) does not make code press it
  const submit = await step(page([biz('b1', '사업자 123-45-67890', 1), el('s1', 'button', '발행 제출')]), { priorRun: prior('발행 제출') })
  assert.deepEqual([submit.result.outcome, submit.acts.length], ['needs_user_context', 0])
})

test('the page state and goal still rule the code-decided step: a person-only state hands over, a met goal is done, an undecided state asks the person', async () => {
  const hand = await step(page(BASE), { answers: () => ans('login_required') })
  assert.deepEqual([hand.result.outcome, hand.acts.length], ['handoff', 0])
  const done = await step(page(BASE), { answers: () => ans('content', 0.95) })
  assert.deepEqual([done.result.outcome, done.acts.length], ['done', 0])
  const unsure = await step(page(BASE), { answers: () => ({ ...ans(), ...pageStateAnswers('content', 0.5) }) })
  assert.deepEqual([unsure.result.outcome, unsure.acts.length], ['page_unclear', 0], 'undecided page state: the person looks, nothing is taken')
})

test('no match: code pauses with the page\'s candidates that look like the recorded one (the which comes from code); no which-question', async () => {
  const changed = page([biz('b1', '사업자 555-11-22222', 1), biz('b2', '사업자 444-33-55555', 2), el('h1', 'link', '도움말', { href: `${O}/help` })])
  const s = await step(changed)
  assert.deepEqual(s.sent.map(r => r.names), [[...PS_NAMES, 'goal_met']])
  assert.deepEqual([s.result.outcome, s.result.candidates, s.acts.length], ['needs_user_context', ['[L1] 사업자 555-11-22222', '[L2] 사업자 444-33-55555'], 0])
  // nothing alike on the page: every offered element is a candidate
  const other = await step(page([el('h1', 'link', '도움말', { href: `${O}/help` }), el('n1', 'link', '공지사항', { href: `${O}/notice` })]))
  assert.deepEqual(other.result.candidates, ['[L1] 도움말', '[L2] 공지사항'])
})

test('several matches: the person decides among them; nothing is taken', async () => {
  const twice = page([biz('b1', '사업자 987-65-43210', 1), biz('b2', '사업자 987-65-43210', 2), biz('b3', '사업자 123-45-67890', 3)])
  const s = await step(twice)
  assert.deepEqual([s.result.outcome, s.result.candidates, s.acts.length], ['needs_user_context', ['[L1] 사업자 987-65-43210', '[L2] 사업자 987-65-43210'], 0])
})

test('c17 renamed with the same registration number: a code match, no question (real c16: the same-thing predicate answered 0.75, undecided)', async () => {
  const renamed = page([biz('b1', '다라무역 (123-45-67890)', 1), biz('b2', '가나상사 (987-65-43210)', 2)])
  const s = await step(renamed)
  assert.deepEqual(s.sent.map(r => r.names), [[...PS_NAMES, 'goal_met']], 'no which-question and no same-thing predicate')
  assert.deepEqual(s.navigated, ['/biz/2'])
  const verdict = recordedChoice(prior(), renamed, buildReflexCandidates(renamed).options, { goal: GOAL })
  assert.deepEqual([verdict.kind, verdict.by, verdict.option.value], ['one', 'identifier', '[L2] 가나상사 (987-65-43210)'])
  // two candidates carrying the recorded number: the person decides which (never a code pick)
  const two = page([biz('b1', '가나상사 본점 987-65-43210', 1), biz('b2', '가나상사 지점 987-65-43210', 2)])
  const both = await step(two)
  assert.deepEqual([both.result.outcome, both.result.candidates, both.acts.length], ['needs_user_context', ['[L1] 가나상사 본점 987-65-43210', '[L2] 가나상사 지점 987-65-43210'], 0])
})

test('the same-thing predicate stays only for label pairs without identifiers on both sides: one predicate per candidate, quoted; exactly one decided yes is taken', async () => {
  // the recorded label carries no number; the page shows the business under a longer name
  const named = page([biz('b1', '다라무역 주식회사', 1), biz('b2', '가나상사 주식회사', 2)])
  const rec = prior('가나상사')
  const yes = await step(named, { priorRun: rec, answers: () => ans('content', 0.02, [0.95]) })
  assert.deepEqual(yes.sent.map(r => r.names), [[...PS_NAMES, 'goal_met', 'same_0']], 'only the candidate sharing a word is asked about')
  const q = yes.sent[0].questions.find(x => x.name === 'same_0')
  assert.match(q.instructions, /^Is this option, "가나상사 주식회사", the same thing as the recorded choice, "가나상사"\?$/)
  assert.deepEqual(yes.navigated, ['/biz/2'])
  for (const p of [0.75, 0.6, 0.2]) {
    const no = await step(named, { priorRun: rec, answers: () => ans('content', 0.02, [p]) })
    assert.deepEqual([no.result.outcome, no.result.candidates, no.acts.length], ['needs_user_context', ['[L2] 가나상사 주식회사'], 0], String(p))
  }
  // a masked number is not an identifier: the pair is asked, never matched by code
  const masked = page([biz('b1', '사업자 ***-**-43210', 1), biz('b2', '사업자 ***-**-67890', 2)])
  const m = await step(masked, { answers: () => ans('content', 0.02, [0.5, 0.5]) })
  assert.deepEqual([m.sent[0].names.filter(n => n.startsWith('same_')).length, m.acts.length], [2, 0])
})

// Over-matching, table form: [recorded, offered label, sameByCode]
const IDENTIFIER_TABLE = [
  ['사업자 987-65-43210', '가나상사 (987-65-43210)', 'same'],            // the real c16 case: renamed, same number
  ['사업자 987-65-43210', '가나상사 9876543210', 'same'],                // separators removed
  ['사업자 987-65-43210', '가나상사 987.65.43210', 'same'],
  ['사업자 987-65-43210', '사업자 987-65-43211', 'different'],          // shares a prefix, differs in the last digit
  ['사업자 987-65-43210', '사업자 987-65-4321', 'different'],           // a prefix of it (9 digits)
  ['사업자 987-65-43210', '사업자 1-987-65-43210', 'different'],         // contains it: compared whole, never as a part
  ['사업자 987-65-43210', '고객센터 010-9876-5432', 'different'],        // a phone number vs a registration number
  ['사업자 987-65-43210', '고객센터 1588-1234', 'different'],
  ['고객센터 1588-1234', '상담 1588-1234', 'same'],                      // the same phone number is the same thing
  ['사업자 987-65-43210', '사업자 ***-**-43210', 'unknown'],             // partial (masked) digits are not an identifier
  ['사업자 987-65-43210', '가나상사', 'unknown'],                        // one side has no number
  ['사업자 987 65 43210', '가나상사 (987-65-43210)', 'unknown'],         // spaces are not joints: 987 / 65 / 43210 is no identifier
  ['주문 1234567', '주문 1234567 (재발행)', 'unknown'],                   // 7 digits: below the identifier length
  ['청구서 2026-11-19', '청구서 2026-11-19 (재발행)', 'unknown'],         // a date is not an identifier
  ['청구서 20261119', '견적서 20261119', 'unknown'],
  ['계약 2026-1119-0042', '계약 2026-1119-0042 (변경)', 'same'],          // 12 digits shaped like no date: an identifier
  ['사업자 987-65-43210', '[L2] 사업자  987-65-43210', 'same'],          // the label itself, prefix and spacing aside
]
test('identifier table: sameByCode never over-matches (prefixes, parts, phone vs registration, masked digits, dates, spaces)', () => {
  for (const [recorded, label, want] of IDENTIFIER_TABLE) assert.equal(sameByCode(recorded, label), want, `${recorded} | ${label}`)
  assert.equal(MIN_IDENTIFIER_DIGITS, 8)
  assert.deepEqual(identifiersOf('2026-11-19 사업자 987-65-43210'), ['9876543210'], 'a date next to a number stays out')
})

test('exactly one candidate sharing the identifier, among others with different numbers and none: code takes it; a shared identifier on two: the person decides', () => {
  const opts = labels => buildReflexCandidates(page(labels.map((l, i) => biz(`b${i}`, l, i + 1)))).options
  const pick = labels => { const v = recordedChoice(prior(), page([]), opts(labels), { goal: GOAL }); return v && [v.kind, v.option?.value ?? v.candidates] }
  assert.deepEqual(pick(['다라무역 (123-45-67890)', '가나상사 (987-65-43210)', '도움말']), ['one', '[L2] 가나상사 (987-65-43210)'])
  assert.deepEqual(pick(['가나상사 (987-65-43210)', '가나상사 지점 (987-65-43210)']), ['several', ['[L1] 가나상사 (987-65-43210)', '[L2] 가나상사 지점 (987-65-43210)']])
  assert.deepEqual(pick(['사업자 987-65-43211', '사업자 123-45-67890']), ['none', ['[L1] 사업자 987-65-43211', '[L2] 사업자 123-45-67890']], 'near misses are different businesses: the person is asked which')
})
test('the current request overrides the record: a reply in this task, a request naming another element, or a different request that does not name the recorded one -> the step is asked as before', async () => {
  const ctx = await step(page(BASE), { userContext: ['첫 번째 사업자로'], answers: modelPick('[L1] 사업자 123-45-67890') })
  assert.deepEqual([ctx.sent[0].names[0], ctx.navigated], ['next_step', ['/biz/1']])
  const named = await step(page(BASE), { goal: '사업자 123-45-67890 세금계산서 내려받아줘', answers: modelPick('[L1] 사업자 123-45-67890') })
  assert.deepEqual([named.sent[0].names[0], named.navigated], ['next_step', ['/biz/1']])
  const reworded = await step(page(BASE), { goal: '이번엔 첫 번째 사업자 걸로 받아줘', answers: modelPick('[L1] 사업자 123-45-67890') })
  assert.deepEqual([reworded.sent[0].names[0], reworded.navigated], ['next_step', ['/biz/1']])
  assert.match(reworded.sent[0].text, /it is listed now as \[L2\] 사업자 987-65-43210/, 'the history is still evidence for the model')
  // a different request that names the recorded number is code's
  const sameNumber = await step(page(BASE), { goal: '987-65-43210 세금계산서 받아줘' })
  assert.deepEqual([sameNumber.sent[0].names, sameNumber.navigated], [[...PS_NAMES, 'goal_met'], ['/biz/2']])
})

test('after the person answers on a changed page, the reply decides (before c16 the gone choice forced a question on every pick)', async () => {
  const changed = page([biz('b1', '사업자 555-11-22222', 1), biz('b2', '사업자 444-33-55555', 2)])
  const s = await step(changed, { userContext: ['두 번째 거로'], answers: modelPick('[L2] 사업자 444-33-55555') })
  assert.deepEqual([s.sent[0].names[0], s.navigated], ['next_step', ['/biz/2']])
  assert.match(s.sent[0].text, /NOT listed now/)
  // without a reply the gone choice still never lets a confident pick act
  const none = await step(changed, { priorRun: prior('사업자 987-65-43210', '다른 요청'), goal: '이번엔 444-33-55555 걸로', answers: modelPick('[L1] 사업자 555-11-22222') })
  assert.deepEqual([none.result.outcome, none.acts.length], ['needs_user_context', 0])
})

test('the recorded choice applies once per path in a run, only on the path it was settled on', async () => {
  const elsewhere = await step(page(BASE, undefined, '/other'), { answers: modelPick('[L2] 사업자 987-65-43210') })
  assert.equal(elsewhere.sent[0].names[0], 'next_step')
})

// ---- c16 owner question (b): how often the person-state label would matter when the c15 rule stops without a request ----
import { census } from '../scripts/egdesk-browser-human-step-census.mjs'
import { createDecisionClient } from './egdesk-decision-client.mjs'
import { decideRecordedStep } from './egdesk-browser-reflex.mjs'
import { decisionThresholds } from './egdesk-decision-questions.mjs'
import { estimateTokens } from './egdesk-memory-real-plan.mjs'
import { PS_NAMES, pageStateAnswers, pageStateWire } from './egdesk-browser-page-state.fixture.mjs'
test('census (b): of 12 page shapes 9 stop by the rule (c17: the SSO-only sign-in page too); 4 of them (push 2FA x2, a check-box captcha, SSO-only sign-in) would have carried a person-state label; one page-state request (six predicates and the goal) costs ~1.2k tokens', async () => {
  const rows = census()
  assert.equal(rows.length, 12)
  assert.deepEqual(rows.filter(r => r.stops !== 'asked').map(r => r.id), ['2fa-push', '2fa-push-resend', 'login-sso-only', 'captcha', 'checkout-pay', 'subscription-cancel', 'permission-grant', 'form-submit-only', 'logout-only'])
  assert.deepEqual(rows.filter(r => r.labelLost).map(r => [r.id, r.labelLost]), [['2fa-push', 'two_factor_required'], ['2fa-push-resend', 'two_factor_required'], ['login-sso-only', 'login_required'], ['captcha', 'bot_check']])
  // the price of keeping the label: one page-state request on such a page (sized with the page-state + goal request of this module)
  let bytes = 0, questions = []
  const client = createDecisionClient({ getApiKey: async () => 'egd-synthetic-not-a-key-0008', fetchImpl: async (_u, init) => { bytes = Buffer.byteLength(init.body); questions = JSON.parse(init.body).questions; return { ok: true, text: async () => JSON.stringify({ answers: [] }) } } })
  const snapshot = page([el('b', 'button', '인증 확인')], ['2단계 인증', '휴대전화에서 승인하세요.'], '/otp-push')
  await decideRecordedStep({ goal: GOAL, snapshot, recorded: { kind: 'none', candidates: [] }, client, thresholds: decisionThresholds() }).catch(() => null)
  const predicates = questions.filter(q => q.type === 'predicate').length
  assert.equal(predicates, 7)
  const tokens = estimateTokens(questions.length - predicates, predicates, bytes)
  assert.ok(tokens > 1000 && tokens < 1400, `${bytes} bytes, ~${tokens} tokens`)
})

test('the general memory packet is step evidence only when no record was parsed from it (c16, R1: the record\'s facts arrive as History lines)', async () => {
  const PACKET = 'Stored page: 거래처 포털 메모 (synthetic)'
  const without = await step(page(BASE, undefined, '/other'), { priorRun: null, answers: modelPick('[L2] 사업자 987-65-43210') })
  assert.doesNotMatch(without.sent[0].text, /Stored memory/)
  const run = async priorRun => { const sent = []
    const client = { decide: async request => { sent.push(request.input.map(m => m.content).join('\n')); return { answers: { ...ans(), next_step: { type: 'choice', choice: 'blocked', confidence: 0.9, probabilities: [{ value: 'blocked', probability: 0.9 }] } }, usage: null, latencyMs: 1 } } }
    const callTool = async name => (name === 'egdesk_browser_observe' ? { observationId: 'o1', snapshot: page(BASE, undefined, '/other') } : { status: 'ok' })
    await runBrowserReflex({ cardId: 'card', goal: GOAL, callTool, client, maxSteps: 1, priorRun, memoryPacket: PACKET }); return sent[0] }
  assert.match(await run(null), /Stored memory fetched for this turn[^]*거래처 포털 메모/)
  const withRecord = await run(prior())
  assert.doesNotMatch(withRecord, /Stored memory|거래처 포털 메모/); assert.match(withRecord, /History \(earlier run of this task/)
})

test('c23: after the person changed the request the recorded choice is checked under the NEW goal: it is not the recorded request, so code does not take the record (the step is asked), unless the change itself names the recorded choice', async () => {
  const { createBrowserTaskStore } = await import('./egdesk-browser-task.mjs')
  const store = createBrowserTaskStore(), task = store.create({ conversationKey: 'dm', cardId: 'card', goal: GOAL })
  const options = buildReflexCandidates(page(BASE)).options
  assert.equal(recordedChoice(prior(), page(BASE), options, { goal: task.goal }).kind, 'one', 'the original request: code takes the recorded business')
  store.changeGoal('dm', '아 그거 말고 지난 달 걸로')
  assert.match(task.goal, /Update from the person while the task ran/)
  assert.equal(recordedChoice(prior(), page(BASE), options, { goal: task.goal }), null, 'a changed request is not the recorded one: the step is asked (History lines stay evidence)')
  store.changeGoal('dm', '987-65-43210 쪽으로')
  assert.equal(recordedChoice(prior(), page(BASE), options, { goal: task.goal }).kind, 'one', 'the change names the recorded business (its number): code takes it')
})
