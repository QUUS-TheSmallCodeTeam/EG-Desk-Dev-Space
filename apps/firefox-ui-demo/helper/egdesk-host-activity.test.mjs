import test from 'node:test'
import assert from 'node:assert/strict'
import { CODEX_COMPUTER_SERVICE, HOST_ACTIVITY_KINDS, createHostActivity } from './egdesk-host-activity.mjs'

const clock = (start = 1_700_000_000_000) => { let t = start; const now = () => t; now.set = value => { t = value }; now.add = ms => { t += ms }; return now }
const activated = (app, at) => ({ type: 'host.event', event: 'app.activated', app, at })
const FINDER = { bundleId: 'com.apple.finder', pid: 100, name: 'Finder' }
const SAFARI = { bundleId: 'com.apple.Safari', pid: 200, name: 'Safari' }
const NOTES = { bundleId: 'com.apple.Notes', pid: 300, name: 'Notes' }

test('front-app rows keep the previous app and skip repeats of the same app', () => {
  const now = clock()
  const activity = createHostActivity({ now })
  const first = activity.noteHostEvent(activated(FINDER, now()))
  assert.equal(first.kind, 'front-app')
  assert.deepEqual(first.app, FINDER)
  assert.equal(first.previous, null)
  assert.equal(first.duringCodex, false)
  assert.equal(activity.noteHostEvent(activated({ ...FINDER }, now())), null)
  now.add(5000)
  const second = activity.noteHostEvent(activated(SAFARI, now()))
  assert.deepEqual(second.previous, FINDER)
  assert.equal('returnedAfterMs' in second, false)
  assert.deepEqual(activity.summary().frontApp, { ...SAFARI, since: now() })
})

test('Codex computer use and front-app changes share one clock and order', () => {
  const now = clock()
  const activity = createHostActivity({ now })
  const t0 = now()
  now.set(t0 + 150)
  activity.noteHostEvent(activated(FINDER, t0))
  // computer.used details as codex-chat-runtime emits them (lastAt = Date.now ms).
  const started = activity.noteComputerUse({ runId: 'run-1', calls: 1, lastAt: t0 + 100, active: true })
  assert.equal(started.kind, 'codex-computer')
  assert.equal(started.at, t0 + 100)
  assert.equal(activity.summary().controller, 'codex-computer-use')
  now.set(t0 + 400)
  // The host event mapped to t0 + 200 arrives after a later row: it is placed by time.
  activity.noteComputerUse({ runId: 'run-1', calls: 2, lastAt: t0 + 300, active: true })
  const during = activity.noteHostEvent(activated(SAFARI, t0 + 200))
  assert.equal(during.duringCodex, true)
  assert.deepEqual(activity.list().map(row => [row.kind, row.at]), [
    ['front-app', t0], ['codex-computer', t0 + 100], ['front-app', t0 + 200], ['codex-computer', t0 + 300],
  ])
  assert.deepEqual(HOST_ACTIVITY_KINDS, ['front-app', 'service', 'codex-computer'])
})

test('A→B→A within the bounce window is marked as a return', () => {
  const now = clock()
  const activity = createHostActivity({ now, bounceWindowMs: 3000 })
  const t0 = now()
  now.set(t0 + 1060) // every stamp below is in the past
  activity.noteComputerUse({ runId: 'run-1', calls: 1, lastAt: t0, active: true })
  activity.noteHostEvent(activated(FINDER, t0 + 10))
  activity.noteHostEvent(activated(SAFARI, t0 + 1000))
  const back = activity.noteHostEvent(activated(FINDER, t0 + 1050))
  assert.equal(back.returnedAfterMs, 50)
  assert.equal(back.duringCodex, true)
  // A third app or a slow return is not a bounce.
  now.set(t0 + 20_000)
  activity.noteHostEvent(activated(NOTES, t0 + 10_000))
  const slow = activity.noteHostEvent(activated(FINDER, t0 + 19_000))
  assert.equal('returnedAfterMs' in slow, false)
})

