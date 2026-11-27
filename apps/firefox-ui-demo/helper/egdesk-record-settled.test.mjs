import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { chmod, mkdtemp, readFile } from 'node:fs/promises'
import { ImmutableContextStore } from './egdesk-context-store.mjs'
import { MemoryEvidenceStore } from './egdesk-memory-evidence.mjs'
import { CodexChatRuntime, RECORDING_KEY, TURN_MEMORY_KEY } from './codex-chat-runtime.mjs'
import { openChatStore } from './egdesk-chat-store.mjs'
import { collectDecisionCandidates } from './egdesk-decision-candidates.mjs'
import { createTurnMemoryConfig } from './egdesk-turn-memory-wiring.mjs'
import { createWikiAdapter, openWikiWrites } from './egdesk-wiki-adapter.mjs'
import { CONTRADICTION_LIMITS, SETTLED_HEAD, contradictionPairs, contradictionRequest, judgeContradictions, judgeRecordConflict, settledRecordText } from './egdesk-record-settled.mjs'
import { RECORDING_RULE } from './egdesk-turn-memory.mjs'
import { createFakeClock, deferred, mockJudge, until } from './egdesk-wiki-reconstruction.fixture.mjs'

// L7 c38 (flag turnMemory.writeFirst): the record write judgment runs at the START of the turn and the engine is handed the settled state. The world below is c35's runtime world.
// A pending reading becomes the record's status through the conversation: the answering model says what was noted, the person's next
// message is read as confirm / object / neither. No form, no button, no question the person must answer.
// Real: the runtime, the chat store, the consent store, the wiki adapter and its write store (through createTurnMemoryConfig), the loop,
// the write path. Synthetic: the native engine (it "follows" the note by saying the sentence, or ignores it when told to) and the
// Decisions client (lexical stand-in). Public synthetic text only.
const OWNER = 'codex:synthetic:qa', AGENT = 'sol', DM = 'dm-1'
const profiles = { runProfile: (p, r) => ({ binding: { profileId: p, revision: r ?? 1, hash: 'h' }, developerInstructions: 'x', toolCeiling: null, model: null }) }
const quiet = () => {}
const settledOf = (w, i) => w.starts[i]?.additionalContext?.[RECORDING_KEY]?.value ?? ''
const GRAPH = { snapshots: [], edges: [], nodes: [{ id: 'plan', label: 'PostgreSQL 마이그레이션 배포 계획', body: '12월 첫째 주에 전환 배포할 예정이다. 아직 배포 전이다.', timeSlice: 'future' }] }
const DONE = 'PostgreSQL 마이그레이션 배포 끝났어'
const NOTE_HEAD = '[noted in this conversation, not confirmed]'

