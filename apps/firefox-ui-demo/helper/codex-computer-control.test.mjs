import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { readFile, rm } from 'node:fs/promises'
import { CodexChatRuntime } from './codex-chat-runtime.mjs'
import { openChatStore } from './egdesk-chat-store.mjs'
import { createPrivateQaTempDirectory } from '../scripts/egdesk-qa-platform.mjs'
import { createComputerControlHttpHandler } from './codex-bridge-http.mjs'
import {
  COMPUTER_CONTROL_FEATURES, COMPUTER_CONTROL_POLICIES, DEFAULT_COMPUTER_CONTROL_POLICY,
  loadComputerControlOffOverrides, normalizeComputerControlPolicy, verifyComputerControlOff,
} from './codex-computer-control.mjs'

// CU-01 stage 1: computer control on ordinary Codex threads, inherited or off.
const COMPUTER_PLUGIN = 'unified-computer-use@openai-bundled'
// The inventory Codex 0.162.1 listed on this Mac (CU doc 2.2), trimmed:
// the computer-use plugin, a harmless plugin, app-provided connectors, and the
// user's direct servers (node_repl declared with the Sky service path).
const listed = (extra = {}) => [
  { name: 'cua_repl', pluginId: COMPUTER_PLUGIN, tools: { js: {}, js_reset: {}, turn_ended: {} } },
  { name: 'code-review', pluginId: 'code-review@openai-bundled', tools: {} },
  { name: 'browser-helper', pluginId: 'browser-helper@acme', tools: { browser_navigate: {} } },
  { name: 'codex_apps', tools: { slack_send_message: {}, drive_search: {} } },
  { name: 'computer-use', tools: {} },
  { name: 'node_repl', tools: { js: {}, js_reset: {} } },
  { name: 'firefox-devtools', tools: { navigate_page: {} } },
  { name: 'context7', tools: { 'query-docs': {} } },
].map(server => ({ resources: [], resourceTemplates: [], toolsError: null, ...server, ...(extra[server.name] || {}) }))
const DIRECT = {
  'computer-use': { command: '/x/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient', args: ['mcp'] },
  node_repl: { command: '/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node', args: ['/x/repl.js'], env: { SKY_CUA_SERVICE_PATH: '/x/SkyComputerUseService', API_KEY: 'SECRET-ENV' } },
  'firefox-devtools': { command: 'npx', args: ['firefox-devtools-mcp'] },
  context7: { url: 'https://mcp.context7.example/mcp' },
  // Declared but not started, so not in the inventory.
  'desktop-commander': { command: 'npx', args: ['desktop-commander'] },
}

// A native fake whose thread catalog and feature switches follow the thread
// settings, like Codex: a turned-off plugin's server is gone from the thread;
// a turned-off direct server is listed disabled without tools.
function native({ custom } = {}) {
  const calls = []
  const threadConfig = new Map()
  let threads = 0, turns = 0
  const features = config => ({ data: ['browser_use', 'browser_use_external', 'computer_use', 'default_mode_request_user_input']
    .map(name => ({ name, enabled: config?.features?.[name] ?? true, stage: 'stable' })), nextCursor: null })
  const defaults = async (method, params) => {
    if (method === 'thread/start') { const id = `thread-${++threads}`; threadConfig.set(id, params.config || {}); return { thread: { id }, cwd: '/work' } }
    if (method === 'thread/resume') { threadConfig.set(params.threadId, params.config || {}); return { thread: { id: params.threadId, turns: [] }, cwd: '/work' } }
    if (method === 'thread/unsubscribe') return { status: 'unsubscribed' }
    if (method === 'turn/start') return { turn: { id: `turn-${++turns}`, status: 'inProgress', items: [] } }
    if (method === 'turn/interrupt') return {}
    if (method === 'config/read') return { config: {}, layers: [{ name: { type: 'user' }, config: { mcp_servers: DIRECT } }] }
    if (method === 'experimentalFeature/list') return features(threadConfig.get(params.threadId))
    if (method === 'mcpServerStatus/list') {
      const config = params.threadId ? threadConfig.get(params.threadId) || {} : null
      const data = []
      for (const server of listed()) {
        if (config && server.pluginId && config.plugins?.[server.pluginId]?.enabled === false) continue
        const off = config && !server.pluginId && config.mcp_servers?.[server.name]?.enabled === false
        data.push({ ...server, tools: off ? {} : server.tools, ...(config ? { runtimeStatus: off ? 'disabled' : 'connected' } : {}) })
      }
      return { data, nextCursor: null }
    }
    throw new Error(`Unexpected method: ${method}`)
  }
  const request = async (method, params) => {
    calls.push({ method, params })
    const answer = custom ? await custom(method, params) : undefined
    return answer !== undefined ? answer : defaults(method, params)
  }
  return { calls, request, threadConfig }
}

function runtime({ policy, custom, mcpServerKind, now, store, computerControlStore } = {}) {
  const fake = native({ custom })
  const events = [], changes = []
  const chat = new CodexChatRuntime({
    request: fake.request, respond: () => {}, emit: event => events.push(event), verifyFile: async () => null,
    ...(policy ? { computerControlPolicy: policy } : {}),
    ...(mcpServerKind ? { mcpServerKind } : {}),
    ...(now ? { now } : {}),
    ...(store ? { store, requireStore: true, getOwnerKey: () => 'email:owner@example.com' } : {}),
    ...(computerControlStore ? { computerControlStore } : {}),
    onComputerControlChange: value => changes.push(value),
  })
  chat.setConnection(true)
  const finish = run => chat.handleNotification({ method: 'turn/completed', params: { threadId: run.conversationId, turn: { id: run.runId, status: 'completed', items: [] } } })
  const methods = () => fake.calls.map(call => call.method)
  return { chat, events, changes, finish, methods, ...fake }
}

