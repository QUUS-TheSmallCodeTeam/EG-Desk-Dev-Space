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
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { verifyThreadDeleteSchema } from '../helper/codex-native-schema-probe.mjs'
import { inspectNativeCapabilities } from '../helper/egdesk-native-capabilities.mjs'
import { createCodexEngineAdapter } from '../helper/codex-engine-adapter.mjs'
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

async function journey(t, { until = null, before = null, world = {} } = {}) {
  const plan = loadJourneyPlan(PLAN_FILE_V4), { transport } = createMeasureTransport({ caps: DEFAULT_CAPS, plan })
  const w = allOnWorld(t, { transport, env: plan.world.env, budgets: plan.world.budgets, ...world })
  if (before) await before(w)
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

// ---- cycle 18: Main's deletion decisions (backups, conversation-temporary memory, engine history) ----------------------------------
const SAID = '지난주 A사 견적 건 어디까지 됐지?' // the DM's first message (s1)
const messageRef = (room, requestId) => `chat-message:msg-${createHash('sha256').update(`${room}\0${requestId}\0msg`).digest('hex').slice(0, 32)}`
const chatDir = w => path.join(w.dir, 'chat')
const dbFile = w => path.join(chatDir(w), fs.readdirSync(chatDir(w)).find(name => name.endsWith('.sqlite')))
const rowsOf = (db, room) => { const row = db.prepare('SELECT local_conversation_id AS id FROM threads WHERE client_thread_id=?').get(room); if (!row) return 0
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name).filter(n => n !== 'threads' && db.prepare(`PRAGMA table_info(${n})`).all().some(c => c.name === 'local_conversation_id'))
  return 1 + tables.reduce((n, table) => n + db.prepare(`SELECT count(*) AS n FROM ${table} WHERE local_conversation_id=?`).get(row.id).n, 0) }

test('c18 upgrade backups: the deleted conversation\'s rows go from every backup copy; the backups stay, other conversations in them stay', async t => {
  const w = await journey(t, { until: 's2-follow-up' })
  w.use(BROWSER_ROOM); await w.send('다른 방의 메시지'); w.use(DM)
  const file = dbFile(w)
  w.store.close()
  // Two older stores this one was upgraded from (the store's own backupVersion names): v3, and a v4 written by a later upgrade.
  for (const [version, drop] of [[3, 'DROP TABLE topic_answer_guards; DROP TABLE run_project_origins;'], [4, 'DROP TABLE topic_answer_guards;']]) {
    const copy = path.join(chatDir(w), 'copy.sqlite'); fs.rmSync(copy, { force: true })
    const live = new DatabaseSync(file); live.prepare('VACUUM INTO ?').run(copy); live.close()
    const old = new DatabaseSync(copy); old.exec(`${drop} PRAGMA user_version=${version};`); old.close()
    fs.renameSync(copy, `${file}.v${version}.bak`); fs.chmodSync(`${file}.v${version}.bak`, 0o600)
  }
  const store = openChatStore({ dataDir: chatDir(w), ownerScope: 'synthetic-all-on' }); t.after(() => { try { store.close() } catch {} })
  const backups = [3, 4].map(v => `${file}.v${v}.bak`)
  const before = backups.map(b => { const db = new DatabaseSync(b); const out = [rowsOf(db, DM), rowsOf(db, BROWSER_ROOM), db.prepare('PRAGMA user_version').get().user_version]; db.close(); return out })
  assert.ok(before.every(([dm, other]) => dm > 1 && other > 1), 'rig: both backups hold both conversations ' + JSON.stringify(before))
  assert.ok(backups.every(b => fs.readFileSync(b).includes(Buffer.from(SAID))), 'rig: the DM\'s words are in the backups')
  const out = store.deleteConversation(DM)
  assert.equal(out.deleted, true)
  assert.deepEqual(out.backups.map(b => [b.version, b.scrubbed, b.rows]), [[3, true, before[0][0]], [4, true, before[1][0]]])
  for (const [i, b] of backups.entries()) {
    assert.ok(fs.existsSync(b), 'the backup itself stays')
    const db = new DatabaseSync(b)
    assert.deepEqual([rowsOf(db, DM), rowsOf(db, BROWSER_ROOM), db.prepare('PRAGMA user_version').get().user_version, db.prepare('PRAGMA quick_check').get().quick_check], [0, before[i][1], before[i][2], 'ok'])
    db.close()
    assert.equal(fs.readFileSync(b).includes(Buffer.from(SAID)), false, 'and the words are not left in it')
  }
  // A repeated delete (the conversation is already gone) still scrubs a backup that kept it.
  const kept = path.join(chatDir(w), 'kept.sqlite'), again = `${file}.v2.bak`
  fs.copyFileSync(`${file}.v4.bak`, kept)
  const k = new DatabaseSync(kept); k.exec("INSERT INTO threads (local_conversation_id, client_thread_id, created_at, updated_at, coverage_json) VALUES ('lc-x', '" + DM + "', 1, 1, '{}')"); k.close()
  fs.renameSync(kept, again); fs.chmodSync(again, 0o600)
  assert.deepEqual(store.deleteConversation(DM).backups.find(b => b.version === 2), { version: 2, scrubbed: true, rows: 1 })
})

