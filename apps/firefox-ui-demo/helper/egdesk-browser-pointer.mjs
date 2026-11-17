// BRW-10 (REA 웹1, D-B4): where a guarded "press like a person" lands.
// Pure and deterministic: no I/O and no node: imports, so the Firefox actor
// child runs the same code (overlay/resources/EGDeskBrowserPointer.sys.mjs is
// a byte-for-byte mirror of everything below the SHARED marker; the test
// helper/egdesk-browser-pointer.test.mjs compares the two).
//
// Coordinates come only from the bounds the Agent observed, and only while the
// observed frame still holds: same document and revision, same viewport size,
// devicePixelRatio, page zoom and top scroll offset. Anything else discards the
// point and refuses before input (EG-02); nothing here retries (EG-01).
//
// Spaces (all CSS px):
//   display point  top Browser viewport, the space observation bounds use
//                  (Child viewportRect: element rect plus same-origin frame
//                  content offsets). The Agent pointer dot is drawn here.
//   input point    the target's own window (a same-origin frame's viewport),
//                  what synthesizeMouseEvent / sendMouseEvent take. Gecko maps
//                  CSS px to device px with the pres context, so zoom and DPR
//                  are applied by Gecko, never again here.
//   device point   display point x devicePixelRatio; receipts only.
// ---- SHARED: mirrored below this line ----

// Observed bounds are rounded to whole CSS px by the actor.
export const POINTER_BOUNDS_TOLERANCE_PX = 1
// REA 웹8 (b): a pointer sequence starts only if this much of the request
// budget is left (move/down/up input plus the 150 ms settle floor).
export const POINTER_MIN_REMAINING_MS = 400
const ZOOM_EPSILON = 0.001
export const POINTER_REFUSALS = Object.freeze(['frame-unreadable', 'document-changed', 'revision-changed',
  'viewport-changed', 'device-pixel-ratio-changed', 'zoom-changed', 'scroll-changed', 'target-bounds-unreadable',
  'target-outside-viewport', 'target-moved', 'point-outside-target', 'frame-offset-unreadable', 'budget-too-short'])

function finite(value) { return typeof value === 'number' && Number.isFinite(value) }
function round2(value) { return Math.round(value * 100) / 100 }
function zoomOf(value) { return finite(value) && value > 0 ? value : null }

// The observed or live frame of one document, or null when a field is unreadable.
// state: { documentId, revision, viewport: { width, height, devicePixelRatio }, zoom?, scroll: { x, y } }
export function pointerFrame(state) {
  if (!state || typeof state !== 'object') return null
  const viewport = state.viewport
  const scroll = state.scroll
  if (typeof state.documentId !== 'string' || !state.documentId || !Number.isSafeInteger(state.revision)) return null
  if (!viewport || !finite(viewport.width) || !finite(viewport.height) || viewport.width <= 0 || viewport.height <= 0 ||
      !finite(viewport.devicePixelRatio) || viewport.devicePixelRatio <= 0) return null
  if (!scroll || !finite(scroll.x) || !finite(scroll.y)) return null
  if (state.zoom !== undefined && state.zoom !== null && zoomOf(state.zoom) === null) return null
  return { documentId: state.documentId, revision: state.revision, width: viewport.width, height: viewport.height,
    devicePixelRatio: viewport.devicePixelRatio, zoom: zoomOf(state.zoom), scrollX: scroll.x, scrollY: scroll.y }
}

// null when the observed frame still holds, else the first reason it does not.
export function pointerFrameMismatch(observed, live) {
  const a = pointerFrame(observed), b = pointerFrame(live)
  if (!a || !b) return 'frame-unreadable'
  if (a.documentId !== b.documentId) return 'document-changed'
  if (a.revision !== b.revision) return 'revision-changed'
  if (a.width !== b.width || a.height !== b.height) return 'viewport-changed'
  if (a.devicePixelRatio !== b.devicePixelRatio) return 'device-pixel-ratio-changed'
  // A zoom the actor could not read on both sides is not a match: either both
  // are unknown (then devicePixelRatio, which includes full zoom, decides) or
  // both are the same number.
  if ((a.zoom === null) !== (b.zoom === null)) return 'zoom-changed'
  if (a.zoom !== null && Math.abs(a.zoom - b.zoom) > ZOOM_EPSILON) return 'zoom-changed'
  if (a.scrollX !== b.scrollX || a.scrollY !== b.scrollY) return 'scroll-changed'
  return null
}

