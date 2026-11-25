// L8 c37: the browser slice of the open-item registry (helper/egdesk-browser-open-items.mjs). Fake Decision model, fake provider: no model, no page, no network.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createBrowserTaskStore, createDirectBrowserEntry, subjectiveNote } from './egdesk-browser-task.mjs'
import { MAX_ITEM_SUMMARY, OPEN_ITEM_KIND, createBrowserOpenItems, decideOpenItem, openItemOf, openItemOptions, openItemQuestions, openItemState, openItemSummary, optionQuestionName, readOpenItem, settledNote } from './egdesk-browser-open-items.mjs'

const NOW = Date.parse('2026-11-25T10:00:00Z')
const P = p => ({ type: 'predicate', probability: p })
const answersOf = map => Object.fromEntries(Object.entries(map).map(([id, p]) => [optionQuestionName(id), P(p)]))

function pausedTask(store, { kind = 'cannot_proceed', code = 'human_step', cardId = 'card', question = null } = {}) {
  const task = store.create({ conversationKey: 'dm', cardId, goal: '회의실 대관 신청해줘' })
  task.status = 'paused'; task.pause = { kind, code }; task.steps = 2; task.actions = { fill: 0, navigate: 1, scroll: 0 }; task.state = { step: 2 }; task.question = question
  return task
}

test('state and options: waiting, handed over, stuck, running; the options are the ones code can apply; change only with in-run messages', () => {
  const store = createBrowserTaskStore({ now: () => NOW })
  const waiting = pausedTask(store, { kind: 'need_context', code: 'choice_needed' })
  assert.equal(openItemState(waiting), 'waiting'); assert.deepEqual(openItemOptions(waiting), ['continue', 'abandon', 'ask_page'])
  const handed = pausedTask(store); assert.equal(openItemState(handed), 'handed_over'); assert.deepEqual(openItemOptions(handed), ['continue', 'retry', 'abandon', 'ask_page'])
  assert.deepEqual(openItemOptions(handed, { change: true }), ['continue', 'retry', 'abandon', 'ask_page', 'change'])
  const login = pausedTask(store, { code: 'login_required' }); assert.equal(openItemState(login), 'handed_over')
  const stuck = pausedTask(store, { code: 'error_page' }); assert.equal(openItemState(stuck), 'stuck'); assert.deepEqual(openItemOptions(stuck), ['continue', 'retry', 'abandon', 'ask_page'])
  const running = store.create({ conversationKey: 'dm', cardId: 'card', goal: '배송 알려줘' }); assert.equal(openItemState(running), 'running'); assert.deepEqual(openItemOptions(running), ['abandon', 'ask_page'])
  const done = store.create({ conversationKey: 'dm', cardId: 'card', goal: 'x' }); done.status = 'done'
  assert.equal(openItemState(done), null); assert.deepEqual(openItemOptions(done), []); assert.equal(openItemOf(done), null)
})

test('the item: kind browser_task, the person\'s own request quoted (bounded), the closed state and code, the steps; no page text, label or address', () => {
  const store = createBrowserTaskStore({ now: () => NOW })
  const task = pausedTask(store, { code: 'human_step' })
  const item = openItemOf(task)
  assert.deepEqual([item.provider, item.kind, item.id, item.state, item.options.map(o => o.id)], ['browser', OPEN_ITEM_KIND, task.taskId, 'handed_over', ['continue', 'retry', 'abandon', 'ask_page']])
  assert.equal(item.summary, 'Browser task "회의실 대관 신청해줘": handed_over (human_step), 2 steps done.')
  task.goal = `"${'긴 요청 '.repeat(100)}"`
  assert.ok(openItemSummary(task).length <= MAX_ITEM_SUMMARY)
  assert.ok(!openItemSummary(task).includes('"긴') || openItemSummary(task).includes("'긴"), 'quotes inside the goal cannot break the quoting')
  task.pause = { kind: 'cannot_proceed', code: 'bad code with https://x.test/a b' }
  assert.equal(openItemSummary(task).includes('https://'), false, 'a code that is not a closed word is not carried')
  assert.ok(Object.isFrozen(item) && Object.isFrozen(item.options))
})

