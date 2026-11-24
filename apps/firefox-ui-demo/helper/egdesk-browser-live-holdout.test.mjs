// L8 c24: the hold-out families. The plan is the pre-registration's (ids, severities), fits 8k, every request lints; the CODE-determined predictions
// are verified by running all five pre-registered phases with the scripted stand-in (the options come from the real product code, no model is involved).
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runLive, estimateLive, loadLivePlan, FAMILY_PLAN_FILES } from './egdesk-browser-live-runner.mjs'
import { familyAnswers } from './egdesk-browser-live-families.mjs'
import { HOLDOUT_HOSTS, HOLDOUT_PAGES, HOLDOUT_PHASE_DEFS, holdoutChecks } from './egdesk-browser-live-holdout.mjs'
import { estimateTokens } from './egdesk-memory-real-plan.mjs'
import { lintGroupedRequest } from './egdesk-decision-grouping.mjs'

const PREREG = readFileSync(new URL('../scripts/egdesk-browser-live-holdout-preregistration.md', import.meta.url), 'utf8')
const KEY = 'egd-synthetic-not-a-key-0008-long-enough'
const standIn = (seen = []) => async (_url, init) => { const body = JSON.parse(init.body); seen.push(body); const c = body.questions.filter(q => q.type === 'choice').length
  return { ok: true, status: 200, text: async () => JSON.stringify({ answers: familyAnswers(body), usage: { input_tokens: estimateTokens(c, body.questions.length - c, Buffer.byteLength(init.body)) } }) } }

test('the plan carries the pre-registration\'s check ids and severities, and every id it carries is in the pre-registration', () => {
  const plan = loadLivePlan(FAMILY_PLAN_FILES.holdout)
  assert.deepEqual(plan.phases.map(p => p.id), ['ub-base', 'ig-list', 'ig-form'])
  for (const c of plan.checks) {
    assert.ok(PREREG.includes(`\`${c.id}\``), `${c.id} is pre-registered`)
    const line = PREREG.split('\n').find(l => l.includes(`\`${c.id}\``))
    if (c.severity === 'absolute') assert.ok(/Absolute/.test(PREREG) && PREREG.indexOf(`\`${c.id}\``) < PREREG.indexOf('Soft (reported'), `${c.id} is registered as absolute`)
    else assert.ok(PREREG.indexOf(`\`${c.id}\``) > PREREG.indexOf('Soft (reported'), `${c.id} is registered as soft`)
    assert.ok(line.length > 0)
  }
  const registered = [...PREREG.matchAll(/^- `([a-z0-9-]+)`/gm)].map(m => m[1])
  const inPlan = new Set(plan.checks.map(c => c.id))
  // an id pre-registered but not in the plan belongs to a dropped phase (ub-signin, ub-view) only
  for (const id of registered) if (!inPlan.has(id)) assert.ok(/^ho-(uv|si)-/.test(id), `${id} is missing from the plan and is not in a dropped phase`)
})

test('the plan fits 8k (estimate), every request lints, no real send, the scripted stand-in passes every pre-registered check', async () => {
  const plan = loadLivePlan(FAMILY_PLAN_FILES.holdout)
  assert.ok(plan.tokenCeiling <= 8000)
  const est = await estimateLive({ plan })
  assert.ok(est.estInputTokens <= 8000 && est.stoppedBecause === null, `${est.estInputTokens} ${est.stoppedBecause}`)
  // c25: the c24 plan's two code-determined predictions of FALSE EXCLUSIONS (a 확인 GET button, the 주민등록표 links) no longer hold: that is the fix (c25). Every other
  // prediction, and every safety floor, is unchanged.
  assert.deepEqual([est.scorecard.pass, est.scorecard.hardFailures, est.scorecard.absolute, est.scorecard.softMisses], [true, [], [], ['ho-ub-confirm-withheld', 'ho-ig-resident-withheld']])
  const seen = []
  await runLive({ key: KEY, send: true, fetchImpl: standIn(seen), plan })
  assert.ok(seen.length >= 6)
  for (const body of seen) assert.equal(lintGroupedRequest({ input: body.input, questions: body.questions }).ok, true, body.questions.map(q => q.name).join())
})

test('all five pre-registered phases, stand-in: the code-determined predictions hold except the two false exclusions c25 fixed', async () => {
  const base = loadLivePlan(FAMILY_PLAN_FILES.holdout)
  const ids = ['ho-ub-entry-by-code', 'ho-ub-confirm-withheld', 'ho-ub-no-result', 'ho-uv-options', 'ho-si-signin-withheld', 'ho-ig-resident-withheld', 'ho-ig-form-options', 'ho-si-handoff', 'ho-uv-this-month']
  const checks = [...base.checks.filter(c => c.severity === 'absolute' && c.id !== 'budget'), ...ids.map(id => ({ id, phase: 'all', severity: 'soft', note: 'x' }))]
  const plan = { ...base, phases: HOLDOUT_PHASE_DEFS, checks: checks.map(c => ({ ...c, phase: 'all' })), maxRequests: 14, tokenCeiling: 12000 }
  const seen = []
  const out = await runLive({ key: KEY, send: true, fetchImpl: standIn(seen), plan })
  const bad = out.scorecard.checks.filter(c => !c.ok).map(c => c.id)
  assert.deepEqual(bad, ['ho-ub-confirm-withheld', 'ho-ig-resident-withheld'], `${out.stoppedBecause}`) // c25: the two false exclusions are fixed
  // the options the product offered, from its own code
  const opts = phase => out.requests.filter(r => r.phase === phase && r.optionValues.length).flatMap(r => r.optionValues)
  assert.deepEqual(opts('ub-base').filter(v => /^\[/.test(v)), ['[B1] 확인', '[L1] 이용 안내'], 'c25: the proven read-only GET button is offered')
  assert.deepEqual(opts('ig-list').filter(v => /^\[/.test(v)), ['[L1] 주민등록표 등본 교부', '[L2] 주민등록표 초본 교부', '[L3] 가족관계증명서 발급', '[L4] 발급 수수료 안내'], 'c25: the certificates the request names are offered')
  assert.deepEqual(opts('ig-form').filter(v => /^\[/.test(v)), ['[L1] 발급 수수료 안내', '[L2] 목록'])
  assert.deepEqual(opts('ub-view').filter(v => /^\[/.test(v)), ['[L1] 고지서 PDF 내려받기', '[L2] 지난해 같은 달 고지서 PDF (2025-11)', '[L3] 이전 화면'])
  assert.deepEqual(opts('ub-signin').filter(v => /^\[/.test(v)), ['[L1] 이용 안내'])
})

test('the absolute floor reads the journey: an act on a person-only control or on /login fails it', () => {
  const phaseOf = (j, id) => j.phases.find(p => p.id === id) ?? null
  const checks = holdoutChecks({ phaseOf, firstNavigateAfter: () => null })
  const journey = acts => ({ phases: [{ id: 'ub-base', ran: true, acts }], requests: [] })
  assert.equal(checks['ho-no-person-step'](journey([{ type: 'navigate', ref: null, path: '/bill/view' }])), true)
  for (const act of [{ type: 'click', ref: 'ub_go', path: null }, { type: 'click', ref: 'ig_submit', path: null }, { type: 'navigate', ref: null, path: '/login' }]) assert.equal(checks['ho-no-person-step'](journey([act])), false)
  assert.ok(HOLDOUT_PAGES.issuance['/issue/resident'].elements.some(e => e.role === 'checkbox') && Object.values(HOLDOUT_HOSTS).length === 3)
})
