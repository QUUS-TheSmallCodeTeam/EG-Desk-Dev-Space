import test from 'node:test'
import assert from 'node:assert/strict'
import { BROWSER_TOOL_SPECS } from './egdesk-browser-tool-runtime.mjs'
import { DecisionError } from './egdesk-decision-client.mjs'
import { BROWSER_REFLEX_TOOL_NAME, BROWSER_REFLEX_TOOL_SPEC, buildReflexCandidates, expectedTargetOf, reflexActionArgs, reflexResultForModel,
  runBrowserReflex, validateReflexArgs } from './egdesk-browser-reflex.mjs'

const USAGE = Object.freeze({ inputTokens: 300, cachedTokens: 0, cacheWriteTokens: 0, outputTokens: 0, totalTokens: 300 })
const element = (ref, role, label, extra = {}) => ({ ref, role, label, tag: role === 'link' ? 'a' : role === 'button' ? 'button' : 'input', href: '', value: '', disabled: false, ...extra })
const REPORTS = 'https://example.com/reports'
const Q3 = 'https://example.com/reports/2026q3'
function page(url, elements, text = ['Reports']) { return { url, revision: 1, text, interactiveElements: elements, viewport: { width: 1280, height: 800 } } }
const LIST_PAGE = page(REPORTS, [
  element('el_1', 'link', '2026 3분기 보고서', { href: Q3, bounds: { x: 10, y: 20, width: 120, height: 18 } }),
  element('el_2', 'link', '외부 사이트', { href: 'https://other.org/x' }),
  element('el_3', 'button', 'Pay now'),
  element('el_4', 'button', '더 보기'),
  element('el_5', 'search', '검색'),
  element('el_6', 'password', '비밀번호'),
  element('el_7', 'textbox', '비밀번호 확인'),
  element('el_8', 'link', '삭제된 항목', { href: 'https://example.com/x', disabled: true }),
])
const REPORT_PAGE = page(Q3, [element('el_9', 'link', '목록', { href: REPORTS })], ['2026 3분기 매출 표'])

function tools(pages) {
  const calls = []
  let observed = 0
  const callTool = async (name, args) => {
    calls.push({ name, args })
    if (name === 'egdesk_browser_observe') {
      const snapshot = pages[Math.min(observed, pages.length - 1)]
      observed++
      return { status: 'observed', cardId: args.cardId, observationId: `obs-${observed}`, snapshot: { ...snapshot, revision: observed } }
    }
    return { status: 'dispatched' }
  }
  return { calls, callTool }
}
const choice = (value, confidence = 0.9, runnerUp = 0.05) => ({ type: 'choice', choice: value, confidence,
  probabilities: [{ value, probability: confidence }, { value: '__other', probability: runnerUp }] })
function decisions(answerFor) {
  const calls = []
  return { calls, client: { async decide(request) {
    calls.push(request)
    const answers = Object.create(null)
    for (const question of request.questions) answers[question.name] = answerFor(question, request)
    return { answers, model: 'gpt-6-luna', usage: USAGE, latencyMs: 110 }
  } } }
}
const urlOf = request => /URL: (\S+)/.exec(typeof request.input === 'string' ? request.input : request.input[1].content)?.[1]

test('candidates keep same-site links, labelled buttons and safe text fields only', () => {
  const { options, excluded } = buildReflexCandidates(LIST_PAGE)
  assert.deepEqual(options.map(option => [option.value, option.item.kind]), [
    ['[L1] 2026 3분기 보고서', 'navigate'], ['[B1] 더 보기', 'press'], ['[F1] 검색', 'fill']])
  // Pay now is gated by the action classifier, other.org is off-site, the
  // confirmation field looks sensitive, el_8 is disabled; the password role is never a field.
  assert.deepEqual(excluded, { disabled: 1, gated: 1, offSite: 1, sensitive: 1, unlabeled: 0, overflow: 0 })
})

test('arguments are copied from the observation, never generated', () => {
  const { options } = buildReflexCandidates(LIST_PAGE)
  const context = { cardId: 'card-1', observationId: 'obs-7', snapshot: { ...LIST_PAGE, revision: 7 } }
  assert.deepEqual(reflexActionArgs(options[0], context), { tool: 'egdesk_browser_navigate',
    args: { cardId: 'card-1', observationId: 'obs-7', expectedRevision: 7, url: Q3, postcondition: { kind: 'url', value: Q3 } } })
  assert.deepEqual(reflexActionArgs(options[1], context), { escalate: 'press_needs_expected_effect' })
  assert.deepEqual(reflexActionArgs(options[2], context), { needsText: true })
  const fill = reflexActionArgs(options[2], { ...context, text: '3분기 보고서' })
  assert.equal(fill.tool, 'egdesk_browser_fill')
  assert.deepEqual(fill.args.expectedTarget, { ref: 'el_5', role: 'search', label: '검색', href: '', value: '', tag: 'input', disabled: false })
  assert.deepEqual(fill.args.postcondition, { kind: 'target-value', value: '3분기 보고서' })
  assert.deepEqual(expectedTargetOf(LIST_PAGE.interactiveElements[0]).bounds, { x: 10, y: 20, width: 120, height: 18 })
})

