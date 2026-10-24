import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { realpathSync, rmSync } from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { createPrivateQaTempDirectory } from '../scripts/egdesk-qa-platform.mjs'
import { MAX_DESK_STATE_BYTES, openDeskStore } from './egdesk-desk-store.mjs'
import { DESK_BODY_LIMITS, createDeskHttpHandler, handleDeskHttp } from './egdesk-desk-http.mjs'

const T0 = Date.UTC(2026, 9, 1, 12)
function fixture(t) {
  const dataDir = createPrivateQaTempDirectory('egdesk-desk-http-test-')
  const stores = []
  t.after(() => {
    for (const store of stores) store.close()
    assert.equal(realpathSync.native(dataDir), dataDir)
    rmSync(dataDir, { recursive: true, force: true })
  })
  const open = () => { const store = openDeskStore({ dataDir, ownerScope: 'local-desktop-v1', now: () => T0, utcOffsetMinutes: 0 }); stores.push(store); return store }
  return { open }
}
function fakeRequest(method, url, body, headers = {}) {
  const raw = body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]
  const req = Readable.from(raw)
  req.method = method
  req.url = url
  req.headers = { host: '127.0.0.1:39218', ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers }
  req.socket = { remoteAddress: '127.0.0.1' }
  return req
}
async function call(options, method, url, body, headers) {
  const req = fakeRequest(method, url, body, headers)
  const sent = []
  const handled = await handleDeskHttp(req, new URL(url, 'http://127.0.0.1:39218'), { send: (status, data) => sent.push({ status, data }), ...options })
  assert.ok(sent.length <= 1)
  return { handled, status: sent[0]?.status, data: sent[0]?.data }
}
const desk = (n, extra = {}) => ({ version: 1, savedAt: T0 + n, desk: { pan: { x: n, y: 0 }, zoom: 1 }, cards: [{ id: `card-${n}`, type: 'browser', runtimeState: { uri: `https://example.com/?q=${n}` } }], shapes: [], ...extra })
const board = (title, extra = {}) => ({ version: 1, savedAt: T0, agenda: { id: 'agenda-a', title, memberCardIds: [] }, cards: [], shapes: [], ...extra })

test('Desk routes save generations, answer stale parents with 409 and the latest generation, and restore', async t => {
  const store = fixture(t).open()
  const api = (...args) => call({ store }, ...args)

  const empty = await api('GET', '/v1/desk/current')
  assert.deepEqual([empty.status, empty.data.generation, empty.data.state, empty.data.lastImport], [200, null, null, null])
  const first = await api('PUT', '/v1/desk/current', { state: desk(1), parentGeneration: null })
  assert.deepEqual([first.status, first.data.generation, first.data.unchanged, first.data.reason, first.data.state], [201, 1, false, 'autosave', undefined])
  const same = await api('PUT', '/v1/desk/current', { state: { ...desk(1), savedAt: T0 + 50 }, parentGeneration: 1 })
  assert.deepEqual([same.status, same.data.generation, same.data.unchanged], [200, 1, true])
  const second = await api('PUT', '/v1/desk/current', { state: desk(2), parentGeneration: 1, reason: 'explicit' })
  assert.deepEqual([second.status, second.data.generation, second.data.reason], [201, 2, 'explicit'])
  const stale = await api('PUT', '/v1/desk/current', { state: desk(3), parentGeneration: 1 })
  assert.deepEqual([stale.status, stale.data.code, stale.data.generation, stale.data.stateHash], [409, 'DESK_GENERATION_CONFLICT', 2, second.data.stateHash])
  assert.equal(typeof stale.data.error, 'string')

  const current = await api('GET', '/v1/desk/current')
  assert.deepEqual([current.data.generation, current.data.state], [2, desk(2)])
  const listed = await api('GET', '/v1/desk/generations?limit=1')
  assert.deepEqual([listed.status, listed.data.generations.map(item => item.generation), listed.data.hasMore, listed.data.nextBefore, listed.data.head], [200, [2], true, 2, 2])
  assert.equal(listed.data.generations[0].state, undefined)
  assert.deepEqual((await api('GET', '/v1/desk/generations?limit=5&before=2')).data.generations.map(item => item.generation), [1])
  assert.deepEqual((await api('GET', '/v1/desk/generations/1')).data.state, desk(1))
  const missing = await api('GET', '/v1/desk/generations/99')
  assert.deepEqual([missing.status, missing.data.code], [404, 'DESK_GENERATION_NOT_FOUND'])

  const restored = await api('POST', '/v1/desk/restore', { generation: 1 })
  assert.deepEqual([restored.status, restored.data.generation, restored.data.reason, restored.data.restoredFrom], [201, 3, 'restore', 1])
  assert.deepEqual([(await api('POST', '/v1/desk/restore', { generation: 1 })).status], [200])
  const staleRestore = await api('POST', '/v1/desk/restore', { generation: 2, parentGeneration: 2 })
  assert.deepEqual([staleRestore.status, staleRestore.data.code, staleRestore.data.generation], [409, 'DESK_GENERATION_CONFLICT', 3])
})

