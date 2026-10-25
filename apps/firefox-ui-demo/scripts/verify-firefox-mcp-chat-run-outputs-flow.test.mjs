import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { chatRunOutputsOptions, prepareRunOutputDesk, assertRunOutputModuleProvenance, assertRunOutputsPeer, assertRunOutputReadOnly, assertRunOutputRead,
  assertRunOutputDelta, assertRunOutputViewPersistence, observeRunOutputDelta,
  runOutputClickAction, observeRunOutputClickTarget,
  assertRunOutputUi, assertRunOutputMetaLayout, clickRunOutputControl, observeRunOutputUi,
  runOutputActivitySelector, runOutputApprovalSelector } from './verify-firefox-mcp-chat-run-outputs-flow.mjs'
import { CHAT_RUN_OUTPUT_MARKER, CHAT_RUN_DIFF_MARKER, CHAT_RUN_OUTPUT_DELTA } from './egdesk-chat-run-outputs-fixture.mjs'

const now = Date.parse('2026-10-26T00:00:00Z')
const env = { EGDESK_QA_RUN_OUTPUTS_FIXTURE: '1', EGDESK_QA_FIXTURE_TRANSPORT: '1', EGDESK_QA_REAL_TURN: '0',
  EGDESK_QA_FIXTURE_PORT: '39220', EGDESK_QA_FIXTURE_TOKEN: 'test-token-only-123456', MOZ_HEADLESS: '1', EGDESK_MARIONETTE_PORT: '2829' }
const argv = ['--profile', '/tmp/main-owned-test-profile', '--deadline-utc', '2026-10-26T00:10:00Z']
const run = { conversationId: 'conversation-original', runId: 'run-original',
  pendingApprovals: [{ approvalId: 'approval-original', itemId: 'proposed-original', status: 'pending', choices: ['decline', 'cancel'] }] }
const effects = { providerTurns: 0, shellExecutions: 0, fileWrites: 0, approvalPosts: 0 }
const peer = () => ({ fixture: true, runOutputsFixture: true, providerTurns: 0, profile: '/tmp/main-owned-test-profile',
  host: '127.0.0.1', port: 39220, origin: 'http://127.0.0.1:39220',
  observed: { sends: [{ runId: run.runId }], approvals: [], approvalPostAttempts: 0,
    events: [], interrupts: [], resumes: [], userInputs: [], authWrites: [] },
  runs: [structuredClone(run)], runOutputs: { enabled: true, disposed: false, effects: { ...effects }, requests: [], options: [],
    scenarios: [{ runId: run.runId }], retainedRunKeys: ['conversation-original/run-original'], retainedBytes: 300 } })
const read = (route = '/chat/command-output', status = 200) => ({ method: 'GET', path: route,
  query: { conversationId: run.conversationId, runId: run.runId, itemId: 'item-original' }, status })
const layout = () => ({ visible: true, cardOverflowX: 0, metaOverflowX: 0,
  card: { left: 0, right: 300, top: 0, bottom: 180, width: 300, height: 180 },
  parts: [{ left: 10, right: 110, top: 20, bottom: 40, width: 100, height: 20 },
    { left: 118, right: 158, top: 20, bottom: 40, width: 40, height: 20 },
    { left: 166, right: 236, top: 20, bottom: 40, width: 70, height: 20 }] })
const commandUi = () => ({ count: 1, fileOpenButtons: 0, text: '이 실행의 프로젝트 연결을 확인하지 못해 파일 열기를 제공하지 않습니다.',
  result: { outcome: 'failed', headline: '2 통과 · 1 실패', headlineVisible: true, tailVisible: true,
    tail: `${CHAT_RUN_OUTPUT_MARKER}: fail`, metadata: layout() } })

const moduleNames = ['EGDeskChatRunResult.sys.mjs', 'EGDeskChatChangeReview.sys.mjs', 'EGDeskRunResult.sys.mjs',
  'EGDeskDiffView.sys.mjs', 'EGDeskChangeReview.mjs'].map(name => `resources/${name}`)
const provenance = () => ({ files: Object.fromEntries(moduleNames.map(name => [name, {
  originalSha256: 'a'.repeat(64), transformedSha256: 'a'.repeat(64), replacements: { endpointUrls: 0, helperPortConstants: 0 },
}])) })

