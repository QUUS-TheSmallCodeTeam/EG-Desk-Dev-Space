import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { createClaudeEngineAdapter } from './claude-engine-adapter.mjs'
import { createEgdeskClaudeMcp } from './egdesk-claude-mcp.mjs'
import { ClaudeReaderClient } from './egdesk-claude-reader.mjs'
import { strictReadAdmission } from './egdesk-smart-read.mjs'
import {
  CLAUDE_IMAGE_TOKEN_BOUND, CLAUDE_MCP_OUTPUT_LIMIT_TOKENS, claudeParentLimitEnv, claudeToolResultBound, createClaudeProcessBudget,
} from './egdesk-claude-limits.mjs'
import { claudeManagedPolicyPaths, createClaudeReaderEvidence, probeClaudeManagedPolicy } from './egdesk-claude-capacity.mjs'

// All native answers below are SYNTHETIC (fake `claude` on PassThrough pipes).
// No CLI, account or model is used.
const EXE = '/Users/test/.local/bin/claude'
const CWD = '/Users/test/project'
const MODEL = 'claude-fixture-model'
const SIGNED_IN = Object.freeze({ installed: true, version: '2.1.300', versionStatus: 'untested', checkedAt: 1,
  auth: { status: 'signedIn', method: 'claudeai', label: 'Claude Max', account: 'owner@example.com', planType: 'max' } })
const OWNER = 'claude:claudeai:owner@example.com'
const READ_TOOL = [{ type: 'function', name: 'egdesk_read_source', description: 'Read', inputSchema: { type: 'object', properties: {} } }]
const usage = (extra = {}) => ({ model: MODEL, totalTokens: 21000, maxTokens: 180000, rawMaxTokens: 200000,
  memoryFiles: [], mcpTools: [], agents: [], ...extra })
const tick = () => new Promise(resolve => setImmediate(resolve))
async function until(predicate, timeoutMs = 2000) {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting')
    await new Promise(resolve => setTimeout(resolve, 2))
  }
}

function fakeChild({ usageAnswer = () => usage(), holdUsage = false } = {}) {
  const child = new EventEmitter()
  child.pid = 5000 + Math.floor(Math.random() * 1000)
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough()
  child.written = []; child.exited = false; child.heldUsage = []
  let buffer = ''
  child.stdin.setEncoding('utf8')
  child.send = message => child.stdout.write(JSON.stringify(message) + '\n')
  const ok = (id, response) => child.send({ type: 'control_response', response: { subtype: 'success', request_id: id, response } })
  child.answerUsage = () => { for (const id of child.heldUsage.splice(0)) ok(id, usageAnswer()) }
  child.stdin.on('data', data => {
    buffer += data
    let index
    while ((index = buffer.indexOf('\n')) >= 0) {
      const message = JSON.parse(buffer.slice(0, index))
      buffer = buffer.slice(index + 1)
      child.written.push(message)
      const subtype = message.type === 'control_request' ? message.request.subtype : null
      if (subtype === 'initialize' || subtype === 'interrupt') ok(message.request_id, {})
      if (subtype === 'get_context_usage') { if (holdUsage) child.heldUsage.push(message.request_id); else ok(message.request_id, usageAnswer()) }
    }
  })
  child.stdin.on('end', () => child.exit(0, null))
  child.kill = signal => { child.exit(null, signal); return true }
  child.exit = (code, signal) => {
    if (child.exited) return
    child.exited = true
    child.stdout.end(); child.stderr.end()
    setImmediate(() => { child.emit('exit', code, signal); setImmediate(() => child.emit('close', code, signal)) })
  }
  return child
}

