// L8 c44: an ordinal reply to a choice the browser task asked ("두번째") is resolved against the asked list. Fake provider, fake Decision model: nothing real.
import test from 'node:test'
import assert from 'node:assert/strict'
import { choiceContextLine, resolveChoiceReply } from './egdesk-browser-choice-reply.mjs'
import { createBrowserTaskStore, createDirectBrowserEntry } from './egdesk-browser-task.mjs'

const TWO = ['[L1] 사업자 123-45-67890', '[L2] 사업자 987-65-43210'], THREE = [...TWO, '[L3] 사업자 555-55-55555']
const idx = (message, list = TWO) => resolveChoiceReply(message, list)?.index ?? null

test('an ordinal that is the WHOLE reply resolves against the asked list, in every common wording; the noun, a particle and a polite verb may follow', () => {
  for (const m of ['두번째', '두 번째', '둘째', '2번', '2번째', '2 번', '2', '두번째 사업자', '두 번째 사업자로 해 줘', '두번째로 해주세요', '2번으로 할게요', '둘째 거요', '2번이요', '두번째!', '2번.']) assert.equal(idx(m), 1, m)
  for (const m of ['첫번째', '첫 번째', '첫째', '1번', '1번째', '1', '처음', '첫번째 사업자로 해줘']) assert.equal(idx(m), 0, m)
  for (const m of ['세번째', '3번', '셋째', '3']) assert.equal(idx(m, THREE), 2, m)
  for (const m of ['마지막', '맨 마지막', '마지막 거', '마지막으로 해줘', '맨 끝']) { assert.equal(idx(m), 1, m); assert.equal(idx(m, THREE), 2, m) }
  assert.deepEqual(resolveChoiceReply('두번째', TWO), { index: 1, label: '사업자 987-65-43210', how: 'ordinal' }, 'the [L2] option prefix is the loop\'s, the label is the person\'s')
})

test('nothing is guessed: another word, a negation, two ordinals, an ordinal beyond the list, a single candidate, "이번", a position word, an empty or long text -> null', () => {
  for (const m of ['2번 말고', '두번째 말고 첫번째', '1번 아니고 2번', '두번째로 하고 나중에 알려줘', '두번째 사업자 맞아요', '아래 거', '위쪽', '이번', '이번 달', '12번', '21번', '4번', '', '  ', '그거', '응', '둘 다', '두번째인데 확실하지 않아', '2번 하고 1번도', '첫번째 두번째']) assert.equal(idx(m), null, JSON.stringify(m))
  assert.equal(idx('3번', TWO), null, 'an ordinal beyond the list'); assert.equal(idx('2번', ['[L1] 하나']), null, 'one candidate: nothing to choose between'); assert.equal(idx('2번', []), null)
  assert.equal(resolveChoiceReply(undefined, TWO), null); assert.equal(resolveChoiceReply('가'.repeat(60), TWO), null)
})

test('the context line: the resolved choice by name with the asked order, or the reply with the asked list (the order the person saw it); a single candidate or none leaves the reply as it was', () => {
  assert.equal(choiceContextLine('두번째', TWO), 'Chose "사업자 987-65-43210" (option 2 of the options the person was asked to choose between, in this order: 1. 사업자 123-45-67890 / 2. 사업자 987-65-43210); the person said: 두번째')
  assert.equal(choiceContextLine('아래 거', TWO), '아래 거\n(The person had been asked to choose between, in this order: 1. 사업자 123-45-67890 / 2. 사업자 987-65-43210)')
  assert.equal(choiceContextLine('2번 말고', TWO).startsWith('2번 말고\n(The person had been asked'), true)
  assert.equal(choiceContextLine('두번째', ['[L1] 하나']), '두번째'); assert.equal(choiceContextLine('두번째', undefined), '두번째')
})

