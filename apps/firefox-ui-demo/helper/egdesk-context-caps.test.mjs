// L57: what the models see. The evidence value is whole (the screen's line stays 40), an undecided step is asked once more with the page's full text, ONE card is quoted wider,
// a finished page keeps more lines.
import test from 'node:test'
import assert from 'node:assert/strict'
import { optionStepDisplay, pageTextCut, withFullPageText, runBrowserReflex, EVIDENCE_VALUE_CHARS, TEXT_SEGMENT_CHARS, FULL_TEXT_BUDGET } from './egdesk-browser-reflex.mjs'
import { taskStepEvent, pageLines, MAX_PAGE_LINES, entryQuestions, observeCardLines, ENTRY_SINGLE_CONTROLS, ENTRY_SINGLE_LINES } from './egdesk-browser-task.mjs'
import { browserStepFor } from './egdesk-browser-task-turn.mjs'
import { PS_NAMES, pageStateAnswers } from './egdesk-browser-page-state.fixture.mjs'

const fillOption = (displayValueSafe = true, label = '메모') => ({ item: { kind: 'fill', element: { label, displayValueSafe } } })

test('a long typed value: the screen keeps 40 chars, the answer evidence carries it whole; masked stays masked', () => {
  const value = '가나다라 '.repeat(100).trim() // 399 chars
  const shown = optionStepDisplay(fillOption(), value)
  assert.equal([...shown.displayValue].length, 40)
  assert.equal(shown.evidenceValue, value)
  const huge = optionStepDisplay(fillOption(), 'x'.repeat(EVIDENCE_VALUE_CHARS + 500))
  assert.ok(huge.evidenceValue.endsWith(`[${EVIDENCE_VALUE_CHARS + 500} chars]`) && huge.evidenceValue.startsWith('x'.repeat(EVIDENCE_VALUE_CHARS)), 'bounded, and says how long it was')
  for (const option of [fillOption(false), fillOption(true, 'OTP'), fillOption(true, '인증 코드')]) assert.deepEqual([optionStepDisplay(option, value).displayValue, optionStepDisplay(option, value).evidenceValue], ['●●●', '●●●'])
})

test('the step event carries the evidence value to the runtime only: a failed step is masked, the UI step never has it', () => {
  const task = { taskId: 'task-1', cardId: 'card-1' }
  const info = { op: 'fill', action: 'egdesk_browser_fill', ok: true, target: '메모', displayValue: 'abc…', evidenceValue: 'abcdefghij' }
  assert.equal(taskStepEvent(task, info, { seq: 1 }).evidenceValue, 'abcdefghij')
  assert.equal(taskStepEvent(task, { ...info, ok: false }, { seq: 1 }).evidenceValue, '●●●')
  assert.equal(taskStepEvent(task, { ...info, op: 'press' }, { seq: 1 }).evidenceValue, undefined)
  const step = browserStepFor(taskStepEvent(task, info, { seq: 1 }), { clientThreadId: 'thread-1' })
  assert.equal(step.displayValue, 'abc…'); assert.equal(JSON.stringify(step).includes('abcdefghij'), false)
})

test('pageTextCut: false for a short page, true past the segment or the total cut; the full text shows the rest', () => {
  assert.equal(pageTextCut({ text: ['a', 'b'] }), false)
  assert.equal(pageTextCut({ text: ['x'.repeat(TEXT_SEGMENT_CHARS + 1)] }), true)
  assert.equal(pageTextCut({ text: Array.from({ length: 30 }, (_, i) => `line ${i} ` + 'y'.repeat(300)) }), true)
  assert.equal(pageTextCut({ text: ['Page title: "t" (the page\'s own text is not sent)', 'x'.repeat(2000)] }), false, 'a withheld page has no text to widen')
  assert.equal(withFullPageText({ text: [] }).textBudget, FULL_TEXT_BUDGET)
})

const el = (ref, role, label, extra = {}) => ({ ref, role, label, tag: role === 'link' ? 'a' : 'input', href: '', value: '', disabled: false, ...extra })
const choice = (value, confidence, runnerUp) => ({ type: 'choice', choice: value, confidence, probabilities: [{ value, probability: confidence }, { value: '__other', probability: runnerUp }] })
const longPage = text => ({ url: 'https://example.com/r', documentId: 'd', revision: 1, text, viewport: { width: 1, height: 1 }, interactiveElements: [el('el_1', 'link', '2026 3분기 보고서', { href: 'https://example.com/r/q3' })] })
function run(text, undecidedFirst = true) {
  const requests = []
  const client = { async decide(request) {
    requests.push(request)
    const full = JSON.stringify(request.input).includes('TAILMARK')
    const answers = Object.create(null)
    for (const q of request.questions) answers[q.name] = q.name === 'next_step' ? (full || !undecidedFirst ? choice('[L1] 2026 3분기 보고서', 0.95, 0.02) : choice('[L1] 2026 3분기 보고서', 0.5, 0.45)) : q.name.startsWith('ps_') ? pageStateAnswers('content', 0.95)[q.name] : { type: 'predicate', probability: 0.1 }
    return { answers, model: 'm', usage: { inputTokens: 300, cachedTokens: 0, cacheWriteTokens: 0, outputTokens: 0, totalTokens: 300 }, latencyMs: 100 }
  } }
  return { requests, client, go: () => runBrowserReflex({ cardId: 'c', goal: 'g', maxSteps: 1, callTool: async name => (name === 'egdesk_browser_observe' ? { status: 'observed', observationId: 'o', snapshot: longPage(text) } : { status: 'dispatched' }), client }) }
}

