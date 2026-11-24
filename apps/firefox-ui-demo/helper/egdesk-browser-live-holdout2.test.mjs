// L8 c25: the re-run of the c24 pages and the new hospital / membership families. Plans carry the pre-registration's ids; both fit 8k; every request lints;
// all seven pre-registered phases run through the real product code with the scripted stand-in (no model), so the code-determined predictions are verified
// without a send and the journeys the stand-in plays (a tab view, a read on page 2, a covered page) are proven to be reachable.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runLive, estimateLive, loadLivePlan, FAMILY_PLAN_FILES } from './egdesk-browser-live-runner.mjs'
import { familyAnswers } from './egdesk-browser-live-families.mjs'
import { HOLDOUT2_PAGES, HOLDOUT2_PHASE_DEFS, holdout2Checks } from './egdesk-browser-live-holdout2.mjs'
import { estimateTokens } from './egdesk-memory-real-plan.mjs'
import { lintGroupedRequest } from './egdesk-decision-grouping.mjs'

const PREREG = readFileSync(new URL('../scripts/egdesk-browser-live-holdout2-preregistration.md', import.meta.url), 'utf8')
const KEY = 'egd-synthetic-not-a-key-0008-long-enough'
const standIn = (set, seen = []) => async (_url, init) => { const body = JSON.parse(init.body); seen.push(body); const c = body.questions.filter(q => q.type === 'choice').length
  return { ok: true, status: 200, text: async () => JSON.stringify({ answers: familyAnswers(body, set), usage: { input_tokens: estimateTokens(c, body.questions.length - c, Buffer.byteLength(init.body)) } }) } }

test('both plans carry only pre-registered check ids, run the phases the pre-registered drop rule leaves, and fit 8k', async () => {
  const rerun = loadLivePlan(FAMILY_PLAN_FILES['holdout-rerun']), fresh = loadLivePlan(FAMILY_PLAN_FILES.holdout2)
  assert.deepEqual(rerun.phases.map(p => p.id), ['rr-ub-base', 'rr-ig-list'])
  assert.deepEqual(fresh.phases.map(p => p.id), ['hc-link', 'hc-covered', 'ms-info'], 'ms-nav and hc-tab dropped, in the pre-registered order')
  assert.deepEqual(rerun.phases.map(p => p.maxSteps), [1, 2], 'rr-ub-base cut to one step (the pre-registered cut, c26 at the owner\'s request)')
  assert.ok(!rerun.checks.some(c => c.id === 'rr-ub-this-month'), 'the second navigation is not run, so its check is not in the plan')
  for (const plan of [rerun, fresh]) {
    for (const c of plan.checks) assert.ok(PREREG.includes(`\`${c.id}\``), `${c.id} is pre-registered`)
    assert.ok(plan.tokenCeiling <= 8000)
    const est = await estimateLive({ plan })
    assert.ok(est.estInputTokens <= 8000 && est.stoppedBecause === null, `${plan.set}: ${est.estInputTokens} ${est.stoppedBecause}`)
    assert.deepEqual([est.scorecard.pass, est.scorecard.hardFailures, est.scorecard.absolute], [true, [], []])
    const seen = []
    await runLive({ key: KEY, send: true, fetchImpl: standIn(plan.set, seen), plan })
    for (const body of seen) assert.equal(lintGroupedRequest({ input: body.input, questions: body.questions }).ok, true, `${plan.set}: ${body.questions.map(q => q.name).join()}`)
  }
  assert.ok(/ms-nav.*then.*hc-tab|`ms-nav`, then `hc-tab`/s.test(PREREG), 'the drop order is pre-registered')
})

