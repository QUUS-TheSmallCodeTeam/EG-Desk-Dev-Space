import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { LIVE_LIMITS, LIVE_RUNS, estimateLive, runLive, runLiveTurn, scoreLive, scoreLiveTurn } from './egdesk-memory-live-runner.mjs'
import { mockJudge } from './egdesk-wiki-reconstruction.fixture.mjs'

const KEY = 'egd-synthetic-not-a-key-0012'
// A stand-in Decisions server: answers each request with the lexical stand-in judge (never a model), in the API's wire shape.
function server({ failAt = null, status = 500, throwAt = null, delayMs = 0, usage = null, log = [] } = {}) {
  const judge = mockJudge()
  let n = 0
  const impl = async (url, init) => {
    n++; log.push({ url, init, n })
    if (throwAt === n) throw Object.assign(new Error(`connect failed for ${init.headers.authorization}`), { name: 'TypeError' })
    if (delayMs) await new Promise((resolve, reject) => { const t = setTimeout(resolve, delayMs); init.signal?.addEventListener('abort', () => { clearTimeout(t); reject(Object.assign(new Error('aborted'), { name: 'AbortError' })) }, { once: true }) })
    if (failAt === n) return new Response(JSON.stringify({ error: { code: 'x' } }), { status })
    const body = JSON.parse(init.body)
    const { answers } = await judge.decide({ input: body.input, questions: body.questions })
    return new Response(JSON.stringify({ model: 'gpt-6-luna', answers: body.questions.map(q => ({ name: q.name, ...answers[q.name] })), usage: { input_tokens: usage ?? Math.round(Buffer.byteLength(init.body) * 0.35), output_tokens: 0 } }), { status: 200 })
  }
  return { impl, log }
}

test('dry run is the default: nothing is sent, no key is needed, and the plan states its upper bounds', async () => {
  const s = server()
  const out = await runLive({ fetchImpl: s.impl })
  assert.deepEqual([out.sent, out.stoppedBecause, s.log.length, out.scorecard], [0, 'dry_run', 0, null])
  assert.deepEqual([out.maxRequests, out.ceiling], [36, 60000])
  assert.deepEqual([LIVE_LIMITS.requestsPerTurn * LIVE_RUNS.length, LIVE_LIMITS.caps.firstMs, LIVE_LIMITS.caps.midMs], [36, 4000, 2500])
  const estimate = await estimateLive()
  assert.ok(estimate.requests <= 36 && estimate.requests >= 18)
  assert.ok(estimate.estInputTokens < LIVE_LIMITS.tokenCeiling * 0.85, `estimate ${estimate.estInputTokens} leaves room under the ceiling`)
  assert.deepEqual(estimate.rows.map(r => r.id), ['pg-first', 'pg-mid', 'a-first', 'a-mid', 'j-first', 'j-mid'])
  for (const key of [null, '', 'short', 'has a space inside the key 123456789']) {
    const none = await runLive({ key, send: true, fetchImpl: s.impl })
    assert.deepEqual([none.stoppedBecause, s.log.length], ['no_key', 0])
  }
})

test('live run: the real adaptive loop through the product client; official endpoint, one attempt per request, key never in the outcome', async () => {
  const s = server()
  const out = await runLive({ key: KEY, send: true, fetchImpl: s.impl })
  assert.equal(out.stoppedBecause, null)
  assert.ok(out.sent >= 18 && out.sent <= 36); assert.equal(out.sent, s.log.length)
  assert.ok(s.log.every(c => c.url === 'https://api.openai.com/v1/decisions' && c.init.method === 'POST' && c.init.redirect === 'error'))
  assert.ok(s.log.every(c => JSON.stringify(Object.keys(c.init.headers).sort()) === '["authorization","content-type"]' && c.init.headers.authorization === `Bearer ${KEY}`))
  assert.equal(new Set(s.log.map(c => c.init.body)).size, s.log.length, 'no request body is sent twice')
  assert.ok(!JSON.stringify(out).includes(KEY), 'the key is not in anything the runner returns')
  assert.deepEqual(out.turns.map(t => t.id), LIVE_RUNS.map(r => r.id))
  assert.equal(out.requests.length, out.sent); assert.ok(out.requests.every(r => r.status === 200 && r.sha256.length === 64 && Number.isFinite(r.inputTokens)))
  assert.equal(out.usage.inputTokens, out.requests.reduce((n, r) => n + r.inputTokens, 0)); assert.ok(out.usage.inputTokens <= out.ceiling)
  // every request body is free of the private page, and mid turns never carry a held page as an option
  for (const c of s.log) assert.ok(!c.init.body.includes('원가는 단가의 71%'))
  // the stand-in is not a model, but it should satisfy the pre-registration: a sanity check that expectations and scorer agree
  assert.deepEqual(out.scorecard.scored.filter(x => !x.pass).map(x => [x.id, x.hardFailures, x.absolute]), [])
  assert.deepEqual([out.scorecard.turnsPassed, out.scorecard.pass], [6, true])
  const pgMid = out.turns.find(t => t.id === 'pg-mid')
  assert.ok(pgMid.pages.includes('db/pg-health') && !pgMid.pages.includes('db/pg-plan')); assert.match(pgMid.packet, /Pages you already hold from earlier in this conversation are not repeated/)
  assert.deepEqual([pgMid.write.op, pgMid.write.pageId, pgMid.write.status], ['update_status', 'db/pg-plan', 'done'])
  assert.ok(out.turns.every(t => Number.isFinite(t.packetMs) && t.packetMs <= t.totalMs))
})

