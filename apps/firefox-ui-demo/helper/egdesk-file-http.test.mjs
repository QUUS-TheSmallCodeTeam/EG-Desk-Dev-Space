import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { Readable } from 'node:stream'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { createEGDeskFileHttpAdapter, EGDESK_FILE_ENDPOINTS, handleEGDeskFiles } from './egdesk-file-http.mjs'
import { createEGDeskFileMount } from './egdesk-file-mount.mjs'
import { CodexChatRuntime } from './codex-chat-runtime.mjs'
import { createEGDeskNativeCreateOnlyAdapter } from './egdesk-file-native.mjs'
import { createEGDeskFileServiceCallbacks, createEGDeskNativeFilePickers, EGDESK_FILE_CLIENT_ENDPOINTS } from '../overlay/resources/EGDeskFileView.sys.mjs'
import { execFileSync } from 'node:child_process'
import { openEGDeskProjectStore, normalizeProjectScripts, suggestProjectScripts, projectReconnectState } from './egdesk-project-store.mjs'
import { fileChangeFromCodex, fileChangeFromAcpDiff, fileChangeFromClaudeToolResult, fileChangesFromGitPatch, hunksToUnified, mergeTurnChanges, boundFileChanges, FILE_CHANGE_LIMITS } from './egdesk-file-change.mjs'
import { createEGDeskGitCheckpoint, EGDESK_CHECKPOINT_REF_PREFIX } from './egdesk-git-checkpoint.mjs'
import { fileDiffFromCodexChange } from '../overlay/resources/EGDeskDiffView.sys.mjs'

async function fixture(t, options = {}) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'egdesk-file-http-'))
  const root = path.join(temp, 'root')
  const draftDirectory = path.join(temp, 'drafts')
  await fs.mkdir(root)
  await fs.writeFile(path.join(root, 'source.txt'), 'external original\n')
  const resolveRootSelection = async ({ selectionId, ownerScope }) => {
    if (selectionId !== `selected-${ownerScope}`) throw new Error('Invalid picker grant')
    return root
  }
  // Provider contract fixture only; native descriptor prevention has its own
  // platform tests and is never replaced with this fixture in production.
  const createOnlyAdapter = options.createOnlyAdapter || { capability: 'descriptor-relative-create-only', async createFile({ rootPath, relativeDirectory, fileName, bytes }) {
    const file = await fs.open(path.join(rootPath, relativeDirectory, fileName), 'wx', 0o600)
    try { await file.writeFile(bytes); await file.sync(); const stat = await file.stat({ bigint: true }); return { created: true, sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length, dev: String(stat.dev), ino: String(stat.ino) } }
    finally { await file.close() }
  } }
  const adapter = createEGDeskFileHttpAdapter({ draftDirectory, localOwnerScope: 'owner-a', resolveRootSelection, createOnlyAdapter })
  t.after(async () => { await adapter.close(); await fs.rm(temp, { recursive: true, force: true }) })
  const dispatch = (operation, body, ownerScope = 'owner-a') => adapter.dispatch({ method: 'POST', pathname: EGDESK_FILE_ENDPOINTS[operation], body, ownerScope })
  const client = createEGDeskFileServiceCallbacks({ request: async (pathname, body) => (await adapter.dispatch({ method: 'POST', pathname, body, ownerScope: 'owner-a' })).body })
  return { root, draftDirectory, resolveRootSelection, adapter, dispatch, client }
}

const nativeBinary = process.env.EGDESK_NATIVE_CREATE_BINARY
const nativeTest = nativeBinary ? test : test.skip

const request = (route, body, headers = {}) => Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), {
  method: 'POST', url: route, headers: { host: '127.0.0.1:39218', 'content-type': 'application/json', ...headers }, socket: { remoteAddress: '127.0.0.1' },
})
const response = () => ({ writeHead(status, headers) { this.status = status; this.headers = headers }, end(body) { this.body = JSON.parse(body) } })

test('frozen UI/server endpoint map supports persisted working-copy flow and create-only Save As', async t => {
  // The read/save-default routes land backend-first; every shipped client
  // operation must retain its exact route while the UI wiring follows.
  for (const [name, route] of Object.entries(EGDESK_FILE_CLIENT_ENDPOINTS)) assert.equal(EGDESK_FILE_ENDPOINTS[name], route)
  assert.equal(EGDESK_FILE_ENDPOINTS.readRoomProjectDefault, '/v1/files/projects/room-default')
  assert.equal(EGDESK_FILE_ENDPOINTS.saveRoomProjectDefault, '/v1/files/projects/room-default/save')
  const { root, client, dispatch } = await fixture(t)
  const authorized = await client.registerRoot({ selectionId: 'selected-owner-a' })
  const listed = await client.listDirectory({ directoryId: authorized.directoryId })
  const fileId = listed.entries.find(entry => entry.name === 'source.txt').id
  const read = await client.readFile({ fileId })
  assert.equal(read.text, 'external original\n')
  const draft = await client.createDraft({ fileId })
  const updated = await client.updateDraft({ draftId: draft.id, expectedHead: draft.head, text: 'edited working copy\n', operationId: 'edit-1' })
  const saved = await client.saveDraft({ draftId: draft.id, expectedHead: updated.head, bufferRevision: updated.bufferRevision, operationId: 'save-1' })
  assert.equal(saved.receipt.originalUpdated, false)
  assert.equal((await client.diffDraft({ draftId: draft.id })).hunks.length, 1)
  const exported = await client.saveAs({ draftId: draft.id, expectedHead: saved.draft.head, directoryId: authorized.directoryId, fileName: 'copy.txt', operationId: 'export-1' })
  assert.equal(exported.mode, 'create-only-save-as')
  assert.equal(await fs.readFile(path.join(root, 'copy.txt'), 'utf8'), 'edited working copy\n')
  assert.equal(await fs.readFile(path.join(root, 'source.txt'), 'utf8'), 'external original\n')
  const collision = await dispatch('saveAs', { draftId: draft.id, expectedHead: saved.draft.head, directoryId: authorized.directoryId, fileName: 'source.txt', operationId: 'collision' })
  assert.equal(collision.status, 409)
  assert.equal(collision.body.code, 'TARGET_EXISTS')
})

test('owner-scoped roots and drafts reject cross-owner IDs and renderer paths', async t => {
  const { adapter, dispatch } = await fixture(t)
  const authorized = (await dispatch('registerRoot', { selectionId: 'selected-owner-a' })).body.result
  const listed = (await dispatch('listDirectory', { directoryId: authorized.directoryId })).body.result
  const fileId = listed.entries[0].id
  const draft = (await dispatch('createDraft', { fileId })).body.result
  assert.equal((await dispatch('listDirectory', { directoryId: authorized.directoryId }, 'owner-b')).status, 403)
  assert.equal((await dispatch('readFile', { fileId }, 'owner-b')).status, 403)
  assert.equal((await dispatch('readDraft', { draftId: draft.id }, 'owner-b')).status, 403)
  assert.equal((await dispatch('registerRoot', { selectionId: 'selected-owner-a', path: '/anything' })).body.code, 'UNEXPECTED_FIELD')
  assert.equal((await adapter.dispatch({ method: 'POST', pathname: EGDESK_FILE_ENDPOINTS.readDraft, body: { draftId: draft.id } })).status, 200)
  assert.equal((await adapter.dispatch({ method: 'GET', pathname: EGDESK_FILE_ENDPOINTS.readFile, ownerScope: 'owner-a' })).status, 405)
  assert.equal(await adapter.dispatch({ method: 'POST', pathname: '/chat/send', ownerScope: 'owner-a' }), null)
})

test('internal capture resolver enforces local owner and exact head without a public byte route', async t => {
  const { root, adapter, client, dispatch } = await fixture(t)
  const authorized = await client.registerRoot({ selectionId: 'selected-owner-a' })
  const listed = await client.listDirectory({ directoryId: authorized.directoryId })
  const fileId = listed.entries.find(entry => entry.name === 'source.txt').id
  const draft = await client.createDraft({ fileId })
  const edited = await client.updateDraft({ draftId: draft.id, expectedHead: draft.head, text: 'edited, not saved\n', operationId: 'capture-edit' })
  const captureRef = { fileId, draftId: draft.id, head: edited.head, revision: edited.bufferRevision }
  let guards = 0
  const source = await adapter.resolveCaptureSource({ ownerScope: 'owner-a', captureRef, assertActive: () => { guards++ } })
  assert.equal(guards, 3)
  assert.deepEqual(source.bytes, Buffer.from('edited, not saved\n'))
  assert.equal(source.mime, 'text/plain')
  assert.equal(source.name, 'source.txt')
  assert.equal(source.captureRef.head, edited.head)
  assert.equal(await fs.readFile(path.join(root, 'source.txt'), 'utf8'), 'external original\n')
  await assert.rejects(adapter.resolveCaptureSource({ ownerScope: 'owner-b', captureRef }), { code: 'OWNER_SCOPE_MISMATCH' })
  await assert.rejects(adapter.resolveCaptureSource({ captureRef }), { code: 'OWNER_SCOPE_MISMATCH' })
  await assert.rejects(adapter.resolveCaptureSource({ ownerScope: 'owner-a', captureRef: { ...captureRef, head: draft.head } }), { code: 'CAPTURE_STALE' })
  assert.equal((await adapter.dispatch({ method: 'POST', pathname: '/v1/files/drafts/capture', body: captureRef, ownerScope: 'owner-a' })).status, 404)
  assert.equal((await dispatch('readDraft', { draftId: draft.id })).body.result.text, 'edited, not saved\n')
})

test('HTTP handler preserves loopback guard and accepts bounded text beyond the generic bridge limit', async t => {
  const { adapter, client } = await fixture(t)
  const authorized = await client.registerRoot({ selectionId: 'selected-owner-a' })
  const listed = await client.listDirectory({ directoryId: authorized.directoryId })
  const draft = await client.createDraft({ fileId: listed.entries[0].id })
  const res = response()
  const text = 'editable text\n'.repeat(8000)
  await handleEGDeskFiles(request(EGDESK_FILE_ENDPOINTS.updateDraft, { draftId: draft.id, expectedHead: draft.head, text, operationId: 'large-edit' }), res, { adapter, ownerScope: 'owner-a' })
  assert.equal(res.status, 200)
  assert.equal(res.body.result.text, text)
  const blocked = response()
  await adapter.handle(request(EGDESK_FILE_ENDPOINTS.readDraft, { draftId: draft.id }, { origin: 'https://untrusted.example' }), blocked, { ownerScope: 'owner-a' })
  assert.equal(blocked.status, 403)
  const wrongType = response()
  await adapter.handle(request(EGDESK_FILE_ENDPOINTS.readDraft, { draftId: draft.id }, { 'content-type': 'text/plain' }), wrongType, { ownerScope: 'owner-a' })
  assert.equal(wrongType.status, 415)
  assert.equal(await adapter.handle(request('/other', {}), response(), { ownerScope: 'owner-a' }), false)
})

