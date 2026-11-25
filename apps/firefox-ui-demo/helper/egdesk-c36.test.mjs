// L7 c36: (1) own v4, (2) the confirmation's stated question, (3) the context selection's status rule, (4) the three prepared plans. Bodies and values are the recorded ones
// (check-20mw / check-22mw / own-statement-v1 c46 / L2 c29's V1 s1).
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { SPLIT_WORDING_CHOICE, SPLIT_WORDINGS, speechSegments, speechSplitQuestions } from './egdesk-speech-grounding.mjs'
import { CONFIRM_WORDINGS, judgeConfirmation } from './egdesk-record-confirmation.mjs'
import { CONTEXT_RULE_SETS, STATUS_RULE, prepareTurnContext } from './egdesk-context-setup.mjs'
import { turnMemoryFlagsFromEnv } from './egdesk-turn-memory-wiring.mjs'
import { CONFIRM_CASES, OWN_CASES, OWN_REPLY, OWN_SAID, STATUS_CASES, buildConfirmationStatedPlan, buildOwnWordingPlan, buildStatusQuestionPlan } from './egdesk-c36-plans.mjs'
import { loadPlan } from './egdesk-decision-real-runner.mjs'
import { allOnWorld } from '../scripts/egdesk-all-on.support.mjs'
import { SAYS } from '../scripts/egdesk-all-on-live-measure.mjs'

const ownText = (wording, text = OWN_SAID) => speechSplitQuestions(speechSegments(text), text, { wording }).find(q => q.name === 'speechs_own_0').instructions

test('own v4: the product default stays v3; v4 is selected by the wording flag; it adds decided / fixed / arranged and keeps every exclusion v3 had', () => {
  assert.equal(SPLIT_WORDING_CHOICE.own, 'v3'); assert.ok(SPLIT_WORDINGS.includes('v4'))
  const v3 = ownText('v2'), v4 = ownText('v4')
  assert.notEqual(v3, v4); assert.match(v4, /decided, fixed or arranged/); assert.match(v4, /목요일로 정했어/); assert.match(v4, /A promise or plan for later \("보낼게", "하자"\) and a request are not this/)
  for (const kept of ['Reading it in a mail, log, record or document', 'being told it is not this', 'the conclusion, which the speaker did not see', 'A statement of a fact that does not say how the speaker knows it is no']) assert.ok(v4.includes(kept), kept)
  assert.equal(ownText({ other: 'v2', own: 'v3', guess: 'v2' }), v3, 'v2 as a string is the product choice (own v3)'); assert.equal(ownText('v4'), ownText({ ...SPLIT_WORDING_CHOICE, own: 'v4' }))
  assert.deepEqual(turnMemoryFlagsFromEnv({ EGDESK_TURN_MEMORY_SPLIT_WORDING: 'v4' }), { splitWording: 'v4' }); assert.deepEqual(turnMemoryFlagsFromEnv({ EGDESK_TURN_MEMORY_SPLIT_WORDING: 'v3' }), {})
})

