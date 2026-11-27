import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { buildPlan } from './egdesk-memory-real-plan.mjs'
import { diffPlan, planTable, runMeasurement } from './egdesk-memory-real-runner.mjs'

const KEY = 'egd-synthetic-not-a-key-0010'
const plan = await buildPlan()
const byBody = new Map(plan.runs.flatMap(run => run.requests.map(r => [JSON.stringify(r.body), r])))
const toApi = scripted => Object.entries(scripted).map(([name, a]) => ({ name, ...a }))
function mockFetch({ failAt = null, status = 200, throwAt = null, log = [] } = {}) {
  let n = 0
  const impl = async (url, init) => {
    n++; log.push({ url, init })
    if (throwAt === n) throw Object.assign(new Error(`socket hang up with ${init.headers.authorization}`), { name: 'TypeError' })
    const request = byBody.get(init.body)
    const code = failAt === n ? status : 200
    return { status: code, headers: { get: h => (h === 'openai-processing-ms' ? '120' : null) }, async json() { return code === 200 ? { answers: toApi(request.scripted), usage: { input_tokens: request.estInputTokens, output_tokens: 0 } } : { error: { code: 'x' } } } }
  }
  return { impl, log }
}

test('a dry run (the default) sends nothing, needs no key, and lists every request with its sha256 and expected tokens', async () => {
  const f = mockFetch()
  const out = await runMeasurement({ plan, fetchImpl: f.impl })
  assert.deepEqual([out.sent, out.stoppedBecause, f.log.length], [0, 'dry_run', 0])
  const table = planTable(plan)
  assert.equal(table.length, plan.totals.requests); assert.ok(table.every(r => r.sha256.length === 64 && r.estInputTokens > 0))
  assert.equal(out.totals.estInputTokens, plan.totals.estInputTokens)
})

test('no key, a short or whitespace key, or a token ceiling below the estimate: nothing is sent', async () => {
  for (const key of [null, '', 'short', 'has a space inside the key 123456789']) {
    const f = mockFetch(); const out = await runMeasurement({ plan, key, send: true, fetchImpl: f.impl })
    assert.deepEqual([out.stoppedBecause, f.log.length], ['no_key', 0])
  }
  const f = mockFetch(); const out = await runMeasurement({ plan, key: KEY, send: true, maxEstimatedTokens: 1000, fetchImpl: f.impl })
  assert.deepEqual([out.stoppedBecause, f.log.length], ['over_token_ceiling', 0])
})

test('every body is re-hashed against the plan first; one altered byte means nothing at all is sent', async () => {
  const tampered = { ...plan, runs: structuredClone(plan.runs) }
  tampered.runs[3].requests[1].body.input[1].content += ' '
  const f = mockFetch(); const out = await runMeasurement({ plan: tampered, key: KEY, send: true, fetchImpl: f.impl })
  assert.deepEqual([out.stoppedBecause, out.mismatch, out.sent, f.log.length], ['hash_mismatch', tampered.runs[3].requests[1].name, 0, 0])
})

test('real run shape: official endpoint only, POST, JSON + Authorization only, redirects refused, one attempt per request, in plan order, and the pre-registered answers score a full pass', async () => {
  const f = mockFetch(); const out = await runMeasurement({ plan, key: KEY, send: true, fetchImpl: f.impl })
  assert.equal(out.sent, plan.totals.requests); assert.equal(out.stoppedBecause, null)
  assert.ok(f.log.every(c => c.url === 'https://api.openai.com/v1/decisions' && c.init.method === 'POST' && c.init.redirect === 'error'))
  assert.ok(f.log.every(c => JSON.stringify(Object.keys(c.init.headers).sort()) === '["authorization","content-type"]'))
  assert.deepEqual(f.log.map(c => c.init.body), plan.runs.flatMap(run => run.requests.map(r => JSON.stringify(r.body))), 'sent in plan order, byte for byte')
  assert.deepEqual([out.scorecard.runsPassed, out.scorecard.pass], [6, true])
  assert.ok(!JSON.stringify(out).includes(KEY), 'the key is not in anything the runner returns')
  const first = Object.values(out.results)[0]
  assert.deepEqual(Object.keys(first).sort(), ['answers', 'elapsedMs', 'openaiProcessingMs', 'status', 'usage'])
})