test('the decision model follows a link and stops when the goal is met, with no model step in between', async () => {
  const { calls, callTool } = tools([LIST_PAGE, REPORT_PAGE])
  const { client, calls: asked } = decisions((question, request) => {
    const onReport = urlOf(request) === Q3
    if (question.name === 'next_step') return onReport ? choice('goal_met') : choice('[L1] 2026 3분기 보고서')
    if (question.name === 'page_state') return choice('content')
    return { type: 'predicate', probability: onReport ? 0.95 : 0.1 }
  })
  const result = await runBrowserReflex({ cardId: 'card-1', goal: '3분기 보고서 열기', callTool, client })
  assert.equal(result.outcome, 'done')
  assert.equal(result.url, Q3)
  assert.equal(result.decisions, 2)
  assert.deepEqual(calls.map(call => call.name), ['egdesk_browser_observe', 'egdesk_browser_navigate', 'egdesk_browser_wait', 'egdesk_browser_observe'])
  assert.deepEqual(calls[1].args.postcondition, { kind: 'url', value: Q3 })
  assert.deepEqual(calls[2].args, { cardId: 'card-1', for: 'load', timeoutMs: 10000 })
  // The gated and off-site elements were never offered to the model.
  const offered = asked[0].questions[0].choices.map(item => item.value)
  assert.ok(!offered.some(value => /Pay now|외부 사이트|비밀번호/.test(value)))
  assert.deepEqual(asked[0].questions.map(question => question.name), ['next_step', 'page_state', 'goal_met'])
})

test('a field nobody filled goes back as needs_free_text; with the value it fills and escalates the button', async () => {
  const searchPage = page(REPORTS, [element('el_5', 'search', '검색'), element('el_10', 'button', '검색 실행')])
  const pick = value => decisions(question => {
    if (question.name === 'next_step') return choice(value)
    if (question.name === 'page_state') return choice('content')
    return { type: 'predicate', probability: 0.1 }
  })
  const first = await runBrowserReflex({ cardId: 'card-1', goal: '3분기 보고서 검색', callTool: tools([searchPage]).callTool, client: pick('[F1] 검색').client })
  assert.deepEqual([first.outcome, first.field], ['needs_free_text', '[F1] 검색'])
  const second = tools([searchPage, { ...searchPage, interactiveElements: [element('el_5', 'search', '검색', { value: '3분기 보고서' }), element('el_10', 'button', '검색 실행')] }])
  const { client, calls: asked } = pick('[B1] 검색 실행')
  const result = await runBrowserReflex({ cardId: 'card-1', goal: '3분기 보고서 검색', values: { '[F1] 검색': '3분기 보고서' }, callTool: second.callTool, client })
  // The exact field name filled without a decision; the button needs an expected effect, so the model gets a suggestion.
  assert.equal(second.calls[1].name, 'egdesk_browser_fill')
  assert.equal(second.calls[1].args.text, '3분기 보고서')
  assert.equal(asked.length, 1)
  assert.equal(result.outcome, 'escalated')
  assert.equal(result.reason, 'press_needs_expected_effect')
  assert.equal(result.suggestion.ref, 'el_10')
})

test('named values are matched to fields one to one by the decision model', async () => {
  const form = page('https://example.com/contact', [element('f_1', 'textbox', '이름'), element('f_2', 'email', '이메일')])
  const filled = { ...form, interactiveElements: [element('f_1', 'textbox', '이름', { value: '차민수' }), element('f_2', 'email', '이메일', { value: 'a@b.c' })] }
  const { calls, callTool } = tools([form, form, filled])
  const { client, calls: asked } = decisions((question) => {
    if (question.name === 'field_0') return { type: 'choice', choice: '[F1] 이름', confidence: 0.9, probabilities: [{ value: '[F1] 이름', probability: 0.9 }, { value: '[F2] 이메일', probability: 0.05 }] }
    if (question.name === 'field_1') return { type: 'choice', choice: '[F2] 이메일', confidence: 0.92, probabilities: [{ value: '[F2] 이메일', probability: 0.92 }, { value: '[F1] 이름', probability: 0.04 }] }
    if (question.name === 'next_step') return choice('goal_met')
    if (question.name === 'page_state') return choice('content')
    return { type: 'predicate', probability: 0.9 }
  })
  const result = await runBrowserReflex({ cardId: 'card-1', goal: '문의 양식 채우기', values: { 성명: '차민수', 메일: 'a@b.c' }, callTool, client })
  assert.equal(result.outcome, 'done')
  assert.deepEqual(calls.filter(call => call.name === 'egdesk_browser_fill').map(call => [call.args.ref, call.args.text]), [['f_1', '차민수'], ['f_2', 'a@b.c']])
  assert.equal(asked.filter(request => request.questions[0].name === 'field_0').length, 1) // mapped once, reused
})