// a1: the stand-in engine records starts[] at once and its start snapshots (atStart, memoAtStart, speechAtStart) after two file reads, so a
// test that reads a snapshot waits for the last one (speechAtStart) instead of starts[] alone (a loaded machine ran the assertion between them)
async function world({ confirm = true, consent = true, writeTarget = 'about', writeFirst = true, conflictP = 0.02, holdWrite = false, graph = GRAPH, ctP = 0.97 } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'egdesk-confirm-')); await chmod(dir, 0o700)
  const w = { dir, now: 1_800_000_000_000, requests: [], starts: [], events: [], turns: 0, threads: 0, clock: createFakeClock(), atStart: [], memoAtStart: [], speechAtStart: [], memoAtReply: [], speechAtReply: [], gate: null }
  const captures = new ImmutableContextStore({ dataDir: path.join(dir, 'state'), allowedRoots: [dir], now: () => w.now })
  w.evidence = new MemoryEvidenceStore({ dataDir: path.join(dir, 'state'), captures, now: () => w.now })
  w.store = openChatStore({ dataDir: path.join(dir, 'chat'), ownerScope: 'synthetic-confirm' })
  const judge = mockJudge()
  let adapter = null
  const config = createTurnMemoryConfig({ settings: { turnMemory: { mode: 'on' } }, ontologyStore: { readGraph: async () => graph }, confirmInConversation: confirm, writeTarget, writeFirst,
    getAdapter: () => adapter ??= createWikiAdapter({ writes: openWikiWrites({ dataDir: path.join(dir, 'settings'), log: quiet }) }) })
  const chat = new CodexChatRuntime({ now: () => (w.now += 1000), store: w.store, requireStore: true, getOwnerKey: () => OWNER, profiles, resolveProjectWorkspace: async () => null,
    request: async (method, p) => {
      if (method === 'thread/start') return { thread: { id: `t${++w.threads}` }, cwd: '/work', model: 'syn' }
      if (method === 'thread/resume') return { thread: { id: p.threadId, turns: [] }, cwd: '/work' }
      if (method === 'config/read') return { config: { developer_instructions: null } }
      if (method === 'thread/unsubscribe') return { status: 'unsubscribed' }
      w.starts.push(p); w.atStart.push(await w.readings()); w.memoAtStart.push(await w.memos()); w.speechAtStart.push(w.speechIds())
      const id = `turn-${++w.turns}`, timing = { threadId: p.threadId, turnId: id }
      // The stand-in for the answering model: when it was given the note, it says what was noted (unless this world's model ignores it).
      // The stand-in for the answering model: told the settled state it words it as an unconfirmed report; told nothing it speaks as if it were settled (check-27mw).
      const settled = Object.values(p.additionalContext ?? {}).some(entry => typeof entry.value === 'string' && entry.value.includes(SETTLED_HEAD))
      const noted = Object.values(p.additionalContext ?? {}).some(entry => typeof entry.value === 'string' && entry.value.includes(NOTE_HEAD))
      const text = settled || noted ? '네. PostgreSQL 마이그레이션 배포 끝났다는 말씀은 아직 확인 전인 보고로 적어 뒀어요.' : p.input?.[0]?.text?.includes('끝났') ? '네, 배포가 완료됐군요.' : '네, 알겠어요.'
      const finish = async () => { w.memoAtReply.push(await w.memos()); w.speechAtReply.push(w.speechIds()); const n = (m, q) => chat.handleNotification({ method: m, params: q })
        await n('item/started', { ...timing, item: { id: `a${id}`, type: 'agentMessage', phase: 'final_answer', text: '' } })
        await n('item/completed', { ...timing, item: { id: `a${id}`, type: 'agentMessage', phase: 'final_answer', text } })
        await n('turn/completed', { threadId: p.threadId, turn: { id, status: 'completed', items: [] } }) }
      setImmediate(() => setImmediate(finish))
      return { turn: { id, status: 'inProgress', items: [] } } },
    respond: () => {}, emit: e => w.events.push(e), emitLegacy: () => {}, verifyFile: async () => null,
    decisionContext: { mode: () => 'on', settingsGeneration: () => 0, configured: () => true, budgetMs: 5000, memoryEvidence: w.evidence,
      client: { model: 'syn', async decide(req) {
        const names = req.questions.map(q => q.name)
        const stage = names.includes('answer_type') ? 'context' : names.includes('cf_differs') ? 'conflict' : names.some(n => n.startsWith('ct_')) ? 'contradiction' : names.some(n => n.startsWith('rc_')) ? 'confirm' : names.some(n => n.startsWith('tw_')) ? 'write' : names.some(n => n.startsWith('tn_')) ? 'triage' : 'fetch'
        w.requests.push({ turn: w.asked, stage, names, text: JSON.stringify(req.input) })
        if (stage === 'contradiction') return { answers: Object.fromEntries(names.map(n => [n, { type: 'predicate', probability: ctP }])), model: 'syn', usage: { inputTokens: 1 }, latencyMs: 1 }
        if (stage === 'conflict') return { answers: { cf_differs: { type: 'predicate', probability: conflictP } }, model: 'syn', usage: { inputTokens: 1 }, latencyMs: 1 }
        if (stage === 'write' && holdWrite && w.gate && !w.gated) { w.gated = true; await w.gate.promise }
        if (stage !== 'context') return judge.decide(req)
        const answers = {}
        for (const q of req.questions) answers[q.name] = q.type !== 'choice' ? { type: 'predicate', probability: 0.02 }
          : q.name.startsWith('speech_') ? { type: 'choice', choice: q.choices[0].value, confidence: 0.3, probabilities: q.choices.map((c, i) => ({ value: c.value, probability: i === 0 ? 0.3 : 0.7 / (q.choices.length - 1) })) }
          : { type: 'choice', choice: q.name === 'time_intent' ? 'present' : 'answer', confidence: 0.95, probabilities: [{ value: q.name === 'time_intent' ? 'present' : 'answer', probability: 0.95 }] }
        return { answers, model: 'syn', usage: { inputTokens: 1 }, latencyMs: 1 }
      } },
      collect: async ({ body, context, memoryEvidenceFor, speech }) => (await collectDecisionCandidates({ body, clientThreadId: context.clientThreadId, excludeMessageId: context.localMessageId, chatStore: w.store, memoryEvidenceFor, speech })).candidates,
      turnMemory: { ...config, get ontologyWrite() { return config.ontologyWrite }, clock: w.clock } } })
  chat.setConnection(true); w.chat = chat
  w.scope = () => ({ ownerKey: OWNER, agentId: AGENT, clientThreadId: DM })
  const completed = () => w.store.listMessages(DM).messages.filter(m => m.role === 'assistant' && m.status === 'complete').length
  w.ask = async message => {
    w.asked = (w.asked ?? 0) + 1
    const r = await chat.send({ message, clientThreadId: DM, requestId: `r${w.asked}`, ...(w.cid ? { conversationId: w.cid } : {}), profileId: AGENT, replyDestination: 'direct' }); w.cid ||= r.conversationId
    await until(() => completed() >= w.asked, `answer ${w.asked} completed`); await w.clock.settle(); await chat.turnMemoryIdle(); await w.clock.settle()
    return [...chat.runs.values()].at(-1)
  }
  w.memory = i => w.starts[i]?.additionalContext?.[TURN_MEMORY_KEY]?.value ?? ''
  w.readings = async () => { try { return JSON.parse(await readFile(path.join(dir, 'settings', 'egdesk-wiki-writes.json'), 'utf8')).readings.map(r => [r.pageId, r.reading.status, r.reading.state]) } catch { return [] } }
  w.page = async () => { const wiki = await config.wiki({ body: { message: 'x' }, context: { clientThreadId: DM }, sources: {} }); return wiki.pages.get('ontology:plan') }
  w.memos = async () => { try { return JSON.parse(await readFile(path.join(dir, 'settings', 'egdesk-wiki-writes.json'), 'utf8')).pages.map(x => x.id) } catch { return [] } }
  w.speechIds = () => { try { return (w.evidence.recentSpeech(w.scope(), w.evidence.speechGrant(w.scope())) ?? []).map(r => r.localMessageId) } catch { return [] } }
  w.lastUserId = () => w.store.listMessages(DM).messages.filter(m => m.role === 'user').at(-1)?.localMessageId ?? null
  w.confirmOf = run => chat.turnMemoryTurns.get(run)?.confirm ?? null
  w.rows = run => run.activities.filter(a => a.detail?.confirmation).map(a => [a.title, a.detail.confirmation, a.detail.status])
  w.close = () => { w.store.close(); w.evidence.close() }
  // a first question that brings the plan page into the conversation (before consent), the report that gets noted, and a follow-up whose
  // reply states the note
  w.open = async () => {
    await w.ask('PostgreSQL 마이그레이션 배포 계획 알려줘')
    if (consent) assert.ok(w.evidence.enableSpeech(w.scope()))
  }
  return w
}