test('questions: one yes/no predicate per option named open_browser_<id>, each quoting the message (R4) and, for continue and change, what was asked; no catch-all option (R2)', () => {
  const store = createBrowserTaskStore({ now: () => NOW })
  const task = pausedTask(store, { question: '약관에 동의하고 신청서 제출을 눌러 주세요.' })
  const qs = openItemQuestions(task, '했어 "방금"', { change: true })
  assert.deepEqual(qs.map(q => [q.type, q.name]), ['continue', 'retry', 'abandon', 'ask_page', 'change'].map(id => ['predicate', `open_browser_${id}`]))
  assert.ok(qs.every(q => q.instructions.includes(`"했어 '방금'"`)), 'the message is quoted, inner quotes neutralised')
  assert.ok(qs[0].instructions.includes('the question "약관에 동의하고 신청서 제출을 눌러 주세요."'))
  assert.ok(!qs.some(q => /none of|other|else/i.test(q.instructions)), 'no catch-all')
  assert.deepEqual(openItemQuestions(store.create({ conversationKey: 'x', cardId: 'c', goal: 'g' }), 'hi').map(q => q.name), ['open_browser_abandon', 'open_browser_ask_page'], 'a running task: only what code can apply while it runs')
})

test('read (R5): exactly one option yes at the product\'s done bar and every other decided no -> settled; all no -> none; anything else -> uncertain and nothing is applied', () => {
  const store = createBrowserTaskStore({ now: () => NOW })
  const task = pausedTask(store)
  const read = map => readOpenItem(answersOf(map), task)
  assert.deepEqual(read({ continue: 0.97, retry: 0.04, abandon: 0.01, ask_page: 0.02 }), { kind: 'settled', optionId: 'continue', p: { continue: 0.97, retry: 0.04, abandon: 0.01, ask_page: 0.02 } })
  assert.equal(read({ continue: 0.2, retry: 0.96, abandon: 0.01, ask_page: 0.02 }).kind, 'uncertain', 'a 0.2 is not a decided no')
  assert.equal(read({ continue: 0.96, retry: 0.9, abandon: 0.01, ask_page: 0.02 }).kind, 'uncertain', 'two yes')
  assert.equal(read({ continue: 0.8, retry: 0.05, abandon: 0.01, ask_page: 0.02 }).kind, 'uncertain', 'under the 0.85 bar')
  assert.equal(read({ continue: 0.05, retry: 0.04, abandon: 0.01, ask_page: 0.02 }).kind, 'none')
  assert.equal(readOpenItem({ ...answersOf({ continue: 0.96, retry: 0.04, abandon: 0.01 }) }, task).kind, 'uncertain', 'an option with no answer is unknown, not no')
  assert.equal(readOpenItem({}, task).kind, 'uncertain')
  const changeable = readOpenItem(answersOf({ continue: 0.03, retry: 0.04, abandon: 0.01, ask_page: 0.02, change: 0.95 }), task, { change: true })
  assert.deepEqual([changeable.kind, changeable.optionId], ['settled', 'change'])
})

test('decideOpenItem: one request, the evidence is the closed summary + what was asked + the message; the answers are read by the same rule', async () => {
  const store = createBrowserTaskStore({ now: () => NOW })
  const task = pausedTask(store, { question: '직접 로그인해 주세요.', code: 'login_required' })
  const sent = []
  const client = { decide: async request => { sent.push(request); return { answers: answersOf({ continue: 0.96, retry: 0.03, abandon: 0.01, ask_page: 0.02 }), usage: { input_tokens: 90 } } } }
  const out = await decideOpenItem({ message: '했어', task, client })
  assert.equal(sent.length, 1); assert.deepEqual(sent[0].questions.map(q => q.name), ['continue', 'retry', 'abandon', 'ask_page'].map(optionQuestionName))
  assert.equal(sent[0].input[1].content, 'Browser task "회의실 대관 신청해줘": handed_over (login_required), 2 steps done.\nAsked: 직접 로그인해 주세요.\nUser message: 했어')
  assert.deepEqual([out.kind, out.optionId, out.usage, Number.isFinite(out.ms)], ['settled', 'continue', { input_tokens: 90 }, true])
})

test('the store: active() is the newest live task (running or paused inside the TTL); retry() restarts the step memory and budget, keeps the goal, the settled choices and what the person said, and refuses a task without a card', () => {
  let at = NOW
  const store = createBrowserTaskStore({ now: () => at })
  assert.equal(store.active('dm'), null)
  const task = pausedTask(store); task.resolved = [{ asked: 'choice_needed', chose: 'x' }]; task.userContext = ['나는 B동이야']
  assert.equal(store.active('dm'), task); assert.equal(store.active('other'), null)
  assert.equal(store.retry(task), true)
  assert.deepEqual([task.status, task.pause, task.state, task.steps, task.actions, task.goal, task.resolved.length, task.userContext], ['running', null, null, 0, { fill: 0, navigate: 0, scroll: 0 }, '회의실 대관 신청해줘', 1, ['나는 B동이야']])
  const noCard = pausedTask(store, { cardId: null, kind: 'need_context', code: 'card_choice_needed' }); noCard.conversationKey = 'dm2'
  assert.equal(store.retry(noCard), false)
  at += 31 * 60 * 1000; assert.equal(store.active('dm'), null, 'past the TTL it is not open any more')
})