test('Board routes keep immutable revisions, refuse stale saves with BOARD_REVISION_CONFLICT and revert as a new revision', async t => {
  const store = fixture(t).open()
  const api = (...args) => call({ store }, ...args)
  const created = await api('PUT', '/v1/boards/agenda-a', { body: board('기획'), expectedRevision: null })
  assert.deepEqual([created.status, created.data.revision, created.data.boardCreated, created.data.board.title], [201, 1, true, '기획'])
  const edited = await api('PUT', '/v1/boards/agenda-a', { body: board('기획', { cards: [{ id: 'c' }] }), expectedRevision: 1 })
  assert.deepEqual([edited.status, edited.data.revision], [201, 2])
  const stale = await api('PUT', '/v1/boards/agenda-a', { body: board('다른 창'), expectedRevision: 1 })
  assert.deepEqual([stale.status, stale.data.code, stale.data.headRevision], [409, 'BOARD_REVISION_CONFLICT', 2])
  const unchanged = await api('PUT', '/v1/boards/agenda-a', { body: board('기획', { cards: [{ id: 'c' }] }), expectedRevision: 2 })
  assert.deepEqual([unchanged.status, unchanged.data.unchanged], [200, true])

  assert.deepEqual((await api('GET', '/v1/boards')).data.boards.map(item => [item.boardId, item.headRevision]), [['agenda-a', 2]])
  const view = await api('GET', '/v1/boards/agenda-a')
  assert.deepEqual([view.data.headRevision, view.data.head.body.cards], [2, [{ id: 'c' }]])
  assert.deepEqual((await api('GET', '/v1/boards/agenda-a/revisions')).data.revisions.map(item => item.revision), [2, 1])
  assert.deepEqual((await api('GET', '/v1/boards/agenda-a/revisions?limit=1')).data.nextBefore, 2)
  assert.deepEqual((await api('GET', '/v1/boards/agenda-a/revisions/1')).data.body, board('기획'))
  const reverted = await api('POST', '/v1/boards/agenda-a/revert', { revision: 1, expectedRevision: 2 })
  assert.deepEqual([reverted.status, reverted.data.revision, reverted.data.revertedFrom], [201, 3, 1])
  const staleRevert = await api('POST', '/v1/boards/agenda-a/revert', { revision: 2, expectedRevision: 2 })
  assert.deepEqual([staleRevert.status, staleRevert.data.code, staleRevert.data.headRevision], [409, 'BOARD_REVISION_CONFLICT', 3])
  for (const url of ['/v1/boards/agenda-missing', '/v1/boards/agenda-missing/revisions', '/v1/boards/agenda-a/revisions/9']) {
    const answer = await api('GET', url)
    assert.equal(answer.status, 404, url)
  }
  assert.equal((await api('GET', '/v1/desk/current')).data.generation, null, 'Board saves never touch the Desk journal')
})

test('import of earlier preference values answers 201 once and 200 duplicate after', async t => {
  const store = fixture(t).open()
  const api = (...args) => call({ store }, ...args)
  const payload = { deskSnapshot: JSON.stringify(desk(1)), boards: [{ boardId: 'agenda-a', title: '기획', body: JSON.stringify(board('기획')) }] }
  const first = await api('POST', '/v1/desk/import', payload)
  assert.deepEqual([first.status, first.data.duplicate, first.data.desk.status, first.data.boards[0].status], [201, false, 'imported', 'imported'])
  const again = await api('POST', '/v1/desk/import', payload)
  assert.deepEqual([again.status, again.data.duplicate, again.data.importId], [200, true, first.data.importId])
  assert.deepEqual((await api('GET', '/v1/desk/current')).data.lastImport, { importId: first.data.importId, importedAt: T0 })
  const unreadable = await api('POST', '/v1/desk/import', { deskSnapshot: '{broken' })
  assert.deepEqual([unreadable.status, unreadable.data.code], [400, 'DESK_IMPORT_UNREADABLE'])
})