test('native picker callback wrapper forwards nonce headers through the real HTTP handler', async t => {
  const { root, adapter } = await fixture(t)
  const service = createEGDeskFileServiceCallbacks({ request: async (route, body, options) => {
    const headers = Object.fromEntries(Object.entries(options?.headers || {}).map(([key, value]) => [key.toLowerCase(), value]))
    const res = response()
    await adapter.handle(request(route, body, headers), res)
    return res.body
  } })
  const pickers = createEGDeskNativeFilePickers({ service, pickDirectory: async () => root, pickSaveFile: async () => ({ parentPath: root, fileName: 'copy.txt' }) })
  const chosen = await pickers.chooseRoot()
  assert.equal(chosen.name, 'root')
  assert.ok(chosen.directoryId)
  const destination = await pickers.chooseSaveAs({ defaultName: 'source.txt' })
  assert.equal(destination.fileName, 'copy.txt')
  assert.ok(destination.directoryId)
})

test('restart preserves draft and requires explicit matching-source reconnect', async t => {
  const { root, adapter, draftDirectory, resolveRootSelection, client } = await fixture(t)
  const authorized = await client.registerRoot({ selectionId: 'selected-owner-a' })
  const listed = await client.listDirectory({ directoryId: authorized.directoryId })
  const draft = await client.createDraft({ fileId: listed.entries[0].id })
  const latest = await client.updateDraft({ draftId: draft.id, expectedHead: draft.head, text: 'retained draft', operationId: 'retain' })
  await adapter.close()
  const reopened = createEGDeskFileHttpAdapter({ draftDirectory, localOwnerScope: 'owner-a', resolveRootSelection })
  const retained = await reopened.dispatch({ method: 'POST', pathname: EGDESK_FILE_ENDPOINTS.readDraft, body: { draftId: draft.id }, ownerScope: 'owner-a' })
  assert.equal(retained.body.result.text, latest.text)
  assert.equal(retained.body.result.sourceConnection, 'reconnect-required')
  const oldHandle = await reopened.dispatch({ method: 'POST', pathname: EGDESK_FILE_ENDPOINTS.readFile, body: { fileId: listed.entries[0].id }, ownerScope: 'owner-a' })
  assert.equal(oldHandle.body.code, 'UNKNOWN_RESOURCE')
  const call = (name, body) => reopened.dispatch({ method: 'POST', pathname: EGDESK_FILE_ENDPOINTS[name], body })
  const nextRoot = (await call('registerRoot', { selectionId: 'selected-owner-a' })).body.result
  const nextList = (await call('listDirectory', { directoryId: nextRoot.directoryId })).body.result
  const nextFile = nextList.entries[0].id
  await fs.writeFile(path.join(root, 'source.txt'), 'changed original')
  const conflict = await call('reconnectDraft', { draftId: draft.id, expectedHead: latest.head, fileId: nextFile, operationId: 'reconnect-conflict' })
  assert.equal(conflict.status, 409)
  assert.equal(conflict.body.code, 'SOURCE_RECONNECT_CONFLICT')
  assert.equal((await call('readDraft', { draftId: draft.id })).body.result.text, 'retained draft')
  await fs.writeFile(path.join(root, 'source.txt'), 'external original\n')
  const matched = await call('reconnectDraft', { draftId: draft.id, expectedHead: latest.head, fileId: nextFile, operationId: 'reconnect' })
  assert.equal(matched.status, 200)
  assert.equal(matched.body.result.draft.text, 'retained draft')
  assert.equal(matched.body.result.draft.fileId, nextFile)
  await reopened.close()
})

test('native picker handoff binds absent-header native transport to a nonce and one-use grants', async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'egdesk-picker-http-'))
  const root = path.join(temp, 'selected'); await fs.mkdir(root)
  let now = 100
  const adapter = createEGDeskFileHttpAdapter({ draftDirectory: path.join(temp, 'drafts'), now: () => now })
  t.after(async () => { await adapter.close(); await fs.rm(temp, { recursive: true, force: true }) })
  const call = async (operation, body, headers = {}) => {
    const res = response()
    await adapter.handle(request(EGDESK_FILE_ENDPOINTS[operation], body, headers), res)
    return res
  }
  for (const headers of [{ origin: 'null' }, { origin: 'chrome://browser' }, { origin: 'http://127.0.0.1:39218' }, { 'sec-fetch-site': 'same-origin' }, { 'sec-fetch-site': 'none' }]) assert.equal((await call('openPickerChannel', {}, headers)).status, 403)
  assert.equal((await call('beginPicker', {})).status, 403)
  const channel = await call('openPickerChannel', {})
  assert.equal(channel.status, 200)
  const nativeHeaders = { 'x-egdesk-picker-channel': channel.body.result.token }
  const began = await call('beginPicker', { purpose: 'folder' }, nativeHeaders)
  assert.equal(began.status, 200)
  const requestId = began.body.result.requestId
  const completed = await call('completePicker', { requestId, absolutePath: root }, nativeHeaders)
  assert.equal(completed.status, 200)
  assert.equal((await call('completePicker', { requestId, absolutePath: root }, nativeHeaders)).status, 409)
  const selected = await call('registerRoot', { selectionId: completed.body.result.selectionId }, nativeHeaders)
  assert.equal(selected.status, 200)
  assert.equal(selected.body.result.name, 'selected')
  assert.equal((await call('registerRoot', { selectionId: completed.body.result.selectionId }, nativeHeaders)).status, 409)
  const expiring = await call('beginPicker', {}, nativeHeaders)
  now += 120_001
  assert.equal((await call('completePicker', { requestId: expiring.body.result.requestId, absolutePath: root }, nativeHeaders)).status, 409)
  assert.equal((await call('registerRoot', { absolutePath: root })).body.code, 'UNEXPECTED_FIELD')
})

test('expired picker grant renews once with the same native selection, channel and purpose', async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'egdesk-picker-renew-'))
  const root = path.join(temp, 'selected'); await fs.mkdir(root)
  let now = Date.now()
  const adapter = createEGDeskFileHttpAdapter({ draftDirectory: path.join(temp, 'drafts'), now: () => now })
  t.after(async () => { await adapter.close(); await fs.rm(temp, { recursive: true, force: true }) })
  const calls = []
  const service = createEGDeskFileServiceCallbacks({ request: async (route, body, options) => {
    const headers = Object.fromEntries(Object.entries(options?.headers || {}).map(([key, value]) => [key.toLowerCase(), value]))
    calls.push({ route, body, channel: headers['x-egdesk-picker-channel'] })
    const res = response(); await adapter.handle(request(route, body, headers), res); return res.body
  } })
  let folderPickCount = 0
  let savePickCount = 0
  const pickers = createEGDeskNativeFilePickers({ service,
    pickDirectory: async () => { folderPickCount++; now += 120_001; return root },
    pickSaveFile: async () => { savePickCount++; now += 120_001; return { parentPath: root, fileName: 'user-chosen 사본.txt' } },
  })
  assert.equal((await pickers.chooseRoot()).displayPath, await fs.realpath(root))
  const target = await pickers.chooseSaveAs({ defaultName: 'suggested 사본.txt', createOnly: true })
  assert.equal(target.fileName, 'user-chosen 사본.txt')
  assert.equal(folderPickCount, 1)
  assert.equal(savePickCount, 1)
  const begins = calls.filter(call => call.route === EGDESK_FILE_ENDPOINTS.beginPicker)
  assert.deepEqual(begins.map(call => call.body.purpose), ['folder', 'folder', 'save-as-directory', 'save-as-directory'])
  assert.equal(new Set(begins.map(call => call.channel)).size, 1)
  const completions = calls.filter(call => call.route === EGDESK_FILE_ENDPOINTS.completePicker)
  assert.equal(completions.length, 4)
  assert.ok(completions.every(call => call.body.absolutePath === root))
  assert.equal(calls.filter(call => call.route === EGDESK_FILE_ENDPOINTS.openPickerChannel).length, 1)
})

test('expired native channel preserves the returned selection without reopening the OS picker or rebinding authority', async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'egdesk-picker-channel-expired-'))
  let now = Date.now()
  const adapter = createEGDeskFileHttpAdapter({ draftDirectory: path.join(temp, 'drafts'), now: () => now })
  t.after(async () => { await adapter.close(); await fs.rm(temp, { recursive: true, force: true }) })
  let channels = 0
  let nativeCalls = 0
  const service = createEGDeskFileServiceCallbacks({ request: async (route, body, options) => {
    if (route === EGDESK_FILE_ENDPOINTS.openPickerChannel) channels++
    const headers = Object.fromEntries(Object.entries(options?.headers || {}).map(([key, value]) => [key.toLowerCase(), value]))
    const res = response(); await adapter.handle(request(route, body, headers), res); return res.body
  } })
  const pickers = createEGDeskNativeFilePickers({ service, pickDirectory: async () => { nativeCalls++; now += 60 * 60_000 + 1; return temp } })
  await assert.rejects(pickers.chooseRoot(), cause => {
    assert.equal(cause.code, 'PICKER_CHANNEL_EXPIRED')
    assert.equal(cause.selectionPreserved, true)
    assert.deepEqual(cause.pickerSelection, { purpose: 'folder', picked: temp })
    return true
  })
  assert.equal(nativeCalls, 1)
  assert.equal(channels, 1)
})

nativeTest('actual native adapter through service and HTTP maps existing target to 409', async t => {
  const { root, client, dispatch } = await fixture(t, { createOnlyAdapter: createEGDeskNativeCreateOnlyAdapter({ executable: nativeBinary }) })
  const authorized = await client.registerRoot({ selectionId: 'selected-owner-a' })
  const listed = await client.listDirectory({ directoryId: authorized.directoryId })
  const draft = await client.createDraft({ fileId: listed.entries.find(entry => entry.name === 'source.txt').id })
  const input = { draftId: draft.id, expectedHead: draft.head, directoryId: authorized.directoryId, fileName: 'source.txt', operationId: 'native-collision' }
  const collision = await dispatch('saveAs', input)
  assert.equal(collision.status, 409)
  assert.equal(collision.body.code, 'TARGET_EXISTS')
  assert.deepEqual(collision.body.details, { targetName: 'source.txt', created: false, fileMayExist: false, originalUpdated: false, nativeCode: 'EGDESK_NATIVE_REFUSED', nativeStatus: 5, targetExists: true, recovery: 'choose-new-target' })
  assert.equal(await fs.readFile(path.join(root, 'source.txt'), 'utf8'), 'external original\n')
  const created = await dispatch('saveAs', { ...input, fileName: 'native 사본.txt', operationId: 'native-success' })
  assert.equal(created.status, 200)
  assert.equal(await fs.readFile(path.join(root, 'native 사본.txt'), 'utf8'), 'external original\n')
})

