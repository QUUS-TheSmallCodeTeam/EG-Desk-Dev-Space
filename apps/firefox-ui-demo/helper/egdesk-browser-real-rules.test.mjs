import test from 'node:test'
import assert from 'node:assert/strict'
import { createDecisionClient } from './egdesk-decision-client.mjs'
import { runBrowserReflex } from './egdesk-browser-reflex.mjs'
import { createBrowserTaskStore, createDirectBrowserEntry, decideResume, readBrowserEntry } from './egdesk-browser-task.mjs'
import { decisionThresholds } from './egdesk-decision-questions.mjs'

// L8 c15: code rules taken from the first REAL Decision results on the browser task (Main's run of plan browser-task-v1, 2026-11-25,
// 12/12 hard expectations held). Every answer below is the real answer replayed: value, confidence and the top-two probabilities as
// measured. Synthetic pages, scripted clients; nothing is sent.
const KEY = 'egd-synthetic-not-a-key-0008'
const el = (ref, role, label, extra = {}) => ({ ref, role, label, tag: role === 'link' ? 'a' : role === 'button' ? 'button' : 'input', href: '', value: '', ...extra })
const O = 'https://portal.example.test'
const page = (path, text, elements) => ({ cardId: 'card', documentId: `doc:${path}`, revision: 1, url: `${O}${path}`, readyState: 'complete', text, interactiveElements: elements })
const OTP = page('/otp', ['2단계 인증', '휴대전화로 받은 6자리 숫자를 입력하면 계속할 수 있습니다.'], [el('o1', 'textbox', '인증번호'), el('o2', 'button', '인증 확인')])
const PUSH = page('/otp-push', ['2단계 인증', '휴대전화에서 승인하세요.'], [el('o2', 'button', '인증 확인')])
const SUBSCRIPTION = page('/subscription', ['구독 관리', '현재 이용 중인 요금제는 기본 요금제입니다.'], [el('s1', 'link', '구독 해지', { href: `${O}/subscription/cancel` }), el('s2', 'button', '제출')])
const HOME = page('/home', ['거래처 포털'], [el('h1', 'link', '세금계산서 조회', { href: `${O}/invoices` })])
const choice = (name, value, confidence, rows) => ({ name, type: 'choice', choice: value, confidence, probabilities: rows.map(([v, p]) => ({ value: v, probability: p })) })

function scripted(reply) {
  const sent = []
  const client = createDecisionClient({ getApiKey: async () => KEY, fetchImpl: async (_e, { body }) => { const wire = JSON.parse(body); sent.push(wire); return { ok: true, text: async () => JSON.stringify({ answers: reply(wire) }) } } })
  return { client, sent }
}
async function step(snapshot, answers) {
  const { client, sent } = scripted(answers)
  const tools = []
  const callTool = async name => { tools.push(name); if (name === 'egdesk_browser_observe') return { observationId: 'o1', snapshot }; return { status: 'ok' } }
  const result = await runBrowserReflex({ cardId: 'card', goal: '거래처 포털에서 이번 달 세금계산서 내려받아줘', callTool, client, maxSteps: 1 })
  return { result, sent, actions: tools.filter(name => name !== 'egdesk_browser_observe') }
}

test('R5 page state: a decided two_factor_required hands over whatever next_step says (real: page_state 1.0, next_step needs_user_context 0.31)', async () => {
  const real = () => [choice('next_step', 'needs_user_context', 0.31, [['needs_user_context', 0.45], ['blocked', 0.40]]),
    choice('page_state', 'two_factor_required', 1.0, [['two_factor_required', 1.0]]), { name: 'goal_met', type: 'predicate', probability: 0.01 }]
  const { result, sent, actions } = await step(OTP, real)
  assert.deepEqual([result.outcome, result.pageState, sent.length, actions], ['handoff', 'two_factor_required', 1, []])
  // the same hand-over for the other person-only page states, and even if the model confidently picks an element
  for (const state of ['login_required', 'bot_check', 'sensitive_flow']) {
    const picked = await step(HOME, () => [choice('next_step', '[L1] 세금계산서 조회', 0.99, [['[L1] 세금계산서 조회', 0.99]]), choice('page_state', state, 0.95, [[state, 0.95]]), { name: 'goal_met', type: 'predicate', probability: 0 }])
    assert.deepEqual([picked.result.outcome, picked.result.pageState, picked.actions], ['handoff', state, []], state)
  }
  // an undecided page state never acts either
  const unsure = await step(HOME, () => [choice('next_step', '[L1] 세금계산서 조회', 0.99, [['[L1] 세금계산서 조회', 0.99]]), choice('page_state', 'two_factor_required', 0.5, [['two_factor_required', 0.6], ['content', 0.3]]), { name: 'goal_met', type: 'predicate', probability: 0 }])
  assert.deepEqual([unsure.result.outcome, unsure.result.reason, unsure.actions], ['escalated', 'uncertain', []])
})

