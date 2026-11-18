import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { CodexChatRuntime } from './codex-chat-runtime.mjs'
import { openChatStore } from './egdesk-chat-store.mjs'
import { createPrivateQaTempDirectory } from '../scripts/egdesk-qa-platform.mjs'

const MAIN = 'codex-default'
const WORK = 'codex-abcdef01'
const owner = value => createHash('sha256').update(value).digest('hex')

async function fixture(t) {
  const dataDir = createPrivateQaTempDirectory('egdesk-agent-account-')
  const open = () => openChatStore({ dataDir, ownerScope: 'local-desktop-test' })
  let store = open()
  t.after(async () => { store.close(); await rm(dataDir, { recursive: true, force: true }) })
  let active = MAIN, workReady = true, workOwner = 'account-work'
  const slots = new Map([[MAIN, 'available'], [WORK, 'available']])
  const calls = [], replies = [], threads = new Map()
  let serial = 0
  const key = slot => slot === MAIN ? 'account-main' : slot === WORK ? workOwner : null
  const profiles = {
    calls: [],
    runProfile(profileId, revision) {
      this.calls.push([profileId, revision])
      const n = revision ?? 3
      if (profileId === 'unknown-agent') throw Object.assign(new Error('Agent not found'), { code: 'PROFILE_NOT_FOUND' })
      const engineProfileId = profileId === 'work' && n !== 1 ? WORK : profileId === 'legacy' ? null : MAIN
      return { binding: { profileId, revision: n, hash: `${profileId}/${n}` }, developerInstructions: 'Fixture agent', model: { engine: 'codex', engineProfileId, modelId: 'saved-model', effort: null } }
    },
  }
  const engine = {
    id: 'codex', describe: () => ({ id: 'codex', version: '0.162.1', profiles: [...slots].map(([id, status]) => ({ id, status, active: id === active })) }),
    refresh: async () => ({}), dispose() {}, subscribe() { return () => {} },
    capabilities: () => new Set(['stream', 'resume', 'interrupt', 'modelSelect.perTurn']),
    async ensureReady(slot) { calls.push(['ensure', slot]); return this.isReady(slot) },
    isReady: (slot = active) => slots.get(slot) === 'available' && (slot !== WORK || workReady),
    ownerKey: (slot = active) => key(slot),
    request(method, params, slot = active) { throw new Error(`Unexpected ${method} for ${slot}`) },
    respond(id, result, error, slot = active) { replies.push({ id, result, error, slot }); return true },
    async startThread(params, slot = active) {
      calls.push(['thread/start', slot, params])
      const thread = { id: `thread-${++serial}`, turns: [] }; threads.set(thread.id, { slot, thread }); return { thread, model: params.model }
    },
    async resumeThread(params, slot = active) {
      calls.push(['thread/resume', slot, params]); assert.equal(threads.get(params.threadId)?.slot, slot)
      return { thread: threads.get(params.threadId).thread }
    },
    async startTurn(params, slot = active) {
      calls.push(['turn/start', slot, params]); assert.equal(threads.get(params.threadId)?.slot, slot)
      const turn = { id: `turn-${++serial}`, status: 'inProgress', items: [] }; threads.get(params.threadId).thread.turns.push(turn); return { turn }
    },
    async releaseThread() { return { status: 'unsubscribed' } },
    async interruptTurn(threadId, turnId, slot = active) { calls.push(['turn/interrupt', slot, { threadId, turnId }]) },
  }
  const runtime = () => {
    const chat = new CodexChatRuntime({ engines: [engine], profiles, store, requireStore: true, getOwnerKey: () => key(active) })
    chat.setConnection(true)
    return chat
  }
  const complete = (chat, run, slot) => {
    const turn = threads.get(run.conversationId).thread.turns.find(turn => run.runId === turn.id)
    turn.status = 'completed'
    return chat.handleNotification({ method: 'turn/completed', params: { threadId: run.conversationId, turn } }, 'codex', slot)
  }
  return { engine, runtime, complete, calls, replies, profiles, slots, get store() { return store },
    restart() { store.close(); store = open(); return runtime() },
    get active() { return active }, set active(id) { active = id },
    set workReady(value) { workReady = value }, set workOwner(value) { workOwner = value },
  }
}

const send = (chat, room, request, extra = {}) => chat.send({ clientThreadId: room, requestId: request, message: request, ...extra })
const runState = (chat, run) => chat.snapshot(run.conversationId).runs.find(row => row.runId === run.runId)

