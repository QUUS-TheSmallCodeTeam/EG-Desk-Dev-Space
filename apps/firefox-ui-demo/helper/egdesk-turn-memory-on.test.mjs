import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { chmod, mkdtemp, readFile, stat } from 'node:fs/promises'
import { CodexChatRuntime, TURN_MEMORY_CAPS, TURN_MEMORY_KEY, compactionSignal } from './codex-chat-runtime.mjs'
import { openChatStore } from './egdesk-chat-store.mjs'
import { openCalibrationLog } from './egdesk-decision-calibration-log.mjs'
import { buildWiki } from './egdesk-wiki-reconstruction.mjs'
import { SYNTHETIC_PAGES, mockJudge } from './egdesk-wiki-reconstruction.fixture.mjs'
import { createWikiWriter } from './egdesk-turn-memory.mjs'
import { createWikiAdapter, openWikiWrites } from './egdesk-wiki-adapter.mjs'
import { createTurnMemoryConfig } from './egdesk-turn-memory-wiring.mjs'

// Real: CodexChatRuntime.send / finish, the turn/start parameters, the chat store, the calibration log, the memory loop, the write path.
// Synthetic: the native engine (thread/start, turn/start and its notifications) and the Decisions client (a lexical stand-in, never a model).
const quiet = () => {}
const profiles = { runProfile: (p, r) => ({ binding: { profileId: p, revision: r ?? 1, hash: 'h' }, developerInstructions: 'x', toolCeiling: null, model: null }) }
const SCOPE = { allowedScopes: ['dm:this-room'], writeScope: 'dm:this-room' }
const DONE = 'PostgreSQL 마이그레이션 배포 끝났어', PLAN_Q = 'PostgreSQL 마이그레이션 계획 알려줘'
const normalize = text => text.replace(/"(?:clientId|requestId|localMessageId|localRunId|clientUserMessageId)":"[^"]*"/g, '"id":"x"')
const body = id => SYNTHETIC_PAGES.find(p => p.id === id).body

async function rig({ memoryMode = 'on', decisionMode = 'on', tm = {}, client = null, wiki = buildWiki(SYNTHETIC_PAGES), hooks = {} } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'egdesk-tm-on-')); await chmod(dir, 0o700)
  const store = openChatStore({ dataDir: path.join(dir, 'chat'), ownerScope: 'synthetic' })
  const calibrationLog = openCalibrationLog({ dataDir: path.join(dir, 'settings'), log: quiet })
  const x = { dir, store, calibrationLog, wiki, starts: [], decides: [], timeline: [], events: [], memoryMode, decisionMode, autoFinish: true, terminal: 'completed' }
  const judge = mockJudge()
  let turns = 0, threads = 0
  const chat = new CodexChatRuntime({ now: () => Date.now(), store, requireStore: true, getOwnerKey: () => 'codex:synthetic:qa', profiles, resolveProjectWorkspace: async () => null,
    request: async (method, p) => {
      if (method === 'thread/start') { await hooks.onThreadStart?.(x); return { thread: { id: `t${++threads}` }, cwd: '/work', model: 'syn' } }
      if (method === 'thread/resume') return { thread: { id: p.threadId, turns: [] }, cwd: '/work' }
      if (method === 'config/read') return { config: { developer_instructions: null } }
      if (method === 'thread/unsubscribe') return { status: 'unsubscribed' }
      x.starts.push(p); x.timeline.push('turn/start')
      const id = `turn-${++turns}`, timing = { threadId: p.threadId, turnId: id }
      setTimeout(async () => { const n = (m, q) => chat.handleNotification({ method: m, params: q })
        await n('item/started', { ...timing, item: { id: `a${id}`, type: 'agentMessage', phase: 'final_answer', text: '' } })
        await n('item/completed', { ...timing, item: { id: `a${id}`, type: 'agentMessage', phase: 'final_answer', text: '네' } })
        x.timeline.push(`turn/${x.terminal}`)
        await n('turn/completed', { threadId: p.threadId, turn: { id, status: x.terminal, items: [] } }) }, 5)
      return { turn: { id, status: 'inProgress', items: [] } } },
    respond: () => {}, emit: e => x.events.push(e), emitLegacy: () => {}, verifyFile: async () => null,
    decisionContext: { calibrationLog, mode: () => x.decisionMode, settingsGeneration: () => 0, configured: () => true, budgetMs: 800,
      client: { model: 'syn', async decide(req) {
        const names = req.questions.map(q => q.name)
        x.decides.push({ names, input: req.input.map(m => (typeof m.content === 'string' ? m.content : '')).join('\n') })
        x.timeline.push(names.some(n => n.startsWith('tw_')) ? 'decide:write' : names.some(n => n.startsWith('tn_')) ? 'decide:triage' : 'decide:fetch')
        return (client ?? judge).decide(req)
      } }, collect: async () => [],
      turnMemory: memoryMode === null ? undefined : { mode: () => x.memoryMode, wiki: async () => x.wiki, scope: () => SCOPE, writer: (w, o) => createWikiWriter(w, o), ontologyWrite: true, budget: { linksFirst: true }, ...tm } } })
  chat.setConnection(true)
  x.chat = chat
  const completed = () => store.listMessages('dm-1').messages.filter(m => m.role === 'assistant' && m.status === 'complete').length
  x.done = async n => { for (let i = 0; i < 300 && completed() < n; i++) await new Promise(r => setTimeout(r, 20)); await new Promise(r => setTimeout(r, 30)); await chat.turnMemoryIdle() }
  x.send = async (message, requestId) => { const r = await chat.send({ message, clientThreadId: 'dm-1', requestId, ...(x.cid ? { conversationId: x.cid } : {}), profileId: 'sol', replyDestination: 'direct' }); x.cid ||= r.conversationId; return r }
  x.packet = i => x.starts[i]?.additionalContext?.[TURN_MEMORY_KEY]?.value ?? null
  x.memoryEntries = () => calibrationLog.entries().filter(e => e.feature === 'turn_memory')
  x.run = () => [...chat.runs.values()].at(-1)
  return x
}

