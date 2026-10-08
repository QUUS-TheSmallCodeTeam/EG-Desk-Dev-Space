import test from 'node:test'
import assert from 'node:assert/strict'
import { NativeReaderClient } from './egdesk-native-reader.mjs'
import { hashContent } from './egdesk-context-store.mjs'

function nativeHarness(options = {}) {
  const calls = [], replies = []
  let thread = 0, turn = 0, owner = 'owner-a', readerInventory = 0
  const reader = new NativeReaderClient({
    getOwnerKey: () => owner, timeoutMs: options.timeoutMs || 1000, readerPolicy: options.readerPolicy || null,
    respond: (...reply) => replies.push(reply),
    request: async (method, params) => {
      calls.push({ method, params })
      if (method === 'mcpServerStatus/list') {
        if (params.threadId !== 'parent') readerInventory++
        return { data: params.threadId === 'parent'
        ? [{ name: 'external', pluginId: 'plugin@example', tools: { write: {} }, resources: [], resourceTemplates: [], toolsError: null }]
        : options.externalTools || options.externalResources || options.externalTemplates || options.toolsError || (options.toolsOnReuse && readerInventory > 1)
          ? [{ name: 'unwanted', tools: options.externalTools || (options.toolsOnReuse && readerInventory > 1) ? { write: {} } : {}, resources: options.externalResources ? [{ uri: 'private' }] : [], resourceTemplates: options.externalTemplates ? [{ uriTemplate: 'private' }] : [], toolsError: options.toolsError ? 'unknown' : null }]
          : [], nextCursor: null }
      }
      if (method === 'thread/start') return { thread: { id: `reader-${++thread}` }, sandbox: { type: options.unsafeSandbox ? 'workspaceWrite' : 'readOnly', networkAccess: options.unsafeNetwork === true }, approvalPolicy: options.unsafeApproval ? 'on-request' : 'never', ...(options.mismatchedThreadModel ? { model: 'another-model' } : {}) }
      if (method === 'thread/resume') return { thread: { id: options.wrongReuseThread ? 'other-reader' : params.threadId },
        sandbox: { type: options.unsafeReuseSandbox ? 'workspaceWrite' : 'readOnly', networkAccess: options.unsafeReuseNetwork === true },
        approvalPolicy: options.unsafeReuseApproval ? 'on-request' : 'never',
        ...(options.mismatchedReuseModel ? { model: 'another-model' } : {}) }
      if (method === 'thread/unsubscribe') return { status: 'unsubscribed' }
      if (method === 'turn/interrupt') return {}
      if (method !== 'turn/start') throw new Error(method)
      const id = `reader-turn-${++turn}`
      if (options.start) return options.start({ reader, method, params, id })
      const input = JSON.parse(params.input[0].text)
      reader.handleNotification({ method: 'item/reasoning/textDelta', params: { threadId: params.threadId, turnId: id, delta: 'RAW_CHAIN_NOT_ALLOWED' } })
      reader.handleNotification({ method: 'item/completed', params: { threadId: params.threadId, turnId: id, item: { type: 'agentMessage', text: JSON.stringify({ summary: 'A source-reading result.', quotes: [options.badQuote ? 'not-in-source' : input.sourceText.slice(0, 12)], structure: ['Visible content'] }) } } })
      reader.handleNotification({ method: 'turn/completed', params: { threadId: params.threadId, turn: { id, status: options.failed ? 'failed' : 'completed' } } })
      return { turn: { id, status: 'inProgress', items: [] }, ...(options.mismatchedTurnEffort ? { reasoningEffort: 'low' } : {}) }
    },
  })
  const input = { ownerKey: owner, parentThreadId: 'parent', readerSessionId: 'logical-reader', sourceId: 'source', sourceHash: hashContent('Original source evidence.'), cwd: '/readonly-scratch', model: 'gpt-6-sol', effort: 'max', intent: 'Read source facts only', text: 'Original source evidence.', range: { startOffset: 0, endOffset: 25 }, maxOutputChars: 1000 }
  return { reader, calls, replies, input, changeOwner: next => { owner = next } }
}

