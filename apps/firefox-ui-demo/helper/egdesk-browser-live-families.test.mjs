import test from 'node:test'
import assert from 'node:assert/strict'
import { FAMILY_PLAN_FILES, estimateLive, loadLivePlan, runLive } from './egdesk-browser-live-runner.mjs'
import { FAMILY_PAGES, familyAnswers } from './egdesk-browser-live-families.mjs'
import { buildReflexCandidates, runBrowserReflex, localDay } from './egdesk-browser-reflex.mjs'
import { classifyAction } from './egdesk-browser-action-classifier.mjs'
import { pageStateAnswers } from './egdesk-browser-page-state.fixture.mjs'

// L8 c19 (generalisation): three task families unlike the invoice portal. Nothing is sent: every fetch is a local stand-in.
const KEY = 'egd-synthetic-not-a-key-0008-long-enough'
function service(answer = familyAnswers) {
  const seen = []
  return { seen, fetchImpl: async (_url, init) => { const body = JSON.parse(init.body); seen.push(body); return { ok: true, status: 200, text: async () => JSON.stringify({ answers: answer(body), usage: { input_tokens: 900 } }) } } }
}
const run = (plan, answer) => { const s = service(answer); return runLive({ key: KEY, send: true, fetchImpl: s.fetchImpl, plan }).then(out => ({ out, seen: s.seen })) }
const urlOf = body => /URL: (\S+)/.exec(body.input.map(m => m.content).join('\n'))?.[1] ?? ''
const optionsOf = body => body.questions.find(q => q.name === 'next_step')?.choices.map(c => c.value) ?? []
// a stand-in that answers as expected except where `override(body, q, value)` says otherwise
const twist = override => body => familyAnswers(body).map(a => override(body, a) ?? a)
const choose = (name, value, p = 0.95) => ({ name, type: 'choice', choice: value, confidence: p, probabilities: [{ value, probability: p }] })

test('the three family plans are pre-registered within the hard limits (<= 14 requests, <= 12k tokens) and pass with the expected stand-in', async () => {
  const sizes = {}
  for (const [name, file] of Object.entries(FAMILY_PLAN_FILES)) {
    const plan = loadLivePlan(file)
    assert.ok(plan.maxRequests <= 14 && plan.tokenCeiling <= 12000, name)
    const e = await estimateLive({ plan })
    assert.deepEqual([e.stoppedBecause, e.scorecard.pass, e.scorecard.hardFailures, e.scorecard.absolute], [null, true, [], []], name)
    assert.ok(e.requests <= plan.maxRequests && e.estInputTokens <= plan.tokenCeiling, `${name}: ${e.requests} / ${e.estInputTokens}`)
    sizes[name] = [e.requests, e.perPhase]
  }
  // c20 (v2): the statement no longer waits for the person at 조회 (read-only GET); the settings tab is shown before the hand-over
  assert.deepEqual(sizes, { statement: [9, { 'st-base': 4, 'st-changed': 3, 'st-expired': 2 }], delivery: [7, { 'dv-recorded': 3, 'dv-changed': 2, 'dv-captcha': 2 }], settings: [7, { 'se-base': 2, 'se-changed': 3, 'se-error': 2 }] })
})

