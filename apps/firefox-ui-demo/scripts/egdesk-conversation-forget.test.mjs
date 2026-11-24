// Deleting a conversation in the surface (cycle 16): the surface tells the bridge (POST /chat/conversation/forget { clientThreadId }) and the
// bridge drops the ephemeral state it holds for that conversation: the live session heartbeat, the posted-answer note, held pointers, memory
// and context receipts, pending confirmation notes, browser tasks, briefing bindings, the run requester and work placement's queue and pointer.
// Owner decision (cycle 17): deleting a conversation deletes it. Its stored history goes (and stays gone after a restart), a run still working
// in it is interrupted and says nothing more, and a reading heard there that is still pending is withdrawn. Kept: ontology pages, promoted
// records, conversation-scoped memory pages, consented speech and topic records, calibration rows (canon: chat history is not Memory).
// World: the all-on journey (plan v4, scripted answers) in two conversations; the surface's deleteThread runs in a vm. No network.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import * as ChatState from '../overlay/resources/EGDeskChatState.sys.mjs'
import { openBriefingBindings } from '../helper/egdesk-briefing-bindings.mjs'
import { openChatStore } from '../helper/egdesk-chat-store.mjs'
import { allOnWorld, DM } from './egdesk-all-on.support.mjs'
import { BROWSER_ROOM, STEPS, createMeasureTransport, loadJourneyPlan, DEFAULT_CAPS, PLAN_FILE_V4 } from './egdesk-all-on-live-measure.mjs'

const surface = fs.readFileSync(new URL('../overlay/JS/eg-desk-surface.uc.js', import.meta.url), 'utf8')
function section(from, to) { const a = surface.indexOf(from), b = surface.indexOf(to, a + from.length); assert.ok(a >= 0 && b > a, 'Surface section: ' + from); return surface.slice(a, b) }

// The surface's deleteThread with its helpers; requests go to post(path, body).
function surfaceRooms(post, rooms, { confirm = true } = {}) {
  const state = { codex: { threads: rooms.map(id => ({ id, type: 'dm', title: id, messages: [], conversationId: null })), activeThreadId: rooms[0], threadDrafts: {}, messageThreadMap: {}, threadMenu: null, memberMenu: null, conversationId: null, draft: '' } }
  const sandbox = { state, ChatState, window: { confirm: () => confirm }, update() {}, emit() {}, fetchJson: async (p, options = {}) => post(p, options.body ? JSON.parse(options.body) : undefined) }
  return { state, bridge: vm.runInNewContext([section('  function getCodexThreadById(', '  function withCodexThread('), '({', section('      deleteThread(threadId) {', '      openFreshRoomAfterAccountHold(threadId) {'), '})'].join('\n'), sandbox, { filename: 'eg-desk-surface.uc.js (delete)' }) }
}
const settle = () => new Promise(resolve => setTimeout(resolve, 5))

async function journey(t, { until = null } = {}) {
  const plan = loadJourneyPlan(PLAN_FILE_V4), { transport } = createMeasureTransport({ caps: DEFAULT_CAPS, plan })
  const w = allOnWorld(t, { transport, env: plan.world.env, budgets: plan.world.budgets })
  await w.settings.turnMemory.save('on')
  const j = { note: {}, sends: [], said: [], async say(text, extra) { try { await w.send(text, extra) } catch {} await w.idle() }, async pause() { await new Promise(r => setTimeout(r, 60)); await w.idle() } }
  for (const def of STEPS.filter(d => plan.steps.some(s => s.id === d.id))) { w.step(def.id); j.said = []; await def.run(w, j); await w.idle(); if (def.id === until) break }
  w.use(DM)
  w.j = j
  return w
}
const writesJson = w => JSON.parse(writesOf(w) ?? '{"data":{"pages":[],"readings":[]}}')
const writesData = w => { const raw = writesJson(w); return raw.data ?? raw }
const writesOf = w => { const file = path.join(w.dir, 'settings', 'egdesk-wiki-writes.json'); return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null }