nativeTest('actual bounded native write failure preserves partial-file details through HTTP and UI callback', async t => {
  const wrapperDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'egdesk-http-native-limit-'))
  t.after(() => fs.rm(wrapperDirectory, { recursive: true, force: true }))
  const executable = path.join(wrapperDirectory, 'limited-native')
  await fs.writeFile(executable, '#!/bin/sh\nulimit -f 1\ntrap \'\' XFSZ\nexec "$EGDESK_NATIVE_CREATE_BINARY"\n', { mode: 0o700 })
  const { root, client, dispatch } = await fixture(t, { createOnlyAdapter: createEGDeskNativeCreateOnlyAdapter({ executable }) })
  const authorized = await client.registerRoot({ selectionId: 'selected-owner-a' })
  const listed = await client.listDirectory({ directoryId: authorized.directoryId })
  const draft = await client.createDraft({ fileId: listed.entries.find(entry => entry.name === 'source.txt').id })
  const text = 'Z'.repeat(4096)
  const changed = await client.updateDraft({ draftId: draft.id, expectedHead: draft.head, text, operationId: 'native-edit' })
  const input = { draftId: draft.id, expectedHead: changed.head, directoryId: authorized.directoryId, fileName: 'partial 사본.txt', operationId: 'native-partial' }
  const failed = await dispatch('saveAs', input)
  assert.equal(failed.status, 500)
  assert.equal(failed.body.code, 'SAVE_AS_INCOMPLETE')
  assert.deepEqual(failed.body.details, { targetName: 'partial 사본.txt', created: true, fileMayExist: true, originalUpdated: false, nativeCode: 'EGDESK_NATIVE_REFUSED', nativeStatus: 8, recovery: 'inspect-target-before-retry' })
  const partial = await fs.readFile(path.join(root, 'partial 사본.txt'))
  assert.ok(partial.length < Buffer.byteLength(text))
  assert.equal((await client.readDraft({ draftId: draft.id })).text, text)
  assert.equal(await fs.readFile(path.join(root, 'source.txt'), 'utf8'), 'external original\n')
  const packet = JSON.stringify(failed.body)
  for (const sensitive of [root, executable, nativeBinary, text]) assert.equal(packet.includes(sensitive), false)
  const ui = createEGDeskFileServiceCallbacks({ request: async () => failed.body })
  await assert.rejects(ui.saveAs(input), cause => {
    assert.equal(cause.code, 'SAVE_AS_INCOMPLETE')
    assert.deepEqual(cause.details, failed.body.details)
    return true
  })
  const retry = await dispatch('saveAs', { ...input, operationId: 'native-partial-retry' })
  assert.equal(retry.status, 409)
  assert.equal(retry.body.code, 'TARGET_EXISTS')
  assert.deepEqual(await fs.readFile(path.join(root, 'partial 사본.txt')), partial)
})

test('actual unavailable native adapter maps to 503 with no new-file claim or executable path leak', async t => {
  const missingDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'egdesk-http-native-missing-'))
  t.after(() => fs.rm(missingDirectory, { recursive: true, force: true }))
  const executable = path.join(missingDirectory, 'missing-executable')
  const { root, client, dispatch } = await fixture(t, { createOnlyAdapter: createEGDeskNativeCreateOnlyAdapter({ executable }) })
  const authorized = await client.registerRoot({ selectionId: 'selected-owner-a' })
  const listed = await client.listDirectory({ directoryId: authorized.directoryId })
  const draft = await client.createDraft({ fileId: listed.entries.find(entry => entry.name === 'source.txt').id })
  const failed = await dispatch('saveAs', { draftId: draft.id, expectedHead: draft.head, directoryId: authorized.directoryId, fileName: 'missing 사본.txt', operationId: 'native-unavailable' })
  assert.equal(failed.status, 503)
  assert.equal(failed.body.code, 'SAVE_AS_UNAVAILABLE')
  assert.equal(failed.body.details.created, false)
  assert.equal(failed.body.details.fileMayExist, false)
  assert.equal(failed.body.details.recovery, 'retry-when-available')
  assert.equal(JSON.stringify(failed.body).includes(executable), false)
  await assert.rejects(fs.stat(path.join(root, 'missing 사본.txt')), { code: 'ENOENT' })
})

test('uncertain native failure exposes only allowlisted outcome metadata', async t => {
  const createOnlyAdapter = { capability: 'descriptor-relative-create-only', async createFile() {
    throw Object.assign(new Error('secret-token /private/raw/native/path'), { code: 'EGDESK_NATIVE_TIMEOUT', created: null, fileMayExist: true, rawPath: '/private/raw/native/path', stderr: 'secret-token', dev: '123', ino: '456' })
  } }
  const { client, dispatch } = await fixture(t, { createOnlyAdapter })
  const authorized = await client.registerRoot({ selectionId: 'selected-owner-a' })
  const listed = await client.listDirectory({ directoryId: authorized.directoryId })
  const draft = await client.createDraft({ fileId: listed.entries.find(entry => entry.name === 'source.txt').id })
  const failed = await dispatch('saveAs', { draftId: draft.id, expectedHead: draft.head, directoryId: authorized.directoryId, fileName: 'uncertain.txt', operationId: 'uncertain' })
  assert.equal(failed.status, 500)
  assert.equal(failed.body.code, 'SAVE_AS_UNCERTAIN')
  assert.deepEqual(failed.body.details, { targetName: 'uncertain.txt', created: null, fileMayExist: true, originalUpdated: false, nativeCode: 'EGDESK_NATIVE_TIMEOUT', recovery: 'inspect-target-before-retry' })
  for (const sensitive of ['secret-token', '/private/raw/native/path', 'stderr', '123', '456']) assert.equal(JSON.stringify(failed.body).includes(sensitive), false)
})

test('git and content-search routes: bounded fields, opaque change ids, and git failures without paths or stderr', async t => {
  const { client, dispatch } = await fixture(t)
  const authorized = await client.registerRoot({ selectionId: 'selected-owner-a' })
  // The fixture root sits in os.tmpdir(); whatever git says about it, the route answers.
  const status = await client.gitStatus({ rootId: authorized.rootId })
  assert.equal(status.rootId, authorized.rootId)
  assert.equal(typeof status.isRepo, 'boolean')
  const found = await client.searchContents({ rootId: authorized.rootId, query: 'external', caseSensitive: false })
  assert.deepEqual(found.matches.map(match => [match.relativePath, match.lineNumber]), [['source.txt', 1]])
  assert.equal(typeof found.matches[0].fileId, 'string')
  assert.equal((await client.search({ rootId: authorized.rootId, query: 'source', includeIgnored: true })).matches.length, 1)
  const stale = await dispatch('gitFileDiff', { changeId: 'never-issued' })
  assert.deepEqual([stale.status, stale.body.code], [404, 'UNKNOWN_CHANGE'])
  const extra = await dispatch('gitChanges', { rootId: authorized.rootId, cwd: '/etc' })
  assert.deepEqual([extra.status, extra.body.code], [400, 'UNEXPECTED_FIELD'])
  const badId = await dispatch('gitFileDiff', { changeId: 'x'.repeat(513) })
  assert.deepEqual([badId.status, badId.body.code], [400, 'INVALID_ID'])
  const scope = await dispatch('gitChanges', { rootId: authorized.rootId, scope: 'turn' })
  assert.deepEqual([scope.status, scope.body.code], [400, 'UNSUPPORTED_SCOPE'])

  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'egdesk-file-http-git-'))
  const root = path.join(temp, 'root')
  await fs.mkdir(root)
  const slowGit = {
    status: async () => { throw Object.assign(new Error(`fatal: ${root} stderr detail`), { code: 'GIT_TIMEOUT' }) },
    changes: async () => { throw Object.assign(new Error(`fatal: ${root}`), { code: 'GIT_FAILED' }) },
    grep: async () => null, listFiles: async () => null,
  }
  const adapter = createEGDeskFileHttpAdapter({ draftDirectory: path.join(temp, 'drafts'), localOwnerScope: 'owner-g', resolveRootSelection: async () => root, gitReview: slowGit })
  t.after(async () => { await adapter.close(); await fs.rm(temp, { recursive: true, force: true }) })
  const call = (operation, body) => adapter.dispatch({ method: 'POST', pathname: EGDESK_FILE_ENDPOINTS[operation], body, ownerScope: 'owner-g' })
  const rootId = (await call('registerRoot', { selectionId: 'any' })).body.result.rootId
  const timedOut = await call('gitStatus', { rootId })
  assert.deepEqual([timedOut.status, timedOut.body.code], [504, 'GIT_TIMEOUT'])
  const failed = await call('gitChanges', { rootId })
  assert.deepEqual([failed.status, failed.body.code], [500, 'GIT_FAILED'])
  for (const body of [timedOut.body, failed.body]) assert.equal(JSON.stringify(body).includes(root), false)
})

// ---- 2-X: Board projects (D-X3), project commands (D-X6), original save and review routes ----

async function projectFixture(t, options = {}) {
  const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'egdesk-file-projects-')))
  const folders = { shop: path.join(temp, 'shop'), blog: path.join(temp, 'blog') }
  for (const folder of Object.values(folders)) await fs.mkdir(folder)
  await fs.writeFile(path.join(folders.shop, 'package.json'), JSON.stringify({ packageManager: 'pnpm@9.0.0', scripts: { test: 'node --test', build: 'tsc', start: 'node server.js', 'lint:fix': 'eslint --fix' } }))
  await fs.writeFile(path.join(folders.shop, 'app.js'), 'one\n')
  const draftDirectory = path.join(temp, 'drafts')
  const resolveRootSelection = async ({ selectionId }) => selectionId === 'cancel' ? null : folders[selectionId.replace('pick-', '')]
  const make = () => createEGDeskFileHttpAdapter({ draftDirectory, localOwnerScope: 'owner-p', resolveRootSelection, ...options })
  let adapter = make()
  t.after(async () => { await adapter.close(); await fs.rm(temp, { recursive: true, force: true }) })
  const call = (operation, body) => adapter.dispatch({ method: 'POST', pathname: EGDESK_FILE_ENDPOINTS[operation], body, ownerScope: 'owner-p' })
  return { temp, folders, draftDirectory, call, restart: async () => { await adapter.close(); adapter = make() }, adapter: () => adapter }
}

const observedRoomProject = view => ({ roomId: view.roomId, status: view.status, source: view.source,
  boardId: view.source === 'board' ? view.inheritance.boardId : null,
  projectId: view.project?.projectId ?? null, rootId: view.project?.rootId ?? null })

test('expected room project: adapter validates and snapshots only identity before any await', async t => {
  const calls = []
  const adapter = createEGDeskFileHttpAdapter({ storeForOwner: async () => { calls.push('drafts'); throw new Error('must not open') },
    projectStoreForOwner: async () => { calls.push('projects'); throw new Error('must not open') } })
  t.after(() => adapter.close())
  const connected = { roomId: 'r', status: 'connected', source: 'board', boardId: 'a', projectId: 'p', rootId: 'root' }
  const none = { roomId: 'r', status: 'none', source: null, boardId: null, projectId: null, rootId: null }
  const invalid = [null, false, [], {}, 'r', { ...none, source: 'board' }, { ...connected, status: 'unavailable' },
    { ...connected, source: 'request' }, { ...connected, source: 'room' }, { ...connected, boardId: null }]
  for (const key of Object.keys(connected)) {
    const missing = { ...connected }; delete missing[key]; invalid.push(missing)
    for (const value of ['', ' ', '\0', 'x'.repeat(513), 12, {}]) invalid.push({ ...connected, [key]: value })
  }
  for (const key of ['cwd', 'absolutePath', 'allowedRoots', 'ownerScope', 'permissions']) invalid.push({ ...connected, [key]: '/not-authority' })
  for (const expectedRoomProject of invalid) await assert.rejects(adapter.resolveProjectWorkspace({ roomId: 'r', expectedRoomProject }), { code: 'INVALID_EXPECTED_ROOM_PROJECT', httpStatus: 400 })
  await assert.rejects(adapter.resolveProjectWorkspace({ roomId: 'r', expectedRoomProject: connected, projectTarget: { boardId: 'a', projectId: 'p', rootId: 'root' } }), { code: 'INVALID_EXPECTED_ROOM_PROJECT', httpStatus: 400 })
  await assert.rejects(adapter.resolveProjectWorkspace({ roomId: 'other', expectedRoomProject: none }), { code: 'PROJECT_WORKSPACE_CHANGED', httpStatus: 409 })
  assert.deepEqual(calls, [])

  const h = await projectFixture(t)
  await h.call('attachProject', { roomId: 'r', selectionId: 'pick-shop' })
  const before = (await h.call('readRoomProjectDefault', { roomId: 'r' })).body.result
  const expectedRoomProject = observedRoomProject(before)
  const pending = h.adapter().resolveProjectWorkspace({ roomId: 'r', expectedRoomProject })
  Object.assign(expectedRoomProject, { rootId: 'mutated', roomId: 'other' })
  assert.equal((await pending).rootId, before.project.rootId, 'the direct backend boundary clones before opening either store')
})

