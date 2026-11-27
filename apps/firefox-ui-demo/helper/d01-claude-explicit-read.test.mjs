import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { CodexChatRuntime } from './codex-chat-runtime.mjs'
import { createClaudeEngineAdapter } from './claude-engine-adapter.mjs'
import { createCodexEngineAdapter } from './codex-engine-adapter.mjs'

import { ContextRuntime } from './egdesk-context-runtime.mjs'
import { ImmutableContextStore } from './egdesk-context-store.mjs'
import { openChatStore } from './egdesk-chat-store.mjs'
import { collectDecisionCandidates } from './egdesk-decision-candidates.mjs'

const question = 'What is the approved test-label color?'
const approvedText = 'D01_APPROVED_BODY_42: the test label is turquoise.'
const attachment = { kind: 'browser', label: 'Approved QA note',
  sourceRef: { resourceId: 'd01-card', viewId: 'd01-view', url: 'https://d01.invalid/qa-note' },
  captureScope: { type: 'selection' }, content: { text: approvedText, truncated: false } }
const owner = 'd01-synthetic-owner@example.invalid'

// Only an in-process duplex boundary: no subprocess, PID, CLI executable or model.
function openWire(lines, allFrames) {
  const wire = new EventEmitter()
  wire.stdin = new PassThrough(); wire.stdout = new PassThrough(); wire.stderr = new PassThrough()
  wire.send = frame => wire.stdout.write(JSON.stringify(frame) + '\n')
  let pending = ''
  wire.stdin.setEncoding('utf8')
  wire.stdin.on('data', chunk => {
    pending += chunk
    for (let end; (end = pending.indexOf('\n')) !== -1;) {
      const line = pending.slice(0, end + 1)
      pending = pending.slice(end + 1)
      const frame = JSON.parse(line)
      allFrames.push({ wire, frame })
      if (frame.type === 'user') lines.push(line)
      if (frame.type === 'control_request' && ['initialize', 'interrupt'].includes(frame.request.subtype)) {
        queueMicrotask(() => wire.send({ type: 'control_response', response: { subtype: 'success',
          request_id: frame.request_id, response: { commands: [] } } }))
      }
    }
  })
  wire.stdin.once('end', () => setImmediate(() => {
    wire.stdout.end(); wire.stderr.end(); wire.emit('exit', 0, null); wire.emit('close', 0, null)
  }))
  wire.kill = () => { wire.stdin.end(); return true }
  process.nextTick(() => wire.emit('spawn'))
  return wire
}

