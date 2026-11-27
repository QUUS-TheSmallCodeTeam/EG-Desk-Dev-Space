// Screen recording v1 (round d, lane L37; module name is a temporary name). The EG-Desk window is captured at a low
// rate, covered where a field is sensitive, and only then encoded, in the contract's order: capture -> scope check ->
// mask -> encode (ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md, "Firefox, OS adapter, capture, recording").
//
// - Capture: window-global drawSnapshot (the same composited capture Marionette uses; remote Browser cards included).
// - Mask: every Browser card is asked for its screenshot mask (the Browser agent actor's existing `screenshotMask`
//   report: password / one-time-code / card / private-marked fields, other-site frames, embedded objects). A card that
//   cannot answer, is private, a sign-in card, or is zoomed is covered whole. Chrome fields of type password or marked
//   data-sensitive / data-private are covered too. A frame whose mask cannot be built is dropped, never drawn.
//   Boxes of the previous frame are painted again with the new ones, so a field that moved never shows for a frame.
// - Encode: canvas.captureStream(rate) (frames exist only when the canvas is drawn; requestFrame was ~1/s in Firefox) -> MediaRecorder in a supported WebM.
//   No supported WebM = no recording (the start is refused; no native encoder is bundled).
// - Files: <dir>/<id>.webm grows by timeslice segments; <dir>/<id>.json (sidecar) holds owner, runtime, node (written
//   BEFORE the first frame), and per segment: time range, byte range, sha256, mask revision range, frames drawn/dropped.
//   Timeslice length is not exact; the sidecar records what really happened.
// - Cost: nothing runs until start(); stop() clears the timer, tracks and indicator.
// - A recording is not success evidence for any work; it is a record to look at.
import { normalizeMaskReport, maskRegionInViewport } from './EGDeskScreenshotMask.sys.mjs';

export const SCREEN_RECORDING = Object.freeze({
  schema: 'egdesk-screen-recording/1',
  fps: 4, scale: 0.5, timesliceMs: 2000, maxMs: 30 * 60_000, bitsPerSecond: 600_000,
  maxFps: 15, minScale: 0.25, maxScale: 1, minTimesliceMs: 500, maxMaxMs: 2 * 60 * 60_000,
  maskQueryMs: 800, maskMarginPx: 3, viewportSlackPx: 24,
  mimeCandidates: Object.freeze(['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']),
  idPattern: /^rec-[a-z0-9-]{6,60}$/,
  dotId: 'egd-recording-dot',
})

const clamp = (value, min, max, fallback) => (Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback)
const hex = bytes => Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('')

/** The options a start command may set, clamped; anything else is the default. */
export function recordingOptions(command = {}) {
  return {
    fps: clamp(Number(command.fps), 0.5, SCREEN_RECORDING.maxFps, SCREEN_RECORDING.fps),
    scale: clamp(Number(command.scale), SCREEN_RECORDING.minScale, SCREEN_RECORDING.maxScale, SCREEN_RECORDING.scale),
    timesliceMs: clamp(Number(command.timesliceMs), SCREEN_RECORDING.minTimesliceMs, 30_000, SCREEN_RECORDING.timesliceMs),
    maxMs: clamp(Number(command.maxMs), 1000, SCREEN_RECORDING.maxMaxMs, SCREEN_RECORDING.maxMs),
  }
}

/** First candidate WebM type the recorder supports, or null. */
export function pickRecordingMime(MediaRecorderCtor, candidates = SCREEN_RECORDING.mimeCandidates) {
  if (typeof MediaRecorderCtor !== 'function' || typeof MediaRecorderCtor.isTypeSupported !== 'function') return null
  for (const mime of candidates) { try { if (MediaRecorderCtor.isTypeSupported(mime)) return mime } catch {} }
  return null
}

const wholeBox = (rect, kind) => ({ x: Math.floor(rect.left), y: Math.floor(rect.top), width: Math.ceil(rect.width) + 1, height: Math.ceil(rect.height) + 1, kind })

