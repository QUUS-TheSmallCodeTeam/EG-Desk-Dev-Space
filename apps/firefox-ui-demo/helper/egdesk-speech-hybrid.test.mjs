// 'hybrid-isolated' (L7 c21): the axes questions keep every label they install at today's bar; the split predicates are read only for an
// axis the axes question leaves uninstalled. Plus the re-measure plans of this cycle.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { SPEECH_HYBRID, speechDesignInterpretations, speechDesignQuestions, speechIsolatedQuestions, speechSegments, speechSplitQuestions } from './egdesk-speech-grounding.mjs'
import { HYBRID_REQUESTS, analyzeHybrid, buildHybridPlan } from './egdesk-axis-hybrid-plan.mjs'
import { loadPlan } from './egdesk-decision-real-runner.mjs'
import { lintGroupedRequest } from './egdesk-decision-grouping.mjs'
import { JUDGE_RULES, NEXT_RULES, ACTION_MEMORY_RULE, reconstructMemory } from './egdesk-wiki-reconstruction.mjs'
import { triageTurn } from './egdesk-turn-memory.mjs'

const choice = (value, c, other = 1 - c) => ({ type: 'choice', choice: value, confidence: c, probabilities: [{ value, probability: c }, { value: value === 'unknown' ? 'assertion' : 'unknown', probability: other }] })
const pred = p => ({ type: 'predicate', probability: p })
const one = '어제 오후에 3층 회의실 프로젝터가 꺼져 있는 걸 내가 봤어.', spans = speechSegments(one)

test('hybrid questions: the three axes questions and the nine split predicates, nothing reworded', () => {
  const qs = speechDesignQuestions(SPEECH_HYBRID, spans, one)
  const axes = speechIsolatedQuestions(spans, one), split = speechSplitQuestions(spans, one).filter(q => q.type === 'predicate')
  assert.deepEqual(qs, [...axes, ...split])
  assert.equal(lintGroupedRequest({ input: [{ role: 'user', content: one }], questions: qs }).ok, true)
})

test('an axis the axes question installs keeps its label; the predicates are read only where it does not', () => {
  // c01 in c23: the predicates left source undecided (guess .66) and time undecided (before .56); the study's axes answers installed both
  const answers = { speech_source_0: choice('self_reported_observation', 1), speech_time_0: choice('past_anchored', 0.94, 0.03), speech_form_0: choice('assertion', 0.98, 0.01),
    speechs_other_0: pred(0), speechs_own_0: pred(0.99), speechs_record_0: pred(0.1), speechs_guess_0: pred(0.66),
    speechs_before_0: pred(0.56), speechs_now_0: pred(0.03), speechs_ongoing_0: pred(0), speechs_after_0: pred(0), speechs_when_0: pred(1) }
  assert.deepEqual(speechDesignInterpretations(SPEECH_HYBRID, answers, spans), [{ start: 0, end: one.length, source: 'self_reported_observation', form: 'assertion', time: 'past_anchored' }])
  // below the axes bar: the predicates decide (c26 in c23: all four source predicates decided no -> unspecified)
  answers.speech_source_0 = choice('self_reported_observation', 0.8, 0.07)
  Object.assign(answers, { speechs_own_0: pred(0.01), speechs_record_0: pred(0.09), speechs_guess_0: pred(0.04), speechs_other_0: pred(0.07) })
  assert.equal(speechDesignInterpretations(SPEECH_HYBRID, answers, spans)[0].source, 'unspecified')
  // and the when rule applies to the predicate reading (a16: now .92, when 1.0) while the axes question stays under its bar
  answers.speech_time_0 = choice('past_anchored', 0.41, 0.17)
  Object.assign(answers, { speechs_before_0: pred(0.12), speechs_now_0: pred(0.92), speechs_ongoing_0: pred(0), speechs_after_0: pred(0.07), speechs_when_0: pred(1) })
  assert.equal(speechDesignInterpretations(SPEECH_HYBRID, answers, spans)[0].time, 'unknown')
})