test('D-01 follow-up: test-supplied MCP tool-use over the real Claude NDJSON wire', async t => {
  assert.ok(process.env.TMPDIR, 'run with a private TMPDIR')
  const dir = await mkdtemp(join(process.env.TMPDIR, 'd01-'))
  const store = openChatStore({ dataDir: join(dir, 'chat'), ownerScope: 'd01-synthetic' })
  const mode = 'on'
  let chat
  const lines = [], frames = [], decisions = [], events = [], transportInstances = [], serverRequests = []
  const contextStore = new ImmutableContextStore({ dataDir: join(dir, 'context'), allowedRoots: [dir] })
  const contexts = new ContextRuntime({ store: contextStore,
    reader: { read() { assert.fail('Codex Reader must not run') }, disconnect() {} },
    getOwnerKey: () => null, getAuthority: hints => chat.contextAuthority(hints), schemaReady: () => true })
  const claude = createClaudeEngineAdapter({
    defaultCwd: dir, collectContextUsage: false,
    snapshot: () => ({ installed: true, version: '2.1.300', versionStatus: 'untested',
      auth: { status: 'signedIn', method: 'claudeai', account: owner, label: 'Synthetic only' } }),
    resolveExecutable: () => '/nonexistent/d01-claude',
    transportOptions: { managedMcpConfig: false, processGroup: false,
      execFileImpl: () => assert.fail('Unexpected executable version probe'),
      spawnImpl(executable, args) {
        assert.equal(executable, '/nonexistent/d01-claude')
        const wire = openWire(lines, frames)
        const flag = args.indexOf('--mcp-config')
        wire.mcpServers = flag < 0 ? {} : JSON.parse(args[flag + 1]).mcpServers
        transportInstances.push(wire)
        return wire
      } },
  })
  t.after(async () => { await claude.dispose(); store.close(); await rm(dir, { recursive: true, force: true }) })
  chat = new CodexChatRuntime({ engines: [createCodexEngineAdapter({ request: () => assert.fail("Unexpected Codex request"), respond: () => assert.fail("Unexpected Codex response") }), claude], store, requireStore: true, contexts, verifyFile: async () => null,
    profiles: { runProfile: id => ({ binding: { profileId: id, revision: 1, hash: 'd01-qa-agent' },
      developerInstructions: 'Answer the question.', toolCeiling: null, model: { engine: 'claude' } }) },
    emit: event => events.push(event),
    decisionContext: { mode: () => mode, configured: () => true, budgetMs: 5000,
      client: { model: 'd01-fake-decision', async decide(request) {
        decisions.push(request)
        return { answers: Object.fromEntries(request.questions.map(q => [q.name, q.type === 'choice' ?
          { type: 'choice', choice: q.choices[0].value, confidence: 0.95, probabilities: [{ value: q.choices[0].value, probability: 0.95 }] } :
          { type: 'predicate', probability: 0.95 }])), model: this.model, usage: { inputTokens: 1 }, latencyMs: 1 }
      } },
      collect: async ({ body, context, memoryEvidenceFor, speech }) => {
        const result = await collectDecisionCandidates({ body, memoryEvidenceFor, speech, clientThreadId: context.clientThreadId,
          excludeMessageId: context.localMessageId, chatStore: store })
        return result.candidates
      },
    },
  })
  claude.subscribe({
    notification: (_, message) => chat.handleNotification(message),
    serverRequest: (_, message) => { serverRequests.push(message); return chat.handleServerRequest(message) },
    connection: (id, state) => chat.setConnection(id, state.ready, state),
  })
  claude.syncStatus()
  const route = { engineId: 'claude', engineProfileId: 'claude-default', clientThreadId: 'd01-attachment-on' }
  const authority = chat.contextAuthority(route)
  const scope = contexts.capabilities(authority).expectedContextScope
  assert.match(scope, /^[a-f0-9]{64}$/)
  const unselectedText = 'D01_UNAPPROVED_BODY_73: this capture is not approved for this turn.'
  const { captures: [unselected] } = await contexts.capture({ ...route, expectedContextScope: scope, attachments: [{ ...attachment,
    label: 'Not approved for this turn', sourceRef: { ...attachment.sourceRef, resourceId: 'd01-card-unapproved', viewId: 'd01-view-unapproved' },
    content: { text: unselectedText, truncated: false } }] }, authority)
  const base = { ...route, profileId: 'd01-qa-agent', replyDestination: 'direct', message: question, contextCapabilities: { reader: false } }
  const run = await chat.send({ ...base, expectedContextScope: scope, requestId: 'd01-attachment-on', attachments: [attachment] })
  assert.equal(run.accepted, true)
  assert.equal(lines.length, 1)
  const userWire = JSON.parse(lines[0])
  const prefix = '[EG-Desk context: egdesk_context]\n'
  const descriptor = JSON.parse(userWire.message.content.find(b => b.text.startsWith(prefix)).text.slice(prefix.length))
  assert.match(userWire.message.content.find(b => b.text.startsWith('[EG-Desk context: egdesk_channel]\n')).text, /direct conversation/)
  assert.equal(userWire.message.content.at(-1).text, question)
  assert.ok(userWire.message.content.some(b => b.text.startsWith('[EG-Desk context: egdesk_decision_context]\n')))
  assert.equal(descriptor.captures.length, 1)
  const approvedId = descriptor.captures[0].sourceId
  assert.notEqual(unselected.sourceId, approvedId)
  assert.ok(!lines[0].includes(unselected.sourceId))
  assert.ok(!lines[0].includes(approvedText) && !lines[0].includes(unselectedText))
  const engineWire = transportInstances[0]
  const [server] = Object.keys(engineWire.mcpServers)
  assert.deepEqual(Object.keys(engineWire.mcpServers), ['egdesk'])
  assert.equal(engineWire.mcpServers[server].type, 'sdk')
  const pending = new Map()
  const received = []
  let rpc = 0
  const call = async (wire, method, params, requestId) => {
    const id = ++rpc
    assert.equal(pending.has(requestId), false)
    const payload = { type: 'control_request', request_id: requestId, request: { subtype: 'mcp_message', server_name: server,
      message: { jsonrpc: '2.0', id, method, ...(params ? { params } : {}) } } }
    pending.set(requestId, payload)
    wire.send(payload)
    const deadline = performance.now() + 2000
    while (performance.now() < deadline) {
      const matches = frames.filter(x => x.wire === wire && x.frame.type === 'control_response' && x.frame.response.request_id === requestId)
      assert.ok(matches.length <= 1)
      if (matches.length) {
        const res = matches[0].frame.response
        assert.equal(res.subtype, 'success')
        const reply = res.response.mcp_response
        assert.equal(reply.id, id)
        received.push({ request: payload, reply: matches[0].frame })
        return reply
      }
      await new Promise(resolve => setTimeout(resolve, 2))
    }
    assert.fail(`No Claude wire response for ${requestId}`)
  }
  const advertised = await call(engineWire, 'tools/list', null, 'd01-read-catalog')
  const readTool = advertised.result.tools.find(tool => descriptor.instruction.includes(tool.name) && tool.inputSchema.required.includes('snapshotId'))
  assert.equal(readTool.name, 'egdesk_read_source')
  const read = (wire, snapshotId, label, activeTurn) => {
    const toolUseId = `toolu_d01_${label}`
    const args = { snapshotId, intent: 'Read the one selected QA note', range: { startLine: 1, endLine: 1 } }
    // Simulated engine selection. The tool_use block is a stream notification;
    // Claude's SDK actually invokes the bridge via mcp_message/tools/call.
    if (activeTurn) wire.send({ type: 'assistant', session_id: run.conversationId, parent_tool_use_id: null,
      message: { id: `msg_d01_${label}`, role: 'assistant', content: [{ type: 'tool_use', id: toolUseId, name: `mcp__${server}__${readTool.name}`, input: args }] } })
    return call(wire, 'tools/call', { name: readTool.name, arguments: args, _meta: { 'claudecode/toolUseId': toolUseId } }, `d01-read-${label}`)
  }
  const a = await read(engineWire, approvedId, 'approved', true)
  assert.notEqual(a.result.isError, true)
  const packet = JSON.parse(a.result.content[0].text)
  assert.equal(packet.sourceId, approvedId)
  assert.equal(packet.sourceHash, descriptor.captures[0].hash)
  assert.equal(packet.content.text, approvedText)
  assert.ok(!JSON.stringify(a).includes(unselectedText))
  const b = await read(engineWire, unselected.sourceId, 'unapproved', true)
  assert.equal(b.result.isError, true)
  assert.equal(JSON.parse(b.result.content[0].text).error.code, 'CONTEXT_FORBIDDEN')
  assert.ok(!JSON.stringify(b).includes(unselectedText) && !JSON.stringify(b).includes(approvedText))
  const stop = await chat.interrupt(run)
  assert.equal(stop.stopRequested, true)
  assert.equal(frames.filter(x => x.wire === engineWire && x.frame.type === 'control_request' && x.frame.request.subtype === 'interrupt').length, 1)
  engineWire.send({ type: 'result', subtype: 'success', is_error: false, session_id: run.conversationId })
  await new Promise(resolve => setImmediate(resolve)); await chat.queue
  assert.ok(events.some(e => e.runId === run.runId && e.event === 'run.completed' && e.details?.status === 'interrupted'), JSON.stringify(events.map(e => [e.runId, e.event, e.details?.status])))
  const stopped = await read(engineWire, approvedId, 'after_stop', false)
  assert.equal(stopped.result.isError, true)
  assert.deepEqual(JSON.parse(stopped.result.content[0].text).error, { code: 'EGDESK_TOOL_REFUSED', message: 'No matching EG-Desk run' })
  assert.ok(!JSON.stringify(stopped).includes(approvedText) && !JSON.stringify(stopped).includes(unselectedText))
  const next = await chat.send({ ...base, conversationId: run.conversationId, requestId: 'd01-read-with-selection-removed' })
  assert.equal(next.accepted, true)
  assert.equal(next.conversationId, run.conversationId)
  assert.notEqual(next.runId, run.runId)
  assert.equal(lines.length, 2)
  assert.ok(!lines[1].includes(approvedId) && !lines[1].includes(unselected.sourceId) && !lines[1].includes(approvedText))
  const nextWire = transportInstances.at(-1)
  const nextCatalog = await call(nextWire, 'tools/list', null, 'd01-read-catalog-next')
  assert.ok(nextCatalog.result.tools.some(tool => tool.name === readTool.name), 'tool still registered, but A approval was not carried to the next turn')
  const removed = await read(nextWire, approvedId, 'selection_removed', true)
  assert.equal(removed.result.isError, true)
  assert.equal(JSON.parse(removed.result.content[0].text).error.code, 'CONTEXT_FORBIDDEN')
  assert.ok(!JSON.stringify(removed).includes(approvedText) && !JSON.stringify(removed).includes(unselectedText))
  await new Promise(resolve => setImmediate(resolve)); await chat.queue
  const reads = serverRequests.filter(message => message.method === 'item/tool/call')
  assert.deepEqual(reads.map(({ params }) => [params.tool, params.callId, params.turnId, params.arguments.snapshotId]), [
    [readTool.name, 'toolu_d01_approved', run.runId, approvedId],
    [readTool.name, 'toolu_d01_unapproved', run.runId, unselected.sourceId],
    [readTool.name, 'toolu_d01_after_stop', null, approvedId],
    [readTool.name, 'toolu_d01_selection_removed', next.runId, approvedId],
  ])
  assert.equal(decisions.length, 1)
  const delivered = events.filter(e => e.event === 'context.read.completed')
  assert.equal(delivered.length, 1)
  assert.equal(delivered[0].details.sourceId, approvedId)
  assert.equal(delivered[0].runId, run.runId)
  t.diagnostic(JSON.stringify({ approvedId, unselectedId: unselected.sourceId, readTool: readTool.name,
    initialUserContent: userWire.message.content, a: packet, b: b.result, stopped: stopped.result, removed: removed.result,
    observedReadCompletions: delivered.length, decisionCalls: decisions.length, wireRoundTrips: received }))
  nextWire.send({ type: 'result', subtype: 'success', is_error: false, session_id: next.conversationId })
  await new Promise(resolve => setImmediate(resolve)); await chat.queue
})