test('Desk state may exceed 64 KiB up to its own limit; other bodies stay at 64 KiB', async t => {
  const store = fixture(t).open()
  const api = (...args) => call({ store }, ...args)
  assert.deepEqual(DESK_BODY_LIMITS, { small: 65536, deskState: MAX_DESK_STATE_BYTES + 65536, board: MAX_DESK_STATE_BYTES + 65536, import: 32 * 1024 * 1024 })
  const large = desk(1, { blob: 'x'.repeat(1024 * 1024) })
  const saved = await api('PUT', '/v1/desk/current', { state: large, parentGeneration: null })
  assert.deepEqual([saved.status, saved.data.generation], [201, 1])
  assert.deepEqual((await api('GET', '/v1/desk/current')).data.state, large)
  const boardSaved = await api('PUT', '/v1/boards/agenda-big', { body: board('큰 Board', { blob: 'y'.repeat(512 * 1024) }), expectedRevision: null })
  assert.equal(boardSaved.status, 201)

  const overBody = await api('PUT', '/v1/desk/current', { state: desk(2, { blob: 'x'.repeat(DESK_BODY_LIMITS.deskState) }), parentGeneration: 1 })
  assert.deepEqual([overBody.status, overBody.data.code], [413, 'BODY_TOO_LARGE'])
  const overState = await api('PUT', '/v1/desk/current', { state: desk(2, { blob: 'x'.repeat(MAX_DESK_STATE_BYTES) }), parentGeneration: 1 })
  assert.deepEqual([overState.status, overState.data.code], [413, 'DESK_STATE_TOO_LARGE'])
  const overSmall = await api('POST', '/v1/desk/restore', { generation: 1, padding: 'x'.repeat(70000) })
  assert.deepEqual([overSmall.status, overSmall.data.code], [413, 'BODY_TOO_LARGE'])
  assert.equal((await api('GET', '/v1/desk/generations')).data.generations.length, 1, 'refused bodies write nothing')
})

