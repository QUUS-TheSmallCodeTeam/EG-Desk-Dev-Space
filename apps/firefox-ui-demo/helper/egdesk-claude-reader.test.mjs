import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { ClaudeReaderClient, claudeReaderCapacityObservation, estimateClaudeReaderInput, CLAUDE_READER_SYSTEM_PROMPT } from './egdesk-claude-reader.mjs'
import { buildClaudeArgs, createClaudeTransport } from './claude-engine-transport.mjs'

const sha = value => createHash('sha256').update(value).digest('hex')
const tick = () => new Promise(resolve => setImmediate(resolve))
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes }); return { promise, resolve } }

// All evidence below is SYNTHETIC. No native CLI, profile or model is opened.
function harness(overrides = {}) {
  let scope = { engineId: 'claude', engineProfileId: 'fixture-profile', ownerKey: 'fixture-owner', epoch: 7 }
  const processes = [], disposed = [], lifecycles = []
  let workspaceId = 0
  const model = 'claude-fixture-model'
  const input = { ownerKey: scope.ownerKey, authority: { ...scope }, parentThreadId: 'parent', readerSessionId: 'logical-read',
    sourceId: 'immutable-source', sourceHash: sha('before. Evidence in supplied text. after.'),
    text: 'Evidence in supplied text.', range: { startOffset: 8, endOffset: 34 },
    intent: 'Read the source facts', query: null, cwd: '/must-not-read-live-project', model, effort: 'high', maxOutputChars: 1000,
    onLifecycle: item => lifecycles.push(item) }
  const capacity = { status: 'verified', source: 'native-observation', engineId: 'claude', fallback: false,
    model, engineBuild: '2.1.300', metadataHash: sha('fixture-only-capacity'), usableContextWindow: 80000,
    toolOutputLimitTokens: 4096, inputOverheadTokens: 100,
    estimator: { kind: 'utf8-upper-bound', verified: true, version: 'fixture-only-stream-json-v1' } }
  const environment = { capacity, usage: { usedTokens: 20 }, readerBudget: { maxInputTokens: 12000, inputOverheadTokens: 100 } }
  const usage = () => ({ model, totalTokens: 20, maxTokens: 80000, rawMaxTokens: 100000,
    memoryFiles: [], mcpTools: [], agents: [], systemTools: [], deferredBuiltinTools: [] })
  const reader = new ClaudeReaderClient({
    getScope: () => scope, snapshot: () => ({ version: '2.1.300', auth: { status: 'signedIn', method: 'claudeai' } }),
    executablePath: '/not-an-executable/claude', env: { HOME: '/fixture-only' },
    getReadCapacity: () => environment,
    getIsolationProof: () => ({ status: 'verified', ...scope, engineBuild: '2.1.300', metadataHash: sha('fixture-policy'),
      expiresAt: Date.now() + 10000, hooksDisabled: true, noApiKey: true }),
    createWorkspace: async () => { const cwd = `/fixture-only-reader/${++workspaceId}`; return { cwd, dispose: async () => { disposed.push(cwd) } } },
    createTransport: options => {
      const proc = { options, sends: [], calls: [], interruptions: 0, closes: 0, state: 'idle' }
      processes.push(proc)
      proc.init = extra => options.onMessage({ type: 'system', subtype: 'init', uuid: randomUUID(), session_id: options.sessionId,
        cwd: options.cwd, model: options.model, claude_code_version: '2.1.300', tools: [], mcp_servers: [], skills: [], plugins: [],
        slash_commands: [], agents: [], permissionMode: 'dontAsk', apiKeySource: 'none', capabilities: [], ...extra })
      proc.assistant = (text, extra = {}) => options.onMessage({ type: 'assistant', session_id: options.sessionId,
        parent_tool_use_id: null, message: { id: 'msg_fixture', model, content: [{ type: 'thinking', thinking: 'NEVER_RETAIN_ME' }, { type: 'text', text }] }, ...extra })
      proc.result = (text, extra = {}) => options.onMessage({ type: 'result', session_id: options.sessionId, uuid: randomUUID(),
        subtype: 'success', is_error: false, num_turns: 1, terminal_reason: 'completed', stop_reason: 'end_turn', result: text, ...extra })
      proc.complete = (value = { summary: 'The fragment contains evidence.', structure: ['A statement'], quotes: ['Evidence'] }) => {
        const text = JSON.stringify(value)
        proc.init(); proc.assistant(text); proc.result(text)
      }
      return {
        start: async () => { proc.state = 'running'; await overrides.start?.(proc); return { managedMcpConfig: false, initialize: { models: [{ value: model }] }, ...overrides.started } },
        request: async type => {
          proc.calls.push(type)
          if (overrides.request) return overrides.request(type, proc, usage())
          return type === 'mcp_status' ? { mcpServers: [] } : usage()
        },
        sendUserMessage: text => { proc.sends.push(text); if (overrides.send) overrides.send(proc, text); else proc.complete(); return true },
        interrupt: async () => { proc.interruptions++ },
        close: async () => { proc.closes++; if (overrides.close) await overrides.close(proc); proc.state = 'exited'; return { code: 0, signal: null } },
      }
    },
    ...overrides.reader,
  })
  return { reader, input, processes, disposed, lifecycles, environment, usage, scope: () => scope, change: value => { scope = { ...scope, ...value } } }
}

