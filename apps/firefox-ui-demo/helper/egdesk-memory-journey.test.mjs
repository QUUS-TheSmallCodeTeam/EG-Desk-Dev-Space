import test from 'node:test'
import assert from 'node:assert/strict'
import { JOURNEY_CHECKS, JOURNEY_LIMITS, JOURNEY_TURNS, classifyReport, estimateJourney, runJourney, runJourneyLive, scoreJourney } from './egdesk-memory-journey.mjs'
import { DECISION_CONTEXT_KEY } from './egdesk-context-setup.mjs'
import { TURN_MEMORY_KEY } from './codex-chat-runtime.mjs'
import { mockJudge } from './egdesk-wiki-reconstruction.fixture.mjs'

const P = id => `ontology:${id}`
// An observed journey in which everything goes as registered (the shape runJourney returns).
const good = () => [
  { id: 't1-done-first', keys: [DECISION_CONTEXT_KEY], packetPages: [P('db/pg-plan'), P('db/pg-health'), P('db/pg-followup')], heldPages: [], resent: [], duplicateBodies: 0, noteGiven: false, confirm: null,
    write: { op: 'update_status', pageId: P('db/pg-plan'), status: 'done', applied: 'recorded_pending' }, fetches: 3, status: { 'db/pg-plan': 'unknown' }, readings: { 'db/pg-plan': ['done:pending'] } },
  { id: 't2-question', keys: [DECISION_CONTEXT_KEY], packetPages: [], heldPages: [P('db/pg-health')], resent: [], duplicateBodies: 0, noteGiven: true, confirm: null, write: { op: 'none' }, fetches: 1, status: { 'db/pg-plan': 'unknown' }, readings: { 'db/pg-plan': ['done:pending'] } },
  { id: 't3-thanks', keys: [DECISION_CONTEXT_KEY], packetPages: [], heldPages: [], resent: [], duplicateBodies: 0, noteGiven: true, confirm: { judged: 1, actions: [{ action: 'kept' }] }, write: null, fetches: 0, status: { 'db/pg-plan': 'unknown' }, readings: { 'db/pg-plan': ['done:pending'] } },
  { id: 't4-yes', keys: [DECISION_CONTEXT_KEY], packetPages: [], heldPages: [], resent: [], duplicateBodies: 0, noteGiven: false, confirm: { judged: 1, actions: [{ action: 'promoted' }] }, write: null, fetches: 0, status: { 'db/pg-plan': 'done' }, readings: { 'db/pg-plan': ['done:accepted'] } },
  { id: 't5-done-first-gap', keys: [TURN_MEMORY_KEY], packetPages: [P('quote/a-v2-plan')], heldPages: [], resent: [], duplicateBodies: 0, noteGiven: false, confirm: null, write: { op: 'update_status', pageId: P('quote/a-v2-plan'), status: 'done', applied: 'recorded_pending' }, fetches: 2, status: { 'db/pg-plan': 'done' }, readings: {} },
  { id: 't6-question', keys: [DECISION_CONTEXT_KEY], packetPages: [P('quote/a-decision')], heldPages: [], resent: [], duplicateBodies: 0, noteGiven: true, confirm: null, write: null, fetches: 1, status: {}, readings: {}, prior: { t5Pending: true } },
]
const change = (id, patch) => good().map(o => (o.id === id ? { ...o, ...patch } : o))

test('journey plan: six registered turns in two sessions, the three options on, the token ceiling at 30k', () => {
  assert.deepEqual(JOURNEY_TURNS.map(t => [t.id, t.session]), [['t1-done-first', 'S1'], ['t2-question', 'S1'], ['t3-thanks', 'S1'], ['t4-yes', 'S1'], ['t5-done-first-gap', 'S2'], ['t6-question', 'S2']])
  assert.deepEqual(Object.keys(JOURNEY_CHECKS), JOURNEY_TURNS.map(t => t.id))
  assert.ok(JOURNEY_LIMITS.tokenCeiling === 30000 && JOURNEY_LIMITS.hardTokenMax <= 32000)
})

