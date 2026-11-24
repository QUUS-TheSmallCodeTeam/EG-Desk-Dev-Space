import test from 'node:test'
import assert from 'node:assert/strict'
import { FLOW_COPY, FLOW_LIMITS } from './egdesk-conversation-flow.mjs'
import { HEARTBEAT_LIMITS } from './egdesk-heartbeat.mjs'
import { feedBrowserTask } from './egdesk-heartbeat-providers.mjs'
import { createBrowserTaskStore, createDirectBrowserEntry } from './egdesk-browser-task.mjs'
import { A, MID, SLOW, world } from './egdesk-heartbeat-flow.fixture.mjs'

// The live-session heartbeat inside the real runtime, over a mock engine and a mock decision model, on a virtual clock
// (egdesk-heartbeat-flow.fixture.mjs): virtual monotonic time and virtual timers drive the beats; no network, no Codex binary.

// After its run the session goes on at the idle tempo and ends by itself: no request while idle, no timer left afterwards.
async function idleOut(w, d) {
  const requests = w.requests.flow, beats = d.hb.beats
  assert.deepEqual([d.hb.state, d.hb.tempo, w.chat.heartbeatFor(d.name) === d.hb], ['running', 'idle', true], 'the run ended; the session goes on at the idle tempo')
  await w.advance(HEARTBEAT_LIMITS.lingerMs)
  assert.deepEqual([d.hb.state, d.hb.stopReason, w.chat.heartbeatFor(d.name), w.requests.flow, d.hb.beats - beats], ['stopped', 'idle', null, requests, HEARTBEAT_LIMITS.lingerMs / HEARTBEAT_LIMITS.idleBeatMs],
    'nothing pending: the idle session ends after the linger time, with no request')
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
  await idleOut(w, d)
  assert.deepEqual([w.chat.heartbeats.size, w.timers.length, w.flowEntries().length], [0, 0, 2], 'idle beats are not asked and not recorded')
  t.diagnostic(`40 s run: beats=${d.hb.beats} flowRequests=${w.requests.flow} draftChecks=${w.requests.draft} messages=${d.assistant().length} (1 intermediate + final) forkTurns=${w.forkPrompts.length}`)
})