test('unit: the settled text states what was kept, what was confirmed, and a conflict; nothing to state gives null', () => {
  assert.equal(settledRecordText({}), null); assert.equal(settledRecordText({ write: { kind: 'bogus' } }), null)
  const kept = settledRecordText({ write: { kind: 'pending_reading', title: '배포 계획', status: 'done', recordStatus: 'unknown' } })
  assert.ok(kept.startsWith(SETTLED_HEAD) && kept.includes('kept as an unconfirmed report on the record "배포 계획": reported as done') && kept.includes('still reads not decided'))
  assert.ok(kept.includes('Do not ask the person to confirm it') && kept.includes('never call a report confirmed'))
  const conflict = settledRecordText({ write: { kind: 'pending_reading', title: '배포 계획', status: 'done', recordStatus: 'plan', recordSlice: 'planned', conflict: true } })
  assert.ok(conflict.includes('differ: the record reads planned (not done yet) (planned), the person reports it as done') && conflict.includes('the record as it is, the message as a report that is not confirmed'))
  assert.ok(settledRecordText({ write: { kind: 'correction', title: 'X', status: 'superseded', recordStatus: 'plan' } }).includes('reported as outdated'))
  assert.ok(settledRecordText({ write: { kind: 'new_record' } }).includes('new record that is not confirmed')); assert.ok(settledRecordText({ write: { kind: 'not_recorded' } }).includes('Nothing from this message is recorded'))
  const confirmed = settledRecordText({ confirmations: [{ title: 'A', action: 'promoted', status: 'done' }, { title: 'B', action: 'withdrawn', status: 'plan' }] })
  assert.ok(confirmed.includes('has just confirmed "A": the record now reads done') && confirmed.includes('refused the note on "B"'))
})