test('expected room project: UI observation changed before first resolve refuses before fake provider or engine calls', async t => {
  for (const scenario of ['Board replaced', 'override attached', 'same project different source', 'same project different Board',
    'none to inheritance', 'none to override', 'override to none', 'root reconnected', 'folder replaced', 'other room']) await t.test(scenario, async t => {
    const h = await projectFixture(t)
    await h.call('attachProject', { boardId: 'a', selectionId: 'pick-shop' })
    const b = (await h.call('attachProject', { boardId: 'b', selectionId: scenario === 'same project different Board' ? 'pick-shop' : 'pick-blog' })).body.result
    const a = (await h.call('openProject', { boardId: 'a' })).body.result.project
    const save = (boardId, project) => h.call('saveRoomProjectDefault', { roomId: 'r', boardId, expectedProjectId: project.projectId, expectedRootId: project.rootId })
    if (scenario === 'override to none') await h.call('attachProject', { roomId: 'r', selectionId: 'pick-shop' })
    else if (!scenario.startsWith('none')) assert.equal((await save('a', a)).status, 200)
    const observed = (await h.call('readRoomProjectDefault', { roomId: 'r' })).body.result
    const expectedRoomProject = observedRoomProject(observed)
    if (scenario === 'Board replaced') await h.call('attachProject', { boardId: 'a', selectionId: 'pick-blog' })
    if (scenario === 'override attached' || scenario === 'none to override') await h.call('attachProject', { roomId: 'r', selectionId: 'pick-blog' })
    if (scenario === 'same project different source') await h.call('attachProject', { roomId: 'r', selectionId: 'pick-shop' })
    if (scenario === 'same project different Board') assert.equal((await save('b', b)).status, 200)
    if (scenario === 'none to inheritance') assert.equal((await save('a', a)).status, 200)
    if (scenario === 'override to none') await h.call('inheritRoomProject', { roomId: 'r' })
    if (scenario === 'root reconnected') await h.restart()
    if (scenario === 'folder replaced') { await fs.rename(h.folders.shop, `${h.folders.shop}-old`); await fs.mkdir(h.folders.shop) }
    if (scenario === 'other room') expectedRoomProject.roomId = 'another-room'
    const calls = [], prepared = []
    const runtime = new CodexChatRuntime({ request: async (...args) => { calls.push(args); assert.fail('stale observation must not reach fake execution') }, respond: () => {},
      resolveProjectWorkspace: args => h.adapter().resolveProjectWorkspace({ ...args, ownerScope: 'owner-p' }),
      toolProviders: [{ providerId: 'probe', specs: () => [], prepare: async () => { prepared.push(true) } }] })
    runtime.setConnection(true)
    await assert.rejects(runtime.send({ clientThreadId: 'r', message: 'Use what I observed', expectedRoomProject, cwd: '/never-fallback' }),
      { code: scenario === 'folder replaced' ? 'PROJECT_RECONNECT_REQUIRED' : 'PROJECT_WORKSPACE_CHANGED', httpStatus: 409, definite: true, dispatchStatus: 'rejected', resumeRequired: false })
    assert.deepEqual(calls, [])
    assert.deepEqual(prepared, [])
  })
})

test('expected room project: comparison never selects or saves and only omission retains legacy fallback', async t => {
  const h = await projectFixture(t)
  const a = (await h.call('attachProject', { boardId: 'a', selectionId: 'pick-shop' })).body.result
  const b = (await h.call('attachProject', { boardId: 'b', selectionId: 'pick-blog' })).body.result
  await h.call('saveRoomProjectDefault', { roomId: 'r', boardId: 'a', expectedProjectId: a.projectId, expectedRootId: a.rootId })
  const read = async roomId => (await h.call('readRoomProjectDefault', { roomId })).body.result
  const before = await read('r')
  const resolve = input => h.adapter().resolveProjectWorkspace({ roomId: 'r', ...input })
  const current = await resolve({ boardId: 'b', expectedRoomProject: observedRoomProject(before) })
  assert.deepEqual([current.projectId, current.boardId, current.source], [a.projectId, 'a', 'board'])
  assert.deepEqual(await read('r'), before)
  await h.call('saveRoomProjectDefault', { roomId: 'r', boardId: 'b', expectedProjectId: b.projectId, expectedRootId: b.rootId })
  await h.call('saveRoomProjectDefault', { roomId: 'r', boardId: 'a', expectedProjectId: a.projectId, expectedRootId: a.rootId })
  assert.equal((await resolve({ expectedRoomProject: observedRoomProject(before) })).projectId, a.projectId,
    'identity equality deliberately does not detect A-to-B-to-A history')
  const expectedNone = observedRoomProject(await read('plain'))
  assert.equal(await resolve({ roomId: 'plain', expectedRoomProject: expectedNone }), null)
  await assert.rejects(resolve({ roomId: 'plain', boardId: 'b', expectedRoomProject: expectedNone }), { code: 'PROJECT_WORKSPACE_CHANGED', httpStatus: 409 })
  assert.equal((await resolve({ roomId: 'plain', boardId: 'b' })).source, 'board', 'omission preserves the legacy Board hint')
  await h.call('detachProject', { boardId: 'a' })
  await assert.rejects(resolve({ expectedRoomProject: observedRoomProject(before) }), { code: 'PROJECT_INHERITANCE_UNAVAILABLE', httpStatus: 409 })
  assert.equal((await read('r')).status, 'unavailable', 'broken saved inheritance never becomes explicit none')
})

test('expected room project: observation and resolver recheck selection after connecting the folder', async t => {
  for (const phase of ['room-default view', 'workspace resolver']) await t.test(phase, async t => {
    let h, backing, change = false
    h = await projectFixture(t, { projectStoreForOwner: async ownerScope => {
      backing = await openEGDeskProjectStore({ directory: h.draftDirectory, ownerScope })
      return { ...backing, effective(scope) {
        const selected = backing.effective(scope)
        if (change) {
          change = false
          queueMicrotask(() => {
            const next = backing.forBoard('b')
            backing.attachToRoom({ roomId: 'r', workspaceRoot: next.workspaceRoot, identity: next.identity })
          })
        }
        return selected
      } }
    } })
    await h.call('attachProject', { roomId: 'r', selectionId: 'pick-shop' })
    await h.call('attachProject', { boardId: 'b', selectionId: 'pick-blog' })
    const before = (await h.call('readRoomProjectDefault', { roomId: 'r' })).body.result
    change = true
    if (phase === 'room-default view') {
      const result = await h.call('readRoomProjectDefault', { roomId: 'r' })
      assert.deepEqual([result.status, result.body.code], [409, 'PROJECT_WORKSPACE_CHANGED'])
      assert.equal(Object.hasOwn(result.body, 'result'), false)
    } else await assert.rejects(h.adapter().resolveProjectWorkspace({ roomId: 'r', expectedRoomProject: observedRoomProject(before) }), { code: 'PROJECT_WORKSPACE_CHANGED', httpStatus: 409 })
    assert.equal(change, false)
    assert.equal((await h.call('readRoomProjectDefault', { roomId: 'r' })).body.result.project.name, 'blog')
  })
})

test('room defaults: explicit request > override > saved inheritance > legacy, only absence descends and selection never saves', async t => {
  const h = await projectFixture(t)
  const a = (await h.call('attachProject', { boardId: 'a', selectionId: 'pick-shop' })).body.result
  const b = (await h.call('attachProject', { boardId: 'b', selectionId: 'pick-blog' })).body.result
  const save = await h.call('saveRoomProjectDefault', { roomId: 'r', boardId: 'a', expectedProjectId: a.projectId, expectedRootId: a.rootId })
  assert.equal(save.status, 200)
  assert.deepEqual(save.body.result.inheritance, { boardId: 'a' })
  assert.equal(save.body.result.override, null)
  const resolve = options => h.adapter().resolveProjectWorkspace({ ownerScope: 'owner-p', roomId: 'r', ...options })
  assert.equal((await resolve()).projectId, a.projectId)
  await h.call('attachProject', { roomId: 'r', selectionId: 'pick-blog' })
  assert.equal((await resolve()).projectId, b.projectId)
  const targetA = { boardId: 'a', projectId: a.projectId, rootId: a.rootId }
  assert.equal((await resolve({ projectTarget: targetA })).source, 'request')
  assert.equal((await resolve({ projectTarget: targetA })).projectId, a.projectId)
  assert.equal((await resolve()).projectId, b.projectId, 'clearing the request reveals the unchanged default')
  const before = (await h.call('readRoomProjectDefault', { roomId: 'r' })).body.result
  for (const target of [{ ...targetA, projectId: 'stale' }, { ...targetA, rootId: 'stale' }, { ...targetA, boardId: 'missing' }]) {
    await assert.rejects(resolve({ projectTarget: target }), { code: 'PROJECT_TARGET_CHANGED' })
  }
  assert.deepEqual((await h.call('readRoomProjectDefault', { roomId: 'r' })).body.result, before)
  await h.call('inheritRoomProject', { roomId: 'r' })
  assert.equal((await resolve({ boardId: 'b' })).projectId, a.projectId, 'saved inheritance outranks a legacy Board hint')
  await h.restart()
  assert.equal((await resolve()).projectId, a.projectId)
  assert.deepEqual((await h.call('readRoomProjectDefault', { roomId: 'r' })).body.result.inheritance, { boardId: 'a' })
  await h.call('detachProject', { boardId: 'a' })
  await assert.rejects(resolve({ boardId: 'b' }), { code: 'PROJECT_INHERITANCE_UNAVAILABLE' })
  assert.equal((await h.call('readRoomProjectDefault', { roomId: 'r' })).body.result.status, 'unavailable')
  const currentB = (await h.call('openProject', { boardId: 'b' })).body.result.project
  assert.equal((await resolve({ projectTarget: { boardId: 'b', projectId: b.projectId, rootId: currentB.rootId } })).projectId, b.projectId)
  assert.equal(await h.adapter().resolveProjectWorkspace({ ownerScope: 'owner-p', roomId: 'plain' }), null)
})

