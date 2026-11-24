// Deleting a conversation in the surface (cycle 16): the surface tells the bridge (POST /chat/conversation/forget { clientThreadId }) and the
// bridge drops the ephemeral state it holds for that conversation: the live session heartbeat, the posted-answer note, held pointers, memory
// and context receipts, pending confirmation notes, browser tasks, briefing bindings, the run requester and work placement's queue and pointer.
// Kept: the chat store's history, ontology pages, the write store, calibration rows (owner decisions / canon, see the cycle-16 report).
// World: the all-on journey (plan v4, scripted answers) in two conversations; the surface's deleteThread runs in a vm. No network.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import * as ChatState from '../overlay/resources/EGDeskChatState.sys.mjs'
import { openBriefingBindings } from '../helper/egdesk-briefing-bindings.mjs'
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

async function journey(t) {
  const plan = loadJourneyPlan(PLAN_FILE_V4), { transport } = createMeasureTransport({ caps: DEFAULT_CAPS, plan })
  const w = allOnWorld(t, { transport, env: plan.world.env, budgets: plan.world.budgets })
  await w.settings.turnMemory.save('on')
  const j = { note: {}, sends: [], said: [], async say(text, extra) { try { await w.send(text, extra) } catch {} await w.idle() }, async pause() { await new Promise(r => setTimeout(r, 60)); await w.idle() } }
  for (const def of STEPS.filter(d => plan.steps.some(s => s.id === d.id))) { w.step(def.id); j.said = []; await def.run(w, j); await w.idle() }
  w.use(DM)
  return w
}
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
  const keep = { history: w.store.listMessages(DM).messages.length, writes: writesOf(w), calibration: w.calibrationLog.entries().length,
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
  // Kept: the history, the records, the calibration rows; and the other conversation's state.
  assert.equal(w.store.listMessages(DM).messages.length, keep.history); assert.equal(writesOf(w), keep.writes); assert.equal(w.calibrationLog.entries().length, keep.calibration)
  assert.equal(c.heartbeatFor(BROWSER_ROOM)?.state ?? null, keep.browserHb)
  assert.equal(c.turnMemoryDelivered.has(browser) || c.contextDelivered.has(browser), keep.browserReceipts)
  assert.equal([...w.briefingBindings.values()].filter(b => b.conversationId === browser).length, keep.browserBindings)
  // Nothing more is posted into the deleted conversation.
  const before = w.store.listMessages(DM).messages.length
  await w.advance(120000); await w.idle()
  assert.equal(w.store.listMessages(DM).messages.length, before)
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
