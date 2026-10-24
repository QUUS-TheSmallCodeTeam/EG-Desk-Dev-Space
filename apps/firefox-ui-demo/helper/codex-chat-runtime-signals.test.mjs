// 1-R: Codex signals the runtime used to drop — child Agent status, names and
// recent activity (CHAT-13·10), the Agent's own model (AGENT-08), and the
// changed lines and command output a screen can ask for (CODE-05·06).
import test from 'node:test'
import assert from 'node:assert/strict'
import { rm } from 'node:fs/promises'
import { CodexChatRuntime } from './codex-chat-runtime.mjs'
import { createCodexEngineAdapter } from './codex-engine-adapter.mjs'
import { openChatStore } from './egdesk-chat-store.mjs'
import { openProfileStore } from './egdesk-profile-store.mjs'
import { createPrivateQaTempDirectory } from '../scripts/egdesk-qa-platform.mjs'

function harness(override = {}) {
  const calls = [], events = [], replies = []
  let turnCount = 0, threadCount = 0
  const defaults = async (method, params) => {
    if (method === 'thread/start') return { thread: { id: `thread-${++threadCount}` }, cwd: '/work', model: 'configured-model' }
    if (method === 'thread/resume') return { thread: { id: params.threadId, turns: [] }, cwd: '/work' }
    if (method === 'thread/unsubscribe') return { status: 'unsubscribed' }
    if (method === 'turn/start') return { turn: { id: `turn-${++turnCount}`, status: 'inProgress', items: [] } }
    if (method === 'turn/interrupt') return {}
    throw new Error(`Unexpected method: ${method}`)
  }
  const request = async (method, params) => { calls.push({ method, params }); return (override.request || defaults)(method, params, defaults) }
  const respond = (...args) => replies.push(args)
  const chat = new CodexChatRuntime({
    ...(override.models ? { engines: [createCodexEngineAdapter({ request, respond, getModels: () => override.models })] } : { request, respond }),
    emit: event => events.push(event), emitLegacy: () => {},
    contexts: override.contexts, profiles: override.profiles, verifyFile: async () => null,
    ...(override.now ? { now: override.now } : {}),
  })
  chat.setConnection(true)
  const notify = (method, params) => chat.handleNotification({ method, params })
  const item = (run, value, completed = true) => notify(completed ? 'item/completed' : 'item/started', { threadId: run.conversationId, turnId: run.runId, item: value })
  const finish = (run, status = 'completed') => notify('turn/completed', { threadId: run.conversationId, turn: { id: run.runId, status, items: [] } })
  return { chat, calls, events, replies, notify, item, finish }
}

// Lets fire-and-forget reads resolve and their queued results apply.
async function settle(chat) {
  for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve))
  await chat.queue
}

const spawnItem = (extra = {}) => ({ id: 'spawn-1', type: 'collabAgentToolCall', tool: 'spawnAgent', status: 'completed', senderThreadId: 'parent',
  receiverThreadIds: ['child-1'], prompt: 'Research the change', model: 'gpt-child', agentsStates: { 'child-1': { status: 'pendingInit', message: null } }, ...extra })
const rows = h => h.chat.snapshot().runs[0].subAgents
const row = (h, threadId) => rows(h).find(candidate => candidate.threadId === threadId)
const shown = value => ({ state: value.state, nativeStatus: value.nativeStatus, waitingOn: value.waitingOn, blocked: value.blocked })

