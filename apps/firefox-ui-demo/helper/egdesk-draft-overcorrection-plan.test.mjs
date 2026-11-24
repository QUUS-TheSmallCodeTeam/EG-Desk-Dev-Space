import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DRAFT_CHECK_THRESHOLDS, isCheckable } from './egdesk-draft-check.mjs'
import { loadPlan } from './egdesk-decision-real-runner.mjs'
import { DRAFTS, OVERCORRECTION_BARS, OVERCORRECTION_DIR, analyzeOvercorrection, buildOvercorrectionPlan } from './egdesk-draft-overcorrection-plan.mjs'

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', OVERCORRECTION_DIR)

test('over-correction plan: committed files are what the product builds; the runner accepts them (product bars declared, grouping lint clean); room for a 10% under-estimate', async () => {
  const built = await buildOvercorrectionPlan()
  assert.ok(readFileSync(path.join(dir, 'plan.json')).equals(built.planBytes), 'plan.json is stale: node scripts/egdesk-draft-overcorrection-plan.mjs --write')
  for (const f of built.files) assert.ok(readFileSync(path.join(dir, f.file)).equals(f.bytes), `${f.file} is stale`)
  const loaded = loadPlan(path.join(dir, 'plan.json'))
  assert.deepEqual(Object.keys(loaded.productBars), ['sup_#', 'tense_#'])
  assert.equal(loaded.productBars['tense_#'].yes, DRAFT_CHECK_THRESHOLDS.finding)
  assert.equal(loaded.productBars['sup_#'].no, Math.round((1 - DRAFT_CHECK_THRESHOLDS.finding) * 1000) / 1000)
  assert.ok(loaded.requests.every(r => r.groupingOk && !r.recordOnly))
  assert.ok(built.totals.estInputTokens * 1.1 <= loaded.tokenCeiling)
  assert.deepEqual([built.totals.correct, built.totals.wrong], [14, 5])
})

test('over-correction plan: every sentence is registered, quoted on its own, and has a hard check on the question the product would act on', async () => {
  const built = await buildOvercorrectionPlan()
  for (const [n, d] of DRAFTS.entries()) {
    const body = JSON.parse(built.files[n].bytes.toString('utf8')), spec = built.plan.requests[n]
    assert.deepEqual(body.questions.map(q => q.name), d.sentences.flatMap((_, i) => [`sup_${i}`, `tense_${i}`]))
    d.sentences.forEach((s, i) => {
      assert.ok(body.input.some(m => m.content.includes(`Sentence S${i + 1}:`) && m.content.includes(s.text)), `${d.id} S${i + 1} quoted`)
      const hard = spec.expect.filter(e => e.severity === 'hard' && e.name.endsWith(`_${i}`))
      assert.ok(hard.length >= 1, `${d.id} S${i + 1} has a hard check`)
      if (s.status === 'correct') { assert.ok(hard.some(e => e.name === `tense_${i}` && e.max === OVERCORRECTION_BARS['tense_#'].no)); assert.equal(hard.some(e => e.name === `sup_${i}`), isCheckable(s.text)) }
      else assert.ok(hard.some(e => (e.name === `sup_${i}` && e.max === OVERCORRECTION_BARS['sup_#'].no) || (e.name === `tense_${i}` && e.min === OVERCORRECTION_BARS['tense_#'].yes)))
    })
    for (const item of d.evidence) assert.ok(body.input.some(m => m.content.includes(item.text)), `${d.id}: evidence quoted`)
  }
})

test('over-correction analysis: replays answers through the product checkDraft; a low support on a sentence without a concrete detail does not act', async () => {
  const answersFor = (d, f) => d.sentences.flatMap((s, i) => { const [sup, tense] = f(s, i); return [{ name: `sup_${i}`, type: 'predicate', probability: sup }, { name: `tense_${i}`, type: 'predicate', probability: tense }] })
  const run = f => Object.fromEntries(DRAFTS.map(d => [d.id, { status: 200, answers: answersFor(d, f) }]))
  const perfect = await analyzeOvercorrection(run(s => (s.status === 'correct' ? [0.95, 0.02] : s.kind === 'plan_as_done' || s.kind === 'past_as_present' || (s.kind === 'relayed_as_fact' && !isCheckable(s.text)) ? [0.5, 0.9] : [0.05, 0.1])))
  assert.deepEqual([perfect.correct.removedOrRewritten, perfect.wrong.passed, perfect.correct.n, perfect.wrong.n], [0, 0, 14, 5])
  // every sentence judged "not supported" (.1): only the concrete ones would act
  const harsh = await analyzeOvercorrection(run(() => [0.1, 0.1]))
  const concreteCorrect = DRAFTS.flatMap(d => d.sentences).filter(s => s.status === 'correct' && isCheckable(s.text)).length
  assert.equal(harsh.correct.removedOrRewritten, concreteCorrect)
  assert.ok(harsh.wrong.passed >= 1, 'a wrong sentence without a concrete detail cannot be caught by support alone')
  // a missing request counts as unanswered, not as a pass
  const partial = await analyzeOvercorrection({ [DRAFTS[0].id]: { status: 500 } })
  assert.equal(partial.answered, 0)
})
