import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, chmodSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { CodexChatRuntime } from './codex-chat-runtime.mjs'
import { openChatStore } from './egdesk-chat-store.mjs'
import { createCodexBrowserToolProvider } from './codex-browser-tool-provider.mjs'
import { createDecisionClient, decisionTopicRecipient } from './egdesk-decision-client.mjs'
import { outcomeCandidate } from './egdesk-browser-task-memory.mjs'
import { triageTurn } from './egdesk-turn-memory.mjs'
import { mockJudge } from './egdesk-wiki-reconstruction.fixture.mjs'
import { PS_NAMES, pageStateAnswers, pageStateProbabilities, pageStateWire } from './egdesk-browser-page-state.fixture.mjs'
const STEP = `decide:${['next_step', ...PS_NAMES, 'goal_met'].join('+')}`

// L8/C11: the objective browser loop <-> chat round trip in the 'on' path of the REAL chat runtime under completed-messages-only
// (the held-answer mode), the read-only progress facts for the heartbeat, the entry decision riding on a turn-start triage request,
// and the safety re-check on the merged code. Synthetic only: UI double, mock Decisions fetch, a scripted subjective engine.
const KEY = 'egd-synthetic-not-a-key-0008'
const OWNER = 'codex:fixture-owner'
const DM = 'selected-chat'
const O = 'https://portal.example.test'
const el = (ref, role, label, extra = {}) => ({ ref, role, label, tag: role === 'link' ? 'a' : 'button', href: '', value: '', ...extra })
const PAGES = () => ({
  [`${O}/invoices`]: [el('b1', 'link', '사업자 123-45-67890', { href: `${O}/biz/1` }), el('b2', 'link', '사업자 987-65-43210', { href: `${O}/biz/2` }),
    el('x1', 'link', '구독 해지', { href: `${O}/subscription/cancel` }), el('s1', 'button', '발행 제출')],
  [`${O}/invoices-changed`]: [el('b1', 'link', '사업자 555-11-22222', { href: `${O}/biz/1` }), el('b2', 'link', '사업자 444-33-55555', { href: `${O}/biz/2` })],
  [`${O}/biz/2`]: [el('d2', 'link', '이번 달 세금계산서 다운로드', { href: `${O}/download/2.pdf` }), el('s2', 'button', '발행 제출')],
  [`${O}/biz/1`]: [el('d1', 'link', '이번 달 세금계산서 다운로드', { href: `${O}/download/1.pdf` })],
  [`${O}/download/2.pdf`]: [], [`${O}/download/1.pdf`]: [],
  // A second-factor page as measured for real (c14): the code field (a sensitive field, never a candidate) and the confirm button.
  [`${O}/otp`]: [el('o1', 'textbox', '인증번호'), el('o2', 'button', '인증 확인')],
  [`${O}/otp-push`]: [el('o2', 'button', '인증 확인')],
  [`${O}/single`]: [el('b9', 'link', '사업자 111-22-33333', { href: `${O}/biz/2` })],
  // the c4 classifier vocabulary, as labels and as destinations behind a harmless label
  [`${O}/danger`]: [el('g1', 'link', '로그아웃', { href: `${O}/session/end` }), el('g2', 'link', '회원 탈퇴', { href: `${O}/members/leave` }), el('g3', 'button', '알림 허용'),
    el('g4', 'button', '주문하기'), el('g5', 'link', '계약 해지', { href: `${O}/contract/x` }), el('g6', 'link', '계속', { href: `${O}/logout` }),
    el('g7', 'link', '다음', { href: `${O}/subscriptions/cancel` }), el('g8', 'link', '더 보기', { href: `${O}/order/place` }), el('g9', 'link', '설정', { href: `${O}/permissions/allow` }),
    el('g10', 'button', '결제 제출'), el('g11', 'link', 'Sign out', { href: `${O}/a` }), el('g12', 'button', 'Close my account')],
})
const DANGER_REFS = ['g1', 'g2', 'g3', 'g4', 'g5', 'g6', 'g7', 'g8', 'g9', 'g10', 'g11', 'g12']
const choice = (name, value, confidence) => ({ name, type: 'choice', choice: value, confidence, probabilities: [{ value, probability: confidence }] })
const starts = (choices, text) => choices.find(c => c.value.includes(text))?.value
const MSG = '거래처 포털에서 이번 달 세금계산서 내려받아줘'

