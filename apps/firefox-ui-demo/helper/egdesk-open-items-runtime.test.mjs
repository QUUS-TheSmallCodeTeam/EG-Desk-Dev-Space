import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { chmod, mkdtemp } from 'node:fs/promises'
import { CodexChatRuntime, TURN_MEMORY_KEY } from './codex-chat-runtime.mjs'
import { openChatStore } from './egdesk-chat-store.mjs'
import { openCalibrationLog } from './egdesk-decision-calibration-log.mjs'
import { SYNTHETIC_PAGES, createFakeClock, mockJudge, until } from './egdesk-wiki-reconstruction.fixture.mjs'
import { buildWiki } from './egdesk-wiki-reconstruction.mjs'
import { createWikiWriter } from './egdesk-turn-memory.mjs'
import { OPEN_ITEMS_KEY, registerOpenItemProvider } from './egdesk-open-items.mjs'

// L1 c32: the open-item resolver through the REAL runtime (send, startTurn, store, run) with a synthetic engine, a stub of the command-approval broker and a scripted Decision client.
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



// The Decision stand-in: the loop's own questions go to the repo's lexical judge; the resolver's oi_ref_<n> questions are answered by `ref(message, n, summary)`.
function scripted(ref, log = []) {
  const judge = mockJudge()
  return { async decide(req) {
    if (!req.questions.some(q => q.name.startsWith('oi_'))) return judge.decide(req)
    log.push(req.questions.map(q => ({ name: q.name, text: q.instructions })))
    return { answers: Object.fromEntries(req.questions.map(q => [q.name, { type: 'predicate', probability: q.name.startsWith('oi_ref_') ? ref(q.instructions, Number(q.name.slice(7))) : 0.02 }])), usage: { inputTokens: 1 } }
  } }
}
// A stub of the command-approval broker: one command waits; readReply is the existing judgment (counted).
function brokerStub({ waiting = false } = {}) {
  const b = { waiting, reads: [], awaitingReply: () => b.waiting, awaitingAsk: () => (b.waiting ? { command: 'git push --force origin main', reasons: ['remote_irreversible'] } : null),
    readReply: async ({ reply }) => { b.reads.push(reply); b.waiting = false; return { approved: /해|응|네/.test(reply), read: true } } }
  return b
}
const on = async (x, broker) => { x.chat.decisionContext.openItems = true; if (broker) x.chat.gateHookBroker = () => broker }
const WAIT = 'git push --force origin main'
const first = async (x, broker) => { await x.send('안녕, 폴더 정리 좀 해 줄래', 'r0'); await x.done(1); if (broker) broker.waiting = true } // the command starts waiting after turn 1
const block = x => x.starts.at(-1)?.additionalContext?.[OPEN_ITEMS_KEY]?.value ?? null
const ocalls = log => log.filter(l => l.length).length

test('flag off: nothing is resolved, the waiting command\'s reply is read as before, the engine gets no open-items entry', async () => {
  const log = [], broker = brokerStub()
  const x = await rig({ memoryMode: null, client: scripted(() => 0.99, log) })
  x.chat.gateHookBroker = () => broker
  await first(x, broker); await x.send('그냥 해', 'r1'); await x.done(2)
  assert.equal(log.length, 0); assert.equal(broker.reads.length, 1); assert.equal(block(x), null); assert.equal(x.chat.openItemRecord('r1'), null)
  x.store.close()
})

test('flag on, a message that settles the waiting command: the resolver picks it, the existing reply judgment runs for it, the engine is told the settled state', async () => {
  const log = [], broker = brokerStub()
  const x = await rig({ memoryMode: null, client: scripted(() => 0.97, log) }); await on(x, broker)
  await first(x, broker); await x.send('그냥 해', 'r1'); await x.done(2)
  assert.equal(log.length, 1, 'one Decision request for the referent')
  assert.equal(log[0].length, 1); assert.match(log[0][0].text, /git push --force origin main/); assert.match(log[0][0].text, /그냥 해/)
  assert.deepEqual(broker.reads, ['그냥 해'], 'the approval words judgment of the existing path ran once, for this item')
  const record = x.chat.openItemRecord('r1')
  assert.deepEqual([record.status, record.kind, record.id, record.calls, record.today], ['settled', 'approval', 'oi1', 1, 'new_turn'])
  assert.deepEqual(record.states, { oi1: 'approved' })
  assert.match(block(x), /oi1 approval: settled by this message, state=approved/); assert.match(block(x), /settles oi1 only/)
  x.store.close()
})

test('a message about something else, an ambiguous reply, or a Decision that is not sure: nothing is settled and the waiting command is NOT consumed', async () => {
  for (const [name, p] of [['unrelated', 0.03], ['ambiguous', 0.6], ['just under the bar', 0.84]]) {
    const broker = brokerStub()
    const x = await rig({ memoryMode: null, client: scripted(() => p) }); await on(x, broker)
    await first(x, broker); await x.send(name === 'unrelated' ? '그건 그렇고 폴더에 뭐 있어?' : '음… 글쎄', 'r1'); await x.done(2)
    assert.equal(broker.reads.length, 0, `${name}: the reply judgment was not run`); assert.equal(broker.waiting, true, `${name}: the command still waits`)
    const record = x.chat.openItemRecord('r1'); assert.deepEqual([record.status, record.reason], ['none', 'no_item_referred'], name)
    assert.match(block(x), /settles none of them; they stay open/); assert.match(block(x), /oi1 approval: still open/)
    assert.equal(x.starts.length, 2, `${name}: the message is an ordinary turn`)
    x.store.close()
  }
  // the same command can still be answered by the next message
  const broker = brokerStub(), answers = ['그건 그렇고 뭐 있어?', '그냥 해']
  const x = await rig({ memoryMode: null, client: scripted(q => (/그냥 해/.test(q) ? 0.97 : 0.03)) }); await on(x, broker)
  await first(x, broker); await x.send(answers[0], 'r1'); await x.done(2); await x.send(answers[1], 'r2'); await x.done(3)
  assert.deepEqual(broker.reads, ['그냥 해'])
  assert.equal(x.chat.openItemRecord('r2').status, 'settled')
  x.store.close()
})