// ---- the entry: the settled option is applied by code before the engine turn ----
function entryWorld({ runs, openItems = () => true, inRun = () => false, observed = ['로그인이 필요합니다.', '로그인 후 예매 내역을 볼 수 있습니다.'], cardText = () => true, answers }) {
  const store = createBrowserTaskStore({ now: () => NOW })
  const calls = { decide: [], runs: [], observe: 0 }
  const client = { decide: async request => { calls.decide.push(request); return { answers: answers(request) } } }
  const provider = {
    directEntryEnabled: () => true,
    reflexScope: () => ({ client, isDecisionCurrent: () => true, authorizeDispatch: undefined, callTool: async name => { if (name === 'egdesk_browser_observe') { calls.observe++; return { snapshot: { text: observed } } } return { status: 'ok' } } }),
    runDirectTask: async (_run, args) => { calls.runs.push({ goal: args.goal, userContext: [...args.userContext], resumeState: args.resumeState, maxSteps: args.maxSteps }); return runs.shift() },
  }
  const entry = createDirectBrowserEntry({ provider, store, now: () => NOW, openItems, inRunChange: inRun, cardTextInEntry: cardText, pageTextInNote: () => true })
  const run = { runId: 'r1', browserBinding: { cards: [{ cardId: 'card', permission: 'interact' }] } }
  const handle = (message, extra = {}) => entry.handle({ run, conversationKey: 'dm', message, hosts: { card: 'ticket.example.test' }, titles: { card: '예매' }, ...extra })
  return { store, calls, entry, handle, run }
}
const entryAnswers = { browser_entry: { type: 'predicate', probability: 0.97 }, browser_entry_answer: { type: 'predicate', probability: 0 }, browser_entry_card_0: { type: 'predicate', probability: 0.95 } }
const WALL = { outcome: 'handoff', pageState: 'login_required', steps: [{ url: 'https://ticket.example.test/my/bookings', actions: [] }], state: { seen: 1 } }
const DONE = { outcome: 'done', steps: [{ url: 'https://ticket.example.test/my/bookings/9001', actions: [] }], text: ['별빛 콘서트', '공연일: 2026-12-20'], state: { seen: 2 } }
const optionAnswers = picked => request => Object.fromEntries(request.questions.map(q => [q.name, P(q.name === optionQuestionName(picked) ? 0.96 : 0.03)]))
const none = () => request => Object.fromEntries(request.questions.map(q => [q.name, P(0.03)]))

async function startWall(w) {
  const first = await w.handle('내 다음 공연 예매 내역 알려줘', { entryAnswers })
  assert.deepEqual([first.handled, first.status, JSON.parse(first.note).egdesk_browser_task.code], [true, 'paused', 'login_required'])
  w.store.noteQuestion(w.store.paused('dm'), '직접 로그인해 주시면 이어서 확인할게요.')
  return first
}

test('continue: after the hand-over the person says "했어": ONE request settles it, code resumes the loop from where it stopped (the page after their step), with what they said as context; the engine gets the finished note', async () => {
  const w = entryWorld({ runs: [WALL, DONE], answers: optionAnswers('continue') })
  await startWall(w)
  const before = w.calls.decide.length
  const out = await w.handle('했어')
  assert.equal(w.calls.decide.length - before, 1, 'one request for the whole decision')
  assert.deepEqual(w.calls.decide.at(-1).questions.map(q => q.name), ['continue', 'retry', 'abandon', 'ask_page'].map(optionQuestionName))
  assert.deepEqual([out.handled, out.status, out.resumed, out.settled], [true, 'done', true, 'continue'])
  assert.equal(w.calls.runs.length, 2, 'the loop ran again, not a new task')
  assert.deepEqual(w.calls.runs[1].resumeState, { seen: 1 }, 'from the step memory of the hand-over')
  assert.deepEqual(w.calls.runs[1].userContext, ['했어'])
  assert.deepEqual(JSON.parse(out.note).egdesk_browser_task.page, ['별빛 콘서트', '공연일: 2026-12-20'])
})