test('room defaults: Save validates expected IDs and filesystem identity, and atomic CAS preserves baseline/override on a race', async t => {
  const h = await projectFixture(t)
  const a = (await h.call('attachProject', { boardId: 'a', selectionId: 'pick-shop' })).body.result
  const b = (await h.call('attachProject', { boardId: 'b', selectionId: 'pick-blog' })).body.result
  await h.call('saveRoomProjectDefault', { roomId: 'r', boardId: 'b', expectedProjectId: b.projectId, expectedRootId: b.rootId })
  await h.call('attachProject', { roomId: 'r', selectionId: 'pick-shop' })
  const input = { roomId: 'r', boardId: 'a', expectedProjectId: a.projectId, expectedRootId: a.rootId }
  for (const body of [{ ...input, expectedProjectId: 'old' }, { ...input, expectedRootId: 'old' }]) assert.equal((await h.call('saveRoomProjectDefault', body)).body.code, 'PROJECT_TARGET_CHANGED')
  for (const body of [{ ...input, path: h.folders.shop }, { ...input, ownerScope: 'owner-p' }, { ...input, allowedRoots: [] }]) assert.equal((await h.call('saveRoomProjectDefault', body)).body.code, 'UNEXPECTED_FIELD')
  for (const key of Object.keys(input)) {
    const body = { ...input }; delete body[key]
    assert.equal((await h.call('saveRoomProjectDefault', body)).status, 400)
  }
  const store = await openEGDeskProjectStore({ directory: h.draftDirectory, ownerScope: 'owner-p' })
  t.after(() => store.close())
  const checked = store.forBoard('a')
  await h.call('attachProject', { boardId: 'a', selectionId: 'pick-blog' })
  assert.throws(() => store.saveRoomInheritance({ roomId: 'r', boardId: 'a', expectedProject: checked }), { code: 'PROJECT_TARGET_CHANGED' })
  assert.deepEqual(store.inheritanceForRoom('r'), { boardId: 'b' })
  assert.equal(store.forRoom('r').id, a.projectId)
  const fresh = (await h.call('openProject', { boardId: 'a' })).body.result.project
  await fs.rename(h.folders.blog, `${h.folders.blog}-old`); await fs.mkdir(h.folders.blog)
  assert.equal((await h.call('saveRoomProjectDefault', { ...input, expectedProjectId: fresh.projectId, expectedRootId: fresh.rootId })).body.code, 'PROJECT_RECONNECT_REQUIRED')
  assert.deepEqual(store.inheritanceForRoom('r'), { boardId: 'b' })
  assert.equal(store.forRoom('r').id, a.projectId)
})

test('project store schema: exact legacy schema upgrades additively; incomplete current and legacy schemas fail closed', async t => {
  const h = await projectFixture(t)
  await h.call('attachProject', { boardId: 'a', selectionId: 'pick-shop' })
  await h.adapter().close()
  const filename = path.join(h.draftDirectory, `projects-${createHash('sha256').update('owner-p').digest('hex')}.sqlite`)
  const db = new DatabaseSync(filename)
  db.exec('DROP TABLE room_project_inheritance; PRAGMA user_version=0;')
  db.close()
  const upgraded = await openEGDeskProjectStore({ directory: h.draftDirectory, ownerScope: 'owner-p' })
  assert.ok(upgraded.forBoard('a'))
  assert.equal(upgraded.inheritanceForRoom('r'), null, 'legacy room.boardId metadata is not inferred as a saved inheritance choice')
  upgraded.close()
  const broken = new DatabaseSync(filename)
  assert.equal(broken.prepare('PRAGMA user_version').get().user_version, 1)
  broken.exec('ALTER TABLE room_project_inheritance DROP COLUMN boardId;')
  broken.close()
  await assert.rejects(openEGDeskProjectStore({ directory: h.draftDirectory, ownerScope: 'owner-p' }), { code: 'PROJECT_STORE_CORRUPT' })
  const legacy = new DatabaseSync(filename)
  legacy.exec('DROP TABLE room_project_inheritance; DROP TABLE bindings; PRAGMA user_version=0;')
  legacy.close()
  await assert.rejects(openEGDeskProjectStore({ directory: h.draftDirectory, ownerScope: 'owner-p' }), { code: 'PROJECT_STORE_CORRUPT' })
  const kept = new DatabaseSync(filename)
  assert.equal(kept.prepare('SELECT count(*) AS n FROM projects').get().n, 1)
  assert.equal(kept.prepare('PRAGMA user_version').get().user_version, 0)
  kept.close()
})

test('room defaults: HTTP Save loses a last-moment association race without clearing the override or changing the saved source', async t => {
  let backing, h, race = false
  h = await projectFixture(t, { projectStoreForOwner: async ownerScope => {
    backing = await openEGDeskProjectStore({ directory: h.draftDirectory, ownerScope })
    return { ...backing, saveRoomInheritance(input) {
      if (race) {
        race = false
        const replacement = backing.forBoard('b')
        backing.attachToBoard({ boardId: 'a', workspaceRoot: replacement.workspaceRoot, identity: replacement.identity, title: replacement.title })
      }
      return backing.saveRoomInheritance(input)
    } }
  } })
  const a = (await h.call('attachProject', { boardId: 'a', selectionId: 'pick-shop' })).body.result
  const b = (await h.call('attachProject', { boardId: 'b', selectionId: 'pick-blog' })).body.result
  await h.call('saveRoomProjectDefault', { roomId: 'r', boardId: 'b', expectedProjectId: b.projectId, expectedRootId: b.rootId })
  await h.call('attachProject', { roomId: 'r', selectionId: 'pick-shop' })
  race = true
  const lost = await h.call('saveRoomProjectDefault', { roomId: 'r', boardId: 'a', expectedProjectId: a.projectId, expectedRootId: a.rootId })
  assert.deepEqual([lost.status, lost.body.code], [409, 'PROJECT_TARGET_CHANGED'])
  assert.deepEqual(backing.inheritanceForRoom('r'), { boardId: 'b' })
  assert.equal(backing.forRoom('r').id, a.projectId)
})

test('room defaults: changing the saved source while preparation awaits prevents all fake engine dispatch', async t => {
  const h = await projectFixture(t)
  const a = (await h.call('attachProject', { boardId: 'a', selectionId: 'pick-shop' })).body.result
  const b = (await h.call('attachProject', { boardId: 'b', selectionId: 'pick-blog' })).body.result
  const save = (boardId, project) => h.call('saveRoomProjectDefault', { roomId: 'r', boardId, expectedProjectId: project.projectId, expectedRootId: project.rootId })
  await save('a', a)
  const entered = Promise.withResolvers(), release = Promise.withResolvers(), calls = []
  const runtime = new CodexChatRuntime({ request: async (...args) => { calls.push(args); assert.fail('no fake native call expected') }, respond: () => {},
    resolveProjectWorkspace: args => h.adapter().resolveProjectWorkspace({ ...args, ownerScope: 'owner-p' }),
    toolProviders: [{ providerId: 'gate', specs: () => [], prepare: async () => { entered.resolve(); await release.promise } }] })
  runtime.setConnection(true)
  const pending = runtime.send({ clientThreadId: 'r', message: 'Prepare in A' })
  await entered.promise
  await save('b', b)
  release.resolve()
  await assert.rejects(pending, { code: 'PROJECT_WORKSPACE_CHANGED', definite: true })
  assert.deepEqual(calls, [])
})

test('run origin resolver: only current authorized connections qualify, never a saved-path registration or a replacement inode', async t => {
  const registrations = []
  const h = await projectFixture(t, { onRootRegistered: value => registrations.push(value) })
  const initial = (await h.call('attachProject', { boardId: 'a', selectionId: 'pick-shop' })).body.result
  const workspace = await h.adapter().resolveProjectWorkspace({ ownerScope: 'owner-p', boardId: 'a', roomId: 'r' })
  const origin = { project: { fileOwnerScope: 'owner-p', projectId: workspace.projectId, source: 'board', startCwd: workspace.absolutePath, fsIdentity: workspace.identity } }
  const read = async () => {
    const count = registrations.length
    const result = await h.adapter().resolveRunProjectOrigin({ ownerScope: 'owner-p', origin })
    assert.equal(registrations.length - count, 0, 'every origin reread registers zero roots')
    if (!result.verified) for (const key of ['rootId', 'directoryId', 'displayPath']) assert.equal(Object.hasOwn(result, key), false)
    return result
  }
  const expected = connection => ({ status: 'verified', verified: true, projectId: workspace.projectId, source: 'board',
    rootId: connection.rootId, directoryId: connection.directoryId, displayPath: connection.displayPath })
  assert.deepEqual(await read(), expected(initial))
  await assert.rejects(h.adapter().resolveRunProjectOrigin({ ownerScope: 'other', origin }), { code: 'OWNER_SCOPE_MISMATCH' })
  await assert.rejects(h.adapter().resolveRunProjectOrigin({ ownerScope: 'owner-p', origin: { project: { ...origin.project, fileOwnerScope: 'other' } } }), { code: 'PROJECT_ORIGIN_SCOPE_MISMATCH' })
  await h.restart()
  const count = registrations.length
  assert.equal((await read()).status, 'unavailable')
  assert.equal(registrations.length, count, 'origin reread itself never registers a saved path')
  const connected = (await h.call('openProject', { boardId: 'a' })).body.result.project
  assert.notEqual(connected.rootId, workspace.rootId)
  assert.notEqual(connected.directoryId, initial.directoryId)
  assert.deepEqual(await read(), expected(connected))
  const listing = (await h.call('listDirectory', { directoryId: connected.directoryId })).body.result
  assert.deepEqual(listing.entries.map(entry => entry.name), ['app.js', 'package.json'])
  const relative = (await h.call('resolvePath', { rootId: connected.rootId, path: 'app.js' })).body.result
  const absolute = (await h.call('resolvePath', { rootId: connected.rootId, path: path.join(connected.displayPath, 'app.js') })).body.result
  assert.deepEqual([relative.kind, relative.relativePath, absolute.kind, absolute.relativePath], ['file', 'app.js', 'file', 'app.js'])
  await h.call('detachProject', { boardId: 'a' })
  assert.equal((await read()).status, 'unavailable', 'a cached handle is not authorization after detach')
  const reattached = (await h.call('attachProject', { boardId: 'a', selectionId: 'pick-shop' })).body.result
  assert.deepEqual(await read(), expected(reattached))
  await fs.rename(h.folders.shop, `${h.folders.shop}-old`); await fs.mkdir(h.folders.shop)
  const beforeReplaced = registrations.length
  assert.equal((await read()).status, 'reconnect-required')
  assert.equal(registrations.length, beforeReplaced)
  await h.call('attachProject', { boardId: 'a', selectionId: 'pick-shop' })
  assert.equal((await read()).status, 'reconnect-required', 'same-path reauthorization cannot rewrite a past origin')
})

