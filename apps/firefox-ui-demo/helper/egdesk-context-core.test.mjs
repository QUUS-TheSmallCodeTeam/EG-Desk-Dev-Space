import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { ImmutableContextStore, hashContent, appDataDirectory } from './egdesk-context-store.mjs'
import { ContextRuntime, CONTEXT_TOOL_SPECS } from './egdesk-context-runtime.mjs'
import { createContextHttpHandler } from './egdesk-context-http.mjs'
import { CodexChatRuntime } from './codex-chat-runtime.mjs'
import { NativeReaderClient } from './egdesk-native-reader.mjs'

async function harness(t, options = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'egdesk-context-test-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const cwd = path.join(dir, 'workspace'); await mkdir(cwd)
  let owner = 'email:a@example.com', nativeSeq = 0
  const store = new ImmutableContextStore({ dataDir: path.join(dir, 'state'), allowedRoots: [cwd], managedFileView: options.managedFileView })
  const contexts = new ContextRuntime({ store, reader: options.reader || null, getOwnerKey: () => owner, schemaReady: () => options.schemaReady !== false })
  const calls = [], replies = [], events = []
  const chat = new CodexChatRuntime({
    contexts, respond: (id, result, error) => { if (options.throwRespond) throw new Error('Socket disconnected'); replies.push({ id, result, error }) }, emit: e => events.push(e),
    request: async (method, params) => {
      calls.push({ method, params })
      if (method === 'thread/start') return { thread: { id: `parent-${++nativeSeq}` }, cwd, model: 'configured-model' }
      if (method === 'thread/resume') return { thread: { id: params.threadId, turns: [] }, cwd }
      if (method === 'turn/start') {
        if (options.earlyTool) await chat.handleServerRequest({ id: 'early', method: 'item/tool/call', params: { threadId: params.threadId, turnId: `turn-${nativeSeq}`, callId: 'early', tool: 'egdesk_list_context', arguments: {} } })
        return { turn: { id: `turn-${nativeSeq}`, status: 'inProgress', items: [] } }
      }
      if (method === 'turn/interrupt') return {}
      throw new Error(`Unexpected native method ${method}`)
    },
  })
  chat.setConnection(true)
  const capture = async (text = 'Original selected text', extra = {}) => (await contexts.capture({ clientThreadId: 'ui', attachments: [{ id: 'attachment', kind: 'browser', label: 'Selected page', sourceRef: { viewId: 'view-1', resourceId: 'page-1', url: 'https://example.com/page?token=private' }, capturedAt: 10, captureScope: { type: 'dom-range', locator: '#selected' }, content: { mime: 'text/plain', text, truncated: false }, ...extra }] })).captures[0]
  const start = async (ids, settings = {}) => chat.send({ message: 'Use selected sources', requestId: `req-${nativeSeq}`, clientThreadId: 'ui', cwd, contextSnapshotIds: ids, contextCapabilities: { read: true, reader: true, publishBriefing: true }, ...settings })
  const tool = async (run, name, args, id = `call-${replies.length}`) => {
    await chat.handleServerRequest({ id, method: 'item/tool/call', params: { threadId: run.conversationId, turnId: run.runId, callId: id, tool: name, arguments: args } })
    await contexts.calls.get(`${run.answerId}/${id}`)
    return replies.find(reply => reply.id === id)
  }
  return { dir, cwd, store, contexts, chat, calls, replies, events, capture, start, tool, changeOwner: value => { owner = value } }
}

test('app data defaults do not use a repository cwd; explicit config must be absolute', () => {
  assert.equal(appDataDirectory({}, '/user', 'darwin'), '/user/Library/Application Support/EG-Desk')
  assert.throws(() => appDataDirectory({ EGDESK_DATA_DIR: 'relative' }), /absolute/)
})

