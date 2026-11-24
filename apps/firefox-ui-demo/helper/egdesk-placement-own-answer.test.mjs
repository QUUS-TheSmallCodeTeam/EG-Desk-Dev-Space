// L1 c16: the owner question ("does the result need the owner?") quotes only the answering model's own sentences, never the text the draft check
// appended. The draft check knows what it appended (DRAFT_CHECK_COPY) and says which part is the model's (`own`); the runtime keeps that per run and the
// placement context quotes it (R3: code-known text stays code; R4: the item quoted is the model's answer alone). The v2 send (c21): the follow-up's
// "따로 확인하실 일은 없습니다." plus the check's "…자료를 알려 주세요." was read as owner action .95 and opened the owner's branch.
import test from 'node:test'
import assert from 'node:assert/strict'
import { DRAFT_CHECK_COPY, checkDraft } from './egdesk-draft-check.mjs'
import { CodexChatRuntime } from './codex-chat-runtime.mjs'
import { createWorkPlacement, placementQuestions } from './egdesk-work-placement.mjs'
import { createEgressGate, modelDataPermissions } from './egdesk-decision-egress.mjs'

const FOLLOW_UP = '납기는 v1보다 1주 짧은 2주입니다. 따로 확인하실 일은 없습니다.'          // the v2 follow-up answer (no claim the check can find support for is needed)
const DECISION = '이 단가 인하를 소유자께서 승인해 주셔야 수정 견적서를 보낼 수 있습니다.'
const never = { model: 'mock', async decide() { throw new Error('not asked') } }
const reviseNever = async () => { throw new Error('not revised') }
// The two fixed sentences the draft check appended or posted before c19 (owner decision 2026-11-25: no fixed fallback). Kept here only as
// the historical text of the c21 run, to show what the owner question must never read again.
const C21_PARTIAL = '확인되지 않은 부분은 답하지 않았습니다. 필요하면 기준으로 삼을 자료를 알려 주세요.'
const C21_ASK = '확인할 수 있는 근거가 부족해 지금은 답하기 어렵습니다. 어떤 자료를 기준으로 할지 알려 주세요.'

test('draft check: everything it hands back is the answering model\'s text (c19: it appends nothing and posts no sentence of its own)', async () => {
  // no evidence: the concrete claims cannot be supported and are removed silently; what is left is the model's own sentence
  const trimmed = await checkDraft({ draft: `PostgreSQL 마이그레이션은 v14에서 v16으로 3월에 끝났습니다. ${FOLLOW_UP}`, evidence: [], mode: 'on', client: never, revise: reviseNever })
  assert.deepEqual([trimmed.outcome, trimmed.text, trimmed.own], ['certain_part', '따로 확인하실 일은 없습니다.', '따로 확인하실 일은 없습니다.'])
  assert.ok(!trimmed.text.includes('자료를 알려 주세요'))
  // nothing would be left and the rewrite could not run: the draft as written (no fixed question any more), all of it the model's
  const asked = await checkDraft({ draft: 'PostgreSQL 마이그레이션은 v14에서 v16으로 3월에 끝났습니다.', evidence: [], mode: 'on', client: never, revise: reviseNever })
  assert.deepEqual([asked.outcome, asked.text, asked.own, asked.calibration.fallback], ['unchecked', 'PostgreSQL 마이그레이션은 v14에서 v16으로 3월에 끝났습니다.', 'PostgreSQL 마이그레이션은 v14에서 v16으로 3월에 끝났습니다.', 'revision_unavailable'])
  assert.deepEqual(DRAFT_CHECK_COPY, {})
  for (const mode of ['off', 'advisory']) { const kept = await checkDraft({ draft: FOLLOW_UP, evidence: [], mode, client: never }); assert.equal(kept.own, kept.text, mode); assert.equal(kept.text, FOLLOW_UP) }
})

