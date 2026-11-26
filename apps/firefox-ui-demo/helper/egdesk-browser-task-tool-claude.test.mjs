// L8 a1 ('교대'): the browser task tool as Claude calls it. REPLAY over the real runtime, Claude adapter, EG-Desk MCP server, Browser provider and page tools (the fixture's world): only the
// Claude process, the page (Google's first page as the real window showed it, D19) and the objective loop's decision model are scripted. Nothing real runs.
import test from 'node:test'
import assert from 'node:assert/strict'
import { GOOGLE_HOST, GOOGLE_PAGES, callTool, world } from './egdesk-claude-browser-world.fixture.mjs'
import { BROWSER_TASK_TOOL_NAME } from './egdesk-browser-task-tool.mjs'

const pick = (question, match) => question.choices.find(option => match(option.value))?.value ?? question.choices.at(-1).value
const choice = (name, value, p = 0.95) => ({ name, type: 'choice', choice: value, confidence: p, probabilities: [{ value, probability: p }] })
// The loop's decision model on Google: the search field first, then the read-only search button; the results page meets the goal. The field text, when asked, is the span '우산'.
function googleLoop(body) {
  const text = body.input.map(item => (typeof item.content === 'string' ? item.content : JSON.stringify(item.content))).join('\n')
  const onResults = /URL: https:\/\/www\.google\.com\/search/.test(text)
  return body.questions.map(q => {
    if (q.type === 'predicate') return { name: q.name, type: 'predicate', probability: q.name === 'goal_met' ? (onResults ? 0.96 : 0.02) : 0.02 }
    if (q.name === 'next_step') return choice(q.name, /filled \[F\d+\] 검색/.test(text) ? pick(q, v => /^\[B\d+\] Google 검색$/.test(v)) : pick(q, v => /^\[F\d+\] 검색$/.test(v)))
    if (/^field_\d+$/.test(q.name)) return choice(q.name, pick(q, v => /^\[F\d+\] 검색$/.test(v)))
    if (q.name === 'field_text') return choice(q.name, pick(q, v => v === '우산'))
    return choice(q.name, q.choices.at(-1).value)
  })
}
const listTools = async w => {
  const answer = await w.transports.at(-1).options.controlHandlers.mcp_message({ subtype: 'mcp_message', server_name: 'egdesk', message: { jsonrpc: '2.0', id: 9, method: 'tools/list' } }, { requestId: 'list-a1' })
  return answer.write.response.response.mcp_response.result.tools.map(tool => tool.name)
}

test('a1 Claude calls the task tool through the EG-Desk MCP server on the granted Card: the runtime gate passes it, the loop types where the value belongs and runs the read-only Google search', async t => {
  const w = world(t, { host: GOOGLE_HOST, pages: GOOGLE_PAGES, start: '/', hold: true, init: 'real', taskDecide: googleLoop })
  const first = await w.browserSend('구글에서 우산 검색해줘'); await w.drain()
  assert.ok((await listTools(w)).includes(BROWSER_TASK_TOOL_NAME), 'the catalog offers it in a run with an interact Card')
  const out = await callTool(w, BROWSER_TASK_TOOL_NAME, { goal: '구글에서 우산 검색', values: { 검색어: '우산' } })
  assert.equal(out.status, 'done', JSON.stringify(out))
  assert.deepEqual(out.steps.map(step => [step.op, step.target, step.ok]), [['fill', '검색', true], ['submit', 'Google 검색', true]])
  assert.equal(w.pw.state.cur.path, '/search', 'the GET search ran')
  assert.equal(out.page.host, GOOGLE_HOST)
  assert.deepEqual(w.ran, [], 'no shell command')
  w.transports.at(-1).finish(); await w.settled(first)
})

test('a1 the same with no value given: the field text is chosen among the spans of the goal ("우산"), in the same call', async t => {
  const w = world(t, { host: GOOGLE_HOST, pages: GOOGLE_PAGES, start: '/', hold: true, init: 'real', taskDecide: googleLoop })
  const first = await w.browserSend('구글에서 우산 검색해줘'); await w.drain()
  const out = await callTool(w, BROWSER_TASK_TOOL_NAME, { goal: '구글에서 우산 검색' })
  assert.equal(out.status, 'done', JSON.stringify(out))
  assert.equal(w.pw.state.cur.path, '/search')
  const asked = w.decisionBodies.find(body => body.questions.some(q => q.name === 'field_text'))
  assert.ok(asked && asked.questions[0].choices.some(option => option.value === '우산'))
  w.transports.at(-1).finish(); await w.settled(first)
})
