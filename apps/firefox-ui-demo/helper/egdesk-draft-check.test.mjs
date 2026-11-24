import test from 'node:test'
import assert from 'node:assert/strict'
import { DRAFT_CHECK_COPY, DRAFT_CHECK_LIMITS, checkDraft, collectTerms, evidenceFromPacket, isCheckable, revisionNote, segmentDraft } from './egdesk-draft-check.mjs'
import { mockJudge, mockReviser } from './egdesk-draft-check.fixture.mjs'
import { createDecisionBudget } from './egdesk-decision-client.mjs'

const plan = { id: 'doc:pg', kind: 'document', time: 'planned', status: 'draft', source: 'doc', text: 'PostgreSQL 마이그레이션 계획: 다음 분기에 전환 예정입니다.' }
const live = { id: 'board:deploy', kind: 'board', time: 'present', status: 'live', text: '배포 파이프라인 점검은 월요일에 끝났습니다.' }

test('segmentation: fixed spans in order, version numbers and fenced code are not split or judged', () => {
  const text = 'v1.2 버전은 안정적입니다. 어떻게 할까요?\n```js\nconst a = 1. 2\n```\n끝입니다.'
  const spans = segmentDraft(text)
  assert.deepEqual(spans.map(s => s.kind), ['claim', 'question', 'code', 'claim'])
  for (const s of spans) assert.equal(text.slice(s.start, s.end), s.text)
  assert.equal(spans[0].text, 'v1.2 버전은 안정적입니다.')
  assert.ok(isCheckable('PostgreSQL 14') && isCheckable('`foo`') && !isCheckable('도움이 되었길 바랍니다.'))
})

test('terms: the person\'s own words and given materials are a basis; only the rest is put to the judge', () => {
  const terms = collectTerms({ draft: '`consent_generation`이 바뀌면 settingsGeneration과 동의 세대가 올라갑니다. user_said_term도 씁니다.',
    userText: 'user_said_term 알려줘', evidence: [{ text: 'settingsGeneration is documented here' }], internalVocabulary: ['동의 세대'] })
  const by = Object.fromEntries(terms.map(t => [t.term, t.exposure]))
  assert.equal(by.consent_generation, 'internal_only')
  assert.equal(by.settingsGeneration, 'in_evidence')
  assert.equal(by['동의 세대'], 'internal_only')
  assert.equal(by.user_said_term, 'user_said')
})

test('evidenceFromPacket reads the context packet headers with time and provenance', () => {
  const items = evidenceFromPacket('EG-Desk is supplying…\n\n[item id=board:plan kind=board time=planned status=draft source=x]\nFull plan text\n\n[item id=m1 kind=conversation time=past]\nold')
  assert.deepEqual(items.map(i => [i.id, i.time, i.status, i.text]), [['board:plan', 'planned', 'draft', 'Full plan text'], ['m1', 'past', null, 'old']])
})

test('(a) a clean answer passes untouched, one call', async () => {
  const calls = []
  const result = await checkDraft({ draft: '배포 파이프라인 점검은 월요일에 끝났습니다.', evidence: [live], mode: 'on', client: mockJudge({ calls }), revise: mockReviser() })
  assert.equal(result.outcome, 'passed'); assert.equal(result.text, '배포 파이프라인 점검은 월요일에 끝났습니다.'); assert.equal(result.calls, 1)
  assert.equal(result.calibration.attached, false)
})

test('(b) a plan stated as current is revised once to plan wording, then re-checked', async () => {
  const revise = mockReviser({ '현재 운영 중입니다': '아직 계획 단계입니다' })
  const result = await checkDraft({ draft: 'PostgreSQL 마이그레이션은 현재 운영 중입니다.', evidence: [plan], mode: 'on', client: mockJudge(), revise })
  assert.equal(result.outcome, 'revised'); assert.equal(result.text, 'PostgreSQL 마이그레이션은 아직 계획 단계입니다.')
  assert.equal(result.calls, 2); assert.equal(revise.log.length, 1)
  assert.deepEqual(revise.log[0].kinds, ['present_tense'])
  assert.match(revise.log[0].note, /tags as planned/); assert.match(revise.log[0].note, /Do not mention this check/)
  assert.ok(!result.text.includes('planned'), 'findings never enter the answer')
})

test('(c) an internal term with no basis is rephrased', async () => {
  const revise = mockReviser({ '동의 세대': '허용 상태' })
  const result = await checkDraft({ draft: '동의 세대가 바뀌면 추천이 취소됩니다.', evidence: [{ id: 'm', time: 'present', text: '추천이 취소되는 조건 설명' }], userText: '추천이 왜 사라졌어?',
    internalVocabulary: ['동의 세대'], mode: 'on', client: mockJudge({ internalTerms: ['동의 세대'] }), revise })
  assert.equal(result.outcome, 'revised'); assert.ok(!result.text.includes('동의 세대'))
  assert.deepEqual(revise.log[0].kinds, ['internal_term'])
})

