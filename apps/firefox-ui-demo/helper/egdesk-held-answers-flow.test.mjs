import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, chmodSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { CodexChatRuntime, POSTED_ANSWER_KEY, answerEvidence } from './codex-chat-runtime.mjs'
import { checkDraft } from './egdesk-draft-check.mjs'
import { openChatStore } from './egdesk-chat-store.mjs'
import { openCalibrationLog } from './egdesk-decision-calibration-log.mjs'

// Held, completed answers and human-like intermediate messages, end to end over a mock engine (no network, no Codex binary).
// Virtual clock and timers drive the long runs; fork turns (draft revision, intermediate writer) are answered by scripted text.
const DM = 'local-dm', A = 'first-agent'
const PLAN = { id: 'doc:pg', kind: 'document', title: 'PostgreSQL 이전 계획', summary: '다음 분기에 전환 예정', timeSlice: 'planned', loadText: () => 'body' }

function judge(request) {
  const answers = {}
  for (const q of request.questions) {
    if (/^message__/.test(q.name)) {
      // The heartbeat's yes/no message questions: a question to the person when one is asked about, else a progress note.
      const names = request.questions.map(row => row.name)
      const explained = /\(a note that this takes a while\)/.test(JSON.stringify(request.input)) // then the note question stands for a milestone: declined, as before
      const pick = names.includes('message__ask') ? 'message__ask' : names.includes('message__note') && !explained ? 'message__note' : null
      answers[q.name] = { type: 'predicate', probability: q.name === pick ? 0.97 : 0.03 }
    } else if (q.name === 'answer_type' || q.name === 'time_intent') answers[q.name] = { type: 'choice', choice: q.choices[0].value, confidence: 0.9, probabilities: [{ value: q.choices[0].value, probability: 0.9 }] }
    else if (/^claim_/.test(q.name)) answers[q.name] = { type: 'choice', choice: 'supported', confidence: 0.95, probabilities: [{ value: 'supported', probability: 0.96 }, { value: 'insufficient', probability: 0.02 }] }
    else if (/^(present|tense)_/.test(q.name)) answers[q.name] = { type: 'predicate', probability: /현재 운영 중/.test(JSON.stringify(request.input)) ? 0.93 : 0.03 }
    else if (/^sup_/.test(q.name)) answers[q.name] = { type: 'predicate', probability: 0.96 } // the predicate design (default): supported
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
    if (request.promptCacheKey === 'heartbeat-beat') requests.flow++
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
  // c19 (no fixed fallback): with the rewrite unavailable and nothing left after removing the failing sentence, the check posts no
  // sentence of its own; the draft goes as written, as on any failure of the check (P2), and the record says revision_unavailable.
  assert.deepEqual(failing.posted().filter(([r]) => r === 'assistant'), [['assistant', 'PostgreSQL 마이그레이션은 현재 운영 중입니다.']])
  assert.equal(failing.log.entries().filter(e => e.feature === 'draft_check').at(-1).fallback, 'revision_unavailable')
  const none = world(t, { candidates: [PLAN], forkOk: false, flags: { held: true, flow: false } })
  await none.send(); await none.final('PostgreSQL 마이그레이션은 현재 운영 중입니다.')
  assert.deepEqual(none.posted().filter(([r]) => r === 'assistant'), [['assistant', 'PostgreSQL 마이그레이션은 현재 운영 중입니다.']])
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

// ---- L3 c18: the answer's evidence holds the run's own facts; the next turn is told what the person saw ----

test('an answer after a command is checked against that command\'s facts first (all-on journey s6), ahead of the turn\'s pages and within the 8-item bound', async t => {
  const pages = Array.from({ length: 8 }, (_, i) => ({ ...PLAN, id: `doc:pg-${i}`, title: `PostgreSQL 체크리스트 ${i + 1}` }))
  const w = world(t, { candidates: pages, flags: { held: true, flow: false } })
  const seen = []
  const decide = w.chat.decisionContext.client.decide
  w.chat.decisionContext.client.decide = async request => { if (request.promptCacheKey === 'draft-check') seen.push(request); return decide(request) }
  await w.send('전체 테스트 돌리고 결과 알려줘'); await w.advance(1000)
  const n = (m, p) => w.chat.handleNotification({ method: m, params: p })
  await n('item/started', { ...w.timing, item: { id: 'cmd-1', type: 'commandExecution', command: 'npm test -- --suite=payroll', cwd: '/work', status: 'inProgress', commandActions: [] } })
  await n('item/commandExecution/outputDelta', { ...w.timing, itemId: 'cmd-1', delta: 'running 40 tests\n40 passed, 0 failed\n' })
  await n('item/completed', { ...w.timing, item: { id: 'cmd-1', type: 'commandExecution', command: 'npm test -- --suite=payroll', cwd: '/work', status: 'completed', exitCode: 0, durationMs: 12_000, commandActions: [], aggregatedOutput: 'running 40 tests\n40 passed, 0 failed\n' } })
  await w.final('테스트 40개가 모두 통과했습니다.')
  assert.equal(seen.length, 1)
  const evidence = seen[0].input[1].content
  assert.match(evidence, /^Evidence:\n\[E1 time=present\]\n"""\nIn this turn the assistant ran `npm test -- --suite=payroll`; it finished after about 12 seconds with exit code 0, which means the command itself reported success\. Last lines of its output: running 40 tests 40 passed, 0 failed\n"""/)
  assert.match(evidence, /\[E2 time=planned[^\]]*\]\n"""\nPostgreSQL/, 'the turn\'s page follows')
  // The check keeps 8 items: with 8 pages the command fact still comes first (it used to be cut, being last).
  const turn = { evidence: pages.map(p => ({ id: p.id, kind: 'document', time: 'planned', text: p.title })), memory: [] }
  const facts = [{ id: 'cmd1', kind: 'terminal', time: 'present', text: 'In this turn the assistant ran `npm test`; it finished with exit code 0.' }, { id: 'tool2', kind: 'tool', opaque: true }]
  const ordered = answerEvidence(turn, facts)
  assert.deepEqual(ordered.slice(0, 2).map(item => item.id), ['cmd1', 'doc:pg-0']); assert.equal(ordered.at(-1).id, 'tool2')
  const bound = []
  await checkDraft({ draft: '테스트 40개가 모두 통과했습니다.', evidence: ordered, mode: 'advisory', client: { async decide(request) { bound.push(request); return { answers: {} } } } })
  assert.match(bound[0].input[1].content, /^Evidence:\n\[E1 time=present\]\n"""\nIn this turn the assistant ran `npm test`/); assert.equal((bound[0].input[1].content.match(/\[E\d+ /g) ?? []).length, 7, '8 items kept: the command fact, 6 pages and the content-free reference (not quoted, but it still stops an "unverified")')
  assert.deepEqual(w.posted().filter(([r]) => r === 'assistant'), [['assistant', '테스트 40개가 모두 통과했습니다.']])
})

test('when the check replaces the answer, the next turn of that conversation is told exactly what the person saw, once; an answer posted as written leaves nothing', async t => {
  // c19: the one rewrite says in the model's own words what it could not confirm (no concrete detail: the re-check passes it).
  const w = world(t, { candidates: [PLAN], revision: '가진 자료로는 마이그레이션이 끝났는지 확인하지 못했습니다.', flags: { held: true, flow: false } })
  const decide = w.chat.decisionContext.client.decide
  // The check finds nothing in the evidence for the concrete sentence: the rewrite replaces it.
  w.chat.decisionContext.client.decide = async request => { const out = await decide(request); if (request.promptCacheKey === 'draft-check') for (const q of request.questions) if (/^sup_/.test(q.name)) out.answers[q.name] = { type: 'predicate', probability: 0.02 }; return out }
  await w.send(); await w.final('PostgreSQL 마이그레이션은 v16으로 3월에 끝났습니다.')
  const shown = w.posted().filter(([r]) => r === 'assistant').map(([, text]) => text)
  assert.equal(shown.length, 1); assert.notEqual(shown[0], 'PostgreSQL 마이그레이션은 v16으로 3월에 끝났습니다.')
  const turns = () => w.native.filter(([m, p]) => m === 'turn/start' && !String(p.threadId).startsWith('fork-')).map(([, p]) => p)
  const again = async (message, requestId) => { const r = await w.chat.send({ clientThreadId: DM, conversationId: w.r.conversationId, profileId: A, replyDestination: 'direct', message, requestId }); w.r = r; w.timing = { threadId: r.conversationId, turnId: r.runId } }
  await again('방금 그 내용 정리해줘', 'req-2')
  const second = turns().at(-1)
  assert.equal(second.additionalContext[POSTED_ANSWER_KEY].kind, 'application')
  assert.equal(second.additionalContext[POSTED_ANSWER_KEY].value, `Your previous answer in this conversation was not posted as you wrote it (a check before posting: revised). The person saw exactly this instead:\n"""\n${shown[0]}\n"""\nBuild on what the person saw, not on your earlier draft.`)
  assert.ok(!JSON.stringify(w.events).includes('not posted as you wrote it'), 'never in the chat')
  // That turn ends without an answer (stopped): nothing new was posted, and the note was already given to it.
  await w.chat.handleNotification({ method: 'turn/completed', params: { threadId: w.timing.threadId, turn: { id: w.timing.turnId, status: 'interrupted', items: [] } } }); await w.settleAll()
  await again('다시 정리해 줘', 'req-3')
  assert.equal(turns().at(-1).additionalContext?.[POSTED_ANSWER_KEY], undefined, 'consumed by the turn that was told')
  w.chat.decisionContext.client.decide = decide
  await w.final('네, 정리했습니다.')
  await again('고마워요', 'req-4')
  assert.equal(turns().at(-1).additionalContext?.[POSTED_ANSWER_KEY], undefined, 'an answer posted as written leaves nothing to tell')
})

// ---- c19: the evidence a check reads when the turn's context was late or chose nothing (Main, real collaboration v2, 2026-11-24) ----
// The turn's context result as the runtime received it, replaced: late = the deadline passed and the result comes afterwards; none = ready, nothing chosen.
function contextAs(w, shape) {
  const prepare = w.chat.prepareDecisionContext.bind(w.chat)
  w.chat.prepareDecisionContext = async (body, context) => {
    const real = await prepare(body, context)
    const how = typeof shape === 'function' ? shape() : shape
    if (!real || how === 'real') return real
    if (how === 'none') return { ...real, result: { ...real.result, selected: [], draftEvidence: [] } }
    const timeout = { status: 'fallback', reason: 'timeout', selected: [], extraContext: {}, receipt: null }
    // late: the result arrives 20 ms (real time) after the turn started, i.e. after lane L7's own late reading could have merged it
    if (how === 'late') return { ...real, result: timeout, late: new Promise(resolve => setTimeout(() => resolve(real.result), 20)) }
    if (how === 'late_guarded') return { ...real, result: timeout, late: Promise.resolve({ ...real.result, privateTopicBatch: true }) }
    throw new Error(how)
  }
}
const draftRequests = w => { const seen = [], decide = w.chat.decisionContext.client.decide
  w.chat.decisionContext.client.decide = async request => { if (request.promptCacheKey === 'draft-check') seen.push(request); return decide(request) }
  return seen }

test('c19: a turn whose context missed its deadline is checked against the result that arrived later; a guarded late result skips the check', async t => {
  for (const how of ['late', 'late_guarded']) {
    const w = world(t, { candidates: [PLAN], flags: { held: true, flow: false } }); contextAs(w, how)
    w.chat.noteLateDecisionContext = () => {} // lane L7's merge off: only the check's own wait reads the late result
    const seen = draftRequests(w)
    await w.send(); await w.final('PostgreSQL 전환은 v16으로 다음 분기에 할 예정입니다.')
    assert.deepEqual(w.posted().filter(([r]) => r === 'assistant'), [['assistant', 'PostgreSQL 전환은 v16으로 다음 분기에 할 예정입니다.']], `${how}: posted as written`)
    if (how === 'late') {
      assert.equal(seen.length, 1, 'one check, with the late materials')
      assert.match(seen[0].input[1].content, /PostgreSQL 이전 계획/)
    } else {
      assert.equal(seen.length, 0, 'a private-topic result never reaches the checker, late or not')
      assert.equal(w.log.entries().filter(e => e.feature === 'draft_check').length, 0, 'the check is skipped (guarded), not run without evidence')
    }
  }
  // Before c19 the same late turn had no evidence: the concrete sentence was cut with no request (the real run's "확인되지 않은 부분은 ..." line).
  const w = world(t, { candidates: [PLAN], flags: { held: true, flow: false } }); contextAs(w, 'late')
  const seen = draftRequests(w)
  w.chat.draftTurnEvidence = async (run, turn, tools) => ({ skip: null, evidence: answerEvidence(turn, tools) }) // the c18 reading
  w.chat.noteLateDecisionContext = () => {} // and without lane L7's late reading (flag keepLate)
  await w.send(); await w.final('PostgreSQL 전환은 v16으로 다음 분기에 할 예정입니다.')
  assert.equal(seen.length, 0, 'the c18 reading never asks')
  // Before c19 the person got the fixed "확인되지 않은 ..." sentence here; now no fixed sentence exists, and with no rewrite in this world
  // the draft goes as written, recorded as revision_unavailable (never judged).
  assert.equal(w.log.entries().filter(e => e.feature === 'draft_check').at(-1).fallback, 'revision_unavailable')
})

test('c19: a follow-up whose context chose no material is checked against the records the last check of the conversation used (real collaboration v2 F0)', async t => {
  const w = world(t, { candidates: [PLAN], flags: { held: true, flow: false } })
  let next = 'real'; contextAs(w, () => next)
  const seen = draftRequests(w)
  await w.send(); await w.final('PostgreSQL 전환은 v16으로 다음 분기에 할 예정입니다.')
  next = 'none'
  const r = await w.chat.send({ clientThreadId: DM, conversationId: w.r.conversationId, profileId: A, replyDestination: 'direct', message: 'v16 맞지?', requestId: 'req-2' })
  w.r = r; w.timing = { threadId: r.conversationId, turnId: r.runId }
  await w.final('네, v16입니다. 따로 확인하실 일은 없습니다.')
  assert.equal(seen.length, 2, 'the follow-up is asked about, not cut locally')
  assert.match(seen[1].input[1].content, /PostgreSQL 이전 계획/, 'with the earlier record')
  assert.deepEqual(w.posted().filter(([r]) => r === 'assistant').map(([, text]) => text), ['PostgreSQL 전환은 v16으로 다음 분기에 할 예정입니다.', '네, v16입니다. 따로 확인하실 일은 없습니다.'])
  // Another conversation does not get them.
  const other = world(t, { candidates: [PLAN], flags: { held: true, flow: false } }); contextAs(other, 'none')
  const none = draftRequests(other)
  await other.send(); await other.final('네, v16입니다.')
  assert.equal(none.length, 0)
  assert.equal(other.log.entries().filter(e => e.feature === 'draft_check').at(-1).fallback, 'revision_unavailable', 'no evidence anywhere: the concrete sentence is not confirmed; no rewrite here, so it goes as written, unjudged')
})

test('c19: with no evidence at all, an answer that makes no concrete claim is posted as written, with no request and no added line', async t => {
  const w = world(t, { candidates: [PLAN], flags: { held: true, flow: false } }); contextAs(w, 'none')
  const seen = draftRequests(w)
  await w.send(); await w.final('따로 확인하실 일은 없습니다.')
  assert.equal(seen.length, 0)
  assert.deepEqual(w.posted().filter(([r]) => r === 'assistant'), [['assistant', '따로 확인하실 일은 없습니다.']])
})

test('c19 (owner decision, no fixed fallback): a rewrite whose every sentence still fails leaves nothing: nothing is posted, the record says would_withhold, the next turn is told the person saw no answer', async t => {
  const w = world(t, { candidates: [PLAN], revision: 'PostgreSQL 마이그레이션은 v16으로 4월에 끝났습니다.', flags: { held: true, flow: false } })
  const decide = w.chat.decisionContext.client.decide
  w.chat.decisionContext.client.decide = async request => { const out = await decide(request); if (request.promptCacheKey === 'draft-check') for (const q of request.questions) if (/^sup_/.test(q.name)) out.answers[q.name] = { type: 'predicate', probability: 0.02 }; return out }
  await w.send(); await w.final('PostgreSQL 마이그레이션은 v16으로 3월에 끝났습니다.')
  assert.deepEqual(w.posted().filter(([r]) => r === 'assistant'), [], 'nothing of the check\'s own, and nothing unconfirmed')
  assert.equal(w.log.entries().filter(e => e.feature === 'draft_check').at(-1).ifUnrevised, 'would_withhold')
  const r = await w.chat.send({ clientThreadId: DM, conversationId: w.r.conversationId, profileId: A, replyDestination: 'direct', message: '그래서 끝났어?', requestId: 'req-2' })
  const next = w.native.filter(([m, p]) => m === 'turn/start' && !String(p.threadId).startsWith('fork-')).at(-1)[1]
  assert.match(next.additionalContext[POSTED_ANSWER_KEY].value, /was not posted: a check before posting could not confirm anything in it .* the person saw no answer to that message/)
  assert.ok(r)
})
