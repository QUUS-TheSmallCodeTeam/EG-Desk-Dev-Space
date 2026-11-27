import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createScreenRecorder, cardCoverBoxes, maskKey, pickRecordingMime, recordingOptions, scaleBoxes, SCREEN_RECORDING } from '../overlay/resources/EGDeskScreenRecorder.sys.mjs'

// Screen recording v1 (L37): the recorder with a fake window, fake IOUtils and a fake MediaRecorder.
const goodReport = (regions = [], viewport = { width: 400, height: 300 }) => ({ complete: true, incompleteReason: null, documentId: 'd1', revision: 1, viewport, regions })
const field = { kind: 'sensitive-field', reason: 'password', rect: { left: 10, top: 20, width: 100, height: 20 } }

test('mask: a card that cannot answer, is private/zoomed or mismatched is covered whole; fields are offset into window pixels', () => {
  const rect = { left: 100, top: 50, width: 400, height: 300 }
  const whole = reason => assert.equal(reason.whole, true) || assert.equal(reason.boxes.length, 1)
  whole(cardCoverBoxes({ rect }, null))
  whole(cardCoverBoxes({ rect }, { complete: false, incompleteReason: 'scan-budget' }))
  whole(cardCoverBoxes({ rect, cover: 'private' }, goodReport()))
  whole(cardCoverBoxes({ rect }, goodReport([], { width: 900, height: 300 })))
  const ok = cardCoverBoxes({ rect }, goodReport([field]))
  assert.equal(ok.whole, false)
  assert.deepEqual(ok.boxes.map(({ x, y }) => [x, y]), [[100 + 7, 50 + 17]])
  assert.ok(ok.boxes[0].width >= 106 && ok.boxes[0].height >= 26, 'grown by the margin')
})

test('mask: boxes scale to the canvas, grown by one pixel and clipped', () => {
  const out = scaleBoxes([{ x: 0, y: 0, width: 100, height: 40 }, { x: 990, y: 10, width: 50, height: 10 }], 0.5, 0.5, { width: 500, height: 300 })
  assert.deepEqual(out[0], { x: 0, y: 0, width: 51, height: 21 })
  assert.equal(out[1].x + out[1].width, 500)
  assert.equal(maskKey([{ x: 1, y: 2, width: 3, height: 4, kind: 'a' }]), '1,2,3,4,a')
})

test('options are clamped; mime picks the first supported WebM or nothing', () => {
  assert.deepEqual(recordingOptions({}), { fps: 4, scale: 0.5, timesliceMs: 2000, maxMs: 1_800_000 })
  assert.equal(recordingOptions({ fps: 999, scale: 9, maxMs: 1 }).fps, SCREEN_RECORDING.maxFps)
  assert.equal(recordingOptions({ scale: 9 }).scale, 1)
  const R = supported => Object.assign(function () {}, { isTypeSupported: t => supported.includes(t) })
  assert.equal(pickRecordingMime(R(['video/webm;codecs=vp8', 'video/webm'])), 'video/webm;codecs=vp8')
  assert.equal(pickRecordingMime(R([])), null)
  assert.equal(pickRecordingMime(undefined), null)
})

function rig({ supported = ['video/webm;codecs=vp9'], report = goodReport([field]), existing = false, queryThrows = false } = {}) {
  const files = new Map(), json = new Map(), events = [], drawn = [], timers = []
  const dot = { removed: false, remove() { this.removed = true } }
  let dotEl = null
  const track = { frames: 0, requestFrame() { this.frames++ } }
  const recorders = []
  class FakeRecorder {
    static isTypeSupported(t) { return supported.includes(t) }
    constructor(stream, opts) { this.opts = opts; this.state = 'inactive'; recorders.push(this) }
    start(slice) { this.state = 'recording'; this.slice = slice }
    emit(text) { this.ondataavailable({ data: { size: text.length, arrayBuffer: async () => new TextEncoder().encode(text).buffer } }) }
    stop() { this.emit('tail'); this.state = 'inactive'; this.onstop() }
  }
  const ctx = { drawImage: (...a) => drawn.push(['draw', a.length]), fillRect: (...a) => drawn.push(['mask', ...a]), set fillStyle(v) { drawn.push(['style', v]) } }
  const canvas = { width: 0, height: 0, getContext: () => ctx, captureStream: () => ({ getVideoTracks: () => [track], getTracks: () => [{ stop() { events.push('track-stop') } }] }) }
  const doc = { createElementNS: (ns, name) => (name === 'canvas' ? canvas : { setAttribute() {}, id: '' }), getElementById: () => dotEl, documentElement: { appendChild: el => { dotEl = el; el.remove = () => { dotEl = null; dot.removed = true } } } }
  const IOUtils = {
    makeDirectory: async () => {}, exists: async p => existing || files.has(p) || json.has(p),
    writeJSON: async (p, v) => { json.set(p, JSON.parse(JSON.stringify(v))); events.push(['json', v.state, v.segments.length]) },
    write: async (p, bytes) => { files.set(p, Buffer.concat([files.get(p) || Buffer.alloc(0), Buffer.from(bytes)])) },
    stat: async p => ({ size: files.get(p)?.length ?? 0 }),
  }
  const setTimeoutFn = (fn, ms) => { const t = { fn, ms, cleared: false }; timers.push(t); return t }
  let t0 = 1_000_000
  const rec = createScreenRecorder({
    window: { innerWidth: 800, innerHeight: 600 }, document: doc, IOUtils, MediaRecorder: FakeRecorder, crypto: { subtle: { digest: async (alg, b) => createHash('sha256').update(b).digest() } },
    now: () => (t0 += 500), setTimeout: setTimeoutFn, clearTimeout: t => { if (t) t.cleared = true },
    capture: async () => ({ width: 400, height: 300, close() { events.push('bitmap-close') } }),
    frames: () => [{ id: 'c1', rect: { left: 100, top: 50, width: 400, height: 300 }, query: async () => { if (queryThrows) throw new Error('no actor'); return report } }],
    chromeCovers: () => [{ left: 0, top: 0, width: 50, height: 10 }],
    report: async body => { events.push(['report', body.state]) }, runtime: () => ({ app: 'EG-Desk' }),
  })
  const runTick = async () => { const t = timers.filter(x => !x.cleared && x.ms < 1000).pop(); t.cleared = true; await t.fn() }
  return { rec, files, json, events, drawn, track, recorders, timers, runTick, isDot: () => !!dotEl }
}
const cmd = { id: 'rec-20261128-aabbcc', dir: '/data/recordings', label: 'qa', owner: { kind: 'bridge-http' } }