test('(d) evidence missing: concrete claims are unverified; only the certain part is posted, or the person is asked', async () => {
  const revise = mockReviser()
  const partial = await checkDraft({ draft: 'PostgreSQL 마이그레이션은 v14에서 v16으로 3월에 끝났습니다. 도움이 되었길 바랍니다.', evidence: [], mode: 'on', client: mockJudge(), revise })
  assert.equal(partial.outcome, 'certain_part')
  assert.equal(partial.text, `도움이 되었길 바랍니다.\n\n${DRAFT_CHECK_COPY.partial}`)
  assert.equal(partial.calls, 0, 'no evidence: nothing for the judge to choose among')
  const ask = await checkDraft({ draft: 'PostgreSQL 마이그레이션은 v14에서 v16으로 3월에 끝났습니다.', evidence: [], mode: 'on', client: mockJudge(), revise })
  assert.equal(ask.outcome, 'ask_user'); assert.equal(ask.text, DRAFT_CHECK_COPY.askUser)
})

test('still failing after the one revision: only the certain part is posted, never a second revision', async () => {
  const revise = mockReviser({})
  const draft = '배포 파이프라인 점검은 월요일에 끝났습니다. PostgreSQL 마이그레이션은 현재 운영 중입니다.'
  const result = await checkDraft({ draft, evidence: [live, plan], mode: 'on', client: mockJudge(), revise })
  assert.equal(revise.log.length, 1)
  assert.equal(result.outcome, 'certain_part')
  assert.ok(result.text.startsWith('배포 파이프라인 점검은 월요일에 끝났습니다.'))
  assert.ok(!result.text.includes('운영 중'))
})

test('mode off calls nothing; advisory judges and records but posts the draft unchanged', async () => {
  const calls = []
  const draft = 'PostgreSQL 마이그레이션은 현재 운영 중입니다.'
  const off = await checkDraft({ draft, evidence: [plan], mode: 'off', client: mockJudge({ calls }), revise: mockReviser() })
  assert.deepEqual([off.outcome, off.text, calls.length], ['unchecked', draft, 0])
  const revise = mockReviser({ '현재 운영 중입니다': '아직 계획 단계입니다' })
  const adv = await checkDraft({ draft, evidence: [plan], mode: 'advisory', client: mockJudge({ calls }), revise })
  assert.deepEqual([adv.outcome, adv.text, calls.length, revise.log.length], ['unchecked', draft, 1, 0])
  assert.ok(adv.findings.length === 1 && adv.calibration.mode === 'advisory' && adv.calibration.judgments.some(j => j.would === 'reject'))
})

test('budget, failures and the first-check deadline post the draft as it is today', async () => {
  const draft = 'PostgreSQL 마이그레이션은 현재 운영 중입니다.'
  const spent = createDecisionBudget({ monthlyInputTokenCap: 10, initial: { month: createDecisionBudget().snapshot().month, inputTokens: 10 } })
  const noBudget = await checkDraft({ draft, evidence: [plan], mode: 'on', client: mockJudge(), budget: spent })
  assert.deepEqual([noBudget.outcome, noBudget.text, noBudget.calibration.fallback], ['unchecked', draft, 'budget_exceeded'])
  const broken = await checkDraft({ draft, evidence: [plan], mode: 'on', client: { decide: async () => { throw new Error('x') } } })
  assert.deepEqual([broken.outcome, broken.text, broken.calibration.fallback], ['unchecked', draft, 'unreachable'])
  const calls = []
  await checkDraft({ draft, evidence: [plan], mode: 'on', client: mockJudge({ calls }), revise: mockReviser({ '현재 운영 중입니다': '계획입니다' }) })
  assert.equal(calls[0].timeoutMs, DRAFT_CHECK_LIMITS.firstCheckMs)
  assert.equal(calls[1].timeoutMs, DRAFT_CHECK_LIMITS.recheckMs)
  const slow = await checkDraft({ draft, evidence: [plan], mode: 'on', client: mockJudge({ delayMs: DRAFT_CHECK_LIMITS.firstCheckMs + 50 }) })
  assert.deepEqual([slow.outcome, slow.text, slow.calibration.fallback], ['unchecked', draft, 'timeout'])
})

test('nothing checkable means no call and no spend', async () => {
  const calls = []
  const result = await checkDraft({ draft: '네, 알겠습니다. 천천히 하세요.', evidence: [], mode: 'on', client: mockJudge({ calls }) })
  assert.deepEqual([result.outcome, calls.length], ['unchecked', 0])
})

test('the revision note carries spans and kinds, not the check as answer text', () => {
  const note = revisionNote({ findings: [{ kind: 'unverified', span: 0, evidence: [] }, { kind: 'contradicted', span: 0, evidence: [] }], claims: [{ text: 'X는 3월에 끝났습니다.' }] })
  assert.match(note, /not supported/); assert.match(note, /conflicts/); assert.match(note, /Do not mention this check/)
})