const WAIT_TEXT = '확인하는 데 시간이 조금 걸리고 있어요. 곧 이어서 말씀드릴게요.'
function world(t, { start = `${O}/invoices`, held = true, flow = true, entry = {}, pick = null, patch = null, virtual = false, actGate = null } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'egd-c11-')); chmodSync(dir, 0o700)
  const store = openChatStore({ dataDir: dir, ownerScope: 'synthetic-c11' })
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }) })
  const pages = PAGES(), flags = { notListed: 0 }
  patch?.(pages)
  const events = [], calls = [], replies = [], decisions = [], acts = [], uiKinds = [], factsDuringActs = [], timeline = []
  let docSeq = 1, turnCount = 0, threadCount = 0, chat = null, clock = 5_000_000, forks = 0, failTurn = false
  const timers = [], flowAsked = [], forkPrompts = [], turnIds = [], sends = []
  let cur = { url: start, documentId: 'doc1', revision: 1 }
  const snap = () => ({ cardId: 'card', documentId: cur.documentId, revision: cur.revision, url: cur.url, readyState: 'complete', text: ['합성 포털'],
    viewport: { width: 300, height: 200, devicePixelRatio: 1 }, interactiveElements: pages[cur.url] })
  const client = createDecisionClient({
    recipientForKey: (value, endpoint, model) => decisionTopicRecipient(value, 1, endpoint, model), getApiKey: async () => KEY,
    fetchImpl: async (_e, { body }) => {
      const wire = JSON.parse(body), names = wire.questions.map(q => q.name), q0 = wire.questions[0]
      const stepQ = wire.questions.find(q => q.name === 'next_step') ?? (q0.choices ? q0 : { choices: [] }) // c16: a code-decided step asks no next_step
      const text = wire.input.map(m => (typeof m.content === 'string' ? m.content : '')).join('\n\n')
      decisions.push({ q: q0.name, names, bytes: Buffer.byteLength(body), image: /input_image|image_url/.test(body), input: text }); timeline.push(`decide:${names.join('+')}`)
      const entryAnswer = q => { const msg = /(?:User message: |Message:\n)(.*)/.exec(text)?.[1] ?? ''
        return choice('browser_entry', /세금계산서/.test(msg) ? starts(q.choices, '[C1]') : 'not_browser_task', 0.95) }
      if (names.some(name => name.includes('__'))) { // one heartbeat request for every question proposed at this beat (provider__name)
        // L3 c15: the message judgment is asked as yes/no questions (message__ask / __pointer / __note / __stalled) and code derives the kind.
        // This mock keeps its old policy (a wait message when one is possible, else a stall notice) and reports the kinds the questions stand for.
        const KIND = { message__pointer: 'pointer', message__ask: 'ask_missing', message__note: 'explain_wait', message__stalled: 'stalled' }
        const offered = ['none', ...names.filter(name => KIND[name]).map(name => KIND[name])]
        const picked = offered.includes('explain_wait') ? 'explain_wait' : offered.includes('stalled') ? 'stalled' : 'none'
        if (offered.length > 1) flowAsked.push({ offered, pick: picked, facts: text })
        const answers = wire.questions.map(q => { if (q.type === 'predicate') return { name: q.name, type: 'predicate', probability: KIND[q.name] === picked && picked !== 'none' ? 0.97 : 0.03 }
          const values = q.choices.map(c => c.value)
          const value = values.includes('none') ? 'none' : values[0]
          return { name: q.name, type: 'choice', choice: value, confidence: 0.95, probabilities: [{ value, probability: 0.96 }, { value: values.find(v => v !== value), probability: 0.02 }] } })
        return { ok: true, text: async () => JSON.stringify({ answers }) }
      }
      if (/^(claim_|present_)/.test(q0.name)) { // the check of a short intermediate message (no evidence for a bounded run)
        const answers = wire.questions.map(q => (q.type === 'choice' ? { name: q.name, type: 'choice', choice: 'supported', confidence: 0.95, probabilities: [{ value: 'supported', probability: 0.96 }, { value: q.choices.find(c => c.value !== 'supported')?.value, probability: 0.02 }] } : { name: q.name, type: 'predicate', probability: 0.03 }))
        return { ok: true, text: async () => JSON.stringify({ answers }) }
      }
      if (names.includes('tn_courtesy')) { // a turn-start triage request, possibly carrying the entry question
        const answers = wire.questions.map(q => (q.name === 'browser_entry' ? entryAnswer(q) : { name: q.name, type: 'predicate', probability: q.name === 'tn_need' ? 0.9 : 0.03 }))
        return { ok: true, text: async () => JSON.stringify({ answers, usage: { input_tokens: 1 } }) }
      }
      if (q0.name === 'browser_entry') return { ok: true, text: async () => JSON.stringify({ answers: [entryAnswer(q0)] }) }
      if (q0.name === 'task_resume') { const msg = /User message: (.*)/.exec(text)?.[1] ?? ''
        return { ok: true, text: async () => JSON.stringify({ answers: [choice('task_resume', /취소/.test(msg) ? 'cancel_task' : /점심/.test(msg) ? 'unrelated' : 'resume_task', 0.95)] }) } }
      const evidence = wire.input[1].content
      const url = /URL: (\S+)/.exec(evidence)?.[1], ctx = /Context the user gave in the chat \(not page text\):\n([\s\S]*?)\n\n/.exec(evidence)?.[1] ?? ''
      let next, goalMet = 0, pageState = 'content'
      if (/is NOT listed now/.test(evidence)) flags.notListed++
      const listed = /it is listed now as (\[L\d+\] [^\n]*?)\.(?:\n|$)/.exec(evidence)
      if (pick) { const picked = pick(stepQ.choices, evidence, url, ctx); if (picked && typeof picked === 'object') { next = picked.next; goalMet = picked.goalMet ?? 0 } else next = picked }
      else if (/\/download\//.test(url)) { next = 'goal_met'; goalMet = 0.95 }
      else if (url.endsWith('/otp')) { next = 'blocked'; pageState = 'two_factor_required' }
      else if (/\/invoices/.test(url)) next = listed ? listed[1].trim() : /is NOT listed now/.test(evidence) ? stepQ.choices.map(c => c.value).find(v => /^\[L1\]/.test(v)) : /두 번째/.test(ctx) ? starts(stepQ.choices, '987-65') : 'needs_user_context'
      else if (url.endsWith('/single')) next = starts(stepQ.choices, '111-22')
      else next = starts(stepQ.choices, '다운로드') ?? 'blocked'
      const answer = choice('next_step', next, 0.95)
      if (next === 'needs_user_context') answer.probabilities.push(...stepQ.choices.filter(c => /^\[L\d+\]/.test(c.value)).slice(0, 2).map(c => ({ value: c.value, probability: 0.02 })))
      return { ok: true, text: async () => JSON.stringify({ answers: [answer, ...pageStateWire(pageState), { name: 'goal_met', type: 'predicate', probability: goalMet }] }) }
    },
  })
  const transport = { runs: new Map(), hasClient: id => id === 'ui',
    bindRun: (id, thread, transportId) => { if (transport.runs.has(id)) throw new Error('already bound'); transport.runs.set(id, { clientThreadId: thread, transportId, ownerKey: OWNER }) },
    unbindRun: id => transport.runs.delete(id),
    async sendToUi(request) {
      uiKinds.push(request.kind); timeline.push(`ui:${request.kind}`)
      const reply = { requestId: request.requestId }
      if (request.kind === 'bind') return { ...reply, status: 'bound', binding: { cardId: 'card', cardEpoch: 'epoch', profileId: 'fixture', accountId: '', userContextId: 0, url: start, engineAccountKey: OWNER, authorityEpoch: 1 } }
      if (request.kind === 'observe') { const wait = request.options?.wait
        return { ...reply, status: 'observed', snapshot: wait ? { ...snap(), wait: { for: wait.for, outcome: 'met', elapsedMs: 1 } } : snap() } }
      if (request.kind === 'act') {
        const a = request.action; acts.push({ type: a.type, url: a.url ?? null, ref: a.ref ?? null })
        if (actGate) await actGate(acts.length)
        factsDuringActs.push(chat.browserTaskFacts(DM))
        if (a.type === 'navigate') cur = { url: a.url, documentId: `doc${++docSeq}`, revision: 1 }
        return { ...reply, status: 'acted', receipt: { after: snap(), observation: {}, dispatchReceipt: { actor: 'JSWindowActor', eventDispatched: true, documentStillCurrent: true, inputRoute: 'chrome-load-uri' } } }
      }
      if (request.kind === 'cancel') return { ...reply, status: 'cancelled' }
      return { ...reply, status: 'rejected' }
    },
  }
  const provider = createCodexBrowserToolProvider({ transport, getOwnerKey: () => OWNER, decision: { mode: () => 'on', configured: () => true, client,
    recipient: () => decisionTopicRecipient(KEY, 1, undefined, client.model), generation: () => 0 } })
  const memoryCalls = []
  chat = new CodexChatRuntime({
    store, requireStore: true, getOwnerKey: () => OWNER, toolProviders: [provider], verifyFile: async () => null,
    ...(virtual ? { now: () => clock, monotonicNow: () => clock, setTimer: (fn, ms) => { const timer = { fn, at: clock + ms }; timers.push(timer); return timer },
      clearTimer: timer => { const i = timers.indexOf(timer); if (i >= 0) timers.splice(i, 1) } } : {}),
    respond: (...args) => replies.push(args), emit: e => events.push(e), emitLegacy() {},
    request: async (method, params) => {
      calls.push({ method, params }); timeline.push(`native:${method}`)
      if (method === 'experimentalFeature/list') return { data: ['browser_use', 'browser_use_external', 'computer_use'].map(name => ({ name, enabled: false, stage: 'stable' })), nextCursor: null }
      if (method === 'mcpServerStatus/list') return { data: [], nextCursor: null }
      if (method === 'thread/unsubscribe') return { status: 'unsubscribed' }
      if (method === 'config/read') return { config: { developer_instructions: 'Ordinary instructions' }, layers: [] }
      if (method === 'thread/start') return { thread: { id: `thread-${++threadCount}` }, cwd: '/work', model: 'configured-model', sandbox: { type: 'readOnly', networkAccess: false }, approvalPolicy: 'never' }
      if (method === 'thread/resume') return { thread: { id: params.threadId, turns: [] }, cwd: '/work', sandbox: { type: 'readOnly', networkAccess: false }, approvalPolicy: 'never' }
      if (method === 'thread/fork') return { thread: { id: `fork-${++forks}`, forkedFromId: params.threadId } }
      if (method === 'turn/start' && String(params.threadId).startsWith('fork-')) { // the private writer turn: the subjective model words one short message
        forkPrompts.push(params.input[0].text)
        setTimeout(async () => {
          await chat.handleNotification({ method: 'item/completed', params: { threadId: params.threadId, turnId: 'ft', item: { id: 'f1', type: 'agentMessage', phase: 'final_answer', text: WAIT_TEXT } } })
          await chat.handleNotification({ method: 'turn/completed', params: { threadId: params.threadId, turn: { id: 'ft', status: 'completed', items: [] } } })
        }, 1)
        return { turn: { id: 'ft', status: 'inProgress', items: [] } }
      }
      if (method === 'turn/start') { if (failTurn) { failTurn = false; throw Object.assign(new Error('native refused'), { code: -32000 }) }
        const id = `turn-${++turnCount}`; turnIds.push(id); return { turn: { id, status: 'inProgress', items: [] } } }
      if (method === 'turn/interrupt') return {}
      throw new Error(`Unexpected method: ${method}`)
    },
    decisionContext: { mode: () => 'on', configured: () => true, client, calibrationLog: { record: () => ({}), complete() {} },
      ...(held ? { draftCheck: { mode: () => 'on' } } : {}), ...(flow ? { conversationFlow: { mode: () => 'on' } } : {}),
      browserEntry: { mode: () => 'on', ...entry, ...(entry.memory ? { memory: async args => { memoryCalls.push(1); return entry.memory(args) } } : {}) } },
  })
  chat.setConnection(true)
  const source = n => ({ id: 'selected-source', kind: 'browser', selectedByUser: true, browserToolPermission: 'interact',
    sourceRef: { viewId: 'card', profileId: 'fixture', accountId: '', uri: start },
    browserToolIdentity: { cardEpoch: 'epoch', userContextId: 0, engineAccountKey: OWNER, authorityEpoch: 1 },
    browserToolSelection: { token: `token-${n}`, threadId: DM } })
  let n = 0, last = null
  const notify = (method, params) => chat.handleNotification({ method, params })
  const settle = async () => { for (let i = 0; i < 8; i++) { await chat.flowIdle(); await new Promise(r => setTimeout(r, 3)) } }
  const w = { flowAsked, forkPrompts, timers, settle,
    async advance(ms, { settleEvery = 1 } = {}) { const end = clock + ms; let fired = 0
      for (;;) { timers.sort((a, b) => a.at - b.at); const next = timers[0]; if (!next || next.at > end) break; timers.shift(); clock = next.at; next.fn(); if (++fired % settleEvery === 0) await settle(); else await new Promise(r => setImmediate(r)) }
      clock = end; await settle() },
    timing: () => ({ threadId: last.conversationId, turnId: turnIds.at(-1) }), notify,
    flags, chat, store, events, calls, decisions, acts, uiKinds, timeline, factsDuringActs, memoryCalls,
    setUrl(url) { cur = { url, documentId: `doc${++docSeq}`, revision: 1 } },
    // Sent the way the composer sends: the same body whether or not a reply is open (the runtime decides where it goes).
    async send(message, { wait = true, extra = {} } = {}) { n++
      const out = await chat.send({ ...extra, message, requestId: `req-${n}`, clientThreadId: DM, ...(last ? { conversationId: last.conversationId } : {}), executionPolicy: { mode: 'browserBounded' },
        selectedSources: [source(n)], browserTransportId: 'ui' })
      sends.push(out)
      if (out.inRun) { if (wait) await chat.browserRunIdle() } else last = out
      return out },
    failNextTurn() { failTurn = true },
    sends, turnIds, runs: () => chat.snapshot(last.conversationId).runs, replyEvents: () => events.filter(e => /^reply\./.test(e.event)).map(e => e.event),
    note() { const value = calls.filter(c => c.method === 'turn/start').at(-1).params.additionalContext?.egdesk_browser_task?.value; return value ? JSON.parse(value).egdesk_browser_task : null },
    // The scripted subjective engine: it words the closed note (it has nothing else) and streams like a real turn would.
    async subjective({ beforeTurnEnds = null } = {}) {
      const note = w.note(), timing = { threadId: last.conversationId, turnId: turnIds.at(-1) }
      const text = !note ? '(일반 답변)' : note.status === 'done' ? '세금계산서를 내려받았습니다.'
        : note.code === 'choice_needed' ? `사업자가 둘입니다(${(note.candidates || []).join(', ')}). 어느 쪽으로 받을까요?`
          : note.code === 'two_factor_required' ? '2단계 인증이 필요합니다. 브라우저 카드에서 직접 마친 뒤 알려주세요.' : note.code === 'human_step' ? '남은 단계는 직접 눌러야 합니다.' : '진행할 수 없습니다.'
      const id = `ans-${n}`
      await notify('item/started', { ...timing, item: { id, type: 'agentMessage', phase: 'final_answer', text: '' } })
      for (const part of [text.slice(0, 5), text.slice(5)]) await notify('item/agentMessage/delta', { ...timing, itemId: id, delta: part })
      await notify('item/completed', { ...timing, item: { id, type: 'agentMessage', phase: 'final_answer', text } })
      await new Promise(r => setTimeout(r, 2))
      beforeTurnEnds?.(text)
      await notify('turn/completed', { threadId: timing.threadId, turn: { id: timing.turnId, status: 'completed', items: [] } })
      for (let i = 0; i < 6; i++) { await chat.draftCheckIdle(); await chat.flowIdle(); await chat.browserRunIdle(); await new Promise(r => setTimeout(r, 2)) }
      return text
    },
    history: () => store.listMessages(DM).messages.map(m => [m.role, m.text]),
    deltas: () => events.filter(e => e.event === 'message.delta').map(e => e.details?.delta),
    posted: () => events.filter(e => e.event === 'message.completed' && e.details?.role === 'assistant').map(e => e.details.text),
    visibleAssistant: () => JSON.stringify(events.filter(e => /^message\./.test(e.event) && e.details?.role !== 'user')),
    counts: () => decisions.reduce((m, d) => (m[d.q] = (m[d.q] || 0) + 1, m), {}),
  }
  return w
}