test('the policy is inherit by default, only inherit or off is accepted, and off leaves browser_use alone', () => {
  assert.deepEqual(COMPUTER_CONTROL_POLICIES, ['inherit', 'off'])
  assert.equal(DEFAULT_COMPUTER_CONTROL_POLICY, 'inherit')
  assert.deepEqual(COMPUTER_CONTROL_FEATURES, ['computer_use', 'browser_use_external'])
  for (const value of ['inherit', 'off']) assert.equal(normalizeComputerControlPolicy(value), value)
  for (const value of [undefined, null, '', 'OFF', 'on', true, {}]) {
    assert.throws(() => normalizeComputerControlPolicy(value), error => error.code === 'INVALID_COMPUTER_CONTROL_POLICY' && error.httpStatus === 400)
  }
  assert.throws(() => new CodexChatRuntime({ request: async () => ({}), respond: () => {}, computerControlPolicy: 'sometimes' }), error => error.code === 'INVALID_COMPUTER_CONTROL_POLICY')
})

test('off turns off browser/desktop plugins by id, desktop direct servers (by name or a Computer Use marker) and the two Codex switches', async () => {
  const fake = native()
  const { overrides, plan } = await loadComputerControlOffOverrides(fake.request, { cwd: '/work' })
  assert.deepEqual(fake.calls.map(call => [call.method, call.params]), [
    ['mcpServerStatus/list', { limit: 100 }],
    ['config/read', { includeLayers: true, cwd: '/work' }],
  ])
  assert.deepEqual(Object.keys(overrides), ['config'])
  assert.deepEqual(overrides.config.features, { computer_use: false, browser_use_external: false })
  assert.equal(Object.hasOwn(overrides.config.features, 'browser_use'), false)
  assert.deepEqual({ ...overrides.config.plugins }, { [COMPUTER_PLUGIN]: { enabled: false }, 'browser-helper@acme': { enabled: false } })
  // node_repl drives the Mac through the Sky service; firefox-devtools (browser)
  // and context7 stay; codex_apps has no declaration to turn off.
  assert.deepEqual({ ...overrides.config.mcp_servers }, { 'computer-use': { enabled: false }, node_repl: { enabled: false }, 'desktop-commander': { enabled: false } })
  assert.deepEqual([...plan.computerUse], ['computer-use', 'node_repl'])
  assert.doesNotMatch(JSON.stringify(overrides), /SECRET|cua_node|SKY_CUA|npx|context7\.example/)
  // Nothing to turn off: only the switches.
  const bare = await loadComputerControlOffOverrides(async method => method === 'config/read'
    ? { config: {}, layers: [] } : { data: [{ name: 'context7', tools: {}, resources: [], resourceTemplates: [], toolsError: null }], nextCursor: null })
  assert.deepEqual(bare.overrides, { config: { features: { computer_use: false, browser_use_external: false } } })
  // An unreadable inventory or configuration refuses before any thread.
  for (const failing of ['mcpServerStatus/list', 'config/read']) {
    const broken = native({ custom: async method => { if (method === failing) throw new Error('offline: /Users/private/.codex/config.toml') } })
    await assert.rejects(loadComputerControlOffOverrides(broken.request), error => error.code === 'COMPUTER_CONTROL_UNVERIFIED' && error.httpStatus === 502 && !/private/.test(error.message))
  }
})

test('the thread readback accepts only a thread with no computer-control server live and both switches off', async () => {
  const fake = native()
  const { overrides, plan } = await loadComputerControlOffOverrides(fake.request)
  fake.threadConfig.set('t-off', overrides.config)
  assert.deepEqual(await verifyComputerControlOff(fake.request, 't-off', plan), { nativeFeatures: 'verified' })
  const thread = (servers, features = { computer_use: false, browser_use_external: false }) => async (method, params) => {
    if (method === 'mcpServerStatus/list') return { data: servers.map(server => ({ resources: [], resourceTemplates: [], toolsError: null, ...server })), nextCursor: null }
    if (method === 'experimentalFeature/list') return { data: Object.entries(features).map(([name, enabled]) => ({ name, enabled, stage: 'stable' })), nextCursor: null }
    throw new Error(`unexpected ${method} ${params}`)
  }
  const refused = [
    // Codex kept the plugin's server running despite the switch.
    thread([{ name: 'cua_repl', pluginId: COMPUTER_PLUGIN, tools: { js: {} }, runtimeStatus: 'connected' }]),
    thread([{ name: 'cua_repl', pluginId: COMPUTER_PLUGIN, tools: {}, runtimeStatus: 'starting' }]),
    // A marked direct server is still connected.
    thread([{ name: 'node_repl', tools: { js: {} }, runtimeStatus: 'connected' }]),
    // A desktop server from somewhere EG-Desk cannot turn off is still live.
    thread([{ name: 'desktop-bridge', tools: { left_click: {} }, runtimeStatus: 'connected' }]),
    // A switch is still on, or not reported at all.
    thread([], { computer_use: false, browser_use_external: true }),
    thread([], { computer_use: false }),
    async method => { if (method === 'mcpServerStatus/list') throw new Error('lost'); return thread([])(method) },
    async method => { if (method === 'experimentalFeature/list') throw Object.assign(new Error('thread not found'), { code: -32600 }); return thread([])(method) },
  ]
  for (const request of refused) {
    await assert.rejects(verifyComputerControlOff(request, 't', plan), error => error.code === 'COMPUTER_CONTROL_UNVERIFIED' && error.httpStatus === 502 && /no turn was started/.test(error.message))
  }
  // Disabled servers, browser servers and harmless plugins pass.
  assert.deepEqual(await verifyComputerControlOff(thread([
    { name: 'node_repl', tools: {}, runtimeStatus: 'disabled' }, { name: 'firefox-devtools', tools: { navigate_page: {} }, runtimeStatus: 'connected' },
    { name: 'code-review', pluginId: 'code-review@openai-bundled', tools: {}, runtimeStatus: 'disabled' }, { name: 'codex_apps', tools: { slack_send_message: {} }, runtimeStatus: 'connected' },
  ]), 't', plan), { nativeFeatures: 'verified' })
  // A Codex build that cannot report thread features: the MCP check still ran.
  const absent = async (method, params) => {
    if (method === 'experimentalFeature/list') throw Object.assign(new Error('Invalid request: unknown variant `experimentalFeature/list`'), { code: -32600 })
    return thread([])(method, params)
  }
  assert.deepEqual(await verifyComputerControlOff(absent, 't', plan), { nativeFeatures: 'unavailable' })
})

