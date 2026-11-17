import test from 'node:test'
import assert from 'node:assert/strict'
import { createChatChangeReview } from '../overlay/resources/EGDeskChatChangeReview.sys.mjs'
import { DIFF_VIEW_LIMITS } from '../overlay/resources/EGDeskDiffView.sys.mjs'

// Deterministic DOM stand-in; all diff/approval nodes are built by the actual
// production modules (including their real jsdiff parser), never a renderer
// mock. No native browser, network, provider or filesystem mutation is used.
class Node {
  constructor(tag) {
    this.tagName = tag.toUpperCase(); this.children = []; this.parentNode = null
    this.attributes = new Map(); this.listeners = new Map(); this.className = ''; this.ownText = ''; this.open = false
  }
  set innerHTML(_) { throw new Error('Rendering must use textContent, never HTML') }
  set textContent(value) { this.replaceChildren(); this.ownText = String(value) }
  get textContent() { return this.ownText + this.children.map(child => child.textContent).join('') }
  get isConnected() { return this.root === true || this.parentNode?.isConnected === true }
  setAttribute(key, value) { this.attributes.set(key, String(value)) }
  getAttribute(key) { return this.attributes.get(key) ?? null }
  append(...children) {
    for (const child of children) {
      assert.ok(child instanceof Node)
      child.remove(); child.parentNode = this; this.children.push(child)
    }
  }
  replaceChildren(...children) {
    for (const child of this.children) child.parentNode = null
    this.children = []; this.ownText = ''; this.append(...children)
  }
  remove() {
    if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(child => child !== this)
    this.parentNode = null
  }
  matches(selector) { return selector.startsWith('.') ? this.className.split(' ').includes(selector.slice(1)) : this.tagName === selector.toUpperCase() }
  querySelectorAll(selector) { return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]) }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null }
  addEventListener(type, callback) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(callback) }
  removeEventListener(type, callback) { this.listeners.get(type)?.delete(callback) }
  async fire(type) { await Promise.all([...this.listeners.get(type) || []].map(callback => callback({ type, target: this }))) }
  async toggle(open) { this.open = open; await this.fire('toggle') }
  click() { return this.fire('click') }
}
function documentFixture() {
  const body = new Node('body'); body.root = true
  return { body, createElement: tag => new Node(tag) }
}
const target = Object.freeze({ conversationId: 'original-conversation', runId: 'original-run', itemId: 'approved-item' })
const patch = label => `@@ -1 +1 @@\n-before\n+${label}\n`
const item = (itemId = target.itemId, label = 'chosen change', files = null) => ({ itemId, status: 'inProgress', truncated: false, files: files || [{ path: '/original/project/app.txt', kind: 'update', movePath: null, diff: patch(label), omitted: null }] })
// The diff view's own 한 줄로/나란히 보기 toggle (CODE-05) only switches the
// display; every other button would be an action and stays forbidden.
const actionButtons = node => node.querySelectorAll('button').filter(button => !/^egdesk-diff-layout-/.test(button.className))
const packet = (items = [item()]) => ({ protocolVersion: 1, conversationId: target.conversationId, runId: target.runId, retained: true, items, turn: null })
function fixture({ kind = 'approval', requestedTarget = target, ...options } = {}) {
  const document = documentFixture(), fetched = []
  const review = createChatChangeReview({ document,
    fetchRunChanges: async value => { fetched.push(value); return packet() }, isCurrent: () => true, ...options })
  const node = kind === 'approval' ? review.renderApproval(requestedTarget) : review.renderActivity(requestedTarget)
  document.body.append(node)
  const details = node.querySelector('details')
  return { document, review, node, details, fetched, open: () => details.toggle(true), close: () => details.toggle(false) }
}