function harness({ childOptions = {}, check = SIGNED_IN, ...options } = {}) {
  const children = [], spawns = []
  let current = check, ids = 0
  const adapter = createClaudeEngineAdapter({
    snapshot: () => current, refreshStatus: async () => current, env: { HOME: '/Users/test', PATH: '/usr/bin' }, platform: 'darwin', defaultCwd: CWD,
    resolveExecutable: () => EXE,
    randomUUID: () => `00000000-0000-4000-8000-${String(++ids).padStart(12, '0')}`,
    setTimer: () => ({}), clearTimer: () => {},
    transportOptions: {
      managedMcpConfig: false,
      spawnImpl: (file, args, opts) => {
        const child = fakeChild(childOptions)
        children.push(child); spawns.push({ file, args, opts })
        process.nextTick(() => child.emit('spawn'))
        return child
      },
      execFileImpl: (file, args, opts, callback) => process.nextTick(() => callback(null, '2.1.300 (Claude Code)\n', '')),
      timeouts: { closeGraceMs: 200, closeTermMs: 100, closeKillMs: 100, exitCloseFallbackMs: 50 },
    },
    ...options,
  })
  const requests = []
  adapter.subscribe({ serverRequest: (_id, message) => requests.push(message) })
  adapter.syncStatus()
  return { adapter, children, spawns, requests, setCheck: next => { current = next; adapter.syncStatus() } }
}

async function turn(h, tools = READ_TOOL) {
  const started = await h.adapter.startThread({ dynamicTools: tools, model: MODEL })
  await h.adapter.startTurn({ threadId: started.thread.id, input: [{ type: 'text', text: 'hi', text_elements: [] }] })
  return started.thread.id
}

const authority = (extra = {}) => ({ engineId: 'claude', engineProfileId: 'claude-default', ownerKey: OWNER, epoch: 3, ...extra })
const clearFs = { existsSync: () => false, readFileSync: () => { throw new Error('none') }, readdirSync: () => [] }

// ---------------------------------------------------------------- budget

test('process budget: one counter for parents and Readers, per-kind and total caps, idempotent release', () => {
  const budget = createClaudeProcessBudget()
  assert.deepEqual(budget.limits, { total: 3, parent: 2, reader: 2 })
  const p1 = budget.tryAcquire('parent'), p2 = budget.tryAcquire('parent')
  assert.ok(p1 && p2)
  assert.equal(budget.tryAcquire('parent'), null, 'parent cap')
  const r1 = budget.tryAcquire('reader')
  assert.ok(r1)
  assert.equal(budget.tryAcquire('reader'), null, 'total cap: 2 parents + 1 Reader')
  assert.equal(r1.release(), true)
  assert.equal(r1.release(), false, 'a double release frees one slot only')
  p1.release()
  assert.ok(budget.tryAcquire('reader') && budget.tryAcquire('reader'))
  assert.equal(budget.tryAcquire('reader'), null, 'Reader cap')
  assert.deepEqual(budget.snapshot(), { total: 3, parent: 1, reader: 2, limits: { total: 3, parent: 2, reader: 2 } })
  assert.throws(() => createClaudeProcessBudget({ total: 1, parent: 2 }), TypeError)
  assert.throws(() => budget.tryAcquire('codex'), TypeError)
})

test('Reader refuses to spawn when parents and Readers already fill the shared Claude budget', async () => {
  const budget = createClaudeProcessBudget({ total: 2, parent: 2, reader: 2 })
  const held = [budget.tryAcquire('parent'), budget.tryAcquire('parent')]
  let spawned = 0
  const reader = new ClaudeReaderClient({ getScope: () => authority(), snapshot: () => SIGNED_IN, executablePath: EXE, env: {},
    processBudget: budget, createTransport: () => { spawned++; throw new Error('must not spawn') },
    getReadCapacity: () => ({ capacity: { status: 'verified', source: 'native-observation', engineId: 'claude', fallback: false, model: MODEL,
      engineBuild: '2.1.300', metadataHash: 'a'.repeat(64), usableContextWindow: 180000, toolOutputLimitTokens: 10000, inputOverheadTokens: 512,
      estimator: { kind: 'utf8-upper-bound', verified: true, version: 'v1' } }, usage: { usedTokens: 1 }, readerBudget: { maxInputTokens: 60000, inputOverheadTokens: 8192 } }),
    getIsolationProof: () => ({ status: 'verified', ...authority(), engineBuild: '2.1.300', metadataHash: 'b'.repeat(64), expiresAt: Date.now() + 60000, hooksDisabled: true, noApiKey: true }) })
  await assert.rejects(reader.read({ readerSessionId: 's', parentThreadId: 'p', sourceId: 'src', sourceHash: 'c'.repeat(64), text: 'abc',
    range: { startOffset: 0, endOffset: 3 }, intent: 'read', maxOutputChars: 500, model: MODEL, effort: 'low' }), { code: 'READER_BUSY' })
  assert.equal(spawned, 0)
  held[0].release()
  assert.ok(budget.available('reader'))
})