test('inherit sends exactly what it sent before: no extra reads, no extra settings, no reload', async () => {
  const baseline = runtime()
  const inherit = runtime({ policy: 'inherit' })
  for (const h of [baseline, inherit]) {
    const run = await h.chat.send({ message: 'Hi', requestId: 'r-1' })
    await h.finish(run)
    await h.chat.send({ message: 'Again', requestId: 'r-2', conversationId: run.conversationId })
  }
  assert.deepEqual(inherit.calls, baseline.calls)
  assert.deepEqual(inherit.methods(), ['thread/start', 'turn/start', 'turn/start'])
  assert.deepEqual(inherit.calls[0].params.config, { features: { default_mode_request_user_input: true } })
  assert.deepEqual(inherit.chat.computerControlSnapshot(), { policy: 'inherit', verified: null })
  assert.deepEqual(inherit.changes, [])
})

test('off starts an ordinary thread with computer control off and reads it back before the turn', async () => {
  const h = runtime({ policy: 'off' })
  const run = await h.chat.send({ message: 'Hi', requestId: 'r-1', cwd: '/work' })
  const start = h.calls.find(call => call.method === 'thread/start').params
  assert.deepEqual(start.config.features, { default_mode_request_user_input: true, computer_use: false, browser_use_external: false })
  assert.deepEqual({ ...start.config.plugins }, { [COMPUTER_PLUGIN]: { enabled: false }, 'browser-helper@acme': { enabled: false } })
  assert.deepEqual(Object.keys(start.config.mcp_servers), ['computer-use', 'node_repl', 'desktop-commander'])
  const at = method => h.calls.findIndex(call => call.method === method && call.params.threadId === run.conversationId)
  const turnAt = h.methods().indexOf('turn/start')
  assert.ok(h.methods().indexOf('config/read') < h.methods().indexOf('thread/start'))
  for (const method of ['mcpServerStatus/list', 'experimentalFeature/list']) assert.ok(at(method) > h.methods().indexOf('thread/start') && at(method) < turnAt, method)
  assert.deepEqual(h.chat.computerControlSnapshot(), { policy: 'off', verified: true })
  assert.deepEqual(h.changes, [{ policy: 'off', verified: true }])
  // The verified thread is not reloaded for the next send.
  await h.finish(run)
  const before = h.calls.length
  await h.chat.send({ message: 'Again', requestId: 'r-2', conversationId: run.conversationId })
  assert.deepEqual(h.calls.slice(before).map(call => call.method), ['turn/start'])
})

test('off refuses the turn when the thread does not read back as off, and records it as unconfirmed', async () => {
  const cases = [
    async (method, params) => method === 'mcpServerStatus/list' && params.threadId
      ? { data: [{ name: 'cua_repl', pluginId: COMPUTER_PLUGIN, tools: { js: {} }, resources: [], resourceTemplates: [], toolsError: null, runtimeStatus: 'connected' }], nextCursor: null } : undefined,
    async (method, params) => method === 'experimentalFeature/list' && params.threadId
      ? { data: [{ name: 'computer_use', enabled: true }, { name: 'browser_use_external', enabled: false }], nextCursor: null } : undefined,
  ]
  for (const custom of cases) {
    const h = runtime({ policy: 'off', custom })
    await assert.rejects(h.chat.send({ message: 'Hi', requestId: 'r-1' }), error => error.code === 'COMPUTER_CONTROL_UNVERIFIED' && error.httpStatus === 502)
    assert.equal(h.methods().includes('turn/start'), false)
    assert.deepEqual(h.chat.computerControlSnapshot(), { policy: 'off', verified: false })
  }
  // An unreadable configuration refuses before any thread is started.
  const h = runtime({ policy: 'off', custom: async method => { if (method === 'config/read') throw new Error('offline') } })
  await assert.rejects(h.chat.send({ message: 'Hi', requestId: 'r-1' }), error => error.code === 'COMPUTER_CONTROL_UNVERIFIED')
  assert.equal(h.methods().includes('thread/start'), false)
  assert.equal(h.chat.computerControlSnapshot().verified, false)
  // A build without thread feature reporting runs on the MCP check, unconfirmed.
  const old = runtime({ policy: 'off', custom: async method => {
    if (method === 'experimentalFeature/list') throw Object.assign(new Error('Invalid request: unknown variant `experimentalFeature/list`'), { code: -32600 })
  } })
  await old.chat.send({ message: 'Hi', requestId: 'r-1' })
  assert.equal(old.methods().includes('turn/start'), true)
  assert.deepEqual(old.chat.computerControlSnapshot(), { policy: 'off', verified: null })
})