test('same SmartRead contract: exact input/hash, source-bounded evidence, actual native result receipt', async () => {
  const h = harness()
  const result = await h.reader.read(h.input)
  await h.reader.disconnect()
  assert.equal(result.inputPayload.text, h.processes[0].sends[0])
  assert.equal(result.inputPayload.hash, sha(h.processes[0].sends[0]))
  const payload = JSON.parse(result.inputPayload.text)
  assert.deepEqual(Object.keys(payload), ['purpose', 'sourceId', 'sourceHash', 'range', 'intent', 'query', 'outputCharacterLimit', 'sourceText'])
  assert.equal(payload.sourceText, h.input.text)
  assert.deepEqual(result.selectedSpans, [{ quote: 'Evidence', startOffset: 8, endOffset: 16 }])
  assert.equal(result.nativeThreadId, h.processes[0].options.sessionId)
  assert.equal(result.nativeTurnId, result.receipt.nativeResultId)
  assert.equal(result.receipt.nativeTurnIdKind, 'result-uuid')
  assert.equal(result.receipt.sourceHash, h.input.sourceHash)
  assert.equal(result.receipt.fragmentHash, sha(h.input.text))
  assert.equal(result.receipt.epoch, 7)
  assert.equal(result.receipt.coverage.kind, 'assigned-fragment')
  assert.equal(result.receipt.isolation.osSandbox, false)
  assert.equal(result.receipt.isolation.persistence, 'disabled-by-argv')
  assert.deepEqual(result.readerConfiguration, { model: h.input.model, effort: 'high', source: 'parent-turn' })
  assert.equal(JSON.stringify(result).includes('NEVER_RETAIN_ME'), false)
  assert.equal(h.lifecycles[0].phase, 'completed')
  assert.equal(h.disposed.length, 1)
})

