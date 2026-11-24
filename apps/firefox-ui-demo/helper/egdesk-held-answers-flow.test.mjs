import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, chmodSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { CodexChatRuntime } from './codex-chat-runtime.mjs'
import { openChatStore } from './egdesk-chat-store.mjs'
import { openCalibrationLog } from './egdesk-decision-calibration-log.mjs'

// Held, completed answers and human-like intermediate messages, end to end over a mock engine (no network, no Codex binary).
// Virtual clock and timers drive the long runs; fork turns (draft revision, intermediate writer) are answered by scripted text.
const DM = 'local-dm', A = 'first-agent'
const PLAN = { id: 'doc:pg', kind: 'document', title: 'PostgreSQL 이전 계획', summary: '다음 분기에 전환 예정', timeSlice: 'planned', loadText: () => 'body' }

function judge(request) {
  const answers = {}
  for (const q of request.questions) {
    if (q.name === 'intermediate_message') {
      const values = q.choices.map(c => c.value)
      const pick = values.includes('ask_missing') ? 'ask_missing' : values.includes('explain_wait') ? 'explain_wait' : 'none'
      answers[q.name] = { type: 'choice', choice: pick, confidence: 0.95, probabilities: [{ value: pick, probability: 0.96 }, { value: values.find(v => v !== pick), probability: 0.02 }] }
    } else if (q.name === 'answer_type' || q.name === 'time_intent') answers[q.name] = { type: 'choice', choice: q.choices[0].value, confidence: 0.9, probabilities: [{ value: q.choices[0].value, probability: 0.9 }] }
    else if (/^claim_/.test(q.name)) answers[q.name] = { type: 'choice', choice: 'supported', confidence: 0.95, probabilities: [{ value: 'supported', probability: 0.96 }, { value: 'insufficient', probability: 0.02 }] }
    else if (/^present_/.test(q.name)) answers[q.name] = { type: 'predicate', probability: /현재 운영 중/.test(JSON.stringify(request.input)) ? 0.93 : 0.03 }
    else answers[q.name] = { type: 'predicate', probability: q.name === 'rel_0' ? 0.95 : 0.04 }
  }
  return { answers, model: 'mock', usage: { inputTokens: 5 }, latencyMs: 3 }
}