test('file capture is immutable, root scoped, and new bytes require a new source/hash', async t => {
  const h = await harness(t)
  const file = path.join(h.cwd, 'source.md'); await writeFile(file, 'first version\nsecond line')
  const request = { clientThreadId: 'ui', attachments: [{ id: 'file-ui', kind: 'file', label: 'Source', sourceRef: { path: file }, captureScope: { type: 'file' } }] }
  const first = (await h.contexts.capture(request)).captures[0]
  await writeFile(file, 'new version')
  const inspected = await h.store.inspect('email:a@example.com', first.sourceId)
  assert.equal(inspected.source.text, 'first version\nsecond line')
  assert.equal(inspected.source.hash, hashContent('first version\nsecond line'))
  assert.equal(inspected.delivered, null)
  const second = (await h.contexts.capture(request)).captures[0]
  assert.notEqual(first.sourceId, second.sourceId)
  assert.notEqual(first.hash, second.hash)
  const outside = path.join(h.dir, 'outside.txt'); await writeFile(outside, 'outside')
  await assert.rejects(h.contexts.capture({ ...request, attachments: [{ ...request.attachments[0], sourceRef: { path: outside } }] }), e => e.code === 'SOURCE_OUTSIDE_ROOT')
})

test('managed working-copy capture uses opaque local file identity and preserves old immutable history', async t => {
  const state = { head: 'head-1', revision: 0, text: 'First working copy\n' }
  const managedFileView = {
    resolveCaptureSource: async ({ captureRef, assertActive }) => {
      assertActive()
      if (captureRef.fileId !== 'file-1' || captureRef.draftId !== 'draft-1' || captureRef.head !== state.head || captureRef.revision !== state.revision) throw Object.assign(new Error('stale draft'), { code: 'CAPTURE_STALE' })
      const bytes = Buffer.from(state.text)
      return { captureRef: { ...captureRef }, name: 'work.md', mime: 'text/plain', bytes, sha256: hashContent(bytes) }
    },
  }
  const h = await harness(t, { managedFileView })
  const attachment = (head, revision) => ({ id: 'file-ui', kind: 'file', managedFileView: { fileId: 'file-1', draftId: 'draft-1', head, revision }, captureScope: { type: 'file' } })
  const capture = async (head, revision) => (await h.contexts.capture({ clientThreadId: 'ui', attachments: [attachment(head, revision)] })).captures[0]
  const first = await capture(state.head, state.revision)
  assert.equal(first.sourceRef.managedFileView.draftId, 'draft-1')
  assert.equal(first.sourceRef.revision, '0')
  assert.equal(first.capture.coverage.provenance, 'managed-working-copy')
  assert.equal(first.shape.format, 'text')
  assert.equal(first.sourceRef.path, undefined)
  state.head = 'head-2'; state.revision = 1; state.text = 'Second working copy\n'
  await assert.rejects(capture('head-1', 0), e => e.code === 'CAPTURE_STALE')
  await assert.rejects(capture('head-2', 0), e => e.code === 'CAPTURE_STALE')
  const second = await capture('head-2', 1)
  assert.notEqual(first.sourceId, second.sourceId)
  assert.notEqual(first.hash, second.hash)
  assert.equal((await h.store.inspect('email:a@example.com', first.sourceId)).source.text, 'First working copy\n')
  assert.equal((await h.store.inspect('email:a@example.com', second.sourceId)).source.text, 'Second working copy\n')
  await assert.rejects(h.contexts.capture({ clientThreadId: 'ui', attachments: [{ ...attachment('head-2', 1), sourceRef: { path: '/not-an-authority' } }] }), e => e.code === 'INVALID_CAPTURE_REF')
})

test('managed working-copy capture rejects a head change during snapshot storage', async t => {
  const state = { head: 'h1', revision: 0, text: 'Old bytes' }
  const h = await harness(t, { managedFileView: {
    resolveCaptureSource: async ({ captureRef, assertActive }) => {
      assertActive()
      if (captureRef.head !== state.head || captureRef.revision !== state.revision) throw Object.assign(new Error('draft changed'), { code: 'CAPTURE_STALE' })
      const bytes = Buffer.from(state.text)
      return { captureRef: { ...captureRef }, name: 'source.txt', mime: 'text/plain', bytes, sha256: hashContent(bytes) }
    },
  } })
  let entered, release
  const paused = new Promise(resolve => { entered = resolve })
  const blob = h.store.blob.bind(h.store)
  let pausedOnce = false
  h.store.blob = async (...args) => {
    const result = await blob(...args)
    if (!pausedOnce) { pausedOnce = true; entered(); await new Promise(resolve => { release = resolve }) }
    return result
  }
  const pending = h.contexts.capture({ clientThreadId: 'ui', attachments: [{ kind: 'file', managedFileView: { fileId: 'file', draftId: 'draft', head: 'h1', revision: 0 }, captureScope: { type: 'file' } }] })
  await paused
  state.head = 'h2'; state.revision = 1; state.text = 'New bytes'
  release()
  await assert.rejects(pending, e => e.code === 'CAPTURE_STALE')
  assert.equal((await h.store.listRecords('email:a@example.com', 'sources')).length, 0)
})