test('R1 one live run: question (completed message) -> run.replyOpen -> in-run reply -> the SAME task resumes inside the run -> one final report', async t => {
  const w = world(t)
  await w.send(MSG)
  const note1 = w.note()
  assert.deepEqual([note1.status, note1.code, note1.next], ['need_context', 'choice_needed', 'ask_user_in_chat'])
  const waiting = w.chat.browserTaskFacts(DM)
  let early = null
  const question = await w.subjective({ beforeTurnEnds: () => { early = w.visibleAssistant() } })
  // the subjective model's question is ONE completed message: nothing of it is visible before the turn ends, then it arrives whole
  assert.equal(early, '[]', 'no started, partial or completed assistant text while the turn works')
  assert.deepEqual(w.deltas(), [question], 'one piece, never streamed fragments')
  assert.deepEqual(w.posted(), [question])
  assert.deepEqual(w.history(), [['user', MSG], ['assistant', question]])
  assert.deepEqual(w.acts, [], 'nothing was done before the person answered')
  // the run stays open for the reply: still working, reply open on the question message, nothing else posted
  const held = w.runs()
  assert.deepEqual([held.length, held[0].status, held[0].replyOpen?.messageId], [1, 'inProgress', held[0].messages.find(m => m.role === 'assistant').id])
  assert.deepEqual(w.replyEvents(), ['reply.opened'])
  const reply = await w.send('두 번째 사업자로')
  assert.deepEqual([reply.inRun, reply.runId, reply.accepted], [true, held[0].runId, true], 'the reply went into the same run')
  const note2 = w.note()
  assert.deepEqual([note2.status, note2.id, note2.next], ['done', note1.id, 'report_to_user'], 'the reply resumed the same task')
  const report = await w.subjective()
  assert.deepEqual(w.deltas(), [question, report]); assert.deepEqual(w.posted(), [question, report], 'the final report is one completed message too')
  assert.deepEqual(w.history(), [['user', MSG], ['assistant', question], ['user', '두 번째 사업자로'], ['assistant', report]])
  const ended = w.runs()
  assert.deepEqual([ended.length, ended[0].status, ended[0].replyOpen ?? null, ended[0].runId], [1, 'completed', null, held[0].runId], 'one run from the request to the report')
  assert.deepEqual(ended[0].messages.map(m => m.role), ['assistant', 'user', 'assistant'], 'the question, the in-run reply and the report belong to one run')
  assert.deepEqual(w.replyEvents(), ['reply.opened', 'reply.closed'])
  assert.equal(w.events.filter(e => e.event === 'run.completed').length, 1)
  // the second native turn is the person's reply plus the closed note, on the same thread; nothing else differs from the first turn's shape
  const [turn1, turn2] = w.calls.filter(c => c.method === 'turn/start').map(c => c.params)
  assert.deepEqual([turn2.threadId, turn2.input[0].text, Object.keys(turn2).sort()], [turn1.threadId, '두 번째 사업자로', Object.keys(turn1).sort()])
  assert.deepEqual(w.acts.map(a => [a.type, a.url]), [['navigate', `${O}/biz/2`], ['navigate', `${O}/download/2.pdf`]])
  assert.deepEqual(w.counts(), { browser_entry: 1, next_step: 4, task_resume: 1 })
  assert.equal(w.decisions.filter(d => d.image).length, 0)
  // each objective phase ran before its native turn: the subjective model only ever worded a finished note
  const order = w.timeline.filter(x => /^(decide:|native:turn\/start)/.test(x))
  assert.deepEqual(order, ['decide:browser_entry', STEP, 'native:turn/start', 'decide:task_resume',
    STEP, STEP, STEP, 'native:turn/start'])
  // no intermediate-message job started for a browser-task turn (its reply must reach the task, not an in-run steer)
  assert.equal(w.calls.some(c => c.method === 'thread/fork' || c.method === 'turn/steer' || c.method === 'turn/interrupt'), false, 'the reply is never steered into a native turn: it belongs to the task')

  // progress facts for the heartbeat: read-only, numbers and closed words only
  assert.deepEqual([waiting.status, waiting.active, waiting.phase, waiting.waitingOnUser, waiting.waitingKind, waiting.waitingCode, waiting.stepsDone, waiting.stepsRemaining, waiting.lastActionAgeMs], ['paused', true, 'waiting_user', true, 'need_context', 'choice_needed', 1, 23, null])
  const done = w.chat.browserTaskFacts(DM)
  assert.deepEqual([done.status, done.active, done.phase, done.waitingOnUser, done.stepsDone, done.actions.navigate, done.taskId], ['done', false, null, false, 4, 2, note1.id])
  assert.equal(typeof done.lastActionAgeMs, 'number')
  assert.deepEqual(w.factsDuringActs.map(f => [f.status, f.phase, f.waitingOnUser]), [['running', 'objective_step', false], ['running', 'objective_step', false]])
  assert.equal(waiting.asked, false, 'read while the question was still being worded')
  assert.ok(w.factsDuringActs[1].stepsDone > w.factsDuringActs[0].stepsDone, 'the step count moves while the loop runs')
  assert.deepEqual(Object.keys(done).sort(), ['actions', 'active', 'ageMs', 'asked', 'idleMs', 'lastActionAgeMs', 'phase', 'status', 'stepsDone', 'stepsRemaining', 'taskId', 'waitingCode', 'waitingKind', 'waitingOnUser'])
  assert.doesNotMatch(JSON.stringify([waiting, done, w.factsDuringActs]), /세금|사업자|portal|example|https?:|invoices/)
  assert.ok(Object.isFrozen(done))
  assert.equal(w.chat.browserTaskFacts('other-chat'), null)
})

