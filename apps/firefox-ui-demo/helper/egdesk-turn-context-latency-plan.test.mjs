import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { TURN_CONTEXT_BUDGET_MS, TURN_CONTEXT_COLD_BUDGET_MS } from './codex-chat-runtime.mjs'
import { lintGroupedRequest } from './egdesk-decision-grouping.mjs'
import { DECISION_IDLE_MS } from './egdesk-decision-transport.mjs'
import { loadPlan } from './egdesk-decision-real-runner.mjs'
import { BUDGETS, CONDITIONS, LATENCY_CEILING, LATENCY_DIR, analyzeLatency, buildLatencyPlan } from './egdesk-turn-context-latency-plan.mjs'

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', LATENCY_DIR)

test('latency probe: committed files are what the product builds; two record-only repetitions through the product transport, waits as registered, within 6k', async () => {
  const built = await buildLatencyPlan()
  const bodies = new Set()
  for (const rep of built.reps) {
    assert.ok(readFileSync(path.join(dir, rep.dir, 'plan.json')).equals(rep.planBytes), `${rep.dir}/plan.json is stale`)
    for (const f of rep.files) { assert.ok(readFileSync(path.join(dir, rep.dir, f.file)).equals(f.bytes), `${rep.dir}/${f.file} is stale`); bodies.add(f.bytes.toString('utf8')) }
    const plan = loadPlan(path.join(dir, rep.dir, 'plan.json'))
    assert.equal(plan.transport, 'product')
    assert.deepEqual(plan.requests.map(r => [r.id, r.waitBeforeMs, r.recordOnly]), CONDITIONS.map(([id, wait]) => [id, wait, true]))
    assert.ok(plan.requests.every(r => r.groupingOk))
    for (const f of rep.files) { const body = JSON.parse(f.bytes.toString('utf8')); assert.ok(lintGroupedRequest(body).ok); assert.deepEqual(body.questions.map(q => q.name), ['answer_type', 'time_intent', 'rel_0']) }
  }
  assert.equal(bodies.size, 8, 'no two bodies are identical (a different message each time)')
  assert.ok(built.totals.estInputTokens * 1.1 <= LATENCY_CEILING)
  // the 70 s gap is past the transport's idle window; the 20 s gap is inside it
  assert.ok(CONDITIONS[3][1] > DECISION_IDLE_MS && CONDITIONS[2][1] < DECISION_IDLE_MS)
  assert.deepEqual(BUDGETS, { warm: TURN_CONTEXT_BUDGET_MS, cold: TURN_CONTEXT_COLD_BUDGET_MS })
})

test('latency analysis: budgets per request from the product\'s warm() reading; a missing request is reported, not counted', () => {
  const r = (elapsedMs, warmBefore, reusedSocket) => ({ status: 200, elapsedMs, warmBefore, reusedSocket, openaiProcessingMs: '180', usage: { cached_tokens: 0 } })
  const out = analyzeLatency([{ 'a-first': r(1098, false, false), 'b-immediate': r(300, true, true), 'c-after-20s': r(820, true, true), 'd-after-70s': r(1200, false, false) }, { 'a-first': r(950, false, false) }])
  const row = (rep, id) => out.rows.find(x => x.rep === rep && x.id === id)
  assert.deepEqual([row(1, 'a-first').within800, row(1, 'a-first').within1500, row(1, 'a-first').withinProductBudget], [false, true, true])
  assert.deepEqual([row(1, 'c-after-20s').productBudget, row(1, 'c-after-20s').withinProductBudget], [TURN_CONTEXT_BUDGET_MS, false], 'warm means the 800 ms budget')
  assert.equal(row(2, 'b-immediate').sent, false)
  assert.deepEqual([out.byCondition['a-first'].n, out.byCondition['a-first'].within800, out.byCondition['a-first'].within1500], [2, 0, 2])
})
