import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { createScreenRecordingService, verifyRecordingFiles } from './egdesk-screen-recording.mjs'

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

test('flag off: every route is refused with 404 and nothing is sent to the window', async t => {
  const f = fixture(t, { on: false })
  for (const [m, u] of [['GET', '/v1/recording'], ['POST', '/v1/recording/start'], ['POST', '/v1/recording/stop']]) assert.equal((await call(f.service, m, u, m === 'POST' ? {} : undefined)).status, 404)
  assert.equal(f.commands.length, 0)
  assert.equal((await call(f.service, 'GET', '/other')).handled, false)
})

test('start -> status -> stop: the window is commanded, the file is re-read by the bridge, and the result is reported', async t => {
  const f = fixture(t, { verify: async () => ({ by: 'bridge', ok: true }) })
  const start = await call(f.service, 'POST', '/v1/recording/start', { label: 'chat scroll check', fps: 6 })
  assert.equal(start.status, 200); assert.equal(start.body.status, 'recording')
  assert.match(start.body.recording.id, /^rec-\d{14}-[0-9a-f]{6}$/)
  assert.equal(f.commands[0].command, 'start'); assert.equal(f.commands[0].fps, 6); assert.equal(f.commands[0].dir, path.join(f.dataDir, 'recordings')); assert.equal(f.commands[0].owner.kind, 'bridge-http')
  assert.equal((await call(f.service, 'GET', '/v1/recording')).body.status, 'recording')
  assert.equal((await call(f.service, 'POST', '/v1/recording/start', {})).status, 409, 'one recording at a time')
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
  const refused = await call(fixture(t, { window: 'refuse' }).service, 'POST', '/v1/recording/start', {})
  assert.equal(refused.status, 422); assert.equal(refused.body.reason, 'encoder-unsupported')
  const silent = fixture(t, { window: 'none' })
  assert.equal((await call(silent.service, 'POST', '/v1/recording/start', {})).status, 504)
  assert.equal((await call(silent.service, 'GET', '/v1/recording')).body.status, 'idle')
  const bad = fixture(t, { verify: async () => ({ by: 'bridge', ok: false, error: 'file-unreadable' }) })
  await call(bad.service, 'POST', '/v1/recording/start', {})
  const stop = await call(bad.service, 'POST', '/v1/recording/stop')
  assert.equal(stop.body.status, 'failed'); assert.match(stop.body.recording.error, /verify-/)
})

test('a stop the window makes itself (max length, app closing) is finished and checked; closing() commands a stop', async t => {
  const f = fixture(t, { verify: async () => ({ by: 'bridge', ok: true }) })
  const start = await call(f.service, 'POST', '/v1/recording/start', {})
  await f.service.report({ id: start.body.recording.id, state: 'stopped', info: { state: 'finished', error: null } })
  const status = await call(f.service, 'GET', '/v1/recording')
  assert.equal(status.body.status, 'idle'); assert.equal(status.body.last.state, 'finished')
  const g = fixture(t)
  await call(g.service, 'POST', '/v1/recording/start', {})
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
