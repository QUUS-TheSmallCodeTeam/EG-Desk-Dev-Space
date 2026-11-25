// L2 c32: expect.timing (layers before the engine starts, engine rounds, first visible, final answer) and journey v10 (the merged layer-first flags as -off / -on pairs).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { TIMING_EXPECT_SCHEMA, judgeTiming, validateTimingExpect } from './egdesk-real-engine-timing-expect.mjs'
import { turnTiming } from './egdesk-real-engine-timing.mjs'
import { REAL_ENGINE_SCRIPT_SCHEMA, validateEngineScript } from './egdesk-real-engine-script.mjs'
import { commandFake, journeyWorld, runJourneyConversation } from '../scripts/egdesk-real-engine-journey.support.mjs'
import { LAYERS_BOUND_MS, PLACEHOLDERS, SCRIPTS_DIR, TESTS_ON_TURN_MS, U13_SET, buildU13Script, scriptText } from '../scripts/egdesk-real-engine-journey-u13-scripts.mjs'
import { secretsIn } from './egdesk-secret-mask.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const timed = () => turnTiming({ index: 1, posted: ['x'], subTurns: [{ status: 'completed', latencyMs: 9000, toolCalls: [{}, {}], decisions: [{ names: ['a'], atMs: 100, ms: 400 }],
  timing: { engineStartMs: 1000, doneMs: 9000, events: [{ event: 'activity.completed', atMs: 2600, kind: 'commandExecution' }, { event: 'message.completed', atMs: 8800 }],
    items: [{ id: 'm', type: 'agentMessage', startMs: 8000, endMs: 8700 }], tools: [{ id: 1, tool: 'a', startMs: 2500, endMs: 2700 }, { id: 2, tool: 'b', startMs: 5200, endMs: 5400 }] } }] })

test('expect.timing: the schema is in the committed schema file; the validator takes the right shapes and refuses the rest', () => {
  const committed = JSON.parse(fs.readFileSync(path.join(here, '..', 'scripts', 'real-engine', 'real-engine-script.schema.json'), 'utf8'))
  assert.deepEqual(committed, JSON.parse(JSON.stringify(REAL_ENGINE_SCRIPT_SCHEMA)))
  assert.deepEqual(committed.properties.conversations.items.properties.turns.items.properties.expect.properties.timing, JSON.parse(JSON.stringify(TIMING_EXPECT_SCHEMA)))
  const ok = e => assert.deepEqual(validateTimingExpect(e, {}), [], JSON.stringify(e)), bad = (e, re, turn = {}) => assert.match(validateTimingExpect(e, turn).join('\n'), re, JSON.stringify(e))
  ok({ layersMaxMs: 3000 }); ok({ engineStarted: false, answerMaxMs: 8000 }); ok({ maxEngineRounds: 0 }); ok({ firstVisibleMaxMs: 100 })
  bad({}, /at least one key/); bad({ x: 1 }, /unknown key/); bad({ layersMaxMs: 99 }, /100-600000/); bad({ answerMaxMs: 1.5 }, /integer/); bad({ maxEngineRounds: 31 }, /0-30/); bad({ engineStarted: 'no' }, /true or false/)
  bad({ engineStarted: false, maxEngineRounds: 2 }, /contradict/); bad({ layersMaxMs: 3000 }, /plain message turn/, { whileRunning: { afterMs: 1 } })
})

test('judgeTiming: each bound is judged on the measured row, a number the record does not have fails, never guessed', () => {
  const t = timed(), ok = e => judgeTiming(e, t).map(c => [c.check, c.ok])
  assert.deepEqual(ok({ layersMaxMs: 1000, answerMaxMs: 8800, firstVisibleMaxMs: 2600, maxEngineRounds: 3, engineStarted: true }), [['timing.layersMaxMs', true], ['timing.answerMaxMs', true], ['timing.firstVisibleMaxMs', true], ['timing.maxEngineRounds', true], ['timing.engineStarted', true]])
  assert.deepEqual(ok({ layersMaxMs: 999, answerMaxMs: 8799, firstVisibleMaxMs: 2599, maxEngineRounds: 2, engineStarted: false }).map(x => x[1]), [false, false, false, false, false])
  const old = turnTiming({ index: 1, posted: ['x'], subTurns: [{ latencyMs: 5000, decisions: [] }] })
  assert.deepEqual(judgeTiming({ layersMaxMs: 3000, firstVisibleMaxMs: 3000, engineStarted: true }, old).map(c => c.ok), [false, false, false], 'a record without timing cannot satisfy a timing bound')
  assert.deepEqual(judgeTiming({ layersMaxMs: 100 }, null).map(c => [c.check, c.ok]), [['timing', false]])
  // a decision-first turn ends without the engine: all of it is layers, and engineStarted false holds
  const local = turnTiming({ index: 1, posted: ['x'], subTurns: [{ latencyMs: 3000, decisions: [{ names: ['df_pick'], atMs: 50, ms: 400 }], timing: { engineStartMs: null, events: [{ event: 'message.completed', atMs: 2900 }], items: [], tools: [] } }] })
  assert.deepEqual(judgeTiming({ engineStarted: false, answerMaxMs: 3000, maxEngineRounds: 0 }, local).map(c => c.ok), [true, true, true])
})

