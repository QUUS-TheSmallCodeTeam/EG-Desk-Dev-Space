import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
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
  assert.deepEqual(BUDGETS, { warm: 800, cold: 1500 }, 'the budgets the probes were registered against (the product moved to 1,200 / 1,800 in u5; the registered plans keep theirs)')
})

test('latency analysis: budgets per request from the product\'s warm() reading; a missing request is reported, not counted', () => {
  const r = (elapsedMs, warmBefore, reusedSocket) => ({ status: 200, elapsedMs, warmBefore, reusedSocket, openaiProcessingMs: '180', usage: { cached_tokens: 0 } })
  const out = analyzeLatency([{ 'a-first': r(1098, false, false), 'b-immediate': r(300, true, true), 'c-after-20s': r(820, true, true), 'd-after-70s': r(1200, false, false) }, { 'a-first': r(950, false, false) }])
  const row = (rep, id) => out.rows.find(x => x.rep === rep && x.id === id)
  assert.deepEqual([row(1, 'a-first').within800, row(1, 'a-first').within1500, row(1, 'a-first').withinProductBudget], [false, true, true])
  assert.deepEqual([row(1, 'c-after-20s').productBudget, row(1, 'c-after-20s').withinProductBudget], [BUDGETS.warm, false], 'warm means the 800 ms budget of the registered plan')
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

test('body-size probe: two runs (product warm-up body vs the 648-token one, each then a measured turn_context 1 s later), <= 3k, record only, committed files match, registered readings', async () => {
  const { SIZE_CEILING, SIZE_DIR, SIZE_ESTIMATE_BOUND, SIZE_RUNS, analyzeSize, buildSizePlan } = await import('./egdesk-turn-context-latency-plan.mjs')
  const { CONTENT_FREE_REQUESTS } = await import('./egdesk-decision-egress.mjs')
  const built = await buildSizePlan(), sDir = path.join(dir, '..', path.basename(SIZE_DIR))
  assert.deepEqual(built.runs.map(r => r.dir), ['S1-small', 'S2-large'])
  assert.ok(built.totals.estInputTokens <= SIZE_ESTIMATE_BOUND && built.totals.ceilings <= SIZE_CEILING, JSON.stringify(built.totals))
  assert.equal(built.totals.requests, 4)
  const bodies = new Set()
  for (const run of built.runs) {
    assert.ok(readFileSync(path.join(sDir, run.dir, 'plan.json')).equals(run.planBytes), `${run.dir}/plan.json is stale`)
    for (const f of run.files) { assert.ok(readFileSync(path.join(sDir, run.dir, f.file)).equals(f.bytes)); bodies.add(f.bytes.toString('utf8')) }
    const plan = loadPlan(path.join(sDir, run.dir, 'plan.json'))
    assert.equal(plan.transport, 'product'); assert.match(plan.passRule, /at least 10 minutes with no Decisions request/)
    assert.ok(plan.requests.every(r => r.recordOnly && r.groupingOk))
    assert.ok(plan.totals.fittedEst * 1.1 <= plan.tokenCeiling)
    assert.deepEqual(plan.requests.map(r => [r.id, r.waitBeforeMs]), [['warmup', 0], ['measured', 1000]])
  }
  assert.equal(bodies.size, 4, 'no two bodies are identical')
  // S1's warm-up is byte for byte the body the product sends (model, input, questions), and nothing else
  const s1 = built.runs[0].files.find(f => f.file.endsWith('warmup.json')).bytes.toString('utf8')
  assert.equal(s1, JSON.stringify({ model: JSON.parse(s1).model, input: CONTENT_FREE_REQUESTS.warmup.input, questions: CONTENT_FREE_REQUESTS.warmup.questions }))
  const sizeOf = r => r.plan.requests.find(x => x.id === 'warmup').estInputTokens
  assert.ok(sizeOf(built.runs[0]) < 200 && sizeOf(built.runs[1]) > 600, 'about 159 against about 648 tokens')
  const run = (warmupMs, measuredMs) => ({ warmup: { elapsedMs: warmupMs, openaiProcessingMs: '300' }, measured: { elapsedMs: measuredMs, openaiProcessingMs: '200', reusedSocket: true } })
  const read = (a, b) => analyzeSize({ 'S1-small': a, 'S2-large': b }).reading
  assert.equal(analyzeSize({}).reading, 'incomplete')
  assert.equal(read(run(1500, 300), run(1400, 320)), 'size does not matter')
  assert.match(read(run(400, 300), run(500, 320)), /^inconclusive/)
  assert.match(read(run(1500, 300), run(500, 320)), /^one run only/)
  assert.match(read(run(1500, 1200), run(1400, 320)), /^small body does not warm/)
  assert.match(read(run(1500, 300), run(1400, 1200)), /^large body failed while the small one warmed/)
  assert.match(read(run(1500, 1200), run(1400, 1100)), /^warm-up did not help/)
  assert.deepEqual(SIZE_RUNS.map(([d]) => d), ['S1-small', 'S2-large'])
})

test('separating probe: N1, N2 (warm-up, then the same socket, then a NEW socket) and Y1 (a reused socket after a 10-minute idle), <= 4k estimated, record only, committed files match', async () => {
  const { SEP_CEILING, SEP_DIR, SEP_ESTIMATE_BOUND, SEP_IDLE_WAIT_MS, SEP_RUNS, SEP_SOCKET_IDLE_MS, SEP_WAIT_LIMIT_MS, buildSeparationPlan } = await import('./egdesk-turn-context-latency-plan.mjs')
  const { CONTENT_FREE_REQUESTS } = await import('./egdesk-decision-egress.mjs')
  const built = await buildSeparationPlan(), sDir = path.join(dir, '..', path.basename(SEP_DIR))
  assert.deepEqual(built.runs.map(r => r.dir), ['N1', 'N2', 'Y1'])
  assert.ok(built.totals.estInputTokens <= SEP_ESTIMATE_BOUND && built.totals.ceilings <= SEP_CEILING, JSON.stringify(built.totals))
  assert.equal(built.totals.requests, 8)
  const bodies = new Set()
  for (const run of built.runs) {
    assert.ok(readFileSync(path.join(sDir, run.dir, 'plan.json')).equals(run.planBytes), `${run.dir}/plan.json is stale`)
    for (const f of run.files) { assert.ok(readFileSync(path.join(sDir, run.dir, f.file)).equals(f.bytes)); bodies.add(f.bytes.toString('utf8')) }
    const plan = loadPlan(path.join(sDir, run.dir, 'plan.json'))
    assert.equal(plan.transport, 'product'); assert.match(plan.passRule, /at least 10 minutes with no Decisions request/)
    assert.ok(plan.requests.every(r => r.recordOnly && r.groupingOk))
    assert.ok(plan.totals.fittedEst * 1.1 <= plan.tokenCeiling)
  }
  assert.equal(bodies.size, 6, 'the five turn_context bodies all differ; the three warm-up bodies are the one fixed product body (the product sends it every time)')
  const plans = Object.fromEntries(built.runs.map(r => [r.dir, loadPlan(path.join(sDir, r.dir, 'plan.json'))]))
  for (const n of ['N1', 'N2']) {
    assert.deepEqual(plans[n].requests.map(r => [r.id, r.waitBeforeMs, r.freshSocket]), [['warmup', 0, false], ['same', 1000, false], ['fresh', 1000, true]])
    assert.deepEqual([plans[n].transportIdleMs, plans[n].waitLimitMs], [null, null], 'the N runs use the product transport as it is')
  }
  assert.deepEqual(plans.Y1.requests.map(r => [r.id, r.waitBeforeMs, r.freshSocket]), [['first', 0, false], ['after', SEP_IDLE_WAIT_MS, false]])
  assert.deepEqual([plans.Y1.transportIdleMs, plans.Y1.waitLimitMs], [SEP_SOCKET_IDLE_MS, SEP_WAIT_LIMIT_MS])
  assert.ok(SEP_SOCKET_IDLE_MS > SEP_IDLE_WAIT_MS, 'the socket may outlive the idle')
  // the warm-up bodies are byte for byte the body the product sends
  for (const [run, id] of [['N1', 'warmup'], ['N2', 'warmup'], ['Y1', 'first']]) {
    const text = built.runs.find(r => r.dir === run).files.find(f => f.file.endsWith(`${id}.json`)).bytes.toString('utf8')
    assert.equal(text, JSON.stringify({ model: JSON.parse(text).model, input: CONTENT_FREE_REQUESTS.warmup.input, questions: CONTENT_FREE_REQUESTS.warmup.questions }))
  }
  assert.deepEqual(SEP_RUNS.map(([d]) => d), ['N1', 'N2', 'Y1'])
})

test('separating probe readings: informative N runs (tail and a held warm-up), the new socket fast or slow, and what Y1 says', async () => {
  const { analyzeSeparation } = await import('./egdesk-turn-context-latency-plan.mjs')
  const r = (ms, extra = {}) => ({ elapsedMs: ms, openaiProcessingMs: '200', ...extra })
  const nRun = (warmup, same, fresh) => ({ warmup: r(warmup), same: r(same, { reusedSocket: true }), fresh: r(fresh, { reusedSocket: false, freshSocket: true, connectMs: 15, tlsMs: 25 }) })
  const yRun = (first, after, reused = true) => ({ first: r(first), after: r(after, { reusedSocket: reused, waitedMs: 600000 }) })
  const read = (n1, n2, y) => analyzeSeparation({ N1: n1, N2: n2, Y1: y }).reading
  assert.equal(analyzeSeparation({}).reading, 'incomplete'); assert.equal(read(nRun(1500, 300, 310), null, yRun(1200, 700, false)), 'incomplete')
  // a new socket fast after a warm-up that followed a tail: warmth, not the socket
  assert.match(read(nRun(1500, 300, 310), nRun(500, 300, 900), yRun(1200, 700, false)), /^warmth, not the socket/)
  // a new socket slow after a held warm-up that followed a tail: the socket matters
  assert.match(read(nRun(1500, 300, 1100), nRun(500, 300, 310), yRun(1200, 700, false)), /^the socket matters/)
  // informative runs disagree
  assert.match(read(nRun(1500, 300, 1100), nRun(1400, 310, 320), yRun(1200, 700, false)), /^mixed/)
  // no run informative: no tail in either, or the warm-up did not hold
  assert.match(read(nRun(500, 300, 310), nRun(600, 320, 1500), yRun(1200, 700, false)), /^inconclusive/)
  assert.match(read(nRun(1500, 900, 310), nRun(1400, 1000, 320), yRun(1200, 700, false)), /^inconclusive/)
  // Y1 reused and fast qualifies a "warmth" reading
  assert.match(read(nRun(1500, 300, 310), nRun(1400, 310, 320), yRun(1200, 300, true)), /^reuse alone is fast too/)
  const out = analyzeSeparation({ N1: nRun(1500, 300, 310), N2: nRun(500, 300, 900), Y1: yRun(1200, 1300, true) })
  assert.deepEqual([out.runs.N1.informative, out.runs.N2.informative, out.runs.N1.freshFlag, out.runs.N1.freshReused, out.runs.N1.freshConnectMs], [true, false, true, false, 15])
  assert.equal(out.runs.Y1.reading, 'reused and slow: reuse does not prevent the tail')
  assert.equal(analyzeSeparation({ Y1: yRun(1200, 700, false) }).runs.Y1.reading, 'socket did not survive the idle: reuse after a long idle is not available')
  assert.equal(analyzeSeparation({ Y1: yRun(1200, 300, true) }).runs.Y1.reading, 'reused and fast: weak (the tail is intermittent), repeat')
})