test('journey scoring: the registered pass, each failure where it belongs, silence never promotes, and the gap is classed', () => {
  assert.deepEqual([scoreJourney(good()).turnsPassed, scoreJourney(good()).pass], [6, true])
  const silent = scoreJourney(change('t3-thanks', { status: { 'db/pg-plan': 'done' } }))
  assert.equal(silent.pass, false); assert.deepEqual(silent.absolute, ['t3-thanks: thanks never promotes: the plan status is still not done'])
  const twoKeys = scoreJourney(change('t1-done-first', { keys: [DECISION_CONTEXT_KEY, TURN_MEMORY_KEY] }))
  assert.deepEqual(twoKeys.scored[0].hardFailures, ['one packet: never both keys, and no page body twice'])
  const wrong = scoreJourney(change('t1-done-first', { write: { op: 'new_page', pageId: 'memo/x', status: 'done', applied: 'stored' } }))
  assert.ok(wrong.absolute.includes('t1-done-first: no new page and no other page is changed for this report'))
  // the known gap: the plan is not found, the report becomes a new page
  const gap = scoreJourney(change('t5-done-first-gap', { packetPages: [P('quote/a-v1')], write: { op: 'new_page', pageId: 'memo/x', status: 'done', applied: 'stored' } }))
  assert.deepEqual([gap.pass, gap.turnsPassed, gap.scored[4].failureClass], [true, 5, 'retrieval_miss'], 'one failed turn is allowed by the pass rule, and the gap is named')
  assert.equal(classifyReport({ write: { op: 'new_page' }, packetPages: [P('quote/a-v2-plan')], heldPages: [] }, 'quote/a-v2-plan'), 'target_miss')
  assert.equal(classifyReport({ write: { op: 'update_status', pageId: P('quote/a-v1') }, packetPages: [], heldPages: [] }, 'quote/a-v2-plan'), 'wrong_record')
  assert.equal(scoreJourney([]).pass, false)
})

test('the journey runs end to end on the stand-in (no network): all six turns, real runtime, one packet, the confirmation judged twice', async () => {
  const observed = await runJourney(mockJudge())
  assert.deepEqual(observed.map(o => o.id), JOURNEY_TURNS.map(t => t.id))
  assert.deepEqual(observed.map(o => o.position), ['first', 'mid', 'mid', 'mid', 'first', 'mid'])
  assert.ok(observed.every(o => !(o.keys.includes(DECISION_CONTEXT_KEY) && o.keys.includes(TURN_MEMORY_KEY)) && o.duplicateBodies === 0), 'one packet on every turn')
  assert.equal(observed[0].write.op, 'update_status'); assert.equal(observed[0].write.applied, 'recorded_pending')
  assert.deepEqual([observed[2].confirm.actions.map(a => a.action), observed[3].confirm.actions.map(a => a.action)], [['kept'], ['promoted']])
  assert.deepEqual([observed[2].status['db/pg-plan'], observed[3].status['db/pg-plan']], ['unknown', 'done'])
  const est = await estimateJourney()
  assert.ok(est.estInputTokens <= JOURNEY_LIMITS.tokenCeiling, `stand-in estimate ${est.estInputTokens}`)
})

test('the live entry point sends nothing without send and a key; with them every request goes through the guarded fetch', async () => {
  assert.deepEqual([(await runJourneyLive()).stoppedBecause, (await runJourneyLive({ send: true })).stoppedBecause], ['dry_run', 'no_key'])
  const judge = mockJudge(), seen = []
  const fetchImpl = async (url, init) => { seen.push(url); const body = JSON.parse(init.body); const { answers } = await judge.decide({ input: body.input, questions: body.questions })
    return new Response(JSON.stringify({ model: 'gpt-6-luna', answers: body.questions.map(q => ({ name: q.name, ...answers[q.name] })), usage: { input_tokens: 100, output_tokens: 0 } }), { status: 200 }) }
  const out = await runJourneyLive({ key: 'egd-synthetic-not-a-key-0016', send: true, fetchImpl })
  assert.ok(seen.length > 10 && seen.every(u => u === 'https://api.openai.com/v1/decisions'))
  assert.equal(out.sent, seen.length); assert.equal(out.stoppedBecause, null); assert.equal(out.turns.length, 6)
  assert.ok(out.requests.every(r => JOURNEY_TURNS.some(t => t.id === r.turn)), 'every request row is labelled with its turn')
  assert.ok(!JSON.stringify(out).includes('egd-synthetic-not-a-key-0016'), 'the key appears nowhere in the result')
  const stopped = await runJourneyLive({ key: 'egd-synthetic-not-a-key-0016', send: true, fetchImpl: async () => new Response('{}', { status: 429 }) })
  assert.deepEqual([stopped.stoppedBecause, stopped.sent], ['http_429', 1], 'the first failure stops everything after it')
})