test('Reader uses a fresh isolated process and immutable text on every refinement', async () => {
  const h = harness()
  const first = await h.reader.read(h.input)
  await h.reader.disconnect()
  const second = await h.reader.read({ ...h.input, intent: 'Another reading angle' })
  await h.reader.disconnect()
  assert.notEqual(first.nativeThreadId, second.nativeThreadId)
  assert.equal(JSON.parse(second.inputPayload.text).sourceText, h.input.text)
  for (const proc of h.processes) {
    const args = buildClaudeArgs(proc.options)
    assert.deepEqual(args.slice(args.indexOf('--tools'), args.indexOf('--tools') + 2), ['--tools', ''])
    for (const flag of ['--restricted', '--safe-mode', '--no-chrome', '--no-session-persistence', '--strict-mcp-config', '--setting-sources=']) assert.ok(args.includes(flag), flag)
    assert.equal(args[args.indexOf('--max-turns') + 1], '1')
    assert.equal(args[args.indexOf('--permission-mode') + 1], 'dontAsk')
    assert.equal(args[args.indexOf('--mcp-config') + 1], '{"mcpServers":{}}')
    assert.ok(args.includes(`--system-prompt=${CLAUDE_READER_SYSTEM_PROMPT}`))
    assert.equal(proc.options.cwd === h.input.cwd, false)
    assert.equal(proc.options.resume, null)
    assert.equal(proc.options.extraEnv.CLAUDE_CODE_MAX_OUTPUT_TOKENS, '4096')
    assert.deepEqual(proc.calls, ['mcp_status', 'get_context_usage'])
  }
})

test('two sequential chunks wait for delayed owned cleanup without retrying either generation', async () => {
  const h = harness({ close: () => new Promise(resolve => setTimeout(resolve, 12)) })
  const first = await h.reader.read(h.input)
  assert.equal(h.reader.children.size, 0, 'successful read waits until the first resident slot is released')
  const second = await h.reader.read({ ...h.input, intent: 'Next source-reading chunk' })
  assert.equal(h.reader.children.size, 0)
  assert.notEqual(first.nativeThreadId, second.nativeThreadId)
  assert.equal(h.processes.length, 2)
  assert.deepEqual(h.processes.map(proc => proc.sends.length), [1, 1])
})

test('successful native result with a stuck close is stop-pending, never auto-regenerated', async () => {
  const gate = deferred(), h = harness({ close: () => gate.promise, reader: { limits: { closeWaitMs: 10 } } })
  await assert.rejects(h.reader.read(h.input), { code: 'READER_STOP_PENDING' })
  await assert.rejects(h.reader.read(h.input), { code: 'READER_STOP_PENDING' })
  assert.equal(h.processes.length, 1)
  assert.equal(h.processes[0].sends.length, 1)
  gate.resolve(); await h.reader.disconnect()
})

test('scoped stop during success cleanup still prevents delivery of the completed packet', async () => {
  const gate = deferred(), h = harness({ close: () => gate.promise })
  const read = h.reader.read(h.input)
  const rejected = assert.rejects(read, { code: 'READER_OFFLINE' })
  await tick()
  const stopped = h.reader.disconnect({ readerSessionId: h.input.readerSessionId })
  gate.resolve()
  await rejected; await stopped
  assert.equal(h.processes[0].sends.length, 1)
})

test('missing native capacity and fake caller budgets never start a process', async () => {
  const h = harness({ reader: { getReadCapacity: () => null } })
  assert.deepEqual(h.reader.readiness(h.input), { ready: false, engineId: 'claude', code: 'ENGINE_CAPACITY_UNKNOWN', nativeVerified: false })
  await assert.rejects(h.reader.read({ ...h.input, capacity: { status: 'verified' }, contextWindow: 1e20 }), { code: 'ENGINE_CAPACITY_UNKNOWN' })
  assert.equal(h.processes.length, 0)
})

test('readiness is local preflight only, never claims native proof or affects chat', () => {
  const h = harness()
  const ready = h.reader.readiness({ authority: h.scope(), model: h.input.model, effort: 'high' })
  assert.equal(ready.ready, true)
  assert.equal(ready.nativeVerified, false)
  assert.equal(h.processes.length, 0)
  assert.equal(h.reader.readiness({ ...h.input, model: 'sonnet' }).code, 'READER_CONFIGURATION_REQUIRED')
})

for (const [label, change] of [
  ['unknown input', e => { delete e.usage.usedTokens }],
  ['unknown tool ceiling', e => { e.capacity.toolOutputLimitTokens = null }],
  ['documented model policy only', e => { e.capacity.source = 'documented-model-policy' }],
  ['wrong model', e => { e.capacity.model = 'claude-other-model' }],
  ['wrong build', e => { e.capacity.engineBuild = '2.1.299' }],
  ['unverified estimator', e => { e.capacity.estimator.verified = false }],
]) test(`strict capacity rejects ${label}`, async () => {
  const h = harness(); change(h.environment)
  await assert.rejects(h.reader.read(h.input), { code: 'ENGINE_CAPACITY_UNKNOWN' })
  assert.equal(h.processes.length, 0)
})

