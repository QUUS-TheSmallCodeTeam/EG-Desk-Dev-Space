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
  [`${O}/otp`]: [el('o2', 'button', '인증 확인')],
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

function world(t, { start = `${O}/invoices`, held = true, entry = {}, pick = null, patch = null } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'egd-c11-')); chmodSync(dir, 0o700)
  const store = openChatStore({ dataDir: dir, ownerScope: 'synthetic-c11' })
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }) })
  const pages = PAGES(), flags = { notListed: 0 }
  patch?.(pages)
  const events = [], calls = [], replies = [], decisions = [], acts = [], uiKinds = [], factsDuringActs = [], timeline = []
  let docSeq = 1, turnCount = 0, threadCount = 0, chat = null
  let cur = { url: start, documentId: 'doc1', revision: 1 }
  const snap = () => ({ cardId: 'card', documentId: cur.documentId, revision: cur.revision, url: cur.url, readyState: 'complete', text: ['합성 포털'],
    viewport: { width: 300, height: 200, devicePixelRatio: 1 }, interactiveElements: pages[cur.url] })
  const client = createDecisionClient({
    recipientForKey: (value, endpoint, model) => decisionTopicRecipient(value, 1, endpoint, model), getApiKey: async () => KEY,
    fetchImpl: async (_e, { body }) => {
      const wire = JSON.parse(body), names = wire.questions.map(q => q.name), q0 = wire.questions[0]
      const text = wire.input.map(m => (typeof m.content === 'string' ? m.content : '')).join('\n\n')
      decisions.push({ q: q0.name, names, bytes: Buffer.byteLength(body), image: /input_image|image_url/.test(body) }); timeline.push(`decide:${names.join('+')}`)
      const entryAnswer = q => { const msg = /(?:User message: |Message:\n)(.*)/.exec(text)?.[1] ?? ''
        return choice('browser_entry', /세금계산서/.test(msg) ? starts(q.choices, '[C1]') : 'not_browser_task', 0.95) }
      if (names.includes('tn_courtesy')) { // a turn-start triage request, possibly carrying the entry question
        const answers = wire.questions.map(q => (q.name === 'browser_entry' ? entryAnswer(q) : { name: q.name, type: 'predicate', probability: q.name === 'tn_need' ? 0.9 : 0.03 }))
        return { ok: true, text: async () => JSON.stringify({ answers, usage: { input_tokens: 1 } }) }
      }
      if (q0.name === 'browser_entry') return { ok: true, text: async () => JSON.stringify({ answers: [entryAnswer(q0)] }) }
      if (q0.name === 'task_resume') return { ok: true, text: async () => JSON.stringify({ answers: [choice('task_resume', 'resume_task', 0.95)] }) }
      const evidence = wire.input[1].content
      const url = /URL: (\S+)/.exec(evidence)?.[1], ctx = /Context the user gave in the chat \(not page text\):\n([\s\S]*?)\n\n/.exec(evidence)?.[1] ?? ''
      let next, goalMet = 0, pageState = 'content'
      if (/is NOT listed now/.test(evidence)) flags.notListed++
      const listed = /it is listed now as (\[L\d+\] [^\n]*?)\.(?:\n|$)/.exec(evidence)
      if (pick) next = pick(q0.choices, evidence)
      else if (/\/download\//.test(url)) { next = 'goal_met'; goalMet = 0.95 }
      else if (url.endsWith('/otp')) { next = 'blocked'; pageState = 'two_factor_required' }
      else if (/\/invoices/.test(url)) next = listed ? listed[1].trim() : /is NOT listed now/.test(evidence) ? q0.choices.map(c => c.value).find(v => /^\[L1\]/.test(v)) : /두 번째/.test(ctx) ? starts(q0.choices, '987-65') : 'needs_user_context'
      else if (url.endsWith('/single')) next = starts(q0.choices, '111-22')
      else next = starts(q0.choices, '다운로드') ?? 'blocked'
      const answer = choice('next_step', next, 0.95)
      if (next === 'needs_user_context') answer.probabilities.push({ value: starts(q0.choices, '123-45'), probability: 0.02 }, { value: starts(q0.choices, '987-65'), probability: 0.02 })
      return { ok: true, text: async () => JSON.stringify({ answers: [answer, choice('page_state', pageState, 0.95), { name: 'goal_met', type: 'predicate', probability: goalMet }] }) }
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
    respond: (...args) => replies.push(args), emit: e => events.push(e), emitLegacy() {},
    request: async (method, params) => {
      calls.push({ method, params }); timeline.push(`native:${method}`)
      if (method === 'experimentalFeature/list') return { data: ['browser_use', 'browser_use_external', 'computer_use'].map(name => ({ name, enabled: false, stage: 'stable' })), nextCursor: null }
      if (method === 'mcpServerStatus/list') return { data: [], nextCursor: null }
      if (method === 'thread/unsubscribe') return { status: 'unsubscribed' }
      if (method === 'config/read') return { config: { developer_instructions: 'Ordinary instructions' }, layers: [] }
      if (method === 'thread/start') return { thread: { id: `thread-${++threadCount}` }, cwd: '/work', model: 'configured-model', sandbox: { type: 'readOnly', networkAccess: false }, approvalPolicy: 'never' }
      if (method === 'thread/resume') return { thread: { id: params.threadId, turns: [] }, cwd: '/work', sandbox: { type: 'readOnly', networkAccess: false }, approvalPolicy: 'never' }
      if (method === 'turn/start') return { turn: { id: `turn-${++turnCount}`, status: 'inProgress', items: [] } }
      if (method === 'turn/interrupt') return {}
      throw new Error(`Unexpected method: ${method}`)
    },
    decisionContext: { mode: () => 'on', configured: () => true, client, calibrationLog: { record: () => ({}), complete() {} },
      ...(held ? { draftCheck: { mode: () => 'on' } } : {}), conversationFlow: { mode: () => 'on' },
      browserEntry: { mode: () => 'on', ...entry, ...(entry.memory ? { memory: async args => { memoryCalls.push(1); return entry.memory(args) } } : {}) } },
  })
  chat.setConnection(true)
  const source = n => ({ id: 'selected-source', kind: 'browser', selectedByUser: true, browserToolPermission: 'interact',
    sourceRef: { viewId: 'card', profileId: 'fixture', accountId: '', uri: start },
    browserToolIdentity: { cardEpoch: 'epoch', userContextId: 0, engineAccountKey: OWNER, authorityEpoch: 1 },
    browserToolSelection: { token: `token-${n}`, threadId: DM } })
  let n = 0, last = null
  const notify = (method, params) => chat.handleNotification({ method, params })
  const w = { flags, chat, store, events, calls, decisions, acts, uiKinds, timeline, factsDuringActs, memoryCalls,
    setUrl(url) { cur = { url, documentId: `doc${++docSeq}`, revision: 1 } },
    async send(message) { n++
      last = await chat.send({ message, requestId: `req-${n}`, clientThreadId: DM, ...(last ? { conversationId: last.conversationId } : {}), executionPolicy: { mode: 'browserBounded' },
        selectedSources: [source(n)], browserTransportId: 'ui' })
      return last },
    note() { const value = calls.filter(c => c.method === 'turn/start').at(-1).params.additionalContext?.egdesk_browser_task?.value; return value ? JSON.parse(value).egdesk_browser_task : null },
    // The scripted subjective engine: it words the closed note (it has nothing else) and streams like a real turn would.
    async subjective({ beforeTurnEnds = null } = {}) {
      const note = w.note(), timing = { threadId: last.conversationId, turnId: last.runId }
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
      for (let i = 0; i < 6; i++) { await chat.draftCheckIdle(); await chat.flowIdle(); await new Promise(r => setTimeout(r, 2)) }
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

test('R1 need-context round trip, completed messages only: question -> reply -> same task -> one final report; history order holds', async t => {
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
  await w.send('두 번째 사업자로')
  const note2 = w.note()
  assert.deepEqual([note2.status, note2.id, note2.next], ['done', note1.id, 'report_to_user'], 'the reply resumed the same task')
  const report = await w.subjective()
  assert.deepEqual(w.deltas(), [question, report]); assert.deepEqual(w.posted(), [question, report], 'the final report is one completed message too')
  assert.deepEqual(w.history(), [['user', MSG], ['assistant', question], ['user', '두 번째 사업자로'], ['assistant', report]])
  assert.deepEqual(w.acts.map(a => [a.type, a.url]), [['navigate', `${O}/biz/2`], ['navigate', `${O}/download/2.pdf`]])
  assert.deepEqual(w.counts(), { browser_entry: 1, next_step: 4, task_resume: 1 })
  assert.equal(w.decisions.filter(d => d.image).length, 0)
  // each objective phase ran before its native turn: the subjective model only ever worded a finished note
  const order = w.timeline.filter(x => /^(decide:|native:turn\/start)/.test(x))
  assert.deepEqual(order, ['decide:browser_entry', 'decide:next_step+page_state+goal_met', 'native:turn/start', 'decide:task_resume',
    'decide:next_step+page_state+goal_met', 'decide:next_step+page_state+goal_met', 'decide:next_step+page_state+goal_met', 'native:turn/start'])
  // no intermediate-message job started for a browser-task turn (its reply must reach the task, not an in-run steer)
  assert.equal(w.calls.some(c => c.method === 'thread/fork' || c.method === 'turn/steer'), false)

  // progress facts for the heartbeat: read-only, numbers and closed words only
  assert.deepEqual([waiting.status, waiting.active, waiting.phase, waiting.waitingOnUser, waiting.waitingKind, waiting.waitingCode, waiting.stepsDone, waiting.stepsRemaining, waiting.lastActionAgeMs], ['paused', true, 'waiting_user', true, 'need_context', 'choice_needed', 1, 23, null])
  const done = w.chat.browserTaskFacts(DM)
  assert.deepEqual([done.status, done.active, done.phase, done.waitingOnUser, done.stepsDone, done.actions.navigate, done.taskId], ['done', false, null, false, 4, 2, note1.id])
  assert.equal(typeof done.lastActionAgeMs, 'number')
  assert.deepEqual(w.factsDuringActs.map(f => [f.status, f.phase, f.waitingOnUser]), [['running', 'objective_step', false], ['running', 'objective_step', false]])
  assert.ok(w.factsDuringActs[1].stepsDone > w.factsDuringActs[0].stepsDone, 'the step count moves while the loop runs')
  assert.deepEqual(Object.keys(done).sort(), ['actions', 'active', 'ageMs', 'idleMs', 'lastActionAgeMs', 'phase', 'status', 'stepsDone', 'stepsRemaining', 'taskId', 'waitingCode', 'waitingKind', 'waitingOnUser'])
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
  w.setUrl(`${O}/single`) // the person finished the second factor in the card
  await w.send('했어')
  const note2 = w.note()
  assert.deepEqual([note2.status, note2.id], ['done', note1.id])
  const report = await w.subjective()
  assert.deepEqual(w.history(), [['user', MSG], ['assistant', ask], ['user', '했어'], ['assistant', report]])
  assert.deepEqual(w.deltas(), [ask, report]); assert.deepEqual(w.posted(), [ask, report])
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

test('R4 held mode on, not a browser task: an ordinary bounded turn is untouched by this change (still not held)', async t => {
  const w = world(t)
  await w.send('오늘 날씨 어때?')
  assert.equal(w.note(), null)
  const text = await w.subjective()
  assert.ok(w.deltas().length > 1 && w.deltas().join('') === text, 'bounded turns without a browser task keep their existing behaviour')
  assert.equal(w.chat.browserTaskFacts(DM), null)
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
    assert.equal(note.code, guess === 'blocked' ? 'human_step' : 'uncertain', guess)
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
  assert.equal(changed.flags.notListed, 1, 'the step evidence said the earlier choice is not listed')
  assert.deepEqual([changed.note().status, changed.note().code, changed.acts.length], ['need_context', 'choice_needed', 0], 'the model picked [L1] at 0.95; code asked the person instead')
})
