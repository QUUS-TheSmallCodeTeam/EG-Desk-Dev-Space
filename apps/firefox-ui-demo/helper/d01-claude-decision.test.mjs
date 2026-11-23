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
      if (frame.type === 'control_request' && frame.request.subtype === 'initialize') {
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

test('D-01 ordinary Claude DM: selected attachment and selected immutable snapshot at the final NDJSON boundary', async t => {
  assert.ok(process.env.TMPDIR, 'run with a private TMPDIR')
  const dir = await mkdtemp(join(process.env.TMPDIR, 'd01-'))
  const store = openChatStore({ dataDir: join(dir, 'chat'), ownerScope: 'd01-synthetic' })
  let mode = 'off', chat
  const lines = [], frames = [], decisions = [], catalog = [], events = [], transportInstances = []
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
      spawnImpl(executable) {
        assert.equal(executable, '/nonexistent/d01-claude')
        const wire = openWire(lines, frames)
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
        catalog.push(result.candidates)
        return result.candidates
      },
    },
  })
  claude.subscribe({
    notification: (_, message) => chat.handleNotification(message),
    serverRequest: (_, message) => chat.handleServerRequest(message),
    connection: (id, state) => chat.setConnection(id, state.ready, state),
  })
  claude.syncStatus()
  for (const lane of ['attachment', 'snapshot']) {
    for (mode of ['off', 'advisory', 'on']) {
      const requestId = `d01-${lane}-${mode}`
      const route = { engineId: 'claude', engineProfileId: 'claude-default', clientThreadId: requestId }
      const authority = chat.contextAuthority(route)
      const expectedContextScope = contexts.capabilities(authority).expectedContextScope
      assert.match(expectedContextScope, /^[a-f0-9]{64}$/)
      const contextRoute = { ...route, expectedContextScope }
      let selected
      if (lane === 'attachment') selected = { attachments: [attachment] }
      else {
        const { captures } = await contexts.capture({ ...contextRoute, attachments: [attachment] }, authority)
        const original = await contextStore.getCapture(contexts.owner(authority), captures[0].sourceId)
        assert.equal(original.hash, captures[0].hash)
        selected = { contextSnapshotIds: [original.sourceId] }
      }
      const before = { lines: lines.length, decisions: decisions.length, catalog: catalog.length, events: events.length, transports: transportInstances.length }
      const result = await chat.send({ ...contextRoute, ...selected, requestId, message: question,
        profileId: 'd01-qa-agent', replyDestination: 'direct', contextCapabilities: { reader: false } })
      const persisted = store.getRequest({ clientThreadId: requestId, requestId }).outcome
      const sent = lines.slice(before.lines).map(JSON.parse)
      const reqs = decisions.slice(before.decisions)
      const rows = events.slice(before.events).filter(e => e.event === 'activity.completed' && e.details?.kind === 'decisionContext')
      const summaries = catalog.slice(before.catalog).map(cs => cs.map(c => ({ id: c.id, hasBodyLoader: typeof c.loadText === 'function' })))
      t.diagnostic(JSON.stringify({ lane, mode, accepted: result.accepted, durable: result.durable, dispatchStatus: persisted.dispatchStatus,
        decisionCalls: reqs.length, questionSends: sent.length, transportCallables: transportInstances.length - before.transports,
        candidates: summaries, decisionActivity: rows.map(e => e.details.detail), finalUserFrames: sent }))
      assert.equal(result.accepted, true)
      assert.equal(result.durable, true)
      assert.equal(persisted.accepted, true)
      assert.equal(persisted.dispatchStatus, 'confirmed')
      assert.equal(sent.length, 1)
      assert.equal(transportInstances.length - before.transports, 1)
      assert.deepEqual(Object.keys(sent[0]), ['type', 'session_id', 'message', 'parent_tool_use_id'])
      assert.equal(sent[0].type, 'user')
      assert.equal(sent[0].message.role, 'user')
      const blocks = sent[0].message.content
      assert.equal(blocks.at(-1).text, question)
      assert.equal(blocks.filter(b => b.text === question).length, 1)
      const channel = blocks.find(b => b.text.startsWith('[EG-Desk context: egdesk_channel]\n'))
      assert.ok(channel)
      const descriptor = blocks.find(b => b.text.startsWith('[EG-Desk context: egdesk_context]\n'))
      assert.ok(descriptor)
      const scoped = JSON.parse(descriptor.text.slice(descriptor.text.indexOf('\n') + 1))
      assert.equal(scoped.captures.length, 1)
      assert.equal(scoped.capabilities.read, true)
      const captured = await contextStore.readProjection(contexts.owner(authority), scoped.captures[0].sourceId)
      assert.equal(captured.text, approvedText)
      assert.match(channel.text, /direct/i)
      assert.doesNotMatch(channel.text, /D01_APPROVED_BODY_42/)
      assert.doesNotMatch(JSON.stringify(sent), /D01_APPROVED_BODY_42/)
      assert.doesNotMatch(JSON.stringify(reqs), /D01_APPROVED_BODY_42/)
      assert.equal(reqs.length, lane === 'attachment' && mode !== 'off' ? 1 : 0)
      const packet = blocks.find(b => b.text.startsWith('[EG-Desk context: egdesk_decision_context]\n'))
      assert.equal(Boolean(packet), lane === 'attachment' && mode === 'on')
      if (packet) assert.match(packet.text, /selected browser/)
      assert.equal(rows.length, reqs.length)
      if (rows.length) {
        assert.equal(rows[0].details.detail.attached, mode === 'on')
        assert.equal(rows[0].details.detail.receipt.selected[0].textSource, 'summary')
        assert.ok(reqs[0].input.some(item => item.content === `Message:\n${question}`))
        assert.equal(reqs[0].questions.length, 3)
      }
      assert.deepEqual(summaries, mode === 'off' ? [] : lane === 'snapshot' ? [[]] : [[{ id: 'selected:attachments-0', hasBodyLoader: false }]])
      assert.equal(catalog.length - before.catalog, mode === 'off' ? 0 : 1)
      const wire = transportInstances.at(-1)
      assert.equal(frames.filter(item => item.wire === wire && item.frame.type === 'user').length, 1)
      wire.send({ type: 'result', subtype: 'success', is_error: false, session_id: result.conversationId })
      await new Promise(resolve => setImmediate(resolve)); await chat.queue
    }
  }
})
