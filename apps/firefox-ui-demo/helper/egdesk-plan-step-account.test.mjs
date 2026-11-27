// L1 c26 (owner decision: "the room keeps its account"; flag roomAccount, default off): a NEW room opened by a step of a plan that a room on an Agent
// profile proposed starts on THAT room's account. Only the plan runner's trusted internal argument can say so; the public send body stays closed to
// engineProfileId. The runtime, store and (two-account) engine fixture are real, the same shape as egdesk-room-account.test.mjs. Mocks only.
import test from 'node:test'
import assert from 'node:assert/strict'
import { rm } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { CodexChatRuntime } from './codex-chat-runtime.mjs'
import { openChatStore } from './egdesk-chat-store.mjs'
import { createPrivateQaTempDirectory } from '../scripts/egdesk-qa-platform.mjs'

const MAIN = 'codex-default', WORK = 'codex-abcdef01'
async function fixture(t, { on = true } = {}) {
  const dataDir = createPrivateQaTempDirectory('egdesk-room-account-')
  const open = () => openChatStore({ dataDir, ownerScope: 'local-desktop-test' })
  let store = open()
  t.after(async () => { try { store.close() } catch {} await rm(dataDir, { recursive: true, force: true }) })
  const flag = { on }
  const slots = new Map([[MAIN, 'available'], [WORK, 'available']])
  const calls = [], threads = new Map()
  let serial = 0
  const key = slot => (slot === MAIN ? 'account-main' : slot === WORK ? 'account-work' : null)
  const profiles = { runProfile(profileId, revision) {
    const engineProfileId = profileId === 'work' ? WORK : MAIN
    return { binding: { profileId, revision: revision ?? 3, hash: `${profileId}/${revision ?? 3}` }, developerInstructions: 'Fixture agent', model: { engine: 'codex', engineProfileId, modelId: 'saved-model', effort: null } }
  } }
  const engine = {
    id: 'codex', describe: () => ({ id: 'codex', version: '0.162.1', profiles: [...slots].map(([id, status]) => ({ id, status, active: id === MAIN })) }),
    refresh: async () => ({}), dispose() {}, subscribe() { return () => {} },
    capabilities: () => new Set(['stream', 'resume', 'interrupt', 'modelSelect.perTurn']),
    async ensureReady(slot) { return this.isReady(slot) },
    isReady: (slot = MAIN) => slots.get(slot) === 'available', ownerKey: (slot = MAIN) => key(slot),
    request(method) { throw new Error(`Unexpected ${method}`) }, respond() { return true },
    async startThread(params, slot = MAIN) { const thread = { id: `thread-${++serial}`, turns: [] }; threads.set(thread.id, { slot, thread }); calls.push(['thread/start', slot]); return { thread, model: params.model } },
    async resumeThread(params, slot = MAIN) { assert.equal(threads.get(params.threadId)?.slot, slot, 'a thread resumes on its own account'); calls.push(['thread/resume', slot]); return { thread: threads.get(params.threadId).thread } },
    async startTurn(params, slot = MAIN) { assert.equal(threads.get(params.threadId)?.slot, slot); calls.push(['turn/start', slot, params.threadId]); const turn = { id: `turn-${++serial}`, status: 'inProgress', items: [] }; threads.get(params.threadId).thread.turns.push(turn); return { turn } },
    async releaseThread() { return { status: 'unsubscribed' } }, async interruptTurn() {},
  }
  const runtime = () => { const chat = new CodexChatRuntime({ engines: [engine], profiles, store, requireStore: true, getOwnerKey: () => key(MAIN), roomAccount: { mode: () => (flag.on ? 'on' : 'off') } }); chat.setConnection(true); return chat }
  const complete = (chat, run) => {
    const { slot, thread } = threads.get(run.conversationId), turn = thread.turns.find(x => x.id === run.runId)
    turn.status = 'completed'
    return chat.handleNotification({ method: 'turn/completed', params: { threadId: run.conversationId, turn } }, 'codex', slot)
  }
  return { runtime, complete, calls, threads, flag, get store() { return store }, restart() { store.close(); store = open(); return runtime() } }
}
const send = (chat, room, request, extra = {}) => chat.send({ clientThreadId: room, requestId: request, message: request, ...extra })
const slotOf = (f, run) => f.threads.get(run.conversationId).slot