test('R2 cannot-proceed round trip (2FA): one completed message asks the person, "했어" resumes the same task, one final report', async t => {
  const w = world(t, { start: `${O}/otp` })
  await w.send(MSG)
  const note1 = w.note()
  assert.deepEqual([note1.status, note1.code, note1.next], ['cannot_proceed', 'two_factor_required', 'tell_user_and_ask_in_chat'])
  const facts = w.chat.browserTaskFacts(DM)
  assert.deepEqual([facts.waitingOnUser, facts.waitingKind, facts.waitingCode], [true, 'cannot_proceed', 'two_factor_required'])
  const ask = await w.subjective()
  assert.deepEqual(w.acts, [])
  assert.equal(w.runs()[0].status, 'inProgress'); assert.equal(w.chat.browserTaskFacts(DM).asked, true)
  w.setUrl(`${O}/single`) // the person finished the second factor in the card
  assert.equal((await w.send('했어')).inRun, true)
  const note2 = w.note()
  assert.deepEqual([note2.status, note2.id], ['done', note1.id])
  const report = await w.subjective()
  assert.deepEqual(w.history(), [['user', MSG], ['assistant', ask], ['user', '했어'], ['assistant', report]])
  assert.deepEqual(w.deltas(), [ask, report]); assert.deepEqual(w.posted(), [ask, report])
  assert.deepEqual([w.runs().length, w.runs()[0].status], [1, 'completed'])
  assert.equal(w.acts.filter(a => a.type !== 'navigate').length, 0)
})