test('approval presentation selects the exact approved item before parsing and uses production read-only diff DOM', async () => {
  const other = { itemId: 'another-item', get files() { throw new Error('Do not read another item') } }
  const result = packet([other, item()])
  Object.defineProperty(result, 'turn', { get() { throw new Error('Do not fall back to a turn diff') } })
  const requests = [], decisions = []
  const h = fixture({ fetchRunChanges: async scope => { requests.push(scope); return result }, onDecision: value => decisions.push(value), replyApproval: value => decisions.push(value) })
  assert.equal(requests.length, 0, 'not fetched while the details are closed')
  await h.open()
  assert.deepEqual(requests, [target])
  assert.equal(Object.isFrozen(requests[0]), true)
  assert.equal(h.node.getAttribute('data-state'), 'ready')
  assert.match(h.node.textContent, /chosen change/)
  assert.match(h.node.textContent, /읽기 전용/)
  assert.equal(h.node.querySelectorAll('.egdesk-diff-view').length, 1)
  assert.equal(h.node.querySelectorAll('.egdesk-diff-line-add').length, 1)
  assert.equal(h.node.querySelectorAll('.egdesk-diff-line-delete').length, 1)
  assert.equal(h.node.querySelector('.egdesk-diff-file-path').textContent, '/original/project/app.txt')
  assert.equal(actionButtons(h.node).length, 0, 'no duplicate approval controls or file-opening buttons')
  assert.deepEqual(h.node.querySelector('.egdesk-diff-layout').querySelectorAll('button').map(button => button.textContent), ['한 줄로 보기', '나란히 보기'])
  assert.equal(h.node.querySelectorAll('.egdesk-change-approval-actions').length, 0)
  assert.deepEqual(decisions, [])
})

test('activity rows fetch independently only on explicit open, and closing discards the retained text', async () => {
  const document = documentFixture(), fetched = []
  const review = createChatChangeReview({ document, isCurrent: () => true, fetchRunChanges: async scope => { fetched.push(scope); return packet([item(scope.itemId, scope.itemId)]) } })
  const first = review.renderActivity(target)
  const secondTarget = { ...target, itemId: 'second-item' }
  const second = review.renderActivity(secondTarget)
  document.body.append(first, second)
  assert.deepEqual(fetched, [])
  await second.querySelector('details').toggle(true)
  assert.deepEqual(fetched, [secondTarget])
  assert.equal(first.getAttribute('data-state'), 'idle')
  assert.equal(first.querySelectorAll('.egdesk-diff-view').length, 0)
  assert.match(second.textContent, /second-item/)
  await second.querySelector('details').toggle(false)
  assert.equal(second.querySelectorAll('.egdesk-diff-view').length, 0)
  assert.equal(second.textContent.includes('second-item'), false)
  await second.querySelector('details').toggle(true)
  assert.equal(fetched.length, 2, 'reopen asks again, never a persistent output cache')
})

test('missing exact item, empty item, and unretained run are distinct and never substitute turn or sibling content', async () => {
  for (const [response, expected] of [
    [{ ...packet([item('other', 'SIBLING_SECRET')]), turn: { diff: patch('TURN_SECRET') } }, 'missing'],
    [packet([item(target.itemId, '', [])]), 'empty'],
    [{ ...packet([item(target.itemId, 'NOT_RETAINED_SECRET')]), retained: false }, 'not-retained'],
  ]) for (const kind of ['approval', 'activity']) {
    const h = fixture({ kind, fetchRunChanges: async () => response })
    await h.open()
    assert.equal(h.node.getAttribute('data-state'), expected)
    assert.equal(h.node.querySelectorAll('.egdesk-diff-view').length, 0)
    assert.doesNotMatch(h.node.textContent, /SECRET|바뀐 파일이 없습니다/)
  }
})

