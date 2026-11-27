import { createHash, randomBytes } from 'node:crypto'
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { guardBridgeRequest, readJsonBody, sendJson } from './codex-bridge-http.mjs'

// Screen recording v1, bridge side (round d, lane L37; flag EGDESK_SCREEN_RECORDING and all names here are temporary names).
// The window records (overlay/resources/EGDeskScreenRecorder.sys.mjs); this module is the control line and the independent check:
//   POST /v1/recording/start {label?, fps?, scale?, timesliceMs?, maxMs?}  -> waits for the window's "started" report
//   POST /v1/recording/stop                                                -> waits for "stopped", then re-reads the file
//   GET  /v1/recording                                                     -> state + last finished recording
//   POST /v1/recording/report                                              -> the window's own reports (loopback only)
// Flag off (default): every route answers 404 {status:'off'}. A recording existing is a record, not proof that any work succeeded.
// After a stop the bridge re-reads the .webm itself: every segment's sha256 against the sidecar, the total size, and, when ffprobe is
// installed, the decoded frame count and size (a file that decodes is the "real playback" check). Result goes to status and the sidecar.
export const SCREEN_RECORDING_HTTP = Object.freeze({
  base: '/v1/recording', startAckMs: 10_000, stopAckMs: 20_000, bodyBytes: 16_384, graceMs: 30_000,
  ffprobe: '/opt/homebrew/bin/ffprobe', ffprobeTimeoutMs: 60_000,
})
const START_KEYS = new Set(['label', 'fps', 'scale', 'timesliceMs', 'maxMs'])
const LABEL = /^[\p{L}\p{N} ._:/#()+-]{0,120}$/u

const sha = bytes => createHash('sha256').update(bytes).digest('hex')

/** Re-reads a finished recording from disk. Independent of the window's own report. */
export async function verifyRecordingFiles({ dir, id, ffprobe = SCREEN_RECORDING_HTTP.ffprobe, run = execFileJson, readFile = fs.readFile, access = fs.access } = {}) {
  const file = path.join(dir, `${id}.webm`), sidecarPath = path.join(dir, `${id}.json`)
  const result = { by: 'bridge', at: new Date().toISOString(), ok: false }
  let sidecar, bytes
  try { sidecar = JSON.parse(await readFile(sidecarPath, 'utf8')) } catch { return { ...result, error: 'sidecar-unreadable' } }
  try { bytes = await readFile(file) } catch { return { ...result, error: 'file-unreadable' } }
  const segments = Array.isArray(sidecar.segments) ? sidecar.segments : []
  let expected = 0, hashesMatch = true
  for (const segment of segments) {
    if (segment.offset !== expected) hashesMatch = false
    const slice = bytes.subarray(segment.offset, segment.offset + segment.bytes)
    if (slice.length !== segment.bytes || sha(slice) !== segment.sha256) hashesMatch = false
    expected += segment.bytes
  }
  Object.assign(result, { fileBytes: bytes.length, segments: segments.length, sizeMatches: bytes.length === expected && expected === sidecar.totalBytes,
    segmentHashesMatch: hashesMatch && segments.length > 0, fileSha256: sha(bytes) })
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
export function createScreenRecordingService({ enabled = () => false, broadcast, dataDir, now = Date.now, verify = verifyRecordingFiles, setTimer = setTimeout, clearTimer = clearTimeout, pid = process.pid, port = 39218, startAckMs = SCREEN_RECORDING_HTTP.startAckMs, stopAckMs = SCREEN_RECORDING_HTTP.stopAckMs } = {}) {
  if (typeof broadcast !== 'function' || !dataDir) throw new TypeError('broadcast and dataDir are required')
  const dir = path.join(dataDir, 'recordings')
  let current = null   // { id, label, state, requestedAt, info, waiters, maxTimer }
  let last = null
  const isOn = () => { try { return enabled() === true } catch { return false } }
  const waitFor = (rec, key, ms) => new Promise(resolve => {
    const timer = setTimer(() => { rec.waiters[key] = null; resolve(null) }, ms)
    rec.waiters[key] = value => { clearTimer(timer); rec.waiters[key] = null; resolve(value) }
  })
  const publicOf = rec => rec && ({ id: rec.id, label: rec.label, state: rec.state, requestedAt: rec.requestedAt, file: path.join(dir, `${rec.id}.webm`), sidecar: path.join(dir, `${rec.id}.json`),
    ...(rec.info ? { window: rec.info } : {}), ...(rec.verification ? { verification: rec.verification } : {}), ...(rec.error ? { error: rec.error } : {}) })
  const command = (rec, name, extra = {}) => broadcast({ type: 'recording.command', v: 1, provider: 'codex', command: name, id: rec.id, ts: now(), ...extra })

  async function start(body = {}) {
    if (current && ['starting', 'recording', 'stopping'].includes(current.state)) return { code: 409, body: { status: 'busy', recording: publicOf(current) } }
    const id = `rec-${new Date(now()).toISOString().replace(/[-:T]/g, '').slice(0, 14)}-${randomBytes(3).toString('hex')}`
    const label = typeof body.label === 'string' ? body.label : ''
    const rec = { id, label, state: 'starting', requestedAt: new Date(now()).toISOString(), info: null, waiters: {}, verification: null, error: null }
    current = rec
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
    if (body.state === 'failed') { rec.waiters.started?.({ state: 'failed', reason: String(body.reason || 'failed').slice(0, 60) }); return true }
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
    if (body.label !== undefined && (typeof body.label !== 'string' || !LABEL.test(body.label))) return reply(400, { status: 'invalid', reason: 'label' })
    for (const key of ['fps', 'scale', 'timesliceMs', 'maxMs']) if (body[key] !== undefined && !(typeof body[key] === 'number' && Number.isFinite(body[key]))) return reply(400, { status: 'invalid', reason: key })
    const r = await start(body)
    return reply(r.code, r.body)
  }
  /** The bridge is closing: a recording in progress is told to stop and finish its file (no hand-over contract exists). */
  function closing() { if (current && ['starting', 'recording'].includes(current.state)) command(current, 'stop', { reason: 'bridge-closing' }) }
  return { start, stop, report, snapshot, handle, closing }
}
