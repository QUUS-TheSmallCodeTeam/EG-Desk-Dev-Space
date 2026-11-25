import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { chmod, mkdtemp } from 'node:fs/promises'
import { CodexChatRuntime } from './codex-chat-runtime.mjs'
import { openChatStore } from './egdesk-chat-store.mjs'
import { openCalibrationLog } from './egdesk-decision-calibration-log.mjs'
import { SYNTHETIC_PAGES, createFakeClock, mockJudge, until } from './egdesk-wiki-reconstruction.fixture.mjs'
import { buildWiki } from './egdesk-wiki-reconstruction.mjs'
import { createWikiWriter } from './egdesk-turn-memory.mjs'
import { createTurnMemoryConfig, turnMemoryFlagsFromEnv } from './egdesk-turn-memory-wiring.mjs'
import { fastCarryText } from './egdesk-memory-fast-answer.mjs'

// L1 c31: the fast answer from a picked record, through the REAL runtime (send, finish, store, turn memory loop) with a synthetic engine and a
// scripted Decision client. The engine here writes "엔진 답변"; a fast answer is the record's own sentence, so the two are told apart by text.
const quiet = () => {}
const profiles = { runProfile: (p, r) => ({ binding: { profileId: p, revision: r ?? 1, hash: 'h' }, developerInstructions: 'x', toolCeiling: null, model: null }) }
const SCOPE = { allowedScopes: ['dm:this-room'], writeScope: 'dm:this-room' }
const RETENTION = '롤백은 몇 분 안에 하기로 했지?', SENTENCE = '문제가 생기면 SQLite 백업으로 30분 안에 되돌린다.'

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
        await n('item/completed', { ...timing, item: { id: `a${id}`, type: 'agentMessage', phase: 'final_answer', text: '엔진 답변' } })
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


// The Decision stand-in: the loop's own questions go to the repo's lexical judge; the fast answer's fa_* questions are answered by `fa(message, question)`.
function scriptedClient(fa, log = []) {
  const judge = mockJudge()
  return { async decide(req) {
    if (!req.questions.some(q => q.name.startsWith('fa_'))) return judge.decide(req)
    const message = /Message:\n([\s\S]*)$/.exec(req.input.at(-1).content)?.[1]?.trim() ?? ''
    log.push(req.questions.map(q => q.name))
    return { answers: Object.fromEntries(req.questions.map(q => [q.name, { type: 'predicate', probability: fa(message, q.name) }])), usage: { inputTokens: 1 } }
  } }
}
const yesFirst = (message, name) => (name === 'fa_ans_0' ? 0.97 : 0.02)
const texts = x => x.store.listMessages('dm-1').messages.map(m => [m.role, m.status, m.text])
const faCalls = x => x.decides.filter(d => d.names.some(n => n.startsWith('fa_')))

test('flag on: the picked record\'s one answering sentence is posted by code, no turn starts, nothing of the packet is marked as delivered', async () => {
  const x = await rig({ tm: { fastAnswer: true }, client: scriptedClient(yesFirst) })
  const sent = await x.send(RETENTION, 'r1')
  await x.done(1)
  assert.equal(x.starts.length, 0, 'no turn/start reached the engine')
  assert.ok(!x.timeline.includes('turn/start'))
  assert.deepEqual(texts(x), [['user', 'accepted', RETENTION], ['assistant', 'complete', SENTENCE]])
  const run = x.run()
  assert.equal(run.status, 'completed'); assert.match(run.runId, /^egdesk-fast-/); assert.equal(sent.runId, run.runId)
  assert.equal(run.messages.filter(m => m.role === 'assistant').at(-1).text, SENTENCE)
  const record = x.chat.fastAnswerRecord(run)
  assert.deepEqual([record.used, record.reason, record.pageId, record.calls], [true, 'answered', 'db/pg-rollback', 1])
  assert.ok(Number.isFinite(record.ms))
  assert.equal(faCalls(x).length, 1)
  assert.ok(x.decides.findIndex(d => d.names.some(n => n.startsWith('fa_'))) > x.decides.findIndex(d => d.names.some(n => n.startsWith('tn_'))), 'the answer was judged after the loop picked the record')
  assert.equal(x.chat.turnMemoryDelivered.get(x.cid), undefined, 'the engine never held the page: no delivery receipt')
  assert.equal(x.chat.turnMemoryLatest.get(x.cid)?.attached, false)
  assert.deepEqual(x.memoryEntries?.().map(e => e.attached) ?? [], [false])
  x.store.close()
})

