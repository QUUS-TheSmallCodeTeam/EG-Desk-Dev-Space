// L7 c35, from the real write run check-20mw: (a) a first-person decision got source "unspecified" from the axes request and the split predicates were never asked;
// (b) the confirmation's question quoted "신제품 리뷰 회의 일정 (noted as done)" and the real judge saw no link to what the reply said.
import test from 'node:test'
import assert from 'node:assert/strict'
import { SPEECH_SPLIT_KEYS } from './egdesk-speech-grounding.mjs'
import { judgeTurnWrite } from './egdesk-turn-memory.mjs'
import { judgeConfirmation, noteQuote } from './egdesk-record-confirmation.mjs'
import { turnMemoryFlagsFromEnv } from './egdesk-turn-memory-wiring.mjs'

const choice = (value, c, other = 1 - c) => ({ type: 'choice', choice: value, confidence: c, probabilities: [{ value, probability: c }, { value: 'unknown', probability: other }] })
const pred = p => ({ type: 'predicate', probability: p })
const MESSAGE = '아 그거 다음 주 화요일로 확정했어', ASKED = Date.parse('2026-11-27T10:00:00+09:00')
// what the real axes request answered for this sentence (check-20mw turn 2): source unspecified (installed), form assertion, time future_anchored
const AXES = { speech_source_0: choice('unspecified', 0.93, 0.02), speech_form_0: choice('assertion', 0.97, 0.01), speech_time_0: choice('future_anchored', 0.95, 0.02) }
const split = (own, rest = 0.02) => ({ speechs_other_0: pred(rest), speechs_own_0: pred(own), speechs_record_0: pred(rest), speechs_guess_0: pred(rest) })
async function judge(design, answers, message = MESSAGE) {
  const calls = []
  const client = { async decide(r) { calls.push(r); return { answers: Object.fromEntries(r.questions.filter(q => answers[q.name]).map(q => [q.name, answers[q.name]])) } } }
  return { out: await judgeTurnWrite({ message, candidates: [], client, askedAt: ASKED, targetDesign: 'about', speechDesign: design }), calls }
}

test('hybrid-two-step (unchanged): an installed "unspecified" source is final, the split predicates are not asked', async () => {
  const r = await judge('hybrid-two-step', { ...AXES, ...split(0.95) })
  assert.equal(r.calls.length, 1); assert.equal(r.out.receipt.spans[0].source, 'unspecified')
})

test('hybrid-two-step-ask: the source axis is asked again with the split predicates; a decided own installs self_reported_observation, time and form stay as the axes request gave them', async () => {
  const r = await judge('hybrid-two-step-ask', { ...AXES, ...split(0.95) })
  assert.equal(r.calls.length, 2)
  assert.deepEqual(r.calls[1].questions.map(q => q.name), SPEECH_SPLIT_KEYS.source.map(k => `speechs_${k}_0`), 'only the source predicates: time was installed')
  assert.equal(r.calls[0].questions.length, r.calls[0].questions.filter(q => /^speech_|^tw_/.test(q.name)).length)
  assert.deepEqual(r.out.receipt.spans[0], { start: 0, end: MESSAGE.length, source: 'self_reported_observation', form: 'assertion', time: 'future_anchored' })
})

test('hybrid-two-step-ask: an undecided or all-no split leaves the axes\' "unspecified" (nothing is guessed), a decided other / guess / record installs that label', async () => {
  const sourceOf = async answers => (await judge('hybrid-two-step-ask', { ...AXES, ...answers })).out.receipt.spans[0].source
  assert.equal(await sourceOf(split(0.5)), 'unspecified', 'own undecided')
  assert.equal(await sourceOf(split(0.03)), 'unspecified', 'all no')
  assert.equal(await sourceOf({ ...split(0.02), speechs_other_0: pred(0.95) }), 'attributed_report')
  assert.equal(await sourceOf({ ...split(0.02), speechs_guess_0: pred(0.95) }), 'inference')
  assert.equal(await sourceOf({ ...split(0.02), speechs_record_0: pred(0.95) }), 'record_based')
})

test('hybrid-two-step-ask: a source the axes request installed as anything but unspecified is not asked again (relayed and hedged sentences keep their labels)', async () => {
  for (const [value, label] of [['attributed_report', 'attributed_report'], ['inference', 'inference']]) {
    const r = await judge('hybrid-two-step-ask', { ...AXES, speech_source_0: choice(value, 0.93, 0.02), ...split(0.95) }, '법무팀 말로는 그 마감을 수요일로 정했대')
    assert.equal(r.calls.length, 1, value); assert.equal(r.out.receipt.spans[0].source, label)
  }
})