test('native capacity export preserves partial knowledge; no default window or tool ceiling', () => {
  const h = harness()
  const value = claudeReaderCapacityObservation(h.usage(), { model: h.input.model, engineBuild: '2.1.300', now: 1 })
  assert.equal(value.status, 'partial'); assert.equal(value.toolOutputLimitTokens, null); assert.equal(value.estimator, null)
  assert.equal(value.metadataHash, sha(JSON.stringify(h.usage())))
  assert.throws(() => claudeReaderCapacityObservation({ ...h.usage(), totalTokens: undefined }, { model: h.input.model }), { code: 'ENGINE_CAPACITY_UNKNOWN' })
})

test('unknown isolation and API-key env fail before spawn', async () => {
  for (const [reader, code] of [[{ getIsolationProof: () => null }, 'READER_ISOLATION_UNAVAILABLE'],
    [{ env: { ANTHROPIC_API_KEY: 'test-only-not-a-key' } }, 'CLAUDE_API_KEY_DETECTED']]) {
    const h = harness({ reader })
    await assert.rejects(h.reader.read(h.input), { code })
    assert.equal(h.processes.length, 0)
  }
})

test('exact serialization and prompt overhead, not caller text length, must fit', async () => {
  const h = harness()
  h.environment.readerBudget.maxInputTokens = 150
  await assert.rejects(h.reader.read(h.input), { code: 'ENGINE_CONTEXT_CONFIGURATION_ERROR' })
  assert.equal(h.processes.length, 0)
})

test('pure estimator measures the exact input wire string and system prompt, without any runtime access', async () => {
  const h = harness()
  const result = await h.reader.read({ ...h.input, intent: '읽기\\"\n', query: '한글' }); await h.reader.disconnect()
  const expected = Buffer.byteLength(result.inputPayload.text, 'utf8') + Buffer.byteLength(CLAUDE_READER_SYSTEM_PROMPT, 'utf8')
  h.reader.getScope = () => { throw new Error('must not inspect runtime') }
  assert.equal(h.reader.estimateInput({ ...h.input, intent: '읽기\\"\n', query: '한글' }), expected)
  assert.equal(estimateClaudeReaderInput({ ...h.input, intent: '읽기\\"\n', query: '한글' }, 100), expected + 100)
})

test('mutating the input after read starts cannot change source/hash/range', async () => {
  const gate = deferred(), h = harness({ start: () => gate.promise })
  const read = h.reader.read(h.input)
  h.input.text = 'changed'; h.input.range.startOffset = 100; h.input.sourceHash = sha('changed')
  gate.resolve()
  const result = await read; await h.reader.disconnect()
  assert.equal(JSON.parse(result.inputPayload.text).sourceText, 'Evidence in supplied text.')
  assert.equal(result.selectedSpans[0].startOffset, 8)
})

for (const [label, change, code] of [
  ['epoch during startup', h => h.change({ epoch: 8 }), 'ACCOUNT_CHANGED'],
  ['profile during startup', h => h.change({ engineProfileId: 'other' }), 'ACCOUNT_CHANGED'],
  ['owner during startup', h => h.change({ ownerKey: 'other' }), 'ACCOUNT_CHANGED'],
]) test(label + ' sends zero source input', async () => {
  const gate = deferred(), h = harness({ start: () => gate.promise })
  const read = h.reader.read(h.input)
  const rejection = assert.rejects(read, { code })
  await tick(); change(h); gate.resolve(); await rejection; await h.reader.disconnect()
  assert.equal(h.processes.reduce((n, p) => n + p.sends.length, 0), 0)
})

