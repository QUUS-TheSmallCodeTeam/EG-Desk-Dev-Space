import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, chmodSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { CodexChatRuntime } from './codex-chat-runtime.mjs'
import { openChatStore } from './egdesk-chat-store.mjs'
import { openCalibrationLog } from './egdesk-decision-calibration-log.mjs'
import { FLOW_COPY, FLOW_LIMITS } from './egdesk-conversation-flow.mjs'
import { HEARTBEAT_LIMITS } from './egdesk-heartbeat.mjs'
import { feedBrowserTask } from './egdesk-heartbeat-providers.mjs'
import { createBrowserTaskStore, createDirectBrowserEntry } from './egdesk-browser-task.mjs'

// The live-session heartbeat inside the real runtime, over a mock engine and a mock decision model, on a virtual clock:
// virtual monotonic time and virtual timers drive the beats; nothing touches the network or a Codex binary.
const A = 'first-agent'
const MID = '이 부분은 시간이 좀 걸립니다. 계속 확인하고 있어요.'
const SLOW = '응답이 평소보다 늦어지고 있어요. 조금 더 기다리시거나 중지하고 다시 요청하셔도 됩니다.'

// The mock decision model's policy for the flow question, from the facts it is given (numbers and closed labels).
function judge(request, seen) {
  const answers = {}
  for (const q of request.questions) {
    if (q.name === 'intermediate_message') {
      const values = q.choices.map(c => c.value), text = request.input[1].content
      const num = name => Number(new RegExp(`${name}: (\\d+)`).exec(text)?.[1] ?? 0)
      const pick = values.includes('stalled') ? 'stalled' : values.includes('ask_missing') ? 'ask_missing'
        : values.includes('explain_wait') && num('tool_steps_done') + num('tool_steps_running') > 0 ? 'explain_wait' : 'none'
      seen.push({ offered: values, pick, facts: text })
      answers[q.name] = { type: 'choice', choice: pick, confidence: 0.95, probabilities: [{ value: pick, probability: 0.96 }, { value: values.find(v => v !== pick), probability: 0.02 }] }
    } else if (q.type === 'choice') answers[q.name] = { type: 'choice', choice: /^claim_/.test(q.name) ? 'supported' : q.choices[0].value, confidence: 0.95, probabilities: [{ value: /^claim_/.test(q.name) ? 'supported' : q.choices[0].value, probability: 0.96 }, { value: 'insufficient', probability: 0.02 }] }
    else answers[q.name] = { type: 'predicate', probability: 0.03 }
  }
  return { answers, model: 'mock', usage: { inputTokens: 5 }, latencyMs: 3 }
}