/**
 * Cover boxes (window CSS pixels) for one Browser card. frame = { rect: {left,top,width,height}, cover?: reason }.
 * cover = the card is covered whole without asking (private, sign-in card, zoomed). report = the card's screenshotMask
 * answer or null. Any report that is missing, incomplete or does not fit the card's box covers the card whole.
 */
export function cardCoverBoxes(frame, report, { marginPx = SCREEN_RECORDING.maskMarginPx, slackPx = SCREEN_RECORDING.viewportSlackPx } = {}) {
  const rect = frame?.rect
  if (!rect || ![rect.left, rect.top, rect.width, rect.height].every(Number.isFinite)) return { boxes: [], whole: false, reason: 'no-rect' }
  if (frame.cover) return { boxes: [wholeBox(rect, `card-${frame.cover}`)], whole: true, reason: frame.cover }
  const normalized = normalizeMaskReport(report)
  if (!normalized.ok) return { boxes: [wholeBox(rect, 'card-unreadable')], whole: true, reason: normalized.reason }
  const viewport = normalized.report.viewport
  if (Math.abs(viewport.width - rect.width) > slackPx || Math.abs(viewport.height - rect.height) > slackPx) {
    return { boxes: [wholeBox(rect, 'card-size-mismatch')], whole: true, reason: 'viewport-mismatch' }
  }
  const boxes = []
  for (const region of normalized.report.regions) {
    const box = maskRegionInViewport(region.rect, viewport, marginPx)
    if (box) boxes.push({ x: Math.floor(rect.left) + box.x, y: Math.floor(rect.top) + box.y, width: box.width, height: box.height, kind: region.kind })
  }
  return { boxes, whole: false, reason: null }
}

/** Stable text key of a box list; the mask revision rises when it changes. */
export const maskKey = boxes => boxes.map(b => `${b.x},${b.y},${b.width},${b.height},${b.kind}`).sort().join('|')

/** Boxes in canvas pixels, grown by one pixel so a rescaled edge never uncovers a pixel. */
export function scaleBoxes(boxes, sx, sy, canvas) {
  const out = []
  for (const b of boxes) {
    const x0 = Math.max(0, Math.floor(b.x * sx) - 1), y0 = Math.max(0, Math.floor(b.y * sy) - 1)
    const x1 = Math.min(canvas.width, Math.ceil((b.x + b.width) * sx) + 1), y1 = Math.min(canvas.height, Math.ceil((b.y + b.height) * sy) + 1)
    if (x1 > x0 && y1 > y0) out.push({ x: x0, y: y0, width: x1 - x0, height: y1 - y0 })
  }
  return out
}

const withTimeout = (promise, ms, setTimer, clearTimer) => new Promise((resolve, reject) => {
  const timer = setTimer(() => reject(new Error('mask-query-timeout')), ms)
  Promise.resolve(promise).then(v => { clearTimer(timer); resolve(v) }, e => { clearTimer(timer); reject(e) })
})

/**
 * createScreenRecorder(deps) -> { start(command), stop(reason), status(), active() }
 * deps: window, document, IOUtils, MediaRecorder, crypto, now(), setTimeout, clearTimeout,
 *   capture(rect, scale) -> ImageBitmap-like { width, height, close() }   (window drawSnapshot)
 *   frames() -> [{ id, rect, cover?, query?: () => Promise<mask report> }]  (visible Browser cards)
 *   chromeCovers() -> [{ left, top, width, height }]                        (sensitive chrome fields)
 *   report(body) -> Promise                                                  (status to the bridge, best effort)
 *   runtime() -> plain object about this run (version, platform, window)
 */
