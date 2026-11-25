import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { CONFLICT_CASES, CONTRADICTION_CASES, buildConflictPairPlan, buildContradictionPairsPlan } from './egdesk-c39-plans.mjs'
import { loadPlan } from './egdesk-decision-real-runner.mjs'
import { contradictionPairs } from './egdesk-record-settled.mjs'

// L7 c39: the two prepared plans for the questions of memory-first (cf_differs, ct_<k>): built by the product's own functions, loadable by the generic runner with the product's bars.
test('the two prepared plans load in the generic runner with the product bars; every request has a hard check naming a real question; the bodies are the product\'s', async () => {
  for (const [build, count, cases] of [[buildConflictPairPlan, 6, CONFLICT_CASES], [buildContradictionPairsPlan, 6, CONTRADICTION_CASES]]) {
    const built = await build()
    assert.equal(built.plan.requests.length, count); assert.equal(cases.length, count); assert.ok(built.plan.tokenCeiling >= built.estInputTokens); assert.ok(built.estInputTokens < 5000, 'a small plan')
    const dir = mkdtempSync(path.join(os.tmpdir(), 'c39-plan-')); mkdirSync(path.join(dir, 'requests'))
    for (const { file, bytes } of built.files) writeFileSync(path.join(dir, file), bytes)
    writeFileSync(path.join(dir, 'plan.json'), JSON.stringify(built.plan))
    const loaded = loadPlan(path.join(dir, 'plan.json'))
    assert.equal(loaded.requests.length, count); assert.ok(Object.keys(loaded.productBars).length >= 1)
    for (const r of built.plan.requests) assert.ok(r.expect.some(e => e.severity === 'hard'), r.id)
  }
  const cf = await buildConflictPairPlan(), body = id => JSON.parse(cf.files.find(f => f.file === `requests/${id}.json`).bytes)
  assert.deepEqual(body('cf-undecided-settled').questions.map(q => q.name), ['cf_differs']); assert.ok(body('cf-undecided-settled').input.at(-1).content.endsWith('아 그거 다음 주 화요일로 확정했어'))
  assert.equal(cf.plan.requests.filter(r => r.expect.some(e => e.min !== undefined)).length, 3, 'three that differ'); assert.equal(cf.plan.requests.filter(r => r.expect.some(e => e.max !== undefined)).length, 3, 'three that do not')
  const ct = await buildContradictionPairsPlan(), three = JSON.parse(ct.files.find(f => f.file === 'requests/ct-three-records.json').bytes)
  assert.deepEqual(three.questions.map(q => q.name), ['ct_0', 'ct_1', 'ct_2'], 'one request, one question per pair'); assert.equal(ct.plan.requests.length, 6)
  // the pairs of the plan are the ones the product builds from the same pages
  assert.equal(contradictionPairs(CONTRADICTION_CASES.find(c => c.id === 'ct-three-records').pages).length, 3)
})