test('retry: step memory and budget start over, same goal; nothing of the first segment is carried as state', async () => {
  const w = entryWorld({ runs: [WALL, DONE], answers: optionAnswers('retry') })
  await startWall(w)
  const out = await w.handle('다시 해줘')
  assert.deepEqual([out.handled, out.status, out.settled], [true, 'done', 'retry'])
  assert.deepEqual([w.calls.runs[1].resumeState, w.calls.runs[1].userContext, w.calls.runs[1].goal], [null, [], '내 다음 공연 예매 내역 알려줘'])
})

test('abandon: the task is cancelled by code, no loop runs, the engine gets a closed note that says so; the conversation has no open item afterwards', async () => {
  const w = entryWorld({ runs: [WALL], answers: optionAnswers('abandon') })
  await startWall(w)
  const out = await w.handle('아냐 됐어')
  assert.deepEqual([out.handled, out.status, out.settled, w.calls.runs.length], [true, 'cancelled', 'abandon', 1])
  const note = JSON.parse(out.note).egdesk_browser_task
  assert.deepEqual([note.status, note.settled, note.next, note.code, note.page], ['cancelled', 'abandon', 'tell_user', undefined, undefined])
  assert.equal(w.store.active('dm'), null)
  assert.equal((await w.handle('안녕', { entryAnswers: { ...entryAnswers, browser_entry: P(0.02) } })).handled, false)
})

test('ask_page: the task stays handed over (still resumable), no loop runs and nothing is clicked; the note carries the page\'s own first lines (only where the run may receive page text) and the closed state', async () => {
  const w = entryWorld({ runs: [WALL], answers: optionAnswers('ask_page') })
  await startWall(w)
  const out = await w.handle('지금 화면에 뭐라고 나와?')
  const note = JSON.parse(out.note).egdesk_browser_task
  assert.deepEqual([out.handled, out.status, out.settled, w.calls.runs.length, w.calls.observe], [true, 'paused', 'ask_page', 1, 1])
  assert.deepEqual([note.status, note.code, note.settled, note.next, note.page], ['cannot_proceed', 'login_required', 'ask_page', 'answer_user', ['로그인이 필요합니다.', '로그인 후 예매 내역을 볼 수 있습니다.']])
  assert.equal(w.store.paused('dm')?.status, 'paused', 'the task is still waiting for the person')
  const closed = entryWorld({ runs: [WALL], answers: optionAnswers('ask_page'), cardText: () => false })
  await startWall(closed)
  const out2 = await closed.handle('지금 화면에 뭐라고 나와?')
  assert.deepEqual([JSON.parse(out2.note).egdesk_browser_task.page, closed.calls.observe], [undefined, 0], 'without page_text permission the page is not read for the note')
})

test('not settled: every option no -> an ordinary turn with the task left as it was; two yes or an undecided option -> nothing applied either (fail closed)', async () => {
  const unrelated = entryWorld({ runs: [WALL], answers: none() })
  await startWall(unrelated)
  assert.deepEqual(await unrelated.handle('고마워. 파이썬 정렬은?'), { handled: false, reason: 'unrelated' })
  assert.equal(unrelated.store.paused('dm')?.status, 'paused'); assert.equal(unrelated.calls.runs.length, 1)
  const two = entryWorld({ runs: [WALL], answers: request => Object.fromEntries(request.questions.map(q => [q.name, P(['open_browser_continue', 'open_browser_ask_page'].includes(q.name) ? 0.95 : 0.02)])) })
  await startWall(two)
  assert.deepEqual(await two.handle('했어, 지금 화면은?'), { handled: false, reason: 'uncertain' })
  assert.equal(two.calls.runs.length, 1); assert.equal(two.store.paused('dm')?.status, 'paused')
})

