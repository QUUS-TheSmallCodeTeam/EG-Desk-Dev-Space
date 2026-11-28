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

const flush = () => new Promise(r => setImmediate(r))
const verdict = (rect, asleep, scale) => Sleep.sleepVerdict({ rect, viewport: VP, asleep, scale })

test('L48 rules: the c12 trap (1070x398 asleep) wakes by area; tiny and unreadable cards sleep', () => {
  assert.equal(verdict(rectAt(100, 100, 1070, 398), true, 1.148), 'wake', '33% of the viewport')
  assert.equal(verdict(rectAt(100, 100, 1070, 398), false, 1.148), 'keep', 'awake stays awake')
  assert.equal(verdict(rectAt(0, 0, 900, 300), true), 'keep', '21%: hysteresis band, below WAKE_AREA_AT, short height')
  assert.equal(verdict(rectAt(0, 0, 700, 330), false), 'sleep', 'small side and under 20%')
  assert.equal(verdict(rectAt(0, 0, 1100, 340), false), 'keep', '29% area dominates even with a short side')
  assert.equal(verdict(rectAt(100, 100, 547, 342), false, 0.376), 'sleep', 'overview thumbnail')
  assert.equal(verdict(rectAt(0, 0, 1300, 850), false, 0.4), 'sleep', 'unreadable zoom sleeps even when large')
  assert.equal(verdict(rectAt(0, 0, 1300, 850), true, 0.55), 'keep', 'zoom hysteresis 0.5/0.58')
  assert.equal(verdict(rectAt(0, 0, 1300, 850), true, 0.6), 'wake')
  assert.equal(verdict(rectAt(1400, 0, 1200, 800), true, 1), 'keep', 'mostly off-screen stays asleep')
  assert.equal(verdict(null, false), 'sleep')
})

function fakeBrowser({ drawSnapshot, cw = 1200, ch = 800, onScreenW = 600 } = {}) {
  const parent = { children: [], appendChild(c) { this.children.push(c); c.parent = this } }
  const mkCanvas = () => ({ width: 0, height: 0, style: {}, attrs: {}, removed: false,
    getContext() { return { drawImage: (b) => { this.drew = b } } }, setAttribute(k) { this.attrs[k] = true },
    remove() { this.removed = true; const i = parent.children.indexOf(this); if (i >= 0) parent.children.splice(i, 1) } })
  return { parentNode: parent, offsetLeft: 0, offsetTop: 0, offsetWidth: cw, offsetHeight: ch, clientWidth: cw, clientHeight: ch,
    ownerDocument: { createElementNS: () => mkCanvas() },
    getBoundingClientRect: () => ({ width: onScreenW, height: onScreenW * ch / cw }),
    browsingContext: { currentWindowGlobal: drawSnapshot ? { drawSnapshot } : null } }
}

test('snapshot: scaled to the on-screen size, shown over the page, removed after wake, memory freed', async () => {
  const calls = []; const bitmap = { closed: false, close() { this.closed = true } }
  const b = fakeBrowser({ drawSnapshot: async (rect, scale, bg) => { calls.push({ rect, scale, bg }); bitmap.width = 1200; bitmap.height = 800; return bitmap } })
  const r = await Sleep.sleepBrowserWithFrame(b, { dpr: 2 })
  assert.equal(r.framed, true)
  assert.equal(calls[0].rect, null, 'null = visible viewport; a plain object would throw TypeError (DOMRect is an interface)')
  assert.equal(calls[0].scale, 1, 'on-screen 600 css px at dpr 2 = 1200 device px = scale 1 (capped at 1)')
  assert.equal(b._egdSleepFrame.width, 1200)
  assert.equal(bitmap.closed, true, 'ImageBitmap released right after drawing')
  assert.equal(b.parentNode.children.length, 1)
  let timer; Sleep.wakeBrowserWithFrame(b, { setTimer: (fn) => { timer = fn } })
  assert.equal(b.parentNode.children.length, 1, 'frame kept until the page repainted')
  const canvas = b._egdSleepFrame; timer()
  assert.equal(b._egdSleepFrame, null); assert.equal(canvas.removed, true); assert.equal(canvas.width, 0)
})