test('surface: deleting a room asks the bridge to forget it, once, by the room\'s client id; a cancelled or refused delete asks nothing', async () => {
  const posts = [], post = async (p, body) => { posts.push([p, body]); return { accepted: true } }
  const ui = surfaceRooms(post, ['a', 'b'])
  ui.bridge.deleteThread('b'); await settle()
  assert.deepEqual(posts, [['/chat/conversation/forget', { clientThreadId: 'b' }]])
  surfaceRooms(post, ['a', 'b'], { confirm: false }).bridge.deleteThread('b'); await settle()
  surfaceRooms(post, ['a']).bridge.deleteThread('a'); await settle()
  assert.equal(posts.length, 1, 'not on a cancelled delete, not on the refused delete of the last room')
  const failing = surfaceRooms(async () => { throw Object.assign(new Error('down'), { status: 0 }) }, ['a', 'b'])
  failing.bridge.deleteThread('b'); await settle()
  assert.deepEqual(Array.from(failing.state.codex.threads, x => x.id), ['a'], 'the room is gone on the screen even when the bridge cannot be told')
  assert.equal(surface.split("'/chat/conversation/forget'").length - 1, 1)
})

test('bridge: a deleted conversation loses its session, receipts, notes, bindings, requester and placement state; the other conversation keeps all of it', async t => {
  const w = await journey(t)
  const cidOf = room => w.state.lastOf.get(room).conversationId, dm = cidOf(DM), browser = cidOf(BROWSER_ROOM)
  w.runRequesters.set([DM], 'm-jin'); w.runRequesters.set([BROWSER_ROOM], 'm-jin')
  const c = w.chat
  // Before: the DM conversation has what the journey gave it.
  assert.ok(c.heartbeatFor(DM) && c.heartbeatFor(DM).state !== 'stopped', 'a live session')
  assert.ok(c.turnMemoryDelivered.has(dm) && c.contextDelivered.has(dm) && c.turnMemoryLatest.has(dm), 'memory and context receipts')
  assert.ok([...w.briefingBindings.values()].some(b => b.conversationId === dm), 'briefing bindings')
  assert.notEqual(w.workPlacement.result(DM, 'wp-1').status, 'unknown', 'a placement of this conversation')
  c.postedInstead.set(DM, { outcome: 'revised', posted: 'x' }) // as a replaced answer leaves it (the scripted answers pass the check)
  c.heldAttention.push({ id: `held:${DM}:sig`, member: 'self', kind: 'result', sourceKey: DM, at: c.monotonicNow() }) // as holdAttention leaves it
  const keep = { history: w.store.listMessages(DM).messages.length, writesData: writesData(w), calibration: w.calibrationLog.entries().length,
    browserHb: c.heartbeatFor(BROWSER_ROOM)?.state ?? null, browserReceipts: c.turnMemoryDelivered.has(browser) || c.contextDelivered.has(browser), browserBindings: [...w.briefingBindings.values()].filter(b => b.conversationId === browser).length }
  // The person deletes the DM room in the surface; the request reaches the bridge's real route.
  const replies = []
  const ui = surfaceRooms(async (p, body) => { const out = await w.http('POST', p, body); replies.push(out); return out.body }, [DM, BROWSER_ROOM])
  ui.bridge.deleteThread(DM); await settle(); await w.idle()
  assert.equal(replies.length, 1); assert.equal(replies[0].status, 200)
  const r = replies[0].body
  assert.equal(r.accepted, true); assert.equal(r.heartbeat, true); assert.equal(r.postedNote, true); assert.equal(r.heldPointers, 1)
  assert.ok(r.memoryReceipts >= 3, JSON.stringify(r)); assert.ok(r.modules.briefing_bindings >= 1 && r.modules.run_requesters === 1 && r.modules.work_placement >= 1, JSON.stringify(r.modules))
  // After: nothing of the DM's ephemeral state is left.
  assert.ok(!c.heartbeatFor(DM) || c.heartbeatFor(DM).state === 'stopped')
  assert.ok(![c.turnMemoryDelivered, c.contextDelivered, c.turnMemoryLatest, c.turnMemoryShadow, c.turnMemoryNoted].some(map => map.has(dm) || map.has(DM)))
  assert.ok(!c.postedInstead.has(DM)); assert.ok(!c.heldAttention.some(row => row.sourceKey === DM))
  assert.ok(![...w.briefingBindings.values()].some(b => b.conversationId === dm))
  assert.ok(![...openBriefingBindings({ dataDir: path.join(w.dir, 'briefing'), log() {} }).values()].some(b => b.conversationId === dm), 'and on disk')
  assert.equal(w.workPlacement.result(DM, 'wp-1').status, 'unknown')
  assert.equal(w.runRequesters.audience({ run: { clientThreadId: DM, conversationId: dm } })?.requester ?? null, w.runRequesters.audience({ run: { clientThreadId: 'never', conversationId: 'never' } })?.requester ?? null, 'no requester left for it')
  // Deleted: the stored history of the DM (owner decision, c17). Kept: the written pages and every reading that is not the DM's pending one,
  // the calibration rows; and the other conversation's state.
  assert.equal(w.store.getConversation(DM), null); assert.ok(r.history.deleted === true && r.history.rows >= keep.history, JSON.stringify(r.history))
  assert.ok(!w.store.listConversations().threads.some(x => x.clientThreadId === DM)); assert.ok(w.store.listConversations().threads.some(x => x.clientThreadId === BROWSER_ROOM))
  const was = keep.writesData, now = writesData(w)
  assert.deepEqual(now.pages, was.pages, 'written pages stay')
  assert.deepEqual(now.readings, was.readings.filter(e => !(e.reading.state === 'pending' && e.from === DM)), 'only the DM\'s pending readings went')
  assert.equal(r.modules.pending_readings, was.readings.length - now.readings.length)
  assert.equal(w.calibrationLog.entries().length, keep.calibration)
  assert.equal(c.heartbeatFor(BROWSER_ROOM)?.state ?? null, keep.browserHb)
  assert.equal(c.turnMemoryDelivered.has(browser) || c.contextDelivered.has(browser), keep.browserReceipts)
  assert.equal([...w.briefingBindings.values()].filter(b => b.conversationId === browser).length, keep.browserBindings)
  // Nothing more is posted into the deleted conversation (nothing stored, no event), and the store stays healthy.
  const events = w.events.length
  await w.advance(120000); await w.idle()
  assert.equal(w.store.getConversation(DM), null); assert.equal(w.events.slice(events).filter(e => e.clientThreadId === DM).length, 0); assert.equal(c.storeHealthy, true)
  // Idempotent.
  const again = await w.http('POST', '/chat/conversation/forget', { clientThreadId: DM })
  assert.deepEqual([again.status, again.body.heartbeat, again.body.memoryReceipts, again.body.heldPointers, again.body.modules.work_placement], [200, false, 0, 0, 0])
})

