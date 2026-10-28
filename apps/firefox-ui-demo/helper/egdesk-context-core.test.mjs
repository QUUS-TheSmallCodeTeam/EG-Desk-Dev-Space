import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, readdir, realpath, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { randomUUID } from 'node:crypto'
import { ImmutableContextStore, hashContent, appDataDirectory } from './egdesk-context-store.mjs'
import { ContextRuntime, CONTEXT_TOOL_SPECS } from './egdesk-context-runtime.mjs'
import { createContextHttpHandler } from './egdesk-context-http.mjs'
import { CodexChatRuntime } from './codex-chat-runtime.mjs'
import { NativeReaderClient } from './egdesk-native-reader.mjs'
import { createEGDeskFileService } from './egdesk-file-service.mjs'
import { openChatStore } from './egdesk-chat-store.mjs'

async function harness(t, options = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'egdesk-context-test-'))
  const chatStore = options.verifiedComments ? openChatStore({ dataDir: path.join(dir, 'chat'), ownerScope: 'comment-test' }) : null
  t.after(async () => { chatStore?.close(); await rm(dir, { recursive: true, force: true }) })
  const cwd = path.join(dir, 'workspace'); await mkdir(cwd)
  let owner = 'email:a@example.com', nativeSeq = 0
  const store = new ImmutableContextStore({ dataDir: path.join(dir, 'state'), allowedRoots: [cwd], managedFileView: options.managedFileView })
  const contexts = new ContextRuntime({ store, reader: options.reader || null, getOwnerKey: () => owner, schemaReady: () => options.schemaReady !== false,
    ...(options.verifiedComments ? { getAuthority: hints => chat.contextAuthority(hints) } : {}) })
  const calls = [], replies = [], events = []
  const chat = new CodexChatRuntime({
    ...(options.verifiedComments ? { store: chatStore, requireStore: true, getOwnerKey: () => owner } : {}),
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
  return { dir, cwd, store, contexts, chat, chatStore, calls, replies, events, capture, start, tool, changeOwner: value => { owner = value } }
}

test('app data defaults do not use a repository cwd; explicit config must be absolute', () => {
  assert.equal(appDataDirectory({}, '/user', 'darwin'), '/user/Library/Application Support/EG-Desk')
  assert.throws(() => appDataDirectory({ EGDESK_DATA_DIR: 'relative' }), /absolute/)
})

test('concurrent source reads reserve context before asynchronous projection and cannot overspend aggregate allowance', async t => {
  const h = await harness(t)
  const capture = await h.capture('First selected bytes\n'.repeat(20))
  const started = await h.start([capture.sourceId])
  let entered, release
  const blocked = new Promise(resolve => { entered = resolve })
  const read = h.store.readProjection.bind(h.store)
  h.store.readProjection = async (...args) => {
    entered()
    await new Promise(resolve => { release = resolve })
    return read(...args)
  }
  const first = h.tool(started, 'egdesk_read_source', { snapshotId: capture.sourceId, intent: 'Read selected bytes' }, 'reserved-first')
  await blocked
  const second = await h.tool(started, 'egdesk_read_source', { snapshotId: capture.sourceId, intent: 'Read selected bytes' }, 'reserved-second')
  assert.equal(second.result.success, false)
  assert.match(JSON.stringify(second.result), /CONTEXT_CAPACITY_REQUIRED/)
  const run = h.chat.runs.get(`${started.conversationId}/${started.runId}`)
  assert.ok(run.contextUsage.reservedTokens > 0)
  release()
  assert.equal((await first).result.success, true)
  assert.equal(run.contextUsage.reservedTokens, 0)
  assert.ok(run.contextUsage.deliveryDebt > 0)
  assert.equal((await h.store.listRecords('email:a@example.com', 'deliveries')).length, 1)
})

test('accepted delivery remains context debt when durable delivery receipt fails', async t => {
  const h = await harness(t)
  const capture = await h.capture('Selected evidence '.repeat(40))
  const started = await h.start([capture.sourceId])
  const put = h.store.putRecord.bind(h.store)
  h.store.putRecord = async (owner, kind, ...args) => {
    if (kind === 'deliveries') throw Object.assign(new Error('private receipt diagnostic'), { code: 'STORE_FAILED' })
    return put(owner, kind, ...args)
  }
  const response = await h.tool(started, 'egdesk_read_source', { snapshotId: capture.sourceId, intent: 'Read source' })
  assert.equal(response.result.success, true)
  const run = h.chat.runs.get(`${started.conversationId}/${started.runId}`)
  assert.ok(run.contextUsage.deliveryDebt > 0)
  assert.equal(run.contextUsage.reservedTokens, 0)
  assert.equal(run.context.packets.length, 0)
  assert.deepEqual(await h.store.listRecords('email:a@example.com', 'deliveries'), [])
  assert.equal((await h.store.inspect('email:a@example.com', capture.sourceId)).delivered, null)
  assert.equal(h.events.find(event => event.event === 'context.read.failed')?.details.deliveryStatus, 'sent-record-failed')
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
    if (method === 'config/read') return { config: {}, layers: [{ name: { type: 'user' }, config: {} }] }
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

// ── 1-O: Canvas results, multi-evidence briefing, saved step comments ──

const httpResponse = () => ({ writeHead(status) { this.status = status }, end(body) { this.body = JSON.parse(body) } })
const jsonRequest = (method, body) => {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
  req.method = method; req.headers = { 'content-type': 'application/json' }
  return req
}
const toolJson = reply => JSON.parse(reply.result.contentItems[0].text)

test('existing context tools keep their recorded schema hashes, so older conversations still verify', async () => {
  const { specManifestEntries, verifiedManifestOwners } = await import('./codex-native-tool-manifest.mjs')
  const pinned = {
    egdesk_list_context: '17b4b5efbdf97956413705b362bead95a0fb95363c637feaadf9058c23f18ac9',
    egdesk_read_source: '489e5c4a747ec63d0cf34a4c0fe2bdb742bf0013e9434ad832f0cd7b72df1fe2',
    egdesk_capture_output: 'edd899ec6c18cec76cca25964f2edc2ccc8f08d4f6a7db238aeaad966f495ee2',
    egdesk_publish_briefing: '53c35129017b4aecca005671ec313756fa5977dc847fa996b4674b2033f760e0',
  }
  const current = CONTEXT_TOOL_SPECS.flatMap(spec => specManifestEntries(spec, 'egdesk-context-v1'))
  for (const [name, hash] of Object.entries(pinned)) assert.equal(current.find(entry => entry.key === `\0${name}`).schemaHash, hash, `${name} inputSchema changed`)
  // A thread recorded before the new tools existed still resolves every owner.
  const recorded = current.filter(entry => Object.keys(pinned).some(name => entry.key === `\0${name}`))
  const owners = new Map(current.map(entry => [entry.key, 'contexts']))
  assert.equal(verifiedManifestOwners(recorded, current, owners).status, 'verified')
  assert.deepEqual(CONTEXT_TOOL_SPECS.slice(4).map(spec => spec.name), ['egdesk_publish_briefing_multi', 'egdesk_publish_output'])
  const output = CONTEXT_TOOL_SPECS.find(spec => spec.name === 'egdesk_publish_output')
  assert.deepEqual(Object.keys(output.inputSchema.properties).sort(), ['markdown', 'outputKey', 'title'])
  assert.match(output.description, /do not repeat/i)
})

test('publish_output stores a Canvas result, versions it by outputKey and never echoes the markdown', async t => {
  const h = await harness(t)
  const capture = await h.capture()
  const run = await h.start([capture.sourceId])
  const report = '# Quarterly report\n\n' + 'Row of findings\n'.repeat(40)
  const first = await h.tool(run, 'egdesk_publish_output', { title: 'Quarterly report', markdown: report, outputKey: 'q3-report' }, 'out-1')
  assert.equal(first.result.success, true)
  const firstResult = toolJson(first)
  assert.equal(firstResult.output.version, 1)
  assert.equal(firstResult.output.outputKey, 'q3-report')
  assert.match(firstResult.shown, /Do not repeat/)
  assert.ok(!first.result.contentItems[0].text.includes('Row of findings'), 'the tool result never repeats the body')
  const published = h.events.filter(e => e.event === 'output.published')
  assert.equal(published.length, 1)
  assert.equal(published[0].answerId, run.answerId)
  assert.equal(published[0].details.output.charCount, report.length)
  assert.ok(!JSON.stringify(published[0].details).includes('Row of findings'), 'the event stream carries metadata only')
  // A retried identical call in the same answer is the same version.
  const retry = await h.tool(run, 'egdesk_publish_output', { title: 'Quarterly report', markdown: report, outputKey: 'q3-report' }, 'out-retry')
  assert.equal(toolJson(retry).unchanged, true)
  assert.equal(toolJson(retry).output.id, firstResult.output.id)
  assert.equal(h.events.filter(e => e.event === 'output.published').length, 1)
  const second = await h.tool(run, 'egdesk_publish_output', { title: 'Quarterly report', markdown: report + '\nRevised total', outputKey: 'q3-report' }, 'out-2')
  const secondOutput = h.events.filter(e => e.event === 'output.published')[1].details.output
  assert.equal(toolJson(second).output.version, 2)
  assert.equal(secondOutput.previousId, firstResult.output.id)
  const fresh = await h.tool(run, 'egdesk_publish_output', { title: 'Another', markdown: 'Separate result body' }, 'out-3')
  assert.match(toolJson(fresh).output.outputKey, /^output-[\da-f]{8}$/)
  assert.equal(toolJson(fresh).output.version, 1)
  assert.equal(h.chat.runs.get(run.answerId).context.outputs.length, 3)

  const handler = createContextHttpHandler(h.contexts, async () => {})
  const one = httpResponse()
  await handler({ method: 'GET' }, one, new URL(`http://localhost/context/outputs/${firstResult.output.id}`))
  assert.equal(one.status, 200)
  assert.equal(one.body.markdown, report)
  assert.equal(one.body.output.hash, hashContent(report))
  assert.equal(one.body.output.ownerScope, undefined)
  const versions = httpResponse()
  await handler({ method: 'GET' }, versions, new URL(`http://localhost/context/outputs?conversationId=${encodeURIComponent(run.conversationId)}&outputKey=q3-report`))
  assert.deepEqual(versions.body.outputs.map(item => item.version), [1, 2])
  assert.ok(versions.body.outputs.every(item => item.markdown === undefined))
  const badQuery = httpResponse()
  await handler({ method: 'GET' }, badQuery, new URL('http://localhost/context/outputs?outputKey=q3-report'))
  assert.equal(badQuery.status, 400)

  // Same key in another conversation starts its own history.
  const other = await h.start([capture.sourceId], { clientThreadId: 'ui-2' })
  const otherReply = await h.tool(other, 'egdesk_publish_output', { title: 'Quarterly report', markdown: report, outputKey: 'q3-report' }, 'other-out')
  assert.equal(toolJson(otherReply).output.version, 1)
})

test('publish_output refuses paths, URLs, oversize bodies and runs without the publish capability', async t => {
  const h = await harness(t)
  const capture = await h.capture()
  const run = await h.start([capture.sourceId])
  const refused = async (args, id) => {
    const reply = await h.tool(run, 'egdesk_publish_output', args, id)
    assert.equal(reply.result.success, false, id)
    return JSON.parse(reply.result.contentItems[0].text).error.code
  }
  assert.equal(await refused({ title: 'Report', markdown: '/Users/someone/report.md' }, 'path-body'), 'INVALID_CONTEXT_TOOL')
  assert.equal(await refused({ title: 'Report', markdown: 'https://example.com/report.md' }, 'url-body'), 'INVALID_CONTEXT_TOOL')
  assert.equal(await refused({ title: 'https://example.com', markdown: 'Body' }, 'url-title'), 'INVALID_CONTEXT_TOOL')
  assert.equal(await refused({ title: '~/notes', markdown: 'Body' }, 'home-title'), 'INVALID_CONTEXT_TOOL')
  assert.equal(await refused({ title: 'Two\nlines', markdown: 'Body' }, 'multiline-title'), 'INVALID_CONTEXT_TOOL')
  assert.equal(await refused({ title: 'Report', markdown: 'x'.repeat(20001) }, 'oversize'), 'INVALID_CONTEXT_TOOL')
  assert.equal(await refused({ title: 'Report', markdown: 'Body', outputKey: 'Bad Key' }, 'bad-key'), 'INVALID_CONTEXT_TOOL')
  assert.equal(await refused({ title: 'Report', markdown: 'Body', path: '/tmp/x' }, 'extra-arg'), 'INVALID_CONTEXT_TOOL')
  // Ordinary prose that mentions a link is content, not a locator.
  const prose = await h.tool(run, 'egdesk_publish_output', { title: 'A/B 결과', markdown: 'See https://example.com for the source table.' }, 'prose')
  assert.equal(prose.result.success, true)
  // Credentials in the body are redacted before storage.
  const secret = await h.tool(run, 'egdesk_publish_output', { title: 'Config', markdown: 'api_key=sk-abcdefghijklmnop\nOther line' }, 'secret')
  const stored = await h.contexts.readOutput(toolJson(secret).output.id)
  assert.ok(!stored.markdown.includes('sk-abcdefghijklmnop'))
  assert.equal(stored.output.redacted, true)

  const denied = await h.start([capture.sourceId], { clientThreadId: 'ui-2', contextCapabilities: { read: true, reader: true, publishBriefing: false } })
  const reply = await h.tool(denied, 'egdesk_publish_output', { title: 'Report', markdown: 'Body' }, 'no-cap')
  assert.equal(reply.result.success, false)
  assert.equal(JSON.parse(reply.result.contentItems[0].text).error.code, 'CONTEXT_PERMISSION_REQUIRED')
})

test('publish_output caps results per answer and restores output metadata on resume', async t => {
  const h = await harness(t)
  const capture = await h.capture()
  const run = await h.start([capture.sourceId])
  for (let index = 0; index < 8; index++) assert.equal((await h.tool(run, 'egdesk_publish_output', { title: `Result ${index}`, markdown: `Body ${index}` }, `cap-${index}`)).result.success, true)
  const ninth = await h.tool(run, 'egdesk_publish_output', { title: 'Result 9', markdown: 'Body 9' }, 'cap-9')
  assert.equal(ninth.result.success, false)
  // The model hears the cap by name, not as a generic provider failure.
  assert.equal(JSON.parse(ninth.result.contentItems[0].text).error.code, 'OUTPUT_LIMIT')
  await assert.rejects(h.contexts.publishOutput(h.chat.runs.get(run.answerId), { title: 'Result 9', markdown: 'Body 9' }), e => e.code === 'OUTPUT_LIMIT')
  const live = h.chat.runs.get(run.answerId)
  const original = structuredClone(live.context.outputs)
  h.contexts.bindings.clear()
  delete live.context
  await h.contexts.restoreRun(live)
  assert.deepEqual(live.context.outputs.map(item => item.id).sort(), original.map(item => item.id).sort())
  assert.ok(!JSON.stringify(live.context.outputs).includes('ownerScope'))
})

test('multi-target briefing lights up several evidence targets per step and keeps the original tool shape unchanged', async t => {
  const h = await harness(t)
  const a = await h.capture('Evidence A\nsecond line\nthird line'), b = await h.capture('Evidence B', { id: 'b', sourceRef: { viewId: 'view-2', resourceId: 'page-2' } })
  const run = await h.start([a.sourceId, b.sourceId])
  const published = await h.tool(run, 'egdesk_publish_briefing_multi', { title: 'Compare', steps: [
    { id: 'both', text: 'Both sources agree', targets: [{ sourceId: a.sourceId, range: { startLine: 2, endLine: 3 } }, { viewId: 'view-2' }], emphasis: 'spotlight', fallback: 'Open both sources' },
    { id: 'one', text: 'Only A', targets: [{ sourceId: a.sourceId }], emphasis: 'outline', fallback: 'Open A' },
  ] }, 'v2')
  assert.equal(published.result.success, true)
  const briefing = toolJson(published).briefing
  assert.equal(briefing.steps[0].targets.length, 2)
  assert.deepEqual(briefing.steps[0].target, briefing.steps[0].targets[0])
  assert.equal(briefing.steps[0].targets[1].sourceId, b.sourceId)
  assert.equal(briefing.steps[0].targets[1].hash, b.hash)
  assert.equal(briefing.steps[1].emphasis, 'outline')
  const refusedV2 = async (steps, id) => {
    const reply = await h.tool(run, 'egdesk_publish_briefing_multi', { title: 'Bad', steps }, id)
    assert.equal(reply.result.success, false, id)
    return JSON.parse(reply.result.contentItems[0].text).error.code
  }
  const step = extra => ({ id: 's', text: 'T', fallback: 'F', targets: [{ sourceId: a.sourceId }], ...extra })
  assert.equal(await refusedV2([step({ targets: [{ sourceId: a.sourceId }, { sourceId: a.sourceId }] })], 'dup'), 'INVALID_BRIEFING_TARGET')
  assert.equal(await refusedV2([step({ targets: Array.from({ length: 7 }, (_, i) => ({ sourceId: a.sourceId, range: { startLine: 1, endLine: 1 + (i % 3) } })) })], 'seven'), 'INVALID_BRIEFING_TARGET')
  assert.equal(await refusedV2([step({ targets: [] })], 'none'), 'INVALID_BRIEFING_TARGET')
  assert.equal(await refusedV2([step({ emphasis: 'blink' })], 'emphasis'), 'INVALID_BRIEFING')
  assert.equal(await refusedV2([step({ target: { sourceId: a.sourceId } })], 'mixed'), 'INVALID_BRIEFING')
  assert.equal(await refusedV2([step({ targets: [{ path: '/tmp/x' }] })], 'path'), 'INVALID_BRIEFING_TARGET')
  const single = await h.tool(run, 'egdesk_publish_briefing', { title: 'Old', steps: [{ id: 'old', text: 'Old', target: { sourceId: a.sourceId }, fallback: 'Open' }] }, 'v1')
  const oldStep = toolJson(single).briefing.steps[0]
  assert.deepEqual(Object.keys(oldStep), ['id', 'text', 'target', 'fallback'], 'the original tool keeps its stored step shape')
  assert.equal(h.events.filter(e => e.event === 'briefing.published').length, 2)
})

test('briefing dispatch refuses supplied noninteger end lines while omitted ends retain bounded source semantics', async t => {
  const h = await harness(t)
  const owner = 'email:a@example.com'
  const source = Array.from({ length: 610 }, (_, index) => `captured line ${index + 1}`).join('\n')
  const capture = await h.capture(source)
  const run = await h.start([capture.sourceId])
  const live = h.chat.runs.get(run.answerId)
  const sourceBytes = await h.store.readBlob(owner, capture.hash)
  assert.equal(sourceBytes.toString('utf8'), source)
  assert.equal(capture.hash, hashContent(source))
  const clipped = await h.store.inspect(owner, capture.sourceId, { startLine: 500 })
  assert.deepEqual(clipped.source.range, { startLine: 500, endLine: 610, totalLines: 610 })
  assert.equal(clipped.source.nextLine, null)

  const state = async () => ({
    stored: (await h.store.listRecords(owner, 'briefings')).map(row => row.id).sort(),
    run: live.context.briefings.map(row => row.id).sort(),
    published: h.events.filter(event => event.event === 'briefing.published').length,
    nativeCalls: h.calls.length,
  })
  const step = (range, multi) => ({ id: 'bounded', text: 'Bounded evidence', fallback: 'Open the fixed source',
    ...(multi ? { targets: [{ sourceId: capture.sourceId, range }] } : { target: { sourceId: capture.sourceId, range } }) })
  const invalidEnds = [null, '610', 610.5, false, {}, undefined]
  for (const multi of [false, true]) {
    const name = multi ? 'egdesk_publish_briefing_multi' : 'egdesk_publish_briefing'
    for (const [index, endLine] of invalidEnds.entries()) {
      const before = await state()
      const reply = await h.tool(run, name, { title: 'Invalid end', steps: [step({ startLine: 500, endLine }, multi)] }, `${name}-bad-${index}`)
      assert.equal(reply.result.success, false, `${name}: supplied end ${String(endLine)} must fail`)
      assert.equal(toolJson(reply).error.code, 'INVALID_BRIEFING_TARGET')
      assert.deepEqual(await state(), before, 'invalid targets cannot persist or emit a partial briefing')
    }

    const beforeOutOfBounds = await state()
    const outOfBounds = await h.tool(run, name, { title: 'Out of bounds', steps: [step({ startLine: 500, endLine: 699 }, multi)] }, `${name}-699`)
    assert.equal(outOfBounds.result.success, false)
    assert.equal(toolJson(outOfBounds).error.code, 'TOOL_PROVIDER_FAILED', 'existing public tool policy sanitizes the store error')
    await assert.rejects(h.store.inspect(owner, capture.sourceId, { startLine: 500, endLine: 699 }), error => error.code === 'INVALID_RANGE')
    assert.deepEqual(await state(), beforeOutOfBounds)

    const omitted = await h.tool(run, name, { title: 'Omitted end', steps: [step({ startLine: 500 }, multi)] }, `${name}-omitted`)
    assert.equal(omitted.result.success, true)
    assert.deepEqual(toolJson(omitted).briefing.steps[0].target.range, { startLine: 500 })
    const exact = await h.tool(run, name, { title: 'Exact end', steps: [step({ startLine: 500, endLine: 610 }, multi)] }, `${name}-610`)
    assert.equal(exact.result.success, true)
    assert.deepEqual(toolJson(exact).briefing.steps[0].target.range, { startLine: 500, endLine: 610 })
  }

  const beforePartial = await state()
  const mixed = await h.tool(run, 'egdesk_publish_briefing_multi', { title: 'No partial result', steps: [{
    id: 'mixed', text: 'Two targets', fallback: 'Open the fixed source', targets: [
      { sourceId: capture.sourceId, range: { startLine: 500 } },
      { sourceId: capture.sourceId, range: { startLine: 500, endLine: null } },
    ],
  }] }, 'mixed-invalid-end')
  assert.equal(mixed.result.success, false)
  assert.equal(toolJson(mixed).error.code, 'INVALID_BRIEFING_TARGET')
  assert.deepEqual(await state(), beforePartial, 'an earlier valid target cannot become a partial published briefing')
  assert.deepEqual(await h.store.readBlob(owner, capture.hash), sourceBytes)
  assert.equal((await h.store.getCapture(owner, capture.sourceId)).hash, capture.hash)
  assert.deepEqual((await h.store.inspect(owner, capture.sourceId, { startLine: 500 })).source.range, clipped.source.range)
})

test('briefing step comments are numbered records that survive closing and can be resolved', async t => {
  const h = await harness(t, { verifiedComments: true })
  const a = await h.capture('Evidence A'), b = await h.capture('Evidence B', { id: 'b', sourceRef: { viewId: 'view-2', resourceId: 'page-2' } })
  const run = await h.start([a.sourceId, b.sourceId])
  const published = await h.tool(run, 'egdesk_publish_briefing_multi', { title: 'Compare', steps: [
    { id: 'both', text: 'Both', targets: [{ sourceId: a.sourceId }, { sourceId: b.sourceId }], fallback: 'Open both' },
    { id: 'a-only', text: 'A', targets: [{ sourceId: a.sourceId }], fallback: 'Open A' },
  ] }, 'brief')
  const briefingId = toolJson(published).briefing.id
  const handler = createContextHttpHandler(h.contexts, async () => {})
  const route = { engineId: 'codex', engineProfileId: 'codex-default', clientThreadId: 'ui', conversationId: run.conversationId }
  const routed = path => new URL(`http://localhost${path}?${new URLSearchParams(route)}`)
  const post = async (path, body) => { const res = httpResponse(); await handler(jsonRequest('POST', path.endsWith('/comments') ? { clientRequestId: randomUUID(), ...body } : body), res, routed(path)); return res }
  const get = async path => { const res = httpResponse(); await handler({ method: 'GET' }, res, routed(path)); return res }
  const first = await post(`/context/briefings/${briefingId}/comments`, { stepId: 'both', text: '  Compare the totals  ' })
  assert.equal(first.status, 201)
  assert.equal(first.body.comment.seq, 1)
  assert.equal(first.body.comment.text, 'Compare the totals')
  assert.deepEqual(first.body.comment.sourceIds, [a.sourceId, b.sourceId])
  assert.equal(first.body.comment.answerId, run.answerId)
  const second = await post(`/context/briefings/${briefingId}/comments`, { stepId: 'a-only', text: 'Why only A?', sourceIds: [a.sourceId] })
  assert.equal(second.body.comment.seq, 2)
  const concurrent = await Promise.all([1, 2, 3].map(n => h.contexts.addBriefingComment(briefingId, { stepId: 'both', text: `Parallel ${n}`, clientRequestId: randomUUID() }, h.contexts.authority(route))))
  assert.deepEqual(concurrent.map(item => item.seq).sort(), [3, 4, 5], 'numbers are assigned one at a time')
  assert.equal((await post(`/context/briefings/${briefingId}/comments`, { stepId: 'a-only', text: 'B?', sourceIds: [b.sourceId] })).status, 403)
  assert.equal((await post(`/context/briefings/${briefingId}/comments`, { stepId: 'missing', text: 'x' })).status, 404)
  assert.equal((await post(`/context/briefings/${briefingId}/comments`, { stepId: 'both', text: ' ' })).status, 400)
  assert.equal((await post(`/context/briefings/${briefingId}/comments`, { stepId: 'both', text: 'x'.repeat(2001) })).status, 400)
  assert.equal((await post(`/context/briefings/${briefingId}/comments`, { stepId: 'both', text: 'x', anchor: 'y' })).status, 400)

  // Closing the briefing loses nothing: a fresh read returns every comment in order.
  h.contexts.bindings.clear()
  const listed = await get(`/context/briefings/${briefingId}/comments`)
  assert.deepEqual(listed.body.comments.map(item => item.seq), [1, 2, 3, 4, 5])
  assert.ok(listed.body.comments.every(item => item.ownerScope === undefined))
  const resolved = await post(`/context/briefing-comments/${first.body.comment.id}`, { resolved: true })
  assert.equal(resolved.status, 200)
  assert.equal(resolved.body.comment.resolved, true)
  assert.equal(resolved.body.comment.text, 'Compare the totals', 'resolving never rewrites the comment')
  assert.equal((await get(`/context/briefings/${briefingId}/comments`)).body.comments[0].resolved, true)
  const reopened = await post(`/context/briefing-comments/${first.body.comment.id}`, { resolved: false })
  assert.equal(reopened.body.comment.resolvedAt, null)
  assert.equal((await post(`/context/briefing-comments/${first.body.comment.id}`, { resolved: 'yes' })).status, 400)
  assert.equal((await post(`/context/briefing-comments/${first.body.comment.id}`, { resolved: true, text: 'rewrite' })).status, 400)

  // Another account sees none of it.
  h.changeOwner('email:b@example.com')
  assert.equal((await get(`/context/briefings/${briefingId}/comments`)).status, 403, 'durable owner checkpoint rejects before lookup')
  assert.equal((await post(`/context/briefing-comments/${first.body.comment.id}`, { resolved: true })).status, 403)
})

// Real Chat authority + SQLite native binding + JSON Context records. Native
// replies are local test data; these tests open no server or provider connection.
async function commentHarness(t) {
  const h = await harness(t, { verifiedComments: true })
  const a = await h.capture('Evidence A'), b = await h.capture('Evidence B', { id: 'b', sourceRef: { viewId: 'view-2', resourceId: 'page-2' } })
  const run = await h.start([a.sourceId, b.sourceId])
  const published = await h.tool(run, 'egdesk_publish_briefing_multi', { title: 'Compare', steps: [
    { id: 'both', text: 'Both', targets: [{ sourceId: a.sourceId }, { sourceId: b.sourceId }], fallback: 'Open both' },
    { id: 'a-only', text: 'A', targets: [{ sourceId: a.sourceId }], fallback: 'Open A' },
  ] }, 'comment-briefing')
  assert.equal(published.result.success, true)
  const briefing = toolJson(published).briefing
  const route = { engineId: 'codex', engineProfileId: 'codex-default', clientThreadId: 'ui', conversationId: run.conversationId }
  const handler = createContextHttpHandler(h.contexts, async () => {})
  const request = async (method, endpoint, body, hints = route, respond = httpResponse()) => {
    await handler(jsonRequest(method, body), respond, new URL(`http://localhost${endpoint}?${new URLSearchParams(hints)}`))
    return respond
  }
  const endpoint = `/context/briefings/${briefing.id}/comments`
  const body = extra => ({ stepId: 'both', text: 'Compare totals', clientRequestId: randomUUID(), ...extra })
  const authority = () => h.contexts.authority(route)
  return { ...h, a, b, run, briefing, route, request, endpoint, body, authority }
}

test('comment request UUID serializes concurrent duplicates once; normalized retries preserve exact id, seq and request ID', async t => {
  const h = await commentHarness(t), body = h.body({ text: '  Compare totals  ' })
  const nativeCalls = h.calls.length
  const results = await Promise.all(Array.from({ length: 8 }, () => h.request('POST', h.endpoint, body)))
  assert.ok(results.every(result => result.status === 201))
  const first = results[0].body.comment
  for (const result of results) assert.deepEqual(result.body.comment, first)
  assert.equal(first.seq, 1)
  assert.equal(first.text, 'Compare totals')
  assert.equal(first.clientRequestId, body.clientRequestId)
  const equivalent = await h.request('POST', h.endpoint, { ...body, text: 'Compare totals', sourceIds: [h.b.sourceId, h.a.sourceId, h.a.sourceId], clientRequestId: body.clientRequestId.toUpperCase() })
  assert.deepEqual(equivalent.body.comment, first, 'trimmed text, source sets and UUID casing normalize without rewriting the original result')
  const listed = await h.request('GET', h.endpoint)
  assert.deepEqual(listed.body.comments, [first])
  assert.equal(Object.hasOwn(first, 'requestDigest'), false)
  assert.equal(Object.hasOwn(first, 'ownerScope'), false)
  assert.equal(h.calls.length, nativeCalls, 'comment requests never dispatch another native turn')
})

test('comment duplicate key conflicts on text, step or evidence, including distinct secrets with identical public redaction', async t => {
  const h = await commentHarness(t), body = h.body()
  const first = await h.request('POST', h.endpoint, body)
  for (const changed of [{ text: 'Different' }, { stepId: 'a-only' }, { stepId: 'unknown' }, { sourceIds: [] }, { sourceIds: [h.a.sourceId] }, { sourceIds: ['foreign-source'] }]) {
    const response = await h.request('POST', h.endpoint, { ...body, ...changed })
    assert.equal(response.status, 409, JSON.stringify(changed))
    assert.equal(response.body.code, 'BRIEFING_COMMENT_CONFLICT')
  }
  const racedBody = h.body()
  const raced = await Promise.all([h.request('POST', h.endpoint, racedBody), h.request('POST', h.endpoint, { ...racedBody, text: 'Other payload' })])
  assert.deepEqual(raced.map(result => result.status), [201, 409])
  const secret = h.body({ text: 'api_key=sk-abcdefghijklmnop' })
  assert.equal((await h.request('POST', h.endpoint, secret)).body.comment.text, 'api_key=[REDACTED]')
  assert.equal((await h.request('POST', h.endpoint, { ...secret, text: 'api_key=sk-otherprivatevalue' })).status, 409)
  const records = await h.store.listRecords('email:a@example.com', 'briefing-comments')
  assert.equal(records.length, 3)
  assert.equal(records.some(record => JSON.stringify(record).includes('sk-abcdefghijklmnop')), false)
  assert.equal((await h.request('GET', h.endpoint)).body.comments[0].id, first.body.comment.id)
})

test('a lost POST response is recovered exactly by GET and retry after both Chat and Context restart', async t => {
  const h = await commentHarness(t), body = h.body()
  let dropped
  await h.request('POST', h.endpoint, body, h.route, { writeHead() {}, end(value) { dropped = JSON.parse(value) } })
  const chat = new CodexChatRuntime({ store: h.chatStore, requireStore: true, getOwnerKey: () => 'email:a@example.com',
    request: () => assert.fail('restart recovery must not call a provider'), respond: () => assert.fail('no tool reply') })
  const store = new ImmutableContextStore({ dataDir: path.join(h.dir, 'state'), allowedRoots: [h.cwd] })
  const restarted = new ContextRuntime({ store, getAuthority: hints => chat.contextAuthority(hints), getOwnerKey: () => 'email:a@example.com' })
  const handler = createContextHttpHandler(restarted, async () => {})
  const response = httpResponse()
  await handler(jsonRequest('POST', body), response, new URL(`http://localhost${h.endpoint}?${new URLSearchParams(h.route)}`))
  assert.equal(response.status, 201)
  assert.deepEqual(response.body, dropped)
  const list = await restarted.listBriefingComments(h.briefing.id, restarted.authority(h.route))
  assert.deepEqual(list.comments.filter(comment => comment.clientRequestId === body.clientRequestId), [dropped.comment])
  assert.equal((await store.listRecords('email:a@example.com', 'briefing-comments')).length, 1)
  const resolved = await restarted.resolveBriefingComment(dropped.comment.id, { resolved: true }, restarted.authority(h.route))
  assert.equal(resolved.clientRequestId, body.clientRequestId)
  assert.deepEqual(await restarted.addBriefingComment(h.briefing.id, body, restarted.authority(h.route)), resolved, 'retry cannot reopen or resequence a resolved comment')
})

test('comments require the verified room, reject absent/forged routing, and use the stored briefing CID for GET, POST and resolve', async t => {
  const h = await commentHarness(t)
  const first = (await h.request('POST', h.endpoint, h.body())).body.comment
  const other = await h.start([], { clientThreadId: 'other-room', requestId: 'other-room-request' })
  const otherRoute = { ...h.route, clientThreadId: 'other-room', conversationId: other.conversationId }
  for (const [route, status] of [[{}, 403], [otherRoute, 403], [{ ...h.route, clientThreadId: 'other-room' }, 409], [{ ...h.route, conversationId: other.conversationId }, 409], [{ ...h.route, engineProfileId: 'another-profile' }, 403]]) {
    for (const [method, endpoint, body] of [['GET', h.endpoint], ['POST', h.endpoint, h.body()], ['POST', `/context/briefing-comments/${first.id}`, { resolved: true }]]) {
      const response = await h.request(method, endpoint, body, route)
      assert.equal(response.status, status, JSON.stringify({ method, route }))
    }
  }
  for (const forged of ['ownerKey', 'epoch', 'authority']) {
    assert.equal((await h.request('GET', h.endpoint, undefined, { ...h.route, [forged]: 'forged' })).status, 400)
    assert.equal((await h.request('POST', h.endpoint, h.body({ [forged]: 'forged' }))).status, 400)
  }
  await assert.rejects(h.contexts.listBriefingComments(h.briefing.id), { code: 'CONTEXT_THREAD_REQUIRED' })
  const legacyAccountOnly = new ContextRuntime({ store: h.store, getOwnerKey: () => 'email:a@example.com' })
  await assert.rejects(legacyAccountOnly.listBriefingComments(h.briefing.id, h.authority()), { code: 'CONTEXT_THREAD_REQUIRED' })
  // Even an unchanged resolve must validate its parent briefing, not just the
  // comment CID. This deliberately inconsistent record cannot grant access.
  const foreignBriefingId = await h.store.putRecord('email:a@example.com', 'briefings', { ...h.briefing, conversationId: other.conversationId })
  const malformed = await h.store.putRecord('email:a@example.com', 'briefing-comments', { ...first, briefingId: foreignBriefingId })
  await assert.rejects(h.contexts.resolveBriefingComment(malformed, { resolved: false }, h.authority()), { code: 'CONTEXT_THREAD_MISMATCH' })
  assert.equal((await h.request('GET', h.endpoint)).body.comments.length, 1)
  assert.equal((await h.request('GET', h.endpoint)).body.comments[0].resolved, false)
})

test('comment limits reject without truncation; legacy records stay readable and idempotent replay precedes the 200-record cap', async t => {
  const h = await commentHarness(t)
  for (const bad of [{ clientRequestId: undefined }, { clientRequestId: 'not-a-uuid' }, { text: 'x'.repeat(2001) }, { text: ' ' }, { sourceIds: Array(7).fill(h.a.sourceId) }, { sourceIds: [3] }, { text: 5 }]) {
    const response = await h.request('POST', h.endpoint, h.body(bad))
    assert.equal(response.status, 400)
  }
  assert.equal((await h.request('POST', h.endpoint, h.body({ padding: 'x'.repeat(16 * 1024) }))).status, 413)
  assert.equal((await h.request('POST', h.endpoint, h.body({ sourceIds: ['foreign-source'] }))).status, 403)
  assert.equal((await h.request('POST', h.endpoint, h.body({ stepId: 'missing' }))).status, 404)
  assert.deepEqual((await h.request('GET', h.endpoint)).body.comments, [])
  const body = h.body({ text: '한'.repeat(2000) })
  const first = (await h.request('POST', h.endpoint, body)).body.comment
  assert.equal(first.text, body.text)
  for (let seq = 2; seq <= 200; seq++) {
    await h.store.putRecord('email:a@example.com', 'briefing-comments', { briefingId: h.briefing.id, conversationId: h.run.conversationId,
      stepId: 'both', seq, text: `Legacy ${seq}`, sourceIds: [], resolved: false, resolvedAt: null })
  }
  const list = (await h.request('GET', h.endpoint)).body.comments
  assert.equal(list.length, 200)
  assert.equal(Object.hasOwn(list[1], 'clientRequestId'), false, 'legacy records do not get invented request keys')
  assert.deepEqual((await h.request('POST', h.endpoint, body)).body.comment, first)
  const conflict = await h.request('POST', h.endpoint, { ...body, text: 'Changed at cap' })
  assert.equal(conflict.body.code, 'BRIEFING_COMMENT_CONFLICT')
  const overflow = await h.request('POST', h.endpoint, h.body())
  assert.equal(overflow.status, 409)
  assert.equal(overflow.body.code, 'BRIEFING_COMMENT_LIMIT')
  const legacyResolved = await h.contexts.resolveBriefingComment(list[1].id, { resolved: true }, h.authority())
  assert.equal(legacyResolved.text, 'Legacy 2')
  assert.equal(Object.hasOwn(legacyResolved, 'clientRequestId'), false)
  assert.equal((await h.request('GET', h.endpoint)).body.comments.length, 200)
})

function changeCommentAuthority(h, change) {
  if (change === 'account') h.changeOwner('email:b@example.com')
  else if (change === 'epoch') h.chat.reset()
  else if (change === 'profile') {
    const record = h.chat.engineRecord.bind(h.chat)
    h.chat.engineRecord = engine => ({ ...record(engine), engineProfileId: 'changed-profile' })
  } else if (change === 'CID') {
    const get = h.chatStore.getConversation.bind(h.chatStore)
    h.chatStore.getConversation = client => { const value = get(client); return value && client === h.route.clientThreadId ? { ...value, conversationId: 'changed-native' } : value }
  } else if (change === 'checkpoint') {
    h.chatStore.appendEvent({ clientThreadId: h.route.clientThreadId, eventKey: randomUUID(), ts: Date.now(), event: 'native.thread.bound',
      details: { conversationId: h.route.conversationId, ownerHash: hashContent('email:b@example.com'), engine: { id: 'codex', engineProfileId: 'codex-default' } } })
  } else assert.fail(`Unknown authority change: ${change}`)
}

test('comment queue entry revalidates account, epoch, profile, CID and durable checkpoint, including duplicate and no-op resolve', async t => {
  for (const change of ['account', 'epoch', 'profile', 'CID', 'checkpoint']) for (const operation of ['add', 'duplicate', 'resolve', 'resolve-noop']) await t.test(`${operation}/${change}`, { timeout: 5000 }, async t => {
    const h = await commentHarness(t), body = h.body()
    const first = await h.contexts.addBriefingComment(h.briefing.id, body, h.authority())
    const authority = h.authority()
    let release
    h.contexts.commentQueue = new Promise(resolve => { release = resolve })
    let reads = 0, writes = 0
    const get = h.store.getRecord.bind(h.store), put = h.store.putRecord.bind(h.store), replace = h.store.replaceRecord.bind(h.store)
    h.store.getRecord = (...args) => { reads++; return get(...args) }
    h.store.putRecord = (...args) => { writes++; return put(...args) }
    h.store.replaceRecord = (...args) => { writes++; return replace(...args) }
    const pending = operation.startsWith('resolve')
      ? h.contexts.resolveBriefingComment(first.id, { resolved: operation !== 'resolve-noop' }, authority)
      : h.contexts.addBriefingComment(h.briefing.id, operation === 'duplicate' ? body : h.body(), authority)
    const rejected = assert.rejects(pending, { code: 'ACCOUNT_CHANGED', httpStatus: 403 })
    changeCommentAuthority(h, change)
    release()
    await rejected
    assert.equal(reads, 0, 'stale queued work cannot read even an existing duplicate/no-op record')
    assert.equal(writes, 0)
  })
})

test('comment operations recheck authority after every awaited read or write and never deliver late records', async t => {
  const stages = [
    ['list', 'getRecord', 'briefings'], ['list', 'listRecords', 'briefing-comments'],
    ['add', 'getRecord', 'briefings'], ['add', 'listRecords', 'briefing-comments'], ['add', 'putRecord', 'briefing-comments'],
    ['duplicate', 'listRecords', 'briefing-comments'],
    ['resolve', 'getRecord', 'briefing-comments'], ['resolve', 'getRecord', 'briefings'], ['resolve', 'replaceRecord', 'briefing-comments'],
    ['resolve-noop', 'getRecord', 'briefings'],
  ]
  for (const [operation, method, kind] of stages) for (const change of ['account', 'epoch']) await t.test(`${operation}/${method}/${kind}/${change}`, { timeout: 5000 }, async t => {
    const h = await commentHarness(t), body = h.body()
    const first = await h.contexts.addBriefingComment(h.briefing.id, body, h.authority())
    const authority = h.authority()
    const original = h.store[method].bind(h.store)
    let enter, release, blocked = false
    const entered = new Promise(resolve => { enter = resolve }), released = new Promise(resolve => { release = resolve })
    h.store[method] = async (...args) => {
      const value = await original(...args)
      if (!blocked && args[1] === kind) { blocked = true; enter(); await released }
      return value
    }
    const pending = operation === 'list' ? h.contexts.listBriefingComments(h.briefing.id, authority)
      : operation.startsWith('resolve') ? h.contexts.resolveBriefingComment(first.id, { resolved: operation !== 'resolve-noop' }, authority)
        : h.contexts.addBriefingComment(h.briefing.id, operation === 'duplicate' ? body : h.body(), authority)
    const rejected = assert.rejects(pending, { code: 'ACCOUNT_CHANGED', httpStatus: 403 })
    try { await entered; changeCommentAuthority(h, change) } finally { release() }
    await rejected
    h.store[method] = original
    const records = await h.store.listRecords('email:a@example.com', 'briefing-comments')
    assert.equal(records.length, method === 'putRecord' ? 2 : 1, 'only an already-committed old-owner write may remain after a late refusal')
    assert.equal(records.find(record => record.id === first.id).resolved, method === 'replaceRecord')
    assert.deepEqual(await h.store.listRecords('email:b@example.com', 'briefing-comments'), [], 'no old request migrates into a new account')
  })
})

test('HTTP comment responses and awaited request bodies retain their original authority fence', async t => {
  for (const method of ['listBriefingComments', 'addBriefingComment', 'resolveBriefingComment']) await t.test(method, async t => {
    const h = await commentHarness(t)
    const first = await h.contexts.addBriefingComment(h.briefing.id, h.body(), h.authority())
    const original = h.contexts[method].bind(h.contexts)
    h.contexts[method] = async (...args) => { const result = await original(...args); h.chat.reset(); return result }
    const endpoint = method === 'resolveBriefingComment' ? `/context/briefing-comments/${first.id}` : h.endpoint
    const response = await h.request(method === 'listBriefingComments' ? 'GET' : 'POST', endpoint, method === 'resolveBriefingComment' ? { resolved: true } : h.body())
    assert.equal(response.status, 403)
    assert.equal(response.body.code, 'ACCOUNT_CHANGED')
    assert.equal(Object.hasOwn(response.body, 'comment'), false)
    assert.equal(Object.hasOwn(response.body, 'comments'), false)
  })
  await t.test('body read', { timeout: 5000 }, async t => {
    const h = await commentHarness(t)
    let enter, release
    const entered = new Promise(resolve => { enter = resolve }), released = new Promise(resolve => { release = resolve })
    const req = Readable.from((async function* () { enter(); await released; yield Buffer.from(JSON.stringify(h.body())) })())
    req.method = 'POST'; req.headers = { 'content-type': 'application/json' }
    const handler = createContextHttpHandler(h.contexts, async () => {}), response = httpResponse()
    const pending = handler(req, response, new URL(`http://localhost${h.endpoint}?${new URLSearchParams(h.route)}`))
    try { await entered; h.chat.reset() } finally { release() }
    await pending
    assert.equal(response.status, 403)
    assert.deepEqual((await h.request('GET', h.endpoint)).body.comments, [])
  })
})

test('request keys are scoped to owner and briefing, and stale captured authority cannot return after A to B to A', async t => {
  const h = await commentHarness(t), body = h.body(), authority = h.authority()
  const first = await h.contexts.addBriefingComment(h.briefing.id, body, authority)
  const anotherId = await h.store.putRecord('email:a@example.com', 'briefings', h.briefing)
  const second = await h.contexts.addBriefingComment(anotherId, body, authority)
  assert.notEqual(first.id, second.id)
  assert.equal(second.seq, 1)
  h.changeOwner('email:b@example.com'); h.chat.reset()
  h.changeOwner('email:a@example.com'); h.chat.reset()
  await assert.rejects(h.contexts.listBriefingComments(h.briefing.id, authority), { code: 'ACCOUNT_CHANGED' })
  assert.deepEqual(await h.contexts.addBriefingComment(h.briefing.id, body, h.authority()), first, 'current authority can recover the old committed request without incrementing')
})

test('only briefing comments are mutable; replacement is atomic and owner checked', async t => {
  const h = await harness(t)
  const owner = 'email:a@example.com'
  const id = await h.store.putRecord(owner, 'briefing-comments', { briefingId: 'b', seq: 1, text: 'One', resolved: false })
  await h.store.replaceRecord(owner, 'briefing-comments', id, { briefingId: 'b', seq: 1, text: 'One', resolved: true, ownerScope: 'forged' })
  const record = await h.store.getRecord(owner, 'briefing-comments', id)
  assert.equal(record.resolved, true)
  assert.equal(record.ownerScope, h.store.ownerScope(owner))
  const capture = await h.capture()
  await assert.rejects(h.store.replaceRecord(owner, 'sources', capture.sourceId, {}), e => e.code === 'IMMUTABLE_RECORD')
  await assert.rejects(h.store.replaceRecord('email:b@example.com', 'briefing-comments', id, {}), e => e.code === 'CONTEXT_NOT_FOUND')
  const names = await (await import('node:fs/promises')).readdir(await h.store.directory(owner, 'briefing-comments'))
  assert.deepEqual(names, [`${id}.json`], 'no temporary file is left behind')
})

// ── CTX-04: attached sources that changed after they were sent ──

function fakeSourceBus() {
  const subscriptions = [], queue = []
  return {
    subscriptions,
    subscribe({ owner, topics }, listener) {
      const entry = { owner, topics, listener, active: true }
      subscriptions.push(entry)
      return () => { entry.active = false }
    },
    publish({ owner, topic, payload }) {
      for (const entry of subscriptions) if (entry.active && entry.owner === owner && entry.topics.includes(topic)) queue.push(() => entry.listener({ topic, payload }))
    },
    // Deliberately deliver already queued callbacks after unsubscribe too.
    async flush() { for (const callback of queue.splice(0)) await callback() },
    stats: () => ({ subscribers: subscriptions.filter(entry => entry.active).length }),
    close() { queue.length = 0; for (const entry of subscriptions) entry.active = false },
  }
}

async function trackingHarness(t, options = {}) {
  const { createWorkflowEventBus } = await import('./egdesk-event-bus.mjs')
  const dir = await mkdtemp(path.join(os.tmpdir(), 'egdesk-context-track-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await mkdir(path.join(dir, 'workspace'))
  const cwd = await realpath(path.join(dir, 'workspace'))
  let owner = 'email:a@example.com', threadSeq = 0, turnSeq = 0, clock = 1_800_000_000_000
  const store = new ImmutableContextStore({ dataDir: path.join(dir, 'state'), allowedRoots: [cwd], managedFileView: options.managedFileView, now: () => clock })
  const contexts = new ContextRuntime({ store, reader: null, getOwnerKey: () => owner, now: () => clock })
  const bus = options.bus || createWorkflowEventBus({ now: () => clock })
  t.after(() => bus.close())
  contexts.attachServices({ bus })
  const calls = [], replies = [], events = []
  const chat = new CodexChatRuntime({
    contexts, respond: (id, result, error) => replies.push({ id, result, error }), emit: e => events.push(e),
    request: async (method, params) => {
      calls.push({ method, params })
      if (method === 'thread/start') return { thread: { id: `parent-${++threadSeq}` }, cwd, model: 'configured-model' }
      if (method === 'turn/start') return { turn: { id: `turn-${++turnSeq}`, status: 'inProgress', items: [] } }
      if (method === 'turn/interrupt') return {}
      throw new Error(`Unexpected native method ${method}`)
    },
  })
  chat.setConnection(true)
  let sends = 0
  const send = async (settings = {}) => {
    const accepted = await chat.send({ message: 'Next step', requestId: `track-${++sends}`, clientThreadId: 'ui', cwd, ...settings })
    await chat.handleNotification({ method: 'turn/completed', params: { threadId: accepted.conversationId, turn: { id: accepted.runId, status: 'completed', items: [], itemsView: 'notLoaded' } } })
    return accepted
  }
  const lastTurn = () => calls.filter(call => call.method === 'turn/start').at(-1).params
  const publish = async (topic, payload) => { bus.publish({ topic, owner: 'egdesk-local', payload }); await bus.flush() }
  const browser = (viewId, url = 'https://example.com/page?token=private') => ({ id: `input-${viewId}`, kind: 'browser', label: 'Quarterly page', sourceRef: { viewId, resourceId: `page-${viewId}`, url }, capturedAt: 10, captureScope: { type: 'document-text', locator: 'body' }, content: { mime: 'text/plain', text: 'Captured page words', truncated: false } })
  const caps = { contextCapabilities: { read: true, reader: true, publishBriefing: true } }
  return { dir, cwd, store, contexts, chat, bus, calls, replies, events, send, lastTurn, publish, browser, caps, tick: ms => { clock += ms }, changeOwner: value => { owner = value } }
}
const changeNote = turn => turn.additionalContext?.egdesk_context_changes ? JSON.parse(turn.additionalContext.egdesk_context_changes.value) : null

test('a Browser source shows changed after its card goes to another page, and the next message hears it once without content', async t => {
  const h = await trackingHarness(t)
  const first = await h.send({ attachments: [h.browser('egd-browser-card-1')], ...h.caps })
  const sourceId = h.chat.runs.get(first.answerId).context.captures[0].sourceId
  assert.equal(changeNote(h.lastTurn()), null)
  assert.deepEqual(h.contexts.sourceStatus({ conversationId: first.conversationId }).sources.map(s => [s.sourceId, s.state]), [[sourceId, 'active']])
  // Arriving at the captured origin + path again, or another card moving, changes nothing.
  await h.publish('browser.navigated', { cardId: 'egd-browser-card-1', origin: 'https://example.com', path: '/page' })
  await h.publish('browser.navigated', { cardId: 'egd-browser-card-2', origin: 'https://example.com', path: '/other' })
  assert.equal(h.contexts.sourceStatus({ conversationId: first.conversationId }).sources[0].state, 'active')
  h.tick(5000)
  await h.publish('browser.navigated', { cardId: 'egd-browser-card-1', origin: 'https://example.com', path: '/other' })
  const [stale] = h.contexts.sourceStatus({ conversationId: first.conversationId }).sources
  assert.deepEqual({ ...stale }, { sourceId, kind: 'browser', viewId: 'egd-browser-card-1', state: 'stale', reason: 'navigated', changedAt: 1_800_000_005_000, announcedAt: null })

  // A plain follow-up (no sources, no context capabilities) carries one content-free line.
  const second = await h.send({ conversationId: first.conversationId })
  const note = changeNote(h.lastTurn())
  assert.deepEqual(note.changed, [{ sourceId, kind: 'browser', reason: 'navigated' }])
  assert.equal(note.contract, 'egdesk-context-changes-v1')
  assert.equal(h.lastTurn().additionalContext.egdesk_context, undefined, 'no source descriptors without context tools')
  const raw = JSON.stringify(h.lastTurn().additionalContext)
  for (const text of ['example.com', 'Quarterly page', 'Captured page words', '/other', 'token']) assert.ok(!raw.includes(text), text)
  const noted = h.events.find(e => e.event === 'context.sources.changed')
  assert.equal(noted.answerId, second.answerId)
  assert.deepEqual(noted.details.sources.map(s => [s.sourceId, s.reason]), [[sourceId, 'navigated']])
  assert.equal(h.chat.runs.get(second.answerId).context, undefined, 'the note binds nothing')
  assert.equal(h.contexts.sourceStatus({ conversationId: first.conversationId }).sources[0].announcedAt, 1_800_000_005_000)

  // Heard once: the next message is quiet until the card moves again.
  await h.send({ conversationId: first.conversationId })
  assert.equal(changeNote(h.lastTurn()), null)
  await h.publish('browser.navigated', { cardId: 'egd-browser-card-1', origin: 'https://example.com', path: '/third' })
  await h.send({ conversationId: first.conversationId })
  assert.deepEqual(changeNote(h.lastTurn()).changed.map(c => c.sourceId), [sourceId])

  // HTTP: the chip state, owner scoped.
  const handler = createContextHttpHandler(h.contexts, async () => {})
  const res = httpResponse()
  await handler({ method: 'GET' }, res, new URL(`http://localhost/context/sources?conversationId=${encodeURIComponent(first.conversationId)}`))
  assert.equal(res.status, 200)
  assert.equal(res.body.sources[0].state, 'stale')
  assert.ok(!JSON.stringify(res.body).includes('example.com'))
  const missing = httpResponse()
  await handler({ method: 'GET' }, missing, new URL('http://localhost/context/sources'))
  assert.equal(missing.status, 400)
  h.changeOwner('email:b@example.com')
  const other = httpResponse()
  await handler({ method: 'GET' }, other, new URL(`http://localhost/context/sources?conversationId=${encodeURIComponent(first.conversationId)}`))
  assert.deepEqual(other.body.sources, [])
})

test('a file source changes through its connected root (canonical path or working-copy location) and a change before sending is not lost', async t => {
  const location = { rootId: 'root-9', relativePath: 'docs/plan.md' }
  const managedFileView = { resolveCaptureSource: async ({ captureRef, assertActive }) => {
    assertActive()
    const bytes = Buffer.from('Working copy text\n')
    return { captureRef: { ...captureRef }, name: 'plan.md', mime: 'text/plain', bytes, sha256: hashContent(bytes), location }
  } }
  const h = await trackingHarness(t, { managedFileView })
  await mkdir(path.join(h.cwd, 'notes'))
  const file = path.join(h.cwd, 'notes', 'source.md'); await writeFile(file, 'first version\n')
  // Captured first, changed, then sent: the change still counts.
  const captured = (await h.contexts.capture({ clientThreadId: 'ui', attachments: [{ id: 'file-ui', kind: 'file', label: 'Source', sourceRef: { path: file }, captureScope: { type: 'file' } }] })).captures[0]
  assert.equal(h.contexts.noteRoot({ rootId: 'root-1', absolutePath: h.cwd }), true)
  await h.publish('file.changed', { rootId: 'root-1', relativePath: 'notes/other.md', change: 'change' })
  await h.publish('file.changed', { rootId: 'root-2', relativePath: 'notes/source.md', change: 'change' })
  assert.equal([...h.contexts.allTrackedSources()].find(e => e.sourceId === captured.sourceId).state, 'active', 'other files and unknown roots do not match')
  await h.publish('file.changed', { rootId: 'root-1', relativePath: 'notes/source.md', change: 'rename' })
  const managed = (await h.contexts.capture({ clientThreadId: 'ui', attachments: [{ id: 'managed-ui', kind: 'file', managedFileView: { fileId: 'f', draftId: 'd', head: 'h', revision: 0 }, captureScope: { type: 'file' } }] })).captures[0]
  assert.deepEqual(managed.sourceRef.location, location)
  const run = await h.send({ contextSnapshotIds: [captured.sourceId, managed.sourceId], ...h.caps })
  // The first turn already says the file it sends changed since capture.
  assert.deepEqual(changeNote(h.lastTurn()).changed, [{ sourceId: captured.sourceId, kind: 'file', reason: 'fileChanged' }])
  assert.ok(h.lastTurn().additionalContext.egdesk_context, 'descriptors and the note travel together')
  assert.ok(!JSON.stringify(changeNote(h.lastTurn())).includes(h.cwd))
  await h.publish('file.changed', { rootId: 'root-9', relativePath: 'docs/plan.md', change: 'change' })
  assert.deepEqual(h.contexts.sourceStatus({ conversationId: run.conversationId }).sources.map(s => [s.sourceId, s.state, s.reason]).sort(),
    [[captured.sourceId, 'stale', 'fileChanged'], [managed.sourceId, 'stale', 'fileChanged']].sort())
  // Sending the stale snapshot again repeats the note for it.
  await h.send({ conversationId: run.conversationId, contextSnapshotIds: [captured.sourceId], ...h.caps })
  assert.deepEqual(changeNote(h.lastTurn()).changed.map(c => c.sourceId).sort(), [captured.sourceId, managed.sourceId].sort())
  await h.send({ conversationId: run.conversationId, contextSnapshotIds: [captured.sourceId], ...h.caps })
  assert.deepEqual(changeNote(h.lastTurn()).changed.map(c => c.sourceId), [captured.sourceId], 'announced ones stay quiet unless sent again')
  // A bad location from the file owner is dropped, not stored.
  location.relativePath = '../escape.md'
  const dropped = (await h.contexts.capture({ clientThreadId: 'ui', attachments: [{ id: 'managed-2', kind: 'file', managedFileView: { fileId: 'f', draftId: 'd', head: 'h', revision: 1 }, captureScope: { type: 'file' } }] })).captures[0]
  assert.equal(dropped.sourceRef.location, undefined)
})

test('packets list stale run sources; tracking is bounded, cleared on account change, and the note never reaches a thread that lacks verified tools', async t => {
  const h = await trackingHarness(t)
  const run = await h.send({ attachments: [h.browser('egd-card-a')], ...h.caps })
  const sourceId = h.chat.runs.get(run.answerId).context.captures[0].sourceId
  // A read in a later turn of the same conversation gives a packet.
  const reading = await h.chat.send({ message: 'Read it', requestId: 'read-turn', clientThreadId: 'ui', cwd: h.cwd, conversationId: run.conversationId, contextSnapshotIds: [sourceId], ...h.caps })
  await h.chat.handleServerRequest({ id: 'read', method: 'item/tool/call', params: { threadId: reading.conversationId, turnId: reading.runId, callId: 'read', tool: 'egdesk_read_source', arguments: { snapshotId: sourceId, intent: 'Read' } } })
  await h.contexts.calls.get(`${reading.answerId}/read`)
  const packetId = JSON.parse(h.replies.find(r => r.id === 'read').result.contentItems[0].text).packetId
  await h.chat.handleNotification({ method: 'turn/completed', params: { threadId: reading.conversationId, turn: { id: reading.runId, status: 'completed', items: [], itemsView: 'notLoaded' } } })
  const handler = createContextHttpHandler(h.contexts, async () => {})
  const before = httpResponse()
  await handler({ method: 'GET' }, before, new URL(`http://localhost/context/packets/${packetId}`))
  assert.deepEqual(before.body.staleSources, [])
  await h.publish('browser.navigated', { cardId: 'egd-card-a', origin: 'https://example.org', path: '/' })
  const after = httpResponse()
  await handler({ method: 'GET' }, after, new URL(`http://localhost/context/packets/${packetId}`))
  assert.deepEqual(after.body.staleSources.map(s => [s.sourceId, s.reason]), [[sourceId, 'navigated']])

  // A thread whose tool ownership is not verified gets no note and sends normally.
  h.chat.threadToolManifestStatus.set(run.conversationId, 'unverified')
  const quiet = await h.chat.send({ message: 'Plain', requestId: 'plain-1', clientThreadId: 'ui', cwd: h.cwd, conversationId: run.conversationId }).catch(error => error)
  assert.equal(quiet instanceof Error, false, quiet?.code)
  assert.equal(changeNote(h.lastTurn()), null)
  await h.chat.handleNotification({ method: 'turn/completed', params: { threadId: quiet.conversationId, turn: { id: quiet.runId, status: 'completed', items: [], itemsView: 'notLoaded' } } })
  h.chat.threadToolManifestStatus.set(run.conversationId, 'verified')

  // Bounds.
  for (let i = 0; i < 200; i += 1) h.contexts.trackPending('email:a@example.com', [{ sourceId: `s-${i}`, kind: 'browser', sourceRef: { viewId: `v-${i}` } }])
  assert.equal(h.contexts.pendingSources.size, 128)
  for (let i = 0; i < 80; i += 1) h.contexts.trackBound('email:a@example.com', `conv-${i}`, [{ sourceId: `b-${i}`, kind: 'browser', sourceRef: { viewId: `w-${i}` } }])
  assert.equal(h.contexts.trackedSources.size, 64)
  // Board selections and sources without a card or path are not tracked.
  h.contexts.trackBound('email:a@example.com', 'conv-x', [{ sourceId: 'board-1', kind: 'board', sourceRef: { viewId: 'board-view' } }, { sourceId: 'web-1', kind: 'browser', sourceRef: {} }])
  assert.equal(h.contexts.trackedSources.has('conv-x'), false)
  // Unknown topics and malformed payloads are ignored.
  assert.equal(h.contexts.noteSourceEvent({ topic: 'auth.changed', payload: { signedIn: false } }), 0)
  assert.equal(h.contexts.noteSourceEvent({ topic: 'file.changed' }), 0)
  // Account change: the old account's records go.
  h.changeOwner('email:b@example.com')
  h.chat.reset()
  assert.equal(h.contexts.trackedSources.size, 0)
  assert.equal(h.contexts.pendingSources.size, 0)
})

test('the source-change bus owner is the workflow owner, and attachServices can be detached', async t => {
  const { WORKFLOW_OWNER } = await import('./egdesk-workflow-runtime.mjs')
  const { SOURCE_EVENT_OWNER } = await import('./egdesk-context-runtime.mjs')
  assert.equal(SOURCE_EVENT_OWNER, WORKFLOW_OWNER)
  const h = await trackingHarness(t)
  await h.send({ attachments: [h.browser('egd-card-z')], ...h.caps })
  assert.equal(h.bus.stats().subscribers, 1)
  const detach = h.contexts.attachServices({ bus: h.bus })
  assert.equal(h.bus.stats().subscribers, 1, 're-attaching replaces the subscription')
  detach()
  assert.equal(h.bus.stats().subscribers, 0)
})

test('actual file service integration marks immutable path and working-copy captures stale without recapture or dispatch', async t => {
  let service, resolves = 0
  const managedFileView = { async resolveCaptureSource({ captureRef, assertActive }) {
    assertActive()
    resolves += 1
    const value = await service.resolveCaptureSource(captureRef)
    assertActive()
    return value
  } }
  const h = await trackingHarness(t, { managedFileView, bus: fakeSourceBus() })
  const drafts = new Map(), watched = []
  service = createEGDeskFileService({
    gitReview: null,
    draftStore: {
      async create(value) { drafts.set(value.id, structuredClone(value)) },
      async get(id) { return structuredClone(drafts.get(id)) },
      async compareAndSwap(id, head, value) {
        assert.equal(drafts.get(id).head, head)
        drafts.set(id, structuredClone(value))
        return structuredClone(value)
      },
    },
    onRootRegistered(root) { watched.push(root); h.contexts.noteRoot(root) },
  })
  const root = await service.registerRoot(h.cwd)
  assert.deepEqual(watched, [{ rootId: root.rootId, absolutePath: h.cwd }])
  await mkdir(path.join(h.cwd, 'notes'))
  const original = path.join(h.cwd, 'notes', 'source.md')
  await writeFile(original, 'Original disk bytes\n')
  const file = (await service.search({ rootId: root.rootId, query: 'source' })).matches[0]
  const draft = await service.createDraft({ fileId: file.id })
  const edited = await service.updateDraft({ draftId: draft.id, expectedHead: draft.head, text: 'Selected working-copy bytes\n', operationId: 'edit' })
  const captures = (await h.contexts.capture({ clientThreadId: 'ui', attachments: [
    { id: 'path-source', kind: 'file', sourceRef: { path: original }, captureScope: { type: 'file' } },
    { id: 'working-source', kind: 'file', managedFileView: { fileId: file.id, draftId: edited.id, head: edited.head, revision: edited.bufferRevision }, captureScope: { type: 'file' } },
  ] })).captures
  assert.deepEqual(captures[1].sourceRef.location, { rootId: root.rootId, relativePath: 'notes/source.md' })
  assert.equal(await readFile(original, 'utf8'), 'Original disk bytes\n')
  assert.equal(h.calls.length, 0, 'connecting, registering, opening, editing and explicitly capturing dispatch no model request')
  assert.equal(h.chat.runs.size, 0)
  const run = await h.chat.send({ message: 'Read my selection', requestId: 'integrated-read', clientThreadId: 'ui', cwd: h.cwd, contextSnapshotIds: captures.map(c => c.sourceId), ...h.caps })
  await h.chat.handleServerRequest({ id: 'read-integrated', method: 'item/tool/call', params: {
    threadId: run.conversationId, turnId: run.runId, callId: 'read-integrated', tool: 'egdesk_read_source', arguments: { snapshotId: captures[1].sourceId, intent: 'Read selected copy' },
  } })
  await h.contexts.calls.get(`${run.answerId}/read-integrated`)
  await h.chat.handleNotification({ method: 'turn/completed', params: { threadId: run.conversationId, turn: { id: run.runId, status: 'completed', items: [], itemsView: 'notLoaded' } } })
  const inspected = await h.store.inspect('email:a@example.com', captures[1].sourceId)
  assert.ok(inspected.delivered, 'the previously delivered immutable snapshot is part of the proof')
  const calls = h.calls.length, runs = h.chat.runs.size, captureResolves = resolves
  await writeFile(original, 'External replacement bytes\n')
  h.bus.publish({ owner: 'other-workflow', topic: 'file.changed', payload: { rootId: root.rootId, relativePath: 'notes/source.md' } })
  await h.bus.flush()
  assert.ok(h.contexts.sourceStatus({ conversationId: run.conversationId }).sources.every(source => source.state === 'active'))
  await h.publish('file.changed', { rootId: root.rootId, relativePath: 'notes/source.md', change: 'change' })
  const status = h.contexts.sourceStatus({ conversationId: run.conversationId })
  assert.ok(status.sources.every(source => source.state === 'stale' && source.reason === 'fileChanged'))
  assert.ok(!JSON.stringify(status).includes(h.cwd))
  assert.deepEqual(await h.store.inspect('email:a@example.com', captures[1].sourceId), inspected)
  assert.equal((await h.store.inspect('email:a@example.com', captures[0].sourceId)).source.text, 'Original disk bytes\n')
  assert.equal(h.calls.length, calls)
  assert.equal(h.chat.runs.size, runs)
  assert.equal(resolves, captureResolves, 'stale marking and viewing never resolve the live working copy again')
  const room = { conversationId: run.conversationId, clientThreadId: 'ui' }
  const prepared = await h.contexts.prepare(room)
  assert.equal(prepared.changesOnly, true)
  assert.equal(prepared.changes.length, 2)
  assert.deepEqual((await h.contexts.prepare(room)).changes, prepared.changes, 'preparation cannot consume the change notification')
  assert.equal(h.calls.length, calls)
  assert.ok(status.sources.every(source => source.announcedAt === null))
  assert.deepEqual(h.contexts.sourceStatus({ conversationId: 'other-room' }).sources, [])
  assert.equal(await h.contexts.prepare({ conversationId: 'other-room', clientThreadId: 'ui-other' }), null)
  h.changeOwner('email:other@example.com')
  assert.deepEqual(h.contexts.sourceStatus(room).sources, [])
  assert.equal(await h.contexts.prepare(room), null)
  h.changeOwner('email:a@example.com')
  await h.send(room)
  assert.deepEqual(changeNote(h.lastTurn()).changed.map(source => source.sourceId).sort(), captures.map(c => c.sourceId).sort())
  const changed = h.events.find(event => event.event === 'context.sources.changed')
  assert.deepEqual(Object.keys(changed.details.sources[0]).sort(), ['changedAt', 'kind', 'reason', 'sourceId'])
  await h.send(room)
  assert.equal(changeNote(h.lastTurn()), null)
  assert.equal(resolves, captureResolves)
  assert.deepEqual(await h.store.inspect('email:a@example.com', captures[1].sourceId), inspected)
})

test('service lifecycle is connection-specific, rejects broken adapters and ignores late callbacks without dispatch', async t => {
  const h = await harness(t)
  const bus = fakeSourceBus()
  const first = h.contexts.attachServices({ bus })
  const captured = await h.capture()
  const entry = h.contexts.pendingSources.get(captured.sourceId).entry
  bus.publish({ owner: 'egdesk-local', topic: 'browser.navigated', payload: { cardId: 'view-1', origin: 'https://example.com', path: '/old-queued' } })
  const second = h.contexts.attachServices({ bus })
  first(); first()
  assert.equal(bus.stats().subscribers, 1)
  await bus.flush()
  assert.equal(entry.state, 'active', 'the old queued callback cannot mutate current tracking')
  for (const adapter of [{ bus: {} }, { settings: {} }, { boards: {} }, { rootPath: 'not-a-function' }, { bus: { subscribe: () => undefined } }]) {
    assert.throws(() => h.contexts.attachServices(adapter), { code: 'CONTEXT_SERVICE_INVALID' })
    assert.equal(bus.stats().subscribers, 1)
  }
  assert.throws(() => h.contexts.attachServices({ bus: { subscribe() { throw new Error('private backend details') } } }), { code: 'CONTEXT_SERVICE_UNAVAILABLE' })
  bus.publish({ owner: 'egdesk-local', topic: 'browser.navigated', payload: { cardId: 'view-1', origin: 'https://example.com', path: '/current' } })
  await bus.flush()
  assert.equal(entry.state, 'stale', 'a failed replacement does not remove the working connection')
  second(); second()
  assert.equal(bus.stats().subscribers, 0)
  const version = entry.changeVersion
  bus.subscriptions.at(-1).listener({ topic: 'browser.navigated', payload: { cardId: 'view-1', origin: 'https://example.com', path: '/late' } })
  assert.equal(entry.changeVersion, version)
  h.contexts.attachServices({ bus })
  h.contexts.attachServices({ bus: null })()
  assert.equal(bus.stats().subscribers, 0)
  let lateCallback
  const brokenDetach = h.contexts.attachServices({ bus: { subscribe(scope, listener) {
    lateCallback = listener
    return () => { throw new Error('private teardown failure') }
  } } })
  assert.throws(() => h.contexts.attachServices({ bus }), { code: 'CONTEXT_SERVICE_UNAVAILABLE' })
  assert.equal(bus.stats().subscribers, 0, 'the tentative replacement is also cleaned up if old teardown fails')
  assert.equal(h.contexts.detachServices, null)
  assert.doesNotThrow(brokenDetach, 'even a failed teardown is idempotent')
  lateCallback({ topic: 'browser.navigated', payload: { cardId: 'view-1', origin: 'https://example.com', path: '/after-failed-detach' } })
  assert.equal(entry.changeVersion, version)
  assert.equal(h.calls.length, 0)
  assert.equal(h.chat.runs.size, 0)
})

test('source changes arriving after preparation stay pending even at the same timestamp, and paths cannot escape roots', async t => {
  const h = await trackingHarness(t, { bus: fakeSourceBus() })
  const run = await h.send({ attachments: [h.browser('racing-card')], ...h.caps })
  const change = () => h.publish('browser.navigated', { cardId: 'racing-card', origin: 'https://example.com', path: '/changed' })
  await change()
  const prepared = await h.contexts.prepare({ conversationId: run.conversationId })
  await change()
  h.contexts.announceChanges(run, prepared)
  assert.equal(h.contexts.sourceStatus(run).sources[0].announcedAt, null)
  assert.equal((await h.contexts.prepare({ conversationId: run.conversationId })).changes.length, 1)
  h.contexts.trackPending('email:a@example.com', [{ sourceId: 'outside', kind: 'file', sourceRef: { path: path.join(h.dir, 'outside.md') } }])
  h.contexts.noteRoot({ rootId: 'root', absolutePath: h.cwd })
  for (const relativePath of ['../outside.md', '/outside.md', './outside.md', 'a/../../outside.md', 'a\\outside.md']) {
    assert.equal(h.contexts.noteSourceEvent({ topic: 'file.changed', payload: { rootId: 'root', relativePath } }), 0)
  }
  assert.equal(h.contexts.pendingSources.get('outside').entry.state, 'active')
})

test('prepareOnly direct and Reader plans allocate no session, write no records and emit or dispatch nothing', async t => {
  let readerCalls = 0
  const h = await harness(t, { reader: { async read() { readerCalls += 1; throw new Error('Preparation must not call a Reader') } } })
  const capture = await h.capture('Exact immutable bytes for preparation')
  const before = (await readdir(h.store.root, { recursive: true })).sort()
  const input = { ownerKey: 'email:a@example.com', run: { conversationId: 'prepared-room', clientThreadId: 'ui', context: { captures: [capture] } },
    sourceId: capture.sourceId, intent: 'Plan a selected read', usage: {}, model: 'configured-model', effort: 'high', cwd: h.cwd,
    assertActive: () => {}, prepareOnly: true, emit: () => assert.fail('Preparation must not emit Reader lifecycle events') }
  const direct = await h.contexts.smartRead.read(input)
  assert.equal(direct.packet.mode, 'direct')
  const reader = await h.contexts.smartRead.read({ ...input, forceReader: true })
  assert.equal(reader.plan.mode, 'reader')
  assert.equal(reader.plan.coverage, 'pending')
  assert.equal(reader.packet, undefined)
  assert.deepEqual((await readdir(h.store.root, { recursive: true })).sort(), before)
  assert.equal(h.contexts.smartRead.sessions.size, 0)
  assert.equal(h.contexts.bindings.size, 0)
  assert.equal(h.chat.runs.size, 0)
  assert.equal(h.calls.length, 0)
  assert.equal(h.events.length, 0)
  assert.equal(readerCalls, 0)
})

async function scopedContextHarness(t, options = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'egdesk-context-b2-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const state = { codex: { ownerKey: 'subscription-account-not-a-site', epoch: 1 }, claude: { ownerKey: 'subscription-account-not-a-site', epoch: 1 } }
  const route = { engineId: 'claude', engineProfileId: 'claude-profile', clientThreadId: 'ui-claude' }
  const replies = [], events = [], authCalls = [], readerCalls = []
  const getAuthority = hints => {
    const engineId = hints.engineId || (hints.clientThreadId === 'ui-claude' ? 'claude' : 'codex')
    return { ...hints, engineId, ...(engineId === 'claude' ? { engineProfileId: hints.engineProfileId || 'claude-profile' } : {}), ...state[engineId] }
  }
  const make = () => {
    const store = new ImmutableContextStore({ dataDir: dir, allowedRoots: [dir] })
    const contexts = new ContextRuntime({ store, getAuthority, getOwnerKey: () => state.codex.ownerKey,
      schemaReady: authority => authority?.engineId === 'claude' || options.codexReady !== false,
      reader: { read: async value => { readerCalls.push(value); throw new Error('No B2 NativeReader may start') }, disconnect: () => { readerCalls.push('disconnect') } },
    })
    contexts.runtime = { epoch: state.codex.epoch, respond: (id, response) => { replies.push({ id, response }); return options.rejectResponse ? false : true }, emit: (run, name, details) => events.push({ answerId: run.answerId, name, details }), threads: new Map(), threadToolManifestStatus: new Map() }
    return { store, contexts }
  }
  const { store, contexts } = make()
  const scope = (hints = route) => ({ ...hints, expectedContextScope: contexts.capabilities(contexts.authority(hints)).expectedContextScope })
  const attachment = (text = 'First line\nOriginal immutable evidence\nThird line') => ({ kind: 'browser', id: 'selected', sourceRef: { url: 'https://site.example/document', browserProfileId: 'browser-profile-unrelated', siteAccount: 'person@site.example' }, captureScope: { type: 'dom-range', locator: '#selected' }, content: { text, mime: 'text/plain', truncated: false } })
  const capture = async (text, hints = route, selected = attachment(text)) => (await contexts.capture({ ...scope(hints), attachments: [selected] })).captures[0]
  let sequence = 0
  const bind = async (captures, hints = route) => {
    const authority = contexts.authority(hints)
    const prepared = await contexts.prepare({ ...scope(hints), contextSnapshotIds: captures.map(c => c.sourceId), contextCapabilities: { read: true, reader: false, publishBriefing: false } }, authority)
    const n = ++sequence
    const run = { ...hints, conversationId: hints.conversationId || `native-${n}`, runId: `turn-${n}`, answerId: `answer-${n}`, status: 'inProgress', artifacts: [], activities: [] }
    await contexts.registerThread(run.conversationId, authority)
    await contexts.bindRun(run, prepared, undefined, authority)
    return run
  }
  const tool = async (run, name, args = {}, target = contexts) => {
    const callId = `b2-${replies.length}`
    await target.dispatch(run, { tool: name, arguments: args, callId, rpcId: callId })
    return replies.find(reply => reply.id === callId)?.response
  }
  const http = async (method, endpoint, body, target = contexts) => {
    const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
    req.method = method; req.url = endpoint; req.headers = { 'content-type': 'application/json', host: 'localhost:39218' }
    const res = { writeHead(status) { this.status = status }, end(value) { this.body = JSON.parse(value) } }
    await createContextHttpHandler(target, async hints => { authCalls.push(hints) })(req, res, new URL(endpoint, 'http://localhost'))
    return res
  }
  return { dir, state, route, scope, store, contexts, capture, attachment, bind, tool, http, make, replies, events, authCalls, readerCalls }
}

test('B2 HTTP capability and capture use the engine account, independently of browser/site identity; no raw authority is public', async t => {
  const h = await scopedContextHarness(t, { codexReady: false })
  const query = new URLSearchParams(h.route)
  const caps = await h.http('GET', `/context/capabilities?${query}`)
  assert.equal(caps.status, 200)
  const { expectedContextScope, ...descriptor } = caps.body
  assert.match(expectedContextScope, /^[a-f0-9]{64}$/)
  assert.deepEqual(descriptor, { contract: 'egdesk-context-b2', engineId: 'claude', engineProfileId: 'claude-profile', selectedAttachments: true, immutableRead: true, nativeReader: false,
    largeReader: false, reader: { ready: false, engineId: 'claude', code: 'CLAUDE_CONTEXT_READER_UNSUPPORTED' }, tools: ['egdesk_list_context', 'egdesk_read_source'] })
  const response = await h.http('POST', '/context/captures', { ...h.route, expectedContextScope, attachments: [h.attachment()] })
  assert.equal(response.status, 201)
  const capture = response.body.captures[0]
  assert.deepEqual(capture.engine, { engineId: 'claude', engineProfileId: 'claude-profile' })
  assert.equal(capture.sourceRef.siteAccount, 'person@site.example')
  assert.equal(capture.sourceRef.browserProfileId, 'browser-profile-unrelated')
  const inspected = await h.http('GET', `/context/captures/${capture.sourceId}?${query}`)
  assert.equal(inspected.status, 200)
  assert.equal(inspected.body.delivered, null)
  assert.equal(inspected.body.source.hash, hashContent(h.attachment().content.text))
  for (const value of [caps.body, response.body, inspected.body]) {
    assert.equal(JSON.stringify(value).includes(h.state.claude.ownerKey), false)
    assert.equal(JSON.stringify(value).includes('ownerKey'), false)
    assert.equal(JSON.stringify(value).includes('epoch'), false)
  }
  assert.ok(h.authCalls.every(hints => hints.engineId === 'claude'))
  const stored = await h.store.getRecord(h.contexts.owner(h.contexts.authority(h.route)), 'sources', capture.sourceId)
  assert.equal(JSON.stringify(stored).includes(h.state.claude.ownerKey), false)
  const omitted = await h.http('GET', '/context/capabilities?clientThreadId=ui-claude')
  assert.equal(omitted.body.engineId, 'claude')
  assert.deepEqual(h.readerCalls, [])
})

test('B2 HTTP rejects client authority before authentication and keeps the 2 MiB capture bound', async t => {
  const h = await scopedContextHarness(t)
  for (const key of ['ownerKey', 'epoch', 'authority']) {
    const reply = await h.http('POST', '/context/captures', { ...h.route, [key]: 'forged', attachments: [h.attachment()] })
    assert.equal(reply.status, 400)
    assert.equal(reply.body.code, 'INVALID_CONTEXT_ROUTE')
    const get = await h.http('GET', `/context/capabilities?engineId=claude&${key}=forged`)
    assert.equal(get.status, 400)
  }
  const oversized = await h.http('POST', '/context/captures', { ...h.route, attachments: [h.attachment('x'.repeat(2 * 1024 * 1024))] })
  assert.equal(oversized.status, 413)
  assert.equal(h.authCalls.length, 0)
})

test('B2 snapshot lookup denies cross-engine, cross-account, cross-profile and cross-client-thread selections', async t => {
  const h = await scopedContextHarness(t)
  const capture = await h.capture()
  const prepare = hints => h.contexts.prepare({ ...h.scope({ ...h.route, ...hints }), contextSnapshotIds: [capture.sourceId], contextCapabilities: { read: true } })
  await assert.rejects(prepare({ engineId: 'codex', engineProfileId: undefined }), e => e.code === 'CONTEXT_NOT_FOUND')
  await assert.rejects(prepare({ engineProfileId: 'another-profile' }), e => e.code === 'CONTEXT_NOT_FOUND')
  await assert.rejects(prepare({ clientThreadId: 'another-ui' }), e => e.code === 'CONTEXT_THREAD_MISMATCH')
  h.state.claude.ownerKey = 'a-different-subscription'
  await assert.rejects(prepare({}), e => e.code === 'CONTEXT_NOT_FOUND')
  h.state.claude.ownerKey = h.state.codex.ownerKey
  const [legacy] = await h.store.captureAttachments(h.state.codex.ownerKey, { clientThreadId: h.route.clientThreadId, attachments: [h.attachment('Legacy Codex record')] })
  await assert.rejects(h.contexts.prepare({ ...h.scope(), contextSnapshotIds: [legacy.sourceId] }), e => e.code === 'CONTEXT_NOT_FOUND')
  const noCallback = new ContextRuntime({ store: h.store, getOwnerKey: () => h.state.codex.ownerKey })
  await assert.rejects(noCallback.capture({ ...h.route, attachments: [h.attachment()] }), e => e.code === 'CONTEXT_ENGINE_UNSUPPORTED')
})

test('B2 run reads only selected snapshots from its original conversation, with exact range/version delivery receipts', async t => {
  const h = await scopedContextHarness(t)
  const capture = await h.capture()
  const unselected = await h.capture('Unselected same-account source')
  const run = await h.bind([capture])
  const denied = await h.tool(run, 'egdesk_read_source', { snapshotId: unselected.sourceId, intent: 'Read' })
  assert.equal(denied.success, false)
  const foreignRun = { ...run, conversationId: 'another-native-thread' }
  assert.equal((await h.tool(foreignRun, 'egdesk_list_context')).success, false)
  await assert.rejects(h.contexts.prepare({ ...h.scope(), conversationId: 'another-native-thread', contextSnapshotIds: [capture.sourceId] }), e => e.code === 'CONTEXT_THREAD_MISMATCH')
  const response = await h.tool(run, 'egdesk_read_source', { snapshotId: capture.sourceId, intent: 'Read precisely the second line', range: { startLine: 2, endLine: 2 } })
  assert.equal(response.success, true)
  const packet = JSON.parse(response.contentItems[0].text)
  assert.equal(packet.content.text, 'Original immutable evidence')
  assert.equal(packet.sourceHash, capture.hash)
  assert.equal(packet.projectionHash, capture.payloads.projection.hash)
  assert.equal(packet.coverage.scope, 'line-range')
  assert.equal(packet.coverage.complete, true)
  assert.deepEqual(packet.coverage.reviewedRanges, [{ startOffset: 11, endOffset: 38 }])
  const owner = h.contexts.owner(h.contexts.authority(h.route))
  const inspected = await h.store.inspect(owner, capture.sourceId, { packetId: packet.packetId })
  assert.equal(inspected.delivered.text, response.contentItems[0].text)
  assert.equal(inspected.delivered.hash, hashContent(response.contentItems[0].text))
  assert.equal(inspected.delivered.binding.conversationId, run.conversationId)
  assert.equal(JSON.stringify(response).includes(h.state.claude.ownerKey), false)
  assert.deepEqual(h.readerCalls, [])
})

test('B2 transport false is not delivered and cannot produce a receipt or read.completed', async t => {
  const h = await scopedContextHarness(t, { rejectResponse: true })
  const capture = await h.capture()
  const run = await h.bind([capture])
  await h.tool(run, 'egdesk_read_source', { snapshotId: capture.sourceId, intent: 'Read' })
  const owner = h.contexts.owner(h.contexts.authority(h.route))
  assert.equal((await h.store.listRecords(owner, 'deliveries')).length, 0)
  assert.equal(run.context.packets.length, 0)
  assert.equal(h.events.some(event => event.name === 'context.read.completed'), false)
})

test('B2 preflight refuses Reader request, oversized aggregate, truncated and unreadable sources without Reader/delivery', async t => {
  const h = await scopedContextHarness(t)
  const small = await h.capture('Small')
  await assert.rejects(h.contexts.prepare({ ...h.scope(), contextSnapshotIds: [small.sourceId], contextCapabilities: { read: true, reader: true } }), e => e.code === 'CLAUDE_CONTEXT_READER_UNSUPPORTED')
  const large = await h.capture('Complete selected evidence. '.repeat(1000))
  await assert.rejects(h.contexts.prepare({ ...h.scope(), contextSnapshotIds: [large.sourceId], contextUsage: { modelContextWindow: 1000000, usedTokens: -1000000 } }), e => e.code === 'CLAUDE_CONTEXT_READER_UNSUPPORTED')
  const selected = h.attachment('Clipped'); selected.content.truncated = true
  await assert.rejects(h.contexts.capture({ ...h.scope(), attachments: [selected] }), e => e.code === 'CONTEXT_CAPTURE_INCOMPLETE')
  const binary = path.join(h.dir, 'unreadable.bin'); await writeFile(binary, Buffer.from([0, 255, 0, 1]))
  const captured = await h.capture(undefined, h.route, { kind: 'file', sourceRef: { path: binary }, captureScope: { type: 'file' } })
  await assert.rejects(h.contexts.prepare({ ...h.scope(), contextSnapshotIds: [captured.sourceId] }), e => e.code === 'UNSUPPORTED_SOURCE_FORMAT')
  const many = []
  for (let i = 0; i < 5; i++) many.push(await h.capture(`Selected source ${i}`))
  await assert.rejects(h.contexts.prepare({ ...h.scope(), contextSnapshotIds: many.map(c => c.sourceId) }), e => e.code === 'CLAUDE_CONTEXT_READER_UNSUPPORTED')
  const owner = h.contexts.owner(h.contexts.authority(h.route))
  for (const kind of ['packets', 'deliveries', 'readers', 'bindings']) assert.equal((await h.store.listRecords(owner, kind)).length, 0)
  assert.deepEqual(h.readerCalls, [])
})

function pauseOnce(target, method) {
  const original = target[method].bind(target)
  let enter, release, paused = false
  const entered = new Promise(resolve => { enter = resolve })
  target[method] = async (...args) => {
    const result = await original(...args)
    if (!paused) { paused = true; enter(); await new Promise(resolve => { release = resolve }) }
    return result
  }
  return { entered, release: () => release(), restore: () => { target[method] = original } }
}

test('B2 delayed capture is invalidated only by its own engine epoch/account', async t => {
  const h = await scopedContextHarness(t)
  let pause = pauseOnce(h.store, 'blob')
  const stillValid = h.capture('Claude capture while Codex reconnects')
  await pause.entered
  h.state.codex.epoch++; h.contexts.runtime.epoch++; h.contexts.reset({ engineId: 'codex' })
  pause.release()
  assert.equal((await stillValid).engine.engineId, 'claude')
  pause.restore()
  pause = pauseOnce(h.store, 'blob')
  const invalidated = h.capture('Never publish after Claude epoch change')
  await pause.entered
  h.state.claude.epoch++
  pause.release()
  await assert.rejects(invalidated, e => e.code === 'ACCOUNT_CHANGED')
  pause.restore()
  const owner = h.contexts.owner(h.contexts.authority(h.route))
  assert.equal((await h.store.listRecords(owner, 'sources')).length, 1)
})

test('B2 delayed read survives other-engine disconnect but cannot emit or deliver after own account rotation', async t => {
  const h = await scopedContextHarness(t)
  const capture = await h.capture()
  const run = await h.bind([capture])
  let pause = pauseOnce(h.store, 'readProjection')
  const good = h.tool(run, 'egdesk_read_source', { snapshotId: capture.sourceId, intent: 'Read before Codex logout' })
  await pause.entered
  h.state.codex.epoch++; h.contexts.runtime.epoch++; h.contexts.disconnect({ engineId: 'codex' }); h.contexts.reset({ engineId: 'codex' })
  pause.release()
  assert.equal((await good).success, true)
  pause.restore()
  pause = pauseOnce(h.store, 'readProjection')
  const bad = h.tool(run, 'egdesk_read_source', { snapshotId: capture.sourceId, intent: 'Do not leak after account rotation' })
  await pause.entered
  const replies = h.replies.length, events = h.events.length
  h.state.claude.ownerKey = 'new-claude-account'; h.state.claude.epoch++
  h.contexts.reset({ engineId: 'claude' })
  pause.release()
  assert.equal(await bad, undefined)
  assert.equal(h.replies.length, replies)
  assert.equal(h.events.length, events)
  pause.restore()
})

test('B2 restart restores exact original snapshots and manifest after live changes; missing manifest/blob never recaptures', async t => {
  const h = await scopedContextHarness(t)
  const file = path.join(h.dir, 'original.txt')
  await writeFile(file, 'Original persisted evidence')
  const capture = await h.capture(undefined, h.route, { kind: 'file', sourceRef: { path: file }, captureScope: { type: 'file' } })
  const run = await h.bind([capture])
  await h.tool(run, 'egdesk_read_source', { snapshotId: capture.sourceId, intent: 'Read original' })
  const savedContext = structuredClone(run.context)
  await writeFile(file, 'Changed live contents, never an implicit replacement')
  const restarted = h.make()
  const resumed = { ...run, context: savedContext }
  await restarted.contexts.restoreRun(resumed, restarted.contexts.authority(resumed))
  assert.deepEqual(resumed.context.captures, savedContext.captures)
  assert.deepEqual(resumed.context.packets, savedContext.packets)
  const response = await h.tool(resumed, 'egdesk_read_source', { snapshotId: capture.sourceId, intent: 'Read after restart' }, restarted.contexts)
  assert.equal(JSON.parse(response.contentItems[0].text).content.text, 'Original persisted evidence')
  const owner = restarted.contexts.owner(restarted.contexts.authority(resumed))
  const marker = (await restarted.store.listRecords(owner, 'threads'))[0]
  // Removing only this test's marker simulates an unavailable persisted manifest.
  await rm(path.join(await restarted.store.directory(owner, 'threads'), `${marker.id}.json`))
  const missingManifest = h.make()
  await assert.rejects(missingManifest.contexts.restoreRun({ ...run }, missingManifest.contexts.authority(run)), e => e.code === 'CONTEXT_TOOLS_UNAVAILABLE')
  await restarted.contexts.registerThread(run.conversationId, restarted.contexts.authority(run))
  await rm(path.join(await restarted.store.directory(owner, 'blobs'), capture.hash))
  const missingBlob = h.make()
  await assert.rejects(missingBlob.contexts.restoreRun({ ...run }, missingBlob.contexts.authority(run)), e => e.code === 'CONTEXT_NOT_FOUND')
  assert.equal((await restarted.store.listRecords(owner, 'sources')).length, 1)
  assert.deepEqual(h.readerCalls, [])
})

test('B2 old or missing Claude tool registration is not inferred from legacy Codex records or generic readiness', async t => {
  const h = await scopedContextHarness(t)
  const capture = await h.capture()
  const authority = h.contexts.authority(h.route)
  const prepared = await h.contexts.prepare({ ...h.scope(), contextSnapshotIds: [capture.sourceId] }, authority)
  await assert.rejects(h.contexts.requireThread('old-claude', prepared, authority), e => e.code === 'CONTEXT_TOOLS_UNAVAILABLE')
  await h.store.markNativeThread(h.contexts.owner(authority), 'old-claude')
  await assert.rejects(h.contexts.requireThread('old-claude', prepared, authority), e => e.code === 'CONTEXT_TOOLS_UNAVAILABLE')
  await assert.rejects(h.contexts.registerThread('old-claude', authority), e => e.code === 'CONTEXT_TOOLS_UNAVAILABLE')
  await assert.rejects(h.contexts.restoreRun({ ...h.route, conversationId: 'missing', runId: 'turn', answerId: 'answer', context: { bindingId: 'expected-original-binding' } }, authority), e => e.code === 'CONTEXT_BINDING_MISSING')
})

test('B2 same-account reconnect revalidates saved snapshots with the new epoch rather than retaining a stale binding', async t => {
  const h = await scopedContextHarness(t)
  const capture = await h.capture()
  const run = await h.bind([capture])
  const original = structuredClone(run.context)
  h.state.claude.epoch++
  h.contexts.disconnect({ engineId: 'claude' })
  await h.contexts.restoreRun(run, h.contexts.authority(run))
  assert.deepEqual(run.context.captures, original.captures)
  const response = await h.tool(run, 'egdesk_read_source', { snapshotId: capture.sourceId, intent: 'Read after reconnect' })
  assert.equal(response.success, true)
  const owner = h.contexts.owner(h.contexts.authority(h.route))
  await rm(path.join(await h.store.directory(owner, 'blobs'), capture.hash))
  // Even an already-cached binding cannot skip exact snapshot revalidation.
  await assert.rejects(h.contexts.restoreRun(run, h.contexts.authority(run)), e => e.code === 'CONTEXT_NOT_FOUND')
})

test('B2 HTTP inspection discards late own-epoch results and Codex resolver routing remains compatible', async t => {
  const h = await scopedContextHarness(t)
  const capture = await h.capture()
  const pause = pauseOnce(h.store, 'inspect')
  const pending = h.http('GET', `/context/captures/${capture.sourceId}?${new URLSearchParams(h.route)}`)
  await pause.entered
  h.state.claude.epoch++
  pause.release()
  const response = await pending
  assert.equal(response.status, 403)
  assert.equal(response.body.code, 'ACCOUNT_CHANGED')
  assert.equal(JSON.stringify(response.body).includes('Original immutable evidence'), false)
  pause.restore()
  const suggested = await h.http('POST', '/context/resolve', { engineId: 'codex', clientThreadId: 'ui-codex', explicit: [{ kind: 'browser', ref: 'page-one' }] })
  assert.equal(suggested.status, 200, JSON.stringify(suggested.body))
  assert.equal(suggested.body.policy, 'suggest-only')
  const refused = await h.http('POST', '/context/resolve', { ...h.route, explicit: [] })
  assert.equal(refused.body.code, 'CONTEXT_TOOL_UNSUPPORTED')
})

test('B2 store strips raw authority from engine provenance even if an internal caller passes too much', async t => {
  const h = await scopedContextHarness(t)
  const authority = h.contexts.authority(h.route)
  const owner = h.contexts.owner(authority)
  const [capture] = await h.store.captureAttachments(owner, { clientThreadId: h.route.clientThreadId, attachments: [h.attachment()] }, { engine: authority })
  const binding = await h.store.bind(owner, { conversationId: 'native', runId: 'turn', answerId: 'answer', clientThreadId: h.route.clientThreadId }, [capture.sourceId], { read: true }, undefined, undefined, authority)
  for (const value of [capture, binding, ...await h.store.listRecords(owner, 'sources'), ...await h.store.listRecords(owner, 'bindings')]) {
    assert.equal(JSON.stringify(value).includes('ownerKey'), false)
    assert.equal(JSON.stringify(value).includes('epoch'), false)
    assert.equal(JSON.stringify(value).includes(authority.ownerKey), false)
    assert.deepEqual(value.engine, { engineId: 'claude', engineProfileId: 'claude-profile' })
  }
})

test('B2 capabilities-to-capture race refuses a same-profile account switch before the UI learns of it', async t => {
  const h = await scopedContextHarness(t)
  const observed = await h.http('GET', `/context/capabilities?${new URLSearchParams(h.route)}`)
  assert.equal(observed.status, 200)
  // The UI still holds A's routing and capability response while Browser
  // selection capture runs. Only the authoritative server account changes.
  h.state.claude.ownerKey = 'subscription-B-same-profile'
  const attempted = await h.http('POST', '/context/captures', { ...h.route, expectedContextScope: observed.body.expectedContextScope, attachments: [h.attachment('Selected under subscription A')] })
  assert.equal(attempted.status, 409)
  assert.equal(attempted.body.code, 'CONTEXT_SCOPE_CHANGED')
  const ownerB = h.contexts.owner(h.contexts.authority(h.route))
  assert.equal((await h.store.listRecords(ownerB, 'sources')).length, 0)
})

test('B2 opaque scope is an expectation, not a grant, and survives only unrelated-engine changes', async t => {
  const h = await scopedContextHarness(t)
  const observed = await h.http('GET', `/context/capabilities?${new URLSearchParams(h.route)}`)
  const expectedContextScope = observed.body.expectedContextScope
  assert.equal(expectedContextScope.includes(h.state.claude.ownerKey), false)
  const request = { ...h.route, expectedContextScope, attachments: [h.attachment()] }
  const missing = await h.http('POST', '/context/captures', { ...request, expectedContextScope: undefined })
  assert.equal(missing.body.code, 'CONTEXT_SCOPE_CHANGED')
  const forged = await h.http('POST', '/context/captures', { ...request, expectedContextScope: 'f'.repeat(64) })
  assert.equal(forged.body.code, 'CONTEXT_SCOPE_CHANGED')
  const crossThread = await h.http('POST', '/context/captures', { ...request, clientThreadId: 'different-ui' })
  assert.equal(crossThread.body.code, 'CONTEXT_SCOPE_CHANGED')
  h.state.codex.ownerKey = 'new-codex-account'; h.state.codex.epoch++
  h.contexts.reset({ engineId: 'codex' })
  const allowed = await h.http('POST', '/context/captures', request)
  assert.equal(allowed.status, 201)
  const capture = allowed.body.captures[0]
  assert.equal(JSON.stringify(capture).includes(expectedContextScope), false)
  // Resolving a native conversation for this same client does not change scope.
  const prepared = await h.contexts.prepare({ ...h.route, conversationId: 'newly-bound-native', expectedContextScope, contextSnapshotIds: [capture.sourceId] })
  assert.equal(prepared.captures[0].sourceId, capture.sourceId)
  h.state.claude.epoch++
  await assert.rejects(h.contexts.prepare({ ...h.route, expectedContextScope, contextSnapshotIds: [capture.sourceId] }), e => e.code === 'CONTEXT_SCOPE_CHANGED')
  const restarted = h.make()
  await assert.rejects(restarted.contexts.capture(request), e => e.code === 'CONTEXT_SCOPE_CHANGED')
  assert.equal((await h.store.listRecords(h.contexts.owner(h.contexts.authority(h.route)), 'sources')).length, 1)
})

test('B2 capture-to-prepare account switch refuses stale scope before lookup/bind/model dispatch', async t => {
  const h = await scopedContextHarness(t)
  const observed = h.scope()
  const { captures } = await h.contexts.capture({ ...observed, attachments: [h.attachment()] })
  let lookups = 0
  const getCapture = h.store.getCapture.bind(h.store)
  h.store.getCapture = async (...args) => { lookups++; return getCapture(...args) }
  h.state.claude.ownerKey = 'account-B-same-profile'
  await assert.rejects(h.contexts.prepare({ ...observed, contextSnapshotIds: [captures[0].sourceId], contextCapabilities: { read: true, reader: false, publishBriefing: false } }), e => e.code === 'CONTEXT_SCOPE_CHANGED')
  assert.equal(lookups, 0)
  const ownerB = h.contexts.owner(h.contexts.authority(h.route))
  for (const kind of ['sources', 'bindings', 'packets', 'deliveries']) assert.equal((await h.store.listRecords(ownerB, kind)).length, 0)
  assert.equal(h.replies.length, 0)
})