test('a Decision that fails or cannot be read: the path of today (the waiting command\'s reply is read), recorded as none with the reason', async () => {
  for (const [name, client, reason] of [['down', { async decide(req) { if (req.questions.some(q => q.name.startsWith('oi_'))) throw Object.assign(new Error('x'), { code: 'timeout' }); return mockJudge().decide(req) } }, 'timeout'],
    ['silent', { async decide(req) { return req.questions.some(q => q.name.startsWith('oi_')) ? { answers: {} } : mockJudge().decide(req) } }, 'unanswered']]) {
    const broker = brokerStub()
    const x = await rig({ memoryMode: null, client }); await on(x, broker)
    await first(x, broker); await x.send('그냥 해', 'r1'); await x.done(2)
    assert.deepEqual(broker.reads, ['그냥 해'], name); assert.equal(x.chat.openItemRecord('r1').reason, reason, name)
    x.store.close()
  }
})

test('nothing open: no Decision request at all; two items both referred to: nothing settled; a registered provider\'s item is settled and applied for itself only', async () => {
  const log = []
  const idle = await rig({ memoryMode: null, client: scripted(() => 0.99, log) }); await on(idle)
  await first(idle); await idle.send('그냥 해', 'r1'); await idle.done(2)
  assert.equal(log.length, 0); assert.equal(idle.chat.openItemRecord('r1'), null); assert.equal(block(idle), null)
  idle.store.close()
  const applied = [], undo = registerOpenItemProvider({ id: 'fake_browser', items: () => [{ id: 'task-1', kind: 'browser_task', summary: 'A browser task waits for the person.', options: [{ id: 'continue' }] }],
    questions: (key, message) => [{ type: 'predicate', name: 'open_browser_continue', instructions: `Message: ${JSON.stringify(message)} Does it tell the task to go on?` }],
    apply: async ctx => { applied.push(ctx.item.itemId); return { handled: true, settled: 'continue', note: 'browser task: continue' } } })
  try {
    const broker = brokerStub()
    const both = await rig({ memoryMode: null, client: scripted(() => 0.95, log) }); await on(both, broker)
    await first(both, broker); await both.send('그냥 해', 'r1'); await both.done(2)
    assert.deepEqual([both.chat.openItemRecord('r1').status, both.chat.openItemRecord('r1').reason], ['none', 'several_items'])
    assert.equal(broker.reads.length, 0); assert.deepEqual(applied, []); both.store.close()
    const oneBroker = brokerStub(), one = await rig({ memoryMode: null, client: scripted((q, n) => (/browser task/.test(q) ? 0.96 : 0.03)) }); await on(one, oneBroker)
    await first(one, oneBroker); await one.send('계속해', 'r1'); await one.done(2)
    const r = one.chat.openItemRecord('r1')
    assert.deepEqual([r.status, r.kind, r.id, r.states.oi2], ['settled', 'browser_task', 'oi2', 'continue']); assert.deepEqual(applied, ['task-1'])
    assert.match(block(one), /oi2 browser_task: settled by this message, state=continue/); assert.match(block(one), /browser task: continue/); assert.match(block(one), /oi1 approval: still open/)
    one.store.close()
  } finally { undo() }
})

test('the memory confirmation is gated by the verdict: skipped when the message belongs to something else, run when it is that item or when nothing was decided', async () => {
  const x = await rig({ memoryMode: null }); await on(x)
  const put = (requestId, verdict) => x.chat.openItemVerdicts.set(requestId, { items: [], verdict, record: { states: {}, items: [] }, note: null })
  put('a', { status: 'settled', item: { kind: 'memory' } }); put('b', { status: 'settled', item: { kind: 'approval' } }); put('c', { status: 'none', reason: 'no_item_referred' })
  put('d', { status: 'none', reason: 'several_items' }); put('e', { status: 'none', reason: 'timeout' }); put('f', { status: 'none', reason: 'unanswered' })
  assert.deepEqual(['a', 'b', 'c', 'd', 'e', 'f', 'zz', undefined].map(id => x.chat.openItemRoute(id, 'memory')), ['apply', 'skip', 'skip', 'skip', 'today', 'today', 'today', 'today'])
  assert.deepEqual(['a', 'b', 'c'].map(id => x.chat.openItemRoute(id, 'approval')), ['skip', 'apply', 'skip'])
  x.store.close()
})

test('the memory item: present while a note the person was told of waits for their confirmation (the runtime\'s own notes, or L7\'s openMemoryItems when it exists); the resolver settles it and the confirmation judgment is the memory loop\'s', async () => {
  const x = await rig({ memoryMode: null }); await on(x)
  const src = () => x.chat.builtinOpenItemSources({ allows: () => true }).find(s => s.id === 'memory')
  assert.deepEqual(src().items({ cid: 't1' }), [], 'nothing waits')
  x.chat.openMemoryItems = cid => (cid === 't1' ? [{ kind: 'memory_confirm', pageId: 'p', status: 'plan' }] : [])
  assert.deepEqual(src().items({ cid: 't1' }).map(i => [i.id, i.kind]), [['memory:t1', 'memory']]); assert.deepEqual(src().items({ cid: 'other' }), [])
  assert.deepEqual(await src().apply({}), { handled: true, settled: 'confirmation_read' })
  x.store.close()
})
