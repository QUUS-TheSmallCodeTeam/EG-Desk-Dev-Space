import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as Sleep from '../overlay/resources/EGDeskCardSleep.sys.mjs'

const js = readFileSync(new URL('../overlay/JS/eg-desk-surface.uc.js', import.meta.url), 'utf8')
const VP = { width: 1440, height: 900 }
const rectAt = (left, top, width, height) => ({ left, top, right: left + width, bottom: top + height, width, height })

function harness(initial) {
  let t = 1000
  const cards = new Map()
  const add = (id, rect, excluded = false) => {
    const c = { id, r: rect, ex: excluded, awake: true, log: [] }
    c.entry = { id, rect: () => c.r, excluded: () => c.ex, setAwake: (a) => { c.awake = a; c.log.push(a) } }
    cards.set(id, c); return c
  }
  for (const [id, r] of Object.entries(initial)) add(id, r)
  const sleeper = Sleep.createCardSleeper({ cards: () => [...cards.values()].map(c => c.entry), viewport: () => VP, now: () => t })
  const advance = (ms) => { for (let i = 0; i < ms; i += Sleep.TICK_MS) { t += Sleep.TICK_MS; sleeper.tick() } }
  return { cards, add, sleeper, advance }
}

test('an off-screen card sleeps after the delay; a visible large card does not', () => {
  const h = harness({ off: rectAt(3000, 100, 1200, 800), big: rectAt(100, 50, 1000, 700) })
  h.advance(1500)
  assert.equal(h.cards.get('off').awake, true, 'not before the delay')
  h.advance(1000)
  assert.equal(h.cards.get('off').awake, false)
  assert.equal(h.cards.get('big').awake, true)
})

test('a small card (38% zoom thumbnail) sleeps; coming back large wakes it after the short delay', () => {
  const h = harness({ s: rectAt(100, 100, 547, 342) })
  h.advance(2500)
  assert.equal(h.cards.get('s').awake, false)
  h.cards.get('s').r = rectAt(0, 0, 1200, 800)
  h.advance(Sleep.TICK_MS)
  assert.equal(h.cards.get('s').awake, false, 'wake delay')
  h.advance(500)
  assert.equal(h.cards.get('s').awake, true)
})

test('hysteresis: a size between sleep and wake limits changes nothing; a brief shrink never sleeps', () => {
  const h = harness({ a: rectAt(0, 0, 600, 380) })
  h.advance(5000)
  assert.equal(h.cards.get('a').awake, true, 'above the sleep limits')
  h.cards.get('a').r = rectAt(0, 0, 500, 300); h.advance(1000)
  h.cards.get('a').r = rectAt(0, 0, 600, 380); h.advance(3000)
  assert.deepEqual(h.cards.get('a').log, [], 'the shrink ended before the delay')
  h.cards.get('a').r = rectAt(0, 0, 500, 300); h.advance(2500)
  assert.equal(h.cards.get('a').awake, false)
  h.cards.get('a').r = rectAt(0, 0, 600, 380); h.advance(3000)
  assert.equal(h.cards.get('a').awake, false, 'between the limits it stays asleep')
})

test('an excluded card (focus, tool use) is never slept, and wakes at once if it was asleep', () => {
  const h = harness({ f: rectAt(3000, 0, 1200, 800) })
  const c = h.cards.get('f')
  c.ex = true; h.advance(5000)
  assert.deepEqual(c.log, [])
  c.ex = false; h.advance(2500)
  assert.equal(c.awake, false)
  c.ex = true; h.advance(Sleep.TICK_MS)
  assert.equal(c.awake, true)
})

test('wakeNow (before a tool runs) wakes a sleeping card immediately and a later tick keeps it awake while excluded', () => {
  const h = harness({ f: rectAt(3000, 0, 1200, 800) })
  const c = h.cards.get('f')
  h.advance(2500)
  assert.equal(h.sleeper.isAsleep('f'), true)
  h.sleeper.wakeNow(c.entry)
  assert.equal(c.awake, true)
  assert.equal(h.sleeper.isAsleep('f'), false)
})

test('removed cards are forgotten', () => {
  const h = harness({ f: rectAt(3000, 0, 1200, 800) })
  h.advance(2500); h.cards.delete('f'); h.advance(500)
  assert.equal(h.sleeper.isAsleep('f'), false)
})

test('setBrowserAwake flips docShellIsActive and renderLayers; skips non-browser frames', () => {
  const b = { docShellIsActive: true, renderLayers: true }
  assert.equal(Sleep.setBrowserAwake(b, false), true)
  assert.deepEqual(b, { docShellIsActive: false, renderLayers: false })
  Sleep.setBrowserAwake(b, true)
  assert.deepEqual(b, { docShellIsActive: true, renderLayers: true })
  assert.equal(Sleep.setBrowserAwake({}, false), false, 'iframe fallback')
  assert.equal(Sleep.setBrowserAwake(null, false), false)
})

test('overlay wiring: flag read once, default off, tools wake first, focus and Agent work excluded', () => {
  assert.equal(js.split("readSurfacePref('egdesk.perf.sleepHiddenCards') === 'on'").length - 1, 1)
  assert.match(js, /guardCardForTools\(card, card\._browserControls\)/)
  assert.match(js, /try \{ installCardSleep\(\); \} catch/)
  for (const n of ['agentSnapshot', 'agentAct', 'captureInput', 'toolObserve', 'toolAct', 'toolReconcile', 'toolNavigateChrome', 'toolActivity', 'toolBrowser']) assert.match(js, new RegExp(`'${n}'`), n)
  assert.match(js, /state\.activeEntityId === card\.id/)
  assert.match(js, /card\.contains\(focus\)/)
  assert.match(js, /control\.inFlight > 0 \|\| control\.held/)
  assert.match(js, /screenRecorder\?\.active\?\.\(\)/)
})