test('c18 memory: the conversation-temporary scope goes with it; Board and other scopes stay; a page whose only source was a deleted message keeps a text-less pointer', async t => {
  const DM_SCOPE = `dm:${DM}`, ref = messageRef(DM, 'req-1')
  const seed = { version: 1, pages: [
    { id: 'memory-dm-1', title: 'DM 메모', body: 'DM에서만 쓰는 메모', revision: '1', time: { slice: 'present' }, provenance: { kind: 'utterance', by: 'user' }, status: 'unknown', scope: DM_SCOPE, links: [] },
    { id: 'memory-dm-ref', title: 'referenced utterance', ref, revision: '1', time: { slice: 'present' }, provenance: { kind: 'utterance', by: 'user' }, status: 'unknown', scope: DM_SCOPE, links: [] },
    { id: 'memory-other-dm', title: '다른 방', body: '다른 방의 메모', revision: '1', time: { slice: 'present' }, provenance: { kind: 'utterance', by: 'user' }, status: 'unknown', scope: `dm:${BROWSER_ROOM}`, links: [] },
    { id: 'memory-board', title: '보드', body: '보드 범위 메모', revision: '1', time: { slice: 'present' }, provenance: { kind: 'utterance', by: 'user' }, status: 'unknown', scope: 'board:b1', links: [] },
    { id: 'memory-board-ref', title: 'referenced utterance', ref, revision: '1', time: { slice: 'present' }, provenance: { kind: 'utterance', by: 'user' }, status: 'unknown', scope: 'board:b1', links: [] },
  ], readings: [{ pageId: 'memory-dm-1', sourceRevision: '1', reading: { status: 'done', state: 'accepted', basis: null } }] }
  const file = w => path.join(w.dir, 'settings', 'egdesk-wiki-writes.json')
  const w = await journey(t, { until: 's2-follow-up', before: w => { fs.writeFileSync(file(w), JSON.stringify(seed), { mode: 0o600 }) } })
  const stored = () => JSON.parse(fs.readFileSync(file(w), 'utf8'))
  assert.deepEqual(w.turnMemoryConfig.getAdapter() && (await import('../helper/egdesk-wiki-adapter.mjs')).openWikiWrites({ dataDir: path.join(w.dir, 'settings'), log() {} }).read().pages.map(p => p.id), seed.pages.map(p => p.id), 'rig: every seeded page is a valid stored page')
  assert.ok(w.store.localMessageIds(DM).includes(ref.slice('chat-message:'.length)), 'rig: the referenced message is the DM\'s first message')
  const out = await w.http('POST', '/chat/conversation/forget', { clientThreadId: DM })
  assert.equal(out.status, 200)
  const after = stored()
  assert.deepEqual(after.pages.map(p => p.id).sort(), ['memory-board', 'memory-board-ref', 'memory-other-dm'])
  assert.deepEqual(after.pages.find(p => p.id === 'memory-board-ref'), { ...seed.pages[4], sourceDeleted: true }, 'a text-less pointer, marked')
  assert.ok(!('body' in after.pages.find(p => p.id === 'memory-board-ref')))
  assert.deepEqual(after.pages.find(p => p.id === 'memory-board'), seed.pages[3]); assert.deepEqual(after.pages.find(p => p.id === 'memory-other-dm'), seed.pages[2])
  assert.ok(!after.readings.some(e => e.pageId === 'memory-dm-1'), 'readings on a deleted page go with it')
  assert.equal(out.body.modules.conversation_memory, 2 + 1 + 1)
  // A new conversation under the same id does not get the deleted memory back, and the marked pointer resolves nowhere.
  const wiki = await w.turnMemoryConfig.getAdapter().snapshot({ context: { clientThreadId: DM }, body: { boardId: 'b1' } })
  assert.ok(!wiki.pages.has('memory-dm-1') && !wiki.pages.has('memory-dm-ref') && !wiki.pages.has('memory-board-ref'))
})