test('a policy change reloads a loaded thread on its next send: off applies and is read back, inherit drops it', async () => {
  const h = runtime()
  const run = await h.chat.send({ message: 'Hi', requestId: 'r-1' })
  await h.finish(run)
  assert.deepEqual(h.chat.setComputerControlPolicy('off'), { policy: 'off', verified: null })
  assert.deepEqual(h.chat.setComputerControlPolicy('off'), { policy: 'off', verified: null }, 'the same value is not a change')
  let before = h.calls.length
  const second = await h.chat.send({ message: 'Again', requestId: 'r-2', conversationId: run.conversationId })
  const offCalls = h.calls.slice(before)
  assert.deepEqual(offCalls.map(call => call.method).filter(method => ['thread/unsubscribe', 'thread/resume', 'turn/start'].includes(method)), ['thread/unsubscribe', 'thread/resume', 'turn/start'])
  const resumed = offCalls.find(call => call.method === 'thread/resume').params
  assert.deepEqual(resumed.config.features, { computer_use: false, browser_use_external: false, default_mode_request_user_input: true })
  assert.equal(resumed.config.plugins[COMPUTER_PLUGIN].enabled, false)
  const resumeAt = offCalls.findIndex(call => call.method === 'thread/resume')
  assert.ok(offCalls.findIndex(call => call.method === 'experimentalFeature/list') > resumeAt)
  assert.deepEqual(h.chat.computerControlSnapshot(), { policy: 'off', verified: true })
  await h.finish(second)
  // Viewing the conversation again (resume) loads it with the user's settings;
  // the next send under off reloads it with them off again.
  await h.chat.resume({ conversationId: run.conversationId })
  before = h.calls.length
  const third = await h.chat.send({ message: 'Third', requestId: 'r-3', conversationId: run.conversationId })
  assert.ok(h.calls.slice(before).some(call => call.method === 'thread/unsubscribe'))
  await h.finish(third)
  // Back to inherit: one reload without the off settings, then none.
  h.chat.setComputerControlPolicy('inherit')
  before = h.calls.length
  const fourth = await h.chat.send({ message: 'Fourth', requestId: 'r-4', conversationId: run.conversationId })
  const inheritCalls = h.calls.slice(before)
  assert.deepEqual(inheritCalls.map(call => call.method), ['thread/unsubscribe', 'thread/resume', 'turn/start'])
  assert.deepEqual(inheritCalls[1].params.config, { features: { default_mode_request_user_input: true } })
  await h.finish(fourth)
  before = h.calls.length
  await h.chat.send({ message: 'Fifth', requestId: 'r-5', conversationId: run.conversationId })
  assert.deepEqual(h.calls.slice(before).map(call => call.method), ['turn/start'])
  assert.deepEqual(h.changes.map(change => change.policy + ':' + change.verified), ['off:null', 'off:true', 'inherit:null'])
})

test('bounded QA threads are not touched by the off policy', async () => {
  const h = runtime({ policy: 'off', custom: async (method, params) => {
    if (method === 'thread/start') return { thread: { id: 'qa-thread' }, cwd: '/work', sandbox: { type: 'readOnly', networkAccess: false }, approvalPolicy: 'never' }
    if (method === 'mcpServerStatus/list' && params.threadId) return { data: [], nextCursor: null }
    if (method === 'experimentalFeature/list') return { data: ['browser_use', 'browser_use_external', 'computer_use'].map(name => ({ name, enabled: false })), nextCursor: null }
  } })
  await h.chat.send({ message: 'Read', requestId: 'qa-1', executionPolicy: { mode: 'readOnlyQa' } })
  assert.equal(h.methods().filter(method => method === 'config/read').length, 1, 'only the QA isolation read')
  assert.deepEqual(h.chat.computerControlSnapshot(), { policy: 'off', verified: null })
})

test('an MCP tool call row says what its server can control, never its plugin id, arguments, result or images', async () => {
  const kinds = { node_repl: 'desktop', 'playwright-electron': 'browser', drive: 'other' }
  const h = runtime({ mcpServerKind: name => kinds[name] ?? null })
  const run = await h.chat.send({ message: 'Hi', requestId: 'r-1' })
  const call = (id, server, extra = {}) => h.chat.handleNotification({ method: 'item/completed', params: { threadId: run.conversationId, turnId: run.runId, item: {
    id, type: 'mcpToolCall', server, tool: 'js', status: 'completed', durationMs: 5,
    arguments: { code: 'await cua.click("ARGUMENT_SENTINEL")' }, result: { content: [{ type: 'image', data: 'IMAGE_SENTINEL' }, { type: 'text', text: 'RESULT_SENTINEL' }] }, ...extra,
  } } })
  await call('cua', 'cua_repl', { pluginId: COMPUTER_PLUGIN })
  await call('repl', 'node_repl')
  await call('pw', 'playwright-electron')
  await call('plugin-only', 'helper', { pluginId: 'unified-computer-use@openai-bundled' })
  await call('drive', 'drive')
  await call('unlisted', 'jupyter')
  const rows = h.chat.snapshot().runs[0].activities.filter(activity => activity.kind === 'mcpToolCall')
  assert.deepEqual(rows.map(row => [row.id, row.detail.controlKind]), [
    ['cua', 'computer'], ['repl', 'computer'], ['pw', 'browser'], ['plugin-only', 'computer'], ['drive', 'other'], ['unlisted', 'repl'],
  ])
  assert.deepEqual(Object.keys(rows[0].detail), ['server', 'tool', 'durationMs', 'controlKind', 'status', 'argumentsBytes', 'resultImageCount', 'resultTextBytes'])
  // A computer-control call reads as 컴퓨터 조작; the server's name stays in detail.
  assert.equal(rows[0].title, '컴퓨터 조작 · js')
  assert.equal(rows[0].detail.server, 'cua_repl')
  assert.equal(rows.find(row => row.id === 'pw').title, 'playwright-electron / js')
  assert.equal(rows.find(row => row.id === 'drive').title, 'drive / js')
  const exposed = JSON.stringify([h.events, h.chat.snapshot()])
  for (const hidden of ['ARGUMENT_SENTINEL', 'IMAGE_SENTINEL', 'RESULT_SENTINEL', COMPUTER_PLUGIN]) assert.ok(!exposed.includes(hidden), hidden)
  // Without the inherited lookup node_repl reads as a REPL; a failing lookup changes nothing.
  for (const mcpServerKind of [undefined, () => { throw new Error('not ready') }]) {
    const plain = runtime({ mcpServerKind })
    const other = await plain.chat.send({ message: 'Hi', requestId: 'r-1' })
    await plain.chat.handleNotification({ method: 'item/completed', params: { threadId: other.conversationId, turnId: other.runId, item: { id: 'repl', type: 'mcpToolCall', server: 'node_repl', tool: 'js', status: 'completed' } } })
    assert.equal(plain.chat.snapshot().runs[0].activities.find(row => row.id === 'repl').detail.controlKind, 'repl')
  }
})

