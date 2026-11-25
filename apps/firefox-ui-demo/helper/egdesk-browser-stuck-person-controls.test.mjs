// L8 c26: a page whose offered options do not move toward the goal, but which holds controls withheld as the person's own, is the person's step: the task
// hands over as human_step naming them (nothing is acted on) instead of scrolling or ending without a word. Decided by code from the step's answers and the
// snapshot's scroll state. Real: the c24 fee-and-verification page (all six page-state predicates 0, scroll_more 0.91, person_target 0.49).
import test from 'node:test'
import assert from 'node:assert/strict'
import { buildReflexCandidates, contentBelow, runBrowserReflex } from './egdesk-browser-reflex.mjs'
import { createBrowserTaskStore, createDirectBrowserEntry } from './egdesk-browser-task.mjs'
import { HOLDOUT_PAGES } from './egdesk-browser-live-holdout.mjs'
import { FAMILY_PAGES } from './egdesk-browser-live-families.mjs'
import { pageStateAnswers } from './egdesk-browser-page-state.fixture.mjs'

const FORM = HOLDOUT_PAGES.issuance['/issue/resident']
const snap = (page, url, extra = {}) => ({ cardId: 'card', documentId: 'doc1', revision: 1, url, readyState: 'complete', text: page.text, viewport: { width: 1200, height: 800, devicePixelRatio: 1 }, interactiveElements: page.elements, ...extra })
const FORM_SNAP = snap(FORM, 'https://minwon.example.test/issue/resident')
const snapSettings = snap(FAMILY_PAGES.settings['/settings/notifications'], 'https://account.example.test/settings/notifications')
const choice = (value, confidence = 0.91) => ({ type: 'choice', choice: value, confidence, probabilities: [{ value, probability: confidence }] })
const P = p => ({ type: 'predicate', probability: p })
const base = (next, extra = {}) => ({ next_step: next, ...pageStateAnswers('content', 0.98), goal_met: P(0.02), person_target_0: P(0.49), ...extra })
async function step(answers, snapshot = FORM_SNAP, goal = '주민등록등본 발급 신청해줘') {
  const tools = [], sent = []
  const callTool = async name => { tools.push(name); return name === 'egdesk_browser_observe' ? { observationId: 'o1', snapshot } : { status: 'ok' } }
  const client = { decide: async request => { sent.push(request); return { answers: answers(request) } } }
  const result = await runBrowserReflex({ cardId: 'card', goal, maxSteps: 1, callTool, client })
  return { result, sent, acts: tools.filter(n => n !== 'egdesk_browser_observe') }
}

test('withheld controls are collected in page order (a button withheld by vocabulary, a control with no action); a proven read-only button is not one', () => {
  const { withheld, options } = buildReflexCandidates(FORM_SNAP)
  assert.deepEqual(withheld, [{ label: '휴대폰 본인확인', role: 'button' }, { label: '수수료 결제에 동의합니다', role: 'checkbox' }, { label: '신청하기', role: 'button' }])
  assert.deepEqual(options.map(o => o.value), ['[L1] 발급 수수료 안내', '[L2] 목록'])
  const bill = buildReflexCandidates(snap(HOLDOUT_PAGES.utility['/bill'], 'https://power.example.test/bill'))
  assert.deepEqual([bill.withheld, bill.options.map(o => o.value)], [[{ label: '청구 월', role: 'combobox' }], ['[B1] 확인', '[L1] 이용 안내']])
  assert.equal(buildReflexCandidates({ url: 'https://x.example.test/', interactiveElements: Array.from({ length: 6 }, (_, i) => ({ ref: `b${i}`, role: 'button', label: `삭제 ${i}`, tag: 'button' })) }).withheld.length, 3, 'at most three are named')
})

test('real replay (c24 form page): scroll_more 0.91, the one person-target undecided (0.49): the task hands over as human_step naming the controls, nothing acted on', async () => {
  const { result, sent, acts } = await step(() => base(choice('scroll_more')))
  assert.deepEqual([result.outcome, result.reason, result.controls, acts], ['escalated', 'human_step', ['휴대폰 본인확인', '수수료 결제에 동의합니다', '신청하기'], []])
  assert.equal(sent.length, 2, 'the step request and the existing person-target follow-up: no new question')
  assert.equal(result.steps.at(-1).rule, 'stuck_person_controls')
})