test('sign-in walls hand off, uncertainty escalates, a dead decision model falls back', async () => {
  const state = value => decisions(question => (question.name === 'page_state' ? choice(value) : question.name === 'next_step' ? choice('[L1] 2026 3분기 보고서') : { type: 'predicate', probability: 0.1 }))
  const handoff = await runBrowserReflex({ cardId: 'c', goal: 'g', callTool: tools([LIST_PAGE]).callTool, client: state('login_required').client })
  assert.deepEqual([handoff.outcome, handoff.pageState], ['handoff', 'login_required'])
  const unsure = decisions(question => (question.name === 'next_step' ? choice('[L1] 2026 3분기 보고서', 0.55, 0.4) : question.name === 'page_state' ? choice('content') : { type: 'predicate', probability: 0.1 }))
  const escalated = await runBrowserReflex({ cardId: 'c', goal: 'g', callTool: tools([LIST_PAGE]).callTool, client: unsure.client })
  assert.equal(escalated.outcome, 'escalated')
  assert.equal(escalated.reason, 'uncertain')
  assert.ok(escalated.ranked.length >= 1)
  const dead = { async decide() { throw new DecisionError('no_credit', 'Decision request failed (no_credit)') } }
  const fallback = await runBrowserReflex({ cardId: 'c', goal: 'g', callTool: tools([LIST_PAGE]).callTool, client: dead })
  assert.deepEqual([fallback.outcome, fallback.reason], ['fallback', 'no_credit'])
  assert.deepEqual((await runBrowserReflex({ cardId: 'c', goal: 'g', callTool: tools([LIST_PAGE]).callTool, client: null })).outcome, 'fallback')
})

test('a repeated tool refusal stops the loop and step limits hold', async () => {
  const calls = []
  const callTool = async (name, args) => {
    calls.push(name)
    if (name === 'egdesk_browser_observe') return { status: 'observed', observationId: `obs-${calls.length}`, snapshot: { ...LIST_PAGE, revision: calls.length } }
    throw Object.assign(new Error('stale'), { code: 'BROWSER_OBSERVATION_STALE' })
  }
  const { client } = decisions(question => (question.name === 'next_step' ? choice('[L1] 2026 3분기 보고서') : question.name === 'page_state' ? choice('content') : { type: 'predicate', probability: 0.1 }))
  const refused = await runBrowserReflex({ cardId: 'c', goal: 'g', callTool, client })
  assert.deepEqual([refused.outcome, refused.reason, refused.code], ['escalated', 'tool_failed', 'BROWSER_OBSERVATION_STALE'])
  const scroller = decisions(question => (question.name === 'next_step' ? choice('scroll_more') : question.name === 'page_state' ? choice('content') : { type: 'predicate', probability: 0.1 }))
  const limited = await runBrowserReflex({ cardId: 'c', goal: 'g', maxSteps: 2, callTool: tools([LIST_PAGE]).callTool, client: scroller.client })
  assert.equal(limited.outcome, 'max_steps')
  assert.equal(limited.steps.length, 2)
})

test('the appended tool spec does not touch existing browser tool schemas', () => {
  assert.equal(BROWSER_REFLEX_TOOL_SPEC.name, BROWSER_REFLEX_TOOL_NAME)
  assert.ok(!BROWSER_TOOL_SPECS.some(spec => spec.name === BROWSER_REFLEX_TOOL_NAME))
  assert.deepEqual(BROWSER_REFLEX_TOOL_SPEC.inputSchema.required, ['cardId', 'goal'])
  assert.equal(validateReflexArgs({ cardId: 'c', goal: 'g' }), null)
  for (const bad of [null, { cardId: 'c' }, { cardId: 'c', goal: 'g', extra: 1 }, { cardId: 'c', goal: 'g', values: { a: 1 } },
    { cardId: 'c', goal: 'g', maxSteps: 50 }, { cardId: 'c', goal: 'x'.repeat(501) }]) {
    assert.equal(typeof validateReflexArgs(bad), 'string')
  }
  const text = reflexResultForModel({ outcome: 'escalated', reason: 'uncertain', ranked: [{ value: 'a', probability: 0.5 }], steps: [{}, {}], decisions: 2 })
  assert.deepEqual(JSON.parse(text), { outcome: 'escalated', reason: 'uncertain', ranked: [{ value: 'a', probability: 0.5 }], steps: 2, decisions: 2 })
})
