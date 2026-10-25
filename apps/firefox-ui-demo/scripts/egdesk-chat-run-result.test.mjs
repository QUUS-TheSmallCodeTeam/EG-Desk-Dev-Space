import test from 'node:test'
import assert from 'node:assert/strict'
import { createChatRunResultView } from '../overlay/resources/EGDeskChatRunResult.sys.mjs'

// Exercise production listeners and the real RunResult renderer, without a
// browser, runtime, terminal, provider or filesystem opener.
class Node {
  constructor(tag) {
    this.tagName = tag.toUpperCase()
    this.children = []
    this.attributes = new Map()
    this.listeners = new Map()
    this.parentNode = null
    this.className = ''
    this.ownText = ''
    this.disabled = false
  }
  set textContent(text) { this.replaceChildren(); this.ownText = String(text) }
  get textContent() { return this.ownText + this.children.map(child => child.textContent).join('') }
  set innerHTML(_) { assert.fail('output must remain text, never HTML') }
  get isConnected() { return this.tagName === 'ROOT' || this.parentNode?.isConnected === true }
  setAttribute(name, value) { this.attributes.set(name, String(value)) }
  getAttribute(name) { return this.attributes.get(name) ?? null }
  append(...nodes) {
    for (const node of nodes) { assert.ok(node instanceof Node); node.parentNode = this; this.children.push(node) }
  }
  replaceChildren(...nodes) {
    for (const child of this.children) child.parentNode = null
    this.children = []
    this.ownText = ''
    this.append(...nodes)
  }
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set())
    this.listeners.get(type).add(listener)
  }
  removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener) }
  async click() {
    if (!this.disabled) return Promise.all([...(this.listeners.get('click') || [])].map(listener => listener({ currentTarget: this })))
  }
}
const find = (node, predicate) => [node, ...node.children.flatMap(child => find(child, predicate))].filter(predicate)
const byClass = (node, name) => find(node, entry => entry.className.split(' ').includes(name))
const resultCard = node => byClass(node, 'egdesk-run-result')[0]
const identity = { conversationId: 'conversation-a', runId: 'run-a', itemId: 'item-a' }
const run = () => ({ conversationId: identity.conversationId, runId: identity.runId })
const activity = (patch = {}) => ({ id: identity.itemId, kind: 'commandExecution', status: 'completed',
  detail: { command: 'npm test', cwd: '/work/project', exitCode: 0, durationMs: 1500 }, ...patch })
const output = (patch = {}) => ({ protocolVersion: 1, ...identity, head: '',
  tail: '# tests 2\n# pass 2\n# fail 0\n', totalBytes: 31, omittedBytes: 0, complete: true, ...patch })
const failedOutput = `FAIL src/math.test.js
  ● math › subtracts

    Expected: 1
    Received: 2

      at Object.toBe (src/math.test.js:11:19)

Tests:       1 failed, 2 passed, 3 total
Ran all test suites.
`
const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function fixture(options = {}) {
  const root = new Node('root')
  const document = { createElement: tag => new Node(tag) }
  const calls = []
  let current = true
  const view = createChatRunResultView({ document, run: run(), activity: activity(),
    projectRoot: '/work/project', isCurrent: ids => current && JSON.stringify(ids) === JSON.stringify(identity),
    ...options,
    fetchJson: async (path, init) => { calls.push({ path, init }); return options.fetchJson ? options.fetchJson(path, init) : output() },
  })
  root.append(view.element)
  return { ...view, root, calls, button: view.element.children[0], current: value => { current = value } }
}

