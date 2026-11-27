// The turn_context budget (owner decision 2026-11-25; values raised by u5 on 11-26 to Main's approved ceilings, see the constants' comment):
// 1,800 ms for the first turn of a conversation and whenever the Decisions transport has no warm connection, 1,200 ms otherwise (codex-chat-runtime.mjs TURN_CONTEXT_BUDGET_MS / TURN_CONTEXT_COLD_BUDGET_MS; the bridge passes both
// and the transport's warm()). Mock provider with fixed delays; offline.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { allOnWorld, scriptedDecisions } from './egdesk-all-on.support.mjs'
import { SAYS } from './egdesk-all-on-live-measure.mjs'
import { TURN_CONTEXT_BUDGET_MS, TURN_CONTEXT_COLD_BUDGET_MS } from '../helper/codex-chat-runtime.mjs'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
function world(t, { delays, warm, env = {} }) {
  const scripted = scriptedDecisions()
  let n = 0
  const w = allOnWorld(t, { env, transport: async ({ wire }) => {
    if (wire.questions.some(q => q.name === 'answer_type')) await sleep(delays[n++] ?? 0)
    return { status: 200, json: { answers: await scripted.answer(wire), usage: { input_tokens: 10 } } }
  } })
  Object.assign(w.chat.decisionContext, { budgetMs: TURN_CONTEXT_BUDGET_MS, coldBudgetMs: TURN_CONTEXT_COLD_BUDGET_MS, warm: () => warm.value })
  return w
}
const lastContext = w => w.turnStarts().at(-1).params.additionalContext?.egdesk_decision_context?.value ?? null
const entryOf = w => [...w.chat.runs.values()].map(run => w.chat.draftCheckTurns.get(run)).filter(Boolean).at(-1)

test('the values: 1,200 ms warm, 1,800 ms cold (u5: p90 of 19 real calls is 934 ms, the largest uncut one 1,070 ms)', () => {
  assert.deepEqual([TURN_CONTEXT_BUDGET_MS, TURN_CONTEXT_COLD_BUDGET_MS], [1200, 1800])
})

test('cold first turn, provider 1.7 s: within the 1.8 s budget, the selection is attached', async t => {
  const w = world(t, { delays: [1700], warm: { value: true } }) // the first turn is cold whatever the pool says
  await w.settings.turnMemory.save('on')
  await w.send(SAYS.quote)
  assert.match(lastContext(w) ?? '', /\[item id=ontology:quote\//)
})

test('warm mid-session turn: the 1,200 ms path (0.3 s and 1.1 s attach, 1.4 s falls back)', async t => {
  const warm = { value: true }
  const w = world(t, { delays: [0, 300, 1100, 1400], warm })
  await w.settings.turnMemory.save('on')
  await w.send(SAYS.quote)
  await w.answer('A사 견적은 v1 발송 후 v2 수정 계획 단계입니다.')
  await w.send(SAYS.quote)
  assert.match(lastContext(w) ?? '', /\[item id=ontology:quote\//, '0.3 s answers within 1,200 ms')
  await w.answer('같은 내용입니다.')
  await w.send(SAYS.quote)
  assert.match(lastContext(w) ?? '', /\[item id=ontology:quote\//, '1.1 s (it missed the old 800 ms budget) answers within 1,200 ms')
  await w.answer('또 같은 내용입니다.')
  await w.send(SAYS.quote)
  assert.equal(lastContext(w), null, '1.4 s misses the warm 1,200 ms budget')
})

test('cold mid-session turn (no warm socket), provider 1.6 s: the 1.8 s budget applies', async t => {
  const warm = { value: true }
  const w = world(t, { delays: [0, 1600], warm })
  await w.settings.turnMemory.save('on')
  await w.send(SAYS.quote)
  await w.answer('A사 견적은 v1 발송 후 v2 수정 계획 단계입니다.')
  warm.value = false
  await w.send(SAYS.quote)
  assert.match(lastContext(w) ?? '', /\[item id=ontology:quote\//)
})

test('cold first turn, provider 2.1 s: past the 1.8 s deadline the turn goes without it; with keepLate the late result is the check\'s evidence', async t => {
  const w = world(t, { delays: [2100], warm: { value: false }, env: { EGDESK_TURN_MEMORY_KEEP_LATE: 'on' } })
  await w.settings.turnMemory.save('on')
  await w.send(SAYS.quote)
  for (const end = Date.now() + 8000; Date.now() < end && !(entryOf(w)?.lateEvidence >= 1);) await sleep(25) // polled, not a fixed wait
  assert.equal(lastContext(w), null)
  const entry = entryOf(w)
  assert.ok(entry.lateEvidence >= 1)
  assert.ok(entry.evidence.some(e => /^ontology:quote\//.test(e.id ?? '')))
})

test('the bridge passes the budgets and the transport\'s warm() explicitly', () => {
  const source = readFileSync(new URL('../helper/codex-bridge-server.mjs', import.meta.url), 'utf8')
  assert.match(source, /budgetMs: TURN_CONTEXT_BUDGET_MS, coldBudgetMs: TURN_CONTEXT_COLD_BUDGET_MS, warm: \(\) => decisionTransport\.warm\(\),/)
})