test('module provenance requires all five own manifest entries with unchanged real-module hash receipts', () => {
  const manifest = provenance(), receipt = assertRunOutputModuleProvenance(manifest)
  assert.deepEqual(Object.keys(receipt), moduleNames)
  for (const name of moduleNames) {
    const missing = provenance(); delete missing.files[name]
    assert.throws(() => assertRunOutputModuleProvenance(missing), /Missing run-output module provenance/)
    const inherited = provenance(); delete inherited.files[name]
    Object.setPrototypeOf(inherited.files, { [name]: manifest.files[name] })
    assert.throws(() => assertRunOutputModuleProvenance(inherited), /Missing run-output module provenance/)
  }
  manifest.files[moduleNames[0]].replacements.endpointUrls = 1
  assert.equal(receipt[moduleNames[0]].replacements.endpointUrls, 0, 'evidence is detached from the manifest object')
});

test('module provenance refuses transformed code, absent hashes and every presentation rewrite', () => {
  for (const mutate of [entry => entry.transformedSha256 = 'b'.repeat(64),
    entry => { delete entry.originalSha256; delete entry.transformedSha256 },
    entry => { entry.originalSha256 = 'unverified'; entry.transformedSha256 = 'unverified' },
    entry => entry.replacements.endpointUrls++, entry => entry.replacements.helperPortConstants++,
    entry => entry.replacements.osPickerResultBoundaries = 1, entry => entry.projectPickerTransform = null,
    entry => delete entry.replacements]) {
    const manifest = provenance(); mutate(manifest.files[moduleNames[0]])
    assert.throws(() => assertRunOutputModuleProvenance(manifest))
  }
  assert.throws(() => assertRunOutputModuleProvenance(null))
});

test('import-safe options require explicit isolated model-free headless mode and a bounded UTC deadline', () => {
  assert.equal(chatRunOutputsOptions(argv, env, now).deadlineMs, now + 600000)
  assert.equal(chatRunOutputsOptions(['--profile', argv[1]], env, now).deadlineMs, now + 360000)
  for (const patch of [{ EGDESK_QA_RUN_OUTPUTS_FIXTURE: undefined }, { EGDESK_QA_REAL_TURN: '1' },
    { EGDESK_QA_FIXTURE_TRANSPORT: '0' }, { EGDESK_QA_PROJECT_FILE_FIXTURE: '1' }, { EGDESK_QA_CLAUDE_FIXTURE: '1' },
    { MOZ_HEADLESS: '0' }, { EGDESK_MARIONETTE_PORT: '2828' }, { EGDESK_QA_FIXTURE_PORT: '39218' },
    { EGDESK_QA_FIXTURE_PORT: '2829' }, { EGDESK_QA_FIXTURE_TOKEN: '' }]) {
    assert.throws(() => chatRunOutputsOptions(argv, { ...env, ...patch }, now))
  }
  for (const values of [[], ['--profile', 'relative'], [...argv, '--extra', 'x'], [...argv, '--profile', argv[1]],
    ['--profile', argv[1], '--deadline-utc', '2026-10-26T09:10:00+09:00'],
    ['--profile', argv[1], '--deadline-utc', '2026-10-25T23:00:00Z'],
    ['--profile', argv[1], '--deadline-utc', '2026-10-26T01:00:00Z']]) assert.throws(() => chatRunOutputsOptions(values, env, now))
});

function initialDesk({ focused = true, visible = false, reveal = true, expired = false, replaceBrowser = false } = {}) {
  const calls = []
  let didPress = false
  const h = { inspect: async selector => {
    calls.push(['inspect', selector]); return [{ visible: visible || didPress && reveal, disabled: false }]
  }, press: async key => { calls.push(['native-key', key]); didPress = true } }
  const options = { deadlineMs: 100, now: () => expired ? 101 : 1,
    readFirstUse: async () => {
      calls.push(['read-first-use'])
      return { initialBrowserFocus: focused && !(didPress && reveal), fullscreen: focused && !(didPress && reveal),
        cardId: 'original-browser', browserContextId: didPress && replaceBrowser ? 22 : 11 }
    }, waitUntil: async (read, accept) => {
      for (let attempt = 0; attempt < 3; attempt++) { const value = await read(); if (accept(value)) return value }
      throw new Error('native Desk never became ready')
    } }
  return { h, options, calls }
}