test('c18 engine history: thread/delete for the native thread when the engine\'s schema has it; otherwise the result says the history remains', async t => {
  const yes = await journey(t, { until: 's2-follow-up', world: { threadDelete: true } })
  const cid = yes.state.lastOf.get(DM).conversationId
  const out = await yes.http('POST', '/chat/conversation/forget', { clientThreadId: DM }); await yes.settle()
  assert.deepEqual(out.body.engineHistory, [{ conversationId: cid, engineId: 'codex', state: 'deleted' }])
  assert.deepEqual(yes.native.filter(c => c.method === 'thread/delete').map(c => c.params), [{ threadId: cid }])
  assert.deepEqual(yes.state.deletedThreads, [cid]); assert.equal(yes.chat.storeHealthy, true, 'the thread/deleted notification is harmless')
  const no = await journey(t, { until: 's2-follow-up' })
  const nout = await no.http('POST', '/chat/conversation/forget', { clientThreadId: DM })
  assert.deepEqual(nout.body.engineHistory, [{ conversationId: no.state.lastOf.get(DM).conversationId, engineId: 'codex', state: 'remains', reason: 'unsupported' }])
  assert.equal(no.native.filter(c => c.method === 'thread/delete').length, 0)
  const fails = await journey(t, { until: 's2-follow-up', world: { threadDelete: true } }); fails.state.failThreadDelete = true
  const fout = await fails.http('POST', '/chat/conversation/forget', { clientThreadId: DM })
  assert.deepEqual(fout.body.engineHistory.map(e => [e.state, e.reason]), [['remains', 'failed']])
  assert.equal(fout.body.history.deleted, true, 'EG-Desk\'s own history still goes')
})

test('c18 the thread/delete capability: the 0.171 schema shape passes; anything else does not; any identified version is checked for it alone', () => {
  // Shapes as generated by Codex 0.171 (ClientRequest union entry, v2/ThreadDeleteParams.json, v2/ThreadDeleteResponse.json).
  const request = { oneOf: [{ properties: { id: {}, method: { enum: ['thread/archive'] } } }, { properties: { id: {}, method: { enum: ['thread/delete'], type: 'string' }, params: { $ref: '#/definitions/ThreadDeleteParams' } }, required: ['id', 'method', 'params'] }] }
  const params = { $schema: 'http://json-schema.org/draft-07/schema#', properties: { threadId: { type: 'string' } }, required: ['threadId'], title: 'ThreadDeleteParams', type: 'object' }
  const response = { $schema: 'http://json-schema.org/draft-07/schema#', title: 'ThreadDeleteResponse', type: 'object' }
  assert.equal(verifyThreadDeleteSchema(request, params, response), true)
  assert.equal(verifyThreadDeleteSchema({ oneOf: request.oneOf.slice(0, 1) }, params, response), false, 'not in the request union')
  assert.equal(verifyThreadDeleteSchema(request, { ...params, required: ['threadId', 'force'], properties: { ...params.properties, force: { type: 'boolean' } } }, response), false, 'other params')
  assert.equal(verifyThreadDeleteSchema(request, params, { title: 'Other', type: 'object' }), false)
  const run = version => () => ({ status: 0, stdout: `codex-cli ${version}\n` })
  let probes = 0
  const caps = (version, fp) => inspectNativeCapabilities({ executable: '/selected/native', run: run(version), probe: () => { probes++; return null }, fingerprint: () => 'b'.repeat(64), deleteProbe: () => fp })
  const v171 = caps('0.171.0', 'd'.repeat(64))
  assert.deepEqual([v171.threadDelete, v171.schemaMatch, v171.qaReadOnly, v171.boardPeerContract, probes], [true, false, false, null, 0], 'thread/delete alone; nothing else is granted')
  assert.equal(caps('0.171.0', null).threadDelete, false)
  assert.equal(inspectNativeCapabilities({ executable: '/x', run: () => ({ status: 1, stdout: '' }), deleteProbe: () => 'd'.repeat(64), probe: () => null, fingerprint: () => 'b'.repeat(64) }).threadDelete, false, 'no identified version')
  // The adapter calls it only when told the binary has it.
  const calls = [], adapter = on => createCodexEngineAdapter({ request: async (m, p) => { calls.push([m, p]); return {} }, respond() {}, getThreadDelete: () => on })
  assert.equal(adapter(false).threadDeleteSupported(), false); assert.throws(() => adapter(false).deleteThread('t1'), { code: 'THREAD_DELETE_UNSUPPORTED' })
  assert.equal(adapter(true).threadDeleteSupported(), true); void adapter(true).deleteThread('t1')
  assert.deepEqual(calls, [['thread/delete', { threadId: 't1' }]])
})