test('first turn, on: the reconstructed packet rides in the turn input under one key; everything else in turn/start is what it was', async () => {
  const off = await rig({ memoryMode: null })
  await off.send(DONE, 'r1'); await off.done(1)
  const x = await rig()
  await x.send(DONE, 'r1'); await x.done(1)
  const packet = x.packet(0)
  assert.equal(typeof packet, 'string')
  assert.match(packet, /EG-Desk reconstructed memory for this turn/)
  assert.match(packet, /\[page id=db\/pg-plan time=planned [^\]]*status-recorded=plan/); assert.ok(packet.includes(body('db/pg-plan')))
  assert.ok(!packet.includes('원가는 단가의 71%'), 'a page outside this DM never reaches the answering model')
  assert.deepEqual(x.starts[0].additionalContext[TURN_MEMORY_KEY].kind, 'application')
  const without = structuredClone(x.starts[0]); delete without.additionalContext[TURN_MEMORY_KEY]
  if (!Object.keys(without.additionalContext).length) delete without.additionalContext
  assert.equal(normalize(JSON.stringify(without)), normalize(JSON.stringify(off.starts[0])), 'the one key is the only difference from a bridge without the feature')
  assert.ok(x.timeline.indexOf('decide:fetch') < x.timeline.indexOf('turn/start'), 'the loop ran before the turn started')
  const [entry] = x.memoryEntries()
  assert.deepEqual([entry.mode, entry.position, entry.attached, entry.memory], ['on', 'first', true, 'ran'])
  for (const r of [off, x]) r.store.close()
})