test('saved revisions isolate two concurrent accounts; request slot hints cannot change routing, and per-turn overrides do not move a running model', async t => {
  const f = await fixture(t), chat = f.runtime()
  const [a, b] = await Promise.all([
    send(chat, 'main', 'one', { profileId: 'work', profileRevision: 1, engineProfileId: WORK }),
    send(chat, 'work', 'two', { profileId: 'work', engineProfileId: MAIN }),
  ])
  assert.deepEqual(f.profiles.calls, [['work', 1], ['work', undefined]], 'runtime resolved one trusted revision per send')
  assert.deepEqual([runState(chat, a).engine.engineProfileId, runState(chat, b).engine.engineProfileId], [MAIN, WORK])
  assert.deepEqual([runState(chat, a).accountIdentity.ownerHash, runState(chat, b).accountIdentity.ownerHash], [owner('account-main'), owner('account-work')])
  assert.equal(f.active, MAIN)
  const approval = { id: 'work/1', method: 'item/commandExecution/requestApproval', params: { threadId: b.conversationId, turnId: b.runId, itemId: 'cmd', command: 'pwd' } }
  await chat.handleServerRequest(approval, 'codex', MAIN)
  assert.equal(runState(chat, b).pendingApprovals.length, 0, 'another slot cannot inject a callback into the work thread')
  await chat.handleServerRequest(approval, 'codex', WORK)
  const approvalId = runState(chat, b).pendingApprovals[0].approvalId
  await chat.replyApproval({ ...b, approvalId, decision: 'decline' })
  assert.equal(f.replies.at(-1).slot, WORK)
  await assert.rejects(send(chat, 'work', 'blocked', { conversationId: b.conversationId, model: 'new-model' }), { code: 'RUN_IN_PROGRESS' })
  assert.equal(runState(chat, b).parentTurnConfiguration.model, 'saved-model')
  await f.complete(chat, b, WORK)
  const next = await send(chat, 'work', 'next', { conversationId: b.conversationId, profileId: 'work', model: 'new-model' })
  assert.equal(runState(chat, next).parentTurnConfiguration.model, 'new-model')
  assert.deepEqual(f.calls.filter(([op]) => op === 'turn/start').map(([, slot, params]) => [slot, params.model]), [[MAIN, 'saved-model'], [WORK, 'saved-model'], [WORK, 'new-model']])
  chat.setConnection('codex', false, { engineProfileId: WORK, processLost: true })
  assert.equal(runState(chat, next).status, 'failed')
  assert.equal(runState(chat, a).status, 'inProgress')
  assert.equal(f.active, MAIN)
})

test('persisted binding survives store/runtime restart and refuses a different saved slot or changed owner before native dispatch', async t => {
  const f = await fixture(t), chat = f.runtime()
  const first = await send(chat, 'work', 'first', { profileId: 'work' })
  await f.complete(chat, first, WORK)
  const restarted = f.restart()
  const route = { conversationId: first.conversationId, clientThreadId: 'work' }
  assert.deepEqual(restarted.requestEngineRoute(route, { verifyAccount: false }), { engineId: 'codex', engineProfileId: WORK })
  assert.equal(f.store.getConversation('work').engineProfileId, WORK)
  const before = f.calls.length
  await assert.rejects(send(restarted, 'work', 'conflict', { ...route, profileId: 'main', model: 'new-model' }), { code: 'ENGINE_PROFILE_CONFLICT', httpStatus: 409 })
  assert.equal(f.calls.length, before)
  await restarted.resume(route)
  assert.equal(runState(restarted, first).engine.engineProfileId, WORK)
  const next = await send(restarted, 'work', 'next', route)
  assert.equal(runState(restarted, next).engine.engineProfileId, WORK)
  assert.deepEqual(f.calls.slice(before).filter(([op]) => op !== 'ensure').map(([op, slot]) => [op, slot]), [['thread/resume', WORK], ['turn/start', WORK]])
  await f.complete(restarted, next, WORK)
  const nativeBefore = f.calls.filter(([op]) => op !== 'ensure').length
  f.workOwner = 'changed-work-owner'
  await assert.rejects(send(restarted, 'work', 'other-owner', route), { code: 'NATIVE_ACCOUNT_MISMATCH' })
  await assert.rejects(restarted.resume(route), { code: 'NATIVE_ACCOUNT_MISMATCH' })
  assert.equal(f.calls.filter(([op]) => op !== 'ensure').length, nativeBefore)
  assert.equal(f.active, MAIN)
})

test('a missing, disabled, offline or unsigned saved slot fails closed; null selections use the active account', async t => {
  const f = await fixture(t), chat = f.runtime()
  f.slots.delete(WORK)
  await assert.rejects(send(chat, 'missing', 'missing', { profileId: 'work' }), { code: 'ENGINE_PROFILE_UNAVAILABLE' })
  f.slots.set(WORK, 'disabled')
  await assert.rejects(send(chat, 'disabled', 'disabled', { profileId: 'work' }), { code: 'ENGINE_PROFILE_UNAVAILABLE' })
  f.slots.set(WORK, 'available'); f.workReady = false
  await assert.rejects(send(chat, 'offline', 'offline', { profileId: 'work' }), { code: 'ENGINE_UNAVAILABLE' })
  f.workReady = true; f.workOwner = null
  await assert.rejects(send(chat, 'unsigned', 'unsigned', { profileId: 'work' }), { code: 'NATIVE_ACCOUNT_UNVERIFIED' })
  await assert.rejects(send(chat, 'unknown', 'unknown', { profileId: 'unknown-agent' }), { code: 'PROFILE_NOT_FOUND' })
  assert.equal(f.calls.some(([op]) => op === 'thread/start' || op === 'turn/start'), false)
  for (const room of ['missing', 'disabled', 'offline', 'unsigned', 'unknown']) assert.equal(f.store.getConversation(room), null)
  const plain = await send(chat, 'legacy', 'legacy', { profileId: 'legacy', engineProfileId: WORK })
  assert.equal(runState(chat, plain).engine.engineProfileId, MAIN)
  assert.equal(f.active, MAIN)
})
