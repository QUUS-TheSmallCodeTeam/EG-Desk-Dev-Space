import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createChangeReview } from '../overlay/resources/EGDeskChangeReview.mjs'

// Stage 2 of D-X2 (적용 후 덩어리별 되돌리기) against a fake file service that
// behaves like helper/egdesk-file-service.mjs revertReviewed/deleteCreated:
// a write happens only when the file still hashes to what the screen read.
// No real filesystem, network or provider is touched.
class Node {
  constructor(tag) {
    this.tagName = tag.toUpperCase(); this.children = []; this.parentNode = null
    this.attributes = new Map(); this.listeners = new Map(); this.className = ''; this.ownText = ''; this.dataset = {}
  }
  set innerHTML(_) { throw new Error('Rendering must use textContent, never HTML') }
  set textContent(value) { this.replaceChildren(); this.ownText = String(value) }
  get textContent() { return this.ownText + this.children.map(child => child.textContent).join('') }
  setAttribute(key, value) { this.attributes.set(key, String(value)) }
  getAttribute(key) { return this.attributes.get(key) ?? null }
  append(...children) { for (const child of children) { child.remove(); child.parentNode = this; this.children.push(child) } }
  replaceChildren(...children) { for (const child of this.children) child.parentNode = null; this.children = []; this.ownText = ''; this.append(...children) }
  remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(child => child !== this); this.parentNode = null }
  matches(selector) { return selector.startsWith('.') ? this.className.split(' ').includes(selector.slice(1)) : this.tagName === selector.toUpperCase() }
  querySelectorAll(selector) { return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]) }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null }
  addEventListener(type, callback) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(callback) }
  async click() { await Promise.all([...this.listeners.get('click') || []].map(callback => callback({ type: 'click', target: this }))) }
}
const document = { createElement: tag => new Node(tag) }
const sha256 = text => createHash('sha256').update(text, 'utf8').digest('hex')
const fail = (code, details) => Object.assign(new Error(code), { code, details })

// files: path → text. writes/deletes record what the helper was asked to do.
function fakeService(files, { afterWrite = null, deleteActually = true } = {}) {
  const ids = new Map([...files.keys()].map((path, index) => [path, `file-${index}`]))
  const pathOf = fileId => [...ids].find(([, id]) => id === fileId)?.[0]
  const service = {
    writes: [], deletes: [],
    async resolvePath({ rootId, path }) {
      assert.equal(rootId, 'root-1')
      if (!files.has(path)) throw fail('RESOURCE_UNAVAILABLE')
      return { id: ids.get(path), kind: 'file', name: path.split('/').pop(), relativePath: path.slice(1) }
    },
    async readFile({ fileId }) {
      const text = files.get(pathOf(fileId))
      if (typeof text !== 'string') throw fail('UNKNOWN_RESOURCE')
      return { kind: 'text', text, sha256: sha256(text) }
    },
    async revertReviewed({ fileId, expectedSha256, text, operationId }) {
      assert.match(operationId, /^review-(revert|undo)-/)
      const path = pathOf(fileId), current = files.get(path)
      if (sha256(current) !== expectedSha256) {
        if (current === text) return { fileId, written: false, unchanged: true, sha256: sha256(current) }
        throw fail('SOURCE_CHANGED', { expectedSourceHash: expectedSha256, currentSourceHash: sha256(current) })
      }
      if (current === text) return { fileId, written: false, unchanged: true, sha256: sha256(current) }
      service.writes.push({ path, expectedSha256, text })
      files.set(path, text)
      afterWrite?.(files, path)
      return { fileId, written: true, unchanged: false, sha256: sha256(text) }
    },
    async deleteCreated({ fileId, expectedSha256 }) {
      const path = pathOf(fileId), current = files.get(path)
      if (sha256(current) !== expectedSha256) throw fail('SOURCE_CHANGED', { expectedSourceHash: expectedSha256, currentSourceHash: sha256(current) })
      service.deletes.push({ path, expectedSha256 })
      if (deleteActually) files.delete(path)
      return { fileId, deleted: true, sha256: expectedSha256 }
    },
  }
  return service
}

