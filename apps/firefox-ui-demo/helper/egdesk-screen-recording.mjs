import { createHash, randomBytes } from 'node:crypto'
import { execFile, spawn as spawnProcess } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { guardBridgeRequest, readJsonBody, sendJson } from './codex-bridge-http.mjs'

// Screen recording v1, bridge side (round d, lane L37; flag EGDESK_SCREEN_RECORDING and all names here are temporary names).
// The window records (overlay/resources/EGDeskScreenRecorder.sys.mjs); this module is the control line and the independent check:
//   POST /v1/recording/start {label?, fps?, scale?, timesliceMs?, maxMs?}  -> waits for the window's "started" report
//   POST /v1/recording/stop                                                -> waits for "stopped", then re-reads the file
//   GET  /v1/recording                                                     -> state + last finished recording
//   POST /v1/recording/report                                              -> the window's own reports (loopback only)
// Two capture sources (body.source):
//   'os' (default): what a person sees. The bridge starts ffmpeg (avfoundation, macOS) on the Desk window's screen rectangle, taken from the window at
//     the start, so separate windows, dialogs and popups above it are in the video. QA/development path: there is NO mask (the contract's
//     capture -> mask -> encode order cannot be kept by an OS screen grab), the sidecar says so, and the product path is ScreenCaptureKit with masking.
//     The rectangle is fixed at start; a window that moves or resizes is not followed. Only the main display is captured.
//     Stopped by 'q' on ffmpeg's stdin (SIGINT, then SIGKILL as fallbacks); the file is fragmented MP4, so a crash still leaves a playable file.
//     (macOS screencapture -v was tried first: SIGINT/SIGTERM/SIGHUP kill it without writing a file, only its own -V timeout finalizes.)
//   'window': the Desk window's own drawSnapshot + MediaRecorder (masked, but only the main window; separate windows are not seen).
// Flag off (default): every route answers 404 {status:'off'}. A recording existing is a record, not proof that any work succeeded.
// After a stop the bridge re-reads the .webm itself: every segment's sha256 against the sidecar, the total size, and, when ffprobe is
// installed, the decoded frame count and size (a file that decodes is the "real playback" check). Result goes to status and the sidecar.
export const SCREEN_RECORDING_HTTP = Object.freeze({
  base: '/v1/recording', startAckMs: 10_000, stopAckMs: 20_000, bodyBytes: 16_384, graceMs: 30_000,
  ffprobe: '/opt/homebrew/bin/ffprobe', ffprobeTimeoutMs: 60_000,
})
const START_KEYS = new Set(['label', 'fps', 'scale', 'timesliceMs', 'maxMs', 'source'])
export const OS_CAPTURE = Object.freeze({ ffmpeg: '/opt/homebrew/bin/ffmpeg', defaultFps: 10, maxFps: 30, maxWidth: 1280, startupMs: 1500, quitMs: 8000, intMs: 4000 })
const LABEL = /^[\p{L}\p{N} ._:/#()+-]{0,120}$/u

const sha = bytes => createHash('sha256').update(bytes).digest('hex')

/** Re-reads a finished recording from disk. Independent of the window's own report. */
export async function verifyRecordingFiles({ dir, id, ffprobe = SCREEN_RECORDING_HTTP.ffprobe, run = execFileJson, readFile = fs.readFile, access = fs.access } = {}) {
  const sidecarPath = path.join(dir, `${id}.json`)
  const result = { by: 'bridge', at: new Date().toISOString(), ok: false }
  let sidecar, bytes
  try { sidecar = JSON.parse(await readFile(sidecarPath, 'utf8')) } catch { return { ...result, error: 'sidecar-unreadable' } }
  const file = path.join(dir, typeof sidecar.file === 'string' ? path.basename(sidecar.file) : `${id}.webm`)
  try { bytes = await readFile(file) } catch { return { ...result, error: 'file-unreadable' } }
  // An OS capture has no segments (one file written by ffmpeg): size and decode are checked, there are no segment hashes to compare.
  const wholeFile = !Array.isArray(sidecar.segments)
  const segments = wholeFile ? [] : sidecar.segments
  let expected = 0, hashesMatch = true
  for (const segment of segments) {
    if (segment.offset !== expected) hashesMatch = false
    const slice = bytes.subarray(segment.offset, segment.offset + segment.bytes)
    if (slice.length !== segment.bytes || sha(slice) !== segment.sha256) hashesMatch = false
    expected += segment.bytes
  }
  Object.assign(result, { fileBytes: bytes.length, segments: segments.length, sizeMatches: wholeFile ? bytes.length > 0 : bytes.length === expected && expected === sidecar.totalBytes,
    segmentHashesMatch: wholeFile ? true : hashesMatch && segments.length > 0, fileSha256: sha(bytes), ...(wholeFile ? { wholeFile: true } : {}) })
  let probe = null
  try { await access(ffprobe); probe = true } catch { probe = false }
  if (!probe) Object.assign(result, { playback: 'unchecked', playbackNote: 'ffprobe-missing' })
  else {
    try {
      const out = await run(ffprobe, ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,width,height,nb_read_frames:format=duration', '-of', 'json', file], SCREEN_RECORDING_HTTP.ffprobeTimeoutMs)
      const stream = out?.streams?.[0] || {}
      const frames = Number(stream.nb_read_frames)
      const duration = Number(out?.format?.duration)
      Object.assign(result, { codec: stream.codec_name ?? null, width: stream.width ?? null, height: stream.height ?? null,
        decodedFrames: Number.isFinite(frames) ? frames : null, durationSec: Number.isFinite(duration) ? duration : null,
        playback: Number.isFinite(frames) && frames > 0 ? 'decodes' : 'no-frames' })
    } catch (error) { Object.assign(result, { playback: 'decode-failed', playbackNote: String(error?.message || error).slice(0, 160) }) }
  }
  result.ok = result.sizeMatches && result.segmentHashesMatch && result.playback !== 'no-frames' && result.playback !== 'decode-failed'
  return result
}

/**
 * The Desk window's rectangle on the main display as an ffmpeg crop (device pixels, even numbers), from the window's report:
 * { screenX, screenY, outerWidth, outerHeight, dpr, screen: { left, top, width, height } } in points. { error } when it cannot be trusted.
 */
export function osCaptureRegion(g, { maxWidth = OS_CAPTURE.maxWidth } = {}) {
  const n = v => typeof v === 'number' && Number.isFinite(v)
  if (!g || ![g.screenX, g.screenY, g.outerWidth, g.outerHeight, g.dpr].every(n) || !g.screen || ![g.screen.left, g.screen.top, g.screen.width, g.screen.height].every(n)) return { error: 'geometry-invalid' }
  if (g.dpr < 1 || g.dpr > 4 || g.outerWidth < 100 || g.outerHeight < 100) return { error: 'geometry-invalid' }
  if (g.screen.left !== 0 || g.screen.top !== 0) return { error: 'not-main-display' }
  const x0 = Math.max(0, g.screenX), y0 = Math.max(0, g.screenY)
  const x1 = Math.min(g.screen.width, g.screenX + g.outerWidth), y1 = Math.min(g.screen.height, g.screenY + g.outerHeight)
  if (x1 - x0 < 100 || y1 - y0 < 100) return { error: 'window-off-screen' }
  const even = v => Math.max(2, Math.floor(v / 2) * 2)
  const pixels = { x: even(x0 * g.dpr), y: even(y0 * g.dpr), width: even((x1 - x0) * g.dpr), height: even((y1 - y0) * g.dpr) }
  return { points: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }, pixels, outWidth: even(Math.min(maxWidth, pixels.width)), dpr: g.dpr }
}

function execFileJson(bin, args, timeout) {
  return new Promise((resolve, reject) => execFile(bin, args, { timeout, maxBuffer: 1 << 20 }, (error, stdout) => {
    if (error) return reject(error)
    try { resolve(JSON.parse(stdout)) } catch { reject(new Error('ffprobe-output-invalid')) }
  }))
}

/**
 * createScreenRecordingService({ enabled, broadcast, dataDir, now?, verify?, setTimer?, clearTimer?, pid? })
 * -> { start(options), stop(), report(body), snapshot(), handle(req, res, url) }
 */
export function createScreenRecordingService({ enabled = () => process.env.EGDESK_SCREEN_RECORDING === 'on', broadcast, dataDir, now = Date.now, verify = verifyRecordingFiles, setTimer = setTimeout, clearTimer = clearTimeout, pid = process.pid, port = 39218, startAckMs = SCREEN_RECORDING_HTTP.startAckMs, stopAckMs = SCREEN_RECORDING_HTTP.stopAckMs, spawn = spawnProcess, ffmpegPath = OS_CAPTURE.ffmpeg, exists = p => fs.access(p).then(() => true, () => false), startupMs = OS_CAPTURE.startupMs, quitMs = OS_CAPTURE.quitMs, intMs = OS_CAPTURE.intMs } = {}) {
  if (typeof broadcast !== 'function' || !dataDir) throw new TypeError('broadcast and dataDir are required')
  const dir = path.join(dataDir, 'recordings')
  let current = null   // { id, label, state, requestedAt, info, waiters, maxTimer }
  let last = null
  const isOn = () => { try { return enabled() === true } catch { return false } }
  const waitFor = (rec, key, ms) => new Promise(resolve => {
    const timer = setTimer(() => { rec.waiters[key] = null; resolve(null) }, ms)
    rec.waiters[key] = value => { clearTimer(timer); rec.waiters[key] = null; resolve(value) }
  })
  const publicOf = rec => rec && ({ id: rec.id, label: rec.label, state: rec.state, requestedAt: rec.requestedAt, file: path.join(dir, rec.fileName || `${rec.id}.webm`), source: rec.source, sidecar: path.join(dir, `${rec.id}.json`),
    ...(rec.info ? { window: rec.info } : {}), ...(rec.verification ? { verification: rec.verification } : {}), ...(rec.error ? { error: rec.error } : {}) })
  const command = (rec, name, extra = {}) => broadcast({ type: 'recording.command', v: 1, provider: 'codex', command: name, id: rec.id, ts: now(), ...extra })

  async function start(body = {}) {
    if (current && ['starting', 'recording', 'stopping'].includes(current.state)) return { code: 409, body: { status: 'busy', recording: publicOf(current) } }
    const id = `rec-${new Date(now()).toISOString().replace(/[-:T]/g, '').slice(0, 14)}-${randomBytes(3).toString('hex')}`
    const label = typeof body.label === 'string' ? body.label : ''
    const source = body.source ?? 'os'
    const rec = { id, label, source, fileName: source === 'os' ? `${id}.mp4` : `${id}.webm`, state: 'starting', requestedAt: new Date(now()).toISOString(), info: null, waiters: {}, verification: null, error: null }
    current = rec
    if (source === 'os') return startOs(rec, body)
    const options = {}
    for (const key of ['fps', 'scale', 'timesliceMs', 'maxMs']) if (body[key] !== undefined) options[key] = body[key]
    command(rec, 'start', { label, dir, owner: { kind: 'bridge-http', label }, bridgePid: pid, ...options })
    const ack = await waitFor(rec, 'started', startAckMs)
    if (!ack) { rec.state = 'failed'; rec.error = 'no-window-ack'; last = rec; command(rec, 'stop', { reason: 'start-timeout' }); return { code: 504, body: { status: 'no-window-ack', recording: publicOf(rec) } } }
    if (ack.state === 'failed') { rec.state = 'failed'; rec.error = ack.reason; last = rec; return { code: 422, body: { status: 'refused', reason: ack.reason, recording: publicOf(rec) } } }
    // Safety net behind the window's own maxMs: if the window never stops, ask once more.
    const maxMs = Number(options.maxMs) > 0 ? Number(options.maxMs) : 30 * 60_000
    rec.maxTimer = setTimer(() => { if (rec.state === 'recording') command(rec, 'stop', { reason: 'bridge-max-length' }) }, maxMs + SCREEN_RECORDING_HTTP.graceMs)
    return { code: 200, body: { status: 'recording', recording: publicOf(rec) } }
  }

  const alive = proc => proc.exitCode === null && proc.signalCode === null
  const sidecarOf = (rec, extra = {}) => ({ schema: 'egdesk-screen-recording/1', id: rec.id, label: rec.label, source: 'os-ffmpeg-avfoundation', mask: 'none',
    maskNote: 'no mask: an OS screen capture cannot be masked before encoding; QA/development path only', owner: { kind: 'bridge-http', label: rec.label },
    runtime: { app: 'EG-Desk', bridgePid: pid, window: rec.geometry ?? null }, node: { kind: 'egdesk-window-region', surface: 'desk' },
    region: rec.region ?? null, regionNote: 'fixed at start; a window that moves or resizes is not followed; main display only', fps: rec.fps, maxMs: rec.maxMs,
    startedAt: rec.startedAt ?? null, endedAt: null, stopReason: null, file: rec.fileName, state: rec.state, error: rec.error ?? null, verification: null, ...extra })
  const writeSidecar = (rec, extra) => fs.writeFile(path.join(dir, `${rec.id}.json`), JSON.stringify(sidecarOf(rec, extra), null, 1))

  async function startOs(rec, body) {
    const fail = (code, status, reason) => { rec.state = 'failed'; rec.error = reason; last = rec; command(rec, 'indicator', { on: false }); return { code, body: { status, reason, recording: publicOf(rec) } } }
    command(rec, 'locate')
    const where = await waitFor(rec, 'located', startAckMs)
    if (!where) return fail(504, 'no-window-ack', 'no-window-ack')
    if (where.failed) return fail(422, 'refused', where.failed)
    const region = osCaptureRegion(where.geometry)
    if (region.error) return fail(422, 'refused', region.error)
    if (!await exists(ffmpegPath)) return fail(422, 'refused', 'encoder-unavailable')
    rec.geometry = where.geometry; rec.region = region
    rec.fps = Math.min(OS_CAPTURE.maxFps, Math.max(1, Number.isFinite(body.fps) ? body.fps : OS_CAPTURE.defaultFps))
    rec.maxMs = Math.min(2 * 60 * 60_000, Math.max(1000, Number.isFinite(body.maxMs) ? body.maxMs : 30 * 60_000))
    rec.startedAt = new Date(now()).toISOString()
    const file = path.join(dir, rec.fileName)
    try { await fs.mkdir(dir, { recursive: true }); await writeSidecar(rec) } catch { return fail(500, 'failed', 'sidecar-unwritable') }  // owner, runtime, node first
    const px = region.pixels
    const args = ['-hide_banner', '-loglevel', 'error', '-f', 'avfoundation', '-framerate', String(rec.fps), '-capture_cursor', '1', '-i', '2:none',
      '-vf', `crop=${px.width}:${px.height}:${px.x}:${px.y},scale=${region.outWidth}:-2`, '-c:v', 'h264_videotoolbox', '-b:v', '3M', '-t', String(Math.ceil(rec.maxMs / 1000)),
      '-movflags', '+frag_keyframe+empty_moov', '-y', file]
    let proc
    try { proc = spawn(ffmpegPath, args, { stdio: ['pipe', 'ignore', 'pipe'] }) } catch { return fail(422, 'refused', 'capture-spawn-failed') }
    rec.proc = proc; rec.stderr = ''
    proc.stderr?.on('data', d => { rec.stderr = (rec.stderr + d).slice(-600) })
    proc.stdin?.on('error', () => {})
    rec.exited = new Promise(resolve => proc.once('exit', (code, signal) => { rec.exit = { code, signal }; resolve(rec.exit); if (rec.state === 'recording') { rec.stopReason ||= 'encoder-exited'; stopOs(rec) } }))
    proc.once('error', () => { rec.exit ||= { code: null, signal: 'spawn-error' } })
    const early = await Promise.race([rec.exited, new Promise(resolve => setTimer(() => resolve(null), startupMs))])
    if (early) { rec.error = 'capture-failed: ' + rec.stderr.replace(/objc\[[^\n]*\n?/g, '').trim().slice(0, 200); return fail(422, 'refused', 'capture-failed') }
    rec.state = 'recording'
    command(rec, 'indicator', { on: true })  // the text-free red dot is in the picture, so nothing records unseen
    await writeSidecar(rec).catch(() => {})
    rec.maxTimer = setTimer(() => { if (rec.state === 'recording') { rec.stopReason = 'max-length'; stopOs(rec) } }, rec.maxMs + SCREEN_RECORDING_HTTP.graceMs)
    return { code: 200, body: { status: 'recording', recording: publicOf(rec) } }
  }

  async function stopOs(rec, reason) {
    if (rec.state === 'stopping' && rec.stopping) return rec.stopping
    rec.state = 'stopping'; rec.stopReason ||= reason || 'requested'
    rec.stopping = (async () => {
      clearTimer(rec.maxTimer)
      const waitExit = ms => Promise.race([rec.exited, new Promise(resolve => setTimer(() => resolve(null), ms))])
      if (alive(rec.proc)) { try { rec.proc.stdin.write('q') } catch {} }
      if (!await waitExit(quitMs) && alive(rec.proc)) { try { rec.proc.kill('SIGINT') } catch {} }
      if (!await waitExit(intMs) && alive(rec.proc)) { try { rec.proc.kill('SIGKILL') } catch {}; rec.error ||= 'encoder-killed'; await waitExit(2000) }
      command(rec, 'indicator', { on: false })
      const clean = rec.exit && (rec.exit.code === 0 || rec.exit.code === 255 || rec.exit.signal === 'SIGINT')
      if (!clean) rec.error ||= `encoder-exit-${rec.exit?.code ?? rec.exit?.signal ?? 'unknown'}`
      await writeSidecar(rec, { endedAt: new Date(now()).toISOString(), stopReason: rec.stopReason, state: rec.error ? 'failed' : 'finished', error: rec.error ?? null }).catch(() => {})
      await finish(rec, { state: rec.error ? 'failed' : 'finished', error: rec.error ?? null })
    })()
    return rec.stopping
  }

  async function finish(rec, info) {
    rec.info = info
    clearTimer(rec.maxTimer)
    rec.state = info?.state === 'finished' || info?.error == null ? 'finished' : 'failed'
    if (info?.error) { rec.state = 'failed'; rec.error = info.error }
    rec.verification = await verify({ dir, id: rec.id }).catch(error => ({ by: 'bridge', ok: false, error: String(error?.message || error).slice(0, 160) }))
    // Keep the check next to the sidecar so the file explains itself later.
    try {
      const sidecarPath = path.join(dir, `${rec.id}.json`)
      const sidecar = JSON.parse(await fs.readFile(sidecarPath, 'utf8'))
      await fs.writeFile(sidecarPath, JSON.stringify({ ...sidecar, verification: { recorder: sidecar.verification ?? null, bridge: rec.verification } }, null, 1))
    } catch {}
    if (rec.verification && rec.verification.ok === false && rec.state === 'finished') rec.state = 'failed', rec.error ||= `verify-${rec.verification.error || 'mismatch'}`
    last = rec
  }

  async function stop() {
    const rec = current
    if (!rec || !['recording', 'starting'].includes(rec.state)) return { code: 409, body: { status: 'not-recording', last: publicOf(last) } }
    if (rec.source === 'os' && !rec.proc) return { code: 409, body: { status: 'busy', reason: 'starting', recording: publicOf(rec) } }
    if (rec.source === 'os') { await stopOs(rec); return { code: 200, body: { status: rec.state, recording: publicOf(rec) } } }
    rec.state = 'stopping'
    const wait = waitFor(rec, 'stopped', stopAckMs)
    command(rec, 'stop', { reason: 'requested' })
    const ack = await wait
    if (!ack) { rec.state = 'failed'; rec.error = 'no-stop-ack'; last = rec; return { code: 504, body: { status: 'no-stop-ack', recording: publicOf(rec) } } }
    await finish(rec, ack.info)
    return { code: 200, body: { status: rec.state, recording: publicOf(rec) } }
  }

  /** The window's report. A stop the window made by itself (max length, app closing) is finished here too. */
  async function report(body) {
    const rec = current
    if (!rec || !body || typeof body !== 'object' || body.id !== rec.id) return false
    if (body.state === 'started') { rec.state = 'recording'; rec.info = body.info ?? null; rec.waiters.started?.({ state: 'started' }); return true }
    if (body.state === 'located') { rec.waiters.located?.({ geometry: body.geometry }); return true }
    if (body.state === 'failed') { const reason = String(body.reason || 'failed').slice(0, 60); rec.waiters.started?.({ state: 'failed', reason }); rec.waiters.located?.({ failed: reason }); return true }
    if (body.state === 'stopped') {
      if (rec.waiters.stopped) rec.waiters.stopped({ info: body.info })
      else if (rec.state === 'recording') { rec.state = 'stopping'; await finish(rec, body.info) }
      return true
    }
    return false
  }

  const snapshot = () => ({ status: current && ['starting', 'recording', 'stopping'].includes(current.state) ? current.state : 'idle', recording: publicOf(current && ['starting', 'recording', 'stopping'].includes(current.state) ? current : null), last: publicOf(last), dir })

  async function handle(req, res, url) {
    if (url.pathname !== SCREEN_RECORDING_HTTP.base && !url.pathname.startsWith(`${SCREEN_RECORDING_HTTP.base}/`)) return false
    const reply = (code, body) => { if (!res.destroyed && !res.writableEnded) sendJson(res, code, body); return true }
    if (!isOn()) return reply(404, { status: 'off' })
    if (!guardBridgeRequest(req, port)) return reply(403, { status: 'refused', reason: 'loopback-required' })
    const sub = url.pathname.slice(SCREEN_RECORDING_HTTP.base.length)
    if (sub === '' || sub === '/') {
      if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return reply(405, { status: 'refused', reason: 'get-required' }) }
      return reply(200, snapshot())
    }
    if (!['/start', '/stop', '/report'].includes(sub)) return reply(404, { status: 'unknown' })
    if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return reply(405, { status: 'refused', reason: 'post-required' }) }
    let body = {}
    if (sub !== '/stop') {
      if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) return reply(415, { status: 'refused', reason: 'json-required' })
      try { body = await readJsonBody(req, { maxBytes: SCREEN_RECORDING_HTTP.bodyBytes }) } catch { return reply(400, { status: 'invalid' }) }
    }
    if (sub === '/report') return reply(await report(body) ? 200 : 409, { status: 'ok' })
    if (sub === '/stop') { const r = await stop(); return reply(r.code, r.body) }
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(k => !START_KEYS.has(k))) return reply(400, { status: 'invalid', reason: 'unknown-field' })
    if (body.source !== undefined && !['os', 'window'].includes(body.source)) return reply(400, { status: 'invalid', reason: 'source' })
    if (body.label !== undefined && (typeof body.label !== 'string' || !LABEL.test(body.label))) return reply(400, { status: 'invalid', reason: 'label' })
    for (const key of ['fps', 'scale', 'timesliceMs', 'maxMs']) if (body[key] !== undefined && !(typeof body[key] === 'number' && Number.isFinite(body[key]))) return reply(400, { status: 'invalid', reason: key })
    const r = await start(body)
    return reply(r.code, r.body)
  }
  /** The bridge is closing: a recording in progress is told to stop and finish its file (no hand-over contract exists). */
  function closing() {
    if (!current || !['starting', 'recording'].includes(current.state)) return
    if (current.source === 'os') { stopOs(current, 'bridge-closing'); return }
    command(current, 'stop', { reason: 'bridge-closing' })
  }
  return { start, stop, report, snapshot, handle, closing }
}