test('the engine\'s next turn is told the exchange once, and gets the page again (it never held it)', async () => {
  const x = await rig({ tm: { fastAnswer: true }, client: scriptedClient((message, name) => (message === RETENTION ? (name === 'fa_ans_0' ? 0.97 : 0.02) : name === 'fa_more' ? 0.9 : 0.02)) })
  await x.send(RETENTION, 'r1'); await x.done(1)
  await x.send('롤백 판단은 누가 하는지 정리해서 알려줘', 'r2'); await x.done(2)
  assert.equal(x.starts.length, 1)
  const input = x.starts[0].input
  assert.deepEqual(input.map(i => i.text), [fastCarryText(RETENTION, SENTENCE), '롤백 판단은 누가 하는지 정리해서 알려줘'], 'the carried exchange, then the person\'s message')
  assert.ok(!String(x.packet(0) ?? '').includes('already delivered'), 'nothing is skipped as already delivered: the engine never held the page')
  assert.equal(x.chat.carriedInRun.get('dm-1'), undefined, 'taken once')
  assert.deepEqual(texts(x).map(t => t[2]), [RETENTION, SENTENCE, '롤백 판단은 누가 하는지 정리해서 알려줘', '엔진 답변'])
  x.store.close()
})

test('flag off, and flag on with every doubt: the engine turn is byte-identical to a bridge without the feature', async () => {
  const baseline = await rig({ client: scriptedClient(yesFirst) })
  await baseline.send(RETENTION, 'r1'); await baseline.done(1)
  assert.equal(faCalls(baseline).length, 0, 'flag off: no fast-answer request at all')
  assert.equal(baseline.starts.length, 1)
  assert.deepEqual(texts(baseline).map(t => t[2]), [RETENTION, '엔진 답변'])
  const normalize = text => text.replace(/"(?:clientId|requestId|localMessageId|localRunId|clientUserMessageId)":"[^"]*"/g, '"id":"x"').replace(/Question clock: [^\\]*/g, 'Question clock')
  const doubts = { 'the message needs more': (m, n) => (n === 'fa_more' ? 0.9 : n === 'fa_ans_0' ? 0.97 : 0.02), 'under the bar': (m, n) => (n === 'fa_ans_0' ? 0.85 : 0.02),
    'two candidates': (m, n) => (n.startsWith('fa_ans_') ? 0.97 : 0.02), 'unclear alone': (m, n) => (n === 'fa_ans_0' ? 0.97 : n === 'fa_alone_0' ? 0.9 : 0.02) }
  for (const [name, fa] of Object.entries(doubts)) {
    const x = await rig({ tm: { fastAnswer: true }, client: scriptedClient(fa) })
    await x.send(RETENTION, 'r1'); await x.done(1)
    assert.equal(faCalls(x).length, 1, name)
    assert.equal(normalize(JSON.stringify(x.starts[0])), normalize(JSON.stringify(baseline.starts[0])), `${name}: turn/start is the one the flag-off bridge sends (packet included)`)
    assert.equal(x.chat.fastAnswerRecord(x.run()).used, false, name)
    assert.deepEqual(texts(x).map(t => t[2]), [RETENTION, '엔진 답변'], name)
    assert.equal(x.chat.carriedInRun.size, 0, name)
    x.store.close()
  }
  baseline.store.close()
})