test('R3 no element offered and person-only controls withheld: code stops with human_step and asks nothing (real, when asked: scroll_more 0.30, top 0.44 / 0.36)', async () => {
  let asked = 0
  const { result, sent, actions } = await step(SUBSCRIPTION, () => { asked++; return [choice('next_step', 'scroll_more', 0.30, [['scroll_more', 0.44], ['blocked', 0.36]])] })
  assert.deepEqual([result.outcome, result.reason, result.withheld, sent.length, asked, actions], ['escalated', 'human_step', 2, 0, 0, []])
  // Trade-off, recorded: a second-factor page that shows ONLY a confirm button (push approval) now stops the same way, as human_step and
  // without its page state. With its code field (the page measured for real) it is still asked, and keeps two_factor_required.
  const push = await step(PUSH, () => { throw new Error('must not be asked') })
  assert.deepEqual([push.result.outcome, push.result.reason, push.sent.length], ['escalated', 'human_step', 0])
  const withField = await step(OTP, () => [choice('next_step', 'blocked', 0.9, [['blocked', 0.9]]), choice('page_state', 'two_factor_required', 1, [['two_factor_required', 1]]), { name: 'goal_met', type: 'predicate', probability: 0 }])
  assert.deepEqual([withField.sent.length, withField.result.pageState], [1, 'two_factor_required'])
})

test('R3 the task reports the person-only stop as human_step, with no question to the person and no outcome other than stuck', async () => {
  const store = createBrowserTaskStore()
  const runDirectTask = async () => ({ outcome: 'escalated', reason: 'human_step', withheld: 2, steps: [{ url: `${O}/subscription`, actions: [], excluded: { gated: 2, sensitive: 0 } }], state: null })
  const written = []
  const client = { decide: async request => ({ answers: { browser_entry: { type: 'choice', choice: request.questions[0].choices[0].value, confidence: 0.93, probabilities: [{ value: request.questions[0].choices[0].value, probability: 0.95 }] } } }) }
  const entry = createDirectBrowserEntry({ store, outcomeSink: candidate => { written.push(candidate); return { status: 'stored' } },
    provider: { directEntryEnabled: () => true, reflexScope: () => ({ client, authorizeDispatch: () => true, isDecisionCurrent: () => true }), runDirectTask } })
  const out = await entry.handle({ run: { runId: 'r', browserBinding: { cards: [{ cardId: 'card', permission: 'interact' }] } }, conversationKey: 'dm', message: '구독 관리 화면 열어줘', hosts: { card: 'portal.example.test' } })
  const note = JSON.parse(out.note).egdesk_browser_task
  assert.deepEqual([note.status, note.code, note.candidates], ['cannot_proceed', 'human_step', undefined])
  assert.deepEqual(written.map(c => c.outcome), [{ status: 'stuck', code: 'human_step' }])
})

// ---- the entry bar, against the real entry answers ----
const cards1 = [{ cardId: 'card', host: 'portal.example.test' }], cards2 = [...cards1, { cardId: 'card2', host: 'mail.example.test' }]
const C1 = '[C1] portal.example.test'
const answer = (value, confidence, rows) => ({ browser_entry: choice('browser_entry', value, confidence, rows) })
test('entry bar 0.75 / margin 0.2, kept: the real decided answers enter, the real undecided one does not', () => {
  const t = decisionThresholds()
  assert.deepEqual([t.choice, t.margin], [0.75, 0.2], 'the product bar is unchanged')
  assert.equal(readBrowserEntry(answer(C1, 0.93, [[C1, 0.95], ['ask_user', 0.03]]), cards1).kind, 'browser', 'entry-task, real 0.93')
  assert.equal(readBrowserEntry(answer('not_browser_task', 1.0, [['not_browser_task', 1.0]]), cards1).kind, 'not_browser', 'entry-not-browser, real 1.0')
  const two = readBrowserEntry(answer('ask_user', 0.51, [['ask_user', 0.63], [C1, 0.20]]), cards2)
  assert.deepEqual([two.kind, two.top], ['uncertain', 'ask_user'], 'entry-two-cards, real 0.51 (top 0.63 / 0.20): not decided')
  // entry-with-prior: real 0.76 with the memory packet in the entry evidence; the packet is no longer entry evidence (see the report)
  assert.equal(readBrowserEntry(answer(C1, 0.76, [[C1, 0.82], ['ask_user', 0.10]]), cards1).kind, 'browser')
  assert.equal(readBrowserEntry(answer(C1, 0.74, [[C1, 0.82], ['ask_user', 0.10]]), cards1).kind, 'uncertain', 'one hundredth below the bar does not enter')
})