test('R3 contrast, held mode off: the same browser-task turn streams (started + deltas), which is what the hold removes', async t => {
  const w = world(t, { held: false })
  await w.send(MSG)
  let early = null
  const text = await w.subjective({ beforeTurnEnds: () => { early = w.visibleAssistant() } })
  assert.notEqual(early, '[]', 'without the hold the text is visible while the turn still works')
  assert.ok(w.deltas().length > 1 && w.deltas().join('') === text, 'streamed fragments')
})

// Changed in c15 (U8, all-on finding A6): with the held mode on, every turn of a Browser conversation shows only finished messages.
test('R4 held mode on, not a browser task: the ordinary turn of a Browser conversation is held too, shown once and whole; the heartbeat does not start speaking there', async t => {
  const w = world(t, { virtual: true })
  await w.send('오늘 날씨 어때?')
  assert.equal(w.note(), null)
  let early = null
  const text = await w.subjective({ beforeTurnEnds: () => { early = w.visibleAssistant() } })
  assert.equal(early, '[]', 'nothing of the answer is visible while the turn works')
  assert.deepEqual([w.deltas(), w.posted()], [[text], [text]], 'one piece, one completed message')
  assert.equal(w.chat.browserTaskFacts(DM), null)
  assert.equal(w.flowAsked.length, 0, 'a held ordinary bounded turn is not made a speaker')
})

// ---- cost: the entry decision riding on a turn-start triage request ----
const rideHook = { entryAnswers: async ({ body, question, client }) => (await triageTurn({ message: body.message, client, extraQuestions: [question] })).extra ?? null }

test('C1 ride-along: one turn-start request carries triage + the entry question; no separate entry request; the task runs the same', async t => {
  const alone = world(t); await alone.send(MSG)
  const ride = world(t, { entry: rideHook }); await ride.send(MSG)
  assert.deepEqual(ride.decisions[0].names, ['tn_courtesy', 'tn_need', 'tn_record', 'browser_entry'])
  assert.deepEqual(ride.counts(), { tn_courtesy: 1, next_step: 1 }, 'no standalone browser_entry request')
  assert.deepEqual(alone.counts(), { browser_entry: 1, next_step: 1 })
  assert.deepEqual([ride.note().status, ride.note().code], [alone.note().status, alone.note().code])
  assert.deepEqual(ride.acts, alone.acts)
  // measured request sizes in this harness (bytes on the wire, the real token counts need the provider)
  const plainTriage = world(t, { entry: { entryAnswers: async ({ body, client }) => { await triageTurn({ message: body.message, client }); return null } } }); await plainTriage.send(MSG)
  const sizes = { standaloneEntryBytes: alone.decisions[0].bytes, triageBytes: plainTriage.decisions[0].bytes, triageWithEntryBytes: ride.decisions[0].bytes }
  sizes.addedByRiding = sizes.triageWithEntryBytes - sizes.triageBytes
  sizes.savedBytes = sizes.standaloneEntryBytes - sizes.addedByRiding
  t.diagnostic(JSON.stringify(sizes))
  assert.ok(sizes.addedByRiding < sizes.standaloneEntryBytes, 'the extra question is smaller than a request of its own')
})

test('C2 ride-along, not a browser task: the entry answer skips the memory fetch entirely; without riding the fetch happens first', async t => {
  const memory = async () => ({ packet: null, pages: [], scope: null })
  const ride = world(t, { entry: { ...rideHook, memory } }); await ride.send('오늘 날씨 어때?')
  assert.deepEqual([ride.memoryCalls.length, ride.note(), ride.acts.length, ride.counts().tn_courtesy], [0, null, 0, 1])
  const alone = world(t, { entry: { memory } }); await alone.send('오늘 날씨 어때?')
  assert.deepEqual([alone.memoryCalls.length, alone.note()], [1, null])
  const task = world(t, { entry: { ...rideHook, memory } }); await task.send(MSG)
  assert.equal(task.memoryCalls.length, 1, 'a browser task still gets its memory')
})

test('C3 riding does not change the triage reading: same input, same triage questions, the entry question appended last', async () => {
  for (const message of ['PostgreSQL 마이그레이션 배포 끝났어', '고마워', MSG]) {
    const a = [], b = []
    const rider = { type: 'choice', name: 'browser_entry', instructions: 'Is the user message a task to carry out in one of the listed browser cards?', choices: [{ value: '[C1] portal.example.test' }, { value: 'not_browser_task' }, { value: 'ask_user' }] }
    const plain = await triageTurn({ message, client: mockJudge(a), askedAt: 1 })
    const rode = await triageTurn({ message, client: mockJudge(b), askedAt: 1, extraQuestions: [rider, { ...rider, name: 'tn_need' }] })
    const { extra, ...rest } = rode
    assert.deepEqual(rest, plain, 'courtesy / need / record / recall readings are identical')
    assert.equal(a[0].input, b[0].input, 'the evidence is byte-identical')
    assert.deepEqual(b[0].questions, [...a[0].questions, 'browser_entry'], 'triage questions first and unchanged; a rider can never take a tn_ name')
    assert.deepEqual(Object.keys(extra), ['browser_entry'])
  }
  const failed = await triageTurn({ message: 'x', client: { decide: async () => { throw Object.assign(new Error('x'), { code: 'timeout' }) } }, extraQuestions: [{ type: 'choice', name: 'browser_entry', instructions: 'i', choices: [{ value: 'a' }, { value: 'b' }] }] })
  assert.equal(failed.status, 'fallback'); assert.equal(failed.extra, undefined, 'a failed shared request yields no entry answer: the caller asks on its own')
})

