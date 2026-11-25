// L4 cycle 50: the copular connective of a clause fact (Main's c64 measure: recorded "…순서이고" .29, ending cut .84, natural fragment 1.0, V1's verb clause "…보냈으며" 1.0).
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { answerFacts, factAnchors, trimCopular } from './egdesk-briefing-skeleton.mjs'
import { FACT_VARIANTS } from './egdesk-briefing-fact-wording.mjs'

const app = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
// the real answers of c64 (judge numbers recorded on the V2 board): the four forms of the one fact
const C64 = { recorded: .29, 'connective-trimmed': .84, 'natural-fragment': 1, 'v1-clause': 1 }
test('the measure the rule rests on: the plan\'s four forms and Main\'s c64 numbers (the ending cut passes, the recorded form does not)', () => {
  const results = JSON.parse(readFileSync(path.join(app, 'proofs', 'decision-real-measure', 'briefing-fact-wording', 'requests', 'fact-wording.json'), 'utf8'))
  assert.deepEqual(FACT_VARIANTS.map(v => v.id), Object.keys(C64)); assert.equal(results.questions.length, 4)
  assert.ok(C64['connective-trimmed'] >= .7 && C64.recorded < .3, 'the plan\'s passRule: trimmed yes while recorded stays under .3 -> the connective is the cause')
  assert.equal(trimCopular(FACT_VARIANTS[0].fact), FACT_VARIANTS[1].fact, 'the code produces exactly the form that was measured')
})
test('copular endings are cut from a clause split at a comma: 이고, 이며, 이지만, 이면서; the clause keeps its anchors', () => {
  assert.deepEqual(['발송 순서이고', '11월 6일 v1 발송 순서이며', '단가 12,800원이지만', '승인 단계이면서'].map(trimCopular), ['발송 순서', '11월 6일 v1 발송 순서', '단가 12,800원', '승인 단계'])
  assert.deepEqual(answerFacts('11월 3일 요청 접수 단계이고, 11월 6일 v1 발송 단계이며, 12월 20일 납품 예정입니다.').facts, ['11월 3일 요청 접수 단계', '11월 6일 v1 발송 단계', '12월 20일 납품 예정입니다.'])
  for (const [raw, cut] of [['11월 6일 v1 발송 순서이고', '11월 6일 v1 발송 순서']]) assert.deepEqual(factAnchors(raw), factAnchors(cut))
})
test('what is NOT cut: verb connectives (the judge accepted them), verbs whose stem ends in 이, a bare stem, whole sentences, table rows and list items', () => {
  for (const same of ['11월 6일에 v1을 보냈으며', '11월 3일에 요청을 받았고', '단가를 12,800원으로 줄이고', '납기를 12월 20일로 높이고', '결과가 보이고', '이고', '순이고']) assert.equal(trimCopular(same), same, same)
  assert.deepEqual(answerFacts('11월 6일에 요청을 받았고, 11월 8일에 v1을 보냈으며, 12월 20일 납품 예정입니다.').facts, ['11월 6일에 요청을 받았고', '11월 8일에 v1을 보냈으며', '12월 20일 납품 예정입니다.'])
  assert.deepEqual(answerFacts('단가를 12,800원으로 줄이고, 11월 6일 v1을 보내고, 납기는 12월 20일입니다.').facts, ['단가를 12,800원으로 줄이고', '11월 6일 v1을 보내고', '납기는 12월 20일입니다.'], 'a verb with an 이 stem keeps its ending')
  assert.deepEqual(answerFacts('11월 6일 v1 발송 순서이고 12월 20일 납품입니다.').facts, ['11월 6일 v1 발송 순서이고 12월 20일 납품입니다.'], 'a whole sentence is one fact, nothing is cut')
  assert.ok(answerFacts('| 일자 | 내용 |\n|---|---|\n| 11-24 | v1 발송 순서이고 |').facts.every(f => f.includes('순서이고')), 'a table row cell is not a clause')
  assert.ok(answerFacts('- 11월 6일 v1 발송 순서이고\n- 12월 20일 납품').facts.some(f => f.includes('순서이고')), 'a list item is not a clause')
})
