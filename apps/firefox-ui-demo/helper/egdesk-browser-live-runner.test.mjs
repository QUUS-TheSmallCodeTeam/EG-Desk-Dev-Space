import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { ALLON_PLAN_FILE, HARD_LIMITS, LIVE_PAGES, RECORDED_PLAN_FILE, RENAMED_PLAN_FILE, estimateLive, loadLivePlan, runLive, scoreJourney } from './egdesk-browser-live-runner.mjs'

// L8 c15: the live browser measurement is safe to hand to Main. Nothing here sends: every fetch is a local stand-in.
const KEY = 'egd-synthetic-not-a-key-0008-long-enough'
const OFFICIAL = 'https://api.openai.com/v1/decisions'

// A stand-in for the Decisions service: answers like the expected journey, or as told; records what it was sent.
function service({ answer = null, status = 200, failAt = null } = {}) {
  const seen = []
  const fetchImpl = async (url, init) => {
    seen.push({ url, auth: init.headers?.authorization ?? init.headers?.Authorization ?? null, body: JSON.parse(init.body) })
    if (failAt !== null && seen.length === failAt) return { ok: false, status, text: async () => JSON.stringify({ error: { message: 'stand-in failure' } }) }
    const body = seen.at(-1).body
    const answers = (answer ?? expected)(body)
    return { ok: true, status: 200, text: async () => JSON.stringify({ answers, usage: { input_tokens: 700 } }) }
  }
  return { seen, fetchImpl }
}
const pick = (q, value, confidence = 0.95) => ({ name: q.name, type: 'choice', choice: value, confidence, probabilities: [{ value, probability: confidence }] })
function expected(body) {
  const ev = body.input.map(m => m.content).join('\n')
  return body.questions.map(q => {
    const values = (q.choices ?? []).map(c => c.value)
    if (q.name === 'browser_entry') return { name: q.name, type: 'predicate', probability: 0.95 } // c20: the request predicate
    if (/^browser_entry_card_\d+$/.test(q.name)) return { name: q.name, type: 'predicate', probability: q.name === 'browser_entry_card_0' ? 0.95 : 0.03 }
    if (q.name === 'task_resume') return pick(q, 'resume_task')
    if (q.name === 'ps_sign_in' && /URL: \S+\/login/.test(ev)) return { name: q.name, type: 'predicate', probability: 0.95 } // the sign-in page
    if (/^ps_/.test(q.name)) return { name: q.name, type: 'predicate', probability: 0.02 }
    if (q.name === 'goal_met') return { name: q.name, type: 'predicate', probability: /다운로드 완료|URL: \S+\/download\//.test(ev) ? 0.95 : 0.02 }
    if (/^same_\d+$/.test(q.name)) return { name: q.name, type: 'predicate', probability: 0.95 }
    const listed = /it is listed now as (\[L\d+\] [^\n]*?)\.(?:\n|$)/.exec(ev)
    if (/다운로드 완료|URL: \S+\/download\//.test(ev)) return pick(q, 'goal_met')
    if (listed) return pick(q, listed[1].trim())
    if (/is NOT listed now/.test(ev)) return pick(q, values.find(v => /^\[L1\]/.test(v)))
    const download = values.find(v => v.includes('다운로드'))
    if (download) return pick(q, download)
    if (/두 번째/.test(ev)) return pick(q, values.find(v => v.includes('987-65')))
    const ask = pick(q, 'needs_user_context', 0.9) // a real answer spreads the rest over the listed businesses
    for (const v of values.filter(v => /^\[L\d+\] 사업자/.test(v))) ask.probabilities.push({ value: v, probability: 0.04 })
    return ask
  })
}

test('the plan is pre-registered, within the hard limits, and the runner refuses a plan outside them', () => {
  const plan = loadLivePlan()
  assert.equal(plan.set, 'browser-live-v2')
  assert.ok(plan.maxRequests <= 14 && plan.tokenCeiling <= 12000)
  assert.deepEqual(HARD_LIMITS, { maxRequests: 14, tokenCeiling: 12000 })
  assert.deepEqual(plan.phases.map(p => p.id), ['month1', 'changed'])
  const hard = plan.checks.filter(c => c.severity !== 'soft').map(c => c.id)
  for (const id of ['m1-asks-first', 'changed-no-action', 'changed-asks-which', 'never-offered', 'never-acted', 'budget']) assert.ok(hard.includes(id), id)
  const recorded = loadLivePlan(RECORDED_PLAN_FILE).checks.filter(c => c.severity !== 'soft').map(c => c.id)
  for (const id of ['m2-no-question', 'm2-by-code', 'm2-recorded', 'r-by-code', 'r-no-question', 'never-offered', 'never-acted', 'budget']) assert.ok(recorded.includes(id), id)
  assert.equal(plan.passRule.includes('Soft checks are reported and never fail it'), true)
})

test('dry run by default: nothing is sent and no key is read; --send without a plausible key sends nothing', async () => {
  const s = service()
  assert.deepEqual([(await runLive({ fetchImpl: s.fetchImpl })).stoppedBecause, s.seen.length], ['dry_run', 0])
  assert.deepEqual([(await runLive({ key: KEY, fetchImpl: s.fetchImpl })).stoppedBecause, s.seen.length], ['dry_run', 0], 'a key alone does not send')
  for (const key of [null, '', 'short', 'has a space in it 1234567890']) assert.equal((await runLive({ key, send: true, fetchImpl: s.fetchImpl })).stoppedBecause, 'no_key')
  assert.equal(s.seen.length, 0)
})

test('the estimate (c16 shape): v2 8 requests (6 / 2), under 12k, and the expected journey passes every check', async () => {
  const e = await estimateLive()
  assert.deepEqual([e.requests, e.perPhase, e.stoppedBecause], [8, { month1: 6, changed: 2 }, null])
  assert.ok(e.estInputTokens < 12000, String(e.estInputTokens))
  assert.deepEqual([e.scorecard.pass, e.scorecard.hardFailures, e.scorecard.absolute, e.scorecard.softMisses], [true, [], [], []])
})

test('send (stand-in service): official endpoint only, the key only in the Authorization header, never in the result; the journey passes', async () => {
  const s = service()
  const out = await runLive({ key: KEY, send: true, fetchImpl: s.fetchImpl })
  assert.equal(out.sent, 8); assert.equal(out.stoppedBecause, null)
  assert.ok(s.seen.every(r => r.url === OFFICIAL))
  assert.ok(s.seen.every(r => String(r.auth).includes(KEY)), 'the key travels in the header')
  assert.ok(s.seen.every(r => !JSON.stringify(r.body).includes(KEY)), 'never in a body')
  assert.equal(JSON.stringify(out).includes(KEY), false, 'never in the result')
  assert.equal(out.usage.inputTokens, 8 * 700, 'reported usage is what is counted')
  assert.equal(out.scorecard.pass, true)
  const m1 = out.phases.find(p => p.id === 'month1'), ch = out.phases.find(p => p.id === 'changed')
  assert.deepEqual(m1.acts.map(a => a.path), ['/biz/2', '/download/2.pdf'])
  assert.deepEqual([ch.firstNote.code, ch.acts], ['choice_needed', []])
  // the resume request carries the question the person was asked (c15) and never a page address
  const resume = s.seen.find(r => r.body.questions[0].name === 'task_resume')
  assert.match(resume.body.input[1].content, /Asked: .+ 중 어느 쪽으로 할까요\?/)
  // never offered: the submit button and the cancellation link are absent from every option list
  assert.ok(s.seen.every(r => r.body.questions.every(q => (q.choices ?? []).every(c => !/발행 제출|구독 해지/.test(c.value)))))
})

test('no retries: the first failed request stops the journey; later phases count as not run, and the journey fails', async () => {
  const s = service({ failAt: 3, status: 429 })
  const out = await runLive({ key: KEY, send: true, fetchImpl: s.fetchImpl })
  assert.deepEqual([s.seen.length, out.sent, out.stoppedBecause], [3, 3, 'http_429'])
  assert.equal(out.scorecard.pass, false)
  assert.ok(out.scorecard.checks.filter(c => c.phase === 'changed').every(c => c.notRun && !c.ok))
})

test('limits are checked before each request: a ceiling the next request would cross sends nothing more', async () => {
  const plan = { ...loadLivePlan(), tokenCeiling: 1500 }
  const s = service()
  const out = await runLive({ key: KEY, send: true, fetchImpl: s.fetchImpl, plan })
  assert.equal(out.stoppedBecause, 'token_ceiling'); assert.ok(out.usage.inputTokens <= 1500)
  assert.equal(out.sent, s.seen.length)
  const few = await runLive({ key: KEY, send: true, fetchImpl: service().fetchImpl, plan: { ...loadLivePlan(), maxRequests: 2 } })
  assert.deepEqual([few.sent, few.stoppedBecause], [2, 'request_limit'])
  const tooMany = { ...loadLivePlan(), maxRequests: 99, tokenCeiling: 99999 }
  const capped = await runLive({ key: KEY, send: true, fetchImpl: service().fetchImpl, plan: tooMany })
  assert.deepEqual(capped.limits, { maxRequests: 14, tokenCeiling: 12000 }, 'the hard limits win over a plan')
})

test('a model that picks a business without asking in month 1 fails a hard check and stops the journey there', async () => {
  const eager = body => body.questions.map(q => q.name === 'next_step' && (q.choices ?? []).some(c => c.value.includes('123-45'))
    ? pick(q, q.choices.find(c => c.value.includes('123-45')).value) : expected(body).find(a => a.name === q.name))
  const s = service({ answer: eager })
  const out = await runLive({ key: KEY, send: true, fetchImpl: s.fetchImpl })
  assert.equal(out.scorecard.pass, false)
  assert.ok(out.scorecard.hardFailures.includes('m1-asks-first'))
  assert.match(out.stoppedBecause, /^failed:/)
  assert.ok(out.phases.filter(p => p.id !== 'month1').every(p => p.ran === false))
})

test('a soft miss is reported and does not fail the journey; the pages never contain a typed field', () => {
  const plan = loadLivePlan()
  const journey = { phases: [], requests: [{ answers: { next_step: { type: 'choice', confidence: 0.6 } }, optionValues: [] }], usage: { inputTokens: 1 }, limits: plan }
  const card = scoreJourney(plan, journey)
  assert.ok(card.softMisses.includes('decided'))
  for (const pages of Object.values(LIVE_PAGES)) for (const page of Object.values(pages)) assert.ok(page.elements.every(e => e.role !== 'textbox'))
  assert.match(readFileSync(new URL('../scripts/egdesk-browser-live-measure.mjs', import.meta.url), 'utf8'), /process\.env\.OPENAI_API_KEY/)
})

// ---- c16: the recorded choice by code and the page-state predicates in the live plans ----
test('c16 v2: changed-asks-which is hard; the changed-page step on /invoices is decided by code; month 2 lives in the recorded plan', async () => {
  const plan = loadLivePlan()
  for (const id of ['changed-asks-which', 'changed-by-code']) assert.equal(plan.checks.find(c => c.id === id).severity, 'hard')
  const s = service()
  const out = await runLive({ key: KEY, send: true, fetchImpl: s.fetchImpl })
  assert.equal(out.scorecard.pass, true)
  assert.deepEqual(out.phases.find(p => p.id === 'changed').firstNote.candidates, ['사업자 555-11-22222', '사업자 444-33-55555'])
  assert.equal(s.seen.filter(r => !r.body.questions.some(q => q.name === 'next_step') && r.body.questions.some(q => q.name === 'ps_sign_in')).length, 1)
})

test('c17 recorded plan v3: seeded by code; month 2 by code and written again; renamed by the same registration number, no predicate; 8 requests under 12k', async () => {
  const plan = loadLivePlan(RECORDED_PLAN_FILE)
  assert.deepEqual([plan.set, plan.phases.map(p => p.id)], ['browser-live-recorded-v3', ['month2', 'renamed']])
  assert.ok(plan.checks.some(c => c.id === 'r-by-code' && c.severity === 'hard')); assert.ok(!plan.checks.some(c => c.id === 'r-asked-same'))
  const e = await estimateLive({ plan })
  assert.deepEqual([e.requests, e.perPhase, e.scorecard.pass], [8, { month2: 4, renamed: 4 }, true]); assert.ok(e.estInputTokens < 11000, String(e.estInputTokens))
  const s = service()
  const out = await runLive({ key: KEY, send: true, fetchImpl: s.fetchImpl, plan })
  const [m2, rn] = out.phases
  assert.deepEqual([out.sent, out.scorecard.pass, m2.seeded, m2.recorded, m2.acts.map(a => a.path), rn.acts.map(a => a.path)], [8, true, 'stored', true, ['/biz/2', '/download/2.pdf'], ['/biz/2', '/download/2.pdf']])
  assert.equal(s.seen.flatMap(r => r.body.questions).filter(q => q.name.startsWith('same_')).length, 0, 'an identical registration number is never asked about')
})

test('c17 renamed plan v3 (the re-measure): 5 requests under 6k; renamed by code within the 2-step cap; the SSO buttons are never offered, the help link is, the page is handed over', async () => {
  const plan = loadLivePlan(RENAMED_PLAN_FILE)
  assert.deepEqual([plan.set, plan.maxRequests, plan.tokenCeiling, plan.phases.map(p => [p.id, p.maxSteps])], ['browser-live-renamed-v3', 6, 6000, [['renamed', 2], ['sso', 1]]])
  const e = await estimateLive({ plan })
  assert.deepEqual([e.requests, e.perPhase, e.scorecard.pass], [5, { renamed: 3, sso: 2 }, true]); assert.ok(e.estInputTokens < 6000, String(e.estInputTokens))
  const s = service()
  const out = await runLive({ key: KEY, send: true, fetchImpl: s.fetchImpl, plan })
  const [rn, sso] = out.phases
  assert.deepEqual([out.sent, out.scorecard.pass, rn.acts.map(a => a.path), rn.firstNote.code], [5, true, ['/biz/2', '/download/2.pdf'], 'step_rejected'])
  assert.deepEqual([sso.firstNote.status, sso.firstNote.code, sso.acts], ['cannot_proceed', 'login_required', []])
  const ssoStep = s.seen.find(r => r.body.questions.some(q => q.name === 'next_step') && /URL: \S+\/login/.test(r.body.input[1].content))
  const values = ssoStep.body.questions.find(q => q.name === 'next_step').choices.map(c => c.value)
  assert.ok(values.includes('[L1] 로그인 도움말')); assert.ok(values.every(v => !/카카오로 로그인|네이버로 로그인/.test(v)))
  // a sign-in page the predicates do not decide is not a silent stop: the person is asked to look (and the hard handoff check fails)
  const unsure = body => expected(body).map(a => (a.name === 'ps_sign_in' && /URL: \S+\/login/.test(body.input[1].content) ? { ...a, probability: 0.5 } : a))
  const flat = await runLive({ key: KEY, send: true, fetchImpl: service({ answer: unsure }).fetchImpl, plan })
  assert.deepEqual([flat.phases[1].firstNote.status, flat.phases[1].firstNote.code, flat.phases[1].acts], ['need_context', 'page_unclear', []])
  assert.ok(flat.scorecard.hardFailures.includes('sso-handoff'))
})

// Main's all-on journey, 2026-11-25 (evidence/main-real/c16-all-on-journey.json): the real next_step answers, replayed as they came.
const REAL_S10 = [['[L1] 사업자 123-45-67890', 0.05], ['[L2] 사업자 987-65-43210', 0.05], ['scroll_more', 0.04], ['goal_met', 0.01], ['needs_free_text', 0.05], ['needs_user_context', 0.74], ['blocked', 0.06]]
function realAllOn({ pages = 'no' } = {}) {
  return body => body.questions.map(q => {
    const ev = body.input.map(m => m.content).join('\n')
    if (/^ps_/.test(q.name)) return { name: q.name, type: 'predicate', probability: pages === 'no' ? 0.03 : 0.5 }
    if (q.name !== 'next_step') return expected(body).find(a => a.name === q.name)
    if (/URL: \S+\/invoices/.test(ev) && !/두 번째/.test(ev)) return { name: 'next_step', type: 'choice', choice: 'needs_user_context', confidence: 0.70, probabilities: REAL_S10.map(([value, probability]) => ({ value, probability })) } // s10, real
    if (/URL: \S+\/invoices/.test(ev)) return pick(q, '[L2] 사업자 987-65-43210', 1) // s11 step 1, real 1.0
    if (/URL: \S+\/biz\/2/.test(ev)) return pick(q, '[L1] 이번 달 세금계산서 다운로드', 0.99) // s11 step 2, real 0.99
    return expected(body).find(a => a.name === q.name)
  })
}
test('c16 all-on plan: the real s10 answer (needs_user_context 0.70, below the bar) now asks which with both businesses; the s11 page is not a stop', async () => {
  const plan = loadLivePlan(ALLON_PLAN_FILE)
  assert.deepEqual([plan.set, plan.phases.map(p => p.id)], ['browser-live-allon-v1', ['allon']])
  const e = await estimateLive({ plan }); assert.deepEqual([e.requests, e.scorecard.pass], [6, true])
  const out = await runLive({ key: KEY, send: true, fetchImpl: service({ answer: realAllOn() }).fetchImpl, plan })
  const p = out.phases[0]
  assert.deepEqual([p.firstNote.status, p.firstNote.code, p.firstNote.candidates, p.actsBeforeReply], ['need_context', 'choice_needed', ['사업자 123-45-67890', '사업자 987-65-43210'], 0])
  assert.deepEqual(p.acts.map(a => a.path), ['/biz/2', '/download/2.pdf'])
  assert.equal(out.scorecard.pass, true)
  // undecided page-state predicates are not a silent stop either: the person is asked to look (need_context / page_unclear)
  const flat = await runLive({ key: KEY, send: true, fetchImpl: service({ answer: realAllOn({ pages: 'flat' }) }).fetchImpl, plan })
  assert.deepEqual([flat.phases[0].firstNote.status, flat.phases[0].firstNote.code, flat.phases[0].acts], ['need_context', 'page_unclear', []])
  assert.ok(flat.scorecard.hardFailures.includes('ao-asks-which'))
})
