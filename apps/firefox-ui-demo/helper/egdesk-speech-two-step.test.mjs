// L7 c22: the two-step hybrid (same labels as the one-request hybrid, fewer tokens), split wording v2, turn memory's action-request rule,
// and this cycle's plans.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { SPEECH_SPLIT_KEYS, speechSegments, speechSplitQuestions } from './egdesk-speech-grounding.mjs'
import { SECOND_LABEL_RULES, TN_ACTION, judgeTurnWrite, prepareTurnMemory, triageTurn } from './egdesk-turn-memory.mjs'
import { WORDING_REQUESTS, analyzeWording, buildWordingPlan } from './egdesk-split-wording-plan.mjs'
import { loadPlan } from './egdesk-decision-real-runner.mjs'
import { lintGroupedRequest } from './egdesk-decision-grouping.mjs'

const choice = (value, c, other = 1 - c) => ({ type: 'choice', choice: value, confidence: c, probabilities: [{ value, probability: c }, { value: value === 'unknown' ? 'assertion' : 'unknown', probability: other }] })
const pred = p => ({ type: 'predicate', probability: p })
const text = '그 버그는 내가 고쳤어.', ASKED = Date.parse('2026-11-27T10:00:00+09:00')
const record = { id: 'ontology:r1', title: '기록', body: '가'.repeat(400), time: { slice: 'past' }, status: 'done', provenance: 'document', revision: 'r1' }
async function judge(design, answers, { fail = false, candidates = [] } = {}) {
  const calls = []
  const client = { async decide(r) { calls.push(r); if (fail && calls.length > 1) throw Object.assign(new Error('x'), { code: 'timeout' }); return { answers: Object.fromEntries(r.questions.filter(q => answers[q.name]).map(q => [q.name, answers[q.name]])) } } }
  const out = await judgeTurnWrite({ message: text, candidates, client, askedAt: ASKED, targetDesign: 'about', speechDesign: design })
  return { out, calls }
}
// c17-like: the axes question installs form and time, leaves source under the bar; the predicates decide own
const ANSWERS = { speech_source_0: choice('self_reported_observation', 0.75, 0.15), speech_form_0: choice('assertion', 0.97, 0.01), speech_time_0: choice('past_unspecified', 0.9, 0.05),
  speechs_other_0: pred(0.01), speechs_own_0: pred(0.97), speechs_record_0: pred(0.02), speechs_guess_0: pred(0.03),
  speechs_before_0: pred(0.9), speechs_now_0: pred(0.4), speechs_ongoing_0: pred(0), speechs_after_0: pred(0), speechs_when_0: pred(0.1) }

test('two-step: the first request is today\'s axes request byte for byte; the second asks only the axis left uninstalled, without the records', async () => {
  const axes = await judge('axes-isolated', ANSWERS, { candidates: [record] }), two = await judge('hybrid-two-step', ANSWERS, { candidates: [record] })
  assert.equal(JSON.stringify(two.calls[0]), JSON.stringify(axes.calls[0]))
  assert.equal(two.calls.length, 2)
  assert.deepEqual(two.calls[1].questions.map(q => q.name), SPEECH_SPLIT_KEYS.source.map(k => `speechs_${k}_0`))
  assert.deepEqual(two.calls[1].input.map(m => m.role), ['developer', 'user'])
  assert.equal(two.calls[1].input[0].content, SECOND_LABEL_RULES)
  assert.equal(two.calls[1].input[1], two.calls[0].input.at(-1), 'the clock and the message, as in the first request')
  assert.ok(!JSON.stringify(two.calls[1]).includes(record.body), 'the stored records are not sent again')
})

test('two-step gives the same labels as the one-request hybrid on the same answers', async () => {
  const one = await judge('hybrid-isolated', ANSWERS), two = await judge('hybrid-two-step', ANSWERS)
  assert.equal(one.calls.length, 1)
  assert.deepEqual(two.out.receipt.spans, one.out.receipt.spans)
  assert.equal(two.out.receipt.spans[0].source, 'self_reported_observation')
  assert.equal(two.out.receipt.spans[0].time, 'past_unspecified', 'installed by the axes question; its predicates are not asked')
  assert.equal(two.out.receipt.speechSecond.questions, 4)
})

test('two-step: nothing left -> no second request; a failed second request leaves those axes unknown (never guessed)', async () => {
  const all = { ...ANSWERS, speech_source_0: choice('self_reported_observation', 0.95, 0.02) }
  const none = await judge('hybrid-two-step', all)
  assert.equal(none.calls.length, 1)
  assert.deepEqual(none.out.receipt.speechSecond, { questions: 0 })
  const failed = await judge('hybrid-two-step', ANSWERS, { fail: true })
  assert.equal(failed.out.receipt.spans[0].source, 'unknown')
  assert.equal(failed.out.receipt.speechSecond.failed, 'timeout')
})

test('split wording v2 changes only other / own / guess / before / now; v1 stays the default', () => {
  const spans = speechSegments(text), v1 = speechSplitQuestions(spans, text), v2 = speechSplitQuestions(spans, text, { wording: 'v2' })
  assert.deepEqual(speechSplitQuestions(spans, text, { wording: 'v1' }), v1)
  assert.deepEqual(v2.map(q => q.name), v1.map(q => q.name))
  const changed = v2.filter((q, i) => q.instructions !== v1[i].instructions).map(q => q.name)
  assert.deepEqual(changed, ['speechs_other_0', 'speechs_own_0', 'speechs_guess_0', 'speechs_before_0', 'speechs_now_0'])
})

