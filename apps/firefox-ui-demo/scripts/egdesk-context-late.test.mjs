// A turn_context answer that misses its 800 ms budget (real first turns: 946 ms in L1 c20, 1,098 ms in c21). With the internal flag
// EGDESK_TURN_MEMORY_KEEP_LATE=on the turn still goes without it (the model receives exactly what it received before), and the late answer
// reaches the later steps of the same turn: the draft check's evidence and the calibration record. Mock provider answering in 1.1 s; offline.
import test from 'node:test'
import assert from 'node:assert/strict'
import { allOnWorld, scriptedDecisions } from './egdesk-all-on.support.mjs'
import { SAYS } from './egdesk-all-on-live-measure.mjs'
import { TURN_CONTEXT_BUDGET_MS } from '../helper/codex-chat-runtime.mjs'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
function slowTurnContext(ms = TURN_CONTEXT_BUDGET_MS + 300) { // 300 ms past the budget, whatever the budget is (u5: 800 -> 1,200)
  const scripted = scriptedDecisions()
  return async ({ wire }) => {
    if (wire.questions.some(q => q.name === 'answer_type')) await sleep(ms)
    return { status: 200, json: { answers: await scripted.answer(wire), usage: { input_tokens: 10 } } }
  }
}
async function firstTurn(t, env) {
  const w = allOnWorld(t, { transport: slowTurnContext(), env })
  await w.settings.turnMemory.save('on')
  await w.send(SAYS.quote)
  // the late answer (budget + 300 ms) is in before the answer is written; the turn was sent at the budget. Polled, not a fixed wait (a loaded gate failed it once).
  const want = env.EGDESK_TURN_MEMORY_KEEP_LATE === 'on' ? 2 : 1
  for (const end = Date.now() + 8000; Date.now() < end && w.calibrationLog.entries().filter(e => e.feature === 'turn_context').length < want;) await sleep(25)
  await w.idle?.()
  const start = w.turnStarts().at(-1)
  const entry = [...w.chat.runs.values()].map(run => w.chat.draftCheckTurns.get(run)).filter(Boolean).at(-1)
  const late = w.calibrationLog.entries().filter(e => e.feature === 'turn_context')
  return { start, entry, late }
}

test('flag off (default): the late answer is aborted at the budget; the check has no selection evidence', async t => {
  const { start, entry, late } = await firstTurn(t, {})
  assert.equal(start.params.additionalContext?.egdesk_decision_context, undefined)
  assert.ok(entry)
  assert.equal(entry.evidence.filter(e => /^ontology:/.test(e.id ?? '')).length, 0)
  assert.equal(entry.lateEvidence, undefined)
  assert.deepEqual(late.map(e => e.fallback ?? null), ['timeout'])
})

test('EGDESK_TURN_MEMORY_KEEP_LATE=on: same native turn, and the late items become the check\'s evidence and a late calibration entry', async t => {
  const off = await firstTurn(t, {})
  const { start, entry, late } = await firstTurn(t, { EGDESK_TURN_MEMORY_KEEP_LATE: 'on' })
  assert.equal(start.params.additionalContext?.egdesk_decision_context, undefined, 'never attached to the turn that already went')
  assert.deepEqual(Object.keys(start.params.additionalContext ?? {}), Object.keys(off.start.params.additionalContext ?? {}))
  const items = entry.evidence.filter(e => /^ontology:quote\//.test(e.id ?? ''))
  assert.ok(items.length >= 1)
  assert.equal(entry.lateEvidence, items.length)
  for (const item of items) assert.equal(item.guarded, undefined)
  assert.equal(late.length, 2)
  assert.equal(late[0].fallback, 'timeout')
  assert.equal(late[1].late, true)
  assert.equal(late[1].attached, false)
  assert.ok(late[1].lateMs >= 0 && late[1].lateMs < 1500)
})
