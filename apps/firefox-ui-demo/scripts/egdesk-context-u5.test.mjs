// u5 (11-26): the context call cut by its budget. Real evidence: decision-call log 11-26 04:47 (context 672 ms ok, 679 ms ok, 813 ms aborted at the
// old 800 ms budget) and L5 u3's 16 turns (median 0.62 s, max 1.07 s, one fallback at 1.52 s). Replay with a mock provider and fixed delays; offline.
//   (a) the 813 ms call against the OLD 800 ms budget: the turn goes without the context (engine input unchanged); with the flag the bundle fills
//       (EGDESK_TURN_MEMORY_KEEP_LATE) the call finishes in the background and its picked materials are the same turn's pre-posting check evidence.
//   (b) the shipped budget (1,200 warm / 1,800 cold) no longer cuts that call; a call past it (1,350 ms) is still cut and still handed over late.
//   (c) the bundle carries the flag; an explicit value still wins.
import test from 'node:test'
import assert from 'node:assert/strict'
import { allOnWorld, scriptedDecisions } from './egdesk-all-on.support.mjs'
import { SAYS } from './egdesk-all-on-live-measure.mjs'
import { TURN_CONTEXT_BUDGET_MS, TURN_CONTEXT_COLD_BUDGET_MS, LATE_CONTEXT_MS } from '../helper/codex-chat-runtime.mjs'
import { NOT_IN_BUNDLE, UPPER_BUNDLE, upperBundleFlags } from '../helper/egdesk-upper-bundle.mjs'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const lastContext = w => w.turnStarts().at(-1).params.additionalContext?.egdesk_decision_context?.value ?? null
const entryOf = w => [...w.chat.runs.values()].map(run => w.chat.draftCheckTurns.get(run)).filter(Boolean).at(-1)
const bundleEnv = (extra = {}) => ({ ...Object.fromEntries(Object.entries(upperBundleFlags({ EGDESK_UPPER: 'on', ...extra }).flags).filter(([k]) => k === 'EGDESK_TURN_MEMORY_KEEP_LATE')), ...extra })

// Poll instead of a fixed sleep: under a loaded gate a fixed wait was the one flaky part of the late tests (u5).
async function until(cond, limitMs = 8000) { const end = Date.now() + limitMs; while (Date.now() < end) { if (cond()) return true; await sleep(25) } return cond() }

