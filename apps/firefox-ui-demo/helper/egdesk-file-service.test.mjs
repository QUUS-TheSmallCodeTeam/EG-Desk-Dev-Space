import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { createEGDeskFileService } from './egdesk-file-service.mjs'
import { createEGDeskFileView, suggestEGDeskCopyName } from '../overlay/resources/EGDeskFileView.sys.mjs'

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
