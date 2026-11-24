import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadPlan } from './egdesk-decision-real-runner.mjs'
import { CONTAMINATION_CEILING, CONTAMINATION_DIR, FAMILIES, L1_SENT_SAME_MATTER_SHA256, SKIPPED, analyzeContamination, buildContaminationPlan, sameMatterBytes } from './egdesk-contamination-plan.mjs'

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', CONTAMINATION_DIR)

test('contamination plan: committed files are what the code builds today, the runner accepts them, and it fits 10k', async () => {
  const built = await buildContaminationPlan()
  assert.ok(readFileSync(path.join(dir, 'plan.json')).equals(built.planBytes), 'plan.json is stale: node scripts/egdesk-contamination-plan.mjs --write')
  assert.ok(readFileSync(path.join(dir, 'design.json')).equals(built.designBytes), 'design.json is stale')
  for (const f of built.files) assert.ok(readFileSync(path.join(dir, f.file)).equals(f.bytes), `${f.file} is stale`)
  const loaded = loadPlan(path.join(dir, 'plan.json'))
  assert.equal(loaded.requests.length, 16)
  assert.ok(built.totals.estInputTokens <= CONTAMINATION_CEILING && (loaded.tokenCeiling ?? built.plan.tokenCeiling) === 10000 && built.plan.tokenCeiling === 10000)
  for (const r of loaded.requests) assert.ok(r.expect.some(e => e.severity === 'hard') && !r.recordOnly)
})

test('contamination plan: per family the same target comes first in A, O and S; siblings carry the registered opposite or same answer', async () => {
  const built = await buildContaminationPlan()
  for (const [family, f] of Object.entries(FAMILIES)) {
    const reqs = built.requests.filter(r => r.family === family)
    assert.equal(reqs.length, 6 - SKIPPED[family].length)
    for (const r of reqs) {
      const target = r.targetSide === 'yes' ? f.yes : f.no, text = r.bytes.toString('utf8')
      const first = family === 'fill-slot' ? JSON.stringify(target.text).slice(1, -1) : target.text
      assert.equal(r.items[0].name, r.body.questions[0].name)
      assert.ok(text.includes(first), `${r.id}: target quoted`)
      // the target is the first item in the body as well as the first question
      const firstItemAt = text.indexOf(first), otherTexts = r.items.slice(1).map((_, i) => (r.layout.endsWith('O') ? (r.targetSide === 'yes' ? f.noSiblings : f.yesSiblings) : (r.targetSide === 'yes' ? f.yesSiblings : f.noSiblings))[i].text)
      for (const t of otherTexts) assert.ok(text.indexOf(family === 'fill-slot' ? JSON.stringify(t).slice(1, -1) : t) > firstItemAt, `${r.id}: sibling after target`)
      const want = r.layout === 'A' ? [] : r.layout.endsWith('O') ? [r.targetSide === 'yes' ? 'no' : 'yes'] : [r.targetSide]
      for (const s of r.items.slice(1)) assert.deepEqual([s.side], want)
      assert.equal(r.body.questions.every(q => q.type === 'predicate'), true)
      assert.equal(/egd-synthetic|sk-/.test(text), false)
    }
  }
  // The hand-built same-matter shape is the one L1 sent: rebuilt from that request's three cards it hashes to the sent body.
  const cards = [{ title: 'A사 견적서 v1 단가표', text: 'A사 견적서 v1: 품목 3종, 단가 12,000원, 수량 40개, 납기 3주.' }, { title: '점심 메뉴 투표 결과', text: '이번 주 점심은 김치찌개로 정해졌습니다. 다음 투표는 금요일입니다.' }, { title: 'B사 계약 조항 메모', text: 'B사 공급 계약 제7조 지체상금 조항 검토 메모입니다.' }]
  assert.equal(createHash('sha256').update(sameMatterBytes(FAMILIES['same-matter'].request, cards)).digest('hex'), L1_SENT_SAME_MATTER_SHA256)
  // Splitting costs more tokens than grouping in every family, and the plan says how much.
  for (const c of Object.values(built.splitCost)) assert.ok(c.splitOf3 > c.groupedOf3 && c.ratio > 1)
})

test('contamination analysis: each registered outcome is reachable and reads only the target and the O signature', async () => {
  const { design } = await buildContaminationPlan()
  const answer = (map) => Object.fromEntries(design.requests.map(r => [r.id, { status: 200, answers: r.items.map((it, i) => ({ name: it.name, type: 'predicate', probability: map(r, it, i) })) }]))
  const truth = (r, it) => (it.side === 'yes' ? 0.97 : 0.02)
  const v = res => Object.fromEntries(Object.entries(analyzeContamination(design, res)).map(([k, x]) => [k, x.verdict]))
  assert.deepEqual(Object.values(v(answer(truth))), ['KEEP GROUPING', 'KEEP GROUPING', 'KEEP GROUPING'])
  // O pulls every answer to the siblings' side, uniformly (L1's pattern); S fine: split only when siblings disagree.
  const pulled = answer((r, it) => (r.layout.endsWith('O') ? (r.targetSide === 'yes' ? 0.03 : 0.98) : truth(r, it)))
  assert.equal(v(pulled)['same-matter'], 'SPLIT ONLY WHEN SIBLINGS DISAGREE (re-ask alone when grouped answers are uniform)')
  // O moves the target but the answers are not uniform: undetectable, so split.
  const hidden = answer((r, it, i) => (r.layout.endsWith('O') && i === 0 ? (r.targetSide === 'yes' ? 0.4 : 0.7) : truth(r, it)))
  assert.equal(v(hidden).excerpt, 'SPLIT')
  // The target undecided alone: nothing follows about grouping.
  const unsure = answer((r, it, i) => (r.layout === 'yes-A' || r.layout === 'no-A' ? 0.59 : truth(r, it)))
  assert.equal(v(unsure)['fill-slot'], 'INCONCLUSIVE')
  // A missing answer is not evidence.
  const missing = Object.fromEntries(design.requests.map(r => [r.id, { status: 500 }]))
  assert.deepEqual(Object.values(v(missing)), ['INCONCLUSIVE', 'INCONCLUSIVE', 'INCONCLUSIVE'])
})
