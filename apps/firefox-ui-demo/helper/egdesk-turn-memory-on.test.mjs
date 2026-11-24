import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { chmod, mkdtemp, readFile, stat } from 'node:fs/promises'
import { CodexChatRuntime, TURN_MEMORY_CAPS, TURN_MEMORY_KEY, compactionSignal } from './codex-chat-runtime.mjs'
import { DECISION_CONTEXT_KEY } from './egdesk-context-setup.mjs'
import { BODY_ELSEWHERE, SAME_SOURCE } from './egdesk-wiki-reconstruction.mjs'
import { openChatStore } from './egdesk-chat-store.mjs'
import { openCalibrationLog } from './egdesk-decision-calibration-log.mjs'
import { buildWiki } from './egdesk-wiki-reconstruction.mjs'
import { SYNTHETIC_PAGES, createFakeClock, deferred, mockJudge, until } from './egdesk-wiki-reconstruction.fixture.mjs'
import { createWikiWriter } from './egdesk-turn-memory.mjs'
import { createWikiAdapter, openWikiWrites } from './egdesk-wiki-adapter.mjs'
import { createTurnMemoryConfig } from './egdesk-turn-memory-wiring.mjs'

// Real: CodexChatRuntime.send / finish, the turn/start parameters, the chat store, the calibration log, the memory loop, the write path.
// Synthetic: the native engine (thread/start, turn/start and its notifications) and the Decisions client (a lexical stand-in, never a model).
// Time: every rig runs turn memory on a manual clock (x.clock). It moves only when a test moves it, so no cap or deadline can pass by
// accident on a busy machine, and the cap tests state exactly when things happen instead of sleeping and measuring.
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
  const x = { dir, store, calibrationLog, wiki, starts: [], decides: [], timeline: [], events: [], memoryMode, decisionMode, manual: hooks.manualFinish === true, terminal: 'completed', clock: tm.clock ?? createFakeClock() }
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
      const finish = async () => { const n = (m, q) => chat.handleNotification({ method: m, params: q })
        await n('item/started', { ...timing, item: { id: `a${id}`, type: 'agentMessage', phase: 'final_answer', text: '' } })
        await n('item/completed', { ...timing, item: { id: `a${id}`, type: 'agentMessage', phase: 'final_answer', text: '네' } })
        x.timeline.push(`turn/${x.terminal}`)
        await n('turn/completed', { threadId: p.threadId, turn: { id, status: x.terminal, items: [] } }) }
      // The engine's answer arrives after turn/start returned (a later event-loop turn), or when the test says so.
      if (x.manual) x.finish = finish; else setImmediate(() => setImmediate(finish))
      return { turn: { id, status: 'inProgress', items: [] } } },
    respond: () => {}, emit: e => x.events.push(e), emitLegacy: () => {}, verifyFile: async () => null,
    decisionContext: { calibrationLog, mode: () => x.decisionMode, settingsGeneration: () => 0, configured: () => true, budgetMs: 800,
      client: { model: 'syn', async decide(req) {
        const names = req.questions.map(q => q.name)
        x.decides.push({ names, input: req.input.map(m => (typeof m.content === 'string' ? m.content : '')).join('\n') })
        x.timeline.push(names.some(n => n.startsWith('tw_')) ? 'decide:write' : names.some(n => n.startsWith('tn_')) ? 'decide:triage' : 'decide:fetch')
        return (client ?? judge).decide(req)
      } }, collect: async () => (hooks.collect ? hooks.collect() : []),
      turnMemory: memoryMode === null ? undefined : { mode: () => x.memoryMode, wiki: async () => x.wiki, scope: () => SCOPE, writer: (w, o) => createWikiWriter(w, o), ontologyWrite: true, budget: { linksFirst: true }, ...tm, clock: x.clock } } })
  chat.setConnection(true)
  x.chat = chat
  const completed = () => store.listMessages('dm-1').messages.filter(m => m.role === 'assistant' && m.status === 'complete').length
  x.done = async n => { await until(() => completed() >= n, `answer ${n} completed`); await x.clock.settle(); await chat.turnMemoryIdle(); await x.clock.settle() }
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