test('a child Agent’s Codex thread status shows on its parent row: waiting on approval or a question, a system error, and work resumed', async () => {
  const h = harness()
  const run = await h.chat.send({ message: 'Delegate' })
  await h.item(run, spawnItem())
  const status = (threadId, type, activeFlags) => h.notify('thread/status/changed', { threadId, status: { type, ...(activeFlags ? { activeFlags } : {}) } })
  await status('child-1', 'active', [])
  assert.deepEqual(shown(row(h, 'child-1')), { state: 'running', nativeStatus: 'active', waitingOn: [], blocked: null })
  await status('child-1', 'active', ['waitingOnUserInput'])
  assert.deepEqual(shown(row(h, 'child-1')), { state: 'running', nativeStatus: 'active', waitingOn: ['userInput'], blocked: { reason: 'userInputRequested' } })
  await status('child-1', 'active', [])
  assert.equal(row(h, 'child-1').blocked, null, 'a question is shown only while Codex says the child waits on it')
  await status('child-1', 'active', ['waitingOnApproval', 'notAFlag'])
  assert.deepEqual(shown(row(h, 'child-1')), { state: 'running', nativeStatus: 'active', waitingOn: ['approval'], blocked: { reason: 'approvalRequested' } })
  await status('child-1', 'active', [])
  assert.deepEqual(row(h, 'child-1').blocked, { reason: 'approvalRequested' }, 'a refused approval stays until a resume-type signal, as before')
  await status('child-1', 'idle')
  assert.deepEqual(shown(row(h, 'child-1')), { state: 'running', nativeStatus: 'idle', waitingOn: [], blocked: { reason: 'approvalRequested' } })
  await status('child-1', 'systemError')
  assert.deepEqual(shown(row(h, 'child-1')), { state: 'errored', nativeStatus: 'systemError', waitingOn: [], blocked: { reason: 'errored' } })
  await status('child-1', 'active', [])
  assert.deepEqual(shown(row(h, 'child-1')), { state: 'running', nativeStatus: 'active', waitingOn: [], blocked: null }, 'Codex’s own status reopens an errored child')
  const before = JSON.stringify(rows(h))
  await status('child-1', 'mystery')
  await status('stranger', 'active', ['waitingOnApproval'])
  await h.notify('thread/status/changed', { threadId: run.conversationId, status: { type: 'active', activeFlags: [] } })
  assert.equal(JSON.stringify(rows(h)), before, 'unknown statuses, unknown threads and the parent itself change nothing')
  assert.deepEqual(h.chat.snapshot().runs[0].pendingApprovals, [])
  assert.equal(h.chat.pendingUserInputs.size, 0)
  assert.deepEqual(h.replies, [])
  const updates = h.events.filter(event => event.event === 'subagent.updated')
  assert.ok(updates.length >= 8)
  for (const event of updates) assert.deepEqual(Object.keys(event.details), ['subAgent'])
  h.chat.setConnection(false)
  assert.deepEqual(shown(row(h, 'child-1')), { state: 'unknown', nativeStatus: null, waitingOn: [], blocked: null }, 'a lost connection makes the last status uncertain')
})

test('a child gets its Codex nickname and role from thread/started, or from one thread/read when Codex did not announce it', async () => {
  const reads = []
  let release = null
  const h = harness({ request: async (method, params, defaults) => {
    if (method === 'thread/read') {
      reads.push(params)
      const answer = { thread: { id: params.threadId, agentNickname: `  Nick-${params.threadId}  `, agentRole: 'reviewer', status: { type: 'active', activeFlags: [] } } }
      if (params.threadId === 'child-3') return new Promise(resolve => { release = () => resolve(answer) })
      return answer
    }
    return defaults(method, params)
  } })
  const run = await h.chat.send({ message: 'Delegate' })
  // Codex announces child-1 before the spawn item names it.
  await h.notify('thread/started', { thread: { id: 'child-1', parentThreadId: run.conversationId, agentNickname: 'Avicenna', agentRole: 'explorer', status: { type: 'active', activeFlags: ['waitingOnApproval'] } } })
  await h.notify('thread/started', { thread: { id: 'ghost', parentThreadId: 'someone-else', agentNickname: 'Ghost' } })
  await h.notify('thread/started', { thread: { id: 'not-a-child', agentNickname: 'Parentless' } })
  await h.item(run, spawnItem({ receiverThreadIds: ['child-1', 'child-2'], agentsStates: {} }))
  await settle(h.chat)
  assert.deepEqual([row(h, 'child-1').nickname, row(h, 'child-1').role], ['Avicenna', 'explorer'])
  assert.deepEqual(shown(row(h, 'child-1')), { state: 'running', nativeStatus: 'active', waitingOn: ['approval'], blocked: { reason: 'approvalRequested' } })
  assert.deepEqual([row(h, 'child-2').nickname, row(h, 'child-2').role, row(h, 'child-2').nativeStatus], ['Nick-child-2', 'reviewer', 'active'])
  assert.deepEqual(reads, [{ threadId: 'child-2', includeTurns: false }], 'only the child Codex did not announce is read')
  await h.notify('thread/status/changed', { threadId: 'child-2', status: { type: 'idle' } })
  await settle(h.chat)
  assert.equal(reads.length, 1, 'a known name is not read again')
  // A read answered after a newer live status keeps the live status.
  await h.item(run, spawnItem({ id: 'spawn-3', receiverThreadIds: ['child-3'], agentsStates: {} }))
  await h.notify('thread/status/changed', { threadId: 'child-3', status: { type: 'idle' } })
  release()
  await settle(h.chat)
  assert.deepEqual([row(h, 'child-3').nickname, row(h, 'child-3').nativeStatus], ['Nick-child-3', 'idle'])
  assert.equal(rows(h).some(child => ['ghost', 'not-a-child'].includes(child.threadId)), false)
})