test('managed working-copy capture cannot publish after an account or engine generation switch', async t => {
  let entered, release
  const paused = new Promise(resolve => { entered = resolve })
  const h = await harness(t, { managedFileView: {
    resolveCaptureSource: async ({ captureRef, assertActive }) => {
      entered(); await new Promise(resolve => { release = resolve }); assertActive()
      const bytes = Buffer.from('old account')
      return { captureRef: { ...captureRef }, name: 'source.txt', mime: 'text/plain', bytes, sha256: hashContent(bytes) }
    },
  } })
  const pending = h.contexts.capture({ clientThreadId: 'ui', attachments: [{ kind: 'file', managedFileView: { fileId: 'file', draftId: 'draft', head: 'h1', revision: 0 }, captureScope: { type: 'file' } }] })
  await paused
  h.changeOwner('email:b@example.com')
  h.chat.reset()
  release()
  await assert.rejects(pending, e => e.code === 'ACCOUNT_CHANGED')
  assert.equal((await h.store.listRecords('email:a@example.com', 'sources')).length, 0)
})

test('DOM capture preserves explicit scope and truncation; source and delivered roles are distinct', async t => {
  const h = await harness(t)
  const capture = await h.capture('API_KEY=private-value\nvisible selection', { content: { mime: 'text/plain', text: 'API_KEY=private-value\nvisible selection', truncated: true } })
  assert.equal(capture.captureScope.type, 'dom-range')
  assert.equal(capture.truncated, true)
  assert.equal(capture.capture.coverage.complete, false)
  assert.equal(capture.capturedAt, 10)
  assert.equal(capture.sourceRef.viewId, 'view-1')
  assert.ok(!capture.sourceRef.url.includes('private'))
  assert.notEqual(capture.payloads.source.hash, capture.payloads.projection.hash)
  const inspected = await h.store.inspect('email:a@example.com', capture.sourceId)
  assert.ok(inspected.source.text.includes('private-value'))
  assert.equal(inspected.delivered, null)
  assert.ok(!(await h.store.readProjection('email:a@example.com', capture.sourceId)).text.includes('private-value'))
  await assert.rejects(h.store.inspect('email:b@example.com', capture.sourceId), e => e.code === 'CONTEXT_NOT_FOUND')
})

test('wired native tools bind before early callback; read result has exact delivery payload and no recapture on inspect', async t => {
  const h = await harness(t, { earlyTool: true })
  const capture = await h.capture('Hello immutable source')
  const run = await h.start([capture.sourceId])
  await h.contexts.calls.get(`${run.answerId}/early`)
  assert.equal(h.replies[0].result.success, true)
  assert.equal(h.calls[0].params.dynamicTools[0].type, 'function')
  assert.ok(CONTEXT_TOOL_SPECS.every(spec => /^egdesk_[a-z_]+$/.test(spec.name)))
  const turn = h.calls.find(call => call.method === 'turn/start')
  assert.equal(turn.params.additionalContext.egdesk_context.kind, 'application')
  assert.ok(!turn.params.additionalContext.egdesk_context.value.includes('Hello immutable source'))
  const reply = await h.tool(run, 'egdesk_read_source', { snapshotId: capture.sourceId, intent: 'Read this selected source' }, 'read')
  assert.equal(reply.result.success, true)
  assert.equal(reply.result.contentItems[0].type, 'inputText')
  const packet = JSON.parse(reply.result.contentItems[0].text)
  assert.equal(packet.content.text, 'Hello immutable source')
  assert.equal(packet.coverage.complete, true)
  const inspected = await h.store.inspect('email:a@example.com', capture.sourceId, { packetId: packet.packetId })
  assert.equal(inspected.delivered.text, reply.result.contentItems[0].text)
  assert.equal(inspected.delivered.hash, hashContent(reply.result.contentItems[0].text))
  assert.equal(inspected.delivered.deliveryStatus, 'sent-to-app-server')
  assert.equal(inspected.delivered.binding.answerId, run.answerId)
  assert.equal(inspected.bindings[0].runId, run.runId)
  assert.ok(h.events.some(e => e.event === 'context.bound' && e.details.captures[0].sourceId === capture.sourceId))
  const callCount = h.calls.length
  await h.store.inspect('email:a@example.com', capture.sourceId)
  assert.equal(h.calls.length, callCount)
})

