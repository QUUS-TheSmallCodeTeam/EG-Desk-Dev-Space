import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { createEGDeskFileService, DEFAULT_SEARCH_IGNORES, lineDiff } from './egdesk-file-service.mjs'
import { createEGDeskGitReview } from './egdesk-git-review.mjs'
import { createEGDeskFileView, createEGDeskGitStateIndex, EGDESK_GIT_STATE_LABELS, loadEGDeskFileViewPart, normalizeFileChangedEvent, parentFolderOf, suggestEGDeskCopyName } from '../overlay/resources/EGDeskFileView.sys.mjs'
import * as DiffView from '../overlay/resources/EGDeskDiffView.sys.mjs'
import * as RunResult from '../overlay/resources/EGDeskRunResult.sys.mjs'
import * as ChangeReview from '../overlay/resources/EGDeskChangeReview.mjs'
import * as TerminalState from '../overlay/resources/EGDeskTerminalState.sys.mjs'

function draftStore() {
  const records = new Map()
  return {
    records,
    async create(record) { assert.equal(records.has(record.id), false); records.set(record.id, structuredClone(record)) },
    async get(id) { return structuredClone(records.get(id) || null) },
    async compareAndSwap(id, expectedHead, next) {
      if (records.get(id)?.head !== expectedHead) throw Object.assign(new Error('conflict'), { code: 'DRAFT_CONFLICT' })
      records.set(id, structuredClone(next))
      return structuredClone(next)
    },
  }
}

// Test-only provider fixture. The native descriptor operation is supplied and
// verified by the platform integration; this fixture tests the service contract.
const createOnlyFixture = {
  capability: 'descriptor-relative-create-only',
  async createFile({ rootPath, relativeDirectory, fileName, bytes }) {
    const target = path.join(rootPath, relativeDirectory, fileName)
    const file = await fs.open(target, 'wx', 0o600)
    try { await file.writeFile(bytes); await file.sync(); const stat = await file.stat({ bigint: true }); return { created: true, sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length, dev: String(stat.dev), ino: String(stat.ino) } }
    finally { await file.close() }
  },
}

async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'egdesk-file-test-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const store = draftStore()
  const service = createEGDeskFileService({ draftStore: store, ...options })
  const rootHandle = await service.registerRoot(root)
  return { root, store, service, rootHandle }
}

async function fileId(service, directoryId, name) {
  const listed = await service.listDirectory({ directoryId })
  return listed.entries.find(entry => entry.name === name)?.id
}

test('opaque root handles, bounded listing/search, and symlinks never grant traversal', async t => {
  const { root, service, rootHandle } = await fixture(t)
  await fs.mkdir(path.join(root, 'folder'))
  await fs.writeFile(path.join(root, 'folder', 'needle.txt'), 'safe')
  await fs.writeFile(path.join(root, 'alpha.txt'), 'A')
  await fs.writeFile(path.join(root, 'beta.txt'), 'B')
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'egdesk-outside-'))
  t.after(() => fs.rm(outside, { recursive: true, force: true }))
  await fs.writeFile(path.join(outside, 'secret.txt'), 'secret')
  await fs.symlink(outside, path.join(root, 'outside-link'))
  const listed = await service.listDirectory({ directoryId: rootHandle.directoryId, limit: 1 })
  assert.equal(listed.entries.length, 1)
  assert.equal(listed.nextCursor, 1)
  const full = await service.listDirectory({ directoryId: rootHandle.directoryId })
  assert.equal(full.entries.find(entry => entry.name === 'outside-link').kind, 'blocked')
  assert.equal(full.entries.find(entry => entry.name === 'outside-link').id, undefined)
  const found = await service.search({ rootId: rootHandle.rootId, query: 'needle', limit: 1 })
  assert.equal(found.matches[0].relativePath, path.join('folder', 'needle.txt'))
  assert.equal(found.scope, 'names')
  assert.equal((await service.search({ rootId: rootHandle.rootId, query: 'secret' })).matches.length, 0)
  await assert.rejects(service.readFile({ fileId: '../../secret.txt' }), { code: 'UNKNOWN_RESOURCE' })
  await assert.rejects(service.listDirectory({ directoryId: rootHandle.directoryId, limit: 201 }), { code: 'INVALID_LIMIT' })
  await assert.rejects(service.registerRoot(path.join(root, 'outside-link')), { code: 'INVALID_ROOT' })
})

test('read returns exact bytes and hash, while binary and invalid UTF-8 stay non-editable', async t => {
  const { root, service, rootHandle } = await fixture(t)
  const textBytes = Buffer.from('한글\r\nline two\n', 'utf8')
  await fs.writeFile(path.join(root, 'text.txt'), textBytes)
  await fs.writeFile(path.join(root, 'binary.bin'), Buffer.from([0, 1, 2, 3]))
  await fs.writeFile(path.join(root, 'invalid.txt'), Buffer.from([0xc3, 0x28]))
  const textId = await fileId(service, rootHandle.directoryId, 'text.txt')
  const read = await service.readFile({ fileId: textId })
  assert.deepEqual(Buffer.from(read.bytesBase64, 'base64'), textBytes)
  assert.equal(read.sha256, createHash('sha256').update(textBytes).digest('hex'))
  assert.equal(read.text, textBytes.toString('utf8'))
  assert.equal(read.kind, 'text')
  for (const name of ['binary.bin', 'invalid.txt']) {
    const id = await fileId(service, rootHandle.directoryId, name)
    const result = await service.readFile({ fileId: id })
    assert.equal(result.kind, 'binary-or-invalid-utf8')
    assert.equal(result.text, null)
    await assert.rejects(service.createDraft({ fileId: id }), { code: 'UNSUPPORTED_EDIT' })
  }
  const bom = Buffer.from('\ufeff한글\r\n', 'utf8')
  await fs.writeFile(path.join(root, 'bom.txt'), bom)
  const bomId = await fileId(service, rootHandle.directoryId, 'bom.txt')
  const bomDraft = await service.createDraft({ fileId: bomId })
  assert.deepEqual(Buffer.from(bomDraft.text, 'utf8'), bom)
  await assert.rejects(service.updateDraft({ draftId: bomDraft.id, expectedHead: bomDraft.head, text: '\ud800', operationId: 'invalid-unicode' }), { code: 'INVALID_TEXT' })
})

test('managed expected-head save and diff never overwrite the external original', async t => {
  const { root, service, rootHandle } = await fixture(t)
  const original = path.join(root, 'work.txt')
  await fs.writeFile(original, 'first\nsecond\nthird\n')
  const id = await fileId(service, rootHandle.directoryId, 'work.txt')
  const opened = await service.createDraft({ fileId: id })
  const changed = await service.updateDraft({ draftId: opened.id, expectedHead: opened.head, text: 'first\nchanged\nthird\n', operationId: 'edit-1' })
  assert.equal(changed.bufferRevision, 1)
  const diff = await service.diffDraft({ draftId: opened.id })
  assert.deepEqual(diff.hunks, [{ baseStartLine: 2, baseLines: ['second'], currentStartLine: 2, currentLines: ['changed'] }])
  await assert.rejects(service.saveDraft({ draftId: opened.id, expectedHead: opened.head, bufferRevision: 1, operationId: 'old-save' }), { code: 'DRAFT_CONFLICT' })
  await assert.rejects(service.saveDraft({ draftId: opened.id, expectedHead: changed.head, bufferRevision: 0, operationId: 'wrong-buffer' }), { code: 'BUFFER_CONFLICT' })
  const saved = await service.saveDraft({ draftId: opened.id, expectedHead: changed.head, bufferRevision: 1, operationId: 'save-1' })
  assert.equal(saved.receipt.mode, 'managed-working-copy')
  assert.equal(saved.receipt.originalUpdated, false)
  assert.equal(saved.draft.savedRevision, 1)
  assert.equal(await fs.readFile(original, 'utf8'), 'first\nsecond\nthird\n')
  await fs.writeFile(original, 'external write')
  assert.equal((await service.sourceStatus({ draftId: opened.id })).status, 'changed')
  assert.equal((await service.readDraft({ draftId: opened.id })).text, 'first\nchanged\nthird\n')
  await fs.rm(original)
  assert.equal((await service.sourceStatus({ draftId: opened.id })).status, 'unavailable')
  assert.equal((await service.readDraft({ draftId: opened.id })).text, 'first\nchanged\nthird\n')
})

test('capture source resolves exact edited working-copy bytes without reading the original', async t => {
  const { root, service, rootHandle } = await fixture(t)
  const original = path.join(root, 'data.json')
  await fs.writeFile(original, '{"version":1}\n')
  const id = await fileId(service, rootHandle.directoryId, 'data.json')
  const opened = await service.createDraft({ fileId: id })
  const edited = await service.updateDraft({ draftId: opened.id, expectedHead: opened.head, text: '{"version":2}\n', operationId: 'edit-v2' })
  const ref = { fileId: id, draftId: edited.id, head: edited.head, revision: edited.bufferRevision }
  const captured = await service.resolveCaptureSource(ref)
  assert.deepEqual(captured.bytes, Buffer.from('{"version":2}\n'))
  assert.equal(captured.mime, 'application/json')
  assert.equal(captured.name, 'data.json')
  assert.equal(captured.sha256, createHash('sha256').update(captured.bytes).digest('hex'))
  assert.deepEqual(captured.captureRef, ref)
  assert.deepEqual(captured.location, { rootId: rootHandle.rootId, relativePath: 'data.json' })
  assert.equal(await fs.readFile(original, 'utf8'), '{"version":1}\n')
  await fs.rm(original)
  assert.deepEqual((await service.resolveCaptureSource(ref)).bytes, captured.bytes)
  await assert.rejects(service.resolveCaptureSource({ ...ref, path: original }), { code: 'INVALID_CAPTURE_REF' })
  await assert.rejects(service.resolveCaptureSource({ ...ref, fileId: 'other-file' }), { code: 'CAPTURE_STALE' })
  await assert.rejects(service.resolveCaptureSource({ ...ref, revision: ref.revision - 1 }), { code: 'CAPTURE_STALE' })
  const next = await service.updateDraft({ draftId: edited.id, expectedHead: edited.head, text: '{"version":3}\n', operationId: 'edit-v3' })
  await assert.rejects(service.resolveCaptureSource(ref), { code: 'CAPTURE_STALE' })
  assert.deepEqual((await service.resolveCaptureSource({ ...ref, head: next.head, revision: next.bufferRevision })).bytes, Buffer.from('{"version":3}\n'))
})

test('capture source location follows the registered file resource and is absent for a disconnected working copy', async t => {
  const { root, store, service, rootHandle } = await fixture(t, { gitReview: null })
  await fs.mkdir(path.join(root, 'notes'))
  const original = path.join(root, 'notes', '한글.md')
  await fs.writeFile(original, 'immutable working copy')
  const found = await service.search({ rootId: rootHandle.rootId, query: '한글' })
  const opened = await service.createDraft({ fileId: found.matches[0].id })
  const ref = { fileId: opened.fileId, draftId: opened.id, head: opened.head, revision: opened.bufferRevision }
  // A draft's retained rootId is not a grant to invent a connected location.
  store.records.get(opened.id).rootId = 'stale-draft-root'
  const captured = await service.resolveCaptureSource(ref)
  assert.deepEqual(captured.location, { rootId: rootHandle.rootId, relativePath: 'notes/한글.md' })
  await fs.rm(original)
  assert.deepEqual((await service.resolveCaptureSource(ref)).location, captured.location)
  const reopened = createEGDeskFileService({ draftStore: store })
  const disconnected = await reopened.resolveCaptureSource(ref)
  assert.equal(disconnected.location, undefined)
  assert.deepEqual(disconnected.bytes, captured.bytes)
  assert.equal(disconnected.sha256, captured.sha256)
  assert.ok(!JSON.stringify(disconnected).includes(root))
})

