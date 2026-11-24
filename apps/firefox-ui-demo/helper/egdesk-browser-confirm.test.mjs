import test from 'node:test'
import assert from 'node:assert/strict'
import { runBrowserReflex } from './egdesk-browser-reflex.mjs'
import { createBrowserTaskStore, createDirectBrowserEntry } from './egdesk-browser-task.mjs'
import { normalizeEntry } from './egdesk-decision-calibration-log.mjs'
import { outcomeCandidate, parseOutcomeText } from './egdesk-browser-task-memory.mjs'
import { PAGE_STATE_CHECKS } from './egdesk-browser-reflex.mjs'
import { pageStateAnswers } from './egdesk-browser-page-state.fixture.mjs'

// L8 c17: a pause with exactly one candidate is a confirmation (confirm_needed), not a "which". Real c16 (browser-live-recorded-v2):
// the same-thing predicate answered 0.75 and the task paused as choice_needed with ONE candidate, "가나상사 (987-65-43210)".
// Synthetic pages, the product loop, scripted Decisions answers; nothing is sent.
const O = 'https://portal.example.test'
const GOAL = '거래처 포털에서 이번 달 세금계산서 내려받아줘'
const el = (ref, role, label, extra = {}) => ({ ref, role, label, tag: role === 'link' ? 'a' : 'button', href: '', value: '', ...extra })
const PAGES = {
  '/invoices': [el('b1', 'link', '다라무역 주식회사', { href: `${O}/biz/1` }), el('b2', 'link', '가나상사 주식회사', { href: `${O}/biz/2` })],
  '/invoices-two': [el('b1', 'link', '가나상사 본점', { href: `${O}/biz/1` }), el('b2', 'link', '가나상사 지점', { href: `${O}/biz/2` })],
  '/biz/2': [el('d2', 'link', '이번 달 세금계산서 다운로드', { href: `${O}/download/2.pdf` })], '/biz/1': [], '/download/2.pdf': [],
}
// last month's record, as the general memory feature hands it to the task: one strict browser-task page
const RECORD = outcomeCandidate({ taskId: 'bt_0123456789ab', goal: GOAL, host: 'portal.example.test', now: Date.parse('2026-10-19T09:00:00Z'), outcome: { status: 'done' },
  trail: [{ op: 'open', label: '가나상사', from: '/invoices', to: '/biz/2' }], resolved: [{ asked: 'choice_needed', chose: '가나상사', at: '/invoices' }] })
const MEMORY = { packet: RECORD.text, scope: null, pages: [{ id: 'browser-task/bt_0123456789ab', title: 'x', body: RECORD.text, revision: '1', provenance: { kind: 'agent_note', by: 'browser_task' }, time: { slice: 'past' }, status: 'done', scope: null }] }
const pick = (value, p = 0.95) => ({ type: 'choice', choice: value, confidence: p, probabilities: [{ value, probability: p }] })

function world({ start = '/invoices', same = 0.75 } = {}) {
  let cur = start, docs = 0
  const sent = [], acts = [], contexts = []
  const snap = () => ({ cardId: 'card', documentId: `d${docs}`, revision: 1, url: `${O}${cur}`, readyState: 'complete', text: ['세금계산서 조회'], interactiveElements: PAGES[cur] })
  const callTool = async (name, args) => {
    if (name === 'egdesk_browser_observe') return { observationId: `o${docs}`, snapshot: snap() }
    acts.push({ name, url: args.url ?? null })
    if (name === 'egdesk_browser_navigate') { cur = new URL(args.url).pathname; docs++ }
    return { status: 'ok' }
  }
  const client = { decide: async request => {
    const names = request.questions.map(q => q.name), text = request.input.map(m => m.content).join('\n')
    sent.push({ names, text })
    const answers = { ...pageStateAnswers('content'), goal_met: { type: 'predicate', probability: /download/.test(text) ? 0.95 : 0.02 } }
    if (names.includes('task_resume')) return { answers: { task_resume: pick('resume_task') } }
    if (names.includes('browser_entry')) return { answers: { browser_entry: pick(request.questions[0].choices[0].value) } }
    for (const name of names.filter(n => n.startsWith('same_'))) answers[name] = { type: 'predicate', probability: same }
    if (names.includes('next_step')) {
      const values = request.questions.find(q => q.name === 'next_step').choices.map(c => c.value)
      const url = /URL: (\S+)/.exec(text)?.[1] ?? ''
      // a real ask answer spreads the rest over the listed elements
      const ask = () => ({ ...pick('needs_user_context', 0.9), probabilities: [{ value: 'needs_user_context', probability: 0.9 }, ...values.filter(v => /^\[L\d+\]/.test(v)).map(value => ({ value, probability: 0.03 }))] })
      answers.next_step = /\/download\//.test(url) ? pick('goal_met') : /\/biz\//.test(url) ? pick(values.find(v => v.includes('다운로드')))
        : /answered: 응/.test(text) ? pick(values.find(v => v.includes('가나상사 주식회사'))) : ask()
    }
    return { answers }
  } }
  const provider = { directEntryEnabled: () => true, reflexScope: () => ({ client, authorizeDispatch: () => true, isDecisionCurrent: () => true }),
    runDirectTask: async (_run, args) => { contexts.push([...args.userContext]); return runBrowserReflex({ cardId: 'card', goal: args.goal, maxSteps: args.maxSteps, userContext: args.userContext, resumeState: args.resumeState, priorRun: args.priorRun, callTool, client }) } }
  const written = []
  const store = createBrowserTaskStore()
  const entry = createDirectBrowserEntry({ provider, store, outcomeSink: candidate => { written.push(candidate); return { status: 'stored' } } })
  const run = { runId: 'r', browserBinding: { cards: [{ cardId: 'card', permission: 'interact' }] } }
  const say = (message, memory = null) => entry.handle({ run, conversationKey: 'dm', message, hosts: { card: 'portal.example.test' }, memory })
  return { say, sent, acts, contexts, written, store }
}
const noteOf = out => JSON.parse(out.note).egdesk_browser_task