// CU-01 Q1 (다): computer control stays on, and its use is shown instead.
const mcpItem = (run, id, server, status, extra = {}) => ({
  method: status === 'inProgress' ? 'item/started' : 'item/completed',
  params: { threadId: run.conversationId, turnId: run.runId, item: { id, type: 'mcpToolCall', server, tool: 'js', status, ...(server === 'cua_repl' ? { pluginId: COMPUTER_PLUGIN } : {}), ...extra } },
})

test('an MCP call keeps sizes only: argument bytes, result images and result text bytes, never the content', async () => {
  const h = runtime()
  const run = await h.chat.send({ message: 'Hi', requestId: 'r-1' })
  const args = { code: 'await cua.type("ARGUMENT_SENTINEL 한글")' }
  const text = 'RESULT_SENTINEL 화면 설명'
  const result = { content: [
    { type: 'image', data: 'IMAGE_SENTINEL', mimeType: 'image/png' },
    { type: 'text', text },
    { type: 'resource', resource: { uri: 'file:///RESOURCE_SENTINEL.png', mimeType: 'image/png', blob: 'BLOB_SENTINEL' } },
    { type: 'text', text: 'second' },
  ], structuredContent: { note: 'STRUCTURED_SENTINEL' } }
  const row = id => h.chat.snapshot().runs[0].activities.find(activity => activity.id === id)
  await h.chat.handleNotification(mcpItem(run, 'cua-1', 'cua_repl', 'inProgress', { arguments: args }))
  const argumentsBytes = Buffer.byteLength(JSON.stringify(args))
  assert.deepEqual(row('cua-1').detail, { server: 'cua_repl', tool: 'js', durationMs: null, controlKind: 'computer', status: 'inProgress', argumentsBytes, resultImageCount: null, resultTextBytes: null })
  await h.chat.handleNotification(mcpItem(run, 'cua-1', 'cua_repl', 'completed', { arguments: args, result, durationMs: 42 }))
  assert.deepEqual(row('cua-1').detail, { server: 'cua_repl', tool: 'js', durationMs: 42, controlKind: 'computer', status: 'completed', argumentsBytes, resultImageCount: 2, resultTextBytes: Buffer.byteLength(text) + Buffer.byteLength('second') })
  assert.equal(row('cua-1').status, 'completed')
  // A failed call without arguments or a result reports neither; its error text stays out.
  await h.chat.handleNotification(mcpItem(run, 'drive-1', 'drive', 'failed', { error: { message: 'ERROR_SENTINEL' } }))
  assert.deepEqual(row('drive-1').detail, { server: 'drive', tool: 'js', durationMs: null, controlKind: 'other', status: 'failed', argumentsBytes: null, resultImageCount: null, resultTextBytes: null })
  const exposed = JSON.stringify([h.events, h.chat.snapshot()])
  for (const hidden of ['ARGUMENT_SENTINEL', 'RESULT_SENTINEL', 'IMAGE_SENTINEL', 'RESOURCE_SENTINEL', 'BLOB_SENTINEL', 'STRUCTURED_SENTINEL', 'ERROR_SENTINEL', '한글', '화면 설명', COMPUTER_PLUGIN]) assert.ok(!exposed.includes(hidden), hidden)
})