test('cancel and timeout race stuck initialization without sending input; late init cannot revive', async () => {
  for (const mode of ['cancel', 'timeout']) {
    const gate = deferred(), abort = new AbortController()
    const h = harness({ start: () => gate.promise, reader: { limits: { timeoutMs: 15 } } })
    const read = h.reader.read({ ...h.input, signal: abort.signal })
    const rejected = assert.rejects(read, { code: mode === 'cancel' ? 'READ_CANCELLED' : 'READER_TIMEOUT' })
    await tick(); if (mode === 'cancel') abort.abort()
    await rejected
    gate.resolve(); await h.reader.disconnect()
    assert.equal(h.processes[0].sends.length, 0)
  }
})

test('owner change after send rejects without waiting for another event', async () => {
  const h = harness({ send: () => {}, reader: { limits: { ownerPollMs: 5 } } })
  const read = h.reader.read(h.input), rejected = assert.rejects(read, { code: 'ACCOUNT_CHANGED' })
  await tick(); h.change({ epoch: 9 }); await rejected; await h.reader.disconnect()
  h.processes[0].complete()
  assert.equal(h.lifecycles.length, 0)
})

test('scoped disconnect leaves sibling read untouched and ignores late results', async () => {
  const h = harness({ send: () => {} })
  const first = h.reader.read(h.input), rejected = assert.rejects(first, { code: 'READER_OFFLINE' })
  const second = h.reader.read({ ...h.input, readerSessionId: 'sibling-read' })
  await tick()
  await h.reader.disconnect({ engineId: 'codex' })
  assert.equal(h.processes[0].closes, 0)
  await h.reader.disconnect({ engineId: 'claude', readerSessionId: h.input.readerSessionId, epoch: 7 })
  await rejected
  h.processes[0].complete(); h.processes[1].complete()
  const result = await second; await h.reader.disconnect()
  assert.equal(result.nativeThreadId, h.processes[1].options.sessionId)
  assert.equal(h.lifecycles.length, 1)
})

test('bounded active slots and unresolved closing process prevent replacement', async () => {
  const gate = deferred(), h = harness({ send: () => {}, close: () => gate.promise, reader: { limits: { maxConcurrent: 1 } } })
  const abort = new AbortController(), read = h.reader.read({ ...h.input, signal: abort.signal })
  const rejected = assert.rejects(read, { code: 'READ_CANCELLED' })
  await tick(); abort.abort(); await rejected
  await assert.rejects(h.reader.read(h.input), { code: 'READER_BUSY' })
  gate.resolve(); await h.reader.disconnect()
  assert.equal(h.processes.length, 1)
})

test('scoped disconnect is bounded even when initialization never settles', async () => {
  const gate = deferred(), h = harness({ start: () => gate.promise, reader: { limits: { closeWaitMs: 10 } } })
  const read = h.reader.read(h.input), rejected = assert.rejects(read, { code: 'READER_OFFLINE' })
  await tick()
  const result = await h.reader.disconnect({ readerSessionId: h.input.readerSessionId })
  await rejected
  assert.equal(result[0].status, 'stop-pending')
  assert.equal(h.reader.children.size, 1)
  gate.resolve(); await h.reader.disconnect()
  assert.equal(h.reader.children.size, 0)
  assert.equal(h.processes[0].sends.length, 0)
})

test('unconfirmed transport close retains residency; a success result is not process-exit proof', async () => {
  const h = harness({ reader: { createTransport: options => ({
    start: async () => { throw new Error('fixture start failure') },
    close: async () => ({ code: null, signal: null, forced: 'kill' }),
  }) } })
  await assert.rejects(h.reader.read(h.input))
  const result = await h.reader.disconnect()
  assert.equal(result[0].status, 'stop-pending')
  assert.equal(h.reader.children.size, 1)
  await assert.rejects(h.reader.read(h.input), { code: 'READER_STOP_PENDING' })
})

