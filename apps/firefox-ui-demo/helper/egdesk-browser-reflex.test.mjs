import test from 'node:test'
import assert from 'node:assert/strict'
import { BROWSER_TOOL_SPECS } from './egdesk-browser-tool-runtime.mjs'
import { DecisionError } from './egdesk-decision-client.mjs'
import { BROWSER_REFLEX_TOOL_NAME, BROWSER_REFLEX_TOOL_SPEC, buildReflexCandidates, expectedTargetOf, reflexActionArgs, reflexResultForModel,
  runBrowserReflex, validateReflexArgs } from './egdesk-browser-reflex.mjs'

import { PS_NAMES, pageStateAnswers } from './egdesk-browser-page-state.fixture.mjs'
const USAGE = Object.freeze({ inputTokens: 300, cachedTokens: 0, cacheWriteTokens: 0, outputTokens: 0, totalTokens: 300 })
const element = (ref, role, label, extra = {}) => ({ ref, role, label, tag: role === 'link' ? 'a' : role === 'button' ? 'button' : 'input', href: '', value: '', disabled: false, ...extra })
const REPORTS = 'https://example.com/reports'
const Q3 = 'https://example.com/reports/2026q3'
function page(url, elements, text = ['Reports']) { return { url, documentId: 'fixture-doc', revision: 1, text, interactiveElements: elements, viewport: { width: 1280, height: 800 } } }
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
    // c16: the page state is asked as predicates; a double written for the old choice answers it once, translated per predicate
    let state = null
    for (const question of request.questions) {
      if (!question.name.startsWith('ps_')) { answers[question.name] = answerFor(question, request); continue }
      state ??= answerFor({ name: 'page_state', type: 'choice' }, request)
      answers[question.name] = state?.type === 'choice' ? pageStateAnswers(state.choice, state.confidence)[question.name] : state
    }
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
  assert.deepEqual(asked[0].questions.map(question => question.name), ['next_step', ...PS_NAMES, 'goal_met'])
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
  // The supplied field fills only after classifying this observation; the button still needs an expected effect.
  assert.equal(second.calls[1].name, 'egdesk_browser_fill')
  assert.equal(second.calls[1].args.text, '3분기 보고서')
  assert.equal(asked.length, 2) // one page decision per fresh observation, no mapping request for an exact name
  assert.equal(result.steps[0].decision.pageState, 'content')
  assert.deepEqual(second.calls[1].args.postcondition, { kind: 'target-value', value: '3분기 보고서' })
  assert.equal(result.outcome, 'escalated')
  assert.equal(result.reason, 'press_needs_expected_effect')
  assert.equal(result.suggestion.ref, 'el_10')
})

test('named values are matched to fields one to one by the decision model', async () => {
  const form = page('https://example.com/contact', [element('f_1', 'textbox', '이름'), element('f_2', 'email', '이메일')])
  const filled = { ...form, interactiveElements: [element('f_1', 'textbox', '이름', { value: '차민수' }), element('f_2', 'email', '이메일', { value: 'a@b.c' })] }
  const { calls, callTool } = tools([form, form, filled])
  const { client, calls: asked } = decisions((question, request) => {
    if (question.name === 'field_0') return { type: 'choice', choice: '[F1] 이름', confidence: 0.9, probabilities: [{ value: '[F1] 이름', probability: 0.9 }, { value: '[F2] 이메일', probability: 0.05 }] }
    if (question.name === 'field_1') return { type: 'choice', choice: '[F2] 이메일', confidence: 0.92, probabilities: [{ value: '[F2] 이메일', probability: 0.92 }, { value: '[F1] 이름', probability: 0.04 }] }
    const evidence = request.input[1].content
    const filledName = evidence.includes('filled [F1]'), filledEmail = evidence.includes('filled [F2]')
    if (question.name === 'next_step') return choice(filledEmail ? 'goal_met' : filledName ? '[F2] 이메일' : '[F1] 이름')
    if (question.name === 'page_state') return choice('content')
    return { type: 'predicate', probability: filledEmail ? 0.9 : 0.1 }
  })
  const result = await runBrowserReflex({ cardId: 'card-1', goal: '문의 양식 채우기', values: { 성명: '차민수', 메일: 'a@b.c' }, callTool, client })
  assert.equal(result.outcome, 'done')
  assert.deepEqual(calls.filter(call => call.name === 'egdesk_browser_fill').map(call => [call.args.ref, call.args.text]), [['f_1', '차민수'], ['f_2', 'a@b.c']])
  assert.equal(asked.filter(request => request.questions[0].name === 'field_0').length, 1) // mapped once, reused
})

