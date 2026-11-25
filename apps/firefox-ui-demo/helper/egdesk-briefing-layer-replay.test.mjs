// L4 cycle 46: the Decisions-only replay of the briefing's layers on recorded real inputs (check-29br / 29bh / 25br). Nothing is sent and no engine runs: the plan's bytes are what the product
// sends, and replayLayers() feeds answers back through the product flow. The "real" answers below are check-29br's own recorded Decision answers (about_M12 .26 among them).
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { LAYER_REPLAY_CEILING, LAYER_REPLAY_DIR, buildLayerReplayPlan, expectedTopics, factsOf, ledgerMaterials, replayLayers } from './egdesk-briefing-layer-replay.mjs'
import { CHECK29BR_DECISIONS } from './egdesk-briefing-real-run.fixture.mjs'
import { estimateBodyTokens, loadPlan } from './egdesk-decision-real-runner.mjs'

const app = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const built = await buildLayerReplayPlan()
const namesOf = id => JSON.parse(built.files.find(f => f.file === `requests/${id}.json`).bytes.toString('utf8')).questions.map(q => q.name)
/** results as the runner writes them: the recorded check-29br answers for what the plan asks, the rest by the same rule as the run's neighbours */
const recorded = { ...CHECK29BR_DECISIONS[0].p, ...CHECK29BR_DECISIONS[1].p, happened_M12: .99 }
const results = (answers = recorded, ms = { 'layer-place': 520, 'layer-fit': 310, 'layer-coverage': 640 }) => Object.fromEntries(['layer-place', 'layer-fit', 'layer-coverage'].map(id => [id, { status: 200, elapsedMs: ms[id], usage: { input_tokens: 1000, output_tokens: 20 },
  answers: namesOf(id).map(name => ({ name, type: 'predicate', probability: id === 'layer-coverage' ? (name.startsWith('stated_') ? .05 : .95) : answers[name] ?? .5 })) }]))

