import { createHash, randomBytes } from 'node:crypto'
import { execFile, spawn as spawnProcess } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { guardBridgeRequest, readJsonBody, sendJson } from './codex-bridge-http.mjs'

// Screen recording v1, bridge side (round d, lane L37; flag EGDESK_SCREEN_RECORDING and all names here are temporary names).
// The window records (overlay/resources/EGDeskScreenRecorder.sys.mjs); this module is the control line and the independent check:
//   POST /v1/recording/start {label?, fps?, scale?, timesliceMs?, maxMs?}  -> waits for the window's "started" report
//   POST /v1/recording/stop                                                -> waits for "stopped", then re-reads the file
//   GET  /v1/recording                                                     -> state + last finished recording
//   POST /v1/recording/report                                              -> the window's own reports (loopback only)
// Two capture sources (body.source):
//   'egdesk-windows' (default; temporary name, round d lane L44): what a person sees of EG-Desk, and nothing else. The bridge starts the Swift tool
//     egdesk-screen-recorder (apps/firefox-ui-demo/helper-native/screen-recorder, ScreenCaptureKit) with the EG-Desk Firefox process id that the window
//     reports. The tool's filter is SCContentFilter(display:including: windows owned by that pid): the Desk window AND that process's own other windows
//     and dialogs (e.g. the software-update window) are in the video, every other app's window is not, even when it is in front of the Desk.
//     The tool follows new/closed windows of that pid (filter refresh every second). The old fixed screen rectangle ('os', ffmpeg avfoundation) is REMOVED:
//     it recorded whatever app was on top of that rectangle (a real incident). Mask: the tool masks boxes it receives on stdin before encoding;
//     the window-side producer of those boxes is not connected yet, so the sidecar says mask 'none' unless a window report 'mask' arrives.
//     Stopped by 'q' on the tool's stdin (SIGINT, then SIGKILL as fallbacks); the recording is a list of MP4 parts (<id>.mp4, <id>.s2.mp4, ...; a part closes on roll every 60 s or after a writer failure, and the next frame opens a new one; sidecar 'segments' has per-part hash, bytes, time range, real error). No Screen Recording permission -> a clear refusal.
//   'window': the Desk window's own drawSnapshot + MediaRecorder (masked, but only the main window; separate windows are not seen).
// Flag off (default): every route answers 404 {status:'off'}. A recording existing is a record, not proof that any work succeeded.
// After a stop the bridge re-reads the .webm itself: every segment's sha256 against the sidecar, the total size, and, when ffprobe is
// installed, the decoded frame count and size (a file that decodes is the "real playback" check). Result goes to status and the sidecar.
export const SCREEN_RECORDING_HTTP = Object.freeze({
  base: '/v1/recording', startAckMs: 10_000, stopAckMs: 20_000, bodyBytes: 16_384, graceMs: 30_000,
  ffprobe: '/opt/homebrew/bin/ffprobe', ffprobeTimeoutMs: 60_000,
})
const START_KEYS = new Set(['label', 'fps', 'scale', 'timesliceMs', 'maxMs', 'source'])
const HERE = path.dirname(fileURLToPath(import.meta.url))
export const WINDOW_CAPTURE = Object.freeze({ recorder: process.env.EGDESK_SCREEN_RECORDER_BIN || path.join(HERE, '..', '.tmp', 'bin', 'egdesk-screen-recorder'), defaultFps: 5, maxFps: 30, minScale: 0.1, maxScale: 2, startupMs: 12000, quitMs: 10000, intMs: 4000 })
export const DEFAULT_SOURCE = 'egdesk-windows'
const LABEL = /^[\p{L}\p{N} ._:/#()+-]{0,120}$/u

const sha = bytes => createHash('sha256').update(bytes).digest('hex')

/** Re-reads a finished recording from disk. Independent of the window's own report. */
export async function verifyRecordingFiles({ dir, id, ffprobe = SCREEN_RECORDING_HTTP.ffprobe, run = execFileJson, readFile = fs.readFile, access = fs.access } = {}) {
  const sidecarPath = path.join(dir, `${id}.json`)
  const result = { by: 'bridge', at: new Date().toISOString(), ok: false }
  let sidecar, bytes
  try { sidecar = JSON.parse(await readFile(sidecarPath, 'utf8')) } catch { return { ...result, error: 'sidecar-unreadable' } }
  // Parts written by the recorder tool (round d L45): each segment is its own MP4 with its own hash, duration and loss record.
  if (Array.isArray(sidecar.segments) && sidecar.segments.length && sidecar.segments.every(x => x && typeof x.file === 'string')) return verifySegmentFiles({ dir, sidecar, result, ffprobe, run, readFile, access })
  const file = path.join(dir, typeof sidecar.file === 'string' ? path.basename(sidecar.file) : `${id}.webm`)
  try { bytes = await readFile(file) } catch { return { ...result, error: 'file-unreadable' } }
  // A window-set capture has no segments (one file written by the recorder tool): size and decode are checked, there are no segment hashes to compare.
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

/** Segment-file recordings: every part that the recorder closed ok must exist, match its hash and decode. Failed parts are listed as lost, not hidden. */
async function verifySegmentFiles({ dir, sidecar, result, ffprobe, run, readFile, access }) {
  let probe = false
  try { await access(ffprobe); probe = true } catch {}
  const parts = []
  let okParts = 0, goodParts = 0, frames = 0, seconds = 0, total = 0
  for (const seg of sidecar.segments) {
    const part = { index: seg.index, file: path.basename(seg.file), recorderOk: seg.ok === true }
    if (seg.ok === true) okParts++
    let bytes = null
    try { bytes = await readFile(path.join(dir, path.basename(seg.file))) } catch { part.missing = true }
    if (bytes) {
      part.bytes = bytes.length; part.sha256 = sha(bytes); total += bytes.length
      part.hashMatches = typeof seg.sha256 === 'string' ? seg.sha256 === part.sha256 : null
      if (probe) {
        try {
          const out = await run(ffprobe, ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,width,height,nb_read_frames:format=duration', '-of', 'json', path.join(dir, path.basename(seg.file))], SCREEN_RECORDING_HTTP.ffprobeTimeoutMs)
          const n = Number(out?.streams?.[0]?.nb_read_frames), d = Number(out?.format?.duration)
          part.decodedFrames = Number.isFinite(n) ? n : null; part.durationSec = Number.isFinite(d) ? d : null
          part.playback = Number.isFinite(n) && n > 0 ? 'decodes' : 'no-frames'
        } catch (error) { part.playback = 'decode-failed'; part.playbackNote = String(error?.message || error).slice(0, 120) }
      }
    }
    if (seg.ok === true && bytes && part.hashMatches !== false && (!probe || part.playback === 'decodes')) goodParts++
    if (part.playback === 'decodes') { frames += part.decodedFrames; seconds += part.durationSec || 0 }
    parts.push(part)
  }
  Object.assign(result, { segmentFiles: parts, segments: parts.length, okSegments: okParts, verifiedSegments: goodParts, lostSegments: parts.length - goodParts, fileBytes: total,
    sizeMatches: total > 0, segmentHashesMatch: parts.every(p => p.missing || p.hashMatches !== false), decodedFrames: probe ? frames : null, durationSec: probe ? seconds : null,
    playback: probe ? (goodParts > 0 ? 'decodes' : 'no-frames') : 'unchecked', ...(probe ? {} : { playbackNote: 'ffprobe-missing' }) })
  result.ok = okParts > 0 && goodParts === okParts && result.segmentHashesMatch
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
export function createScreenRecordingService({ enabled = () => process.env.EGDESK_SCREEN_RECORDING === 'on', broadcast, dataDir, now = Date.now, verify = verifyRecordingFiles, setTimer = setTimeout, clearTimer = clearTimeout, pid = process.pid, port = 39218, startAckMs = SCREEN_RECORDING_HTTP.startAckMs, stopAckMs = SCREEN_RECORDING_HTTP.stopAckMs, spawn = spawnProcess, recorderPath = WINDOW_CAPTURE.recorder, exists = p => fs.access(p).then(() => true, () => false), startupMs = WINDOW_CAPTURE.startupMs, quitMs = WINDOW_CAPTURE.quitMs, intMs = WINDOW_CAPTURE.intMs } = {}) {
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
    const source = body.source ?? DEFAULT_SOURCE
    const rec = { id, label, source, fileName: source === 'window' ? `${id}.webm` : `${id}.mp4`, state: 'starting', requestedAt: new Date(now()).toISOString(), info: null, waiters: {}, verification: null, error: null }
    current = rec
    if (source === DEFAULT_SOURCE) return startWindows(rec, body)
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
  const sidecarOf = (rec, extra = {}) => ({ schema: 'egdesk-screen-recording/1', id: rec.id, label: rec.label, source: 'egdesk-windows-screencapturekit',
    filter: { kind: 'include-windows-of-pid', pid: rec.firefoxPid ?? null, windowCount: rec.windowIds?.length ?? 0, windowIds: rec.windowIds ?? [],
      note: 'only windows owned by this process are in the filter (SCContentFilter display:including:); other apps never reach a frame' },
    mask: rec.maskRevisions?.length ? 'recorder-stdin' : 'none',
    maskNote: rec.maskRevisions?.length ? 'boxes from the window were painted black in the recorder before encoding' : 'no mask: the recorder supports stdin masks but the window-side producer is not connected yet (next job); a sensitive field of EG-Desk itself is visible',
    maskRevision: rec.maskRev ?? 0, maskRevisions: rec.maskRevisions ?? [],
    intervals: (rec.filterLog ?? []).map((e, i, a) => ({ fromMs: e.atMs, toMs: a[i + 1]?.atMs ?? null, windows: e.windows, windowIds: e.windowIds, maskRevision: e.maskRev })),
    owner: { kind: 'bridge-http', label: rec.label }, runtime: { app: 'EG-Desk', bridgePid: pid, firefoxPid: rec.firefoxPid ?? null }, node: { kind: 'egdesk-owned-windows', surface: 'desk' },
    recorder: rec.recorderInfo ?? null, frames: rec.frames ?? null, ...(rec.source === DEFAULT_SOURCE ? segmentRecord(rec) : {}), fps: rec.fps, maxMs: rec.maxMs,
    startedAt: rec.startedAt ?? null, endedAt: null, stopReason: null, file: rec.fileName, state: rec.state, error: rec.error ?? null, verification: null, ...extra })
  /** Parts of the recording: per-part file, hash, bytes, time range and, for a part that failed, the recorder's real error; gaps between parts are named. */
  const segmentRecord = rec => {
    const segs = rec.segments ?? []
    const gaps = []
    for (let i = 1; i < segs.length; i++) { const a = segs[i - 1], b = segs[i]; if (Number.isFinite(a.endMs) && Number.isFinite(b.startMs ?? b.openedAtMs)) gaps.push({ afterIndex: a.index, fromMs: a.endMs, toMs: b.startMs ?? b.openedAtMs, gapMs: (b.startMs ?? b.openedAtMs) - a.endMs }) }
    return { segments: segs, segmentFailures: Math.max(rec.segmentFailures ?? 0, segs.filter(x => x.ok === false).length), segmentGaps: gaps, droppedFrames: rec.droppedFrames ?? null }
  }
  const hashSegments = async rec => { for (const seg of rec.segments ?? []) { try { const bytes = await fs.readFile(path.join(dir, seg.file)); seg.bytes = bytes.length; seg.sha256 = sha(bytes) } catch { seg.missing = true } } }
  const writeSidecar = (rec, extra) => fs.writeFile(path.join(dir, `${rec.id}.json`), JSON.stringify(sidecarOf(rec, extra), null, 1))
  const logFilter = rec => { (rec.filterLog ||= []).push({ atMs: now() - rec.startedMs, windows: rec.windowIds?.length ?? 0, windowIds: rec.windowIds ?? [], maskRev: rec.maskRev ?? 0 }); if (rec.filterLog.length > 200) rec.filterLog.splice(1, 1) }

  /** One JSON line of the recorder's stdout. */
  function onRecorderEvent(rec, e) {
    if (!e || typeof e !== 'object') return
    if (e.event === 'started') { rec.recorderInfo = { video: e.video ?? null, display: e.display ?? null, fps: e.fps ?? null, scale: e.scale ?? null }; rec.windowIds = Array.isArray(e.windowIds) ? e.windowIds : []; logFilter(rec); rec.waiters.recorder?.({ started: true }) }
    else if (e.event === 'windows') { rec.windowIds = Array.isArray(e.windowIds) ? e.windowIds : []; logFilter(rec) }
    else if (e.event === 'segment') { (rec.segments ||= []).push({ index: e.index, file: path.basename(String(e.file || '')), reason: String(e.reason || '').slice(0, 40), width: e.width ?? null, height: e.height ?? null, openedAtMs: e.atMs ?? null, ok: null }); if (rec.segments.length > 600) rec.segments.splice(1, 1) }
    else if (e.event === 'segment-closed') {
      const seg = (rec.segments ||= []).find(x => x.index === e.index) ?? (rec.segments.push({ index: e.index, file: path.basename(String(e.file || '')) }), rec.segments.at(-1))
      Object.assign(seg, { frames: e.frames ?? 0, durationMs: e.durationMs ?? 0, startMs: e.startMs ?? null, endMs: e.endMs ?? null, closeReason: String(e.reason || '').slice(0, 40), ok: e.ok === true })
      if (e.ok !== true) { seg.error = e.error && typeof e.error === 'object' ? { domain: e.error.domain ?? null, code: e.error.code ?? null, localized: String(e.error.localized ?? '').slice(0, 200), chain: Array.isArray(e.error.chain) ? e.error.chain.slice(0, 4) : [] } : { localized: String(e.detail || 'unknown').slice(0, 200) }
        if (Array.isArray(e.recentFrames)) seg.recentFrames = e.recentFrames.slice(-10).map(x => String(x).slice(0, 120)) }
    }
    else if (e.event === 'progress' || e.event === 'stopped') { if (e.event === 'stopped') { rec.segmentFailures = e.segmentFailures ?? 0; rec.droppedFrames = { busy: e.droppedBusy ?? 0, order: e.droppedOrder ?? 0 } } if (Number.isFinite(e.frames)) rec.frames = { count: e.frames, masked: e.maskedFrames ?? 0 } }
    else if (e.event === 'error') { rec.recorderError = String(e.reason || 'recorder-error').slice(0, 60); rec.recorderDetail = String(e.detail || '').slice(0, 300); rec.waiters.recorder?.({ error: rec.recorderError }) }
  }

  async function startWindows(rec, body) {
    const fail = (code, status, reason) => { rec.state = 'failed'; rec.error = reason; last = rec; command(rec, 'indicator', { on: false }); return { code, body: { status, reason, recording: publicOf(rec) } } }
    command(rec, 'locate')
    const where = await waitFor(rec, 'located', startAckMs)
    if (!where) return fail(504, 'no-window-ack', 'no-window-ack')
    if (where.failed) return fail(422, 'refused', where.failed)
    // The process id comes from the Desk window itself (Services.appinfo.processID): never from the request, so no other app can be named.
    const firefoxPid = where.pid
    if (!Number.isInteger(firefoxPid) || firefoxPid <= 1) return fail(422, 'refused', 'no-firefox-pid')
    if (!await exists(recorderPath)) return fail(422, 'refused', 'recorder-unavailable')
    rec.firefoxPid = firefoxPid
    rec.fps = Math.min(WINDOW_CAPTURE.maxFps, Math.max(1, Math.round(Number.isFinite(body.fps) ? body.fps : WINDOW_CAPTURE.defaultFps)))
    const scale = Number.isFinite(body.scale) ? Math.min(WINDOW_CAPTURE.maxScale, Math.max(WINDOW_CAPTURE.minScale, body.scale)) : 1
    rec.maxMs = Math.min(2 * 60 * 60_000, Math.max(1000, Number.isFinite(body.maxMs) ? body.maxMs : 30 * 60_000))
    rec.startedAt = new Date(now()).toISOString(); rec.startedMs = now(); rec.maskRev = 0; rec.maskRevisions = []; rec.filterLog = []
    const file = path.join(dir, rec.fileName)
    try { await fs.mkdir(dir, { recursive: true }); await writeSidecar(rec) } catch { return fail(500, 'failed', 'sidecar-unwritable') }  // owner, runtime, node first
    const args = ['--pid', String(firefoxPid), '--out', file, '--fps', String(rec.fps), '--max-sec', String(Math.ceil(rec.maxMs / 1000)), '--scale', String(scale)]
    let proc
    try { proc = spawn(recorderPath, args, { stdio: ['pipe', 'pipe', 'pipe'] }) } catch { return fail(422, 'refused', 'capture-spawn-failed') }
    rec.proc = proc; rec.stderr = ''; rec.stdoutBuf = ''
    proc.stderr?.on('data', d => { rec.stderr = (rec.stderr + d).slice(-600) })
    proc.stdout?.on('data', d => {
      rec.stdoutBuf += d
      let nl
      while ((nl = rec.stdoutBuf.indexOf('\n')) >= 0) { const line = rec.stdoutBuf.slice(0, nl); rec.stdoutBuf = rec.stdoutBuf.slice(nl + 1); try { onRecorderEvent(rec, JSON.parse(line)) } catch {} }
    })
    proc.stdin?.on('error', () => {})
    rec.exited = new Promise(resolve => proc.once('exit', (code, signal) => { rec.exit = { code, signal }; resolve(rec.exit); rec.waiters.recorder?.({ exited: true }); if (rec.state === 'recording') { rec.stopReason ||= 'recorder-exited'; stopWindows(rec) } }))
    proc.once('error', () => { rec.exit ||= { code: null, signal: 'spawn-error' }; rec.waiters.recorder?.({ exited: true }) })
    const early = await waitFor(rec, 'recorder', startupMs)
    if (!early?.started) {
      if (alive(proc)) { try { proc.kill('SIGKILL') } catch {} }
      const reason = rec.recorderError || (early?.exited ? 'capture-failed' : 'capture-timeout')
      rec.error = reason + (rec.recorderDetail ? ': ' + rec.recorderDetail : rec.stderr ? ': ' + rec.stderr.trim().slice(0, 200) : '')
      await writeSidecar(rec, { state: 'failed', endedAt: new Date(now()).toISOString() }).catch(() => {})
      return fail(422, 'refused', reason)
    }
    rec.state = 'recording'
    command(rec, 'indicator', { on: true })  // the text-free red dot is in the picture, so nothing records unseen
    await writeSidecar(rec).catch(() => {})
    rec.maxTimer = setTimer(() => { if (rec.state === 'recording') { rec.stopReason = 'max-length'; stopWindows(rec) } }, rec.maxMs + SCREEN_RECORDING_HTTP.graceMs)
    return { code: 200, body: { status: 'recording', recording: publicOf(rec) } }
  }

  /** Boxes in display points: [{x, y, width, height}]. Forwarded to the recorder, which paints them black before encoding. */
  function setMask(boxes) {
    const rec = current
    if (!rec || rec.state !== 'recording' || !rec.proc || !alive(rec.proc)) return false
    const n = v => typeof v === 'number' && Number.isFinite(v)
    const list = (Array.isArray(boxes) ? boxes : []).slice(0, 200).filter(b => b && [b.x, b.y, b.width, b.height].every(n)).map(b => ({ x: b.x, y: b.y, w: b.width, h: b.height }))
    rec.maskRev = (rec.maskRev ?? 0) + 1
    rec.maskRevisions.push({ revision: rec.maskRev, atMs: now() - rec.startedMs, boxes: list.length }); if (rec.maskRevisions.length > 200) rec.maskRevisions.splice(1, 1)
    try { rec.proc.stdin.write(JSON.stringify({ mask: list, rev: rec.maskRev }) + '\n') } catch { return false }
    return true
  }

  async function stopWindows(rec, reason) {
    if (rec.state === 'stopping' && rec.stopping) return rec.stopping
    rec.state = 'stopping'; rec.stopReason ||= reason || 'requested'
    rec.stopping = (async () => {
      clearTimer(rec.maxTimer)
      const waitExit = ms => Promise.race([rec.exited, new Promise(resolve => setTimer(() => resolve(null), ms))])
      if (alive(rec.proc)) { try { rec.proc.stdin.write('q\n') } catch {} }
      if (!await waitExit(quitMs) && alive(rec.proc)) { try { rec.proc.kill('SIGINT') } catch {} }
      if (!await waitExit(intMs) && alive(rec.proc)) { try { rec.proc.kill('SIGKILL') } catch {}; rec.error ||= 'recorder-killed'; await waitExit(2000) }
      command(rec, 'indicator', { on: false })
      await hashSegments(rec)
      if (!(rec.exit && rec.exit.code === 0)) rec.error ||= rec.recorderError || `recorder-exit-${rec.exit?.code ?? rec.exit?.signal ?? 'unknown'}`
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
    if (rec.source === DEFAULT_SOURCE && !rec.proc) return { code: 409, body: { status: 'busy', reason: 'starting', recording: publicOf(rec) } }
    if (rec.source === DEFAULT_SOURCE) { await stopWindows(rec); return { code: 200, body: { status: rec.state, recording: publicOf(rec) } } }
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
    if (body.state === 'located') { rec.waiters.located?.({ geometry: body.geometry, pid: body.pid }); return true }
    if (body.state === 'mask') return setMask(body.boxes)
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
    if (body.source !== undefined && ![DEFAULT_SOURCE, 'window'].includes(body.source)) return reply(400, { status: 'invalid', reason: 'source' })
    if (body.label !== undefined && (typeof body.label !== 'string' || !LABEL.test(body.label))) return reply(400, { status: 'invalid', reason: 'label' })
    for (const key of ['fps', 'scale', 'timesliceMs', 'maxMs']) if (body[key] !== undefined && !(typeof body[key] === 'number' && Number.isFinite(body[key]))) return reply(400, { status: 'invalid', reason: key })
    const r = await start(body)
    return reply(r.code, r.body)
  }
  /** The bridge is closing: a recording in progress is told to stop and finish its file (no hand-over contract exists). */
  function closing() {
    if (!current || !['starting', 'recording'].includes(current.state)) return
    if (current.source === DEFAULT_SOURCE) { stopWindows(current, 'bridge-closing'); return }
    command(current, 'stop', { reason: 'bridge-closing' })
  }
  return { start, stop, report, snapshot, handle, closing, setMask }
}
