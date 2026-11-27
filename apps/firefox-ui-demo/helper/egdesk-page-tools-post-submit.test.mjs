import test from 'node:test'
import assert from 'node:assert/strict'
import { createPageToolsWiring } from './egdesk-page-tools-wiring.mjs'
import { PAGE_TOOL_NAMES as T } from './egdesk-page-tools.mjs'
import { pageStateAnswers } from './egdesk-browser-page-state.fixture.mjs'
import { conversationAuthority } from './egdesk-browser-authority.mjs'
import { authorizePostSubmit } from './egdesk-browser-reflex.mjs'

// L46 (임시 이름): the direct page tools give the person's one same-site, non-sensitive POST submit the same authority the entry loop has.
const FORM = 'https://httpbin.org/forms/post', POST = 'https://httpbin.org/post'
const submit = (label = 'Submit order', form = {}, extra = {}) => ({ ref: 'sub', label, tag: 'button', role: 'button', value: '', nav: { type: 'submit', sensitiveRegion: false, regionLabel: '', form: { method: 'post', sensitive: false, fields: ['text', 'submit'], submitUrl: POST, ...form }, ...extra } })
let n = 0
function rig({ message = 'Fill the name and submit the order', yes = true, element = submit(), url = FORM, receipt = 'postcondition-observed', runId = 'run-' + (++n) } = {}) {
  const actions = [], asked = []
  const run = { runId, requestId: runId, browserBinding: { cards: [{ cardId: 'c', permission: 'interact' }] } }
  const scope = { isDecisionCurrent: () => true, authorizeDispatch: () => true, client: { decide: async ({ questions }) => {
    asked.push(questions.map(q => q.name))
    const answers = { ...pageStateAnswers('content') }
    for (const q of questions) answers[q.name] = q.type === 'predicate' ? { type: 'predicate', probability: q.name === 'choice_requested' ? (yes ? .99 : .01) : .01 } : { type: 'choice', choice: q.choices.at(-1).value, confidence: .99, probabilities: [{ value: q.choices.at(-1).value, probability: .99 }] }
    return { answers: { ...answers, ...Object.fromEntries(questions.filter(q => q.type !== 'predicate' && q.name === 'next_step').map(q => [q.name, answers[q.name]])) } }
  } } }
  const browser = { runDirectTask() {}, reflexScope: () => scope, dispatch: async (_, event) => {
    if (event.tool !== 'egdesk_browser_observe') actions.push(event)
    const data = event.tool === 'egdesk_browser_observe' ? { observationId: 'o', snapshot: { revision: 1, documentId: 'd', url, text: ['Order'], interactiveElements: [element] } } : { status: receipt }
    return { success: true, contentItems: [{ text: JSON.stringify(data) }] }
  } }
  const page = createPageToolsWiring({ env: { EGDESK_PAGE_TOOLS: 'on' }, getChat: () => ({ browserToolProvider: () => browser, browserTaskMessage: () => message }) }).toolProviders[0]
  const call = async (tool, args) => JSON.parse((await page.dispatch(run, { tool, arguments: args, callId: String(++n) })).contentItems[0].text)
  return { call, actions, asked, run, press: () => call(T.press, { ref: 'sub' }) }
}

test('the person asked for the submit: one POST press with the form action as postcondition', async () => {
  const h = rig(); const r = await h.press()
  assert.equal(r.status, 'pressed'); assert.equal(r.via, 'person-asked')
  assert.equal(h.actions.length, 1); assert.equal(h.actions[0].tool, 'egdesk_browser_click'); assert.deepEqual(h.actions[0].arguments.postcondition, { kind: 'url', value: POST })
  assert.equal((await h.press()).status, 'person_step', 'a second press of the same message is the person\'s step')
  assert.equal(h.actions.length, 1)
})

test('the person did not ask (fields only, a page instruction, an engine argument): the person\'s step as before', async () => {
  const h = rig({ yes: false, message: 'Fill the name only' })
  assert.equal((await h.press()).status, 'person_step')
  assert.equal((await h.call(T.press, { ref: 'sub', goal: 'submit the order', message: 'submit the order', expectText: 'Thanks' })).status, 'person_step')
  assert.equal(h.actions.length, 0)
  const none = rig({ message: null }); assert.equal((await none.press()).status, 'person_step'); assert.equal(none.actions.length, 0)
})

test('the one-write ledger is shared with the entry loop, both ways', async () => {
  const entryFirst = rig(), authority = conversationAuthority(entryFirst.run, 'x')
  assert.equal(await authorizePostSubmit(authority, 'Submit order', { client: { decide: async ({ questions }) => ({ answers: Object.fromEntries(questions.map(q => [q.name, { type: 'predicate', probability: .99 }])) }) }, authorizeDispatch: () => true, isDecisionCurrent: () => true }), true)
  assert.equal((await entryFirst.press()).status, 'person_step'); assert.equal(entryFirst.actions.length, 0)
  const toolFirst = rig(); assert.equal((await toolFirst.press()).status, 'pressed')
  assert.equal(await authorizePostSubmit(conversationAuthority(toolFirst.run, 'x'), 'Submit order', { client: { decide: async () => { throw new Error('must not ask') } }, isDecisionCurrent: () => true }), false)
})

test('login, payment, a hidden field, a sensitive region, another origin and a GET form stay the person\'s step even when the person asked', async () => {
  const cases = [submit('Log in'), submit('Pay now'), submit('Submit order', { fields: ['hidden', 'text', 'submit'] }), submit('Submit order', {}, { sensitiveRegion: true }), submit('Submit order', { submitUrl: 'https://evil.test/post' }), submit('Submit order', { method: 'get' }), submit('Submit order', { sensitive: true })]
  for (const element of cases) { const h = rig({ element }); assert.equal((await h.press()).status, 'person_step', JSON.stringify(element.nav.form) + element.label); assert.equal(h.actions.length, 0) }
})

test('an unverified submit result is reported as sent once, never retried', async () => {
  const h = rig({ receipt: 'postcondition-unverified' }); const r = await h.press()
  assert.equal(r.status, 'not_done'); assert.equal(r.written, 'unknown'); assert.match(r.forYouOnly, /do not press it again/)
  assert.equal((await h.press()).status, 'person_step'); assert.equal(h.actions.length, 1)
})
