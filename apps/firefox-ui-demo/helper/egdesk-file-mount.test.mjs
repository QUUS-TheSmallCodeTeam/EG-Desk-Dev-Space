import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { Readable } from 'node:stream'
import { createEGDeskFileMount, requireEGDeskNodeRuntime } from './egdesk-file-mount.mjs'
import { ImmutableContextStore } from './egdesk-context-store.mjs'
import { ContextRuntime } from './egdesk-context-runtime.mjs'
import { createContextHttpHandler } from './egdesk-context-http.mjs'

const request = (route, body, headers = {}) => Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), {
  method: 'POST', url: route, headers: { host: '127.0.0.1:39218', 'content-type': 'application/json', ...headers }, socket: { remoteAddress: '127.0.0.1' },
})
const response = () => ({ writeHead(status) { this.status = status }, end(text) { this.body = JSON.parse(text) } })

test('Windows starts managed files without advertising the unavailable POSIX Save As helper', async () => {
  let configuration
  createEGDeskFileMount({ dataDir: path.resolve('qa-not-created'), platform: 'win32',
    createHttpAdapter: options => { configuration = options; return {} } })
  assert.equal(configuration.createOnlyAdapter.capability, 'unavailable')
  await assert.rejects(configuration.createOnlyAdapter.createFile({}), error => error.code === 'EGDESK_NATIVE_UNAVAILABLE'
    && error.httpStatus === 503 && error.details.created === false && error.details.fileMayExist === false)
})

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
  let configuration, forwarded, resolved, closed = false, selectedNative
  const mount = createEGDeskFileMount({
    dataDir: '/app-owned-data', nativeExecutable: '/verified-native-binary',
    createNativeAdapter: options => { selectedNative = options; return { capability: 'descriptor-relative-create-only', createFile() {} } },
    createHttpAdapter: options => { configuration = options; return { handle: (...args) => { forwarded = args; return true }, resolveCaptureSource: async options => { resolved = options; return { bytes: Buffer.from('managed') } }, close: () => { closed = true } } },
  })
  assert.equal(configuration.draftDirectory, path.join('/app-owned-data', 'file-drafts'))
  assert.equal(configuration.localOwnerScope, 'egdesk-local')
  assert.equal(configuration.createOnlyAdapter.capability, 'descriptor-relative-create-only')
  assert.deepEqual(selectedNative, { executable: '/verified-native-binary' })
  const req = request('/v1/files/drafts/read', { draftId: 'local' }), res = response(), url = new URL('http://127.0.0.1:39218/v1/files/drafts/read')
  assert.equal(await mount.handle(req, res, url), true)
  assert.deepEqual(forwarded, [req, res, { url }])
  const captureRef = { fileId: 'file', draftId: 'draft', head: 'head', revision: 0 }
  const assertActive = () => {}
  await mount.managedFileView.resolveCaptureSource({ captureRef, assertActive })
  assert.deepEqual(resolved, { ownerScope: 'egdesk-local', captureRef, assertActive })
  await mount.close()
  assert.equal(closed, true)
})

test('project execution and run-origin mount callbacks pin file ownership and forward only server contract fields', async () => {
  const calls = []
  const mount = createEGDeskFileMount({ dataDir: '/unused', createNativeAdapter: () => ({ capability: 'unavailable' }),
    createHttpAdapter: () => ({
      resolveProjectWorkspace: async value => { calls.push(value); return null },
      resolveRunProjectOrigin: async value => { calls.push(value); return { status: 'unknown' } },
      close: async () => {},
    }) })
  const projectTarget = Object.freeze({ boardId: 'b', projectId: 'p', rootId: 'r' })
  await mount.resolveProjectWorkspace({ boardId: 'b', roomId: 'room', projectTarget, ownerScope: 'forged', cwd: '/forged', allowedRoots: ['/forged'] })
  assert.deepEqual(calls[0], { ownerScope: 'egdesk-local', boardId: 'b', roomId: 'room', projectTarget })
  const origin = { project: { fileOwnerScope: 'egdesk-local' } }, assertActive = () => {}
  await mount.resolveRunProjectOrigin({ origin, assertActive, ownerScope: 'forged', absolutePath: '/forged', rootId: 'forged' })
  assert.deepEqual(calls[1], { ownerScope: 'egdesk-local', origin, assertActive })
  await mount.close()
})