test('flag off: the entry is exactly what it was (the resume judgment, no open-item request); a registry that already decided is applied with no request of its own', async () => {
  const off = entryWorld({ runs: [WALL], openItems: () => false, answers: request => (request.questions.some(q => q.name === 'task_resume') ? { task_resume: { type: 'choice', choice: 'unrelated', confidence: 0.95, probabilities: [{ value: 'unrelated', probability: 0.95 }] } } : {}) })
  await startWall(off)
  const before = off.calls.decide.length
  assert.deepEqual(await off.handle('했어'), { handled: false, reason: 'unrelated' })
  assert.deepEqual(off.calls.decide.slice(before).map(r => r.questions.map(q => q.name)), [['task_resume']])
  const registry = entryWorld({ runs: [WALL, DONE], openItems: () => false, answers: () => ({}) })
  await startWall(registry)
  const n = registry.calls.decide.length
  const out = await registry.handle('했어', { openItemRead: { kind: 'settled', optionId: 'continue', p: { continue: 0.97 } } })
  assert.deepEqual([out.status, out.settled, registry.calls.decide.length - n], ['done', 'continue', 0], 'the registry\'s own request decided; the entry sends none')
  const notMine = entryWorld({ runs: [WALL], openItems: () => false, answers: () => ({}) })
  await startWall(notMine)
  assert.deepEqual(await notMine.handle('고마워', { openItemRead: { kind: 'none', p: {} } }), { handled: false, reason: 'unrelated' })
})

test('the provider contract for the registry: items() is synchronous and read-only, questions() and read() follow the one task, apply() is the entry\'s settle() and returns { handled, note, settled, reason }', async () => {
  const w = entryWorld({ runs: [WALL, DONE], answers: optionAnswers('continue') })
  const provider = createBrowserOpenItems({ store: w.store, entry: w.entry })
  assert.deepEqual([provider.id, provider.items('dm')], ['browser', []])
  await startWall(w)
  const items = provider.items('dm')
  assert.deepEqual([items.length, items[0].kind, items[0].state, items[0].options.map(o => o.id)], [1, 'browser_task', 'handed_over', ['continue', 'retry', 'abandon', 'ask_page']])
  assert.ok(items[0].summary.length <= 300 && !items[0].summary.includes('로그인'))
  assert.deepEqual(provider.questions('dm', '했어').map(q => q.name), ['continue', 'retry', 'abandon', 'ask_page'].map(optionQuestionName))
  assert.deepEqual(provider.questions('nobody', '했어'), [])
  const read = provider.read(answersOf({ continue: 0.97, retry: 0.02, abandon: 0.01, ask_page: 0.02 }), 'dm')
  assert.deepEqual([read.kind, read.optionId, read.itemId], ['settled', 'continue', items[0].id])
  const out = await provider.apply({ run: w.run, conversationKey: 'dm', optionId: 'continue', message: '했어', hosts: { card: 'ticket.example.test' }, titles: { card: '예매' } })
  assert.deepEqual([out.handled, out.settled, out.status, out.resumed, JSON.parse(out.note).egdesk_browser_task.status], [true, 'continue', 'done', true, 'done'])
  assert.deepEqual(await provider.apply({ run: w.run, conversationKey: 'nobody', optionId: 'continue', message: 'x' }), { handled: false, settled: 'continue', reason: 'no_task', status: null, resumed: false })
  assert.throws(() => createBrowserOpenItems({ store: {}, entry: {} }), TypeError)
})

test('abandon of a RUNNING task aborts its segment; ask_page of a running task reads its state without touching it', async () => {
  const w = entryWorld({ runs: [], answers: none() })
  const task = w.store.create({ conversationKey: 'dm', cardId: 'card', goal: '배송 알려줘' })
  let aborted = false; task.abort = { abort: () => { aborted = true } }; task.liveStep = 2
  const asked = await w.entry.settle({ run: w.run, conversationKey: 'dm', optionId: 'ask_page', message: '어디까지 했어?', hosts: { card: 'h.example.test' } })
  assert.deepEqual([asked.handled, asked.status, JSON.parse(asked.note).egdesk_browser_task.status, task.status], [true, 'running', 'running', 'running'])
  const out = await w.entry.settle({ run: w.run, conversationKey: 'dm', optionId: 'abandon', message: '그만', hosts: { card: 'h.example.test' } })
  assert.deepEqual([out.handled, out.status, aborted, task.status], [true, 'cancelled', true, 'cancelled'])
})

test('the closed note of a settled state is data only: status, code, settled, steps, actions, next (+ page lines when given)', () => {
  const store = createBrowserTaskStore({ now: () => NOW })
  const task = pausedTask(store, { code: 'human_step' })
  assert.deepEqual(JSON.parse(settledNote(task, 'ask_page', { lines: ['a', 'b'] })).egdesk_browser_task, { id: task.taskId, status: 'cannot_proceed', code: 'human_step', settled: 'ask_page', page: ['a', 'b'], stepsDone: 2, actions: { fill: 0, navigate: 1, scroll: 0 }, next: 'answer_user' })
  void subjectiveNote
})