test('adapter takes a parent slot from the shared budget and returns it when the process exits', async () => {
  const budget = createClaudeProcessBudget({ total: 2, parent: 2, reader: 2 })
  const readers = [budget.tryAcquire('reader')]
  const h = harness({ processBudget: budget })
  await turn(h)
  assert.deepEqual(budget.snapshot().parent, 1)
  // The second conversation would exceed the total while a Reader runs and the first parent is busy.
  readers.push(budget.tryAcquire('reader'))
  assert.equal(readers[1], null, 'total 2 = 1 parent + 1 Reader')
  const started = await h.adapter.startThread({ dynamicTools: READ_TOOL, model: MODEL })
  await assert.rejects(h.adapter.startTurn({ threadId: started.thread.id, input: [{ type: 'text', text: 'x', text_elements: [] }] }), { code: 'ENGINE_BUSY' })
  readers[0].release()
  await h.adapter.dispose()
  await until(() => budget.snapshot().total === 0)
})

// ---------------------------------------------------------------- MCP output

test('MCP output limit: the parent env carries MAX_MCP_OUTPUT_TOKENS and oversized results become tool errors, never clipped', () => {
  assert.deepEqual(claudeParentLimitEnv(), { MAX_MCP_OUTPUT_TOKENS: String(CLAUDE_MCP_OUTPUT_LIMIT_TOKENS) })
  const small = { content: [{ type: 'text', text: 'ok' }] }
  assert.ok(claudeToolResultBound(small) < 64)
  const image = { content: [{ type: 'image', data: 'A'.repeat(500000), mimeType: 'image/png' }] }
  assert.ok(claudeToolResultBound(image) < CLAUDE_IMAGE_TOKEN_BOUND + 200, 'image base64 counts as an image, not as text bytes')
  assert.ok(claudeToolResultBound({ content: [{ type: 'text', text: '가'.repeat(100) }] }) >= 300, 'UTF-8 bytes, not characters')

  const mcp = createEgdeskClaudeMcp({ threadId: 't1', tools: READ_TOOL, outputLimitTokens: 100 })
  const call = id => mcp.handle({ kind: 'mcpMessage', requestId: `req-${id}`, request: { server_name: 'egdesk', message: { jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'egdesk_read_source', arguments: {} } } } })
  const first = call(1).serverRequest
  const big = mcp.respond(first.id, { success: true, contentItems: [{ type: 'inputText', text: 'x'.repeat(500) }] })
  const result = big.write.response.response.mcp_response.result
  assert.equal(result.isError, true)
  assert.equal(JSON.parse(result.content[0].text).error.code, 'EGDESK_TOOL_OUTPUT_LIMIT')
  assert.equal(result.content[0].text.includes('xxxx'), false, 'no partial source text leaks')
  const second = call(2).serverRequest
  const fits = mcp.respond(second.id, { success: true, contentItems: [{ type: 'inputText', text: 'short' }] })
  assert.deepEqual(fits.write.response.response.mcp_response.result, { content: [{ type: 'text', text: 'short' }] })
  assert.equal(mcp.stats().outputLimited, 1)
  assert.equal(mcp.outputLimitTokens(), 100)
  assert.throws(() => createEgdeskClaudeMcp({ threadId: 't', outputLimitTokens: 0 }), TypeError)
})

// ---------------------------------------------------------------- managed policy / hooks