test('unit: the conflict judge asks one yes/no question over one pair, never throws, and an unreachable judge marks no conflict', async () => {
  const seen = []
  const client = p => ({ decide: async req => { seen.push(req); if (p === 'throw') throw Object.assign(new Error('x'), { code: 'down' }); return { answers: { cf_differs: { type: 'predicate', probability: p } }, usage: { inputTokens: 1 } } } })
  const page = { title: '배포 계획', status: 'plan', time: { slice: 'planned' }, body: '12월 첫째 주에 배포한다.' }
  const yes = await judgeRecordConflict({ message: '배포 끝났어', page, client: client(0.97), askedAt: 1_800_000_000_000 })
  assert.deepEqual([yes.status, yes.conflict.state], ['ready', 'yes']); assert.equal(seen[0].questions.length, 1); assert.equal(seen[0].questions[0].name, 'cf_differs')
  assert.ok(JSON.stringify(seen[0].input).includes('12월 첫째 주에 배포한다.') && JSON.stringify(seen[0].input).includes('배포 끝났어'))
  assert.equal((await judgeRecordConflict({ message: '배포는 언제야', page, client: client(0.03) })).conflict.state, 'no'); assert.equal((await judgeRecordConflict({ message: 'x', page, client: client(0.5) })).conflict.state, 'unknown')
  assert.deepEqual((await judgeRecordConflict({ message: '배포 끝났어', page, client: client('throw') })).conflict, { state: 'unknown', p: null }); assert.equal((await judgeRecordConflict({ message: '', page, client: client(0.9) })).status, 'fallback')
})

test('flag off (default): the engine gets today\'s recording rule, the reading is stored only after the answer, the words do not follow the record', async () => {
  const w = await world({ writeFirst: false }); await w.open()
  await w.ask(DONE)
  assert.equal(settledOf(w, 1), RECORDING_RULE, 'decided after your reply'); assert.ok(!settledOf(w, 1).includes(SETTLED_HEAD))
  assert.deepEqual(w.atStart[1], [], 'nothing was stored when the engine started')
  assert.deepEqual(await w.readings(), [['ontology:plan', 'done', 'pending']], 'stored after the answer, as before')
  assert.equal(w.requests.filter(r => r.stage === 'conflict').length, 0)
  assert.equal(w.starts.at(-1) && w.chat.turnMemoryWriteReceipts.get([...w.chat.runs.values()].at(-1)).writeFirst, undefined)
  w.close()
})

test('flag on: the pending reading is stored BEFORE the engine starts, the engine is told the settled state, its words follow it, the write is not asked twice', async () => {
  const w = await world(); await w.open()
  const run = await w.ask(DONE)
  assert.deepEqual(w.atStart[1], [['ontology:plan', 'done', 'pending']], 'the record was judged and stored when the engine started')
  const text = settledOf(w, 1)
  assert.ok(text.startsWith(SETTLED_HEAD) && text.includes('kept as an unconfirmed report on the record "PostgreSQL 마이그레이션 배포 계획": reported as done'), text)
  assert.ok(!text.includes('EG-Desk, not you, decides after your reply'), 'the old rule is replaced, not added to')
  const reply = w.store.listMessages(DM).messages.filter(m => m.role === 'assistant').at(-1)
  assert.ok(reply.text?.includes('확인 전인 보고') ?? JSON.stringify(reply).includes('확인 전인 보고'), 'the (stand-in) engine worded it as the record is')
  assert.equal(w.requests.filter(r => r.stage === 'write' && r.names.includes('tw_status')).length, 1, 'one write judgment, at the start; the write after the answer reuses it')
  assert.deepEqual(await w.readings(), [['ontology:plan', 'done', 'pending']], 'not stored twice')
  assert.equal((await w.page()).status, 'unknown', 'a reading never sets the status')
  const receipt = w.chat.turnMemoryWriteReceipts.get(run)
  assert.deepEqual([receipt.applied, receipt.writeFirst.settled, receipt.writeFirst.inTime, receipt.writeFirst.sent, receipt.writeFirst.kind], ['recorded_pending', true, true, true, 'pending_reading'])
  assert.ok(Number.isFinite(receipt.writeFirst.ms))
  // the draft check's evidence says the same, so a truthful sentence is not flagged
  const evidence = w.chat.turnMemoryDraftEvidence(w.chat.turnMemoryTurns.get(run), true, w.cid).find(e => e.id === 'record-state')
  assert.ok(evidence.text.includes('settled before the reply') && evidence.text.includes('unconfirmed report'))
  w.close()
})