const BEFORE = 'a\nb\nc\n'
const AGENT = 'a\nB\nc\nd\n'
const change = { path: '/project/app.txt', kind: 'update', oldText: BEFORE, newText: AGENT }
const open = async (files, options = {}) => {
  const service = fakeService(files, options)
  const states = []
  const review = createChangeReview({ document, service, rootId: 'root-1', changes: options.changes || [change], makeOperationId: prefix => `${prefix}-1`, onState: state => states.push(state) })
  await review.load()
  const status = () => review.element.querySelector('.egdesk-change-review-status').textContent
  return { service, review, states, status, files }
}

test('the applied change is shown as numbered chunks and reverting one writes against the hash this screen read, then re-reads to confirm', async () => {
  const files = new Map([[change.path, AGENT]])
  const h = await open(files)
  assert.deepEqual(h.review.snapshot().files.map(file => [file.path, file.change, file.chunks, file.sha256]), [[change.path, 'update', 2, sha256(AGENT)]])
  assert.equal(h.review.element.querySelectorAll('.egdesk-change-review-revert').length, 2)
  assert.equal(h.review.element.querySelectorAll('.egdesk-diff-line-add').length, 2)
  assert.equal(h.review.element.querySelectorAll('.egdesk-diff-line-delete').length, 1)
  const result = await h.review.revert(0, [0])
  assert.deepEqual(h.service.writes, [{ path: change.path, expectedSha256: sha256(AGENT), text: 'a\nb\nc\nd\n' }])
  assert.equal(result.written, true)
  assert.match(h.status(), /덩어리 1개를 되돌렸습니다 · 파일을 다시 읽어 확인했습니다/)
  const after = h.review.snapshot()
  assert.equal(after.files[0].chunks, 1, 'the remaining chunk is recomputed from the re-read file')
  assert.equal(after.files[0].sha256, sha256('a\nb\nc\nd\n'))
  assert.equal(after.canUndo, true)
  await h.review.undoLastRevert()
  assert.equal(files.get(change.path), AGENT)
  assert.match(h.status(), /되돌리기를 취소했습니다 · 파일을 다시 읽어 확인했습니다/)
  assert.equal(h.review.snapshot().canUndo, false)
})

test('D-X1: when the file no longer hashes to what was read, nothing is written and the screen shows what it read against the file now', async () => {
  const files = new Map([[change.path, AGENT]])
  const h = await open(files)
  files.set(change.path, 'a\nB\nc\nd\nEXTERNAL\n')
  await h.review.element.querySelector('.egdesk-change-review-revert').click()
  assert.deepEqual(h.service.writes, [])
  const error = h.review.element.querySelector('.egdesk-change-review-error')
  assert.equal(error.hidden, false)
  assert.match(error.textContent, /열 때와 달라 쓰지 않았습니다/)
  assert.match(h.status(), /파일은 그대로입니다/)
  const conflict = h.review.element.querySelector('.egdesk-change-review-conflict')
  assert.ok(conflict, 'comparison block is shown')
  assert.match(conflict.textContent, /되돌리지 않았습니다/)
  assert.match(conflict.textContent, new RegExp(`${sha256(AGENT).slice(0, 12)} → ${sha256(files.get(change.path)).slice(0, 12)}`))
  assert.deepEqual(conflict.querySelectorAll('.egdesk-diff-line-add').map(line => line.querySelector('.egdesk-diff-text').textContent), ['EXTERNAL'])
  assert.equal(conflict.querySelectorAll('.egdesk-diff-line-delete').length, 0)
  const snapshot = h.review.snapshot()
  assert.equal(snapshot.files[0].conflict, true)
  assert.equal(snapshot.files[0].sha256, sha256(files.get(change.path)), 'the review now holds the re-read file')
  assert.equal(snapshot.files[0].chunks, 2, 'chunks are recomputed against the file now')
  assert.equal(snapshot.canUndo, false)
  await h.review.element.querySelector('.egdesk-change-review-conflict-continue').click()
  assert.equal(h.review.element.querySelectorAll('.egdesk-change-review-conflict').length, 0)
  assert.equal(h.review.snapshot().files[0].conflict, false)
})

