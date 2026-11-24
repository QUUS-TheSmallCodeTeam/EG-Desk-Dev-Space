// c29 (L2 c24, real v9 run, s14): after s13's withheld "배포를 완료했습니다." the correct s14 sentence "12월 첫째 주에 배포할 예정입니다." was withheld again: its evidence was byte-identical to v8's, no
// plan page. The plan page had reached the s13 check as a CARRIED record (prev_mem1), so it was not among s13's own records, and the carry-over kept only own records: the chain broke
// at s14. The next check now carries what the withheld check was given (result.evidenceUsed). Mocks only.
import test from 'node:test'
import assert from 'node:assert/strict'
import { checkDraft } from './egdesk-draft-check.mjs'
import { world } from './egdesk-heartbeat-flow.fixture.mjs'

const mem = (id, time, status, text) => ({ id, kind: 'memory', time, status, source: 'document', text })
const PLAN = mem('mem1', 'planned', 'plan', 'PostgreSQL 마이그레이션 배포 계획\n12월 첫째 주에 SQLite에서 PostgreSQL로 전환 배포한다. 아직 배포 전이다.')
const FILLER = n => Array.from({ length: n }, (_, i) => mem(`mem${i + 1}`, 'past', 'done', `${['견적서 v1 발송 기록', '헬스체크 3종 체크리스트', '롤백 절차 문서', '알림 채널 설정', '캐시 비우기 순서', '디스크 점검 일지'][i % 6]} ${i}\n${['A사 단가 12,800원', '디스크 사용률 점검', '30분 안에 되돌린다', '슬랙 채널 연결', '배포 직후 확인', '월간 점검'][i % 6]} (${i}).`))
const judge = low => ({ requests: [], async decide(request) { this.requests.push(request); const answers = {}; for (const q of request.questions) answers[q.name] = { type: 'predicate', probability: q.name.startsWith('sup_') ? low : 0.02 }; return { answers, usage: { inputTokens: 5 } } } })
const body = request => request.input.find(row => /^Evidence:/.test(row.content)).content

test('s13 -> s14: the plan page that reached the withheld check as a carried record is carried on, ranked in for the next sentence, and the correct plan sentence is supported', async t => {
  const w = world(t, { flags: { held: true } })
  const run = { clientThreadId: 'dm-chain', conversationId: 'c1' }
  // before s13: an earlier check had the plan page (it was posted then): its records are the carried ones of s13
  await w.chat.draftTurnEvidence(run, { evidence: [], memory: [PLAN, ...FILLER(3).map(m => ({ ...m, id: `x${m.id}` }))], skip: null }, [])
  // s13: its own records are other pages (the real turn carried no page); the carried plan page is in the check's evidence but not among its own records
  const s13 = await w.chat.draftTurnEvidence(run, { evidence: [], memory: FILLER(8).map(m => ({ ...m, id: `s13${m.id}` })), skip: null }, [])
  assert.ok(s13.evidence.some(item => item.id === 'prev_mem1'), 'the plan page is carried into the s13 check')
  const wrong = judge(0), checked = await checkDraft({ draft: 'PostgreSQL 전환 배포를 완료했습니다.', evidence: s13.evidence, mode: 'on', client: wrong })
  assert.ok(checked.findings.some(f => f.kind === 'unverified'), 's13: the false completion is caught'); assert.ok(body(wrong.requests[0]).includes('아직 배포 전이다'), 'and the judge saw the plan page')
  assert.ok(checked.evidenceUsed.some(item => item.id === 'prev_mem1'), 'the result names the items the check was given')
  w.chat.rememberWithheldEvidence(run, { outcome: 'withheld', evidenceUsed: checked.evidenceUsed }) // what the runtime does when the outcome is 'withheld'
  // s14: this turn's own records are eight other pages (as in the real run: A사, the design, the checklists)
  const s14 = await w.chat.draftTurnEvidence(run, { evidence: [], memory: FILLER(8).map(m => ({ ...m, id: `s14${m.id}` })), skip: null }, [])
  assert.ok(s14.evidence.some(item => item.id === 'prev_mem1' && item.text.includes('아직 배포 전이다')), 's14: the plan page is carried on although it was not among the previous check\'s own records')
  const right = judge(0.96), out = await checkDraft({ draft: '12월 첫째 주에 배포할 예정입니다.', evidence: s14.evidence, mode: 'on', client: right })
  assert.ok(body(right.requests[0]).includes('12월 첫째 주에 SQLite에서 PostgreSQL로 전환 배포한다'), 'the plan page is among the eight the check keeps')
  assert.deepEqual([out.findings.length, out.text], [0, '12월 첫째 주에 배포할 예정입니다.'], 'the correct plan sentence is posted as written')
})

test('after a posted answer the carry-over is what it was (own records, four): only a withheld check hands on what it was given', async t => {
  const w = world(t, { flags: { held: true } })
  const run = { clientThreadId: 'dm-posted', conversationId: 'c2' }
  const a = await w.chat.draftTurnEvidence(run, { evidence: [], memory: FILLER(8), skip: null }, [])
  w.chat.rememberWithheldEvidence({ clientThreadId: 'someone-else' }, { outcome: 'withheld', evidenceUsed: [PLAN] }) // another conversation: nothing happens to this one
  const b = await w.chat.draftTurnEvidence(run, { evidence: [], memory: FILLER(8).map(m => ({ ...m, id: `b${m.id}`, text: `${m.text} (B)` })), skip: null }, [])
  assert.deepEqual(b.evidence.filter(item => item.id.startsWith('prev_')).map(item => item.id), ['prev_mem1', 'prev_mem2', 'prev_mem3', 'prev_mem4'])
  assert.equal(a.evidence.length, 8)
})