test('service rows only for the Codex computer-use service and only on change', () => {
  const now = clock()
  const activity = createHostActivity({ now })
  const service = (running, pids = []) => ({ type: 'host.event', event: 'service.changed', service: { bundleId: CODEX_COMPUTER_SERVICE, running, pids }, at: now() })
  const up = activity.noteHostEvent(service(true, [4242]))
  assert.deepEqual({ kind: up.kind, running: up.running, pidCount: up.pidCount, bundleId: up.bundleId }, { kind: 'service', running: true, pidCount: 1, bundleId: CODEX_COMPUTER_SERVICE })
  assert.equal(activity.noteHostEvent(service(true, [4242])), null)
  assert.equal(activity.noteHostEvent({ type: 'host.event', event: 'service.changed', service: { bundleId: 'com.example.other', running: false }, at: now() }), null)
  now.add(1000)
  const down = activity.noteHostEvent(service(false))
  assert.equal(down.running, false)
  assert.deepEqual(activity.summary().service, { bundleId: CODEX_COMPUTER_SERVICE, running: false, since: now() })
})

test('a Codex call that ends without a new lastAt is placed when it is learned', () => {
  const now = clock()
  const activity = createHostActivity({ now })
  const t0 = now()
  activity.noteComputerUse({ runId: 'run-1', calls: 1, lastAt: t0, active: true })
  now.set(t0 + 9000)
  const ended = activity.noteComputerUse({ runId: 'run-1', calls: 1, lastAt: t0, active: false })
  assert.equal(ended.at, t0 + 9000)
  assert.equal(activity.summary().controller, 'none')
  assert.deepEqual(activity.summary().codex, { active: false, runId: null, calls: 0, lastAt: null })
  assert.equal(activity.noteComputerUse({ runId: 'run-1', calls: 1, lastAt: t0, active: false }), null)
})

test('rows never carry more than names, bundle ids and pids, and bad input is ignored', () => {
  const now = clock()
  const activity = createHostActivity({ now })
  const row = activity.noteHostEvent(activated({ bundleId: 'com.apple.Safari', pid: 200, name: 'S'.repeat(400), title: 'secret window', text: 'typed' }, now()))
  assert.deepEqual(Object.keys(row.app).sort(), ['bundleId', 'name', 'pid'])
  assert.equal(row.app.name.length, 128)
  assert.equal(activity.noteHostEvent(null), null)
  assert.equal(activity.noteHostEvent({ type: 'host.state', state: 'ready' }), null)
  assert.equal(activity.noteHostEvent(activated({ bundleId: 'bad id with spaces' }, now())), null)
  assert.equal(activity.noteComputerUse({ runId: '../x y', calls: 1, active: true }), null)
  // A future time is clamped to now.
  const future = activity.noteComputerUse({ runId: 'run-2', calls: 1, lastAt: now() + 60_000, active: false })
  assert.equal(future.at, now())
})

test('the list is bounded, filterable by time and returns copies', () => {
  const now = clock()
  const activity = createHostActivity({ now, limit: 3 })
  const apps = [FINDER, SAFARI, NOTES, FINDER, SAFARI]
  apps.forEach((app, index) => activity.noteHostEvent(activated(app, now() - 1000 + index)))
  const rows = activity.list()
  assert.equal(rows.length, 3)
  assert.deepEqual(rows.map(item => item.app.name), ['Notes', 'Finder', 'Safari'])
  assert.equal(activity.list({ sinceAt: rows[1].at }).length, 1)
  assert.equal(activity.list({ limit: 1 })[0].app.name, 'Safari')
  rows[0].app.name = 'changed'
  assert.equal(activity.list()[0].app.name, 'Notes')
  activity.clear()
  assert.deepEqual(activity.list(), [])
  assert.equal(activity.summary().frontApp, null)
  assert.throws(() => createHostActivity({ limit: 0 }), TypeError)
})
