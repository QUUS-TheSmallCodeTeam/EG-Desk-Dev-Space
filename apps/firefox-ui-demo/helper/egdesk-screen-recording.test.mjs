import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { EventEmitter } from 'node:events'
import { createScreenRecordingService, verifyRecordingFiles, DEFAULT_SOURCE } from './egdesk-screen-recording.mjs'

// Screen recording v1 bridge side (L37): flag gate, control line with a fake window, and the independent file check.
const FFMPEG = '/opt/homebrew/bin/ffmpeg', FFPROBE = '/opt/homebrew/bin/ffprobe'
const sha = b => createHash('sha256').update(b).digest('hex')
function call(service, method, url, body) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
  Object.assign(req, { method, url, headers: { host: '127.0.0.1:39218', ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, socket: { remoteAddress: '127.0.0.1' } })
  const res = { headers: {}, setHeader(k, v) { this.headers[k] = v }, writeHead(s, h) { this.status = s; Object.assign(this.headers, h) }, end(t) { this.body = t ? JSON.parse(t) : null; this.writableEnded = true } }
  return service.handle(req, res, new URL(url, 'http://127.0.0.1:39218')).then(handled => ({ handled, status: res.status, body: res.body }))
}
function fixture(t, { on = true, window = 'ok', verify } = {}) {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'egd-rec-'))
  t.after(() => rmSync(dataDir, { recursive: true, force: true }))
  const commands = []
  let service
  const broadcast = event => {
    commands.push(event)
    if (window === 'none') return
    queueMicrotask(async () => {
      const dir = path.join(dataDir, 'recordings')
      if (event.command === 'start') {
        if (window === 'refuse') return void service.report({ id: event.id, state: 'failed', reason: 'encoder-unsupported' })
        mkdirSync(dir, { recursive: true })
        const bytes = Buffer.from('webm-bytes')
        writeFileSync(path.join(dir, `${event.id}.webm`), bytes)
        writeFileSync(path.join(dir, `${event.id}.json`), JSON.stringify({ id: event.id, totalBytes: bytes.length, segments: [{ index: 0, offset: 0, bytes: bytes.length, sha256: sha(bytes) }] }))
        service.report({ id: event.id, state: 'started', info: { state: 'recording' } })
      } else if (event.command === 'stop') service.report({ id: event.id, state: 'stopped', info: { state: 'finished', error: null, totalBytes: 10 } })
    })
  }
  service = createScreenRecordingService({ enabled: () => on, broadcast, dataDir, startAckMs: 200, stopAckMs: 200, verify })
  return { service, commands, dataDir }
}

test('the flag defaults to off in the module itself', async t => {
  const keep = process.env.EGDESK_SCREEN_RECORDING
  t.after(() => { if (keep === undefined) delete process.env.EGDESK_SCREEN_RECORDING; else process.env.EGDESK_SCREEN_RECORDING = keep })
  delete process.env.EGDESK_SCREEN_RECORDING
  const service = createScreenRecordingService({ broadcast() {}, dataDir: '/tmp/x' })
  assert.equal((await call(service, 'GET', '/v1/recording')).status, 404)
  process.env.EGDESK_SCREEN_RECORDING = 'on'
  assert.equal((await call(service, 'GET', '/v1/recording')).status, 200)
})

test('flag off: every route is refused with 404 and nothing is sent to the window', async t => {
  const f = fixture(t, { on: false })
  for (const [m, u] of [['GET', '/v1/recording'], ['POST', '/v1/recording/start'], ['POST', '/v1/recording/stop']]) assert.equal((await call(f.service, m, u, m === 'POST' ? {} : undefined)).status, 404)
  assert.equal(f.commands.length, 0)
  assert.equal((await call(f.service, 'GET', '/other')).handled, false)
})

test('start -> status -> stop: the window is commanded, the file is re-read by the bridge, and the result is reported', async t => {
  const f = fixture(t, { verify: async () => ({ by: 'bridge', ok: true }) })
  const start = await call(f.service, 'POST', '/v1/recording/start', { label: 'chat scroll check', fps: 6, source: 'window' })
  assert.equal(start.status, 200); assert.equal(start.body.status, 'recording')
  assert.match(start.body.recording.id, /^rec-\d{14}-[0-9a-f]{6}$/)
  assert.equal(f.commands[0].command, 'start'); assert.equal(f.commands[0].fps, 6); assert.equal(f.commands[0].dir, path.join(f.dataDir, 'recordings')); assert.equal(f.commands[0].owner.kind, 'bridge-http')
  assert.equal((await call(f.service, 'GET', '/v1/recording')).body.status, 'recording')
  assert.equal((await call(f.service, 'POST', '/v1/recording/start', { source: 'window' })).status, 409, 'one recording at a time')
  const stop = await call(f.service, 'POST', '/v1/recording/stop')
  assert.equal(stop.status, 200); assert.equal(stop.body.status, 'finished'); assert.equal(stop.body.recording.verification.ok, true)
  const after = await call(f.service, 'GET', '/v1/recording')
  assert.equal(after.body.status, 'idle'); assert.equal(after.body.last.id, start.body.recording.id)
  assert.equal((await call(f.service, 'POST', '/v1/recording/stop')).status, 409)
})