test('default, off, advisory, and "on" under an advisory decision mode: turn/start is byte-identical to a bridge without the feature', async () => {
  const baseline = await rig({ memoryMode: null })
  await baseline.send(DONE, 'r1'); await baseline.done(1)
  const variants = [{ memoryMode: 'off' }, { memoryMode: 'advisory' }, { memoryMode: 'on', decisionMode: 'advisory' }, { memoryMode: 'advisory', decisionMode: 'advisory' }, { memoryMode: 'on', decisionMode: 'off' }]
  for (const v of variants) {
    const x = await rig(v)
    await x.send(DONE, 'r1'); await x.done(1)
    assert.equal(normalize(JSON.stringify(x.starts[0])), normalize(JSON.stringify(baseline.starts[0])), JSON.stringify(v))
    assert.equal(x.packet(0), null)
    assert.ok(x.timeline.filter(t => t.startsWith('decide')).every((_, i, all) => x.timeline.indexOf(all[i]) > x.timeline.indexOf('turn/start')), `${JSON.stringify(v)}: any memory request is made only after the turn started`)
    assert.equal(x.events.some(e => /기억 자료/.test(JSON.stringify(e))), false)
    if (v.memoryMode === 'off' || v.decisionMode === 'off') assert.equal(x.decides.length, 0)
    else assert.deepEqual(x.memoryEntries().map(e => [e.mode, e.attached]), [['advisory', false]])
    x.store.close()
  }
  baseline.store.close()
})

test('the person can see what was attached: one activity row with the pages by title and time, no page content, no labels', async () => {
  const x = await rig()
  await x.send(DONE, 'r1'); await x.done(1)
  const rows = x.events.filter(e => e.event === 'activity.completed' && e.details?.detail?.feature === 'turnMemory')
  assert.equal(rows.length, 1)
  const row = rows[0].details
  assert.match(row.title, /^기억 자료 \d+개$/)
  assert.ok(row.detail.items.some(i => i.id === 'db/pg-plan' && i.title === 'PostgreSQL 마이그레이션 배포 계획' && i.time === '계획'))
  assert.deepEqual([row.kind, row.detail.attached, row.detail.position], ['decisionContext', true, 'first'])
  assert.ok(!JSON.stringify(row).includes(body('db/pg-plan')) && !/status-read|speech|발언/.test(JSON.stringify(row)))
  x.store.close()
})

test('mid-session, on: no reconstruction; real receipts keep pages the live context holds out of the packet; small talk attaches nothing', async () => {
  const x = await rig()
  await x.send(PLAN_Q, 'r1'); await x.done(1)
  const first = x.packet(0)
  const delivered = x.chat.turnMemoryDelivered.get(x.cid)
  assert.ok(delivered?.usable && delivered.threadKey === x.cid && Object.keys(delivered.pages).includes('db/pg-plan'), 'receipts of what was really attached, keyed by the native thread')
  assert.ok(!JSON.stringify(delivered).includes('12월 첫째 주'), 'receipts hold revisions and hashes, never text')
  const before = x.decides.length
  await x.send(DONE, 'r2'); await x.done(2)
  const second = x.packet(1)
  assert.match(second, /EG-Desk fetched these stored pages for the judgment this message asks for/)
  for (const id of Object.keys(delivered.pages)) assert.ok(!second.includes(body(id)), `${id} is already in the live context and is not sent again`)
  assert.ok(second.includes(body('db/pg-health')), 'what the next judgment needs and the live context lacks (the stand-in\'s first turn already delivered the follow-up checklist)')
  const midRequests = x.decides.slice(before).filter(d => !d.names.some(n => n.startsWith('tw_')))
  assert.deepEqual(midRequests[0].names, ['tn_courtesy', 'tn_need', 'tn_recall', 'tn_record'], 'triage first, at message arrival')
  assert.ok(midRequests.slice(1).every(d => /MID-CONVERSATION/.test(d.input)))
  assert.ok(Object.keys(x.chat.turnMemoryDelivered.get(x.cid).pages).includes('db/pg-health'), 'the receipts now include what this turn attached')
  const beforeThanks = x.decides.length
  await x.send('고마워', 'r3'); await x.done(3)
  assert.equal(x.packet(2), null); assert.equal(x.decides.length - beforeThanks, 1, 'one triage call, no fetch')
  assert.deepEqual(x.memoryEntries().map(e => [e.position, e.memory, e.attached]), [['first', 'ran', true], ['mid', 'ran', true], ['mid', 'skipped', false]])
  assert.ok(first.includes(body('db/pg-plan')))
  x.store.close()
})