test('hard limits stop the whole measurement before they are exceeded: token ceiling, request count', async () => {
  const s = server({ usage: 900 })
  const out = await runLive({ key: KEY, send: true, fetchImpl: s.impl, tokenCeiling: 9000 })
  assert.equal(out.stoppedBecause, 'token_ceiling')
  assert.ok(out.usage.inputTokens <= 9000, `spent ${out.usage.inputTokens}`)
  assert.ok(out.turns.length < 6, 'later turns never start'); assert.equal(out.scorecard.pass, false)
  assert.ok(out.scorecard.scored.some(x => x.ran === false))
  const capped = await runLive({ key: KEY, send: true, fetchImpl: server().impl, tokenCeiling: 10 ** 9 })
  assert.equal(capped.ceiling, LIVE_LIMITS.hardTokenMax, 'the ceiling can be lowered, never raised past the hard maximum')
  const s2 = server()
  const few = await runLive({ key: KEY, send: true, fetchImpl: s2.impl, limits: { ...LIVE_LIMITS, maxRequests: 3 } })
  assert.deepEqual([few.stoppedBecause, few.sent, s2.log.length], ['request_limit', 3, 3])
})

test('no retries: the first HTTP failure or network error stops the measurement; an error text that contains the key is never kept', async () => {
  const s = server({ failAt: 2, status: 429 })
  const out = await runLive({ key: KEY, send: true, fetchImpl: s.impl })
  assert.equal(out.stoppedBecause, 'http_429')
  assert.ok(s.log.length <= 3, 'at most the requests already in flight; nothing is sent again')
  assert.equal(new Set(s.log.map(c => c.init.body)).size, s.log.length)
  assert.ok(out.turns.length <= 1); assert.equal(out.scorecard.pass, false)
  const n = server({ throwAt: 1 })
  const net = await runLive({ key: KEY, send: true, fetchImpl: n.impl })
  assert.equal(net.stoppedBecause, 'network'); assert.ok(!JSON.stringify(net).includes(KEY))
})

test('a slow model is a result, not a stop: the loop is cut at its deadline, the turn is marked partial and classed as cap, later turns still run', async () => {
  const s = server({ delayMs: 400 })
  const limits = { ...LIVE_LIMITS, caps: { firstMs: 700, midMs: 700 } }
  const out = await runLive({ key: KEY, send: true, fetchImpl: s.impl, limits })
  assert.equal(out.stoppedBecause, null); assert.equal(out.turns.length, 6)
  assert.ok(out.requests.some(r => r.status === 'aborted_by_deadline'))
  assert.ok(out.turns.some(t => t.partial || t.status === 'fallback' || t.status === 'empty'))
  const failed = out.scorecard.scored.filter(x => !x.pass)
  assert.ok(failed.length > 0 && failed.every(x => x.failureClass === 'cap_or_outage' || x.failureClass === 'judgment'))
  assert.ok(failed.some(x => x.failureClass === 'cap_or_outage'))
  assert.ok(out.turns.every(t => t.packetMs < 1500), 'no turn waits for the slow request beyond its deadline')
})