function world(t, { flags = { held: true, flow: true }, candidates = [], writer = {}, revision = null, steerOk = true, forkOk = true } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'egd-held-')); chmodSync(dir, 0o700)
  const store = openChatStore({ dataDir: dir, ownerScope: 'synthetic-held' })
  const log = openCalibrationLog({ dataDir: dir, log() {} })
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }) })
  let clock = 1_000_000, timerId = 0, threads = 0, forks = 0, turns = 0
  const timers = [], events = [], native = [], requests = { flow: 0, draft: 0, context: 0 }, steers = [], forkTexts = []
  const state = { usedReply: null }
  const client = { model: 'mock', async decide(request) {
    if (request.promptCacheKey === 'conversation-flow') requests.flow++
    else if (request.promptCacheKey === 'draft-check') requests.draft++
    else requests.context++
    return judge(request)
  } }
  const chat = new CodexChatRuntime({
    store, requireStore: true, getOwnerKey: () => 'test-account', now: () => clock, monotonicNow: () => clock, // the heartbeat's counter follows the virtual clock
    setTimer: (fn, ms) => { const timer = { id: ++timerId, fn, at: clock + ms }; timers.push(timer); return timer },
    clearTimer: timer => { const i = timers.indexOf(timer); if (i >= 0) timers.splice(i, 1) },
    getBoardPeerContract: () => (steerOk ? 'c'.repeat(64) : null),
    profiles: { runProfile: profileId => ({ binding: { profileId, revision: 1, hash: `h-${profileId}` }, developerInstructions: `Agent ${profileId}` }) },
    resolveProjectWorkspace: async () => null, respond() {}, emit: e => events.push(e), emitLegacy() {}, verifyFile: async () => null,
    request: async (method, params) => {
      native.push([method, params])
      if (method === 'thread/start') return { thread: { id: `native-${++threads}` } }
      if (method === 'thread/resume') return { thread: { id: params.threadId, turns: [] } }
      if (method === 'thread/unsubscribe') return { status: 'unsubscribed' }
      if (method === 'thread/fork') { if (!forkOk) throw Object.assign(new Error('no fork'), { code: -32601 }); return { thread: { id: `fork-${++forks}`, forkedFromId: params.threadId } } }
      if (method === 'turn/steer') { steers.push(params); state.usedReply = params.input[0].text; return { turnId: params.expectedTurnId } }
      if (method === 'turn/start' && String(params.threadId).startsWith('fork-')) {
        const prompt = params.input[0].text
        forkTexts.push(prompt)
        const text = /Here is your draft answer/.test(prompt) ? revision : /ask the person|need one piece of information/.test(prompt) ? writer.ask : writer.explain
        setTimeout(async () => {
          const n = (m, p) => chat.handleNotification({ method: m, params: p })
          const timing = { threadId: params.threadId, turnId: `fturn-${forks}` }
          if (text != null) await n('item/completed', { ...timing, item: { id: 'f1', type: 'agentMessage', phase: 'final_answer', text } })
          await n('turn/completed', { threadId: params.threadId, turn: { id: timing.turnId, status: text == null ? 'failed' : 'completed', items: [] } })
        }, 1)
        return { turn: { id: `fturn-${forks}`, status: 'inProgress', items: [] } }
      }
      if (method === 'turn/start') return { turn: { id: `turn-${++turns}`, status: 'inProgress', items: [] } }
      if (method === 'turn/interrupt') return {}
      assert.fail(`Unexpected native call: ${method}`)
    },
    decisionContext: { mode: () => 'on', configured: () => true, client, budgetMs: 800, calibrationLog: log, collect: async () => candidates,
      draftCheck: flags.held ? { mode: () => 'on' } : undefined, conversationFlow: flags.flow ? { mode: () => 'on' } : undefined },
  })
  chat.setConnection(true)
  const n = (m, p) => chat.handleNotification({ method: m, params: p })
  const settleAll = async () => { for (let i = 0; i < 12; i++) { await chat.flowIdle(); await chat.draftCheckIdle(); await new Promise(r => setTimeout(r, 3)) } }
  const w = { chat, store, log, events, native, requests, steers, forkTexts, state, now: () => clock, settleAll,
    async send(message = 'PostgreSQL 마이그레이션 상태는?', requestId = 'req-1') {
      const r = await chat.send({ clientThreadId: DM, profileId: A, replyDestination: 'direct', message, requestId })
      w.r = r; w.timing = { threadId: r.conversationId, turnId: r.runId }
      return r
    },
    async advance(ms) {
      const end = clock + ms
      for (;;) {
        timers.sort((a, b) => a.at - b.at)
        const next = timers[0]
        if (!next || next.at > end) break
        timers.shift(); clock = Math.max(clock, next.at); next.fn(); await settleAll()
      }
      clock = end; await settleAll()
    },
    tool: async (id, status) => n(status === 'started' ? 'item/started' : 'item/completed', { ...w.timing, item: { id, type: 'commandExecution', command: 'ls', cwd: '/work', status: status === 'started' ? 'inProgress' : 'completed', commandActions: [], aggregatedOutput: '', ...(status === 'started' ? {} : { exitCode: 0 }) } }),
    note: async (id, text) => { await n('item/started', { ...w.timing, item: { id, type: 'agentMessage', phase: 'commentary', text: '' } }); await n('item/completed', { ...w.timing, item: { id, type: 'agentMessage', phase: 'commentary', text } }) },
    async final(text) {
      await n('item/started', { ...w.timing, item: { id: 'ans', type: 'agentMessage', phase: 'final_answer', text: '' } })
      await n('item/agentMessage/delta', { ...w.timing, itemId: 'ans', delta: text })
      await n('item/completed', { ...w.timing, item: { id: 'ans', type: 'agentMessage', phase: 'final_answer', text } })
      await n('turn/completed', { threadId: w.timing.threadId, turn: { id: w.timing.turnId, status: 'completed', items: [] } })
      await settleAll()
    },
    chatTexts: () => store.listMessages(DM).messages.map(m => [m.role, m.text]),
    posted: () => events.filter(e => e.event === 'message.completed').map(e => [e.details.role, e.details.text]),
    streamed: () => events.filter(e => e.event === 'message.delta' || e.event === 'message.started').map(e => e.event),
  }
  return w
}
const summary = w => `history=${JSON.stringify(w.chatTexts().map(([r, x]) => `${r}:${x.slice(0, 18)}`))} decisions(flow=${w.requests.flow} draft=${w.requests.draft} context=${w.requests.context}) forkTurns=${w.forkTexts.length} steers=${w.steers.length} nativeTurnStarts=${w.native.filter(([m, p]) => m === 'turn/start' && !String(p.threadId).startsWith('fork')).length}`
const MID = '이 부분은 시간이 좀 걸립니다. 계속 확인하고 있어요.'
const ASK = '어느 환경에 배포할까요? 운영인지 스테이징인지 알려 주세요.'