const oneTurn = timing => ({ set: 'real-engine-timing-t-v1', conversations: [{ id: 'timing-t', turns: [{ say: 'run it', expect: { timing } }] }] })
test('through the check on the fake app-server: bounds that hold pass, bounds the run cannot meet fail by code (and the key lives in the schema, so the script validates)', async t => {
  const run = async timing => { const script = oneTurn(timing); assert.deepEqual(validateEngineScript(script), { ok: true, errors: [] }); const w = journeyWorld(t, commandFake({ command: 'sleep 20 && echo done-1', final: 'done-1' })); const rec = await runJourneyConversation(w, script, 'timing-t'); assert.equal(rec.aborted, null, rec.abortDetail); return rec.turns[0].expectations.filter(e => e.check.startsWith('timing.')) }
  const good = await run({ layersMaxMs: 5000, answerMaxMs: 20000, firstVisibleMaxMs: 20000, maxEngineRounds: 3, engineStarted: true })
  assert.deepEqual(good.map(e => [e.check, e.ok]), [['timing.layersMaxMs', true], ['timing.answerMaxMs', true], ['timing.firstVisibleMaxMs', true], ['timing.maxEngineRounds', true], ['timing.engineStarted', true]], JSON.stringify(good))
  const tight = await run({ answerMaxMs: 200, maxEngineRounds: 0, engineStarted: false })
  assert.deepEqual(tight.map(e => [e.check, e.ok]), [['timing.answerMaxMs', false], ['timing.maxEngineRounds', false], ['timing.engineStarted', false]]); assert.ok(tight[0].detail.finalAnswerMs > 200)
})

// ---- journey v10 ----
const load = name => JSON.parse(fs.readFileSync(path.join(SCRIPTS_DIR, `${name}.json`), 'utf8'))
test('journey v10: the committed file is the builder\'s output; six conversations as three -off/-on pairs; the lanes\' own scenarios kept, only ids and timing bounds are ours', () => {
  const built = buildU13Script(), file = load(U13_SET)
  assert.equal(fs.readFileSync(path.join(SCRIPTS_DIR, `${U13_SET}.json`), 'utf8'), scriptText(built)); assert.deepEqual(validateEngineScript(file), { ok: true, errors: [] }); assert.deepEqual(secretsIn(JSON.stringify(file)), [])
  assert.deepEqual(file.conversations.map(c => c.id), ['prefetch-notes-off', 'prefetch-notes-on', 'prefetch-code-off', 'prefetch-code-on', 'tests-off', 'tests-on']); assert.ok(file.conversations.length <= 8)
  const strip = c => ({ ...c, turns: c.turns.map(t => { const { timing, noToolCalls, decisionFirst, engine, ...rest } = t.expect; return { ...t, expect: rest } }) })
  for (const pair of ['prefetch-notes', 'prefetch-code']) { const off = file.conversations.find(c => c.id === `${pair}-off`), on = file.conversations.find(c => c.id === `${pair}-on`); assert.deepEqual(strip({ ...on, id: off.id, flags: off.flags }), strip(off), `${pair}: the pair differs only in the flag and what the flag must change`); assert.equal(on.flags.EGDESK_TURN_MEMORY_PREFETCH, 'files'); assert.equal(off.flags.EGDESK_TURN_MEMORY_PREFETCH, undefined) }
  const [off, on] = [file.conversations.find(c => c.id === 'tests-off'), file.conversations.find(c => c.id === 'tests-on')]
  assert.equal(on.flags.EGDESK_DECISION_FIRST, 'on'); assert.equal(off.flags, undefined); assert.deepEqual(on.folder, off.folder)
  // the bounds: layers 3,000 where the engine starts; the -on conversations one engine round (c36, L5: tests-on is action first, the value on: the command runs in the action layer, then the engine talks once; the card-only value is a proposal and not in this journey)
  for (const c of file.conversations) assert.equal(c.turns[0].expect.timing.layersMaxMs, LAYERS_BOUND_MS, c.id)
  assert.deepEqual(file.conversations.filter(c => c.turns[0].expect.timing.maxEngineRounds !== undefined).map(c => c.id), ['prefetch-notes-on', 'prefetch-code-on', 'tests-on'])
  assert.deepEqual(on.turns[0].expect.timing, { layersMaxMs: LAYERS_BOUND_MS, maxEngineRounds: 1 }); assert.equal(on.turns[0].expect.decisionFirst.path, 'action')
})

test('journey v10 placeholders: each unmerged flag says who owns it and what to add; none of them is in the script yet', () => {
  assert.deepEqual(PLACEHOLDERS.map(p => p.owner), ['L3', 'L1', 'L7']); assert.ok(PLACEHOLDERS.every(p => p.flag && p.source && p.add))
  const text = JSON.stringify(load(U13_SET)); assert.ok(!text.includes('EGDESK_DECISION_FIRST_APPROVALS')); assert.match(load(U13_SET).description, /Not in yet/)
})