test('scoring the final packet: required, off-topic, held, private, status, write and the pass rule', async () => {
  const def = id => LIVE_RUNS.find(r => r.id === id)
  const good = { id: 'pg-mid', position: 'mid', capMs: 2500, packetMs: 900, totalMs: 1400, status: 'ready', partial: false, reason: null, pages: ['db/pg-health', 'db/pg-followup'],
    picks: [{ id: 'db/pg-health', via: 'scan', p: 0.99, statusRead: 'done' }], triage: null, write: { op: 'update_status', pageId: 'db/pg-plan', status: 'done', reason: null }, packet: 'x' }
  assert.equal(scoreLiveTurn(def('pg-mid'), good).pass, true)
  const fails = (turn, d = def('pg-mid'), extra = {}) => { const s = scoreLiveTurn(d, turn, extra); return [s.pass, [...s.hardFailures, ...s.absolute].join(' | '), s.failureClass] }
  assert.match(fails({ ...good, pages: ['db/pg-followup'] })[1], /packet has db\/pg-health/)
  assert.match(fails({ ...good, pages: [...good.pages, 'misc/dinner'] })[1], /no off-topic page/)
  assert.match(fails({ ...good, pages: [...good.pages, 'db/pg-plan'] })[1], /already holds is sent again/)
  assert.match(fails({ ...good, packet: '... 원가는 단가의 71% ...' })[1], /outside this DM/)
  assert.match(fails(good, def('pg-mid'), { privateSeen: true })[1], /outside this DM/)
  assert.match(fails({ ...good, write: { op: 'new_page', pageId: null, status: 'done' } })[1], /write proposal is a status change.*no new page or other page/)
  assert.deepEqual(fails({ ...good, pages: [], partial: true, status: 'empty' }).slice(0, 3)[2], 'cap_or_outage')
  assert.equal(fails({ ...good, pages: ['db/pg-followup'] })[2], 'judgment')
  const a = { id: 'a-first', position: 'first', capMs: 4000, packetMs: 1300, totalMs: 1300, status: 'ready', partial: false, reason: null, pages: ['quote/a-v1', 'quote/a-v2-plan'],
    picks: [{ id: 'quote/a-v2-plan', statusRead: 'plan' }, { id: 'quote/a-meeting', statusRead: null }], triage: null, write: { op: 'none', reason: 'not_worth_recording' }, packet: 'x' }
  assert.equal(scoreLiveTurn(def('a-first'), a).pass, true, 'a status that was not read is not wrong')
  assert.match(fails({ ...a, picks: [{ id: 'quote/a-v2-plan', statusRead: 'done' }] }, def('a-first'))[1], /status of quote\/a-v2-plan, when read, is plan/)
  assert.match(fails({ ...a, write: { op: 'new_page', pageId: null, status: 'unknown' } }, def('a-first'))[1], /a question is not recorded/)
  assert.deepEqual(scoreLiveTurn(def('a-first'), { ...a, packetMs: 4500 }).softMisses.filter(m => /within the cap/.test(m)).length, 1, 'latency over the cap is reported, soft')
  // pass rule: five of six, and an absolute failure is never outvoted
  const s = server(); const out = await runLive({ key: KEY, send: true, fetchImpl: s.impl })
  const drop = id => out.turns.map(t => (t.id === id ? { ...t, pages: [] } : t))
  assert.deepEqual([scoreLive(drop('j-mid')).turnsPassed, scoreLive(drop('j-mid')).pass], [5, true])
  assert.equal(scoreLive(out.turns.map(t => (t.id === 'j-mid' || t.id === 'a-mid' ? { ...t, pages: [] } : t))).pass, false)
  const leak = scoreLive(out.turns, { privateSeen: true })
  assert.deepEqual([leak.pass, leak.absolute.length > 0], [false, true])
  assert.equal(scoreLive(out.turns.slice(0, 5)).scored.at(-1).ran, false)
})

test('one turn through the shared egress gate: only memory pages of this room may leave', async () => {
  const seen = []
  const judge = mockJudge()
  const turn = await runLiveTurn(LIVE_RUNS[2], { async decide(request) { seen.push(JSON.stringify(request.input)); return judge.decide(request) } })
  assert.ok(seen.length >= 3 && seen.every(text => !text.includes('원가는 단가의 71%') && !text.includes('A사 내부 원가')))
  assert.ok(turn.pages.includes('quote/a-v2-plan') && !turn.pages.includes('quote/a-cost'))
})

test('the command line tool: dry run by default, the key only from OPENAI_API_KEY and never printed or written', async () => {
  const source = await readFile(new URL('../scripts/egdesk-memory-live-measure.mjs', import.meta.url), 'utf8')
  assert.match(source, /key: flag\('--send'\) \? process\.env\.OPENAI_API_KEY \?\? null : null/)
  assert.equal((source.match(/process\.env/g) ?? []).length, 1)
  const code = source.replace(/\/\/.*$/gm, '').replace(/(['"`])(?:\\.|(?!\1).)*\1/g, '""')
  assert.equal((code.match(/\bkey\b/g) ?? []).length, 1, 'the key is only handed to the runner')
  const runner = await readFile(new URL('./egdesk-memory-live-runner.mjs', import.meta.url), 'utf8')
  assert.ok(!/console\.|writeFile|appendFile/.test(runner), 'the runner prints and writes nothing')
  assert.ok(!/retry|retries/i.test(runner.replace(/never retries|Nothing is retried|No retries/gi, '')))
})