test('the flag value hybrid-ask selects the design; only that exact value', () => {
  assert.deepEqual(turnMemoryFlagsFromEnv({ EGDESK_TURN_MEMORY_SPEECH_DESIGN: 'hybrid-ask' }), { speechDesign: 'hybrid-two-step-ask' })
  assert.deepEqual(turnMemoryFlagsFromEnv({ EGDESK_TURN_MEMORY_SPEECH_DESIGN: 'hybrid' }), { speechDesign: 'hybrid-two-step' })
  assert.deepEqual(turnMemoryFlagsFromEnv({ EGDESK_TURN_MEMORY_SPEECH_DESIGN: 'ask' }), {})
})

const REPLY = '기존 기록에는 일정 미정, 후보는 다음 주 화요일·수요일로 남아 있고, 방금 말씀하신 ‘다음 주 화요일 확정’은 아직 확인 전인 보고로 덧붙어 있어요.'
async function body(record) {
  let request = null
  await judgeConfirmation({ message: '응 맞아', previousAnswer: REPLY, records: [record], client: { async decide(r) { request = r; return { answers: {} } } }, askedAt: ASKED })
  return request
}
test('confirmation quote: with the person\'s own words the note names what was said; without them it is what it was, byte for byte', async () => {
  const bare = await body({ title: '신제품 리뷰 회의 일정', status: 'done' }), said = await body({ title: '신제품 리뷰 회의 일정', status: 'done', said: MESSAGE })
  assert.match(bare.questions[1].instructions ?? JSON.stringify(bare.questions[1]), /"신제품 리뷰 회의 일정 \(noted as done\)"/)
  assert.equal(noteQuote({ title: '신제품 리뷰 회의 일정', status: 'done' }), JSON.stringify('신제품 리뷰 회의 일정 (noted as done)'))
  for (const q of said.questions) assert.match(JSON.stringify(q), /아 그거 다음 주 화요일로 확정했어 \[the person's earlier message, kept as a report on 신제품 리뷰 회의 일정, noted as done\]/)
  assert.deepEqual(said.input, bare.input, 'the reply and the message are the same; only the questions quote the note differently')
  assert.deepEqual(said.questions.map(q => q.name), bare.questions.map(q => q.name))
  assert.equal(noteQuote({ title: 't', status: 'plan', said: '   ' }), JSON.stringify('t (noted as planned)'), 'a blank said is no said')
})

test('own-statement-v1 plan: the generic runner loads it with the product bars, 6 product-built bodies under 5k tokens, every expectation names a real question', async () => {
  const { buildOwnStatementPlan, RC_CASES, SRC_CASES, OWN_REPLY } = await import('./egdesk-own-statement-plan.mjs')
  const { loadPlan } = await import('./egdesk-decision-real-runner.mjs')
  const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs'), os = await import('node:os'), path = await import('node:path')
  const built = await buildOwnStatementPlan()
  assert.equal(built.plan.requests.length, 6); assert.ok(built.estInputTokens <= 5000, String(built.estInputTokens))
  const dir = mkdtempSync(path.join(os.tmpdir(), 'own-statement-')); mkdirSync(path.join(dir, 'requests'))
  for (const { file, bytes } of built.files) writeFileSync(path.join(dir, file), bytes)
  writeFileSync(path.join(dir, 'plan.json'), JSON.stringify(built.plan))
  const loaded = loadPlan(path.join(dir, 'plan.json'))
  assert.equal(loaded.requests.length, 6); assert.ok(Object.keys(loaded.productBars).length >= 7)
  const body = id => JSON.parse(built.files.find(f => f.file === `requests/${id}.json`).bytes)
  assert.ok(JSON.stringify(body('rc-own-yes').questions).includes(`아 그거 다음 주 화요일로 확정했어 [the person's earlier message`)); assert.ok(body('rc-own-yes').input.some(m => m.content.includes(OWN_REPLY)))
  assert.deepEqual(body('src-own-decision').questions.map(q => q.name), ['speechs_other_0', 'speechs_own_0', 'speechs_record_0', 'speechs_guess_0'])
  assert.ok(body('src-own-decision').input.at(-1).content.endsWith('아 그거 다음 주 화요일로 확정했어'))
  for (const def of [...RC_CASES, ...SRC_CASES]) assert.ok(def.expect.some(e => e.severity === 'hard'))
  // nothing in the hard checks can be met by promoting a non-answer: thanks and the unstated reply are held under the yes bar
  assert.deepEqual(built.plan.requests.find(r => r.id === 'rc-own-thanks').expect.filter(e => e.severity === 'hard').map(e => [e.name, e.max]), [['rc_confirms_0', 0.79]])
  assert.deepEqual(built.plan.requests.find(r => r.id === 'rc-own-unstated').expect.filter(e => e.severity === 'hard').map(e => [e.name, e.max]), [['rc_stated_0', 0.79]])
})