test('refusals: unknown fields, bad label, window refusal, no window answer; a failed check is a failure', async t => {
  const f = fixture(t)
  assert.equal((await call(f.service, 'POST', '/v1/recording/start', { path: '/etc' })).status, 400)
  assert.equal((await call(f.service, 'POST', '/v1/recording/start', { label: 'a\nb' })).status, 400)
  assert.equal((await call(f.service, 'POST', '/v1/recording/start', { fps: 'x' })).status, 400)
  assert.equal(f.commands.length, 0)
  const refused = await call(fixture(t, { window: 'refuse' }).service, 'POST', '/v1/recording/start', { source: 'window' })
  assert.equal(refused.status, 422); assert.equal(refused.body.reason, 'encoder-unsupported')
  const silent = fixture(t, { window: 'none' })
  assert.equal((await call(silent.service, 'POST', '/v1/recording/start', { source: 'window' })).status, 504)
  assert.equal((await call(silent.service, 'GET', '/v1/recording')).body.status, 'idle')
  const bad = fixture(t, { verify: async () => ({ by: 'bridge', ok: false, error: 'file-unreadable' }) })
  await call(bad.service, 'POST', '/v1/recording/start', { source: 'window' })
  const stop = await call(bad.service, 'POST', '/v1/recording/stop')
  assert.equal(stop.body.status, 'failed'); assert.match(stop.body.recording.error, /verify-/)
})

test('a stop the window makes itself (max length, app closing) is finished and checked; closing() commands a stop', async t => {
  const f = fixture(t, { verify: async () => ({ by: 'bridge', ok: true }) })
  const start = await call(f.service, 'POST', '/v1/recording/start', { source: 'window' })
  await f.service.report({ id: start.body.recording.id, state: 'stopped', info: { state: 'finished', error: null } })
  const status = await call(f.service, 'GET', '/v1/recording')
  assert.equal(status.body.status, 'idle'); assert.equal(status.body.last.state, 'finished')
  const g = fixture(t)
  await call(g.service, 'POST', '/v1/recording/start', { source: 'window' })
  g.service.closing()
  assert.deepEqual(g.commands.at(-1).reason, 'bridge-closing')
  assert.equal(await g.service.report({ id: 'rec-other', state: 'stopped' }), false)
})

test('verifyRecordingFiles: segment hashes and size are checked against the file', async t => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'egd-ver-')); t.after(() => rmSync(dir, { recursive: true, force: true }))
  const a = Buffer.from('aaaa'), b = Buffer.from('bbbbbb')
  writeFileSync(path.join(dir, 'x.webm'), Buffer.concat([a, b]))
  const side = { totalBytes: 10, segments: [{ offset: 0, bytes: 4, sha256: sha(a) }, { offset: 4, bytes: 6, sha256: sha(b) }] }
  writeFileSync(path.join(dir, 'x.json'), JSON.stringify(side))
  const ok = await verifyRecordingFiles({ dir, id: 'x', ffprobe: '/nonexistent/ffprobe' })
  assert.equal(ok.segmentHashesMatch, true); assert.equal(ok.sizeMatches, true); assert.equal(ok.playback, 'unchecked'); assert.equal(ok.ok, true)
  writeFileSync(path.join(dir, 'x.webm'), Buffer.concat([a, Buffer.from('bbbbbX')]))
  assert.equal((await verifyRecordingFiles({ dir, id: 'x', ffprobe: '/nonexistent/ffprobe' })).ok, false)
  assert.equal((await verifyRecordingFiles({ dir, id: 'missing' })).error, 'sidecar-unreadable')
})

