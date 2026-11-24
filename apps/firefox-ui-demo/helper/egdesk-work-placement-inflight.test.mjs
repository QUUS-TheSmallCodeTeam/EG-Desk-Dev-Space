// L1 c28 (Main's first real-engine run of the collaboration check, 2026-11-25): the attention scene stayed "submitted: queued ... result: unknown" at the turn's end although the
// placement had decided (its record said source: decision). A judgment leaves the queue when its beat takes it and is decided only after the Decision model answered (seconds
// on the real model); in between result() said 'unknown', and both readers that poll "until it is no longer pending" (the check's hook, and the window's bounded wait for the
// viewer's same-matter answer) stopped there. result() now says 'pending' while the judgment is being judged. The runtime, its queue and its egress gate are real; the heartbeat is
// a fake that beats when told, the Decision client answers when released. Mocks only.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createWorkPlacement } from './egdesk-work-placement.mjs'
import { attentionScene } from './egdesk-real-engine-collab-hook.mjs'

const beating = () => { let tick = 0; const hb = { state: 'running', register() {}, nudge() {}, acknowledge() {}, subscribe(fn) { this.beatNow = fn } }; return { hb, now: () => (tick += 1) } }
function slowClient(gate) {
  const calls = []
  return { calls, model: 'mock', async decide(request) { calls.push(request); await gate.promise; return { answers: Object.fromEntries(request.questions.map(q => [q.name, { type: 'predicate', probability: 0.97 }])) } } }
}
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
const tickOf = () => new Promise(resolve => setImmediate(resolve))

function world() {
  const b = beating(), gate = deferred(), client = slowClient(gate)
  const placement = createWorkPlacement({ client, mode: () => 'on', enabled: () => true, live: () => true, now: b.now, setTimer: () => null,
    contextFor: () => ({ request: 'A사 견적서를 비교해 주세요.', answer: 'v2는 단가가 낮습니다. 승인해 주셔야 합니다.' }) })
  return { ...b, placement, gate, client }
}

test('result() is pending while the judgment is being judged (out of the queue, not yet decided), then decided; it was unknown in between', async () => {
  const w = world()
  const submitted = w.placement.submit('room', attentionScene(), w.hb)
  assert.equal(submitted.status, 'queued'); assert.deepEqual(w.placement.result('room', submitted.id), { status: 'pending' }, 'queued')
  w.hb.beatNow(); await tickOf()
  assert.equal(w.client.calls.length, 1, 'the beat took it and the Decision model is being asked')
  assert.deepEqual(w.placement.result('room', submitted.id), { status: 'pending' }, 'being judged: not unknown (the window and the check poll until it is no longer pending)')
  assert.deepEqual(w.placement.result('room', 'wp-999'), { status: 'unknown' }, 'an id it never had is still unknown')
  assert.deepEqual(w.placement.result('other-room', submitted.id), { status: 'unknown' }, 'another conversation never saw it')
  w.gate.resolve(); await w.placement.idle()
  const done = w.placement.result('room', submitted.id)
  assert.equal(done.status, 'decided'); assert.equal(done.branch, 'owner'); assert.equal(done.kind, 'point')
  assert.equal(w.placement.records().length, 1)
})

test('a judgment that fails or is refused is not left pending: it is decided by the code\'s outcome; a queued one that goes stale is expired', async () => {
  const b = beating(), failing = { model: 'mock', async decide() { throw Object.assign(new Error('offline'), { code: 'unreachable' }) } }
  const placement = createWorkPlacement({ client: failing, mode: () => 'on', enabled: () => true, live: () => true, now: b.now, setTimer: () => null, contextFor: () => ({ request: 'x', answer: 'y' }) })
  const s = placement.submit('room', attentionScene(), b.hb); b.hb.beatNow(); await placement.idle()
  assert.equal(placement.result('room', s.id).status, 'decided'); assert.equal(placement.result('room', s.id).source, 'failed', 'the code\'s outcome stands, and nothing stays in flight')
  const late = beating(); let clock = 1
  const stale = createWorkPlacement({ client: failing, mode: () => 'on', enabled: () => true, live: () => true, now: () => clock, setTimer: () => null, contextFor: () => ({ request: 'x', answer: 'y' }) })
  const q = stale.submit('room', attentionScene(), late.hb); clock += 31_000; late.hb.beatNow(); await stale.idle()
  assert.equal(stale.result('room', q.id).status, 'expired')
})

test('the two pollers stop only on a status that is no longer pending: the check\'s hook and the window\'s bounded wait', () => {
  const hook = readFileSync(new URL('./egdesk-real-engine-collab-hook.mjs', import.meta.url), 'utf8')
  assert.match(hook, /if \(result\.status !== 'pending'\) break/)
  const surface = readFileSync(new URL('../overlay/JS/eg-desk-surface.uc.js', import.meta.url), 'utf8')
  assert.match(surface, /if \(res\?\.body\?\.status !== 'pending'\) break;/)
})