test('run origin resolver: detach after the filesystem await cannot release current root metadata', async t => {
  const registrations = []
  const h = await projectFixture(t, { onRootRegistered: value => registrations.push(value) })
  const selected = (await h.call('attachProject', { boardId: 'a', selectionId: 'pick-shop' })).body.result
  const store = await openEGDeskProjectStore({ directory: h.draftDirectory, ownerScope: 'owner-p' })
  t.after(() => store.close())
  const project = store.forBoard('a')
  const origin = { project: { fileOwnerScope: 'owner-p', projectId: selected.projectId, source: 'board', startCwd: project.workspaceRoot, fsIdentity: project.identity } }
  let checks = 0
  const count = registrations.length
  const result = await h.adapter().resolveRunProjectOrigin({ ownerScope: 'owner-p', origin, assertActive() {
    // The third account fence runs immediately after describeRoot's await.
    if (++checks === 3) store.detachBoard({ boardId: 'a' })
  } })
  assert.equal(checks, 3)
  assert.deepEqual(result, { status: 'unavailable', verified: false, reason: 'connection-required' })
  assert.equal(registrations.length - count, 0)
})

test('run origin resolver: production connection snapshot rejects metadata mismatch and replacement across its await', async t => {
  // Exercise only the actual resolver body with a gated fake filesystem. No
  // production injection hook, server, provider or root registration is added.
  const source = await fs.readFile(new URL('./egdesk-file-http.mjs', import.meta.url), 'utf8')
  const start = source.indexOf('  async function resolveRunProjectOrigin(')
  const end = source.indexOf('\n  async function close()', start)
  const sameFolder = source.match(/^  const sameFolder = .*$/m)?.[0]
  assert.ok(start >= 0 && end > start && sameFolder)
  for (const scenario of ['current', 'display-path-mismatch', 'connection-replaced', 'root-mutated', 'directory-mutated', 'display-mutated', 'authorization-removed']) await t.test(scenario, async () => {
    const entered = Promise.withResolvers(), release = Promise.withResolvers()
    const project = { id: 'project', workspaceRoot: '/authorized/current', identity: { dev: '1', ino: '2' } }
    const connection = { rootId: 'root-current', directoryId: 'directory-current', displayPath: project.workspaceRoot, capability: 'not-a-public-origin-field' }
    if (scenario === 'display-path-mismatch') connection.displayPath = '/different/authorized-looking-path'
    let current = project, registrations = 0
    const roots = new Map([[project.id, connection]])
    const service = {
      async describeRoot(rootId) {
        assert.equal(rootId, 'root-current')
        entered.resolve(); await release.promise
        return { rootId, absolutePath: project.workspaceRoot, identity: project.identity }
      },
      registerRoot() { registrations++; assert.fail('origin must never create authorization') },
    }
    const projects = { roots, store: { list: () => [project], get: () => current } }
    const resolve = vm.runInNewContext(`${sameFolder};\n(${source.slice(start, end)})`, {
      path, boundOwner: owner => owner, error: (code, message) => Object.assign(new Error(message), { code }),
      entryForOwner: async () => ({ service }), projectsForOwner: async () => projects,
    })
    const pending = resolve({ ownerScope: 'owner-p', origin: { project: { fileOwnerScope: 'owner-p', projectId: 'historic-project', source: 'room', startCwd: project.workspaceRoot, fsIdentity: project.identity } } })
    await entered.promise
    if (scenario === 'connection-replaced') roots.set(project.id, { ...connection })
    if (scenario === 'root-mutated') connection.rootId = 'root-new'
    if (scenario === 'directory-mutated') connection.directoryId = 'directory-new'
    if (scenario === 'display-mutated') connection.displayPath = '/new/path'
    if (scenario === 'authorization-removed') current = null
    release.resolve()
    const result = structuredClone(await pending)
    assert.deepEqual(result, scenario === 'current'
      ? { status: 'verified', verified: true, projectId: 'historic-project', source: 'room', rootId: 'root-current', directoryId: 'directory-current', displayPath: '/authorized/current' }
      : { status: 'unavailable', verified: false, reason: 'connection-required' })
    assert.equal(registrations, 0)
  })
})

test('Board project: attach by picker selection only, rooms inherit or own a folder, restart reconnects only the same dev/ino', async t => {
  const { folders, draftDirectory, call, restart, adapter } = await projectFixture(t)
  const noSelection = await call('attachProject', { boardId: 'board-1' })
  assert.deepEqual([noSelection.status, noSelection.body.code], [400, 'SELECTION_REQUIRED'])
  const byPath = await call('attachProject', { boardId: 'board-1', absolutePath: folders.shop })
  assert.deepEqual([byPath.status, byPath.body.code], [400, 'UNEXPECTED_FIELD'])
  const attached = (await call('attachProject', { boardId: 'board-1', selectionId: 'pick-shop', title: 'Shop' })).body.result
  assert.deepEqual([attached.status, attached.source, attached.title, attached.name, attached.displayPath], ['connected', 'board', 'Shop', 'shop', folders.shop])
  const listed = (await call('listDirectory', { directoryId: attached.directoryId })).body.result
  assert.deepEqual(listed.entries.map(entry => entry.name), ['app.js', 'package.json'])
  if (process.platform !== 'win32') {
    const database = (await fs.readdir(draftDirectory)).find(name => name.startsWith('projects-'))
    assert.equal((await fs.stat(path.join(draftDirectory, database))).mode & 0o777, 0o600)
  }

  const inRoom = (await call('openProject', { boardId: 'board-1', roomId: 'room-1' })).body.result
  assert.deepEqual([inRoom.source, inRoom.project.projectId, inRoom.project.rootId], ['board', attached.projectId, attached.rootId])
  const own = (await call('attachProject', { boardId: 'board-1', roomId: 'room-2', selectionId: 'pick-blog' })).body.result
  assert.deepEqual([own.source, own.name], ['room', 'blog'])
  assert.equal((await call('openProject', { boardId: 'board-1', roomId: 'room-2' })).body.result.project.name, 'blog')
  assert.equal((await call('openProject', { boardId: 'board-1', roomId: 'room-1' })).body.result.project.name, 'shop')
  assert.equal((await call('inheritRoomProject', { roomId: 'room-2' })).body.result.removed, true)
  assert.equal((await call('openProject', { boardId: 'board-1', roomId: 'room-2' })).body.result.project.name, 'shop')

  const workspace = await adapter().resolveProjectWorkspace({ ownerScope: 'owner-p', boardId: 'board-1', roomId: 'room-1' })
  assert.deepEqual([workspace.status, workspace.absolutePath, workspace.projectId, workspace.source], ['connected', folders.shop, attached.projectId, 'board'])
  await assert.rejects(adapter().resolveProjectWorkspace({ ownerScope: 'someone-else', boardId: 'board-1' }), { code: 'OWNER_SCOPE_MISMATCH' })
  assert.equal(await adapter().resolveProjectWorkspace({ ownerScope: 'owner-p', boardId: 'board-none' }), null)

  // Restart: the same folder (same dev/ino) reconnects by itself.
  await restart()
  const reopened = (await call('openProject', { boardId: 'board-1' })).body.result.project
  assert.equal(reopened.status, 'connected')
  assert.equal(reopened.projectId, attached.projectId)
  assert.notEqual(reopened.rootId, attached.rootId)
  assert.equal((await call('listDirectory', { directoryId: reopened.directoryId })).status, 200)

  // A different folder now at the same path is never adopted silently.
  await fs.rename(folders.shop, `${folders.shop}-old`)
  await fs.mkdir(folders.shop)
  await restart()
  const replaced = (await call('openProject', { boardId: 'board-1' })).body.result.project
  assert.deepEqual([replaced.status, replaced.reason, replaced.rootId], ['reconnect-required', 'identity-changed', undefined])
  assert.equal((await adapter().resolveProjectWorkspace({ ownerScope: 'owner-p', boardId: 'board-1' })).status, 'reconnect-required')
  const picked = (await call('attachProject', { boardId: 'board-1', selectionId: 'pick-shop' })).body.result
  assert.deepEqual([picked.projectId, picked.status], [attached.projectId, 'connected'])
  assert.deepEqual((await call('attachProject', { boardId: 'board-1', selectionId: 'cancel' })).body.result, { cancelled: true })
  assert.equal((await call('detachProject', { boardId: 'board-1' })).body.result.removed, true)
  assert.deepEqual((await call('openProject', { boardId: 'board-1' })).body.result, { project: null, source: null })
})

test('project workspace mount fixes local file owner and forwards only routing and identity conditions to the server resolver', async () => {
  const scopes = []
  const connected = { projectId: 'project-one', rootId: 'root-one', source: 'board', status: 'connected', absolutePath: '/verified/project' }
  let current = connected
  const mount = createEGDeskFileMount({ dataDir: path.join(os.tmpdir(), 'unused-project-mount'),
    createNativeAdapter: () => ({ capability: 'unavailable' }),
    createHttpAdapter: options => {
      assert.equal(options.localOwnerScope, 'egdesk-local')
      return { resolveProjectWorkspace: async scope => { scopes.push(scope); return current }, close: async () => {} }
    },
  })
  assert.equal(await mount.resolveProjectWorkspace({ boardId: 'board-1', roomId: 'room-1', ownerScope: 'ai-account', owner: 'ai-account', absolutePath: '/ui-path' }), connected)
  assert.deepEqual(scopes[0], { ownerScope: 'egdesk-local', boardId: 'board-1', roomId: 'room-1' })
  current = null
  assert.equal(await mount.resolveProjectWorkspace(), null)
  assert.deepEqual(scopes[1], { ownerScope: 'egdesk-local', boardId: null, roomId: null })
  current = { status: 'reconnect-required', projectId: 'project-one', source: 'board', reason: 'identity-changed' }
  assert.equal(await mount.resolveProjectWorkspace({ boardId: 'board-1' }), current)
  const expectedRoomProject = { roomId: 'room-1', status: 'none', source: null, boardId: null, projectId: null, rootId: null }
  await mount.resolveProjectWorkspace({ roomId: 'room-1', expectedRoomProject, ownerScope: 'ui-owner', cwd: '/ui-cwd', allowedRoots: ['/'] })
  assert.deepEqual(scopes.at(-1), { ownerScope: 'egdesk-local', boardId: null, roomId: 'room-1', expectedRoomProject })
  const projectTarget = { boardId: 'board-1', projectId: 'project-one', rootId: 'root-one' }
  await mount.resolveProjectWorkspace({ roomId: 'room-1', projectTarget })
  assert.deepEqual(scopes.at(-1), { ownerScope: 'egdesk-local', boardId: null, roomId: 'room-1', projectTarget })
  await mount.close()
})