test('a failed thread/read leaves the row as it was and is tried at most twice per child', async () => {
  const h = harness()
  const run = await h.chat.send({ message: 'Delegate' })
  await h.item(run, spawnItem())
  await settle(h.chat)
  for (let i = 0; i < 3; i++) {
    await h.notify('thread/status/changed', { threadId: 'child-1', status: { type: 'active', activeFlags: [] } })
    await settle(h.chat)
  }
  assert.equal(h.calls.filter(call => call.method === 'thread/read').length, 2)
  assert.deepEqual([row(h, 'child-1').nickname, row(h, 'child-1').role, row(h, 'child-1').state], [null, null, 'running'])
  assert.equal(h.chat.snapshot().runs[0].status, 'inProgress')
})

test('a child Agent’s own items become its three latest activity lines without message text, arguments or secrets', async () => {
  const h = harness()
  const run = await h.chat.send({ message: 'Delegate' })
  await h.item(run, spawnItem())
  const child = (value, completed = true) => h.notify(completed ? 'item/completed' : 'item/started', { threadId: 'child-1', turnId: 'child-turn', item: value })
  await child({ id: 'c-msg', type: 'agentMessage', text: 'CHILD_PRIVATE_ANSWER' }, false)
  await child({ id: 'c-msg', type: 'agentMessage', text: 'CHILD_PRIVATE_ANSWER' })
  await child({ id: 'c-cmd', type: 'commandExecution', command: 'curl --token CHILD_TOKEN_VALUE https://example.test', status: 'inProgress' }, false)
  await child({ id: 'c-user', type: 'userMessage', content: [{ type: 'text', text: 'CHILD_PROMPT' }] })
  await child({ id: 'c-list', type: 'collabAgentToolCall', tool: 'listAgents', status: 'completed', receiverThreadIds: [], agentsStates: {} })
  assert.deepEqual(row(h, 'child-1').recent.map(line => [line.itemId, line.kind, line.text, line.count]), [
    ['c-msg', 'message', null, null], ['c-cmd', 'command', 'curl --token [REDACTED] https://example.test', null]])
  await child({ id: 'c-edit', type: 'fileChange', status: 'completed', changes: [{ path: 'a.txt', kind: { type: 'update' }, diff: 'CHILD_DIFF' }, { path: 'b.txt', kind: { type: 'add' }, diff: 'new' }] })
  await child({ id: 'c-mcp', type: 'mcpToolCall', server: 'docs', tool: 'search', status: 'completed', arguments: { q: 'CHILD_ARG' } })
  const recent = row(h, 'child-1').recent
  assert.deepEqual(recent.map(line => [line.itemId, line.kind, line.text, line.count]), [
    ['c-cmd', 'command', 'curl --token [REDACTED] https://example.test', null], ['c-edit', 'fileChange', null, 2], ['c-mcp', 'mcpTool', 'docs/search', null]])
  assert.ok(recent.every(line => Number.isFinite(line.at)))
  await h.notify('item/completed', { threadId: 'unrelated', turnId: 't', item: { id: 'u-1', type: 'agentMessage', text: 'x' } })
  const state = h.chat.snapshot()
  assert.equal(state.runs.length, 1)
  assert.equal(state.runs[0].subAgents.length, 1)
  const exposed = JSON.stringify([h.events, state])
  for (const hidden of ['CHILD_PRIVATE_ANSWER', 'CHILD_TOKEN_VALUE', 'CHILD_DIFF', 'CHILD_ARG', 'CHILD_PROMPT']) assert.ok(!exposed.includes(hidden), hidden)
})