test('a failing or silent Decision request, an unsettled record, advisory memory and a decision mode that is off: the engine, and (code floors) no fast-answer request', async () => {
  const failing = await rig({ tm: { fastAnswer: true }, client: { async decide(req) { if (req.questions.some(q => q.name.startsWith('fa_'))) throw Object.assign(new Error('down'), { code: 'timeout' }); return mockJudge().decide(req) } } })
  await failing.send(RETENTION, 'r1'); await failing.done(1)
  assert.equal(failing.starts.length, 1); assert.equal(failing.chat.fastAnswerRecord(failing.run()).reason, 'timeout')
  const unsettled = await rig({ tm: { fastAnswer: true }, client: scriptedClient(yesFirst) })
  await unsettled.send('A사 견적 v2 팀장 승인 기한이 언제야?', 'r1'); await unsettled.done(1)
  assert.equal(unsettled.starts.length, 1); assert.equal(faCalls(unsettled).length, 0, 'a relayed record and several records are ruled out by code, not asked')
  assert.equal(unsettled.chat.fastAnswerRecord(unsettled.run()).reason, 'too_many_records')
  const advisory = await rig({ memoryMode: 'advisory', tm: { fastAnswer: true }, client: scriptedClient(yesFirst) })
  await advisory.send(RETENTION, 'r1'); await advisory.done(1)
  assert.equal(advisory.starts.length, 1); assert.equal(faCalls(advisory).length, 0); assert.equal(advisory.chat.fastAnswerRecord(advisory.run()), null)
  const noMemory = await rig({ memoryMode: null, client: scriptedClient(yesFirst) })
  await noMemory.send(RETENTION, 'r1'); await noMemory.done(1)
  assert.equal(noMemory.starts.length, 1); assert.equal(faCalls(noMemory).length, 0)
  for (const r of [failing, unsettled, advisory, noMemory]) r.store.close()
})

test('the fast turn is an ordinary completed turn for the app: events, store run, no pending start left behind, a second message can follow at once', async () => {
  const x = await rig({ tm: { fastAnswer: true }, client: scriptedClient(yesFirst) })
  await x.send(RETENTION, 'r1'); await x.done(1)
  assert.deepEqual(x.events.filter(e => /^run\.(started|completed)$/.test(e.event)).map(e => [e.event, e.runId === x.run().runId]), [['run.started', true], ['run.completed', true]])
  assert.equal(x.chat.pendingStarts.size, 0); assert.equal(x.chat.conversationBusy(x.cid), false)
  const runs = x.store.listRuns('dm-1', { afterSeq: 0, limit: 10 }).runs
  assert.equal(runs.length, 1); assert.match(runs[0].runId, /^egdesk-fast-/)
  await x.send(RETENTION, 'r2'); await x.done(2)
  assert.equal(x.starts.length, 0, 'the second recall is answered the same way')
  assert.deepEqual(texts(x).map(t => t[2]), [RETENTION, SENTENCE, RETENTION, SENTENCE])
  x.store.close()
})

test('the flag: EGDESK_TURN_MEMORY_FAST_ANSWER=on only; the config carries it only then, and the rest of the config is what it was', () => {
  assert.deepEqual(turnMemoryFlagsFromEnv({}), {})
  assert.equal(turnMemoryFlagsFromEnv({ EGDESK_TURN_MEMORY_FAST_ANSWER: 'on' }).fastAnswer, true)
  for (const value of ['1', 'true', 'ON', '', 'off']) assert.equal(turnMemoryFlagsFromEnv({ EGDESK_TURN_MEMORY_FAST_ANSWER: value }).fastAnswer, undefined, value)
  assert.deepEqual(turnMemoryFlagsFromEnv({ EGDESK_TURN_MEMORY_ONE_PACKET: 'on', EGDESK_TURN_MEMORY_FAST_ANSWER: 'on' }), { onePacket: true, fastAnswer: true })
  const settings = { turnMemory: { mode: 'on' } }, getAdapter = () => null
  const off = createTurnMemoryConfig({ settings, getAdapter }), on = createTurnMemoryConfig({ settings, getAdapter, fastAnswer: true, onePacket: true })
  assert.equal(Object.hasOwn(off, 'fastAnswer'), false); assert.equal(on.fastAnswer, true); assert.equal(on.onePacket, true); assert.equal(on.mode(), 'on'); assert.equal(on.ontologyWrite, true)
  assert.deepEqual(Object.keys(off).sort(), Object.keys(createTurnMemoryConfig({ settings, getAdapter, fastAnswer: false })).sort())
})