function world({ results }) {
  const store = createBrowserTaskStore({ now: () => Date.parse('2026-11-25T10:00:00Z') })
  const calls = []
  const client = { decide: async request => ({ answers: Object.fromEntries(request.questions.map(q => [q.name, q.type === 'choice' ? { type: 'choice', choice: 'resume_task', confidence: 0.97, probabilities: [{ value: 'resume_task', probability: 0.97 }] } : { type: 'predicate', probability: 0.02 }])) }) }
  const provider = { directEntryEnabled: () => true, reflexScope: () => ({ client, isDecisionCurrent: () => true, callTool: async () => ({ snapshot: { text: [] } }) }),
    runDirectTask: async (_run, args) => { calls.push({ userContext: [...args.userContext], goal: args.goal }); return results.shift() } }
  const entry = createDirectBrowserEntry({ provider, store, now: () => Date.parse('2026-11-25T10:00:00Z') })
  const run = { runId: 'r1', browserBinding: { cards: [{ cardId: 'card', permission: 'interact' }] } }
  const handle = (message, extra = {}) => entry.handle({ run, conversationKey: 'dm', message, hosts: { card: 'portal.example.test' }, titles: { card: '포털' }, ...extra })
  return { store, calls, handle }
}
const entryAnswers = { browser_entry: { type: 'predicate', probability: 0.97 }, browser_entry_answer: { type: 'predicate', probability: 0 }, browser_entry_card_0: { type: 'predicate', probability: 0.95 } }
const ASKS = { outcome: 'needs_user_context', candidates: TWO, steps: [], state: { n: 1 } }
const DONE = { outcome: 'done', steps: [], text: ['사업자 987-65-43210', '세금계산서 다운로드 완료'], state: { n: 2 } }

test('the entry: the pause keeps the asked candidates in the order of the note; "두번째" reaches the step as the chosen business by name; the list is cleared once used', async () => {
  const w = world({ results: [ASKS, DONE] })
  const first = await w.handle('포털 세금계산서 이번 달 거 받아줘', { entryAnswers })
  assert.deepEqual(JSON.parse(first.note).egdesk_browser_task.candidates, ['사업자 123-45-67890', '사업자 987-65-43210'])
  const task = w.store.paused('dm'); assert.deepEqual(task.askedCandidates, ['사업자 123-45-67890', '사업자 987-65-43210'])
  const out = await w.handle('두번째')
  assert.equal(out.status, 'done')
  assert.deepEqual(w.calls[1].userContext, ['Chose "사업자 987-65-43210" (option 2 of the options the person was asked to choose between, in this order: 1. 사업자 123-45-67890 / 2. 사업자 987-65-43210); the person said: 두번째'])
  assert.deepEqual(task.askedCandidates, [])
})

test('the entry: a reply code cannot resolve ("아래 거", "2번 말고") reaches the step with the asked list in the order the person saw it, so the model decides against it; other pauses and confirmations are untouched', async () => {
  const w = world({ results: [ASKS, DONE] })
  await w.handle('포털 세금계산서 이번 달 거 받아줘', { entryAnswers })
  await w.handle('아래 거')
  assert.deepEqual(w.calls[1].userContext, ['아래 거\n(The person had been asked to choose between, in this order: 1. 사업자 123-45-67890 / 2. 사업자 987-65-43210)'])
  // a pause that is not a choice (free text) keeps the reply as it was
  const free = world({ results: [{ outcome: 'needs_free_text', steps: [], state: {} }, DONE] })
  await free.handle('포털 세금계산서 이번 달 거 받아줘', { entryAnswers }); await free.handle('두번째')
  assert.deepEqual(free.calls[1].userContext, ['두번째'], 'no asked list: the reply is not an ordinal of anything')
  // a single candidate is a confirmation: the existing wording
  const one = world({ results: [{ outcome: 'needs_user_context', candidates: ['[L1] 사업자 123-45-67890'], steps: [], state: {} }, DONE] })
  await one.handle('포털 세금계산서 이번 달 거 받아줘', { entryAnswers }); await one.handle('응')
  assert.deepEqual(one.calls[1].userContext, ['Asked to confirm "사업자 123-45-67890", the user answered: 응'])
})