test('failed transport never produces a successful delivery receipt', async t => {
  const h = await harness(t, { throwRespond: true })
  const capture = await h.capture()
  const run = await h.start([capture.sourceId])
  await h.tool(run, 'egdesk_read_source', { snapshotId: capture.sourceId, intent: 'Read' })
  assert.equal((await h.store.inspect('email:a@example.com', capture.sourceId)).delivered, null)
  assert.equal(h.chat.snapshot().runs[0].context.packets.length, 0)
})

test('context access is per-run/per-account and old native threads are not silently replaced', async t => {
  const h = await harness(t)
  const a = await h.capture('A'), b = await h.capture('B', { id: 'b' })
  const run = await h.start([a.sourceId])
  const denied = await h.tool(run, 'egdesk_read_source', { snapshotId: b.sourceId, intent: 'Read' })
  assert.equal(denied.result.success, false)
  h.changeOwner('email:b@example.com')
  const changed = await h.tool(run, 'egdesk_list_context', {}, 'changed')
  assert.equal(changed.result.success, false)
  h.changeOwner('email:a@example.com')
  await assert.rejects(h.chat.send({ message: 'Continue', conversationId: 'old-thread', contextSnapshotIds: [a.sourceId], contextCapabilities: { read: true } }), e => e.code === 'CONTEXT_TOOLS_UNAVAILABLE')
  assert.equal(h.calls.filter(call => call.method === 'thread/start').length, 1)
})

test('briefing resolves view hints only inside the bound run and pins current-run output bytes', async t => {
  const h = await harness(t)
  const capture = await h.capture()
  const run = await h.start([capture.sourceId])
  const output = path.join(h.cwd, 'report.md'); await writeFile(output, 'Verified report revision one')
  await h.chat.handleNotification({ method: 'item/completed', params: { threadId: run.conversationId, turnId: run.runId, item: { id: 'native-write', type: 'fileChange', status: 'completed', changes: [{ path: output, kind: { type: 'add' }, diff: 'not retained' }] } } })
  const listed = await h.tool(run, 'egdesk_list_context', {}, 'list')
  const artifactId = JSON.parse(listed.result.contentItems[0].text).outputs[0].artifactId
  const published = await h.tool(run, 'egdesk_publish_briefing', { title: 'Result', steps: [
    { id: 'source', text: 'Selected evidence', target: { viewId: 'view-1' }, fallback: 'Open its immutable snapshot' },
    { id: 'output', text: 'Report', target: { artifactId }, fallback: 'Open the pinned report snapshot' },
  ] }, 'publish')
  assert.equal(published.result.success, true)
  const briefing = JSON.parse(published.result.contentItems[0].text).briefing
  assert.equal(briefing.answerId, run.answerId)
  assert.equal(briefing.steps[0].target.sourceId, capture.sourceId)
  await writeFile(output, 'Later live file mutation')
  const pinned = await h.store.inspect('email:a@example.com', briefing.steps[1].target.sourceId)
  assert.equal(pinned.source.text, 'Verified report revision one')
  const rejected = await h.tool(run, 'egdesk_publish_briefing', { title: 'Bad', steps: [{ id: 'bad', text: 'No', target: { path: output }, fallback: 'No target' }] }, 'bad')
  assert.equal(rejected.result.success, false)
  assert.equal(h.events.filter(e => e.event === 'briefing.published').length, 1)
})

test('HTTP batch capture and frozen GET source/delivered/bindings work without a server or model call', async t => {
  const h = await harness(t)
  const handler = createContextHttpHandler(h.contexts, async () => {})
  const req = Readable.from([Buffer.from(JSON.stringify({ clientThreadId: 'ui', attachments: [{ id: 'board', kind: 'board', label: 'Board selection', sourceRef: { viewId: 'board-view' }, captureScope: { type: 'board-selection' }, content: { mime: 'text/plain', text: 'Board selected notes', truncated: false } }] }))])
  req.method = 'POST'; req.headers = { 'content-type': 'application/json' }
  const response = () => ({ writeHead(status) { this.status = status }, end(body) { this.body = JSON.parse(body) } })
  const created = response()
  await handler(req, created, new URL('http://localhost/context/captures'))
  assert.equal(created.status, 201)
  const capture = created.body.captures[0]
  const res = response()
  await handler({ method: 'GET' }, res, new URL(`http://localhost/context/captures/${capture.sourceId}`))
  assert.deepEqual(Object.keys(res.body).sort(), ['bindings', 'capture', 'delivered', 'source'])
  assert.equal(res.body.source.text, 'Board selected notes')
  assert.equal(res.body.delivered, null)
  assert.equal(h.calls.length, 0)
})