test('the plan is deterministic, within its 15k ceiling, and the committed files are its bytes', () => {
  assert.equal(LAYER_REPLAY_CEILING, 15000); assert.equal(built.plan.tokenCeiling, 15000); assert.ok(built.totals.estInputTokens <= 15000, String(built.totals.estInputTokens))
  assert.deepEqual(built.requests.map(r => r.id), ['layer-place', 'layer-fit', 'layer-coverage'])
  for (const f of [{ file: 'plan.json', bytes: built.planBytes }, ...built.files]) assert.ok(readFileSync(path.join(app, LAYER_REPLAY_DIR, f.file)).equals(f.bytes), `${f.file} is committed as built`)
  for (const f of built.files) assert.ok(estimateBodyTokens(f.bytes.toString('utf8')) > 0)
})
test('the runner loads it as a plan (dry run): product bars declared for every family, nothing sent, each body is the exact bytes of its file', () => {
  const plan = loadPlan(path.join(app, LAYER_REPLAY_DIR, 'plan.json'))
  assert.equal(plan.set, 'l4-briefing-layer-replay'); assert.equal(plan.requests.length, 3); assert.ok(plan.totals.estInputTokens <= plan.tokenCeiling)
  assert.deepEqual(Object.keys(plan.productBars).sort(), ['about_M#', 'combines', 'happened_M#', 'before_P#_P#', 'onboard_F#', 'same_M#_M#', 'slot_P#_r#', 'step_P#', 'stated_F#'].sort())
  assert.ok(plan.requests.every(r => /^[0-9a-f]{64}$/.test(r.sha256)))
})
test('the bodies carry the recorded real inputs: the request, the twelve ledger materials, the one-sentence answer of check-29br; the coverage is the table of check-25br with its six first facts', () => {
  const place = JSON.parse(built.files[0].bytes.toString('utf8')), text = JSON.stringify(place)
  assert.deepEqual(namesOf('layer-place').filter(n => n.startsWith('about_')).sort((x, y) => Number(x.slice('about_M'.length)) - Number(y.slice('about_M'.length))), Array.from({ length: 12 }, (_, i) => `about_M${i + 1}`), 'every entry is asked about (one question each, a log after a log)'); assert.equal(namesOf('layer-place')[0], 'combines')
  assert.ok(text.includes('ledger 폴더의 기록을 읽고') && text.includes('첨부했습니다') && text.includes('1,812'))
  assert.deepEqual(namesOf('layer-fit').sort((x, y) => Number(x.slice('happened_M'.length)) - Number(y.slice('happened_M'.length))), Array.from({ length: 12 }, (_, i) => `happened_M${i + 1}`))
  const cov = built.files.find(f => f.file === 'requests/layer-coverage.json').bytes.toString('utf8')
  assert.deepEqual(factsOf(cov).map(f => f.name), ['onboard_F1', 'onboard_F2', 'onboard_F3', 'onboard_F4', 'onboard_F5', 'onboard_F6'])
  assert.ok(!/api[-_ ]?key|OPENAI|Bearer/i.test(JSON.stringify(built.plan)), 'no key anywhere')
})
test('code-built structure of the records: two topics of six entries, one sequence card each in date order, the recorded fill carries the twelve facts', () => {
  assert.deepEqual(expectedTopics(ledgerMaterials()).map(t => [t.topic, t.aliases.join('/')]), [['integration', 'M1/M2/M4/M5/M7/M10'], ['measure', 'M3/M6/M8/M9/M11/M12']])
  assert.deepEqual(built.flows.s25.parts.map(p => [p[1], p[2]]).sort(), [['result_lines', 'M1/M2/M4/M5/M7/M10'], ['result_lines', 'M3/M6/M8/M9/M11/M12']]); assert.equal(built.flows.s25.kept, 12)
  assert.deepEqual(built.flows.s25.stages, ['place', 'fit', 'order', 'fill_check', 'coverage', 'coverage'])
})
test('replay of check-29br\'s own recorded answers (about_M12 .26, M11 .65): the product rules keep all twelve (M11 linked, M12 voted), two sequence cards in date order, the twelve facts on the cards', async () => {
  assert.equal(recorded.about_M12, .26); assert.equal(recorded.about_M11, .65)
  const report = await replayLayers({ results: results() })
  assert.deepEqual(report.hardFailures, [], JSON.stringify(report.checks.filter(c => !c.pass)))
  assert.deepEqual(report.layers.voted, ['M12']); assert.deepEqual(report.layers.linked, ['M11']); assert.equal(report.layers.kept.length, 12); assert.equal(report.layers.aboutSure, 10)
  assert.deepEqual(report.layers.parts.map(p => [p.shows, p.component]), [['sequence', 'result_lines'], ['sequence', 'result_lines']]); assert.equal(report.layers.status, 'presented')
  assert.deepEqual(report.table, [{ id: 'layer-place', ms: 520, recordedMs: 506 }, { id: 'layer-fit', ms: 310, recordedMs: 303 }, { id: 'layer-coverage', ms: 640, recordedMs: 662 }]); assert.equal(report.totalMs, 1470)
})
test('the replay fails where the layers fail: a whole log judged not relevant drops its entries (hard), and a run with no answers is not a pass', async () => {
  const noMeasure = await replayLayers({ results: results({ ...recorded, about_M3: .1, about_M6: .1, about_M8: .1, about_M9: .1, about_M11: .1, about_M12: .1 }) })
  assert.ok(noMeasure.hardFailures.includes('twelve entries kept') && noMeasure.layers.dropped.length === 6, JSON.stringify(noMeasure.layers))
  const none = await replayLayers({ results: {} }); assert.ok(none.hardFailures.length > 0 && none.checks.find(c => c.name.startsWith('every question')).observed.unanswered.length > 0)
})
test('the CLI rebuilds the committed plan byte for byte; nothing in the module can send (no fetch, no key, no network)', () => {
  const source = readFileSync(path.join(app, 'helper', 'egdesk-briefing-layer-replay.mjs'), 'utf8')
  assert.ok(!/\bfetch\(|OPENAI_API_KEY|process\.env/.test(source)); assert.ok(readFileSync(path.join(app, 'scripts', 'egdesk-briefing-layer-replay.mjs'), 'utf8').includes('Sends nothing, reads no key, starts no engine'))
})