test('quick answer (3 s): the answer is held then posted once as a completed message; no intermediate message, no flow request', async t => {
  const w = world(t)
  await w.send(); await w.advance(3000)
  await w.final('네, 알겠습니다. 천천히 하세요.')
  const deltas = w.events.filter(e => e.event === 'message.delta').map(e => e.details?.delta)
  assert.deepEqual(deltas, ['네, 알겠습니다. 천천히 하세요.'], 'the answer arrives whole, in one piece, never as streamed fragments')
  assert.deepEqual(w.posted().filter(([role]) => role === 'assistant'), [['assistant', '네, 알겠습니다. 천천히 하세요.']])
  assert.equal(w.requests.flow, 0); assert.equal(w.forkTexts.length, 0)
  assert.deepEqual(w.chatTexts().map(r => r[0]), ['user', 'assistant'])
  t.diagnostic(`quick 3 s: ${summary(w)}`)
})

test('nothing of the held final answer is visible before it is posted; the working indicator state is the run itself', async t => {
  const w = world(t)
  await w.send(); await w.advance(1000)
  await w.chat.handleNotification({ method: 'item/started', params: { ...w.timing, item: { id: 'ans', type: 'agentMessage', phase: 'final_answer', text: '' } } })
  await w.chat.handleNotification({ method: 'item/agentMessage/delta', params: { ...w.timing, itemId: 'ans', delta: '부분 답변' } })
  await w.chat.handleNotification({ method: 'item/completed', params: { ...w.timing, item: { id: 'ans', type: 'agentMessage', phase: 'final_answer', text: '완성된 답변입니다.' } } })
  await w.settleAll()
  assert.deepEqual(w.posted().filter(([r]) => r === 'assistant'), [], 'completed item is held until the turn ends')
  assert.ok(!JSON.stringify(w.events).includes('부분 답변') && !JSON.stringify(w.events).includes('완성된 답변'))
  const run = w.chat.snapshot().runs[0]
  assert.equal(run.status, 'inProgress'); assert.deepEqual(run.messages.filter(m => m.role === 'assistant'), [])
  await w.chat.handleNotification({ method: 'turn/completed', params: { threadId: w.timing.threadId, turn: { id: w.timing.turnId, status: 'completed', items: [] } } })
  await w.settleAll()
  assert.deepEqual(w.posted().filter(([r]) => r === 'assistant'), [['assistant', '완성된 답변입니다.']])
})

test('held final answer with a draft-check revision: the plan wording is posted, the original never is', async t => {
  const w = world(t, { candidates: [PLAN], revision: 'PostgreSQL 마이그레이션은 아직 계획 단계입니다.', flags: { held: true, flow: false } })
  await w.send(); await w.advance(2000)
  await w.final('PostgreSQL 마이그레이션은 현재 운영 중입니다.')
  assert.deepEqual(w.posted().filter(([r]) => r === 'assistant'), [['assistant', 'PostgreSQL 마이그레이션은 아직 계획 단계입니다.']])
  assert.ok(!JSON.stringify(w.events).includes('현재 운영 중입니다') && !JSON.stringify(w.chatTexts()).includes('현재 운영 중입니다'))
  assert.equal(w.requests.draft, 2, 'check and one re-check'); assert.equal(w.forkTexts.length, 1)
  assert.match(w.forkTexts[0], /Do not mention this check/)
  assert.equal(w.native.filter(([m]) => m === 'thread/fork').length, 1)
  t.diagnostic(`held final with revision: ${summary(w)}`)
  const entry = w.log.entries().find(e => e.feature === 'draft_check' && e.mode === 'on')
  assert.ok(entry && entry.attached === true)
})

test('a failed or unavailable revision fork posts the original (certain part only is for the check, never silence)', async t => {
  const failing = world(t, { candidates: [PLAN], revision: null, flags: { held: true, flow: false } })
  await failing.send(); await failing.final('PostgreSQL 마이그레이션은 현재 운영 중입니다.')
  assert.equal(failing.posted().filter(([r]) => r === 'assistant').length, 1)
  const none = world(t, { candidates: [PLAN], forkOk: false, flags: { held: true, flow: false } })
  await none.send(); await none.final('PostgreSQL 마이그레이션은 현재 운영 중입니다.')
  assert.equal(none.posted().filter(([r]) => r === 'assistant').length, 1)
})