test('flag on: "응 맞아" right after the statement confirms it (no extra turn is needed to state the note), with the person as the authority', async () => {
  const w = await world(); await w.open()
  await w.ask(DONE)
  const run = await w.ask('응 맞아.')
  assert.deepEqual(w.confirmOf(run).actions.map(a => [a.action, a.reason]), [['promoted', 'confirmed']])
  assert.deepEqual(await w.readings(), [['ontology:plan', 'done', 'pending'], ['ontology:plan', 'done', 'accepted']])
  assert.equal((await w.page()).status, 'done')
  // the engine was told the confirmation as a settled state of this turn
  assert.ok(settledOf(w, 2).includes('has just confirmed "PostgreSQL 마이그레이션 배포 계획": the record now reads done'), settledOf(w, 2))
  w.close()
})

test('flag on: a message that differs from the record is marked as a conflict (both kept: the record as it is, the message as an unconfirmed report); a message that does not differ is not', async () => {
  const yes = await world({ conflictP: 0.97 }); await yes.open()
  const run = await yes.ask(DONE)
  assert.equal(yes.requests.filter(r => r.stage === 'conflict').length, 1); assert.ok(yes.requests.find(r => r.stage === 'conflict').text.includes('12월 첫째 주에 전환 배포할 예정이다'), 'the pair: the record and the message')
  assert.ok(settledOf(yes, 1).includes('differ: the record reads') && settledOf(yes, 1).includes('Both are kept'), settledOf(yes, 1))
  assert.equal(yes.chat.turnMemoryWriteReceipts.get(run).writeFirst.conflict, 'yes'); assert.deepEqual(await yes.readings(), [['ontology:plan', 'done', 'pending']]); assert.equal((await yes.page()).status, 'unknown')
  const no = await world({ conflictP: 0.02 }); await no.open()
  const run2 = await no.ask(DONE)
  assert.ok(!settledOf(no, 1).includes('differ:') && settledOf(no, 1).includes('kept as an unconfirmed report'))
  assert.equal(no.chat.turnMemoryWriteReceipts.get(run2).writeFirst.conflict, 'no')
  for (const w of [yes, no]) w.close()
})

test('flag on, budget: a write judgment that is not ready within the loop\'s cap does not hold the turn: it goes on with today\'s rule, and the write is stored after the answer, once', async () => {
  const w = await world({ holdWrite: true }); await w.open()
  w.gate = deferred()
  const asked = w.ask(DONE)
  await until(() => w.requests.some(r => r.stage === 'write'), 'the write judgment started'); await w.clock.settle()
  await w.clock.advance(2600) // the warm cap (2.5 s) passes with the write still out
  await until(() => w.starts.length === 2 && w.speechAtStart.length === 2, 'the turn went on without waiting'); assert.equal(settledOf(w, 1), RECORDING_RULE, 'today\'s rule, not a settled state')
  assert.deepEqual(w.atStart[1], [], 'nothing stored when the engine started')
  w.gate.resolve(); const run = await asked
  assert.deepEqual(await w.readings(), [['ontology:plan', 'done', 'pending']], 'stored after the answer')
  assert.equal(w.requests.filter(r => r.stage === 'write' && r.names.includes('tw_status')).length, 1, 'asked once')
  const wf = w.chat.turnMemoryWriteReceipts.get(run).writeFirst
  assert.deepEqual([wf.settled, wf.inTime, wf.sent], [true, false, false], 'settled late: never told to the engine')
  w.close()
})

test('flag on: a message that is not worth recording gets no settled state (as today no rule); a question about the record states nothing was recorded only where the judgment ran', async () => {
  const w = await world(); await w.open()
  await w.ask('고마워')
  assert.equal(settledOf(w, 1), '', 'nothing to state'); assert.deepEqual(await w.readings(), [])
  w.close()
})

test('flag on without speech consent: a status change is still stored as a pending reading (it needs none); the settled state does not claim a new record', async () => {
  const w = await world({ consent: false }); await w.open()
  await w.ask(DONE)
  assert.deepEqual(w.atStart[1], [['ontology:plan', 'done', 'pending']]); assert.ok(!settledOf(w, 1).includes('new record'))
  w.close()
})