function world(t, { flags = { held: true, flow: true }, fork = 'ok', failTurn = false } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'egd-beat-')); chmodSync(dir, 0o700)
  const store = openChatStore({ dataDir: dir, ownerScope: 'synthetic-beat' })
  const log = openCalibrationLog({ dataDir: dir, log() {} })
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }) })
  let clock = 9_000_000, threads = 0, forks = 0, turns = 0
  const timers = [], events = [], native = [], flowAsked = [], requests = { flow: 0, draft: 0, other: 0 }, forkPrompts = []
  const client = { model: 'mock', async decide(request) {
    if (request.promptCacheKey === 'conversation-flow') requests.flow++
    else if (request.promptCacheKey === 'draft-check') requests.draft++
    else requests.other++
    return judge(request, flowAsked)
  } }
  const chat = new CodexChatRuntime({
    store, requireStore: true, getOwnerKey: () => 'test-account', now: () => clock, monotonicNow: () => clock,
    setTimer: (fn, ms) => { const timer = { fn, at: clock + ms }; timers.push(timer); return timer },
    clearTimer: timer => { const i = timers.indexOf(timer); if (i >= 0) timers.splice(i, 1) },
    getBoardPeerContract: () => 'c'.repeat(64),
    profiles: { runProfile: profileId => ({ binding: { profileId, revision: 1, hash: `h-${profileId}` }, developerInstructions: `Agent ${profileId}` }) },
    resolveProjectWorkspace: async () => null, respond() {}, emit: e => events.push(e), emitLegacy() {}, verifyFile: async () => null,
    request: async (method, params) => {
      native.push([method, params])
      if (method === 'thread/start') return { thread: { id: `native-${++threads}` } }
      if (method === 'thread/resume') return { thread: { id: params.threadId, turns: [] } }
      if (method === 'thread/unsubscribe') return { status: 'unsubscribed' }
      if (method === 'thread/fork') { if (fork === 'hang') return new Promise(() => {}); return { thread: { id: `fork-${++forks}`, forkedFromId: params.threadId } } }
      if (method === 'turn/start' && String(params.threadId).startsWith('fork-')) {
        const prompt = params.input[0].text
        forkPrompts.push(prompt)
        const text = /unusually long/.test(prompt) ? SLOW : MID
        setTimeout(async () => {
          const n = (m, p) => chat.handleNotification({ method: m, params: p })
          await n('item/completed', { threadId: params.threadId, turnId: 'ft', item: { id: 'f1', type: 'agentMessage', phase: 'final_answer', text } })
          await n('turn/completed', { threadId: params.threadId, turn: { id: 'ft', status: 'completed', items: [] } })
        }, 1)
        return { turn: { id: 'ft', status: 'inProgress', items: [] } }
      }
      if (method === 'turn/start') { if (failTurn) throw Object.assign(new Error('refused'), { code: -32000 }); return { turn: { id: `turn-${++turns}`, status: 'inProgress', items: [] } } }
      if (method === 'turn/interrupt') return {}
      assert.fail(`Unexpected native call: ${method}`)
    },
    decisionContext: { mode: () => 'on', configured: () => true, client, budgetMs: 800, calibrationLog: log, collect: async () => [],
      draftCheck: flags.held ? { mode: () => 'on' } : undefined, conversationFlow: flags.flow ? { mode: () => 'on' } : undefined },
  })
  chat.setConnection(true)
  const n = (m, p) => chat.handleNotification({ method: m, params: p })
  // Settle without waiting on jobs that wait for virtual time (a hung fork waits for its virtual deadline).
  const settle = async () => {
    let quiet = 0, last = -1
    for (let i = 0; i < 80 && quiet < 5; i++) {
      await new Promise(r => setTimeout(r, 2))
      const mark = native.length + events.length + requests.flow + requests.draft + requests.other
      quiet = mark === last ? quiet + 1 : 0; last = mark
    }
  }
  const w = { chat, store, log, events, native, requests, flowAsked, forkPrompts, timers, at: () => clock - 9_000_000, settle,
    async advance(ms) {
      const end = clock + ms
      for (;;) {
        timers.sort((a, b) => a.at - b.at)
        const next = timers[0]
        if (!next || next.at > end) break
        timers.shift(); clock = next.at; next.fn(); await settle()
      }
      clock = end; await settle()
    },
    async dm(name, message = '상태를 알려 주세요') {
      const r = await chat.send({ clientThreadId: name, profileId: A, replyDestination: 'direct', message, requestId: `req-${name}` })
      const timing = { threadId: r.conversationId, turnId: r.runId }
      const beats = []
      const hb = chat.heartbeatFor(name)
      hb?.subscribe(beat => beats.push({ at: w.at(), beat: beat.beat, phase: beat.facts.phase, sinceUserMs: beat.facts.sinceUserMs, sinceEngineMs: beat.facts.sinceEngineMs, sources: beat.facts.sources }))
      return { name, r, hb, beats, timing,
        tool: (id, status) => n(status === 'started' ? 'item/started' : 'item/completed', { ...timing, item: { id, type: 'commandExecution', command: 'ls', cwd: '/work', status: status === 'started' ? 'inProgress' : 'completed', commandActions: [], aggregatedOutput: '', ...(status === 'started' ? {} : { exitCode: 0 }) } }),
        note: async (id, text) => { await n('item/started', { ...timing, item: { id, type: 'agentMessage', phase: 'commentary', text: '' } }); await n('item/completed', { ...timing, item: { id, type: 'agentMessage', phase: 'commentary', text } }) },
        async final(text, status = 'completed') {
          if (text != null) await n('item/completed', { ...timing, item: { id: `ans-${name}`, type: 'agentMessage', phase: 'final_answer', text } })
          await n('turn/completed', { threadId: timing.threadId, turn: { id: timing.turnId, status, items: [] } })
          await settle(); await chat.draftCheckIdle(); await settle()
        },
        history: () => store.listMessages(name).messages.map(m => [m.role, m.text]),
        assistant: () => store.listMessages(name).messages.filter(m => m.role === 'assistant').map(m => m.text),
      }
    },
    flowEntries: () => log.entries().filter(e => e.feature === 'conversation_flow'),
  }
  return w
}

