import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, chmod, symlink, rm, realpath, mkdir, readdir, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { CodexChatRuntime } from './codex-chat-runtime.mjs'
import { createCodexBrowserToolProvider } from './codex-browser-tool-provider.mjs'
import { ContextRuntime } from './egdesk-context-runtime.mjs'
import { inspectNativeCapabilities } from './egdesk-native-capabilities.mjs'
import { openChatStore } from './egdesk-chat-store.mjs'
import { composeDeveloperInstructions, openProfileStore } from './egdesk-profile-store.mjs'
import { explicitFileLinks, publicText, verifyLocalFile } from './codex-chat-values.mjs'
import { createPrivateQaTempDirectory } from '../scripts/egdesk-qa-platform.mjs'

// Codex reports a thread's effective feature switches (experimentalFeature/list
// with threadId); a bounded thread has the built-in browser and computer ones off.
const qaFeatureList = () => ({ data: ['browser_use', 'browser_use_external', 'computer_use'].map(name => ({ name, enabled: false, stage: 'stable' })), nextCursor: null })

function harness(override = {}) {
  const calls = [], events = [], legacy = [], replies = []
  let turnCount = 0, threadCount = 0
  const defaults = async (method, params) => {
    if (method === 'thread/start') return { thread: { id: `thread-${++threadCount}` }, cwd: '/work', model: 'configured-model' }
    if (method === 'thread/resume') return { thread: { id: params.threadId, turns: [] }, cwd: '/work' }
    if (method === 'turn/start') return { turn: { id: `turn-${++turnCount}`, status: 'inProgress', items: [] } }
    if (method === 'turn/interrupt') return {}
    throw new Error(`Unexpected method: ${method}`)
  }
  const chat = new CodexChatRuntime({
    request: async (method, params) => { calls.push({ method, params }); return (override.request || defaults)(method, params, chat, defaults) },
    respond: (...args) => replies.push(args), emit: event => events.push(event), emitLegacy: event => legacy.push(event),
    contexts: override.contexts,
    toolProviders: override.toolProviders,
    getOwnerKey: override.getOwnerKey,
    qaReady: override.qaReady,
    getNativeContractFingerprint: override.getNativeContractFingerprint,
    expectedProcessConfiguration: override.expectedProcessConfiguration,
    verifyFile: override.verifyFile || (async () => null),
    profiles: override.profiles,
  })
  chat.setConnection(true)
  const notify = (method, params) => chat.handleNotification({ method, params })
  const item = (run, value, completed = true) => notify(completed ? 'item/completed' : 'item/started', { threadId: run.conversationId, turnId: run.runId, item: value })
  const finish = (run, status = 'completed', items = []) => notify('turn/completed', { threadId: run.conversationId, turn: { id: run.runId, status, items } })
  return { chat, calls, events, legacy, replies, notify, item, finish }
}

function qaHarness(override = {}) {
  return harness({ ...override, request: async (method, params, chat, defaults) => {
    if (override.request) {
      const custom = await override.request(method, params, chat, defaults)
      if (custom !== undefined) return custom
    }
    if (method === 'experimentalFeature/list') return qaFeatureList()
    if (method === 'mcpServerStatus/list') return { data: [
      { name: 'account-tools', pluginId: 'account-plugin', tools: params.threadId ? {} : { write: {} }, resources: [], resourceTemplates: [], toolsError: null },
      { name: 'configured-tools', tools: params.threadId ? {} : { read: {} }, resources: [], resourceTemplates: [], toolsError: null },
      { name: 'app-provided-tools', tools: params.threadId ? {} : { ambient: {} }, resources: [], resourceTemplates: [], toolsError: null },
    ], nextCursor: null }
    if (method === 'thread/unsubscribe') return { status: 'unsubscribed' }
    if (method === 'config/read') return { config: { developer_instructions: 'Ordinary instructions' },
      layers: [{ name: { type: 'user' }, config: { mcp_servers: { 'configured-tools': { command: 'fixture-mcp' } } } }] }
    const result = await defaults(method, params)
    if (method === 'thread/start' || method === 'thread/resume') return { ...result, sandbox: { type: 'readOnly', networkAccess: false }, approvalPolicy: 'never' }
    return result
  } })
}

test('read-only QA is explicit, verifies native thread and MCP isolation before a same-path turn, and preserves context reads', async () => {
  const registered = [], bound = []
  const contexts = {
    prepare: async () => ({ sourceIds: ['fixture-source'] }),
    specs: () => ['egdesk_list_context', 'egdesk_read_source', 'egdesk_capture_output', 'egdesk_publish_briefing'].map(name => ({ type: 'function', name, inputSchema: { type: 'object' }, description: name })),
    additionalContext: () => ({ egdesk_context: { kind: 'application', value: 'fixture-source' } }),
    registerThread: async id => registered.push(id),
    bindRun: async run => bound.push(run.runId),
  }
  const h = qaHarness({ contexts })
  const accepted = await h.chat.send({ message: 'Read fixture and run a safe nonce command', requestId: 'qa-1', executionPolicy: { mode: 'readOnlyQa' }, attachments: [{ name: 'fixture' }], contextCapabilities: { read: true } })
  const start = h.calls.find(call => call.method === 'thread/start').params
  const turn = h.calls.find(call => call.method === 'turn/start').params
  assert.equal(start.sandbox, 'read-only')
  assert.equal(start.approvalPolicy, 'never')
  assert.equal(Object.hasOwn(start.config.mcp_servers, 'account-tools'), false)
  assert.equal(Object.hasOwn(start.config.mcp_servers, 'app-provided-tools'), false)
  assert.deepEqual(start.config.mcp_servers['configured-tools'], { enabled: false })
  assert.deepEqual(start.config.plugins['account-plugin'], { enabled: false })
  assert.equal(start.config.features.plugins, false)
  assert.equal(start.config.features.multi_agent, false)
  assert.equal(start.config.features.default_mode_request_user_input, false)
  // Codex's own browser and computer switches are off too, and the thread reports them off.
  assert.deepEqual([start.config.features.browser_use, start.config.features.browser_use_external, start.config.features.computer_use], [false, false, false])
  assert.equal(accepted.executionPolicy.nativeComputerFeatures, 'off')
  assert.ok(h.calls.findIndex(call => call.method === 'experimentalFeature/list' && call.params.threadId === accepted.conversationId) < h.calls.findIndex(call => call.method === 'turn/start'))
  assert.deepEqual(h.calls.find(call => call.method === 'config/read').params, { includeLayers: true, cwd: null })
  assert.equal(start.config.web_search, 'disabled')
  assert.deepEqual(start.dynamicTools.map(tool => tool.name), ['egdesk_list_context', 'egdesk_read_source'])
  assert.deepEqual(turn.additionalContext, { egdesk_context: { kind: 'application', value: 'fixture-source' } })
  assert.deepEqual(turn.sandboxPolicy, { type: 'readOnly', networkAccess: false })
  assert.equal(turn.approvalPolicy, 'never')
  assert.equal(accepted.executionPolicy.status, 'native-thread-verified')
  assert.equal(accepted.executionPolicy.externalMcpCatalog, 'empty')
  assert.deepEqual(registered, [accepted.conversationId])
  assert.deepEqual(bound, [accepted.runId])
  assert.ok(h.events.some(event => event.event === 'run.executionPolicy' && event.details.executionPolicy.mode === 'readOnlyQa'))
  assert.ok(h.calls.findIndex(call => call.method === 'mcpServerStatus/list' && call.params.threadId === accepted.conversationId) < h.calls.findIndex(call => call.method === 'turn/start'))
})

test('bounded QA refuses missing direct-MCP layer evidence before native thread/start', async () => {
  const h = qaHarness({ request: async method => method === 'config/read' ? { config: {}, layers: null } : undefined })
  await assert.rejects(h.chat.send({ message: 'Do not run without origin evidence', executionPolicy: { mode: 'readOnlyQa' } }),
    error => error.code === 'QA_TOOL_ISOLATION_UNVERIFIED')
  assert.equal(h.calls.some(call => call.method === 'thread/start' || call.method === 'turn/start'), false)
})

test('ordinary Chat does not apply QA MCP or plugin overrides to its native thread', async () => {
  const h = qaHarness()
  await h.chat.send({ message: 'Ordinary work retains its existing native configuration' })
  assert.equal(h.calls.some(call => call.method === 'config/read' || call.method === 'mcpServerStatus/list'), false)
  // Only the ordinary Agent-question opt-in; no QA MCP, plugin or web overrides.
  assert.deepEqual(h.calls.find(call => call.method === 'thread/start').params.config, { features: { default_mode_request_user_input: true } })
})

test('actual ContextRuntime attachment capture and dynamic read specs remain available under the validated 0.160.1 gate', async () => {
  const native = inspectNativeCapabilities({ executable: '/native/codex', run: () => ({ status: 0, stdout: 'codex-cli 0.160.1\n' }),
    probe: () => ({ contextContract: true, qaContract: true, schemaFingerprint: 'a'.repeat(64) }), fingerprint: () => 'b'.repeat(64) })
  const captured = { sourceId: 'fixture-source', hash: 'fixture-hash', label: 'Public fixture', captureScope: 'full', truncated: false, shape: { kind: 'text' } }
  const observations = []
  const store = {
    captureAttachments: async (owner, body) => { observations.push(['capture', owner, body.attachments.length]); return [captured] },
    getCapture: async (owner, id) => { assert.equal(id, captured.sourceId); return captured },
    markNativeThread: async (owner, id) => observations.push(['registered', owner, id]),
    bind: async (owner, run, ids, capabilities, readerConfiguration) => {
      observations.push(['bound', owner, run.runId, ids])
      return { bindingId: 'binding-1', capabilities, readerConfiguration, captures: [captured] }
    },
  }
  const contexts = new ContextRuntime({ store, reader: null, getOwnerKey: () => 'qa-account', schemaReady: () => native.schemaMatch })
  const h = qaHarness({ contexts, getOwnerKey: () => 'qa-account' })
  const accepted = await h.chat.send({ message: 'Read the attached public fixture', clientThreadId: 'fixture-chat', attachments: [{ kind: 'public-fixture' }], contextCapabilities: { read: true }, executionPolicy: { mode: 'readOnlyQa' } })
  assert.deepEqual(observations.map(row => row[0]), ['capture', 'registered', 'bound'])
  assert.deepEqual(h.calls.find(call => call.method === 'thread/start').params.dynamicTools.map(tool => tool.name), ['egdesk_list_context', 'egdesk_read_source'])
  const context = JSON.parse(h.calls.find(call => call.method === 'turn/start').params.additionalContext.egdesk_context.value)
  assert.equal(context.captures[0].sourceId, captured.sourceId)
  assert.equal(accepted.executionPolicy.mode, 'readOnlyQa')
})

test('ordinary Browser attachment keeps immutable Context read without live Browser binding or native policy changes', async () => {
  const owner = 'codex:chatgpt:fixture-owner'
  const captured = { sourceId: 'browser-snapshot-1', hash: 'browser-hash', label: 'Selected Browser snapshot',
    captureScope: 'visible', truncated: false, shape: { kind: 'browser' } }
  const contextCalls = [], browserCalls = []
  const contexts = new ContextRuntime({ getOwnerKey: () => owner, schemaReady: () => true, reader: null, store: {
    captureAttachments: async (key, body) => { contextCalls.push(['capture', key, body.attachments.length]); return [captured] },
    getCapture: async (key, id) => { contextCalls.push(['read-capture', key, id]); return captured },
    markNativeThread: async (key, id) => contextCalls.push(['register', key, id]),
    bind: async (key, run, ids, capabilities) => {
      contextCalls.push(['bind', key, run.runId, ids])
      return { bindingId: 'context-binding-1', capabilities, readerConfiguration: null, captures: [captured] }
    },
  } })
  const transport = { runs: new Map(), hasClient: () => false, bindRun: () => browserCalls.push('transport-bind'),
    unbindRun: () => browserCalls.push('transport-unbind'), reset: () => browserCalls.push('transport-reset') }
  const service = { prepare: () => { browserCalls.push('prepare'); throw new Error('ordinary Chat must not prepare live Browser') },
    bind: async () => browserCalls.push('bind'), dispatch: async () => browserCalls.push('dispatch'),
    cancelRun: async () => browserCalls.push('cancel'), reset: async () => [] }
  const browser = createCodexBrowserToolProvider({ transport, service, getOwnerKey: () => owner })
  const h = harness({ contexts, toolProviders: [browser], getOwnerKey: () => owner })
  const capture = await contexts.capture({ clientThreadId: 'ui-browser-chat', attachments: [{ kind: 'browser', sourceId: captured.sourceId }] })
  assert.equal(capture.captures[0].sourceId, captured.sourceId)
  const run = await h.chat.send({ message: 'Read the selected Browser snapshot', clientThreadId: 'ui-browser-chat',
    contextSnapshotIds: [captured.sourceId], contextCapabilities: { read: true },
    selectedSources: [{ id: 'source-1', kind: 'browser', selectedByUser: true, browserToolPermission: 'interact',
      browserToolSelection: { token: 'one-time-token', threadId: 'ui-browser-chat' },
      sourceRef: { viewId: 'card-1', profileId: 'firefox-default', accountId: '', uri: 'https://example.test/fixture' } }],
  })
  assert.equal(run.accepted, true)
  assert.equal(Object.hasOwn(run, 'executionPolicy'), false)
  const start = h.calls.find(call => call.method === 'thread/start').params
  assert.equal(Object.hasOwn(start, 'sandbox'), false)
  assert.equal(Object.hasOwn(start, 'approvalPolicy'), false)
  assert.deepEqual(start.dynamicTools.map(spec => spec.name).filter(name => name.startsWith('egdesk_browser_')), [])
  assert.ok(start.dynamicTools.some(spec => spec.name === 'egdesk_read_source'))
  const turn = h.calls.find(call => call.method === 'turn/start').params
  assert.equal(Object.hasOwn(turn, 'sandboxPolicy'), false)
  assert.deepEqual(JSON.parse(turn.additionalContext.egdesk_context.value).captures.map(source => source.sourceId), [captured.sourceId])
  assert.equal(h.chat.snapshot(run.conversationId).runs[0].context.capabilities.read, true)
  assert.deepEqual(contextCalls.map(call => call[0]), ['capture', 'read-capture', 'register', 'bind'])
  assert.deepEqual(browserCalls, [])
  await h.chat.handleServerRequest({ id: 'forbidden-browser-call', method: 'item/tool/call', params: {
    threadId: run.conversationId, turnId: run.runId, callId: 'call-1', tool: 'egdesk_browser_observe', arguments: { cardId: 'card-1' },
  } })
  assert.equal(h.replies[0][2].code, -32601)
  assert.deepEqual(browserCalls, [])
})

test('invalid QA policy and unavailable native contract reject before provider turn or local acceptance', async () => {
  for (const executionPolicy of [null, 'readOnlyQa', {}, { mode: 'readOnlyQa', sandbox: 'dangerFullAccess' }, { mode: 'write' }]) {
    const h = qaHarness()
    await assert.rejects(h.chat.send({ message: 'test', executionPolicy }), error => error.code === 'INVALID_EXECUTION_POLICY')
    assert.deepEqual(h.calls, [])
  }
  const unavailable = qaHarness({ qaReady: () => false })
  await assert.rejects(unavailable.chat.send({ message: 'test', executionPolicy: { mode: 'readOnlyQa' } }), error => error.code === 'QA_POLICY_UNAVAILABLE')
  assert.deepEqual(unavailable.calls, [])
})

test('native read-only, offline and never-approval response fields are all mandatory before provider turn', async () => {
  const bad = [
    { sandbox: { type: 'workspaceWrite', networkAccess: false }, approvalPolicy: 'never' },
    { sandbox: { type: 'readOnly', networkAccess: true }, approvalPolicy: 'never' },
    { sandbox: { type: 'readOnly' }, approvalPolicy: 'never' },
    { sandbox: { type: 'readOnly', networkAccess: false }, approvalPolicy: 'on-request' },
  ]
  for (const receipt of bad) {
    const h = qaHarness({ request: async (method, params, chat, defaults) => method === 'thread/start' ? { ...(await defaults(method, params)), ...receipt } : undefined })
    await assert.rejects(h.chat.send({ message: 'test', executionPolicy: { mode: 'readOnlyQa' } }), error => error.code === 'QA_POLICY_UNVERIFIED')
    assert.equal(h.calls.filter(call => call.method === 'turn/start').length, 0)
    assert.ok(!h.events.some(event => event.event === 'run.executionPolicy'))
  }
})

test('QA blocks provider turn when effective MCP catalog has tools, resources or discovery errors', async () => {
  for (const exposure of [{ tools: { send: {} } }, { resources: [{ uri: 'private' }] }, { toolsError: 'unknown' }]) {
    const h = qaHarness({ request: async (method, params) => method === 'mcpServerStatus/list' && params.threadId ? { data: [{ name: 'account-tools', tools: {}, resources: [], resourceTemplates: [], ...exposure }], nextCursor: null } : undefined })
    await assert.rejects(h.chat.send({ message: 'test', executionPolicy: { mode: 'readOnlyQa' } }), error => error.code === 'QA_TOOL_ISOLATION_UNVERIFIED')
    assert.equal(h.calls.filter(call => call.method === 'turn/start').length, 0)
  }
})

test('QA blocks the provider turn when the thread still allows built-in browser or computer control, or its features cannot be read', async () => {
  for (const name of ['browser_use', 'browser_use_external', 'computer_use']) {
    const h = qaHarness({ request: async method => method === 'experimentalFeature/list'
      ? { data: qaFeatureList().data.map(feature => feature.name === name ? { ...feature, enabled: true } : feature), nextCursor: null } : undefined })
    await assert.rejects(h.chat.send({ message: 'test', executionPolicy: { mode: 'readOnlyQa' } }), error => error.code === 'QA_TOOL_ISOLATION_UNVERIFIED', name)
    assert.equal(h.calls.filter(call => call.method === 'turn/start').length, 0)
  }
  // A missing switch is not proof it is off; another native error is not "method absent".
  for (const answer of [
    async () => ({ data: qaFeatureList().data.filter(feature => feature.name !== 'computer_use'), nextCursor: null }),
    async () => { throw Object.assign(new Error('thread not found: native'), { code: -32600 }) },
    async () => { throw new Error('connection lost') },
    async () => ({ data: null }),
  ]) {
    const h = qaHarness({ request: async method => method === 'experimentalFeature/list' ? answer() : undefined })
    await assert.rejects(h.chat.send({ message: 'test', executionPolicy: { mode: 'readOnlyQa' } }), error => error.code === 'QA_TOOL_ISOLATION_UNVERIFIED')
    assert.equal(h.calls.filter(call => call.method === 'turn/start').length, 0)
  }
})

test('a Codex build without thread feature reporting keeps QA running on the MCP check and says the switches were unchecked', async () => {
  const h = qaHarness({ request: async method => {
    if (method === 'experimentalFeature/list') throw Object.assign(new Error('Invalid request: unknown variant `experimentalFeature/list`, expected one of `initialize`'), { code: -32600 })
  } })
  const accepted = await h.chat.send({ message: 'test', executionPolicy: { mode: 'readOnlyQa' } })
  assert.equal(accepted.executionPolicy.externalMcpCatalog, 'empty')
  assert.equal(accepted.executionPolicy.nativeComputerFeatures, 'unchecked')
  assert.equal(h.calls.filter(call => call.method === 'turn/start').length, 1)
})

test('same EG-Desk QA Run publishes only an exact nonce line from native command item/completed', async () => {
  const nonce = 'EGDESK_PUBLIC_QA_7f41ad982b'
  const h = qaHarness({ getNativeContractFingerprint: () => 'a'.repeat(64) })
  const run = await h.chat.send({ message: 'Read the disposable public fixture and print its line', executionPolicy: { mode: 'readOnlyQa' }, qaCommandNonce: nonce })
  await h.item(run, { id: 'native-command-1', type: 'commandExecution', status: 'completed', command: 'cat /public-fixture/nonce.txt', cwd: '/public-fixture', exitCode: 0, aggregatedOutput: `unrelated private line\n${nonce}\n` })
  const proof = h.events.find(event => event.event === 'qa.command.receipt')
  assert.equal(proof.requestId, run.requestId)
  assert.equal(proof.runId, run.runId)
  assert.equal(proof.details.nativeItemId, 'native-command-1')
  assert.equal(proof.details.exitCode, 0)
  assert.equal(proof.details.status, 'marker-witness')
  assert.deepEqual(proof.details.markerLines, [nonce])
  assert.equal(proof.details.outputStream, 'aggregated-stdout-stderr')
  assert.equal(proof.details.originalProviderId, 'codex-native')
  assert.equal(proof.details.contractFingerprint, 'a'.repeat(64))
  assert.equal(h.chat.snapshot(run.conversationId).runs[0].qaCommandReceipts[0].nativeItemId, 'native-command-1')
  assert.equal(JSON.stringify({ events: h.events, state: h.chat.snapshot() }).includes('unrelated private line'), false)
  await h.item(run, { id: 'native-command-1', type: 'commandExecution', status: 'completed', command: 'cat /public-fixture/nonce.txt', exitCode: 0, aggregatedOutput: `${nonce}\n` })
  assert.equal(h.events.filter(event => event.event === 'qa.command.receipt').length, 1)
})

test('two explicit QA markers map to distinct actual native command items in one Run', async () => {
  const fileNonce = 'EGDESK_FILE_NONCE_13b49a72'
  const commandTag = 'EGDESK_COMMAND_TAG_98f0c231'
  const h = qaHarness()
  const message = `Read the public fixture, then run a harmless command that prints ${commandTag}`
  assert.equal(message.includes(fileNonce), false)
  const run = await h.chat.send({ message, executionPolicy: { mode: 'readOnlyQa' }, qaOutputMarkers: [fileNonce, commandTag] })
  const commands = [
    { id: 'native-read-item', type: 'commandExecution', status: 'completed', command: 'cat /public/fixture/nonce.txt', cwd: '/public/fixture', exitCode: 0, aggregatedOutput: `${fileNonce}\n` },
    { id: 'native-harmless-item', type: 'commandExecution', status: 'completed', command: `printf '%s\\n' ${commandTag}`, cwd: '/public/fixture', exitCode: 0, aggregatedOutput: `${commandTag}\n` },
  ]
  for (const item of commands) await h.item(run, item)
  const receipts = h.events.filter(event => event.event === 'qa.command.receipt')
  assert.equal(receipts.length, 2)
  assert.ok(receipts.every(event => event.runId === run.runId && event.requestId === run.requestId && event.details.status === 'marker-witness'))
  assert.deepEqual(receipts.map(event => [event.details.nativeItemId, event.details.markerLines]), [
    ['native-read-item', [fileNonce]], ['native-harmless-item', [commandTag]],
  ])
  for (const receipt of receipts) {
    const activity = h.chat.snapshot(run.conversationId).runs[0].activities.find(item => item.id === receipt.details.nativeItemId)
    assert.equal(receipt.details.commandSha256, createHash('sha256').update(activity.detail.command).digest('hex'))
    assert.equal(activity.detail.exitCode, 0)
    assert.equal(receipt.details.nativeItemStatus, 'completed')
    assert.equal(receipt.details.outputStream, 'aggregated-stdout-stderr')
  }
  assert.equal(h.chat.snapshot(run.conversationId).runs[0].qaCommandReceipts.length, 2)
})