// Centre of the part of observed bounds { x, y, width, height } inside the
// viewport, or null when the bounds are malformed or wholly outside it.
export function observedCenter(bounds, viewport) {
  if (!bounds || !['x', 'y', 'width', 'height'].every(key => finite(bounds[key])) ||
      bounds.width <= 0 || bounds.height <= 0) return null
  const width = viewport?.width, height = viewport?.height
  if (!finite(width) || !finite(height) || width <= 0 || height <= 0) return null
  const left = Math.max(bounds.x, 0), right = Math.min(bounds.x + bounds.width, width)
  const top = Math.max(bounds.y, 0), bottom = Math.min(bounds.y + bounds.height, height)
  if (right <= left || bottom <= top) return null
  return { x: (left + right) / 2, y: (top + bottom) / 2 }
}

// Whether the live rect { left, top, width, height } (display space) is where
// the observation put the element, within the rounding of observed bounds.
export function liveBoundsMatch(bounds, rect, tolerance = POINTER_BOUNDS_TOLERANCE_PX) {
  if (!bounds || !rect || !['left', 'top', 'width', 'height'].every(key => finite(rect[key]))) return false
  return Math.abs(rect.left - bounds.x) <= tolerance && Math.abs(rect.top - bounds.y) <= tolerance &&
    Math.abs(rect.width - bounds.width) <= tolerance && Math.abs(rect.height - bounds.height) <= tolerance
}

// Display point -> the target window's point: minus each same-origin frame's
// content offset, outermost first. null when an offset is unreadable.
export function frameLocalPoint(point, frameOffsets = []) {
  if (!point || !finite(point.x) || !finite(point.y) || !Array.isArray(frameOffsets)) return null
  let x = point.x, y = point.y
  for (const offset of frameOffsets) {
    if (!offset || !finite(offset.x) || !finite(offset.y)) return null
    x -= offset.x
    y -= offset.y
  }
  return { x, y }
}

// The whole plan: { ok: true, displayPoint, inputPoint, devicePoint } or
// { ok: false, reason } (a POINTER_REFUSALS value).
//   observed     the frame the Agent observed (guard)
//   live         the frame now
//   bounds       the observed target bounds (display space, whole px)
//   liveRect     the target's live rect in display space
//   frameOffsets same-origin frame content offsets, outermost first
export function planPointerPress({ observed, live, bounds, liveRect, frameOffsets = [] } = {}) {
  const mismatch = pointerFrameMismatch(observed, live)
  if (mismatch) return { ok: false, reason: mismatch }
  if (!bounds || !['x', 'y', 'width', 'height'].every(key => finite(bounds[key])) ||
      bounds.width <= 0 || bounds.height <= 0) return { ok: false, reason: 'target-bounds-unreadable' }
  const display = observedCenter(bounds, observed.viewport)
  if (!display) return { ok: false, reason: 'target-outside-viewport' }
  if (!liveBoundsMatch(bounds, liveRect)) return { ok: false, reason: 'target-moved' }
  // The observed centre must also fall strictly inside the live box.
  if (!(display.x > liveRect.left && display.x < liveRect.left + liveRect.width &&
        display.y > liveRect.top && display.y < liveRect.top + liveRect.height)) return { ok: false, reason: 'point-outside-target' }
  const local = frameLocalPoint(display, frameOffsets)
  if (!local) return { ok: false, reason: 'frame-offset-unreadable' }
  const dpr = observed.viewport.devicePixelRatio
  return { ok: true, displayPoint: { x: round2(display.x), y: round2(display.y) },
    inputPoint: { x: round2(local.x), y: round2(local.y) },
    devicePoint: { x: round2(display.x * dpr), y: round2(display.y * dpr) } }
}

// REA 웹8 (b): whether a multi-step input may start with remainingMs left.
export function pointerBudgetAllows(remainingMs, minimumMs = POINTER_MIN_REMAINING_MS) {
  return finite(remainingMs) && remainingMs >= minimumMs
}