test('engine silent for 25 s: the heartbeat still beats, the stall is offered at the 25 s beat, and the fixed line is posted when the engine cannot write', async t => {
  const w = world(t, { fork: 'hang' }), d = await w.dm('dm-silent')
  await w.advance(1000); await d.note('n1', '자료를 확인하는 중입니다.') // the last engine event, at 1 s
  await w.advance(23000) // 24 s
  assert.equal(d.hb.beats, 4); assert.deepEqual(d.assistant(), [])
  // L3 c16: without a tool step, a wait message waits for 30 s while the engine is active, or for the stall bound of silence (20 s):
  // at the 20 s beat the engine had been silent 19 s, so nothing was asked yet.
  assert.deepEqual(w.flowAsked.map(a => [a.offered, a.pick]), [], 'no tool step and the engine silent for less than the stall bound: no request')
  await w.advance(1000) // the 25 s beat: 24 s without an engine event
  assert.deepEqual(w.flowAsked.at(-1).offered, ['none', 'explain_wait', 'stalled']); assert.equal(w.flowAsked.at(-1).pick, 'stalled')
  assert.match(w.flowAsked.at(-1).facts, /seconds_since_anything_came_from_the_work: 24$/m); assert.match(w.flowAsked.at(-1).facts, /current_phase: thinking/)
  assert.deepEqual(d.assistant(), [], 'the writer is given its 6 s first')
  await w.advance(FLOW_LIMITS.stalledWriterMs - 1); assert.deepEqual(d.assistant(), [])
  await w.advance(1)
  assert.deepEqual(d.assistant(), [FLOW_COPY.stalled]); assert.equal(w.at(), 31000)
  await w.advance(29000) // 60 s: still silent
  assert.equal(d.hb.beats, 12); assert.equal(w.requests.flow, 1, 'L3 c16: one request (the 25 s stall beat); the 20 s ask is gone with the no-step floor'); assert.deepEqual(d.assistant(), [FLOW_COPY.stalled], 'said once')
  assert.equal(d.beats.at(-1).sinceEngineMs, 59000)
  await w.advance(2000); await d.final('늦어서 죄송합니다. 확인을 마쳤습니다.')
  assert.deepEqual(d.history().map(r => r[0]), ['user', 'assistant', 'assistant'])
  assert.deepEqual(d.assistant(), [FLOW_COPY.stalled, '늦어서 죄송합니다. 확인을 마쳤습니다.'])
  const entry = w.flowEntries().at(-1)
  assert.deepEqual([entry.flow, entry.posted, entry.beat.n, entry.beat.phase, entry.beat.sinceEngineS], ['stalled', 'fallback', 5, 'thinking', 24])
  await idleOut(w, d); assert.equal(w.timers.length, 0)
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

test('browser task handed off: while the subjective model is still wording the question the heartbeat reports the hand-off and can still speak (a slow turn is explained like any other)', async t => {
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
  assert.deepEqual([...new Set(d.beats.map(b => b.phase))], ['thinking'], 'the person has not been asked yet: this is not waiting_user')
  const row = d.beats[0].sources.browser_task
  assert.deepEqual([row.active, row.phase, row.waitingOnUser, row.stepsDone, row.stepsRemaining, row.task, row.awaiting, row.awaitingCode], [true, 'handing_off', false, 4, 20, 'handing_off', 'need_context', 'choice_needed'])
  assert.ok(w.requests.flow >= 1, 'a 40 s wording turn is not muted')
  assert.ok(w.flowAsked.every(a => !a.offered.includes('ask_missing')), 'nothing here opens an in-run question')
  // The same 40 s without the waiting task: the wait message becomes possible at 20 s and the model is asked.
  const plain = world(t), p = await plain.dm('dm-plain')
  await plain.advance(40000)
  assert.ok(plain.requests.flow >= 1); assert.equal(p.beats[0].phase, 'thinking')
  await d.final('어느 사업자의 세금계산서인지 알려 주세요.'); await p.final('끝났습니다.')
  t.diagnostic(`browser task handed off: beats=${d.hb.beats} flowRequests=${w.requests.flow} messages=${d.assistant().length} before the question (same 40 s without the task: flowRequests=${plain.requests.flow})`)
})

test('quick 3 s answer: no beat, no decision request, no timer left', async t => {
  const w = world(t), d = await w.dm('dm-quick')
  await w.advance(3000); await d.final('네, 알겠습니다.')
  assert.deepEqual([d.hb.beats, w.requests.flow, d.hb.tempo, w.timers.length], [0, 0, 'idle', 1], 'no beat during the run; one timer: the idle beat')
  assert.deepEqual(d.assistant(), ['네, 알겠습니다.'])
  await idleOut(w, d); assert.equal(w.timers.length, 0)
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
  assert.deepEqual([a.hb.tempo, b.hb.tempo, w.chat.heartbeats.size], ['idle', 'active', 2], 'A\'s run ended: its session idles, B\'s is untouched')
  await w.advance(11000) // 42 s
  assert.equal(a.beats.length, 6); assert.deepEqual(b.beats.map(x => x.at).slice(4), [32000, 37000, 42000])
  await b.final('B 끝났습니다.')
  assert.deepEqual(a.history(), [['user', 'A 작업'], ['assistant', MID], ['assistant', 'A 끝났습니다.']])
  assert.deepEqual(b.history(), [['user', 'B 작업'], ['assistant', MID], ['assistant', 'B 끝났습니다.']])
  await w.advance(HEARTBEAT_LIMITS.lingerMs)
  assert.deepEqual([a.hb.stopReason, b.hb.stopReason, w.chat.heartbeats.size, w.timers.length, w.requests.flow], ['idle', 'idle', 0, 0, 2])
  t.diagnostic(`two DMs: beats A=${a.beats.length} B=${b.beats.length} flowRequests=${w.requests.flow} messages A=${a.assistant().length} B=${b.assistant().length}`)
})

test('lifecycle in the runtime: a cancelled run idles the session; disconnect, a lost process and a refused first turn stop the heartbeat with their reason; a second message leaves a live one alone', async t => {
  const cancelled = world(t), c = await cancelled.dm('dm-cancel')
  await cancelled.advance(6000); await c.final(null, 'interrupted')
  assert.deepEqual([c.hb.state, c.hb.tempo, c.hb.beats], ['running', 'idle', 1], 'a cancelled run ends the run, not the session')
  await idleOut(cancelled, c); assert.equal(cancelled.timers.length, 0)
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
  // A lost connection also ends a session that is idle after its run.
  busy.chat.setConnection(false)
  assert.deepEqual([b.hb.state, b.hb.stopReason, busy.chat.heartbeats.size, busy.timers.length], ['stopped', 'disconnect', 0, 0])
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