test('early or foreign native command output cannot fabricate a QA receipt', async () => {
  const nonce = 'EGDESK_PUBLIC_QA_4cd671ae92'
  const h = qaHarness({ request: async (method, params, chat) => {
    if (method !== 'turn/start') return undefined
    await chat.handleNotification({ method: 'item/completed', params: { threadId: params.threadId, turnId: 'foreign-turn', item: { id: 'foreign-command', type: 'commandExecution', status: 'completed', command: 'cat fixture', exitCode: 0, aggregatedOutput: `${nonce}\n` } } })
    await chat.handleNotification({ method: 'item/completed', params: { threadId: params.threadId, turnId: 'owned-turn', item: { id: 'owned-command', type: 'commandExecution', status: 'completed', command: 'cat fixture', exitCode: 0, aggregatedOutput: `${nonce}\n` } } })
    return { turn: { id: 'owned-turn', status: 'inProgress', items: [] } }
  } })
  const run = await h.chat.send({ message: 'Read fixture', executionPolicy: { mode: 'readOnlyQa' }, qaCommandNonce: nonce })
  assert.equal(h.events.filter(event => event.event === 'qa.command.receipt').length, 1)
  assert.equal(h.events.find(event => event.event === 'qa.command.receipt').details.nativeItemId, 'owned-command')
  assert.equal(h.chat.snapshot(run.conversationId).runs.length, 1)
  const ordinary = qaHarness()
  await assert.rejects(ordinary.chat.send({ message: 'No policy', qaCommandNonce: nonce }), error => error.code === 'QA_COMMAND_POLICY_REQUIRED')
  assert.deepEqual(ordinary.calls, [])
  const invalid = qaHarness()
  await assert.rejects(invalid.chat.send({ message: 'Duplicate markers', executionPolicy: { mode: 'readOnlyQa' }, qaOutputMarkers: [nonce, nonce] }), error => error.code === 'INVALID_QA_OUTPUT_MARKERS')
  await assert.rejects(invalid.chat.send({ message: 'Conflicting contracts', executionPolicy: { mode: 'readOnlyQa' }, qaOutputMarkers: [nonce], qaCommandNonce: nonce }), error => error.code === 'INVALID_QA_OUTPUT_MARKERS')
  await assert.rejects(invalid.chat.send({ message: `Spoiled private fixture ${nonce}`, executionPolicy: { mode: 'readOnlyQa' }, qaOutputMarkers: [nonce, 'EGDESK_COMMAND_TAG_89ac5217'] }), error => error.code === 'QA_PRIVATE_MARKER_SPOILED')
  assert.deepEqual(invalid.calls, [])
})

test('QA policy persists across ordinary continuation, profile change and explicit resume', async () => {
  const h = qaHarness()
  const first = await h.chat.send({ message: 'first', executionPolicy: { mode: 'readOnlyQa' } })
  await h.finish(first)
  const second = await h.chat.send({ message: 'second', conversationId: first.conversationId, profileEnabled: false })
  assert.equal(second.executionPolicy.mode, 'readOnlyQa')
  assert.equal(h.calls.filter(call => call.method === 'thread/resume').length, 1)
  assert.equal(h.calls.find(call => call.method === 'thread/resume').params.developerInstructions, 'Ordinary instructions')
  assert.equal(h.calls.filter(call => call.method === 'turn/start')[1].params.approvalPolicy, 'never')
  await h.finish(second)
  await h.chat.resume({ conversationId: first.conversationId })
  assert.equal(h.calls.filter(call => call.method === 'thread/resume').length, 2)
  assert.equal(h.chat.threads.get(first.conversationId).executionPolicy, 'readOnlyQa')
})

test('a changed native resume policy blocks the next QA turn rather than trusting a prior receipt', async () => {
  const h = qaHarness({ request: async (method, params, chat, defaults) => method === 'thread/resume'
    ? { ...(await defaults(method, params)), sandbox: { type: 'workspaceWrite', networkAccess: false }, approvalPolicy: 'never' }
    : undefined })
  const first = await h.chat.send({ message: 'first', executionPolicy: { mode: 'readOnlyQa' } })
  await h.finish(first)
  await assert.rejects(h.chat.send({ message: 'second', conversationId: first.conversationId }), error => error.code === 'QA_POLICY_UNVERIFIED')
  assert.equal(h.calls.filter(call => call.method === 'turn/start').length, 1)
})

test('resumed active QA run has a deny-all approval guard even without a recoverable turn receipt', async () => {
  const h = qaHarness({ request: async (method, params, chat, defaults) => method === 'thread/resume'
    ? { ...(await defaults(method, params)), thread: { id: params.threadId, turns: [{ id: 'active-turn', status: 'inProgress', items: [] }] }, sandbox: { type: 'readOnly', networkAccess: false }, approvalPolicy: 'never' }
    : undefined })
  h.chat.threads.set('qa-thread', { id: 'qa-thread', cwd: '/work', model: 'configured-model', clientThreadId: 'ui-qa', executionPolicy: 'readOnlyQa' })
  await h.chat.resume({ conversationId: 'qa-thread' })
  const run = h.chat.snapshot('qa-thread').runs[0]
  assert.equal(run.executionPolicy.status, 'recovered-active-guard')
  await h.chat.handleServerRequest({ id: 'native-approval', method: 'item/commandExecution/requestApproval', params: { threadId: 'qa-thread', turnId: 'active-turn', itemId: 'command', command: 'touch forbidden', availableDecisions: ['accept', 'decline'] } })
  assert.equal(h.replies[0][0], 'native-approval')
  assert.equal(h.replies[0][2].code, -32601)
  assert.deepEqual(h.chat.snapshot('qa-thread').runs[0].pendingApprovals, [])
  h.chat.pendingApprovals.set('stale-ui-approval', { approvalId: 'stale-ui-approval', conversationId: 'qa-thread', runId: 'active-turn', status: 'pending', choices: ['accept'], rpcId: 'old-rpc' })
  await assert.rejects(h.chat.replyApproval({ conversationId: 'qa-thread', runId: 'active-turn', approvalId: 'stale-ui-approval', decision: 'accept' }), error => error.code === 'NATIVE_RUN_UNBOUND')
  assert.equal(h.replies.length, 1)
})

test('unloaded native history is checked for an active turn before profile or new-turn dispatch', async () => {
  const h = harness({ request: async (method, params) => {
    if (method === 'thread/resume') return { thread: { id: params.threadId, turns: [{ id: 'active-native', status: 'inProgress', items: [] }] }, cwd: '/historical' }
    throw new Error(`No other native call allowed: ${method}`)
  } })
  await assert.rejects(h.chat.send({ message: 'must wait', conversationId: 'old-thread', profileEnabled: false }), error => error.code === 'RUN_IN_PROGRESS')
  assert.deepEqual(h.calls.map(call => call.method), ['thread/resume'])
})

test('an existing ordinary thread can opt into QA, but a later omitted policy does not widen it', async () => {
  const h = qaHarness()
  const ordinary = await h.chat.send({ message: 'ordinary' })
  assert.equal(h.calls.find(call => call.method === 'thread/start').params.sandbox, undefined)
  await h.finish(ordinary)
  const qa = await h.chat.send({ message: 'qa', conversationId: ordinary.conversationId, executionPolicy: { mode: 'readOnlyQa' } })
  assert.equal(qa.executionPolicy.mode, 'readOnlyQa')
  assert.equal(h.calls.find(call => call.method === 'thread/resume').params.sandbox, 'read-only')
  await h.finish(qa)
  const continued = await h.chat.send({ message: 'still qa', conversationId: ordinary.conversationId })
  assert.equal(continued.executionPolicy.mode, 'readOnlyQa')
  assert.equal(h.calls.filter(call => call.method === 'turn/start').at(-1).params.approvalPolicy, 'never')
})

test('ordinary threads with persisted broader dynamic tools cannot be relabeled read-only QA', async () => {
  const contexts = { specs: () => [{ type: 'function', name: 'egdesk_capture_output', description: 'writes capture', inputSchema: {} }], prepare: async () => null, registerThread: async () => {} }
  const h = qaHarness({ contexts })
  const ordinary = await h.chat.send({ message: 'ordinary' })
  await h.finish(ordinary)
  await assert.rejects(h.chat.send({ message: 'qa', conversationId: ordinary.conversationId, executionPolicy: { mode: 'readOnlyQa' } }), error => error.code === 'QA_REQUIRES_NEW_CONVERSATION')
  assert.equal(h.calls.filter(call => call.method === 'turn/start').length, 1)
})

test('Browser specs are pre-registered so a later selected Card uses the same native thread under browserBounded policy', async () => {
  const browser = {
    providerId: 'egdesk-browser',
    specs: () => ['egdesk_browser_observe', 'egdesk_browser_navigate', 'egdesk_browser_click', 'egdesk_browser_fill'].map(name => ({ type: 'function', name, description: name, inputSchema: { type: 'object' } })),
    prepare: async body => body.selectedSources?.length ? { cards: body.selectedSources } : null,
    requireThread(threadId, prepared) { if (prepared && !this.runtime.browserRegisteredThreads.has(threadId)) throw Object.assign(new Error('Older thread'), { code: 'BROWSER_TOOLS_UNAVAILABLE' }) },
    bindRun: async (run, prepared) => { if (prepared) run.browserBinding = { cards: prepared.cards } },
    dispatch: async () => ({ success: true, contentItems: [{ type: 'inputText', text: '{"status":"postcondition-observed"}' }] }),
  }
  const h = qaHarness({ toolProviders: [browser] })
  const first = await h.chat.send({ message: 'Start bounded Browser chat', executionPolicy: { mode: 'browserBounded' } })
  assert.deepEqual(h.calls.find(call => call.method === 'thread/start').params.dynamicTools.map(spec => spec.name), ['egdesk_browser_observe'])
  await h.finish(first)
  const second = await h.chat.send({ message: 'Observe selected Card', conversationId: first.conversationId, selectedSources: [{ cardId: 'card-1', permission: 'observe' }], browserTransportId: 'ui-1' })
  assert.equal(second.conversationId, first.conversationId)
  assert.equal(second.executionPolicy.mode, 'browserBounded')
  assert.equal(second.executionPolicy.browserEffects, 'observe-only-selected-card')
  assert.equal(h.calls.find(call => call.method === 'thread/resume').params.sandbox, 'read-only')
  assert.deepEqual(h.calls.filter(call => call.method === 'turn/start')[1].params.sandboxPolicy, { type: 'readOnly', networkAccess: false })
  assert.equal(h.chat.snapshot(second.conversationId).runs.at(-1).browserBinding.cards[0].permission, 'observe')
  await h.chat.handleServerRequest({ id: 'browser-call', method: 'item/tool/call', params: { threadId: second.conversationId, turnId: second.runId, callId: 'call-1', tool: 'egdesk_browser_observe', arguments: { cardId: 'card-1' } } })
  assert.equal(h.replies[0][1].success, true)
  await h.chat.handleServerRequest({ id: 'browser-click-forbidden', method: 'item/tool/call', params: { threadId: second.conversationId, turnId: second.runId, callId: 'call-2', tool: 'egdesk_browser_click', arguments: { cardId: 'card-1' } } })
  assert.equal(h.replies[1][2].code, -32601)
})

function selectedBrowserTurnFixture() {
  const actions = []
  const transport = { runs: new Map(), hasClient: id => id === 'selected-ui',
    bindRun() {}, unbindRun() {}, reset() {} }
  const service = {
    prepare: ({ selectedSources }) => ({ cards: new Map(selectedSources.map(source => [source.sourceRef.viewId,
      { cardId: source.sourceRef.viewId, sourceId: source.id, cardEpoch: source.browserToolIdentity.cardEpoch,
        permission: source.browserToolPermission }])) }),
    bind: async (_run, prepared) => ({ cards: [...prepared.cards.values()] }),
    dispatch: async (run, event) => { actions.push({ runId: run.runId, tool: event.tool });
      return { status: 'postcondition-observed', cardId: 'selected-card', action: 'click',
        postcondition: { matched: true }, externalEffectVerified: false } },
    cancelRun: async () => [], reset: async () => [],
  }
  const provider = createCodexBrowserToolProvider({ transport, service, getOwnerKey: () => 'codex:account-selected' })
  const source = { id: 'selected-source', kind: 'browser', selectedByUser: true, browserToolPermission: 'interact',
    sourceRef: { viewId: 'selected-card', uri: 'https://example.test/owned-page' },
    browserToolIdentity: { cardEpoch: 'selected-epoch' },
    browserToolSelection: { token: 'one-time-selected-token', threadId: 'selected-chat' } }
  return { provider, source, actions }
}

test('selected Browser interaction belongs to one native run despite inherited safe thread policy', async () => {
  const f = selectedBrowserTurnFixture(), h = qaHarness({ toolProviders: [f.provider] })
  const first = await h.chat.send({ message: 'Click only this selected Card', clientThreadId: 'selected-chat',
    executionPolicy: { mode: 'browserBounded' }, selectedSources: [f.source], browserTransportId: 'selected-ui' })
  assert.deepEqual(h.calls.find(call => call.method === 'thread/start').params.dynamicTools.map(spec => spec.name),
    ['egdesk_browser_observe', 'egdesk_browser_navigate', 'egdesk_browser_click', 'egdesk_browser_fill', 'egdesk_browser_scroll', 'egdesk_browser_press', 'egdesk_browser_wait'])
  assert.equal(first.executionPolicy.browserEffects, 'selected-card-observe-click-fill-this-run')
  assert.equal(h.chat.threads.get(first.conversationId).qaReceipt.browserEffects, 'observe-only-selected-card')
  assert.deepEqual(h.calls.find(call => call.method === 'turn/start').params.sandboxPolicy,
    { type: 'readOnly', networkAccess: false })
  await h.chat.handleServerRequest({ id: 'selected-click', method: 'item/tool/call', params: {
    threadId: first.conversationId, turnId: first.runId, callId: 'click-1', tool: 'egdesk_browser_click',
    arguments: { cardId: 'selected-card' } } })
  assert.equal(h.replies.at(-1)[1].success, true)
  assert.equal(f.actions.length, 1)
  await h.finish(first)
  const later = await h.chat.send({ message: 'Continue without selecting a Browser',
    clientThreadId: 'selected-chat', conversationId: first.conversationId })
  assert.equal(later.executionPolicy.mode, 'browserBounded')
  assert.equal(later.executionPolicy.browserEffects, 'observe-only-selected-card')
  assert.equal(h.chat.snapshot(later.conversationId).runs.at(-1).browserBinding, undefined)
  for (const tool of ['egdesk_browser_observe', 'egdesk_browser_click', 'egdesk_browser_fill', 'egdesk_browser_navigate']) {
    await h.chat.handleServerRequest({ id: `later-${tool}`, method: 'item/tool/call', params: {
      threadId: later.conversationId, turnId: later.runId, callId: `call-${tool}`, tool,
      arguments: { cardId: 'selected-card' } } })
    assert.equal(h.replies.at(-1)[2].code, -32601)
  }
  assert.equal(f.actions.length, 1)
})

test('an observe-only native catalog cannot silently gain click/fill through a later UI selection', async () => {
  const f = selectedBrowserTurnFixture(), h = qaHarness({ toolProviders: [f.provider] })
  const first = await h.chat.send({ message: 'Start an observe-only native catalog',
    clientThreadId: 'selected-chat', executionPolicy: { mode: 'browserBounded' } })
  assert.deepEqual(h.calls.find(call => call.method === 'thread/start').params.dynamicTools.map(spec => spec.name),
    ['egdesk_browser_observe'])
  await h.finish(first)
  const count = h.calls.filter(call => call.method === 'turn/start').length
  await assert.rejects(h.chat.send({ message: 'Try to add interaction later', clientThreadId: 'selected-chat',
    conversationId: first.conversationId, selectedSources: [f.source], browserTransportId: 'selected-ui' }),
  error => error.code === 'BROWSER_TOOLS_UNAVAILABLE' && /explicit new Chat/.test(error.message))
  assert.equal(h.calls.filter(call => call.method === 'turn/start').length, count)
  assert.equal(f.actions.length, 0)
})

test('guarded navigate, scroll, press and wait need the selected Card interaction grant; observe-only stays observe-only', async () => {
  const f = selectedBrowserTurnFixture(), h = qaHarness({ toolProviders: [f.provider] })
  const granted = await h.chat.send({ message: 'Scroll and search on this selected Card', clientThreadId: 'selected-chat',
    executionPolicy: { mode: 'browserBounded' }, selectedSources: [f.source], browserTransportId: 'selected-ui' })
  for (const tool of ['egdesk_browser_navigate', 'egdesk_browser_scroll', 'egdesk_browser_press', 'egdesk_browser_wait']) {
    await h.chat.handleServerRequest({ id: `granted-${tool}`, method: 'item/tool/call', params: {
      threadId: granted.conversationId, turnId: granted.runId, callId: `call-${tool}`, tool, arguments: { cardId: 'selected-card' } } })
    assert.equal(h.replies.at(-1)[0], `granted-${tool}`)
    assert.equal(h.replies.at(-1)[1].success, true)
  }
  assert.deepEqual(f.actions.map(action => action.tool), ['egdesk_browser_navigate', 'egdesk_browser_scroll', 'egdesk_browser_press', 'egdesk_browser_wait'])
  await h.finish(granted)

  const o = selectedBrowserTurnFixture(), observeOnly = qaHarness({ toolProviders: [o.provider] })
  const watched = await observeOnly.chat.send({ message: 'Only look at this Card', clientThreadId: 'selected-chat',
    executionPolicy: { mode: 'browserBounded' }, selectedSources: [{ ...o.source, browserToolPermission: 'observe' }], browserTransportId: 'selected-ui' })
  assert.deepEqual(observeOnly.calls.find(call => call.method === 'thread/start').params.dynamicTools.map(spec => spec.name), ['egdesk_browser_observe'])
  for (const tool of ['egdesk_browser_navigate', 'egdesk_browser_scroll', 'egdesk_browser_press', 'egdesk_browser_wait']) {
    await observeOnly.chat.handleServerRequest({ id: `observe-${tool}`, method: 'item/tool/call', params: {
      threadId: watched.conversationId, turnId: watched.runId, callId: `call-${tool}`, tool, arguments: { cardId: 'selected-card' } } })
    assert.equal(observeOnly.replies.at(-1)[2].code, -32601)
  }
  assert.equal(o.actions.length, 0)
})

test('older ordinary thread with a persisted Browser catalog keeps history but never grants a live actor', async () => {
  const browserCalls = []
  const browser = { providerId: 'egdesk-browser',
    specs: () => [{ type: 'function', name: 'egdesk_browser_observe', description: 'Legacy Browser tool', inputSchema: {} }],
    prepare: async () => { browserCalls.push('prepare'); throw new Error('ordinary Browser must not bind') },
    bindRun: async () => browserCalls.push('bind'), dispatch: async () => browserCalls.push('dispatch'),
    registerThread(threadId) { this.runtime.browserRegisteredThreads.add(threadId) },
  }
  const h = harness({ toolProviders: [browser] })
  const currentCatalog = h.chat.collectToolSpecs.bind(h.chat)
  h.chat.collectToolSpecs = (policy, options) => currentCatalog(policy, policy === null ? { forManifest: true } : options)
  const older = await h.chat.send({ message: 'Earlier ordinary Browser conversation' })
  assert.ok(h.calls.find(call => call.method === 'thread/start').params.dynamicTools.some(spec => spec.name === 'egdesk_browser_observe'))
  await h.finish(older)
  h.chat.collectToolSpecs = currentCatalog
  await h.chat.resume({ conversationId: older.conversationId })
  assert.equal(h.chat.threadToolManifestStatus.get(older.conversationId), 'verified')
  const continued = await h.chat.send({ message: 'Continue with immutable context only', conversationId: older.conversationId,
    selectedSources: [{ id: 'browser-source', kind: 'browser', browserToolPermission: 'observe' }] })
  assert.equal(continued.conversationId, older.conversationId)
  assert.deepEqual(browserCalls, [])
  await h.chat.handleServerRequest({ id: 'legacy-browser-call', method: 'item/tool/call', params: {
    threadId: continued.conversationId, turnId: continued.runId, callId: 'call-1', tool: 'egdesk_browser_observe', arguments: {},
  } })
  assert.equal(h.replies[0][2].code, -32601)
  assert.deepEqual(browserCalls, [])
})

test('QA Browser catalog and dispatch remain observe-only despite an interaction-capable provider', async () => {
  const browser = {
    providerId: 'egdesk-browser',
    specs: () => ['egdesk_browser_observe', 'egdesk_browser_click'].map(name => ({ type: 'function', name, description: name, inputSchema: {} })),
    dispatch: async () => ({ success: true, contentItems: [] }),
  }
  const h = qaHarness({ toolProviders: [browser] })
  const run = await h.chat.send({ message: 'Observe only', executionPolicy: { mode: 'readOnlyQa' } })
  assert.deepEqual(h.calls.find(call => call.method === 'thread/start').params.dynamicTools.map(spec => spec.name), ['egdesk_browser_observe'])
  await h.chat.handleServerRequest({ id: 'click', method: 'item/tool/call', params: { threadId: run.conversationId, turnId: run.runId, callId: 'call-click', tool: 'egdesk_browser_click', arguments: {} } })
  assert.equal(h.replies[0][2].code, -32601)
})

test('fixtureBrowserQa starts a new narrowed native catalog and never exposes navigate or output-publish tools', async () => {
  const contexts = { specs: () => ['egdesk_list_context', 'egdesk_read_source', 'egdesk_capture_output', 'egdesk_publish_briefing'].map(name => ({ type: 'function', name, description: name, inputSchema: {} })), prepare: async () => null }
  const browser = { providerId: 'egdesk-browser', specs: () => ['egdesk_browser_observe', 'egdesk_browser_navigate', 'egdesk_browser_click', 'egdesk_browser_fill'].map(name => ({ type: 'function', name, description: name, inputSchema: {} })),
    prepare: async body => body.selectedSources?.length ? { selected: true } : null,
    dispatch: async () => ({ success: true, contentItems: [{ type: 'inputText', text: 'fixture' }] }) }
  const h = qaHarness({ contexts, toolProviders: [browser] })
  const run = await h.chat.send({ message: 'Use only the owned local QA fixture', executionPolicy: { mode: 'fixtureBrowserQa' }, selectedSources: [{ id: 'source-1' }], clientThreadId: 'ui-fixture' })
  assert.deepEqual(h.calls.find(call => call.method === 'thread/start').params.dynamicTools.map(spec => spec.name), [
    'egdesk_list_context', 'egdesk_read_source', 'egdesk_browser_observe', 'egdesk_browser_click', 'egdesk_browser_fill',
  ])
  assert.equal(run.executionPolicy.browserEffects, 'attested-local-fixture-only')
  assert.deepEqual(h.calls.find(call => call.method === 'turn/start').params.sandboxPolicy, { type: 'readOnly', networkAccess: false })
  await h.chat.handleServerRequest({ id: 'forbidden-navigate', method: 'item/tool/call', params: { threadId: run.conversationId, turnId: run.runId, callId: 'call-nav', tool: 'egdesk_browser_navigate', arguments: {} } })
  assert.equal(h.replies[0][2].code, -32601)
})

test('fixtureBrowserQa cannot upgrade an ordinary native thread with a broader persisted tool catalog', async () => {
  const h = qaHarness()
  const ordinary = await h.chat.send({ message: 'ordinary' })
  await h.finish(ordinary)
  const before = h.calls.filter(call => call.method === 'turn/start').length
  await assert.rejects(h.chat.send({ message: 'fixture', conversationId: ordinary.conversationId, executionPolicy: { mode: 'fixtureBrowserQa' } }), error => error.code === 'FIXTURE_QA_NEW_CONVERSATION_REQUIRED')
  assert.equal(h.calls.filter(call => call.method === 'turn/start').length, before)
})