test('file omissions and missing diff text stay unavailable, never empty no-change claims or reconstructed old bytes', async () => {
  const writes = [], opened = []
  for (const omitted of ['fileLimit', 'runLimit', 'unavailable', null]) {
    const files = [{ path: '/original/project/file.txt', kind: 'update', diff: omitted ? patch('MUST_NOT_SHOW') : null, omitted }]
    const h = fixture({ fetchRunChanges: async () => packet([item(target.itemId, '', files)]),
      onOpenFile: value => opened.push(value), onDecision: value => writes.push(value),
      service: { rollback: value => writes.push(value), showChangeReview: value => writes.push(value) } })
    await h.open()
    assert.equal(h.node.getAttribute('data-state'), 'omitted')
    const status = h.node.querySelector('.egdesk-diff-file').getAttribute('data-status')
    assert.equal(status, ['fileLimit', 'runLimit'].includes(omitted) ? 'omitted' : 'unavailable')
    assert.doesNotMatch(h.node.textContent, /MUST_NOT_SHOW|내용 변경이 없습니다/)
    assert.equal(actionButtons(h.node).length, 0)
  }
  assert.deepEqual(writes, [])
  assert.deepEqual(opened, [])
})

test('truncated item warns that the preserved file list is incomplete', async () => {
  const h = fixture({ kind: 'activity', fetchRunChanges: async () => packet([{ ...item(), truncated: true }]) })
  await h.open()
  assert.equal(h.node.getAttribute('data-state'), 'omitted')
  assert.match(h.node.textContent, /일부 변경 내용은 보존되지 않았거나/)
  assert.match(h.node.textContent, /chosen change/)
})

test('presentation caps are reported, while unparseable retained text is not mislabeled as unretained', async () => {
  const files = Array.from({ length: DIFF_VIEW_LIMITS.maxFiles + 1 }, (_, index) => ({ path: `/original/file-${index}.txt`, kind: 'add', diff: 'kept\n', omitted: null }))
  const capped = fixture({ kind: 'activity', fetchRunChanges: async () => packet([item(target.itemId, '', files)]) })
  await capped.open()
  assert.equal(capped.node.getAttribute('data-state'), 'omitted')
  assert.equal(capped.node.querySelectorAll('.egdesk-diff-file').length, DIFF_VIEW_LIMITS.maxFiles)
  // jsdiff accepts plain preamble text as a patch with zero hunks (empty).
  // An invalid line inside a declared hunk exercises its actual parse error.
  const malformedPatch = '@@ -1,2 +1,2 @@\n*retained but not a unified patch\n'
  const raw = fixture({ fetchRunChanges: async () => packet([item(target.itemId, '', [{ path: '/original/raw.txt', kind: 'update', diff: malformedPatch, omitted: null }])]) })
  await raw.open()
  assert.equal(raw.node.getAttribute('data-state'), 'ready')
  assert.equal(raw.node.querySelector('.egdesk-diff-file').getAttribute('data-status'), 'unparsable')
  assert.match(raw.node.textContent, /retained but not a unified patch/)
  assert.doesNotMatch(raw.node.textContent, /일부 변경 내용은 보존되지/)
})

test('nonempty retained text without parsed changes is not an empty/no-change claim, even when the parser does not throw', async () => {
  for (const kind of ['approval', 'activity']) for (const diff of [
    'retained but not a unified patch', ' \n', '--- a/raw.txt\n+++ b/raw.txt\n',
    'x'.repeat(DIFF_VIEW_LIMITS.maxRawChars + 1),
  ]) {
    const h = fixture({ kind, fetchRunChanges: async () => packet([item(target.itemId, '', [
      { path: '/original/raw.txt', kind: 'update', diff, omitted: null },
    ])]) })
    await h.open()
    assert.equal(h.node.getAttribute('data-state'), 'ready')
    assert.equal(h.node.querySelector('.egdesk-diff-file').getAttribute('data-status'), 'unparsable')
    assert.match(h.node.textContent, /줄 단위로 해석하지 못했습니다/)
    assert.doesNotMatch(h.node.textContent, /내용 변경이 없습니다|바뀐 파일이 없습니다|보존되지/)
    assert.equal(h.node.querySelector('.egdesk-diff-raw').textContent,
      diff.length > DIFF_VIEW_LIMITS.maxRawChars ? `${diff.slice(0, DIFF_VIEW_LIMITS.maxRawChars)}\n…` : diff)
    assert.equal(actionButtons(h.node).length, 0)
  }
})