test('run.computerUse counts each computer-control call once and is active only while one is in progress', async () => {
  let clock = 1000
  const h = runtime({ mcpServerKind: name => (name === 'node_repl' ? 'desktop' : null), now: () => clock })
  const run = await h.chat.send({ message: 'Hi', requestId: 'r-1' })
  const call = async (at, ...args) => { clock = at; await h.chat.handleNotification(mcpItem(run, ...args)) }
  const use = () => h.chat.snapshot().runs[0].computerUse
  const used = () => h.events.filter(event => event.event === 'computer.used').map(event => event.details)
  // An ordinary MCP call is not computer control: no computerUse at all.
  await call(1500, 'drive-1', 'drive', 'completed')
  assert.equal(Object.hasOwn(h.chat.snapshot().runs[0], 'computerUse'), false)
  await call(2000, 'a', 'cua_repl', 'inProgress')
  assert.deepEqual(use(), { calls: 1, lastAt: 2000, servers: ['cua_repl'], active: true })
  await call(3000, 'b', 'node_repl', 'inProgress')
  assert.deepEqual(use(), { calls: 2, lastAt: 3000, servers: ['cua_repl', 'node_repl'], active: true })
  await call(4000, 'a', 'cua_repl', 'completed')
  assert.deepEqual(use(), { calls: 2, lastAt: 4000, servers: ['cua_repl', 'node_repl'], active: true }, 'b is still in progress')
  await call(5000, 'b', 'node_repl', 'failed')
  assert.deepEqual(use(), { calls: 2, lastAt: 5000, servers: ['cua_repl', 'node_repl'], active: false })
  // Replays and late items change nothing: an ended call is neither counted again nor reopened.
  await call(6000, 'a', 'cua_repl', 'completed')
  await call(6000, 'b', 'node_repl', 'inProgress')
  assert.deepEqual(use(), { calls: 2, lastAt: 5000, servers: ['cua_repl', 'node_repl'], active: false })
  // A call first seen at its completion still counts once.
  await call(7000, 'c', 'cua_repl', 'completed')
  assert.deepEqual(use(), { calls: 3, lastAt: 7000, servers: ['cua_repl', 'node_repl'], active: false })
  const id = run.runId
  assert.deepEqual(used(), [
    { runId: id, calls: 1, lastAt: 2000, active: true }, { runId: id, calls: 2, lastAt: 3000, active: true },
    { runId: id, calls: 2, lastAt: 4000, active: true }, { runId: id, calls: 2, lastAt: 5000, active: false },
    { runId: id, calls: 3, lastAt: 7000, active: false },
  ])
  // Each computer.used follows its call's activity row and names the call.
  const first = h.events.findIndex(event => event.event === 'computer.used')
  assert.equal(h.events[first - 1].event, 'activity.started')
  assert.equal(h.events[first - 1].itemId, 'a')
  assert.equal(h.events[first].itemId, 'a')
  // The turn's own item list replays the calls without counting them again.
  clock = 8000
  await h.chat.handleNotification({ method: 'turn/completed', params: { threadId: run.conversationId, turn: { id: run.runId, status: 'completed', items: [mcpItem(run, 'a', 'cua_repl', 'completed').params.item, mcpItem(run, 'c', 'cua_repl', 'completed').params.item] } } })
  assert.deepEqual(use(), { calls: 3, lastAt: 7000, servers: ['cua_repl', 'node_repl'], active: false })
  assert.equal(used().length, 5)
  // At most 8 server names are kept.
  const many = runtime({ mcpServerKind: () => 'desktop' })
  const other = await many.chat.send({ message: 'Hi', requestId: 'r-1' })
  for (let index = 0; index < 10; index++) await many.chat.handleNotification(mcpItem(other, `m-${index}`, `desk-${index}`, 'completed'))
  assert.deepEqual(many.chat.snapshot().runs[0].computerUse.servers, Array.from({ length: 8 }, (_, index) => `desk-${index}`))
  assert.equal(many.chat.snapshot().runs[0].computerUse.calls, 10)
})

test('a turn that ends or loses Codex with a computer call in progress is no longer active', async () => {
  let clock = 1000
  const ended = runtime({ now: () => clock })
  const run = await ended.chat.send({ message: 'Hi', requestId: 'r-1' })
  await ended.chat.handleNotification(mcpItem(run, 'x', 'cua_repl', 'inProgress'))
  clock = 9000
  await ended.chat.handleNotification({ method: 'turn/completed', params: { threadId: run.conversationId, turn: { id: run.runId, status: 'interrupted', items: [] } } })
  assert.deepEqual(ended.chat.snapshot().runs[0].computerUse, { calls: 1, lastAt: 9000, servers: ['cua_repl'], active: false })
  const tail = ended.events.slice(-2)
  assert.deepEqual(tail.map(event => event.event), ['computer.used', 'run.completed'])
  assert.deepEqual(tail[0].details, { runId: run.runId, calls: 1, lastAt: 9000, active: false })
  // A lost connection ends it too, without inventing when the call ended.
  clock = 1000
  const lost = runtime({ now: () => clock })
  const other = await lost.chat.send({ message: 'Hi', requestId: 'r-1' })
  await lost.chat.handleNotification(mcpItem(other, 'y', 'cua_repl', 'inProgress'))
  clock = 9000
  lost.chat.setConnection(false)
  assert.deepEqual(lost.chat.snapshot().runs[0].computerUse, { calls: 1, lastAt: 1000, servers: ['cua_repl'], active: false })
  assert.deepEqual(lost.events.slice(-2).map(event => event.event), ['computer.used', 'run.unavailable'])
})

test('computer calls seen only in native history are counted without a time or a live event', async () => {
  const items = [
    { id: 'h-1', type: 'mcpToolCall', server: 'cua_repl', pluginId: COMPUTER_PLUGIN, tool: 'js', status: 'completed', arguments: { code: 'HISTORY_ARGUMENT' }, result: { content: [{ type: 'image', data: 'HISTORY_IMAGE' }] } },
    { id: 'h-2', type: 'mcpToolCall', server: 'cua_repl', pluginId: COMPUTER_PLUGIN, tool: 'js', status: 'inProgress' },
  ]
  const h = runtime({ custom: async method => method === 'thread/resume' ? { thread: { id: 'old', turns: [{ id: 'old-turn', status: 'interrupted', items }] }, cwd: '/work' } : undefined })
  const state = await h.chat.resume({ conversationId: 'old' })
  assert.deepEqual(state.runs[0].computerUse, { calls: 2, lastAt: null, servers: ['cua_repl'], active: false })
  assert.equal(state.runs[0].activities.find(activity => activity.id === 'h-1').detail.resultImageCount, 1)
  assert.equal(h.events.length, 0)
  for (const hidden of ['HISTORY_ARGUMENT', 'HISTORY_IMAGE']) assert.ok(!JSON.stringify(state).includes(hidden), hidden)
})

