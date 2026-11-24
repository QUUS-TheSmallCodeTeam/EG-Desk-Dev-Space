// L8 c30: a finished task whose answer is a fact on the page ("다음 결제일이 언제야?") carries the page's own first lines (bounded, same gate as `found`), so the
// model that writes the reply has the date. Real: holdout2 (c31) finished the hospital task with a note that said only "done".
import test from 'node:test'
import assert from 'node:assert/strict'
import { MAX_PAGE_CHARS, MAX_PAGE_LINES, createBrowserTaskStore, createDirectBrowserEntry, pageLines, subjectiveNote } from './egdesk-browser-task.mjs'
import { HOLDOUT2_PAGES } from './egdesk-browser-live-holdout2.mjs'

const MEMBERSHIP = HOLDOUT2_PAGES.membership['/account/membership'].text
async function finish({ text = MEMBERSHIP, gate = true, openedIds = null, message = '다음 결제일이 언제야?' } = {}) {
  const store = createBrowserTaskStore()
  const provider = { directEntryEnabled: () => true, reflexScope: () => ({ client: { decide: async () => ({ answers: {} }) }, isDecisionCurrent: () => true, callTool: async () => ({ snapshot: { text: [] } }) }),
    runDirectTask: async () => ({ outcome: 'done', text, steps: [{ url: 'https://streamly.example.test/account/membership', actions: [], ...(openedIds ? { opened: { option: '[L1] x', to: 'https://streamly.example.test/o/' + openedIds } } : {}) }], state: null }) }
  const entry = createDirectBrowserEntry({ provider, store, pageTextInNote: () => gate, cardTextInEntry: () => false })
  const out = await entry.handle({ run: { runId: 'r', browserBinding: { cards: [{ cardId: 'card', permission: 'interact' }] } }, conversationKey: 'dm', message, hosts: { card: 'streamly.example.test' }, titles: { card: '멤버십 관리 | 스트리밍플러스' },
    entryAnswers: { browser_entry: { type: 'predicate', probability: 0.99 }, browser_entry_answer: { type: 'predicate', probability: 0 }, browser_entry_card_0: { type: 'predicate', probability: 0.98 }, codeCard: null } })
  return { out, note: JSON.parse(out.note).egdesk_browser_task }
}

test('a finished task carries the page it ended on (the date is in the note); the answer is not guessed by code', async () => {
  const { out, note } = await finish()
  assert.equal(out.status, 'done')
  assert.deepEqual(note.page, ['멤버십 관리', '이용 중인 요금제: 프리미엄', '다음 결제일: 2026-12-14', '결제 금액: 14,900원'])
  assert.equal(note.found, undefined, 'nothing was located by an identifier')
  assert.equal(note.status, 'done')
})

test('where the run may not receive page text, the note is as before: nothing of the page', async () => {
  const { note } = await finish({ gate: false })
  assert.deepEqual([note.page, note.found, note.status], [undefined, undefined, 'done'])
})

test('lines are bounded: at most MAX_PAGE_LINES, MAX_PAGE_CHARS in all, each at most 120 characters, blanks and non-text skipped', () => {
  const many = Array.from({ length: 30 }, (_, i) => `줄 ${i}`)
  assert.equal(pageLines(many).length, MAX_PAGE_LINES)
  const long = ['가'.repeat(300), '', null, 7, '나'.repeat(200), '다'.repeat(200), '라'.repeat(200)]
  const out = pageLines(long)
  assert.ok(out.every(line => line.length <= 120) && out.join('').length <= MAX_PAGE_CHARS, JSON.stringify(out.map(l => l.length)))
  assert.deepEqual(pageLines(undefined), [])
  assert.deepEqual(pageLines(['', '  ']), [])
})

test('a note with a located status (found) does not also carry the page; the page rides only without one', () => {
  const task = { taskId: 'bt_0123456789ab', steps: 1, actions: { fill: 0, navigate: 0, scroll: 0 } }
  const both = JSON.parse(subjectiveNote(task, { status: 'done', found: ['배송 상태: 배송 중'], page: ['주문 내역', '배송 상태: 배송 중'] })).egdesk_browser_task
  assert.deepEqual([both.found, both.page], [['배송 상태: 배송 중'], undefined])
  const only = JSON.parse(subjectiveNote(task, { status: 'done', page: ['주문 내역', '배송 상태: 배송 중'] })).egdesk_browser_task
  assert.deepEqual([only.found, only.page], [undefined, ['주문 내역', '배송 상태: 배송 중']])
  const paused = JSON.parse(subjectiveNote(task, { status: 'cannot_proceed', code: 'human_step' })).egdesk_browser_task
  assert.equal(paused.page, undefined, 'a task that did not finish carries no page')
})
