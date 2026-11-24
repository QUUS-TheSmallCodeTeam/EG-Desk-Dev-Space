import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { lintExpectation, loadPlan } from './egdesk-decision-real-runner.mjs'
import { SKELETON_BARS } from './egdesk-briefing-skeleton.mjs'
import { BRIEFING_COVERAGE_CEILING, BRIEFING_COVERAGE_DIR, boardOf, buildBriefingCoveragePlan } from './egdesk-briefing-coverage-plan.mjs'

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', BRIEFING_COVERAGE_DIR)

test('briefing coverage plan: committed files are what the code builds today, and lane L6 runner loads them (its productBars schema, bars from SKELETON_BARS)', async () => {
  const built = await buildBriefingCoveragePlan()
  assert.ok(readFileSync(path.join(dir, 'plan.json')).equals(built.planBytes), 'plan.json is stale: node scripts/egdesk-briefing-coverage-plan.mjs --write')
  for (const f of built.files) assert.ok(readFileSync(path.join(dir, f.file)).equals(f.bytes), `${f.file} is stale`)
  const loaded = loadPlan(path.join(dir, 'plan.json')) // throws "plan refused: ..." on a bar declaration the runner does not accept (the c19 refusal)
  assert.deepEqual(Object.keys(loaded.productBars), ['combines', 'covers', 'about_M#', 'same_M#_M#'])
  for (const bars of Object.values(loaded.productBars)) assert.deepEqual([bars.yes, bars.no], [SKELETON_BARS.yes, SKELETON_BARS.no], 'the values are the code\'s, not a plan\'s')
  for (const r of loaded.requests) for (const e of r.expect) assert.equal(lintExpectation(e, r, loaded.productBars), null, `${r.id} ${e.name}: every check, soft too, is at the product bar`)
  assert.deepEqual(loaded.requests.map(r => r.id), ['q-s3-place-new', 'q-cov-complete', 'q-cov-incomplete', 'q-cov-as-attached'])
  assert.deepEqual(loaded.requests.map(r => r.expect.filter(e => e.severity === 'hard').length), [1, 1, 1, 0])
  assert.ok(built.totals.estInputTokens <= BRIEFING_COVERAGE_CEILING && loaded.tokenCeiling === BRIEFING_COVERAGE_CEILING)
})

test('briefing coverage plan: s3 place has no "several"; the complete board has three parts in order, the incomplete one lacks the remaining work', async () => {
  const built = await buildBriefingCoveragePlan(), body = f => readFileSync(path.join(dir, 'requests', `${f}.json`), 'utf8')
  assert.deepEqual(JSON.parse(body('q-s3-place-new')).questions.map(q => q.name), ['combines', 'about_M1', 'about_M2', 'about_M3', 'same_M1_M2'])
  const complete = boardOf(body('q-cov-complete')), incomplete = boardOf(body('q-cov-incomplete'))
  assert.deepEqual(complete.map(p => p.shown[0].label), ['A사 견적 요청', 'A사 견적서 v1과 v2', 'A사 건 결정'])
  assert.deepEqual(incomplete.map(p => p.shown[0].label), ['A사 견적 요청', 'A사 견적서 v1과 v2']); assert.ok(!JSON.stringify(incomplete).includes('팀장 승인'))
  assert.deepEqual(built.flows.incomplete, { status: 'fallback-chat', reason: 'not-covered' }, 'a decided no with only a fit-no part missing: the chat answer, no re-design')
  for (const f of ['q-s3-place-new', 'q-cov-complete', 'q-cov-incomplete', 'q-cov-as-attached']) assert.doesNotMatch(body(f), /quote\/|"key"|outputId|viewId|"rect"/)
})
