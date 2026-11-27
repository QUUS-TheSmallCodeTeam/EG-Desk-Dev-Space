import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { deflateSync, inflateSync } from 'node:zlib'
import { attachBoardVisual, boardVisualNames, MAX_BOARD_VISUAL_IMAGE_CHARS, validateBoardVisual } from './egdesk-board-visual-packet.mjs'
import { createBoardPresentationHttpHandler } from './egdesk-board-presentation-http.mjs'

const prefix = 'data:image/png;base64,'
const signature = Buffer.from('89504e470d0a1a0a', 'hex')
const raw = url => Buffer.from(url.slice(prefix.length), 'base64')
const imageOf = png => prefix + png.toString('base64')
const pixels = Buffer.from([0, 9, 8, 7, 0, 5, 6, 7, 255, 2, 1, 2, 3, 255, 7, 8, 9, 0])
function chunk(type, data) {
  const packet = Buffer.alloc(data.length + 12)
  packet.writeUInt32BE(data.length)
  packet.write(type, 4)
  data.copy(packet, 8)
  let crc = 0xffffffff
  for (const byte of packet.subarray(4, -4)) {
    crc ^= byte
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0)
  }
  packet.writeUInt32BE((crc ^ 0xffffffff) >>> 0, packet.length - 4)
  return packet
}
function makePng({ width = 2, height = 2, rows = pixels, compressed = deflateSync(rows), ancillary = [], split = false } = {}) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8; ihdr[9] = 6
  const idats = split ? [compressed.subarray(0, 2), compressed.subarray(2)] : [compressed]
  return Buffer.concat([signature, chunk('IHDR', ihdr), ...ancillary, ...idats.map(data => chunk('IDAT', data)), chunk('IEND', Buffer.alloc(0))])
}
const composition = Object.freeze({ density: 'balanced', readability: 'mixed', alignment: 'aligned', flow: 'linked',
  focus: 'prominent', distribution: 'balanced', openSpace: 'room', movement: 'low' })
const makeVisual = (overrides = {}) => ({ image: imageOf(makePng()), width: 2, height: 2, composition,
  candidates: ['workbench', 'tidy'], ...overrides })

function parseIdat(png) {
  assert.equal(png.toString('latin1', 37, 41), 'IDAT') // only IHDR before it in canonical PNG
  const length = png.readUInt32BE(33)
  assert.equal(png.toString('latin1', 49 + length, 53 + length), 'IEND')
  return inflateSync(png.subarray(41, 41 + length))
}

test('validate returns only the exact DTO; strips fixed ancillary, original filters, and transparent RGB', () => {
  const g = Buffer.alloc(4); g.writeUInt32BE(45455)
  const image = imageOf(makePng({ split: true, ancillary: [chunk('sRGB', Buffer.from([0])), chunk('gAMA', g), chunk('pHYs', Buffer.alloc(9))] }))
  const visual = validateBoardVisual(makeVisual({ image }))
  assert.ok(visual)
  assert.notEqual(visual.image, image)
  assert.deepEqual(visual, { image: visual.image, width: 2, height: 2, composition, candidates: ['tidy', 'workbench'] })
  assert.deepEqual(parseIdat(raw(visual.image)), Buffer.from([0, 0, 0, 0, 0, 5, 6, 7, 255, 0, 10, 10, 10, 255, 12, 14, 16, 255]))
  assert.ok(Object.isFrozen(visual) && Object.isFrozen(visual.composition) && Object.isFrozen(visual.candidates))
  assert.deepEqual(validateBoardVisual(JSON.parse(JSON.stringify(visual))), visual)
})

test('rejects size, dimension, canonical base64, CRC, filter and deflate violations', () => {
  const invalidCrc = makePng(); invalidCrc[29] ^= 1
  const badFilter = Buffer.from(pixels); badFilter[0] = 5
  for (const visual of [makeVisual({ width: 1 }), makeVisual({ width: 0 }), makeVisual({ width: 769 }),
    makeVisual({ height: 513 }), makeVisual({ height: 2.5 }), makeVisual({ width: '2' }),
    makeVisual({ image: prefix + 'A'.repeat(MAX_BOARD_VISUAL_IMAGE_CHARS) }),
    makeVisual({ image: `${prefix}A===` }), makeVisual({ image: `${prefix}AR==` }),
    makeVisual({ image: 'https://test.invalid/not-an-image' }), makeVisual({ image: 'file:///not-an-image' }),
    makeVisual({ image: `${imageOf(makePng())}\n` }),
    ...[invalidCrc, makePng({ rows: pixels.subarray(0, -1) }), makePng({ rows: Buffer.alloc(99_999) }), makePng({ rows: badFilter }),
      makePng({ compressed: Buffer.concat([deflateSync(pixels), Buffer.from([0])]) }),
      Buffer.concat([makePng(), Buffer.from([0])])].map(png => makeVisual({ image: imageOf(png) })),
  ]) assert.equal(validateBoardVisual(visual), null)
})