test('caps: a loop that does not answer in time never holds the turn; the turn starts without a packet and nothing is carried to a later turn', async () => {
  // 1. A Decisions request that never answers: the loop gives up at its own deadline (the cap minus 200 ms), well before the request would.
  let release
  const hang = new Promise(resolve => { release = resolve })
  const x = await rig({ tm: { caps: { firstMs: 400, midMs: 400 } }, client: { decide: () => hang.then(() => ({ answers: {} })) } })
  let started = Date.now()
  await x.send(DONE, 'r1')
  let waited = Date.now() - started
  assert.ok(waited >= 150 && waited < 1500, `waited ${waited} ms: about the loop deadline, never the hung request`)
  assert.equal(x.packet(0), null)
  release(); await x.done(1)
  assert.equal(x.chat.turnMemoryDelivered.size, 0, 'nothing was delivered, so nothing counts as held')
  assert.deepEqual(x.memoryEntries().map(e => [e.mode, e.memory, e.fallback, e.attached]), [['on', 'fallback', 'timeout', false]])
  // 2. A loop that cannot even finish by itself (here the wiki source hangs): the cap is the last line, the turn starts at the cap.
  let releaseWiki
  const y = await rig({ tm: { caps: { firstMs: 300, midMs: 300 }, wiki: () => new Promise(resolve => { releaseWiki = resolve }) } })
  started = Date.now()
  await y.send(DONE, 'r1')
  waited = Date.now() - started
  assert.ok(waited >= 250 && waited < 1500, `waited ${waited} ms: the cap`)
  assert.equal(y.packet(0), null); assert.equal(y.decides.length, 0)
  releaseWiki(null); await y.done(1)
  assert.deepEqual(y.memoryEntries().map(e => [e.mode, e.memory, e.fallback, e.attached]), [['on', 'fallback', 'timeout', false]])
  assert.deepEqual(TURN_MEMORY_CAPS, { firstMs: 4000, midMs: 2500 })
  for (const r of [x, y]) r.store.close()
})

test('caps: a loop cut by its deadline attaches what it already has (the scan picks) and marks the packet partial', async () => {
  const judge = mockJudge()
  const client = { async decide(req) { if (req.questions.some(q => /^(st_|op_)/.test(q.name))) await new Promise(r => setTimeout(r, 2000)); return judge.decide(req) } }
  const x = await rig({ tm: { caps: { firstMs: 700, midMs: 700 }, ontologyWrite: false }, client })
  const started = Date.now()
  await x.send(DONE, 'r1'); await x.done(1)
  assert.ok(Date.now() - started < 2500)
  assert.ok(x.packet(0)?.includes(body('db/pg-plan')), 'the pages the scan already picked are attached')
  assert.doesNotMatch(x.packet(0), /status-read=/, 'the status reading that did not finish is simply absent')
  assert.deepEqual(x.memoryEntries().map(e => [e.memory, e.attached]), [['partial', true]])
  x.store.close()
})

test('re-check at dispatch: a page whose permission was withdrawn, or a mode switched off, while the thread was being prepared attaches nothing', async () => {
  let allowed = true
  const pages = SYNTHETIC_PAGES.map(p => (p.id === 'db/pg-plan' ? { ...p, mayRead: () => allowed } : p))
  const revoked = await rig({ wiki: buildWiki(pages), hooks: { onThreadStart: async x => { await x.chat.turnMemoryIdle(); allowed = false } } })
  await revoked.send(DONE, 'r1'); await revoked.done(1)
  assert.ok(revoked.decides.length > 0, 'the loop ran and picked the page')
  assert.equal(revoked.packet(0), null, 'but its permission was gone at dispatch, so the whole packet is dropped')
  assert.equal(revoked.chat.turnMemoryDelivered.size, 0)
  const switched = await rig({ hooks: { onThreadStart: async x => { await x.chat.turnMemoryIdle(); x.memoryMode = 'off' } } })
  await switched.send(DONE, 'r1'); await switched.done(1)
  assert.equal(switched.packet(0), null)
  for (const r of [revoked, switched]) r.store.close()
})

