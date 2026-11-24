import test from 'node:test'
import assert from 'node:assert/strict'
import { buildReflexCandidates, readOnlyPress, reflexActionArgs, runBrowserReflex } from './egdesk-browser-reflex.mjs'
import { pageStateAnswers } from './egdesk-browser-page-state.fixture.mjs'

// L8 c20 (owner decision, c19 review): a button is pressed only when code proves read-only navigation. Synthetic facts; nothing is sent.
const B = 'https://bank.example.test'
const snap = elements => ({ cardId: 'card', documentId: 'd1', revision: 1, url: `${B}/card`, readyState: 'complete', text: ['카드 명세서'], interactiveElements: elements })
const getForm = (extra = {}) => ({ type: 'submit', sensitiveRegion: false, regionLabel: '', controls: null, form: { method: 'get', fields: ['select', 'hidden', 'submit'], sensitive: false, submitUrl: `${B}/card/result?period=2026-11`, ...extra } })
const button = (label, nav, extra = {}) => ({ ref: 'q', role: 'button', label, tag: 'button', href: '', value: '', ...(nav ? { nav } : {}), ...extra })
const tab = (nav, extra = {}) => ({ ref: 't', role: 'tab', label: '알림', tag: 'button', href: '', value: '', nav, ...extra })
const view = (extra = {}) => ({ type: 'button', sensitiveRegion: false, regionLabel: '', form: null, controls: { text: '마케팅 정보 알림' }, ...extra })

test('proof: a same-site GET form submission and a view-only button are read-only; every look-alike stays with the person', () => {
  const ok = (el, s = snap([el])) => readOnlyPress(el, s)
  assert.deepEqual(ok(button('조회', getForm())), { kind: 'get_form', url: `${B}/card/result?period=2026-11` })
  assert.deepEqual(ok(tab(view({ type: null }))), { kind: 'view', text: '마케팅 정보 알림' })
  assert.deepEqual(ok(button('더 보기', view())), { kind: 'view', text: '마케팅 정보 알림' })
  assert.deepEqual(ok(button('조회', { ...getForm(), regionLabel: '카드 명세서 조회' })), { kind: 'get_form', url: `${B}/card/result?period=2026-11` }, 'a statement section is not a card-details section')
  const LOOK_ALIKES = [
    ['a POST 조회 form', button('조회', { ...getForm(), form: { ...getForm().form, method: 'post' } })],
    ['a GET form with a password field', button('조회', { ...getForm(), form: { ...getForm().form, fields: ['text', 'password'], sensitive: true } })],
    ['a GET form with an e-mail field (personal data)', button('조회', { ...getForm(), form: { ...getForm().form, fields: ['email'] } })],
    ['a GET form posting off-site', button('조회', getForm({ submitUrl: 'https://other.example.org/r?x=1' }))],
    ['a GET form whose destination is delete vocabulary', button('조회', getForm({ submitUrl: `${B}/account/delete?confirm=1` }))],
    ['a GET form without a computed destination', button('조회', getForm({ submitUrl: null }))],
    ['a button inside a payment section', button('조회', { ...getForm(), regionLabel: '결제 정보' })],
    ['a button inside a permission section', button('확인', { ...view(), regionLabel: '권한 설정' })],
    ['a button inside a data-sensitive region', button('조회', { ...getForm(), sensitiveRegion: true })],
    ['a type=button inside a form that controls nothing', button('조회', { ...getForm(), type: 'button', form: null, controls: null })],
    ['a submit-type button outside a form (no explicit type=button)', button('보기', view({ type: 'submit' }))],
    ['a button reported by an older runtime (no facts)', button('조회', null)],
    ['a tab whose panel is empty', tab(view({ type: null, controls: { text: ' ' } }))],
    ['a reset button', button('초기화', { ...getForm(), type: 'reset' })],
    ['a button in a billing section', button('조회', { ...getForm(), regionLabel: 'Billing details' })],
    ['a tab in a security section', tab(view({ type: null, regionLabel: '보안 설정' }))],
  ]
  for (const [name, el] of LOOK_ALIKES) assert.equal(ok(el), null, name)
})

test('candidates and actions: the proven GET button goes as the navigation it loads; the view button as a click with its visible effect; others escalate', () => {
  const s = snap([button('조회', getForm()), tab(view({ type: null }), { ref: 't' }), button('결제하기', getForm(), { ref: 'p' }), button('조회', { ...getForm(), form: { ...getForm().form, method: 'post' } }, { ref: 'x' })])
  const { options, excluded } = buildReflexCandidates(s)
  assert.deepEqual(options.map(o => [o.value, o.description]), [
    ['[B1] 조회', 'button on this page; opens /card/result?period=2026-11 (a read-only search)'],
    ['[B2] 알림', 'tab on this page; shows another part of this page'],
    ['[B3] 조회', 'button on this page']])
  assert.equal(excluded.gated, 1, '결제하기 is never offered, whatever its form')
  const args = o => reflexActionArgs(o, { cardId: 'card', observationId: 'o', snapshot: s })
  assert.deepEqual(args(options[0]), { tool: 'egdesk_browser_navigate', args: { cardId: 'card', observationId: 'o', expectedRevision: 1, url: `${B}/card/result?period=2026-11`, postcondition: { kind: 'url', value: `${B}/card/result?period=2026-11` } } })
  assert.deepEqual([args(options[1]).tool, args(options[1]).args.postcondition], ['egdesk_browser_click', { kind: 'visible-text', value: '마케팅 정보 알림' }])
  assert.deepEqual(args(options[2]), { escalate: 'press_needs_expected_effect' }, 'the POST look-alike stays with the person')
})

test('product loop: a model that picks the proven 조회 navigates to its GET URL; one that picks the POST 조회 hands the step to the person', async () => {
  const run = async elements => {
    const tools = []
    const callTool = async (name, args) => { tools.push([name, args.url ?? args.ref ?? null]); return name === 'egdesk_browser_observe' ? { observationId: 'o1', snapshot: snap(elements) } : { status: 'ok' } }
    const client = { decide: async () => ({ answers: { ...pageStateAnswers('content'), goal_met: { type: 'predicate', probability: 0 }, next_step: { type: 'choice', choice: '[B1] 조회', confidence: 0.95, probabilities: [{ value: '[B1] 조회', probability: 0.95 }] } } }) }
    const result = await runBrowserReflex({ cardId: 'card', goal: '이번 달 카드 명세서 내려받아줘', maxSteps: 1, callTool, client })
    return { result, acts: tools.filter(([n]) => n !== 'egdesk_browser_observe') }
  }
  const get = await run([button('조회', getForm())])
  assert.deepEqual(get.acts[0], ['egdesk_browser_navigate', `${B}/card/result?period=2026-11`])
  assert.equal(get.result.steps[0].opened.to, `${B}/card/result?period=2026-11`)
  const post = await run([button('조회', { ...getForm(), form: { ...getForm().form, method: 'post' } })])
  assert.deepEqual([post.result.outcome, post.result.reason, post.acts], ['escalated', 'press_needs_expected_effect', []])
})