test('an actually empty retained change remains distinct from unrenderable nonempty text', async () => {
  for (const kind of ['approval', 'activity']) {
    const h = fixture({ kind, fetchRunChanges: async () => packet([item(target.itemId, '', [
      { path: '/original/empty.txt', kind: 'update', diff: '', omitted: null },
    ])]) })
    await h.open()
    assert.equal(h.node.getAttribute('data-state'), 'ready')
    assert.equal(h.node.querySelector('.egdesk-diff-file').getAttribute('data-status'), 'empty')
    assert.match(h.node.textContent, /내용 변경이 없습니다/)
    assert.equal(h.node.querySelectorAll('.egdesk-diff-raw').length, 0)
    assert.doesNotMatch(h.node.textContent, /해석하지 못했습니다|보존되지/)
  }
})

test('valid hunkless rename, copy, mode and binary records remain visible as records, not empty or malformed changes', async () => {
  const rename = 'diff --git a/old.txt b/new.txt\nsimilarity index 100%\nrename from old.txt\nrename to new.txt\n'
  const copy = 'diff --git a/old.txt b/copy.txt\nsimilarity index 100%\ncopy from old.txt\ncopy to copy.txt\n'
  const mode = 'diff --git a/script b/script\nold mode 100644\nnew mode 100755\n'
  const binary = 'diff --git a/image.png b/image.png\nindex 1111111..2222222 100644\nBinary files a/image.png and b/image.png differ\n'
  const records = [
    { diff: '\n\nMoved to: /original/new.txt', status: 'ok', change: 'rename', text: '/original/old.txt → /original/new.txt' },
    { diff: '', movePath: '/original/new.txt', status: 'ok', change: 'rename', text: '/original/old.txt → /original/new.txt' },
    { diff: rename, status: 'ok', change: 'rename', raw: rename },
    { diff: copy, status: 'ok', change: 'copy', raw: copy },
    { diff: mode, status: 'ok', change: 'update', raw: mode },
    { diff: binary, status: 'binary', change: 'update', raw: binary },
    { diff: 'binary\0bytes', status: 'binary', change: 'update', text: '바이너리 파일이라' },
  ]
  for (const kind of ['approval', 'activity']) for (const record of records) {
    const h = fixture({ kind, fetchRunChanges: async () => packet([item(target.itemId, '', [
      { path: '/original/old.txt', kind: 'update', diff: record.diff, movePath: record.movePath, omitted: null },
    ])]) })
    await h.open()
    const file = h.node.querySelector('.egdesk-diff-file')
    assert.equal(file.getAttribute('data-status'), record.status)
    assert.equal(file.getAttribute('data-change'), record.change)
    assert.equal(h.node.getAttribute('data-state'), 'ready')
    assert.doesNotMatch(h.node.textContent, /내용 변경이 없습니다|해석하지 못했습니다|보존되지/)
    if (record.text) assert.ok(h.node.textContent.includes(record.text))
    if (record.raw) assert.equal(h.node.querySelector('.egdesk-diff-raw')?.textContent, record.raw)
    assert.equal(actionButtons(h.node).length, 0)
  }
})