test('read-only callables: the open memory items of a conversation (ids and words only) and what was settled for a turn (no titles, no text); none without the flag', async () => {
  const w = await world(); await w.open()
  assert.deepEqual(w.chat.openMemoryItems(w.cid), [])
  const run = await w.ask(DONE)
  assert.deepEqual(w.chat.openMemoryItems(w.cid), [{ kind: 'memory_confirm', pageId: 'ontology:plan', status: 'done', offers: 1, told: true }])
  const settled = w.chat.memorySettledFor(run)
  assert.deepEqual(settled, { inTime: true, sent: true, write: { kind: 'pending_reading', status: 'done', recordStatus: 'unknown', recordSlice: 'planned', conflict: false }, confirmations: [], contradictions: 0 })
  assert.ok(!JSON.stringify(settled).includes('PostgreSQL')); assert.ok(Object.isFrozen(settled) && Object.isFrozen(w.chat.openMemoryItems(w.cid)))
  await w.ask('응 맞아.'); assert.deepEqual(w.chat.openMemoryItems(w.cid), [], 'confirmed: no longer open')
  assert.equal(w.chat.memorySettledFor({}), null); assert.deepEqual(w.chat.openMemoryItems(null), [])
  const off = await world({ writeFirst: false }); await off.open(); const run2 = await off.ask(DONE)
  assert.equal(off.chat.memorySettledFor(run2), null)
  for (const x of [w, off]) x.close()
})

// ---- c39: new page at the start of the turn; contradictions of the picked set ----
const WS_NODES = [{ id: 'ws-a', label: '사내 워크숍 일정', body: '사내 워크숍은 12월 5일 금요일로 확정됐다.', timeSlice: 'future' }, { id: 'ws-b', label: '워크숍 날짜 메모', body: '사내 워크숍은 12월 12일 금요일로 잡혀 있다.', timeSlice: 'future' }]
const WS = { snapshots: [], edges: [], nodes: WS_NODES }
const WS_LINKED = { snapshots: [], edges: [{ id: 'e1', source: 'ws-b', target: 'ws-a', relation: 'supersedes' }], nodes: WS_NODES }
const NEWFACT = '다음 달에 재고 실사 할 거야'
const wsAsk = w => w.ask('사내 워크숍 언제야?')

test('unit: contradiction pairs are code-built: only unlinked, not outdated, at most 4 records and 6 pairs; one request with one question per pair quoting its own two', () => {
  const page = (id, extra = {}) => ({ id, title: `기록 ${id}`, status: 'unknown', time: { slice: 'future' }, body: `내용 ${id}`, ...extra })
  const pages = ['a', 'b', 'c', 'd', 'e'].map(id => page(id))
  assert.equal(contradictionPairs(pages).length, CONTRADICTION_LIMITS.maxPairs); assert.ok(contradictionPairs(pages).every(({ a, b }) => ['a', 'b', 'c', 'd'].includes(a.id) && ['a', 'b', 'c', 'd'].includes(b.id)), 'the first four only')
  assert.deepEqual(contradictionPairs([page('a'), page('b')], { linked: (x, y) => x.id === 'a' && y.id === 'b' }), [], 'a link in either direction means the pair is not asked')
  assert.deepEqual(contradictionPairs([page('a'), page('b')], { linked: (x, y) => x.id === 'b' && y.id === 'a' }), [])
  assert.deepEqual(contradictionPairs([page('a'), page('b', { status: 'superseded' })]), [], 'an outdated record is not a contradiction'); assert.deepEqual(contradictionPairs([page('a')]), []); assert.deepEqual(contradictionPairs([page('a'), page('b', { body: ' ' })]), []); assert.deepEqual(contradictionPairs(null), [])
  const pairs = contradictionPairs(pages.slice(0, 3)), request = contradictionRequest(pairs, 1_800_000_000_000)
  assert.deepEqual(request.questions.map(q => q.name), ['ct_0', 'ct_1', 'ct_2']); assert.ok(request.questions.every(q => q.type === 'predicate'))
  const text = JSON.stringify(request.input); assert.equal(text.split('R1 | ').length - 1, 1, 'each record is shown once'); assert.ok(request.questions[0].instructions?.includes('R1') || JSON.stringify(request.questions[0]).includes('R2'))
})

