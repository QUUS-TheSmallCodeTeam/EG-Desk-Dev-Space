import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadPlan, scoreRequest } from './egdesk-decision-real-runner.mjs'
import { SPEECH_THRESHOLDS, speechSegments } from './egdesk-speech-grounding.mjs'
import { AXES, SENTENCES, STUDY_CHUNK_CEILING, STUDY_DIR, analyzeStudy, buildStudy, outcomeTable, upperBound95, wouldInstall } from './egdesk-utterance-threshold-study.mjs'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const dir = path.join(root, STUDY_DIR)

test('utterance study: committed labels and chunk plans are what the product builds; every chunk cites the labels hash and fits 12k', async () => {
  const built = await buildStudy()
  assert.ok(readFileSync(path.join(dir, 'labels.json')).equals(built.labels.bytes), 'labels.json is stale')
  assert.equal(SENTENCES.length, 60); assert.equal(SENTENCES.filter(s => s.ambiguous).length, 16)
  assert.equal(new Set(SENTENCES.map(s => s.id)).size, 60); assert.equal(new Set(SENTENCES.map(s => s.text)).size, 60)
  const seen = new Set()
  for (const c of built.chunks) {
    assert.ok(readFileSync(path.join(dir, c.dir, 'plan.json')).equals(c.planBytes), `${c.dir}/plan.json is stale`)
    for (const f of c.files) assert.ok(readFileSync(path.join(dir, c.dir, f.file)).equals(f.bytes), `${c.dir}/${f.file} is stale`)
    assert.ok(c.plan.passRule.includes(built.labels.sha256))
    assert.ok(c.est <= STUDY_CHUNK_CEILING && c.plan.tokenCeiling <= 12000)
    assert.equal(c.items.filter(s => s.ambiguous).length, 2)
    const loaded = loadPlan(path.join(dir, c.dir, 'plan.json'))
    assert.deepEqual(loaded.productBars['*choice'], { minConfidence: SPEECH_THRESHOLDS.confidence, minMargin: SPEECH_THRESHOLDS.margin, source: loaded.productBars['*choice'].source })
    for (const r of loaded.requests) { assert.equal(r.recordOnly, false); assert.ok(r.expect.some(e => e.severity === 'hard')); seen.add(r.id) }
  }
  assert.equal(seen.size, 60, 'every sentence is in exactly one chunk')
})

test('utterance study: each message is one product sentence, quoted in its own request, and the hard checks are exactly "no wrong install at today\'s bar"', async () => {
  const built = await buildStudy()
  for (const s of SENTENCES) assert.equal(speechSegments(s.text).length, 1, s.id)
  for (const c of built.chunks) for (const [n, f] of c.files.entries()) {
    const s = c.items[n], body = JSON.parse(f.bytes.toString('utf8'))
    assert.equal(body.questions.filter(q => /^speech_/.test(q.name)).length, 3)
    assert.ok(body.questions.find(q => q.name === 'speech_source_0').instructions.includes(JSON.stringify(s.text)), 'the sentence is quoted in the question')
    assert.equal(body.questions.some(q => /^tw_about_/.test(q.name)), false, 'no stored record, so no target question')
    const hard = c.plan.requests[n].expect.filter(e => e.severity === 'hard')
    assert.deepEqual(hard.map(e => e.name), AXES.map(a => `speech_${a}_0`))
    for (const e of hard) { assert.deepEqual(e.whenAccepted, { minConfidence: SPEECH_THRESHOLDS.confidence, minMargin: SPEECH_THRESHOLDS.margin }); assert.ok(e.oneOf.includes('unknown')) }
  }
})

test('utterance study: bounds, the product acceptance replay and the analysis on mock answers', async () => {
  assert.equal(upperBound95(0, 6), 0.393); assert.equal(upperBound95(0, 16), 0.1707); assert.equal(upperBound95(0, 60), 0.0487)
  assert.ok(upperBound95(1, 60) > upperBound95(0, 60) && upperBound95(1, 60) < 0.08)
  const row = (value, conf, rows) => ({ type: 'choice', choice: value, confidence: conf, probabilities: rows.map(([v, p]) => ({ value: v, probability: p })) })
  assert.equal(wouldInstall(row('unknown', 0.99, [['unknown', 0.99], ['plan', 0.01]]), 0.6), false, 'unknown is never installed')
  assert.equal(wouldInstall(row('plan', 0.86, [['plan', 0.9], ['assertion', 0.05]]), 0.85), true)
  assert.equal(wouldInstall(row('plan', 0.86, [['plan', 0.6], ['assertion', 0.05]]), 0.85, 0.2, 5), true)
  assert.equal(wouldInstall(row('plan', 0.86, [['plan', 0.5], ['assertion', 0.05]]), 0.85, 0.2, 5), false, 'unreported mass is a runner-up')
  // Mock: every axis answers its first allowed label at 0.9, except a01 source installs attributed_report (wrong: deliberately ambiguous)
  // and c01 time installs past_unspecified at 0.72 (wrong, but only below 0.85).
  const results = {}
  for (const s of SENTENCES) results[s.id] = { status: 200, answers: AXES.map(a => {
    let value = s.allowed[a][0], conf = 0.9
    if (s.id === 'a01' && a === 'source') value = 'attributed_report'
    if (s.id === 'c01' && a === 'time') { value = 'past_unspecified'; conf = 0.72 }
    return { name: `speech_${a}_0`, ...row(value, conf, [[value, conf + 0.05], ['zz', 0]]) }
  }) }
  const out = analyzeStudy(results)
  const at = bar => out.byBar.find(b => b.bar === bar)
  assert.deepEqual([at(0.85).wrong, at(0.85).wrongSentences, at(0.85).wrongRows[0].id], [1, 1, 'a01'])
  assert.deepEqual([at(0.7).wrong, at(0.7).wrongSentences], [2, 2])
  assert.equal(at(0.95).installs, 0)
  // The runner's hard check agrees with the analysis at today's bar.
  const built = await buildStudy()
  const chunk = built.chunks.find(c => c.items.some(s => s.id === 'a01')), idx = chunk.items.findIndex(s => s.id === 'a01')
  const scored = scoreRequest(chunk.plan.requests[idx], { status: 200, answers: Object.fromEntries(results.a01.answers.map(a => [a.name, a])) })
  assert.ok(scored.hardFailures.length >= 1 || scored.pass === false)
  const table = outcomeTable()
  assert.equal(table.perSentence[0].upper95, 0.0487); assert.equal(table.ambiguous[0].upper95, 0.1707)
})