test('hunkless metadata paths stay evidence, never new file-opening targets even with a verified origin', async () => {
  const opened = []
  const diff = 'diff --git a/old.txt b/new.txt\nsimilarity index 100%\nrename from old.txt\nrename to new.txt\n'
  const h = fixture({ kind: 'activity', onOpenFile: value => opened.push(value),
    getVerifiedOrigin: () => ({ verified: true, ...target, rootId: 'original-root' }),
    fetchRunChanges: async () => packet([item(target.itemId, '', [
      { path: '/original/recorded.txt', kind: 'update', diff, omitted: null },
    ])]) })
  await h.open()
  assert.equal(h.node.querySelector('.egdesk-diff-file').getAttribute('data-change'), 'rename')
  assert.equal(h.node.querySelector('.egdesk-diff-file-path').textContent, '/original/recorded.txt')
  assert.equal(h.node.querySelector('.egdesk-diff-raw').textContent, diff)
  assert.equal(h.node.querySelectorAll('.egdesk-diff-open').length, 0)
  assert.deepEqual(opened, [])
})

test('missing IDs, wrong response identities, ambiguous duplicate items and malformed retention fail closed', async () => {
  for (const requestedTarget of [{}, { ...target, itemId: '' }, { ...target, runId: null }]) {
    const h = fixture({ requestedTarget })
    await h.open()
    assert.equal(h.node.getAttribute('data-state'), 'unavailable')
    assert.deepEqual(h.fetched, [])
  }
  for (const response of [
    { ...packet(), conversationId: 'another-conversation' }, { ...packet(), runId: 'another-run' },
    { ...packet(), protocolVersion: 99 }, { ...packet(), retained: undefined }, packet([item(), item()]),
    packet([{ itemId: target.itemId }]), packet([item(target.itemId, '', [{ kind: 'add', diff: 'bad' }])]),
  ]) {
    const h = fixture({ fetchRunChanges: async () => response })
    await h.open()
    assert.equal(h.node.getAttribute('data-state'), 'unavailable')
    assert.equal(h.node.querySelectorAll('.egdesk-diff-view').length, 0)
  }
})

test('late responses are fenced by the original conversation, run AND item', async () => {
  for (const key of ['conversationId', 'runId', 'itemId']) {
    const deferred = Promise.withResolvers()
    const active = { ...target }, requestedTarget = { ...target }
    const h = fixture({ requestedTarget, fetchRunChanges: () => deferred.promise, isCurrent: scope => Object.keys(target).every(name => scope[name] === active[name]) })
    const opening = h.open()
    assert.equal(h.node.getAttribute('data-state'), 'loading')
    active[key] = `new-${key}`
    requestedTarget[key] = active[key]
    deferred.resolve(packet([item(target.itemId, 'LATE_SECRET')]))
    await opening
    assert.equal(h.node.getAttribute('data-state'), 'stale')
    assert.doesNotMatch(h.node.textContent, /LATE_SECRET/)
    assert.equal(h.node.querySelectorAll('.egdesk-diff-view').length, 0)
  }
})

test('closing and reopening the same item fences older success and failure responses', async () => {
  for (const rejectOld of [false, true]) {
    const old = Promise.withResolvers(), fresh = Promise.withResolvers()
    let count = 0
    const h = fixture({ fetchRunChanges: () => ++count === 1 ? old.promise : fresh.promise })
    const oldOpen = h.open()
    await h.close()
    const newOpen = h.open()
    fresh.resolve(packet([item(target.itemId, 'NEW_RESPONSE')]))
    await newOpen
    if (rejectOld) old.reject(new Error('private old response'))
    else old.resolve(packet([item(target.itemId, 'OLD_RESPONSE')]))
    await oldOpen
    assert.equal(h.node.getAttribute('data-state'), 'ready')
    assert.match(h.node.textContent, /NEW_RESPONSE/)
    assert.doesNotMatch(h.node.textContent, /OLD_RESPONSE|private old/)
  }
})

test('detached, invalidated and disposed cards discard late responses and cannot dispatch stale actions', async () => {
  for (const action of ['detach', 'invalidate', 'dispose']) {
    const deferred = Promise.withResolvers()
    const h = fixture({ fetchRunChanges: () => deferred.promise })
    const opening = h.open()
    if (action === 'detach') h.node.remove()
    else h.review[action]()
    deferred.resolve(packet([item(target.itemId, 'STALE_BYTES')]))
    await opening
    assert.doesNotMatch(h.node.textContent, /STALE_BYTES/)
    assert.equal(h.node.querySelectorAll('.egdesk-diff-view').length, 0)
    if (action === 'dispose') assert.throws(() => h.review.renderActivity(target), /disposed/)
  }
})