test('a long multi-step run (40 s): one wait-explaining message, then the final answer; ordering and counts', async t => {
  const w = world(t, { writer: { explain: MID } })
  await w.send()
  const steps = [['s1', 8000], ['s2', 18000], ['s3', 28000]]
  let at = 0
  for (const [id, when] of steps) { await w.advance(when - at); at = when; await w.tool(id, 'started'); await w.advance(2000); at += 2000; await w.tool(id, 'completed') }
  await w.advance(40000 - at)
  await w.final('작업을 마쳤습니다. 결과는 세 단계로 정리했습니다.')
  const assistant = w.posted().filter(([r]) => r === 'assistant')
  assert.deepEqual(assistant, [['assistant', MID], ['assistant', '작업을 마쳤습니다. 결과는 세 단계로 정리했습니다.']])
  assert.deepEqual(w.chatTexts(), [['user', 'PostgreSQL 마이그레이션 상태는?'], ['assistant', MID], ['assistant', '작업을 마쳤습니다. 결과는 세 단계로 정리했습니다.']])
  assert.ok(w.requests.flow >= 1 && w.requests.flow <= 6, `flow requests bounded: ${w.requests.flow}`)
  assert.equal(w.forkTexts.length, 1); assert.match(w.forkTexts[0], /Do not reveal your reasoning/)
  assert.ok(!w.forkTexts[0].includes('ls'), 'tool commands are not given to the writer')
  const flowEntries = w.log.entries().filter(e => e.feature === 'conversation_flow')
  assert.ok(flowEntries.length >= 1 && flowEntries.every(e => e.mode === 'on'))
  t.diagnostic(`long 40 s run: ${summary(w)}`)
})

test('a missing value: early question, the person answers mid-run, the run uses it, final answer', async t => {
  const w = world(t, { writer: { ask: ASK } })
  await w.send('서비스를 배포해 주세요')
  await w.advance(4000)
  await w.note('n1', '배포 환경이 정해져 있지 않네요. 어느 환경에 배포할까요?')
  await w.advance(2000)
  assert.deepEqual(w.posted().filter(([r]) => r === 'assistant'), [['assistant', ASK]])
  assert.equal(w.chat.openEarlyQuestion(DM, w.r.conversationId)?.runId, w.r.runId)
  const reply = await w.chat.send({ clientThreadId: DM, profileId: A, replyDestination: 'direct', conversationId: w.r.conversationId, message: '스테이징이요', requestId: 'req-2' })
  assert.equal(reply.inRun, true); assert.equal(reply.runId, w.r.runId)
  assert.equal(w.steers.length, 1)
  assert.deepEqual([w.steers[0].threadId, w.steers[0].expectedTurnId, w.steers[0].input[0].text], [w.r.conversationId, w.r.runId, '스테이징이요'])
  assert.equal(w.native.filter(([m]) => m === 'turn/start' && !String(m).startsWith('fork')).filter(([, p]) => !String(p.threadId).startsWith('fork')).length, 1, 'no second turn on the conversation')
  assert.equal(w.chat.openEarlyQuestion(DM, w.r.conversationId), null, 'one reply per question; a second message waits for the turn like any other')
  await w.advance(3000)
  await w.final(`${w.state.usedReply} 환경에 배포했습니다.`)
  assert.deepEqual(w.chatTexts(), [['user', '서비스를 배포해 주세요'], ['assistant', ASK], ['user', '스테이징이요'], ['assistant', '스테이징이요 환경에 배포했습니다.']])
  assert.equal(w.chat.openEarlyQuestion(DM, w.r.conversationId), null)
  t.diagnostic(`early question: ${summary(w)}`)
})

test('flags off: no hold, no fork, no flow request, native steer never used (today\'s behaviour)', async t => {
  const w = world(t, { flags: { held: false, flow: false } })
  await w.send(); await w.advance(30000)
  await w.final('끝났습니다.')
  assert.equal(w.requests.flow, 0); assert.equal(w.forkTexts.length, 0); assert.equal(w.steers.length, 0)
  assert.ok(w.events.some(e => e.event === 'message.delta' || e.event === 'message.completed'))
})

test('the flow needs the held-answer mode: conversationFlow alone does nothing', async t => {
  const w = world(t, { flags: { held: false, flow: true } })
  await w.send(); await w.advance(30000)
  assert.equal(w.requests.flow, 0)
})
