import test from 'node:test'
import assert from 'node:assert/strict'
import { conversationAuthority } from './egdesk-browser-authority.mjs'
import { runBrowserReflex } from './egdesk-browser-reflex.mjs'
import { pageStateAnswers } from './egdesk-browser-page-state.fixture.mjs'

// L46 (임시 이름): a shaky next_step (the submit top at .69, under the bar) is settled by the SAME post-submit predicate the press needs; it never lowers the bar.
const FORM = 'https://httpbin.org/forms/post', POST = 'https://httpbin.org/post'
let n = 0
function rig({ post = .99, top = .69, name = '' } = {}) {
  const clicks = [], questions = []
  const snap = () => ({ url: FORM, revision: 1, documentId: 'd', readyState: 'complete', text: ['지금 주문하세요'], interactiveElements: [
    { ref: 'f', label: 'Customer name', tag: 'input', role: 'textbox', type: 'text', value: name },
    { ref: 'sub', label: 'Submit order', tag: 'button', role: 'button', value: '', nav: { type: 'submit', sensitiveRegion: false, regionLabel: '', form: { method: 'post', sensitive: false, fields: ['text', 'submit'], submitUrl: POST } } }] })
  const client = { decide: async req => {
    questions.push(req.questions.map(q => q.name)); const next = req.questions.find(q => q.name === 'next_step'), pq = req.questions.find(q => q.name === 'post_requested')
    const answers = { ...pageStateAnswers('content', .99) }
    if (next) { const sub = next.choices.find(c => /Submit order/.test(c.value)).value, other = next.choices.find(c => !/Submit order/.test(c.value)).value
      answers.next_step = { type: 'choice', choice: sub, confidence: top, probabilities: [{ value: sub, probability: top }, { value: other, probability: 1 - top }] } }
    for (const q of req.questions) if (q.type === 'predicate' && !answers[q.name]) answers[q.name] = { type: 'predicate', probability: q.name === 'post_requested' ? post : q.name === 'choice_requested' ? 1 : .01 }
    if (pq) answers.post_requested = { type: 'predicate', probability: post }
    return { answers } } }
  const callTool = async (tool, a) => { if (tool.endsWith('_observe')) return { observationId: 'o', snapshot: snap() }; if (tool.endsWith('_click')) { clicks.push(a); return { status: 'postcondition-observed' } } throw new Error(tool) }
  const run = goal => runBrowserReflex({ authority: conversationAuthority({ requestId: 'm-ps-' + (++n), runId: 'r' }, goal), cardId: 'c', goal, textComboboxes: true, callTool, client, isDecisionCurrent: () => true, maxSteps: 2 })
  return { run, clicks, questions }
}
test('a decided post_requested yes settles the shaky submit step (one press), the question carries the form\'s field values', async () => {
  const h = rig({ name: '차민수' }), r = await h.run('이름 차민수로 채우고 주문 제출해줘')
  assert.equal(r.outcome, 'done'); assert.equal(h.clicks.length, 1); assert.ok(h.questions[0].includes('post_requested'))
})
test('without the decided yes (not requested / below the bar) the step stays undecided and nothing is pressed', async () => {
  for (const post of [.5, .7, .01]) { const h = rig({ post, name: '차민수' }), r = await h.run('이름만 채우고 제출하지 마'); assert.notEqual(r.outcome, 'done', String(post)); assert.equal(h.clicks.length, 0) }
})