test('actual native Reader adapter requests read-only/no-network/no tools and handles events before RPC acknowledgement', async () => {
  const h = nativeHarness()
  const result = await h.reader.read(h.input)
  const start = h.calls.find(call => call.method === 'thread/start').params
  assert.equal(start.ephemeral, true)
  assert.equal(start.sandbox, 'read-only')
  assert.equal(start.approvalPolicy, 'never')
  assert.equal(start.model, 'gpt-6-sol')
  assert.equal(start.config.features.apps, false)
  assert.equal(start.config.features.shell_tool, false)
  assert.equal(start.config.features.hooks, false)
  assert.equal(start.config.features.multi_agent, false)
  assert.equal(start.config.mcp_servers.external.enabled, false)
  assert.deepEqual(start.dynamicTools, [])
  const turn = h.calls.find(call => call.method === 'turn/start').params
  assert.equal(turn.model, 'gpt-6-sol')
  assert.equal(turn.effort, 'max')
  assert.deepEqual(turn.sandboxPolicy, { type: 'readOnly', networkAccess: false })
  assert.equal(result.inputPayload.text, turn.input[0].text)
  assert.equal(result.inputPayload.hash, hashContent(turn.input[0].text))
  assert.equal(result.nativeTurnId, 'reader-turn-1')
  assert.deepEqual(result.readerConfiguration, { model: 'gpt-6-sol', effort: 'max', source: 'parent-turn' })
  assert.ok(!JSON.stringify(result).includes('RAW_CHAIN_NOT_ALLOWED'))
})

test('Reader refuses an implicit global model or effort before any native request', async () => {
  const h = nativeHarness()
  await assert.rejects(h.reader.read({ ...h.input, model: null }), e => e.code === 'READER_CONFIGURATION_REQUIRED')
  await assert.rejects(h.reader.read({ ...h.input, effort: null }), e => e.code === 'READER_CONFIGURATION_REQUIRED')
  assert.equal(h.calls.length, 0)
})

test('configured Reader policy may intentionally select a different explicit pair', async () => {
  const h = nativeHarness({ readerPolicy: { model: 'reader-policy-model', effort: 'high' } })
  const result = await h.reader.read(h.input)
  assert.equal(h.calls.find(call => call.method === 'thread/start').params.model, 'reader-policy-model')
  const turn = h.calls.find(call => call.method === 'turn/start').params
  assert.deepEqual({ model: turn.model, effort: turn.effort }, { model: 'reader-policy-model', effort: 'high' })
  assert.deepEqual(result.readerConfiguration, { model: 'reader-policy-model', effort: 'high', source: 'reader-policy' })
})

test('Reader changes native child when a later parent turn changes model or effort', async () => {
  const h = nativeHarness()
  const first = await h.reader.read(h.input)
  const second = await h.reader.read({ ...h.input, model: 'other-model', effort: 'high' })
  assert.notEqual(first.nativeThreadId, second.nativeThreadId)
  assert.deepEqual(h.calls.filter(call => call.method === 'turn/start').map(call => [call.params.model, call.params.effort]), [['gpt-6-sol', 'max'], ['other-model', 'high']])
})

test('native-reported Reader configuration mismatch fails without a successful read', async () => {
  for (const mismatch of [{ mismatchedThreadModel: true }, { mismatchedTurnEffort: true }]) {
    const h = nativeHarness(mismatch)
    await assert.rejects(h.reader.read(h.input), e => e.code === 'READER_CONFIGURATION_MISMATCH')
  }
})

test('Reader refinement reuses a bounded session and re-enters original source, not only previous summaries', async () => {
  const h = nativeHarness()
  const first = await h.reader.read(h.input)
  const second = await h.reader.read({ ...h.input, intent: 'Read the same source from another angle' })
  assert.equal(first.nativeThreadId, second.nativeThreadId)
  const turns = h.calls.filter(call => call.method === 'turn/start')
  assert.equal(h.calls.filter(call => call.method === 'thread/resume').length, 1)
  assert.equal(JSON.parse(turns[1].params.input[0].text).sourceText, h.input.text)
  const third = await h.reader.read(h.input)
  assert.notEqual(third.nativeThreadId, first.nativeThreadId)
})

test('reused Reader checks MCP isolation again before its next provider turn', async () => {
  const h = nativeHarness({ toolsOnReuse: true })
  await h.reader.read(h.input)
  await assert.rejects(h.reader.read({ ...h.input, intent: 'Refine the reading' }), error => error.code === 'READER_ISOLATION_UNAVAILABLE')
  assert.equal(h.calls.filter(call => call.method === 'turn/start').length, 1)
})

test('reused Reader rechecks effective native policy before the second child turn', async () => {
  for (const options of [{ unsafeReuseSandbox: true }, { unsafeReuseNetwork: true }, { unsafeReuseApproval: true }, { wrongReuseThread: true }, { mismatchedReuseModel: true }]) {
    const h = nativeHarness(options)
    await h.reader.read(h.input)
    await assert.rejects(h.reader.read({ ...h.input, intent: 'Refine source reading' }), error =>
      ['READER_ISOLATION_UNAVAILABLE', 'READER_CONFIGURATION_MISMATCH'].includes(error.code))
    assert.equal(h.calls.filter(call => call.method === 'turn/start').length, 1)
    assert.equal(h.calls.filter(call => call.method === 'thread/resume').length, 1)
  }
})