test('a new room opened with the trusted newRoomProfile starts on that account (flag on), whatever the Agent saved; the Agent\'s account is the default without it', async t => {
  const f = await fixture(t), chat = f.runtime()
  const inherited = await chat.send({ clientThreadId: 'child-1', requestId: 'r1', message: 'step', profileId: 'main' }, { newRoomProfile: WORK })
  assert.equal(slotOf(f, inherited), WORK, 'the plan room\'s account, though the Agent is saved to the default')
  assert.equal(f.store.getConversation('child-1').engineProfileId, WORK, 'and the room is pinned to it')
  await f.complete(chat, inherited)
  const again = await chat.send({ clientThreadId: 'child-1', conversationId: inherited.conversationId, requestId: 'r2', message: 'more', profileId: 'main' })
  assert.equal(slotOf(f, again), WORK, 'later messages of that room stay on it')
  const savedToWork = await chat.send({ clientThreadId: 'child-2', requestId: 'r3', message: 'step', profileId: 'work' }, { newRoomProfile: MAIN })
  assert.equal(slotOf(f, savedToWork), MAIN, 'it wins over the Agent\'s saved account too')
  const plain = await chat.send({ clientThreadId: 'child-3', requestId: 'r4', message: 'step', profileId: 'work' })
  assert.equal(slotOf(f, plain), WORK, 'no trusted profile: the Agent\'s saved account, as before')
})

test('the public send body cannot do it: engineProfileId and newRoomProfile in the body are not read; a forged one changes nothing', async t => {
  const f = await fixture(t), chat = f.runtime()
  const forged = await chat.send({ clientThreadId: 'forge-1', requestId: 'r1', message: 'x', profileId: 'main', engineProfileId: WORK, newRoomProfile: WORK })
  assert.equal(slotOf(f, forged), MAIN, 'body fields are ignored')
  assert.deepEqual(chat.requestEngineRoute({ clientThreadId: 'forge-2', profileId: 'main', engineProfileId: WORK, newRoomProfile: WORK }, { verifyAccount: false }), { engineId: 'codex', engineProfileId: null })
  const http = readFileSync(new URL('./codex-bridge-http.mjs', import.meta.url), 'utf8')
  assert.match(http, /: await chat\[action\]\(body\)/, 'the HTTP layer passes the body only: no internal argument can come from a request')
})

test('flag off: the trusted newRoomProfile is ignored; an existing room keeps its account; an unknown account is refused, not guessed', async t => {
  const f = await fixture(t, { on: false }), chat = f.runtime()
  const off = await chat.send({ clientThreadId: 'off-1', requestId: 'r1', message: 'x', profileId: 'main' }, { newRoomProfile: WORK })
  assert.equal(slotOf(f, off), MAIN, 'flag off: as today')
  f.flag.on = true
  const room = await chat.send({ clientThreadId: 'room-1', requestId: 'r2', message: 'x', profileId: 'main' })
  await f.complete(chat, room)
  const next = await chat.send({ clientThreadId: 'room-1', conversationId: room.conversationId, requestId: 'r3', message: 'y', profileId: 'main' }, { newRoomProfile: WORK })
  assert.equal(slotOf(f, next), MAIN, 'an existing room keeps the account it is pinned to')
  await assert.rejects(chat.send({ clientThreadId: 'bad-1', requestId: 'r4', message: 'x', profileId: 'main' }, { newRoomProfile: 'codex-doesnotexist' }), error => /profile|ENGINE/i.test(`${error.code} ${error.message}`))
  assert.equal(f.store.getConversation('bad-1') ?? null, null, 'nothing was stored for the refused one')
})