export function createScreenRecorder(deps) {
  const { window: win, document: doc, IOUtils, MediaRecorder, crypto } = deps
  const now = deps.now || (() => Date.now())
  const setTimer = deps.setTimeout || win.setTimeout.bind(win)
  const clearTimer = deps.clearTimeout || win.clearTimeout.bind(win)
  let run = null

  const report = body => { try { return Promise.resolve(deps.report?.(body)).catch(() => {}) } catch { return Promise.resolve() } }
  const sidecarOf = r => ({
    schema: SCREEN_RECORDING.schema, id: r.id, label: r.label, state: r.state, owner: r.owner, runtime: r.runtime, node: r.node,
    mime: r.mime, fps: r.options.fps, scale: r.options.scale, timesliceMs: r.options.timesliceMs, maxMs: r.options.maxMs,
    canvas: { width: r.canvas.width, height: r.canvas.height }, windowCss: r.windowCss,
    startedAt: r.startedAt, endedAt: r.endedAt ?? null, stopReason: r.stopReason ?? null, file: `${r.id}.webm`,
    segments: r.segments, totalBytes: r.totalBytes, framesDrawn: r.framesDrawn, framesDropped: r.framesDropped, dropReasons: r.dropReasons,
    maskRevision: r.maskRevision, maskRevisions: r.maskRevisions, error: r.error ?? null, verification: r.verification ?? null,
  })
  const persist = r => IOUtils.writeJSON(r.sidecarPath, sidecarOf(r))
  const summary = r => ({ id: r.id, state: r.state, label: r.label, startedAt: r.startedAt, endedAt: r.endedAt ?? null, stopReason: r.stopReason ?? null,
    file: r.filePath, sidecar: r.sidecarPath, segments: r.segments.length, totalBytes: r.totalBytes, framesDrawn: r.framesDrawn,
    framesDropped: r.framesDropped, dropReasons: r.dropReasons, maskRevision: r.maskRevision, mime: r.mime, error: r.error ?? null })

  function indicator(on) {
    try {
      const old = doc.getElementById(SCREEN_RECORDING.dotId)
      if (!on) { old?.remove(); return }
      if (old) return
      const dot = doc.createElementNS('http://www.w3.org/1999/xhtml', 'div')
      dot.id = SCREEN_RECORDING.dotId
      // Text-free mark: a small red dot at the top right; it never takes a click.
      dot.setAttribute('style', 'position:fixed;top:8px;right:8px;width:10px;height:10px;border-radius:50%;background:#e5322d;z-index:2147483647;pointer-events:none;')
      ;(doc.documentElement || doc.body).appendChild(dot)
    } catch {}
  }

  async function collectMasks(r) {
    const frames = deps.frames?.() || []
    const answers = await Promise.all(frames.map(async frame => {
      if (frame.cover || typeof frame.query !== 'function') return cardCoverBoxes(frame, null)
      let answer = null
      try { answer = await withTimeout(frame.query(), SCREEN_RECORDING.maskQueryMs, setTimer, clearTimer) } catch {}
      return cardCoverBoxes(frame, answer)
    }))
    const boxes = []
    for (const answer of answers) boxes.push(...answer.boxes)
    for (const rect of deps.chromeCovers?.() || []) if (rect && rect.width > 0 && rect.height > 0) boxes.push(wholeBox(rect, 'chrome-field'))
    const wholeCards = answers.filter(a => a.whole).length
    return { boxes, wholeCards }
  }

  async function tick(r) {
    if (r !== run || r.state !== 'recording') return
    if (r.busy) { r.framesDropped++; r.segDropped++; r.dropReasons.busy = (r.dropReasons.busy || 0) + 1; return }
    r.busy = true
    let bitmap = null
    try {
      const wCss = win.innerWidth, hCss = win.innerHeight
      if (!(wCss > 0 && hCss > 0)) throw Object.assign(new Error('no-window-size'), { drop: 'no-window-size' })
      let masks
      try { masks = await collectMasks(r) } catch { throw Object.assign(new Error('mask-failed'), { drop: 'mask-failed' }) }
      const key = maskKey(masks.boxes)
      if (key !== r.lastMaskKey) {
        r.maskRevision++
        r.lastMaskKey = key
        r.maskRevisions.push({ revision: r.maskRevision, atMs: now() - r.startedMs, boxes: masks.boxes.length, wholeCards: masks.wholeCards })
        if (r.maskRevisions.length > 200) r.maskRevisions.splice(1, 1)
      }
      const painted = masks.boxes.concat(r.prevBoxes)
      r.prevBoxes = masks.boxes
      try { bitmap = await deps.capture({ x: 0, y: 0, width: wCss, height: hCss }, r.options.scale) } catch { throw Object.assign(new Error('capture-failed'), { drop: 'capture-failed' }) }
      if (r !== run || r.state !== 'recording') return
      const ctx = r.ctx
      ctx.drawImage(bitmap, 0, 0, r.canvas.width, r.canvas.height)
      ctx.fillStyle = '#000000'
      for (const box of scaleBoxes(painted, r.canvas.width / wCss, r.canvas.height / hCss, r.canvas)) ctx.fillRect(box.x, box.y, box.width, box.height)
      r.framesDrawn++; r.segDrawn++
      r.segRevMax = Math.max(r.segRevMax, r.maskRevision)
    } catch (error) {
      const reason = error?.drop || 'draw-failed'
      r.framesDropped++; r.segDropped++; r.dropReasons[reason] = (r.dropReasons[reason] || 0) + 1
    } finally {
      try { bitmap?.close?.() } catch {}
      r.busy = false
      if (r === run && r.state === 'recording') r.timer = setTimer(() => tick(r), Math.max(10, 1000 / r.options.fps))
    }
  }

  async function writeSegment(r, blob) {
    const endMs = now() - r.startedMs
    const bytes = new Uint8Array(await blob.arrayBuffer())
    const sha256 = hex(await crypto.subtle.digest('SHA-256', bytes))
    await IOUtils.write(r.filePath, bytes, { mode: 'appendOrCreate' })
    r.segments.push({ index: r.segments.length, offset: r.totalBytes, bytes: bytes.length, sha256, startMs: r.segStartMs, endMs,
      maskRevisionFrom: r.segRevMin, maskRevisionTo: r.segRevMax, framesDrawn: r.segDrawn, framesDropped: r.segDropped })
    r.totalBytes += bytes.length
    r.segStartMs = endMs; r.segRevMin = r.maskRevision; r.segRevMax = r.maskRevision; r.segDrawn = 0; r.segDropped = 0
    await persist(r)
  }

  async function start(command = {}) {
    if (run && run.state !== 'finished' && run.state !== 'failed') return { ok: false, reason: 'already-recording', id: run.id }
    const id = String(command.id || '')
    if (!SCREEN_RECORDING.idPattern.test(id)) return { ok: false, reason: 'bad-id' }
    const dir = String(command.dir || '')
    if (!dir.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(dir)) return { ok: false, reason: 'bad-dir' }
    const mime = pickRecordingMime(MediaRecorder)
    if (!mime) return { ok: false, reason: 'encoder-unsupported' }
    const options = recordingOptions(command)
    const sep = dir.includes('\\') && !dir.includes('/') ? '\\' : '/'
    const filePath = `${dir.replace(/[\\/]+$/, '')}${sep}${id}.webm`, sidecarPath = `${dir.replace(/[\\/]+$/, '')}${sep}${id}.json`
    const r = { id, label: String(command.label || '').slice(0, 120), state: 'starting', options, mime, filePath, sidecarPath,
      owner: command.owner && typeof command.owner === 'object' ? command.owner : { kind: 'unknown' },
      runtime: { ...(deps.runtime?.() || {}), bridgePid: command.bridgePid ?? null }, node: { kind: 'egdesk-window', surface: 'desk' },
      startedAt: new Date(now()).toISOString(), startedMs: now(), segments: [], totalBytes: 0, framesDrawn: 0, framesDropped: 0, dropReasons: {},
      maskRevision: 0, maskRevisions: [], lastMaskKey: null, prevBoxes: [], busy: false, timer: null, maxTimer: null,
      segStartMs: 0, segRevMin: 0, segRevMax: 0, segDrawn: 0, segDropped: 0, chain: Promise.resolve(), windowCss: { width: win.innerWidth, height: win.innerHeight } }
    const width = Math.max(2, Math.round(win.innerWidth * options.scale)), height = Math.max(2, Math.round(win.innerHeight * options.scale))
    r.canvas = doc.createElementNS('http://www.w3.org/1999/xhtml', 'canvas')
    r.canvas.width = width; r.canvas.height = height
    r.ctx = r.canvas.getContext('2d', { alpha: false })
    if (!r.ctx) return { ok: false, reason: 'canvas-unavailable' }
    try {
      await IOUtils.makeDirectory(dir, { createAncestors: true, ignoreExisting: true })
      if (await IOUtils.exists(sidecarPath) || await IOUtils.exists(filePath)) return { ok: false, reason: 'exists' }
      // Node, owner and runtime are stored before the first frame exists (contract).
      await persist(r)
      // Measured in Firefox: captureStream(0)+requestFrame reaches the encoder about once a second; captureStream(rate) follows the canvas.
      // The canvas only changes when a frame is drawn here, so a rate above fps costs nothing while nothing is drawn.
      const stream = r.canvas.captureStream(Math.min(30, Math.max(8, Math.ceil(options.fps * 2))))
      r.stream = stream
      r.track = stream.getVideoTracks()[0]
      r.recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: SCREEN_RECORDING.bitsPerSecond })
      r.recorder.ondataavailable = event => { if (event.data?.size) r.chain = r.chain.then(() => writeSegment(r, event.data)).catch(error => { r.error = `write-failed: ${error?.message || error}`.slice(0, 200) }) }
      r.stopped = new Promise(resolve => { r.recorder.onstop = resolve; r.recorder.onerror = () => { r.error = 'recorder-error'; resolve() } })
    } catch (error) {
      r.state = 'failed'; r.error = `start-failed: ${error?.message || error}`.slice(0, 200)
      try { r.stream?.getTracks().forEach(t => t.stop()) } catch {}
      return { ok: false, reason: 'start-failed', detail: r.error }
    }
    run = r
    r.state = 'recording'
    r.startedMs = now()
    r.recorder.start(options.timesliceMs)
    indicator(true)
    r.maxTimer = setTimer(() => { stop('max-length') }, options.maxMs)
    r.timer = setTimer(() => tick(r), 0)
    await persist(r).catch(() => {})
    report({ id, state: 'started', info: summary(r) })
    return { ok: true, id, mime, file: filePath, sidecar: sidecarPath }
  }

  async function stop(reason = 'requested') {
    const r = run
    if (!r || r.state !== 'recording') return { ok: false, reason: 'not-recording' }
    r.state = 'stopping'; r.stopReason = String(reason).slice(0, 40)
    clearTimer(r.timer); clearTimer(r.maxTimer)
    indicator(false)
    try { r.recorder.state !== 'inactive' && r.recorder.stop() } catch {}
    let giveUp; await Promise.race([r.stopped, new Promise(resolve => { giveUp = setTimer(resolve, 5000) })]); clearTimer(giveUp)
    await r.chain
    try { r.stream.getTracks().forEach(t => t.stop()) } catch {}
    r.endedAt = new Date(now()).toISOString()
    // Check what reached the disk: the file size must equal the sum of the segments.
    try {
      const stat = await IOUtils.stat(r.filePath)
      r.verification = { by: 'recorder', fileBytes: stat.size, segmentBytes: r.totalBytes, sizeMatches: stat.size === r.totalBytes }
      if (!r.verification.sizeMatches && !r.error) r.error = 'file-size-mismatch'
    } catch (error) { r.verification = { by: 'recorder', error: String(error?.message || error).slice(0, 120) }; r.error ||= 'file-unreadable' }
    if (!r.segments.length && !r.error) r.error = 'no-data'
    r.state = r.error ? 'failed' : 'finished'
    await persist(r).catch(() => {})
    const info = summary(r)
    await report({ id: r.id, state: 'stopped', info })
    if (run === r) run = null
    return { ok: !r.error, ...info }
  }

  const status = () => (run ? summary(run) : null)
  const active = () => !!run && (run.state === 'recording' || run.state === 'stopping')
  return { start, stop, status, active }
}
