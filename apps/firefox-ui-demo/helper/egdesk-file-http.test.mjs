import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { createHash } from 'node:crypto'
import { createEGDeskFileHttpAdapter, EGDESK_FILE_ENDPOINTS, handleEGDeskFiles } from './egdesk-file-http.mjs'
import { createEGDeskFileServiceCallbacks, createEGDeskNativeFilePickers, EGDESK_FILE_CLIENT_ENDPOINTS } from '../overlay/resources/EGDeskFileView.sys.mjs'

async function fixture(t) {
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
  const createOnlyAdapter = { capability: 'descriptor-relative-create-only', async createFile({ rootPath, relativeDirectory, fileName, bytes }) {
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

const request = (route, body, headers = {}) => Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), {
  method: 'POST', url: route, headers: { host: '127.0.0.1:39218', 'content-type': 'application/json', ...headers }, socket: { remoteAddress: '127.0.0.1' },
})
const response = () => ({ writeHead(status, headers) { this.status = status; this.headers = headers }, end(body) { this.body = JSON.parse(body) } })

test('frozen UI/server endpoint map supports persisted working-copy flow and create-only Save As', async t => {
  assert.deepEqual(EGDESK_FILE_CLIENT_ENDPOINTS, EGDESK_FILE_ENDPOINTS)
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