test('Reader cannot start a model turn when native isolation is unverifiable', async () => {
  for (const options of [{ externalTools: true }, { externalResources: true }, { externalTemplates: true }, { toolsError: true }, { unsafeSandbox: true }, { unsafeNetwork: true }, { unsafeApproval: true }]) {
    const h = nativeHarness(options)
    await assert.rejects(h.reader.read(h.input), e => e.code === 'READER_ISOLATION_UNAVAILABLE')
    assert.equal(h.calls.some(call => call.method === 'turn/start'), false)
  }
})

test('failed Reader and fabricated source quotes never become successful packets', async () => {
  const failed = nativeHarness({ failed: true })
  await assert.rejects(failed.reader.read(failed.input), e => e.code === 'READER_FAILED')
  const invalid = nativeHarness({ badQuote: true })
  await assert.rejects(invalid.reader.read(invalid.input), e => e.code === 'READER_INVALID_CITATION')
})

test('cancel while native turn is starting interrupts the exact returned child ID and returns no result', async () => {
  let release, started
  const ready = new Promise(resolve => { started = resolve })
  const h = nativeHarness({ start: ({ id }) => { started(); return new Promise(resolve => { release = () => resolve({ turn: { id, status: 'inProgress' } }) }) } })
  const controller = new AbortController()
  const pending = h.reader.read({ ...h.input, signal: controller.signal })
  pending.catch(() => {})
  await ready
  controller.abort()
  release()
  await assert.rejects(pending, e => e.code === 'READ_CANCELLED')
  assert.ok(h.calls.some(call => call.method === 'turn/interrupt' && call.params.threadId === 'reader-1' && call.params.turnId === 'reader-turn-1'))
})

test('Reader rejects account changes before any native work', async () => {
  const h = nativeHarness()
  h.changeOwner('owner-b')
  await assert.rejects(h.reader.read(h.input), e => e.code === 'ACCOUNT_CHANGED')
  assert.equal(h.calls.length, 0)
})

test('unexpected Reader tool execution is interrupted, not approved or mislabeled as reading success', async () => {
  const h = nativeHarness({ start: ({ reader, params, id }) => {
    reader.handleNotification({ method: 'item/started', params: { threadId: params.threadId, turnId: id, item: { type: 'commandExecution' } } })
    return { turn: { id, status: 'inProgress' } }
  } })
  await assert.rejects(h.reader.read(h.input), e => e.code === 'READER_SCOPE_VIOLATION')
  assert.ok(h.calls.some(call => call.method === 'turn/interrupt'))
  assert.equal(h.replies.length, 0)
})

test('aborted Reader is quarantined until actual native terminal receipt; interrupt acknowledgement alone is insufficient', async () => {
  let ready
  const started = new Promise(resolve => { ready = resolve })
  let first = true
  const h = nativeHarness({ start: ({ reader, params, id }) => {
    if (first) { first = false; ready(); return { turn: { id, status: 'inProgress' } } }
    const source = JSON.parse(params.input[0].text).sourceText
    reader.handleNotification({ method: 'item/completed', params: { threadId: params.threadId, turnId: id, item: { type: 'agentMessage', text: JSON.stringify({ summary: 'Reread complete.', quotes: [source.slice(0, 10)], structure: [] }) } } })
    reader.handleNotification({ method: 'turn/completed', params: { threadId: params.threadId, turn: { id, status: 'completed' } } })
    return { turn: { id, status: 'inProgress' } }
  } })
  const controller = new AbortController()
  const pending = h.reader.read({ ...h.input, signal: controller.signal })
  pending.catch(() => {})
  await started
  controller.abort()
  await assert.rejects(pending, e => e.code === 'READ_CANCELLED')
  const beforeRetry = h.calls.length
  await assert.rejects(h.reader.read(h.input), e => e.code === 'READER_STOP_PENDING')
  assert.equal(h.calls.length, beforeRetry)
  h.reader.handleNotification({ method: 'turn/completed', params: { threadId: 'reader-1', turn: { id: 'reader-turn-1', status: 'interrupted' } } })
  const retried = await h.reader.read(h.input)
  assert.equal(retried.nativeThreadId, 'reader-2')
})

test('timed-out Reader also remains quarantined without native completion proof', async () => {
  const h = nativeHarness({ timeoutMs: 5, start: ({ id }) => ({ turn: { id, status: 'inProgress' } }) })
  const keeper = setTimeout(() => {}, 100)
  try {
    await assert.rejects(h.reader.read(h.input), e => e.code === 'READER_TIMEOUT')
    await assert.rejects(h.reader.read(h.input), e => e.code === 'READER_STOP_PENDING')
    assert.equal(h.calls.filter(call => call.method === 'thread/start').length, 1)
  } finally { clearTimeout(keeper) }
})