test('verifyRecordingFiles with ffprobe: a real WebM decodes; junk bytes do not', { skip: !existsSync(FFMPEG) || !existsSync(FFPROBE) }, async t => {
  try { execFileSync(FFMPEG, ['-version'], { stdio: 'ignore' }) } catch { return t.skip('process spawn is not available here') }
  const dir = mkdtempSync(path.join(os.tmpdir(), 'egd-ffp-')); t.after(() => rmSync(dir, { recursive: true, force: true }))
  execFileSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=4:duration=2', '-c:v', 'libvpx', '-y', path.join(dir, 'v.webm')])
  const bytes = readFileSync(path.join(dir, 'v.webm'))
  writeFileSync(path.join(dir, 'v.json'), JSON.stringify({ totalBytes: bytes.length, segments: [{ offset: 0, bytes: bytes.length, sha256: sha(bytes) }] }))
  const good = await verifyRecordingFiles({ dir, id: 'v', ffprobe: FFPROBE })
  assert.equal(good.playback, 'decodes'); assert.equal(good.decodedFrames, 8); assert.equal(good.width, 160); assert.equal(good.ok, true)
  const junk = Buffer.from('not a webm at all')
  writeFileSync(path.join(dir, 'j.webm'), junk)
  writeFileSync(path.join(dir, 'j.json'), JSON.stringify({ totalBytes: junk.length, segments: [{ offset: 0, bytes: junk.length, sha256: sha(junk) }] }))
  const bad = await verifyRecordingFiles({ dir, id: 'j', ffprobe: FFPROBE })
  assert.notEqual(bad.playback, 'decodes'); assert.equal(bad.ok, false)
})

// ---- default source 'egdesk-windows' (L44): the ScreenCaptureKit tool on the windows of the Desk's own Firefox pid ----
function winFixture(t, { pid = 4242, behavior = 'ok', verify = async () => ({ by: 'bridge', ok: true }), exists = async () => true } = {}) {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'egd-win-'))
  t.after(() => rmSync(dataDir, { recursive: true, force: true }))
  const commands = [], spawned = []
  let service
  const broadcast = event => {
    commands.push(event)
    if (event.command === 'locate') queueMicrotask(() => service.report(pid === 'none' ? { id: event.id, state: 'failed', reason: 'no-desk' } : { id: event.id, state: 'located', geometry: {}, ...(pid === null ? {} : { pid }) }))
  }
  const spawn = (bin, args) => {
    const child = new EventEmitter()
    Object.assign(child, { exitCode: null, signalCode: null, stderr: new EventEmitter(), stdout: new EventEmitter(), killed: [] })
    child.stdin = { written: '', write(x) { this.written += x; if (/^q/.test(x) && behavior === 'ok') queueMicrotask(() => { child.stdout.emit('data', '{"event":"stopped","frames":7,"maskedFrames":2}\n'); child.exitCode = 0; child.emit('exit', 0, null) }) }, on() {} }
    child.kill = sig => { child.killed.push(sig); child.signalCode = sig; queueMicrotask(() => child.emit('exit', null, sig)) }
    setTimeout(() => {
      if (behavior === 'denied') { child.stdout.emit('data', '{"event":"error","reason":"screen-recording-permission","detail":"denied"}\n'); child.exitCode = 1; child.emit('exit', 1, null) }
      else child.stdout.emit('data', '{"event":"started","windows":2,"windowIds":[11,12],"video":{"width":1512,"height":982},"fps":5,"scale":1}\n{"event":"win')   // a line split across chunks
    }, 5)
    spawned.push({ bin, args, child })
    return child
  }
  service = createScreenRecordingService({ enabled: () => true, broadcast, dataDir, spawn, exists, recorderPath: '/x/egdesk-screen-recorder', startAckMs: 200, stopAckMs: 200, startupMs: 80, quitMs: 100, intMs: 100, verify })
  return { service, commands, spawned, dataDir }
}
const sidecarOf = (f, id) => JSON.parse(readFileSync(path.join(f.dataDir, 'recordings', id + '.json'), 'utf8'))

test('default source: locate gives the Firefox pid -> recorder is started with that pid only; sidecar has filter pid, windows, intervals; stop sends q', async t => {
  const f = winFixture(t)
  const start = await call(f.service, 'POST', '/v1/recording/start', { label: 'update dialog', fps: 12 })
  assert.equal(start.status, 200); assert.equal(start.body.recording.source, DEFAULT_SOURCE); assert.match(start.body.recording.file, /\.mp4$/)
  assert.deepEqual(f.commands.map(c => c.command), ['locate', 'indicator']); assert.equal(f.commands[1].on, true)
  const { bin, args } = f.spawned[0]
  assert.equal(bin, '/x/egdesk-screen-recorder'); assert.equal(args[args.indexOf('--pid') + 1], '4242'); assert.equal(args[args.indexOf('--fps') + 1], '12')
  assert.ok(!args.some(a => /crop|avfoundation|ffmpeg/.test(a)), 'no fixed screen rectangle any more')
  f.spawned[0].child.stdout.emit('data', 'dows","count":3,"windowIds":[11,12,13]}\n')   // the split line completes: a dialog opened
  const side = sidecarOf(f, start.body.recording.id)
  assert.equal(side.source, 'egdesk-windows-screencapturekit'); assert.equal(side.filter.kind, 'include-windows-of-pid'); assert.equal(side.filter.pid, 4242); assert.equal(side.filter.windowCount, 2)
  assert.equal(side.mask, 'none'); assert.match(side.maskNote, /not connected/); assert.equal(side.owner.kind, 'bridge-http'); assert.equal(side.state, 'recording')
  const stop = await call(f.service, 'POST', '/v1/recording/stop')
  assert.equal(stop.status, 200); assert.equal(stop.body.status, 'finished'); assert.equal(f.spawned[0].child.stdin.written, 'q\n')
  assert.equal(f.commands.at(-1).on, false)
  const done = sidecarOf(f, start.body.recording.id)
  assert.equal(done.state, 'finished'); assert.equal(done.stopReason, 'requested'); assert.ok(done.endedAt); assert.deepEqual(done.frames, { count: 7, masked: 2 })
  assert.deepEqual(done.intervals.map(i => i.windows), [2, 3]); assert.equal(done.intervals[0].toMs, done.intervals[1].fromMs); assert.equal(done.intervals[1].toMs, null)
})