test('only an explicit production button click fetches retained output, always by GET and the original three IDs', async () => {
  const ui = fixture()
  assert.equal(ui.calls.length, 0)
  assert.equal(resultCard(ui.element), undefined)
  assert.equal(ui.element.getAttribute('data-state'), 'closed')
  assert.equal(ui.button.textContent, '실행 결과 보기')
  await ui.button.click()
  assert.equal(ui.calls.length, 1)
  const url = new URL(ui.calls[0].path, 'http://unused.invalid')
  assert.equal(url.pathname, '/chat/command-output')
  assert.deepEqual(Object.fromEntries(url.searchParams), identity)
  assert.equal(ui.calls[0].init.method, 'GET')
  assert.equal(Object.hasOwn(ui.calls[0].init, 'body'), false)
  assert.ok(ui.calls[0].init.signal instanceof AbortSignal)
  assert.equal(resultCard(ui.element).className, 'egdesk-run-result')
  assert.equal(resultCard(ui.element).getAttribute('data-outcome'), 'passed')
  assert.equal(ui.element.getAttribute('data-state'), 'ready')
  assert.match(ui.element.textContent, /민감한 내용이 가려졌을 수/)
  assert.equal(byClass(ui.element, 'egdesk-run-result-output')[0].open, undefined, 'the retained tail is collapsed')
  assert.doesNotMatch(ui.element.textContent, /다시 실행|터미널 열기/)
  await Promise.resolve()
  assert.equal(ui.calls.length, 1, 'no automatic refresh or execution callback exists')
});

test('failed output reuses the actual renderer and defaults to passive file locations with a truthful reason', async () => {
  const ui = fixture({ activity: activity({ status: 'failed', detail: { command: 'npm test', cwd: '/work/project', exitCode: 1 } }),
    fetchJson: async () => output({ tail: failedOutput, totalBytes: failedOutput.length }) })
  await ui.button.click()
  assert.equal(resultCard(ui.element).getAttribute('data-outcome'), 'failed')
  assert.equal(byClass(ui.element, 'egdesk-run-result-headline')[0].textContent, '2 통과 · 1 실패')
  const location = byClass(ui.element, 'egdesk-run-result-location')[0]
  assert.equal(location.tagName, 'SPAN')
  assert.equal(location.textContent, 'src/math.test.js:11:19')
  assert.match(ui.element.textContent, /프로젝트 연결을 확인하지 못해 파일 열기를 제공하지 않습니다/)
  assert.doesNotMatch(ui.element.textContent, /파일이 없|파일이 존재하지|file not found/i)
  await location.click()
  assert.equal(ui.calls.length, 1)
});

test('only an explicitly injected safe location callback receives the original immutable run identity', async () => {
  const opened = []
  const ui = fixture({ activity: activity({ status: 'failed', detail: { command: 'npm test', cwd: '/work/project', exitCode: 1 } }),
    fetchJson: async () => output({ tail: failedOutput, totalBytes: failedOutput.length }),
    onOpenLocation: (location, ids) => opened.push({ location, ids }) })
  await ui.button.click()
  assert.equal(opened.length, 0, 'rendering does not open a file')
  const location = byClass(ui.element, 'egdesk-run-result-location')[0]
  assert.equal(location.tagName, 'BUTTON')
  await location.click()
  assert.equal(opened.length, 1)
  assert.deepEqual(opened[0].ids, identity)
  assert.equal(Object.isFrozen(opened[0].ids), true)
  assert.equal(Object.isFrozen(opened[0].location), true)
  assert.deepEqual([opened[0].location.path, opened[0].location.line, opened[0].location.column], ['/work/project/src/math.test.js', 11, 19])
  ui.current(false)
  await location.click()
  assert.equal(opened.length, 1, 'stale file buttons never open in the new room')
});

test('a provided cwd or projectRoot never enables file opening by itself', async () => {
  for (const projectRoot of [undefined, '/work/project']) {
    const ui = fixture({ projectRoot,
      activity: activity({ status: 'failed', detail: { command: 'npm test', cwd: '/work/project', exitCode: 1 } }),
      fetchJson: async () => output({ tail: failedOutput, totalBytes: failedOutput.length }) })
    await ui.button.click()
    assert.equal(byClass(ui.element, 'egdesk-run-result-location')[0].tagName, 'SPAN')
  }
});