test('a busy child announces new activity lines at most once a second; a status change carries the lines in between', async () => {
  let clock = 1_000_000
  const h = harness({ now: () => clock })
  const run = await h.chat.send({ message: 'Delegate' })
  await h.item(run, spawnItem())
  const lineEvents = () => h.events.filter(event => event.event === 'subagent.updated' && event.details.subAgent.recent.length)
  const child = id => h.notify('item/started', { threadId: 'child-1', turnId: 'child-turn', item: { id, type: 'commandExecution', command: `step ${id}`, status: 'inProgress' } })
  await child('c-1')
  await child('c-2')
  await child('c-3')
  assert.equal(lineEvents().length, 1)
  assert.deepEqual(row(h, 'child-1').recent.map(line => line.itemId), ['c-1', 'c-2', 'c-3'], 'the row itself is current')
  await h.notify('thread/status/changed', { threadId: 'child-1', status: { type: 'idle' } })
  assert.deepEqual(lineEvents().at(-1).details.subAgent.recent.map(line => line.itemId), ['c-1', 'c-2', 'c-3'])
  clock += 1000
  await child('c-4')
  assert.deepEqual(lineEvents().at(-1).details.subAgent.recent.map(line => line.itemId), ['c-2', 'c-3', 'c-4'])
})

test('real SQLite history keeps the new child fields without poisoned keys and clears a live status after a restart', async () => {
  const dataDir = createPrivateQaTempDirectory('egdesk-runtime-signals-')
  let store = null
  try {
    store = openChatStore({ dataDir, ownerScope: 'local-desktop-test' })
    const chat = new CodexChatRuntime({
      store, requireStore: true, getOwnerKey: () => 'codex:chatgpt:account-1', emit: () => {},
      request: async (method, params) => {
        if (method === 'thread/start') return { thread: { id: 'native-1' }, cwd: '/safe/work' }
        if (method === 'turn/start') return { turn: { id: 'turn-1', status: 'inProgress', items: [] } }
        if (method === 'thread/read') return { thread: { id: params.threadId, agentNickname: 'secret', agentRole: 'password' } }
        throw new Error(`Unexpected native call: ${method}`)
      }, respond: () => {},
    })
    chat.setConnection(true)
    await chat.send({ message: 'Delegate', clientThreadId: 'ui-1', requestId: 'req-1' })
    await chat.handleNotification({ method: 'item/completed', params: { threadId: 'native-1', turnId: 'turn-1', item: spawnItem({ receiverThreadIds: ['apikey'], agentsStates: {} }) } })
    await chat.handleNotification({ method: 'thread/status/changed', params: { threadId: 'apikey', status: { type: 'active', activeFlags: ['waitingOnUserInput'] } } })
    await chat.handleNotification({ method: 'item/started', params: { threadId: 'apikey', turnId: 'c-turn', item: { id: 'systemprompt', type: 'commandExecution', command: 'ls', status: 'inProgress' } } })
    await settle(chat)
    assert.equal(chat.storeHealthy, true)
    const kept = chat.getLocalHistory({ clientThreadId: 'ui-1', limit: 500 }).runs[0].subAgents[0]
    assert.deepEqual([kept.threadId, kept.nickname, kept.role, kept.nativeStatus, kept.waitingOn, kept.recent.map(line => line.itemId)], ['apikey', 'secret', 'password', 'active', ['userInput'], ['systemprompt']])
    store.close(); store = null
    store = openChatStore({ dataDir, ownerScope: 'local-desktop-test' })
    const restarted = new CodexChatRuntime({ store, requireStore: true, getOwnerKey: () => 'codex:chatgpt:account-1', request: async () => { throw new Error('no native call') }, respond: () => {} })
    assert.equal(restarted.recoverInterruptedRuns(), 1)
    const recovered = restarted.getLocalHistory({ clientThreadId: 'ui-1', limit: 500 }).runs[0].subAgents[0]
    assert.deepEqual([recovered.state, recovered.nativeStatus, recovered.waitingOn, recovered.nickname], ['unknown', null, [], 'secret'])
  } finally {
    try { store?.close() } catch {}
    await rm(dataDir, { recursive: true, force: true })
  }
})

