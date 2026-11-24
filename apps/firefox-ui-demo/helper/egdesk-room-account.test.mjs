// L1 c21, owner decisions (1) and (2), provisional ("일단 권장대로"), behind roomAccount (EGDESK_ROOM_ACCOUNT=on), default off:
//   (1) a room keeps its account; an Agent's saved account is only the default for NEW rooms;
//   (2) an explicit switch continues the SAME room on another account: history, draft, requester, an unanswered approval question and EG-Desk
//       memory stay with it; only the engine-side thread stays with the old account. Refused while a run is in flight. Survives a restart.
// The runtime, store and broker are real; the engine is a two-account fixture (the same shape as codex-chat-runtime-agent-account.test.mjs).
import test from 'node:test'
import assert from 'node:assert/strict'
import { rm } from 'node:fs/promises'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { CodexChatRuntime } from './codex-chat-runtime.mjs'
import { openChatStore } from './egdesk-chat-store.mjs'
import { createGateHookBroker } from './egdesk-gate-hook-broker.mjs'
import { ROOM_ACCOUNT_PATH, createRoomAccountHttpHandler } from './egdesk-room-account-http.mjs'
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

test('(1) a room keeps its account: with the flag an Agent saved to another account answers in the room\'s account; without it, today\'s conflict; a NEW room uses the Agent\'s account', async t => {
  const f = await fixture(t), chat = f.runtime()
  const first = await send(chat, 'room-a', 'first', { profileId: 'main' })
  await f.complete(chat, first)
  const next = await send(chat, 'room-a', 'second', { conversationId: first.conversationId, profileId: 'work' })
  assert.equal(slotOf(f, next), MAIN, 'the room\'s account, not the Agent\'s')
  assert.equal(next.conversationId, first.conversationId)
  await f.complete(chat, next)
  const fresh = await send(chat, 'room-new', 'hello', { profileId: 'work' })
  assert.equal(slotOf(f, fresh), WORK, 'a new room: the Agent\'s saved account')
  f.flag.on = false
  await assert.rejects(send(chat, 'room-a', 'third', { conversationId: first.conversationId, profileId: 'work' }), { code: 'ENGINE_PROFILE_CONFLICT' }, 'flag off: as today')
})

test('(2) an explicit switch continues the SAME room on the other account; the history stays local, the engine thread is new; memory keeps the room\'s scope', async t => {
  const f = await fixture(t), chat = f.runtime()
  const first = await send(chat, 'room-a', 'first', { profileId: 'main' })
  await f.complete(chat, first)
  assert.equal(chat.memoryOwnerKeyFor('room-a', 'account-main'), 'account-main', 'before: the current account')
  assert.deepEqual(chat.switchRoomAccount({ clientThreadId: 'room-a', engineProfileId: WORK }), { status: 'switched', clientThreadId: 'room-a', engineProfileId: WORK, previous: { conversationId: first.conversationId, engineProfileId: MAIN } })
  const row = f.store.getConversation('room-a')
  assert.deepEqual([row.conversationId ?? null, row.engineProfileId], [null, WORK])
  const after = await send(chat, 'room-a', 'after', { profileId: 'main' })
  assert.equal(slotOf(f, after), WORK, 'the next message runs on the new account')
  assert.notEqual(after.conversationId, first.conversationId, 'a new engine thread; the old one stays with the old account')
  assert.equal(f.store.getConversation('room-a').conversationId, after.conversationId)
  assert.deepEqual(chat.requestEngineRoute({ clientThreadId: 'room-a', conversationId: after.conversationId }, { verifyAccount: false }), { engineId: 'codex', engineProfileId: WORK })
  const runs = f.store.listRuns('room-a', { afterSeq: 0, limit: 10 }).runs
  assert.deepEqual(runs.map(r => r.runId), [first.runId, after.runId], 'both runs, from both accounts, are in the room\'s own history')
  assert.equal(chat.memoryOwnerKeyFor('room-a', 'account-work'), 'account-main', 'EG-Desk memory keeps the room\'s scope across the switch')
  assert.equal(f.calls.filter(([op]) => op === 'thread/resume').length, 0, 'the old thread was never resumed on the new account')
  assert.deepEqual(chat.switchRoomAccount({ clientThreadId: 'room-a', engineProfileId: WORK }).status, 'unchanged')
})

test('(2) in flight: the switch is refused while the room is working (the running Run never moves); after it ends the switch goes through', async t => {
  const f = await fixture(t), chat = f.runtime()
  const first = await send(chat, 'room-a', 'first', { profileId: 'main' })
  assert.throws(() => chat.switchRoomAccount({ clientThreadId: 'room-a', engineProfileId: WORK }), { code: 'RUN_IN_PROGRESS' })
  assert.deepEqual([f.store.getConversation('room-a').conversationId, f.store.getConversation('room-a').engineProfileId], [first.conversationId, MAIN], 'nothing changed')
  await f.complete(chat, first)
  assert.equal(chat.switchRoomAccount({ clientThreadId: 'room-a', engineProfileId: WORK }).status, 'switched')
  assert.throws(() => chat.switchRoomAccount({ clientThreadId: 'room-a', engineProfileId: 'codex-missing0' }), { code: 'ENGINE_PROFILE_UNAVAILABLE' })
  assert.throws(() => chat.switchRoomAccount({ clientThreadId: 'nobody', engineProfileId: WORK }), { code: 'CONVERSATION_NOT_FOUND' })
  f.flag.on = false
  assert.throws(() => chat.switchRoomAccount({ clientThreadId: 'room-a', engineProfileId: MAIN }), { code: 'ROOM_ACCOUNT_OFF' })
})

