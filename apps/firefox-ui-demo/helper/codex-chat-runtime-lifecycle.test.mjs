import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { createChatHttpHandler } from './codex-bridge-http.mjs'
import { createChatEngineAuth } from './codex-bridge-engine-auth.mjs'
import { CodexChatRuntime } from './codex-chat-runtime.mjs'
import { CODEX_ENGINE_PROFILE_ID as SHARED, createCodexEngineAdapter, describeCodexEngine } from './codex-engine-adapter.mjs'

const OWNED = 'codex-abcdef01'
const OTHER = 'codex-12345678'
const session = (id, extra = {}) => ({ clientThreadId: id, requestId: id, message: 'Synthetic message', ...extra })
const state = (chat, run) => chat.snapshot(run.conversationId).runs.find(row => row.runId === run.runId)

function fixture() {
  let serial = 0, sharedReady = true
  const replies = [], canceled = [], contextLifecycle = []
  const request = (method, params) => {
    if (method === 'thread/start') return { thread: { id: `thread-${++serial}` } }
    if (method === 'turn/start') return { turn: { id: `turn-${++serial}`, status: 'inProgress', items: [] } }
    throw new Error(`Unexpected ${method}`)
  }
  const engine = createCodexEngineAdapter({
    request, respond: (...args) => replies.push([SHARED, ...args]), isReady: () => sharedReady,
    getOwnerKey: () => 'synthetic/shared',
    describe: () => describeCodexEngine({ ready: sharedReady, extraProfiles: [OWNED, OTHER].map(id => ({ id, runnable: true })) }),
    profiles: {
      ensureReady: async () => true,
      snapshot: id => ({ auth: { isLoggedIn: true, accountType: 'chatgpt', accountEmail: `${id}@example.invalid` } }),
      request: (_id, method, params) => request(method, params),
      respond: (id, ...args) => replies.push([id, ...args]),
    },
  })
  const contexts = {
    getAuthority() {},
    disconnect: scope => contextLifecycle.push(['disconnect', scope]),
    reset: scope => contextLifecycle.push(['reset', scope]),
  }
  const profiles = { runProfile: id => ({
    binding: { profileId: id, revision: 1, hash: id }, developerInstructions: 'Synthetic profile',
    model: { engine: 'codex', engineProfileId: id },
  }) }
  const toolProviders = [{ providerId: 'test-provider', cancelRun: run => canceled.push(run.runId), reset: () => canceled.push('global reset'), disconnect: () => canceled.push('global disconnect') }]
  const chat = new CodexChatRuntime({ engines: [engine], profiles, contexts, toolProviders, getOwnerKey: () => 'synthetic/shared' })
  chat.setConnection(true)
  return { chat, replies, canceled, contextLifecycle, set sharedReady(value) { sharedReady = value } }
}

async function callbacks(chat, run, slot, label) {
  const params = { threadId: run.conversationId, turnId: run.runId }
  await chat.handleServerRequest({ id: `${label}-approval`, method: 'item/commandExecution/requestApproval', params: { ...params, itemId: 'cmd', command: 'echo synthetic' } }, 'codex', slot)
  await chat.handleServerRequest({ id: `${label}-input`, method: 'item/tool/requestUserInput', params: { ...params, itemId: 'question', questions: [{ id: 'answer', header: 'Fixture', question: 'What should this unit test answer?', options: null }] } }, 'codex', slot)
  return state(chat, run)
}

test('shared Codex disconnect and sign-out preserve owned runs, buffered work and live callbacks', async () => {
  const f = fixture(), { chat } = f
  const [legacy, shared, owned, other] = await Promise.all([
    chat.send(session('legacy')), chat.send(session('shared', { profileId: SHARED })),
    chat.send(session('owned', { profileId: OWNED })), chat.send(session('other', { profileId: OTHER })),
  ])
  await callbacks(chat, shared, SHARED, 'shared')
  const { pendingApprovals: [approval], pendingUserInputs: [input] } = await callbacks(chat, owned, OWNED, 'owned')
  assert.ok(approval && input)
  const [sharedEpoch, ownedEpoch, otherEpoch] = [SHARED, OWNED, OTHER].map(slot => chat.epochOf('codex', slot))
  const queued = chat.handleNotification({ method: 'item/agentMessage/delta', params: { threadId: owned.conversationId, turnId: owned.runId, itemId: 'answer', delta: 'Still running' } }, 'codex', OWNED)
  f.sharedReady = false
  chat.setConnection(false)
  assert.equal(state(chat, legacy).status, 'unknown')
  assert.equal(state(chat, shared).status, 'unknown')
  assert.equal(state(chat, shared).pendingApprovals.length, 0)
  assert.equal(state(chat, shared).pendingUserInputs.length, 0)
  assert.equal(state(chat, owned).status, 'inProgress')
  assert.equal(state(chat, other).status, 'inProgress')
  assert.equal(chat.epochOf('codex', SHARED), sharedEpoch + 1)
  assert.equal(chat.epochOf('codex', SHARED), chat.epochOf('codex'))
  assert.equal(chat.epochOf('codex', OWNED), ownedEpoch)
  assert.equal(chat.epochOf('codex', OTHER), otherEpoch)
  chat.reset()
  await queued
  assert.equal(state(chat, legacy), undefined)
  assert.equal(state(chat, shared), undefined)
  assert.equal(chat.requests.has('legacy'), false)
  assert.equal(chat.requests.has('shared'), false)
  assert.equal(chat.requests.has('owned'), true)
  assert.equal(chat.requests.has('other'), true)
  assert.equal(chat.loadedThreads.has(owned.conversationId), true)
  assert.match(state(chat, owned).messages.map(item => item.text).join(), /Still /)
  assert.equal(chat.epochOf('codex', OWNED), ownedEpoch)
  assert.equal(chat.epochOf('codex', OTHER), otherEpoch)
  assert.deepEqual(new Set(f.canceled), new Set([legacy.runId, shared.runId]))
  assert.deepEqual(f.contextLifecycle, [
    ['disconnect', { engineId: 'codex', processLost: false, engineProfileId: SHARED }],
    ['reset', { engineId: 'codex', engineProfileId: SHARED }],
  ])
  await chat.replyApproval({ ...owned, approvalId: approval.approvalId, decision: 'accept' })
  await chat.replyUserInput({ ...owned, userInputId: input.userInputId, action: 'submit', answers: [{ questionId: 'answer', text: 'Synthetic reply' }] })
  assert.deepEqual(f.replies.map(([slot, id]) => [slot, id]), [[OWNED, 'owned-approval'], [OWNED, 'owned-input']])
})