test('Save As delegates to the native provider contract and a collision retains the draft', async t => {
  const { root, service, rootHandle } = await fixture(t, { createOnlyAdapter: createOnlyFixture })
  await fs.writeFile(path.join(root, 'work.txt'), 'original')
  await fs.writeFile(path.join(root, 'taken.txt'), 'keep me')
  const id = await fileId(service, rootHandle.directoryId, 'work.txt')
  const draft = await service.createDraft({ fileId: id })
  const updated = await service.updateDraft({ draftId: draft.id, expectedHead: draft.head, text: 'draft body', operationId: 'edit-1' })
  for (const fileName of ['../escape.txt', '/absolute.txt', 'sub/file.txt']) {
    await assert.rejects(service.saveAs({ draftId: draft.id, expectedHead: updated.head, directoryId: rootHandle.directoryId, fileName, operationId: 'bad-path' }), { code: 'INVALID_NAME' })
  }
  await assert.rejects(service.saveAs({ draftId: draft.id, expectedHead: updated.head, directoryId: rootHandle.directoryId, fileName: 'taken.txt', operationId: 'collision' }), { code: 'TARGET_EXISTS' })
  assert.equal(await fs.readFile(path.join(root, 'taken.txt'), 'utf8'), 'keep me')
  const receipt = await service.saveAs({ draftId: draft.id, expectedHead: updated.head, directoryId: rootHandle.directoryId, fileName: 'copy.txt', operationId: 'save-as' })
  assert.equal(receipt.originalUpdated, false)
  assert.equal(receipt.sha256, createHash('sha256').update('draft body').digest('hex'))
  assert.equal(await fs.readFile(path.join(root, 'copy.txt'), 'utf8'), 'draft body')
  assert.equal(await fs.readFile(path.join(root, 'work.txt'), 'utf8'), 'original')
  assert.equal((await service.readDraft({ draftId: draft.id })).text, 'draft body')
  await assert.rejects(service.saveAs({ draftId: draft.id, expectedHead: updated.head, directoryId: rootHandle.directoryId, fileName: 'copy.txt', operationId: 'repeat' }), { code: 'TARGET_EXISTS' })
})

test('Save As without descriptor capability performs no path-based write', async t => {
  const { root, service, rootHandle } = await fixture(t)
  await fs.writeFile(path.join(root, 'source.txt'), 'source')
  const id = await fileId(service, rootHandle.directoryId, 'source.txt')
  const draft = await service.createDraft({ fileId: id })
  assert.equal(draft.saveAsAvailable, false)
  await assert.rejects(service.saveAs({ draftId: draft.id, expectedHead: draft.head, directoryId: rootHandle.directoryId, fileName: 'must-not-exist.txt', operationId: 'blocked' }), { code: 'SAVE_AS_UNAVAILABLE' })
  assert.deepEqual(await fs.readdir(root), ['source.txt'])
})

test('resource replacement invalidates old handle and oversized files are rejected', async t => {
  const { root, service, rootHandle } = await fixture(t)
  const target = path.join(root, 'one.txt')
  await fs.writeFile(target, 'one')
  const id = await fileId(service, rootHandle.directoryId, 'one.txt')
  await fs.rename(target, path.join(root, 'moved.txt'))
  await fs.writeFile(target, 'replacement')
  await assert.rejects(service.readFile({ fileId: id }), { code: 'RESOURCE_CHANGED' })
  const big = path.join(root, 'big.txt')
  await fs.writeFile(big, Buffer.alloc(8 * 1024 * 1024 + 1, 65))
  const bigId = await fileId(service, rootHandle.directoryId, 'big.txt')
  await assert.rejects(service.readFile({ fileId: bigId }), { code: 'FILE_TOO_LARGE' })
})

// Small DOM stand-in for event bubbling, focus and close persistence. This is
// interaction regression coverage; native Firefox rendering is checked centrally.
class Element {
  constructor(document, tagName) { this.ownerDocument = document; this.tagName = tagName; this.children = []; this.attributes = {}; this.listeners = new Map(); this.dataset = {}; this.hidden = false; this.value = ''; this.scrollTop = 0; this.parentElement = null; this.className = '' }
  set textContent(value) { this.text = String(value); this.children = [] }
  get textContent() { return (this.text || '') + this.children.map(child => child.textContent).join('') }
  append(...children) { for (const child of children) { child.parentElement = this; this.children.push(child) } }
  replaceChildren(...children) { for (const child of this.children) child.parentElement = null; this.children = []; this.text = ''; this.append(...children) }
  remove() { if (this.parentElement) { this.parentElement.children = this.parentElement.children.filter(child => child !== this); this.parentElement = null } }
  setAttribute(name, value) { this.attributes[name] = String(value) }
  getAttribute(name) { return this.attributes[name] ?? null }
  addEventListener(name, listener) { if (!this.listeners.has(name)) this.listeners.set(name, []); this.listeners.get(name).push(listener) }
  matches(selector) {
    if (selector === '[hidden]') return this.hidden
    const role = /^\[role="([^"]+)"\]$/.exec(selector)
    if (role) return this.getAttribute('role') === role[1]
    if (selector.startsWith('.')) return this.className.split(' ').includes(selector.slice(1))
    return this.tagName === selector
  }
  closest(selector) { for (let item = this; item; item = item.parentElement) if (item.matches(selector)) return item; return null }
  querySelectorAll(selector) { return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]) }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null }
  contains(element) { for (let item = element; item; item = item.parentElement) if (item === this) return true; return false }
  focus() { this.ownerDocument.activeElement = this }
  fire(type, properties = {}) {
    const event = { type, target: this, defaultPrevented: false, stopped: false, preventDefault() { this.defaultPrevented = true }, stopPropagation() { this.stopped = true }, ...properties }
    for (let item = this; item; item = item.parentElement) {
      for (const listener of item.listeners.get(type) || []) listener(event)
      if (event.stopped) break
    }
    return event
  }
  click() { this.fire('click') }
}
const fakeDocument = () => {
  const document = { activeElement: null, createElement(tag) { return new Element(document, tag) } }
  document.body = document.createElement('body')
  return document
}
const nextTurn = () => new Promise(resolve => setImmediate(resolve))
function uiFixture(overrides = {}, viewOptions = {}) {
  let current = { id: 'draft', fileId: 'file', name: 'source.txt', head: 'h0', text: 'start', baseText: 'start', bufferRevision: 0, savedRevision: 0, sourceHash: 'a'.repeat(64), sourceRevision: 'source-0' }
  const writes = []
  const service = {
    listDirectory: async ({ directoryId }) => ({ entries: directoryId === 'root-dir' ? [{ id: 'sub-dir', name: 'folder', kind: 'directory' }] : [{ id: 'file', name: 'source.txt', kind: 'file' }], nextCursor: null }),
    search: async () => ({ matches: [], truncated: false }),
    readFile: async () => ({ name: 'source.txt', size: 5, sha256: 'a'.repeat(64), diskRevision: 'source-0', kind: 'text', text: 'start' }),
    createDraft: async () => ({ ...current }), readDraft: async () => ({ ...current }),
    updateDraft: async ({ text }) => { writes.push(text); current = { ...current, text, head: `h${writes.length}`, bufferRevision: writes.length }; return { ...current } },
    saveDraft: async () => ({ draft: { ...current, savedRevision: current.bufferRevision }, receipt: { savedRevision: current.bufferRevision } }),
    saveAs: async () => ({}), diffDraft: async () => ({ bufferRevision: current.bufferRevision, hunks: [] }), ...overrides,
  }
  const document = fakeDocument()
  const view = createEGDeskFileView({ document, service, ...viewOptions })
  document.body.append(view.element)
  return { view, document, writes }
}

test('nested FileView click opens file without toggling ancestor directory', async () => {
  const { view, document } = uiFixture()
  await view.openRoot({ rootId: 'root', directoryId: 'root-dir', name: 'Project' })
  const folder = view.element.querySelector('[role="treeitem"]')
  folder.click(); await nextTurn()
  assert.equal(folder.getAttribute('aria-expanded'), 'true')
  const file = folder.querySelector('[role="treeitem"]')
  file.click(); await nextTurn()
  assert.equal(folder.getAttribute('aria-expanded'), 'true')
  assert.equal(view.snapshot().fileId, 'file')
  assert.equal(document.activeElement, view.element.querySelector('textarea'))
  assert.equal(view.element.querySelector('.egdesk-file-meta').parentElement.tagName, 'details')
  await view.close()
})

test('passive draft restoration keeps focus and close persists pending text before removal', async () => {
  const { view, document, writes } = uiFixture()
  const previousFocus = document.createElement('button')
  document.body.append(previousFocus)
  previousFocus.focus()
  await view.restoreDraft({ fileId: 'file', draftId: 'draft' })
  assert.equal(document.activeElement, previousFocus)
  const editor = view.element.querySelector('textarea')
  editor.value = 'last characters before close'
  editor.fire('input')
  assert.equal(await view.close(), true)
  assert.deepEqual(writes, ['last characters before close'])
  assert.equal(view.element.parentElement, null)
})

test('failed close keeps the editor and newest local text available', async () => {
  let failWrite = true
  const { view } = uiFixture({ updateDraft: async ({ text }) => {
    if (failWrite) throw new Error('Temporary store failure')
    return { id: 'draft', fileId: 'file', head: 'h1', text, bufferRevision: 1, savedRevision: 0 }
  } })
  await view.openFile('file')
  const editor = view.element.querySelector('textarea')
  editor.value = 'keep the newest characters'; editor.fire('input')
  assert.equal(await view.close(), false)
  assert.notEqual(view.element.parentElement, null)
  assert.equal(editor.value, 'keep the newest characters')
  failWrite = false
  assert.equal(await view.close(), true)
})

test('FileView capture reference flushes latest unsaved text, but never captures active IME composition', async () => {
  const { view, writes } = uiFixture()
  await view.openFile('file')
  const editor = view.element.querySelector('textarea')
  editor.value = '최신 작업사본'; editor.fire('input')
  const ref = await view.captureRef()
  assert.deepEqual(ref, { fileId: 'file', draftId: 'draft', head: 'h1', revision: 1 })
  assert.deepEqual(writes, ['최신 작업사본'])
  assert.equal(view.snapshot().savedRevision, 0)
  editor.fire('compositionstart'); editor.value = '최신 작업사본 + 조합'; editor.fire('input')
  await assert.rejects(view.captureRef(), { code: 'CAPTURE_COMPOSING' })
  assert.deepEqual(writes, ['최신 작업사본'])
  assert.equal(editor.value, '최신 작업사본 + 조합')
  editor.fire('compositionend')
  assert.deepEqual(await view.captureRef(), { fileId: 'file', draftId: 'draft', head: 'h2', revision: 2 })
  await view.close()
})

test('FileView capture rejects intervening typing and a stale store head without discarding text', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let releaseWrite
  const writePending = new Promise(resolve => { releaseWrite = resolve })
  let writes = 0
  let record = { id: 'draft', fileId: 'file', head: 'h0', text: 'start', bufferRevision: 0, savedRevision: 0 }
  const { view } = uiFixture({
    createDraft: async () => ({ ...record }),
    readDraft: async () => ({ ...record }),
    updateDraft: async ({ text }) => {
      writes++
      if (writes === 1) await writePending
      record = { ...record, text, head: `h${writes}`, bufferRevision: writes }
      return { ...record }
    },
  })
  await view.openFile('file')
  const editor = view.element.querySelector('textarea')
  editor.value = 'typed first'; editor.fire('input')
  const capturing = view.captureRef()
  editor.value = 'typed latest'; editor.fire('input')
  releaseWrite()
  await assert.rejects(capturing, { code: 'CAPTURE_STALE' })
  assert.equal(editor.value, 'typed latest')
  assert.equal(record.text, 'typed latest')
  assert.deepEqual(await view.captureRef(), { fileId: 'file', draftId: 'draft', head: 'h2', revision: 2 })
  record = { ...record, head: 'external-head' }
  await assert.rejects(view.captureRef(), { code: 'CAPTURE_STALE' })
  assert.equal(editor.value, 'typed latest')
  await view.close()
})

test('reordered draft responses cannot redirect a B edit to A', async () => {
  let resolveA
  const edits = []
  const { view } = uiFixture({
    readFile: async ({ fileId }) => ({ name: `${fileId}.txt`, size: 1, sha256: 'a'.repeat(64), diskRevision: fileId, kind: 'text' }),
    createDraft: ({ fileId }) => fileId === 'A' ? new Promise(resolve => { resolveA = resolve }) : Promise.resolve({ id: 'draft-B', fileId: 'B', head: 'b0', text: 'B', bufferRevision: 0, savedRevision: 0 }),
    updateDraft: async ({ draftId, text }) => { edits.push({ draftId, text }); return { id: draftId, fileId: 'B', head: 'b1', text, bufferRevision: 1, savedRevision: 0 } },
  })
  const openingA = view.openFile('A')
  await nextTurn()
  await view.openFile('B')
  resolveA({ id: 'draft-A', fileId: 'A', head: 'a0', text: 'A', bufferRevision: 0, savedRevision: 0 })
  await openingA
  const editor = view.element.querySelector('textarea')
  assert.equal(editor.value, 'B')
  editor.value = 'B edit'; editor.fire('input')
  await view.flush()
  assert.deepEqual(edits, [{ draftId: 'draft-B', text: 'B edit' }])
  await view.close()
})

