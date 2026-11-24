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

test('idle probe: a realistic ~2.5k-token turn_context body and the smallest one, first after idle and immediately after; ceilings within 8k; the registered readings', async () => {
  const { IDLE_CEILING, IDLE_DIR, analyzeIdle, buildIdlePlan } = await import('./egdesk-turn-context-latency-plan.mjs')
  const built = await buildIdlePlan(), idleDir = path.join(dir, '..', path.basename(IDLE_DIR))
  for (const run of built.runs) {
    assert.ok(readFileSync(path.join(idleDir, run.dir, 'plan.json')).equals(run.planBytes), `${run.dir}/plan.json is stale`)
    for (const f of run.files) assert.ok(readFileSync(path.join(idleDir, run.dir, f.file)).equals(f.bytes))
    const plan = loadPlan(path.join(idleDir, run.dir, 'plan.json'))
    assert.equal(plan.transport, 'product'); assert.ok(plan.requests.every(r => r.recordOnly && r.groupingOk && r.waitBeforeMs === 0))
    assert.match(plan.passRule, /at least 10 minutes with no Decisions request/)
  }
  assert.ok(built.runs.reduce((s, r) => s + r.plan.tokenCeiling, 0) <= IDLE_CEILING)
  const a1 = JSON.parse(built.runs[0].files[0].bytes.toString('utf8'))
  assert.equal(a1.questions.length, 14, 'answer_type, time_intent and 12 relevance questions, as the multiuser first turn')
  assert.ok(built.runs[0].plan.requests[0].estInputTokens >= 2400 && built.runs[0].plan.requests[0].estInputTokens <= 2800)
  const r = (ms, srv = 200) => ({ elapsedMs: ms, openaiProcessingMs: String(srv) })
  const A = { 'A1-realistic-first': r(1100, 600), 'A2-realistic-next': r(290), 'A3-small-next': r(250) }
  assert.equal(analyzeIdle([A, { 'B1-small-first': r(1000, 550), 'B2-small-next': r(240) }]).reading, 'idle gap explains it, whatever the size')
  assert.equal(analyzeIdle([A, { 'B1-small-first': r(320), 'B2-small-next': r(240) }]).reading, 'size matters on a cold path')
  assert.equal(analyzeIdle([{ 'A1-realistic-first': r(330), 'A2-realistic-next': r(290), 'A3-small-next': r(250) }, { 'B1-small-first': r(300), 'B2-small-next': r(240) }]).reading, 'all fast: the tail is intermittent; two samples cannot show it')
  assert.equal(analyzeIdle([A, {}]).reading, 'incomplete')
})

test('warm-up probe: six runs (A cold, B warm-up + 1 s, C warm-up + 10 s; two repetitions), record only through the product transport, ceilings within 10k; the registered readings', async () => {
  const { WARMUP_CEILING, WARMUP_DIR, WARMUP_RUNS, analyzeWarmup, buildWarmupPlan } = await import('./egdesk-turn-context-latency-plan.mjs')
  const built = await buildWarmupPlan(), wDir = path.join(dir, '..', path.basename(WARMUP_DIR))
  assert.deepEqual(built.runs.map(r => r.dir), ['A-rep1', 'B-rep1', 'C-rep1', 'A-rep2', 'B-rep2', 'C-rep2'])
  const bodies = new Set()
  for (const run of built.runs) {
    assert.ok(readFileSync(path.join(wDir, run.dir, 'plan.json')).equals(run.planBytes), `${run.dir}/plan.json is stale`)
    for (const f of run.files) { assert.ok(readFileSync(path.join(wDir, run.dir, f.file)).equals(f.bytes)); bodies.add(f.bytes.toString('utf8')) }
    const plan = loadPlan(path.join(wDir, run.dir, 'plan.json'))
    assert.equal(plan.transport, 'product'); assert.match(plan.passRule, /at least 10 minutes with no Decisions request/)
    assert.ok(plan.requests.every(r => r.recordOnly && r.groupingOk))
    assert.ok(plan.totals.fittedEst * 1.1 <= plan.tokenCeiling, 'the fitted estimate with its margin fits the run\'s ceiling')
    const ids = plan.requests.map(r => [r.id, r.waitBeforeMs])
    if (run.dir.startsWith('A')) assert.deepEqual(ids, [['measured', 0]])
    if (run.dir.startsWith('B')) assert.deepEqual(ids, [['warmup', 0], ['measured', 1000]])
    if (run.dir.startsWith('C')) assert.deepEqual(ids, [['warmup', 0], ['measured', 10000]])
  }
  assert.equal(bodies.size, 10, 'no two bodies are identical')
  assert.ok(built.totals.ceilings <= WARMUP_CEILING)
  const m = (ms, warm) => ({ measured: { elapsedMs: ms, openaiProcessingMs: '200', reusedSocket: warm }, ...(warm !== undefined ? { warmup: { elapsedMs: 1200 } } : {}) })
  const runs = (a, b, c) => Object.fromEntries(WARMUP_RUNS.map(([d]) => [d, d.startsWith('A') ? m(a) : d.startsWith('B') ? m(b, true) : m(c, true)]))
  assert.equal(analyzeWarmup(runs(1100, 300, 290)).reading, 'warm-up works')
  assert.equal(analyzeWarmup(runs(1100, 950, 290)).reading, 'warm-up works with lead time (10 s, not 1 s)')
  assert.equal(analyzeWarmup(runs(1100, 300, 1000)).reading, 'warm-up does not help')
  assert.equal(analyzeWarmup(runs(320, 300, 290)).reading, 'inconclusive: the idle tail did not occur in A')
  assert.equal(analyzeWarmup({}).reading, 'incomplete')
})