test('caps: a request that never answers is given up at the loop deadline (cap minus 200 ms on the clock); the turn starts then, without a packet', async () => {
  const gate = deferred()
  const x = await rig({ tm: { caps: { firstMs: 400, midMs: 400 } }, client: { decide: () => gate.promise } })
  const t0 = x.clock.now()
  const sending = x.send(DONE, 'r1')
  await until(() => x.decides.length >= 1 && x.clock.pending() >= 2, 'the loop asked and the turn waits on the cap')
  await x.clock.advance(199)
  assert.equal(x.starts.length, 0, 'the turn is held while the loop may still answer in time')
  await x.clock.advance(2)
  await sending
  assert.equal(x.starts.length, 1); assert.equal(x.packet(0), null)
  assert.ok(x.clock.now() - t0 < 400, 'released at the loop deadline, before the cap')
  gate.resolve({ answers: {} }); await x.done(1)
  assert.equal(x.chat.turnMemoryDelivered.size, 0, 'nothing was delivered, so nothing counts as held and nothing is carried to a later turn')
  assert.deepEqual(x.memoryEntries().map(e => [e.mode, e.memory, e.fallback, e.attached]), [['on', 'fallback', 'timeout', false]])
  assert.deepEqual(TURN_MEMORY_CAPS, { firstMs: 4000, midMs: 2500 })
  x.store.close()
})

test('caps: a loop that cannot finish by itself is cut at the cap, to the millisecond on the clock; an early timer does not release the turn early', async () => {
  for (const earlyMs of [0, 30]) {
    const wikiGate = deferred(), clock = createFakeClock({ earlyMs })
    const x = await rig({ tm: { clock, caps: { firstMs: 300, midMs: 300 }, wiki: () => wikiGate.promise } })
    const sending = x.send(DONE, 'r1')
    await until(() => clock.pending() >= 1, 'the turn waits on the cap')
    await clock.advance(299)
    assert.equal(x.starts.length, 0, `earlyMs ${earlyMs}: still held one millisecond before the cap`)
    await clock.advance(2)
    await sending
    assert.equal(x.starts.length, 1); assert.equal(x.packet(0), null); assert.equal(x.decides.length, 0)
    wikiGate.resolve(null); await x.done(1)
    assert.deepEqual(x.memoryEntries().map(e => [e.mode, e.memory, e.fallback, e.attached]), [['on', 'fallback', 'timeout', false]])
    x.store.close()
  }
})

test('the cap is authoritative: a packet that became ready after the cap on the clock is not attached, even when no timer has fired (a busy process)', async () => {
  // The scan answers in time and its picks are kept. While the link round is out, the process is "busy": the clock passes the cap and no
  // timer has run. The loop then closes with the scan picks (a ready, partial packet) at 450 ms. Deciding by which callback ran first would
  // attach that packet; deciding by the clock does not.
  const judge = mockJudge(), clock = createFakeClock()
  const t0 = clock.now()
  const client = { async decide(req) { if (req.questions.some(q => /^(st_|op_)/.test(q.name))) clock.set(t0 + 450); return judge.decide(req) } }
  const x = await rig({ tm: { clock, caps: { firstMs: 400, midMs: 400 }, ontologyWrite: false }, client })
  await x.send(DONE, 'r1'); await x.done(1)
  assert.ok(x.decides.some(d => d.names.some(n => n.startsWith('pg_'))), 'the loop ran and picked pages')
  assert.ok(x.decides.some(d => d.names.some(n => /^(st_|op_)/.test(n))), 'the link round was started in time')
  assert.equal(x.packet(0), null, 'ready at 450 ms with a 400 ms cap: not attached')
  assert.equal(x.chat.turnMemoryDelivered.size, 0)
  assert.equal(x.events.some(e => /기억 자료/.test(JSON.stringify(e))), false)
  assert.deepEqual(x.memoryEntries().map(e => [e.mode, e.memory, e.fallback, e.attached]), [['on', 'fallback', 'timeout', false]])
  // control: the same turn without the jump is attached
  const y = await rig({ tm: { caps: { firstMs: 400, midMs: 400 }, ontologyWrite: false } })
  await y.send(DONE, 'r1'); await y.done(1)
  assert.ok(y.packet(0)?.includes(body('db/pg-plan')))
  for (const r of [x, y]) r.store.close()
})