test('redacted file paths stay passive even if a location callback was supplied', async () => {
  const redacted = failedOutput.replaceAll('src/math.test.js', 'src/[redacted].test.js')
  const ui = fixture({ activity: activity({ status: 'failed', detail: { command: 'npm test', cwd: '/work/project', exitCode: 1 } }),
    fetchJson: async () => output({ tail: redacted, totalBytes: redacted.length }),
    onOpenLocation: () => assert.fail('a redacted path is not a verified file location') })
  await ui.button.click()
  const location = byClass(ui.element, 'egdesk-run-result-location')[0]
  assert.equal(location.tagName, 'SPAN')
  assert.match(location.textContent, /redacted/)
  await location.click()
});

test('old result listeners are fenced after a newer explicit read or disposal', async () => {
  const opened = []
  const ui = fixture({ activity: activity({ status: 'failed', detail: { command: 'npm test', cwd: '/work/project', exitCode: 1 } }),
    fetchJson: async () => output({ tail: failedOutput, totalBytes: failedOutput.length }),
    onOpenLocation: location => opened.push(location) })
  await ui.button.click()
  const oldLocation = byClass(ui.element, 'egdesk-run-result-location')[0]
  await ui.button.click()
  await oldLocation.click()
  assert.equal(opened.length, 0)
  const newLocation = byClass(ui.element, 'egdesk-run-result-location')[0]
  await newLocation.click()
  assert.equal(opened.length, 1)
  ui.dispose()
  await newLocation.click()
  assert.equal(opened.length, 1)
});

test('a failed safe file callback neither retries nor claims that the file does not exist', async () => {
  let opens = 0
  const ui = fixture({ activity: activity({ status: 'failed', detail: { command: 'npm test', cwd: '/work/project', exitCode: 1 } }),
    fetchJson: async () => output({ tail: failedOutput, totalBytes: failedOutput.length }),
    onOpenLocation: async () => { opens++; throw new Error('PRIVATE_AUTHORITY_FAILURE') } })
  await ui.button.click()
  await byClass(ui.element, 'egdesk-run-result-location')[0].click()
  await Promise.resolve()
  assert.equal(opens, 1)
  assert.equal(ui.calls.length, 1)
  assert.match(ui.element.textContent, /파일 위치를 열지 못했습니다/)
  assert.doesNotMatch(ui.element.textContent, /PRIVATE_AUTHORITY_FAILURE|파일이 없|파일이 존재하지/)
});

test('missing, unretained and empty outputs never become a success from exitCode zero', async () => {
  for (const fetchJson of [
    async () => { throw Object.assign(new Error('private server path'), { code: 'COMMAND_OUTPUT_UNAVAILABLE', status: 404 }) },
    async () => { throw Object.assign(new Error('private server path'), { code: 'RUN_NOT_FOUND', status: 404 }) },
    async () => ({ protocolVersion: 1, ...identity, retained: false }),
    async () => output({ head: '', tail: '', totalBytes: 0 }),
  ]) {
    const ui = fixture({ fetchJson })
    await ui.button.click()
    assert.equal(ui.element.getAttribute('data-state'), 'missing')
    assert.equal(resultCard(ui.element), undefined)
    assert.doesNotMatch(ui.element.textContent, /private server path|테스트 통과|빌드 성공/)
    assert.equal(ui.calls.length, 1)
  }
});

test('running and unconfirmed output completion cannot display success even with passing text and exit zero', async () => {
  for (const [status, complete, expected] of [['inProgress', false, 'running'], ['inProgress', true, 'running'], ['completed', false, 'unknown']]) {
    const ui = fixture({ activity: activity({ status }), fetchJson: async () => output({ complete }) })
    await ui.button.click()
    assert.equal(resultCard(ui.element).getAttribute('data-outcome'), expected)
    assert.equal(ui.element.getAttribute('data-state'), expected)
    assert.match(ui.element.textContent, /최종 성공 결과로 표시하지 않습니다/)
  }
});