test('restored working copy stays editable with a stale handle and reconnect preserves its text', async () => {
  const retained = { id: 'draft', fileId: 'expired-file', name: 'source.txt', head: 'h0', text: 'retained edits', bufferRevision: 1, savedRevision: 0, sourceHash: 'a'.repeat(64), sourceRevision: 'old-source' }
  const { view, document } = uiFixture({
    readDraft: async () => ({ ...retained }),
    readFile: async () => { throw Object.assign(new Error('Unknown handle'), { code: 'UNKNOWN_RESOURCE' }) },
    reconnectDraft: async ({ fileId }) => ({ draft: { ...retained, fileId, head: 'h1' }, source: { fileId, name: 'source.txt', size: 5, sha256: retained.sourceHash, diskRevision: 'new-source' } }),
  })
  const focused = document.createElement('button'); focused.focus()
  await view.restoreDraft({ draftId: 'draft' })
  assert.equal(document.activeElement, focused)
  assert.equal(view.snapshot().sourceConnection, 'reconnect-required')
  assert.equal(view.element.querySelector('textarea').value, 'retained edits')
  assert.equal(view.element.querySelector('.egdesk-file-reconnect-button').hidden, false)
  await view.reconnectSource('new-file')
  assert.equal(view.snapshot().sourceConnection, 'connected')
  assert.equal(view.snapshot().fileId, 'new-file')
  assert.equal(view.element.querySelector('textarea').value, 'retained edits')
  await view.close()
})

test('late source reconnect cannot replace a newly active draft', async () => {
  let finishReconnect
  const { view } = uiFixture({
    readFile: async ({ fileId }) => ({ name: `${fileId}.txt`, size: 1, sha256: 'a'.repeat(64), diskRevision: fileId, kind: 'text' }),
    createDraft: async ({ fileId }) => ({ id: `draft-${fileId}`, fileId, head: 'h0', text: fileId, bufferRevision: 0, savedRevision: 0 }),
    reconnectDraft: () => new Promise(resolve => { finishReconnect = resolve }),
  })
  await view.openFile('A')
  const reconnecting = view.reconnectSource('new-A')
  await nextTurn()
  await view.openFile('B')
  finishReconnect({ draft: { id: 'draft-A', fileId: 'new-A', text: 'A', head: 'a1', bufferRevision: 0, savedRevision: 0 }, source: { fileId: 'new-A', name: 'A.txt', size: 1, sha256: 'a'.repeat(64) } })
  await reconnecting
  assert.equal(view.snapshot().draftId, 'draft-B')
  assert.equal(view.element.querySelector('textarea').value, 'B')
  await view.close()
})

test('opening a file does not cancel an independent directory expansion', async () => {
  let finishDirectory
  const { view } = uiFixture({ listDirectory: ({ directoryId }) => directoryId === 'root-dir'
    ? Promise.resolve({ entries: [{ id: 'sub-dir', name: 'folder', kind: 'directory' }], nextCursor: null })
    : new Promise(resolve => { finishDirectory = resolve }) })
  await view.openRoot({ rootId: 'root', directoryId: 'root-dir', name: 'Project' })
  const folder = view.element.querySelector('[role="treeitem"]')
  folder.click(); await nextTurn()
  await view.openFile('file')
  finishDirectory({ entries: [{ id: 'file', name: 'source.txt', kind: 'file' }], nextCursor: null })
  await nextTurn()
  assert.ok(folder.querySelector('[role="treeitem"]'))
  await view.close()
})

test('file transition preserves A edits during delayed B read, draft creation and final flush', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let finishReadB, finishDraftB, finishFirstWrite
  const readB = new Promise(resolve => { finishReadB = resolve })
  const draftB = new Promise(resolve => { finishDraftB = resolve })
  const firstWrite = new Promise(resolve => { finishFirstWrite = resolve })
  const records = new Map(['A', 'B'].map(fileId => [`draft-${fileId}`, { id: `draft-${fileId}`, fileId, head: `${fileId}-0`, text: fileId, bufferRevision: 0, savedRevision: 0 }]))
  const writes = []
  const info = fileId => ({ name: `${fileId}.txt`, size: 1, sha256: 'a'.repeat(64), diskRevision: fileId, kind: 'text' })
  const { view } = uiFixture({
    readFile: ({ fileId }) => fileId === 'B' ? readB : Promise.resolve(info(fileId)),
    createDraft: ({ fileId }) => fileId === 'B' ? draftB : Promise.resolve({ ...records.get(`draft-${fileId}`) }),
    readDraft: async ({ draftId }) => ({ ...records.get(draftId) }),
    updateDraft: async ({ draftId, text }) => {
      writes.push({ draftId, text })
      if (writes.length === 1) await firstWrite
      const updated = { ...records.get(draftId), text, head: `${draftId}-${writes.length}`, bufferRevision: writes.length }
      records.set(draftId, updated)
      return { ...updated }
    },
  })
  await view.openFile('A')
  const editor = view.element.querySelector('textarea')
  const title = view.element.querySelector('.egdesk-file-title')
  const openingB = view.openFile('B')
  editor.value = 'A read-wait edits'; editor.fire('input')
  assert.equal(title.textContent, 'A.txt')
  assert.equal(view.snapshot().fileId, 'A')
  finishReadB(info('B')); await nextTurn()
  assert.equal(title.textContent, 'A.txt')
  assert.equal(editor.value, 'A read-wait edits')
  editor.value = 'A read/draft edits'; editor.fire('input')
  finishDraftB({ ...records.get('draft-B') }); await nextTurn()
  assert.deepEqual(writes, [{ draftId: 'draft-A', text: 'A read/draft edits' }])
  assert.equal(title.textContent, 'A.txt')
  assert.equal(view.snapshot().draftId, 'draft-A')
  editor.value = 'A read/draft/flush edits'; editor.fire('input')
  finishFirstWrite(); await openingB
  assert.deepEqual(writes, [
    { draftId: 'draft-A', text: 'A read/draft edits' },
    { draftId: 'draft-A', text: 'A read/draft/flush edits' },
  ])
  assert.equal(records.get('draft-A').text, 'A read/draft/flush edits')
  assert.equal(title.textContent, 'B.txt')
  assert.equal(editor.value, 'B')
  assert.equal(view.snapshot().draftId, 'draft-B')
  await view.openFile('A')
  assert.equal(editor.value, 'A read/draft/flush edits')
  await view.close()
})

test('failed transition flush leaves A title, identity and latest text intact', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let finishB
  let failWrite = true
  const delayedB = new Promise(resolve => { finishB = resolve })
  const info = fileId => ({ name: `${fileId}.txt`, size: 1, sha256: 'a'.repeat(64), diskRevision: fileId, kind: 'text' })
  const { view } = uiFixture({
    readFile: ({ fileId }) => fileId === 'B' ? delayedB : Promise.resolve(info(fileId)),
    createDraft: async ({ fileId }) => ({ id: `draft-${fileId}`, fileId, head: 'h0', text: fileId, bufferRevision: 0, savedRevision: 0 }),
    updateDraft: async ({ draftId, text }) => {
      if (failWrite) throw new Error('Draft store unavailable')
      return { id: draftId, fileId: 'A', head: 'h1', text, bufferRevision: 1, savedRevision: 0 }
    },
  })
  await view.openFile('A')
  const openingB = view.openFile('B')
  const editor = view.element.querySelector('textarea')
  editor.value = 'A newest unsaved text'; editor.fire('input')
  finishB(info('B'))
  await assert.rejects(openingB, /Draft store unavailable/)
  assert.equal(view.element.querySelector('.egdesk-file-title').textContent, 'A.txt')
  assert.equal(view.snapshot().fileId, 'A')
  assert.equal(view.snapshot().draftId, 'draft-A')
  assert.equal(editor.value, 'A newest unsaved text')
  failWrite = false
  assert.equal(await view.close(), true)
})

test('file transition cannot discard an in-progress composition in A', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let finishB
  const delayedB = new Promise(resolve => { finishB = resolve })
  const { view } = uiFixture({
    readFile: ({ fileId }) => fileId === 'B' ? delayedB : Promise.resolve({ name: 'A.txt', kind: 'text', size: 1, sha256: 'a'.repeat(64) }),
    createDraft: async ({ fileId }) => ({ id: `draft-${fileId}`, fileId, head: 'h0', text: fileId, bufferRevision: 0, savedRevision: 0 }),
    updateDraft: async ({ draftId, text }) => ({ id: draftId, fileId: 'A', head: 'h1', text, bufferRevision: 1, savedRevision: 0 }),
  })
  await view.openFile('A')
  const openingB = view.openFile('B')
  const editor = view.element.querySelector('textarea')
  editor.fire('compositionstart'); editor.value = '한글 조합'; editor.fire('input')
  finishB({ name: 'B.txt', kind: 'text', size: 1, sha256: 'b'.repeat(64) })
  await openingB
  assert.equal(view.snapshot().fileId, 'A')
  assert.equal(view.element.querySelector('.egdesk-file-title').textContent, 'A.txt')
  assert.equal(editor.value, '한글 조합')
  editor.fire('compositionend')
  assert.equal(await view.close(), true)
})

test('Save As suggests a copy name with the original extension and retains create-only intent', async () => {
  assert.equal(suggestEGDeskCopyName('보고서.txt'), '보고서 사본.txt')
  assert.equal(suggestEGDeskCopyName('archive.tar.gz'), 'archive.tar 사본.gz')
  assert.equal(suggestEGDeskCopyName('README'), 'README 사본')
  assert.equal(suggestEGDeskCopyName('.env'), '.env 사본')
  let options
  const { view } = uiFixture({ createDraft: async () => ({ id: 'draft', fileId: 'file', head: 'h0', text: 'start', bufferRevision: 0, savedRevision: 0, saveAsAvailable: true }) }, {
    chooseSaveAs: async requested => { options = requested; return null },
  })
  await view.openFile('file')
  const saveAsButton = view.element.querySelector('.egdesk-file-save-as-button')
  assert.equal(saveAsButton.disabled, false)
  saveAsButton.click(); await nextTurn()
  assert.deepEqual(options, { defaultName: 'source 사본.txt', createOnly: true })
  assert.equal(view.snapshot().draftId, 'draft')
  await view.close()
})

test('Save As partial or uncertain result warns about the target and keeps the draft without automatic retry', async () => {
  for (const created of [true, null]) {
    let calls = 0
    const { view } = uiFixture({
      createDraft: async () => ({ id: 'draft', fileId: 'file', head: 'h0', text: 'start', bufferRevision: 0, savedRevision: 0, saveAsAvailable: true }),
      saveAs: async () => {
        calls++
        throw Object.assign(new Error('raw secret /private/native/path'), { code: created ? 'SAVE_AS_INCOMPLETE' : 'SAVE_AS_UNCERTAIN', details: { targetName: 'partial 사본.txt', created, fileMayExist: true, recovery: 'inspect-target-before-retry' } })
      },
    }, { chooseSaveAs: async () => ({ directoryId: 'directory', fileName: 'partial 사본.txt' }) })
    await view.openFile('file')
    view.element.querySelector('.egdesk-file-save-as-button').click(); await nextTurn()
    const warning = view.element.querySelector('.egdesk-file-error').textContent
    assert.match(warning, /partial 사본\.txt/)
    assert.match(warning, created ? /확인한 뒤 다른 이름/ : /다시 저장하기 전에 파일을 확인/)
    assert.equal(warning.includes('raw secret'), false)
    assert.equal(warning.includes('/private/native/path'), false)
    assert.equal(calls, 1)
    assert.equal(view.snapshot().draftId, 'draft')
    assert.equal(view.element.querySelector('textarea').value, 'start')
    await view.close()
  }
})

// ---- 1-G: git review, content search and the File view '변경' tab ----