test('fresh Browser focus exits once through the existing native zoom-out before Chat Dock use', async () => {
  const f = initialDesk()
  const result = await prepareRunOutputDesk(f.h, f.options)
  assert.equal(result.before.initialBrowserFocus, true)
  assert.equal(result.before.dockVisible, false)
  assert.equal(result.after.initialBrowserFocus, false)
  assert.equal(result.after.dockVisible, true)
  assert.equal(result.action, 'native first-use zoom-out')
  assert.deepEqual(f.calls.filter(call => call[0] === 'native-key'), [['native-key', 'meta+-']])
  assert.equal(result.before.browserContextId, result.after.browserContextId)
});

test('already visible Desk is untouched; hidden non-focus state, ineffective exit and expired deadline fail without forcing UI', async () => {
  const ready = initialDesk({ focused: false, visible: true })
  assert.equal((await prepareRunOutputDesk(ready.h, ready.options)).action, 'already-ready')
  assert.equal(ready.calls.some(call => call[0] === 'native-key'), false)
  for (const config of [{ focused: false, visible: false }, { reveal: false }, { expired: true }, { replaceBrowser: true }]) {
    const f = initialDesk(config)
    await assert.rejects(prepareRunOutputDesk(f.h, f.options))
    assert.equal(f.calls.filter(call => call[0] === 'native-key').length, config.reveal === false || config.replaceBrowser ? 1 : 0)
  }
});

test('fixture peer must match the exact profile, endpoint, mode and zero side-effect receipts', () => {
  const options = chatRunOutputsOptions(argv, env, now)
  assert.doesNotThrow(() => assertRunOutputsPeer(peer(), options))
  for (const change of [p => p.runOutputsFixture = false, p => p.profile = '/tmp/other-profile', p => p.port++,
    p => p.origin = 'http://foreign.invalid', p => p.projectFileFixture = true, p => p.providerTurns++,
    p => p.runOutputs.disposed = true, p => p.runOutputs.effects.shellExecutions++,
    p => p.observed.approvalPostAttempts++, p => delete p.observed.approvalPostAttempts,
    p => p.observed.approvals.push({ decision: 'decline' })]) {
    const bad = peer(); change(bad); assert.throws(() => assertRunOutputsPeer(bad, options))
  }
});

test('one native open must correspond to exactly one original three-ID GET, never a duplicate, POST or foreign result', () => {
  const before = peer(), after = peer()
  after.runOutputs.requests.push(read())
  const expected = { run, route: '/chat/command-output', itemId: 'item-original' }
  assert.doesNotThrow(() => assertRunOutputRead(before, after, expected))
  for (const mutate of [p => p.runOutputs.requests.push(read()), p => p.runOutputs.requests.length = 0,
    p => p.runOutputs.requests[0].method = 'POST', p => p.runOutputs.requests[0].query.itemId = 'foreign-item',
    p => p.runOutputs.requests[0].query.runId = 'foreign-run', p => p.runOutputs.requests[0].query.conversationId = 'other-room',
    p => p.runOutputs.requests[0].query.cwd = '/unauthorized', p => p.runOutputs.requests[0].status = 404]) {
    const bad = structuredClone(after); mutate(bad); assert.throws(() => assertRunOutputRead(before, bad, expected))
  }
});

test('reading approval changes must preserve pending state and all observed mutation boundaries', () => {
  const before = peer(), after = peer()
  after.runOutputs.requests.push(read('/chat/run-changes'))
  assert.doesNotThrow(() => assertRunOutputRead(before, after, { run, route: '/chat/run-changes', itemId: 'item-original' }))
  for (const mutate of [p => p.runs[0].pendingApprovals[0].status = 'replySent',
    p => p.observed.approvals.push({ decision: 'decline' }), p => p.observed.sends.push({}),
    p => p.observed.resumes.push({}), p => p.observed.interrupts.push({}), p => p.observed.events.push({ event: 'approval.resolved' }),
    p => p.runOutputs.effects.fileWrites++, p => p.runOutputs.effects.providerTurns++,
    p => p.runOutputs.retainedBytes++, p => p.runOutputs.retainedRunKeys.push('other')]) {
    const bad = structuredClone(after); mutate(bad); assert.throws(() => assertRunOutputReadOnly(before, bad))
  }
});