test('transport failures and unsafe-looking text remain display-only and reveal no raw error details', async () => {
  const failed = fixture({ fetchRunChanges: async () => { throw new Error('secret-token /private/path stack trace') } })
  await failed.open()
  assert.equal(failed.node.getAttribute('data-state'), 'unavailable')
  assert.doesNotMatch(failed.node.textContent, /secret-token|private\/path|stack trace/)
  const literal = fixture({ fetchRunChanges: async () => packet([item(target.itemId, '<img src=x onerror=alert(1)>')]) })
  await literal.open()
  assert.match(literal.node.textContent, /<img src=x onerror=alert\(1\)>/)
  assert.equal(literal.node.querySelectorAll('img').length, 0)
  assert.equal(literal.node.querySelectorAll('script').length, 0)
})

test('no verified run origin means no file-opening affordance, even when a callback or active Board path is provided', async () => {
  const opened = []
  for (const origin of [undefined, null, { verified: false }, { verified: true, conversationId: 'wrong', runId: target.runId, rootId: 'root' },
    { verified: true, conversationId: target.conversationId, runId: 'wrong', rootId: 'root' },
    { verified: true, conversationId: target.conversationId, runId: target.runId }]) {
    const h = fixture({ kind: 'activity', onOpenFile: value => opened.push(value), activeBoard: { rootId: 'board-root', path: '/active/board' },
      ...(origin !== undefined ? { getVerifiedOrigin: () => origin } : {}) })
    await h.open()
    assert.equal(h.node.querySelectorAll('.egdesk-diff-open').length, 0)
  }
  assert.deepEqual(opened, [])
})

test('verified-origin activity callback receives original IDs and literal path/line, and is fenced again when clicked', async () => {
  const opened = []
  let active = true
  let origin = { verified: true, conversationId: target.conversationId, runId: target.runId, rootId: 'original-root', projectId: 'original-project' }
  const h = fixture({ kind: 'activity', isCurrent: () => active, getVerifiedOrigin: () => origin, onOpenFile: value => opened.push(value) })
  await h.open()
  const button = h.node.querySelector('.egdesk-diff-open')
  assert.ok(button)
  await button.click()
  assert.deepEqual(opened, [{ ...target, path: '/original/project/app.txt', line: 1, origin }])
  active = false
  await button.click()
  active = true
  origin = { ...origin, rootId: 'different-root' }
  await button.click()
  assert.equal(opened.length, 1)
  origin = { ...origin, rootId: 'original-root' }
  await h.close()
  await button.click()
  assert.equal(opened.length, 1)
})