// Isolated git (own HOME, empty global config) inside a temp folder.
async function gitFixture(t) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'egdesk-file-git-')))
  t.after(() => fs.rm(base, { recursive: true, force: true }))
  const home = path.join(base, 'home')
  await fs.mkdir(home)
  await fs.writeFile(path.join(home, 'gitconfig'), '')
  const env = { ...process.env, HOME: home, GIT_CONFIG_GLOBAL: path.join(home, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1', GIT_CEILING_DIRECTORIES: base }
  delete env.GIT_DIR; delete env.GIT_WORK_TREE; delete env.GIT_INDEX_FILE
  const root = path.join(base, 'repo')
  await fs.mkdir(root)
  const git = (...args) => execFileSync('git', args, { cwd: root, env, encoding: 'utf8' })
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 'file@example.invalid'); git('config', 'user.name', 'File Test'); git('config', 'commit.gpgsign', 'false')
  const service = createEGDeskFileService({ draftStore: draftStore(), gitReview: createEGDeskGitReview({ env }) })
  const put = async (relative, body) => { await fs.mkdir(path.dirname(path.join(root, relative)), { recursive: true }); await fs.writeFile(path.join(root, relative), body) }
  return { base, root, env, git, service, put }
}

test('service git routes: status for the tree, change list with opaque ids, per-file diffs in lineDiff shape', async t => {
  const { root, git, service, put } = await gitFixture(t)
  await put('a.txt', 'one\ntwo\n')
  await put('gone.txt', 'bye\n')
  await put('.gitignore', '*.log\n')
  git('add', '-A'); git('commit', '-qm', 'init')
  await put('a.txt', 'one\nTWO\n')
  await fs.unlink(path.join(root, 'gone.txt'))
  await put('new/fresh.txt', 'fresh\nlines\n')
  await put('new/big.txt', Buffer.alloc(1024 * 1024 + 1, 65))
  await put('debug.log', 'ignored\n')
  const rootHandle = await service.registerRoot(root)

  const status = await service.gitStatus({ rootId: rootHandle.rootId })
  assert.equal(status.available, true)
  assert.equal(status.isRepo, true)
  assert.deepEqual(status.entries.map(entry => [entry.relativePath, entry.state, entry.directory]).sort(), [['a.txt', 'modified', false], ['gone.txt', 'deleted', false], ['new', 'untracked', true]])

  const listed = await service.gitChanges({ rootId: rootHandle.rootId })
  assert.equal(listed.scope, 'uncommitted')
  assert.equal(listed.branch, 'main')
  assert.deepEqual(listed.files.map(file => [file.relativePath, file.status]).sort(), [['a.txt', 'modified'], ['gone.txt', 'deleted'], ['new/big.txt', 'untracked'], ['new/fresh.txt', 'untracked']])
  assert.deepEqual(listed.totals, { files: 4, additions: 1, deletions: 2 })
  assert.ok(listed.files.every(file => typeof file.changeId === 'string' && !('fileId' in file) && !file.changeId.includes('/')))
  const change = name => listed.files.find(file => file.relativePath === name).changeId

  const modified = await service.gitFileDiff({ changeId: change('a.txt') })
  assert.deepEqual(modified.hunks, [{ baseStartLine: 2, baseLines: ['two'], currentStartLine: 2, currentLines: ['TWO'] }])
  assert.equal((await service.readFile({ fileId: modified.fileId })).text, 'one\nTWO\n')
  const deleted = await service.gitFileDiff({ changeId: change('gone.txt') })
  assert.equal(deleted.fileId, null)
  assert.deepEqual(deleted.hunks, [{ baseStartLine: 1, baseLines: ['bye'], currentStartLine: 1, currentLines: [] }])
  const fresh = await service.gitFileDiff({ changeId: change('new/fresh.txt') })
  assert.match(fresh.patch, /^--- \/dev\/null$/m)
  assert.deepEqual(fresh.hunks, [{ baseStartLine: 1, baseLines: [], currentStartLine: 1, currentLines: ['fresh', 'lines'] }])
  const big = await service.gitFileDiff({ changeId: change('new/big.txt') })
  assert.deepEqual([big.tooLarge, big.truncated, big.hunks.length, big.patch], [true, true, 0, ''])

  // Two list generations stay valid; older change ids are refused.
  const second = await service.gitChanges({ rootId: rootHandle.rootId })
  assert.equal((await service.gitFileDiff({ changeId: change('a.txt') })).status, 'modified')
  await service.gitChanges({ rootId: rootHandle.rootId })
  await assert.rejects(service.gitFileDiff({ changeId: change('a.txt') }), { code: 'UNKNOWN_CHANGE' })
  assert.equal((await service.gitFileDiff({ changeId: second.files[0].changeId })).changeId, second.files[0].changeId)
  await assert.rejects(service.gitChanges({ rootId: rootHandle.rootId, scope: 'turn' }), { code: 'UNSUPPORTED_SCOPE' })
  await assert.rejects(service.gitStatus({ rootId: 'not-a-root' }), { code: 'UNKNOWN_ROOT' })
})

test('git review degrades to "not a repository" or "git unavailable" without failing the File view', async t => {
  const { base } = await gitFixture(t)
  const plain = path.join(base, 'plain')
  await fs.mkdir(plain)
  const env = { ...process.env, GIT_CEILING_DIRECTORIES: base }
  const service = createEGDeskFileService({ draftStore: draftStore(), gitReview: createEGDeskGitReview({ env }) })
  const rootHandle = await service.registerRoot(plain)
  assert.deepEqual(await service.gitStatus({ rootId: rootHandle.rootId }), { rootId: rootHandle.rootId, available: true, isRepo: false, branch: null, truncated: false, entries: [] })
  assert.equal((await service.gitChanges({ rootId: rootHandle.rootId })).isRepo, false)
  const missingGit = createEGDeskFileService({ draftStore: draftStore(), gitReview: createEGDeskGitReview({ gitExecutable: path.join(base, 'no-git') }) })
  const missingRoot = await missingGit.registerRoot(plain)
  assert.equal((await missingGit.gitStatus({ rootId: missingRoot.rootId })).available, false)
  const unavailable = await missingGit.gitChanges({ rootId: missingRoot.rootId })
  assert.deepEqual([unavailable.available, unavailable.files, unavailable.totals.files], [false, [], 0])
})

test('content search: git grep in a work tree, bounded walk elsewhere; results carry file handles and line numbers', async t => {
  const { root, git, service, put, base } = await gitFixture(t)
  await put('.gitignore', 'ignored.txt\n')
  await put('src/a.js', 'const Needle = 1\n\nneedle()\n')
  git('add', '-A'); git('commit', '-qm', 'init')
  await put('src/untracked.txt', 'untracked needle\n')
  await put('ignored.txt', 'needle should stay hidden\n')
  const rootHandle = await service.registerRoot(root)
  const found = await service.searchContents({ rootId: rootHandle.rootId, query: 'needle' })
  assert.equal(found.source, 'git-grep')
  assert.equal(found.scope, 'contents')
  assert.deepEqual(found.matches.map(match => `${match.relativePath}:${match.lineNumber}`).sort(), ['src/a.js:1', 'src/a.js:3', 'src/untracked.txt:1'])
  const first = found.matches.find(match => match.relativePath === 'src/a.js' && match.lineNumber === 1)
  assert.deepEqual(first.matchRanges, [{ start: 6, end: 12 }])
  assert.equal(first.column, 6)
  assert.match((await service.readFile({ fileId: first.fileId })).text, /Needle/)
  assert.deepEqual((await service.searchContents({ rootId: rootHandle.rootId, query: 'Needle', caseSensitive: true })).matches.map(match => match.lineNumber), [1])
  await assert.rejects(service.searchContents({ rootId: rootHandle.rootId, query: 'a\nb' }), { code: 'INVALID_QUERY' })
  await assert.rejects(service.searchContents({ rootId: rootHandle.rootId, query: 'x', caseSensitive: 'yes' }), { code: 'INVALID_OPTION' })

  // Outside git: skip DEFAULT_SEARCH_IGNORES, binary, oversized and symlinked files.
  const plain = path.join(base, 'plain')
  const outside = path.join(base, 'outside')
  await fs.mkdir(path.join(plain, 'node_modules', 'pkg'), { recursive: true })
  await fs.mkdir(path.join(plain, 'docs'), { recursive: true })
  await fs.mkdir(outside)
  await fs.writeFile(path.join(plain, 'docs', 'note.md'), '# Title\n찾을 문장 needle 입니다\n')
  await fs.writeFile(path.join(plain, 'node_modules', 'pkg', 'index.js'), 'needle in dependency\n')
  await fs.writeFile(path.join(plain, 'blob.bin'), Buffer.from([0, 110, 101, 101, 100, 108, 101]))
  await fs.writeFile(path.join(plain, 'huge.txt'), `needle${'x'.repeat(1024 * 1024)}`)
  await fs.writeFile(path.join(outside, 'secret.txt'), 'needle secret\n')
  await fs.symlink(path.join(outside, 'secret.txt'), path.join(plain, 'linked.txt'))
  const walkService = createEGDeskFileService({ draftStore: draftStore(), gitReview: createEGDeskGitReview({ env: { ...process.env, GIT_CEILING_DIRECTORIES: base } }) })
  const plainHandle = await walkService.registerRoot(plain)
  const walked = await walkService.searchContents({ rootId: plainHandle.rootId, query: 'NEEDLE' })
  assert.equal(walked.source, 'walk')
  assert.deepEqual(walked.matches.map(match => [match.relativePath, match.lineNumber, match.lineContent]), [['docs/note.md', 2, '찾을 문장 needle 입니다']])
  assert.deepEqual(DEFAULT_SEARCH_IGNORES, ['.git', 'node_modules', 'target', 'dist', 'build'])
})

test('name search skips ignored folders by default, includes them on request, and follows .gitignore inside a work tree', async t => {
  const { root, git, service, put, base } = await gitFixture(t)
  await put('.gitignore', 'secret-note.txt\n')
  await put('src/note.txt', 'tracked\n')
  git('add', '-A'); git('commit', '-qm', 'init')
  await put('secret-note.txt', 'ignored\n')
  await put('draft-note.txt', 'untracked\n')
  const rootHandle = await service.registerRoot(root)
  const viaGit = await service.search({ rootId: rootHandle.rootId, query: 'note' })
  assert.equal(viaGit.source, 'git-index')
  assert.deepEqual(viaGit.matches.map(match => match.relativePath).sort(), ['draft-note.txt', path.join('src', 'note.txt')])
  assert.ok((await service.readFile({ fileId: viaGit.matches.find(match => match.name === 'note.txt').id })).text.startsWith('tracked'))
  const everything = await service.search({ rootId: rootHandle.rootId, query: 'note', includeIgnored: true })
  assert.equal(everything.source, 'walk')
  assert.ok(everything.matches.some(match => match.name === 'secret-note.txt'))

  const plain = path.join(base, 'plain')
  await fs.mkdir(path.join(plain, 'node_modules', 'lib'), { recursive: true })
  await fs.writeFile(path.join(plain, 'node_modules', 'lib', 'match-me.js'), '')
  await fs.writeFile(path.join(plain, 'match-me.txt'), '')
  const walkService = createEGDeskFileService({ draftStore: draftStore(), gitReview: createEGDeskGitReview({ env: { ...process.env, GIT_CEILING_DIRECTORIES: base } }) })
  const plainHandle = await walkService.registerRoot(plain)
  assert.deepEqual((await walkService.search({ rootId: plainHandle.rootId, query: 'match-me' })).matches.map(match => match.name), ['match-me.txt'])
  assert.deepEqual((await walkService.search({ rootId: plainHandle.rootId, query: 'match-me', includeIgnored: true })).matches.map(match => match.name).sort(), ['match-me.js', 'match-me.txt'])
  await assert.rejects(walkService.search({ rootId: plainHandle.rootId, query: 'x', includeIgnored: 'yes' }), { code: 'INVALID_OPTION' })
})

