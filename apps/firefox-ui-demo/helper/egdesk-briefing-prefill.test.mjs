// Cycle 45: the prefill store and the caching fill (egdesk-briefing-prefill.mjs). The end-to-end behaviour is in egdesk-briefing-skeleton.test.mjs (c45 tests).
import assert from 'node:assert/strict'
import test from 'node:test'
import { PREFILL_LIMITS, cachingFill, createPrefillStore, requestKey } from './egdesk-briefing-prefill.mjs'

const want = n => ({ kind: 'briefing_fill', guide: { items: [{ id: `P${n}` }] }, materials: [{ alias: 'M1' }] })
test('the key is the hash of the request: equal requests share it, any difference does not', () => {
  assert.equal(requestKey(want(1)), requestKey(want(1))); assert.notEqual(requestKey(want(1)), requestKey(want(2))); assert.match(requestKey(want(1)), /^[0-9a-f]{64}$/)
})
test('an entry serves an identical request once (waiting for it when in flight), never a null reply, never a different request', async () => {
  const store = createPrefillStore(), entry = store.begin('c/a'); let calls = 0
  const engine = async w => { calls++; await new Promise(r => setTimeout(r, 5)); return w.guide.items[0].id === 'P9' ? null : { ok: w.guide.items[0].id } }
  const pending = entry.speculate(engine, want(1)); assert.equal(entry.speculate(engine, want(1)), pending, 'the same request is sent once')
  assert.deepEqual(await entry.serve(want(1)), { ok: 'P1' }); assert.equal(calls, 1); assert.equal(await entry.serve(want(1)), undefined, 'served once'); assert.equal(await entry.serve(want(2)), undefined)
  await entry.speculate(engine, want(9)); assert.equal(await entry.serve(want(9)), undefined); assert.deepEqual(entry.counts, { sent: 2, served: 1, missed: 3, nullReplies: 1 })
  const reply = { a: { b: 1 } }; entry.speculate(async () => reply, want(3)); const got = await entry.serve(want(3)); got.a.b = 2; assert.equal(reply.a.b, 1, 'a copy is served')
})
test('cachingFill: only fill requests are served from the entry, anything else goes to the engine; lastFailure is the engine\'s unless the request was served', async () => {
  const entry = createPrefillStore().begin('c/a'); let asked = []
  const engine = async w => { asked.push(w.kind); return { from: 'engine' } }; engine.lastFailure = () => 'timeout'; engine.stats = () => ({ turns: 1 })
  await entry.speculate(async () => ({ from: 'prefill' }), want(1))
  const fill = cachingFill(engine, entry)
  assert.deepEqual(await fill(want(1)), { from: 'prefill' }); assert.equal(fill.lastFailure(), null); assert.deepEqual(asked, [])
  assert.deepEqual(await fill(want(1)), { from: 'engine' }); assert.equal(fill.lastFailure(), 'timeout'); assert.deepEqual(await fill({ kind: 'briefing_component' }), { from: 'engine' }); assert.deepEqual(fill.stats(), { turns: 1 })
  assert.equal(cachingFill(engine, null), engine)
})
test('the store is bounded: one entry per answer, claimed once, the oldest and the expired dropped; idle() waits for the prefill\'s Decision requests and gives up after its bound', async () => {
  let at = 0; const store = createPrefillStore({ now: () => at, limits: { entries: 2, ttlMs: 100 } })
  assert.ok(store.begin('a')); assert.equal(store.begin('a'), null); assert.ok(store.claim('a')); assert.equal(store.claim('a'), null); assert.equal(store.claim('zzz'), null)
  store.begin('b'); store.begin('c'); assert.equal(store.has('a'), false, 'the oldest goes'); at = 1000; store.begin('d'); assert.equal(store.size, 1, 'the expired go')
  const e = store.begin('e'); let idle = false; e.judging(1); const w = e.idle(50).then(() => { idle = true }); e.judgesFinished(); await new Promise(r => setTimeout(r, 5)); assert.equal(idle, false, 'a request is in flight'); e.judging(-1); await w; assert.equal(idle, true)
  const f = store.begin('f'); f.judging(1); const t0 = Date.now(); await f.idle(20); assert.ok(Date.now() - t0 >= 15, 'it gives up after its bound'); assert.equal(PREFILL_LIMITS.entries, 16)
})