test('native create failures preserve collision and partial-file semantics through the mount', async () => {
  let adapter
  let failure = Object.assign(new Error('existing file'), { code: 'EGDESK_NATIVE_REFUSED', nativeStatus: 5, created: false })
  createEGDeskFileMount({ dataDir: '/unused', createNativeAdapter: () => ({ capability: 'descriptor-relative-create-only', createFile: async () => { throw failure } }), createHttpAdapter: options => { adapter = options.createOnlyAdapter; return {} } })
  await assert.rejects(adapter.createFile({}), e => e.code === 'TARGET_EXISTS' && e.details.created === false && e.details.fileMayExist === false)
  failure = Object.assign(new Error('reported collision but outcome is uncertain'), { code: 'EGDESK_NATIVE_REFUSED', nativeStatus: 5, created: false, fileMayExist: true })
  await assert.rejects(adapter.createFile({}), e => e.code === 'EGDESK_NATIVE_REFUSED' && e.details.fileMayExist === true)
  failure = Object.assign(new Error('A partial new file may remain'), { code: 'EGDESK_NATIVE_TIMEOUT', created: null, fileMayExist: true })
  await assert.rejects(adapter.createFile({}), e => e.httpStatus === 504 && e.details.fileMayExist === true && e.details.created === null)
  failure = Object.assign(new Error('Native executable is unavailable'), { code: 'EGDESK_NATIVE_UNAVAILABLE', created: false, fileMayExist: false })
  await assert.rejects(adapter.createFile({}), e => e.httpStatus === 503 && e.details.created === false && e.details.fileMayExist === false)
})

async function fixture(t, mountOptions = {}) {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'egdesk-file-mount-test-'))
  const root = path.join(temp, 'selected'); await mkdir(root)
  await writeFile(path.join(root, 'source.txt'), 'external original\n')
  const options = { dataDir: path.join(temp, 'app-data'), nativeExecutable: process.env.EGDESK_NATIVE_CREATE_BINARY, ...mountOptions }
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
  return { root, call, fileId, directoryId, draft: created.body.result, restart: async () => { await mount.close(); mount = createEGDeskFileMount(options) }, getMount: () => mount }
}

test('managed file view reads only local-owner, exact-head working-copy bytes', async t => {
  const h = await fixture(t)
  const view = h.getMount().managedFileView
  const selected = { fileId: h.fileId, draftId: h.draft.id, head: h.draft.head, revision: h.draft.bufferRevision }
  const resolve = captureRef => view.resolveCaptureSource({ captureRef, assertActive: () => {} })
  const first = await resolve(selected)
  assert.equal(first.bytes.toString(), 'external original\n')
  assert.equal(view.ownerScope, 'egdesk-local')
  assert.equal(first.mime, 'text/plain')
  await assert.rejects(resolve({ ...selected, ownerScope: 'another-account' }), e => e.code === 'INVALID_CAPTURE_REF')
  await assert.rejects(resolve({ ...selected, fileId: 'unselected-handle' }), e => e.code === 'CAPTURE_STALE')
  const updated = await h.call('drafts/update', { draftId: h.draft.id, expectedHead: h.draft.head, text: 'edited working copy', operationId: 'capture-head-test' })
  await assert.rejects(resolve(selected), e => e.code === 'CAPTURE_STALE')
  await assert.rejects(resolve({ ...selected, head: updated.body.result.head }), e => e.code === 'CAPTURE_STALE')
  const nextRef = { ...selected, head: updated.body.result.head, revision: updated.body.result.bufferRevision }
  const next = await resolve(nextRef)
  assert.equal(next.bytes.toString(), 'edited working copy')
  await h.restart()
  const restored = await h.getMount().managedFileView.resolveCaptureSource({ captureRef: nextRef, assertActive: () => {} })
  assert.equal(restored.bytes.toString(), 'edited working copy')
  assert.equal(await readFile(path.join(h.root, 'source.txt'), 'utf8'), 'external original\n')
})

