import test from 'node:test'; import assert from 'node:assert/strict'
import { claimsPositively } from './answer-check.mjs'; import { CASES } from './cases-rws.mjs'
const re15 = CASES['rws-15'].answerNotRe
test('negated answer is not a positive claim (rws-15 owner example)', () => {
  assert.equal(claimsPositively('현재 화면으로는 승인됐다고 확인할 수 없습니다. 접수 완료가 승인 완료를 뜻하지는 않습니다. 지급일도 화면에 없습니다.', re15), false)
  assert.equal(claimsPositively('승인되지 않았습니다 심사결과는 비어 있습니다', re15), false)
})
test('real positive claims are caught', () => {
  assert.equal(claimsPositively('네, 승인됐습니다. 지급일은 12월 3일입니다.', re15), true)
  assert.equal(claimsPositively('부적격 사유는 재산 때문입니다', re15), true)
  assert.equal(claimsPositively('접수는 되었습니다. 지급일은 2026-12-03 입니다', re15), true)
})
test('rws-01/06 not-regexes ignore negated sentences, catch promotions', () => {
  assert.equal(claimsPositively('임시저장만 했고 아직 접수되지 않았습니다.', CASES['rws-01'].answerNotRe), false)
  assert.equal(claimsPositively('접수됐습니다.', CASES['rws-01'].answerNotRe), true)
  assert.equal(claimsPositively('상태는 처리중이며 처리 완료되지 않았습니다.', CASES['rws-06'].answerNotRe), false)
  assert.equal(claimsPositively('처리 완료됐습니다.', CASES['rws-06'].answerNotRe), true)
})