const profileBody = (extra = {}) => ({ name: '리오', avatar: { kind: 'initial', value: 'R' }, role: '회의 준비 담당', instructions: '결론부터 답한다.', ...extra })
function profileFixture(t, body) {
  const dataDir = createPrivateQaTempDirectory('egdesk-runtime-agent-model-')
  const profiles = openProfileStore({ dataDir, ownerHash: 'local-desktop-test' })
  t.after(async () => { profiles.close(); await rm(dataDir, { recursive: true, force: true }) })
  const created = profiles.createDraft(profileBody(body))
  profiles.activate(created.id, 1, null)
  return { profiles, id: created.id }
}

test('an Agent’s saved Codex model and effort run its turns unless the room picked one, and another engine’s model is not sent', async t => {
  const p = profileFixture(t, { model: { engine: 'codex', modelId: 'gpt-agent', effort: 'high' } })
  const bound = []
  const contexts = { prepare: async () => null, specs: () => [], bindRun: async (run, prepared, configuration) => bound.push(configuration) }
  const h = harness({ profiles: p.profiles, contexts })
  const turnStarts = () => h.calls.filter(call => call.method === 'turn/start').map(call => [call.params.model, call.params.effort])
  const first = await h.chat.send({ message: 'Hi', profileId: p.id })
  assert.equal(h.calls.find(call => call.method === 'thread/start').params.model, 'gpt-agent')
  assert.deepEqual(turnStarts(), [['gpt-agent', 'high']])
  assert.deepEqual(bound[0], { model: 'gpt-agent', effort: 'high', modelSource: 'agent-profile', effortSource: 'agent-profile' })
  await h.finish(first)
  await h.chat.send({ message: 'Room pick', conversationId: first.conversationId, profileId: p.id, model: 'gpt-room' })
  assert.deepEqual(turnStarts().at(-1), ['gpt-room', undefined], 'the room’s pick replaces the Agent’s whole selection')
  assert.deepEqual([bound[1].modelSource, bound[1].effortSource], ['turn-request', 'native-thread'])
  await h.finish({ ...first, runId: 'turn-2' })
  await h.chat.send({ message: 'Room effort', conversationId: first.conversationId, profileId: p.id, effort: 'low' })
  assert.deepEqual(turnStarts().at(-1), [undefined, 'low'])
  await h.finish({ ...first, runId: 'turn-3' })
  const claude = p.profiles.saveDraft(p.id, profileBody({ model: { engine: 'claude', modelId: 'claude-agent' } }), 1)
  p.profiles.activate(p.id, claude.revision, 1)
  await h.chat.send({ message: 'Other engine', conversationId: first.conversationId, profileId: p.id })
  assert.deepEqual(turnStarts().at(-1), [undefined, undefined], 'a model saved for another engine is not sent to Codex')
  await h.finish({ ...first, runId: 'turn-4' })
  const none = profileFixture(t, {})
  const plain = harness({ profiles: none.profiles })
  await plain.chat.send({ message: 'No model', profileId: none.id })
  assert.equal(plain.calls.find(call => call.method === 'turn/start').params.model, undefined)
})