test('all egress through the shared gate: a kind the run\'s models may not receive sends nothing at all', async () => {
  const wiki = buildWiki(SYNTHETIC_PAGES); wiki.adapter = { counts: { speech: 1 } } // speech pages present, but no speech consent in this DM
  const x = await rig({ wiki })
  await x.send(DONE, 'r1'); await x.done(1)
  assert.equal(x.decides.length, 0, 'refused before any request')
  assert.equal(x.packet(0), null)
  x.store.close()
})

test('write judgment runs after the answer and stores only a pending reading; nothing promotes it, not even a policy callback', async () => {
  const x = await rig({ tm: { writer: (w, o) => createWikiWriter(w, { ...o, acceptStatus: () => true }) } })
  await x.send(DONE, 'r1'); await x.done(1)
  assert.ok(x.timeline.indexOf('decide:write') > x.timeline.indexOf('turn/completed'), 'the write judgment is made after the answer completed')
  assert.deepEqual(x.chat.turnMemoryWriteReceipts.get(x.run()), { proposal: 'update_status', reason: null, applied: 'recorded_pending' })
  const page = x.wiki.pages.get('db/pg-plan')
  assert.equal(page.status, 'plan', 'the stored status is untouched')
  assert.deepEqual(page.statusReadings.map(r => [r.status, r.state]), [['done', 'pending']])
  const entry = x.memoryEntries().at(-1)
  assert.ok(entry.judgments.some(j => j.q === 'write_target' && j.would === 'accept') && entry.judgments.some(j => j.q === 'triage_record'))
  // a question is not recorded; a turn that did not complete is not judged at all
  const q = await rig()
  await q.send('지난주 A사 견적 건 어디까지 됐지?', 'r1'); await q.done(1)
  assert.equal(q.chat.turnMemoryWriteReceipts.get(q.run()).proposal, 'none')
  assert.ok(!q.timeline.includes('decide:write'))
  const failed = await rig(); failed.terminal = 'failed'
  await failed.send(DONE, 'r1'); await new Promise(r => setTimeout(r, 200)); await failed.chat.turnMemoryIdle()
  assert.ok(!failed.timeline.includes('decide:write')); assert.equal(failed.wiki.pages.get('db/pg-plan').statusReadings.length, 0)
  for (const r of [x, q, failed]) r.store.close()
})

test('no writer, or the mode switched off before the answer finished: the judgment may run but nothing is stored', async () => {
  const none = await rig({ tm: { writer: undefined } })
  await none.send(DONE, 'r1'); await none.done(1)
  assert.equal(none.chat.turnMemoryWriteReceipts.get(none.run()).applied, null); assert.equal(none.wiki.pages.get('db/pg-plan').statusReadings.length, 0)
  const flipped = await rig()
  const sent = flipped.send(DONE, 'r1'); await sent; flipped.memoryMode = 'advisory'; await flipped.done(1)
  assert.equal(flipped.wiki.pages.get('db/pg-plan').statusReadings.length, 0)
  for (const r of [none, flipped]) r.store.close()
})