function entryWorld({ answers }) {
  const store = createBrowserTaskStore(), sent = [], runs = []
  let i = 0
  const client = { decide: async request => { sent.push(request); return { answers: answers[i++](request), usage: null } } }
  const runDirectTask = async (_run, args) => { runs.push({ cardId: args.cardId, context: args.userContext }); return { outcome: 'done', steps: [{ url: `${O}/download`, actions: [] }], state: null } }
  const entry = createDirectBrowserEntry({ store, provider: { directEntryEnabled: () => true, reflexScope: () => ({ client, authorizeDispatch: () => true, isDecisionCurrent: () => true }), runDirectTask } })
  const run = { runId: 'r', browserBinding: { cards: [{ cardId: 'card', permission: 'interact' }, { cardId: 'card2', permission: 'interact' }] } }
  const say = message => entry.handle({ run, conversationKey: 'dm', message, hosts: { card: 'portal.example.test', card2: 'mail.example.test' } })
  return { store, sent, runs, say }
}
const real051 = () => ({ browser_entry: { type: 'choice', choice: 'ask_user', confidence: 0.51, probabilities: [{ value: 'ask_user', probability: 0.63 }, { value: C1, probability: 0.20 }] } })

test('undecided entry with two cards asks the person which card (closed note, nothing touched); the answer starts the task on that card with the original goal', async () => {
  const w = entryWorld({ answers: [real051,
    () => ({ task_resume: { type: 'choice', choice: 'resume_task', confidence: 0.99, probabilities: [{ value: 'resume_task', probability: 0.99 }] } }),
    () => ({ browser_entry: { type: 'choice', choice: C1, confidence: 0.95, probabilities: [{ value: C1, probability: 0.96 }] } })] })
  const asked = await w.say('거기서 이번 달 명세서 내려받아줘')
  const note = JSON.parse(asked.note).egdesk_browser_task
  assert.deepEqual([asked.handled, asked.status, note.status, note.code, note.candidates, w.runs.length], [true, 'paused', 'need_context', 'card_choice_needed', ['portal.example.test', 'mail.example.test'], 0])
  w.store.noteQuestion(w.store.paused('dm'), '어느 카드에서 받을까요? 거래처 포털인가요, 메일인가요?')
  const out = await w.say('거래처 포털 쪽')
  assert.deepEqual([out.status, out.resumed, w.runs.map(r => r.cardId)], ['done', true, ['card']])
  // the second entry request judges the ORIGINAL request with the answer, and the resume request carries the question
  const [, resume, again] = w.sent
  assert.match(resume.input[1].content, /Asked: 어느 카드에서 받을까요\?/)
  assert.match(again.input[1].content, /User message: 거기서 이번 달 명세서 내려받아줘\nAsked which card it concerns, the user answered: 거래처 포털 쪽/)
  assert.equal(w.store.get(note.id).goal, '거기서 이번 달 명세서 내려받아줘')
})

test('undecided entry asks at most twice, then goes back to the ordinary turn; a top answer of "not a browser task" never asks; a single card never asks', async () => {
  const resume = () => ({ task_resume: { type: 'choice', choice: 'resume_task', confidence: 0.99, probabilities: [{ value: 'resume_task', probability: 0.99 }] } })
  const w = entryWorld({ answers: [real051, resume, real051, resume, real051] })
  assert.equal((await w.say('거기서 명세서 내려받아줘')).status, 'paused')
  assert.equal((await w.say('음 글쎄')).status, 'paused')
  const third = await w.say('잘 모르겠어')
  assert.deepEqual([third.handled, w.runs.length], [false, 0])
  const not = entryWorld({ answers: [() => ({ browser_entry: { type: 'choice', choice: 'not_browser_task', confidence: 0.5, probabilities: [{ value: 'not_browser_task', probability: 0.55 }, { value: 'ask_user', probability: 0.3 }] } })] })
  assert.deepEqual(await not.say('오늘 날씨 어때?'), { handled: false, reason: 'uncertain' })
})

// ---- R1: why the resume request needs the question ----
test('R1 without the question, two different questions with the same reply make byte-identical resume requests (no judge could tell them apart); with it they differ', async () => {
  const bodies = []
  const client = { decide: async request => { bodies.push(JSON.stringify(request.input)); return { answers: { task_resume: { type: 'choice', choice: 'resume_task', confidence: 0.9, probabilities: [{ value: 'resume_task', probability: 0.9 }] } } } } }
  const pause = { kind: 'need_context', code: 'choice_needed' }
  const which = '사업자가 둘입니다(사업자 123-45-67890, 사업자 987-65-43210). 어느 쪽으로 받을까요?'
  const month = '10월분과 11월분이 있습니다. 어느 달 것을 받을까요?'
  await decideResume({ message: '두 번째 사업자로', pause, client })
  await decideResume({ message: '두 번째 사업자로', pause, client })
  assert.equal(bodies[0], bodies[1], 'without the question the judge sees the same request for an answer that fits and one that does not')
  await decideResume({ message: '두 번째 사업자로', pause, question: which, client })
  await decideResume({ message: '두 번째 사업자로', pause, question: month, client })
  assert.notEqual(bodies[2], bodies[3])
  assert.match(bodies[2], /Asked: 사업자가 둘입니다/); assert.match(bodies[3], /Asked: 10월분과 11월분이 있습니다/)
  // bounded
  await decideResume({ message: 'x', pause, question: '가'.repeat(5000), client })
  assert.ok(JSON.parse(bodies[4])[1].content.length < 600)
})
