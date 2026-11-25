import test from 'node:test'
import assert from 'node:assert/strict'
import { PROPOSAL_BARS, createProposalOpenItems } from './egdesk-open-proposal-items.mjs'
import { buildRegistry } from './egdesk-open-items.mjs'

// L3's proposal registry (chat.openItemsFor / closeOpenItem) as an item of the resolver: the provider reads, decides nothing itself, closes only on a settled reading.
const PROPOSAL = { provider: 'proposals', kind: 'proposal', id: 'p1', text: '이 순서대로 실행해도 될까요?', steps: [{ n: 1, text: '빌드' }, { n: 2, text: '테스트' }, { n: 3, text: '배포' }], options: [] }
const REQUEST = { provider: 'proposals', kind: 'person_request', id: 'q1', text: '로그인하신 뒤 알려주시겠어요?', steps: [], options: [] }
const make = (items, closed = []) => createProposalOpenItems({ chat: { openItemsFor: () => items, closeOpenItem: (cid, id, outcome) => { closed.push([cid, id, outcome]); return true } } })
const key = { cid: 't1' }
const ans = by => Object.fromEntries(Object.entries(by).map(([k, v]) => [k, { type: 'predicate', probability: v }]))

test('items: proposals and waiting actions are proposal items, a request of the person is a question item; other providers\' rows and unknown kinds are not', () => {
  const p = make([PROPOSAL, REQUEST, { provider: 'other', kind: 'proposal', id: 'x', text: 'x' }, { provider: 'proposals', kind: 'weird', id: 'y', text: 'y' }, { provider: 'proposals', kind: 'waiting_action', id: 'w', text: '지울 항목은 2개입니다.', steps: [], options: [] }])
  assert.deepEqual(p.items(key).map(i => [i.id, i.kind]), [['q1', 'question'], ['w', 'proposal']], 'the two most recent of this provider')
  const reg = buildRegistry([make([PROPOSAL])], key); assert.equal(reg[0].kind, 'proposal'); assert.match(reg[0].summary, /Steps: 1\) 빌드 2\) 테스트 3\) 배포/)
  assert.deepEqual(make([]).items(key), [])
})

test('questions: accept and decline per proposal, one question per step quoting that step only; none for a person\'s request', () => {
  const qs = make([PROPOSAL]).questions(key, '응 근데 테스트는 빼고')
  assert.deepEqual(qs.map(q => q.name), ['open_prop_0_accept', 'open_prop_0_decline', 'open_prop_0_skip_1', 'open_prop_0_skip_2', 'open_prop_0_skip_3'])
  assert.ok(qs.every(q => q.instructions.includes('응 근데 테스트는 빼고')))
  assert.ok(qs[3].instructions.includes('테스트') && !qs[3].instructions.includes('빌드') && !qs[3].instructions.includes('배포') && !qs[3].instructions.includes('실행해도'))
  assert.deepEqual(make([REQUEST]).questions(key, '네'), [])
})

test('read: accept with steps left out, plain accept, decline; everything unclear is not applied', () => {
  const p = make([PROPOSAL]), item = { itemId: 'p1' }
  const read = by => p.read(ans(by), key, undefined, item)
  assert.deepEqual(read({ open_prop_0_accept: 0.97, open_prop_0_decline: 0.02, open_prop_0_skip_1: 0.02, open_prop_0_skip_2: 0.95, open_prop_0_skip_3: 0.03 }), { kind: 'settled', itemId: 'p1', optionId: 'accept', skipped: [2] })
  assert.deepEqual(read({ open_prop_0_accept: 0.97, open_prop_0_decline: 0.02, open_prop_0_skip_1: 0.02, open_prop_0_skip_2: 0.02, open_prop_0_skip_3: 0.02 }).skipped, [])
  assert.equal(read({ open_prop_0_accept: 0.02, open_prop_0_decline: 0.96, open_prop_0_skip_1: 0.02, open_prop_0_skip_2: 0.02, open_prop_0_skip_3: 0.02 }).optionId, 'decline')
  const unclear = by => assert.equal(read({ open_prop_0_accept: 0.02, open_prop_0_decline: 0.02, open_prop_0_skip_1: 0.02, open_prop_0_skip_2: 0.02, open_prop_0_skip_3: 0.02, ...by }).kind, 'uncertain', JSON.stringify(by))
  unclear({}); unclear({ open_prop_0_accept: 0.6 }); unclear({ open_prop_0_accept: 0.97, open_prop_0_skip_2: 0.5 }); unclear({ open_prop_0_accept: 0.97, open_prop_0_decline: 0.5 }); unclear({ open_prop_0_accept: 0.97, open_prop_0_decline: 0.97 })
  assert.equal(p.read({}, key, undefined, item).kind, 'uncertain', 'unanswered is not a no')
  assert.equal(p.read(ans({ open_prop_0_accept: 0.97, open_prop_0_decline: 0.02 }), key, undefined, item).kind, 'uncertain', 'a missing step answer is not a no')
  assert.equal(p.read({}, key, undefined, { itemId: 'gone' }).kind, 'none')
  assert.deepEqual(make([REQUEST]).read({}, key, undefined, { itemId: 'q1' }), { kind: 'settled', itemId: 'q1', optionId: 'answer', skipped: [] })
  assert.equal(PROPOSAL_BARS.yes, 0.85)
})

test('apply: closes the item and tells the engine in closed words; nothing else happens', async () => {
  const closed = [], p = make([PROPOSAL], closed), item = { id: 'oi2', itemId: 'p1' }
  assert.deepEqual(await p.apply({ cid: 't1', item, optionId: 'accept', read: { skipped: [2] } }), { handled: true, settled: 'accepted_without_steps', note: 'oi2 accepted_without_steps; steps left out: 2' })
  assert.deepEqual(await p.apply({ cid: 't1', item, optionId: 'accept', read: { skipped: [] } }), { handled: true, settled: 'accepted', note: 'oi2 accepted' })
  assert.equal((await p.apply({ cid: 't1', item, optionId: 'decline', read: { skipped: [] } })).settled, 'declined')
  assert.equal((await p.apply({ cid: 't1', item, optionId: 'answer', read: { skipped: [] } })).settled, 'answered')
  assert.deepEqual(closed.map(c => c[2]), ['accept', 'accept', 'decline', 'answer']); assert.ok(closed.every(c => c[0] === 't1' && c[1] === 'p1'))
})
