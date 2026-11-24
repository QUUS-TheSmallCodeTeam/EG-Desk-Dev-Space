// L1 c22: with EGDESK_ROOM_ACCOUNT on, a room that was switched to another account routes steer / interrupt / delete for its OLD native thread to the
// OLD account's app-server and for its NEW runs to the NEW one, live and after a restart. The runtime, store and flag are real; each app-server is a
// fake engine slot that records every call it receives. The old thread's slot comes from the store's account segments (c21), not from memory.
import test from 'node:test'
import assert from 'node:assert/strict'
import { rm } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { readdirSync } from 'node:fs'
import path from 'node:path'
import { CodexChatRuntime } from './codex-chat-runtime.mjs'
import { openChatStore } from './egdesk-chat-store.mjs'
import { createPrivateQaTempDirectory } from '../scripts/egdesk-qa-platform.mjs'

const MAIN = 'codex-default', WORK = 'codex-abcdef01'
const PROOF = { [MAIN]: 'm'.repeat(64), [WORK]: 'w'.repeat(64) }
async function fixture(t, { deleteCapable = { [MAIN]: true, [WORK]: true } } = {}) {
  const dataDir = createPrivateQaTempDirectory('egdesk-room-routing-')
  const segmentRows = () => { const file = readdirSync(dataDir, { recursive: true }).find(name => /chat-.*\.sqlite$/.test(String(name))); const db = new DatabaseSync(path.join(dataDir, String(file))); try { return db.prepare('SELECT COUNT(*) AS n FROM room_account_segments').get().n } finally { db.close() } }
  const open = () => openChatStore({ dataDir, ownerScope: 'local-desktop-test' })
  let store = open()
  t.after(async () => { try { store.close() } catch {} await rm(dataDir, { recursive: true, force: true }) })
  const slots = new Map([[MAIN, 'available'], [WORK, 'available']])
  const log = [], threads = new Map()
  let serial = 0
  const key = slot => (slot === MAIN ? 'account-main' : slot === WORK ? 'account-work' : null)
  const profiles = { runProfile(profileId, revision) {
    return { binding: { profileId, revision: revision ?? 3, hash: `${profileId}/${revision ?? 3}` }, developerInstructions: 'Fixture agent', model: { engine: 'codex', engineProfileId: profileId === 'work' ? WORK : MAIN, modelId: 'm', effort: null } }
  } }
  const engine = {
    id: 'codex', describe: () => ({ id: 'codex', version: '0.162.1', profiles: [...slots].map(([id, status]) => ({ id, status, active: id === MAIN })) }),
    refresh: async () => ({}), dispose() {}, subscribe() { return () => {} },
    capabilities: () => new Set(['stream', 'resume', 'interrupt', 'modelSelect.perTurn']),
    async ensureReady(slot) { return this.isReady(slot) }, isReady: (slot = MAIN) => slots.get(slot) === 'available', ownerKey: (slot = MAIN) => key(slot),
    request(method) { throw new Error(`Unexpected ${method}`) }, respond() { return true },
    async startThread(params, slot = MAIN) { const thread = { id: `thread-${++serial}`, turns: [] }; threads.set(thread.id, { slot, thread }); return { thread, model: params.model } },
    async resumeThread(params, slot = MAIN) { assert.equal(threads.get(params.threadId)?.slot, slot); return { thread: threads.get(params.threadId).thread } },
    async startTurn(params, slot = MAIN) { assert.equal(threads.get(params.threadId)?.slot, slot); const turn = { id: `turn-${++serial}`, status: 'inProgress', items: [] }; threads.get(params.threadId).thread.turns.push(turn); return { turn } },
    async releaseThread() { return { status: 'unsubscribed' } },
    // what each app-server receives: the slot and the thread
    async interruptTurn(threadId, turnId, slot = MAIN) { log.push(['interrupt', slot, threadId, turnId]) },
    boardPeerContract: slot => PROOF[slot ?? MAIN] ?? null,
    async steerTurn(params, slot = MAIN, proof) { log.push(['steer', slot, params.threadId, proof]); assert.equal(proof, PROOF[slot]); return { turnId: params.expectedTurnId } },
    threadDeleteSupported: slot => deleteCapable[slot ?? MAIN] === true,
    async deleteThread(threadId, slot = MAIN) { log.push(['delete', slot, threadId]); threads.delete(threadId); return {} },
  }
  const runtime = () => { const chat = new CodexChatRuntime({ engines: [engine], profiles, store, requireStore: true, getOwnerKey: () => key(MAIN), roomAccount: { mode: () => 'on' } }); chat.setConnection(true); return chat }
  const complete = (chat, run) => {
    const { slot, thread } = threads.get(run.conversationId), turn = thread.turns.find(x => x.id === run.runId)
    turn.status = 'completed'
    return chat.handleNotification({ method: 'turn/completed', params: { threadId: run.conversationId, turn } }, 'codex', slot)
  }
  return { runtime, complete, log, threads, segmentRows, get store() { return store }, restart() { store.close(); store = open(); return runtime() } }
}
const send = (chat, room, request, extra = {}) => chat.send({ clientThreadId: room, requestId: request, message: request, ...extra })

