// L6 a1b: the real window 11-26 17:16 (DuckDuckGo, Claude DM): Claude called the browser task tool; the objective loop observed (step 1) and its first action, the fill
// of the value it was given, was refused by the Card as not sent (BROWSER_OBSERVATION_STALE, staleBy 'target': the page actor's element check), 13 ms after a 301 ms
// decision. The loop ended the task on that first refusal and Claude did the rest itself in 22 s, its own fill going through on the same Card. A refusal before any input
// typed nothing, so the loop types the value once more on a new observation (once only). REPLAY over the real runtime, Claude adapter, MCP server, Browser provider, page
// tools and the task tool (L8 taskDecide), with the Card's own site rule (cardSites 'window'); only Claude, the page and the decision model are scripted.
import test from 'node:test'
import assert from 'node:assert/strict'
import { GOOGLE_HOST, GOOGLE_PAGES, callTool, world } from './egdesk-claude-browser-world.fixture.mjs'
import { BROWSER_TASK_TOOL_NAME } from './egdesk-browser-task-tool.mjs'

const pick = (question, match) => question.choices.find(option => match(option.value))?.value ?? question.choices.at(-1).value
const choice = (name, value, p = 0.95) => ({ name, type: 'choice', choice: value, confidence: p, probabilities: [{ value, probability: p }] })
// the loop's decision model on the search page: the value goes into the search field, then the read-only search runs; the results page meets the goal
function searchLoop(body) {
  const text = body.input.map(item => (typeof item.content === 'string' ? item.content : JSON.stringify(item.content))).join('\n')
  const onResults = /URL: https:\/\/www\.google\.com\/search/.test(text)
  return body.questions.map(q => {
    if (q.type === 'predicate') return { name: q.name, type: 'predicate', probability: q.name === 'goal_met' ? (onResults ? 0.96 : 0.02) : 0.02 }
    if (q.name === 'next_step') return choice(q.name, /filled \[F\d+\] 검색/.test(text) ? pick(q, v => /^\[B\d+\] Google 검색$/.test(v)) : pick(q, v => /^\[F\d+\] 검색$/.test(v)))
    if (/^field_\d+$/.test(q.name)) return choice(q.name, pick(q, v => /^\[F\d+\] 검색$/.test(v)))
    if (q.name === 'field_text') return choice(q.name, pick(q, v => v === '장화 신은 고양이'))
    return choice(q.name, q.choices.at(-1).value)
  })
}
const NOT_SENT = request => ({ requestId: request.requestId, status: 'rejected', error: 'Browser target changed [value]; observe again', dispatchPhase: 'not-dispatched', timing: {} })
// the Card refuses the first `refuse` fills as not sent (as the real Card did), then acts; every act and observation is recorded
function card(w, refuse) {
  const seen = { fills: [], observations: 0 }
  const send = w.pw.transport.sendToUi.bind(w.pw.transport)
  w.pw.transport.sendToUi = async request => {
    if (request.kind === 'observe') seen.observations++
    if (request.kind === 'act' && request.action?.type === 'fill') {
      seen.fills.push({ actor: request.actor ?? null, documentId: request.guard?.documentId, revision: request.guard?.revision, refused: seen.fills.length < refuse })
      if (seen.fills.length <= refuse) return NOT_SENT(request)
    }
    return send(request)
  }
  return seen
}
const stepsOf = out => (out.steps ?? []).map(step => [step.op, step.ok])

test('a1b: the task tool\'s first action, refused by the Card as not sent, is typed once more on a new observation and the task goes on to done', async t => {
  const w = world(t, { host: GOOGLE_HOST, pages: GOOGLE_PAGES, start: '/', hold: true, init: 'real', taskDecide: searchLoop, cardSites: 'window' })
  const seen = card(w, 1)
  const sent = await w.browserSend('구글 카드에서 장화 신은 고양이 검색해줘'); await w.drain()
  const out = await callTool(w, BROWSER_TASK_TOOL_NAME, { goal: '장화 신은 고양이 검색', values: { 검색어: '장화 신은 고양이' } })
  assert.equal(out.status, 'done', JSON.stringify(out))
  assert.deepEqual(seen.fills.map(fill => [fill.actor, fill.refused]), [['decision', true], ['decision', false]], 'refused once, typed once: never typed twice')
  assert.equal(w.pw.state.cur.path, '/search', 'and the read-only search ran')
  // the refusal is named in the record: the page actor's element check, and which field of it
  await w.drain()
  const failed = JSON.stringify(w.events.filter(event => JSON.stringify(event).includes('browser.tool.failed')))
  assert.match(failed, /"staleBy":"target"/); assert.match(failed, /"targetBy":"value"/)
  // the same run, the same Card binding and observation generation: the conversation model's own page tools go on right after the task
  const read = await callTool(w, 'egdesk_card_read', { mode: 'structure' })
  assert.equal(read.status, 'read', JSON.stringify(read))
  w.transports.at(-1).finish(); await w.settled(sent)
})

test('a1b: a refusal that repeats still ends the task: two attempts at most, nothing typed, the model is handed the code', async t => {
  const w = world(t, { host: GOOGLE_HOST, pages: GOOGLE_PAGES, start: '/', hold: true, init: 'real', taskDecide: searchLoop, cardSites: 'window' })
  const seen = card(w, 99)
  const sent = await w.browserSend('구글 카드에서 장화 신은 고양이 검색해줘'); await w.drain()
  const out = await callTool(w, BROWSER_TASK_TOOL_NAME, { goal: '장화 신은 고양이 검색', values: { 검색어: '장화 신은 고양이' } })
  assert.notEqual(out.status, 'done', JSON.stringify(out))
  assert.equal(seen.fills.length, 2, 'once more, never in a loop')
  assert.equal(w.pw.state.cur.path, '/', 'nothing ran')
  assert.ok(JSON.stringify(out).includes('BROWSER_OBSERVATION_STALE'), JSON.stringify(out))
  // the model's own tools still work on the same Card in the same run
  const read = await callTool(w, 'egdesk_card_read', { mode: 'structure' })
  assert.equal(read.status, 'read')
  w.transports.at(-1).finish(); await w.settled(sent)
})

test('a1b, unchanged: a first fill the Card accepts is typed once, with no extra observation', async t => {
  const w = world(t, { host: GOOGLE_HOST, pages: GOOGLE_PAGES, start: '/', hold: true, init: 'real', taskDecide: searchLoop, cardSites: 'window' })
  const seen = card(w, 0)
  const sent = await w.browserSend('구글 카드에서 장화 신은 고양이 검색해줘'); await w.drain()
  const out = await callTool(w, BROWSER_TASK_TOOL_NAME, { goal: '장화 신은 고양이 검색', values: { 검색어: '장화 신은 고양이' } })
  assert.equal(out.status, 'done', JSON.stringify(out))
  assert.deepEqual(seen.fills.map(fill => fill.refused), [false])
  assert.deepEqual(stepsOf(out).filter(([op]) => op === 'fill'), [['fill', true]])
  w.transports.at(-1).finish(); await w.settled(sent)
})