test('bridge: a running browser task of a deleted conversation goes; the route refuses a request without a conversation', async t => {
  const w = await journey(t)
  const store = w.chat.browserTaskStore
  assert.ok(store, 'the journey ran a browser task')
  const task = store.create({ conversationKey: BROWSER_ROOM, cardId: 'card', goal: '다시 내려받기' })
  assert.equal(store.brief(BROWSER_ROOM)?.goal ?? store.paused(BROWSER_ROOM)?.goal ?? task.goal, task.goal)
  const out = await w.http('POST', '/chat/conversation/forget', { clientThreadId: BROWSER_ROOM })
  assert.equal(out.status, 200); assert.ok(out.body.browserTasks >= 1)
  assert.equal(store.brief(BROWSER_ROOM), null); assert.equal(store.paused(BROWSER_ROOM), null)
  const bad = await w.http('POST', '/chat/conversation/forget', {})
  assert.equal(bad.status, 400); assert.equal(bad.body.code ?? bad.body.error?.code, 'INVALID_CONVERSATION_FORGET')
})

test('c17 the journey leaves a pending reading heard in the DM, and it remembers that conversation (beside the reading, not on the page)', async t => {
  const w = await journey(t)
  const pending = writesData(w).readings.filter(e => e.reading.state === 'pending')
  assert.ok(pending.length >= 1 && pending.every(e => e.from === DM), JSON.stringify(pending))
  assert.ok(pending.every(e => !('from' in e.reading)))
})

