import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { trimToSafeBottom } from '../overlay/resources/EGDeskSurfaceState.sys.mjs'
import { edgeDotsBesideDock } from '../overlay/resources/EGDeskViewportExtras.sys.mjs'

// c35 desk UX fixes that live in pure functions or in the wiring of the (30k-line) surface script, checked in the synthetic DOM / by source.
const surface = readFileSync(new URL('../overlay/JS/eg-desk-surface.uc.js', import.meta.url), 'utf8')

test('UX-1: a View taller than the room above the dock gives up the overflow (down to 320), so the dock never covers its lower controls; one that cannot keeps its size', () => {
  const safe = { left: 0, top: 80, right: 1280, bottom: 560 }
  assert.deepEqual(trimToSafeBottom({ x: 100, y: 90, width: 600, height: 600 }, safe), { x: 100, y: 90, width: 600, height: 470 }, 'the 600 px Settings card at 720 px: 90 + 470 = 560')
  const fits = { x: 0, y: 100, width: 400, height: 300 }; assert.equal(trimToSafeBottom(fits, safe), fits, 'already inside: the same object')
  const chat = { x: 0, y: 90, width: 320, height: 420 }; assert.equal(trimToSafeBottom(chat, { ...safe, bottom: 300 }), chat, 'it cannot stay 320 px high: unchanged (the minimum rule of the placement stays)')
  assert.deepEqual(trimToSafeBottom({ x: 0, y: 90, width: 300, height: 700 }, safe).height, 470); assert.equal(trimToSafeBottom(null, safe), null); assert.deepEqual(trimToSafeBottom({ x: 0, y: NaN, width: 1, height: 1 }, safe), { x: 0, y: NaN, width: 1, height: 1 })
})

test('UX-2: the dots for Views below the screen sit in the dock\'s band beside the dock, never over it, never over each other; the other sides are untouched', () => {
  const dock = { left: 300, right: 760, top: 662, height: 46 }, viewport = { width: 1280, height: 720 }
  const dots = [{ side: 'bottom', x: 671, y: 638, id: 'a' }, { side: 'bottom', x: 695, y: 638, id: 'b' }, { side: 'bottom', x: 900, y: 638, id: 'c' }, { side: 'right', x: 1270, y: 300, id: 'd' }, { side: 'top', x: 10, y: 10, id: 'e' }]
  const out = edgeDotsBesideDock(dots, { dock, viewport })
  for (const dot of out.filter(d => d.side === 'bottom')) { assert.equal(dot.y, 685, `${dot.id} is in the dock's band`); assert.ok(dot.x <= dock.left - 16 || dot.x >= dock.right + 16, `${dot.id} x=${dot.x} is beside the dock`) }
  const xs = out.filter(d => d.side === 'bottom').map(d => d.x).sort((a, b) => a - b)
  for (let i = 1; i < xs.length; i++) assert.ok(xs[i] - xs[i - 1] >= 26 || xs[i] === xs[i - 1] && false, `dots ${xs} do not overlap`)
  assert.deepEqual(out.filter(d => d.side !== 'bottom'), dots.filter(d => d.side !== 'bottom'), 'other sides unchanged'); assert.deepEqual(dots[0], { side: 'bottom', x: 671, y: 638, id: 'a' }, 'the input is not mutated')
  assert.equal(edgeDotsBesideDock(dots, { dock: null, viewport }), dots, 'no dock: nothing moves'); assert.equal(edgeDotsBesideDock(dots, { dock: { ...dock, height: 0 }, viewport }), dots)
  const edge = edgeDotsBesideDock([{ side: 'bottom', x: 5, y: 1, id: 'x' }], { dock, viewport })[0]; assert.ok(edge.x >= 16, 'kept inside the window')
})

test('wiring in the surface: the placement trims to the dock, the bottom dots go beside it, the login terminal keeps the Settings card in view, a popup syncs its address and title', () => {
  assert.match(surface, /return SurfaceState\.trimToSafeBottom\?\.\(placed, safe\) \?\? placed;/)
  assert.match(surface, /ViewportExtras\.edgeDotsBesideDock\(dots, \{ dock: dockRect/)
  assert.match(surface, /openTerminal: \(\) => \(loginCard = spawnTerminalCard\(\{ keepVisible:/)
  assert.match(surface, /const requester = options\.keepVisible\?\.isConnected/)
  const listener = surface.slice(surface.indexOf('const browserLocationListener = {'), surface.indexOf('card._browserLocationListener = browserLocationListener'))
  assert.match(listener, /onLocationChange[\s\S]*syncBrowserStateFromBrowser\(\{ markDirtyOnLocationChange: true \}\)/)
  assert.match(listener, /STATE_STOP[\s\S]*setBrowserLoading\(false\)[\s\S]*syncBrowserStateFromBrowser/)
})