test('passing counts without a verified terminal successful exit stay unknown', async () => {
  for (const selected of [activity({ detail: { command: 'npm test', exitCode: null } }), activity({ status: 'unknown' }), activity({ status: 'failed' })]) {
    const ui = fixture({ activity: selected })
    await ui.button.click()
    assert.equal(resultCard(ui.element).getAttribute('data-outcome'), 'unknown')
    assert.equal(byClass(ui.element, 'egdesk-run-result-headline')[0].textContent, '완료 결과 확인 안 됨')
  }
});

test('responses must match all original IDs before any output is rendered', async () => {
  for (const key of ['conversationId', 'runId', 'itemId']) {
    const ui = fixture({ fetchJson: async () => output({ [key]: 'foreign', tail: 'OTHER_ROOM_PRIVATE_OUTPUT' }) })
    await ui.button.click()
    assert.equal(ui.element.getAttribute('data-state'), 'unavailable')
    assert.equal(resultCard(ui.element), undefined)
    assert.equal(ui.element.textContent.includes('OTHER_ROOM_PRIVATE_OUTPUT'), false)
  }
});

test('late room or view changes suppress both successful output and errors without updating the old DOM', async () => {
  for (const error of [false, true]) {
    const pending = deferred()
    const ui = fixture({ fetchJson: () => pending.promise })
    const clicked = ui.button.click()
    assert.equal(ui.calls.length, 1)
    assert.equal(ui.element.getAttribute('data-state'), 'loading')
    const before = ui.element.textContent
    ui.current(false)
    if (error) pending.reject(new Error('late failure'))
    else pending.resolve(output({ tail: 'LATE_OTHER_ROOM_OUTPUT' }))
    await clicked
    assert.equal(ui.element.textContent, before)
    assert.equal(resultCard(ui.element), undefined)
    assert.equal(ui.element.getAttribute('data-state'), 'loading', 'no late write to the abandoned view')
  }
});

test('a captured view generation fences A to B to A, and detached views cannot fetch or render', async () => {
  const pending = deferred()
  let currentView = 1
  const originalView = currentView
  const ui = fixture({ isCurrent: () => currentView === originalView, fetchJson: () => pending.promise })
  const clicked = ui.button.click()
  currentView++
  currentView++
  pending.resolve(output())
  await clicked
  assert.equal(resultCard(ui.element), undefined)
  const detached = fixture()
  detached.root.replaceChildren()
  await detached.button.click()
  assert.equal(detached.calls.length, 0)
  const inFlight = deferred()
  const removed = fixture({ fetchJson: () => inFlight.promise })
  const opening = removed.button.click()
  removed.root.replaceChildren()
  inFlight.resolve(output())
  await opening
  assert.equal(resultCard(removed.element), undefined)
});

test('dispose aborts reads, disables listeners and prevents late rendering or file opening', async () => {
  const pending = deferred()
  const ui = fixture({ fetchJson: () => pending.promise })
  const clicked = ui.button.click()
  ui.dispose()
  assert.equal(ui.calls[0].init.signal.aborted, true)
  pending.resolve(output())
  await clicked
  assert.equal(ui.element.getAttribute('data-state'), 'disposed')
  assert.equal(resultCard(ui.element), undefined)
  await ui.button.click()
  assert.equal(await ui.open(), 'stale')
  assert.equal(ui.calls.length, 1)
});

test('concurrent clicks coalesce; a subsequent explicit click reads again but never reruns the command', async () => {
  const pending = deferred()
  const ui = fixture({ fetchJson: () => pending.promise })
  const clicked = ui.button.click()
  await ui.button.click()
  assert.equal(await ui.open(), 'loading')
  assert.equal(ui.calls.length, 1)
  pending.resolve(output())
  await clicked
  await ui.button.click()
  assert.equal(ui.calls.length, 2)
  assert.equal(ui.calls.every(call => call.init.method === 'GET' && call.path.startsWith('/chat/command-output?')), true)
});