// a room that ran on MAIN, was switched to WORK, and has a new run in progress on WORK
async function switched(t, options) {
  const f = await fixture(t, options), chat = f.runtime()
  const old = await send(chat, 'room-a', 'first', { profileId: 'main' })
  await f.complete(chat, old)
  chat.switchRoomAccount({ clientThreadId: 'room-a', engineProfileId: WORK })
  const fresh = await send(chat, 'room-a', 'after', { profileId: 'main' })
  return { f, chat, old, fresh }
}

test('live: the old thread resolves to the OLD account, the new run to the NEW one; interrupt and steer of the new run reach the new account only', async t => {
  const { f, chat, old, fresh } = await switched(t)
  assert.deepEqual([chat.threadOperationSlot(old.conversationId), chat.threadOperationSlot(fresh.conversationId)], [MAIN, WORK])
  // interrupt: the person stops the new run
  assert.equal((await chat.interrupt({ conversationId: fresh.conversationId, runId: fresh.runId })).accepted, true)
  assert.deepEqual(f.log.filter(([op]) => op === 'interrupt'), [['interrupt', WORK, fresh.conversationId, fresh.runId]])
  // steer: a message typed while the new run works is steered into that turn, on the new account's server with that binary's own proof
  const run = chat.runs.get(`${fresh.conversationId}/${fresh.runId}`) ?? [...chat.runs.values()].find(r => r.runId === fresh.runId)
  chat.inRunMessageQueue.set(run, [{ requestId: 'req-steer', text: '단가만 다시', state: 'pending' }]) // models what accepting a message while the run works leaves behind
  assert.equal(await chat.settleInRunMessage(run, 'req-steer', 'steer'), 'steer')
  assert.deepEqual(f.log.filter(([op]) => op === 'steer'), [['steer', WORK, fresh.conversationId, PROOF[WORK]]])
  // nothing ever went to the old account's server
  assert.equal(f.log.some(([, slot]) => slot === MAIN), false)
})

test('live: deleting the room deletes each native thread on its own account\'s server (old thread on the old, new thread on the new)', async t => {
  const { f, chat, old, fresh } = await switched(t)
  await f.complete(chat, fresh)
  const out = await chat.forgetConversation('room-a')
  assert.deepEqual(f.log.filter(([op]) => op === 'delete').sort((x, y) => x[2].localeCompare(y[2])), [['delete', MAIN, old.conversationId], ['delete', WORK, fresh.conversationId]].sort((x, y) => x[2].localeCompare(y[2])))
  assert.deepEqual(out.engineHistory.map(r => [r.conversationId, r.state]).sort(), [[old.conversationId, 'deleted'], [fresh.conversationId, 'deleted']].sort())
  assert.equal(f.store.getConversation('room-a'), null)
  assert.deepEqual(f.store.segmentOf(old.conversationId), null)
  assert.equal(f.segmentRows(), 0, 'the room\'s account segments are gone from the database, not just unreachable')
})