test('40 s multi-step run: 8 beats, 2 decision requests, one wait message, then the final answer; every asked beat is recorded without content', async t => {
  const w = world(t), d = await w.dm('dm-long')
  assert.equal(d.hb.state, 'running')
  let at = 0
  for (const [id, when] of [['s1', 8000], ['s2', 18000], ['s3', 28000]]) { await w.advance(when - at); at = when; await d.tool(id, 'started'); await w.advance(2000); at += 2000; await d.tool(id, 'completed') }
  await w.advance(40000 - at)
  assert.equal(d.hb.beats, 8); assert.deepEqual(d.beats.map(b => b.at), [5000, 10000, 15000, 20000, 25000, 30000, 35000, 40000])
  await d.final('작업을 마쳤습니다. 결과는 세 단계로 정리했습니다.')
  assert.deepEqual(d.history(), [['user', '상태를 알려 주세요'], ['assistant', MID], ['assistant', '작업을 마쳤습니다. 결과는 세 단계로 정리했습니다.']])
  assert.equal(w.requests.flow, 2)
  assert.deepEqual(w.flowAsked.map(a => [a.offered, a.pick]), [[['none', 'explain_wait'], 'explain_wait'], [['none', 'milestone'], 'none']])
  assert.match(w.flowAsked[0].facts, /current_phase: tool_running/); assert.match(w.flowAsked[0].facts, /seconds_since_the_person_wrote: 10\n/)
  assert.ok(!w.flowAsked.some(a => /ls|상태를/.test(a.facts)), 'numbers and closed labels only')
  const entries = w.flowEntries()
  assert.deepEqual(entries.map(e => [e.flow, e.posted, e.beat.n, e.beat.phase, e.beat.sinceUserS, e.attached]), [['explain_wait', 'model', 2, 'tool_running', 10, true], ['none', 'none', 8, 'thinking', 40, false]])
  assert.equal(entries[1].beat.sincePostedS, 30)
  assert.ok(!JSON.stringify(entries).includes('시간이'), 'no message text in the record')
  assert.deepEqual([d.hb.state, d.hb.stopReason, w.chat.heartbeatFor('dm-long'), w.chat.heartbeats.size, w.timers.length], ['stopped', 'run_end', null, 0, 0])
  t.diagnostic(`40 s run: beats=${d.hb.beats} flowRequests=${w.requests.flow} draftChecks=${w.requests.draft} messages=${d.assistant().length} (1 intermediate + final) forkTurns=${w.forkPrompts.length}`)
})

test('engine silent for 25 s: the heartbeat still beats, the stall is offered at the 25 s beat, and the fixed line is posted when the engine cannot write', async t => {
  const w = world(t, { fork: 'hang' }), d = await w.dm('dm-silent')
  await w.advance(1000); await d.note('n1', '자료를 확인하는 중입니다.') // the last engine event, at 1 s
  await w.advance(23000) // 24 s
  assert.equal(d.hb.beats, 4); assert.deepEqual(d.assistant(), [])
  assert.deepEqual(w.flowAsked.map(a => [a.offered, a.pick]), [[['none', 'explain_wait'], 'none']], 'at 20 s a wait message is possible; with no step running the model declines')
  await w.advance(1000) // the 25 s beat: 24 s without an engine event
  assert.deepEqual(w.flowAsked.at(-1).offered, ['none', 'explain_wait', 'stalled']); assert.equal(w.flowAsked.at(-1).pick, 'stalled')
  assert.match(w.flowAsked.at(-1).facts, /seconds_since_anything_came_from_the_work: 24$/m); assert.match(w.flowAsked.at(-1).facts, /current_phase: thinking/)
  assert.deepEqual(d.assistant(), [], 'the writer is given its 6 s first')
  await w.advance(FLOW_LIMITS.stalledWriterMs - 1); assert.deepEqual(d.assistant(), [])
  await w.advance(1)
  assert.deepEqual(d.assistant(), [FLOW_COPY.stalled]); assert.equal(w.at(), 31000)
  await w.advance(29000) // 60 s: still silent
  assert.equal(d.hb.beats, 12); assert.equal(w.requests.flow, 2); assert.deepEqual(d.assistant(), [FLOW_COPY.stalled], 'said once')
  assert.equal(d.beats.at(-1).sinceEngineMs, 59000)
  await w.advance(2000); await d.final('늦어서 죄송합니다. 확인을 마쳤습니다.')
  assert.deepEqual(d.history().map(r => r[0]), ['user', 'assistant', 'assistant'])
  assert.deepEqual(d.assistant(), [FLOW_COPY.stalled, '늦어서 죄송합니다. 확인을 마쳤습니다.'])
  const entry = w.flowEntries().at(-1)
  assert.deepEqual([entry.flow, entry.posted, entry.beat.n, entry.beat.phase, entry.beat.sinceEngineS], ['stalled', 'fallback', 5, 'thinking', 24])
  assert.equal(d.hb.stopReason, 'run_end'); assert.equal(w.timers.length, 0)
  t.diagnostic(`silent engine: beats=${d.hb.beats} flowRequests=${w.requests.flow} messages=${d.assistant().length} (fixed line at 31 s + final)`)
})

