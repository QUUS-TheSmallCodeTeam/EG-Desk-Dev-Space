// The source/time re-measure plan (egdesk-axis-split-plan.mjs) and the action-relevance plan: deterministic, within caps, product bars
// declared, grouping lint clean, the committed files match, and the analysis applies the product combination.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { SPLIT_CHUNK_CEILING, SPLIT_LABELS_SHA, SPLIT_SELECTION, SPLIT_TOKEN_CEILING, analyzeSplit, buildSplitPlan, expectationsFor } from './egdesk-axis-split-plan.mjs'
import { SENTENCES, labelsFile } from './egdesk-utterance-threshold-study.mjs'
import { lintGroupedRequest } from './egdesk-decision-grouping.mjs'
import { loadPlan } from './egdesk-decision-real-runner.mjs'

const built = await buildSplitPlan()
const dir = new URL('../proofs/decision-real-measure/axis-split/', import.meta.url)

test('the frozen labels are the study\'s (d29d9007...), committed and unchanged', () => {
  assert.equal(labelsFile().sha256, SPLIT_LABELS_SHA)
  assert.equal(labelsFile().bytes.equals(readFileSync(new URL('../proofs/decision-real-measure/utterance-threshold/labels.json', import.meta.url))), true)
})

test('21 requests, one sentence and one axis each, <= 25k in chunks <= 12k; roles follow the allowed sets', () => {
  assert.equal(built.rows.length, 21)
  assert.ok(built.totals.estInputTokens <= SPLIT_TOKEN_CEILING)
  for (const c of built.chunks) assert.ok(c.est <= SPLIT_CHUNK_CEILING)
  for (const r of built.rows) {
    const body = JSON.parse(r.bytes)
    assert.deepEqual([...new Set(body.questions.map(q => q.name.replace(/^speechs_(\w+)_0$/, '$1')))].length, r.axis === 'source' ? 4 : 5)
    assert.ok(body.questions.every(q => q.type === 'predicate' && /^speechs_/.test(q.name)))
    assert.equal(lintGroupedRequest(body).ok, true, r.id)
    const onlyUnknown = r.allowed.length === 1 && r.allowed[0] === 'unknown'
    assert.equal(onlyUnknown, r.role === 'guard', `${r.id}: guards are exactly the deliberately ambiguous axes`)
    assert.deepEqual(r.allowed, SENTENCES.find(s => s.id === r.sentence).allowed[r.axis])
  }
  assert.deepEqual(Object.values(SPLIT_SELECTION).map(s => s.controls.length).reduce((a, b) => a + b), 6)
})

test('every chunk loads in the generic runner with its product bars, and the committed files are the built ones', () => {
  for (const c of built.chunks) {
    assert.ok(readFileSync(new URL(`${c.dir}/plan.json`, dir)).equals(c.planBytes), c.dir)
    for (const f of c.files) assert.ok(readFileSync(new URL(`${c.dir}/${f.file}`, dir)).equals(f.bytes), f.file)
    const plan = loadPlan(new URL(`${c.dir}/plan.json`, dir).pathname)
    assert.deepEqual(Object.keys(plan.productBars), ['*predicate'])
  }
})

test('soft expectations say what a correct install needs', () => {
  assert.deepEqual(expectationsFor('source', ['unspecified']).map(e => [e.name, e.max ?? null]), [['speechs_other_0', 0.15], ['speechs_own_0', 0.15], ['speechs_record_0', 0.15], ['speechs_guess_0', 0.15]])
  assert.deepEqual(expectationsFor('source', ['attributed_report']).filter(e => e.min).map(e => e.name), ['speechs_other_0'])
  assert.deepEqual(expectationsFor('time', ['ongoing_no_end', 'at_utterance']).map(e => e.name), ['speechs_before_0', 'speechs_after_0'])
  assert.deepEqual(expectationsFor('time', ['past_anchored']).map(e => [e.name, e.min ?? e.max]), [['speechs_before_0', 0.85], ['speechs_now_0', 0.15], ['speechs_ongoing_0', 0.15], ['speechs_after_0', 0.15], ['speechs_when_0', 0.85]])
  assert.deepEqual(expectationsFor('time', ['unknown']), [])
})

test('analysis: product combination at the product bar; a wrong install fails, an undecided one is only a coverage miss', () => {
  const p = x => ({ type: 'predicate', probability: x })
  const results = {}
  for (const r of built.rows) results[r.id] = { status: 200, answers: [] }
  results['source-c26'].answers = ['other', 'own', 'record', 'guess'].map(k => ({ name: `speechs_${k}_0`, ...p(0.02) })) // -> unspecified: correct
  results['source-c22'].answers = [['other', 0.02], ['own', 0.9], ['record', 0.03], ['guess', 0.01]].map(([k, x]) => ({ name: `speechs_${k}_0`, ...p(x) })) // -> own: WRONG
  const out = analyzeSplit(results, built.rows)
  assert.equal(out.rows.find(r => r.id === 'source-c26').label, 'unspecified')
  assert.equal(out.rows.find(r => r.id === 'source-c26').correct, true)
  assert.equal(out.wrong, 1)
  assert.equal(out.pass, false)
  results['source-c22'].answers[1] = { name: 'speechs_own_0', ...p(0.84) }
  assert.equal(analyzeSplit(results, built.rows).wrong, 0)
})

test('action-relevance plan: <= 5k, loads with its bar, s4 is the real v3 body plus exactly the one rule line', async () => {
  const plan = loadPlan(new URL('../proofs/decision-real-measure/action-relevance/plan.json', import.meta.url).pathname)
  assert.ok(plan.requests.reduce((n, r) => n + r.estInputTokens, 0) <= 5000)
  assert.deepEqual(Object.keys(plan.productBars), ['rel_#'])
  const s4 = JSON.parse(readFileSync(new URL('../proofs/decision-real-measure/action-relevance/requests/s4-action.json', import.meta.url)))
  const { CONTEXT_RULE_SETS } = await import('./egdesk-context-setup.mjs')
  assert.deepEqual(CONTEXT_RULE_SETS, ['default', 'action', 'action+status'])
  const lines = s4.input[0].content.split('\n')
  assert.equal(lines.length, 4)
  assert.match(lines[3], /^An item is needed only when the response has to use what the item says\. A request to carry out an action/)
  assert.equal(s4.questions.filter(q => /^rel_\d+$/.test(q.name)).length, 12)
  assert.equal(lintGroupedRequest(s4).ok, true)
})