test('through the bridge wiring and the adapter: the pending reading is persisted (0600), shown beside the status next turn, and the changed page is sent again', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'egdesk-tm-on-adapter-')); await chmod(dir, 0o700)
  const GRAPH = { snapshots: [], edges: [], nodes: [{ id: 'plan', label: 'PostgreSQL 마이그레이션 배포 계획', body: '12월 첫째 주에 전환 배포할 예정이다. 아직 배포 전이다.', timeSlice: 'future' }] }
  const settings = { turnMemory: { mode: 'on' } }
  let adapter = null
  const config = createTurnMemoryConfig({ settings, ontologyStore: { readGraph: async () => GRAPH }, getAdapter: () => adapter ??= createWikiAdapter({ writes: openWikiWrites({ dataDir: path.join(dir, 'settings'), log: quiet }) }) })
  assert.equal(config.ontologyWrite, true); settings.turnMemory.mode = 'advisory'; assert.equal(config.ontologyWrite, false, 'advisory never judges or stores a write'); settings.turnMemory.mode = 'on'
  const x = await rig({ tm: { mode: config.mode, wiki: config.wiki, scope: config.scope, writer: config.writer, get ontologyWrite() { return config.ontologyWrite }, budget: config.budget } })
  await x.send(DONE, 'r1'); await x.done(1)
  assert.match(x.packet(0), /\[page id=ontology:plan time=planned /)
  assert.equal(x.chat.turnMemoryWriteReceipts.get(x.run()).applied, 'recorded_pending')
  const file = path.join(dir, 'settings', 'egdesk-wiki-writes.json')
  assert.equal((await stat(file)).mode & 0o777, 0o600)
  const saved = JSON.parse(await readFile(file, 'utf8'))
  assert.deepEqual(saved.readings.map(r => [r.pageId, r.reading.status, r.reading.state]), [['ontology:plan', 'done', 'pending']])
  assert.ok(!JSON.stringify(saved).includes('끝났어'), 'no copy of what the person said')
  await x.send('PostgreSQL 마이그레이션 배포 계획 다시 알려줘', 'r2'); await x.done(2)
  assert.match(x.packet(1) ?? '', /\[page id=ontology:plan [^\]]*status-recorded=unknown[^\]]*status-reported-pending=done/, 'the reading is beside the status, and the page (its revision moved) is sent again')
  x.store.close()
})

test('compaction signal: the contextCompaction item (and the deprecated thread/compacted) of that thread, nothing else', () => {
  const item = type => ({ method: 'item/completed', params: { threadId: 't1', turnId: 'u1', item: { id: 'i1', type } } })
  assert.equal(compactionSignal(item('contextCompaction')), 't1')
  assert.equal(compactionSignal({ ...item('contextCompaction'), method: 'item/started' }), 't1')
  assert.equal(compactionSignal({ method: 'thread/compacted', params: { threadId: 't2', turnId: 'u9' } }), 't2')
  for (const other of [item('agentMessage'), item('reasoning'), { method: 'thread/compacted', params: {} }, { method: 'item/agentMessage/delta', params: { threadId: 't1', item: { type: 'contextCompaction' } } },
    { method: 'turn/completed', params: { threadId: 't1' } }, null, {}, { method: 'thread/compacted' }]) assert.equal(compactionSignal(other), null)
})

test('engine compaction: receipts are dropped, the next turn reconstructs as a first turn and re-sends what the model lost, then the session is mid again', async () => {
  for (const signal of [cid => ({ method: 'item/completed', params: { threadId: cid, turnId: 'turn-1', item: { id: 'c1', type: 'contextCompaction' } } }), cid => ({ method: 'thread/compacted', params: { threadId: cid, turnId: 'turn-1' } })]) {
    const x = await rig({ tm: { ontologyWrite: false } })
    await x.send(PLAN_Q, 'r1'); await x.done(1)
    assert.ok(x.chat.turnMemoryDelivered.has(x.cid))
    assert.equal(x.chat.turnPosition({ conversationId: x.cid, clientThreadId: 'dm-1' }).kind, 'mid')
    await x.chat.handleNotification(signal(x.cid))
    assert.equal(x.chat.turnMemoryDelivered.has(x.cid), false, 'what was delivered may be gone')
    assert.deepEqual(x.chat.turnPosition({ conversationId: x.cid, clientThreadId: 'dm-1' }), { kind: 'first', reason: 'context_compacted' })
    await x.chat.handleNotification(signal('some-other-thread'))
    await x.send(PLAN_Q, 'r2'); await x.done(2)
    assert.match(x.packet(1), /EG-Desk reconstructed memory for this turn/); assert.ok(x.packet(1).includes(body('db/pg-plan')), 'sent again after the compaction')
    assert.equal(x.chat.turnPosition({ conversationId: x.cid, clientThreadId: 'dm-1' }).kind, 'mid', 'the mark is spent once a loop ran for the turn after it')
    assert.deepEqual(x.memoryEntries().map(e => e.position), ['first', 'first'])
    x.store.close()
  }
})