test('snapshot: small card gets a small bitmap; huge card is capped by the pixel budget', async () => {
  const calls = []
  const small = fakeBrowser({ drawSnapshot: async (r, s) => { calls.push(s); return { width: 450, height: 300, close() {} } }, onScreenW: 450 })
  await Sleep.captureSleepFrame(small, { dpr: 1 })
  assert.equal(calls[0], 450 / 1200)
  const huge = fakeBrowser({ drawSnapshot: async (r, s) => { calls.push(s); return { width: 10, height: 10, close() {} } }, cw: 6000, ch: 4000, onScreenW: 6000 })
  await Sleep.captureSleepFrame(huge, { dpr: 1 })
  assert.ok(calls[1] * calls[1] * 6000 * 4000 <= Sleep.FRAME_MAX_PIXELS + 1)
})

test('snapshot failure keeps v1 behaviour: no frame, card still sleeps', async () => {
  for (const b of [fakeBrowser(), fakeBrowser({ drawSnapshot: async () => { throw new Error('boom') } }), fakeBrowser({ drawSnapshot: async () => null })]) {
    const res = await Sleep.sleepBrowserWithFrame(b)
    assert.equal(res.framed, false); assert.ok(res.error, 'error string for the report'); assert.equal(b._egdSleepError, res.error)
    assert.equal(b._egdSleepFrame, undefined)
  }
  const h = harness({ f: rectAt(3000, 0, 1200, 800) })
  const c = h.cards.get('f'); c.entry.prepareSleep = async () => { throw new Error('x') }
  h.advance(2500); await flush()
  assert.equal(c.awake, false)
})

test('sleep waits for the snapshot; woken or closed meanwhile cancels it; onForget releases a closed sleeper', async () => {
  let release; const forgotten = []
  let t = 1000; const list = new Map()
  const mk = (id) => { const c = { id, r: rectAt(3000, 0, 1200, 800), awake: true, ex: false }; c.entry = { id, rect: () => c.r, excluded: () => c.ex, setAwake: (a) => { c.awake = a }, prepareSleep: () => new Promise(res => { release = res }) }; list.set(id, c); return c }
  const sleeper = Sleep.createCardSleeper({ cards: () => [...list.values()].map(c => c.entry), viewport: () => VP, now: () => t, onForget: (id) => forgotten.push(id) })
  const adv = (ms) => { for (let i = 0; i < ms; i += Sleep.TICK_MS) { t += Sleep.TICK_MS; sleeper.tick() } }
  const a = mk('a'); adv(2500)
  assert.equal(a.awake, true, 'still awake while capturing'); assert.equal(sleeper.states()[0].preparing, true)
  a.ex = true; adv(500); release(); await flush()
  assert.equal(a.awake, true, 'tool arrived during capture: stays awake'); assert.equal(sleeper.isAsleep('a'), false)
  a.ex = false; adv(2500); release(); await flush()
  assert.equal(sleeper.isAsleep('a'), true); assert.equal(a.awake, false)
  list.delete('a'); adv(500)
  assert.deepEqual(forgotten, ['a'])
  const b = mk('b'); adv(2500); list.delete('b'); adv(500); release(); await flush()
  assert.equal(b.awake, true, 'closed during capture: never put to sleep')
})

