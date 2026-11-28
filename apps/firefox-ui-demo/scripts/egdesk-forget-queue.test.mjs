import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as FQ from '../overlay/resources/EGDeskForgetQueue.sys.mjs'

const js = readFileSync(new URL('../overlay/JS/eg-desk-surface.uc.js', import.meta.url), 'utf8')
const rig = (send, initial = []) => {
  const timers = []; const saved = []
  const q = FQ.createForgetQueue({ send, load: () => initial, save: l => saved.push(l),
    setTimer: (fn, ms) => { const t = { fn, ms, live: true }; timers.push(t); return t }, clearTimer: t => { t.live = false } })
  const fire = async () => { const t = timers.find(x => x.live); t.live = false; await t.fn() }
  return { q, timers, saved, fire }
}
const settle = () => new Promise(r => setImmediate(r))

test('forgets go one at a time, in order, each awaited', async () => {
  const log = []; let inflight = 0, max = 0
  const { q, saved } = rig(async id => { inflight++; max = Math.max(max, inflight); log.push(id); await settle(); inflight--; })
  for (const id of ['a', 'b', 'c']) q.enqueue(id)
  q.enqueue('a') // duplicate ignored
  while (!q.idle()) await settle()
  assert.deepEqual(log, ['a', 'b', 'c']); assert.equal(max, 1)
  assert.deepEqual(q.pending(), []); assert.deepEqual(saved.at(-1), [])
})

test('network and 5xx errors retry with growing backoff; the head blocks the rest', async () => {
  const log = []; let fails = 3
  const { q, timers, fire } = rig(async id => { log.push(id); if (id === 'a' && fails-- > 0) throw Object.assign(new Error('x'), fails === 2 ? {} : { status: 503 }) })
  q.enqueue('a'); q.enqueue('b')
  await settle()
  assert.deepEqual(log, ['a']); assert.equal(timers[0].ms, 1000)
  await fire(); await settle(); assert.equal(timers[1].ms, 2000)
  await fire(); await settle(); assert.equal(timers[2].ms, 4000)
  await fire(); await settle()
  assert.deepEqual(log, ['a', 'a', 'a', 'a', 'b']); assert.deepEqual(q.pending(), [])
})

test('a non-retryable 4xx drops the id and moves on', async () => {
  const log = []
  const { q } = rig(async id => { log.push(id); if (id === 'a') throw Object.assign(new Error('bad'), { status: 400 }) })
  q.enqueue('a'); q.enqueue('b'); while (!q.idle()) await settle()
  assert.deepEqual(log, ['a', 'b']); assert.deepEqual(q.pending(), [])
})

test('pending ids are persisted and a new queue resumes them', async () => {
  const a = rig(async () => { throw new Error('down') })
  a.q.enqueue('x'); a.q.enqueue('y'); await settle()
  assert.deepEqual(a.saved.at(-1), ['x', 'y'])
  const log = []
  const b = rig(async id => { log.push(id) }, a.saved.at(-1))
  assert.deepEqual(b.q.pending(), ['x', 'y']); assert.deepEqual(log, [])
  await b.q.resume()
  assert.deepEqual(log, ['x', 'y']); assert.deepEqual(b.saved.at(-1), [])
})

test('resume brings a waiting retry forward; garbage persisted state is ignored', async () => {
  let down = true; const log = []
  const { q, timers } = rig(async id => { if (down) throw new Error('down'); log.push(id) })
  q.enqueue('a'); await settle(); down = false
  await q.resume(); assert.deepEqual(log, ['a']); assert.equal(timers[0].live, false)
  assert.deepEqual(FQ.parsePending('not json'), []); assert.deepEqual(FQ.parsePending('{"a":1}'), [])
  assert.deepEqual(FQ.parsePending('["a","a",3,""]'), ['a'])
})

test('the surface routes deleteThread through the queue', () => {
  assert.match(js, /EGDeskForgetQueue\.sys\.mjs/)
  assert.doesNotMatch(js, /void fetchJson\('\/chat\/conversation\/forget'/)
  assert.match(js, /ForgetQueue\(\)\.enqueue\(ChatState\.clientThreadBinding\(thread\)\)/)
})

test('status 0 or none (no response) is retryable; a 4xx is not', () => {
  assert.equal(FQ.retryable({ status: 0 }), true); assert.equal(FQ.retryable(new Error('x')), true)
  assert.equal(FQ.retryable({ status: 502 }), true); assert.equal(FQ.retryable({ status: 404 }), false)
})