test('an Agent model the account does not offer is refused with its own code before any native call; the room can still pick one', async t => {
  const models = [{ id: 'gpt-6-luna', displayName: 'GPT-6-Luna', isDefault: true, supportedEfforts: ['low', 'medium'], defaultEffort: 'medium' }]
  const gone = profileFixture(t, { model: { engine: 'codex', modelId: 'gpt-retired', effort: null } })
  const h = harness({ profiles: gone.profiles, models })
  await assert.rejects(h.chat.send({ message: 'Hi', profileId: gone.id }), error => error.code === 'PROFILE_MODEL_UNAVAILABLE' && error.httpStatus === 409)
  const effort = profileFixture(t, { model: { engine: 'codex', modelId: 'gpt-6-luna', effort: 'max' } })
  const e = harness({ profiles: effort.profiles, models })
  await assert.rejects(e.chat.send({ message: 'Hi', profileId: effort.id }), error => error.code === 'PROFILE_MODEL_UNAVAILABLE')
  assert.deepEqual([...h.calls, ...e.calls], [])
  await assert.rejects(h.chat.send({ message: 'Hi', profileId: gone.id, model: 'gpt-retired' }), error => error.code === 'MODEL_UNAVAILABLE', 'a room pick keeps its own error')
  const accepted = await h.chat.send({ message: 'Hi', profileId: gone.id, model: 'gpt-6-luna' })
  assert.equal(accepted.accepted, true)
  assert.deepEqual(h.calls.find(call => call.method === 'turn/start').params.model, 'gpt-6-luna')
})

test('command output streams into a head and tail the screen can ask for; it never enters events, snapshots or history', async () => {
  const h = harness()
  const run = await h.chat.send({ message: 'Run tests' })
  await h.item(run, { id: 'cmd-1', type: 'commandExecution', command: 'npm test', cwd: '/work', status: 'inProgress' }, false)
  await h.notify('item/commandExecution/outputDelta', { threadId: run.conversationId, turnId: run.runId, itemId: 'cmd-1', delta: 'ok 1\nAPI_KEY=OUTPUT_SECRET_VALUE\n' })
  await h.notify('item/commandExecution/outputDelta', { threadId: run.conversationId, turnId: run.runId, itemId: 'cmd-1', delta: 'ok 2\n' })
  let output = h.chat.commandOutput({ conversationId: run.conversationId, runId: run.runId, itemId: 'cmd-1' })
  assert.deepEqual([output.head, output.tail, output.omittedBytes, output.complete], ['ok 1\nAPI_KEY=[REDACTED]\nok 2\n', '', 0, false])
  assert.equal(output.totalBytes, Buffer.byteLength('ok 1\nAPI_KEY=OUTPUT_SECRET_VALUE\nok 2\n'))
  await h.item(run, { id: 'cmd-1', type: 'commandExecution', command: 'npm test', cwd: '/work', status: 'completed', exitCode: 0, aggregatedOutput: 'ok 1\nAPI_KEY=OUTPUT_SECRET_VALUE\nok 2\n' })
  output = h.chat.commandOutput({ conversationId: run.conversationId, runId: run.runId, itemId: 'cmd-1' })
  assert.equal(output.complete, true)
  // A command whose deltas were never seen gets Codex's own copy.
  await h.item(run, { id: 'cmd-2', type: 'commandExecution', command: 'ls', status: 'completed', exitCode: 0, aggregatedOutput: 'a\nb\n' })
  assert.equal(h.chat.commandOutput({ conversationId: run.conversationId, runId: run.runId, itemId: 'cmd-2' }).head, 'a\nb\n')
  assert.throws(() => h.chat.commandOutput({ conversationId: run.conversationId, runId: run.runId, itemId: 'cmd-9' }), { code: 'COMMAND_OUTPUT_UNAVAILABLE', httpStatus: 404 })
  assert.throws(() => h.chat.commandOutput({ conversationId: run.conversationId, runId: 'nope', itemId: 'cmd-1' }), { code: 'RUN_NOT_FOUND' })
  // Output of a turn this bridge did not start is never kept.
  await h.notify('item/commandExecution/outputDelta', { threadId: run.conversationId, turnId: 'foreign-turn', itemId: 'cmd-x', delta: 'FOREIGN_OUTPUT' })
  await h.notify('item/commandExecution/outputDelta', { threadId: 'child-1', turnId: 'child-turn', itemId: 'cmd-c', delta: 'CHILD_OUTPUT' })
  assert.deepEqual(h.chat.runOutputs.keys(), [run.answerId])
  const exposed = JSON.stringify([h.events, h.chat.snapshot()])
  for (const hidden of ['OUTPUT_SECRET_VALUE', 'ok 2', 'a\\nb', 'FOREIGN_OUTPUT', 'CHILD_OUTPUT']) assert.ok(!exposed.includes(hidden), hidden)
})