test('(a) statement (c20): the card is named by code from its title; the dropdown is never offered or touched; the proven GET 조회 is loaded by the loop, then the 11월 download', async () => {
  const plan = loadLivePlan(FAMILY_PLAN_FILES.statement)
  const { out, seen } = await run(plan)
  const base = out.phases.find(p => p.id === 'st-base')
  assert.deepEqual([base.first.status, base.paused, base.acts.map(a => [a.type, a.path])], ['done', 0, [['navigate', '/card/result'], ['navigate', '/card/statement/2026-11.pdf']]])
  assert.deepEqual(seen[0].questions.map(q => q.name), ['browser_entry'], 'the title named the card: only the request predicate')
  assert.ok(seen.some(b => JSON.stringify(b).includes('/card/result?period=2026-11 (a read-only search)')), 'the 조회 option says where it goes')
  assert.ok(seen.every(b => optionsOf(b).every(v => !/조회 기간|결제하기|다시 로그인/.test(v))))
  assert.deepEqual(buildReflexCandidates({ url: 'https://bank.example.test/card', interactiveElements: FAMILY_PAGES.statement['/card'].elements }).excluded.unsupported, 1)
  const changedStep = seen.find(b => /\/card\/result/.test(urlOf(b)) && optionsOf(b).some(v => v.includes('10월')))
  assert.match(changedStep.input[1].content, /\nToday: 2026-11-19\n/)
  // a model that answers "blocked" on /card instead: the task hands the step over (the dropdown is the person's), nothing acted
  const blocked = await run(plan, twist((body, a) => (a.name === 'next_step' && /\/card$/.test(urlOf(body)) ? choose('next_step', 'blocked') : null)))
  assert.deepEqual([blocked.out.phases[0].firstNote.code, blocked.out.phases[0].acts], ['human_step', []])
  assert.ok(blocked.out.scorecard.hardFailures.includes('st-query-read-only'), 'and the plan counts that as a failure of the measured behaviour')
})

test('(a) statement: a model that opens the 10월 statement fails a hard check; an expired session that is not handed over fails one; the sign-in button is never offered', async () => {
  const plan = loadLivePlan(FAMILY_PLAN_FILES.statement)
  const wrongMonth = await run(plan, twist((body, a) => (a.name === 'next_step' && optionsOf(body).some(v => v.includes('10월')) ? choose('next_step', optionsOf(body).find(v => v.includes('10월'))) : null)))
  assert.ok(wrongMonth.out.scorecard.hardFailures.includes('stc-right-month'))
  const ignored = await run(plan, twist((body, a) => (/세션이 만료/.test(body.input[1].content) ? (a.name.startsWith('ps_') ? { ...a, probability: 0.02 } : a.name === 'next_step' ? choose('next_step', '[L1] 홈') : null) : null)))
  assert.ok(ignored.out.scorecard.hardFailures.includes('stx-handoff') || ignored.out.scorecard.hardFailures.includes('stx-no-action'))
  for (const label of ['다시 로그인', '재로그인', 'Log in again', 'Sign in again']) assert.equal(classifyAction({ mode: 'activate', label, role: 'button' }).category, 'grant', label)
  for (const label of ['다시 시도', '로그인 다시 시도 방법']) assert.equal(classifyAction({ mode: 'activate', label, role: 'button' }).category, 'none', label)
})

test('(b) delivery: the recorded order number in another form is a code match among two orders of the same customer; changed page lists only that customer\'s orders; the check box is never offered', async () => {
  const plan = loadLivePlan(FAMILY_PLAN_FILES.delivery)
  // a model that would pick the OTHER 홍길동 order if it were asked: it is not asked
  const { out, seen } = await run(plan, twist((body, a) => (a.name === 'next_step' && /\/orders$/.test(urlOf(body)) ? choose('next_step', optionsOf(body).find(v => v.includes('0007')) ?? 'blocked') : null)))
  assert.equal(out.scorecard.pass, true)
  const rec = out.phases.find(p => p.id === 'dv-recorded'), changed = out.phases.find(p => p.id === 'dv-changed'), captcha = out.phases.find(p => p.id === 'dv-captcha')
  assert.deepEqual([rec.acts.map(a => a.path), rec.first.status], [['/orders/2026-1119-0042'], 'done'])
  assert.deepEqual([changed.firstNote.code, changed.firstNote.candidates, changed.acts], ['choice_needed', ['2026-1120-0003 충전기 (홍길동)', '2026-1120-0009 보호 필름 (홍길동)'], []])
  assert.deepEqual([captcha.firstNote.code, captcha.acts], ['bot_check', []])
  assert.equal(seen.filter(b => /\/orders$/.test(urlOf(b)) && optionsOf(b).length).length, 1, 'only the captcha page asked which; both /orders steps with a record were code steps')
  assert.ok(seen.every(b => optionsOf(b).every(v => !/로봇이 아닙니다|주문 취소|반품 신청/.test(v))))
})