test('triage: tn_action only under the action rule set; a decided yes fetches no stored page, a no fetches as before', async () => {
  const seen = []
  const client = { async decide(r) { seen.push(r); return { answers: {} } } }
  await triageTurn({ message: '전체 테스트 돌리고 결과 알려줘', heldTitles: ['롤백 절차'], stored: [], client })
  await triageTurn({ message: '전체 테스트 돌리고 결과 알려줘', heldTitles: ['롤백 절차'], stored: [], client, ruleSet: 'action' })
  assert.ok(!seen[0].questions.some(q => q.name === 'tn_action'))
  assert.equal(seen[1].questions.find(q => q.name === 'tn_action').instructions.includes(TN_ACTION.slice(0, 40)), true)
  const page = { id: 'ontology:p1', title: '롤백 절차', body: '문제가 생기면 30분 안에 되돌린다.', time: { slice: 'present' }, provenance: 'document', status: 'done', revision: 'r1', links: [] }
  const other = { ...page, id: 'ontology:p2', title: '헬스체크 3종 체크리스트', revision: 'r2' }
  const wiki = { pages: new Map([[page.id, page], [other.id, other]]), links: () => [], backlinks: () => [] }
  const { sha256Hex } = await import('./egdesk-decision-questions.mjs')
  const delivered = { usable: true, threadKey: 't1', pages: { [page.id]: { revision: 'r1', hash: sha256Hex(page.body) } } }
  const run = async action => {
    const calls = []
    const c = { async decide(r) { calls.push(r.questions.map(q => q.name)); const a = {}
      for (const q of r.questions) a[q.name] = { type: 'predicate', probability: q.name === 'tn_action' ? action : q.name === 'tn_need' ? 0.99 : 0.01 }
      return { answers: a, usage: { input_tokens: 1 } } } }
    const out = await prepareTurnMemory({ message: '전체 테스트 돌리고 결과 알려줘', wiki, client: c, position: { kind: 'mid', reason: 'live_thread' }, delivered, threadKey: 't1', ruleSet: 'action' })
    return { out, calls }
  }
  const yes = await run(0.97)
  assert.equal(yes.out.memory.reason, 'action_request')
  assert.equal(yes.calls.length, 1, 'only the triage was asked')
  const no = await run(0.03)
  assert.notEqual(no.out.memory.reason, 'action_request')
  assert.ok(no.calls.length > 1, 'the fetch ran')
})

test('split-wording-v2 plan: <= 8k, only the changed predicates, committed files match, analysis combines with the c23 answers', async () => {
  const built = buildWordingPlan()
  assert.ok(built.est <= 8000)
  assert.deepEqual(built.rows.map(r => r.id), WORDING_REQUESTS.map(([axis, id]) => `${axis}-${id}`))
  const dir = new URL('../proofs/decision-real-measure/split-wording/', import.meta.url)
  assert.ok(readFileSync(new URL('plan.json', dir)).equals(built.planBytes))
  for (const f of built.files) assert.ok(readFileSync(new URL(f.file, dir)).equals(f.bytes))
  assert.deepEqual(Object.keys(loadPlan(new URL('plan.json', dir).pathname).productBars), ['*predicate'])
  for (const r of built.rows) assert.equal(lintGroupedRequest(JSON.parse(r.bytes)).ok, true)
  const results = Object.fromEntries(built.rows.map(r => [r.id, { status: 200, answers: [] }]))
  // c22: other and own now decided no, guess no -> record_based (record 1.0 from c23)
  results['source-c22'].answers = [['other', 0.05], ['own', 0.1], ['guess', 0.02]].map(([k, p]) => ({ name: `speechs_${k}_0`, type: 'predicate', probability: p }))
  // c30-time: before no, now no -> ongoing (ongoing 1.0 from c23)
  results['time-c30'].answers = [['before', 0.05], ['now', 0.1]].map(([k, p]) => ({ name: `speechs_${k}_0`, type: 'predicate', probability: p }))
  const out = analyzeWording(results, built.rows)
  assert.equal(out.rows.find(r => r.id === 'source-c22').label, 'record_based')
  assert.equal(out.rows.find(r => r.id === 'time-c30').label, 'ongoing_no_end')
  assert.equal(out.wrong, 0)
})

test('memory-action-v2 plan: <= 5k, every body asks tn_action, committed files match', async () => {
  const { buildMemoryActionV2Plan } = await import('../scripts/egdesk-memory-action-v2-plan.mjs')
  const built = await buildMemoryActionV2Plan()
  assert.ok(built.est <= 5000)
  const dir = new URL('../proofs/decision-real-measure/memory-action-v2/', import.meta.url)
  assert.ok(readFileSync(new URL('plan.json', dir)).equals(built.planBytes))
  for (const f of built.files) { assert.ok(readFileSync(new URL(f.file, dir)).equals(f.bytes)); assert.ok(JSON.parse(f.bytes).questions.some(q => q.name === 'tn_action')) }
  assert.deepEqual(Object.keys(loadPlan(new URL('plan.json', dir).pathname).productBars), ['tn_need', 'tn_action'])
})