test('field assignments own distinct observed controls and do not retarget ambiguous labels', async () => {
  const exact = '[F1] Name', backup = '[F2] Backup', indistinct = '[F2] Name', none = 'no matching field'
  const first = element('f1', 'textbox', 'Name'), second = element('f2', 'textbox', 'Backup')
  const sameLabel = element('f2', 'textbox', 'Name'), sameRef = element('f1', 'textbox', 'Backup')
  async function fill(values, snapshots, mapAnswer) {
    const { calls, callTool } = tools(snapshots.map(elements => page(REPORTS, elements)))
    const { client, calls: asked } = decisions(question => {
      if (question.name.startsWith('field_')) return mapAnswer(question)
      if (question.name === 'page_state') return choice('content')
      if (question.name === 'next_step') return choice(exact)
      return { type: 'predicate', probability: .1 }
    })
    const result = await runBrowserReflex({ cardId: 'fixture', goal: 'Copy supplied values', values, callTool, client })
    assert.equal(result.outcome, 'needs_free_text')
    assert.ok(result.steps.every(step => step.decision?.kind === 'act' && step.decision?.pageState === 'content'))
    const writes = calls.filter(call => call.name === 'egdesk_browser_fill').map(call => [call.args.ref, call.args.text])
    const offers = asked.flatMap(request => request.questions.filter(question => question.name.startsWith('field_'))
      .map(question => question.choices.map(option => option.value)))
    return { writes, offers, unmatched: JSON.parse(reflexResultForModel(result)).unmatchedValues ?? [] }
  }
  const rank = (declared, rows) => ({ type: 'choice', choice: declared, confidence: .98,
    probabilities: rows.map(([value, probability]) => ({ value, probability })) })
  for (const values of [{ [exact]: 'explicit', alias: 'other' }, { alias: 'other', [exact]: 'explicit' }]) {
    assert.deepEqual(await fill(values, [[first]], () => choice(exact)),
      { writes: [['f1', 'explicit']], offers: [], unmatched: ['alias'] })
  }
  const values = { [exact]: 'explicit', alias: 'other' }
  assert.deepEqual(await fill(values, [[first, second]], question => question.choices.some(option => option.value === exact)
    ? rank(exact, [[exact, .95], [backup, .04], [none, .01]]) : rank(backup, [[backup, .91], [none, .09]])),
  { writes: [['f1', 'explicit'], ['f2', 'other']], offers: [[backup, none]], unmatched: [] })
  assert.deepEqual(await fill(values, [[first, second]], () => rank(none, [[none, .96], [backup, .04]])),
    { writes: [['f1', 'explicit']], offers: [[backup, none]], unmatched: ['alias'] })
  assert.deepEqual(await fill(values, [[first, sameRef]], () => choice(backup)),
    { writes: [['f1', 'explicit']], offers: [], unmatched: ['alias'] })
  assert.deepEqual(await fill({ earlier: 'lower', later: 'higher' }, [[first, sameRef]], question => question.name === 'field_0'
    ? rank(exact, [[exact, .86], [none, .14]]) : rank(backup, [[backup, .94], [none, .06]])),
  { writes: [['f1', 'higher']], offers: [[exact, backup, none], [exact, backup, none]], unmatched: ['earlier'] })
  assert.deepEqual(await fill({ alias: 'other' }, [[first, sameLabel]], () => rank(exact, [[exact, .5], [indistinct, .5]])),
    { writes: [], offers: [[exact, indistinct, none]], unmatched: ['alias'] })
  assert.deepEqual(await fill({ [exact]: 'explicit', [indistinct]: 'other' }, [[first, sameLabel], [sameLabel, first]]),
    { writes: [['f1', 'explicit']], offers: [], unmatched: [indistinct] })
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

for (const [state, text, confidence, outcome, key] of [
  ['login_required', 'Sign in to continue', 0.98, 'handoff', '[F1] Email'],
  ['login_required', 'Sign in to continue', 0.98, 'handoff', 'contact'],
  ['two_factor_required', 'Verification required', 0.98, 'handoff', '[F1] Email'],
  ['bot_check', 'Human verification required', 0.98, 'handoff', '[F1] Email'],
  ['sensitive_flow', 'Checkout: complete payment', 0.98, 'handoff', '[F1] Email'],
  // c16: an undecided page state asks the person to look at the page (page_unclear), it no longer ends as "uncertain"
  ['content', 'Unclear form context', 0.51, 'page_unclear', '[F1] Email'],
]) {
  test(`pending caller text is never filled for ${state} (${key})`, async () => {
    const { callTool, calls } = tools([page('https://example.invalid/form', [element('f_1', 'email', 'Email')], [text])])
    const { client, calls: asked } = decisions(question => {
      if (question.name === 'page_state') return choice(state, confidence)
      if (question.name === 'next_step' || question.name === 'field_0') return choice('[F1] Email')
      return { type: 'predicate', probability: 0.1 }
    })
    const result = await runBrowserReflex({ cardId: 'c', goal: 'Check this form', values: { [key]: 'fixture-only' },
      maxSteps: 2, callTool, client })
    assert.deepEqual(calls.map(call => call.name), ['egdesk_browser_observe'], 'classified observation must precede any action')
    assert.deepEqual(asked.map(request => request.questions[0].name), ['next_step'], 'blocked or uncertain observations never enter field mapping')
    assert.equal(result.outcome, outcome)
  })
}

for (const phase of ['page_state', 'field_0']) {
  test(`aborting during ${phase} drops a deferred answer before dispatch`, async () => {
    const controller = new AbortController()
    const { callTool, calls } = tools([page('https://example.invalid/form', [element('f_1', 'email', 'Email')])])
    const stub = decisions(question => {
      if (question.name === phase) controller.abort()
      if (question.name === 'page_state') return choice('content')
      if (question.name === 'next_step' || question.name === 'field_0') return choice('[F1] Email')
      return { type: 'predicate', probability: 0.1 }
    })
    const result = await runBrowserReflex({ cardId: 'c', goal: 'Fill public form', values: { contact: 'fixture-only' },
      signal: controller.signal, callTool, client: stub.client })
    assert.equal(result.outcome, 'aborted')
    assert.deepEqual(calls.map(call => call.name), ['egdesk_browser_observe'])
  })
}

test('a stale guarded fill is refused and not retried against another observation', async () => {
  const snap = page('https://example.invalid/form', [element('f_1', 'email', 'Email')])
  const observed = tools([snap]), attempts = [], effects = []
  let liveRevision = 1
  const { client } = decisions(question => {
    if (question.name === 'page_state') { liveRevision = 2; return choice('content') }
    if (question.name === 'next_step') return choice('[F1] Email')
    return { type: 'predicate', probability: 0.1 }
  })
  const callTool = async (name, args) => {
    if (name === 'egdesk_browser_observe') return observed.callTool(name, args)
    attempts.push({ name, args })
    if (args.expectedRevision !== liveRevision) throw Object.assign(new Error('stale fixture'), { code: 'BROWSER_OBSERVATION_STALE' })
    effects.push(name)
    return { status: 'postcondition-observed' }
  }
  const result = await runBrowserReflex({ cardId: 'c', goal: 'Fill public form', values: { '[F1] Email': 'fixture-only' }, callTool, client })
  assert.deepEqual([result.outcome, result.reason, result.code], ['escalated', 'tool_failed', 'BROWSER_OBSERVATION_STALE'])
  assert.deepEqual(attempts.map(({ name, args }) => [name, args.observationId, args.expectedRevision, args.ref]), [
    ['egdesk_browser_fill', 'obs-1', 1, 'f_1'],
  ])
  assert.equal(observed.calls.length, 1)
  assert.deepEqual(effects, [])
})

for (const variant of ['handoff', 'ordinary', 'changed ref', 'changed URL', 'changed document', 'missing document']) {
  test(`one exact and one mapped value stay in scope: ${variant}`, async () => {
    const exact = '[F1] Name', second = '[F2] Topic'
    const form = page('https://example.invalid/form', [element('f_1', 'textbox', 'Name'), element('f_2', 'textbox', 'Topic')], ['Public form'])
    if (variant === 'missing document') delete form.documentId
    const writes = new Map(), actions = [], observed = []
    let live = form
    const callTool = async (name, args) => {
      if (name === 'egdesk_browser_observe') {
        const revision = observed.length + 1
        const snapshot = { ...live, revision, interactiveElements: live.interactiveElements.map(field => ({ ...field, value: writes.get(field.ref) ?? '' })) }
        observed.push(snapshot)
        return { observationId: `obs-${revision}`, snapshot }
      }
      actions.push({ name, args })
      assert.equal(name, 'egdesk_browser_fill')
      const snapshot = observed.at(-1)
      assert.equal(args.observationId, `obs-${snapshot.revision}`)
      assert.equal(args.expectedRevision, snapshot.revision)
      assert.deepEqual(args.expectedTarget, expectedTargetOf(snapshot.interactiveElements.find(field => field.ref === args.ref)))
      assert.deepEqual(args.postcondition, { kind: 'target-value', value: args.text })
      writes.set(args.ref, args.text)
      if (variant === 'handoff') live = { ...form, text: ['Human sign-in required'] }
      if (variant === 'changed ref') live = { ...form, interactiveElements: [form.interactiveElements[0], element('f_3', 'textbox', 'Topic')] }
      if (variant === 'changed URL') live = { ...form, url: 'https://example.invalid/other-form' }
      if (variant === 'changed document') live = { ...form, documentId: 'replacement-doc' }
      return { status: 'postcondition-observed' }
    }
    const { client, calls: asked } = decisions(question => {
      if (question.name === 'field_0') return choice(second)
      if (question.name === 'page_state') return choice(live === form || variant !== 'handoff' ? 'content' : 'login_required')
      if (question.name === 'next_step') return choice(writes.size === 2 ? 'goal_met' : writes.size === 1 ? second : exact)
      return { type: 'predicate', probability: writes.size === 2 ? .98 : .1 }
    })
    const result = await runBrowserReflex({ cardId: 'fixture', goal: 'Copy public form values', values: { [exact]: 'first-value', subject: 'second-value' }, callTool, client })
    const ordinary = variant === 'ordinary'
    const expected = ordinary ? [['f_1', 'first-value'], ['f_2', 'second-value']] : [['f_1', 'first-value']]
    assert.deepEqual(actions.map(({ name, args }) => [name, args.ref, args.text]), expected.map(row => ['egdesk_browser_fill', ...row]))
    assert.deepEqual([...writes], expected)
    assert.equal(result.outcome, ordinary ? 'done' : variant === 'handoff' ? 'handoff' : 'needs_free_text')
    assert.equal(result.steps.length, ordinary ? 3 : 2)
    assert.deepEqual(result.steps[0].mapping.assigned, { subject: second }, 'second value was actually bound before the first approved write')
    assert.equal(result.steps[0].decision.pageState, 'content')
    assert.equal(result.steps[1].decision.pageState, variant === 'handoff' ? 'login_required' : 'content')
    if (!ordinary) assert.deepEqual(result.steps[1].actions, [])
    if (!ordinary && variant !== 'handoff') assert.deepEqual(result.unmatchedValues, ['subject'])
    assert.deepEqual(asked.map(request => request.questions[0].name), ordinary ? ['next_step', 'field_0', 'next_step', 'next_step'] : ['next_step', 'field_0', 'next_step'])
    assert.deepEqual(asked[1].questions[0].choices.map(option => option.value), [second, 'no matching field'])
  })
}

test('L8: a same-site link is judged by its href words as well as its label; unsafe paths are never candidates', async () => {
  const { buildReflexCandidates, hrefWords } = await import('./egdesk-browser-reflex.mjs')
  assert.equal(hrefWords('https://example.com/a-b/c_d?x=%EC%82%AD%EC%A0%9C&y=1'), 'a b c d x 삭제 y 1')
  assert.equal(hrefWords('not a url'), '')
  const link = (ref, label, href) => ({ ref, role: 'link', label, tag: 'a', href, value: '' })
  const snap = { url: 'https://example.com/cart', interactiveElements: [
    link('a', 'Continue', 'https://example.com/account/delete?id=7'),
    link('b', 'More', 'https://example.com/checkout/pay'),
    link('c', 'Plans', 'https://example.com/plans/team'),
  ] }
  const { options, excluded } = buildReflexCandidates(snap)
  assert.deepEqual(options.map(o => o.item.element.ref), ['c'])
  assert.equal(excluded.gated, 2)
})

test('L8 C4: session-end, ordering, grant and cancellation destinations are not candidates; plain paths are', () => {
  const link = (ref, href) => ({ ref, role: 'link', label: 'Continue', tag: 'a', href, value: '' })
  const hrefs = ['/logout', '/order/place', '/grant/allow', '/account/close', '/subscriptions/cancel', '/ko/로그아웃', '/permissions/allow']
  const { options, excluded } = buildReflexCandidates({ url: 'https://example.com/cart', interactiveElements: [
    ...hrefs.map((h, i) => link('d' + i, 'https://example.com' + h)), link('ok1', 'https://example.com/pricing'), link('ok2', 'https://example.com/orders/123') ] })
  assert.deepEqual(options.map(o => o.item.element.ref), ['ok1', 'ok2'])
  assert.equal(excluded.gated, hrefs.length)
})