test('engine silent but the fork still answers: the subjective model writes the stall message itself', async t => {
  const w = world(t), d = await w.dm('dm-silent-2')
  await w.advance(25000)
  assert.deepEqual(d.assistant(), [SLOW]); assert.equal(w.flowEntries().at(-1).posted, 'model')
  assert.match(w.forkPrompts.at(-1), /without claiming progress/)
  await w.advance(35000)
  assert.deepEqual(d.assistant(), [SLOW]); assert.ok(w.requests.flow <= FLOW_LIMITS.maxEvals)
  await d.final('확인을 마쳤습니다.')
})

test('browser task waiting on the person: the heartbeat beats and reports it, and nothing is asked or sent while the person is awaited', async t => {
  const w = world(t), d = await w.dm('dm-browser')
  // The browser task loop feeds the conversation's heartbeat through the registration API (read-only).
  const feed = feedBrowserTask(w.chat.heartbeatFor('dm-browser'), createBrowserTaskStore())
  const segments = [{ outcome: 'max_steps', steps: [{ actions: [] }, { actions: [] }, { actions: [] }], state: { at: 1 } }, { outcome: 'needs_user_context', steps: [{ actions: [] }], candidates: [] }]
  let call = 0
  const client = { async decide(request) { const q = request.questions[0], value = q.choices[0].value
    return { answers: { [q.name]: { type: 'choice', choice: value, confidence: 0.95, probabilities: [{ value, probability: 0.96 }, { value: q.choices[1].value, probability: 0.02 }] } } } } }
  const entry = createDirectBrowserEntry({ store: feed.store, provider: { directEntryEnabled: () => true, reflexScope: () => ({ client, authorizeDispatch: () => true, isDecisionCurrent: () => true }), runDirectTask: async () => segments[call++] } })
  const out = await entry.handle({ run: { runId: 'pre', browserBinding: { cards: [{ cardId: 'card', permission: 'interact' }] } }, conversationKey: 'dm-browser', message: '세금계산서 내려받아줘', hosts: { card: 'portal.example.test' } })
  assert.equal(out.status, 'paused')
  await w.advance(40000)
  assert.equal(d.hb.beats, 8)
  assert.deepEqual([...new Set(d.beats.map(b => b.phase))], ['waiting_user'])
  assert.deepEqual(d.beats[0].sources.browser_task, { active: true, phase: 'waiting_user', waitingOnUser: true, stepsDone: 4, stepBudgetLeft: 20, task: 'need_context' })
  assert.equal(w.requests.flow, 0); assert.deepEqual(d.assistant(), [])
  // The same 40 s without the waiting task: the wait message becomes possible at 20 s and the model is asked.
  const plain = world(t), p = await plain.dm('dm-plain')
  await plain.advance(40000)
  assert.ok(plain.requests.flow >= 1); assert.equal(p.beats[0].phase, 'thinking')
  await d.final('어느 사업자의 세금계산서인지 알려 주세요.'); await p.final('끝났습니다.')
  t.diagnostic(`browser task waiting: beats=${d.hb.beats} flowRequests=${w.requests.flow} messages=0 while waiting (contrast without the task: flowRequests=${plain.requests.flow})`)
})

test('quick 3 s answer: no beat, no decision request, no timer left', async t => {
  const w = world(t), d = await w.dm('dm-quick')
  await w.advance(3000); await d.final('네, 알겠습니다.')
  assert.deepEqual([d.hb.beats, w.requests.flow, d.hb.stopReason, w.timers.length], [0, 0, 'run_end', 0])
  assert.deepEqual(d.assistant(), ['네, 알겠습니다.'])
})