test('C4 ride-along answer that is unusable or refused by egress: the standalone request is used, never a guess', async t => {
  const broken = world(t, { entry: { entryAnswers: async () => ({ browser_entry: { type: 'invalid', reason: 'choice' } }) } }); await broken.send(MSG)
  assert.deepEqual(broken.counts(), { browser_entry: 1, next_step: 1 })
  const thrown = world(t, { entry: { entryAnswers: async () => { throw new Error('host failed') } } }); await thrown.send(MSG)
  assert.deepEqual(thrown.counts(), { browser_entry: 1, next_step: 1 })
  const lowConfidence = world(t, { entry: { entryAnswers: async ({ question }) => ({ browser_entry: choice('browser_entry', question.choices[0].value, 0.4) }) } }); await lowConfidence.send(MSG)
  assert.deepEqual([lowConfidence.note(), lowConfidence.acts.length, lowConfidence.counts().browser_entry ?? 0], [null, 0, 0], 'an uncertain shared answer starts no task and is not asked again')
})

// ---- safety re-check on the merged code, through the runtime 'on' path ----
test('S1 the classifier vocabulary (logout, leave, allow, order, contract, pay-submit; labels and destinations): never acted on, whatever the model picks', async t => {
  for (const guess of ['[L1] 로그아웃', '[B1] 알림 허용', '[B2] 주문하기', '[L3] 계속', '[L2] 회원 탈퇴', '[B3] 결제 제출', '[L1] Sign out', 'blocked']) {
    const w = world(t, { start: `${O}/danger`, pick: () => guess })
    await w.send(MSG)
    assert.deepEqual(w.acts, [], `${guess}: 0 action requests`)
    const note = w.note()
    assert.equal(note.status, 'cannot_proceed', guess)
    // c15 code rule: nothing on the page can be chosen and person-only controls were withheld -> the step is the person's, whatever the model would pick.
    assert.equal(note.code, 'human_step', guess)
    assert.equal(w.counts().next_step ?? 0, 0, `${guess}: the step is not even asked`)
    assert.equal(note.candidates, undefined)
    assert.doesNotMatch(JSON.stringify(note), /로그아웃|탈퇴|허용|주문|해지|제출|logout|cancel/, 'the note names none of them')
  }
})

test('S2 submit and the dangerous link stay human on the task pages too; nothing is ever typed (the direct entry supplies no values)', async t => {
  const w = world(t); await w.send(MSG); await w.subjective(); await w.send('두 번째 사업자로'); await w.subjective()
  assert.equal(w.acts.filter(a => a.type === 'fill').length, 0)
  assert.equal(w.acts.filter(a => ['s1', 's2', 'x1'].includes(a.ref) || /subscription\/cancel/.test(a.url ?? '')).length, 0)
  assert.equal(w.acts.every(a => a.type === 'navigate'), true)
})

test('S3 page-changed override through the runtime: memory names a choice that is gone -> the person is asked although the model picked confidently; still listed -> no question', async t => {
  const prior = outcomeCandidate({ taskId: 'bt_0123456789ab', goal: MSG, host: 'portal.example.test', now: Date.parse('2026-10-19T09:00:00Z'), outcome: { status: 'done' },
    trail: [{ op: 'open', label: '사업자 987-65-43210', from: '/invoices', to: '/biz/2' }], resolved: [{ asked: 'choice_needed', chose: '사업자 987-65-43210', at: '/invoices' }] })
  const page = { id: 'browser-task/bt_0123456789ab', title: 'x', body: prior.text, revision: '1', provenance: { kind: 'agent_note', by: 'browser_task' }, time: { slice: 'past' }, status: 'done', scope: null }
  const memory = async () => ({ packet: prior.text, pages: [page], scope: null })
  const same = world(t, { entry: { memory } }); await same.send(MSG)
  assert.deepEqual([same.note().status, same.acts.map(a => a.url)], ['done', [`${O}/biz/2`, `${O}/download/2.pdf`]])
  const changed = world(t, { entry: { memory }, patch: p => { p[`${O}/invoices`] = p[`${O}/invoices-changed`] } })
  await changed.send(MSG)
  // c16: code compares the recorded label with the labels offered now; it is gone, so the person is asked which, and the model is not
  assert.equal(changed.flags.notListed, 0, 'no which-question carried the history to the model')
  assert.deepEqual([changed.note().status, changed.note().code, changed.note().candidates, changed.acts.length], ['need_context', 'choice_needed', ['사업자 555-11-22222', '사업자 444-33-55555'], 0])
})

// ---- heartbeat in the real wiring: a browser-task turn is eligible to speak, one mechanism, completed messages only ----
test('H1 a slow wording turn: the heartbeat speaks (one completed message), never opens an in-run question; then the question, the reply, the same task, the report', async t => {
  const w = world(t, { virtual: true })
  await w.send(MSG)
  const hb = w.chat.heartbeatFor(DM)
  assert.equal(hb.state, 'running')
  assert.deepEqual([hb.facts().phase, hb.facts().sources.browser_task.phase, hb.facts().sources.browser_task.awaiting], ['thinking', 'handing_off', 'need_context'])
  // the subjective model thinks aloud with a question in its notes: in an ordinary held turn that would offer ask_missing
  await w.notify('item/started', { ...w.timing(), item: { id: 'note-1', type: 'agentMessage', phase: 'commentary', text: '' } })
  await w.notify('item/completed', { ...w.timing(), item: { id: 'note-1', type: 'agentMessage', phase: 'commentary', text: '어느 사업자인지 먼저 물어봐야 할까?' } })
  await w.advance(26000)
  assert.ok(w.flowAsked.length >= 1, 'the bounded browser-task turn is asked about at a beat')
  assert.ok(w.flowAsked.every(a => !a.offered.includes('ask_missing')), 'the task question is never opened as an in-run question')
  assert.deepEqual(w.posted(), [WAIT_TEXT], 'one intermediate message, completed')
  assert.equal(w.forkPrompts.length, 1, 'written by the subjective model on a private fork')
  assert.equal(w.calls.some(c => c.method === 'turn/steer'), false)
  assert.deepEqual(w.acts, [], 'speaking never acts on the page')
  const question = await w.subjective()
  // the question is posted and the run is held open: now the person really is awaited, and the heartbeat says nothing more
  assert.deepEqual([hb.state, hb.facts().phase, hb.facts().sources.browser_task.phase, hb.facts().sources.browser_task.waitingOnUser], ['running', 'waiting_user', 'waiting_user', true])
  assert.deepEqual(w.posted(), [WAIT_TEXT, question])
  const askedBefore = w.flowAsked.length
  await w.advance(60000)
  assert.deepEqual([w.flowAsked.length, w.posted().length], [askedBefore, 2], 'a minute of waiting for the person: no request, no message')
  assert.equal((await w.send('두 번째 사업자로')).inRun, true)
  assert.deepEqual([w.note().status, w.acts.length], ['done', 2])
  const report = await w.subjective()
  // L3 c13: the heartbeat belongs to the conversation's live session. After the run ended it goes on at the idle tempo (it idles out by itself); the run itself is completed.
  assert.deepEqual([hb.state, hb.tempo, hb.stopReason ?? null, w.runs().length, w.runs()[0].status], ['running', 'idle', null, 1, 'completed'])
  assert.deepEqual(w.history(), [['user', MSG], ['assistant', WAIT_TEXT], ['assistant', question], ['user', '두 번째 사업자로'], ['assistant', report]])
  assert.equal(w.deltas().length, 3, 'three assistant messages, each in one piece')
  // L3 c15: the judge reads the run's own text (the person's request, the Agent's note); nothing of the page (its host, address or the numbers read from it).
  assert.doesNotMatch(w.flowAsked.map(a => a.facts).join('\n'), /portal|example|https?:|\d{3}-\d{2}-\d{5}/, 'the heartbeat questions carry nothing of the page')
})