test('git state index: letters, folder markers, untracked folders and NFD names', () => {
  const index = createEGDeskGitStateIndex([
    { relativePath: 'src/app.js', state: 'modified' },
    { relativePath: 'new dir', state: 'untracked', directory: true },
    { relativePath: '문서/한글.txt', state: 'added' },
    { relativePath: 'bogus', state: 'unknown-state' },
  ])
  assert.equal(index.stateFor('src/app.js'), 'modified')
  assert.equal(index.stateFor('src'), 'contains')
  assert.equal(index.stateFor('new dir'), 'untracked')
  assert.equal(index.stateFor('new dir/inner/file.txt'), 'untracked')
  assert.equal(index.stateFor('문서/한글.txt'.normalize('NFD')), 'added')
  assert.equal(index.stateFor('문서'.normalize('NFD')), 'contains')
  assert.equal(index.stateFor('bogus'), null)
  assert.equal(index.stateFor('other.txt'), null)
  assert.equal(EGDESK_GIT_STATE_LABELS.modified.letter, 'M')
  assert.equal(parentFolderOf('a/b/c.txt'), 'a/b')
  assert.equal(parentFolderOf('top.txt'), '')
  assert.deepEqual(normalizeFileChangedEvent({ topic: 'file.changed', payload: { rootId: 'r', relativePath: 'a/b.txt', change: 'rename' } }), { rootId: 'r', relativePath: 'a/b.txt', change: 'rename' })
  for (const relativePath of ['/abs', 'a/../b', 'a//b', 'a\\b', '', 'x\u0000y']) assert.equal(normalizeFileChangedEvent({ rootId: 'r', relativePath }), null)
  assert.equal(normalizeFileChangedEvent({ relativePath: 'a.txt' }), null)
})

// Fake service with a mutable folder tree for File view git/watch tests.
function treeService(overrides = {}) {
  const folders = { 'root-dir': [{ id: 'dir-src', name: 'src', kind: 'directory' }, { id: 'file-readme', name: 'README.md', kind: 'file' }], 'dir-src': [{ id: 'file-app', name: 'app.js', kind: 'file' }] }
  const calls = []
  const service = {
    folders, calls,
    listDirectory: async ({ directoryId }) => { calls.push(['list', directoryId]); return { entries: (folders[directoryId] || []).map(entry => ({ ...entry })), nextCursor: null } },
    search: async () => ({ matches: [], truncated: false }),
    readFile: async ({ fileId }) => ({ name: fileId, size: 30, sha256: 'b'.repeat(64), diskRevision: `rev-${fileId}`, kind: 'text', text: 'line one\nline two\nline three\n' }),
    createDraft: async ({ fileId }) => ({ id: `draft-${fileId}`, fileId, name: fileId, head: 'h0', text: 'line one\nline two\nline three\n', bufferRevision: 0, savedRevision: 0 }),
    readDraft: async ({ draftId }) => ({ id: draftId, fileId: draftId.slice(6), head: 'h0', text: 'line one\nline two\nline three\n', bufferRevision: 0, savedRevision: 0 }),
    updateDraft: async ({ draftId, text }) => ({ id: draftId, fileId: draftId.slice(6), head: 'h1', text, bufferRevision: 1, savedRevision: 0 }),
    saveDraft: async () => ({ draft: {}, receipt: {} }), saveAs: async () => ({}), diffDraft: async () => ({ bufferRevision: 0, hunks: [] }),
    gitStatus: async () => { calls.push(['status']); return { available: true, isRepo: true, branch: 'main', truncated: false, entries: [{ relativePath: 'src/app.js', state: 'modified' }, { relativePath: 'README.md'.normalize('NFC'), state: 'added' }] } },
    gitChanges: async () => { calls.push(['changes']); return { available: true, isRepo: true, branch: 'main', truncated: false, countsAvailable: true, totals: { files: 2, additions: 3, deletions: 1 }, files: [
      { changeId: 'c-app', relativePath: 'src/app.js', previousPath: null, status: 'modified', additions: 2, deletions: 1, binary: false },
      { changeId: 'c-old', relativePath: 'old.txt', previousPath: null, status: 'deleted', additions: 0, deletions: 1, binary: false },
    ] } },
    gitFileDiff: async ({ changeId }) => { calls.push(['diff', changeId]); return changeId === 'c-app'
      ? { changeId, fileId: 'file-app', relativePath: 'src/app.js', previousPath: null, status: 'modified', binary: false, truncated: false, tooLarge: false, patch: '', hunks: [{ baseStartLine: 2, baseLines: ['two'], currentStartLine: 2, currentLines: ['TWO', 'extra'] }] }
      : { changeId, fileId: null, relativePath: 'old.txt', previousPath: null, status: 'deleted', binary: false, truncated: false, tooLarge: false, patch: '', hunks: [{ baseStartLine: 1, baseLines: ['bye'], currentStartLine: 1, currentLines: [] }] } },
    searchContents: async ({ query }) => { calls.push(['contents', query]); return { truncated: false, matches: [{ fileId: 'file-app', relativePath: 'src/app.js', lineNumber: 3, lineContent: 'call needle()', matchRanges: [{ start: 5, end: 11 }], column: 5 }] } },
    ...overrides,
  }
  return service
}
const settle = async (count = 4) => { for (let index = 0; index < count; index++) await nextTurn() }
const treeItemNamed = (container, name) => container.querySelectorAll('[role="treeitem"]').find(item => item.dataset.name === name)

test('File view tree shows git state letters, folder markers and spoken labels', async () => {
  const service = treeService()
  const document = fakeDocument()
  const view = createEGDeskFileView({ document, service })
  document.body.append(view.element)
  await view.openRoot({ rootId: 'root', directoryId: 'root-dir', name: 'Project' })
  await view.refreshGitStatus()
  const folder = treeItemNamed(view.element, 'src')
  const readme = treeItemNamed(view.element, 'README.md')
  assert.equal(folder.querySelector('.egdesk-file-tree-state').textContent, '•')
  assert.equal(folder.getAttribute('aria-label'), 'src, 안에 변경 있음')
  assert.equal(readme.dataset.gitState, 'added')
  assert.equal(readme.querySelector('.egdesk-file-tree-state').hidden, false)
  folder.click(); await settle()
  const app = treeItemNamed(view.element, 'app.js')
  assert.equal(app.querySelector('.egdesk-file-tree-state').textContent, 'M')
  assert.equal(app.getAttribute('aria-label'), 'app.js, 수정됨')
  app.click(); await settle()
  assert.equal(view.snapshot().fileId, 'file-app')
  await view.close()
})

test('File view 변경 tab lists uncommitted changes and opens a per-file diff with the existing hunk layout', async () => {
  const service = treeService()
  const document = fakeDocument()
  const view = createEGDeskFileView({ document, service })
  document.body.append(view.element)
  await view.openRoot({ rootId: 'root', directoryId: 'root-dir', name: 'Project' })
  const [filesTab, changesTab] = view.element.querySelectorAll('[role="tab"]')
  assert.equal(filesTab.getAttribute('aria-selected'), 'true')
  assert.equal(changesTab.disabled, false)
  filesTab.fire('keydown', { key: 'ArrowRight' }); await settle()
  assert.equal(document.activeElement, changesTab)
  assert.equal(changesTab.getAttribute('aria-selected'), 'true')
  assert.equal(view.element.querySelector('.egdesk-file-tree').hidden, true)
  assert.equal(view.element.querySelector('.egdesk-file-changes').hidden, false)
  const scopes = view.element.querySelector('.egdesk-file-change-scopes').querySelectorAll('[role="radio"]')
  assert.deepEqual(scopes.map(scope => [scope.textContent, scope.getAttribute('aria-checked'), scope.getAttribute('aria-disabled')]), [['커밋 안 한 변경', 'true', null], ['이번 회차', 'false', 'true']])
  assert.equal(view.element.querySelector('.egdesk-file-change-summary').textContent, 'main · 파일 2개 · +3 −1')
  const rows = view.element.querySelectorAll('.egdesk-file-change-row')
  assert.equal(rows.length, 2)
  assert.equal(rows[0].getAttribute('aria-label'), 'src/app.js, 수정됨, +2 −1')
  assert.equal(rows[0].querySelector('.egdesk-file-change-state').textContent, 'M')
  rows[0].click(); await settle()
  const panel = view.element.querySelector('.egdesk-file-change-diff')
  assert.equal(panel.hidden, false)
  assert.equal(panel.querySelector('.egdesk-file-change-diff-heading').textContent, 'src/app.js · 수정됨')
  assert.equal(panel.querySelector('.egdesk-file-hunk-title').textContent, '커밋 2행 ↔ 지금 2행')
  assert.equal(panel.querySelector('.egdesk-file-hunk-after').textContent, 'TWO\nextra')
  panel.querySelector('.egdesk-file-change-open').click(); await settle()
  assert.equal(view.snapshot().fileId, 'file-app')
  assert.equal(panel.hidden, false)
  rows[1].click(); await settle()
  assert.equal(panel.querySelector('.egdesk-file-change-open'), null)
  assert.equal(panel.querySelector('.egdesk-file-hunk-before').textContent, 'bye')
  await view.close()
})

test('File view 변경 tab explains non-repositories and missing git; the tab stays off without git callbacks', async () => {
  for (const [result, message] of [[{ available: true, isRepo: false, files: [] }, '이 폴더는 git 저장소 안에 있지 않습니다.'], [{ available: false, isRepo: false, files: [] }, 'git을 찾을 수 없어 변경을 볼 수 없습니다.'], [{ available: true, isRepo: true, branch: 'dev', files: [], totals: { files: 0, additions: 0, deletions: 0 } }, 'dev · 커밋 안 한 변경이 없습니다.']]) {
    const document = fakeDocument()
    const view = createEGDeskFileView({ document, service: treeService({ gitChanges: async () => result }) })
    await view.openRoot({ rootId: 'root', directoryId: 'root-dir' })
    view.element.querySelectorAll('[role="tab"]')[1].click(); await settle()
    assert.equal(view.element.querySelector('.egdesk-file-change-summary').textContent, message)
    await view.close()
  }
  const { view } = uiFixture()
  const changesTab = view.element.querySelectorAll('[role="tab"]')[1]
  assert.equal(changesTab.disabled, true)
  changesTab.click(); await settle()
  assert.equal(view.element.querySelector('.egdesk-file-changes').hidden, true)
  const contentMode = view.element.querySelector('.egdesk-file-search-modes').querySelectorAll('[role="radio"]')[1]
  assert.equal(contentMode.disabled, true)
  contentMode.click()
  assert.equal(contentMode.getAttribute('aria-checked'), 'false')
  await view.close()
})

test('content search mode sends the untrimmed query, marks matches, and jumps to the line', async () => {
  const service = treeService()
  const document = fakeDocument()
  const view = createEGDeskFileView({ document, service })
  document.body.append(view.element)
  await view.openRoot({ rootId: 'root', directoryId: 'root-dir', name: 'Project' })
  const [nameMode, contentMode] = view.element.querySelector('.egdesk-file-search-modes').querySelectorAll('[role="radio"]')
  assert.equal(nameMode.getAttribute('aria-checked'), 'true')
  contentMode.click()
  assert.equal(contentMode.getAttribute('aria-checked'), 'true')
  assert.equal(view.element.querySelector('.egdesk-file-search-label-text').textContent, '파일 내용 검색')
  view.element.querySelector('.egdesk-file-search-input').value = ' needle'
  view.element.querySelector('.egdesk-file-search').fire('submit'); await settle()
  assert.deepEqual(service.calls.filter(call => call[0] === 'contents'), [['contents', ' needle']])
  const result = view.element.querySelector('.egdesk-file-content-result')
  assert.equal(result.querySelector('.egdesk-file-content-location').textContent, 'src/app.js:3')
  assert.equal(result.querySelector('.egdesk-file-content-match').textContent, 'needle')
  assert.equal(result.getAttribute('aria-label'), 'src/app.js 3행: call needle()')
  const editor = view.element.querySelector('textarea')
  let selection = null
  editor.setSelectionRange = (start, end) => { selection = [start, end] }
  result.click(); await settle()
  assert.equal(view.snapshot().fileId, 'file-app')
  assert.deepEqual(selection, [18, 28])
  assert.equal(document.activeElement, editor)
  // Past the end clamps to the last (empty) line after the final newline.
  assert.equal(view.revealLine(99), true)
  assert.deepEqual(selection, [29, 29])
  assert.equal(view.revealLine(0), false)
  nameMode.fire('keydown', { key: 'ArrowRight' })
  assert.equal(contentMode.getAttribute('aria-checked'), 'true')
  contentMode.fire('keydown', { key: 'ArrowLeft' })
  assert.equal(nameMode.getAttribute('aria-checked'), 'true')
  await view.close()
})

