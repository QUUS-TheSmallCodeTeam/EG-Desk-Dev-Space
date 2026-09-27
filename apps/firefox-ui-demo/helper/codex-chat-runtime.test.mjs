import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, chmod, symlink, rm, realpath } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { CodexChatRuntime } from './codex-chat-runtime.mjs'
import { openChatStore } from './egdesk-chat-store.mjs'
import { explicitFileLinks, publicText, verifyLocalFile } from './codex-chat-values.mjs'

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
    expectedProcessConfiguration: override.expectedProcessConfiguration,
    verifyFile: override.verifyFile || (async () => null),
  })
  chat.setConnection(true)
  const notify = (method, params) => chat.handleNotification({ method, params })
  const item = (run, value, completed = true) => notify(completed ? 'item/completed' : 'item/started', { threadId: run.conversationId, turnId: run.runId, item: value })
  const finish = (run, status = 'completed', items = []) => notify('turn/completed', { threadId: run.conversationId, turn: { id: run.runId, status, items } })
  return { chat, calls, events, legacy, replies, notify, item, finish }
}

test('ordinary Codex does not inject a default profile, model, sandbox or approval override', async () => {
  const h = harness()
  const run = await h.chat.send({ message: 'Hello', requestId: 'request-1', clientThreadId: 'ui-1', systemPrompt: 'legacy persona', agentProfile: { id: 'legacy' }, toolMode: 'unsafe' })
  assert.deepEqual(h.calls[0], { method: 'thread/start', params: {} })
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
  assert.equal(h.chat.snapshot().runs[0].activities[0].sourceRefs[0].target.path, '/work/src/main.mjs')
  assert.deepEqual(h.chat.snapshot().runs[0].artifacts, [])
})

test('artifact path verification rejects URLs, scripts, executable files, secrets and unsafe symlink targets', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'egdesk-artifact-test-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const report = path.join(directory, 'report.txt')
  const script = path.join(directory, 'run.sh')
  const executable = path.join(directory, 'executable.txt')
  const secret = path.join(directory, '.env')
  const alias = path.join(directory, 'alias.txt')
  await Promise.all([writeFile(report, 'report'), writeFile(script, 'echo secret'), writeFile(executable, 'data'), writeFile(secret, 'secret')])
  await chmod(executable, 0o755)
  await symlink(script, alias)
  assert.equal(await verifyLocalFile(report, { artifact: true }), await realpath(report))
  for (const file of [script, executable, secret, alias, 'https://example.com/a.txt', 'file:///tmp/a.txt', '//host/a.txt', 'relative.txt', directory]) assert.equal(await verifyLocalFile(file, { artifact: true }), null, file)
  assert.deepEqual(explicitFileLinks('plain /tmp/a.txt [label] [url](file:///tmp/a.txt)'), [])
})

test('public text redacts credential assignments and private keys', () => {
  const redacted = publicText('Authorization: Bearer secret-token\nOPENAI_API_KEY="hidden-value"\n-----BEGIN PRIVATE KEY-----\nxyz\n-----END PRIVATE KEY-----')
  for (const secret of ['secret-token', 'hidden-value', 'xyz']) assert.ok(!redacted.includes(secret))
})

test('resume buffers live approval requests and newer terminal events until history is hydrated', async () => {
  const h = harness({ request: async (method, params, chat) => {
    assert.equal(method, 'thread/resume')
    await chat.handleServerRequest({ id: 'resume-approval', method: 'item/fileChange/requestApproval', params: { threadId: params.threadId, turnId: 'live-turn', itemId: 'edit', reason: 'Edit file' } })
    return { thread: { id: params.threadId, turns: [{ id: 'live-turn', status: 'inProgress', items: [] }] } }
  } })
  const state = await h.chat.resume({ conversationId: 'resume-thread', clientThreadId: 'resume-ui' })
  assert.equal(state.runs[0].pendingApprovals.length, 1)
  assert.equal(h.replies.length, 0)
  assert.equal(h.events[0].clientThreadId, 'resume-ui')
  assert.equal(h.events[0].runId, 'live-turn')
})

test('early events for a different native turn never inherit the pending request ID', async () => {
  const h = harness({ request: async (method, params, chat, defaults) => {
    if (method !== 'turn/start') return defaults(method, params)
    await chat.handleNotification({ method: 'item/agentMessage/delta', params: { threadId: params.threadId, turnId: 'other-turn', itemId: 'other-message', delta: 'Other turn ' } })
    return { turn: { id: 'requested-turn', status: 'inProgress', items: [] } }
  } })
  await h.chat.send({ message: 'Requested', requestId: 'requested-id', clientThreadId: 'ui' })
  const other = h.events.find(e => e.itemId === 'other-message')
  assert.equal(other.requestId, null)
  assert.equal(other.answerId, `${other.conversationId}/other-turn`)
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
  assert.deepEqual(state.pendingApprovals[0].paths, ['/work/new-report.md'])
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

test('active-turn history restores a partial assistant item as streaming before more tokens arrive', async () => {
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
  assert.equal(h.chat.snapshot().runs[0].messages[0].text, 'Hello world ')
  assert.equal(h.chat.snapshot().runs[0].messages[0].status, 'streaming')
  await h.item({ conversationId: 'active-thread', runId: 'active-turn' }, { id: 'partial', type: 'agentMessage', text: 'Hello world!' })
  assert.equal(h.chat.snapshot().runs[0].messages[0].status, 'complete')
  assert.equal(h.chat.snapshot().runs[0].messages[0].completionConfirmed, true)
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
      listRuns: () => ({ runs: [{ localRunId: 'run-1', requestId: 'request-1', runId: 'turn-1', conversationId: 'native-1', status: 'inProgress', messages: [{ id: 'part', role: 'assistant', text: 'Partial', status: 'streaming' }] }], nextCursor: null, hasMore: false }),
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
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'egdesk-runtime-store-'))
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