test('snapshot corruption fails closed instead of replacing old evidence with the live path', async t => {
  const h = await harness(t)
  const capture = await h.capture('Original')
  const blob = path.join(h.store.root, h.store.ownerScope('email:a@example.com'), 'blobs', capture.hash)
  await writeFile(blob, 'Tampered')
  await assert.rejects(h.store.inspect('email:a@example.com', capture.sourceId), e => e.code === 'SNAPSHOT_CORRUPT')
})

test('pinOutput rechecks generation after the second binding await before mutation or new-stream emission', async t => {
  const h = await harness(t)
  const capture = await h.capture()
  const accepted = await h.start([capture.sourceId])
  const run = h.chat.runs.get(accepted.answerId)
  const output = path.join(h.cwd, 'output.md'); await writeFile(output, 'Owned old-account output')
  run.artifacts.push({ id: 'out', type: 'file', target: { path: output }, label: 'Output', conversationId: run.conversationId, runId: run.runId, answerId: run.answerId })
  const bind = h.store.bind.bind(h.store)
  let release, entered
  const paused = new Promise(resolve => { entered = resolve })
  h.store.bind = async (...args) => {
    const result = await bind(...args)
    entered()
    await new Promise(resolve => { release = resolve })
    return result
  }
  const pending = h.tool(accepted, 'egdesk_capture_output', { artifactId: 'out' }, 'pin-race')
  await paused
  h.changeOwner('email:b@example.com')
  h.chat.reset()
  const eventCount = h.events.length
  release()
  await pending
  assert.equal(h.events.length, eventCount)
  assert.equal(run.context.captures.length, 1)
  assert.equal(h.contexts.bindings.size, 0)
  assert.equal(h.replies.some(reply => reply.id === 'pin-race' && reply.result?.success), false)
})

test('pinOutput stops before persisting output after a generation change during capture', async t => {
  const h = await harness(t)
  const source = await h.capture()
  const accepted = await h.start([source.sourceId])
  const run = h.chat.runs.get(accepted.answerId)
  const output = path.join(h.cwd, 'output.md'); await writeFile(output, 'Old-account output')
  run.artifacts.push({ id: 'out', type: 'file', target: { path: output }, label: 'Output', conversationId: run.conversationId, runId: run.runId, answerId: run.answerId })
  let entered, release
  const paused = new Promise(resolve => { entered = resolve })
  const blob = h.store.blob.bind(h.store)
  h.store.blob = async (...args) => { entered(); await new Promise(resolve => { release = resolve }); return blob(...args) }
  const pending = h.tool(accepted, 'egdesk_capture_output', { artifactId: 'out' }, 'pin-during-capture')
  await paused
  h.changeOwner('email:b@example.com')
  h.chat.reset()
  release()
  await pending
  assert.equal((await h.store.listRecords('email:a@example.com', 'sources')).length, 1)
  assert.equal(h.replies.some(reply => reply.id === 'pin-during-capture' && reply.result?.success), false)
})

test('multiline redaction preserves line coordinates across read_source, source inspection and Briefing', async t => {
  const h = await harness(t)
  const text = ['Heading', '-----BEGIN PRIVATE KEY-----', 'HIDDEN_LINE_ONE', 'HIDDEN_LINE_TWO', '-----END PRIVATE KEY-----', 'Evidence target', 'Tail'].join('\n')
  const capture = await h.capture(text)
  const projection = await h.store.readProjection('email:a@example.com', capture.sourceId)
  assert.equal(projection.text.split('\n').length, text.split('\n').length)
  assert.ok(!projection.text.includes('HIDDEN_LINE'))
  const run = await h.start([capture.sourceId])
  const reply = await h.tool(run, 'egdesk_read_source', { snapshotId: capture.sourceId, intent: 'Read the evidence line', range: { startLine: 6, endLine: 6 } }, 'line-read')
  assert.equal(reply.result.success, true)
  const packet = JSON.parse(reply.result.contentItems[0].text)
  const original = await h.store.inspect('email:a@example.com', capture.sourceId, { startLine: 6, endLine: 6 })
  assert.equal(packet.content.text, 'Evidence target')
  assert.equal(packet.content.text, original.source.text)
  const published = await h.tool(run, 'egdesk_publish_briefing', { title: 'Evidence', steps: [{ id: 'line', text: 'Evidence line', target: { sourceId: capture.sourceId, range: { startLine: 6, endLine: 6 } }, fallback: 'Show source snapshot' }] }, 'line-briefing')
  assert.equal(published.result.success, true)
  assert.equal(JSON.parse(published.result.contentItems[0].text).briefing.steps[0].target.range.startLine, 6)
})