test('run.started and snapshots report the applied policy of an owned ordinary Codex run only when configured', async () => {
  const policyOf = h => h.events.filter(event => event.event === 'run.started').map(event => event.details.computerControl)
  for (const policy of ['inherit', 'off']) {
    const h = runtime({ policy })
    const run = await h.chat.send({ message: 'Hi', requestId: 'r-1' })
    assert.deepEqual(policyOf(h), [{ policy }])
    assert.deepEqual(Object.keys(h.events.find(event => event.event === 'run.started').details), ['status', 'computerControl'])
    // A new subscriber can read the same applied policy from a snapshot.
    assert.deepEqual(h.chat.snapshot().runs[0].computerControl, { policy })
    await h.finish(run)
  }
  // The bridge's saved setting counts as having the setting; a change applies to the next run.
  const saved = { policy: null, persisted: true, save: () => true }
  const h = runtime({ computerControlStore: saved })
  const first = await h.chat.send({ message: 'Hi', requestId: 'r-1' })
  await h.finish(first)
  h.chat.setComputerControlPolicy('off')
  await h.chat.send({ message: 'Again', requestId: 'r-2', conversationId: first.conversationId })
  assert.deepEqual(policyOf(h), [{ policy: 'inherit' }, { policy: 'off' }])
  assert.deepEqual(h.chat.snapshot().runs.map(run => run.computerControl), [{ policy: 'inherit' }, { policy: 'off' }])
  // Without the setting run.started keeps its earlier shape.
  const plain = runtime()
  await plain.chat.send({ message: 'Hi', requestId: 'r-1' })
  assert.deepEqual(plain.events.find(event => event.event === 'run.started').details, { status: 'inProgress' })
  assert.equal(Object.hasOwn(plain.chat.snapshot().runs[0], 'computerControl'), false)
})

test('bounded run events and snapshots do not inherit the ordinary Codex setting', async () => {
  for (const mode of ['readOnlyQa', 'browserBounded', 'fixtureBrowserQa']) {
    const qa = runtime({ policy: 'inherit', custom: async (method, params) => {
      if (method === 'thread/start') return { thread: { id: 'qa-thread' }, cwd: '/work', sandbox: { type: 'readOnly', networkAccess: false }, approvalPolicy: 'never' }
      if (method === 'mcpServerStatus/list' && params.threadId) return { data: [], nextCursor: null }
      if (method === 'experimentalFeature/list') return { data: ['browser_use', 'browser_use_external', 'computer_use'].map(name => ({ name, enabled: false })), nextCursor: null }
    } })
    const run = await qa.chat.send({ message: 'Read', requestId: 'qa-1', executionPolicy: { mode } })
    assert.equal(run.executionPolicy.mode, mode)
    assert.equal(Object.hasOwn(qa.events.find(event => event.event === 'run.started').details, 'computerControl'), false, mode)
    assert.equal(Object.hasOwn(qa.chat.snapshot().runs[0], 'computerControl'), false, mode)
  }
})

test('a native history-only turn and unowned live notifications do not inherit the current setting', async () => {
  const h = runtime({ policy: 'off', custom: async method => method === 'thread/resume' ? {
    thread: { id: 'history-thread', turns: [{ id: 'historical', status: 'completed', items: [] }] }, cwd: '/work',
  } : undefined })
  const resumed = await h.chat.resume({ conversationId: 'history-thread' })
  assert.deepEqual(resumed.runs.map(run => [run.runId, Object.hasOwn(run, 'computerControl')]), [['historical', false]])
  await h.chat.handleNotification({ method: 'turn/started', params: { threadId: 'history-thread', turn: { id: 'unowned', status: 'inProgress', items: [] } } })
  await h.chat.handleNotification({ method: 'turn/started', params: { threadId: 'history-thread', turn: { id: 'historical', status: 'inProgress', items: [] } } })
  assert.deepEqual(h.chat.snapshot().runs.map(run => [run.runId, run.status, Object.hasOwn(run, 'computerControl')]), [['historical', 'completed', false]])
  assert.deepEqual(h.events, [])
})