for (const [name, request, code] of [
  ['MCP inventory', type => type === 'mcp_status' ? { mcpServers: [{}] } : null, 'READER_ISOLATION_UNAVAILABLE'],
  ['unknown native usage', (type, p, u) => type === 'mcp_status' ? { mcpServers: [] } : { ...u, totalTokens: undefined }, 'ENGINE_CAPACITY_UNKNOWN'],
  ['window drift', (type, p, u) => type === 'mcp_status' ? { mcpServers: [] } : { ...u, maxTokens: 70000 }, 'ENGINE_CAPACITY_UNKNOWN'],
  ['memory leak', (type, p, u) => type === 'mcp_status' ? { mcpServers: [] } : { ...u, memoryFiles: [{}] }, 'READER_ISOLATION_UNAVAILABLE'],
]) test(name + ' fails before source send', async () => {
  const h = harness({ request })
  await assert.rejects(h.reader.read(h.input), { code }); await h.reader.disconnect()
  assert.equal(h.processes[0].sends.length, 0)
})

for (const field of ['tools', 'mcp_servers', 'skills', 'plugins', 'agents', 'slash_commands']) test(`native init ${field} leak fails closed`, async () => {
  const h = harness({ send: proc => proc.init({ [field]: ['unexpected'] }) })
  await assert.rejects(h.reader.read(h.input), { code: 'READER_ISOLATION_UNAVAILABLE' }); await h.reader.disconnect()
})

for (const [field, value] of [['session_id', randomUUID()], ['uuid', 'fake'], ['cwd', '/live-project'], ['model', 'claude-other'], ['apiKeySource', 'apiKeyHelper'], ['permissionMode', 'bypassPermissions'], ['effort', 'low']]) test(`native init ${field} mismatch is rejected`, async () => {
  const h = harness({ send: proc => proc.init({ [field]: value }) })
  await assert.rejects(h.reader.read(h.input)); await h.reader.disconnect()
  assert.equal(h.lifecycles.length, 0)
})

test('all incoming tool/hook/MCP control requests are denied and fail the read', async () => {
  for (const type of ['can_use_tool', 'hook_callback', 'mcp_message']) {
    const h = harness({ send: proc => {
      proc.init()
      const response = proc.options.controlHandlers[type]({ subtype: type, tool_name: 'Read' })
      assert.ok(response.error || response.response.behavior === 'deny')
    } })
    await assert.rejects(h.reader.read(h.input), { code: 'READER_SCOPE_VIOLATION' }); await h.reader.disconnect()
  }
})

for (const [name, send, code] of [
  ['bad citation', p => p.complete({ summary: 'no', quotes: ['NOT IN SOURCE'], structure: [] }), 'READER_INVALID_CITATION'],
  ['extra field', p => p.complete({ summary: 'no', quotes: [], structure: [], answer: 'business decision' }), 'READER_INVALID_PACKET'],
  ['oversized result', p => p.complete({ summary: 'x'.repeat(2000), quotes: [], structure: [] }), 'READER_OUTPUT_LIMIT'],
  ['bad JSON', p => { p.init(); p.result('not-json') }, 'READER_INVALID_PACKET'],
  ['missing result ID', p => { p.init(); p.result('{}', { uuid: null }) }, 'READER_FAILED'],
  ['cancelled native result', p => { p.init(); p.result('{}', { terminal_reason: 'aborted_streaming' }) }, 'READER_FAILED'],
  ['too many turns', p => { p.init(); p.result('{}', { num_turns: 2 }) }, 'READER_FAILED'],
  ['wrong completion', p => { p.init(); p.result('{}', { session_id: randomUUID() }) }, 'READER_SCOPE_VIOLATION'],
  ['no init', p => p.result('{}'), 'READER_PROTOCOL_ERROR'],
  ['native tool use', p => { p.init(); p.assistant('', { message: { id: 'msg', model: p.options.model, content: [{ type: 'tool_use', name: 'Read' }] } }) }, 'READER_SCOPE_VIOLATION'],
]) test(name + ' yields no success/coverage', async () => {
  const h = harness({ send })
  await assert.rejects(h.reader.read(h.input), { code }); await h.reader.disconnect()
  assert.equal(h.lifecycles.length, 0)
})