test('unit: the contradiction judge asks ONE request for all pairs, marks only decided yes, never throws, and a failed request marks nothing', async () => {
  const page = (id, body) => ({ id, title: `기록 ${id}`, status: 'unknown', time: { slice: 'future' }, body })
  const pairs = contradictionPairs([page('a', '12월 5일'), page('b', '12월 12일'), page('c', '다른 일')])
  const seen = [], client = answers => ({ decide: async req => { seen.push(req); if (answers === 'throw') throw Object.assign(new Error('x'), { code: 'down' }); return { answers, usage: { inputTokens: 1 } } } })
  const yes = await judgeContradictions({ pairs, client: { decide: async req => { seen.push(req); return { answers: { ct_0: { type: 'predicate', probability: 0.97 }, ct_1: { type: 'predicate', probability: 0.03 }, ct_2: { type: 'predicate', probability: 0.5 } } } } } })
  assert.equal(seen.length, 1); assert.deepEqual([yes.status, yes.judged, yes.contradictions.map(c => [c.a.id, c.b.id])], ['ready', 3, [['a', 'b']]], 'a no and an undecided mark nothing')
  assert.deepEqual((await judgeContradictions({ pairs, client: client('throw') })).contradictions, []); assert.equal((await judgeContradictions({ pairs: [], client: client({}) })).status, 'none'); assert.equal((await judgeContradictions({ pairs, client: null })).status, 'none')
  assert.ok(settledRecordText({ contradictions: [{ a: { title: 'A', status: 'done', slice: 'future' }, b: { title: 'B', status: 'plan', slice: 'future' } }] }).includes('contradict each other and nothing links them: "A (done (carried out or settled), future)" and "B (planned (not done yet), future)"'))
  const only = settledRecordText({ contradictions: [{ a: { title: 'A', status: 'unknown' }, b: { title: 'B', status: 'unknown' } }] })
  assert.ok(only.includes('do not decide which of them is right') && !only.includes('Let your words follow this state'), 'no write: no "what was kept" instruction')
})

test('flag on: a statement that is a NEW record is decided at the start of the turn and stored when the turn is accepted, before the engine replies, with the person\'s utterance record; nothing is stored twice after the answer', async () => {
  const w = await world(); await w.open()
  const run = await w.ask(NEWFACT)
  assert.deepEqual(w.memoAtStart[1], [], 'not at the start: the person\'s message is only in the chat store once the turn was accepted')
  assert.equal(w.memoAtReply[1].length, 1, 'the page existed when the engine replied'); assert.ok(w.speechAtReply[1].includes(w.lastUserId()), 'with the utterance record it points at'); assert.equal(w.speechIds().filter(id => id === w.lastUserId()).length, 1, 'recorded once')
  assert.ok(settledOf(w, 1).includes('kept as a new record that is not confirmed'), settledOf(w, 1)); assert.ok(!settledOf(w, 1).includes('decides after your reply'))
  assert.deepEqual(await w.memos(), w.memoAtReply[1], 'no second page after the answer')
  const receipt = w.chat.turnMemoryWriteReceipts.get(run)
  assert.deepEqual([receipt.applied, receipt.writeFirst.stored, receipt.writeFirst.kind, receipt.writeFirst.inTime, receipt.writeFirst.sent], ['stored', 'stored', 'new_record', true, true])
  assert.equal(w.requests.filter(r => r.stage === 'write' && r.names.includes('tw_status')).length, 1, 'one write judgment')
  // a later turn sees the stored page as a record of this DM (the person may read what they said)
  assert.ok((await w.memos())[0].startsWith('memo/'))
  w.close()
})

test('flag on: without the speech consent a new record is not stored (as before) and the engine is told nothing was recorded; flag off: stored only after the answer', async () => {
  const w = await world({ consent: false }); await w.open()
  await w.ask(NEWFACT)
  assert.deepEqual(w.memoAtReply[1], []); assert.deepEqual(await w.memos(), [], 'no consent, no page'); assert.ok(settledOf(w, 1).includes('Nothing from this message is recorded'), settledOf(w, 1))
  const off = await world({ writeFirst: false }); await off.open()
  await off.ask(NEWFACT)
  assert.deepEqual(off.memoAtReply[1], [], 'flag off: not stored when the engine replies'); assert.equal((await off.memos()).length, 1, 'stored after the answer, as before'); assert.equal(off.speechIds().filter(id => id === off.lastUserId()).length, 1)
  for (const x of [w, off]) x.close()
})

test('flag on, budget: a new record whose judgment is not ready within the cap is stored after the answer exactly as without the flag, once, with one utterance record', async () => {
  const w = await world({ holdWrite: true }); await w.open()
  w.gate = deferred()
  const asked = w.ask(NEWFACT)
  await until(() => w.requests.some(r => r.stage === 'write'), 'the write judgment started'); await w.clock.settle()
  await w.clock.advance(2600)
  await until(() => w.starts.length === 2 && w.speechAtStart.length === 2, 'the turn went on without waiting'); assert.equal(settledOf(w, 1), RECORDING_RULE); assert.deepEqual(w.memoAtStart[1], [])
  w.gate.resolve(); await asked
  assert.deepEqual(w.memoAtReply[1], [], 'not stored before the reply: not settled in time'); assert.equal((await w.memos()).length, 1, 'stored once'); assert.equal(w.speechIds().filter(id => id === w.lastUserId()).length, 1)
  w.close()
})

