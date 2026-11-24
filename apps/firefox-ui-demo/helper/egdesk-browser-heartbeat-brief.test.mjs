import test from 'node:test'
import assert from 'node:assert/strict'
import { createBrowserTaskStore, createDirectBrowserEntry } from './egdesk-browser-task.mjs'
import { runBrowserReflex, PAGE_STATE_CHECKS } from './egdesk-browser-reflex.mjs'
import { browserTaskLines, messageEvidence, runContext, TASK_LAST, BRIEF_GOAL_LIMIT } from './egdesk-conversation-flow.mjs'
import { normalizeEntry } from './egdesk-decision-calibration-log.mjs'
import { pageStateAnswers } from './egdesk-browser-page-state.fixture.mjs'

// L8 c18: what the heartbeat's note judgment is told about a running browser task (R1), under the run's egress gate, and the
// step-level calibration records (owner decision 5: closed words and numbers only). Synthetic pages, scripted answers; nothing is sent.
const O = 'https://portal.example.test'
const GOAL = '거래처 포털에서 이번 달 세금계산서 내려받아줘'
const el = (ref, role, label, extra = {}) => ({ ref, role, label, tag: role === 'link' ? 'a' : 'button', href: '', value: '', ...extra })
const PAGES = { '/invoices': [el('b1', 'link', '사업자 123-45-67890', { href: `${O}/biz/1` }), el('b2', 'link', '사업자 987-65-43210', { href: `${O}/biz/2` }), el('s1', 'button', '발행 제출')],
  '/home': [el('h1', 'link', '세금계산서 조회', { href: `${O}/invoices` })] }
const pick = (value, p = 0.95) => ({ type: 'choice', choice: value, confidence: p, probabilities: [{ value, probability: p }] })
const ALL = () => true
const setOf = lines => (lines.kinds instanceof Set ? [...lines.kinds].sort() : [])

function world({ start = '/home', hold = null } = {}) {
  let cur = start, docs = 0
  const raw = [], briefs = []
  const callTool = async (name, args) => {
    if (name === 'egdesk_browser_observe') return { observationId: `o${docs}`, snapshot: { cardId: 'card', documentId: `d${docs}`, revision: 1, url: `${O}${cur}`, readyState: 'complete', text: ['합성 포털'], interactiveElements: PAGES[cur] ?? [] } }
    if (name === 'egdesk_browser_navigate') { if (hold) await hold(); cur = new URL(args.url).pathname; docs++ }
    return { status: 'ok' }
  }
  const client = { decide: async request => {
    const names = request.questions.map(q => q.name), text = request.input.map(m => m.content).join('\n')
    if (names.includes('browser_entry')) return { answers: { browser_entry: pick(request.questions[0].choices[0].value) } }
    const values = request.questions.find(q => q.name === 'next_step')?.choices.map(c => c.value) ?? []
    const next = /\/home/.test(text) ? pick('[L1] 세금계산서 조회', 0.97)
      : { ...pick('needs_user_context', 0.88), probabilities: [{ value: 'needs_user_context', probability: 0.9 }, ...values.filter(v => /^\[L\d\]/.test(v)).map(value => ({ value, probability: 0.04 }))] }
    return { answers: { next_step: next, ...pageStateAnswers('content', 0.98), goal_met: { type: 'predicate', probability: 0.02 } } }
  } }
  const store = createBrowserTaskStore()
  const provider = { directEntryEnabled: () => true, reflexScope: () => ({ client, authorizeDispatch: () => true, isDecisionCurrent: () => true }),
    runDirectTask: async (_run, args) => runBrowserReflex({ cardId: 'card', goal: args.goal, maxSteps: args.maxSteps, userContext: args.userContext, onStep: info => { args.onStep?.(info); briefs.push(store.brief('dm')) }, callTool, client }) }
  const entry = createDirectBrowserEntry({ provider, store, calibration: { record: r => raw.push(r) } })
  const say = message => entry.handle({ run: { runId: 'r', browserBinding: { cards: [{ cardId: 'card', permission: 'interact' }] } }, conversationKey: 'dm', message, hosts: { card: 'portal.example.test' } })
  return { say, store, raw, briefs }
}

test('brief: the goal (bounded), the card host, the steps and the last closed outcome as the task runs, pauses and is asked; facts() still carry none of it', async () => {
  const w = world()
  const out = await w.say(GOAL)
  assert.equal(out.status, 'paused')
  // while it ran: started, then the opened link
  assert.deepEqual(w.briefs.map(b => [b.status, b.last, b.host]).slice(0, 2), [['running', 'started', 'portal.example.test'], ['running', 'opened_link', 'portal.example.test']])
  const paused = w.store.brief('dm')
  assert.deepEqual([paused.goal, paused.host, paused.stepsDone, paused.status, paused.last, paused.asked], [GOAL, 'portal.example.test', 2, 'paused', 'choice_needed', false])
  w.store.markAsked(w.store.paused('dm'), true)
  assert.equal(w.store.brief('dm').asked, true)
  assert.doesNotMatch(JSON.stringify(w.store.facts('dm')), /세금|portal|example/, 'the heartbeat facts stay content-free')
  const long = world(); await long.say(`${GOAL} `.repeat(20))
  assert.ok(long.store.brief('dm').goal.length <= 160)
  assert.equal(createBrowserTaskStore().brief('dm'), null)
})

