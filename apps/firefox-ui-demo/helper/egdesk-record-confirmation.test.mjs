import test from 'node:test'
import assert from 'node:assert/strict'
import { CONFIRM_BARS, CONFIRM_LIMITS, confirmationAction, confirmationNote, judgeConfirmation } from './egdesk-record-confirmation.mjs'
import { mockJudge } from './egdesk-wiki-reconstruction.fixture.mjs'

const ASKED = Date.parse('2026-11-24T14:30:00+09:00')
const NOTE = [{ title: 'PostgreSQL 마이그레이션 배포 계획', status: 'done' }]
const STATED = '수고하셨어요. PostgreSQL 마이그레이션 배포 계획은 완료로 적어 둘게요. 헬스체크는 응답 시간부터 보세요.'
const judge = (message, previousAnswer = STATED, records = NOTE, client = mockJudge()) => judgeConfirmation({ message, previousAnswer, records, client, askedAt: ASKED })
const yes = { state: 'yes', p: 0.96 }, no = { state: 'no', p: 0.03 }, maybe = { state: 'unknown', p: 0.5 }, missing = { state: 'unknown', p: null }

test('the note for the answering model: what was noted, as a statement to make; never a question, never without a record', () => {
  const note = confirmationNote([...NOTE, { title: 'B사 납품 일정', status: 'superseded' }, { title: 'x', status: 'nonsense' }, { title: '', status: 'done' }])
  assert.match(note, /^\[noted in this conversation, not confirmed\]\n- "PostgreSQL 마이그레이션 배포 계획": the person reported it as done/)
  assert.match(note, /- "B사 납품 일정": the person reported it as outdated/); assert.equal(note.split('\n').filter(l => l.startsWith('- ')).length, 2)
  assert.match(note, /Do not ask them to confirm it/); assert.match(note, /the recorded status has not changed/)
  assert.deepEqual([confirmationNote([]), confirmationNote(null), confirmationNote([{ title: 'x', status: 'unknown' }])], [null, null, null])
  assert.equal(confirmationNote(Array.from({ length: 9 }, (_, i) => ({ title: `t${i}`, status: 'plan' }))).split('\n').filter(l => l.startsWith('- ')).length, CONFIRM_LIMITS.records)
})

test('confirmationAction: only a decided confirmation of a STATED note (and no rejection) promotes; a decided rejection withdraws; everything else keeps it pending', () => {
  assert.deepEqual(confirmationAction(yes, yes, no), { action: 'promote', reason: 'confirmed' })
  assert.deepEqual(confirmationAction(no, yes, no), { action: 'keep', reason: 'confirmed_but_not_stated' })
  assert.deepEqual(confirmationAction(maybe, yes, no), { action: 'keep', reason: 'confirmed_but_not_stated' })
  assert.deepEqual([confirmationAction(yes, no, yes), confirmationAction(no, no, yes)], [{ action: 'revert', reason: 'objected' }, { action: 'revert', reason: 'objected' }])
  assert.deepEqual(confirmationAction(yes, no, no), { action: 'keep', reason: 'no_response' }, 'both no: not objecting is not agreeing')
  assert.deepEqual(confirmationAction(yes, yes, yes), { action: 'keep', reason: 'contradictory' })
  // any undecided or missing answer keeps it pending, even beside a decided yes
  for (const [c, r] of [[maybe, no], [yes, maybe], [no, maybe], [maybe, yes], [missing, no], [yes, missing], [undefined, undefined]]) assert.deepEqual(confirmationAction(yes, c, r), { action: 'keep', reason: 'undecided' })
  assert.deepEqual(CONFIRM_BARS, { yes: 0.8, no: 0.2 })
})

test('judgeConfirmation: one call, closed options; the person agrees, objects, talks about something else, or the reply never stated it', async () => {
  const seen = []
  const client = { async decide(req) { seen.push(req); return mockJudge().decide(req) } }
  const agree = await judge('응, 맞아.', STATED, NOTE, client)
  assert.deepEqual(seen[0].questions.map(q => [q.name, q.type]), [['rc_stated_0', 'predicate'], ['rc_confirms_0', 'predicate'], ['rc_rejects_0', 'predicate']], 'yes/no questions only, no forced choice')
  for (const q of seen[0].questions) assert.ok(q.instructions.startsWith('Note "PostgreSQL 마이그레이션 배포 계획 (noted as done)": '), 'each question quotes the one note it is about')
  assert.ok(seen[0].input.some(m => m.content.startsWith('Assistant\'s previous reply:\n')) && seen[0].input.at(-1).content.endsWith('The person\'s new message:\n응, 맞아.'))
  assert.deepEqual([agree.status, agree.verdicts.map(v => [v.action, v.reason, v.stated.state, v.confirms.state, v.rejects.state]), agree.silent], ['ready', [['promote', 'confirmed', 'yes', 'yes', 'no']], 0])
  assert.deepEqual((await judge('아니, 아직 스테이징만 끝났어.')).verdicts.map(v => [v.action, v.reason]), [['revert', 'objected']])
  const other = await judge('그럼 롤백 조건은 뭐였지?')
  assert.deepEqual([other.verdicts.map(v => [v.action, v.reason]), other.silent], [[['keep', 'no_response']], 1], 'silence keeps it pending; it is only counted')
  assert.deepEqual((await judge('음...')).verdicts.map(v => [v.action, v.reason]), [['keep', 'undecided']])
  // the previous reply did not state the note: "응" answers something else
  const unstated = await judge('응, 맞아.', '헬스체크는 응답 시간부터 보세요. 그렇게 진행할까요?')
  assert.deepEqual(unstated.verdicts.map(v => [v.action, v.reason, v.stated.state]), [['keep', 'confirmed_but_not_stated', 'no']])
  // but an objection is honoured even then
  assert.equal((await judge('아니, 그거 기록하지 마.', '헬스체크는 응답 시간부터 보세요.')).verdicts[0].action, 'revert')
})

test('judgeConfirmation never acts on a failure: no previous reply, no client, an outage or missing answers keep every note pending', async () => {
  assert.deepEqual([(await judge('응', '')).reason, (await judge('응', null)).reason, (await judgeConfirmation({ message: '응', previousAnswer: STATED, records: NOTE })).reason, (await judge('', STATED)).reason], ['no_previous_answer', 'no_previous_answer', 'not_configured', 'not_configured'])
  const down = await judge('응, 맞아.', STATED, NOTE, { async decide() { throw Object.assign(new Error('x'), { code: 'rate_limited' }) } })
  assert.deepEqual([down.status, down.reason, down.verdicts.map(v => v.action)], ['fallback', 'rate_limited', ['keep']])
  const empty = await judge('응, 맞아.', STATED, NOTE, { async decide() { return { answers: {} } } })
  assert.deepEqual(empty.verdicts.map(v => [v.action, v.reason]), [['keep', 'undecided']])
  // a long reply is cut, and at most three notes are judged
  const seen = []
  await judgeConfirmation({ message: '응', previousAnswer: 'ㄱ'.repeat(5000), records: Array.from({ length: 5 }, (_, i) => ({ title: `기록 ${i}`, status: 'plan' })), client: { async decide(req) { seen.push(req); return { answers: {} } } } })
  assert.equal(seen[0].questions.length, CONFIRM_LIMITS.records * 3); assert.ok(seen[0].input[2].content.length < CONFIRM_LIMITS.answerChars + 60)
})