test('same-account connection reset during initial bind cannot repopulate the new stream', async t => {
  const h = await harness(t)
  const capture = await h.capture()
  const bind = h.store.bind.bind(h.store)
  let release, entered
  const paused = new Promise(resolve => { entered = resolve })
  h.store.bind = async (...args) => {
    const result = await bind(...args)
    entered()
    await new Promise(resolve => { release = resolve })
    return result
  }
  const pending = h.start([capture.sourceId])
  pending.catch(() => {})
  await paused
  h.chat.reset()
  const eventCount = h.events.length
  release()
  await assert.rejects(pending, e => e.code === 'ACCOUNT_CHANGED')
  assert.equal(h.events.length, eventCount)
  assert.equal(h.contexts.bindings.size, 0)
  assert.equal(h.chat.runs.size, 0)
})

test('late Reader lifecycle and failure events cannot cross a stream reset', async t => {
  let release, entered
  const paused = new Promise(resolve => { entered = resolve })
  const reader = { disconnect() {}, read: async options => {
    entered()
    await new Promise(resolve => { release = resolve })
    options.onLifecycle({ phase: 'turn-accepted', nativeThreadId: 'old-private-child' })
    throw Object.assign(new Error('Old Reader completion'), { code: 'READ_CANCELLED' })
  } }
  const h = await harness(t, { reader })
  const capture = await h.capture('Selected source information\n'.repeat(500))
  const run = await h.start([capture.sourceId])
  const pending = h.tool(run, 'egdesk_read_source', { snapshotId: capture.sourceId, intent: 'Read the large selected source' }, 'read-race')
  await paused
  h.chat.reset()
  const eventCount = h.events.length
  release()
  await pending
  assert.equal(h.events.length, eventCount)
  assert.equal(h.replies.some(reply => reply.id === 'read-race'), false)
})

