import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import * as helper from './egdesk-browser-pointer.mjs'
import * as mirror from '../overlay/resources/EGDeskBrowserPointer.sys.mjs'

const { POINTER_MIN_REMAINING_MS, POINTER_REFUSALS, frameLocalPoint, liveBoundsMatch, observedCenter,
  planPointerPress, pointerBudgetAllows, pointerFrame, pointerFrameMismatch } = helper

const frame = (overrides = {}) => ({ documentId: 'doc-1', revision: 7,
  viewport: { width: 720, height: 480, devicePixelRatio: 2 }, zoom: 1, scroll: { x: 0, y: 300 }, ...overrides })
const bounds = { x: 100, y: 40, width: 80, height: 30 }
const rectOf = (b, dx = 0, dy = 0) => ({ left: b.x + dx, top: b.y + dy, width: b.width, height: b.height })

test('the actor mirror is the helper module byte for byte below the shared marker', () => {
  const marker = '// ---- SHARED: mirrored below this line ----'
  const body = file => {
    const text = readFileSync(new URL(file, import.meta.url), 'utf8')
    assert.ok(text.includes(marker), `${file} has the shared marker`)
    return text.slice(text.indexOf(marker))
  }
  assert.equal(body('../overlay/resources/EGDeskBrowserPointer.sys.mjs'), body('./egdesk-browser-pointer.mjs'))
  assert.deepEqual(Object.keys(mirror).sort(), Object.keys(helper).sort())
  assert.doesNotMatch(body('./egdesk-browser-pointer.mjs'), /\bimport\b|\brequire\(|node:/, 'pure: no imports')
})

test('a frame is read only when every field is well formed', () => {
  assert.deepEqual(pointerFrame(frame()), { documentId: 'doc-1', revision: 7, width: 720, height: 480,
    devicePixelRatio: 2, zoom: 1, scrollX: 0, scrollY: 300 })
  assert.equal(pointerFrame(frame({ zoom: undefined })).zoom, null, 'an unread zoom is null, not 1')
  for (const bad of [null, 'frame', frame({ documentId: '' }), frame({ revision: 1.5 }),
    frame({ viewport: { width: 0, height: 480, devicePixelRatio: 1 } }),
    frame({ viewport: { width: 720, height: 480, devicePixelRatio: 0 } }),
    frame({ viewport: { width: 720, height: 480, devicePixelRatio: Number.NaN } }),
    frame({ scroll: null }), frame({ scroll: { x: 0, y: Infinity } }), frame({ zoom: -1 }), frame({ zoom: 'big' })]) {
    assert.equal(pointerFrame(bad), null)
  }
})

test('the observed frame holds only for the same document, revision, viewport, DPR, zoom and scroll', () => {
  assert.equal(pointerFrameMismatch(frame(), frame()), null)
  const cases = [
    [frame({ documentId: 'doc-2' }), 'document-changed'],
    [frame({ revision: 8 }), 'revision-changed'],
    [frame({ viewport: { width: 721, height: 480, devicePixelRatio: 2 } }), 'viewport-changed'],
    [frame({ viewport: { width: 720, height: 479, devicePixelRatio: 2 } }), 'viewport-changed'],
    [frame({ viewport: { width: 720, height: 480, devicePixelRatio: 2.5 } }), 'device-pixel-ratio-changed'],
    [frame({ zoom: 1.25 }), 'zoom-changed'],
    [frame({ zoom: undefined }), 'zoom-changed'],
    [frame({ scroll: { x: 0, y: 301 } }), 'scroll-changed'],
    [frame({ scroll: { x: 4, y: 300 } }), 'scroll-changed'],
    [{}, 'frame-unreadable'],
  ]
  for (const [live, reason] of cases) {
    assert.equal(pointerFrameMismatch(frame(), live), reason, reason)
    assert.equal(mirror.pointerFrameMismatch(frame(), live), reason, `mirror ${reason}`)
    assert.ok(POINTER_REFUSALS.includes(reason))
  }
  // Both sides unknown: devicePixelRatio (which carries full zoom) decides.
  assert.equal(pointerFrameMismatch(frame({ zoom: null }), frame({ zoom: undefined })), null)
  assert.equal(pointerFrameMismatch(frame({ zoom: 1.1 }), frame({ zoom: 1.1004 })), null, 'float noise below 0.001')
})

test('the observed centre uses only the part of the bounds inside the viewport', () => {
  const viewport = { width: 720, height: 480 }
  assert.deepEqual(observedCenter(bounds, viewport), { x: 140, y: 55 })
  assert.deepEqual(observedCenter({ x: -40, y: 10, width: 100, height: 20 }, viewport), { x: 30, y: 20 }, 'clipped left edge')
  assert.deepEqual(observedCenter({ x: 700, y: 470, width: 100, height: 100 }, viewport), { x: 710, y: 475 }, 'clipped bottom-right')
  assert.equal(observedCenter({ x: 800, y: 10, width: 10, height: 10 }, viewport), null, 'right of the viewport')
  assert.equal(observedCenter({ x: 10, y: -50, width: 10, height: 50 }, viewport), null, 'touches only the top edge')
  assert.equal(observedCenter({ x: 10, y: 10, width: 0, height: 10 }, viewport), null)
  assert.equal(observedCenter({ x: 10, y: 10, width: 10 }, viewport), null)
  assert.equal(observedCenter(bounds, { width: 0, height: 480 }), null)
})

test('live bounds match within the 1 px rounding of observed bounds', () => {
  assert.equal(liveBoundsMatch(bounds, rectOf(bounds)), true)
  assert.equal(liveBoundsMatch(bounds, { left: 100.4, top: 39.5, width: 80.9, height: 29.2 }), true)
  assert.equal(liveBoundsMatch(bounds, rectOf(bounds, 1.5)), false)
  assert.equal(liveBoundsMatch(bounds, { ...rectOf(bounds), width: 82 }), false)
  assert.equal(liveBoundsMatch(bounds, { left: 100, top: 40, width: 80 }), false)
  assert.equal(liveBoundsMatch(null, rectOf(bounds)), false)
})

test('frame offsets turn a display point into the target frame point, outermost first', () => {
  assert.deepEqual(frameLocalPoint({ x: 300, y: 200 }), { x: 300, y: 200 })
  assert.deepEqual(frameLocalPoint({ x: 300, y: 200 }, [{ x: 200, y: 100 }]), { x: 100, y: 100 })
  assert.deepEqual(frameLocalPoint({ x: 300, y: 200 }, [{ x: 200, y: 100 }, { x: 12.5, y: 8 }]), { x: 87.5, y: 92 })
  assert.equal(frameLocalPoint({ x: 300, y: 200 }, [{ x: 'a', y: 1 }]), null)
  assert.equal(frameLocalPoint({ x: 300 }, []), null)
})

test('plan: a top-document target lands on the observed centre; DPR only scales the receipt device point', () => {
  const plan = planPointerPress({ observed: frame(), live: frame(), bounds, liveRect: rectOf(bounds) })
  assert.deepEqual(plan, { ok: true, displayPoint: { x: 140, y: 55 }, inputPoint: { x: 140, y: 55 },
    devicePoint: { x: 280, y: 110 } })
  const dpr1 = frame({ viewport: { width: 720, height: 480, devicePixelRatio: 1.25 } })
  assert.deepEqual(planPointerPress({ observed: dpr1, live: dpr1, bounds, liveRect: rectOf(bounds) }).devicePoint,
    { x: 175, y: 68.75 })
})

test('plan: a target inside nested same-origin frames gets frame-local input and top display points', () => {
  const inner = { x: 230, y: 130, width: 60, height: 20 }
  const plan = planPointerPress({ observed: frame(), live: frame(), bounds: inner, liveRect: rectOf(inner, 0.3, -0.2),
    frameOffsets: [{ x: 200, y: 100 }, { x: 10.5, y: 10 }] })
  assert.equal(plan.ok, true)
  assert.deepEqual(plan.displayPoint, { x: 260, y: 140 })
  assert.deepEqual(plan.inputPoint, { x: 49.5, y: 30 })
  assert.deepEqual(planPointerPress({ observed: frame(), live: frame(), bounds: inner, liveRect: rectOf(inner),
    frameOffsets: [{ x: 200, y: null }] }), { ok: false, reason: 'frame-offset-unreadable' })
})

test('plan: zoom, DPR, viewport, scroll or revision changes discard the coordinates', () => {
  for (const [live, reason] of [
    [frame({ zoom: 1.1 }), 'zoom-changed'],
    [frame({ viewport: { width: 720, height: 480, devicePixelRatio: 2.2 } }), 'device-pixel-ratio-changed'],
    [frame({ viewport: { width: 600, height: 480, devicePixelRatio: 2 } }), 'viewport-changed'],
    [frame({ scroll: { x: 0, y: 340 } }), 'scroll-changed'],
    [frame({ revision: 9 }), 'revision-changed'],
  ]) {
    // The live rect even agrees: the frame rule alone refuses.
    assert.deepEqual(planPointerPress({ observed: frame(), live, bounds, liveRect: rectOf(bounds) }), { ok: false, reason })
  }
})

test('plan: a moved, clipped-away or malformed target is refused before any point is used', () => {
  const plan = input => planPointerPress({ observed: frame(), live: frame(), ...input })
  assert.deepEqual(plan({ bounds, liveRect: rectOf(bounds, 0, 12) }), { ok: false, reason: 'target-moved' },
    'inner scroll moved the element although the top scroll did not')
  assert.deepEqual(plan({ bounds: { x: 900, y: 10, width: 20, height: 20 }, liveRect: { left: 900, top: 10, width: 20, height: 20 } }),
    { ok: false, reason: 'target-outside-viewport' })
  assert.deepEqual(plan({ bounds: { x: 1, y: 2 }, liveRect: rectOf(bounds) }), { ok: false, reason: 'target-bounds-unreadable' })
  assert.deepEqual(plan({ bounds, liveRect: null }), { ok: false, reason: 'target-moved' })
  // A 1x1 box rounded to whole px: its centre can sit on the live edge.
  assert.deepEqual(plan({ bounds: { x: 10, y: 10, width: 1, height: 1 }, liveRect: { left: 10.5, top: 10, width: 1, height: 1 } }),
    { ok: false, reason: 'point-outside-target' })
  assert.deepEqual(planPointerPress(), { ok: false, reason: 'frame-unreadable' })
})

test('plan with a scrolled page: observation and live frame share the scroll, the point is viewport-local', () => {
  const scrolled = frame({ scroll: { x: 40, y: 1200 } })
  const plan = planPointerPress({ observed: scrolled, live: scrolled, bounds, liveRect: rectOf(bounds) })
  assert.deepEqual(plan.inputPoint, { x: 140, y: 55 }, 'scroll offsets never enter viewport coordinates')
})

test('a pointer sequence starts only with enough budget left (REA 웹8 b)', () => {
  assert.equal(POINTER_MIN_REMAINING_MS, 400)
  assert.equal(pointerBudgetAllows(400), true)
  assert.equal(pointerBudgetAllows(399), false)
  assert.equal(pointerBudgetAllows(Number.NaN), false)
  assert.equal(pointerBudgetAllows(100, 50), true)
  assert.ok(POINTER_REFUSALS.includes('budget-too-short'))
  assert.ok(Object.isFrozen(POINTER_REFUSALS))
})