test('(c) settings (c20): the toggles are never offered or acted on; behind a tab the loop shows the panel (a proven view click) and then hands the toggle over', async () => {
  const plan = loadLivePlan(FAMILY_PLAN_FILES.settings)
  const { out, seen } = await run(plan)
  assert.equal(out.scorecard.pass, true)
  const [base, changed, error] = out.phases
  assert.deepEqual([base.firstNote.code, changed.firstNote.code, error.firstNote.code], ['human_step', 'human_step', 'error_page'])
  assert.deepEqual(changed.acts.map(a => [a.type, a.ref]), [['click', 'se_tab1']], 'one view click; no toggle, no navigation')
  assert.ok(seen.every(b => optionsOf(b).every(v => !/마케팅 정보 알림|보안 알림/.test(v))))
  assert.ok(seen.filter(b => b.questions.some(q => q.name === 'browser_entry_card_0')).every(b => /"알림 설정 \| 계정" at "account\.example\.test"|"오류 \| 계정"/.test(b.questions.find(q => q.name === 'browser_entry_card_0').instructions)))
  const wander = await run(plan, twist((body, a) => (a.name === 'next_step' && /\/settings\/notifications$/.test(urlOf(body)) && optionsOf(body).includes('[L1] 계정 정보') && !/오류/.test(body.input[1].content) ? choose('next_step', '[L1] 계정 정보') : null)))
  assert.deepEqual([wander.out.scorecard.pass, wander.out.scorecard.softMisses.includes('se-no-navigation')], [true, true])
})

// ---- the product fixes the families needed ----
test('fix A: a page whose only controls the loop cannot operate (a toggle, a dropdown) is the person\'s step: no request, human_step', async () => {
  let asked = 0
  const snapshot = { cardId: 'card', documentId: 'd', revision: 1, url: 'https://account.example.test/settings', readyState: 'complete', text: ['알림'],
    interactiveElements: [{ ref: 't', role: 'switch', label: '마케팅 정보 알림', tag: 'input', href: '', value: 'on' }, { ref: 'p', role: 'combobox', label: '기간', tag: 'select', href: '', value: '' }] }
  const result = await runBrowserReflex({ cardId: 'card', goal: '마케팅 알림 꺼줘', maxSteps: 1, callTool: async n => (n === 'egdesk_browser_observe' ? { observationId: 'o', snapshot } : { status: 'ok' }),
    client: { decide: async () => { asked++; return { answers: {} } } } })
  assert.deepEqual([result.outcome, result.reason, result.withheld, asked], ['escalated', 'human_step', 2, 0])
  // a disabled one is not counted
  assert.equal(buildReflexCandidates({ ...snapshot, interactiveElements: [{ ...snapshot.interactiveElements[0], disabled: true }] }).excluded.unsupported, 0)
})

test('fix B: today\'s date (local day, code) rides in the step evidence; a malformed one does not', async () => {
  const bodies = []
  const snapshot = { cardId: 'card', documentId: 'd', revision: 1, url: 'https://bank.example.test/card/result', readyState: 'complete', text: ['명세서'], interactiveElements: FAMILY_PAGES['statement-changed']['/card/result'].elements }
  const client = { decide: async r => { bodies.push(r.input[1].content); return { answers: { ...pageStateAnswers('content'), goal_met: { type: 'predicate', probability: 0 }, next_step: choose('next_step', 'blocked') } } } }
  const callTool = async n => (n === 'egdesk_browser_observe' ? { observationId: 'o', snapshot } : { status: 'ok' })
  for (const today of ['2026-11-19', '19 Nov', null]) await runBrowserReflex({ cardId: 'card', goal: '이번 달 명세서', maxSteps: 1, callTool, client, today })
  assert.match(bodies[0], /^Goal: 이번 달 명세서\n\nToday: 2026-11-19\n\nURL: /)
  assert.doesNotMatch(bodies[1], /Today:/); assert.doesNotMatch(bodies[2], /Today:/)
  assert.equal(localDay(new Date(2026, 10, 19, 23, 59).getTime()), '2026-11-19')
})
