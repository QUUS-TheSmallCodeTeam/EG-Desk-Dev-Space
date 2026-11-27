import test from 'node:test'
import assert from 'node:assert/strict'
import { conversationAuthority } from './egdesk-browser-authority.mjs'
import { postArrived, runBrowserReflex } from './egdesk-browser-reflex.mjs'
import { subjectiveNote } from './egdesk-browser-task.mjs'

const FORM = 'https://httpbin.org/forms/post', POST = 'https://httpbin.org/post'
const run = { requestId: 'm-arrival', runId: 'r', conversationId: 'dm', browserBinding: { cards: [{ cardId: 'c', permission: 'interact' }] } }
const snap = { url: FORM, revision: 1, documentId: 'd', readyState: 'complete', text: ['Order'], interactiveElements: [
  { ref: 'submit', label: 'Submit order', tag: 'button', role: 'button', value: '', nav: { type: 'submit', sensitiveRegion: false, regionLabel: '',
    form: { method: 'post', sensitive: false, fields: ['text', 'submit'], submitUrl: POST } } }] }
const client = { decide: async req => ({ answers: Object.fromEntries(req.questions.map(q => [q.name, q.type === 'predicate'
  ? { type: 'predicate', probability: q.name === 'choice_requested' ? 1 : 0 }
  : { type: 'choice', choice: '[B1] Submit order', confidence: 1, probabilities: [{ value: '[B1] Submit order', probability: 1 }] }])) }) }
// 임시 이름: the arrived document (Firefox JSON viewer) cannot be observed; the error of wait/observe carries the parent's top-level address (or none)
function replay(id, arrival) {
  const calls = []
  const callTool = async name => {
    calls.push(name)
    if (name.endsWith('_observe') && calls.filter(n => n.endsWith('_observe')).length === 1) return { observationId: 'o', snapshot: snap }
    if (name.endsWith('_click')) return { status: 'postcondition-unverified' }
    throw Object.assign(new Error('unobservable'), { code: 'BROWSER_WAIT_OUTCOME_UNKNOWN', ...(arrival ? { arrival: { url: arrival } } : {}) })
  }
  return runBrowserReflex({ authority: conversationAuthority({ ...run, requestId: id }, 'Fill the name and submit the order'), cardId: 'c', goal: 'Fill the name and submit the order',
    textComboboxes: true, callTool, client, isDecisionCurrent: () => true, maxSteps: 1 }).then(result => ({ result, calls }))
}

test('postArrived: same origin and path as the form action, and not the form page itself', () => {
  assert.equal(postArrived(POST, POST, FORM), true)
  assert.equal(postArrived(POST + '?x=1', POST, FORM), true)
  for (const [arrived, to, from] of [[null, POST, FORM], ['', POST, FORM], ['https://httpbin.org/anything', POST, FORM], ['https://evil.test/post', POST, FORM],
    [FORM, POST, FORM], ['about:blank', POST, FORM], ['javascript:1', POST, FORM], [POST, POST, POST]]) assert.equal(postArrived(arrived, to, from), false, String(arrived))
})

test('POST submit whose arrived document cannot be observed: done, with the unobserved arrival kept as a fact', async () => {
  const { result, calls } = await replay('m-ok', POST)
  assert.equal(result.outcome, 'done'); assert.equal(result.url, POST); assert.equal(result.arrivalUnobserved, true)
  assert.equal(calls.filter(n => n.endsWith('_click')).length, 1)
})

test('POST submit arriving at another address is still a failure', async () => {
  for (const [id, to] of [['m-other', 'https://httpbin.org/anything'], ['m-origin', 'https://evil.test/post'], ['m-same', FORM]]) {
    const { result, calls } = await replay(id, to)
    assert.notEqual(result.outcome, 'done', id); assert.equal(result.arrivalUnobserved, undefined)
    assert.equal(calls.filter(n => n.endsWith('_click')).length, 1, id)
  }
})

test('POST submit with no move reported (no address) is still a failure and never presses twice', async () => {
  const { result, calls } = await replay('m-none', null)
  assert.equal(result.outcome, 'escalated'); assert.equal(result.reason, 'tool_failed'); assert.equal(result.arrivalUnobserved, undefined)
  assert.equal(calls.filter(n => n.endsWith('_click')).length, 1)
})

test('the task note keeps the unobserved arrival as a closed-vocabulary fact only on a done task', () => {
  const task = { taskId: 't', steps: 1, actions: {}, goalChanges: 0 }
  assert.equal(subjectiveNote(task, { status: 'done', arrivalUnobserved: true }).includes('arrivalUnobserved'), true)
  assert.equal(subjectiveNote(task, { status: 'done' }).includes('arrivalUnobserved'), false)
  assert.equal(subjectiveNote(task, { status: 'cannot_proceed', arrivalUnobserved: true }).includes('arrivalUnobserved'), false)
})

test('the surface adds the top-level address only to a rejected observe reply, http(s) only', async () => {
  const { readFile } = await import('node:fs/promises')
  const src = await readFile(new URL('../overlay/JS/eg-desk-surface.uc.js', import.meta.url), 'utf8')
  const at = src.indexOf("if (request.kind === 'observe') {\n          try {\n            const spec = document.getElementById(request.cardId)")
  assert.ok(at > 0)
  const block = src.slice(at, at + 420)
  assert.match(block, /currentURI\?\.spec/); assert.match(block, /\^https\?:/); assert.match(block, /rejected\.topLocation = \{ url: spec \}/)
})