test('no retries: the first non-200 stops the run, later requests are not sent and the measurement fails', async () => {
  const f = mockFetch({ failAt: 3, status: 500 }); const out = await runMeasurement({ plan, key: KEY, send: true, fetchImpl: f.impl })
  assert.deepEqual([f.log.length, out.sent, out.stoppedBecause], [3, 3, 'http_500'])
  assert.equal(out.scorecard.pass, false)
  const names = plan.runs.flatMap(r => r.requests.map(q => q.name))
  assert.ok(!names.slice(3).some(n => out.results[n]), 'nothing after the failure was attempted')
  const rate = mockFetch({ failAt: 1, status: 429 }); const limited = await runMeasurement({ plan, key: KEY, send: true, fetchImpl: rate.impl })
  assert.deepEqual([rate.log.length, limited.stoppedBecause], [1, 'http_429'])
})

test('a network failure stops the run and its error text, which may contain the key, is never kept', async () => {
  const f = mockFetch({ throwAt: 2 }); const out = await runMeasurement({ plan, key: KEY, send: true, fetchImpl: f.impl })
  assert.deepEqual([f.log.length, out.stoppedBecause], [2, 'network'])
  assert.ok(!JSON.stringify(out).includes(KEY)); assert.equal(Object.values(out.results).at(-1).error, 'network')
})

test('a saved plan is compared by name, order, size and sha256; any difference is reported', async () => {
  const saved = { requests: planTable(plan).map(({ name, sha256, bytes }) => ({ name, sha256, bytes })) }
  assert.deepEqual(diffPlan(plan, saved), [])
  const changed = structuredClone(saved); changed.requests[4].sha256 = '0'.repeat(64); changed.requests.pop()
  assert.equal(diffPlan(plan, changed).length, 3, 'count differs, one sha differs, and the last request has no counterpart')
})

test('the command line tool: dry run by default, the key only from OPENAI_API_KEY and never printed or written, no retry loop', async () => {
  const source = await readFile(new URL('../scripts/egdesk-memory-real-measure.mjs', import.meta.url), 'utf8')
  assert.match(source, /flag\('--send'\) \? process\.env\.OPENAI_API_KEY \?\? null : null/)
  assert.equal((source.match(/process\.env/g) ?? []).length, 1, 'one environment variable is read')
  const code = source.replace(/\/\/.*$/gm, '').replace(/(['"`])(?:\\.|(?!\1).)*\1/g, '""') // comments and string literals out
  assert.equal((code.match(/\bkey\b/g) ?? []).length, 2, 'the key identifier appears only where it is read and handed to the runner, never in a print or write')
  assert.ok(!/writeFileSync\([^)]*key/.test(source) && !/retry|attempt/i.test(source.replace(/No retries/g, '')))
  const runner = await readFile(new URL('./egdesk-memory-real-runner.mjs', import.meta.url), 'utf8')
  assert.equal((runner.match(/api\.openai\.com/g) ?? []).length, 1, 'the endpoint is asserted once and is not a parameter')
  assert.ok(!/maxRetries|retries\s*[:=]\s*[1-9]/.test(runner))
})

test('the small re-measurement runs through the same runner with its own pass rule, and a failure still stops it', async () => {
  const { buildPlan: build, scoreRemeasure } = await import('./egdesk-memory-real-plan.mjs')
  const small = await build({ subset: 'remeasure' })
  const bodies = new Map(small.runs.flatMap(run => run.requests.map(r => [JSON.stringify(r.body), r])))
  const log = []
  const fetchImpl = async (url, init) => { log.push(url); const r = bodies.get(init.body); return { status: 200, headers: { get: () => null }, async json() { return { answers: Object.entries(r.scripted).map(([name, a]) => ({ name, ...a })), usage: { input_tokens: r.estInputTokens, output_tokens: 0 } } } } }
  const out = await runMeasurement({ plan: small, key: KEY, send: true, fetchImpl, score: scoreRemeasure })
  assert.deepEqual([out.sent, out.stoppedBecause, out.scorecard.pass, out.scorecard.runsPassed], [6, null, true, 4])
  assert.ok(log.every(u => u === 'https://api.openai.com/v1/decisions'))
  const stopped = await runMeasurement({ plan: small, key: KEY, send: true, score: scoreRemeasure, fetchImpl: async () => ({ status: 429, headers: { get: () => null }, async json() { return {} } }) })
  assert.deepEqual([stopped.sent, stopped.stoppedBecause, stopped.scorecard.pass], [1, 'http_429', false])
})