test('the same hand-over for a decided blocked; an undecided step is not touched; with no withheld control nothing changes', async () => {
  const blocked = await step(() => base(choice('blocked', 0.9)))
  assert.deepEqual([blocked.result.outcome, blocked.result.reason, blocked.result.controls, blocked.acts], ['escalated', 'human_step', ['휴대폰 본인확인', '수수료 결제에 동의합니다', '신청하기'], []])
  const unsure = await step(() => base(choice('scroll_more', 0.56)))
  assert.deepEqual([unsure.result.outcome, unsure.result.reason], ['escalated', 'uncertain'], 'undecided stays as it was')
  const links = snap({ text: FORM.text, elements: FORM.elements.filter(e => e.role === 'link') }, FORM_SNAP.url)
  const plain = await step(() => base(choice('blocked', 0.9)), links)
  assert.deepEqual([plain.result.outcome, plain.result.reason, plain.result.controls], ['escalated', 'blocked', undefined], 'nothing withheld: the old outcome')
  const scrolled = await step(() => base(choice('scroll_more')), links)
  assert.ok(scrolled.acts.includes('egdesk_browser_scroll'), 'nothing withheld: scroll_more still scrolls')
})

test('scroll_more is still scrolled when the page reports content below; at the bottom, or without scroll facts, the page is the person\'s', async () => {
  const below = await step(() => base(choice('scroll_more')), { ...FORM_SNAP, scroll: { x: 0, y: 0, maxY: 1800 } })
  assert.ok(below.acts.includes('egdesk_browser_scroll') && below.result.controls === undefined, 'content below: scroll')
  const bottom = await step(() => base(choice('scroll_more')), { ...FORM_SNAP, scroll: { x: 0, y: 1800, maxY: 1800 } })
  assert.deepEqual([bottom.result.reason, bottom.acts], ['human_step', []])
  const fits = await step(() => base(choice('scroll_more')), { ...FORM_SNAP, scroll: { x: 0, y: 0, maxY: 8 } })
  assert.deepEqual([fits.result.reason, fits.acts], ['human_step', []], 'a few pixels is not more content')
  assert.deepEqual([contentBelow(FORM_SNAP), contentBelow({ scroll: { y: 0, maxY: 2000 } }), contentBelow({ scroll: { y: 1990, maxY: 2000 } })], [false, true, false])
})

test('a forward option still proceeds; a sensitive or error page state still comes first; a decided person target keeps its own outcome', async () => {
  const go = await step(() => base(choice('[L1] 발급 수수료 안내', 0.95)))
  assert.deepEqual([go.result.outcome, go.acts.includes('egdesk_browser_navigate')], ['max_steps', true], 'a decided link is taken even though controls are withheld')
  const sensitive = await step(() => base(choice('scroll_more'), pageStateAnswers('sensitive_flow', 0.95)))
  assert.deepEqual([sensitive.result.outcome, sensitive.result.pageState, sensitive.result.controls], ['handoff', 'sensitive_flow', undefined])
  const err = await step(() => base(choice('scroll_more'), pageStateAnswers('error_page', 0.95)))
  assert.deepEqual([err.result.outcome, err.result.reason, err.result.controls], ['escalated', 'error_page', undefined], 'an error page is reported as one, not as the person\'s step')
  const target = await step(() => base(choice('scroll_more'), { person_target_0: P(0.03), person_target_1: P(0.93) }))
  assert.deepEqual([target.result.reason, target.result.target, target.result.controls], ['human_step', '수수료 결제에 동의합니다', ['수수료 결제에 동의합니다']], 'c36: the decided controls are named')
})

test('statement page: 결제하기 is named when the one link left does not move toward the goal', async () => {
  const statement = FAMILY_PAGES.statement['/card/result']
  const page = { text: statement.text, elements: statement.elements.filter(e => e.ref !== 'st_dl') }
  const { result } = await step(() => base(choice('blocked', 0.9)), snap(page, 'https://bank.example.test/card/result'), '이번 달 카드 명세서 내려받아줘')
  assert.deepEqual([result.reason, result.controls], ['human_step', ['결제하기']])
})