test('an undecided step on a cut page is asked once more with the full text; a short page or a decided step asks once', async () => {
  const cutText = [...Array.from({ length: 12 }, (_, i) => `row ${i} ` + 'z'.repeat(390)), 'TAILMARK the answer is here']
  const a = run(cutText); await a.go()
  const sizes = a.requests.map(r => JSON.stringify(r.input).length)
  assert.equal(a.requests.length, 2, 'one extra request')
  assert.equal(JSON.stringify(a.requests[0].input).includes('TAILMARK'), false)
  assert.equal(JSON.stringify(a.requests[1].input).includes('TAILMARK'), true)
  assert.ok(sizes[1] > sizes[0])
  const b = run(cutText, false); await b.go(); assert.equal(b.requests.length, 1, 'decided: no second request')
  const c = run(['short TAILMARK']); await c.go(); assert.equal(c.requests.length, 1, 'nothing was cut: no second request (undecided as before)')
})

test('a finished page keeps more of itself (16 lines, 1600 chars)', () => {
  assert.equal(MAX_PAGE_LINES, 16)
  const lines = Array.from({ length: 30 }, (_, i) => `line ${i}`)
  assert.equal(pageLines(lines).length, 16)
  assert.equal(pageLines(['q'.repeat(300)])[0].length, 160)
})

const wide = Array.from({ length: 60 }, (_, i) => el(`f${i}`, 'textbox', `Field ${i}`))
const page = { url: 'https://p.example/', title: 'Order', text: Array.from({ length: 12 }, (_, i) => `Body ${i}`), interactiveElements: wide }
const provider = { reflexScope: () => ({ callTool: async () => ({ snapshot: page }) }) }
test('ONE card is quoted up to 40 controls and 8 lines; two cards keep the narrow quote', async () => {
  const one = await observeCardLines({ provider, run: {}, message: 'm', cards: [{ cardId: 'a', host: 'p.example' }], enabled: true })
  assert.equal(one[0].quoteWide, true)
  const q = JSON.stringify(entryQuestions(one))
  assert.ok(q.includes('Field 38') && !q.includes('Field 44') && q.includes('Body 7') && !q.includes('Body 8'), `${ENTRY_SINGLE_CONTROLS} controls, ${ENTRY_SINGLE_LINES} lines`)
  const two = await observeCardLines({ provider, run: {}, message: 'm', cards: [{ cardId: 'a', host: 'p.example' }, { cardId: 'b', host: 'q.example' }], enabled: true })
  assert.equal(two[0].quoteWide, undefined)
  const q2 = JSON.stringify(entryQuestions(two))
  assert.ok(q2.includes('Field 14') && !q2.includes('Field 17') && q2.includes('Body 2') && !q2.includes('Body 3'))
})

test('a list of 64 options is offered whole (was the first 32); steps so far reach 16 lines', async () => {
  const { buildReflexCandidates } = await import('./egdesk-browser-reflex.mjs')
  const select = n => ({ url: 'https://p.example/', text: [], interactiveElements: [{ ref: 's', role: 'combobox', tag: 'select', label: '배달 시간', value: 'v0', selectedLabel: 't0', choice: { regionLabels: [] }, options: Array.from({ length: n }, (_, i) => ({ label: `t${i}`, value: `v${i}`, disabled: false })) }] })
  assert.equal(buildReflexCandidates(select(48)).options.length, 47, '48 options, the selected one is not offered again: all of them, the old cap offered 31')
  assert.equal(buildReflexCandidates(select(80)).options.length, 63, 'cut at 64 (minus the selected one)')
  const reqs = []
  const history = Array.from({ length: 20 }, (_, i) => `step ${i}`)
  const { decideReflexStep } = await import('./egdesk-browser-reflex.mjs')
  const snap = { url: 'https://p.example/', text: ['x'], interactiveElements: [] }
  await decideReflexStep({ goal: 'g', snapshot: snap, options: [], history, client: { decide: async r => { reqs.push(JSON.stringify(r.input)); throw new Error('stop') } }, thresholds: { choice: 0.75, margin: 0.2 } }).catch(() => {})
  assert.ok(reqs[0].includes('step 19') && reqs[0].includes('step 4') && !reqs[0].includes('step 3\\n'), 'the last 16')
})