test('run.computerUse and computer.used reach the stored run checkpoint and events, still without content', async () => {
  const dataDir = createPrivateQaTempDirectory('egdesk-computer-use-')
  let store = null
  try {
    store = openChatStore({ dataDir, ownerScope: 'local-desktop-test' })
    let clock = 1000
    const h = runtime({ store, now: () => clock, policy: 'inherit' })
    const run = await h.chat.send({ message: 'Hi', clientThreadId: 'ui-1', requestId: 'r-1' })
    clock = 2000
    await h.chat.handleNotification(mcpItem(run, 'cua-1', 'cua_repl', 'inProgress', { arguments: { code: 'STORED_ARGUMENT' } }))
    clock = 3000
    await h.chat.handleNotification(mcpItem(run, 'cua-1', 'cua_repl', 'completed', { arguments: { code: 'STORED_ARGUMENT' }, result: { content: [{ type: 'image', data: 'STORED_IMAGE' }, { type: 'text', text: 'STORED_TEXT' }] } }))
    await h.finish(run)
    const history = h.chat.getLocalHistory({ clientThreadId: 'ui-1', limit: 500 })
    assert.deepEqual(history.runs[0].computerUse, { calls: 1, lastAt: 3000, servers: ['cua_repl'], active: false })
    // The store adds its run checkpoint beside the event's own details.
    assert.deepEqual(history.events.filter(event => event.event === 'computer.used').map(({ details: { runId, calls, lastAt, active } }) => ({ runId, calls, lastAt, active })), [
      { runId: run.runId, calls: 1, lastAt: 2000, active: true }, { runId: run.runId, calls: 1, lastAt: 3000, active: false },
    ])
    assert.deepEqual(history.events.find(event => event.event === 'run.started').details.computerControl, { policy: 'inherit' })
    assert.equal(history.runs[0].activities.find(activity => activity.id === 'cua-1').title, '컴퓨터 조작 · js')
    const stored = JSON.stringify(history)
    for (const hidden of ['STORED_ARGUMENT', 'STORED_IMAGE', 'STORED_TEXT', COMPUTER_PLUGIN]) assert.ok(!stored.includes(hidden), hidden)
  } finally {
    try { store?.close() } catch {}
    await rm(dataDir, { recursive: true, force: true })
  }
})

function settingsRequest(body, { method = 'POST', headers = {} } = {}) {
  const req = Readable.from(body === null ? [] : [Buffer.from(body)])
  req.method = method
  req.url = '/settings/computer-control'
  req.headers = { host: '127.0.0.1:39218', 'content-type': 'application/json', ...headers }
  req.socket = { remoteAddress: '127.0.0.1' }
  return req
}
function response() {
  return { headers: {}, setHeader(key, value) { this.headers[key] = value }, writeHead(status, headers) { this.status = status; Object.assign(this.headers, headers) }, end(body) { this.body = body ? JSON.parse(body) : null } }
}

test('POST /settings/computer-control changes the policy behind the loopback/Origin guard and accepts only {policy}', async () => {
  const h = runtime()
  const handle = createComputerControlHttpHandler(h.chat, { port: 39218 })
  const send = async (body, options) => {
    const req = settingsRequest(body, options)
    const res = response()
    const owned = await handle(req, res, new URL(req.url, 'http://127.0.0.1:39218'))
    return { owned, status: res.status, body: res.body }
  }
  assert.deepEqual(await send('{"policy":"off"}'), { owned: true, status: 200, body: { policy: 'off', verified: null } })
  assert.equal(h.chat.computerControlSnapshot().policy, 'off')
  for (const headers of [{ origin: 'https://evil.example' }, { origin: 'null' }, { 'sec-fetch-site': 'cross-site' }, { host: 'evil.example:39218' }]) {
    const refused = await send('{"policy":"inherit"}', { headers })
    assert.deepEqual([refused.status, refused.body.code], [403, 'SETTINGS_LOOPBACK_REQUIRED'], JSON.stringify(headers))
  }
  assert.equal(h.chat.computerControlSnapshot().policy, 'off', 'a refused request changes nothing')
  for (const body of ['{}', '{"policy":"on"}', '{"policy":"off","verified":true}', null]) {
    const bad = await send(body)
    assert.deepEqual([bad.status, bad.body.code], [400, 'INVALID_COMPUTER_CONTROL_POLICY'], String(body))
  }
  assert.equal((await send('{"policy":"inherit"}', { headers: { 'content-type': 'text/plain' } })).status, 415)
  assert.equal((await send('x'.repeat(2000))).status, 413)
  assert.equal((await send(null, { method: 'GET' })).status, 405)
  assert.deepEqual(await send('{"policy":"inherit"}', { headers: { origin: 'chrome://browser' } }), { owned: true, status: 200, body: { policy: 'inherit', verified: null } })
  const other = settingsRequest('{}')
  assert.equal(await handle(other, response(), new URL('/settings/other', 'http://127.0.0.1:39218')), false)
})

test('the bridge publishes computerControl last in /v1/state, broadcasts changes, mounts the route and gives Chat the inherited lookup', async () => {
  const source = await readFile(new URL('./codex-bridge-server.mjs', import.meta.url), 'utf8')
  const at = text => { const index = source.indexOf(text); assert.notEqual(index, -1, `missing server marker: ${text}`); return index }
  const chat = source.slice(at('const chat = new CodexChatRuntime({'), at('if (chatStore) {'))
  assert.match(chat, /mcpServerKind: name => inheritedMcp\.kindOf\(name\),/)
  assert.match(chat, /onComputerControlChange: computerControl => broadcast\(\{ type: 'computer\.control', v: BRIDGE_PROTOCOL_VERSION, provider: PROVIDER_ID, computerControl, ts: Date\.now\(\) \}\),/)
  assert.doesNotMatch(chat, /computerControlPolicy:/, 'the default (inherit) comes from codex-computer-control.mjs')
  at('const handleComputerControlHttp = createComputerControlHttpHandler(chat, { port: BRIDGE_PORT })')
  const mount = at('if (await handleComputerControlHttp(req, res, url)) return')
  assert.ok(at('if (!guardBridgeRequest(req, BRIDGE_PORT)) {') < mount)
  assert.ok(mount < at('if (await handleChatHttp(req, res, url)) return'))
  const state = source.slice(at("if (req.method === 'GET' && route === '/v1/state') {"), at("if (req.method === 'GET' && route === '/auth/status') {"))
  assert.ok(state.indexOf('workflow: workflow.snapshot(),') < state.indexOf('computerControl: chat.computerControlSnapshot(),'))
})