test('the task note names them: code human_step with the control labels as candidates (at most three), nothing acted on', async () => {
  const run = async result => {
    const provider = { directEntryEnabled: () => true, reflexScope: () => ({ client: { decide: async () => ({ answers: {} }) }, isDecisionCurrent: () => true, callTool: async () => ({ snapshot: { text: [] } }) }), runDirectTask: async () => result }
    const entry = createDirectBrowserEntry({ provider, store: createBrowserTaskStore(), cardTextInEntry: () => false })
    const out = await entry.handle({ run: { runId: 'r', browserBinding: { cards: [{ cardId: 'card', permission: 'interact' }] } }, conversationKey: 'dm', message: '주민등록등본 발급 신청해줘', hosts: { card: 'minwon.example.test' }, titles: { card: '증명서 발급 | 온민원' },
      entryAnswers: { browser_entry: { type: 'predicate', probability: 0.9 }, browser_entry_card_0: { type: 'predicate', probability: 0.95 }, codeCard: null } })
    return JSON.parse(out.note).egdesk_browser_task
  }
  const note = await run({ outcome: 'escalated', reason: 'human_step', withheld: 3, controls: ['휴대폰 본인확인', '수수료 결제에 동의합니다', '신청하기', '넷째'], steps: [{ url: 'https://minwon.example.test/issue/resident', actions: [], excluded: { gated: 2, unsupported: 1 } }], decisions: 1 })
  assert.deepEqual([note.status, note.code, note.candidates], ['cannot_proceed', 'human_step', ['휴대폰 본인확인', '수수료 결제에 동의합니다', '신청하기']])
})

// ---- c36 (real, check-26bl, loop-form-submit): the submit button is a person-target too, and every decided control is named ----
test('c36: the person-target follow-up asks about the withheld BUTTONS too (page order, at most three); every control decided yes is named, so the 신청서 제출 step is not dropped', async () => {
  const { HOLDOUT_PAGES: _unused } = await import('./egdesk-browser-live-holdout.mjs')
  const { HARD_PAGES } = await import('./egdesk-browser-live-hard.mjs')
  const room = HARD_PAGES.room['/rooms/form']
  const roomSnap = { cardId: 'card', documentId: 'doc1', revision: 1, url: 'https://room.example.test/rooms/form', readyState: 'complete', text: room.text, viewport: { width: 1200, height: 800, devicePixelRatio: 1 }, interactiveElements: room.elements }
  const goal = '회의실 대관 신청해줘'
  const asks = []
  const run = answers => step(req => { asks.push(req); return answers(req) }, roomSnap, goal)
  const base2 = extra => base(choice('scroll_more'), { person_target_0: P(0.03), person_target_1: P(0.03), person_target_2: P(0.03), ...extra })
  // the real run: only the agreement box decided yes (the button was never asked about): its note named only the box. Now the button is asked, and named when decided
  const both = await run(() => base2({ person_target_1: P(0.93), person_target_2: P(0.97) }))
  const follow = asks.find(r => r.questions.some(q => q.name.startsWith('person_target')))
  assert.deepEqual(follow.questions.map(q => q.instructions), ['Is this control, "대관 시간" (combobox, now "14:00"), the one this request asks to change?', 'Is this control, "이용 약관에 동의합니다" (checkbox), the one this request asks to change?', 'Is pressing this control, "신청서 제출" (button), the step that completes what this request asks for?'], 'c37: a pressed control is asked as the step that completes the request, a value-holding one as the one to change')
  assert.deepEqual([both.result.reason, both.result.target, both.result.controls, both.acts], ['human_step', '이용 약관에 동의합니다', ['이용 약관에 동의합니다', '신청서 제출'], []], 'both decided controls are named, page order')
  const onlyButton = await run(() => base2({ person_target_2: P(0.97) }))
  assert.deepEqual([onlyButton.result.target, onlyButton.result.controls], ['신청서 제출', ['신청서 제출']])
  // the note carries them (a hand-over names exactly the decided controls)
  const { createBrowserTaskStore, createDirectBrowserEntry } = await import('./egdesk-browser-task.mjs')
  const provider = { directEntryEnabled: () => true, reflexScope: () => ({ client: { decide: async () => ({ answers: {} }) }, isDecisionCurrent: () => true, callTool: async () => ({ snapshot: { text: [] } }) }), runDirectTask: async () => both.result }
  const out = await createDirectBrowserEntry({ provider, store: createBrowserTaskStore(), cardTextInEntry: () => false }).handle({ run: { runId: 'r', browserBinding: { cards: [{ cardId: 'card', permission: 'interact' }] } }, conversationKey: 'dm', message: goal, hosts: { card: 'room.example.test' }, titles: { card: '대관 | 시민회관' },
    entryAnswers: { browser_entry: { type: 'predicate', probability: 0.97 }, browser_entry_answer: { type: 'predicate', probability: 0 }, browser_entry_card_0: { type: 'predicate', probability: 0.95 }, codeCard: null } })
  assert.deepEqual(JSON.parse(out.note).egdesk_browser_task.candidates, ['이용 약관에 동의합니다', '신청서 제출'])
  // a toggle page keeps its one named control (the v1 loop-toggle expectation)
  const toggles = await step(() => base(choice('scroll_more'), { person_target_0: P(0.96), person_target_1: P(0.03) }), snapSettings, '마케팅 알림 꺼줘')
  assert.deepEqual([toggles.result.target, toggles.result.controls], ['마케팅 정보 알림', ['마케팅 정보 알림']])
})