test('flag on: a correction stores the pending "outdated" reading AND its follow-up page at the start of the turn: the reading at once, the page when the turn is accepted (inside the budget)', async () => {
  const w = await world(); await w.open()
  const run = await w.ask('아니, PostgreSQL 마이그레이션 배포 계획은 12월 셋째 주로 바뀌었어')
  assert.deepEqual(w.atStart[1], [['ontology:plan', 'superseded', 'pending']], 'the reading was stored when the engine started'); assert.deepEqual(w.memoAtStart[1], []); assert.equal(w.memoAtReply[1].length, 1, 'and the page with the new detail before the reply')
  const receipt = w.chat.turnMemoryWriteReceipts.get(run)
  assert.deepEqual([receipt.applied, receipt.followUp, receipt.writeFirst.kind], ['recorded_pending', 'stored', 'correction']); assert.ok(settledOf(w, 1).includes('reported as outdated'))
  assert.equal((await w.memos()).length, 1, 'the follow-up is stored once'); assert.equal(w.requests.filter(r => r.stage === 'conflict').length, 0, 'a correction is a conflict by definition: not asked')
  w.close()
})

test('flag on: two unlinked records of the picked set that disagree are stated to the engine as contradicting; the request is one, beside the write judgment, and nothing is stored or marked', async () => {
  const w = await world({ graph: WS }); await w.open()
  const run = await wsAsk(w)
  const asked = w.requests.filter(r => r.stage === 'contradiction')
  assert.equal(asked.length, 1); assert.deepEqual(asked[0].names, ['ct_0']); assert.ok(asked[0].text.includes('12월 5일') && asked[0].text.includes('12월 12일'), 'the pair is quoted')
  assert.ok(settledOf(w, 1).includes('Two stored records contradict each other and nothing links them') && settledOf(w, 1).includes('do not decide which of them is right'), settledOf(w, 1))
  const receipt = w.chat.turnMemoryWriteReceipts.get(run)
  assert.deepEqual([receipt.writeFirst.contradictions.status, receipt.writeFirst.contradictions.judged, receipt.writeFirst.contradictions.found, receipt.writeFirst.sent], ['ready', 1, 1, true])
  assert.deepEqual(await w.readings(), []); assert.deepEqual(await w.memos(), [], 'nothing stored for it')
  assert.deepEqual(w.chat.memorySettledFor(run), { inTime: true, sent: true, write: null, confirmations: [], contradictions: 1 })
  w.close()
})

test('flag on: the contradiction check is not asked for a linked pair, is not stated when the judge says no, is not asked with one picked record, and not at all without the flag', async () => {
  const linked = await world({ graph: WS_LINKED }); await linked.open(); await wsAsk(linked)
  assert.equal(linked.requests.filter(r => r.stage === 'contradiction').length, 0, 'a supersedes link already says how they relate'); assert.ok(!settledOf(linked, 1).includes('contradict'))
  const no = await world({ graph: WS, ctP: 0.02 }); await no.open(); await wsAsk(no)
  assert.equal(no.requests.filter(r => r.stage === 'contradiction').length, 1); assert.equal(settledOf(no, 1), '', 'no decided yes: nothing to state')
  const one = await world(); await one.open(); await one.ask('PostgreSQL 마이그레이션 배포 계획 다시 알려줘')
  assert.equal(one.requests.filter(r => r.stage === 'contradiction').length, 0)
  const off = await world({ graph: WS, writeFirst: false }); await off.open(); await wsAsk(off)
  assert.equal(off.requests.filter(r => r.stage === 'contradiction').length, 0); assert.ok(!settledOf(off, 1).includes('contradict'))
  for (const x of [linked, no, one, off]) x.close()
})

test('flag on, budget: a contradiction check that is not back within the cap does not hold the turn (the turn goes on with today\'s rule)', async () => {
  const w = await world({ graph: WS }); await w.open()
  const gate = deferred(), inner = w.chat.decisionContext.client.decide.bind(w.chat.decisionContext.client)
  w.chat.decisionContext.client.decide = async req => (req.questions.some(q => q.name.startsWith('ct_')) ? (await gate.promise, inner(req)) : inner(req))
  const asked = wsAsk(w)
  await until(() => w.starts.length === 1 && false || w.requests.length > 3, 'the loop ran'); await w.clock.settle(); await w.clock.advance(2600)
  await until(() => w.starts.length === 2, 'the turn went on'); assert.ok(!settledOf(w, 1).includes('contradict'), settledOf(w, 1))
  gate.resolve(); await asked
  w.close()
})