test('onFileChanged collects events, re-lists only loaded affected folders, keeps expanded folders, and refreshes git state once', async () => {
  const service = treeService()
  const document = fakeDocument()
  const view = createEGDeskFileView({ document, service, fileChangeDelayMs: 5 })
  document.body.append(view.element)
  await view.openRoot({ rootId: 'root', directoryId: 'root-dir', name: 'Project' })
  const folder = treeItemNamed(view.element, 'src')
  folder.click(); await settle()
  assert.equal(folder.getAttribute('aria-expanded'), 'true')
  const app = treeItemNamed(view.element, 'app.js')
  await view.refreshGitStatus()
  service.calls.length = 0

  service.folders['root-dir'] = [{ id: 'dir-src-2', name: 'src', kind: 'directory' }, { id: 'file-new', name: 'NEW.txt', kind: 'file' }]
  service.folders['dir-src-2'] = service.folders['dir-src']
  treeItemNamed(view.element, 'README.md').focus()
  assert.equal(view.onFileChanged({ rootId: 'root', relativePath: 'NEW.txt', change: 'rename' }), true)
  assert.equal(view.onFileChanged({ payload: { rootId: 'root', relativePath: 'README.md', change: 'rename' } }), true)
  assert.equal(view.onFileChanged({ rootId: 'other-root', relativePath: 'x.txt' }), false)
  assert.equal(view.onFileChanged({ rootId: 'root', relativePath: '../escape' }), false)
  await new Promise(resolve => setTimeout(resolve, 20)); await settle()
  assert.deepEqual(service.calls, [['list', 'root-dir'], ['status']])
  assert.equal(treeItemNamed(view.element, 'README.md'), undefined)
  assert.ok(treeItemNamed(view.element, 'NEW.txt'))
  assert.equal(treeItemNamed(view.element, 'src'), folder)
  assert.equal(folder.getAttribute('aria-expanded'), 'true')
  assert.equal(treeItemNamed(view.element, 'app.js'), app)
  assert.equal(document.activeElement, folder, 'focus on a removed item moves to the first remaining item')

  // A content edit keeps the listing: same nodes, git state refreshed.
  service.calls.length = 0
  view.onFileChanged({ rootId: 'root', relativePath: 'src/app.js', change: 'change' })
  await view.flushFileChanges()
  assert.deepEqual(service.calls, [['list', 'dir-src-2'], ['status']])
  assert.equal(treeItemNamed(view.element, 'app.js'), app)

  // A change inside the expanded folder re-lists that folder with its new handle.
  service.folders['dir-src-2'] = [{ id: 'file-app', name: 'app.js', kind: 'file' }, { id: 'file-util', name: 'util.js', kind: 'file' }]
  service.calls.length = 0
  view.onFileChanged({ rootId: 'root', relativePath: 'src/util.js', change: 'rename' })
  await view.flushFileChanges()
  assert.deepEqual(service.calls, [['list', 'dir-src-2'], ['status']])
  assert.ok(treeItemNamed(folder, 'util.js'))
  treeItemNamed(folder, 'util.js').click(); await settle()
  assert.equal(view.snapshot().fileId, 'file-util')

  // A folder that disappears stops being tracked; later events for it only refresh git state.
  service.folders['root-dir'] = [{ id: 'file-new', name: 'NEW.txt', kind: 'file' }]
  view.onFileChanged({ rootId: 'root', relativePath: 'src', change: 'rename' })
  await view.flushFileChanges()
  assert.equal(treeItemNamed(view.element, 'src'), undefined)
  service.calls.length = 0
  view.onFileChanged({ rootId: 'root', relativePath: 'src/app.js', change: 'change' })
  await view.flushFileChanges()
  assert.deepEqual(service.calls, [['status']])
  assert.equal(await view.close(), true)
  assert.equal(view.onFileChanged({ rootId: 'root', relativePath: 'NEW.txt' }), false)
})

// ---- 2-X: original save (D-X1), review writes (D-X2), resolve, line diff ----

const sha = value => createHash('sha256').update(value).digest('hex')
const leftovers = async root => (await fs.readdir(root)).filter(name => name.startsWith('.egdesk-save-'))

test('lineDiff reports separate edits as separate hunks and falls back to one block past its budget', () => {
  assert.deepEqual(lineDiff('a\nb\nc\nd\ne\nf\ng', 'a\nB\nc\nd\ne\nF\ng'), [
    { baseStartLine: 2, baseLines: ['b'], currentStartLine: 2, currentLines: ['B'] },
    { baseStartLine: 6, baseLines: ['f'], currentStartLine: 6, currentLines: ['F'] },
  ])
  assert.deepEqual(lineDiff('x\na\nb', 'a\nb\ny'), [
    { baseStartLine: 1, baseLines: ['x'], currentStartLine: 1, currentLines: [] },
    { baseStartLine: 4, baseLines: [], currentStartLine: 3, currentLines: ['y'] },
  ])
  assert.deepEqual(lineDiff('same', 'same'), [])
  assert.deepEqual(lineDiff('a\nb\nc\nd', 'a\nB\nc\nD', { maxEdits: 1 }), [{ baseStartLine: 2, baseLines: ['b', 'c', 'd'], currentStartLine: 2, currentLines: ['B', 'c', 'D'] }])
})

test('saveOriginal writes the working copy into the original, keeps the file mode, moves the handle and leaves no temporary file', async t => {
  const { root, service, rootHandle } = await fixture(t)
  const original = path.join(root, 'work.txt')
  await fs.writeFile(original, 'first\nsecond\n')
  await fs.chmod(original, 0o640)
  const id = await fileId(service, rootHandle.directoryId, 'work.txt')
  const opened = await service.createDraft({ fileId: id })
  const edited = await service.updateDraft({ draftId: opened.id, expectedHead: opened.head, text: 'first\nchanged\n', operationId: 'edit-1' })
  await assert.rejects(service.saveOriginal({ draftId: opened.id, expectedHead: opened.head, bufferRevision: 1, operationId: 'stale' }), { code: 'DRAFT_CONFLICT' })
  await assert.rejects(service.saveOriginal({ draftId: opened.id, expectedHead: edited.head, bufferRevision: 0, operationId: 'old-buffer' }), { code: 'BUFFER_CONFLICT' })
  await assert.rejects(service.saveOriginal({ draftId: opened.id, expectedHead: edited.head, bufferRevision: 1, operationId: 'bad-hash', expectedSourceHash: 'nope' }), { code: 'INVALID_HASH' })
  const saved = await service.saveOriginal({ draftId: opened.id, expectedHead: edited.head, bufferRevision: 1, operationId: 'save-original' })
  assert.equal(await fs.readFile(original, 'utf8'), 'first\nchanged\n')
  if (process.platform !== 'win32') assert.equal((await fs.stat(original)).mode & 0o777, 0o640)
  assert.deepEqual({ mode: saved.receipt.mode, written: saved.receipt.written, originalUpdated: saved.receipt.originalUpdated, sha256: saved.receipt.sha256 }, { mode: 'original', written: true, originalUpdated: true, sha256: sha('first\nchanged\n') })
  assert.equal(saved.draft.sourceHash, sha('first\nchanged\n'))
  assert.equal(saved.draft.baseText, 'first\nchanged\n')
  assert.deepEqual((await service.diffDraft({ draftId: opened.id })).hunks, [])
  assert.equal((await service.sourceStatus({ draftId: opened.id })).status, 'unchanged')
  // The same handle still reads the new inode.
  assert.equal((await service.readFile({ fileId: id })).text, 'first\nchanged\n')
  assert.deepEqual(await leftovers(root), [])
  // Saving again with nothing new passes without writing.
  const again = await service.saveOriginal({ draftId: opened.id, expectedHead: saved.draft.head, bufferRevision: 1, operationId: 'save-again' })
  assert.equal(again.receipt.written, false)
  assert.equal(again.receipt.unchanged, true)
})

test('saveOriginal never overwrites a changed original unless the user saw its hash; equal content passes', async t => {
  const { root, service, rootHandle } = await fixture(t)
  const original = path.join(root, 'notes.txt')
  await fs.writeFile(original, 'v1\n')
  const id = await fileId(service, rootHandle.directoryId, 'notes.txt')
  const opened = await service.createDraft({ fileId: id })
  const edited = await service.updateDraft({ draftId: opened.id, expectedHead: opened.head, text: 'mine\n', operationId: 'edit' })
  // Another program rewrites the file in place (same inode).
  const handle = await fs.open(original, 'r+'); await handle.truncate(0); await handle.write('theirs\n', 0); await handle.close()
  await assert.rejects(service.saveOriginal({ draftId: opened.id, expectedHead: edited.head, bufferRevision: 1, operationId: 'blocked' }), error => {
    assert.equal(error.code, 'SOURCE_CHANGED')
    assert.deepEqual(error.details, { expectedSourceHash: sha('v1\n'), currentSourceHash: sha('theirs\n'), originalUpdated: false })
    return true
  })
  assert.equal(await fs.readFile(original, 'utf8'), 'theirs\n')
  assert.equal((await service.readDraft({ draftId: opened.id })).text, 'mine\n')
  // Knowing overwrite after the comparison screen.
  const overwritten = await service.saveOriginal({ draftId: opened.id, expectedHead: edited.head, bufferRevision: 1, operationId: 'overwrite', expectedSourceHash: sha('theirs\n') })
  assert.equal(overwritten.receipt.written, true)
  assert.equal(await fs.readFile(original, 'utf8'), 'mine\n')
  // A changed original that already holds the working copy's bytes passes.
  const next = await service.updateDraft({ draftId: opened.id, expectedHead: overwritten.draft.head, text: 'same everywhere\n', operationId: 'edit-2' })
  await fs.writeFile(original, 'same everywhere\n')
  const passed = await service.saveOriginal({ draftId: opened.id, expectedHead: next.head, bufferRevision: next.bufferRevision, operationId: 'pass' })
  assert.deepEqual([passed.receipt.written, passed.receipt.unchanged], [false, true])
  assert.equal(passed.draft.sourceHash, sha('same everywhere\n'))
  assert.deepEqual(await leftovers(root), [])
})

test('saveOriginal refuses symlinks, hard links and drafts whose original is no longer connected', async t => {
  const { root, store, service, rootHandle } = await fixture(t)
  await fs.writeFile(path.join(root, 'linked.txt'), 'linked\n')
  const linkedId = await fileId(service, rootHandle.directoryId, 'linked.txt')
  await fs.link(path.join(root, 'linked.txt'), path.join(root, 'second-name.txt'))
  const linkedDraft = await service.createDraft({ fileId: linkedId })
  const linkedEdit = await service.updateDraft({ draftId: linkedDraft.id, expectedHead: linkedDraft.head, text: 'x\n', operationId: 'e' })
  await assert.rejects(service.saveOriginal({ draftId: linkedDraft.id, expectedHead: linkedEdit.head, bufferRevision: 1, operationId: 's' }), { code: 'ORIGINAL_HARD_LINKED' })
  assert.equal(await fs.readFile(path.join(root, 'second-name.txt'), 'utf8'), 'linked\n')

  await fs.writeFile(path.join(root, 'plain.txt'), 'plain\n')
  const plainId = await fileId(service, rootHandle.directoryId, 'plain.txt')
  const plainDraft = await service.createDraft({ fileId: plainId })
  const plainEdit = await service.updateDraft({ draftId: plainDraft.id, expectedHead: plainDraft.head, text: 'edited\n', operationId: 'e2' })
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'egdesk-save-outside-'))
  t.after(() => fs.rm(outside, { recursive: true, force: true }))
  await fs.writeFile(path.join(outside, 'target.txt'), 'outside\n')
  await fs.rename(path.join(root, 'plain.txt'), path.join(root, 'plain-moved.txt'))
  await fs.symlink(path.join(outside, 'target.txt'), path.join(root, 'plain.txt'))
  await assert.rejects(service.saveOriginal({ draftId: plainDraft.id, expectedHead: plainEdit.head, bufferRevision: 1, operationId: 's2' }), { code: 'SYMLINK' })
  assert.equal(await fs.readFile(path.join(outside, 'target.txt'), 'utf8'), 'outside\n')

  // After a restart the handle is gone: reconnect first.
  const restarted = createEGDeskFileService({ draftStore: store })
  await assert.rejects(restarted.saveOriginal({ draftId: plainDraft.id, expectedHead: plainEdit.head, bufferRevision: 1, operationId: 's3' }), { code: 'SOURCE_RECONNECT_REQUIRED' })
  assert.deepEqual(await leftovers(root), [])
})