test('Desk routes refuse untrusted callers, bad input, unknown paths and a missing store with {code, error}', async t => {
  const store = fixture(t).open()
  const api = (method, url, body, headers) => call({ store }, method, url, body, headers)
  for (const headers of [{ origin: 'https://example.com' }, { 'sec-fetch-site': 'cross-site' }, { host: 'evil.test' }]) {
    const answer = await api('GET', '/v1/desk/current', undefined, headers)
    assert.deepEqual([answer.handled, answer.status, answer.data.code], [true, 403, 'DESK_LOOPBACK_REQUIRED'])
  }
  const remote = fakeRequest('GET', '/v1/boards')
  remote.socket.remoteAddress = '10.0.0.5'
  const sent = []
  await handleDeskHttp(remote, new URL('http://127.0.0.1:39218/v1/boards'), { store, send: (status, data) => sent.push({ status, data }) })
  assert.deepEqual([sent[0].status, sent[0].data.code], [403, 'DESK_LOOPBACK_REQUIRED'])

  for (const url of ['/v1/state', '/v1/desktop', '/profiles', '/v1/boardsx']) assert.equal((await api('GET', url)).handled, false, url)
  assert.deepEqual([(await api('GET', '/v1/desk/nope')).status, (await api('GET', '/v1/desk/nope')).data.code], [404, 'DESK_ROUTE_NOT_FOUND'])
  assert.deepEqual([(await api('DELETE', '/v1/desk/current')).status, (await api('POST', '/v1/boards/agenda-a')).data.code], [405, 'METHOD_NOT_ALLOWED'])
  assert.equal((await api('GET', '/v1/boards/..%2Fescape')).status, 404)

  const cases = [
    ['PUT', '/v1/desk/current', { state: desk(1) }, 'DESK_HTTP_INPUT'],
    ['PUT', '/v1/desk/current', { state: desk(1), parentGeneration: null, extra: 1 }, 'DESK_HTTP_INPUT'],
    ['PUT', '/v1/desk/current', { state: desk(1), parentGeneration: null, reason: 'restore' }, 'INVALID_DESK_REASON'],
    ['PUT', '/v1/desk/current', { state: desk(1, { cookie: 'x' }), parentGeneration: null }, 'PRIVATE_DESK_PAYLOAD'],
    ['PUT', '/v1/desk/current', { state: 'not an object', parentGeneration: null }, 'INVALID_DESK_STATE'],
    ['PUT', '/v1/boards/agenda-a', { body: board('x') }, 'DESK_HTTP_INPUT'],
    ['PUT', '/v1/boards/agenda-a', { body: board('x'), expectedRevision: 0 }, 'INVALID_BOARD_REVISION'],
    ['POST', '/v1/desk/restore', {}, 'DESK_HTTP_INPUT'],
    ['POST', '/v1/desk/import', { other: true }, 'DESK_HTTP_INPUT'],
    ['GET', '/v1/desk/generations?limit=0', undefined, 'DESK_HTTP_INPUT'],
    ['GET', '/v1/desk/generations?limit=999', undefined, 'INVALID_DESK_QUERY'],
    ['GET', '/v1/desk/generations?cursor=1', undefined, 'DESK_HTTP_INPUT'],
    ['GET', '/v1/desk/current?limit=1', undefined, 'DESK_HTTP_INPUT'],
  ]
  for (const [method, url, body, code] of cases) {
    const answer = await api(method, url, body)
    assert.deepEqual([answer.status, answer.data.code], [400, code], `${method} ${url} ${JSON.stringify(body)?.slice(0, 80)}`)
    assert.equal(typeof answer.data.error, 'string')
  }
  const wrongType = await api('PUT', '/v1/desk/current', JSON.stringify({ state: desk(1), parentGeneration: null }), { 'content-type': 'text/plain' })
  assert.deepEqual([wrongType.status, wrongType.data.code], [415, 'CONTENT_TYPE'])
  assert.equal((await api('GET', '/v1/desk/current')).data.generation, null, 'nothing above was written')

  for (const unavailable of [null, () => null]) {
    const answer = await call({ store: unavailable }, 'GET', '/v1/boards')
    assert.deepEqual([answer.status, answer.data.code], [503, 'DESK_STORE_UNAVAILABLE'])
  }
  const broken = await call({ store: { current() { throw new Error('disk exploded at /Users/someone/secret') } } }, 'GET', '/v1/desk/current')
  assert.deepEqual(broken, { handled: true, status: 500, data: { code: 'DESK_ERROR', error: 'Desk request could not be completed' } })
})

test('the bridge handler writes JSON with no-store caching', async t => {
  const store = fixture(t).open()
  const handler = createDeskHttpHandler({ store: () => store })
  const res = { headers: null, status: null, body: '', writeHead(status, headers) { this.status = status; this.headers = headers }, end(body) { this.body = body } }
  const handled = await handler(fakeRequest('GET', '/v1/desk/current'), res, new URL('http://127.0.0.1:39218/v1/desk/current'))
  assert.deepEqual([handled, res.status, res.headers['Cache-Control'], JSON.parse(res.body).generation], [true, 200, 'no-store', null])
})

test('the bridge opens the Desk store beside the others and mounts its routes after profiles, before Context and Chat', async () => {
  const source = await readFile(new URL('./codex-bridge-server.mjs', import.meta.url), 'utf8')
  const at = text => { const index = source.indexOf(text); assert.notEqual(index, -1, `missing server marker: ${text}`); return index }
  assert.ok(at("deskStore = openDeskStore({ dataDir: path.join(dataDir, 'desk'), ownerScope: 'local-desktop-v1' })") > at('profileStore.seedTemplates()'))
  at("const handleDeskHttp = createDeskHttpHandler({ store: () => deskStore, port: BRIDGE_PORT })")
  const mount = at('if (await handleDeskHttp(req, res, url)) return')
  assert.ok(at('if (!guardBridgeRequest(req, BRIDGE_PORT)) {') < mount)
  assert.ok(at('if (await handleProfileHttp(req, res, url)) return') < mount)
  assert.ok(mount < at('if (await handleContextHttp(req, res, url)) return'))
  assert.ok(mount < at('if (await handleChatHttp(req, res, url)) return'))
  at("'Access-Control-Allow-Methods': 'GET,POST,PUT,OPTIONS'")
  at('deskStorageReady: Boolean(deskStore), deskStorageError: deskStoreError')
  assert.ok(at('try { deskStore?.close() }') > at('async function shutdown() {'))
  assert.equal(path.basename(new URL('./egdesk-desk-http.mjs', import.meta.url).pathname), 'egdesk-desk-http.mjs')
})
