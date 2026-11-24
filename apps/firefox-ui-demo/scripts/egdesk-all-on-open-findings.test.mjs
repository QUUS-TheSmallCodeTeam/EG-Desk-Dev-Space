// Open cross-feature findings of the all-on journey (cycle 9), one minimal reproduction each, for the owning lanes.
//
// Each test states the behaviour the journey expected and FAILS on int/c14. They are skipped by default so the gate stays green;
// run them with EGDESK_ALL_ON_REPRO=1 to see the failure:
//   EGDESK_ALL_ON_REPRO=1 node --test scripts/egdesk-all-on-open-findings.test.mjs
// When a finding is fixed, the owner removes the skip (or the test, if the decision goes the other way).
// The expectations are this lane's reading, not a decided contract. Synthetic harness only.
import test from 'node:test'
import assert from 'node:assert/strict'
import { allOnWorld, screen, DM } from './egdesk-all-on.support.mjs'

const repro = reason => (process.env.EGDESK_ALL_ON_REPRO === '1' ? {} : { skip: `open finding, not this lane's to fix: ${reason} (EGDESK_ALL_ON_REPRO=1 runs it)` })
const QUOTE = '지난주 A사 견적 건 어디까지 됐지?', QUOTE_ANSWER = 'A사 견적은 v1 발송 후 v2 수정 계획 단계이며 팀장 승인 후 발송 예정입니다.'
const TIDY = '방금 그 내용 정리해줘', TIDY_ANSWER = 'A사 견적은 11월 3일 요청, 11월 6일 v1 발송, v2는 팀장 승인 후 발송 예정입니다.'
const PORTAL = '거래처 포털에서 이번 달 세금계산서 내려받아줘'

// A1 (draft check, with turn memory): the Agent holds the five pages from the first turn; its follow-up answer restates them.
test('A1: a follow-up answer that restates pages the Agent already holds is posted as written (no rewrite turn)', repro('A1, draft check x turn memory'), async t => {
  const w = allOnWorld(t)
  await w.settings.turnMemory.save('on')
  w.step('first'); await w.send(QUOTE); await w.idle(); await w.advance(3000); await w.answer(QUOTE_ANSWER); await w.idle()
  w.step('follow-up'); const run = await w.send(TIDY); await w.idle()
  assert.ok(w.chat.memoryMaterialsFor(w.chat.runFor(run)).every(material => material.held), 'precondition: every page is held, none newly attached')
  await w.advance(3000); await w.answer(TIDY_ANSWER); await w.idle()
  assert.equal(w.subjectiveTurnsIn('follow-up').fork, 0, 'no rewrite turn')
  assert.equal(w.history().at(-1)[1], TIDY_ANSWER, 'the person reads the Agent\'s own answer')
})

// A2 (browser lane): a browser task asked in a conversation that began with an ordinary turn is refused (409). The refusal itself
// is a product decision; what this pins is that a refused message is not left behind as an accepted one.
test('A2: a browser request that is refused with 409 is not kept as an accepted message of the conversation', repro('A2, browser tools x existing conversation'), async t => {
  const w = allOnWorld(t)
  w.step('first'); await w.send(QUOTE); await w.idle(); await w.answer(QUOTE_ANSWER); await w.idle()
  w.step('browser')
  await assert.rejects(w.send(PORTAL, w.browserExtra()), error => error.code === 'BROWSER_TOOLS_UNAVAILABLE', 'precondition: the request is refused')
  await w.idle()
  const kept = w.store.listMessages(DM).messages.filter(message => message.role === 'user' && message.text === PORTAL)
  assert.deepEqual(kept.filter(message => message.status === 'accepted').length, 0, 'no accepted row for a refused request')
  const restored = screen(w); await restored.restore()
  assert.deepEqual(restored.bubbles().filter(([role, , text]) => role === 'user' && text === PORTAL), [], 'and no unanswered bubble after a restart')
})

// A6 (browser lane, draft check): the conversation keeps the bounded policy of the browser task, so nothing holds the answer of a later
// ordinary message and its text is drawn while it arrives.
test('A6: in a conversation that began as a browser task, an ordinary answer is drawn only when it is complete', repro('A6, browser conversation x completed messages only'), async t => {
  const thread = 'dm-browser', w = allOnWorld(t), ui = screen(w, thread)
  w.use(thread)
  w.step('task')
  const first = await w.send(PORTAL, w.browserExtra()); ui.sent(PORTAL, 'req-1', first); await w.idle(); await w.answer('사업자가 둘입니다. 어느 쪽으로 받을까요?'); await w.idle()
  await w.send('두 번째 사업자로', w.browserExtra()); await w.idle(); await w.answer('세금계산서를 내려받았습니다.'); await new Promise(resolve => setTimeout(resolve, 60)); await w.idle(); ui.pump()
  w.step('ordinary')
  const out = await w.send(QUOTE); ui.sent(QUOTE, 'req-3', out); await w.idle(); ui.pump()
  const timing = w.timing(), before = ui.frames.length
  await w.notify('item/started', { ...timing, item: { id: 'ans-o', type: 'agentMessage', phase: 'final_answer', text: '' } })
  await w.notify('item/agentMessage/delta', { ...timing, itemId: 'ans-o', delta: QUOTE_ANSWER.slice(0, 9) }); await w.idle(); ui.pump()
  const partial = ui.frames.slice(before).filter(frame => frame.bubbles.some(([role, status, text]) => role === 'assistant' && status === 'streaming' && text))
  assert.deepEqual(partial.map(frame => frame.event), [], 'no half-written answer on the screen')
})