test('managed policy probe: clear without managed files; hooks, apiKeyHelper, managed MCP, plist or unreadable files block', () => {
  assert.deepEqual(claudeManagedPolicyPaths('darwin').settings, '/Library/Application Support/ClaudeCode/managed-settings.json')
  assert.equal(claudeManagedPolicyPaths('linux').mcp, '/etc/claude-code/managed-mcp.json')
  assert.equal(probeClaudeManagedPolicy({ platform: 'darwin', fileSystem: clearFs }).status, 'clear')
  const paths = claudeManagedPolicyPaths('darwin')
  const fsWith = files => ({ existsSync: file => Object.hasOwn(files, file), readdirSync: dir => Object.keys(files).filter(f => f.startsWith(dir + '/')).map(f => f.slice(dir.length + 1)),
    readFileSync: file => { if (files[file] === null) throw new Error('EACCES'); return files[file] } })
  const probe = files => probeClaudeManagedPolicy({ platform: 'darwin', fileSystem: fsWith(files) })
  assert.deepEqual(probe({ [paths.settings]: JSON.stringify({ permissions: { deny: ['Bash'] } }) }).status, 'clear')
  assert.deepEqual(probe({ [paths.settings]: JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'audit' }] }] } }) }).reasons, ['managed-hooks'])
  assert.deepEqual(probe({ [paths.settingsDir]: '', [`${paths.settingsDir}/10-org.json`]: JSON.stringify({ apiKeyHelper: '/bin/key' }) }).reasons, ['managed-api-key-helper'])
  assert.deepEqual(probe({ [paths.settings]: JSON.stringify({ env: { ANTHROPIC_API_KEY: 'x' } }) }).reasons, ['managed-api-key-env'])
  assert.deepEqual(probe({ [paths.mcp]: '{}' }).reasons, ['managed-mcp'])
  assert.deepEqual(probe({ [paths.plists[0]]: 'bplist' }).reasons, ['managed-plist-unverifiable'])
  assert.deepEqual(probe({ [paths.settings]: null }).reasons, ['managed-settings-unreadable'])
  assert.deepEqual(probe({ [paths.settings]: '{not json' }).reasons, ['managed-settings-unreadable'])
  const a = probe({ [paths.settings]: '{"a":1}' }), b = probe({ [paths.settings]: '{"a":2}' })
  assert.notEqual(a.hash, b.hash, 'the proof hash changes with the policy contents')
})

// ---------------------------------------------------------------- capacity evidence

test('parent capacity: baseline, per-turn and read-time native usage become verified Reader evidence for that conversation only', async () => {
  let total = 21000
  const h = harness({ childOptions: { usageAnswer: () => usage({ totalTokens: total }) } })
  let now = 1_000_000
  const evidence = createClaudeReaderEvidence({ adapter: h.adapter, snapshot: () => SIGNED_IN, env: {}, platform: 'darwin', now: () => now,
    probe: () => probeClaudeManagedPolicy({ platform: 'darwin', fileSystem: clearFs }) })
  assert.equal(evidence.readCapacity({ authority: authority() }), null, 'nothing observed yet: capacity unknown')
  const threadId = await turn(h)
  await until(() => h.adapter.contextObservation(threadId))
  const baseline = h.adapter.contextObservation(threadId)
  assert.equal(baseline.basis, 'baseline')
  assert.equal(baseline.mcpOutputLimitTokens, 10000)
  assert.equal(h.adapter.baselineObservation(), baseline)
  now = baseline.observedAt + 1
  const env = evidence.readCapacity({ authority: authority(), run: { conversationId: threadId }, configuration: { model: MODEL } })
  assert.equal(env.capacity.status, 'verified')
  assert.equal(env.capacity.usableContextWindow, 180000)
  assert.equal(env.capacity.toolOutputLimitTokens, 10000)
  assert.equal(env.usage.usedTokens, 21000)
  assert.equal(env.selection.revision, env.capacity.modelSelectionRevision)
  assert.ok(env.readerBudget.maxInputTokens > env.readerBudget.inputOverheadTokens)
  const admission = strictReadAdmission('x'.repeat(100), {}, env.capacity, env.usage, 1, { authority: authority(), model: MODEL })
  assert.equal(admission.measurement, 'verified-utf8-upper-bound')
  // A model other than the one Claude measured is not this evidence.
  assert.equal(evidence.readCapacity({ authority: authority(), run: { conversationId: threadId }, configuration: { model: 'claude-other' } }), null)
  // Another owner, another build or a stale observation is not evidence either.
  assert.equal(evidence.readCapacity({ authority: authority({ ownerKey: 'claude:claudeai:other@example.com' }), run: { conversationId: threadId }, configuration: { model: MODEL } }), null)
  now = baseline.observedAt + 31 * 60_000
  assert.equal(evidence.readCapacity({ authority: authority(), run: { conversationId: threadId }, configuration: { model: MODEL } }), null)
  await h.adapter.dispose()
})