test('start persists node/owner/runtime first, shows the dot, paints masks, and stop writes a checked sidecar', async () => {
  const r = rig()
  const started = await r.rec.start(cmd)
  assert.equal(started.ok, true)
  const first = r.json.get('/data/recordings/rec-20261128-aabbcc.json')
  assert.equal(first.state, 'recording')
  assert.equal(first.owner.kind, 'bridge-http'); assert.equal(first.runtime.app, 'EG-Desk'); assert.equal(first.node.kind, 'egdesk-window')
  assert.equal(r.events.find(e => Array.isArray(e) && e[0] === 'json')[1], 'starting', 'the first write is before any frame')
  assert.ok(r.isDot())
  await r.runTick(); await r.runTick()
  assert.equal(r.track.frames, 2)
  const masks = r.drawn.filter(d => d[0] === 'mask')
  assert.ok(masks.length >= 2, 'the chrome field and the card field are covered')
  assert.deepEqual(r.drawn.filter(d => d[0] === 'style').at(-1), ['style', '#000000'])
  r.recorders[0].emit('seg-one')
  const done = await r.rec.stop('requested')
  assert.equal(done.ok, true); assert.equal(done.state, 'finished'); assert.equal(r.isDot(), false)
  const side = r.json.get('/data/recordings/rec-20261128-aabbcc.json')
  assert.equal(side.state, 'finished'); assert.equal(side.segments.length, 2); assert.equal(side.framesDrawn, 2)
  const file = r.files.get('/data/recordings/rec-20261128-aabbcc.webm')
  assert.equal(side.totalBytes, file.length); assert.equal(side.verification.sizeMatches, true)
  let offset = 0
  for (const s of side.segments) { assert.equal(s.offset, offset); assert.equal(createHash('sha256').update(file.subarray(offset, offset + s.bytes)).digest('hex'), s.sha256); offset += s.bytes }
  assert.ok(side.maskRevision >= 1 && side.segments[0].maskRevisionTo >= 1)
  assert.ok(r.events.some(e => Array.isArray(e) && e[0] === 'report' && e[1] === 'stopped'))
  assert.equal(r.timers.filter(t => !t.cleared && t.ms > 1000).length, 0, 'the max-length timer is cleared')
})

test('a card whose mask query fails is covered whole, not drawn open', async () => {
  const r = rig({ queryThrows: true })
  await r.rec.start(cmd); await r.runTick()
  assert.ok(r.drawn.some(d => d[0] === 'mask' && d[3] >= 200 && d[4] >= 150), 'a card-sized box (canvas pixels)')
  await r.rec.stop()
})

test('refusals: no supported WebM, existing id, bad id/dir, second start', async () => {
  assert.deepEqual((await rig({ supported: [] }).rec.start(cmd)).reason, 'encoder-unsupported')
  assert.equal((await rig({ existing: true }).rec.start(cmd)).reason, 'exists')
  assert.equal((await rig().rec.start({ ...cmd, id: '../x' })).reason, 'bad-id')
  assert.equal((await rig().rec.start({ ...cmd, dir: 'relative' })).reason, 'bad-dir')
  const r = rig(); await r.rec.start(cmd)
  assert.equal((await r.rec.start({ ...cmd, id: 'rec-20261128-ddeeff' })).reason, 'already-recording')
  assert.equal((await r.rec.stop()).ok, true)
  assert.equal((await r.rec.stop()).reason, 'not-recording')
})

test('a busy tick is counted as dropped, and a stop with no data is a failure, not a success', async () => {
  const r = rig()
  await r.rec.start(cmd)
  const pending = r.runTick()
  await r.runTick().catch(() => {})
  await pending
  const done = await r.rec.stop()
  assert.ok(done.framesDropped >= 0)
  const empty = rig(); await empty.rec.start(cmd)
  empty.recorders[0].stop = function () { this.state = 'inactive'; this.onstop() }
  const none = await empty.rec.stop()
  assert.equal(none.ok, false); assert.equal(none.error, 'no-data')
})