test('runtime: the run\'s own answer is the posted answer minus the check\'s copy only when the posted answer is exactly what the check handed back', () => {
  const own = CodexChatRuntime.prototype.runOwnAnswerText
  // (an answer posted with an earlier check's appended sentence: the runtime still quotes only the model's part)
  const posted = `${FOLLOW_UP}\n\n${C21_PARTIAL}`
  const fake = (text, mark) => { const run = {}; return { run, self: { runAnswerText: () => text, draftOwnTexts: mark ? new WeakMap([[run, mark]]) : undefined } } }
  let r = fake(posted, { posted, own: FOLLOW_UP }); assert.equal(own.call(r.self, r.run), FOLLOW_UP)
  r = fake(posted.replace('\n\n', ' '), { posted, own: FOLLOW_UP }); assert.equal(own.call(r.self, r.run), FOLLOW_UP, 'the same text, other whitespace')
  r = fake(posted, null); assert.equal(own.call(r.self, r.run), posted, 'no check result: the posted answer as it is')
  r = fake(`${FOLLOW_UP} 추가로 고친 문장. ${C21_PARTIAL}`, { posted, own: FOLLOW_UP }); assert.ok(own.call(r.self, r.run).includes('추가로 고친 문장'), 'another text was posted: never cut')
  r = fake('', { posted, own: FOLLOW_UP }); assert.equal(own.call(r.self, r.run), '')
  r = fake(C21_ASK, { posted: C21_ASK, own: '' }); assert.equal(own.call(r.self, r.run), '', 'the check asked instead: nothing of the model\'s to quote')
  // the placement context quotes it
  const run = { status: 'completed' }, mark = new WeakMap([[run, { posted, own: FOLLOW_UP }]])
  const ctx = CodexChatRuntime.prototype.placementContextFor.call({ heartbeatFor: () => 'hb', heartbeatSubjects: new Map([['hb', { run }]]), runUserText: () => '납기만 다시 알려 주세요',
    runAnswerText: () => posted, draftOwnTexts: mark, runOwnAnswerText: own, decisionEgressFor: () => 'gate' }, 'dm')
  assert.deepEqual(ctx, { request: '납기만 다시 알려 주세요', answer: FOLLOW_UP, egress: 'gate' })
})

test('placement (the v2 follow-up): with a judge that reads "자료를 알려 주세요" as the owner\'s to act on (as the real model did, .95), the own-sentence quote keeps "nothing to do" on the requester\'s branch; the decision result still goes to the owner', async () => {
  const seen = []
  const judge = { model: 'mock', async decide(request) {
    const text = request.input.map(row => row.content).join('\n'); seen.push(text)
    return { answers: { owner_action: { type: 'predicate', probability: /승인해 주셔야|자료를 알려 주세요/.test(text) ? 0.95 : 0.03 } }, usage: { inputTokens: 9 } }
  } }
  const egress = createEgressGate(modelDataPermissions({ runActive: true, canvasMaySend: false }))
  const dto = { kind: 'attention', surface: 'result', state: 'finished', ownerMustAct: false, members: [], requester: 'm-0123456789abcdef', related: [] }
  const outcomeFor = async answer => {
    const material = { request: '납기만 다시 알려 주세요', answer }
    const q = placementQuestions(dto, material); assert.ok(q, 'there is something to ask')
    const reply = await judge.decide(q)
    return reply.answers.owner_action.probability >= 0.5 ? 'owner' : 'requester'
  }
  const posted = `${FOLLOW_UP}\n\n${C21_PARTIAL}`
  assert.equal(await outcomeFor(posted), 'owner', 'control: quoting the posted answer with the check\'s copy reproduces the c21 reading')
  assert.equal(await outcomeFor(FOLLOW_UP), 'requester', 'the model\'s own sentences: nothing for the owner')
  assert.ok(!seen[1].includes('자료를 알려 주세요') && seen[1].includes('따로 확인하실 일은 없습니다.'))
  assert.equal(await outcomeFor(DECISION), 'owner', 'a real decision request still reaches the owner')
  // an empty own answer (the check asked instead) asks nothing: the code's outcome
  assert.equal(placementQuestions(dto, { request: '납기만 다시 알려 주세요', answer: '' }), null)
  assert.equal(typeof createWorkPlacement, 'function')
})