test('restart: after the runtime restarts nothing is live, yet the old thread still resolves to the old account and delete reaches both servers correctly', async t => {
  const { f, chat, old, fresh } = await switched(t)
  await f.complete(chat, fresh)
  const restarted = f.restart()
  assert.equal(restarted.threadEngines.has(old.conversationId), false, 'nothing live for the old thread')
  assert.deepEqual([restarted.threadOperationSlot(old.conversationId), restarted.threadEngineProfile(old.conversationId)], [MAIN, MAIN], 'the store\'s segment says which account it ran on')
  assert.equal(restarted.threadEngineProfile(fresh.conversationId), null, 'the room\'s CURRENT thread is not a left segment: its account is the room\'s stored one (used by delete below, and when the room resumes)')
  assert.equal(restarted.threadEngineProfile('unknown-thread'), null)
  f.log.length = 0
  const out = await restarted.forgetConversation('room-a')
  assert.deepEqual(f.log.filter(([op]) => op === 'delete').map(([, slot, id]) => `${slot}:${id}`).sort(), [`${MAIN}:${old.conversationId}`, `${WORK}:${fresh.conversationId}`].sort())
  assert.deepEqual(out.engineHistory.map(r => r.state), ['deleted', 'deleted'])
})

test('restart, a second restart and a second switch: each thread keeps the account it ran on (WORK -> MAIN again)', async t => {
  const { f, chat, old, fresh } = await switched(t)
  await f.complete(chat, fresh)
  chat.switchRoomAccount({ clientThreadId: 'room-a', engineProfileId: MAIN })
  const third = await send(chat, 'room-a', 'third', { profileId: 'main' })
  await f.complete(chat, third)
  f.restart()
  const r2 = f.restart() // restarted twice: nothing but the store carries it
  assert.deepEqual([old, fresh].map(r => r2.threadOperationSlot(r.conversationId)), [MAIN, WORK], 'the two threads the room left')
  assert.deepEqual(f.store.roomSegments('room-a').map(s => [s.conversationId, s.engineProfileId]), [[old.conversationId, MAIN], [fresh.conversationId, WORK]])
  assert.equal(f.store.getConversation('room-a').engineProfileId, MAIN, 'the room itself is on its latest account')
  f.log.length = 0
  await r2.forgetConversation('room-a')
  assert.deepEqual(f.log.filter(([op]) => op === 'delete').map(([, slot, id]) => `${slot}:${id}`).sort(), [`${MAIN}:${old.conversationId}`, `${WORK}:${fresh.conversationId}`, `${MAIN}:${third.conversationId}`].sort())
})

test('delete honours each account\'s binary: a thread whose server has no thread/delete stays ("remains"), the other is deleted', async t => {
  const { f, chat, old, fresh } = await switched(t, { deleteCapable: { [MAIN]: true, [WORK]: false } })
  await f.complete(chat, fresh)
  const out = await chat.forgetConversation('room-a')
  assert.deepEqual(f.log.filter(([op]) => op === 'delete'), [['delete', MAIN, old.conversationId]])
  const byId = Object.fromEntries(out.engineHistory.map(r => [r.conversationId, r]))
  assert.deepEqual([byId[old.conversationId].state, byId[fresh.conversationId].state, byId[fresh.conversationId].reason], ['deleted', 'remains', 'unsupported'])
})

test('a room that never switched is unchanged: its one thread resolves, steers and deletes on its own account, with and without a restart', async t => {
  const f = await fixture(t), chat = f.runtime()
  const only = await send(chat, 'room-b', 'hello', { profileId: 'work' })
  await f.complete(chat, only)
  assert.equal(chat.threadOperationSlot(only.conversationId), WORK)
  const restarted = f.restart()
  assert.equal(restarted.threadEngineProfile(only.conversationId), null, 'no segment: nothing extra is claimed for it')
  await restarted.forgetConversation('room-b')
  assert.deepEqual(f.log.filter(([op]) => op === 'delete'), [['delete', WORK, only.conversationId]], 'delete uses the room\'s stored account, as before')
})