test('c17 delete while the DM\'s run works: the turn is interrupted, nothing more is stored or shown for it, the store stays healthy, the other room works', async t => {
  const w = await journey(t, { until: 's4-long-command' })
  const run = w.runs().at(-1), timing = w.timing()
  assert.equal(run.status, 'inProgress', 'rig: the long command is running')
  const out = await w.http('POST', '/chat/conversation/forget', { clientThreadId: DM })
  assert.equal(out.status, 200); assert.equal(out.body.interrupted, 1); assert.equal(out.body.history.deleted, true)
  await w.settle()
  assert.deepEqual(w.native.filter(c => c.method === 'turn/interrupt').map(c => [c.params.threadId, c.params.turnId]), [[timing.threadId, timing.turnId]])
  // The engine goes on as engines do: output, an answer, the end of the turn; the heartbeat's time passes.
  const events = w.events.length
  await w.notify('item/completed', { ...timing, item: { id: 'cmd-1', type: 'commandExecution', command: 'npm test', cwd: '/work', status: 'completed', exitCode: 0, commandActions: [], aggregatedOutput: 'x\n' } })
  await w.answer('테스트 결과입니다.', { end: false }); await w.endTurn('interrupted'); await w.advance(60000); await w.idle()
  assert.equal(w.events.slice(events).filter(e => e.clientThreadId === DM).length, 0, 'no event for the deleted conversation')
  assert.equal(w.store.getConversation(DM), null); assert.equal(w.chat.storeHealthy, true)
  // Another conversation is not affected.
  w.use(BROWSER_ROOM)
  const sent = await w.send('하나만 더 확인해줘'); assert.equal(sent.accepted, true)
  assert.ok(w.store.listMessages(BROWSER_ROOM).messages.some(m => m.text === '하나만 더 확인해줘'))
})

test('c17 a deleted conversation does not come back after a restart (the chat store reopened from its files)', async t => {
  const w = await journey(t)
  const dir = path.join(w.dir, 'chat') // as the harness opens it (egdesk-all-on.support.mjs)
  const before = w.store.listConversations().threads.map(x => x.clientThreadId)
  assert.ok(before.includes(DM) && before.includes(BROWSER_ROOM))
  const said = '지난주 A사 견적 건 어디까지 됐지?', inFiles = () => fs.readdirSync(dir).some(name => fs.readFileSync(path.join(dir, name)).includes(Buffer.from(said)))
  assert.equal(inFiles(), true, 'rig: the DM\'s first message is in the database files before the delete')
  const out = await w.http('POST', '/chat/conversation/forget', { clientThreadId: DM }); assert.equal(out.body.history.deleted, true)
  const files = fs.readdirSync(dir).filter(name => /\.(sqlite|db)(-wal)?$/.test(name))
  assert.ok(files.length >= 1, 'rig: the chat database files: ' + fs.readdirSync(dir).join(','))
  const scope = 'synthetic-all-on'
  w.store.close()
  const reopened = openChatStore({ dataDir: dir, ownerScope: scope })
  t.after(() => reopened.close())
  assert.equal(reopened.getConversation(DM), null)
  assert.deepEqual(reopened.listConversations().threads.map(x => x.clientThreadId), before.filter(id => id !== DM))
  assert.throws(() => reopened.listMessages(DM), /does not exist/)
  // The person's words are not left in the database files either (secure delete; the WAL was truncated).
  assert.equal(inFiles(), false, 'the words are not left in the database files')
})