test('review revert writes only against the hash the review read; a created file is removed only while unchanged', async t => {
  const { root, service, rootHandle } = await fixture(t)
  await fs.writeFile(path.join(root, 'agent.txt'), 'a\nAGENT\nc\n')
  const id = await fileId(service, rootHandle.directoryId, 'agent.txt')
  const before = await service.readFile({ fileId: id })
  await assert.rejects(service.revertReviewed({ fileId: id, expectedSha256: 'x', text: 'a\n', operationId: 'r0' }), { code: 'INVALID_HASH' })
  await assert.rejects(service.revertReviewed({ fileId: id, expectedSha256: before.sha256, text: 'bad\u0000', operationId: 'r0' }), { code: 'INVALID_TEXT' })
  const reverted = await service.revertReviewed({ fileId: id, expectedSha256: before.sha256, text: 'a\nb\nc\n', operationId: 'r1' })
  assert.deepEqual([reverted.written, reverted.sha256], [true, sha('a\nb\nc\n')])
  assert.equal(await fs.readFile(path.join(root, 'agent.txt'), 'utf8'), 'a\nb\nc\n')
  await assert.rejects(service.revertReviewed({ fileId: id, expectedSha256: before.sha256, text: 'a\nZ\nc\n', operationId: 'r2' }), { code: 'SOURCE_CHANGED' })
  const same = await service.revertReviewed({ fileId: id, expectedSha256: before.sha256, text: 'a\nb\nc\n', operationId: 'r3' })
  assert.equal(same.unchanged, true)

  await fs.writeFile(path.join(root, 'created.txt'), 'made by agent\n')
  const createdId = await fileId(service, rootHandle.directoryId, 'created.txt')
  await fs.appendFile(path.join(root, 'created.txt'), 'user line\n')
  await assert.rejects(service.deleteCreated({ fileId: createdId, expectedSha256: sha('made by agent\n'), operationId: 'd1' }), { code: 'SOURCE_CHANGED' })
  assert.equal(await fs.readFile(path.join(root, 'created.txt'), 'utf8'), 'made by agent\nuser line\n')
  const removed = await service.deleteCreated({ fileId: createdId, expectedSha256: sha('made by agent\nuser line\n'), operationId: 'd2' })
  assert.equal(removed.deleted, true)
  await assert.rejects(fs.stat(path.join(root, 'created.txt')), { code: 'ENOENT' })
  await assert.rejects(service.readFile({ fileId: createdId }), { code: 'UNKNOWN_RESOURCE' })
})

test('resolvePath maps printed paths inside the root to handles and refuses anything outside', async t => {
  const { root, service, rootHandle } = await fixture(t)
  await fs.mkdir(path.join(root, 'src'))
  await fs.writeFile(path.join(root, 'src', 'app.js'), 'app\n')
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'egdesk-resolve-outside-'))
  t.after(() => fs.rm(outside, { recursive: true, force: true }))
  await fs.writeFile(path.join(outside, 'x.txt'), 'x')
  await fs.symlink(path.join(outside, 'x.txt'), path.join(root, 'link.txt'))
  const real = (await service.describeRoot(rootHandle.rootId)).absolutePath
  for (const printed of ['src/app.js', './src/app.js', path.join(real, 'src', 'app.js'), `file://${path.join(real, 'src', 'app.js')}`]) {
    const found = await service.resolvePath({ rootId: rootHandle.rootId, path: printed })
    assert.deepEqual([found.kind, found.relativePath, found.name], ['file', 'src/app.js', 'app.js'])
    assert.equal((await service.readFile({ fileId: found.id })).text, 'app\n')
  }
  for (const printed of ['../x.txt', 'src/../../x.txt', path.join(outside, 'x.txt'), real]) {
    await assert.rejects(service.resolvePath({ rootId: rootHandle.rootId, path: printed }), { code: 'NOT_IN_ROOT' })
  }
  await assert.rejects(service.resolvePath({ rootId: rootHandle.rootId, path: 'link.txt' }), { code: 'RESOURCE_UNAVAILABLE' })
  await assert.rejects(service.resolvePath({ rootId: rootHandle.rootId, path: 'missing.txt' }), { code: 'RESOURCE_UNAVAILABLE' })
  await assert.rejects(service.resolvePath({ rootId: rootHandle.rootId, path: '' }), { code: 'INVALID_PATH' })
  const described = await service.describeRoot(rootHandle.rootId)
  assert.match(described.identity.dev, /^\d+$/)
  assert.match(described.identity.ino, /^\d+$/)
})

// ---- 2-X: File view — original save, comparison, review, project '검사', openAt ----

function originalUiFixture(overrides = {}, viewOptions = {}) {
  const calls = []
  let current = { id: 'draft', fileId: 'file', name: 'source.txt', head: 'h0', text: 'start\n', baseText: 'start\n', bufferRevision: 0, savedRevision: 0, sourceHash: 'a'.repeat(64), sourceRevision: 'source-0' }
  let disk = { text: 'start\n', sha256: 'a'.repeat(64) }
  const service = {
    listDirectory: async () => ({ entries: [{ id: 'file', name: 'source.txt', kind: 'file' }], nextCursor: null }),
    search: async () => ({ matches: [], truncated: false }),
    readFile: async ({ fileId }) => { calls.push(['read', fileId]); return { name: fileId === 'file' ? 'source.txt' : `${fileId}.js`, size: disk.text.length, sha256: disk.sha256, diskRevision: 'rev', kind: 'text', text: disk.text } },
    createDraft: async ({ fileId }) => ({ ...current, fileId }), readDraft: async () => ({ ...current }),
    updateDraft: async ({ text }) => { current = { ...current, text, head: `h${current.bufferRevision + 1}`, bufferRevision: current.bufferRevision + 1 }; return { ...current } },
    saveDraft: async () => ({ draft: { ...current }, receipt: {} }), saveAs: async () => ({}), diffDraft: async () => ({ bufferRevision: current.bufferRevision, hunks: [{ baseStartLine: 1, baseLines: ['start'], currentStartLine: 1, currentLines: [current.text.trim()] }] }),
    saveOriginal: async body => { calls.push(['saveOriginal', body]); current = { ...current, baseText: current.text, sourceHash: 'c'.repeat(64), head: `${current.head}s` }; return { draft: { ...current }, receipt: { mode: 'original', written: true, unchanged: false, originalUpdated: true, sha256: 'c'.repeat(64), size: current.text.length } } },
    resolvePath: async ({ path: printed }) => { calls.push(['resolve', printed]); return { id: `file-${printed.replace(/[^a-z]/g, '')}`, kind: 'file', name: printed, relativePath: printed } },
    ...overrides(() => current, value => { disk = value }, calls),
  }
  const document = fakeDocument()
  const view = createEGDeskFileView({ document, service, ...viewOptions })
  document.body.append(view.element)
  return { view, document, service, calls, setDisk: value => { disk = value } }
}

test('File view 원본에 저장 saves through the helper; a changed original opens the comparison before any overwrite', async () => {
  let conflictOnce = true
  const { view, calls, setDisk } = originalUiFixture((get, setDisk, calls) => ({
    saveOriginal: async body => {
      calls.push(['saveOriginal', body])
      if (conflictOnce) { conflictOnce = false; throw Object.assign(new Error('changed'), { code: 'SOURCE_CHANGED', details: { expectedSourceHash: 'a'.repeat(64), currentSourceHash: 'd'.repeat(64), originalUpdated: false } }) }
      return { draft: { ...get(), baseText: get().text, head: 'saved' }, receipt: { mode: 'original', written: true, unchanged: false, originalUpdated: true, sha256: 'e'.repeat(64), size: 5 } }
    },
  }), { parts: { diffView: DiffView } })
  await view.openFile('file')
  const saveOriginalButton = view.element.querySelector('.egdesk-file-save-original-button')
  assert.equal(saveOriginalButton.hidden, false)
  assert.equal(saveOriginalButton.disabled, false)
  const editor = view.element.querySelector('textarea')
  editor.value = 'mine\n'; editor.fire('input')
  setDisk({ text: 'theirs\n', sha256: 'd'.repeat(64) })
  saveOriginalButton.click(); await settle(8)
  const panel = view.element.querySelector('.egdesk-file-source-conflict')
  assert.equal(panel.hidden, false)
  assert.equal(panel.querySelector('.egdesk-file-source-conflict-heading').textContent, '원본이 열 때와 다릅니다')
  assert.ok(panel.querySelector('.egdesk-diff-view'), 'the comparison uses EGDeskDiffView')
  assert.deepEqual(panel.querySelectorAll('del').map(node => node.textContent), ['theirs'])
  assert.deepEqual(panel.querySelectorAll('ins').map(node => node.textContent), ['mine'])
  assert.equal(calls.filter(call => call[0] === 'saveOriginal').length, 1)
  assert.equal(calls.find(call => call[0] === 'saveOriginal')[1].expectedSourceHash, undefined)
  panel.querySelector('.egdesk-file-source-conflict-overwrite').click(); await settle(8)
  const saves = calls.filter(call => call[0] === 'saveOriginal')
  assert.equal(saves.length, 2)
  assert.equal(saves[1][1].expectedSourceHash, 'd'.repeat(64))
  assert.equal(panel.hidden, true)
  assert.equal(view.element.querySelector('.egdesk-file-status').textContent, '원본에 저장했습니다.')
  await view.close()
})

test('File view review uses EGDeskDiffView when it loads and the plain hunk layout otherwise', async () => {
  for (const diffView of [DiffView, null]) {
    const { view } = originalUiFixture(() => ({}), { parts: { diffView } })
    await view.openFile('file')
    const editor = view.element.querySelector('textarea')
    editor.value = 'start\nmore\n'; editor.fire('input')
    view.element.querySelector('.egdesk-file-review-button').click(); await settle(8)
    const panel = view.element.querySelector('.egdesk-file-review')
    assert.equal(panel.hidden, false)
    if (diffView) assert.deepEqual(panel.querySelectorAll('ins').map(node => node.textContent), ['more'])
    else assert.ok(panel.querySelector('.egdesk-file-hunk-after'))
    await view.close()
  }
  assert.equal(typeof (await loadEGDeskFileViewPart('diffView'))?.renderDiffView, 'function')
  assert.equal(typeof (await loadEGDeskFileViewPart('changeReview'))?.createChangeReview, 'function')
  assert.equal(await loadEGDeskFileViewPart('unknown'), null)
})

test('project 검사 runs a typed command, shows the result card, and failure locations open the file at the line', async () => {
  const runs = []
  const runCheck = async request => { runs.push(request); return { command: request.script.command, exitCode: 1, durationMs: 1200, output: { head: '✖ adds numbers (1.2ms)\n  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:\n      at TestContext.<anonymous> (/proj/test/math.test.mjs:12:10)\nℹ tests 3\nℹ pass 2\nℹ fail 1\n', tail: '', omittedBytes: 0 } } }
  const { view, calls } = originalUiFixture(() => ({}), { runCheck, parts: { diffView: DiffView, runResult: RunResult } })
  assert.equal(await view.openProject({ projectId: 'p1', status: 'reconnect-required', title: 'Shop' }), false)
  await view.openProject({ projectId: 'p1', status: 'connected', rootId: 'root', directoryId: 'root-dir', title: 'Shop', displayPath: '/proj', scripts: [{ id: 'test', name: '테스트', command: 'npm test', kind: 'test' }, { id: 'lint', name: '검사', command: 'npm run lint', kind: 'lint' }] })
  assert.equal(view.snapshot().projectId, 'p1')
  const projectCheck = view.element.querySelector('.egdesk-file-project-check')
  assert.equal(projectCheck.hidden, false)
  projectCheck.click(); await settle()
  const choices = view.element.querySelectorAll('.egdesk-file-check-script')
  assert.deepEqual(choices.map(choice => choice.getAttribute('aria-label')), ['테스트: npm test', '검사: npm run lint'])
  assert.equal(runs.length, 0, 'nothing runs before the user picks a command')
  choices[0].click(); await settle(8)
  assert.deepEqual(runs, [{ projectId: 'p1', rootId: 'root', script: { id: 'test', name: '테스트', command: 'npm test', kind: 'test' } }])
  const panel = view.element.querySelector('.egdesk-file-check-result')
  assert.equal(panel.querySelector('.egdesk-run-result-headline').textContent, '2 통과 · 1 실패')
  panel.querySelector('.egdesk-run-result-location').click(); await settle(8)
  assert.deepEqual(calls.find(call => call[0] === 'resolve'), ['resolve', 'test/math.test.mjs'])
  assert.equal(view.snapshot().fileId, 'file-testmathtestmjs')

  // Unsaved working-copy text is reported first instead of tested silently.
  const editor = view.element.querySelector('textarea')
  editor.value = 'changed\n'; editor.fire('input')
  view.setProjectScripts([{ id: 'test', name: '테스트', command: 'npm test', kind: 'test' }])
  projectCheck.click(); await settle(8)
  assert.equal(runs.length, 1)
  assert.match(view.element.querySelector('.egdesk-file-status').textContent, /먼저 원본에 저장하세요/)
  await view.close()
})

