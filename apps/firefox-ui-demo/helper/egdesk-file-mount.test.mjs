import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { Readable } from 'node:stream'
import { createEGDeskFileMount, requireEGDeskNodeRuntime } from './egdesk-file-mount.mjs'

const request = (route, body, headers = {}) => Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), {
  method: 'POST', url: route, headers: { host: '127.0.0.1:39218', 'content-type': 'application/json', ...headers }, socket: { remoteAddress: '127.0.0.1' },
})
const response = () => ({ writeHead(status) { this.status = status }, end(text) { this.body = JSON.parse(text) } })

test('unsupported Node and missing SQLite fail clearly before adapter or storage construction', () => {
  for (const version of ['18.20.8', '20.19.0', '22.19.0', 'unknown']) {
    assert.throws(() => createEGDeskFileMount({ dataDir: '/unused', nodeRuntime: { version, hasSqlite: true }, createNativeAdapter: () => assert.fail('native adapter must not be created') }), e => e.code === 'EGDESK_NODE_VERSION_REQUIRED' && e.message.includes('24.11.1'))
  }
  assert.throws(() => requireEGDeskNodeRuntime({ version: '24.11.1', hasSqlite: false }), e => e.code === 'EGDESK_SQLITE_REQUIRED')
  const actual = requireEGDeskNodeRuntime({ version: '26.7.0', hasSqlite: true })
  assert.equal(actual.version, '26.7.0')
  assert.equal(actual.integrationBaseline, '24.11.1')
  assert.equal(requireEGDeskNodeRuntime({ version: '24.11.1', hasSqlite: true }).minimumVersion, '24.0.0')
})

test('production mount uses fixed local ownership and adapter-owned request reading, never an AI account', async () => {
  let configuration, forwarded, closed = false, selectedNative
  const mount = createEGDeskFileMount({
    dataDir: '/app-owned-data', nativeExecutable: '/verified-native-binary',
    createNativeAdapter: options => { selectedNative = options; return { capability: 'descriptor-relative-create-only', createFile() {} } },
    createHttpAdapter: options => { configuration = options; return { handle: (...args) => { forwarded = args; return true }, close: () => { closed = true } } },
  })
  assert.equal(configuration.draftDirectory, '/app-owned-data/file-drafts')
  assert.equal(configuration.localOwnerScope, 'egdesk-local')
  assert.equal(configuration.createOnlyAdapter.capability, 'descriptor-relative-create-only')
  assert.deepEqual(selectedNative, { executable: '/verified-native-binary' })
  const req = request('/v1/files/drafts/read', { draftId: 'local' }), res = response(), url = new URL('http://127.0.0.1:39218/v1/files/drafts/read')
  assert.equal(await mount.handle(req, res, url), true)
  assert.deepEqual(forwarded, [req, res, { url }])
  await mount.close()
  assert.equal(closed, true)
})

test('native create failures preserve collision and partial-file semantics through the mount', async () => {
  let adapter
  let failure = Object.assign(new Error('existing file'), { code: 'EGDESK_NATIVE_REFUSED', nativeStatus: 5, created: false })
  createEGDeskFileMount({ dataDir: '/unused', createNativeAdapter: () => ({ capability: 'descriptor-relative-create-only', createFile: async () => { throw failure } }), createHttpAdapter: options => { adapter = options.createOnlyAdapter; return {} } })
  await assert.rejects(adapter.createFile({}), e => e.code === 'TARGET_EXISTS' && e.details.created === false)
  failure = Object.assign(new Error('A partial new file may remain'), { code: 'EGDESK_NATIVE_TIMEOUT', created: null, fileMayExist: true })
  await assert.rejects(adapter.createFile({}), e => e.httpStatus === 504 && e.details.fileMayExist === true && e.details.created === null)
  failure = Object.assign(new Error('Native executable is unavailable'), { code: 'EGDESK_NATIVE_UNAVAILABLE', created: false, fileMayExist: false })
  await assert.rejects(adapter.createFile({}), e => e.httpStatus === 503 && e.details.created === false && e.details.fileMayExist === false)
})