test('durable QA policy survives a fresh runtime and is reverified before its next provider turn', async () => {
  const dataDir = createPrivateQaTempDirectory('egdesk-qa-policy-store-')
  let store = null
  try {
    store = openChatStore({ dataDir, ownerScope: 'local-desktop-qa-test' })
    const calls = []
    let turn = 0
    const request = async (method, params) => {
      calls.push({ method, params })
      if (method === 'config/read') return { config: {}, layers: [{ name: { type: 'user' }, config: {} }] }
      if (method === 'mcpServerStatus/list') return { data: [], nextCursor: null }
      if (method === 'experimentalFeature/list') return qaFeatureList()
      if (method === 'thread/start') return { thread: { id: 'native-qa' }, sandbox: { type: 'readOnly', networkAccess: false }, approvalPolicy: 'never', model: 'configured-model' }
      if (method === 'thread/resume') return { thread: { id: 'native-qa', turns: [] }, sandbox: { type: 'readOnly', networkAccess: false }, approvalPolicy: 'never', model: 'configured-model' }
      if (method === 'turn/start') return { turn: { id: `turn-${++turn}`, status: 'inProgress', items: [] } }
      throw new Error(`Unexpected native call ${method}`)
    }
    const create = () => {
      const chat = new CodexChatRuntime({ store, requireStore: true, getOwnerKey: () => 'codex:chatgpt:qa-account', request, respond: () => {} })
      chat.setConnection(true)
      return chat
    }
    let chat = create()
    const first = await chat.send({ message: 'first', clientThreadId: 'local-qa', requestId: 'req-1', executionPolicy: { mode: 'readOnlyQa' } })
    assert.equal(first.executionPolicy.status, 'native-thread-verified')
    await chat.handleNotification({ method: 'turn/completed', params: { threadId: first.conversationId, turn: { id: first.runId, status: 'completed', items: [] } } })
    store.close()
    store = openChatStore({ dataDir, ownerScope: 'local-desktop-qa-test' })
    chat = create()
    const next = await chat.send({ message: 'continue', clientThreadId: 'local-qa', conversationId: 'native-qa', requestId: 'req-2' })
    assert.equal(next.executionPolicy.mode, 'readOnlyQa')
    assert.equal(calls.filter(call => call.method === 'thread/resume').length, 1)
    assert.equal(calls.filter(call => call.method === 'turn/start').at(-1).params.sandboxPolicy.type, 'readOnly')
  } finally {
    try { store?.close() } catch {}
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('durably owned active QA turn rehydrates its restrictive guard and declines native approval after restart', async () => {
  const dataDir = createPrivateQaTempDirectory('egdesk-active-qa-guard-')
  let store = null
  try {
    store = openChatStore({ dataDir, ownerScope: 'active-qa-test' })
    const request = async (method, params) => {
      if (method === 'config/read') return { config: {}, layers: [{ name: { type: 'user' }, config: {} }] }
      if (method === 'mcpServerStatus/list') return { data: [], nextCursor: null }
      if (method === 'experimentalFeature/list') return qaFeatureList()
      if (method === 'thread/start') return { thread: { id: 'native-active-qa' }, sandbox: { type: 'readOnly', networkAccess: false }, approvalPolicy: 'never' }
      if (method === 'turn/start') return { turn: { id: 'native-active-turn', status: 'inProgress', items: [] } }
      if (method === 'thread/resume') return { thread: { id: params.threadId, turns: [{ id: 'native-active-turn', status: 'inProgress', items: [] }] }, sandbox: { type: 'readOnly', networkAccess: false }, approvalPolicy: 'never' }
      throw new Error(`Unexpected native call ${method}`)
    }
    const make = replies => {
      const chat = new CodexChatRuntime({ store, requireStore: true, getOwnerKey: () => 'codex:chatgpt:qa-owner', request, respond: (...args) => replies.push(args) })
      chat.setConnection(true)
      return chat
    }
    let chat = make([])
    const started = await chat.send({ message: 'Read-only QA', clientThreadId: 'ui-active-qa', requestId: 'request-active-qa', executionPolicy: { mode: 'readOnlyQa' } })
    assert.equal(started.runId, 'native-active-turn')
    store.close()
    store = openChatStore({ dataDir, ownerScope: 'active-qa-test' })
    const replies = []
    chat = make(replies)
    chat.recoverInterruptedRuns()
    const resumed = await chat.resume({ clientThreadId: 'ui-active-qa', conversationId: 'native-active-qa' })
    assert.equal(resumed.runs[0].executionPolicy.status, 'recovered-active-guard')
    await chat.handleServerRequest({ id: 'approval-after-restart', method: 'item/commandExecution/requestApproval', params: { threadId: 'native-active-qa', turnId: 'native-active-turn', itemId: 'cmd', command: 'touch forbidden', availableDecisions: ['accept', 'decline'] } })
    assert.deepEqual(replies[0], ['approval-after-restart', { decision: 'decline' }])
    assert.deepEqual(chat.snapshot('native-active-qa').runs[0].pendingApprovals, [])
  } finally {
    try { store?.close() } catch {}
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('Browser registration survives a bridge restart, while pre-Browser native history is not silently replaced', async () => {
  const dataDir = createPrivateQaTempDirectory('egdesk-browser-registration-')
  let store = null
  try {
    store = openChatStore({ dataDir, ownerScope: 'browser-registration-test' })
    let turnCount = 0, threadCount = 0
    const calls = []
    const request = async (method, params) => {
      calls.push({ method, params })
      if (method === 'config/read') return { config: {}, layers: [{ name: { type: 'user' }, config: {} }] }
      if (method === 'mcpServerStatus/list') return { data: [], nextCursor: null }
      if (method === 'experimentalFeature/list') return qaFeatureList()
      if (method === 'thread/start') return { thread: { id: `native-${++threadCount}` }, cwd: '/public-fixture', sandbox: { type: 'readOnly', networkAccess: false }, approvalPolicy: 'never' }
      if (method === 'thread/resume') return { thread: { id: params.threadId, turns: [] }, cwd: '/public-fixture', sandbox: { type: 'readOnly', networkAccess: false }, approvalPolicy: 'never' }
      if (method === 'turn/start') return { turn: { id: `turn-${++turnCount}`, status: 'inProgress', items: [] } }
      throw new Error(`Unexpected native call: ${method}`)
    }
    const browser = () => ({
      providerId: 'egdesk-browser', specs: () => [{ type: 'function', name: 'egdesk_browser_observe', description: 'observe', inputSchema: {} }],
      prepare: async body => body.selectedSources?.length ? { cards: body.selectedSources } : null,
      requireThread(threadId, prepared) { if (prepared && !this.runtime.browserRegisteredThreads.has(threadId)) throw Object.assign(new Error('Older thread'), { code: 'BROWSER_TOOLS_UNAVAILABLE' }) },
      bindRun: async () => {}, registerThread(threadId) { this.runtime.browserRegisteredThreads.add(threadId) },
    })
    const create = withBrowser => {
      const chat = new CodexChatRuntime({ store, requireStore: true, getOwnerKey: () => 'codex:chatgpt:account-1', request, respond: () => {}, toolProviders: withBrowser ? [browser()] : [] })
      chat.setConnection(true)
      return chat
    }
    let chat = create(true)
    const first = await chat.send({ message: 'bounded first', clientThreadId: 'with-browser', requestId: 'request-1', executionPolicy: { mode: 'browserBounded' } })
    await chat.handleNotification({ method: 'turn/completed', params: { threadId: first.conversationId, turn: { id: first.runId, status: 'completed', items: [] } } })
    chat = create(false)
    const legacy = await chat.send({ message: 'older chat', clientThreadId: 'without-browser', requestId: 'request-2' })
    await chat.handleNotification({ method: 'turn/completed', params: { threadId: legacy.conversationId, turn: { id: legacy.runId, status: 'completed', items: [] } } })
    store.close()
    store = openChatStore({ dataDir, ownerScope: 'browser-registration-test' })
    chat = create(true)
    const later = await chat.send({ message: 'attach Card later', clientThreadId: 'with-browser', conversationId: first.conversationId, requestId: 'request-3', selectedSources: [{ cardId: 'card-1' }] })
    assert.equal(later.conversationId, first.conversationId)
    assert.equal(later.executionPolicy.mode, 'browserBounded')
    assert.equal(calls.filter(call => call.method === 'thread/start').length, 2)
    const turnsBefore = calls.filter(call => call.method === 'turn/start').length
    await assert.rejects(chat.send({ message: 'cannot attach silently', clientThreadId: 'without-browser', conversationId: legacy.conversationId, requestId: 'request-4', executionPolicy: { mode: 'browserBounded' }, selectedSources: [{ cardId: 'card-1' }] }), error => error.code === 'BROWSER_TOOLS_UNAVAILABLE')
    assert.equal(calls.filter(call => call.method === 'turn/start').length, turnsBefore)
    assert.equal(calls.filter(call => call.method === 'thread/start').length, 2)
  } finally {
    try { store?.close() } catch {}
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('restored native tool name cannot be reassigned to a different provider identity', async () => {
  const dataDir = createPrivateQaTempDirectory('egdesk-tool-owner-manifest-')
  let store = null
  try {
    store = openChatStore({ dataDir, ownerScope: 'tool-owner-test' })
    const calls = []
    const request = async (method, params) => {
      calls.push({ method, params })
      if (method === 'thread/start') return { thread: { id: 'native-owner-thread' } }
      if (method === 'turn/start') return { turn: { id: 'native-owner-turn', status: 'inProgress', items: [] } }
      if (method === 'thread/resume') return { thread: { id: params.threadId, turns: [{ id: 'native-owner-turn', status: 'completed', items: [] }] } }
      throw new Error(`Unexpected native call ${method}`)
    }
    const provider = providerId => ({ providerId, specs: () => [{ type: 'function', name: 'shared_native_name', description: 'shared', inputSchema: { type: 'object' } }], prepare: async body => body.selectedSources ? { selected: true } : null, dispatch: async () => { throw new Error('Remapped provider must not dispatch') } })
    const make = (providerId, replies) => {
      const chat = new CodexChatRuntime({ store, requireStore: true, getOwnerKey: () => 'codex:chatgpt:owner', request, respond: (...args) => replies.push(args), toolProviders: [provider(providerId)] })
      chat.setConnection(true)
      return chat
    }
    let chat = make('original-provider', [])
    const first = await chat.send({ message: 'First', clientThreadId: 'ui-owner', requestId: 'request-owner' })
    await chat.handleNotification({ method: 'turn/completed', params: { threadId: first.conversationId, turn: { id: first.runId, status: 'completed', items: [] } } })
    store.close()
    store = openChatStore({ dataDir, ownerScope: 'tool-owner-test' })
    const replies = []
    chat = make('replacement-provider', replies)
    await chat.resume({ clientThreadId: 'ui-owner', conversationId: first.conversationId })
    assert.equal(chat.threadToolManifestStatus.get(first.conversationId), 'mismatch')
    assert.equal(chat.threadToolOwners.get(first.conversationId).size, 0)
    await chat.handleServerRequest({ id: 'remapped-call', method: 'item/tool/call', params: { threadId: first.conversationId, turnId: first.runId, callId: 'call-1', tool: 'shared_native_name', arguments: {} } })
    assert.equal(replies[0][2].code, -32601)
    const before = calls.filter(call => call.method === 'turn/start').length
    await assert.rejects(chat.send({ message: 'Selected tool', clientThreadId: 'ui-owner', conversationId: first.conversationId, requestId: 'request-selected', selectedSources: [{ selected: true }] }), error => error.code === 'NATIVE_TOOL_MANIFEST_UNVERIFIED')
    assert.equal(calls.filter(call => call.method === 'turn/start').length, before)
  } finally {
    try { store?.close() } catch {}
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('legacy native thread without an original tool manifest cannot gain selected tool authority', async () => {
  const provider = { providerId: 'egdesk-selected', specs: () => [{ type: 'function', name: 'selected_tool', description: 'selected', inputSchema: {} }],
    prepare: async body => body.selectedSources?.length ? { selected: true } : null }
  const h = harness({ toolProviders: [provider], request: async (method, params) => {
    if (method === 'thread/resume') return { thread: { id: params.threadId, turns: [] } }
    throw new Error(`No provider turn expected: ${method}`)
  } })
  await assert.rejects(h.chat.send({ message: 'Use old tool', conversationId: 'legacy-thread', selectedSources: [{ selected: true }] }), error => error.code === 'NATIVE_TOOL_MANIFEST_UNVERIFIED')
  assert.deepEqual(h.calls.map(call => call.method), ['thread/resume'])
  assert.equal(h.chat.threadToolManifestStatus.get('legacy-thread'), 'legacy-unverified')
})

test('QA never offers approval and rejects a disallowed dynamic write tool', async () => {
  const h = qaHarness()
  const run = await h.chat.send({ message: 'qa', executionPolicy: { mode: 'readOnlyQa' } })
  await h.chat.handleServerRequest({ id: 7, method: 'item/commandExecution/requestApproval', params: { threadId: run.conversationId, turnId: run.runId, itemId: 'cmd', command: 'touch forbidden', availableDecisions: ['accept', 'decline'] } })
  assert.deepEqual(h.replies[0], [7, { decision: 'decline' }])
  assert.deepEqual(h.chat.snapshot(run.conversationId).runs[0].pendingApprovals, [])
  assert.ok(h.calls.some(call => call.method === 'turn/interrupt'))
  await h.chat.handleServerRequest({ id: 8, method: 'item/tool/call', params: { threadId: run.conversationId, turnId: run.runId, callId: 'call-1', tool: 'egdesk_capture_output', arguments: {} } })
  assert.equal(h.replies[1][2].code, -32601)
})

test('independent tool providers compose native specs, exact namespace dispatch and per-run cancellation', async () => {
  const lifecycle = []
  const browser = {
    specs: () => [{ type: 'namespace', name: 'egdesk_browser', description: 'bounded browser', tools: [{ type: 'function', name: 'observe', description: 'observe', inputSchema: { type: 'object' } }] }],
    prepare: async body => ({ cardId: body.cardId }),
    registerThread: async id => lifecycle.push(['registered', id]),
    bindRun: async (run, prepared) => lifecycle.push(['bound', run.runId, prepared.cardId]),
    dispatch(run, event) {
      lifecycle.push(['call', run.runId, event.namespace, event.tool, event.arguments.cardId])
      return { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify({ receipt: 'observed', cardId: event.arguments.cardId }) }] }
    },
    cancelRun: run => lifecycle.push(['cancel', run.runId]),
    disconnect: () => lifecycle.push(['disconnect']),
    reset: () => lifecycle.push(['reset']),
  }
  const contexts = { specs: () => [{ type: 'function', name: 'egdesk_list_context', description: 'list', inputSchema: { type: 'object' } }], prepare: async () => null, registerThread: async id => lifecycle.push(['context-registered', id]) }
  const h = harness({ contexts, toolProviders: [browser] })
  assert.equal(browser.runtime.respond, undefined)
  const run = await h.chat.send({ message: 'Observe the card', cardId: 'card-7' })
  assert.deepEqual(h.calls[0].params.dynamicTools.map(tool => tool.name), ['egdesk_list_context', 'egdesk_browser'])
  assert.ok(lifecycle.some(entry => entry[0] === 'bound' && entry[2] === 'card-7'))
  await h.chat.handleServerRequest({ id: 'tool-1', method: 'item/tool/call', params: { threadId: run.conversationId, turnId: run.runId, callId: 'call-1', namespace: 'egdesk_browser', tool: 'observe', arguments: { cardId: 'card-7' } } })
  assert.equal(JSON.parse(h.replies[0][1].contentItems[0].text).receipt, 'observed')
  await h.chat.handleServerRequest({ id: 'tool-2', method: 'item/tool/call', params: { threadId: run.conversationId, turnId: run.runId, callId: 'call-2', namespace: 'wrong', tool: 'observe', arguments: { cardId: 'card-7' } } })
  assert.equal(h.replies[1][2].code, -32601)
  await h.finish(run)
  assert.ok(lifecycle.some(entry => entry[0] === 'cancel' && entry[1] === run.runId))
  h.chat.setConnection(false)
  assert.ok(lifecycle.some(entry => entry[0] === 'disconnect'))
  h.chat.reset()
  assert.ok(lifecycle.some(entry => entry[0] === 'reset'))
})

test('provider name collisions reject before native thread/start rather than choosing a handler', async () => {
  const contexts = { specs: () => [{ type: 'function', name: 'same_name', description: 'context', inputSchema: {} }] }
  const duplicate = { specs: () => [{ type: 'function', name: 'same_name', description: 'browser', inputSchema: {} }] }
  const h = harness({ contexts, toolProviders: [duplicate] })
  await assert.rejects(h.chat.send({ message: 'Do not choose a duplicate provider' }), error => error.code === 'INVALID_TOOL_PROVIDER')
  assert.ok(!h.calls.some(call => call.method === 'thread/start' || call.method === 'turn/start'))
})

test('a provider may return a bounded native receipt; invalid output fails the tool call without inventing success', async () => {
  const provider = {
    specs: () => [{ type: 'function', name: 'egdesk_receipt', description: 'receipt', inputSchema: { type: 'object' } }],
    dispatch: async (run, event) => event.callId === 'good'
      ? { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify({ runId: run.runId, receipt: 'ok' }) }] }
      : { success: true, contentItems: [{ type: 'unknown', text: 'not native' }] },
  }
  const h = harness({ toolProviders: [provider] })
  const run = await h.chat.send({ message: 'Receipts' })
  for (const callId of ['good', 'bad']) await h.chat.handleServerRequest({ id: callId, method: 'item/tool/call', params: { threadId: run.conversationId, turnId: run.runId, callId, tool: 'egdesk_receipt', arguments: {} } })
  await h.chat.queue
  assert.equal(JSON.parse(h.replies[0][1].contentItems[0].text).receipt, 'ok')
  assert.equal(h.replies[1][1].success, false)
  assert.equal(h.chat.snapshot(run.conversationId).runs[0].error.code, 'TOOL_PROVIDER_FAILED')
})

test('unknown provider diagnostics never reach native response, UI events or retained history', async () => {
  const sentinel = 'RAW_PROVIDER_SENTINEL_7f41'
  const provider = {
    providerId: 'unknown-provider',
    specs: () => [{ type: 'function', name: 'egdesk_private_probe', description: 'probe', inputSchema: {} }],
    dispatch: async () => { throw Object.assign(new Error(sentinel), { code: `${sentinel}_CODE` }) },
  }
  const h = harness({ toolProviders: [provider] })
  const run = await h.chat.send({ message: 'Probe' })
  await h.chat.handleServerRequest({ id: 'tool-error', method: 'item/tool/call', params: { threadId: run.conversationId, turnId: run.runId, callId: 'call-1', tool: 'egdesk_private_probe', arguments: {} } })
  await h.chat.queue
  assert.equal(h.replies[0][1].success, false)
  assert.equal(JSON.parse(h.replies[0][1].contentItems[0].text).error.code, 'TOOL_PROVIDER_FAILED')
  assert.equal(JSON.stringify({ replies: h.replies, events: h.events, snapshot: h.chat.snapshot() }).includes(sentinel), false)
  const preparing = harness({ toolProviders: [{ providerId: 'unknown-provider', prepare: async () => { throw new Error(sentinel) } }] })
  await assert.rejects(preparing.chat.send({ message: 'Prepare' }), error => error.code === 'TOOL_PROVIDER_FAILED' && !error.message.includes(sentinel))
  assert.equal(JSON.stringify(preparing.events).includes(sentinel), false)
})

test('failed provider envelopes and legacy ContextRuntime self-responses cannot publish raw diagnostics', async () => {
  const sentinel = 'RAW_CONTEXT_SENTINEL_52ac'
  const provider = { specs: () => [{ type: 'function', name: 'egdesk_failed_envelope', description: 'failed', inputSchema: {} }],
    dispatch: async () => ({ success: false, contentItems: [{ type: 'inputText', text: JSON.stringify({ error: { code: sentinel, message: sentinel } }) }] }) }
  const h = harness({ toolProviders: [provider] })
  const run = await h.chat.send({ message: 'Provider failure' })
  await h.chat.handleServerRequest({ id: 'failed-envelope', method: 'item/tool/call', params: { threadId: run.conversationId, turnId: run.runId, callId: 'call-1', tool: 'egdesk_failed_envelope', arguments: {} } })
  assert.equal(h.replies[0][1].success, false)
  assert.equal(JSON.parse(h.replies[0][1].contentItems[0].text).error.code, 'TOOL_PROVIDER_FAILED')
  assert.equal(JSON.stringify({ replies: h.replies, events: h.events }).includes(sentinel), false)

  const contexts = {
    specs: () => [{ type: 'function', name: 'egdesk_read_source', description: 'read', inputSchema: {} }],
    dispatch(run, event) {
      this.runtime.respond(event.rpcId, { success: false, contentItems: [{ type: 'inputText', text: JSON.stringify({ error: { code: sentinel, message: sentinel } }) }] })
      this.runtime.emit(run, 'context.read.failed', { code: sentinel, message: sentinel, callId: event.callId }, event.callId)
    },
  }
  const c = harness({ contexts })
  const contextRun = await c.chat.send({ message: 'Context failure' })
  await c.chat.handleServerRequest({ id: 'context-failed', method: 'item/tool/call', params: { threadId: contextRun.conversationId, turnId: contextRun.runId, callId: 'call-2', tool: 'egdesk_read_source', arguments: {} } })
  assert.equal(c.replies[0][1].success, false)
  assert.equal(JSON.parse(c.replies[0][1].contentItems[0].text).error.code, 'TOOL_PROVIDER_FAILED')
  assert.equal(JSON.stringify({ replies: c.replies, events: c.events, snapshot: c.chat.snapshot() }).includes(sentinel), false)
})

test('late provider result after disconnect and epoch replacement cannot answer a newer native RPC', async () => {
  let release, entered
  const started = new Promise(resolve => { entered = resolve })
  const pending = new Promise(resolve => { release = resolve })
  const provider = {
    specs: () => [{ type: 'function', name: 'egdesk_slow_tool', description: 'slow', inputSchema: {} }],
    dispatch: async () => { entered(); return pending },
  }
  const h = harness({ toolProviders: [provider] })
  const run = await h.chat.send({ message: 'Slow tool' })
  await h.chat.handleServerRequest({ id: 17, method: 'item/tool/call', params: { threadId: run.conversationId, turnId: run.runId, callId: 'old-call', tool: 'egdesk_slow_tool', arguments: {} } })
  await started
  h.chat.setConnection(false)
  h.chat.setConnection(true)
  release({ success: true, contentItems: [{ type: 'inputText', text: 'STALE_PROVIDER_RESULT' }] })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(h.replies, [])
  assert.equal(JSON.stringify(h.events).includes('STALE_PROVIDER_RESULT'), false)
})

test('an early native tool request is failed and the exact turn interrupted when run binding fails', async () => {
  const provider = {
    specs: () => [{ type: 'function', name: 'egdesk_bound_tool', description: 'requires binding', inputSchema: { type: 'object' } }],
    prepare: async () => ({ selected: true }),
    bindRun: async () => { throw Object.assign(new Error('Selected Card epoch changed'), { code: 'BROWSER_BINDING_STALE' }) },
    cancelRun: () => {},
    dispatch: () => { throw new Error('Unbound tool must not dispatch') },
  }
  const h = harness({ toolProviders: [provider], request: async (method, params, chat, defaults) => {
    if (method === 'turn/start') {
      await chat.handleServerRequest({ id: 'early-tool', method: 'item/tool/call', params: { threadId: params.threadId, turnId: 'native-turn-1', callId: 'call-1', tool: 'egdesk_bound_tool', arguments: {} } })
      return { turn: { id: 'native-turn-1', status: 'inProgress', items: [] } }
    }
    return defaults(method, params)
  } })
  await assert.rejects(h.chat.send({ message: 'Observe Card' }), error => error.code === 'TOOL_PROVIDER_FAILED' && error.resumeRequired === true && !error.message.includes('Selected Card epoch changed'))
  assert.equal(h.replies[0][0], 'early-tool')
  assert.equal(h.replies[0][2].code, -32000)
  assert.deepEqual(h.calls.filter(call => call.method === 'turn/interrupt').map(call => call.params), [{ threadId: 'thread-1', turnId: 'native-turn-1' }])
  assert.equal(h.chat.snapshot('thread-1').runs[0].status, 'unknown')
})

test('an early native tool request waits for successful per-run provider binding', async () => {
  const order = []
  let release
  const binding = new Promise(resolve => { release = resolve })
  const provider = {
    specs: () => [{ type: 'function', name: 'egdesk_bound_tool', description: 'bounded', inputSchema: {} }],
    bindRun: async () => { order.push('bind-start'); await binding; order.push('bind-complete') },
    dispatch: async () => { order.push('dispatch'); return { success: true, contentItems: [{ type: 'inputText', text: 'bound' }] } },
  }
  const h = harness({ toolProviders: [provider], request: async (method, params, chat, defaults) => {
    if (method === 'turn/start') {
      await chat.handleServerRequest({ id: 'early-tool', method: 'item/tool/call', params: { threadId: params.threadId, turnId: 'native-turn-1', callId: 'call-1', tool: 'egdesk_bound_tool', arguments: {} } })
      return { turn: { id: 'native-turn-1', status: 'inProgress', items: [] } }
    }
    return defaults(method, params)
  } })
  const sending = h.chat.send({ message: 'Use bound tool' })
  for (let step = 0; step < 20 && !order.length; step++) await Promise.resolve()
  assert.deepEqual(order, ['bind-start'])
  assert.deepEqual(h.replies, [])
  release()
  await sending
  await h.chat.queue
  assert.deepEqual(order, ['bind-start', 'bind-complete', 'dispatch'])
  assert.equal(h.replies[0][1].contentItems[0].text, 'bound')
})

test('ordinary Codex does not inject a default profile, model, sandbox or approval override', async () => {
  const h = harness()
  const run = await h.chat.send({ message: 'Hello', requestId: 'request-1', clientThreadId: 'ui-1', systemPrompt: 'legacy persona', agentProfile: { id: 'legacy' }, toolMode: 'unsafe' })
  assert.deepEqual(h.calls[0], { method: 'thread/start', params: { config: { features: { default_mode_request_user_input: true } } } })
  assert.equal(h.calls[1].method, 'turn/start')
  assert.deepEqual(h.calls[1].params.input, [{ type: 'text', text: 'Hello', text_elements: [] }])
  assert.equal(h.calls[1].params.approvalPolicy, undefined)
  assert.equal(h.calls[1].params.model, undefined)
  assert.equal(run.answerId, `${run.conversationId}/${run.runId}`)
  assert.equal(h.chat.snapshot(run.conversationId).runs[0].clientThreadId, 'ui-1')
  assert.deepEqual(h.chat.snapshot(run.conversationId).runs[0].parentTurnConfiguration, { model: 'configured-model', effort: null, modelSource: 'native-thread', effortSource: 'native-thread' })
})

test('explicit profile and model/effort are opt-in native fields', async () => {
  const h = harness()
  await h.chat.send({ message: 'Hi', profileEnabled: true, systemPrompt: 'Be concise', model: 'user-selected', effort: 'max', cwd: '/workspace' })
  assert.equal(h.calls[0].params.developerInstructions, 'Be concise')
  assert.equal(h.calls[1].params.model, 'user-selected')
  assert.equal(h.calls[1].params.effort, 'max')
  assert.equal(h.calls[1].params.input[0].text, 'Hi')
})

test('accepted parent-turn Reader configuration preserves explicit overrides and native thread defaults', async () => {
  const bound = []
  const contexts = { prepare: async () => null, specs: () => [], requireThread: async () => {}, cancelRun: () => {}, bindRun: async (run, prepared, configuration) => bound.push({ runId: run.runId, configuration }) }
  const h = harness({ contexts, request: async (method, params, chat, defaults) => {
    const result = await defaults(method, params)
    return method === 'thread/start' ? { ...result, reasoningEffort: 'high' } : result
  } })
  const first = await h.chat.send({ message: 'First', requestId: 'parent-default' })
  assert.deepEqual(bound[0].configuration, { model: 'configured-model', effort: 'high', modelSource: 'native-thread', effortSource: 'native-thread' })
  assert.deepEqual(h.chat.snapshot(first.conversationId).runs[0].parentTurnConfiguration, bound[0].configuration)
  await h.finish(first)
  await h.chat.send({ message: 'Second', requestId: 'parent-sol-max', conversationId: first.conversationId, model: 'gpt-6-sol', effort: 'max' })
  assert.deepEqual(bound[1].configuration, { model: 'gpt-6-sol', effort: 'max', modelSource: 'turn-request', effortSource: 'turn-request' })
  assert.deepEqual(h.chat.snapshot(first.conversationId).runs.at(-1).parentTurnConfiguration, bound[1].configuration)
  assert.deepEqual({ model: h.calls.at(-1).params.model, effort: h.calls.at(-1).params.effort }, { model: 'gpt-6-sol', effort: 'max' })
})

test('native-reported turn settings take precedence over requested settings for Reader gating', async () => {
  const bound = []
  const contexts = { prepare: async () => null, specs: () => [], bindRun: async (run, prepared, configuration) => bound.push(configuration) }
  const h = harness({ contexts, request: async (method, params, chat, defaults) => {
    const result = await defaults(method, params)
    return method === 'turn/start' ? { ...result, model: 'reported-model', reasoningEffort: 'reported-effort' } : result
  } })
  await h.chat.send({ message: 'Check', model: 'gpt-6-sol', effort: 'max' })
  assert.deepEqual(bound[0], { model: 'reported-model', effort: 'reported-effort', modelSource: 'native-turn', effortSource: 'native-turn' })
})

test('process-scoped config rejects a contrary native thread before any parent model turn', async () => {
  for (const reported of [{ model: 'gpt-6-astra', reasoningEffort: 'max' }, { model: 'gpt-6-sol', reasoningEffort: 'high' }]) {
    const h = harness({ expectedProcessConfiguration: { model: 'gpt-6-sol', effort: 'max' }, request: async (method, params, chat, defaults) => {
      const result = await defaults(method, params)
      return method === 'thread/start' ? { ...result, ...reported } : result
    } })
    await assert.rejects(h.chat.send({ message: 'Ordinary UI turn' }), e => e.code === 'NATIVE_CONFIGURATION_MISMATCH')
    assert.equal(h.calls.filter(call => call.method === 'turn/start').length, 0)
  }
  const matching = harness({ expectedProcessConfiguration: { model: 'gpt-6-sol', effort: 'max' }, request: async (method, params, chat, defaults) => {
    const result = await defaults(method, params)
    return method === 'thread/start' ? { ...result, model: 'gpt-6-sol', reasoningEffort: 'max' } : result
  } })
  const accepted = await matching.chat.send({ message: 'Ordinary UI turn' })
  assert.equal(matching.calls.find(call => call.method === 'thread/start').params.model, undefined)
  assert.equal(matching.calls.find(call => call.method === 'turn/start').params.effort, undefined)
  assert.deepEqual(matching.chat.snapshot(accepted.conversationId).runs[0].parentTurnConfiguration, { model: 'gpt-6-sol', effort: 'max', modelSource: 'native-thread', effortSource: 'native-thread' })
})

test('events received before turn/start response bind only to its actual turn and request', async () => {
  const h = harness({ request: async (method, params, chat, defaults) => {
    if (method !== 'turn/start') return defaults(method, params)
    await chat.handleNotification({ method: 'turn/started', params: { threadId: params.threadId, turn: { id: 'early-turn', status: 'inProgress', items: [] } } })
    await chat.handleNotification({ method: 'item/agentMessage/delta', params: { threadId: params.threadId, turnId: 'early-turn', itemId: 'message-early', delta: 'Hello ' } })
    return { turn: { id: 'early-turn', status: 'inProgress', items: [] } }
  } })
  const run = await h.chat.send({ message: 'Hi', requestId: 'req-early', clientThreadId: 'ui-early' })
  const delta = h.events.find(event => event.event === 'message.delta')
  assert.equal(delta.requestId, 'req-early')
  assert.equal(delta.clientThreadId, 'ui-early')
  assert.equal(delta.runId, run.runId)
  assert.equal(delta.details.messageId, 'message-early')
  assert.equal(delta.details.delta, 'Hello ')
})

test('simultaneous conversations and SSE never use the currently selected UI thread as fallback', async () => {
  const h = harness()
  const a = await h.chat.send({ message: 'a', requestId: 'a', clientThreadId: 'ui-a' })
  const b = await h.chat.send({ message: 'b', requestId: 'b', clientThreadId: 'ui-b' })
  await h.item(a, { id: 'a-message', type: 'agentMessage', text: 'A' })
  await h.item(b, { id: 'b-message', type: 'agentMessage', text: 'B' })
  assert.equal(h.events.find(e => e.itemId === 'a-message').clientThreadId, 'ui-a')
  assert.equal(h.events.find(e => e.itemId === 'b-message').clientThreadId, 'ui-b')
  await h.notify('item/agentMessage/delta', { threadId: 'foreign', turnId: 'foreign', itemId: 'x', delta: 'FOREIGN' })
  assert.ok(!JSON.stringify(h.chat.snapshot()).includes('FOREIGN'))
})

test('duplicate request is idempotent within this bridge, while conflicting reuse is rejected', async () => {
  const h = harness()
  const body = { message: 'Hi', requestId: 'same', clientThreadId: 'ui' }
  const [a, b] = await Promise.all([h.chat.send(body), h.chat.send(body)])
  assert.deepEqual(a, b)
  assert.equal(h.calls.filter(c => c.method === 'turn/start').length, 1)
  await assert.rejects(h.chat.send({ ...body, message: 'Different' }), e => e.code === 'REQUEST_CONFLICT')
  await assert.rejects(h.chat.send({ message: 'Another', conversationId: a.conversationId }), e => e.code === 'RUN_IN_PROGRESS')
})

test('failed resume never falls back to a new unrelated thread', async () => {
  const h = harness({ request: async method => { assert.equal(method, 'thread/resume'); throw new Error('Historical thread not found') } })
  await assert.rejects(h.chat.send({ message: 'Continue', conversationId: 'old-thread' }), /Historical thread not found/)
  assert.deepEqual(h.calls.map(c => c.method), ['thread/resume'])
  assert.equal(h.chat.snapshot().runs.length, 0)
})

test('completed messages are not turn completion; direct answers need no artifact', async () => {
  const h = harness()
  const run = await h.chat.send({ message: 'Hi' })
  await h.item(run, { type: 'agentMessage', id: 'one', text: 'Hello.', phase: 'commentary' })
  assert.equal(h.chat.snapshot().runs[0].status, 'inProgress')
  assert.ok(!h.legacy.some(e => e.type === 'assistant-complete'))
  await h.item(run, { type: 'agentMessage', id: 'two', text: 'The answer is 42.', phase: 'final_answer' })
  await h.finish(run)
  assert.equal(h.legacy.filter(e => e.type === 'assistant-complete').length, 1)
  assert.equal(h.chat.snapshot().runs[0].status, 'completed')
  assert.deepEqual(h.chat.snapshot().runs[0].artifacts, [])
})

test('stop acceptance remains in progress until actual interrupted confirmation', async () => {
  const h = harness()
  const run = await h.chat.send({ message: 'Work' })
  const result = await h.chat.interrupt(run)
  assert.equal(result.stopRequested, true)
  assert.equal(h.chat.snapshot().runs[0].status, 'inProgress')
  assert.equal(h.chat.snapshot().runs[0].stopConfirmed, false)
  await h.finish(run, 'interrupted')
  assert.equal(h.chat.snapshot().runs[0].stopConfirmed, true)
  assert.ok(!h.legacy.some(e => e.type === 'assistant-complete'))
})

test('normal completion racing with interrupt remains completed, not interrupted', async () => {
  const h = harness({ request: async (method, params, chat, defaults) => {
    if (method === 'turn/interrupt') {
      await chat.handleNotification({ method: 'turn/completed', params: { threadId: params.threadId, turn: { id: params.turnId, status: 'completed', items: [] } } })
      return {}
    }
    return defaults(method, params)
  } })
  const run = await h.chat.send({ message: 'Work' })
  await h.chat.interrupt(run)
  assert.equal(h.chat.snapshot().runs[0].status, 'completed')
  assert.equal(h.chat.snapshot().runs[0].stopConfirmed, false)
})

test('process loss is explicit offline/failed and never stop success', async () => {
  const h = harness()
  const run = await h.chat.send({ message: 'Work' })
  await h.chat.interrupt(run)
  h.chat.setConnection(false, { processLost: true })
  const state = h.chat.snapshot()
  assert.equal(state.connection, 'offline')
  assert.equal(state.runs[0].status, 'failed')
  assert.equal(state.runs[0].error.code, 'RUNTIME_LOST')
  assert.equal(state.runs[0].stopConfirmed, false)
  assert.ok(!h.legacy.some(e => e.type === 'assistant-complete'))
})

test('approvals require exact pending thread/run and explicit supported choice', async () => {
  const h = harness()
  const run = await h.chat.send({ message: 'Work' })
  await h.chat.handleServerRequest({ id: 7, method: 'item/commandExecution/requestApproval', params: { threadId: run.conversationId, turnId: run.runId, itemId: 'cmd', command: 'echo ok', availableDecisions: ['accept', 'acceptForSession', 'decline', 'cancel'] } })
  const pending = h.chat.snapshot().runs[0].pendingApprovals[0]
  assert.deepEqual(pending.choices, ['accept', 'decline', 'cancel'])
  assert.equal(h.replies.length, 0)
  await assert.rejects(h.chat.replyApproval({ ...run, runId: 'wrong', approvalId: pending.approvalId, decision: 'accept' }), e => e.code === 'STALE_APPROVAL')
  await assert.rejects(h.chat.replyApproval({ ...run, approvalId: pending.approvalId, decision: 'acceptForSession' }), e => e.code === 'INVALID_DECISION')
  const result = await h.chat.replyApproval({ ...run, approvalId: pending.approvalId, decision: 'decline' })
  assert.equal(result.status, 'replySent')
  assert.deepEqual(h.replies[0], [7, { decision: 'decline' }])
  assert.equal(h.chat.snapshot().runs[0].pendingApprovals[0].status, 'replySent')
  await assert.rejects(h.chat.replyApproval({ ...run, approvalId: pending.approvalId, decision: 'accept' }), e => e.code === 'STALE_APPROVAL')
  await h.notify('serverRequest/resolved', { threadId: run.conversationId, requestId: 7 })
  assert.deepEqual(h.chat.snapshot().runs[0].pendingApprovals, [])
})

for (const kind of ['commandExecution', 'fileChange']) {
  test(`accepted ${kind} approval resolves into same-turn activity, not a new or prematurely completed run`, async () => {
    const h = harness()
    const run = await h.chat.send({ message: 'Continue the approved work',
      requestId: 'approval-positive-request', clientThreadId: 'approval-positive-ui' })
    const identity = value => ({ conversationId: value.conversationId, runId: value.runId, answerId: value.answerId })
    const expectedIdentity = identity(run)
    const callsBeforeApproval = h.calls.length
    assert.deepEqual(h.calls.map(call => call.method), ['thread/start', 'turn/start'])
    const current = () => {
      const runs = h.chat.snapshot().runs
      assert.equal(runs.length, 1, 'approval continuation must not create another run')
      assert.deepEqual(identity(runs[0]), expectedIdentity)
      return runs[0]
    }
    const assertStillRunning = () => {
      assert.equal(current().status, 'inProgress')
      assert.equal(h.events.filter(event => event.event === 'run.completed').length, 0)
      assert.equal(h.legacy.filter(event => event.type === 'assistant-complete').length, 0)
    }
    const rpcId = `approval-positive-${kind}`
    await h.chat.handleServerRequest({ id: rpcId, method: `item/${kind}/requestApproval`, params: {
      threadId: run.conversationId, turnId: run.runId, itemId: 'approved-item',
      ...(kind === 'commandExecution' ? { command: 'echo approved', availableDecisions: ['accept', 'decline'] } : {}),
    } })
    const approvalId = current().pendingApprovals[0].approvalId
    const reply = { ...run, approvalId, decision: 'accept' }
    const result = await h.chat.replyApproval(reply)
    assert.equal(result.status, 'replySent')
    assert.deepEqual(h.replies, [[rpcId, { decision: 'accept' }]], 'exactly one native allow response')
    assert.equal(current().pendingApprovals[0].status, 'replySent')
    assertStillRunning() // Sending permission is neither execution nor completion.

    await h.notify('serverRequest/resolved', { threadId: run.conversationId, requestId: rpcId })
    assert.deepEqual(current().pendingApprovals, [])
    assert.equal(h.events.filter(event => event.event === 'approval.resolved').length, 1)
    assertStillRunning() // Resolution also does not stand in for turn/completed.
    await assert.rejects(h.chat.replyApproval(reply), error => error.code === 'STALE_APPROVAL')

    const item = { id: 'approved-item', type: kind, status: 'inProgress',
      ...(kind === 'commandExecution' ? { command: 'echo approved' }
        : { changes: [{ path: 'approved.txt', kind: { type: 'update' }, diff: 'fixture only' }] }) }
    await h.item(run, item, false)
    assert.equal(current().activities.find(activity => activity.id === item.id).status, 'inProgress')
    assertStillRunning()
    await h.item(run, { ...item, status: 'completed', ...(kind === 'commandExecution' ? { exitCode: 0 } : {}) })
    assert.equal(current().activities.find(activity => activity.id === item.id).status, 'completed')
    assertStillRunning() // Even completed activity is not the terminal turn event.

    await h.finish(run)
    assert.equal(current().status, 'completed')
    const lifecycle = h.events.filter(event => ['approval.required', 'approval.resolved',
      'activity.started', 'activity.completed', 'run.completed'].includes(event.event))
    assert.deepEqual(lifecycle.map(event => event.event), ['approval.required', 'approval.resolved',
      'activity.started', 'activity.completed', 'run.completed'])
    for (const event of lifecycle) assert.deepEqual(identity(event), expectedIdentity)
    assert.equal(h.legacy.filter(event => event.type === 'assistant-complete').length, 1)
    await assert.rejects(h.chat.replyApproval(reply), error => error.code === 'STALE_APPROVAL')
    assert.deepEqual(h.replies, [[rpcId, { decision: 'accept' }]], 'late duplicates never send another allow')
    assert.deepEqual(h.calls.slice(callsBeforeApproval), [],
      'approval/resolution/activity/terminal must add zero thread/start or turn/start requests')
  })
}

test('unsupported interactive requests are explicitly rejected without granting permission', async () => {
  const h = harness()
  const run = await h.chat.send({ message: 'Work' })
  await h.chat.handleServerRequest({ id: 'new-type', method: 'item/permissions/requestApproval', params: { threadId: run.conversationId, turnId: run.runId } })
  assert.equal(h.replies[0][1], null)
  assert.equal(h.replies[0][2].code, -32601)
  assert.equal(h.chat.snapshot().runs[0].error.code, 'UNSUPPORTED_INTERACTION')
})

test('live state and events exclude raw reasoning, tool payloads and credential values', async () => {
  const h = harness()
  const run = await h.chat.send({ message: 'Hi' })
  await h.item(run, { type: 'reasoning', id: 'reason', content: ['RAW_CHAIN_SENTINEL'], summary: ['Public summary'] })
  await h.notify('item/reasoning/textDelta', { threadId: run.conversationId, turnId: run.runId, itemId: 'reason', delta: 'RAW_DELTA_SENTINEL' })
  await h.item(run, { type: 'mcpToolCall', id: 'tool', server: 'drive', tool: 'read', status: 'completed', arguments: { secret: 'TOOL_ARGUMENT_SENTINEL' }, result: { content: ['TOOL_OUTPUT_SENTINEL'] } })
  await h.item(run, { type: 'commandExecution', id: 'cmd', command: 'TOKEN=abc PASSWORD=supersecret echo ok', aggregatedOutput: 'SHELL_OUTPUT_SENTINEL', status: 'completed', exitCode: 0 })
  const exposed = JSON.stringify([h.events, h.chat.snapshot()])
  for (const hidden of ['RAW_CHAIN_SENTINEL', 'RAW_DELTA_SENTINEL', 'TOOL_ARGUMENT_SENTINEL', 'TOOL_OUTPUT_SENTINEL', 'SHELL_OUTPUT_SENTINEL', 'supersecret']) assert.ok(!exposed.includes(hidden), hidden)
  assert.ok(exposed.includes('Public summary'))
  assert.equal(h.chat.snapshot().runs[0].activities.find(a => a.id === 'cmd').detail.exitCode, 0)
})

test('split credentials in streamed agent text do not leak as deltas', async () => {
  const h = harness()
  const run = await h.chat.send({ message: 'Hi' })
  for (const delta of ['Hello sk-', 'testSECRET', 'VALUE ', 'world']) await h.notify('item/agentMessage/delta', { threadId: run.conversationId, turnId: run.runId, itemId: 'msg', delta })
  await h.item(run, { id: 'msg', type: 'agentMessage', text: 'Hello sk-testSECRETVALUE world' })
  const wire = JSON.stringify([h.events, h.legacy, h.chat.snapshot()])
  assert.ok(!wire.includes('testSECRET'))
  assert.equal(h.chat.snapshot().runs[0].messages[0].text, 'Hello [REDACTED] world')
})

test('resumed historical items use the same sanitizer and preserve native turn status', async () => {
  const h = harness({ request: async () => ({ thread: { id: 'old', turns: [{ id: 'old-turn', status: 'interrupted', items: [
    { id: 'reason', type: 'reasoning', summary: ['Summary'], content: ['HISTORY_RAW_CHAIN'] },
    { id: 'agent', type: 'agentMessage', text: 'api_key=SECRET_CREDENTIAL' },
    { id: 'file', type: 'fileChange', status: 'completed', changes: [{ path: '/work/a.txt', kind: { type: 'update' }, diff: 'RAW_SECRET_DIFF' }] },
  ] }] }, turnsBackwardsCursor: 'more' }) })
  const state = await h.chat.resume({ conversationId: 'old', clientThreadId: 'restored-ui' })
  const json = JSON.stringify(state)
  for (const value of ['HISTORY_RAW_CHAIN', 'SECRET_CREDENTIAL', 'RAW_SECRET_DIFF']) assert.ok(!json.includes(value))
  assert.equal(state.runs[0].status, 'interrupted')
  assert.equal(state.runs[0].clientThreadId, 'restored-ui')
  assert.equal(state.historyComplete, false)
  assert.equal(h.events.length, 0)
})

test('existing explicit artifact references are bound to the same Answer/run, never claimed as writes', async () => {
  const verified = []
  const h = harness({ verifyFile: async (file, options) => { verified.push({ file, options }); return file === '/work/result.pdf' ? file : null } })
  const run = await h.chat.send({ message: 'Explain' })
  await h.item(run, { id: 'answer', type: 'agentMessage', text: 'See [result](/work/result.pdf). [missing](/work/no.pdf) [web](https://example.com/result.pdf). I created /work/fiction.pdf.' })
  const artifact = h.chat.snapshot().runs[0].artifacts[0]
  assert.equal(artifact.answerId, run.answerId)
  assert.equal(artifact.runId, run.runId)
  assert.equal(artifact.sourceItemId, 'answer')
  assert.equal(artifact.relation, 'referenced')
  assert.deepEqual(artifact.target, { path: '/work/result.pdf' })
  assert.equal(h.chat.snapshot().runs[0].artifacts.length, 1)
  assert.ok(verified.every(call => call.options.artifact === true))
  assert.ok(!verified.some(call => /https|fiction/.test(call.file)))
  await h.item(run, { id: 'answer', type: 'agentMessage', text: '[again](/work/result.pdf)' })
  assert.equal(h.chat.snapshot().runs[0].artifacts[0].id, artifact.id)
})

test('file-change events are activities, not automatic deliverable cards', async () => {
  const h = harness({ verifyFile: async file => file })
  const run = await h.chat.send({ message: 'Work' })
  await h.item(run, { id: 'file', type: 'fileChange', status: 'completed', changes: [{ path: 'src/main.mjs', kind: { type: 'update' }, diff: 'do not expose' }] })
  assert.equal(h.chat.snapshot().runs[0].activities[0].sourceRefs[0].target.path, path.resolve('/work/src/main.mjs'))
  assert.deepEqual(h.chat.snapshot().runs[0].artifacts, [])
})

test('artifact path verification rejects URLs, scripts, executable files, secrets and unsafe symlink targets', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'egdesk-artifact-test-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const report = path.join(directory, 'report.txt')
  const script = path.join(directory, 'run.sh')
  // Windows executable identity is extension-based; POSIX also checks mode bits.
  const executable = path.join(directory, process.platform === 'win32' ? 'executable.exe' : 'executable.txt')
  const secret = path.join(directory, '.env')
  let alias = path.join(directory, 'alias.txt')
  await Promise.all([writeFile(report, 'report'), writeFile(script, 'echo secret'), writeFile(executable, 'data'), writeFile(secret, 'secret')])
  if (process.platform !== 'win32') await chmod(executable, 0o755)
  try {
    await symlink(script, alias)
  } catch (error) {
    if (process.platform !== 'win32' || error.code !== 'EPERM') throw error
    // Directory junctions do not require Developer Mode. A safe-looking path
    // resolving into a protected directory must still fail canonical validation.
    const sensitive = path.join(directory, '.ssh')
    const junction = path.join(directory, 'linked-source')
    await mkdir(sensitive)
    await writeFile(path.join(sensitive, 'notes.txt'), 'private fixture')
    await symlink(sensitive, junction, 'junction')
    alias = path.join(junction, 'notes.txt')
    t.diagnostic('File symlink privilege unavailable; unsafe target checked through a Windows junction')
  }
  assert.equal(await verifyLocalFile(report, { artifact: true }), await realpath(report))
  for (const file of [script, executable, secret, alias, 'https://example.com/a.txt', 'file:///tmp/a.txt', '//host/a.txt', 'relative.txt', directory]) assert.equal(await verifyLocalFile(file, { artifact: true }), null, file)
  assert.deepEqual(explicitFileLinks('plain /tmp/a.txt [label] [url](file:///tmp/a.txt)'), [])
})

test('public text redacts credential assignments and private keys', () => {
  const redacted = publicText('Authorization: Bearer secret-token\nOPENAI_API_KEY="hidden-value"\n-----BEGIN PRIVATE KEY-----\nxyz\n-----END PRIVATE KEY-----')
  for (const secret of ['secret-token', 'hidden-value', 'xyz']) assert.ok(!redacted.includes(secret))
})

test('unowned resumed history never gains an approval callback merely from a native event', async () => {
  const h = harness({ request: async (method, params, chat) => {
    assert.equal(method, 'thread/resume')
    await chat.handleServerRequest({ id: 'resume-approval', method: 'item/fileChange/requestApproval', params: { threadId: params.threadId, turnId: 'live-turn', itemId: 'edit', reason: 'Edit file' } })
    return { thread: { id: params.threadId, turns: [{ id: 'live-turn', status: 'inProgress', items: [] }] } }
  } })
  const state = await h.chat.resume({ conversationId: 'resume-thread', clientThreadId: 'resume-ui' })
  assert.equal(state.runs[0].pendingApprovals.length, 0)
  assert.equal(h.replies[0][2].code, -32601)
  assert.equal(h.events.some(event => event.event === 'approval.required'), false)
})

test('early events for a different native turn never inherit the pending request ID', async () => {
  const h = harness({ request: async (method, params, chat, defaults) => {
    if (method !== 'turn/start') return defaults(method, params)
    await chat.handleNotification({ method: 'item/agentMessage/delta', params: { threadId: params.threadId, turnId: 'other-turn', itemId: 'other-message', delta: 'Other turn ' } })
    return { turn: { id: 'requested-turn', status: 'inProgress', items: [] } }
  } })
  await h.chat.send({ message: 'Requested', requestId: 'requested-id', clientThreadId: 'ui' })
  const other = h.events.find(e => e.itemId === 'other-message')
  assert.equal(other, undefined)
  assert.equal(h.chat.snapshot().runs.length, 1)
})

test('foreign turn/completed and tool calls on an owned thread cannot create or finish an EG-Desk run', async () => {
  const h = harness()
  const own = await h.chat.send({ message: 'Owned turn', requestId: 'request-owned', clientThreadId: 'ui-owned' })
  await h.notify('turn/completed', { threadId: own.conversationId, turn: { id: 'foreign-turn', status: 'completed', items: [{ id: 'foreign-answer', type: 'agentMessage', text: 'foreign' }] } })
  await h.chat.handleServerRequest({ id: 'foreign-call', method: 'item/tool/call', params: { threadId: own.conversationId, turnId: 'foreign-turn', callId: 'foreign-call-1', tool: 'egdesk_browser_click', arguments: {} } })
  const state = h.chat.snapshot(own.conversationId)
  assert.equal(state.runs.length, 1)
  assert.equal(state.runs[0].runId, own.runId)
  assert.equal(state.runs[0].status, 'inProgress')
  assert.equal(JSON.stringify({ state, events: h.events }).includes('foreign-answer'), false)
  assert.equal(h.replies[0][2].code, -32601)
})

test('late dynamic call on a completed owned Run gets an immediate RPC error and no pending callback', async () => {
  let dispatched = 0
  const provider = { specs: () => [{ type: 'function', name: 'egdesk_late_tool', description: 'late', inputSchema: {} }], dispatch: async () => { dispatched++; return { success: true, contentItems: [] } } }
  const h = harness({ toolProviders: [provider] })
  const run = await h.chat.send({ message: 'Finish first' })
  await h.finish(run)
  await h.chat.handleServerRequest({ id: 'late-rpc', method: 'item/tool/call', params: { threadId: run.conversationId, turnId: run.runId, callId: 'late-call', tool: 'egdesk_late_tool', arguments: {} } })
  assert.equal(h.replies[0][0], 'late-rpc')
  assert.equal(h.replies[0][2].code, -32601)
  assert.equal(h.chat.dynamicRequestProviders.size, 0)
  assert.equal(dispatched, 0)
})

test('pending approval IDs become stale after disconnect and are never replay-approved', async () => {
  const h = harness()
  const run = await h.chat.send({ message: 'Work' })
  await h.chat.handleServerRequest({ id: 8, method: 'item/fileChange/requestApproval', params: { threadId: run.conversationId, turnId: run.runId, itemId: 'edit' } })
  const approvalId = h.chat.snapshot().runs[0].pendingApprovals[0].approvalId
  h.chat.setConnection(false)
  h.chat.setConnection(true)
  await h.chat.handleServerRequest({ id: 8, method: 'item/fileChange/requestApproval', params: { threadId: run.conversationId, turnId: run.runId, itemId: 'edit' } })
  assert.notEqual(h.chat.snapshot().runs[0].pendingApprovals[0].approvalId, approvalId)
  await assert.rejects(h.chat.replyApproval({ ...run, approvalId, decision: 'accept' }), e => e.code === 'STALE_APPROVAL')
  assert.equal(h.replies.length, 0)
  assert.equal(h.chat.snapshot().runs[0].status, 'unknown')
})

test('public summary deltas retain partial credentials until redaction and plans survive polling', async () => {
  const h = harness()
  const run = await h.chat.send({ message: 'Work' })
  for (const delta of ['Summary sk-', 'SECRET', 'TAIL ']) await h.notify('item/reasoning/summaryTextDelta', { threadId: run.conversationId, turnId: run.runId, itemId: 'summary', delta })
  await h.notify('turn/plan/updated', { threadId: run.conversationId, turnId: run.runId, explanation: 'Public plan', plan: [{ step: 'Inspect', status: 'inProgress' }] })
  assert.ok(!JSON.stringify([h.events, h.chat.snapshot()]).includes('SECRET'))
  assert.equal(h.chat.snapshot().runs[0].activities.find(a => a.kind === 'plan').detail.plan[0].step, 'Inspect')
})

test('runtime snapshots stay bounded and explicitly report omitted items', async () => {
  const h = harness()
  const run = await h.chat.send({ message: 'Work' })
  for (let i = 0; i < 110; i++) await h.item(run, { type: 'agentMessage', id: `message-${i}`, text: `Message ${i}` })
  const state = h.chat.snapshot()
  assert.equal(state.runs[0].messages.length, 100)
  assert.equal(state.truncated, true)
  assert.equal(state.historyComplete, false)
})

test('file approval shows proposed new paths without presenting them as existing artifacts', async () => {
  const h = harness()
  const run = await h.chat.send({ message: 'Create report' })
  await h.item(run, { id: 'new-file', type: 'fileChange', status: 'inProgress', changes: [{ path: 'new-report.md', kind: { type: 'add' }, diff: 'private diff' }] }, false)
  await h.chat.handleServerRequest({ id: 'file-approval', method: 'item/fileChange/requestApproval', params: { threadId: run.conversationId, turnId: run.runId, itemId: 'new-file' } })
  const state = h.chat.snapshot().runs[0]
  assert.deepEqual(state.pendingApprovals[0].paths, [path.resolve('/work/new-report.md')])
  assert.deepEqual(state.activities[0].sourceRefs, [])
  assert.deepEqual(state.artifacts, [])
})

test('terminal interruption keeps received text when no item completion is delivered', async () => {
  const h = harness()
  const run = await h.chat.send({ message: 'Work' })
  await h.notify('item/agentMessage/delta', { threadId: run.conversationId, turnId: run.runId, itemId: 'partial', delta: 'Partially finished' })
  await h.finish(run, 'interrupted')
  assert.equal(h.chat.snapshot().runs[0].messages[0].text, 'Partially finished')
  assert.equal(h.chat.snapshot().runs[0].status, 'interrupted')
  assert.equal(h.legacy.some(e => e.type === 'assistant-complete'), false)
})

test('metadata-only completion is not truncation when item events already delivered the two-message turn', async () => {
  const h = harness()
  const run = await h.chat.send({ message: 'Reply exactly EGDESK_BRIDGE_OK.', requestId: 'ui-request', clientThreadId: 'ui-thread' })
  await h.item(run, { type: 'userMessage', id: 'native-user-id', clientId: 'ui-request', content: [{ type: 'text', text: 'Reply exactly EGDESK_BRIDGE_OK.' }] })
  await h.item(run, { type: 'agentMessage', id: 'native-agent-id', phase: 'final_answer', text: 'EGDESK_BRIDGE_OK' })
  await h.notify('turn/completed', { threadId: run.conversationId, turn: { id: run.runId, status: 'completed', items: [], itemsView: 'notLoaded' } })
  const state = h.chat.snapshot(run.conversationId)
  assert.equal(state.truncated, false)
  assert.equal(state.historyComplete, true)
  assert.equal(state.runs[0].truncated, false)
  assert.deepEqual(state.runs[0].messages.map(({ messageId, role, clientId }) => ({ messageId, role, clientId })), [
    { messageId: 'native-user-id', role: 'user', clientId: 'ui-request' },
    { messageId: 'native-agent-id', role: 'assistant', clientId: null },
  ])
  assert.equal(state.runs[0].requestId, 'ui-request')
})

test('late authoritative item completion is retained after terminal turn metadata without another turn', async () => {
  const h = harness()
  const run = await h.chat.send({ message: 'Answer', clientThreadId: 'ui-late' })
  await h.notify('turn/completed', { threadId: run.conversationId, turn: { id: run.runId, status: 'completed', items: [], itemsView: 'notLoaded' } })
  await h.item(run, { id: 'late-final', type: 'agentMessage', phase: 'final_answer', text: 'Authoritative late answer' })
  const state = h.chat.snapshot(run.conversationId)
  assert.equal(state.runs[0].status, 'completed')
  assert.equal(state.runs[0].messages[0].text, 'Authoritative late answer')
  assert.equal(state.runs[0].messages[0].completionConfirmed, true)
  assert.equal(h.calls.filter(call => call.method === 'turn/start').length, 1)
})

test('partial native history stays explicit without claiming the bridge dropped items', async () => {
  const h = harness({ request: async () => ({ thread: { id: 'old', turns: [{ id: 'old-turn', status: 'completed', itemsView: 'summary', items: [
    { id: 'native-user', type: 'userMessage', clientId: 'original-request', content: [{ type: 'text', text: 'Question' }] },
    { id: 'native-answer', type: 'agentMessage', text: 'Answer' },
  ] }] }, turnsBackwardsCursor: 'older-turns' }) })
  const state = await h.chat.resume({ conversationId: 'old' })
  assert.equal(state.truncated, false)
  assert.equal(state.historyComplete, false)
  assert.equal(state.runs[0].historyComplete, false)
  assert.equal(state.runs[0].messages[0].clientId, 'original-request')
  assert.equal(state.runs[0].requestId, null)
})

test('exact text limit is complete; actual over-limit text is flagged', async () => {
  const h = harness()
  const run = await h.chat.send({ message: 'Work' })
  await h.item(run, { id: 'exact', type: 'agentMessage', text: 'a'.repeat(20000) })
  assert.equal(h.chat.snapshot().truncated, false)
  await h.item(run, { id: 'over', type: 'agentMessage', text: 'b'.repeat(20001) })
  assert.equal(h.chat.snapshot().truncated, true)
  assert.equal(h.chat.snapshot().runs[0].messages[1].text.length, 20000)
})

test('CLI credential arguments and authorization forms are redacted before activity, approval and history exposure', async () => {
  const cases = [
    ['tool --password hunter2 --verbose', 'hunter2'],
    ['tool --password="hunter two" --verbose', 'hunter two'],
    ["tool --client-secret 'secret words'", 'secret words'],
    ['curl --user alice:secret https://example.com', 'alice:secret'],
    ['tool --secret-access-key awsSecret --session-token temporarySecret', 'awsSecret'],
    ['tool --secret-access-key awsSecret --session-token temporarySecret', 'temporarySecret'],
    ['curl -u alice:shortSecret https://example.com', 'shortSecret'],
    ['curl -ualice:attachedSecret https://example.com', 'attachedSecret'],
    ['mysql -pmysqlSecret', 'mysqlSecret'],
    ["curl -H 'Authorization: Basic YWxhZGRpbjpvcGVuc2VzYW1l' https://example.com", 'YWxhZGRpbjpvcGVuc2VzYW1l'],
    ["curl -H 'Authorization: Bearer headerSecret' https://example.com", 'headerSecret'],
    ["curl -H 'Cookie: sid=cookieOne; session=cookieTwo' https://example.com", 'cookieTwo'],
    ['curl https://alice:urlSecret@example.com/data', 'urlSecret'],
  ]
  const h = harness()
  const run = await h.chat.send({ message: 'Inspect' })
  for (let index = 0; index < cases.length; index++) {
    const [command, secret] = cases[index]
    assert.ok(!publicText(command).includes(secret), command)
    await h.item(run, { id: `cli-${index}`, type: 'commandExecution', status: 'inProgress', command }, false)
    await h.chat.handleServerRequest({ id: `approval-${index}`, method: 'item/commandExecution/requestApproval', params: { threadId: run.conversationId, turnId: run.runId, itemId: `cli-${index}`, command } })
  }
  const exposed = JSON.stringify([h.events, h.chat.snapshot()])
  for (const [, secret] of cases) assert.ok(!exposed.includes(secret), secret)
  assert.ok(exposed.includes('example.com'))
  const historical = harness({ request: async () => ({ thread: { id: 'history', turns: [{ id: 'turn', status: 'completed', items: [
    { type: 'commandExecution', id: 'command', command: 'tool --password historySecret', status: 'completed' },
  ] }] } }) })
  assert.ok(!JSON.stringify(await historical.chat.resume({ conversationId: 'history' })).includes('historySecret'))
})

test('definite first-turn rejection exposes created thread ID and a same-thread retry does not create another thread', async () => {
  let attempts = 0
  const h = harness({ request: async (method, params, chat, defaults) => {
    if (method === 'turn/start' && attempts++ === 0) throw Object.assign(new Error('Invalid model'), { code: -32602 })
    return defaults(method, params)
  } })
  let rejected
  try { await h.chat.send({ message: 'Hello', requestId: 'first-attempt', clientThreadId: 'ui-thread' }) } catch (error) { rejected = error }
  assert.equal(rejected.conversationId, 'thread-1')
  assert.equal(rejected.resumeRequired, false)
  await assert.rejects(h.chat.send({ message: 'Retry', requestId: 'without-id', clientThreadId: 'ui-thread' }), error => error.code === 'CONVERSATION_REQUIRED' && error.conversationId === 'thread-1')
  const retry = await h.chat.send({ message: 'Retry', requestId: 'second-attempt', clientThreadId: 'ui-thread', conversationId: rejected.conversationId })
  assert.equal(retry.conversationId, 'thread-1')
  assert.equal(h.calls.filter(call => call.method === 'thread/start').length, 1)
})

test('ambiguous first-turn failure exposes the thread and requires explicit resume before retry', async () => {
  let attempts = 0
  const h = harness({ request: async (method, params, chat, defaults) => {
    if (method === 'turn/start' && attempts++ === 0) throw Object.assign(new Error('turn/start timed out'), { code: 'RPC_TIMEOUT' })
    return defaults(method, params)
  } })
  await assert.rejects(h.chat.send({ message: 'Hello', requestId: 'first', clientThreadId: 'ui' }), error => error.conversationId === 'thread-1' && error.resumeRequired === true)
  await assert.rejects(h.chat.send({ message: 'Retry', requestId: 'second', conversationId: 'thread-1' }), error => error.code === 'RESUME_REQUIRED')
  await h.chat.resume({ conversationId: 'thread-1' })
  assert.equal((await h.chat.send({ message: 'Retry', requestId: 'third', conversationId: 'thread-1' })).conversationId, 'thread-1')
  assert.equal(h.calls.filter(call => call.method === 'thread/start').length, 1)
})

test('explicit profile disable reloads the same idle native thread with ordinary config instructions and retains history', async () => {
  let effective = null
  const seenByTurns = []
  const h = harness({ request: async (method, params, chat, defaults) => {
    if (method === 'config/read') {
      assert.deepEqual(params, { includeLayers: false, cwd: '/work' })
      return { config: { developer_instructions: 'Ordinary project instructions' } }
    }
    if (method === 'thread/unsubscribe') return { status: 'unsubscribed' }
    if (method === 'thread/start' || method === 'thread/resume') {
      if (Object.hasOwn(params, 'developerInstructions')) effective = params.developerInstructions
    }
    if (method === 'turn/start') seenByTurns.push(effective)
    return defaults(method, params)
  } })
  const first = await h.chat.send({ message: 'First', profileEnabled: true, systemPrompt: 'Selected persona' })
  await h.item(first, { type: 'agentMessage', id: 'old-answer', text: 'Old answer is retained.' })
  await h.finish(first)
  const next = await h.chat.send({ message: 'Next', conversationId: first.conversationId, profileEnabled: false })
  assert.equal(next.conversationId, first.conversationId)
  assert.deepEqual(seenByTurns, ['Selected persona', 'Ordinary project instructions'])
  assert.ok(h.calls.find(call => call.method === 'thread/resume' && call.params.developerInstructions === 'Ordinary project instructions'))
  assert.equal(h.calls.filter(call => call.method === 'thread/start').length, 1)
  assert.equal(h.chat.snapshot().runs[0].messages[0].text, 'Old answer is retained.')
})

test('no ordinary developer instructions uses an explicit empty native override, never null/omission', async () => {
  const h = harness({ request: async (method, params, chat, defaults) => {
    if (method === 'config/read') return { config: { developer_instructions: null } }
    if (method === 'thread/unsubscribe') return { status: 'unsubscribed' }
    return defaults(method, params)
  } })
  const first = await h.chat.send({ message: 'First', profileEnabled: true, systemPrompt: 'Persona' })
  await h.finish(first)
  await h.chat.send({ message: 'Ordinary', conversationId: first.conversationId, profileEnabled: false })
  const resume = h.calls.find(call => call.method === 'thread/resume')
  assert.equal(resume.params.developerInstructions, '')
  assert.equal(Object.hasOwn(resume.params, 'developerInstructions'), true)
})

test('profile transition is blocked while a turn is active', async () => {
  const h = harness()
  const run = await h.chat.send({ message: 'Work', profileEnabled: true, systemPrompt: 'Persona' })
  await assert.rejects(h.chat.send({ message: 'Ordinary', conversationId: run.conversationId, profileEnabled: false }), error => error.code === 'RUN_IN_PROGRESS')
  assert.equal(h.calls.some(call => call.method === 'config/read' || call.method === 'thread/unsubscribe'), false)
})

test('unresolved ordinary config aborts profile disable before detaching or starting another turn', async () => {
  const h = harness({ request: async (method, params, chat, defaults) => {
    if (method === 'config/read') throw new Error('Config unavailable')
    return defaults(method, params)
  } })
  const first = await h.chat.send({ message: 'First', profileEnabled: true, systemPrompt: 'Persona' })
  await h.finish(first)
  await assert.rejects(h.chat.send({ message: 'Next', conversationId: first.conversationId, profileEnabled: false }), error => /Config unavailable/.test(error.message) && error.conversationId === first.conversationId)
  assert.equal(h.calls.filter(call => call.method === 'turn/start').length, 1)
  assert.equal(h.calls.some(call => call.method === 'thread/unsubscribe'), false)
})

// AGENT-03: saved Agent profiles from the local profile store.
const profileBody = (extra = {}) => ({
  name: '리오', avatar: { kind: 'initial', value: 'R' }, role: '회의 준비 담당',
  personality: { tone: 'warm', traits: ['꼼꼼함'], speechNotes: '결론부터 말한다.' },
  expertise: ['회의 자료 정리'], instructions: '대표님께는 존댓말을 쓴다.', ...extra,
})
function profileFixture(t) {
  const dataDir = createPrivateQaTempDirectory('egdesk-runtime-profile-')
  const profiles = openProfileStore({ dataDir, ownerHash: 'local-desktop-test' })
  t.after(async () => { profiles.close(); await rm(dataDir, { recursive: true, force: true }) })
  const created = profiles.createDraft(profileBody())
  profiles.activate(created.id, 1, null)
  return { dataDir, profiles, id: created.id, first: profiles.getRevision(created.id, 1) }
}
const resumingHarness = override => harness({ ...override, request: async (method, params, chat, defaults) => {
  if (method === 'thread/unsubscribe') return { status: 'unsubscribed' }
  return defaults(method, params)
} })

test('a saved Agent profile becomes the native instructions and its revision is recorded on the Run', async t => {
  const p = profileFixture(t)
  const h = harness({ profiles: p.profiles })
  const accepted = await h.chat.send({ message: 'Hi', requestId: 'profile-1', clientThreadId: 'ui-profile', profileEnabled: true, profileId: p.id, systemPrompt: 'Older free-text persona' })
  const start = h.calls.find(call => call.method === 'thread/start')
  assert.equal(start.params.developerInstructions, composeDeveloperInstructions(p.first.body))
  assert.match(start.params.developerInstructions, /이름: 리오/)
  assert.equal(start.params.developerInstructions.includes('Older free-text persona'), false)
  const binding = { profileId: p.id, revision: 1, hash: p.first.hash }
  assert.deepEqual(accepted.profileBinding, binding)
  assert.deepEqual(h.chat.snapshot(accepted.conversationId).runs[0].profileBinding, binding)
  assert.deepEqual(h.events.find(event => event.event === 'run.started').details, { status: 'inProgress', profileBinding: binding })
  // Same requestId with another revision is a different request.
  await h.finish(accepted)
  const second = p.profiles.saveDraft(p.id, profileBody({ instructions: '표로 정리해서 답한다.' }), 1)
  p.profiles.activate(p.id, second.revision, 1)
  await assert.rejects(h.chat.send({ message: 'Hi', requestId: 'profile-1', clientThreadId: 'ui-profile', profileEnabled: true, profileId: p.id, systemPrompt: 'Older free-text persona' }), error => error.code === 'REQUEST_CONFLICT')
})

test('a newly activated profile revision is applied to the same thread on its next send; a named revision runs as named', async t => {
  const p = profileFixture(t)
  const h = resumingHarness({ profiles: p.profiles })
  const first = await h.chat.send({ message: 'First', profileEnabled: true, profileId: p.id })
  await h.finish(first)
  const saved = p.profiles.saveDraft(p.id, profileBody({ personality: { tone: 'concise' }, instructions: '세 줄 이내로 답한다.' }), 1)
  p.profiles.activate(p.id, saved.revision, 1)
  // profileId alone selects the profile path (no profileEnabled flag needed).
  const next = await h.chat.send({ message: 'Next', conversationId: first.conversationId, profileId: p.id })
  assert.equal(next.conversationId, first.conversationId)
  assert.equal(h.calls.filter(call => call.method === 'thread/start').length, 1)
  const resumed = h.calls.filter(call => call.method === 'thread/resume')
  assert.equal(resumed.at(-1).params.developerInstructions, composeDeveloperInstructions(p.profiles.getRevision(p.id, 2).body))
  assert.ok(h.calls.findIndex(call => call.method === 'thread/unsubscribe') < h.calls.indexOf(resumed.at(-1)))
  assert.deepEqual(next.profileBinding, { profileId: p.id, revision: 2, hash: saved.hash })
  await h.finish(next)
  const pinned = await h.chat.send({ message: 'Use the first one', conversationId: first.conversationId, profileEnabled: true, profileId: p.id, profileRevision: 1 })
  assert.equal(h.calls.filter(call => call.method === 'thread/resume').at(-1).params.developerInstructions, composeDeveloperInstructions(p.first.body))
  assert.equal(pinned.profileBinding.revision, 1)
  assert.deepEqual(h.chat.snapshot(first.conversationId).runs.map(run => run.profileBinding.revision), [1, 2, 1])
})

test('missing, inactive or unavailable profiles are rejected before any native call', async t => {
  const p = profileFixture(t)
  const h = harness({ profiles: p.profiles })
  const send = extra => h.chat.send({ message: 'Hi', profileEnabled: true, ...extra })
  await assert.rejects(send({ profileId: 'no-such-profile' }), error => error.code === 'PROFILE_NOT_FOUND' && error.httpStatus === 404)
  await assert.rejects(send({ profileId: p.id, profileRevision: 99 }), error => error.code === 'PROFILE_REVISION_NOT_FOUND' && error.httpStatus === 404)
  await assert.rejects(send({ profileId: p.id, profileRevision: 'latest' }), error => error.code === 'INVALID_PROFILE_REVISION' && error.httpStatus === 400)
  await assert.rejects(send({ profileId: 'Not An ID' }), error => error.code === 'INVALID_PROFILE_ID' && error.httpStatus === 400)
  await assert.rejects(h.chat.send({ message: 'Hi', profileEnabled: false, profileId: p.id }), error => error.code === 'INVALID_PROFILE' && error.httpStatus === 400)
  const draftOnly = p.profiles.createDraft(profileBody({ name: '초안' }))
  await assert.rejects(send({ profileId: draftOnly.id }), error => error.code === 'PROFILE_NOT_RUNNABLE' && error.httpStatus === 409)
  p.profiles.disable(p.id)
  await assert.rejects(send({ profileId: p.id }), error => error.code === 'PROFILE_NOT_RUNNABLE' && error.httpStatus === 409)
  await assert.rejects(harness().chat.send({ message: 'Hi', profileEnabled: true, profileId: p.id }), error => error.code === 'PROFILE_STORE_UNAVAILABLE' && error.httpStatus === 503)
  assert.deepEqual(h.calls, [])
})

test('older UI requests keep the free-text persona path, its durable fingerprint and no profile binding', async () => {
  const dataDir = createPrivateQaTempDirectory('egdesk-runtime-legacy-profile-')
  let store = null
  try {
    store = openChatStore({ dataDir, ownerScope: 'local-desktop-test' })
    const calls = []
    const chat = new CodexChatRuntime({
      store, requireStore: true, getOwnerKey: () => 'codex:chatgpt:account-1', respond: () => {},
      request: async (method, params) => {
        calls.push({ method, params })
        if (method === 'thread/start') return { thread: { id: 'native-legacy' }, cwd: '/work' }
        if (method === 'turn/start') return { turn: { id: 'turn-legacy', status: 'inProgress', items: [] } }
        throw new Error(`Unexpected native call: ${method}`)
      },
    })
    chat.setConnection(true)
    const body = { message: 'Hi', requestId: 'legacy-1', clientThreadId: 'ui-legacy', profileEnabled: true, systemPrompt: 'Be concise' }
    const accepted = await chat.send(body)
    assert.equal(calls[0].params.developerInstructions, 'Be concise')
    assert.equal(Object.hasOwn(accepted, 'profileBinding'), false)
    assert.equal(Object.hasOwn(chat.snapshot().runs[0], 'profileBinding'), false)
    // The formula before saved profiles existed; replays recorded by an older bridge still match.
    const legacyFingerprint = createHash('sha256').update(JSON.stringify({
      message: body.message, clientThreadId: body.clientThreadId,
      cwd: body.cwd, model: body.model, effort: body.effort, profileEnabled: true,
      systemPrompt: body.systemPrompt,
      contextSnapshotIds: body.contextSnapshotIds, contextCapabilities: body.contextCapabilities, attachments: body.attachments,
      executionPolicy: body.executionPolicy,
      selectedSources: body.selectedSources, browserTransportId: body.browserTransportId,
      qaCommandNonce: body.qaCommandNonce, qaOutputMarkers: body.qaOutputMarkers,
    })).digest('hex')
    assert.equal(store.getRequest({ clientThreadId: 'ui-legacy', requestId: 'legacy-1' }).fingerprint, legacyFingerprint)
  } finally {
    try { store?.close() } catch {}
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('real SQLite history keeps the profile binding through a restart and a reconciled checkpoint', async t => {
  const p = profileFixture(t)
  const dataDir = createPrivateQaTempDirectory('egdesk-runtime-profile-store-')
  let store = null
  try {
    store = openChatStore({ dataDir, ownerScope: 'local-desktop-test' })
    const native = async method => {
      if (method === 'thread/start') return { thread: { id: 'native-profile' }, cwd: '/work' }
      if (method === 'turn/start') return { turn: { id: 'turn-profile', status: 'inProgress', items: [] } }
      if (method === 'thread/resume') return { thread: { id: 'native-profile', turns: [{ id: 'turn-profile', status: 'completed', items: [], itemsView: 'full' }] }, cwd: '/work' }
      throw new Error(`Unexpected native call: ${method}`)
    }
    const runtime = () => new CodexChatRuntime({ store, requireStore: true, profiles: p.profiles, getOwnerKey: () => 'codex:chatgpt:account-1', request: native, respond: () => {} })
    const chat = runtime()
    chat.setConnection(true)
    const accepted = await chat.send({ message: 'Stored with a profile', requestId: 'req-profile', clientThreadId: 'ui-profile', profileEnabled: true, profileId: p.id })
    const binding = { profileId: p.id, revision: 1, hash: p.first.hash }
    const stored = chat.getLocalHistory({ clientThreadId: 'ui-profile', limit: 500 })
    assert.deepEqual(stored.runs[0].profileBinding, binding)
    assert.deepEqual(stored.events.find(event => event.event === 'run.started').details.profileBinding, binding)
    // Bridge restart before completion: recovery, then native resume reconciles the run.
    const restarted = runtime()
    assert.equal(restarted.recoverInterruptedRuns(), 1)
    restarted.setConnection(true)
    await restarted.resume({ conversationId: accepted.conversationId, clientThreadId: 'ui-profile' })
    const after = restarted.getLocalHistory({ clientThreadId: 'ui-profile', limit: 500 })
    assert.ok(after.events.some(event => event.event === 'run.reconciled'))
    assert.equal(after.runs[0].status, 'completed')
    assert.deepEqual(after.runs[0].profileBinding, binding)
    assert.deepEqual(restarted.snapshot('native-profile').runs[0].profileBinding, binding)
  } finally {
    try { store?.close() } catch {}
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('a Codex usage-limit turn error carries the quota kind into the Run and its completion event', async () => {
  const h = harness()
  const run = await h.chat.send({ message: 'Work' })
  await h.notify('error', { threadId: run.conversationId, turnId: run.runId, error: { message: 'Reconnecting', codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 401 } } }, willRetry: true })
  assert.equal(h.chat.snapshot().runs[0].error.kind, 'auth')
  await h.notify('turn/completed', { threadId: run.conversationId, turn: { id: run.runId, status: 'failed', items: [],
    error: { message: 'You have hit your usage limit.', codexErrorInfo: 'usageLimitExceeded' } } })
  const shown = h.chat.snapshot().runs[0]
  assert.equal(shown.status, 'failed')
  assert.deepEqual(shown.error, { code: 'TURN_FAILED', origin: 'codex', message: 'You have hit your usage limit.', kind: 'quota' })
  assert.equal(h.events.find(event => event.event === 'run.completed').details.error.kind, 'quota')
  // A native turn error has no reset field; the screen takes it from auth.usage.
  assert.equal(Object.hasOwn(shown.error, 'retryAt'), false)
})

test('network approvals preserve only public host/protocol and request scope, including a meaningful legacy reason', async () => {
  const h = harness()
  const run = await h.chat.send({ message: 'Network work' })
  await h.chat.handleServerRequest({ id: 'net', method: 'item/commandExecution/requestApproval', params: {
    threadId: run.conversationId, turnId: run.runId, itemId: 'network-item', command: null,
    networkApprovalContext: { host: 'api.example.com', protocol: 'https', token: 'DO_NOT_EXPOSE' },
  } })
  const pending = h.chat.snapshot().runs[0].pendingApprovals[0]
  assert.deepEqual(pending.networkApprovalContext, { host: 'api.example.com', protocol: 'https' })
  assert.equal(pending.scope, 'request')
  assert.ok(pending.reason.includes('api.example.com'))
  assert.ok(pending.choices.includes('accept'))
  assert.ok(!JSON.stringify([pending, h.events]).includes('DO_NOT_EXPOSE'))
})

test('unknown network target/protocol and absent command never offer blind accept', async () => {
  const h = harness()
  const run = await h.chat.send({ message: 'Work' })
  const examples = [
    { networkApprovalContext: { host: 'https://alice:secret@example.com/path', protocol: 'https' } },
    { networkApprovalContext: { host: 'example.com', protocol: 'unknown' } },
    {},
    { kind: 'writeStdin', command: 'old command' },
  ]
  for (let i = 0; i < examples.length; i++) await h.chat.handleServerRequest({ id: `unknown-${i}`, method: 'item/commandExecution/requestApproval', params: { threadId: run.conversationId, turnId: run.runId, itemId: `item-${i}`, ...examples[i] } })
  for (const approval of h.chat.snapshot().runs[0].pendingApprovals) {
    assert.deepEqual(approval.choices, ['decline', 'cancel'])
    assert.ok(approval.acceptDisabledReason)
    await assert.rejects(h.chat.replyApproval({ ...run, approvalId: approval.approvalId, decision: 'accept' }), error => error.code === 'INVALID_DECISION')
  }
  assert.equal(h.replies.length, 0)
  assert.ok(!JSON.stringify(h.events).includes('alice:secret'))
})

test('unowned active history remains a partial snapshot and does not accept later native deltas', async () => {
  const h = harness({ request: async (method, params) => {
    assert.equal(method, 'thread/resume')
    return { thread: { id: params.threadId, turns: [{ id: 'active-turn', status: 'inProgress', itemsView: 'full', items: [
      { id: 'partial', type: 'agentMessage', phase: 'final_answer', text: 'Hello' },
    ] }] } }
  } })
  const resumed = await h.chat.resume({ conversationId: 'active-thread', clientThreadId: 'ui' })
  assert.equal(resumed.runs[0].messages[0].status, 'streaming')
  assert.equal(resumed.runs[0].messages[0].completionConfirmed, false)
  await h.notify('item/agentMessage/delta', { threadId: 'active-thread', turnId: 'active-turn', itemId: 'partial', delta: ' world ' })
  assert.equal(h.chat.snapshot().runs[0].messages[0].text, 'Hello')
  assert.equal(h.chat.snapshot().runs[0].messages[0].status, 'streaming')
  await h.item({ conversationId: 'active-thread', runId: 'active-turn' }, { id: 'partial', type: 'agentMessage', text: 'Hello world!' })
  assert.equal(h.chat.snapshot().runs[0].messages[0].status, 'streaming')
  assert.equal(h.chat.snapshot().runs[0].messages[0].completionConfirmed, false)
})

test('active history preserves observed item completion and authoritative text, while another item keeps streaming', async () => {
  const h = harness({ request: async (method, params, chat, defaults) => {
    if (method !== 'thread/resume') return defaults(method, params)
    return { thread: { id: params.threadId, turns: [{ id: 'turn-1', status: 'inProgress', items: [
      { id: 'finished-item', type: 'agentMessage', text: 'Stale summary' },
      { id: 'partial-item', type: 'agentMessage', text: 'Second' },
    ] }] } }
  } })
  const run = await h.chat.send({ message: 'Work' })
  await h.item(run, { id: 'finished-item', type: 'agentMessage', text: 'First item really completed.' })
  await h.notify('item/agentMessage/delta', { threadId: run.conversationId, turnId: run.runId, itemId: 'partial-item', delta: 'Second ' })
  const state = await h.chat.resume({ conversationId: run.conversationId })
  const finished = state.runs[0].messages.find(message => message.id === 'finished-item')
  const partial = state.runs[0].messages.find(message => message.id === 'partial-item')
  assert.equal(finished.status, 'complete')
  assert.equal(finished.completionConfirmed, true)
  assert.equal(finished.text, 'First item really completed.')
  assert.equal(partial.status, 'streaming')
  assert.equal(partial.text, 'Second ')
  await h.notify('item/agentMessage/delta', { threadId: run.conversationId, turnId: run.runId, itemId: 'partial-item', delta: 'message ' })
  assert.equal(h.chat.snapshot().runs[0].messages.find(message => message.id === 'partial-item').text, 'Second message ')
  await h.notify('item/agentMessage/delta', { threadId: run.conversationId, turnId: run.runId, itemId: 'finished-item', delta: 'late stale delta ' })
  assert.equal(h.chat.snapshot().runs[0].messages.find(message => message.id === 'finished-item').text, finished.text)
})

test('explicit invalid cwd is rejected before any native runtime RPC, independent of persona', async () => {
  for (const cwd of [null, '', ' ', 'relative/path', 'file:///tmp/work', 0, [], {}, '/tmp/bad\0path']) {
    for (const profileEnabled of [undefined, false, true]) {
      const h = harness()
      await assert.rejects(h.chat.send({ message: 'Hello', cwd, profileEnabled, systemPrompt: 'Optional persona' }), error => error.code === 'INVALID_CWD' && error.httpStatus === 400)
      assert.equal(h.calls.length, 0)
    }
  }
})

test('omitted cwd inherits native defaults and an explicit absolute cwd is forwarded without a persona', async () => {
  const omitted = harness()
  await omitted.chat.send({ message: 'Hello' })
  for (const call of omitted.calls) assert.equal(Object.hasOwn(call.params, 'cwd'), false)
  const explicit = harness()
  await explicit.chat.send({ message: 'Hello', cwd: '/fixture/manifest-workspace' })
  assert.equal(explicit.calls.find(call => call.method === 'thread/start').params.cwd, '/fixture/manifest-workspace')
  assert.equal(explicit.calls.find(call => call.method === 'turn/start').params.cwd, '/fixture/manifest-workspace')
  assert.equal(Object.hasOwn(explicit.calls[0].params, 'developerInstructions'), false)
})

test('durable acceptance and dispatch intent precede every native start; store failures start no turn', async () => {
  const calls = []
  const store = {
    getConversation: () => null,
    createConversation: () => ({ clientThreadId: 'client-1', localConversationId: 'local-1' }),
    acceptRequest: record => { calls.push(['accept', record]); return { accepted: true, message: record.message, request: { requestId: record.requestId, outcome: null } } },
    appendEvent: event => { calls.push(['event', event]); return event },
    recordRequestOutcome: () => {},
    bindNative: () => {},
  }
  const chat = new CodexChatRuntime({
    store, getOwnerKey: () => 'codex:chatgpt:account-1',
    request: async (method, params) => {
      calls.push(['native', method])
      if (method === 'thread/start') return { thread: { id: 'native-thread-1' } }
      if (method === 'turn/start') return { turn: { id: 'native-turn-1', status: 'inProgress', items: [] } }
      throw new Error('Unexpected native call')
    }, respond: () => {},
  })
  chat.setConnection(true)
  const reply = await chat.send({ message: 'Keep this', clientThreadId: 'client-1', requestId: 'request-1' })
  assert.equal(reply.accepted, true)
  assert.equal(reply.durable, true)
  assert.equal(reply.conversationId, 'native-thread-1')
  assert.equal(reply.runId, 'native-turn-1')
  assert.equal(reply.localConversationId, 'local-1')
  assert.match(reply.localRunId, /^run-[\da-f]{32}$/)
  assert.deepEqual(calls.map(call => call[0] === 'event' ? call[1].event : call[0] === 'native' ? call[1] : 'accept'), [
    'accept', 'run.dispatching', 'thread/start', 'native.thread.bound', 'turn/start', 'run.started', 'run.configuration',
  ])
  assert.equal(calls[0][1].message.text, 'Keep this')
  assert.equal(calls[0][1].requestId, 'request-1')
  const failedStore = new CodexChatRuntime({
    store: { getConversation: () => null, createConversation: () => ({ localConversationId: 'local-1' }), acceptRequest: () => { throw new Error('Disk unavailable') } },
    getOwnerKey: () => 'codex:chatgpt:account-1',
    request: async () => { throw new Error('Native must not be called') }, respond: () => {},
  })
  failedStore.setConnection(true)
  await assert.rejects(failedStore.send({ message: 'Do not send', clientThreadId: 'client-2' }), error => error.code === 'CHAT_STORE_UNAVAILABLE')
  const failedDispatch = new CodexChatRuntime({
    store: {
      getConversation: () => null,
      createConversation: () => ({ localConversationId: 'local-1' }),
      acceptRequest: record => ({ accepted: true, message: record.message, request: { requestId: record.requestId } }),
      appendEvent: () => { throw new Error('Disk unavailable') },
    },
    getOwnerKey: () => 'codex:chatgpt:account-1',
    request: async () => { throw new Error('Native must not be called') }, respond: () => {},
  })
  failedDispatch.setConnection(true)
  await assert.rejects(failedDispatch.send({ message: 'Do not send', clientThreadId: 'client-1' }), error => error.code === 'CHAT_STORE_UNAVAILABLE')
})

test('persisted request replay returns the same local IDs without native dispatch', async () => {
  const chat = new CodexChatRuntime({
    store: {
      getConversation: () => ({ clientThreadId: 'client-1', localConversationId: 'local-1' }),
      getRequest: () => null,
      acceptRequest: record => ({
        accepted: false, message: record.message,
        request: { requestId: record.requestId, outcome: { accepted: false, dispatchStatus: 'unknown' } },
      }),
    },
    getOwnerKey: () => 'codex:chatgpt:account-1',
    request: async () => { throw new Error('Duplicate must not reach native') }, respond: () => {},
  })
  chat.setConnection(true)
  const result = await chat.send({ message: 'Previously sent', clientThreadId: 'client-1', requestId: 'request-1' })
  assert.equal(result.accepted, false)
  assert.equal(result.duplicate, true)
  assert.equal(result.dispatchStatus, 'unknown')
  assert.match(result.localRunId, /^run-[\da-f]{32}$/)
})

test('local history returns full public projections and paged events with native runtime offline', () => {
  const publicRun = {
    localRunId: 'run-local', requestId: 'request-local', conversationId: 'native-1', runId: 'turn-1',
    status: 'completed', messages: [{ id: 'assistant-1', role: 'assistant', text: 'Answer' }],
    activities: [{ id: 'tool-1', kind: 'mcpToolCall', detail: { server: 'public-server', tool: 'public-tool' } }],
    artifacts: [{ id: 'artifact-1', relation: 'referenced' }], context: { packets: [{ packetId: 'packet-1' }] },
    briefing: { briefingId: 'briefing-1' }, cwdPublic: '/safe/work', accountIdentity: { ownerHash: 'hash' },
  }
  const chat = new CodexChatRuntime({
    store: {
      getConversation: () => ({ clientThreadId: 'client-1', localConversationId: 'local-1', conversationId: 'native-1', coverage: { scope: 'egdesk-local', status: 'complete', reasons: [], nativeHistoryComplete: true } }),
      listRuns: () => ({ runs: [publicRun], nextCursor: null, hasMore: false }),
      listMessages: () => ({ messages: [{ localMessageId: 'message-local', requestId: 'request-local', role: 'user', text: 'Question' }], nextCursor: null, hasMore: false }),
      listEvents: () => ({ events: [{ seq: 7, eventId: 'event-7', event: 'message.completed', details: { message: { text: 'Answer' } } }], nextCursor: 7, hasMore: true }),
      getRequest: () => ({ acceptedAt: 1234 }),
      listConversations: () => ({ threads: [{ clientThreadId: 'client-1', localConversationId: 'local-1' }], nextCursor: null, hasMore: false }),
    },
    request: async () => { throw new Error('History must not query native') }, respond: () => {},
  })
  const page = chat.getLocalHistory({ clientThreadId: 'client-1', afterSeq: 6, limit: 1 })
  assert.equal(chat.connection, 'offline')
  assert.equal(page.runs[0].activities[0].detail.tool, 'public-tool')
  assert.equal(page.runs[0].context.packets[0].packetId, 'packet-1')
  assert.equal(page.messages[0].createdAt, 1234)
  assert.equal(page.events[0].details.message.text, 'Answer')
  assert.equal(page.nextCursor, 7)
  assert.equal(page.coverage.status, 'complete')
  assert.equal(chat.listLocalThreads({ limit: 10 }).threads.length, 1)
})

test('restart marks active local run unknown without a provider call or rerun', () => {
  const events = []
  const chat = new CodexChatRuntime({
    store: {
      listConversations: () => ({ threads: [{ clientThreadId: 'client-1' }], nextCursor: null, hasMore: false }),
      listRuns: () => ({ runs: [{ localRunId: 'run-1', requestId: 'request-1', runId: 'turn-1', conversationId: 'native-1', status: 'inProgress', messages: [{ id: 'part', role: 'assistant', text: 'Partial', status: 'streaming' }],
        pendingUserInputs: [{ userInputId: 'input:old', kind: 'userInput', status: 'pending', questions: [] }],
        subAgents: [{ threadId: 'child-running', state: 'running', blocked: null }, { threadId: 'child-done', state: 'completed', blocked: null }] }], nextCursor: null, hasMore: false }),
      appendEvent: event => { events.push(event) },
      getRequest: () => ({ requestId: 'request-1' }),
      recordRequestOutcome: () => {},
    },
    request: async () => { throw new Error('Recovery must not call provider') }, respond: () => {},
  })
  assert.equal(chat.recoverInterruptedRuns(), 1)
  assert.equal(events[0].event, 'run.recovery_unknown')
  assert.equal(events[0].runCheckpoint.status, 'unknown')
  assert.equal(events[0].runCheckpoint.messages[0].status, 'partial')
  assert.deepEqual(events[0].runCheckpoint.pendingUserInputs, [])
  assert.deepEqual(events[0].runCheckpoint.subAgents.map(row => [row.threadId, row.state]), [['child-running', 'unknown'], ['child-done', 'completed']])
})

test('stored native owner mismatch blocks resume before any provider call', async () => {
  const chat = new CodexChatRuntime({
    store: {
      getConversation: () => ({ clientThreadId: 'client-1', localConversationId: 'local-1', conversationId: 'native-1' }),
      getRequest: () => null,
      listEvents: () => ({ events: [{ event: 'native.thread.bound', details: { conversationId: 'native-1', ownerHash: 'different-owner' } }], nextCursor: null, hasMore: false }),
    },
    getOwnerKey: () => 'codex:chatgpt:current-account',
    request: async () => { throw new Error('Mismatched account must not reach provider') }, respond: () => {},
  })
  chat.setConnection(true)
  await assert.rejects(chat.resume({ clientThreadId: 'client-1', conversationId: 'native-1' }), error => error.code === 'NATIVE_ACCOUNT_MISMATCH')
  await assert.rejects(chat.send({ clientThreadId: 'client-1', conversationId: 'native-1', message: 'Continue' }), error => error.code === 'NATIVE_ACCOUNT_MISMATCH')
})

test('real SQLite store captures a full turn, serves offline history and dedupes send after reopen', async () => {
  const dataDir = createPrivateQaTempDirectory('egdesk-runtime-store-')
  let store = null
  try {
    store = openChatStore({ dataDir, ownerScope: 'local-desktop-test' })
    const storageFaults = []
    for (const method of ['appendEvent', 'bindNative', 'recordRequestOutcome']) {
      const original = store[method].bind(store)
      store[method] = input => {
        try { return original(input) }
        catch (error) { storageFaults.push({ method, event: input.event, code: error.code, message: error.message }); throw error }
      }
    }
    const nativeCalls = []
    const chat = new CodexChatRuntime({
      store, requireStore: true, getOwnerKey: () => 'codex:chatgpt:account-1',
      request: async method => {
        nativeCalls.push(method)
        if (method === 'thread/start') return { thread: { id: 'native-1' }, cwd: '/safe/work' }
        if (method === 'turn/start') return { turn: { id: 'turn-1', status: 'inProgress', items: [] } }
        throw new Error(`Unexpected native call: ${method}`)
      }, respond: () => {},
    })
    chat.setConnection(true)
    const body = { message: 'Stored question', clientThreadId: 'ui-1', requestId: 'req-1' }
    const accepted = await chat.send(body)
    assert.equal(accepted.accepted, true)
    assert.equal(accepted.durable, true)
    const pendingUser = store.listMessages('ui-1', { limit: 100 }).messages.find(message => message.role === 'user')
    assert.equal(pendingUser.localMessageId, accepted.localMessageId)
    assert.equal(pendingUser.messageId, null)
    await chat.handleNotification({ method: 'item/completed', params: { threadId: 'native-1', turnId: 'turn-1', item: { id: 'native-user-1', type: 'userMessage', clientId: 'req-1', content: [{ type: 'text', text: 'Stored question' }] } } })
    await chat.handleNotification({ method: 'item/agentMessage/delta', params: { threadId: 'native-1', turnId: 'turn-1', itemId: 'answer-1', delta: 'Partial ' } })
    await chat.handleNotification({ method: 'item/completed', params: { threadId: 'native-1', turnId: 'turn-1', item: { id: 'answer-1', type: 'agentMessage', text: 'Partial final answer', phase: 'final_answer' } } })
    await chat.handleNotification({ method: 'turn/completed', params: { threadId: 'native-1', turn: { id: 'turn-1', status: 'completed', items: [], itemsView: 'notLoaded' } } })
    assert.deepEqual(storageFaults, [])
    const before = chat.getLocalHistory({ clientThreadId: 'ui-1', limit: 500 })
    assert.equal(before.thread.conversationId, 'native-1')
    assert.equal(before.runs[0].runId, 'turn-1')
    assert.equal(before.runs[0].status, 'completed')
    const boundUser = before.messages.find(message => message.role === 'user')
    assert.equal(boundUser.localMessageId, accepted.localMessageId)
    assert.equal(boundUser.messageId, 'native-user-1')
    assert.ok(before.events.some(event => event.event === 'message.checkpoint' && event.localMessageId === accepted.localMessageId && event.messageId === 'native-user-1'))
    assert.ok(before.messages.some(message => message.role === 'assistant' && message.text === 'Partial final answer'))
    assert.ok(before.messages.some(message => message.role === 'assistant' && message.messageId === 'answer-1'))
    assert.ok(before.events.some(event => event.event === 'message.completed' && event.details.text === 'Partial final answer'))
    assert.deepEqual(nativeCalls, ['thread/start', 'turn/start'])
    store.close(); store = null
    const reopened = openChatStore({ dataDir, ownerScope: 'local-desktop-test' })
    store = reopened
    const offline = new CodexChatRuntime({
      store: reopened, requireStore: true, getOwnerKey: () => 'codex:chatgpt:account-1',
      request: async () => { throw new Error('Offline history must not query native') }, respond: () => {},
    })
    assert.equal(offline.recoverInterruptedRuns(), 0)
    assert.equal(offline.getLocalHistory({ clientThreadId: 'ui-1', limit: 500 }).messages.at(-1).text, 'Partial final answer')
    offline.setConnection(true)
    const replay = await offline.send(body)
    assert.equal(replay.duplicate, true)
    assert.equal(replay.runId, 'turn-1')
    assert.equal(replay.localRunId, accepted.localRunId)
  } finally {
    try { store?.close() } catch {}
    await rm(dataDir, { recursive: true, force: true })
  }
})

// Agent questions (item/tool/requestUserInput) and sub-Agent status rows.
const USER_INPUT = 'item/tool/requestUserInput'
const agentQuestions = () => [
  { id: 'deploy_target', header: 'Target', question: 'Where should this go? (token=PUBLIC_QUESTION_TOKEN)', isOther: true, isSecret: false, options: [
    { label: 'Staging', description: 'Safe default' },
    { label: 'Use api_key=RAW_LABEL_TOKEN', description: 'Original label differs from its public copy' },
  ] },
  { id: 'password', header: 'Password', question: 'Enter the deploy password', isOther: false, isSecret: true, options: null },
]
const ask = (h, run, id, params = {}) => h.chat.handleServerRequest({ id, method: USER_INPUT, params: {
  threadId: run.conversationId, turnId: run.runId, itemId: 'ask-item', isBlocking: true, questions: agentQuestions(), ...params,
} })
const pendingInput = (h, index = 0) => h.chat.snapshot().runs[0].pendingUserInputs[index]

test('Agent question is a separate redacted pending card bound to the exact run', async () => {
  const h = harness()
  const run = await h.chat.send({ message: 'Ask before deploying', requestId: 'ask-request', clientThreadId: 'ask-ui' })
  await ask(h, run, 'ask-1')
  assert.deepEqual(h.replies, [], 'a question is never answered automatically')
  const state = h.chat.snapshot().runs[0]
  assert.deepEqual(state.pendingApprovals, [])
  assert.equal(state.pendingUserInputs.length, 1)
  const pending = state.pendingUserInputs[0]
  assert.equal(pending.userInputId, `input:${h.chat.streamId}:${h.chat.epoch}:string:ask-1`)
  assert.deepEqual(Object.keys(pending).sort(), ['isBlocking', 'itemId', 'kind', 'questions', 'status', 'userInputId'])
  assert.equal(pending.kind, 'userInput')
  assert.equal(pending.status, 'pending')
  assert.equal(pending.isBlocking, true)
  assert.deepEqual(pending.questions.map(q => [q.questionId, q.allowsOther, q.isSecret]), [['deploy_target', true, false], ['password', false, true]])
  assert.equal(pending.questions[1].options, null)
  assert.equal(pending.questions[0].options[1].label, 'Use api_key=[REDACTED]')
  assert.deepEqual(Object.keys(pending.questions[0]).sort(), ['allowsOther', 'header', 'isSecret', 'options', 'question', 'questionId'])
  const required = h.events.filter(event => event.event === 'userInput.required')
  assert.equal(required.length, 1)
  assert.deepEqual([required[0].conversationId, required[0].runId, required[0].answerId, required[0].itemId], [run.conversationId, run.runId, run.answerId, 'ask-item'])
  assert.deepEqual(required[0].details, pending)
  const exposed = JSON.stringify([h.events, h.legacy, h.chat.snapshot()])
  for (const hidden of ['PUBLIC_QUESTION_TOKEN', 'RAW_LABEL_TOKEN', 'rawLabels', 'rpcId']) assert.ok(!exposed.includes(hidden), hidden)
  assert.equal(h.chat.pendingApprovals.size, 0)
  assert.equal(h.chat.pendingUserInputs.size, 1)
})

test('Agent answers need exactly one valid answer per question and map choices to original labels', async () => {
  const h = harness()
  const run = await h.chat.send({ message: 'Ask' })
  await ask(h, run, 'ask-2')
  const { userInputId } = pendingInput(h)
  const reply = answers => h.chat.replyUserInput({ ...run, userInputId, action: 'submit', answers })
  await assert.rejects(h.chat.replyUserInput({ ...run, runId: 'wrong', userInputId, action: 'submit', answers: [] }), e => e.code === 'STALE_USER_INPUT')
  await assert.rejects(h.chat.replyUserInput({ ...run, userInputId: 'input:forged', action: 'submit', answers: [] }), e => e.code === 'STALE_USER_INPUT')
  await assert.rejects(h.chat.replyUserInput({ ...run, userInputId, action: 'accept' }), e => e.code === 'INVALID_USER_INPUT_ANSWER')
  const typed = { questionId: 'password', text: 'INVALID_PATH_SECRET' }
  for (const answers of [
    undefined, {}, [], [{ questionId: 'deploy_target', optionIndex: 0 }],
    [{ questionId: 'deploy_target', optionIndex: 0 }, { questionId: 'deploy_target', optionIndex: 1 }],
    [{ questionId: 'unknown', optionIndex: 0 }, typed],
    [{ questionId: 'deploy_target', optionIndex: 2 }, typed],
    [{ questionId: 'deploy_target', optionIndex: -1 }, typed],
    [{ questionId: 'deploy_target', optionIndex: 0.5 }, typed],
    [{ questionId: 'deploy_target', optionIndex: '0' }, typed],
    [{ questionId: 'deploy_target', optionIndex: 0, text: 'both' }, typed],
    [{ questionId: 'deploy_target' }, typed],
    [{ questionId: 'deploy_target', optionIndex: 0 }, { questionId: 'password', optionIndex: 0 }],
    [{ questionId: 'deploy_target', optionIndex: 0 }, { questionId: 'password', text: '   ' }],
    [{ questionId: 'deploy_target', optionIndex: 0 }, { questionId: 'password', text: 'x'.repeat(4001) }],
    [{ questionId: 'deploy_target', optionIndex: 0 }, { questionId: 'password', text: 'nul\0byte' }],
    [{ questionId: 'deploy_target', optionIndex: 0 }, { questionId: 'password', text: 42 }],
    [{ questionId: 'deploy_target', optionIndex: 0 }, null],
  ]) await assert.rejects(reply(answers), error => error.code === 'INVALID_USER_INPUT_ANSWER' && !error.message.includes('INVALID_PATH_SECRET'))
  assert.deepEqual(h.replies, [])
  assert.equal(pendingInput(h).status, 'pending')
  const result = await reply([{ questionId: 'password', text: ' typed value ' }, { questionId: 'deploy_target', optionIndex: 1 }])
  assert.deepEqual(result, { accepted: true, userInputId, conversationId: run.conversationId, runId: run.runId, status: 'replySent' })
  assert.deepEqual(h.replies, [['ask-2', { answers: { deploy_target: { answers: ['Use api_key=RAW_LABEL_TOKEN'] }, password: { answers: [' typed value '] } } }]])
  assert.equal(pendingInput(h).status, 'replySent')
  await assert.rejects(reply([{ questionId: 'password', text: 'again' }, { questionId: 'deploy_target', optionIndex: 0 }]), e => e.code === 'STALE_USER_INPUT')
  await h.notify('serverRequest/resolved', { threadId: run.conversationId, requestId: 'ask-2' })
  assert.deepEqual(h.chat.snapshot().runs[0].pendingUserInputs, [])
  assert.deepEqual(h.events.filter(event => event.event === 'userInput.resolved').map(event => event.details), [{ userInputId }])
  assert.equal(h.replies.length, 1)
})

test('free text on a choice question is the automatic Other answer and non-private text is trimmed', async () => {
  const h = harness()
  const run = await h.chat.send({ message: 'Ask' })
  await ask(h, run, 7, { questions: [agentQuestions()[0], { id: 'note', header: 'Note', question: 'Anything else?', options: [] }] })
  const pending = pendingInput(h)
  assert.equal(pending.userInputId.endsWith(':number:7'), true)
  assert.deepEqual(pending.questions.map(q => [q.options === null, q.allowsOther]), [[false, true], [true, false]])
  await h.chat.replyUserInput({ ...run, userInputId: pending.userInputId, action: 'submit', answers: [{ questionId: 'deploy_target', text: '  Production  ' }, { questionId: 'note', text: ' none ' }] })
  assert.deepEqual(h.replies, [[7, { answers: { deploy_target: { answers: ['Production'] }, note: { answers: ['none'] } } }]])
})

test('answered Agent question continues the same run without another thread or turn', async () => {
  const h = harness()
  const run = await h.chat.send({ message: 'Continue after my answer', requestId: 'input-positive-request', clientThreadId: 'input-positive-ui' })
  const identity = value => ({ conversationId: value.conversationId, runId: value.runId, answerId: value.answerId })
  const callsBefore = h.calls.length
  const current = () => {
    const runs = h.chat.snapshot().runs
    assert.equal(runs.length, 1, 'an answer must not create another run')
    assert.deepEqual(identity(runs[0]), identity(run))
    return runs[0]
  }
  const assertStillRunning = () => {
    assert.equal(current().status, 'inProgress')
    assert.equal(h.events.filter(event => event.event === 'run.completed').length, 0)
  }
  await ask(h, run, 'input-positive', { questions: [agentQuestions()[0]] })
  const reply = { ...run, userInputId: current().pendingUserInputs[0].userInputId, action: 'submit', answers: [{ questionId: 'deploy_target', optionIndex: 0 }] }
  assert.equal((await h.chat.replyUserInput(reply)).status, 'replySent')
  assert.deepEqual(h.replies, [['input-positive', { answers: { deploy_target: { answers: ['Staging'] } } }]])
  assertStillRunning() // Sending an answer is not completion.
  await h.notify('serverRequest/resolved', { threadId: run.conversationId, requestId: 'input-positive' })
  assert.deepEqual(current().pendingUserInputs, [])
  assertStillRunning()
  await assert.rejects(h.chat.replyUserInput(reply), error => error.code === 'STALE_USER_INPUT')
  const item = { id: 'after-answer', type: 'commandExecution', status: 'inProgress', command: 'echo staging' }
  await h.item(run, item, false)
  await h.item(run, { ...item, status: 'completed', exitCode: 0 })
  assertStillRunning()
  await h.finish(run)
  assert.equal(current().status, 'completed')
  const lifecycle = h.events.filter(event => ['userInput.required', 'userInput.resolved', 'activity.started', 'activity.completed', 'run.completed'].includes(event.event))
  assert.deepEqual(lifecycle.map(event => event.event), ['userInput.required', 'userInput.resolved', 'activity.started', 'activity.completed', 'run.completed'])
  for (const event of lifecycle) assert.deepEqual(identity(event), identity(run))
  await assert.rejects(h.chat.replyUserInput(reply), error => error.code === 'STALE_USER_INPUT')
  assert.equal(h.replies.length, 1, 'late duplicates never send another answer')
  assert.deepEqual(h.calls.slice(callsBefore), [], 'question/answer/resolution/terminal add zero thread/start or turn/start requests')
})

test('skipped Agent question sends the native cancellation error and keeps the turn', async () => {
  const h = harness()
  const run = await h.chat.send({ message: 'Ask' })
  await ask(h, run, 'skip-1')
  const { userInputId } = pendingInput(h)
  const result = await h.chat.replyUserInput({ ...run, userInputId, action: 'skip', answers: [{ questionId: 'password', text: 'IGNORED_ON_SKIP' }] })
  assert.equal(result.status, 'replySent')
  assert.deepEqual(h.replies, [['skip-1', null, { code: -32000, message: 'User skipped the question' }]])
  assert.equal(h.chat.snapshot().runs[0].status, 'inProgress')
  assert.equal(h.calls.some(call => call.method === 'turn/interrupt'), false)
  assert.ok(!JSON.stringify([h.replies, h.events, h.chat.snapshot()]).includes('IGNORED_ON_SKIP'))
  await assert.rejects(h.chat.replyUserInput({ ...run, userInputId, action: 'skip' }), e => e.code === 'STALE_USER_INPUT')
})

test('private Agent answers reach only the native response, never events, legacy, snapshot or errors', async () => {
  const h = harness()
  const run = await h.chat.send({ message: 'Ask for a password' })
  await ask(h, run, 'secret-1')
  const { userInputId } = pendingInput(h)
  let failNative = true
  h.chat.nativeRespond = (...args) => {
    if (failNative) throw Object.assign(new Error('Codex app-server is offline'), { code: 'BRIDGE_OFFLINE', httpStatus: 503 })
    h.replies.push(args)
  }
  const answers = [{ questionId: 'deploy_target', optionIndex: 0 }, { questionId: 'password', text: 'PRIVATE_ANSWER_SENTINEL' }]
  await assert.rejects(h.chat.replyUserInput({ ...run, userInputId, action: 'submit', answers }), error => error.code === 'BRIDGE_OFFLINE' && !error.message.includes('PRIVATE_ANSWER_SENTINEL'))
  assert.equal(pendingInput(h).status, 'pending', 'a failed native send restores the card')
  failNative = false
  const result = await h.chat.replyUserInput({ ...run, userInputId, action: 'submit', answers })
  assert.ok(JSON.stringify(h.replies).includes('PRIVATE_ANSWER_SENTINEL'))
  await h.notify('serverRequest/resolved', { threadId: run.conversationId, requestId: 'secret-1' })
  await h.finish(run)
  const exposed = JSON.stringify([result, h.events, h.legacy, h.chat.snapshot(), [...h.chat.pendingUserInputs.values()]])
  assert.ok(!exposed.includes('PRIVATE_ANSWER_SENTINEL'))
})

test('bounded QA refuses Agent questions and any sub-Agent collaboration', async () => {
  const h = qaHarness()
  const run = await h.chat.send({ message: 'qa', executionPolicy: { mode: 'readOnlyQa' } })
  await ask(h, run, 'qa-ask')
  assert.deepEqual(h.replies, [['qa-ask', null, { code: -32601, message: 'Read-only QA has no interactive approval capability' }]])
  let state = h.chat.snapshot(run.conversationId).runs[0]
  assert.equal(state.error.code, 'QA_SCOPE_VIOLATION')
  assert.deepEqual(state.pendingUserInputs, [])
  assert.equal(h.events.some(event => event.event === 'userInput.required'), false)
  assert.equal(h.calls.filter(call => call.method === 'turn/interrupt').length, 1)
  h.chat.pendingUserInputs.set('forged', { userInputId: 'forged', conversationId: run.conversationId, runId: run.runId, status: 'pending', rpcId: 'forged-rpc',
    questions: [{ questionId: 'q', options: null, allowsOther: false, isSecret: false }], rawLabels: [null] })
  await assert.rejects(h.chat.replyUserInput({ ...run, userInputId: 'forged', action: 'submit', answers: [{ questionId: 'q', text: 'no' }] }), error => error.code === 'BOUNDED_INPUT_FORBIDDEN')
  assert.equal(h.replies.length, 1)

  const collab = qaHarness()
  const qa = await collab.chat.send({ message: 'qa', executionPolicy: { mode: 'readOnlyQa' } })
  const spawn = { id: 'qa-spawn', type: 'collabAgentToolCall', tool: 'spawnAgent', status: 'completed', receiverThreadIds: ['qa-child'], prompt: 'escape', agentsStates: { 'qa-child': { status: 'running' } } }
  await collab.item(qa, spawn, false)
  await collab.item(qa, spawn)
  state = collab.chat.snapshot(qa.conversationId).runs[0]
  assert.equal(state.error.code, 'QA_SCOPE_VIOLATION')
  assert.deepEqual(state.subAgents, [])
  assert.equal(state.activities.find(activity => activity.id === 'qa-spawn').kind, 'collabAgentToolCall')
  assert.equal(collab.calls.filter(call => call.method === 'turn/interrupt').length, 1, 'one violation interrupts once')
  assert.equal(collab.events.some(event => event.event === 'subagent.updated'), false)
  assert.equal(collab.calls.find(call => call.method === 'thread/start').params.config.features.default_mode_request_user_input, false)
})

test('unowned, foreign and finished runs never gain an Agent question callback', async () => {
  const resumed = harness({ request: async (method, params, chat) => {
    assert.equal(method, 'thread/resume')
    await ask({ chat }, { conversationId: params.threadId, runId: 'live-turn' }, 'resume-ask')
    return { thread: { id: params.threadId, turns: [{ id: 'live-turn', status: 'inProgress', items: [] }] } }
  } })
  const state = await resumed.chat.resume({ conversationId: 'resume-thread', clientThreadId: 'resume-ui' })
  assert.deepEqual(state.runs[0].pendingUserInputs, [])
  assert.deepEqual(resumed.replies[0], ['resume-ask', null, { code: -32601, message: 'No matching EG-Desk run' }])

  const h = harness()
  const run = await h.chat.send({ message: 'Owned' })
  await ask(h, { ...run, runId: 'foreign-turn' }, 'foreign-ask')
  await h.finish(run)
  await ask(h, run, 'late-ask')
  assert.deepEqual(h.replies.map(reply => [reply[0], reply[2].code]), [['foreign-ask', -32601], ['late-ask', -32601]])
  assert.equal(h.chat.pendingUserInputs.size, 0)
  assert.equal(h.events.some(event => event.event === 'userInput.required'), false)
})

test('Agent question IDs become stale after disconnect or account reset and are never replayed', async () => {
  const h = harness()
  const run = await h.chat.send({ message: 'Ask' })
  await ask(h, run, 9)
  const { userInputId } = pendingInput(h)
  h.chat.setConnection(false)
  assert.deepEqual(h.chat.snapshot().runs[0].pendingUserInputs, [])
  assert.ok(h.events.some(event => event.event === 'userInput.resolved' && event.details.userInputId === userInputId))
  h.chat.setConnection(true)
  // A native resend after reconnect is a new card in the new epoch, as with approvals.
  await ask(h, run, 9)
  assert.notEqual(pendingInput(h).userInputId, userInputId)
  const answers = [{ questionId: 'deploy_target', optionIndex: 0 }, { questionId: 'password', text: 'late' }]
  await assert.rejects(h.chat.replyUserInput({ ...run, userInputId, action: 'submit', answers }), e => e.code === 'STALE_USER_INPUT')
  await assert.rejects(h.chat.replyUserInput({ ...run, userInputId, action: 'skip' }), e => e.code === 'STALE_USER_INPUT')
  assert.deepEqual(h.replies, [], 'the old ID is never replayed as an answer')
  assert.equal(h.chat.snapshot().runs[0].status, 'unknown')

  const reset = harness()
  const second = await reset.chat.send({ message: 'Ask' })
  await ask(reset, second, 'reset-ask')
  const old = pendingInput(reset).userInputId
  reset.chat.reset()
  reset.chat.setConnection(true)
  await assert.rejects(reset.chat.replyUserInput({ ...second, userInputId: old, action: 'skip' }), e => e.code === 'STALE_USER_INPUT')
  assert.equal(reset.chat.pendingUserInputs.size, 0)
  assert.deepEqual(reset.replies, [])
})

test('malformed Agent questions are refused as invalid without a pending card', async () => {
  const h = harness()
  const run = await h.chat.send({ message: 'Ask' })
  const question = (extra = {}) => ({ id: 'q', header: 'H', question: 'Q?', options: null, ...extra })
  const option = (extra = {}) => ({ label: 'A', description: 'd', ...extra })
  const invalid = [
    'not-array', [], Array.from({ length: 9 }, (_, i) => question({ id: `q${i}` })),
    [question({ options: Array.from({ length: 13 }, (_, i) => option({ label: `L${i}` })) })],
    [question({ header: 'h'.repeat(201) })], [question({ question: 'q'.repeat(2001) })], [question({ question: '   ' })],
    [question(), question()], [question({ id: '' })], [question({ id: 7 })], [question({ id: 'x'.repeat(301) })],
    [question({ options: [option({ label: 'l'.repeat(201) })] })], [question({ options: [option({ description: 'd'.repeat(1001) })] })],
    [question({ options: [option({ label: '' })] })], [question({ options: [{ description: 'no label' }] })], [question({ options: 'A' })], [null],
  ]
  for (const [index, questions] of invalid.entries()) await ask(h, run, `bad-${index}`, { questions })
  assert.equal(h.replies.length, invalid.length)
  for (const [index, reply] of h.replies.entries()) assert.deepEqual(reply, [`bad-${index}`, null, { code: -32602, message: 'Invalid user input request' }])
  const state = h.chat.snapshot().runs[0]
  assert.equal(state.error.code, 'INVALID_USER_INPUT_REQUEST')
  assert.equal(state.status, 'inProgress')
  assert.deepEqual(state.pendingUserInputs, [])
  assert.equal(h.events.some(event => event.event === 'userInput.required'), false)
  assert.ok(h.events.some(event => event.event === 'run.unavailable' && event.details.error.code === 'INVALID_USER_INPUT_REQUEST'))

  await ask(h, run, 'max-ok', { questions: Array.from({ length: 8 }, (_, i) => question({ id: `ok${i}`, header: 'h'.repeat(200), question: 'q'.repeat(2000),
    options: Array.from({ length: 12 }, (_, j) => option({ label: 'l'.repeat(198) + String(j).padStart(2, '0'), description: 'd'.repeat(1000) })) })) })
  assert.equal(pendingInput(h).questions.length, 8)
  for (let i = 1; i < 100; i++) await ask(h, run, `fill-${i}`, { questions: [question()] })
  assert.equal(h.chat.pendingUserInputs.size, 100)
  await ask(h, run, 'over-capacity', { questions: [question()] })
  assert.deepEqual(h.replies.at(-1), ['over-capacity', null, { code: -32000, message: 'Too many pending user input requests' }])
  assert.equal(h.chat.snapshot().runs[0].pendingUserInputs.length, 100)
})

test('a finished turn clears non-blocking Agent questions and later answers are stale', async () => {
  const h = harness()
  const run = await h.chat.send({ message: 'Ask' })
  await ask(h, run, 'non-blocking', { isBlocking: false })
  const pending = pendingInput(h)
  assert.equal(pending.isBlocking, false)
  await h.finish(run)
  assert.deepEqual(h.chat.snapshot().runs[0].pendingUserInputs, [])
  assert.equal(h.chat.pendingUserInputs.size, 0)
  const order = h.events.filter(event => ['userInput.resolved', 'run.completed'].includes(event.event)).map(event => event.event)
  assert.deepEqual(order, ['userInput.resolved', 'run.completed'])
  await assert.rejects(h.chat.replyUserInput({ ...run, userInputId: pending.userInputId, action: 'skip' }), e => e.code === 'STALE_USER_INPUT')
  assert.deepEqual(h.replies, [])
})

test('MCP elicitation remains an explicit unsupported interaction', async () => {
  const h = harness()
  const run = await h.chat.send({ message: 'Work' })
  await h.chat.handleServerRequest({ id: 'elicit', method: 'mcpServer/elicitation/request', params: { threadId: run.conversationId, turnId: run.runId, message: 'Need input' } })
  assert.deepEqual(h.replies[0], ['elicit', null, { code: -32601, message: 'This interactive request is not supported by EG-Desk' }])
  assert.deepEqual(h.chat.snapshot().runs[0].pendingUserInputs, [])
})

test('an Agent question delivered before the turn/start response binds only to the returned run', async () => {
  const h = harness({ request: async (method, params, chat, defaults) => {
    if (method !== 'turn/start') return defaults(method, params)
    await ask({ chat }, { conversationId: params.threadId, runId: 'early-turn' }, 'early-ask')
    await ask({ chat }, { conversationId: params.threadId, runId: 'other-turn' }, 'other-ask')
    return { turn: { id: 'early-turn', status: 'inProgress', items: [] } }
  } })
  const run = await h.chat.send({ message: 'Early', requestId: 'early-request', clientThreadId: 'early-ui' })
  assert.equal(run.runId, 'early-turn')
  assert.equal(pendingInput(h).userInputId.endsWith(':string:early-ask'), true)
  assert.deepEqual(h.replies, [['other-ask', null, { code: -32601, message: 'No matching EG-Desk run' }]])
})

test('ordinary resume opts into Agent questions while bounded resume never does', async () => {
  const h = harness()
  await h.chat.resume({ conversationId: 'ordinary-thread' })
  assert.deepEqual(h.calls[0], { method: 'thread/resume', params: { threadId: 'ordinary-thread', config: { features: { default_mode_request_user_input: true } } } })

  const qa = qaHarness()
  const ordinary = await qa.chat.send({ message: 'ordinary' })
  await qa.finish(ordinary)
  await qa.chat.send({ message: 'qa', conversationId: ordinary.conversationId, executionPolicy: { mode: 'readOnlyQa' } })
  const resume = qa.calls.find(call => call.method === 'thread/resume').params
  assert.equal(resume.sandbox, 'read-only')
  assert.equal(resume.config.features.multi_agent, false)
  assert.equal(resume.config.features.default_mode_request_user_input, false)
})

const spawnItem = (extra = {}) => ({ id: 'spawn-1', type: 'collabAgentToolCall', tool: 'spawnAgent', status: 'completed', senderThreadId: 'parent',
  receiverThreadIds: ['child-1'], prompt: 'Research the change', model: 'gpt-child', reasoningEffort: 'high', agentsStates: { 'child-1': { status: 'pendingInit', message: null } }, ...extra })
const rows = h => h.chat.snapshot().runs[0].subAgents
const row = (h, threadId) => rows(h).find(candidate => candidate.threadId === threadId)

test('sub-Agent collaboration becomes bounded per-child rows without prompt text', async () => {
  const h = harness()
  const run = await h.chat.send({ message: 'Delegate' })
  const prompt = `PROMPT_START sk-PROMPTSECRET123 ${'x'.repeat(400)} PROMPT_TAIL_SENTINEL`
  await h.item(run, spawnItem({ status: 'inProgress', receiverThreadIds: [], agentsStates: {}, prompt }), false)
  assert.deepEqual(rows(h), [])
  assert.equal(h.chat.snapshot().runs[0].activities[0].status, 'inProgress')
  await h.item(run, spawnItem({ prompt }))
  let child = row(h, 'child-1')
  assert.deepEqual(Object.keys(child).sort(), ['blocked', 'label', 'lastTool', 'message', 'model', 'nativeStatus', 'nickname', 'parentEnded', 'recent', 'role', 'state', 'taskPreview', 'threadId', 'updatedAt', 'waitingOn'])
  assert.deepEqual([child.state, child.label, child.model, child.lastTool, child.blocked, child.parentEnded], ['starting', null, 'gpt-child', 'spawnAgent', null, false])
  assert.ok(child.taskPreview.startsWith('PROMPT_START [REDACTED]'))
  assert.ok(child.taskPreview.length <= 160)
  await h.item(run, { id: 'activity-1', type: 'subAgentActivity', agentThreadId: 'child-1', agentPath: 'researcher', kind: 'started', model: 'gpt-child' })
  assert.deepEqual([row(h, 'child-1').state, row(h, 'child-1').label], ['running', 'researcher'])
  await h.item(run, { id: 'wait-1', type: 'collabAgentToolCall', tool: 'wait', status: 'completed', receiverThreadIds: ['child-1'], agentsStates: { 'child-1': { status: 'completed', message: `Done: token=CHILD_MESSAGE_TOKEN ${'m'.repeat(600)}` } } })
  child = row(h, 'child-1')
  assert.deepEqual([child.state, child.lastTool, child.blocked], ['completed', 'wait', null])
  assert.ok(child.message.startsWith('Done: token=[REDACTED]'))
  assert.equal(child.message.length, 500)
  await h.item(run, spawnItem({ id: 'spawn-2', receiverThreadIds: ['child-2', 'child-3', 'child-4', 'child-5'], prompt: null, model: null,
    agentsStates: { 'child-2': { status: 'errored', message: 'boom' }, 'child-3': { status: 'notFound' }, 'child-4': { status: 'shutdown' }, 'child-5': { status: 'mystery' } } }))
  assert.deepEqual(['child-2', 'child-3', 'child-4', 'child-5'].map(id => [row(h, id).state, row(h, id).blocked]), [
    ['errored', { reason: 'errored' }], ['notFound', { reason: 'notFound' }], ['closed', null], ['unknown', null]])
  assert.equal(row(h, 'child-2').taskPreview, null)
  await h.item(run, { id: 'odd-tool', type: 'collabAgentToolCall', tool: 'rewriteHistory', status: 'weird', receiverThreadIds: [], agentsStates: [] })
  const activities = h.chat.snapshot().runs[0].activities
  assert.deepEqual(activities.find(activity => activity.id === 'odd-tool').detail, { tool: 'unknown', status: 'inProgress', receiverCount: 0, states: [] })
  assert.deepEqual(activities.find(activity => activity.id === 'spawn-1').detail, { tool: 'spawnAgent', status: 'completed', receiverCount: 1, states: ['starting'] })
  assert.equal(activities.find(activity => activity.id === 'activity-1').kind, 'subAgentActivity')
  const updates = h.events.filter(event => event.event === 'subagent.updated')
  assert.ok(updates.length >= 4)
  for (const event of updates) {
    assert.deepEqual(Object.keys(event.details), ['subAgent'])
    assert.equal(event.runId, run.runId)
  }
  assert.equal(updates.at(-1).details.subAgent.threadId, 'child-5')
  const exposed = JSON.stringify([h.events, h.chat.snapshot()])
  for (const hidden of ['PROMPT_TAIL_SENTINEL', 'PROMPTSECRET123', 'CHILD_MESSAGE_TOKEN', 'reasoningEffort', 'agentsStates']) assert.ok(!exposed.includes(hidden), hidden)
})

test('finished child state is not reopened by stale snapshots, only by resume-type signals', async () => {
  const h = harness()
  const run = await h.chat.send({ message: 'Delegate' })
  const collab = (id, tool, status, message = null) => h.item(run, { id, type: 'collabAgentToolCall', tool, status: 'completed', receiverThreadIds: ['child-1'], agentsStates: { 'child-1': { status, message } } })
  await h.item(run, spawnItem())
  await collab('wait-1', 'wait', 'completed', 'final words')
  await collab('wait-2', 'wait', 'running')
  assert.deepEqual([row(h, 'child-1').state, row(h, 'child-1').message], ['completed', 'final words'])
  await collab('list-1', 'listAgents', 'pendingInit')
  assert.equal(row(h, 'child-1').state, 'completed')
  await collab('send-1', 'sendInput', 'running')
  assert.deepEqual([row(h, 'child-1').state, row(h, 'child-1').message], ['running', null])
  await h.item(run, { id: 'a-1', type: 'subAgentActivity', agentThreadId: 'child-1', kind: 'completed' })
  await h.item(run, { id: 'a-2', type: 'subAgentActivity', agentThreadId: 'child-1', kind: 'interacted' })
  assert.equal(row(h, 'child-1').state, 'running')
  await h.item(run, { id: 'a-3', type: 'subAgentActivity', agentThreadId: 'child-1', kind: 'interrupted' })
  assert.equal(row(h, 'child-1').state, 'interrupted')
  await collab('resume-1', 'resumeAgent', 'running')
  assert.equal(row(h, 'child-1').state, 'running')
  await collab('close-1', 'closeAgent', 'shutdown')
  assert.equal(row(h, 'child-1').state, 'closed')
})

test('child Agent approval is refused without authority and marks only its parent row blocked', async () => {
  const h = harness()
  const run = await h.chat.send({ message: 'Delegate' })
  await h.item(run, spawnItem())
  await h.item(run, { id: 'a-1', type: 'subAgentActivity', agentThreadId: 'child-1', agentPath: 'researcher', kind: 'started' })
  const before = h.events.length
  await h.chat.handleServerRequest({ id: 'child-approval', method: 'item/commandExecution/requestApproval', params: { threadId: 'child-1', turnId: 'child-turn', itemId: 'cmd', command: 'rm -rf /tmp/x', availableDecisions: ['accept', 'decline'] } })
  assert.deepEqual(h.replies, [['child-approval', null, { code: -32601, message: 'No matching EG-Desk run' }]])
  assert.deepEqual(h.chat.snapshot().runs[0].pendingApprovals, [])
  assert.deepEqual([row(h, 'child-1').state, row(h, 'child-1').blocked], ['running', { reason: 'approvalRequested' }])
  assert.deepEqual(h.events.slice(before).map(event => [event.event, event.details.subAgent?.blocked?.reason]), [['subagent.updated', 'approvalRequested']])
  await ask(h, { conversationId: 'child-1', runId: 'child-turn' }, 'child-ask')
  await h.chat.handleServerRequest({ id: 'stranger-approval', method: 'item/fileChange/requestApproval', params: { threadId: 'stranger', turnId: 't', itemId: 'edit' } })
  assert.deepEqual(h.replies.slice(1).map(reply => [reply[0], reply[2].code]), [['child-ask', -32601], ['stranger-approval', -32601]])
  assert.equal(rows(h).length, 1)
  assert.equal(h.chat.pendingUserInputs.size, 0)
  await h.item(run, { id: 'wait-1', type: 'collabAgentToolCall', tool: 'wait', status: 'completed', receiverThreadIds: ['child-1'], agentsStates: { 'child-1': { status: 'running' } } })
  assert.deepEqual(row(h, 'child-1').blocked, { reason: 'approvalRequested' }, 'a running snapshot does not prove the stall ended')
  await h.item(run, { id: 'send-1', type: 'collabAgentToolCall', tool: 'sendInput', status: 'completed', receiverThreadIds: ['child-1'], agentsStates: { 'child-1': { status: 'running' } } })
  assert.equal(row(h, 'child-1').blocked, null)
})

test('child Agent thread events never create or finish an EG-Desk run', async () => {
  const h = harness()
  const run = await h.chat.send({ message: 'Delegate' })
  await h.item(run, spawnItem())
  await h.notify('item/completed', { threadId: 'child-1', turnId: 'child-turn', item: { id: 'child-answer', type: 'agentMessage', text: 'CHILD_PRIVATE_ANSWER' } })
  await h.notify('turn/completed', { threadId: 'child-1', turn: { id: 'child-turn', status: 'completed', items: [] } })
  const state = h.chat.snapshot()
  assert.equal(state.runs.length, 1)
  assert.equal(state.runs[0].status, 'inProgress')
  assert.ok(!JSON.stringify([h.events, state]).includes('CHILD_PRIVATE_ANSWER'))
})

test('resumed history rebuilds sub-Agent rows silently with the same sanitizer', async () => {
  const h = harness({ request: async (method, params) => ({ cwd: '/work', thread: { id: params.threadId, turns: [{ id: 'old-turn', status: 'inProgress', items: [
    spawnItem({ prompt: `History prompt ${'y'.repeat(300)} HISTORY_PROMPT_TAIL`, agentsStates: { 'child-1': { status: 'running', message: 'api_key=HISTORY_KEY' } } }),
    { id: 'history-activity', type: 'subAgentActivity', agentThreadId: 'child-1', agentPath: 'historian', kind: 'interacted' },
  ] }] } }) })
  const state = await h.chat.resume({ conversationId: 'old', clientThreadId: 'old-ui' })
  assert.deepEqual(state.runs[0].subAgents.map(child => [child.threadId, child.state, child.label]), [['child-1', 'running', 'historian']])
  assert.equal(h.events.length, 0)
  const json = JSON.stringify(state)
  for (const hidden of ['HISTORY_PROMPT_TAIL', 'HISTORY_KEY']) assert.ok(!json.includes(hidden), hidden)
})

test('sub-Agent rows are capped and lose certainty on disconnect, even after the parent turn ended', async () => {
  const h = harness()
  const run = await h.chat.send({ message: 'Delegate' })
  const children = Array.from({ length: 40 }, (_, i) => `child-${i}`)
  await h.item(run, spawnItem({ receiverThreadIds: children, agentsStates: Object.fromEntries(children.map(id => [id, { status: 'running' }])) }))
  assert.equal(rows(h).length, 32)
  assert.equal(h.chat.snapshot().runs[0].truncated, true)
  await h.item(run, { id: 'a-new', type: 'subAgentActivity', agentThreadId: 'child-new', kind: 'started' })
  assert.equal(row(h, 'child-new'), undefined)
  await h.item(run, { id: 'wait-1', type: 'collabAgentToolCall', tool: 'wait', status: 'completed', receiverThreadIds: ['child-0'], agentsStates: { 'child-0': { status: 'completed' } } })
  await h.finish(run)
  assert.ok(rows(h).every(child => child.parentEnded === true))
  assert.deepEqual([row(h, 'child-0').state, row(h, 'child-1').state], ['completed', 'running'], 'the parent ending does not invent child outcomes')
  const before = h.events.length
  h.chat.setConnection(false)
  assert.deepEqual([row(h, 'child-0').state, row(h, 'child-1').state, row(h, 'child-31').state], ['completed', 'unknown', 'unknown'])
  const changed = h.events.slice(before).filter(event => event.event === 'subagent.updated')
  assert.equal(changed.length, 31)
  assert.equal(h.chat.snapshot().runs[0].status, 'completed')
})

test('real SQLite store keeps Agent questions and child rows durable without answers or poisoned keys', async () => {
  const dataDir = createPrivateQaTempDirectory('egdesk-runtime-input-')
  let store = null
  try {
    store = openChatStore({ dataDir, ownerScope: 'local-desktop-test' })
    const replies = [], events = []
    const chat = new CodexChatRuntime({
      store, requireStore: true, getOwnerKey: () => 'codex:chatgpt:account-1', emit: event => events.push(event),
      request: async method => {
        if (method === 'thread/start') return { thread: { id: 'native-1' }, cwd: '/safe/work' }
        if (method === 'turn/start') return { turn: { id: 'turn-1', status: 'inProgress', items: [] } }
        throw new Error(`Unexpected native call: ${method}`)
      }, respond: (...args) => replies.push(args),
    })
    chat.setConnection(true)
    const run = await chat.send({ message: 'Ask me', clientThreadId: 'ui-1', requestId: 'req-1' })
    await chat.handleServerRequest({ id: 'ask-1', method: USER_INPUT, params: { threadId: 'native-1', turnId: 'turn-1', itemId: 'ask', isBlocking: true, questions: [
      { id: 'password', header: 'Password', question: 'Deploy password?', isSecret: true, options: null },
      { id: 'secret', header: 'Secret', question: 'Pick one', options: [{ label: 'A', description: '' }] },
      { id: 'api_key', header: 'Key', question: 'Note?', options: null },
    ] } })
    await chat.handleNotification({ method: 'item/completed', params: { threadId: 'native-1', turnId: 'turn-1', item: spawnItem({
      receiverThreadIds: ['password', 'secret'], agentsStates: { password: { status: 'running' }, secret: { status: 'pendingInit' } } }) } })
    const { userInputId } = chat.snapshot().runs[0].pendingUserInputs[0]
    await chat.replyUserInput({ ...run, userInputId, action: 'submit', answers: [
      { questionId: 'password', text: '  SQLITE_SECRET_ANSWER  ' }, { questionId: 'secret', optionIndex: 0 }, { questionId: 'api_key', text: ' SQLITE_PLAIN_ANSWER ' },
    ] })
    assert.deepEqual(replies, [['ask-1', { answers: { password: { answers: ['  SQLITE_SECRET_ANSWER  '] }, secret: { answers: ['A'] }, api_key: { answers: ['SQLITE_PLAIN_ANSWER'] } } }]])
    assert.equal(chat.storeHealthy, true, 'model-chosen IDs named like private keys must not poison the store')
    assert.ok(events.length > 0 && events.every(event => event.durable === true))
    const history = chat.getLocalHistory({ clientThreadId: 'ui-1', limit: 500 })
    assert.deepEqual(history.runs[0].pendingUserInputs[0].questions.map(q => q.questionId), ['password', 'secret', 'api_key'])
    assert.deepEqual(history.runs[0].subAgents.map(child => [child.threadId, child.state]), [['password', 'running'], ['secret', 'starting']])
    const stored = []
    for (const name of await readdir(dataDir, { recursive: true })) {
      try { stored.push(await readFile(path.join(dataDir, name))) } catch {}
    }
    assert.ok(stored.length > 0)
    for (const hidden of ['SQLITE_SECRET_ANSWER', 'SQLITE_PLAIN_ANSWER']) {
      assert.ok(!JSON.stringify([history, events, chat.snapshot()]).includes(hidden), hidden)
      assert.ok(!stored.some(buffer => buffer.includes(hidden)), `${hidden} on disk`)
    }
    store.close(); store = null
    store = openChatStore({ dataDir, ownerScope: 'local-desktop-test' })
    const restarted = new CodexChatRuntime({ store, requireStore: true, getOwnerKey: () => 'codex:chatgpt:account-1',
      request: async () => { throw new Error('Recovery must not call native') }, respond: () => {} })
    assert.equal(restarted.recoverInterruptedRuns(), 1)
    const recovered = restarted.getLocalHistory({ clientThreadId: 'ui-1', limit: 500 }).runs[0]
    assert.equal(recovered.status, 'unknown')
    assert.deepEqual(recovered.pendingUserInputs, [])
    assert.deepEqual(recovered.subAgents.map(child => child.state), ['unknown', 'unknown'])
  } finally {
    try { store?.close() } catch {}
    await rm(dataDir, { recursive: true, force: true })
  }
})