// One first turn whose context call takes `ms`; `budget` = null keeps the shipped values (both passed like the bridge does), a number = one old-style budget.
async function turn(t, { ms, budget = null, env = {} }) {
  const scripted = scriptedDecisions()
  const w = allOnWorld(t, { env, transport: async ({ wire }) => {
    if (wire.questions.some(q => q.name === 'answer_type')) await sleep(ms)
    return { status: 200, json: { answers: await scripted.answer(wire), usage: { input_tokens: 10 } } }
  } })
  const setup = w.chat.decisionContext
  if (budget === null) Object.assign(setup, { budgetMs: TURN_CONTEXT_BUDGET_MS, coldBudgetMs: TURN_CONTEXT_COLD_BUDGET_MS, warm: () => true })
  else Object.assign(setup, { budgetMs: budget })
  await w.settings.turnMemory.save('on')
  await w.send(SAYS.quote)
  const keepLate = env.EGDESK_TURN_MEMORY_KEEP_LATE === 'on'
  const cut = () => w.calibrationLog.entries().some(e => e.feature === 'turn_context' && e.fallback === 'timeout')
  // the call is settled: answered in budget (an entry without fallback), or cut and, with the flag, answered late (the second entry)
  await until(() => { const n = w.calibrationLog.entries().filter(e => e.feature === 'turn_context').length; return cut() ? (keepLate ? n >= 2 : true) : n >= 1 })
  await w.idle?.()
  return { w, entry: entryOf(w), calls: w.calibrationLog.entries().filter(e => e.feature === 'turn_context') }
}
const quoteItems = entry => entry.evidence.filter(e => /^ontology:quote\//.test(e.id ?? ''))

test('(a) 813 ms against the old 800 ms budget, flag off: cut at the budget, the check has no selection evidence', async t => {
  const { w, entry, calls } = await turn(t, { ms: 813, budget: 800 })
  assert.equal(lastContext(w), null)
  assert.equal(quoteItems(entry).length, 0)
  assert.equal(entry.lateEvidence, undefined)
  assert.deepEqual(calls.map(e => e.fallback ?? null), ['timeout'])
})

test('(a) 813 ms against the old 800 ms budget, flag on (what EGDESK_UPPER fills): the engine input is the same, and the late materials are the check\'s evidence', async t => {
  const off = await turn(t, { ms: 813, budget: 800 })
  const on = await turn(t, { ms: 813, budget: 800, env: bundleEnv() })
  assert.equal(lastContext(on.w), null, 'never attached to the turn that already went')
  assert.deepEqual(on.w.turnStarts().at(-1).params.additionalContext ?? {}, off.w.turnStarts().at(-1).params.additionalContext ?? {}, 'engine input unchanged (the whole additional context)')
  const items = quoteItems(on.entry)
  assert.ok(items.length >= 1, 'the picked materials reached the check')
  assert.equal(on.entry.lateEvidence, items.length)
  for (const item of items) assert.equal(item.guarded, undefined)
  assert.equal(on.calls.length, 2)
  assert.equal(on.calls[0].fallback, 'timeout')
  assert.equal(on.calls[1].late, true)
  assert.ok(on.calls[1].lateMs >= 0 && on.calls[1].lateMs < LATE_CONTEXT_MS, `late by ${on.calls[1].lateMs} ms`)
})

test('(b) the shipped budget: the 813 ms call is attached (not cut), also with the flag on; nothing is handed over late', async t => {
  assert.ok(813 < TURN_CONTEXT_BUDGET_MS)
  for (const env of [{}, bundleEnv()]) {
    const { w, entry, calls } = await turn(t, { ms: 813, env })
    assert.match(lastContext(w) ?? '', /\[item id=ontology:quote\//)
    assert.equal(entry.lateEvidence, undefined)
    assert.ok(quoteItems(entry).length >= 1, 'the attached selection is the check\'s evidence as before')
    assert.deepEqual(calls.map(e => e.fallback ?? null), [null])
  }
})

test('(b) the shipped budget: a call past it (budget + 150 ms) is cut, and with the flag its late result is still the check\'s evidence', async t => {
  const ms = TURN_CONTEXT_BUDGET_MS + 150
  const off = await turn(t, { ms, budget: TURN_CONTEXT_BUDGET_MS })
  assert.equal(lastContext(off.w), null)
  assert.equal(quoteItems(off.entry).length, 0)
  const on = await turn(t, { ms, budget: TURN_CONTEXT_BUDGET_MS, env: bundleEnv() })
  assert.equal(lastContext(on.w), null)
  assert.ok(quoteItems(on.entry).length >= 1)
  assert.equal(on.calls[1].late, true)
})

test('(c) the bundle carries EGDESK_TURN_MEMORY_KEEP_LATE=on (role turn, lane L7); it is no longer listed as excluded; an explicit value wins', () => {
  const row = UPPER_BUNDLE.find(r => r.flag === 'EGDESK_TURN_MEMORY_KEEP_LATE')
  assert.deepEqual([row?.value, row?.role, row?.lane], ['on', 'turn', 'L7'])
  assert.equal(NOT_IN_BUNDLE.EGDESK_TURN_MEMORY_KEEP_LATE, undefined)
  assert.equal(upperBundleFlags({ EGDESK_UPPER: 'on' }).flags.EGDESK_TURN_MEMORY_KEEP_LATE, 'on')
  assert.equal(upperBundleFlags({ EGDESK_UPPER: 'on', EGDESK_TURN_MEMORY_KEEP_LATE: 'off' }).flags.EGDESK_TURN_MEMORY_KEEP_LATE, 'off')
  assert.equal(upperBundleFlags({}).flags.EGDESK_TURN_MEMORY_KEEP_LATE, undefined, 'default off without EGDESK_UPPER')
})

test('(c) the budget values stay inside Main\'s approved ceilings (warm <= 1,200 ms, cold <= 1,800 ms) and cover the measured p90 (934 ms)', () => {
  assert.ok(TURN_CONTEXT_BUDGET_MS >= 934 && TURN_CONTEXT_BUDGET_MS <= 1200)
  assert.ok(TURN_CONTEXT_COLD_BUDGET_MS > TURN_CONTEXT_BUDGET_MS && TURN_CONTEXT_COLD_BUDGET_MS <= 1800)
})