async function rc(wording, reply, message) {
  let request = null
  await judgeConfirmation({ message, previousAnswer: reply, records: [{ title: '신제품 리뷰 회의 일정', status: 'done', said: OWN_SAID }], wording, client: { async decide(r) { request = r; return { answers: {} } } } })
  return request
}
test('confirmation wording: v1 is c35\'s byte for byte; v2 and v3 change the quote (no "noted as done") and the stated question only; the reply and the message are the same', async () => {
  assert.deepEqual(CONFIRM_WORDINGS, ['v1', 'v2', 'v3'])
  const v1 = await rc('v1', OWN_REPLY, '응 맞아'), none = await rc(undefined, OWN_REPLY, '응 맞아'), v2 = await rc('v2', OWN_REPLY, '응 맞아'), v3 = await rc('v3', OWN_REPLY, '응 맞아')
  assert.equal(JSON.stringify(none), JSON.stringify(v1)); assert.match(v1.questions[0].instructions, /noted as done\]": did the assistant's previous reply tell the person it was recorded\?/)
  for (const v of [v2, v3]) { assert.deepEqual(v.input, v1.input); assert.ok(!JSON.stringify(v.questions).includes('noted as done')); assert.match(JSON.stringify(v.questions[0]), /kept as an unconfirmed report on 신제품 리뷰 회의 일정/); assert.deepEqual(v.questions.slice(1).map(q => q.name), ['rc_confirms_0', 'rc_rejects_0']) }
  assert.match(v2.questions[0].instructions, /did the assistant's previous reply mention this note, that is, tell the person that what they said was noted or kept, in any words \(also as a report that is not confirmed\)\?/)
  assert.match(v3.questions[0].instructions, /does the assistant's previous reply refer to the message quoted in this note\?/)
  assert.deepEqual(turnMemoryFlagsFromEnv({ EGDESK_TURN_MEMORY_CONFIRM_WORDING: 'v2' }), { confirmWording: 'v2' }); assert.deepEqual(turnMemoryFlagsFromEnv({ EGDESK_TURN_MEMORY_CONFIRM_WORDING: 'v1' }), {})
})

const V1_CATALOG = '#0 | timeline | time=past/done | A사 견적 문의 접수\n#1 | timeline | time=past/done | A사 첫 견적서(v1) 발송\n#2 | timeline | time=past/reported_by_other | A사 단가 협의 메모\n#3 | timeline | time=planned/plan | A사 견적서 v2 수정 계획\n#4 | timeline | time=past/done | A사 건 결정 메모\n#5 | timeline | time=past/done | PostgreSQL 전환 설계 문서\n#6 | timeline | time=planned/plan | PostgreSQL 마이그레이션 배포 일정\n#7 | timeline | time=present/done | 헬스체크 3종 체크리스트\n#8 | timeline | time=present/done | 현재 SQLite 스키마(운영)\n#9 | timeline | time=present/plan | 배포 후 후속 체크리스트\n#10 | timeline | time=present/done | 롤백 절차\n#11 | timeline | time=past/done | 전환 벤치마크 결과\n#12 | timeline | time=past/done | B사 견적 요청'
test('status rule: the default selection request is the recorded V1 one (same rules, same catalog); action+status adds the rule after the action rule; nothing else of the request changes', async () => {
  assert.deepEqual(CONTEXT_RULE_SETS, ['default', 'action', 'action+status'])
  const catalog = ['A사 견적 문의 접수', 'past', 'done'], candidates = [['A사 견적 문의 접수', 'past', 'done'], ['A사 첫 견적서(v1) 발송', 'past', 'done'], ['A사 단가 협의 메모', 'past', 'reported_by_other'], ['A사 견적서 v2 수정 계획', 'planned', 'plan'], ['A사 건 결정 메모', 'past', 'done'],
    ['PostgreSQL 전환 설계 문서', 'past', 'done'], ['PostgreSQL 마이그레이션 배포 일정', 'planned', 'plan'], ['헬스체크 3종 체크리스트', 'present', 'done'], ['현재 SQLite 스키마(운영)', 'present', 'done'], ['배포 후 후속 체크리스트', 'present', 'plan'],
    ['롤백 절차', 'present', 'done'], ['전환 벤치마크 결과', 'past', 'done'], ['B사 견적 요청', 'past', 'done']].map(([title, timeSlice, status], i) => ({ id: `ontology:t/${i}`, kind: 'timeline', title, timeSlice, status }))
  assert.ok(catalog)
  const body = async ruleSet => { let r = null; await prepareTurnContext({ message: 'A사 견적 지금 어떻게 돼 있어?', candidates, ruleSet, client: { model: 'x', async decide(req) { r = req; return { answers: {}, usage: {} } } } }); return r }
  const def = await body('default'), act = await body('action'), st = await body('action+status')
  assert.equal(def.input[1].content[0].text.replace(/^Catalog:\n/, ''), V1_CATALOG); assert.equal(def.input[2].content, 'Message:\nA사 견적 지금 어떻게 돼 있어?')
  assert.ok(!def.input[0].content.includes('Judge only from the catalog lines and the message. A planned or hypothetical item is never a current fact.\nAn item is needed only'))
  assert.equal(st.input[0].content, `${act.input[0].content}\n${STATUS_RULE}`); assert.deepEqual(st.input.slice(1), def.input.slice(1)); assert.deepEqual(st.questions, def.questions)
  assert.match(STATUS_RULE, /without naming a time/); assert.match(STATUS_RULE, /A planned item is still not a current fact/)
})

test('status rule through the product: the flag EGDESK_CONTEXT_RELEVANCE=action+status puts the rule into the turn_context request and keeps the action rule everywhere else; "action" and the default are unchanged', async t => {
  const developerOf = async env => {
    const w = allOnWorld(t, { env })
    await w.settings.turnMemory.save('on'); await w.send(SAYS.quote)
    return w.decisions.find(d => /"answer_type"/.test(d.raw)).raw
  }
  const raw = await developerOf({ EGDESK_CONTEXT_RELEVANCE: 'action+status' }), plain = await developerOf({ EGDESK_CONTEXT_RELEVANCE: 'action' }), none = await developerOf({})
  assert.ok(raw.includes('items that record how that matter began')); assert.ok(raw.includes('An item is needed only when the response has to use')); assert.ok(!plain.includes('items that record how that matter began')); assert.ok(!none.includes('An item is needed only'))
})

test('the three prepared plans load in the generic runner with the product bars, are built by the product, and every one has hard checks naming real questions', async () => {
  for (const [build, count, cases] of [[buildConfirmationStatedPlan, 6, CONFIRM_CASES], [buildOwnWordingPlan, 10, OWN_CASES], [buildStatusQuestionPlan, 2, STATUS_CASES]]) {
    const built = await build()
    assert.equal(built.plan.requests.length, count); assert.equal(cases.length, count); assert.ok(built.plan.tokenCeiling >= built.estInputTokens)
    const dir = mkdtempSync(path.join(os.tmpdir(), 'c36-plan-')); mkdirSync(path.join(dir, 'requests'))
    for (const { file, bytes } of built.files) writeFileSync(path.join(dir, file), bytes)
    writeFileSync(path.join(dir, 'plan.json'), JSON.stringify(built.plan))
    const loaded = loadPlan(path.join(dir, 'plan.json'))
    assert.equal(loaded.requests.length, count); assert.ok(Object.keys(loaded.productBars).length >= 1)
    for (const r of built.plan.requests) assert.ok(r.expect.some(e => e.severity === 'hard'), r.id)
  }
  const own = await buildOwnWordingPlan(), body = id => JSON.parse(own.files.find(f => f.file === `requests/${id}.json`).bytes)
  assert.match(body('t-decision').questions[0].instructions, /decided, fixed or arranged/); assert.ok(body('t-decision').input.at(-1).content.endsWith(OWN_SAID))
  assert.equal(own.plan.requests.filter(r => r.expect.some(e => e.max !== undefined)).length, 6, 'six guards'); assert.equal(own.plan.requests.filter(r => r.expect.some(e => e.min !== undefined)).length, 4, 'four targets')
  const st = await buildStatusQuestionPlan(), s1 = JSON.parse(st.files.find(f => f.file === 'requests/s1-quote-status.json').bytes)
  assert.ok(s1.input[0].content.endsWith(STATUS_RULE)); assert.equal(s1.questions.filter(q => /^rel_/.test(q.name)).length, 13)
  assert.deepEqual(st.plan.requests[0].expect.filter(e => e.severity === 'hard').map(e => e.name), ['rel_0', 'rel_5', 'rel_6', 'rel_12'])
})