test('one candidate left (the same-thing predicate undecided at 0.75, as measured): confirm_needed naming the candidate and the recorded label; nothing opened', async () => {
  const w = world()
  const out = await w.say(GOAL, MEMORY)
  const note = noteOf(out)
  assert.deepEqual([out.status, note.status, note.code, note.candidates, note.recorded, note.next, w.acts.length], ['paused', 'need_context', 'confirm_needed', ['가나상사 주식회사'], '가나상사', 'ask_user_in_chat', 0])
  assert.ok(w.sent.some(r => r.names.includes('same_0')), 'the pair has no identifier on both sides, so it was asked about')
})

test('the confirmation answered: code names what was confirmed in the step context (a bare "응" says nothing); the taken choice is recorded as the settled choice', async () => {
  const w = world()
  await w.say(GOAL, MEMORY)
  const out = await w.say('응 맞아')
  assert.deepEqual([out.status, out.resumed, w.acts.filter(a => a.url).map(a => new URL(a.url).pathname)], ['done', true, ['/biz/2', '/download/2.pdf']])
  assert.deepEqual(w.contexts.at(-1), ['Asked to confirm "가나상사 주식회사" as the earlier choice "가나상사", the user answered: 응 맞아'])
  const step = w.sent.find(r => r.names.includes('next_step') && /answered: 응/.test(r.text))
  assert.match(step.text, /Context the user gave in the chat \(not page text\):\nAsked to confirm "가나상사 주식회사"/)
  assert.deepEqual(parseOutcomeText(w.written.at(-1).text).resolved, [{ asked: 'choice_needed', chose: '가나상사 주식회사', at: '/invoices' }])
})

test('the confirmation refused ("아니"): nothing is opened; the task asks which, and the step judged the refusal with what was asked', async () => {
  const w = world()
  await w.say(GOAL, MEMORY)
  const out = await w.say('아니, 다른 곳이야')
  const note = noteOf(out)
  assert.deepEqual([out.status, note.code, w.acts.length], ['paused', 'choice_needed', 0])
  assert.deepEqual(note.candidates, ['다라무역 주식회사', '가나상사 주식회사'], 'the listed elements of the ask answer')
  assert.ok(w.sent.some(r => r.names.includes('next_step') && /Asked to confirm "가나상사 주식회사" as the earlier choice "가나상사", the user answered: 아니/.test(r.text)))
})

test('two candidates stay a "which" (choice_needed), never a confirmation', async () => {
  const w = world({ start: '/invoices-two' })
  const res = await runBrowserReflex({ cardId: 'card', goal: GOAL, maxSteps: 1, callTool: async n => (n === 'egdesk_browser_observe'
    ? { observationId: 'o', snapshot: { cardId: 'card', documentId: 'd', revision: 1, url: `${O}/invoices`, readyState: 'complete', text: [], interactiveElements: PAGES['/invoices-two'] } } : { status: 'ok' }),
    client: { decide: async () => ({ answers: { ...pageStateAnswers('content'), goal_met: { type: 'predicate', probability: 0 }, next_step: { ...pick('needs_user_context', 0.9), probabilities: [{ value: 'needs_user_context', probability: 0.9 }, { value: '[L1] 가나상사 본점', probability: 0.05 }, { value: '[L2] 가나상사 지점', probability: 0.04 }] } } }) } })
  assert.deepEqual([res.outcome, res.candidates], ['needs_user_context', ['[L1] 가나상사 본점', '[L2] 가나상사 지점']])
  const out = await w.say(GOAL)
  assert.equal(noteOf(out).code, 'choice_needed')
})

// ---- Main's request (a82a563): a page-state predicate answer is logged, not dropped ----
test('calibration: every page-state predicate of the product is in the logged vocabulary; an unknown name is dropped', () => {
  const judgments = PAGE_STATE_CHECKS.map((check, i) => ({ q: check.name, would: i === 0 ? 'act' : 'none', p: i === 0 ? 0.92 : 0.03, threshold: 0.7 }))
  const entry = normalizeEntry({ feature: 'browser_reflex', mode: 'on', judgments: [...judgments, { q: 'ps_not_a_check', would: 'none', p: 0.1, threshold: 0.7 }] }, Date.parse('2026-11-25T00:00:00Z'))
  assert.deepEqual(entry.judgments.map(j => j.q), PAGE_STATE_CHECKS.map(c => c.name), 'all six logged, the unknown one dropped')
  assert.deepEqual(entry.judgments.map(j => [j.would, j.p, j.threshold]), judgments.map(j => [j.would, j.p, j.threshold]))
})