test('two runs in different DMs at once: independent heartbeats on their own counters, each message in its own DM', async t => {
  const w = world(t)
  const a = await w.dm('dm-a', 'A 작업')
  await w.advance(2000); await a.tool('a1', 'started')
  await w.advance(5000) // 7 s
  const b = await w.dm('dm-b', 'B 작업')
  await w.advance(1000); await b.tool('b1', 'started')
  await w.advance(22000) // 30 s
  assert.deepEqual(a.beats.map(x => x.at), [5000, 10000, 15000, 20000, 25000, 30000])
  assert.deepEqual(b.beats.map(x => x.at), [12000, 17000, 22000, 27000], 'B beats 5 s after ITS message, not on A\'s grid')
  assert.deepEqual(b.beats.map(x => x.sinceUserMs), [5000, 10000, 15000, 20000])
  assert.deepEqual(a.assistant(), [MID]); assert.deepEqual(b.assistant(), [MID]); assert.equal(w.requests.flow, 2)
  assert.deepEqual(w.flowEntries().map(e => [e.beat.n, e.beat.sinceUserS]), [[2, 10], [2, 10]])
  assert.equal(w.chat.heartbeats.size, 2)
  await w.advance(1000); await a.final('A 끝났습니다.')
  assert.deepEqual([a.hb.state, b.hb.state, w.chat.heartbeats.size], ['stopped', 'running', 1])
  await w.advance(11000) // 42 s
  assert.equal(a.beats.length, 6); assert.deepEqual(b.beats.map(x => x.at).slice(4), [32000, 37000, 42000])
  await b.final('B 끝났습니다.')
  assert.deepEqual(a.history(), [['user', 'A 작업'], ['assistant', MID], ['assistant', 'A 끝났습니다.']])
  assert.deepEqual(b.history(), [['user', 'B 작업'], ['assistant', MID], ['assistant', 'B 끝났습니다.']])
  assert.deepEqual([w.chat.heartbeats.size, w.timers.length], [0, 0])
  t.diagnostic(`two DMs: beats A=${a.beats.length} B=${b.beats.length} flowRequests=${w.requests.flow} messages A=${a.assistant().length} B=${b.assistant().length}`)
})

test('lifecycle in the runtime: cancel, disconnect, a lost process and a refused turn stop the heartbeat with their reason; a second message leaves a live one alone', async t => {
  const cancelled = world(t), c = await cancelled.dm('dm-cancel')
  await cancelled.advance(6000); await c.final(null, 'interrupted')
  assert.deepEqual([c.hb.state, c.hb.stopReason, c.hb.beats, cancelled.timers.length], ['stopped', 'cancel', 1, 0])
  const lost = world(t), l = await lost.dm('dm-lost')
  await lost.advance(6000); lost.chat.setConnection(false)
  assert.deepEqual([l.hb.state, l.hb.stopReason], ['stopped', 'disconnect'])
  await lost.advance(30000); assert.equal(l.hb.beats, 1, 'no beat after the connection is gone')
  const gone = world(t), g = await gone.dm('dm-gone')
  gone.chat.setConnection(false, { processLost: true })
  assert.deepEqual([g.hb.state, g.hb.stopReason, gone.chat.heartbeats.size], ['stopped', 'restart', 0])
  // A second message while the run is live is refused as before and leaves the live heartbeat alone.
  const busy = world(t), b = await busy.dm('dm-busy')
  await busy.advance(6000)
  await assert.rejects(busy.chat.send({ clientThreadId: 'dm-busy', profileId: A, replyDestination: 'direct', conversationId: b.r.conversationId, message: '하나 더', requestId: 'req-2' }), { code: 'RUN_IN_PROGRESS' })
  assert.deepEqual([busy.chat.heartbeatFor('dm-busy') === b.hb, b.hb.state, b.hb.beats], [true, 'running', 1])
  await b.final('끝.')
  const refused = world(t, { failTurn: true })
  await assert.rejects(refused.chat.send({ clientThreadId: 'dm-refused', profileId: A, replyDestination: 'direct', message: 'x', requestId: 'r1' }))
  assert.deepEqual([refused.chat.heartbeats.size, refused.timers.length], [0, 0])
})

test('flag off: no heartbeat exists and no timer is created; heartbeat without the held-answer mode beats but never asks', async t => {
  const off = world(t, { flags: { held: true, flow: false } }), o = await off.dm('dm-off')
  assert.equal(o.hb, null); assert.equal(off.chat.heartbeats.size, 0); assert.equal(off.timers.length, 0)
  await off.advance(30000); assert.equal(off.requests.flow, 0); await o.final('끝.')
  const mute = world(t, { flags: { held: false, flow: true } }), m = await mute.dm('dm-mute')
  await mute.advance(2000); await m.tool('t1', 'started'); await mute.advance(28000)
  assert.equal(m.hb.beats, 6); assert.equal(mute.requests.flow, 0); assert.deepEqual(m.assistant(), [])
  assert.equal(m.beats.at(-1).phase, 'tool_running')
  assert.equal(HEARTBEAT_LIMITS.beatMs, 5000)
})