async function fixture(t) {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'egdesk-file-mount-test-'))
  const root = path.join(temp, 'selected'); await mkdir(root)
  await writeFile(path.join(root, 'source.txt'), 'external original\n')
  const options = { dataDir: path.join(temp, 'app-data'), nativeExecutable: process.env.EGDESK_NATIVE_CREATE_BINARY }
  let mount = createEGDeskFileMount(options)
  t.after(async () => { await mount.close(); await rm(temp, { recursive: true, force: true }) })
  const call = async (operation, body = {}, headers = {}) => {
    const route = `/v1/files/${operation}`, res = response()
    assert.equal(await mount.handle(request(route, body, headers), res, new URL(`http://127.0.0.1:39218${route}`)), true)
    return res
  }
  // This is the actual privileged picker channel contract, not a path grant
  // injected through a renderer body or a Codex account.
  const channel = await call('picker/channel')
  assert.equal(channel.status, 200)
  const headers = { 'x-egdesk-picker-channel': channel.body.result.token }
  const begun = await call('picker/begin', { purpose: 'folder' }, headers)
  const selected = await call('picker/complete', { requestId: begun.body.result.requestId, absolutePath: root }, headers)
  const registered = await call('roots', { selectionId: selected.body.result.selectionId }, headers)
  assert.equal(registered.status, 200)
  const directoryId = registered.body.result.directoryId
  const listing = await call('list', { directoryId })
  const fileId = listing.body.result.entries.find(entry => entry.name === 'source.txt').id
  const created = await call('drafts/create', { fileId })
  assert.equal(created.status, 200)
  return { root, call, directoryId, draft: created.body.result, restart: async () => { await mount.close(); mount = createEGDeskFileMount(options) }, getMount: () => mount }
}

test('mounted file routes work offline, allow bounded large drafts, preserve local drafts across restart and retain origin guards', async t => {
  const h = await fixture(t)
  const text = 'Local editable working copy\n'.repeat(5000)
  assert.ok(Buffer.byteLength(text) > 65536)
  const updated = await h.call('drafts/update', { draftId: h.draft.id, expectedHead: h.draft.head, text, operationId: 'large-local-edit' })
  assert.equal(updated.status, 200)
  assert.equal(updated.body.result.text, text)
  assert.equal((await h.call('drafts/read', { draftId: h.draft.id, ownerScope: 'subscription-other' })).body.code, 'UNEXPECTED_FIELD')
  for (const headers of [{ origin: 'https://hostile.example' }, { origin: 'null' }, { 'sec-fetch-site': 'same-site' }]) {
    assert.equal((await h.call('drafts/read', { draftId: h.draft.id }, headers)).status, 403)
  }
  assert.equal((await h.call('picker/channel', {}, { 'sec-fetch-site': 'same-origin' })).status, 403)
  await h.restart()
  const restored = await h.call('drafts/read', { draftId: h.draft.id })
  assert.equal(restored.status, 200)
  assert.equal(restored.body.result.text, text)
  assert.equal(restored.body.result.head, updated.body.result.head)
  assert.equal(await h.getMount().handle(request('/chat/send', {}), response(), new URL('http://127.0.0.1:39218/chat/send')), false)
})

test('mounted HTTP Save As uses the actual native binary, preserves the original and rejects a collision', { skip: !process.env.EGDESK_NATIVE_CREATE_BINARY }, async t => {
  const h = await fixture(t)
  const text = 'Saved using the descriptor-bound native helper.\n'
  const updated = await h.call('drafts/update', { draftId: h.draft.id, expectedHead: h.draft.head, text, operationId: 'edit-native' })
  const body = { draftId: h.draft.id, expectedHead: updated.body.result.head, directoryId: h.directoryId, fileName: 'native-copy.txt', operationId: 'native-save' }
  const saved = await h.call('save-as', body)
  assert.equal(saved.status, 200)
  assert.equal(saved.body.result.mode, 'create-only-save-as')
  assert.equal(saved.body.result.originalUpdated, false)
  assert.equal(await readFile(path.join(h.root, 'native-copy.txt'), 'utf8'), text)
  assert.equal(await readFile(path.join(h.root, 'source.txt'), 'utf8'), 'external original\n')
  const collision = await h.call('save-as', { ...body, operationId: 'native-collision' })
  assert.equal(collision.status, 409)
  assert.equal(collision.body.code, 'TARGET_EXISTS')
  assert.equal(await readFile(path.join(h.root, 'native-copy.txt'), 'utf8'), text)
})

test('server mounts local file handler before generic/auth routes and checks Node before app state initialization', async () => {
  const source = await readFile(new URL('./codex-bridge-server.mjs', import.meta.url), 'utf8')
  const mount = source.indexOf('if (await localFiles.handle(req, res, url)) return')
  assert.ok(mount > source.indexOf('if (!guardBridgeRequest(req, BRIDGE_PORT))'))
  assert.ok(mount < source.indexOf("route === '/auth/start'"))
  assert.ok(mount < source.indexOf('if (await handleContextHttp'))
  assert.ok(mount < source.indexOf('if (await handleChatHttp'))
  assert.ok(mount < source.indexOf('await readJsonBody(req)'))
  assert.ok(source.indexOf('const nodeRuntime = requireEGDeskNodeRuntime()') < source.indexOf('const dataDir = appDataDirectory()'))
})