test('an applied change offers the stage-2 review only to the host, with the original IDs and retained rows, fenced like file opening', async () => {
  const requests = []
  let active = true
  const readOrigin = async () => ({ protocolVersion: 1, status: 'verified', verified: true })
  const rows = [
    { path: '/original/project/app.txt', kind: 'update', movePath: null, diff: patch('applied change'), omitted: null },
    { path: '/original/project/gone.txt', kind: 'delete', movePath: null, diff: 'old\n', omitted: null },
    { path: '/original/project/big.txt', kind: 'update', movePath: null, diff: null, omitted: 'fileLimit' },
  ]
  const document = documentFixture()
  const review = createChatChangeReview({ document, isCurrent: () => active, readOrigin,
    fetchRunChanges: async () => packet([item(target.itemId, '', rows)]),
    onReviewApplied: async request => { requests.push(request); return { status: 'opened', cardId: 'file-card-1' } } })
  const node = review.renderActivity(target, { applied: true })
  document.body.append(node)
  await node.querySelector('details').toggle(true)
  const button = node.querySelector('.egdesk-chat-change-review-open')
  assert.ok(button, 'an applied activity offers the review')
  assert.equal(node.querySelectorAll('.egdesk-diff-open').length, 0, 'no synchronous verified origin, so no file-opening buttons')
  assert.match(node.textContent, /덩어리별로 되돌릴 수 있습니다/)
  await button.click()
  assert.equal(requests.length, 1)
  const request = requests[0]
  assert.deepEqual(request.target, target)
  assert.equal(request.readOrigin, readOrigin)
  assert.equal(Object.isFrozen(request.changes), true)
  assert.deepEqual(request.changes.map(row => [row.path, row.kind, row.diff]), [
    ['/original/project/app.txt', 'update', patch('applied change')], ['/original/project/gone.txt', 'delete', 'old\n']], 'omitted rows are not reviewable')
  assert.equal(request.isCurrent(target), true)
  assert.equal(request.isCurrent({ ...target, itemId: 'other' }), false)
  assert.match(node.textContent, /덩어리별 되돌리기를 열었습니다/)
  assert.doesNotMatch(node.textContent, /file-card-1/)
  active = false
  assert.equal(request.isCurrent(target), false)
  await button.click()
  assert.equal(requests.length, 1, 'a stale card dispatches nothing')
})

test('the stage-2 review is never offered without both hooks, for approvals, or for a change that was not applied', async () => {
  const hooks = { readOrigin: async () => ({}), onReviewApplied: async () => ({ status: 'opened' }) }
  const cases = [
    ['activity', { readOrigin: hooks.readOrigin }, { applied: true }, 'completed'],
    ['activity', { onReviewApplied: hooks.onReviewApplied }, { applied: true }, 'completed'],
    ['activity', hooks, { applied: false }, 'inProgress'],
    ['activity', hooks, undefined, 'inProgress'],
    ['activity', hooks, { applied: true }, 'declined'],
    ['activity', hooks, { applied: true }, 'failed'],
    ['approval', hooks, { applied: true }, 'completed'],
  ]
  for (const [kind, options, renderOptions, status] of cases) {
    const document = documentFixture()
    const review = createChatChangeReview({ document, isCurrent: () => true, fetchRunChanges: async () => packet([{ ...item(), status }]), ...options })
    const node = kind === 'approval' ? review.renderApproval(target) : review.renderActivity(target, renderOptions)
    document.body.append(node)
    await node.querySelector('details').toggle(true)
    assert.equal(node.getAttribute('data-state'), 'ready')
    assert.equal(node.querySelectorAll('.egdesk-chat-change-review-open').length, 0, `${kind} ${status} ${Object.keys(options).join(',')}`)
  }
  // A retained item the bridge already marks completed needs no host flag.
  const document = documentFixture()
  const review = createChatChangeReview({ document, isCurrent: () => true, fetchRunChanges: async () => packet([{ ...item(), status: 'completed' }]), ...hooks })
  const node = review.renderActivity(target)
  document.body.append(node)
  await node.querySelector('details').toggle(true)
  assert.equal(node.querySelectorAll('.egdesk-chat-change-review-open').length, 1)
  await node.querySelector('details').toggle(false)
  assert.equal(node.querySelectorAll('.egdesk-chat-change-review-open').length, 0, 'closing discards the offer with the retained text')
})

test('approval rendering never exposes decisions or file-open buttons even with verified origin and injected action hooks', async () => {
  const dispatched = []
  const h = fixture({ onDecision: value => dispatched.push(value), replyPending: value => dispatched.push(value),
    onOpenFile: value => dispatched.push(value), getVerifiedOrigin: () => ({ verified: true, conversationId: target.conversationId, runId: target.runId, rootId: 'original-root' }) })
  await h.open()
  assert.equal(actionButtons(h.node).length, 0)
  await h.close()
  await h.open()
  assert.deepEqual(dispatched, [])
})