test("the old fixed-rectangle source 'os' is gone: refused as an unknown source, nothing is spawned", async t => {
  const f = winFixture(t)
  const r = await call(f.service, 'POST', '/v1/recording/start', { source: 'os' })
  assert.equal(r.status, 400); assert.equal(r.body.reason, 'source'); assert.equal(f.spawned.length, 0); assert.equal(f.commands.length, 0)
})

test('the pid is never taken from the request: a pid field is an unknown field, and a window without a pid is refused', async t => {
  const f = winFixture(t)
  assert.equal((await call(f.service, 'POST', '/v1/recording/start', { pid: 1234 })).body.reason, 'unknown-field')
  assert.equal(f.spawned.length, 0)
  const noPid = winFixture(t, { pid: null })
  const r = await call(noPid.service, 'POST', '/v1/recording/start', {})
  assert.equal(r.status, 422); assert.equal(r.body.reason, 'no-firefox-pid'); assert.equal(noPid.spawned.length, 0)
  assert.equal((await call(winFixture(t, { pid: 'none' }).service, 'POST', '/v1/recording/start', {})).body.reason, 'no-desk')
})

test('refusals: no Screen Recording permission is a clear refusal (reason + detail in the sidecar), recorder missing, nothing stays recording', async t => {
  const denied = winFixture(t, { behavior: 'denied' })
  const r = await call(denied.service, 'POST', '/v1/recording/start', {})
  assert.equal(r.status, 422); assert.equal(r.body.reason, 'screen-recording-permission'); assert.equal((await call(denied.service, 'GET', '/v1/recording')).body.status, 'idle')
  assert.equal(denied.commands.at(-1).on, false)
  const side = sidecarOf(denied, r.body.recording.id); assert.equal(side.state, 'failed'); assert.match(side.error, /screen-recording-permission: denied/)
  const missing = winFixture(t, { exists: async () => false })
  assert.equal((await call(missing.service, 'POST', '/v1/recording/start', {})).body.reason, 'recorder-unavailable'); assert.equal(missing.spawned.length, 0)
})

test('a recorder that ignores q is interrupted then killed and the recording is marked failed; closing() stops it too', async t => {
  const stuck = winFixture(t, { behavior: 'stuck' })
  await call(stuck.service, 'POST', '/v1/recording/start', {})
  const stop = await call(stuck.service, 'POST', '/v1/recording/stop')
  assert.deepEqual(stuck.spawned[0].child.killed, ['SIGINT']); assert.equal(stop.body.status, 'failed')
  const g = winFixture(t)
  await call(g.service, 'POST', '/v1/recording/start', {})
  g.service.closing()
  await new Promise(r => setTimeout(r, 30))
  assert.equal(g.spawned[0].child.stdin.written, 'q\n')
})

test('mask boxes from the window are forwarded to the recorder stdin as JSON lines with a rising revision and logged in the sidecar', async t => {
  const f = winFixture(t)
  assert.equal(f.service.setMask([{ x: 1, y: 2, width: 3, height: 4 }]), false, 'no recording: nothing to mask')
  const start = await call(f.service, 'POST', '/v1/recording/start', {})
  assert.equal(await f.service.report({ id: start.body.recording.id, state: 'mask', boxes: [{ x: 10, y: 20, width: 30, height: 40 }, { x: 'bad' }] }), true)
  assert.equal(f.spawned[0].child.stdin.written, '{"mask":[{"x":10,"y":20,"w":30,"h":40}],"rev":1}\n')
  const side = sidecarOf(f, start.body.recording.id)
  await call(f.service, 'POST', '/v1/recording/stop')
  const done = sidecarOf(f, start.body.recording.id)
  assert.equal(done.mask, 'recorder-stdin'); assert.equal(done.maskRevision, 1); assert.equal(done.maskRevisions[0].boxes, 1); assert.equal(side.state, 'recording')
})