test('warm-up reading while points are still missing: the readings still possible, and the one already fixed (c18)', async () => {
  const { WARMUP_RUNS, analyzeWarmup } = await import('./egdesk-turn-context-latency-plan.mjs')
  const point = (ms, warm) => ({ measured: { elapsedMs: ms, openaiProcessingMs: '200', reusedSocket: warm === true }, ...(warm !== undefined ? { warmup: { elapsedMs: 1500 } } : {}) })
  const some = obj => Object.fromEntries(Object.entries(obj).map(([k, v]) => [WARMUP_RUNS.find(([d]) => d.startsWith(k.slice(0, 1)) && d.endsWith(k.slice(1)))[0], v]))
  // nothing in: all four readings are possible
  const none = analyzeWarmup({})
  assert.equal(none.reading, 'incomplete'); assert.equal(none.pointsIn, 0); assert.equal(none.decidedAlready, null); assert.equal(none.possibleReadings.length, 4)
  // the real state at c18 start: A1 slow (1,812 ms), B1 fast (324 ms)
  const live = analyzeWarmup(some({ 'A-rep1': point(1812), 'B-rep1': point(324, true) }))
  assert.equal(live.pointsIn, 2); assert.equal(live.decidedAlready, null)
  assert.ok(!live.possibleReadings.includes('inconclusive: the idle tail did not occur in A'), 'A was slow once: the tail occurred')
  assert.deepEqual(live.possibleReadings.sort(), ['warm-up does not help', 'warm-up works', 'warm-up works with lead time (10 s, not 1 s)'].sort())
  // C1 slow fixes "does not help", whatever A2, B2, C2 show
  const slowC = analyzeWarmup(some({ 'A-rep1': point(1812), 'B-rep1': point(324, true), 'C-rep1': point(900, true) }))
  assert.equal(slowC.decidedAlready, 'warm-up does not help'); assert.equal(slowC.reading, 'incomplete')
  // C1 fast: still open (A2 may be fast, C2 may be slow, B2 may be slow)
  const fastC = analyzeWarmup(some({ 'A-rep1': point(1812), 'B-rep1': point(324, true), 'C-rep1': point(300, true) }))
  assert.equal(fastC.decidedAlready, null); assert.equal(fastC.possibleReadings.length, 3)
  // both A fast: inconclusive can only be overturned by nothing: A fast twice fixes it
  const inconclusive = analyzeWarmup(some({ 'A-rep1': point(300), 'A-rep2': point(310) }))
  assert.equal(inconclusive.decidedAlready, 'inconclusive: the idle tail did not occur in A')
  // all six in: decided, and equal to the reading
  const all = analyzeWarmup(some({ 'A-rep1': point(1812), 'B-rep1': point(324, true), 'C-rep1': point(300, true), 'A-rep2': point(1500), 'B-rep2': point(310, true), 'C-rep2': point(320, true) }))
  assert.equal(all.reading, 'warm-up works'); assert.equal(all.decidedAlready, 'warm-up works'); assert.equal(all.pointsIn, 6)
})