test('file-change diffs, live patch updates and the turn diff are kept per run within their limits and forgotten with the run', async () => {
  const h = harness()
  const run = await h.chat.send({ message: 'Edit' })
  const key = { conversationId: run.conversationId, runId: run.runId }
  await h.item(run, { id: 'edit-1', type: 'fileChange', status: 'inProgress', changes: [{ path: '/work/a.js', kind: { type: 'update', move_path: null }, diff: '@@ -1 +1 @@\n-old\n+new token=DIFF_SECRET\n' }] }, false)
  let changes = h.chat.runChanges(key)
  assert.equal(changes.retained, true)
  assert.deepEqual(changes.items.map(entry => [entry.itemId, entry.status, entry.files.map(file => [file.path, file.kind, file.diff, file.omitted])]), [
    ['edit-1', 'inProgress', [['/work/a.js', 'update', '@@ -1 +1 @@\n-old\n+new token=[REDACTED]\n', null]]]])
  await h.notify('item/fileChange/patchUpdated', { threadId: run.conversationId, turnId: run.runId, itemId: 'edit-1', changes: [
    { path: '/work/a.js', kind: { type: 'update', move_path: '/work/b.js' }, diff: '@@ -1 +1 @@\n-old\n+newer\n' },
    { path: '/work/big.bin', kind: { type: 'add' }, diff: 'x'.repeat(256 * 1024 + 1) },
  ] })
  await h.item(run, { id: 'edit-1', type: 'fileChange', status: 'completed', changes: [
    { path: '/work/a.js', kind: { type: 'update', move_path: '/work/b.js' }, diff: '@@ -1 +1 @@\n-old\n+newer\n' },
    { path: '/work/big.bin', kind: { type: 'add' }, diff: 'x'.repeat(256 * 1024 + 1) },
  ] })
  await h.notify('turn/diff/updated', { threadId: run.conversationId, turnId: run.runId, diff: 'diff --git a/a.js b/b.js\n' })
  changes = h.chat.runChanges(key)
  assert.deepEqual(changes.items[0].files.map(file => [file.path, file.movePath, file.diff === null, file.omitted, file.bytes]), [
    ['/work/a.js', '/work/b.js', false, null, Buffer.byteLength('@@ -1 +1 @@\n-old\n+newer\n')], ['/work/big.bin', null, true, 'fileLimit', 256 * 1024 + 1]])
  assert.equal(changes.items[0].status, 'completed')
  assert.deepEqual(changes.turn, { diff: 'diff --git a/a.js b/b.js\n', bytes: 25, omitted: null })
  assert.deepEqual(h.chat.runChanges({ ...key, itemId: 'edit-1' }).turn, null)
  assert.deepEqual(h.chat.runChanges({ ...key, itemId: 'other' }).items, [])
  const exposed = JSON.stringify([h.events, h.chat.snapshot()])
  for (const hidden of ['DIFF_SECRET', '+newer', 'diff --git']) assert.ok(!exposed.includes(hidden), hidden)
  // An account change forgets the run's outputs with the run.
  h.chat.reset()
  assert.deepEqual(h.chat.runOutputs.keys(), [])
  assert.throws(() => h.chat.runChanges(key), { code: 'RUN_NOT_FOUND' })
})

test('a turn error names the engine that ran it as its origin', async () => {
  const h = harness()
  const run = await h.chat.send({ message: 'Hi' })
  await h.notify('error', { threadId: run.conversationId, turnId: run.runId, error: { message: 'boom' }, willRetry: false })
  assert.equal(h.chat.snapshot().runs[0].error.origin, 'codex')
  await h.notify('turn/completed', { threadId: run.conversationId, turn: { id: run.runId, status: 'failed', items: [], error: { message: 'failed' } } })
  assert.deepEqual([h.chat.snapshot().runs[0].error.code, h.chat.snapshot().runs[0].error.origin], ['TURN_FAILED', 'codex'])
})
