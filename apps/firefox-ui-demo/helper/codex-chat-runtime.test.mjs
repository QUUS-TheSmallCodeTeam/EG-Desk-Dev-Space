import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, chmod, symlink, rm, realpath } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { CodexChatRuntime } from './codex-chat-runtime.mjs'
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
})

test('explicit profile and model/effort are opt-in native fields', async () => {
  const h = harness()
  await h.chat.send({ message: 'Hi', profileEnabled: true, systemPrompt: 'Be concise', model: 'user-selected', effort: 'max', cwd: '/workspace' })
  assert.equal(h.calls[0].params.developerInstructions, 'Be concise')
  assert.equal(h.calls[1].params.model, 'user-selected')
  assert.equal(h.calls[1].params.effort, 'max')
  assert.equal(h.calls[1].params.input[0].text, 'Hi')
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