test('axis-hybrid-v1: the 6 requests whose outcome changes, <= 12k, product bars for both kinds, committed files match', async () => {
  const built = await buildHybridPlan()
  assert.deepEqual(built.rows.map(r => r.id), HYBRID_REQUESTS.map(([axis, id]) => `${axis}-${id}`))
  assert.ok(built.est <= 12000)
  const dir = new URL('../proofs/decision-real-measure/axis-hybrid/', import.meta.url)
  assert.ok(readFileSync(new URL('plan.json', dir)).equals(built.planBytes))
  for (const f of built.files) assert.ok(readFileSync(new URL(f.file, dir)).equals(f.bytes))
  assert.deepEqual(Object.keys(loadPlan(new URL('plan.json', dir).pathname).productBars), ['*choice', '*predicate'])
  for (const r of built.rows) {
    const body = JSON.parse(r.bytes)
    assert.equal(lintGroupedRequest(body).ok, true)
    assert.deepEqual(body.questions.map(q => q.name)[0], `speech_${r.axis}_0`)
    assert.equal(r.expect.find(e => e.severity === 'hard').whenAccepted.minConfidence, 0.85)
  }
  // analysis = the product interpretation
  const results = Object.fromEntries(built.rows.map(r => [r.id, { status: 200, answers: [] }]))
  results['source-c01'].answers = [{ name: 'speech_source_0', ...choice('self_reported_observation', 0.99, 0.01) }]
  results['time-a16'].answers = [{ name: 'speech_time_0', ...choice('at_utterance', 0.9, 0.05) }]
  const out = analyzeHybrid(results, built.rows)
  assert.equal(out.rows.find(r => r.id === 'source-c01').correct, true)
  assert.equal(out.wrong, 1)
  assert.equal(out.pass, false)
})

test('turn memory action rules: the default triage and scan rules are unchanged; the action set adds the one line', async () => {
  const seen = []
  const client = { async decide(r) { seen.push(r); return { answers: {}, model: 'gpt-6-luna', usage: { input_tokens: 1 } } } }
  await triageTurn({ message: '전체 테스트 돌리고 결과 알려줘', heldTitles: ['롤백 절차'], stored: [], client })
  await triageTurn({ message: '전체 테스트 돌리고 결과 알려줘', heldTitles: ['롤백 절차'], stored: [], client, ruleSet: 'action' })
  assert.ok(!seen[0].input[0].content.includes(ACTION_MEMORY_RULE))
  assert.equal(seen[1].input[0].content, `${seen[0].input[0].content}\n${ACTION_MEMORY_RULE}`)
  assert.deepEqual(seen[1].questions, seen[0].questions)
  const page = { id: 'p1', title: '롤백 절차', body: '문제가 생기면 30분 안에 되돌린다.', time: { slice: 'present' }, provenance: 'document', status: 'done', revision: 'r1', links: [] }
  const wiki = { pages: new Map([[page.id, page]]) }
  for (const [mode, rules] of [['first', JUDGE_RULES], ['next', NEXT_RULES]]) {
    const runs = []
    for (const ruleSet of ['default', 'action']) {
      const got = []
      await reconstructMemory({ message: '전체 테스트 돌리고 결과 알려줘', wiki, client: { async decide(r) { got.push(r); return { answers: {}, usage: { input_tokens: 1 } } } }, mode, ruleSet })
      runs.push(got[0].input[0].content)
    }
    assert.equal(runs[0], rules)
    assert.equal(runs[1], `${rules}\n${ACTION_MEMORY_RULE}`)
  }
})

test('memory-action-v1: <= 5k, product bars, every body carries the rule, committed files match', async () => {
  const { buildMemoryActionPlan } = await import('../scripts/egdesk-memory-action-plan.mjs')
  const built = await buildMemoryActionPlan()
  assert.ok(built.est <= 5000)
  const dir = new URL('../proofs/decision-real-measure/memory-action/', import.meta.url)
  assert.ok(readFileSync(new URL('plan.json', dir)).equals(built.planBytes))
  for (const f of built.files) { assert.ok(readFileSync(new URL(f.file, dir)).equals(f.bytes)); assert.ok(JSON.parse(f.bytes).input[0].content.endsWith(ACTION_MEMORY_RULE)) }
  assert.deepEqual(Object.keys(loadPlan(new URL('plan.json', dir).pathname).productBars), ['tn_need', 'pg_#'])
})