test('project workspace chat integration: real room override and Board inheritance reach fake execution; replaced or missing folders block', async t => {
  const { folders, call, adapter, restart } = await projectFixture(t)
  await call('attachProject', { boardId: 'board-1', selectionId: 'pick-shop' })
  await call('attachProject', { boardId: 'board-1', roomId: 'room-own', selectionId: 'pick-blog' })
  const calls = []
  let threadCount = 0, turnCount = 0
  const chat = new CodexChatRuntime({
    resolveProjectWorkspace: scope => adapter().resolveProjectWorkspace({ ...scope, ownerScope: 'owner-p' }),
    request: async (method, params) => {
      calls.push({ method, params })
      if (method === 'thread/start') return { thread: { id: `native-${++threadCount}` }, cwd: params.cwd || '/legacy-default' }
      if (method === 'turn/start') return { turn: { id: `turn-${++turnCount}`, status: 'completed', items: [] } }
      throw new Error(`Unexpected fake call: ${method}`)
    }, respond: () => {},
  })
  chat.setConnection(true)
  const own = await chat.send({ clientThreadId: 'room-own', message: 'Use direct room project', cwd: '/untrusted-path' })
  assert.equal(calls.find(entry => entry.method === 'turn/start').params.cwd, folders.blog)
  await chat.send({ clientThreadId: 'room-inherit', boardId: 'board-1', message: 'Use Board project' })
  assert.equal(calls.filter(entry => entry.method === 'turn/start').at(-1).params.cwd, folders.shop)
  await chat.send({ clientThreadId: 'unassociated', message: 'Plain chat' })
  assert.equal(Object.hasOwn(calls.filter(entry => entry.method === 'turn/start').at(-1).params, 'cwd'), false)
  // Cached roots must verify the identity too, not just on helper restart.
  await fs.rename(folders.blog, `${folders.blog}-old`)
  await fs.mkdir(folders.blog)
  const beforeReplacement = calls.length
  await assert.rejects(chat.send({ clientThreadId: 'room-own', conversationId: own.conversationId, message: 'Do not use replacement', cwd: '/fallback' }), { code: 'PROJECT_RECONNECT_REQUIRED' })
  assert.equal(calls.length, beforeReplacement)
  await fs.rename(folders.shop, `${folders.shop}-moved`)
  await restart()
  await assert.rejects(chat.send({ clientThreadId: 'room-after-restart', boardId: 'board-1', message: 'Do not use missing folder' }), { code: 'PROJECT_RECONNECT_REQUIRED' })
  assert.equal(calls.length, beforeReplacement)
  assert.ok(calls.every(entry => !Object.hasOwn(entry.params, 'allowedRoots')))
})

test('project workspace chat integration: replacement during asynchronous preparation blocks fake execution', async t => {
  const { folders, call, adapter } = await projectFixture(t)
  await call('attachProject', { roomId: 'room-1', selectionId: 'pick-shop' })
  const entered = Promise.withResolvers(), released = Promise.withResolvers(), calls = []
  const chat = new CodexChatRuntime({
    resolveProjectWorkspace: scope => adapter().resolveProjectWorkspace({ ...scope, ownerScope: 'owner-p' }),
    request: async (method, params) => { calls.push({ method, params }); throw new Error('Replaced folder must never reach the engine') }, respond: () => {},
    toolProviders: [{ providerId: 'project-test', specs: () => [], prepare: async () => { entered.resolve(); await released.promise; return null } }],
  })
  chat.setConnection(true)
  const pending = chat.send({ clientThreadId: 'room-1', message: 'Prepare with selected project' })
  await entered.promise
  await fs.rename(folders.shop, `${folders.shop}-old`)
  await fs.mkdir(folders.shop)
  released.resolve()
  await assert.rejects(pending, { code: 'PROJECT_RECONNECT_REQUIRED', definite: true })
  assert.deepEqual(calls, [])
})

test('project commands are what the user typed; package.json scripts come back as suggestions only', async t => {
  const { call } = await projectFixture(t)
  const attached = (await call('attachProject', { boardId: 'board-1', selectionId: 'pick-shop' })).body.result
  const saved = (await call('setProjectScripts', { projectId: attached.projectId, scripts: [{ name: '테스트', command: '  pnpm run test  ', kind: 'test' }, { name: 'build', command: 'pnpm run build' }] })).body.result
  assert.deepEqual(saved.scripts, [{ id: 'script-1', name: '테스트', command: 'pnpm run test', kind: 'test' }, { id: 'script-2', name: 'build', command: 'pnpm run build', kind: 'build' }])
  for (const scripts of [[{ name: 'x', command: 'npm test\nrm -rf ~' }], [{ name: 'x', command: 'ok', kind: 'deploy' }], [{ name: 'x', command: 'ok', cwd: '/' }]]) {
    const refused = await call('setProjectScripts', { projectId: attached.projectId, scripts })
    assert.deepEqual([refused.status, refused.body.code], [400, 'INVALID_PROJECT_SCRIPT'])
  }
  const unknown = await call('setProjectScripts', { projectId: 'no-such-project', scripts: [] })
  assert.deepEqual([unknown.status, unknown.body.code], [404, 'UNKNOWN_PROJECT'])
  const suggestions = (await call('suggestProjectScripts', { projectId: attached.projectId })).body.result.suggestions
  assert.deepEqual(suggestions, [
    { name: 'test', command: 'pnpm run test', kind: 'test', suggested: true },
    { name: 'build', command: 'pnpm run build', kind: 'build', suggested: true },
    { name: 'lint:fix', command: 'pnpm run lint:fix', kind: 'lint', suggested: true },
  ])
  assert.equal((await call('openProject', { boardId: 'board-1' })).body.result.project.scripts.length, 2, 'suggestions are never saved')
  assert.deepEqual(suggestProjectScripts('{"scripts":{"test":"jest"}}'), [{ name: 'test', command: 'npm run test', kind: 'test', suggested: true }])
  assert.deepEqual(suggestProjectScripts('{"packageManager":"yarn@4","scripts":{"typecheck":"tsc"}}'), [{ name: 'typecheck', command: 'yarn typecheck', kind: 'typecheck', suggested: true }])
  assert.deepEqual(suggestProjectScripts('not json'), [])
  assert.deepEqual(normalizeProjectScripts([{ id: 'a', name: 'A', command: 'a' }, { id: 'a', name: 'B', command: 'b' }]).map(script => script.id), ['a', 'a-2'])
})

test('original save, review and resolve routes: conflicts are 409 with both hashes, paths outside the root are refused, text routes are bounded', async t => {
  const { root, client, dispatch, adapter } = await fixture(t)
  const authorized = await client.registerRoot({ selectionId: 'selected-owner-a' })
  const found = await client.resolvePath({ rootId: authorized.rootId, path: 'source.txt' })
  assert.deepEqual([found.kind, found.relativePath], ['file', 'source.txt'])
  const outside = await dispatch('resolvePath', { rootId: authorized.rootId, path: '../escape.txt' })
  assert.deepEqual([outside.status, outside.body.code], [400, 'NOT_IN_ROOT'])
  const draft = await client.createDraft({ fileId: found.id })
  const edited = await client.updateDraft({ draftId: draft.id, expectedHead: draft.head, text: 'saved through the route\n', operationId: 'e1' })
  const saved = await client.saveOriginal({ draftId: draft.id, expectedHead: edited.head, bufferRevision: edited.bufferRevision, operationId: 's1' })
  assert.equal(saved.receipt.originalUpdated, true)
  assert.equal(await fs.readFile(path.join(root, 'source.txt'), 'utf8'), 'saved through the route\n')
  const next = await client.updateDraft({ draftId: draft.id, expectedHead: saved.draft.head, text: 'second\n', operationId: 'e2' })
  await fs.writeFile(path.join(root, 'source.txt'), 'someone else\n')
  const conflict = await dispatch('saveOriginal', { draftId: draft.id, expectedHead: next.head, bufferRevision: next.bufferRevision, operationId: 's2' })
  assert.deepEqual([conflict.status, conflict.body.code], [409, 'SOURCE_CHANGED'])
  assert.equal(conflict.body.details.currentSourceHash, createHash('sha256').update('someone else\n').digest('hex'))
  assert.equal(JSON.stringify(conflict.body).includes(root), false)
  const current = await client.readFile({ fileId: found.id }).catch(error => error)
  // The external writer replaced the inode; the old handle is refused, not followed.
  assert.ok(current.code === 'RESOURCE_CHANGED' || current.text === 'someone else\n')
  const fresh = await client.resolvePath({ rootId: authorized.rootId, path: 'source.txt' })
  const disk = await client.readFile({ fileId: fresh.id })
  const wrongHash = await dispatch('revertReviewed', { fileId: fresh.id, expectedSha256: 'f'.repeat(64), text: 'x\n', operationId: 'r1' })
  assert.deepEqual([wrongHash.status, wrongHash.body.code], [409, 'SOURCE_CHANGED'])
  const big = 'y'.repeat(100 * 1024)
  const res = response()
  await handleEGDeskFiles(request(EGDESK_FILE_ENDPOINTS.revertReviewed, { fileId: fresh.id, expectedSha256: disk.sha256, text: big, operationId: 'r2' }), res, { adapter, ownerScope: 'owner-a' })
  assert.equal(res.status, 200)
  assert.equal((await fs.readFile(path.join(root, 'source.txt'), 'utf8')).length, big.length)
  const smallRoute = response()
  await handleEGDeskFiles(request(EGDESK_FILE_ENDPOINTS.saveOriginal, { draftId: draft.id, expectedHead: next.head, bufferRevision: 1, operationId: 'x'.repeat(100 * 1024) }), smallRoute, { adapter, ownerScope: 'owner-a' })
  assert.deepEqual([smallRoute.status, smallRoute.body.code], [413, 'BODY_TOO_LARGE'])
  const extra = await dispatch('deleteCreated', { fileId: fresh.id, expectedSha256: disk.sha256, operationId: 'd', force: true })
  assert.deepEqual([extra.status, extra.body.code], [400, 'UNEXPECTED_FIELD'])
})

test('project store: one project per folder identity, room overrides, replaced bindings drop unused projects', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'egdesk-project-store-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  let id = 0
  const store = await openEGDeskProjectStore({ directory, ownerScope: 'owner', now: () => 1000, makeId: () => `p${++id}` })
  t.after(() => store.close())
  const folderA = { workspaceRoot: '/work/a', identity: { dev: '1', ino: '10' } }
  const folderB = { workspaceRoot: '/work/b', identity: { dev: '1', ino: '20' } }
  const a = store.attachToBoard({ boardId: 'b1', ...folderA })
  assert.deepEqual(a, { id: 'p1', title: 'a', workspaceRoot: '/work/a', identity: { dev: '1', ino: '10' }, scripts: [], createdAt: 1000, updatedAt: 1000 })
  assert.equal(store.attachToBoard({ boardId: 'b2', ...folderA }).id, 'p1', 'the same folder is one project')
  store.setScripts({ projectId: 'p1', scripts: [{ name: 'test', command: 'npm test' }] })
  store.attachToRoom({ roomId: 'r1', boardId: 'b1', ...folderB })
  assert.deepEqual([store.effective({ boardId: 'b1', roomId: 'r1' }).source, store.effective({ boardId: 'b1', roomId: 'r1' }).project.id], ['room', 'p2'])
  assert.equal(store.effective({ boardId: 'b1', roomId: 'r9' }).project.id, 'p1')
  assert.deepEqual(store.effective({ boardId: 'none' }), { project: null, source: null })
  store.inheritRoom({ roomId: 'r1' })
  assert.deepEqual(store.list().map(project => project.id), ['p1'], 'a project no binding uses is dropped')
  const moved = store.attachToBoard({ boardId: 'b1', workspaceRoot: '/work/a', identity: { dev: '1', ino: '99' } })
  assert.deepEqual([moved.id, moved.identity.ino, moved.scripts.length], ['p1', '99', 1], 'picking the same path again keeps the project and its commands')
  assert.throws(() => store.attachToBoard({ boardId: 'b3', workspaceRoot: 'relative', identity: { dev: '1', ino: '1' } }), { code: 'INVALID_PROJECT_REQUEST' })
  assert.throws(() => store.attachToBoard({ boardId: 'b3', workspaceRoot: '/x', identity: { dev: 'x', ino: '1' } }), { code: 'INVALID_PROJECT_REQUEST' })
  const stat = kind => ({ dev: 1n, ino: 99n, isDirectory: () => kind === 'dir', isSymbolicLink: () => kind === 'link' })
  assert.equal(projectReconnectState(moved, stat('dir')), 'connected')
  assert.equal(projectReconnectState(moved, { ...stat('dir'), ino: 5n }), 'identity-changed')
  assert.equal(projectReconnectState(moved, stat('link')), 'not-a-directory')
  assert.equal(projectReconnectState(moved, null), 'missing')
  store.close()
  const reopened = await openEGDeskProjectStore({ directory, ownerScope: 'owner' })
  t.after(() => reopened.close())
  assert.equal(reopened.forBoard('b2').id, 'p1')
})