test('original identity and command metadata are snapshotted instead of following later object mutations', async () => {
  const originalRun = run()
  const originalActivity = activity()
  const pending = deferred()
  const ui = fixture({ run: originalRun, activity: originalActivity, fetchJson: () => pending.promise })
  const clicked = ui.button.click()
  originalRun.conversationId = 'new-room'
  originalActivity.id = 'new-item'
  originalActivity.detail.command = 'never display this new command'
  originalActivity.detail.exitCode = 9
  pending.resolve(output())
  await clicked
  assert.deepEqual(ui.identity, identity)
  assert.equal(Object.isFrozen(ui.identity), true)
  assert.equal(byClass(ui.element, 'egdesk-run-result-command')[0].textContent, 'npm test')
  assert.equal(resultCard(ui.element).getAttribute('data-outcome'), 'passed')
});

test('query encoding preserves opaque IDs without introducing extra parameters or request bodies', async () => {
  const unusual = { conversationId: '대화&other=room', runId: 'run/a?#', itemId: 'item+one space' }
  const ui = fixture({ run: unusual, activity: activity({ id: unusual.itemId }), isCurrent: () => true,
    fetchJson: async () => output(unusual) })
  await ui.button.click()
  assert.deepEqual(Object.fromEntries(new URL(ui.calls[0].path, 'http://unused.invalid').searchParams), unusual)
});

test('malformed payloads cannot claim success or inject visible text', async () => {
  for (const value of [null, {}, output({ protocolVersion: 2 }), output({ complete: 'yes' }), output({ head: {} }),
    output({ omittedBytes: -1 }), output({ totalBytes: NaN }), output({ omittedBytes: 100, totalBytes: 1 })]) {
    const ui = fixture({ fetchJson: async () => value })
    await ui.button.click()
    assert.equal(ui.element.getAttribute('data-state'), 'unavailable')
    assert.equal(resultCard(ui.element), undefined)
  }
});

test('truncation and redaction remain explicit; output and command text cannot create HTML or expose known secret forms', async () => {
  const secret = 'sk-proj-' + 'A'.repeat(24)
  const ui = fixture({ activity: activity({ detail: { command: `npm test --api_key=${secret}`, exitCode: 0 } }),
    fetchJson: async () => output({ head: '<img src=x onerror=doNotRun()>\n', tail: `password=${secret}\n[redacted]\n# pass 2\n# fail 0\n`,
      omittedBytes: 500, totalBytes: 1000 }) })
  await ui.button.click()
  assert.equal(ui.element.textContent.includes(secret), false)
  assert.match(ui.element.textContent, /가려졌을 수/)
  assert.match(ui.element.textContent, /전체 로그가 아닙니다/)
  assert.match(ui.element.textContent, /\[redacted\]/)
  assert.equal(find(ui.element, node => node.tagName === 'IMG').length, 0)
  assert.equal(byClass(ui.element, 'egdesk-run-result-tail')[0].textContent.includes('<img'), true, 'markup stays literal output text')
});

test('transport errors remain generic and only a fresh explicit click can retry the read', async () => {
  const ui = fixture({ fetchJson: async () => { throw new Error('SECRET_TRANSPORT_DETAILS') } })
  await ui.button.click()
  assert.equal(ui.element.getAttribute('data-state'), 'error')
  assert.match(ui.element.textContent, /명령은 다시 실행하지 않았습니다/)
  assert.equal(ui.element.textContent.includes('SECRET_TRANSPORT_DETAILS'), false)
  assert.equal(ui.calls.length, 1)
  await Promise.resolve()
  assert.equal(ui.calls.length, 1)
});

test('invalid or non-command identities and absent current-view fences fail before any fetch', () => {
  const document = { createElement: tag => new Node(tag) }
  const base = { document, run: run(), activity: activity(), fetchJson: () => assert.fail('unexpected fetch'), isCurrent: () => true }
  for (const patch of [{ isCurrent: undefined }, { activity: activity({ kind: 'fileChange' }) },
    { run: { conversationId: 'conversation-a' } }, { activity: activity({ id: '' }) },
    { activity: activity({ id: 'i'.repeat(301) }) }]) {
    assert.throws(() => createChatRunResultView({ ...base, ...patch }), TypeError)
  }
});