test('even unchanged rejected approval POST attempts fail strict zero checks before and after viewing', () => {
  for (const value of [1, -1, '0', null, undefined]) {
    const before = peer(), after = peer()
    before.observed.approvalPostAttempts = value
    after.observed.approvalPostAttempts = value
    assert.deepEqual(before.observed.approvals, [])
    assert.deepEqual(after.observed.approvals, [])
    assert.throws(() => assertRunOutputReadOnly(before, after))
    assert.throws(() => assertRunOutputReadOnly(before, peer()))
    assert.throws(() => assertRunOutputReadOnly(peer(), after))
  }
});

function deltaWindow() {
  const before = peer()
  Object.assign(before, { seq: 8, streamId: 'original-stream' })
  const original = before.runs[0], messageId = `${original.runId}-output-message`
  Object.assign(original, { requestId: 'original-request', clientThreadId: 'original-thread',
    answerId: `${original.conversationId}/${original.runId}`, status: 'running',
    activities: [{ id: 'original-command', detail: { exitCode: 0 } }],
    messages: [{ id: messageId, role: 'assistant', status: 'streaming', text: 'Synthetic guidance.' }] })
  const after = structuredClone(before)
  after.seq++
  after.runs[0].messages[0].text += CHAT_RUN_OUTPUT_DELTA
  after.observed.events.push({ type: 'chat.event', v: 2, provider: 'codex', event: 'message.delta',
    streamId: before.streamId, seq: after.seq, ts: 12345, requestId: original.requestId,
    clientThreadId: original.clientThreadId, conversationId: original.conversationId, runId: original.runId,
    answerId: original.answerId, itemId: messageId, details: { messageId, delta: CHAT_RUN_OUTPUT_DELTA, phase: 'answer' } })
  return { before, after, target: { run: original, messageId } }
}

test('designated SSE window permits exactly one fixed same-run guidance delta while strict GET windows remain strict', () => {
  const { before, after, target } = deltaWindow()
  const originals = structuredClone({ before, after })
  assert.equal(assertRunOutputDelta(before, after, target).seq, before.seq + 1)
  assert.throws(() => assertRunOutputReadOnly(before, after), 'a message delta is NOT a read-only GET window')
  assert.deepEqual({ before, after }, originals, 'checking the exception must never mutate either receipt')
});

test('SSE allowance never hides extra reads, approvals, unrelated state, foreign identities or duplicate markers', () => {
  for (const mutate of [p => p.runOutputs.requests.push(read()), p => p.runOutputs.options.push({ method: 'OPTIONS' }),
    p => p.observed.approvalPostAttempts++, p => p.observed.approvals.push({ decision: 'decline' }),
    p => p.runs[0].pendingApprovals[0].status = 'replySent', p => p.runs[0].activities[0].detail.exitCode = 1,
    p => p.runs[0].status = 'completed', p => p.runs[0].messages[0].status = 'completed',
    p => p.runs[0].messages[0].text += CHAT_RUN_OUTPUT_DELTA, p => p.runOutputs.retainedBytes++,
    p => p.observed.events.push(structuredClone(p.observed.events[0])), p => p.seq++,
    p => p.observed.events[0].seq++, p => p.observed.events[0].conversationId = 'foreign-room',
    p => p.observed.events[0].itemId = 'foreign-message', p => p.observed.events[0].event = 'activity.completed',
    p => p.observed.events[0].details.delta = 'unapproved arbitrary text', p => p.observed.events[0].extra = true,
    p => p.runs.push({ runId: 'other-run' }), p => p.observed.resumes.push({}), p => p.clients = 2]) {
    const { before, after, target } = deltaWindow(); mutate(after)
    assert.throws(() => assertRunOutputDelta(before, after, target))
  }
  const { before, after, target } = deltaWindow()
  before.runs[0].messages[0].text += CHAT_RUN_OUTPUT_DELTA
  after.runs[0].messages[0].text += CHAT_RUN_OUTPUT_DELTA
  assert.throws(() => assertRunOutputDelta(before, after, target), /must not already exist/)
});

const readingViews = () => [
  { scope: '#original-command', ui: { ...commandUi(), commandState: 'ready', diffCount: 0, diffVisible: false, diffLines: [],
    details: [{ className: 'egdesk-run-result-output', open: true }], localScroll: [{ className: 'egdesk-run-result-tail',
      top: 64, left: 0, scrollHeight: 352, clientHeight: 288, scrollWidth: 300, clientWidth: 300 }] } },
  { scope: '#original-diff', ui: { count: 1, fileOpenButtons: 0, text: CHAT_RUN_DIFF_MARKER, commandState: null, result: null,
    diffCount: 1, diffVisible: true, diffLines: [{ kind: 'add', text: CHAT_RUN_DIFF_MARKER }],
    details: [{ className: 'egdesk-chat-change-details', open: true }, { className: 'egdesk-diff-file', open: true }],
    localScroll: [{ className: 'egdesk-diff-hunk', top: 0, left: 0, scrollHeight: 60, clientHeight: 60, scrollWidth: 300, clientWidth: 300 }] } },
]