test('malformed native JSON/oversized line notices fail, not truncate', async () => {
  const h = harness({ send: p => p.options.onNotice({ code: 'CLAUDE_LINE_TOO_LONG', fatal: false }) })
  await assert.rejects(h.reader.read(h.input), { code: 'READER_PROTOCOL_ERROR' }); await h.reader.disconnect()
})

test('allowed quota events do not become source evidence; rejected quota never retries', async () => {
  for (const status of ['allowed', 'rejected']) {
    const h = harness({ send: p => {
      p.init()
      p.options.onMessage({ type: 'rate_limit_event', session_id: p.options.sessionId, rate_limit_info: { status } })
      if (status === 'allowed') p.result(JSON.stringify({ summary: 'Source facts', quotes: ['Evidence'], structure: [] }))
    } })
    if (status === 'allowed') await h.reader.read(h.input)
    else await assert.rejects(h.reader.read(h.input), { code: 'READER_RATE_LIMITED' })
    await h.reader.disconnect(); assert.equal(h.processes.length, 1)
  }
})

test('Reader integrates with the actual NDJSON transport using only an in-memory fake process', async () => {
  const written = [], spawned = []
  const h = harness({ reader: { createTransport: createClaudeTransport, transportOptions: {
    managedMcpConfig: false, processGroup: false,
    execFileImpl: () => { throw new Error('No CLI/version probe allowed') },
    spawnImpl: (executable, args, options) => {
      spawned.push({ executable, args, options })
      const sessionId = args.find(arg => arg.startsWith('--session-id=')).split('=')[1]
      const child = new EventEmitter()
      child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough()
      const send = message => child.stdout.write(JSON.stringify(message) + '\n')
      let pending = ''
      child.stdin.on('data', data => {
        pending += data.toString()
        let newline
        while ((newline = pending.indexOf('\n')) !== -1) {
          const message = JSON.parse(pending.slice(0, newline)); pending = pending.slice(newline + 1); written.push(message)
          if (message.type === 'control_request') {
            const response = message.request.subtype === 'initialize' ? { models: [{ value: 'claude-fixture-model' }] }
              : message.request.subtype === 'mcp_status' ? { mcpServers: [] } : h.usage()
            send({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response } })
          } else {
            send({ type: 'system', subtype: 'init', session_id: sessionId, uuid: randomUUID(), cwd: options.cwd,
              model: 'claude-fixture-model', claude_code_version: '2.1.300', apiKeySource: 'none',
              tools: [], mcp_servers: [], skills: [], plugins: [], slash_commands: [], capabilities: [], permissionMode: 'dontAsk' })
            send({ type: 'result', subtype: 'success', session_id: sessionId, uuid: randomUUID(), is_error: false, num_turns: 1,
              result: JSON.stringify({ summary: 'Evidence from the fragment', quotes: ['Evidence'], structure: [] }) })
          }
        }
      })
      let exited = false
      const exit = () => { if (exited) return; exited = true; setImmediate(() => { child.emit('exit', 0, null); child.emit('close', 0, null) }) }
      child.stdin.on('end', exit); child.kill = () => { exit(); return true }
      process.nextTick(() => child.emit('spawn'))
      return child
    },
  } } })
  const result = await h.reader.read(h.input); await h.reader.disconnect()
  assert.equal(spawned.length, 1)
  assert.deepEqual(written.map(message => message.request?.subtype || message.type), ['initialize', 'mcp_status', 'get_context_usage', 'user'])
  assert.equal(written.at(-1).message.content, result.inputPayload.text)
  assert.equal(spawned[0].args[spawned[0].args.indexOf('--tools') + 1], '')
  assert.equal(spawned[0].options.env.ANTHROPIC_API_KEY, undefined)
  assert.equal(spawned[0].options.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS, '4096')
})