test('caps: a loop cut by its deadline attaches what it already has (the scan picks) and marks the packet partial', async () => {
  const judge = mockJudge(), never = deferred()
  const client = { async decide(req) { if (req.questions.some(q => /^(st_|op_)/.test(q.name))) await never.promise; return judge.decide(req) } }
  const x = await rig({ tm: { caps: { firstMs: 700, midMs: 700 }, ontologyWrite: false }, client })
  const sending = x.send(DONE, 'r1')
  await until(() => x.decides.some(d => d.names.some(n => /^(st_|op_)/.test(n))) && x.clock.pending() >= 2, 'the link round is pending and the turn waits')
  assert.equal(x.starts.length, 0)
  await x.clock.advance(501) // the loop deadline is the cap minus 200 ms
  await sending; await x.done(1)
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
  assert.deepEqual(x.chat.turnMemoryWriteReceipts.get(x.run()), { proposal: 'update_status', reason: null, applied: 'recorded_pending', pageId: 'db/pg-plan', status: 'done' })
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
  await failed.send(DONE, 'r1'); await until(() => failed.run()?.status === 'failed', 'the run failed'); await failed.clock.settle(); await failed.chat.turnMemoryIdle()
  assert.ok(!failed.timeline.includes('decide:write')); assert.equal(failed.wiki.pages.get('db/pg-plan').statusReadings.length, 0)
  for (const r of [x, q, failed]) r.store.close()
})