test('SSE reading proof preserves every open disclosure, exact content and nonzero native local scroll', () => {
  const before = readingViews(), after = structuredClone(before)
  assert.doesNotThrow(() => assertRunOutputViewPersistence(before, after))
  for (const mutate of [v => v[0].ui.details[0].open = false, v => v[1].ui.details[1].open = false,
    v => v[0].ui.localScroll[0].top = 0, v => v[1].ui.localScroll[0].left = 20,
    v => v[0].ui.result.tail = 'lost output', v => v[0].ui.result.tailVisible = false,
    v => v[1].ui.diffLines = [], v => v[1].ui.diffVisible = false, v => v[1].ui.fileOpenButtons++,
    v => v[1].scope = '#other-item', v => v.pop()]) {
    const changed = readingViews(); mutate(changed)
    assert.throws(() => assertRunOutputViewPersistence(before, changed))
  }
  const neverScrolled = readingViews(); neverScrolled[0].ui.localScroll[0].top = 0
  assert.throws(() => assertRunOutputViewPersistence(neverScrolled, neverScrolled), /must be nonzero/)
});

test('actual SSE observation requires the original protocol seq and a visible, unclipped marker in its rendered assistant row', async () => {
  const { after, target } = deltaWindow(), sourceRun = after.runs[0]
  const sourceMessage = sourceRun.messages[0]
  const renderedRun = { ...sourceRun, seq: after.seq, streamId: after.streamId,
    messages: [{ ...sourceMessage, content: sourceMessage.text }] }
  for (const clipped of [false, true]) {
    const rect = { left: 10, top: 20, right: 400, bottom: 40, width: 390, height: 20 }
    const content = { isConnected: true, innerText: sourceMessage.text, parentElement: null,
      getBoundingClientRect: () => ({ ...rect, bottom: clipped ? 30 : 40 }) }
    const textNode = { data: sourceMessage.text, parentElement: content }
    const row = { dataset: { messageId: target.messageId, runId: sourceRun.runId, role: 'assistant' }, querySelector: () => content }
    const calls = []
    const h = { evaluateChrome: async expression => {
      calls.push(expression)
      assert.doesNotMatch(expression, /dispatchEvent|\.click\(|importESModule|appendChild|\.scrollTop\s*=/)
      return runInNewContext(`(${expression})()`, {
        window: { __egdesk: { state: { codex: { chatProtocol: { runs: { original: renderedRun } } } } } },
        innerWidth: 1024, innerHeight: 768, getComputedStyle: () => ({ display: 'block', visibility: 'visible', overflowY: 'auto', overflowX: 'visible' }),
        document: { querySelectorAll: () => [row], createTreeWalker() { let first = true; return { nextNode() {
          if (!first) return null; first = false; return textNode
        } } }, createRange: () => ({ setStart() {}, setEnd() {}, getClientRects: () => [rect] }) },
      })
    } }
    const proof = await observeRunOutputDelta(h, sourceRun, target.messageId)
    assert.equal(proof.seq, after.seq)
    assert.equal(proof.streamId, after.streamId)
    assert.equal(proof.rawText, sourceMessage.text)
    assert.equal(proof.visibleMarker, !clipped)
    assert.equal(calls.length, 1)
  }
});

test('command proof requires visible counts, actual opened output and no origin-less file navigation', () => {
  const expected = { outcome: 'failed', headline: '2 통과 · 1 실패', marker: `${CHAT_RUN_OUTPUT_MARKER}: fail` }
  assert.doesNotThrow(() => assertRunOutputUi(commandUi(), expected))
  for (const mutate of [u => u.count = 2, u => u.fileOpenButtons = 1, u => u.result.outcome = 'passed',
    u => u.result.headline = '3 통과', u => u.result.tail = 'unrelated output', u => u.result.tailVisible = false,
    u => u.result.headlineVisible = false, u => u.text = 'file does not exist']) {
    const bad = commandUi(); mutate(bad); assert.throws(() => assertRunOutputUi(bad, expected))
  }
});

test('diff proof checks actual added/deleted lines and the production read-only notice without file navigation', () => {
  const ui = { count: 1, fileOpenButtons: 0, diffCount: 1, diffVisible: true,
    diffLines: [{ kind: 'add', text: CHAT_RUN_DIFF_MARKER }, { kind: 'delete', text: 'before fixture' }],
    text: '보존된 변경 기록 · 읽기 전용. 일부 내용이 가려질 수 있으며 현재 파일이나 적용 완료를 확인한 결과는 아닙니다.' }
  assert.doesNotThrow(() => assertRunOutputUi(ui, { diff: true }))
  for (const mutate of [u => u.diffLines.pop(), u => u.diffVisible = false, u => u.fileOpenButtons = 1,
    u => u.diffLines[0].kind = 'context', u => u.text = '파일이 없습니다']) {
    const bad = structuredClone(ui); mutate(bad); assert.throws(() => assertRunOutputUi(bad, { diff: true }))
  }
});

test('forgotten-output proof requires a 404 read and missing UI, not an exit-zero success or unrelated error', () => {
  const before = peer(), after = peer()
  after.runOutputs.requests.push(read('/chat/command-output', 404))
  assertRunOutputRead(before, after, { run, route: '/chat/command-output', itemId: 'item-original', status: 404 })
  const missing = { count: 1, fileOpenButtons: 0, commandState: 'missing', result: null, text: '저장된 명령 출력을 사용할 수 없습니다' }
  assertRunOutputUi(missing, { unavailable: true })
  assert.throws(() => assertRunOutputUi({ ...missing, result: { outcome: 'passed' } }, { unavailable: true }))
  assert.throws(() => assertRunOutputUi({ ...missing, commandState: 'error', text: 'some other error' }, { unavailable: true }))
});

test('metadata geometry checks real spacing, overlap and horizontal overflow, permitting a genuine wrap', () => {
  assert.doesNotThrow(() => assertRunOutputMetaLayout(layout()))
  const wrapped = layout()
  Object.assign(wrapped.parts[2], { left: 10, right: 80, top: 45, bottom: 65 })
  assert.doesNotThrow(() => assertRunOutputMetaLayout(wrapped))
  for (const mutate of [l => l.parts[1].left = 110, l => l.parts[1].left = 90,
    l => l.parts[2].right = 350, l => l.metaOverflowX = 30, l => l.cardOverflowX = 2,
    l => l.parts.pop(), l => l.parts[0].width = 0, l => l.visible = false]) {
    const bad = layout(); mutate(bad); assert.throws(() => assertRunOutputMetaLayout(bad))
  }
});

const clickTarget = (extra = {}) => ({ count: 1, tag: 'summary', text: '변경 보기', visible: true, disabled: false,
  rect: { left: 110, top: 130, right: 290, bottom: 155, width: 180, height: 25 },
  bodyRect: { left: 100, top: 100, right: 500, bottom: 500, width: 400, height: 400 },
  viewport: { left: 0, top: 0, right: 1024, bottom: 768, width: 1024, height: 768 },
  scrollTop: 100, maxScroll: 700, clips: [], hittable: true, ...extra })
const instantWait = async (read, accept) => {
  for (let sample = 0; sample < 15; sample++) { const value = await read(); if (accept(value)) return value }
  throw new Error('target observation did not settle')
}

function nativeHarness({ duplicate = false, disabled = false, visible = true, tag = 'summary', label = '변경 보기',
  below = false, intercepted = false, moves = true } = {}) {
  const root = { children: [], querySelectorAll(selector) {
    assert.equal(selector, tag)
    return duplicate ? [button, { ...button }] : [button]
  } }
  const inner = { localName: 'div', children: [], parentElement: root }
  const button = { localName: tag, textContent: label, disabled, parentElement: inner }
  root.children.push(inner); inner.children.push(button)
  const calls = []
  let scrolled = false
  return { calls, clickOptions: { waitUntil: instantWait, deadlineMs: Date.now() + 60000, trace: [] }, evaluateChrome: async expression => {
    if (expression.includes('document.elementFromPoint')) {
      calls.push(['hit-test', expression])
      const target = clickTarget({ visible, disabled, tag, text: label, hittable: !intercepted })
      if (below && !scrolled) { target.rect.top = 700; target.rect.bottom = 725; target.hittable = false }
      return target
    }
    calls.push(['observe', expression])
    assert.doesNotMatch(expression, /dispatchEvent|\.click\(|createElement|importESModule|appendChild/)
    return runInNewContext(`(${expression})()`, { document: { querySelectorAll: () => [root] } })
  }, inspect: async selector => { calls.push(['inspect', selector]); return [{ visible, disabled }] },
  scrollWithKey: async (selector, key) => {
    calls.push(['native-scroll', selector, key]); scrolled = moves
    return { overflow: true, moved: moves, before: 100, after: moves ? 600 : 100 }
  },
  click: async selector => { calls.push(['native-click', selector]) } }
}

test('change-view controls are found by observation then clicked once through the native harness, never by DOM execution', async () => {
  const h = nativeHarness(), scope = runOutputApprovalSelector('approval-original')
  const selector = await clickRunOutputControl(h, scope, '변경 보기', 'summary', h.clickOptions)
  assert.equal(selector, `${scope} > div:nth-child(1) > summary:nth-child(1)`)
  assert.deepEqual(h.calls.map(row => row[0]), ['observe', 'hit-test', 'hit-test', 'hit-test', 'native-click'])
  assert.equal(h.calls.at(-1)[1], selector)
  assert.match(runOutputActivitySelector('item-original'), /data-activity-id="item-original"/)
  const command = nativeHarness({ tag: 'button', label: '실행 결과 보기' })
  await clickRunOutputControl(command, scope, '실행 결과 보기', 'button', command.clickOptions)
  assert.equal(command.calls.at(-1)[0], 'native-click')
});

test('ambiguous, disabled or hidden result controls never receive a native click', async () => {
  for (const options of [{ duplicate: true }, { disabled: true }, { visible: false }]) {
    const h = nativeHarness(options)
    await assert.rejects(clickRunOutputControl(h, '#scope', '변경 보기', 'summary', h.clickOptions))
    assert.equal(h.calls.some(row => row[0] === 'native-click'), false)
  }
});

test('positive display geometry is not click readiness when the activity viewport clips the target', () => {
  assert.equal(runOutputClickAction(clickTarget()), 'ready')
  const below = clickTarget(); Object.assign(below.rect, { top: 490, bottom: 515 })
  assert.equal(runOutputClickAction(below), 'PageDown')
  const above = clickTarget(); Object.assign(above.rect, { top: 90, bottom: 115 })
  assert.equal(runOutputClickAction(above), 'PageUp')
  for (const mutate of [v => v.hittable = false, v => v.disabled = true, v => v.visible = false,
    v => v.count = 2, v => v.rect.width = 0, v => v.rect.left = 90,
    v => v.clips.push({ x: false, y: true, rect: { ...v.bodyRect, bottom: 140, height: 40 } })]) {
    const value = clickTarget(); mutate(value); assert.equal(runOutputClickAction(value), 'blocked')
  }
  below.scrollTop = below.maxScroll
  assert.equal(runOutputClickAction(below), 'blocked', 'never click or endlessly scroll a target still clipped at the boundary')
});

test('offscreen diff summary gets measured native panel PageDown then three fresh hit tests and one click', async () => {
  const h = nativeHarness({ below: true })
  await clickRunOutputControl(h, '#original-diff', '변경 보기', 'summary', h.clickOptions)
  assert.deepEqual(h.calls.filter(row => row[0] === 'native-scroll'),
    [['native-scroll', '#egd-codex-activity-panel .egd-codex-activity-body', 'PageDown']])
  assert.equal(h.calls.filter(row => row[0] === 'native-click').length, 1)
  assert.deepEqual(h.calls.slice(-4).map(row => row[0]), ['hit-test', 'hit-test', 'hit-test', 'native-click'])
  assert.equal(h.clickOptions.trace[0].target.hittable, false)
  assert.equal(h.clickOptions.trace.at(-1).target.hittable, true)
  for (const options of [{ below: true, moves: false }, { intercepted: true }]) {
    const bad = nativeHarness(options)
    await assert.rejects(clickRunOutputControl(bad, '#original-diff', '변경 보기', 'summary', bad.clickOptions))
    assert.equal(bad.calls.some(row => row[0] === 'native-click'), false)
  }
});

test('click-target observation reads actual clipping ancestors and hit test without scrolling or editing DOM', async () => {
  const sample = clickTarget()
  const body = { parentElement: null, scrollTop: sample.scrollTop, scrollHeight: 1100, clientHeight: 400,
    getBoundingClientRect: () => sample.bodyRect }
  const node = { localName: 'summary', textContent: '변경 보기', isConnected: true, disabled: false, parentElement: body,
    closest: () => body, getBoundingClientRect: () => sample.rect, contains: target => target === node }
  let observedExpression
  const h = { evaluateChrome: async expression => {
    observedExpression = expression
    return runInNewContext(`(${expression})()`, { innerWidth: 1024, innerHeight: 768,
      document: { querySelectorAll: () => [node], elementFromPoint: () => node },
      getComputedStyle: target => ({ display: 'block', visibility: 'visible', opacity: '1', overflowX: 'visible',
        overflowY: target === body ? 'auto' : 'visible' }) })
  } }
  const observed = await observeRunOutputClickTarget(h, '#original-summary')
  assert.equal(observed.hittable, true)
  assert.equal(observed.clips.length, 1)
  assert.equal(observed.clips[0].y, true)
  assert.equal(runOutputClickAction(observed), 'ready')
  assert.doesNotMatch(observedExpression, /scrollIntoView|\.scrollTop\s*=|\.scrollLeft\s*=|\.click\(|dispatchEvent|\.style\s*=/)
});

test('result observation remains read-only and uses existing renderer metadata classes, not an injected module', async () => {
  let expression
  await observeRunOutputUi({ evaluateChrome: async value => { expression = value; return {} } }, '#original-row')
  assert.match(expression, /egdesk-run-result-meta/)
  assert.match(expression, /getBoundingClientRect/)
  assert.match(expression, /egdesk-diff-line/)
  assert.match(expression, /localScroll/)
  assert.match(expression, /node\.open/)
  assert.match(expression, /\.egdesk-run-result-output, \.egdesk-chat-change-review details/,
    'reading persistence checks retained-result disclosures, not a separately collapsed command-metadata disclosure')
  assert.doesNotMatch(expression, /dispatchEvent|\.click\(|createElement|importESModule|appendChild|\.style\s*=/)
});

test('verifier has an explicit import-safe entrypoint and no product injection, new server or approval POST path', () => {
  const source = readFileSync(new URL('./verify-firefox-mcp-chat-run-outputs-flow.mjs', import.meta.url), 'utf8')
  assert.match(source, /if \(process\.argv\[1\].*fileURLToPath\(import\.meta\.url\)/)
  assert.match(source, /await harness\.click\(selector\)/)
  assert.doesNotMatch(source, /createChatRunResultView|renderRunResultCard|ChromeUtils|createServer|\.listen\(|spawn\(|writeFile|\/chat\/approval['"]|dispatchEvent/)
  assert.equal((source.match(/sendFromComposer\(harness,/g) || []).length, 2, 'only the two fixed synthetic sends')
  assert.equal((source.match(/loopbackJson\('\/__qa\/delta',/g) || []).length, 1, 'the existing explicit control is invoked once, never by a GET')
  assert.match(source, /body: \{ runId: run\.runId, delta: CHAT_RUN_OUTPUT_DELTA \}/)
  assert.match(source, /await harness\.scrollWithKey\(/)
  assert.doesNotMatch(source, /\.scrollTop\s*=|\.scrollLeft\s*=|setTimeout\(|setInterval\(/)
  const standardValidation = 'assertRunOutputModuleProvenance(validateQaFixtureIsolation(options.profile))'
  assert.equal(source.split(standardValidation).length - 1, 2, 'standard actual-profile hashing runs before and after native QA')
  assert.ok(source.indexOf(standardValidation) < source.indexOf("await import('./egdesk-qa-ui-flow.mjs')"),
    'missing or changed module provenance fails before creating a native harness')
  assert.ok(source.indexOf('result.initialDesk = await prepareRunOutputDesk(') < source.indexOf('await newQaThread(harness,'),
    'initial focus exit precedes the first native Chat Dock click')
  assert.match(source, /readFirstUse: observeFirstUse, waitUntil/)
  assert.doesNotMatch(source, /\.style\.[A-Za-z]+\s*=(?!=)|initialBrowserFocus\s*=(?!=)|exitCardFullscreen\(|enterLocalDesk\(/)
});