// ---- c37 (real, check-29bl, loop-form-submit): the question fits the control ----
test('c37: personTargetAsk: a pressed control (button, link, menu item, tab) is asked as the step that completes the request; a control holding a value keeps "the one this request asks to change"', async () => {
  const { personTargetAsk } = await import('./egdesk-browser-reflex.mjs')
  for (const role of ['button', 'link', 'menuitem', 'tab']) assert.equal(personTargetAsk({ label: 'X', role }), `Is pressing this control, "X" (${role}), the step that completes what this request asks for?`)
  for (const role of ['checkbox', 'combobox', 'switch', 'radio', 'textbox']) assert.equal(personTargetAsk({ label: 'X', role, value: 'v' }), `Is this control, "X" (${role}, now "v"), the one this request asks to change?`)
})

// the real record (check-29bl): the step was undecided (scroll_more 0.66 against the 0.75 bar) and the three predicates, asked "the one this request asks to change?", were 0.07 / 0.31 / 0.39.
// With the fitting question the real model's judgement of the button is what decides; the replay below pins what code does with each outcome (decided: named, undecided: nothing is named and nothing is pressed).
test('c37: the form page of the real record: a decided submit button is named as the person\'s step and nothing is pressed; the real answers of check-29bl (all below the bar) name nothing, and nothing is pressed either', async () => {
  const { HARD_PAGES } = await import('./egdesk-browser-live-hard.mjs')
  const room = HARD_PAGES.room['/rooms/form']
  const roomSnap = { cardId: 'card', documentId: 'doc1', revision: 1, url: 'https://room.example.test/rooms/form', readyState: 'complete', text: room.text, viewport: { width: 1200, height: 800, devicePixelRatio: 1 }, interactiveElements: room.elements }
  const goal = '회의실 대관 신청해줘'
  const run = async targets => step(() => base(choice('scroll_more', 0.66) /* the real step: undecided, under the 0.75 bar */, { person_target_0: P(targets[0]), person_target_1: P(targets[1]), person_target_2: P(targets[2]) }), roomSnap, goal)
  const decided = await run([0.07, 0.31, 0.93])
  assert.deepEqual([decided.result.reason, decided.result.target, decided.result.controls, decided.acts], ['human_step', '신청서 제출', ['신청서 제출'], []])
  const real = await run([0.07, 0.31, 0.39])
  assert.deepEqual([real.result.target, real.result.controls], [undefined, undefined], 'below the bar nothing is named as the target (' + JSON.stringify(real.result.reason) + ')')
  assert.deepEqual(real.acts, [], 'and nothing is pressed or typed')
})