test('openAt resolves a printed path inside the folder and moves to the line', async () => {
  const { view, calls } = originalUiFixture(() => ({}))
  assert.equal(await view.openAt({ path: 'src/a.js', line: 2 }), false)
  await view.openRoot({ rootId: 'root', directoryId: 'root-dir', name: 'Project' })
  assert.equal(await view.openAt({ path: '/abs/src/a.js', relativePath: 'src/a.js', line: 2 }), true)
  assert.deepEqual(calls.filter(call => call[0] === 'resolve'), [['resolve', 'src/a.js']])
  assert.equal(view.snapshot().fileId, 'file-srcajs')
  assert.equal(view.element.querySelector('.egdesk-file-status').textContent, '2행으로 이동했습니다.')
  await view.close()
})

// ---- 2-X: change review (D-X2) ----

test('review chunks keep exact line endings, revert chosen chunks only, and detect a file that moved on', () => {
  const before = 'one\r\ntwo\r\nthree\r\nfour\r\nfive'
  const current = 'one\r\nTWO\r\nthree\r\nfour\r\nFIVE\nsix'
  const review = ChangeReview.reviewChunks(before, current)
  assert.equal(review.status, 'ok')
  assert.deepEqual(review.chunks.map(chunk => [chunk.baseStartLine, chunk.currentStartLine, chunk.removed, chunk.added]), [[2, 2, 1, 1], [5, 5, 1, 2]])
  assert.equal(ChangeReview.revertChunks(current, review.chunks, [0]), 'one\r\ntwo\r\nthree\r\nfour\r\nFIVE\nsix')
  assert.equal(ChangeReview.revertChunks(current, review.chunks, [1]), 'one\r\nTWO\r\nthree\r\nfour\r\nfive')
  assert.equal(ChangeReview.revertChunks(current, review.chunks, [0, 1]), before)
  assert.throws(() => ChangeReview.revertChunks('one\r\nchanged again\r\n', review.chunks, [0]), { code: 'CHUNK_DRIFT' })
  assert.deepEqual(ChangeReview.reviewChunks('same', 'same'), { status: 'empty', chunks: [] })
  assert.equal(ChangeReview.reviewChunks('a\u0000', 'b').status, 'binary')
  assert.equal(ChangeReview.reviewChunks('x'.repeat(1024 * 1024 + 1), 'y').status, 'too-large')
})

test('review targets: update diffs are reversed against the file now, created files are removable only while unchanged', () => {
  const update = { path: '/p/a.txt', kind: { type: 'update', move_path: null }, diff: '@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n' }
  const target = ChangeReview.reviewTargetFromChange(update, 'a\nB\nc\n')
  assert.deepEqual(target, { path: '/p/a.txt', change: 'update', beforeText: 'a\nb\nc\n', agentText: 'a\nB\nc\n', status: 'ok' })
  const chunks = ChangeReview.reviewChunks(target.beforeText, 'a\nB\nc\n').chunks
  assert.deepEqual(ChangeReview.reviewActions(target, 'a\nB\nc\n', chunks), { revertChunks: true, deleteFile: false, restoreFile: false, reason: null })
  assert.equal(ChangeReview.reviewTargetFromChange(update, 'a\nedited by user\nc\n').status, 'drifted')
  assert.equal(ChangeReview.reviewTargetFromChange({ ...update, diff: `${update.diff}\nMoved to: /p/b.txt` }, 'a\nB\nc\n').change, 'rename')
  const created = ChangeReview.reviewTargetFromChange({ path: '/p/new.txt', kind: 'add', diff: 'fresh\n' }, 'fresh\n')
  assert.equal(ChangeReview.reviewActions(created, 'fresh\n').deleteFile, true)
  assert.deepEqual(ChangeReview.reviewActions(created, 'fresh\nuser\n'), { revertChunks: false, deleteFile: false, restoreFile: false, reason: 'edited-after-agent' })
  const deleted = ChangeReview.reviewTargetFromChange({ path: '/p/old.txt', kind: 'delete', diff: 'old\n' }, null)
  assert.equal(ChangeReview.reviewActions(deleted, null).reason, 'restore-not-available')
  const acp = ChangeReview.reviewTargetFromChange({ path: '/p/a.txt', oldText: 'x\n', newText: 'y\n' }, 'y\n')
  assert.deepEqual([acp.change, acp.beforeText], ['update', 'x\n'])
})

test('approval card body shows the change and one decision for all of it', () => {
  const document = fakeDocument()
  const decisions = []
  const box = ChangeReview.renderApprovalChanges({ document, item: { changes: [{ path: 'a.txt', kind: 'update', diff: '@@ -1 +1 @@\n-a\n+b\n' }] }, onDecision: value => decisions.push(value) })
  assert.match(box.querySelector('.egdesk-change-approval-summary').textContent, /파일 1개 · \+1 −1/)
  box.querySelector('.egdesk-change-approval-accept').click()
  box.querySelector('.egdesk-change-approval-decline').click()
  assert.deepEqual(decisions, ['accept', 'decline'])
})

test('File view hosts the change review: chunk revert writes against the read hash, undo puts it back, a created file asks before removal', async () => {
  const files = new Map([['src/a.txt', 'a\nB\nc\nD\n'], ['src/new.txt', 'fresh\n']])
  const writes = []
  const service = {
    ...treeService(),
    resolvePath: async ({ path: printed }) => {
      const key = printed.replace('/proj/', '')
      if (!files.has(key)) throw Object.assign(new Error('missing'), { code: 'RESOURCE_UNAVAILABLE' })
      return { id: `id:${key}`, kind: 'file', name: key, relativePath: key }
    },
    readFile: async ({ fileId }) => { const text = files.get(fileId.slice(3)); return { name: fileId, size: text.length, sha256: sha(text), diskRevision: 'r', kind: 'text', text } },
    revertReviewed: async body => {
      const key = body.fileId.slice(3)
      if (sha(files.get(key)) !== body.expectedSha256) throw Object.assign(new Error('changed'), { code: 'SOURCE_CHANGED' })
      writes.push(['revert', key, body.text]); files.set(key, body.text)
      return { written: true, sha256: sha(body.text) }
    },
    deleteCreated: async body => { const key = body.fileId.slice(3); writes.push(['delete', key, body.expectedSha256]); files.delete(key); return { deleted: true } },
  }
  const document = fakeDocument()
  const view = createEGDeskFileView({ document, service, parts: { changeReview: ChangeReview } })
  document.body.append(view.element)
  await view.openRoot({ rootId: 'root', directoryId: 'root-dir', name: 'Project' })
  const review = await view.showChangeReview([
    { path: '/proj/src/a.txt', kind: 'update', diff: '@@ -1,4 +1,4 @@\n a\n-b\n+B\n c\n-d\n+D\n' },
    { path: '/proj/src/new.txt', kind: 'add', diff: 'fresh\n' },
  ])
  const panel = view.element.querySelector('.egdesk-file-change-review-panel')
  assert.equal(panel.hidden, false)
  assert.equal(panel.querySelector('.egdesk-change-review-summary').textContent, '파일 2개 · 덩어리 2개')
  // Revert only the second chunk (d → D).
  panel.querySelectorAll('.egdesk-change-review-revert')[1].click(); await settle(10)
  assert.deepEqual(writes, [['revert', 'src/a.txt', 'a\nB\nc\nd\n']])
  assert.equal(review.snapshot().canUndo, true)
  panel.querySelector('.egdesk-change-review-undo').click(); await settle(10)
  assert.deepEqual(writes.at(-1), ['revert', 'src/a.txt', 'a\nB\nc\nD\n'])
  // A file changed meanwhile is re-read, not overwritten.
  files.set('src/a.txt', 'a\nB\nc\nD\nuser\n')
  panel.querySelectorAll('.egdesk-change-review-revert')[0].click(); await settle(10)
  assert.equal(writes.length, 2)
  assert.match(panel.querySelector('.egdesk-change-review-error').textContent, /다시 읽어 왔습니다/)
  // Created file: propose, confirm, remove.
  panel.querySelector('.egdesk-change-review-delete').click(); await settle()
  assert.equal(writes.some(write => write[0] === 'delete'), false, 'nothing is removed before confirmation')
  panel.querySelector('.egdesk-change-review-delete-yes').click(); await settle(8)
  assert.deepEqual(writes.at(-1), ['delete', 'src/new.txt', sha('fresh\n')])
  assert.equal(review.snapshot().files[1].removed, true)
  await view.close()
})

// ---- 2-X: project command in the terminal (D-X6) ----

test('terminal project command: quoted folder, one-line commands only, marker-bounded output, unknown when no marker', async t => {
  const nonce = 'abcdefgh12345678'
  assert.equal(TerminalState.terminalScriptLine({ command: 'npm test', cwd: "/tmp/it's here", nonce }), `( cd -- '/tmp/it'\\''s here' && eval 'npm test' ); printf '\\n[egdesk-run:%s:exit=%d]\\n' ${nonce} "$?"\r`)
  const powershell = TerminalState.terminalScriptLine({ command: 'npm test', cwd: "C:\\it's", nonce, shell: 'powershell' })
  assert.match(powershell, /Set-Location -LiteralPath 'C:\\it''s' -ErrorAction Stop;/)
  assert.match(powershell, /\[scriptblock\]::Create\('npm test'\)/)
  assert.match(powershell, /finally \{ Set-Location -LiteralPath \$egdeskLocation.Path/)
  for (const command of ['npm test\nrm -rf /', 'a\rb', '', 'x'.repeat(1001)]) assert.throws(() => TerminalState.terminalScriptLine({ command, nonce }), { code: 'TERMINAL_RUN_COMMAND' })
  assert.throws(() => TerminalState.terminalScriptLine({ command: 'ls', nonce: 'short' }), { code: 'TERMINAL_RUN_NONCE' })
  assert.throws(() => TerminalState.terminalScriptLine({ command: 'ls', nonce, shell: 'cmd' }), { code: 'TERMINAL_RUN_SHELL' })

  const collector = TerminalState.createTerminalRunCollector({ nonce, headChars: 4, tailChars: 6 })
  const echoed = TerminalState.terminalScriptLine({ command: 'npm test', nonce }).replace('\r', '\r\n')
  assert.equal(collector.push(echoed.slice(0, 10)), null)
  assert.equal(collector.push(`${echoed.slice(10)}0123456789\nabc\n[egdesk-run:${nonce.slice(0, 5)}`), null)
  const done = collector.push(`${nonce.slice(5)}:exit=3]\n`)
  assert.equal(done.exitCode, 3)
  assert.deepEqual(done.output, { head: '0123', tail: '9\nabc\n', omittedBytes: 5 })

  const typed = []
  const run = TerminalState.createTerminalScriptRun({ write: async line => { typed.push(line); return { ok: true } }, command: 'npm test', cwd: '/proj', nonce, now: () => 1000 })
  const pending = run.start()
  run.onData(`ok\n[egdesk-run:${nonce}:exit=0]\n`)
  const result = await pending
  assert.deepEqual({ ...result }, { command: 'npm test', durationMs: 0, exitCode: 0, output: { head: 'ok\n', tail: '', omittedBytes: 0 }, status: 'completed' })
  assert.deepEqual(typed, [TerminalState.terminalScriptLine({ command: 'npm test', cwd: '/proj', nonce })])

  let fire = null
  const silent = TerminalState.createTerminalScriptRun({ write: async () => ({ ok: true }), command: 'sleep 1', nonce, schedule: fn => { fire = fn; return 1 }, cancel: () => {} })
  const waiting = silent.start()
  fire()
  assert.deepEqual([(await waiting).status, (await waiting).exitCode], ['unknown', null])
  const refused = TerminalState.createTerminalScriptRun({ write: async () => ({ ok: false, code: 'TERMINAL_INPUT_INACTIVE' }), command: 'ls', nonce, schedule: () => 1, cancel: () => {} })
  assert.deepEqual([(await refused.start()).status, (await refused.result).code], ['not-started', 'TERMINAL_INPUT_INACTIVE'])
})