test('a receipt that the re-read does not confirm is reported as such, and undo is not offered', async () => {
  const files = new Map([[change.path, AGENT]])
  const h = await open(files, { afterWrite: (map, path) => map.set(path, `${map.get(path)}RACED\n`) })
  const result = await h.review.revert(0, [0])
  assert.equal(result.written, true)
  assert.match(h.status(), /다시 읽은 파일이 쓴 결과와 다릅니다/)
  assert.equal(h.review.snapshot().canUndo, false)
  assert.equal(h.review.snapshot().files[0].sha256, sha256(files.get(change.path)))
})

test('a file the Agent created is removed only while unchanged, and its absence is confirmed by resolving the path again', async () => {
  const created = { path: '/project/new.txt', kind: 'add', newText: 'x\n' }
  for (const deleteActually of [true, false]) {
    const files = new Map([[created.path, 'x\n']])
    const h = await open(files, { changes: [created], deleteActually })
    assert.equal(h.review.element.querySelectorAll('.egdesk-change-review-revert').length, 0)
    assert.ok(h.review.element.querySelector('.egdesk-change-review-delete'))
    await h.review.deleteFile(0)
    assert.deepEqual(h.service.deletes, [{ path: created.path, expectedSha256: sha256('x\n') }])
    if (deleteActually) {
      assert.match(h.status(), /더 이상 없는 것을 확인했습니다/)
      assert.equal(h.review.snapshot().files[0].removed, true)
    } else {
      assert.match(h.status(), /파일이 아직 있습니다/)
      assert.equal(h.review.snapshot().files[0].removed, false)
    }
  }
  const edited = new Map([[created.path, 'x\nedited\n']])
  const h = await open(edited, { changes: [created] })
  assert.equal(h.review.element.querySelectorAll('.egdesk-change-review-delete').length, 0)
  assert.match(h.review.element.textContent, /삭제를 제안하지 않습니다/)
})

test('CODE-05: a deletion-only change is reviewable — the removed text is shown and the absence is observed, never restored', async () => {
  const removed = { path: '/project/old.txt', kind: 'delete', diff: 'gone one\ngone two\n' }
  const h = await open(new Map(), { changes: [removed] })
  assert.deepEqual(h.review.snapshot().files.map(file => [file.path, file.change, file.chunks, file.deletion]), [[removed.path, 'delete', 0, 'gone']])
  assert.match(h.review.element.querySelector('.egdesk-change-review-summary').textContent, /파일 1개 · 덩어리 0개 · 삭제 1개/)
  assert.equal(h.review.element.querySelectorAll('.egdesk-diff-line-delete').length, 2)
  assert.match(h.review.element.textContent, /파일이 없는 것을 다시 확인했습니다/)
  assert.equal(h.review.element.querySelectorAll('.egdesk-change-review-revert').length, 0)
  assert.equal(h.review.element.querySelectorAll('.egdesk-change-review-delete').length, 0)
  assert.deepEqual([h.service.writes, h.service.deletes], [[], []])
  // Same path holds a file again: reported, not touched.
  const back = await open(new Map([[removed.path, 'someone else\n']]), { changes: [removed] })
  assert.equal(back.review.snapshot().files[0].deletion, 'present')
  assert.match(back.review.element.textContent, /같은 경로에 파일이 다시 있습니다/)
  assert.deepEqual([back.service.writes, back.service.deletes], [[], []])
  // The diff view inside the review offers the side-by-side toggle.
  assert.ok(h.review.element.querySelector('.egdesk-diff-layout-split'))
})
