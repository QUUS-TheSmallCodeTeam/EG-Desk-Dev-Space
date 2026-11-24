import test from 'node:test'
import assert from 'node:assert/strict'
import { checkDraft } from './egdesk-draft-check.mjs'

// c24 (L2, plan v8 real run c37, int/c14 15b0df9): "PostgreSQL 전환 배포를 완료했습니다." was posted as written. The check HAD the plan page ("아직 배포 전이다", planned) and the judge
// answered sup .00 (nothing supports it), but the turn had 9 evidence items against the limit of 8, one was left out, so everything the checker reads counts as not fully seen and
// the unsupported finding is off (c26's deliberate rule: egdesk-draft-check-predicates.test.mjs "pages the item limit left out"). Owner L3. This file states the behaviour the
// owner decision still has to give; it is a todo (it runs and reports, it does not fail the gate) until L3 decides and fixes. The first test pins the exact v8 situation.
const PLAN = { id: 'prev_mem1', kind: 'memory', time: 'planned', status: 'plan', source: 'document', text: 'PostgreSQL 마이그레이션 배포 계획\n12월 첫째 주에 SQLite에서 PostgreSQL로 전환 배포할 예정이다. 배포 뒤 헬스체크 3종을 통과해야 한다. 아직 배포 전이다.' }
const other = i => ({ id: `mem${i}`, kind: 'memory', time: 'past', status: 'unknown', source: 'document', text: `A사 메모 ${i}\n11월 ${i}일 회의 내용이다.` })
const client = answer => ({ async decide(request) { const answers = {}; for (const q of request.questions) answers[q.name] = { type: 'predicate', probability: answer(q.name) }; return { answers, usage: { inputTokens: 10 } } } })
const judge = name => (name.startsWith('sup_') ? 0 : 0.01) // the real judge's answers in c37: sup .00, tense .01
const DRAFT = 'PostgreSQL 전환 배포를 완료했습니다.'

test('c24 control: with eight evidence items (nothing left out) the same answers flag the sentence and nothing is posted as written', async () => {
  const out = await checkDraft({ draft: DRAFT, evidence: [PLAN, ...[1, 2, 3, 4, 5, 6, 7].map(other)], mode: 'on', client: client(judge) })
  assert.ok(out.findings.some(f => f.kind === 'unverified'))
  assert.notEqual(out.text, DRAFT)
})

test('c24 (owner L3): nine evidence items, one left out: a sentence the judge calls unsupported (.00) against a planned page that says "not deployed yet" is not posted as written', { todo: 'L3: the left-out rule lets a contradicted completion claim through (v8 real run c37, s13)' }, async () => {
  const out = await checkDraft({ draft: DRAFT, evidence: [PLAN, ...[1, 2, 3, 4, 5, 6, 7, 8].map(other)], mode: 'on', client: client(judge) })
  assert.notEqual(out.text, DRAFT, 'the false completion claim was posted as written')
})
