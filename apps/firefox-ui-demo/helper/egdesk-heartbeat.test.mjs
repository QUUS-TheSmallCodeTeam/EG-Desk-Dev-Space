import test from 'node:test'
import assert from 'node:assert/strict'
import { HEARTBEAT_LIMITS, createHeartbeat, createHeartbeats } from './egdesk-heartbeat.mjs'

// The live-session heartbeat on a virtual monotonic clock and virtual timers. No engine, no network.
function clockwork() {
  let clock = 50_000 // an arbitrary monotonic origin: only differences matter
  const timers = []
  const api = {
    monotonicNow: () => clock,
    setTimer: (fn, ms) => { const timer = { fn, at: clock + ms }; timers.push(timer); return timer },
    clearTimer: timer => { const i = timers.indexOf(timer); if (i >= 0) timers.splice(i, 1) },
    pending: () => timers.length,
    advance(ms) {
      const end = clock + ms
      for (;;) {
        timers.sort((a, b) => a.at - b.at)
        const next = timers[0]
        if (!next || next.at > end) break
        timers.shift(); clock = next.at; next.fn()
      }
      clock = end
    },
    jump(ms) { clock += ms }, // time passes without any timer firing (a sleeping host)
    fireDue() { timers.sort((a, b) => a.at - b.at); while (timers.length && timers[0].at <= clock) timers.shift().fn() },
  }
  return api
}

test('its own counter: a beat every 5 s from the moment the message was accepted, with no engine event at all', () => {
  const c = clockwork(), seen = []
  const hb = createHeartbeat({ ...c })
  hb.subscribe(beat => seen.push([beat.beat, beat.internalMs, beat.facts.sinceUserMs, beat.facts.sinceEngineMs, beat.facts.phase]))
  assert.equal(hb.state, 'idle'); assert.equal(c.pending(), 0)
  assert.equal(hb.start({ sinceMs: 1200 }), true) // the message was accepted 1.2 s before the conversation started working
  c.advance(3700); assert.deepEqual(seen, [])
  c.advance(100)
  assert.deepEqual(seen, [[1, 5000, 5000, 5000, 'thinking']])
  c.advance(20_000)
  assert.deepEqual(seen.map(row => row[1]), [5000, 10_000, 15_000, 20_000, 25_000], 'silent engine: the heartbeat still beats')
  assert.equal(hb.beats, 5); assert.equal(hb.start(), false, 'a second start is ignored')
  assert.equal(c.pending(), 1, 'exactly one timer at any time')
})

test('marks move on the internal clock: engine events, posted messages and the person\'s messages', () => {
  const c = clockwork(), hb = createHeartbeat({ ...c })
  hb.start(); c.advance(7000); hb.mark('engine'); c.advance(2000); hb.mark('posted'); c.advance(4000)
  let f = hb.facts()
  assert.deepEqual([f.internalMs, f.sinceUserMs, f.sinceEngineMs, f.sincePostedMs, f.engineEvents], [13_000, 13_000, 6000, 4000, 1])
  hb.mark('user'); c.advance(1000); f = hb.facts()
  assert.deepEqual([f.sinceUserMs, f.sinceEngineMs], [1000, 7000])
  assert.equal(hb.mark('other'), false)
  assert.equal(Object.isFrozen(f), true)
})

test('lifecycle: pause freezes the counter and the beats, resume continues, stop is final and leaves no timer', () => {
  const c = clockwork(), seen = [], stops = []
  const hb = createHeartbeat({ ...c, onStop: self => stops.push(self.stopReason) })
  hb.subscribe(beat => seen.push(beat.internalMs))
  hb.start(); c.advance(7000)
  assert.equal(hb.pause(), true); assert.equal(c.pending(), 0)
  c.advance(60_000)
  assert.deepEqual(seen, [5000]); assert.equal(hb.internalMs(), 7000, 'paused time is not counted')
  assert.equal(hb.resume(), true); c.advance(3000)
  assert.deepEqual(seen, [5000, 10_000], 'the next beat falls on the counter\'s own 10 s, 3 s after resuming')
  assert.equal(hb.stop('cancel'), true); assert.equal(hb.state, 'stopped'); assert.equal(hb.stopReason, 'cancel'); assert.equal(c.pending(), 0)
  c.advance(60_000)
  assert.deepEqual(seen, [5000, 10_000]); assert.deepEqual(stops, ['cancel'])
  assert.equal(hb.stop('run_end'), false); assert.equal(hb.start(), false); assert.equal(hb.resume(), false); assert.equal(hb.mark('engine'), false)
  assert.equal(hb.subscribe(() => assert.fail('never called'))(), undefined)
  assert.equal(createHeartbeat({ ...c }).stop('nonsense'), true)
})