test('L48 wiring: frame helpers, effective zoom, frame release on close, diagnostics hook', () => {
  assert.match(js, /prepareSleep: \(\) => CardSleep\.sleepBrowserWithFrame/)
  assert.match(js, /wakeBrowserWithFrame\(browser\)/)
  assert.match(js, /onForget: \(id\)/)
  assert.match(js, /cardSleepReport: \(\) => cardSleepReport\(\)/)
  assert.match(js, /scale: \(\) => \(state\.zoom > 0 \? state\.zoom : null\)/)
  assert.match(js, /lastCaptureError: String\(b\._egdSleepError/)
  assert.doesNotMatch(js, /drawSnapshot\(\{ x: 0/)
})

// Canvas zoom z; the page sits ~0.53x inside the card (innerRatio), card natural size 1000x650 layout px at zoom 1.
test('L48 canvas-zoom rule with the inner factor: 0.376 sleeps, >=0.6 mostly visible card awake, hysteresis', () => {
  const INNER = 0.53
  const cardAt = (z, left = 50, top = 40) => rectAt(left, top, 1000 * INNER * z * 1.9, 650 * INNER * z * 1.9) // the card rect grows with canvas zoom
  for (const z of [0.376]) {
    assert.equal(verdict(cardAt(z), false, z), 'sleep', 'overview, awake -> sleep')
    assert.equal(verdict(cardAt(z), true, z), 'keep', 'overview, asleep stays')
  }
  for (const z of [0.6, 1.0, 1.148]) {
    const r = rectAt(40, 30, 1100, 780) // mostly visible
    assert.equal(verdict(r, true, z), 'wake', 'asleep wakes at canvas zoom ' + z)
    assert.equal(verdict(r, false, z), 'keep', 'awake stays at canvas zoom ' + z)
  }
  assert.equal(verdict(rectAt(40, 30, 1100, 780), false, 0.52), 'keep', 'awake at 0.52 (above 0.5) stays')
  assert.equal(verdict(rectAt(40, 30, 1100, 780), true, 0.52), 'keep', 'asleep at 0.52 (below 0.58) stays: hysteresis')
  assert.equal(verdict(rectAt(40, 30, 1100, 780), false, 0.48), 'sleep')
  // the element's own ratio (~0.53 at zoom 1.0, ~0.2 at 0.376) must never be what is fed in
  assert.equal(verdict(rectAt(40, 30, 1100, 780), true, 0.53), 'keep')
})

test('first snapshot failing (not yet painted): card stays awake and retries, sleeps blank after the grace cap', async () => {
  let t = 1000, tries = 0, ok = false
  const c = { id: 'p', r: rectAt(3000, 0, 1200, 800), awake: true }
  c.entry = { id: 'p', rect: () => c.r, excluded: () => false, scale: () => 0.376, setAwake: (a) => { c.awake = a }, prepareSleep: async () => { tries++; return ok ? { framed: true } : { framed: false, error: 'loading' } } }
  const sleeper = Sleep.createCardSleeper({ cards: () => [c.entry], viewport: () => VP, now: () => t })
  const adv = async (ms) => { for (let i = 0; i < ms; i += Sleep.TICK_MS) { t += Sleep.TICK_MS; sleeper.tick(); await flush() } }
  await adv(2500)
  assert.ok(tries >= 1); assert.equal(c.awake, true, 'failed capture does not sleep yet')
  const before = tries; await adv(2000)
  assert.ok(tries > before, 'retried on the following ticks'); assert.equal(c.awake, true)
  ok = true; await adv(1000)
  assert.equal(c.awake, false, 'sleeps once a frame exists')
  // cap
  t = 1000; const d = { ...c, awake: true }
  const s2 = Sleep.createCardSleeper({ cards: () => [{ ...c.entry, id: 'q', setAwake: (a) => { d.awake = a }, prepareSleep: async () => ({ framed: false, error: 'x' }) }], viewport: () => VP, now: () => t })
  for (let i = 0; i < 20; i++) { t += Sleep.TICK_MS; s2.tick(); await flush() }
  assert.equal(d.awake, false, 'after CAPTURE_GRACE_MS sleeps blank, as v1')
})

test('capture is skipped while the document is loading (retry later)', async () => {
  const b = fakeBrowser({ drawSnapshot: async () => ({ width: 1, height: 1, close() {} }) }); b.webProgress = { isLoadingDocument: true }
  assert.equal((await Sleep.captureSleepFrame(b)).error, 'loading')
})
