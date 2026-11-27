// L8 c30: the holdout2 re-run (membership enters AND finishes, the note carries the date) and the all-families ENTRY regression plan. The first steps of the five families
// are byte-identical to steps already sent and measured, so only the entries are sent; this test is the proof of that identity (sha256 prefixes frozen from the sent
// results: stability c29, rerun c33, holdout2 c31).
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runLive, estimateLive, loadLivePlan, FAMILY_PLAN_FILES } from './egdesk-browser-live-runner.mjs'
import { familyAnswers } from './egdesk-browser-live-families.mjs'
import { estimateTokens } from './egdesk-memory-real-plan.mjs'
import { lintGroupedRequest } from './egdesk-decision-grouping.mjs'
import { ENTRY_ANSWER_ASK, ENTRY_OPERATION_ASK, ENTRY_WEB_ASK } from './egdesk-browser-task.mjs'
import { pageTextFor } from './egdesk-page-text.fixture.mjs'
pageTextFor(["holdout2-v2: the membership request, entry then step, under ","the first steps of the five families are byte-identical to s"]) // a1: these pin what was sent WITH the page text (the flag on for them only; the default is off)

const PREREG = readFileSync(new URL('../scripts/egdesk-browser-live-c30-preregistration.md', import.meta.url), 'utf8')
const KEY = 'egd-synthetic-not-a-key-0008-long-enough'
const standIn = (set, seen = []) => async (_url, init) => { const body = JSON.parse(init.body); seen.push(body); const c = body.questions.filter(q => q.type === 'choice').length
  return { ok: true, status: 200, text: async () => JSON.stringify({ answers: familyAnswers(body, set), usage: { input_tokens: estimateTokens(c, body.questions.length - c, Buffer.byteLength(init.body)) } }) } }

test('holdout2-v2: the membership request, entry then step, under 3k; its entry is c36\'s bytes, its step is new; the finished task\'s note carries the date', async () => {
  const plan = loadLivePlan(FAMILY_PLAN_FILES.holdout2b)
  assert.deepEqual(plan.phases.map(p => p.id), ['ms-info'])
  for (const c of plan.checks) assert.ok(PREREG.includes(`\`${c.id}\``), `${c.id} is pre-registered`)
  const est = await estimateLive({ plan })
  assert.ok(est.estInputTokens <= 3000 && est.stoppedBecause === null, `${est.estInputTokens} ${est.stoppedBecause}`)
  assert.deepEqual([est.scorecard.pass, est.scorecard.hardFailures, est.scorecard.absolute, est.scorecard.softMisses], [true, [], [], []])
  const seen = []
  const out = await runLive({ key: KEY, send: true, fetchImpl: standIn(plan.set, seen), plan })
  assert.deepEqual(out.requests.map(r => [r.stage, r.sha256.slice(0, 8)]), [['entry', '05c37bf2'], ['step', '6f728e9e']], 'the entry is byte-identical to c36\'s measured one')
  for (const body of seen) assert.equal(lintGroupedRequest({ input: body.input, questions: body.questions }).ok, true)
  const phase = out.phases[0]
  assert.deepEqual([phase.first.status, phase.acts.length], ['done', 0])
  assert.ok(phase.firstNote.page.includes('다음 결제일: 2026-12-14'), JSON.stringify(phase.firstNote))
})

test('regression-v1: the five families\' entry requests (the new bytes) under 4k, entry only, both request predicates in each, pre-registered ids', async () => {
  const plan = loadLivePlan(FAMILY_PLAN_FILES.regression)
  assert.deepEqual(plan.phases.map(p => [p.id, p.entryOnly]), [['rg-st', true], ['rg-dv', true], ['rg-se', true], ['rg-inv', true], ['rg-ig', true]])
  for (const c of plan.checks) assert.ok(PREREG.includes(`\`${c.id}\``), `${c.id} is pre-registered`)
  const est = await estimateLive({ plan })
  assert.ok(est.estInputTokens <= 4000 && est.stoppedBecause === null, `${est.estInputTokens} ${est.stoppedBecause}`)
  assert.deepEqual([est.scorecard.pass, est.scorecard.hardFailures, est.scorecard.absolute, est.scorecard.softMisses], [true, [], [], []])
  const seen = []
  const out = await runLive({ key: KEY, send: true, fetchImpl: standIn(plan.set, seen), plan })
  assert.ok(out.requests.length === 5 && out.requests.every(r => r.stage === 'entry'), 'entry only: no step request')
  for (const body of seen) {
    assert.equal(lintGroupedRequest({ input: body.input, questions: body.questions }).ok, true)
    assert.deepEqual(body.questions.slice(0, 2).map(q => [q.name, q.instructions]), [['browser_entry', body.input[1].content.split('\n').filter(line => line.startsWith('- ')).length === 1 && body.input[1].content.includes(' has the controls ') ? ENTRY_OPERATION_ASK : ENTRY_WEB_ASK], ['browser_entry_answer', ENTRY_ANSWER_ASK]])
  }
  assert.deepEqual(out.phases.map(p => [p.id, p.first.handled]), [['rg-st', true], ['rg-dv', true], ['rg-se', true], ['rg-inv', true], ['rg-ig', true]])
})

test('the first steps of the five families are byte-identical to steps already sent (stability c29, rerun c33): this is why the regression plan sends entries only', async () => {
  const stepShas = async key => {
    const plan = { ...loadLivePlan(FAMILY_PLAN_FILES[key]), maxRequests: 14, tokenCeiling: 12000 }
    const out = await runLive({ key: KEY, send: true, fetchImpl: standIn(plan.set), plan })
    return Object.fromEntries(out.phases.map(p => [p.id, out.requests.filter(r => r.phase === p.id && r.stage !== 'entry').map(r => r.sha256.slice(0, 8))]))
  }
  const stability = await stepShas('stability')
  assert.deepEqual(stability, { 'stab-se': ['1e50c0fb', 'fb59df7a'], 'stab-st': ['4b247b1e'], 'stab-dv': ['41a0dcff'], 'stab-inv': ['21b8b5cd'] })
  const rerun = await stepShas('holdout-rerun')
  assert.deepEqual(rerun['rr-ig-list'].slice(0, 2), ['f2943bd6', '689f65cf'])
})