test('lines under the egress gate: the closed step line always; the goal only as browser_task_record; the host only as page_text; nothing malformed', () => {
  const brief = { goal: GOAL, host: 'portal.example.test', stepsDone: 1, last: 'opened_link' }
  const only = kinds => kind => kinds.includes(kind)
  const none = browserTaskLines(brief, only([]))
  assert.deepEqual([none.lines, setOf(none)], [['The task in the browser: 1 page step so far; its last step opened a link on the site.'], []])
  assert.deepEqual(setOf(browserTaskLines(brief, only(['browser_task_record']))), ['browser_task_record'])
  assert.deepEqual(browserTaskLines(brief, only(['page_text'])).lines.at(-1), 'It works on the site portal.example.test.')
  assert.deepEqual(setOf(browserTaskLines(brief, ALL)), ['browser_task_record', 'page_text'])
  for (const host of ['https://portal.example.test', 'portal.example.test/invoices', 'Portal Example', '']) assert.equal(browserTaskLines({ ...brief, host }, ALL).lines.some(l => /^It works on the site/.test(l)), false, host)
  assert.equal(browserTaskLines({ ...brief, last: '<script>' }, ALL).lines[0], 'The task in the browser: 1 page step so far.')
  assert.ok(browserTaskLines({ ...brief, goal: '가'.repeat(500) }, ALL).lines[1].length < BRIEF_GOAL_LIMIT + 60)
  for (const code of ['choice_needed', 'confirm_needed', 'login_required', 'page_unclear']) assert.ok(TASK_LAST[code], code)
  assert.deepEqual(browserTaskLines(null, ALL).lines, [])
})

const HB = (extra = {}) => ({ sinceUserMs: 22000, sinceEngineMs: 22000, internalMs: 22000, stepsDone: 1, phase: 'objective_step', sources: { browser_task: { active: true, task: 'running', phase: 'objective_step', stepsDone: 1, lastActionAgeMs: 4000 } }, ...extra })
test('R1: without the brief the judge reads only "a task in the browser is still going"; with it, what the task does, where, and how far', () => {
  const run = { activities: [] }, brief = { goal: GOAL, host: 'portal.example.test', stepsDone: 1, last: 'opened_link' }
  const bare = runContext({ run, heartbeatFacts: HB(), flow: { sent: [] }, facts: {}, userText: '두 번째 사업자로', allows: k => k === 'run_text' })
  assert.match(bare.text, /a task in the browser is still going/); assert.doesNotMatch(bare.text, /goal|site|page step/)
  const told = runContext({ run, heartbeatFacts: HB(), flow: { sent: [] }, facts: {}, userText: '두 번째 사업자로', allows: ALL, browserTask: brief })
  assert.match(told.text, /- The task in the browser: 1 page step so far; its last step opened a link on the site\.\n- The browser task's goal, as the person asked it: "거래처 포털에서 이번 달 세금계산서 내려받아줘"\n- It works on the site portal\.example\.test\./)
  assert.deepEqual(told.kinds.sort(), ['browser_task_record', 'page_text', 'run_text'], 'the kinds the request declares, each checked by the run\'s gate')
  // a run without a browser task row gets no brief lines even if one is passed
  const noTask = runContext({ run, heartbeatFacts: HB({ sources: {} }), flow: { sent: [] }, facts: {}, userText: 'x', allows: ALL, browserTask: brief })
  assert.doesNotMatch(noTask.text, /browser task's goal/)
  // the check's evidence is built from the same lines, so a message naming the portal can be supported
  const evidence = messageEvidence({ kind: 'explain_wait', run, heartbeatFacts: HB(), flow: { sent: [] }, userText: '두 번째 사업자로', allows: ALL, browserTask: brief })
  assert.match(evidence.find(i => i.id === 'now').text, /It works on the site portal\.example\.test\./)
  const closed = messageEvidence({ kind: 'explain_wait', run, heartbeatFacts: HB(), flow: { sent: [] }, userText: 'x', allows: k => k === 'run_text', browserTask: brief })
  assert.doesNotMatch(closed.find(i => i.id === 'now').text, /portal|세금/)
})

test('calibration (owner decision 5): one record per step with the next-step choice, the six page-state predicates and goal_met; closed words and numbers only', async () => {
  const w = world()
  await w.say(GOAL)
  const [entry, ...steps] = w.raw.map(r => normalizeEntry(r, Date.parse('2026-11-25T00:00:00Z')))
  assert.equal(entry.judgments[0].q, 'choice')
  assert.equal(steps.length, 2)
  for (const step of steps) {
    assert.deepEqual(step.judgments.map(j => j.q), ['next_step', ...PAGE_STATE_CHECKS.map(c => c.name), 'goal_met'])
    assert.ok(step.judgments.slice(1, 7).every(j => j.would === 'none' && j.p === 0.02 && j.threshold === 0.7))
  }
  assert.deepEqual(steps.map(s => [s.judgments[0].would, s.judgments[0].confidence, s.judgments[0].options]), [['act', 0.97, 6], ['hold', 0.88, 7]])
  assert.doesNotMatch(JSON.stringify(w.raw.slice(1)), /세금|사업자|portal|example|https?:|\/invoices|\/home/, 'the raw step records hold nothing of the page')
})