test('an egdesk_read_source call reaches the runtime only after the conversation usage was re-measured', async () => {
  const h = harness({ childOptions: { holdUsage: true, usageAnswer: () => usage({ totalTokens: 33000 }) } })
  const threadId = await turn(h)
  const child = h.children[0]
  child.answerUsage() // baseline
  await until(() => h.adapter.contextObservation(threadId))
  child.send({ type: 'control_request', request_id: 'mcp-1', request: { subtype: 'mcp_message', server_name: 'egdesk',
    message: { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'egdesk_read_source', arguments: { snapshotId: 's', intent: 'i' } } } } })
  await until(() => child.heldUsage.length === 1)
  await tick()
  assert.equal(h.requests.length, 0, 'held until the fresh measurement settles')
  child.answerUsage()
  await until(() => h.requests.length === 1)
  assert.equal(h.requests[0].params.tool, 'egdesk_read_source')
  assert.equal(h.adapter.contextObservation(threadId).basis, 'tool-call')
  assert.equal(h.adapter.contextObservation(threadId).usage.totalTokens, 33000)
  await h.adapter.dispose()
})

test('an account change drops every observation; a hook event or hook callback revokes the isolation proof', async () => {
  const h = harness()
  let now = Date.now()
  const evidence = createClaudeReaderEvidence({ adapter: h.adapter, snapshot: () => SIGNED_IN, env: {}, platform: 'darwin', now: () => now,
    probe: () => probeClaudeManagedPolicy({ platform: 'darwin', fileSystem: clearFs }) })
  const proof = evidence.isolationProof({ authority: authority() })
  assert.equal(proof.status, 'verified')
  assert.equal(proof.hooksDisabled, true)
  assert.equal(proof.noApiKey, true)
  assert.equal(proof.engineBuild, '2.1.300')
  const threadId = await turn(h)
  await until(() => h.adapter.contextObservation(threadId))
  h.children[0].send({ type: 'system', subtype: 'hook_started', session_id: threadId, hook_name: 'PreToolUse' })
  await until(() => h.adapter.isolationEvents().hookEvents === 1)
  assert.equal(evidence.isolationProof({ authority: authority() }), null)
  assert.equal(evidence.explain({ authority: authority() }).hookEvents, 1)
  h.setCheck({ ...SIGNED_IN, auth: { ...SIGNED_IN.auth, account: 'other@example.com' } })
  assert.equal(h.adapter.contextObservation(threadId), null)
  assert.equal(h.adapter.baselineObservation(), null)
  await h.adapter.dispose()

  const withKey = createClaudeReaderEvidence({ adapter: harness().adapter, snapshot: () => SIGNED_IN, env: { ANTHROPIC_API_KEY: 'x' }, platform: 'darwin',
    probe: () => probeClaudeManagedPolicy({ platform: 'darwin', fileSystem: clearFs }) })
  assert.equal(withKey.isolationProof({ authority: authority() }), null, 'an API key in the environment is never subscription-only proof')
  const managed = createClaudeReaderEvidence({ adapter: harness().adapter, snapshot: () => SIGNED_IN, env: {}, platform: 'darwin',
    probe: () => ({ status: 'blocked', reasons: ['managed-hooks'], sources: [], hash: 'x' }) })
  assert.equal(managed.isolationProof({ authority: authority() }), null)
  assert.deepEqual(managed.explain({ authority: authority() }).policyReasons, ['managed-hooks'])
})

test('the evidence feeds ClaudeReaderClient readiness end to end (synthetic native values)', async () => {
  const h = harness()
  const threadId = await turn(h)
  await until(() => h.adapter.contextObservation(threadId))
  const evidence = createClaudeReaderEvidence({ adapter: h.adapter, snapshot: () => SIGNED_IN, env: {}, platform: 'darwin',
    probe: () => probeClaudeManagedPolicy({ platform: 'darwin', fileSystem: clearFs }) })
  const reader = new ClaudeReaderClient({ getScope: () => authority(), snapshot: () => SIGNED_IN, executablePath: EXE, env: {},
    getReadCapacity: options => evidence.readCapacity({ ...options, run: { conversationId: threadId } }),
    getIsolationProof: options => evidence.isolationProof(options) })
  const ready = reader.readiness({ model: MODEL, effort: 'low' })
  assert.equal(ready.ready, true, JSON.stringify(ready))
  await h.adapter.dispose()
})