test('all seven pre-registered phases, stand-in: every code-determined prediction holds, and the journeys the stand-in plays are reachable', async () => {
  const base = loadLivePlan(FAMILY_PLAN_FILES.holdout2)
  const ids = Object.keys(holdout2Checks({ phaseOf: () => null })).filter(id => !id.startsWith('sk-')) // the c26 stuck plan has its own test below
  // the runner's own hard limits (14 requests, 12k tokens) hold here too: the seven phases run as three journeys
  const groups = [['rr-ub-base', 'rr-ig-list'], ['hc-link', 'hc-tab'], ['hc-covered', 'ms-info', 'ms-nav']]
  const outs = []
  for (const group of groups) {
    const plan = { ...base, phases: HOLDOUT2_PHASE_DEFS.filter(p => group.includes(p.id)), checks: ids.map(id => ({ id, phase: 'all', severity: 'soft', note: 'x' })) }
    outs.push(await runLive({ key: KEY, send: true, fetchImpl: standIn('browser-live-holdout-rerun-v1'), plan }))
  }
  const held = new Set(outs.flatMap(o => o.scorecard.checks.filter(c => c.ok).map(c => c.id)))
  const bad = ids.filter(id => !held.has(id))
  // the stand-in is not a model: it reads the c24 form page as the pre-registration predicts a model will NOT (so the predicted miss is the stand-in's hit)
  assert.deepEqual(bad.filter(id => id !== 'rr-ig-form-handover'), [], outs.map(o => o.stoppedBecause).join())
  const out = { requests: outs.flatMap(o => o.requests), phases: outs.flatMap(o => o.phases) }
  const opts = phase => out.requests.filter(r => r.phase === phase && r.optionValues.length).map(r => r.optionValues.filter(v => /^\[/.test(v)))
  assert.deepEqual(opts('rr-ub-base')[0], ['[B1] 확인', '[L1] 이용 안내'])
  assert.deepEqual(opts('rr-ig-list')[0], ['[L1] 주민등록표 등본 교부', '[L2] 주민등록표 초본 교부', '[L3] 가족관계증명서 발급', '[L4] 발급 수수료 안내'])
  assert.deepEqual(opts('hc-link')[0], ['[L1] 예약 내역 보기', '[L2] 진료 기록 보기', '[L3] 병원 소개'], '로그아웃 is delete vocabulary')
  assert.deepEqual(opts('hc-link')[1], ['[B1] 예약 변경', '[L1] 마이페이지'], '예약 취소 is withheld; 예약 변경 is in no vocabulary and is offered (unproven: if chosen the step escalates, nothing is clicked)')
  assert.deepEqual(opts('hc-covered')[0], ['[L1] 예약 내역 보기'])
  assert.deepEqual(opts('ms-info')[0], ['[L1] 고객센터'], '멤버십 해지 is delete, 결제 수단 변경 and 결제 내역 are pay vocabulary')
  const phase = id => out.phases.find(p => p.id === id)
  assert.equal(phase('hc-link').first.status, 'done')
  assert.deepEqual(phase('ms-info').acts, [], 'the date is on the first page: done with no action')
  assert.equal(phase('hc-tab').acts[0].ref, 'hc_t2', 'the view-only tab is clicked, then the list is read')
})

test('the membership and hospital pages: the answer text is on the pages the pre-registration says', () => {
  assert.ok(HOLDOUT2_PAGES.membership['/account/membership'].text.includes('다음 결제일: 2026-12-14'))
  assert.ok(HOLDOUT2_PAGES.hospital['/my/appointments'].text.some(line => line.includes('2026-12-03 10:30')))
  assert.ok(HOLDOUT2_PAGES.hospital['/my'].elements.every(e => !e.href || e.href.startsWith('https://carehosp.example.test/')))
})

test('c26 stuck plan: the c24 form page and the settings error page send the request bytes the real runs sent, so the real answers turn into a hand-over naming the controls (and the error page stays an error page); it fits 6k', async () => {
  const plan = loadLivePlan(FAMILY_PLAN_FILES.stuck)
  assert.ok(plan.tokenCeiling <= 6000)
  const est = await estimateLive({ plan })
  assert.ok(est.estInputTokens <= 6000 && est.stoppedBecause === null, `${est.estInputTokens} ${est.stoppedBecause}`)
  assert.deepEqual([est.scorecard.pass, est.scorecard.hardFailures, est.scorecard.absolute, est.scorecard.softMisses], [true, [], [], []])
  const seen = []
  const out = await runLive({ key: KEY, send: true, fetchImpl: standIn(plan.set, seen), plan })
  // sha256 of the real requests: c24 ig-form (entry, step, person-target follow-up) and c28/c29 settings-error-v2 (entry, wall follow-up, step)
  // c27: the two ENTRY requests changed (the request predicate's evidence lists the open pages, its question says what counts: c24 22478e6b -> 804d7b9b, settings-error-v2 6c01471c -> 21d0d454);
  // the step and the follow-ups are the real runs' bytes unchanged (854910d2, 784e4b64, fe1d1885, 18706a5e)
  assert.deepEqual(out.requests.map(r => r.sha256.slice(0, 8)), ['804d7b9b', '854910d2', '784e4b64', '21d0d454', 'fe1d1885', '18706a5e'])
  const phase = id => out.phases.find(p => p.id === id)
  assert.deepEqual([phase('sk-form').firstNote.code, phase('sk-form').firstNote.candidates, phase('sk-form').acts.length], ['human_step', ['휴대폰 본인확인', '수수료 결제에 동의합니다', '신청하기'], 0])
  assert.deepEqual([phase('sk-error').firstNote.code, phase('sk-error').acts.length], ['error_page', 0])
  for (const body of seen) assert.equal(lintGroupedRequest({ input: body.input, questions: body.questions }).ok, true)
})