test('H2 held mode off: the heartbeat still beats with the task facts but cannot speak; the wording turn streams as before', async t => {
  const w = world(t, { virtual: true, held: false })
  await w.send(MSG)
  await w.advance(26000)
  assert.equal(w.chat.heartbeatFor(DM).facts().sources.browser_task.phase, 'handing_off')
  assert.deepEqual([w.flowAsked.length, w.posted().length, w.forkPrompts.length], [0, 0, 0])
  await w.subjective()
})

// ---- the objective loop INSIDE the run (after the first hand-off): it can speak mid-loop, be stopped, time out, or be declined ----
const gate = () => { let open; const promise = new Promise(resolve => { open = resolve }); return { promise, open } }

test('N1 mid-loop: the resumed loop works inside the run, so a slow step gets one completed message from the heartbeat; then the report; one run', async t => {
  const slow = gate()
  const w = world(t, { virtual: true, actGate: n => (n === 1 ? slow.promise : null) })
  await w.send(MSG); const question = await w.subjective()
  const reply = await w.send('두 번째 사업자로', { wait: false })
  assert.equal(reply.inRun, true)
  await w.settle()
  const hb = w.chat.heartbeatFor(DM)
  assert.deepEqual([w.acts.length, hb.facts().phase, hb.facts().sources.browser_task.phase, w.runs()[0].status], [1, 'objective_step', 'objective_step', 'inProgress'], 'the first page action is in flight, inside the run')
  assert.equal(w.turnIds.length, 1, 'no native turn is live while the objective loop works')
  await w.advance(16000)
  assert.deepEqual(w.posted(), [question, WAIT_TEXT], 'the heartbeat spoke during the objective loop: a completed message in the same run')
  assert.ok(w.flowAsked.length >= 1 && w.flowAsked.every(a => !a.offered.includes('ask_missing')))
  assert.match(w.flowAsked.at(-1).facts, /current_phase: objective_step/)
  assert.doesNotMatch(w.flowAsked.map(a => a.facts).join('\n'), /portal|example|https?:|\d{3}-\d{2}-\d{5}/)
  slow.open()
  await w.chat.browserRunIdle()
  assert.deepEqual([w.note().status, w.turnIds.length], ['done', 2])
  const report = await w.subjective()
  assert.deepEqual(w.history(), [['user', MSG], ['assistant', question], ['user', '두 번째 사업자로'], ['assistant', WAIT_TEXT], ['assistant', report]])
  assert.deepEqual([w.runs().length, w.runs()[0].status, w.acts.length], [1, 'completed', 2])
  assert.equal(w.acts.filter(a => a.type === 'fill' || ['s1', 's2', 'x1'].includes(a.ref)).length, 0)
})

test('N2 stop while the run waits for the reply: it ends here (no native interrupt of a finished turn), the grant is released, the task stays resumable', async t => {
  const w = world(t)
  const first = await w.send(MSG); await w.subjective()
  const out = await w.chat.interrupt({ conversationId: first.conversationId, runId: first.runId })
  assert.equal(out.accepted, true)
  assert.deepEqual([w.runs()[0].status, w.runs()[0].replyOpen ?? null], ['interrupted', null])
  assert.equal(w.calls.some(c => c.method === 'turn/interrupt'), false)
  assert.ok(w.uiKinds.includes('cancel'), 'the Card grant of the run was released')
  assert.deepEqual(w.events.filter(e => e.event === 'run.completed').map(e => e.details.status), ['interrupted'], 'the reply closes with the run')
  // the task itself is still paused: the next message is an ordinary new turn that resumes it before its native turn (the c12 path)
  const next = await w.send('두 번째 사업자로')
  assert.equal(next.inRun, undefined)
  assert.deepEqual([w.note().status, w.acts.length, w.runs().length], ['done', 2, 2])
  await w.subjective()
})

test('N3 no reply within the task lifetime (30 min): the run ends normally and closes the reply; nothing is acted on meanwhile', async t => {
  const w = world(t, { virtual: true })
  await w.send(MSG); const question = await w.subjective()
  await w.advance(29 * 60 * 1000, { settleEvery: 60 })
  assert.deepEqual([w.runs()[0].status, Boolean(w.runs()[0].replyOpen)], ['inProgress', true])
  await w.advance(2 * 60 * 1000, { settleEvery: 12 })
  assert.deepEqual([w.runs()[0].status, w.runs()[0].replyOpen ?? null, w.acts.length], ['completed', null, 0])
  assert.deepEqual(w.posted(), [question]); assert.deepEqual(w.events.filter(e => e.event === 'run.completed').map(e => e.details.status), ['completed'])
  assert.ok(w.uiKinds.includes('cancel'))
})

test('N4 the in-run reply is not about the task ("취소할래" / something else): the task does not act; the subjective model answers the reply in the same run', async t => {
  for (const [message, taskStatus] of [['취소할래', 'cancelled'], ['점심 뭐 먹지', 'paused']]) {
    const w = world(t)
    await w.send(MSG); await w.subjective()
    const id = w.chat.browserTaskFacts(DM).taskId
    assert.equal((await w.send(message)).inRun, true)
    assert.deepEqual([w.note(), w.acts.length, w.turnIds.length], [null, 0, 2], 'a second native turn with the reply and no note')
    const answer = await w.subjective()
    assert.equal(answer, '(일반 답변)')
    assert.deepEqual([w.runs().length, w.runs()[0].status, w.chat.browserTaskStore.get(id).status], [1, 'completed', taskStatus])
    assert.deepEqual(w.history().map(r => r[0]), ['user', 'assistant', 'user', 'assistant'])
  }
})

