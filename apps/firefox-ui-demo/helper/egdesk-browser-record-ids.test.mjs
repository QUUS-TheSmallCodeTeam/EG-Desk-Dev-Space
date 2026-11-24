import test from 'node:test'
import assert from 'node:assert/strict'
import { buildReflexCandidates } from './egdesk-browser-reflex.mjs'
import { hrefIdentifiers, outcomeCandidate, parseOutcomeText, recordedChoice, sameByCode } from './egdesk-browser-task-memory.mjs'
import { createBrowserTaskStore, createDirectBrowserEntry, textNearIdentifier } from './egdesk-browser-task.mjs'
import { entryAnswersOf } from './egdesk-browser-entry.fixture.mjs'

// L8 c20 (owner decisions on c19): (2) the record keeps the digits of the chosen link's address; (3) the finished task's note carries the
// page text code located next to the task's identifier. Synthetic pages; nothing is sent.
const S = 'https://shop.example.test'
const GOAL = '홍길동 고객 주문 배송 상태 확인해줘'
const row = (ref, no) => ({ ref, role: 'link', label: '배송 조회', tag: 'a', href: `${S}/orders/${no}/tracking`, value: '' })
const LIST = { cardId: 'card', documentId: 'd', revision: 1, url: `${S}/orders`, readyState: 'complete', text: ['주문 내역'], interactiveElements: [row('r1', '2026-1118-0007'), row('r2', '2026-1119-0042')] }

test('the record line keeps the chosen link\'s address digits (digits only, at most three) and reads them back; an older line still reads', () => {
  const c = outcomeCandidate({ taskId: 'bt_0123456789ab', goal: GOAL, host: 'shop.example.test', now: Date.parse('2026-11-19T09:00:00Z'), outcome: { status: 'done' },
    trail: [{ op: 'open', label: '배송 조회', from: '/orders', to: '/orders/2026-1119-0042/tracking' }], resolved: [{ asked: 'choice_needed', chose: '배송 조회', at: '/orders', ids: ['202611190042', 'x1', '1234'] }] })
  assert.match(c.text, /^선택: 배송 조회 @ \/orders \[choice_needed\] #202611190042$/m, 'only well-formed digit runs are written')
  assert.deepEqual(parseOutcomeText(c.text).resolved, [{ asked: 'choice_needed', chose: '배송 조회', at: '/orders', ids: ['202611190042'] }])
  assert.deepEqual(parseOutcomeText(c.text.replace(' #202611190042', '')).resolved, [{ asked: 'choice_needed', chose: '배송 조회', at: '/orders' }])
  assert.deepEqual(hrefIdentifiers(`${S}/orders/2026-1119-0042/tracking`), ['202611190042'])
  assert.deepEqual(hrefIdentifiers(`${S}/track?no=202611190042&lang=ko`), ['202611190042'])
})

test('two rows both labelled "배송 조회": the record\'s address digits pick the right one by code; without them the person is asked which', () => {
  const options = buildReflexCandidates(LIST).options
  const prior = ids => ({ goal: GOAL, host: 'shop.example.test', day: '2026-10-19', outcome: { status: 'done' }, trail: [], resolved: [{ asked: 'choice_needed', chose: '배송 조회', at: '/orders', ...(ids ? { ids } : {}) }] })
  const byIds = recordedChoice(prior(['202611190042']), LIST, options, { goal: GOAL })
  assert.deepEqual([byIds.kind, byIds.option.item.element.ref], ['one', 'r2'])
  assert.equal(recordedChoice(prior(null), LIST, options, { goal: GOAL }).kind, 'several', 'equal labels without identifiers: the person decides')
  // identifiers decide over equal labels
  assert.equal(sameByCode('배송 조회', '배송 조회', { recordedIds: ['202611190042'], labelIds: ['202611180007'] }), 'different')
  assert.equal(sameByCode('배송 조회', '배송 조회'), 'same')
})

test('the finished task\'s note carries the text next to its identifier, bounded, only where the run may receive page text', async () => {
  const detail = ['주문 2026-1119-0042', '휴대폰 케이스', '배송 상태: 배송 중 (11월 21일 도착 예정)', '고객센터 1588-0000', '반품 안내']
  assert.deepEqual(textNearIdentifier(detail, ['202611190042']), ['주문 2026-1119-0042', '휴대폰 케이스', '배송 상태: 배송 중 (11월 21일 도착 예정)'])
  assert.deepEqual(textNearIdentifier(detail, ['202611180007']), [], 'not on the page: code never guesses a status')
  assert.deepEqual(textNearIdentifier(detail, []), [])
  assert.ok(textNearIdentifier(['주문 2026-1119-0042', '가'.repeat(120), '나'.repeat(120)], ['202611190042']).join('').length <= 240)
  const run = async allowed => {
    const provider = { directEntryEnabled: () => true, reflexScope: () => ({ client: { decide: async r => ({ answers: entryAnswersOf(r.questions) }) }, authorizeDispatch: () => true, isDecisionCurrent: () => true }),
      runDirectTask: async () => ({ outcome: 'done', steps: [{ url: `${S}/orders`, actions: [{ ok: true, tool: 'egdesk_browser_navigate' }], opened: { option: '[L2] 배송 조회', to: `${S}/orders/2026-1119-0042/tracking` } }], text: detail, state: null }) }
    const store = createBrowserTaskStore()
    const entry = createDirectBrowserEntry({ provider, store, pageTextInNote: () => allowed })
    const out = await entry.handle({ run: { runId: 'r', browserBinding: { cards: [{ cardId: 'card', permission: 'interact' }] } }, conversationKey: 'dm', message: GOAL, hosts: { card: 'shop.example.test' } })
    return JSON.parse(out.note).egdesk_browser_task
  }
  // the identifier comes from the address of the link this run opened (no record needed)
  assert.deepEqual((await run(true)).found, ['주문 2026-1119-0042', '휴대폰 케이스', '배송 상태: 배송 중 (11월 21일 도착 예정)'])
  assert.equal((await run(false)).found, undefined, 'the run may not receive page text: nothing of the page in the note')
})