test('rejects text metadata, arbitrary ICC, APNG, unknown chunks, and private or undeclared fields', () => {
  for (const [type, data] of [['tEXt', Buffer.from('name\0private')], ['zTXt', Buffer.alloc(2)],
    ['iTXt', Buffer.alloc(4)], ['iCCP', Buffer.alloc(20)], ['acTL', Buffer.alloc(8)],
    ['fcTL', Buffer.alloc(26)], ['fdAT', Buffer.alloc(4)], ['abCd', Buffer.alloc(0)],
    ['sRGB', Buffer.from([255])], ['gAMA', Buffer.alloc(4)]]) {
    assert.equal(validateBoardVisual(makeVisual({ image: imageOf(makePng({ ancillary: [chunk(type, data)] })) })), null)
  }
  for (const v of [makeVisual({ id: 'private' }), makeVisual({ composition: { ...composition, id: 'private' } }),
    makeVisual({ composition: { ...composition, readability: 'wrong' } }), makeVisual({ candidates: ['tidy', 'tidy'] }),
    makeVisual({ candidates: ['__proto__'] }), makeVisual({ candidates: ['PRIVATE_CARD_ID'] }),
    makeVisual({ candidates: [{ id: 'private' }] }), makeVisual({ candidates: Array(1) })]) {
    assert.equal(validateBoardVisual(v), null)
    assert.equal(attachBoardVisual({ status: 'prepared' }, v), null)
  }
})

