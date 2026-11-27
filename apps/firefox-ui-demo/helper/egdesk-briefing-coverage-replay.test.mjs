// L4 cycle 48: Main's c59 run of the layer replay failed layer-coverage (onboard_F2 .53, F3 .69, F4 .67, F6 .58 against a hard "yes >= .7"). The recorded board keeps every entry's ids and figures and drops
// the prose cells of the table rows; the product acts only on a decided no. The plan now says so, and measures the judge on two controls built from the recorded request.
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { COVERAGE_REPLAY_CEILING, COVERAGE_REPLAY_DIR, absentValues, buildCoverageReplayPlan, withBoard } from './egdesk-briefing-coverage-replay.mjs'
import { LAYER_REPLAY_DIR, buildLayerReplayPlan, boardIn, factsOf } from './egdesk-briefing-layer-replay.mjs'
import { loadPlan, scoreRequest } from './egdesk-decision-real-runner.mjs'

const app = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const built = await buildCoverageReplayPlan(), layer = await buildLayerReplayPlan()
const C59 = { onboard_F1: .95, onboard_F2: .53, onboard_F3: .69, onboard_F4: .67, onboard_F5: .93, onboard_F6: .58 } // what the real Decision model answered in c59
const answered = (table, id = 'x') => ({ status: 200, answers: Object.entries(table).map(([name, probability]) => ({ name, type: 'predicate', probability })) })
const wireOf = (b, id) => b.files.find(f => f.file === `requests/${id}.json`).bytes.toString('utf8')

test('the plan is deterministic, within its ceiling, committed as built, and its first request is the recorded one byte for byte', () => {
  assert.equal(COVERAGE_REPLAY_CEILING, 15000); assert.ok(built.totals.estInputTokens <= 15000, String(built.totals.estInputTokens)); assert.deepEqual(built.requests.map(r => r.id), ['cov-compressed', 'cov-full', 'cov-absent'])
  for (const f of [{ file: 'plan.json', bytes: built.planBytes }, ...built.files]) assert.ok(readFileSync(path.join(app, COVERAGE_REPLAY_DIR, f.file)).equals(f.bytes), `${f.file} is committed as built`)
  assert.equal(built.requests[0].sha256, layer.requests.find(r => r.id === 'layer-coverage').sha256, 'the same bytes the c59 run sent')
  const plan = loadPlan(path.join(app, COVERAGE_REPLAY_DIR, 'plan.json')); assert.equal(plan.requests.length, 3); assert.ok(plan.totals.estInputTokens <= plan.tokenCeiling)
})
test('the controls differ from the recorded request in the board only: the question, the facts and their wording are the same bytes', () => {
  const recorded = wireOf(built, 'cov-compressed'), full = wireOf(built, 'cov-full'), absent = wireOf(built, 'cov-absent')
  for (const wire of [full, absent]) { const a = JSON.parse(recorded), b = JSON.parse(wire); assert.deepEqual(b.questions, a.questions); assert.equal(b.input[0].content, a.input[0].content); assert.equal(b.prompt_cache_key, a.prompt_cache_key); assert.deepEqual(factsOf(wire), factsOf(recorded)) }
  assert.equal(withBoard(recorded, b => b), recorded, 'an unedited board is the same bytes (the product\'s own serialisation)')
  const facts = factsOf(recorded)
  // full: every cell of every fact is on the integration card
  const flat = JSON.stringify(boardIn(full)); for (const { fact } of facts) for (const cell of fact.split(' · ').slice(1)) assert.ok(flat.includes(JSON.stringify(cell).slice(1, -1)), cell.slice(0, 30))
  assert.deepEqual(facts.map(f => absentValues(f.fact, boardIn(full)).length), [0, 0, 0, 0, 0, 0], 'nothing of any fact is missing from the full board')
  // absent: the 15:29 row (5930건) is nowhere, the other five rows are the recorded ones
  assert.ok(!JSON.stringify(boardIn(absent)).includes('5930건')); assert.ok(['9aeed73', '5752건', '5990건', '6085건', '218c711'].every(k => JSON.stringify(boardIn(absent)).includes(k)))
})
test('what the recorded board lacks is the prose of the rows, never an id or figure the request asks for: each entry\'s key figure is there, and the facts the judge was unsure of lack the most', () => {
  const recorded = wireOf(built, 'cov-compressed'), board = boardIn(recorded), facts = factsOf(recorded), flat = JSON.stringify(board)
  for (const k of ['9aeed73', '5752건', '5930건', '5990건', '6085건', '218c711']) assert.ok(flat.includes(k), k)
  const lacking = Object.fromEntries(built.evidence.map(e => [e.fact, e.absentValues.length])); assert.deepEqual(lacking, { onboard_F1: 3, onboard_F2: 6, onboard_F3: 1, onboard_F4: 3, onboard_F5: 3, onboard_F6: 10 })
  assert.ok(built.evidence.find(e => e.fact === 'onboard_F2').absentValues.some(v => v.includes('decision-client')) && built.evidence.find(e => e.fact === 'onboard_F6').absentValues.some(v => v.includes('L7 c24')))
  assert.equal(facts.length, 6)
})
test('the c59 answers scored with the corrected expectations: no hard failure (undecided is not a decided no), the soft "shown in full" misses are recorded; with the c46 expectation (hard yes) they fail', () => {
  const plan = loadPlan(path.join(app, LAYER_REPLAY_DIR, 'plan.json')), request = plan.requests.find(r => r.id === 'layer-coverage')
  const row = scoreRequest(request, answered(C59)); assert.deepEqual(row.hardFailures, []); assert.deepEqual(row.softMisses.sort(), ['onboard_F2', 'onboard_F3', 'onboard_F4', 'onboard_F6']); assert.equal(row.hard.total, 6)
  assert.ok(request.expect.filter(e => e.severity === 'hard').every(e => e.notDecidedNo === true && e.min === undefined), 'the hard bar is the product\'s: only a decided no counts')
  // the bar is still a bar: one entry judged decided-not-shown fails
  assert.deepEqual(scoreRequest(request, answered({ ...C59, onboard_F3: .12 })).hardFailures, ['onboard_F3'])
})
test('the controls separate the judge from the board: if the full board were judged like the recorded one (F2 .53) or the absent row were not noticed (F3 .69), a hard check fails', () => {
  const plan = loadPlan(path.join(app, COVERAGE_REPLAY_DIR, 'plan.json')), by = id => plan.requests.find(r => r.id === id)
  const yes = Object.fromEntries(Object.keys(C59).map(n => [n, .95]))
  assert.deepEqual(scoreRequest(by('cov-full'), answered(yes)).hardFailures, []); assert.deepEqual(scoreRequest(by('cov-full'), answered(C59)).hardFailures.sort(), ['onboard_F2', 'onboard_F3', 'onboard_F4', 'onboard_F6'], 'the recorded numbers on the full board would say the judge misses')
  assert.deepEqual(scoreRequest(by('cov-absent'), answered({ ...yes, onboard_F3: .1 })).hardFailures, []); assert.deepEqual(scoreRequest(by('cov-absent'), answered({ ...yes, onboard_F3: .69 })).hardFailures, ['onboard_F3'])
  assert.deepEqual(scoreRequest(by('cov-compressed'), answered(C59)).hardFailures, [])
})
test('nothing here can send: no fetch, no key', () => {
  const source = readFileSync(path.join(app, 'helper', 'egdesk-briefing-coverage-replay.mjs'), 'utf8'); assert.ok(!/\bfetch\(|OPENAI_API_KEY|process\.env/.test(source))
})