test('no writer, or the mode switched off before the answer finished: the judgment may run but nothing is stored', async () => {
  const none = await rig({ tm: { writer: undefined } })
  await none.send(DONE, 'r1'); await none.done(1)
  assert.equal(none.chat.turnMemoryWriteReceipts.get(none.run()).applied, null); assert.equal(none.wiki.pages.get('db/pg-plan').statusReadings.length, 0)
  const flipped = await rig({ hooks: { manualFinish: true } })
  await flipped.send(DONE, 'r1'); flipped.memoryMode = 'advisory' // switched while the answer is still being written
  await flipped.finish(); await flipped.done(1)
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

// ---- the turn's memory materials as data ----
test('memoryMaterialsFor: this turn\'s materials as plain data, by run or by request context; valid for the turn only; nothing when off', async () => {
  const x = await rig({ tm: { ontologyWrite: false } })
  await x.send(PLAN_Q, 'r1'); await x.done(1)
  const run1 = x.run(), first = x.chat.memoryMaterialsFor(run1)
  assert.equal(x.chat.memoryMaterialsState(run1), 'attached')
  assert.ok(first.length >= 2 && first.every(m => m.held === false) && Object.isFrozen(first) && first.every(Object.isFrozen))
  assert.deepEqual(Object.keys(first[0]).filter(k => k !== 'statusReading' && k !== 'statusPending'), ['alias', 'kind', 'time', 'provenance', 'status', 'title', 'excerpt', 'links', 'held'])
  // exactly the pages of the packet, in its order, and no id, reference or revision of any of them
  const packet = x.packet(0), titles = first.map(m => m.title)
  assert.deepEqual(titles, [...packet.matchAll(/\[page id=(\S+) /g)].map(m => SYNTHETIC_PAGES.find(p => p.id === m[1]).title))
  assert.doesNotMatch(JSON.stringify(first), /db\/pg-|rev=|"id"|"ref"|"revision"|probab/)
  for (const m of first) for (const l of m.links) assert.ok(first.some(o => o.alias === l.toAlias), 'every link resolves inside the list')
  // bounded on request
  const small = x.chat.memoryMaterialsFor(run1, { excerptChars: 10, max: 1 })
  assert.equal(small.length, 1); assert.ok(small[0].excerpt.length <= 10 + 4)
  assert.ok(x.chat.memoryMaterialsFor(run1, { excerptChars: 1e9, max: 1e9 }).every(m => m.excerpt.length <= 2400 + 4))
  // the next turn: what it attaches is new, what the thread already holds is marked held; the first turn's materials are no longer served
  await x.send(DONE, 'r2'); await x.done(2)
  const run2 = x.run(), second = x.chat.memoryMaterialsFor(run2)
  assert.deepEqual(x.chat.memoryMaterialsFor(run1), [], 'valid for the turn only')
  assert.equal(x.chat.memoryMaterialsState(run1), 'none')
  assert.ok(second.some(m => !m.held) && second.some(m => m.held))
  assert.deepEqual(second.filter(m => m.held).map(m => m.title).sort(), titles.slice().sort(), 'held = what the first turn really delivered')
  assert.ok(second.findIndex(m => m.held) > second.findLastIndex(m => !m.held), 'attached rows come first')
  assert.ok(second.filter(m => m.held).every(m => m.statusReading === undefined), 'no reading is claimed for a page nobody judged this turn')
  // not a turn of this runtime, or the feature switched off: nothing
  assert.deepEqual(x.chat.memoryMaterialsFor({}), []); assert.deepEqual(x.chat.memoryMaterialsFor(null), []); assert.equal(x.chat.memoryMaterialsState('x'), 'none')
  x.memoryMode = 'advisory'
  assert.deepEqual(x.chat.memoryMaterialsFor(run2), [])
  x.store.close()
})

test('memoryMaterialsFor: permission is checked again at every call; a packet that was not sent leaves only held rows; before the turn is sent the state is pending', async () => {
  let allowed = true
  const guarded = buildWiki(SYNTHETIC_PAGES.map(p => (p.id === 'db/pg-plan' ? { ...p, mayRead: () => allowed } : p)))
  const x = await rig({ wiki: guarded, tm: { ontologyWrite: false } })
  await x.send(PLAN_Q, 'r1'); await x.done(1)
  const run = x.run(), before = x.chat.memoryMaterialsFor(run)
  assert.ok(before.some(m => m.title === 'PostgreSQL 마이그레이션 배포 계획'))
  allowed = false
  const after = x.chat.memoryMaterialsFor(run)
  assert.ok(!after.some(m => m.title === 'PostgreSQL 마이그레이션 배포 계획') && after.length === before.length - 1, 'the withdrawn page is gone')
  for (const m of after) for (const l of m.links) assert.ok(after.some(o => o.alias === l.toAlias), 'and so are links to it')
  x.store.close()
  // pending: asked with the request context while turn/start has not returned yet
  let seen = null
  const y = await rig({ tm: { ontologyWrite: false } })
  const original = y.chat.turnMemoryMayDispatch.bind(y.chat)
  y.chat.turnMemoryMayDispatch = (turn, extra) => { const context = [...[y.lastContext]].filter(Boolean)[0]; seen = { state: y.chat.memoryMaterialsState(context), rows: y.chat.memoryMaterialsFor(context).length }; return original(turn, extra) }
  const begin = y.chat.beginTurnMemory.bind(y.chat)
  y.chat.beginTurnMemory = (body, context) => { y.lastContext = context; return begin(body, context) }
  await y.send(PLAN_Q, 'r1'); await y.done(1)
  assert.equal(seen.state, 'pending'); assert.ok(seen.rows >= 2)
  assert.equal(y.chat.memoryMaterialsState(y.lastContext), 'attached')
  y.store.close()
  // not sent (the mode was switched off between the loop and the dispatch, then on again): no attached rows are claimed
  const z = await rig({ tm: { ontologyWrite: false }, hooks: { onThreadStart: r => { r.memoryMode = 'advisory' } } })
  await z.send(PLAN_Q, 'r1'); await z.done(1)
  assert.equal(z.packet(0), null)
  z.memoryMode = 'on'
  assert.equal(z.chat.memoryMaterialsState(z.run()), 'not_attached'); assert.deepEqual(z.chat.memoryMaterialsFor(z.run()), [])
  z.store.close()
})

// ---- one packet: selection and memory together ----
// A stand-in for the context selection: every listed candidate is judged relevant. Everything else goes to the lexical memory stand-in.
function selecting() {
  const judge = mockJudge()
  return { async decide(req) {
    if (!req.questions.some(q => q.name === 'answer_type')) return judge.decide(req)
    const answers = {}
    for (const q of req.questions) answers[q.name] = q.type === 'choice'
      ? { type: 'choice', choice: q.name === 'time_intent' ? 'present' : 'answer', confidence: 0.95, probabilities: [{ value: q.name === 'time_intent' ? 'present' : 'answer', probability: 0.95 }, { value: 'browse', probability: 0.02 }] }
      : { type: 'predicate', probability: 0.95 }
    return { answers, model: 'syn', usage: { inputTokens: 1 }, latencyMs: 3 }
  } }
}
const page = id => SYNTHETIC_PAGES.find(p => p.id === id)
// The same records the wiki holds, offered to the context selection as candidates (as the ontology graph is to both features).
const asCandidate = (id, extra = {}) => ({ id, kind: 'document', title: page(id).title, summary: `${page(id).title} 요약`, timeSlice: page(id).time?.slice ?? 'unknown', loadText: async () => page(id).body, ...extra })
const count = (text, part) => text.split(part).length - 1

test('one packet (flag): selection and memory ride under ONE key and no page body is sent twice; the selected items are byte-identical to what they were', async () => {
  const collect = () => [asCandidate('db/pg-plan'), asCandidate('db/pg-health')]
  const two = await rig({ tm: { ontologyWrite: false }, client: selecting(), hooks: { collect } })
  await two.send(PLAN_Q, 'r1'); await two.done(1)
  const selection = two.starts[0].additionalContext[DECISION_CONTEXT_KEY].value, memory = two.packet(0)
  assert.ok(selection.includes(body('db/pg-plan')) && memory.includes(body('db/pg-plan')), 'without the flag (today): the same body under two keys')
  const one = await rig({ tm: { ontologyWrite: false, onePacket: true }, client: selecting(), hooks: { collect } })
  await one.send(PLAN_Q, 'r1'); await one.done(1)
  const context = one.starts[0].additionalContext
  assert.equal(Object.hasOwn(context, TURN_MEMORY_KEY), false, 'no second key')
  const value = context[DECISION_CONTEXT_KEY].value
  assert.ok(value.startsWith(selection), 'the selected items come first and are byte-identical')
  const all = Object.values(context).map(entry => entry.value).join('\n')
  const sent = [...memory.matchAll(/\[page id=(\S+) /g)].map(m => m[1])
  assert.ok(sent.includes('db/pg-plan') && sent.some(id => !['db/pg-plan', 'db/pg-health'].includes(id)), 'memory picked selected and unselected pages')
  for (const id of sent) assert.equal(count(all, body(id)), 1, `${id}: its body reaches the model exactly once`)
  // the page that is also a selected item keeps its header (time, provenance, status reading) and loses only its body
  assert.match(value, new RegExp(`\\[page id=db/pg-plan [^\\]]*status-recorded=plan[^\\]]*\\]\\n${BODY_ELSEWHERE.replace(/[[\]]/g, '\\$&')}`))
  assert.equal(count(value, BODY_ELSEWHERE), sent.filter(id => ['db/pg-plan', 'db/pg-health'].includes(id)).length)
  // everything else in turn/start is what it was
  const strip = p => JSON.stringify({ ...p, additionalContext: undefined })
  assert.equal(normalize(strip(one.starts[0])), normalize(strip(two.starts[0])))
  // receipts and the data accessor still describe what the model holds: every page, attached
  assert.deepEqual(Object.keys(one.chat.turnMemoryDelivered.get(one.cid).pages).sort(), sent.slice().sort())
  assert.deepEqual(one.chat.memoryMaterialsFor(one.run()).map(m => m.title), sent.map(id => page(id).title))
  const row = one.run().activities.find(a => a.detail?.feature === 'turnMemory')
  assert.deepEqual([row.detail.onePacket, row.detail.notRepeated, row.detail.sameSource], [true, count(value, BODY_ELSEWHERE), 0])
  for (const r of [two, one]) r.store.close()
})

test('one packet: a selected item shown in another form (a summary) keeps the memory body once, marked as the same record; with nothing selected the memory packet is unchanged', async () => {
  // the selection could not load the text and attached the catalog summary; memory has the body
  const collect = () => [asCandidate('db/pg-plan', { loadText: async () => { throw new Error('unreadable') } })]
  const x = await rig({ tm: { ontologyWrite: false, onePacket: true }, client: selecting(), hooks: { collect } })
  await x.send(PLAN_Q, 'r1'); await x.done(1)
  const value = x.starts[0].additionalContext[DECISION_CONTEXT_KEY].value
  assert.equal(Object.hasOwn(x.starts[0].additionalContext, TURN_MEMORY_KEY), false)
  assert.equal(count(value, body('db/pg-plan')), 1, 'the body is there once')
  assert.ok(value.includes(`${SAME_SOURCE}\n${body('db/pg-plan')}`), 'and says it is the same record as the item above')
  assert.equal(count(value, BODY_ELSEWHERE), 0)
  // nothing selected: there is nothing to merge with, the memory packet rides under its own key exactly as without the flag
  const plain = await rig({ tm: { ontologyWrite: false } })
  await plain.send(PLAN_Q, 'r1'); await plain.done(1)
  const alone = await rig({ tm: { ontologyWrite: false, onePacket: true } })
  await alone.send(PLAN_Q, 'r1'); await alone.done(1)
  const sameClock = text => normalize(text).replace(/Question clock: \S+/g, 'Question clock: T') // the two rigs asked a few milliseconds apart
  assert.equal(sameClock(JSON.stringify(alone.starts[0])), sameClock(JSON.stringify(plain.starts[0])))
  for (const r of [x, plain, alone]) r.store.close()
})

test('one packet: with turn memory off (or advisory) the flag changes nothing: turn/start is byte-identical with and without it, selection included', async () => {
  const collect = () => [asCandidate('db/pg-plan'), asCandidate('db/pg-health')]
  const base = await rig({ memoryMode: null, client: selecting(), hooks: { collect } })
  await base.send(PLAN_Q, 'r1'); await base.done(1)
  assert.ok(base.starts[0].additionalContext[DECISION_CONTEXT_KEY].value.includes(body('db/pg-plan')), 'the selection itself is attached')
  for (const memoryMode of ['off', 'advisory']) {
    const x = await rig({ memoryMode, tm: { ontologyWrite: false, onePacket: true }, client: selecting(), hooks: { collect } })
    await x.send(PLAN_Q, 'r1'); await x.done(1)
    assert.equal(normalize(JSON.stringify(x.starts[0])), normalize(JSON.stringify(base.starts[0])), memoryMode)
    x.store.close()
  }
  // and with the flag off, turn memory on: both keys, as before this change
  const on = await rig({ tm: { ontologyWrite: false }, client: selecting(), hooks: { collect } })
  await on.send(PLAN_Q, 'r1'); await on.done(1)
  assert.deepEqual(Object.keys(on.starts[0].additionalContext).filter(k => k === DECISION_CONTEXT_KEY || k === TURN_MEMORY_KEY).sort(), [DECISION_CONTEXT_KEY, TURN_MEMORY_KEY].sort())
  assert.equal(on.starts[0].additionalContext[DECISION_CONTEXT_KEY].value, base.starts[0].additionalContext[DECISION_CONTEXT_KEY].value)
  for (const r of [base, on]) r.store.close()
})

// ---- A3: a developer flag of the bridge, read the way the bridge reads it, really reaches the runtime ----
test('bridge flags reach the runtime through createTurnMemoryConfig: one packet, the write target, the confirmation flow; unset changes nothing', async () => {
  const { createTurnMemoryConfig: build, turnMemoryFlagsFromEnv } = await import('./egdesk-turn-memory-wiring.mjs')
  const collect = () => [asCandidate('db/pg-plan'), asCandidate('db/pg-health')]
  const world = async env => {
    // the config object the bridge builds from its environment; the runtime reads its options from it
    const config = build({ settings: { turnMemory: { mode: 'on' } }, getAdapter: () => ({}), ...turnMemoryFlagsFromEnv(env) })
    const options = Object.fromEntries(['onePacket', 'writeTarget', 'confirmInConversation'].filter(k => Object.hasOwn(config, k)).map(k => [k, config[k]]))
    const x = await rig({ tm: options, client: selecting(), hooks: { collect } })
    await x.send(DONE, 'r1'); await x.done(1)
    const out = { keys: Object.keys(x.starts[0].additionalContext).filter(k => k === DECISION_CONTEXT_KEY || k === TURN_MEMORY_KEY).sort(),
      write: x.decides.filter(d => d.names.some(n => n.startsWith('tw_'))).map(d => (d.names.includes('tw_target') ? 'choice' : 'about')), confirm: x.chat.turnMemoryConfirmOn() }
    x.store.close()
    return out
  }
  const plain = await world({})
  assert.deepEqual(plain, { keys: [DECISION_CONTEXT_KEY, TURN_MEMORY_KEY].sort(), write: ['about'], confirm: false })
  const flagged = await world({ EGDESK_TURN_MEMORY_ONE_PACKET: 'on', EGDESK_TURN_MEMORY_WRITE_TARGET: 'choice', EGDESK_TURN_MEMORY_CONFIRM: 'on' })
  assert.deepEqual(flagged, { keys: [DECISION_CONTEXT_KEY], write: ['choice'], confirm: true })
})

test('one packet: a confirmation note with no pages to add also rides under the selection\'s key, never under a second key', async () => {
  const { buildWiki: build } = await import('./egdesk-wiki-reconstruction.mjs')
  const x = await rig({ tm: { ontologyWrite: false, onePacket: true, confirmInConversation: true }, client: selecting(), hooks: { collect: () => [asCandidate('db/pg-plan')] } })
  const value = 'SELECTION'
  const turn = { note: '[noted in this conversation, not confirmed]\n- "x": the person reported it as done.', noteEntries: [], readyMs: 1, capMs: 10, wiki: build([]), scope: null }
  assert.equal(x.chat.onePacketSelection({ mode: 'on' }, { [DECISION_CONTEXT_KEY]: { kind: 'application', value } }), value)
  assert.equal(x.chat.onePacketSelection({ mode: 'advisory' }, { [DECISION_CONTEXT_KEY]: { kind: 'application', value } }), null)
  assert.equal(x.chat.onePacketSelection({ mode: 'on' }, {}), null)
  x.chat.decisionContext.turnMemory.ontologyWrite = true
  assert.equal(typeof x.chat.turnMemoryNoteFor(turn, {}), 'string', 'the note is ready to go')
  x.store.close()
})