test('owned transport loss and reset leave shared and sibling generations intact', async () => {
  const { chat } = fixture()
  const a = await chat.send(session('owned', { profileId: OWNED }))
  const b = await chat.send(session('other', { profileId: OTHER }))
  const c = await chat.send(session('legacy'))
  const [epoch, otherEpoch, sharedEpoch] = [OWNED, OTHER, SHARED].map(slot => chat.epochOf('codex', slot))
  chat.setConnection('codex', false, { engineProfileId: OWNED, processLost: true })
  assert.equal(state(chat, a).status, 'failed')
  chat.reset('codex', { engineProfileId: OWNED })
  assert.equal(state(chat, a), undefined)
  assert.equal(state(chat, b).status, 'inProgress')
  assert.equal(state(chat, c).status, 'inProgress')
  assert.deepEqual([OWNED, OTHER, SHARED].map(slot => chat.epochOf('codex', slot)), [epoch + 2, otherEpoch, sharedEpoch])
})


test('tagged events for the wrong Codex slot cannot affect an identically named run', async () => {
  const { chat } = fixture()
  const run = await chat.send(session('owned', { profileId: OWNED }))
  const turn = { id: run.runId, status: 'completed', items: [] }
  const notification = { method: 'turn/completed', params: { threadId: run.conversationId, turn } }
  for (const slot of [SHARED, OTHER, undefined]) {
    await callbacks(chat, run, slot, 'crossed')
    await chat.handleNotification(notification, 'codex', slot)
    assert.equal(state(chat, run).status, 'inProgress')
    assert.equal(state(chat, run).pendingApprovals.length, 0)
    assert.equal(state(chat, run).pendingUserInputs.length, 0)
  }
  await chat.handleNotification(notification, 'codex', OWNED)
  assert.equal(state(chat, run).status, 'completed')
  const legacy = await chat.send(session('legacy'))
  await callbacks(chat, legacy, OWNED, 'crossed-legacy')
  assert.equal(state(chat, legacy).pendingApprovals.length, 0)
  await callbacks(chat, legacy, SHARED, 'shared-legacy')
  assert.equal(state(chat, legacy).pendingApprovals.length, 1)
})

test('Board HTTP preflights the mentioned recipient, not the signed-out shared lead', async () => {
  const f = fixture(), { chat } = f
  const checked = []
  const auth = createChatEngineAuth({ chat, refreshCodexAccount: async () => { checked.push('shared') }, getCodexAuth: () => ({ isLoggedIn: false }) })
  const handler = createChatHttpHandler(chat, (body, options) => { checked.push([body.clientThreadId, body.profileId]); return auth(body, options) })
  async function post(requestId, message) {
    const body = { clientThreadId: 'board', requestId, message, profileId: SHARED,
      members: [{ kind: 'agent', memberKey: 'owned', profileId: OWNED, label: 'Worker' }, { kind: 'agent', memberKey: 'lead', profileId: SHARED, label: 'Lead' }] }
    const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), { method: 'POST', headers: { 'content-type': 'application/json' } })
    const res = { writeHead(status) { this.status = status }, end(data) { this.body = JSON.parse(data) } }
    await handler(req, res, new URL('http://localhost/chat/board/send'))
    return res
  }
  const mentioned = await post('mentioned', '@Worker check this')
  assert.equal(mentioned.status, 202)
  const [worker] = mentioned.body.recipients
  assert.deepEqual([worker.profileId, worker.status], [OWNED, 'started'])
  assert.deepEqual(checked, [[worker.clientThreadId, OWNED]])
  const lead = await post('lead', 'No mention')
  assert.deepEqual(lead.body.recipients.map(({ profileId, status, code }) => [profileId, status, code]), [[SHARED, 'failed', 'LOGIN_REQUIRED']])
  assert.deepEqual(checked.slice(1), [['board', SHARED], 'shared'])
})

test('queued shared events are rechecked when an owned slot binds the same IDs', async () => {
  const { chat } = fixture()
  let resumeQueue
  chat.queue = new Promise(resolve => { resumeQueue = resolve })
  const params = { threadId: 'thread-1', turnId: 'turn-2' }
  const notification = chat.handleNotification({ method: 'turn/completed', params: { threadId: params.threadId, turn: { id: params.turnId, status: 'completed', items: [] } } }, 'codex', SHARED)
  const request = chat.handleServerRequest({ id: 'queued-approval', method: 'item/commandExecution/requestApproval', params: { ...params, itemId: 'cmd' } }, 'codex', SHARED)
  let run
  try { run = await chat.send(session('owned-after-events', { profileId: OWNED })) }
  finally { resumeQueue(); await Promise.all([notification, request]) }
  assert.deepEqual([run.conversationId, run.runId], [params.threadId, params.turnId])
  assert.equal(state(chat, run).status, 'inProgress')
  assert.deepEqual(state(chat, run).pendingApprovals, [])
})