const path = '/decision/board-presentation'
const cue = 'Café 인계'
const scene = { overlap: 'selected', frame: 'inside', clip: 'inside', target: 'title', reach: 'miss', obscured: true }
const dto = { cue, items: [{ kind: '업무 전표', focus: true, movable: true, scene }], wide: true, tall: true }
const fixtureKey = 'offline-fixture-only'
const keep = '현재 배치 유지'
async function setup(t, option = 'tidy') {
  const calls = []
  let time = 0, handler
  const server = createServer(async (req, res) => {
    if (!(await handler(req, res, new URL(req.url, 'http://127.0.0.1')))) { res.writeHead(404); res.end() }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  handler = createBoardPresentationHttpHandler({ port, now: () => time, getMode: () => 'on',
    credentials: { getApiKey: () => fixtureKey, savedAt: () => 12 }, budget: { canSpend: () => true, record: () => {} },
    fetchImpl: (_endpoint, { body }) => {
      calls.push(body)
      const choice = boardVisualNames[option]
      return Response.json({ answers: [{ name: 'board_view', type: 'choice', choice, confidence: 0.98,
        probabilities: [{ value: choice, probability: 0.98 }, { value: keep, probability: 0.02 }] }], usage: { input_tokens: 1 } })
    } })
  t.after(() => { handler.invalidate(); server.closeAllConnections(); return new Promise(resolve => server.close(resolve)) })
  async function post(action, body, init = {}) {
    const response = await fetch(`http://127.0.0.1:${port}${path}/${action}`, { method: 'POST',
      body: typeof body === 'string' ? body : JSON.stringify(body), headers: { 'Content-Type': 'application/json' }, ...init })
    return { code: response.status, body: await response.json() }
  }
  return { post, calls, handler, setNow(value) { time = value } }
}

test('prepare locally previews exact canonical and authorized image packet; run consumes and sends it once', async t => {
  const { post, calls } = await setup(t)
  const visual = makeVisual({ candidates: ['workbench', 'tidy'] })
  const { body: prepared } = await post('prepare', { ...dto, visual })
  assert.equal(prepared.status, 'prepared')
  assert.equal(prepared.expiresInMs, 60_000)
  assert.deepEqual(prepared.preview.options, ['keep', 'overview', 'focus', 'front', 'tidy', 'workbench'])
  const packet = prepared.preview.packet
  assert.deepEqual(Object.keys(packet), ['model', 'input', 'questions'])
  assert.deepEqual(packet.input, [{ role: 'user', content: [
    { type: 'input_text', text: cue },
    { type: 'input_json', data: { selected: [{ slot: 'A', kind: '업무 전표', designatedFocus: true, scene }], availableWidth: '두 장 폭', composition } },
    { type: 'input_image', image_url: validateBoardVisual(visual).image, detail: 'low' },
  ] }])
  assert.deepEqual(packet.questions[0].choices.slice(-2), [{ value: boardVisualNames.tidy }, { value: boardVisualNames.workbench }])
  assert.match(packet.questions[0].instructions, /승인된 보드 레이어.*가독성.*여백과 밀도.*배치 안정성.*선후관계.*겹침 제거 자체가 목표는 아닙니다/)
  for (const [action, body] of [['prepare', { ...dto, boardId: 'PRIVATE_ID', visual }],
    ['prepare', { ...dto, visual, items: [{ ...dto.items[0], id: 'PRIVATE_ID' }] }],
    ['prepare', { ...dto, visual: { ...visual, id: 'PRIVATE_ID' } }],
    ['run', { ticket: prepared.ticket, confirm: false }], ['run', { ticket: prepared.ticket, confirm: true, visual }]]) {
    assert.equal((await post(action, body)).code, 400)
  }
  assert.equal(calls.length, 0)
  assert.deepEqual((await post('run', { ticket: prepared.ticket, confirm: true })).body, { status: 'preview', preview: 'tidy' })
  assert.deepEqual(calls, [JSON.stringify(packet)])
  for (const token of ['PRIVATE_ID', prepared.ticket, fixtureKey, 'image_url":"https:']) assert.ok(!calls[0].includes(token))
  assert.deepEqual((await post('run', { ticket: prepared.ticket, confirm: true })).body, { status: 'manual' })
  assert.equal(calls.length, 1)
})

function raster(width, height) {
  const stride = 1 + width * 4
  const rows = Buffer.alloc(stride * height)
  let x = 247933
  for (let i = 0; i < rows.length; i++) {
    if (!(i % stride)) continue
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5
    rows[i] = x
  }
  return makeVisual({ width, height, image: imageOf(makePng({ width, height, rows })) })
}

test('only the valid image grants larger loopback prepare; legacy and padding retain 4096-byte 413', async t => {
  const { post, calls } = await setup(t)
  const visual = raster(40, 40)
  const large = JSON.stringify({ ...dto, visual })
  const legacy = JSON.stringify(dto)
  const legacyLimit = legacy + ' '.repeat(4096 - Buffer.byteLength(legacy))
  const chunked = wire => ({ body: new ReadableStream({ start(c) {
    c.enqueue(new TextEncoder().encode(wire.slice(0, 3000)))
    c.enqueue(new TextEncoder().encode(wire.slice(3000)))
    c.close()
  } }), duplex: 'half' })
  assert.ok(Buffer.byteLength(large) > 4096)
  assert.equal((await post('prepare', legacyLimit)).body.status, 'prepared')
  assert.equal((await post('prepare', legacyLimit + ' ')).code, 413)
  assert.equal((await post('prepare', null, chunked(legacyLimit + ' '))).code, 413)
  assert.equal((await post('prepare', large + ' '.repeat(4096))).code, 413)
  assert.equal((await post('prepare', { ...dto, visual: { ...visual, candidates: ['PRIVATE_ID'] } })).code, 413)
  assert.equal((await post('prepare', large, { headers: { 'Content-Type': 'application/json', Origin: 'https://untrusted.invalid' } })).code, 403)
  assert.equal((await post('prepare', null, chunked(large))).body.status, 'prepared')
  assert.equal((await post('run', { ticket: '0'.repeat(48), confirm: true, visual })).code, 413)
  assert.equal((await post('cancel', { ticket: '0'.repeat(48), visual })).code, 413)
  assert.equal(calls.length, 0)
})

test('unoffered option is not accepted; expired, cancelled, or invalidated visuals never dispatch', async t => {
  const { post, calls, setNow, handler } = await setup(t, 'handoff')
  const makeTicket = async () => (await post('prepare', { ...dto, visual: makeVisual() })).body.ticket
  const run = async ticket => (await post('run', { ticket, confirm: true })).body
  assert.deepEqual(await run(await makeTicket()), { status: 'manual' })
  assert.equal(calls.length, 1)
  const beforeExpiry = await makeTicket(); setNow(60_000)
  assert.deepEqual(await run(beforeExpiry), { status: 'manual' })
  const toCancel = await makeTicket(); await post('cancel', { ticket: toCancel })
  assert.deepEqual(await run(toCancel), { status: 'manual' })
  const toInvalidate = await makeTicket(); handler.invalidate()
  assert.deepEqual(await run(toInvalidate), { status: 'manual' })
  assert.equal(calls.length, 1)
})

test('aggregate ticket bytes are bounded and cancel releases capacity', async t => {
  const { post, calls } = await setup(t)
  const visual = raster(768, 512)
  const first = (await post('prepare', { ...dto, visual })).body
  assert.equal(first.status, 'prepared')
  const packetBytes = Buffer.byteLength(JSON.stringify(first.preview.packet))
  const limit = Math.floor(8 * 1024 * 1024 / packetBytes)
  assert.ok(limit >= 1 && limit < 32)
  for (let i = 1; i < limit; i++) assert.equal((await post('prepare', { ...dto, visual })).body.status, 'prepared')
  assert.equal((await post('prepare', { ...dto, visual })).body.reason, 'busy')
  assert.equal((await post('cancel', { ticket: first.ticket })).body.status, 'cancelled')
  assert.equal((await post('prepare', { ...dto, visual })).body.status, 'prepared')
  assert.equal(calls.length, 0)
})