test('(2) restart: after the switch the store and runtime restart; the room is still on the new account, its next message starts there, memory keeps its scope', async t => {
  const f = await fixture(t), chat = f.runtime()
  const first = await send(chat, 'room-a', 'first', { profileId: 'main' })
  await f.complete(chat, first)
  chat.switchRoomAccount({ clientThreadId: 'room-a', engineProfileId: WORK })
  const restarted = f.restart()
  assert.equal(f.store.getConversation('room-a').engineProfileId, WORK)
  assert.equal(f.store.roomMemoryOwnerKey('room-a'), 'account-main')
  const after = await send(restarted, 'room-a', 'after restart', { profileId: 'main' })
  assert.equal(slotOf(f, after), WORK)
  assert.equal(restarted.memoryOwnerKeyFor('room-a', 'account-work'), 'account-main')
  // a second switch keeps the FIRST account as the memory scope
  await f.complete(restarted, after)
  restarted.switchRoomAccount({ clientThreadId: 'room-a', engineProfileId: MAIN })
  assert.equal(f.store.roomMemoryOwnerKey('room-a'), 'account-main')
  // the store itself keeps the FIRST account even if a later caller names another
  f.store.switchRoomAccount({ clientThreadId: 'room-a', engineProfileId: WORK, memoryOwnerKey: 'account-other' })
  assert.equal(f.store.roomMemoryOwnerKey('room-a'), 'account-main')
})

test('(2) the unanswered approval question follows the room to its new engine thread: the person\'s yes is read there and approves that command once', async t => {
  const broker = createGateHookBroker({ mode: () => 'on', home: '/synthetic/home' })
  broker.turnStarted({ conversationId: 'old-cid', turnId: 't1' })
  const asked = await broker.check({ sessionId: 'old-cid', turnId: 't1', cwd: '/synthetic/work', command: 'git reset --hard HEAD~5' })
  assert.equal(asked.decision, 'deny')
  broker.turnEnded({ turnId: 't1' })
  assert.equal(broker.awaitingReply('old-cid'), true)
  assert.equal(broker.rekey('old-cid', 'new-cid'), true)
  assert.deepEqual([broker.awaitingReply('old-cid'), broker.awaitingReply('new-cid')], [false, true])
  assert.equal(broker.rekey('new-cid', 'new-cid'), false); assert.equal(broker.rekey('', 'x'), false)
  // the person's "yes" is read on the new thread and approves exactly that command once, in its next turn there
  const yes = { async decide() { return { answers: { reply_runs_command: { type: 'predicate', probability: 0.97 }, reply_declines_command: { type: 'predicate', probability: 0.02 } } } } }
  const egress = { allows: kind => ['run_text', 'terminal_command'].includes(kind) }
  assert.deepEqual(await broker.readReply({ conversationId: 'new-cid', reply: '네 실행하세요', client: yes, egress }), { approved: true, read: true })
  broker.turnStarted({ conversationId: 'new-cid', turnId: 't2' })
  assert.equal((await broker.check({ sessionId: 'new-cid', turnId: 't2', cwd: '/synthetic/work', command: 'git reset --hard HEAD~5' })).decision, 'allow')
  assert.equal((await broker.check({ sessionId: 'new-cid', turnId: 't2', cwd: '/synthetic/work', command: 'git reset --hard HEAD~5' })).decision, 'deny', 'once')
  // the runtime moves it when the switched room's first new thread starts
  const f = await fixture(t), chat = f.runtime(), moves = []
  chat.gateHookBroker = () => ({ rekey: (from, to) => moves.push([from, to]), turnStarted() {}, turnEnded() {}, awaitingReply: () => false })
  const first = await send(chat, 'room-a', 'first', { profileId: 'main' })
  await f.complete(chat, first)
  chat.switchRoomAccount({ clientThreadId: 'room-a', engineProfileId: WORK })
  const after = await send(chat, 'room-a', 'yes, run it', { profileId: 'main' })
  assert.deepEqual(moves, [[first.conversationId, after.conversationId]])
})

test('route: off -> 404; loopback JSON only; on -> the switch, refusals as closed codes', async t => {
  const f = await fixture(t), chat = f.runtime()
  const first = await send(chat, 'room-a', 'first', { profileId: 'main' })
  const handlerFor = enabled => createRoomAccountHttpHandler({ chat, enabled: () => enabled })
  const call = async (handler, body, { origin = 'chrome://browser', method = 'POST' } = {}) => {
    const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), { url: ROOM_ACCOUNT_PATH, method, headers: { host: '127.0.0.1:39218', origin, 'content-type': 'application/json' } })
    const res = Object.assign(new EventEmitter(), { setHeader() {}, writeHead(c) { this.status = c }, end(j) { this.body = JSON.parse(j); this.writableEnded = true } })
    await handler(req, res, new URL(ROOM_ACCOUNT_PATH, 'http://127.0.0.1:39218')); return { status: res.status, body: res.body }
  }
  assert.deepEqual(await call(handlerFor(false), { clientThreadId: 'room-a', engineProfileId: WORK }), { status: 404, body: { status: 'off' } })
  const on = handlerFor(true)
  assert.equal((await call(on, {}, { origin: 'https://evil.example' })).status, 403)
  assert.deepEqual((await call(on, { clientThreadId: 'room-a', engineProfileId: WORK })).body, { status: 'refused', code: 'RUN_IN_PROGRESS' }, 'in flight')
  await f.complete(chat, first)
  assert.deepEqual(await call(on, { clientThreadId: 'room-a', engineProfileId: WORK }), { status: 200, body: { status: 'switched', clientThreadId: 'room-a', engineProfileId: WORK } })
})