test('a late timer counts once (no replay of missed beats) and the cadence returns to the counter\'s grid', () => {
  const c = clockwork(), seen = []
  const hb = createHeartbeat({ ...c }); hb.subscribe(beat => seen.push([beat.beat, beat.internalMs]))
  hb.start(); c.jump(17_000); c.fireDue()
  assert.deepEqual(seen, [[1, 17_000]])
  c.advance(3000)
  assert.deepEqual(seen, [[1, 17_000], [2, 20_000]])
})

test('bounded: it stops itself after maxBeats; one heartbeat per key; at most maxLive; stopAll for a restart', () => {
  const c = clockwork()
  const short = createHeartbeat({ ...c, limits: { beatMs: 1000, maxBeats: 3 } }); short.start(); c.advance(60_000)
  assert.deepEqual([short.beats, short.state, short.stopReason], [3, 'stopped', 'limit'])
  assert.equal(HEARTBEAT_LIMITS.beatMs * HEARTBEAT_LIMITS.maxBeats, 3_600_000)
  const beats = createHeartbeats({ ...c, limits: { ...HEARTBEAT_LIMITS, maxLive: 2 } })
  const a = beats.open('dm-a'), b = beats.open('dm-b')
  a.start(); b.start()
  assert.equal(beats.open('dm-c'), null, 'no third live heartbeat')
  const a2 = beats.open('dm-a')
  assert.deepEqual([a.state, a.stopReason, beats.get('dm-a') === a2, beats.size], ['stopped', 'superseded', true, 2])
  assert.equal(beats.open(''), null)
  beats.stopAll('restart')
  assert.deepEqual([a2.stopReason, b.stopReason, beats.size, c.pending()], ['restart', 'restart', 0, 0])
  assert.equal(beats.get('dm-b'), null)
})

test('facts are numbers, booleans and closed labels only; providers and listeners cannot break or outnumber the heartbeat', () => {
  const c = clockwork(), hb = createHeartbeat({ ...c }), seen = []
  hb.setSource(() => ({ stepsDone: 2, stepsRunning: 1, note: 'free text is dropped', nested: { a: 1 } }))
  const off = hb.register('browser_task', () => ({ active: true, phase: 'objective_step', stepsDone: 3, stepsRemaining: 4, task: 'running', secret: 'Bearer abc.def 가나다', list: [1, 2] }))
  hb.register('broken', () => { throw new Error('provider failed') })
  hb.register('Bad Name', () => ({ stepsDone: 100 })) // refused: the name is not a closed label
  assert.deepEqual(hb.snapshot().providers, ['browser_task', 'broken'])
  hb.subscribe(() => { throw new Error('listener failed') }); hb.subscribe(beat => seen.push(beat.facts))
  hb.start(); c.advance(5000)
  const f = seen[0]
  assert.deepEqual([f.phase, f.stepsDone, f.stepsRunning, f.stepsRemaining], ['objective_step', 5, 1, 4])
  assert.deepEqual(f.sources, { browser_task: { active: true, phase: 'objective_step', stepsDone: 3, stepsRemaining: 4, task: 'running' } })
  assert.ok(!JSON.stringify(f).includes('free text') && !JSON.stringify(f).includes('Bearer'))
  hb.register('terminal_loop', () => ({ waitingOnUser: true, stepsDone: 1 }))
  assert.equal(hb.facts().phase, 'waiting_user', 'waiting on the person wins over every other phase')
  off()
  assert.deepEqual(Object.keys(hb.facts().sources), ['terminal_loop'])
  for (let i = 0; i < 20; i++) hb.register(`p${i}`, () => ({ stepsDone: 1 }))
  assert.equal(hb.snapshot().providers.length, HEARTBEAT_LIMITS.maxProviders)
  let extra = 0
  for (let i = 0; i < 20; i++) hb.subscribe(() => { extra++ })
  c.advance(5000)
  assert.equal(extra, HEARTBEAT_LIMITS.maxListeners - 2)
  const plain = createHeartbeat({ ...c }); plain.setSource(() => ({ stepsRunning: 1 })); plain.start()
  assert.equal(plain.facts().phase, 'tool_running'); assert.equal(plain.facts().stepsRemaining, null)
})
