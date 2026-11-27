import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { buildReflexCandidates, decideReflexStep, runBrowserReflex } from './egdesk-browser-reflex.mjs'
import { createDecisionClient } from './egdesk-decision-client.mjs'
import { compactText, decisionThresholds } from './egdesk-decision-questions.mjs'
import { FAMILY_PAGES } from './egdesk-browser-live-families.mjs'
import { lintGroupedRequest } from './egdesk-decision-grouping.mjs'
import { pageStateAnswers } from './egdesk-browser-page-state.fixture.mjs'

// L8 c22: real, browser-live-settings-v3 (2026-11-25): the first step (body sha256 1e50c0fb..., 2806 bytes) offered two links and the fixed
// options; the two toggles were never options and nothing said they existed; next_step answered scroll_more at 0.56. Synthetic page.
const page = FAMILY_PAGES.settings['/settings/notifications']
const SNAP = { cardId: 'card', documentId: 'doc1', revision: 1, url: 'https://account.example.test/settings/notifications', readyState: 'complete', text: page.text, viewport: { width: 1200, height: 800, devicePixelRatio: 1 }, interactiveElements: page.elements }
const REAL_NEXT = { type: 'choice', choice: 'scroll_more', confidence: 0.56, probabilities: [{ value: 'scroll_more', probability: 0.6 }, { value: 'blocked', probability: 0.2 }] }
async function step(answers, snapshot = SNAP) {
  const tools = [], sent = []
  const callTool = async name => { tools.push(name); return name === 'egdesk_browser_observe' ? { observationId: 'o1', snapshot } : { status: 'ok' } }
  const client = { decide: async request => { sent.push(request); return { answers: answers(request) } } }
  const result = await runBrowserReflex({ cardId: 'card', goal: '마케팅 알림 꺼줘', maxSteps: 1, callTool, client })
  return { result, sent, acts: tools.filter(n => n !== 'egdesk_browser_observe') }
}
const base = (extra = {}) => ({ next_step: REAL_NEXT, ...pageStateAnswers('content', 0.98), goal_met: { type: 'predicate', probability: 0.02 }, ...extra })
const P = p => ({ type: 'predicate', probability: p })

test('the FIRST step request carries nothing about the person-only controls (the v3 body, byte for byte); when it found no way forward a follow-up names them and asks one predicate per control, each quoting that control alone', async () => {
  const { sent } = await step(() => base())
  assert.equal(sent.length, 2, 'the step request, then the follow-up')
  assert.doesNotMatch(sent[0].input[1].content, /only the person may operate/)
  assert.equal(sent[0].questions.some(q => q.name.startsWith('person_target')), false)
  const req = sent[1]
  assert.match(req.input[1].content, /\n\nControls on this page that only the person may operate \(they are never options here\): "마케팅 정보 알림" \(switch, now "on"\) \/ "보안 알림" \(switch, now "on"\)$/)
  assert.deepEqual(req.questions.map(q => q.instructions),
    ['Is this control, "마케팅 정보 알림" (switch, now "on"), the one this request asks to change?', 'Is this control, "보안 알림" (switch, now "on"), the one this request asks to change?'])
  assert.equal(lintGroupedRequest({ input: req.input, questions: req.questions }).ok, true)
  // a confident next step never reaches the follow-up (the statement case: 조회 at 0.92 stays as measured before the controls were carried)
  const link = await step(() => base({ next_step: { type: 'choice', choice: '[L1] 계정 정보', confidence: 0.95, probabilities: [{ value: '[L1] 계정 정보', probability: 0.96 }] } }))
  assert.deepEqual([link.sent.length, link.acts.length > 0], [1, true], 'one request: the decided link is taken, no follow-up')
})

test('real replay: with next_step scroll_more 0.56, a decided yes on the marketing toggle makes the step the person\'s (human_step, the control named), nothing acted', async () => {
  const { result, acts } = await step(() => base({ person_target_0: P(0.93), person_target_1: P(0.04) }))
  assert.deepEqual([result.outcome, result.reason, result.target, acts], ['escalated', 'human_step', '마케팅 정보 알림', []])
  // a page-state hazard still comes first; an undecided target leaves the ordinary flow (scroll_more undecided -> uncertain), still nothing on a toggle
  const login = await step(() => base({ person_target_0: P(0.93), ...pageStateAnswers('login_required', 0.95) }))
  assert.deepEqual([login.result.outcome, login.result.pageState], ['handoff', 'login_required'])
  const unsure = await step(() => base({ person_target_0: P(0.6), person_target_1: P(0.1) }))
  assert.deepEqual([unsure.result.outcome, unsure.result.reason, unsure.acts], ['escalated', 'uncertain', []])
})

test('a page without such controls: no line, no predicate (the request bytes as before); the v3 body is reproduced when the controls are left out', async () => {
  const links = { ...SNAP, interactiveElements: page.elements.filter(e => e.role === 'link') }
  const { sent } = await step(() => base(), links)
  assert.doesNotMatch(sent[0].input[1].content, /only the person may operate/)
  assert.equal(sent[0].questions.some(q => q.name.startsWith('person_target')), false)
  let body = null
  const client = createDecisionClient({ getApiKey: async () => 'egd-synthetic-not-a-key-0008', fetchImpl: async (_u, init) => { body = init.body; return { ok: true, text: async () => JSON.stringify({ answers: [] }) } } })
  await decideReflexStep({ goal: compactText('마케팅 알림 꺼줘', 500), snapshot: SNAP, options: buildReflexCandidates(SNAP).options, today: '2026-11-19', client, thresholds: decisionThresholds() }).catch(() => null)
  assert.equal(createHash('sha256').update(body).digest('hex').slice(0, 12), '1e50c0fbab56', 'the real v3 step body, byte for byte, without the person-only controls passed')
  assert.deepEqual(buildReflexCandidates(SNAP).personOnly, [{ label: '마케팅 정보 알림', role: 'switch', value: 'on' }, { label: '보안 알림', role: 'switch', value: 'on' }])
})
