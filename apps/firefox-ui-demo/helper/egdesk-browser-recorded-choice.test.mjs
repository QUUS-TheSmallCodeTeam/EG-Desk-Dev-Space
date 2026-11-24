import test from 'node:test'
import assert from 'node:assert/strict'
import { runBrowserReflex, buildReflexCandidates } from './egdesk-browser-reflex.mjs'
import { identifiersOf, recordedChoice } from './egdesk-browser-task-memory.mjs'

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
const ans = (pageState = 'content', goalMet = 0.02, same = []) => ({ page_state: { type: 'choice', choice: pageState, confidence: 0.98, probabilities: [{ value: pageState, probability: 0.98 }] },
  goal_met: { type: 'predicate', probability: goalMet }, ...Object.fromEntries(same.map((p, i) => [`same_${i}`, { type: 'predicate', probability: p }])) })
const defaults = () => ans()
const modelPick = value => () => ({ ...ans(), next_step: { type: 'choice', choice: value, confidence: 0.95, probabilities: [{ value, probability: 0.95 }] } })

test('one match: code takes the recorded step with no "which" question; page state and goal are still asked; normalisation is NFKC, case and spacing only', async () => {
  const s = await step(page(BASE))
  assert.deepEqual(s.sent.map(r => r.names), [['page_state', 'goal_met']])
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

test('the page state and goal still rule the code-decided step: a person-only state hands over, a met goal is done, an undecided state does not act', async () => {
  const hand = await step(page(BASE), { answers: () => ans('login_required') })
  assert.deepEqual([hand.result.outcome, hand.acts.length], ['handoff', 0])
  const done = await step(page(BASE), { answers: () => ans('content', 0.95) })
  assert.deepEqual([done.result.outcome, done.acts.length], ['done', 0])
  const unsure = await step(page(BASE), { answers: () => ({ ...ans(), page_state: { type: 'choice', choice: 'content', confidence: 0.5, probabilities: [{ value: 'content', probability: 0.55 }, { value: 'error_page', probability: 0.4 }] } }) })
  assert.deepEqual([unsure.result.outcome, unsure.result.reason, unsure.acts.length], ['escalated', 'uncertain', 0])
})

test('no match: code pauses with the page\'s candidates that look like the recorded one (the which comes from code); no which-question', async () => {
  const changed = page([biz('b1', '사업자 555-11-22222', 1), biz('b2', '사업자 444-33-55555', 2), el('h1', 'link', '도움말', { href: `${O}/help` })])
  const s = await step(changed)
  assert.deepEqual(s.sent.map(r => r.names), [['page_state', 'goal_met']])
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

test('renamed with the same number: one predicate per candidate, quoting only that option and the recorded choice; exactly one decided yes is taken', async () => {
  const renamed = page([biz('b1', '다라무역 (123-45-67890)', 1), biz('b2', '가나상사 (987-65-43210)', 2)])
  const yes = await step(renamed, { answers: () => ans('content', 0.02, [0.95]) })
  assert.deepEqual(yes.sent.map(r => r.names), [['page_state', 'goal_met', 'same_0']], 'only the candidate carrying the recorded number is asked about')
  const q = yes.sent[0].questions.find(x => x.name === 'same_0')
  assert.equal(q.type, 'predicate')
  assert.match(q.instructions, /^Is this option, "가나상사 \(987-65-43210\)", the same thing as the recorded choice, "사업자 987-65-43210"\?$/)
  assert.doesNotMatch(q.instructions, /다라무역/, 'one option per predicate')
  assert.deepEqual(yes.navigated, ['/biz/2'])
  for (const p of [0.6, 0.2, 0.05]) {
    const no = await step(renamed, { answers: () => ans('content', 0.02, [p]) })
    assert.deepEqual([no.result.outcome, no.result.candidates, no.acts.length], ['needs_user_context', ['[L2] 가나상사 (987-65-43210)'], 0], String(p))
  }
  // two candidates carry the number: both asked; one yes and one decided no -> taken; two yes or one undecided -> ask
  const two = page([biz('b1', '가나상사 본점 987-65-43210', 1), biz('b2', '가나상사 지점 987-65-43210', 2)])
  assert.deepEqual((await step(two, { answers: () => ans('content', 0.02, [0.1, 0.93]) })).navigated, ['/biz/2'])
  assert.equal((await step(two, { answers: () => ans('content', 0.02, [0.9, 0.93]) })).acts.length, 0)
  assert.equal((await step(two, { answers: () => ans('content', 0.02, [0.5, 0.93]) })).acts.length, 0)
  assert.deepEqual(identifiersOf('사업자 987-65-43210'), ['9876543210']); assert.deepEqual(identifiersOf('2026년 11월'), [])
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
  assert.deepEqual([sameNumber.sent[0].names, sameNumber.navigated], [['page_state', 'goal_met'], ['/biz/2']])
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