test('N5 without the heartbeat flag (held messages only): the c12 behaviour, the run ends with the question and the reply is the next turn', async t => {
  const w = world(t, { flow: false })
  await w.send(MSG); const question = await w.subjective()
  assert.deepEqual([w.runs()[0].status, w.runs()[0].replyOpen ?? null, w.replyEvents().length], ['completed', null, 0])
  const reply = await w.send('두 번째 사업자로')
  assert.equal(reply.inRun, undefined)
  const report = await w.subjective()
  assert.deepEqual(w.history(), [['user', MSG], ['assistant', question], ['user', '두 번째 사업자로'], ['assistant', report]])
  assert.equal(w.runs().length, 2)
})

test('N6 the native turn of the reply fails to start: the run ends as failed, the reply is kept, nothing more is acted on', async t => {
  const w = world(t)
  await w.send(MSG); await w.subjective()
  w.failNextTurn()
  assert.equal((await w.send('두 번째 사업자로')).inRun, true)
  assert.deepEqual([w.runs().length, w.runs()[0].status, w.runs()[0].replyOpen ?? null], [1, 'failed', null])
  assert.deepEqual(w.history().map(r => r[0]), ['user', 'assistant', 'user'])
  assert.equal(w.acts.length, 2, 'the task had already done its part; no retry')
})

test('N7 the composer names the run it replies to (inRunReplyTo): the open run takes it; a stale or wrong target is refused and nothing is stored or started', async t => {
  const w = world(t)
  const first = await w.send(MSG); await w.subjective()
  await assert.rejects(() => w.send('두 번째 사업자로', { extra: { inRunReplyTo: 'turn-999' } }), e => e.code === 'INRUN_REPLY_UNAVAILABLE')
  assert.deepEqual([w.acts.length, w.turnIds.length, w.history().length, Boolean(w.runs()[0].replyOpen)], [0, 1, 2, true])
  const reply = await w.send('두 번째 사업자로', { extra: { inRunReplyTo: first.runId } })
  assert.deepEqual([reply.inRun, w.note().status, w.acts.length], [true, 'done', 2])
  await w.subjective()
  // once the run has ended, a reply aimed at it is refused instead of becoming a second turn
  await assert.rejects(() => w.send('하나 더', { extra: { inRunReplyTo: first.runId } }), e => e.code === 'INRUN_REPLY_UNAVAILABLE')
  assert.equal(w.turnIds.length, 2)
})

test('N8 two questions in one run: each is one completed message with its own open reply; three native turns, one run, one task', async t => {
  const pick = (choices, evidence, url, ctx) => {
    const has = text => choices.find(c => c.value.includes(text))?.value
    if (/\/download\//.test(url)) return { next: 'goal_met', goalMet: 0.95 }
    if (url.endsWith('/invoices')) return /두 번째/.test(ctx) ? has('987-65') : 'needs_user_context'
    return /11월/.test(ctx) ? has('11월') : 'needs_user_context'
  }
  const w = world(t, { pick, patch: p => { p[`${O}/biz/2`] = [el('m1', 'link', '10월 세금계산서 다운로드', { href: `${O}/download/1.pdf` }), el('m2', 'link', '11월 세금계산서 다운로드', { href: `${O}/download/2.pdf` })] } })
  const first = await w.send(MSG)
  const id = w.note().id
  const q1 = await w.subjective()
  assert.equal((await w.send('두 번째 사업자로')).inRun, true)
  assert.deepEqual([w.note().status, w.note().code, w.note().id, w.acts.length], ['need_context', 'choice_needed', id, 1], 'the same task asks again after one page')
  const q2 = await w.subjective()
  const open = w.runs()[0]
  assert.deepEqual([open.status, open.replyOpen.messageId, w.runs().length], ['inProgress', open.messages.filter(m => m.role === 'assistant').at(-1).id, 1])
  assert.equal((await w.send('11월 걸로')).inRun, true)
  assert.deepEqual([w.note().status, w.note().id], ['done', id])
  const report = await w.subjective()
  assert.deepEqual(w.history(), [['user', MSG], ['assistant', q1], ['user', '두 번째 사업자로'], ['assistant', q2], ['user', '11월 걸로'], ['assistant', report]])
  assert.deepEqual([w.runs().length, w.runs()[0].status, w.runs()[0].runId, w.turnIds.length], [1, 'completed', first.runId, 3])
  assert.deepEqual(w.acts.map(a => a.url), [`${O}/biz/2`, `${O}/download/2.pdf`])
  assert.deepEqual(w.replyEvents(), ['reply.opened', 'reply.closed', 'reply.opened', 'reply.closed'])
  assert.equal(w.deltas().length, 3, 'three assistant messages, each whole')
})

test('N9 the task that finishes inside the held-open run still hands its content-minimal outcome to the memory sink, once, with the settled choice', async t => {
  const written = []
  const memory = async () => ({ packet: null, pages: [], scope: null })
  const w = world(t, { entry: { memory, outcomeSink: async (candidate, args) => { written.push({ candidate, pages: args.memoryPages.length }); return { status: 'stored' } } } })
  await w.send(MSG); await w.subjective()
  assert.equal(written.length, 0, 'a question is not an outcome')
  assert.equal((await w.send('두 번째 사업자로')).inRun, true)
  await w.subjective()
  assert.equal(written.length, 1)
  const { candidate } = written[0]
  assert.deepEqual([candidate.outcome, candidate.host], [{ status: 'done' }, 'portal.example.test'])
  assert.match(candidate.text, /선택: 사업자 987-65-43210 @ \/invoices \[choice_needed\]/)
  assert.doesNotMatch(candidate.text, /두 번째|https?:|\?/, 'the reply text and URLs are not in the record')
  assert.equal(w.memoryCalls.length, 1, 'memory was fetched once, for the request; the in-run reply fetches nothing')
})

// ---- c15: the resume judgment reads the question the Agent actually asked (R1), in both reply paths ----
test('Q1 the resume request carries the posted question (bounded), in-run and as a next turn; it never carries a page address', async t => {
  for (const flow of [true, false]) {
    const w = world(t, { flow })
    await w.send(MSG)
    const question = await w.subjective()
    await w.send('두 번째 사업자로')
    const resume = w.decisions.find(d => d.q === 'task_resume')
    assert.ok(resume, `flow=${flow}: a resume judgment was made`)
    assert.ok(resume.input.includes(`Asked: ${question}`), `flow=${flow}: the question as posted`)
    assert.match(resume.input, /Paused because: need_context \(choice_needed\)\nAsked: .+\nUser message: 두 번째 사업자로/)
    assert.doesNotMatch(resume.input, /https?:|example\.test\/|\/invoices/)
    assert.equal(w.note().status, 'done')
  }
})