// ---- 2-X: one change shape for Codex, Claude, ACP and shell edits ----

test('file change shape: Codex, ACP, Claude tool results and git checkpoint patches read the same way', () => {
  assert.deepEqual(fileChangeFromCodex({ path: '/p/a.txt', kind: { type: 'update', move_path: '/p/b.txt' }, diff: '@@ -1 +1 @@\n-a\n+b\n' }),
    { path: '/p/a.txt', kind: 'update', movePath: '/p/b.txt', diff: '@@ -1 +1 @@\n-a\n+b\n', oldText: null, newText: null, source: 'codex', viaShell: false, omitted: null })
  assert.equal(fileChangeFromCodex({ path: '/p/n.txt', kind: 'add', diff: 'new\n' }).kind, 'add')
  assert.equal(fileChangeFromCodex({ kind: 'add' }), null)
  assert.deepEqual(fileChangeFromAcpDiff({ type: 'diff', path: '/p/x.txt', oldText: null, newText: 'x\n' }).kind, 'add')
  assert.deepEqual(fileChangeFromAcpDiff({ type: 'diff', path: '/p/x.txt', oldText: 'a\n', newText: 'b\n' }).kind, 'update')
  // jsdiff convention: a zero-line side stores the line after the change.
  assert.equal(hunksToUnified([{ oldStart: 3, oldLines: 0, newStart: 3, newLines: 1, lines: ['+inserted'] }]), '@@ -2,0 +3 @@\n+inserted\n')
  const edit = fileChangeFromClaudeToolResult('Edit', { file_path: '/p/a.txt', old_string: 'a', new_string: 'b' }, { filePath: '/p/a.txt', originalFile: 'a\n', structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] }] })
  assert.deepEqual([edit.kind, edit.diff, edit.oldText, edit.source], ['update', '@@ -1 +1 @@\n-a\n+b\n', 'a\n', 'claude'])
  assert.equal(fileDiffFromCodexChange(edit).added, 1, 'EGDeskDiffView reads the shared shape')
  const created = fileChangeFromClaudeToolResult('Write', { file_path: '/p/new.txt', content: 'hi\n' }, { type: 'create', filePath: '/p/new.txt', content: 'hi\n', originalFile: null })
  assert.deepEqual([created.kind, created.diff, created.newText], ['add', 'hi\n', 'hi\n'])
  assert.equal(fileChangeFromClaudeToolResult('Bash', {}, {}), null)

  const patch = [
    'diff --git a/src/app.js b/src/app.js', 'index 1..2 100644', '--- a/src/app.js', '+++ b/src/app.js', '@@ -1,2 +1,2 @@', ' keep', '-old', '+new',
    'diff --git a/made.txt b/made.txt', 'new file mode 100644', '--- /dev/null', '+++ b/made.txt', '@@ -0,0 +1,2 @@', '+one', '+two',
    'diff --git a/gone.txt b/gone.txt', 'deleted file mode 100644', '--- a/gone.txt', '+++ /dev/null', '@@ -1 +0,0 @@', '-bye', '\\ No newline at end of file',
    'diff --git a/old.txt b/renamed.txt', 'similarity index 100%', 'rename from old.txt', 'rename to renamed.txt',
    'diff --git a/logo.png b/logo.png', 'index 1..2 100644', 'Binary files a/logo.png and b/logo.png differ', '',
  ].join('\n')
  const changes = fileChangesFromGitPatch(patch)
  assert.deepEqual(changes.map(change => [change.path, change.kind, change.movePath, change.omitted]), [['src/app.js', 'update', null, null], ['made.txt', 'add', null, null], ['gone.txt', 'delete', null, null], ['old.txt', 'update', 'renamed.txt', null], ['logo.png', 'update', null, 'unavailable']])
  assert.equal(changes[0].diff, '@@ -1,2 +1,2 @@\n keep\n-old\n+new\n')
  assert.deepEqual([changes[1].newText, changes[2].oldText], ['one\ntwo\n', 'bye'])
  assert.ok(changes.every(change => change.viaShell && change.source === 'git'))

  const merged = mergeTurnChanges({ engine: [fileChangeFromCodex({ path: '/proj/src/app.js', kind: 'update', diff: '@@ -1 +1 @@\n-a\n+b\n' })], checkpoint: changes, root: '/proj/' })
  assert.deepEqual(merged.map(change => [change.path, change.source, change.viaShell]), [['/proj/src/app.js', 'codex', false], ['/proj/made.txt', 'git', true], ['/proj/gone.txt', 'git', true], ['/proj/old.txt', 'git', true], ['/proj/logo.png', 'git', true]])
  const bounded = boundFileChanges([{ path: 'big', kind: 'add', diff: 'x'.repeat(FILE_CHANGE_LIMITS.maxFileBytes + 1), omitted: null }, ...Array.from({ length: 5 }, (_, index) => ({ path: `f${index}`, kind: 'add', diff: 'y'.repeat(250 * 1024), omitted: null }))])
  assert.deepEqual(bounded.map(change => change.omitted), ['fileLimit', null, null, null, null, 'runLimit'])
  assert.equal(bounded[0].diff, null)
})

// ---- 2-X: git checkpoint (D-X4, off by default) ----

test('git checkpoint is off by default; when on it records turns under its own ref without touching the index, HEAD or files', async t => {
  const calls = []
  const off = createEGDeskGitCheckpoint({ execFile: (...args) => { calls.push(args); throw new Error('must not run') } })
  assert.equal(off.enabled, false)
  assert.deepEqual(await off.capture('/anywhere'), { enabled: false })
  assert.deepEqual(await off.diff('/anywhere', { fromRef: 'x', toRef: 'y' }), { enabled: false })
  assert.equal(calls.length, 0)

  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'egdesk-checkpoint-')))
  t.after(() => fs.rm(base, { recursive: true, force: true }))
  const home = path.join(base, 'home')
  await fs.mkdir(home)
  await fs.writeFile(path.join(home, 'gitconfig'), '')
  const env = { ...process.env, HOME: home, GIT_CONFIG_GLOBAL: path.join(home, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1', GIT_CEILING_DIRECTORIES: base }
  delete env.GIT_DIR; delete env.GIT_WORK_TREE; delete env.GIT_INDEX_FILE
  const repo = path.join(base, 'repo')
  await fs.mkdir(path.join(repo, 'app'), { recursive: true })
  const git = (...args) => execFileSync('git', args, { cwd: repo, env, encoding: 'utf8' })
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 'c@example.invalid'); git('config', 'user.name', 'C'); git('config', 'commit.gpgsign', 'false')
  await fs.writeFile(path.join(repo, 'app', 'a.txt'), 'one\n')
  await fs.writeFile(path.join(repo, 'outside.txt'), 'root file\n')
  git('add', '-A'); git('commit', '-qm', 'init')
  await fs.writeFile(path.join(repo, 'app', 'staged.txt'), 'user staged\n')
  git('add', 'app/staged.txt')
  const head = git('rev-parse', 'HEAD').trim()
  const statusBefore = git('status', '--porcelain=2')

  let n = 0
  const checkpoint = createEGDeskGitCheckpoint({ enabled: true, env, makeId: () => `turn-${++n}` })
  const project = path.join(repo, 'app')
  const start = await checkpoint.capture(project, { label: 'start' })
  assert.deepEqual([start.isRepo, start.ref], [true, `${EGDESK_CHECKPOINT_REF_PREFIX}turn-1`])
  // A shell command edits and creates files during the turn.
  await fs.writeFile(path.join(project, 'a.txt'), 'one\ntwo\n')
  await fs.writeFile(path.join(project, 'shell-made.txt'), 'made by a script\n')
  const end = await checkpoint.capture(project, { label: 'end' })
  const turn = await checkpoint.diff(project, { fromRef: start.ref, toRef: end.ref })
  assert.deepEqual(turn.files.map(file => [file.relativePath, file.additions, file.deletions]).sort(), [['a.txt', 1, 0], ['shell-made.txt', 1, 0]])
  assert.deepEqual(fileChangesFromGitPatch(turn.patch).map(change => [change.path, change.kind]).sort(), [['a.txt', 'update'], ['shell-made.txt', 'add']])
  assert.equal(git('rev-parse', 'HEAD').trim(), head)
  assert.equal(git('diff', '--cached', '--name-only').trim(), 'app/staged.txt', 'the user index keeps exactly what the user staged')
  assert.notEqual(git('status', '--porcelain=2'), '')
  assert.equal(statusBefore.includes('app/staged.txt'), true)
  assert.deepEqual((await fs.readdir(path.join(repo, '.git'))).filter(name => name.startsWith('egdesk-checkpoint-index')), [])
  await assert.rejects(checkpoint.diff(project, { fromRef: 'refs/heads/main', toRef: end.ref }), { code: 'INVALID_REF' })
  assert.equal((await checkpoint.remove(project, start.ref)).removed, true)
  assert.equal(git('for-each-ref', '--format=%(refname)', 'refs/egdesk/').trim(), end.ref)
  const outsideRepo = path.join(base, 'plain')
  await fs.mkdir(outsideRepo)
  assert.deepEqual(await checkpoint.capture(outsideRepo), { enabled: true, isRepo: false })
})

test('chooseProjectFolder attaches a Board folder through the native picker channel; a cancelled pick attaches nothing', async t => {
  const { root, adapter } = await fixture(t)
  const service = createEGDeskFileServiceCallbacks({ request: async (route, body, options) => {
    const headers = Object.fromEntries(Object.entries(options?.headers || {}).map(([key, value]) => [key.toLowerCase(), value]))
    const res = response()
    await adapter.handle(request(route, body, headers), res)
    return res.body
  } })
  let pick = root
  const pickers = createEGDeskNativeFilePickers({ service, pickDirectory: async () => pick })
  const project = await pickers.chooseProjectFolder({ boardId: 'board-n', title: '쇼핑몰' })
  assert.deepEqual([project.status, project.title, project.source], ['connected', '쇼핑몰', 'board'])
  assert.equal((await service.openProject({ boardId: 'board-n' })).project.projectId, project.projectId)
  pick = null
  assert.equal(await pickers.chooseProjectFolder({ boardId: 'board-m' }), null)
  assert.deepEqual(await service.openProject({ boardId: 'board-m' }), { project: null, source: null })
})