test('overflow dynamic tool is wired through the native Reader adapter to an exact delivered packet', async t => {
  const readerCalls = []
  let seq = 0
  const reader = new NativeReaderClient({ getOwnerKey: () => 'email:a@example.com', respond: () => { throw new Error('Unexpected Reader approval') }, request: async (method, params) => {
    readerCalls.push({ method, params })
    if (method === 'mcpServerStatus/list') return { data: [], nextCursor: null }
    if (method === 'thread/start') return { thread: { id: `child-${++seq}` }, sandbox: { type: 'readOnly', networkAccess: false }, approvalPolicy: 'never' }
    if (method === 'thread/resume') return { thread: { id: params.threadId }, sandbox: { type: 'readOnly', networkAccess: false }, approvalPolicy: 'never' }
    if (method === 'thread/unsubscribe') return { status: 'unsubscribed' }
    assert.equal(method, 'turn/start')
    const input = JSON.parse(params.input[0].text), id = `child-turn-${readerCalls.length}`
    reader.handleNotification({ method: 'item/completed', params: { threadId: params.threadId, turnId: id, item: { type: 'agentMessage', text: JSON.stringify({ summary: 'Selected source facts were reviewed.', quotes: [input.sourceText.slice(0, 12)], structure: ['Source sections'] }) } } })
    reader.handleNotification({ method: 'turn/completed', params: { threadId: params.threadId, turn: { id, status: 'completed' } } })
    return { turn: { id, status: 'inProgress' } }
  } })
  const h = await harness(t, { reader })
  const capture = await h.capture('Selected immutable text for source reading.\n'.repeat(350))
  const run = await h.start([capture.sourceId], { model: 'gpt-6-sol', effort: 'max' })
  const binding = h.contexts.bindings.get(run.answerId)
  assert.deepEqual(binding.readerConfiguration, { model: 'gpt-6-sol', effort: 'max', modelSource: 'turn-request', effortSource: 'turn-request' })
  assert.deepEqual(h.chat.snapshot(run.conversationId).runs[0].context.readerConfiguration, binding.readerConfiguration)
  assert.deepEqual((await h.store.getRecord('email:a@example.com', 'bindings', binding.bindingId)).readerConfiguration, binding.readerConfiguration)
  const reply = await h.tool(run, 'egdesk_read_source', { snapshotId: capture.sourceId, intent: 'Review selected source facts only' }, 'native-read')
  assert.equal(reply.result.success, true)
  const packet = JSON.parse(reply.result.contentItems[0].text)
  assert.equal(packet.mode, 'reader')
  const childStart = readerCalls.find(call => call.method === 'thread/start').params
  const childTurn = readerCalls.find(call => call.method === 'turn/start').params
  assert.equal(childStart.model, 'gpt-6-sol')
  assert.deepEqual({ model: childTurn.model, effort: childTurn.effort }, { model: 'gpt-6-sol', effort: 'max' })
  assert.equal(packet.coverage.complete, true)
  const inspected = await h.store.inspect('email:a@example.com', capture.sourceId, { packetId: packet.packetId })
  assert.equal(inspected.delivered.text, reply.result.contentItems[0].text)
  const records = await h.store.listRecords('email:a@example.com', 'readers', record => record.stage === 'source-fragment')
  assert.ok(records.length >= 2)
  assert.ok(records.every(record => record.inputPayload.hash === hashContent(record.inputPayload.text)))
  assert.ok(records.every(record => record.result.readerConfiguration.model === 'gpt-6-sol' && record.result.readerConfiguration.effort === 'max'))
  assert.ok(readerCalls.filter(call => call.method === 'turn/start').every(call => call.params.sandboxPolicy.networkAccess === false))
  assert.equal(h.events.find(event => event.event === 'reader.completed').details.deliveryStatus, 'prepared')
  assert.equal(h.events.find(event => event.event === 'context.read.completed').details.deliveryStatus, 'sent-to-app-server')
})

test('unknown parent reasoning effort cannot silently start a default Reader child', async t => {
  const nativeCalls = []
  const reader = new NativeReaderClient({ getOwnerKey: () => 'email:a@example.com', respond: () => {}, request: async (method, params) => { nativeCalls.push({ method, params }); throw new Error('No Reader RPC should start') } })
  const h = await harness(t, { reader })
  const capture = await h.capture('Long source evidence.\n'.repeat(350))
  const run = await h.start([capture.sourceId])
  const reply = await h.tool(run, 'egdesk_read_source', { snapshotId: capture.sourceId, intent: 'Read the selected source' }, 'missing-effort')
  assert.equal(reply.result.success, false)
  assert.equal(JSON.parse(reply.result.contentItems[0].text).error.code, 'READER_CONFIGURATION_REQUIRED')
  assert.equal(nativeCalls.length, 0)
})

test('context resume restores exact delivered references and immutable briefing without re-reading live sources', async t => {
  const h = await harness(t)
  const capture = await h.capture('Original selected evidence')
  const accepted = await h.start([capture.sourceId], { model: 'gpt-6-sol', effort: 'max' })
  await h.tool(accepted, 'egdesk_read_source', { snapshotId: capture.sourceId, intent: 'Read' }, 'history-read')
  await h.tool(accepted, 'egdesk_publish_briefing', { title: 'Evidence', steps: [{ id: 'source', text: 'Evidence', target: { sourceId: capture.sourceId }, fallback: 'Show immutable source' }] }, 'history-briefing')
  const run = h.chat.runs.get(accepted.answerId)
  const original = structuredClone(run.context)
  h.contexts.bindings.clear()
  delete run.context
  const calls = h.calls.length
  await h.contexts.restoreRun(run)
  assert.equal(h.contexts.bindings.get(run.answerId).readerConfiguration.model, 'gpt-6-sol')
  assert.equal(h.contexts.bindings.get(run.answerId).readerConfiguration.effort, 'max')
  assert.equal(run.context.readerConfiguration.effort, 'max')
  assert.deepEqual(run.context.packets, original.packets)
  assert.deepEqual(run.context.briefings, original.briefings)
  assert.equal(run.context.captures[0].hash, capture.hash)
  assert.equal(h.calls.length, calls)
  assert.ok(!JSON.stringify(run.context).includes('ownerScope'))
})