test('mounted working copy enters batch context capture as immutable, account-owned evidence', async t => {
  const h = await fixture(t)
  const store = new ImmutableContextStore({ dataDir: path.join(path.dirname(h.root), 'context-data'), allowedRoots: [h.root], managedFileView: h.getMount().managedFileView })
  let owner = 'email:first@example.com'
  const context = new ContextRuntime({ store, reader: null, getOwnerKey: () => owner })
  const handle = createContextHttpHandler(context, async () => {})
  const post = async captureRef => {
    const res = response()
    const body = { clientThreadId: 'ui', attachments: [{ id: 'selected-file', kind: 'file', managedFileView: captureRef, captureScope: { type: 'file' } }] }
    await handle(request('/context/captures', body), res, new URL('http://127.0.0.1:39218/context/captures'))
    return res
  }
  const inspect = async sourceId => {
    const res = response()
    await handle({ method: 'GET' }, res, new URL(`http://127.0.0.1:39218/context/captures/${sourceId}`))
    return res
  }
  const initialRef = { fileId: h.fileId, draftId: h.draft.id, head: h.draft.head, revision: h.draft.bufferRevision }
  const first = await post(initialRef)
  assert.equal(first.status, 201)
  const original = first.body.captures[0]
  assert.equal(original.capture.coverage.provenance, 'managed-working-copy')
  assert.equal(original.sourceRef.revision, '0')
  assert.equal(original.sourceRef.path, undefined)
  assert.equal((await inspect(original.sourceId)).body.source.text, 'external original\n')
  const editedText = 'managed edit '.repeat(6000)
  assert.ok(Buffer.byteLength(editedText) > 64 * 1024)
  const updated = await h.call('drafts/update', { draftId: h.draft.id, expectedHead: h.draft.head, text: editedText, operationId: 'context-capture-edit' })
  const stale = await post(initialRef)
  assert.equal(stale.status, 409)
  assert.equal(stale.body.code, 'CAPTURE_STALE')
  const second = await post({ ...initialRef, head: updated.body.result.head, revision: updated.body.result.bufferRevision })
  assert.equal(second.status, 201)
  assert.equal(second.body.captures[0].sourceRef.revision, '1')
  assert.notEqual(second.body.captures[0].hash, original.hash)
  const oldView = await inspect(original.sourceId)
  assert.deepEqual(Object.keys(oldView.body).sort(), ['bindings', 'capture', 'delivered', 'source'])
  assert.equal(oldView.body.source.text, 'external original\n')
  assert.equal(oldView.body.delivered, null)
  assert.equal((await inspect(second.body.captures[0].sourceId)).body.source.text, editedText)
  owner = 'email:second@example.com'
  assert.equal((await inspect(original.sourceId)).status, 404)
})

test('mounted Save As returns a definitive 409 collision without file uncertainty', async t => {
  const nativeFailure = Object.assign(new Error('target already exists'), { code: 'EGDESK_NATIVE_REFUSED', nativeStatus: 5, created: false, fileMayExist: false })
  const h = await fixture(t, { createNativeAdapter: () => ({ capability: 'descriptor-relative-create-only', createFile: async () => { throw nativeFailure } }) })
  const result = await h.call('save-as', { draftId: h.draft.id, expectedHead: h.draft.head, directoryId: h.directoryId, fileName: 'source.txt', operationId: 'mounted-collision' })
  assert.equal(result.status, 409)
  assert.equal(result.body.code, 'TARGET_EXISTS')
  assert.equal(result.body.details.created, false)
  assert.equal(result.body.details.fileMayExist, false)
  assert.equal(result.body.details.originalUpdated, false)
  assert.equal(await readFile(path.join(h.root, 'source.txt'), 'utf8'), 'external original\n')
})

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

test('server mounts local file handler before generic/auth/context/chat/terminal routes and checks Node before app state initialization', async () => {
  const source = await readFile(new URL('./codex-bridge-server.mjs', import.meta.url), 'utf8')
  const marker = text => {
    const index = source.indexOf(text)
    assert.notEqual(index, -1, `missing server marker: ${text}`)
    return index
  }
  const mount = marker('if (await localFiles.handle(req, res, url)) return')
  assert.ok(marker('if (!guardBridgeRequest(req, BRIDGE_PORT))') < mount)
  for (const route of [
    'await readJsonBody(req,',
    "route === '/auth/start'",
    'if (await handleContextHttp(req, res, url)) return',
    'if (await handleChatHttp(req, res, url)) return',
    'if (await handleTerminalHttp(req, res, url)) return',
  ]) {
    assert.ok(mount < marker(route), `local file mount must precede ${route}`)
  }
  assert.ok(marker('const nodeRuntime = requireEGDeskNodeRuntime()') < marker('const dataDir = appDataDirectory()'))
})
