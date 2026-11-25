import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { lintExpectation, loadPlan } from './egdesk-decision-real-runner.mjs'
import { SKELETON_BARS } from './egdesk-briefing-skeleton.mjs'
import { BRIEFING_COVERAGE_CEILING, BRIEFING_COVERAGE_DIR, BRIEFING_COVERAGE_FACTS_CEILING, BRIEFING_COVERAGE_FACTS_DIR, boardIn, boardOf, buildBriefingCoverageFactsPlan, buildBriefingCoveragePlan, factsOf } from './egdesk-briefing-coverage-plan.mjs'

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

const factsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', BRIEFING_COVERAGE_FACTS_DIR)
test('per-fact coverage plan (c21): committed files are what the code builds today; the runner loads it with onboard_F# at SKELETON_BARS; every hard check at the product bar', async () => {
  const built = await buildBriefingCoverageFactsPlan()
  assert.ok(readFileSync(path.join(factsDir, 'plan.json')).equals(built.planBytes), 'plan.json is stale: node scripts/egdesk-briefing-coverage-plan.mjs --write')
  for (const f of built.files) assert.ok(readFileSync(path.join(factsDir, f.file)).equals(f.bytes), `${f.file} is stale`)
  const loaded = loadPlan(path.join(factsDir, 'plan.json'))
  assert.deepEqual(Object.keys(loaded.productBars), ['onboard_F#', 'stated_F#']); for (const family of ['onboard_F#', 'stated_F#']) assert.deepEqual([loaded.productBars[family].yes, loaded.productBars[family].no], [SKELETON_BARS.yes, SKELETON_BARS.no])
  for (const r of loaded.requests) for (const e of r.expect) assert.equal(lintExpectation(e, r, loaded.productBars), null, `${r.id} ${e.name}`)
  assert.deepEqual(loaded.requests.map(r => r.expect.map(e => `${e.name}:${e.severity}:${e.min ?? e.max}`)), [
    ['onboard_F1:hard:0.7', 'onboard_F2:hard:0.7', 'onboard_F3:hard:0.7'], ['onboard_F1:hard:0.7', 'onboard_F2:hard:0.7', 'onboard_F3:hard:0.3'], ['onboard_F1:soft:0.3', 'onboard_F2:hard:0.7', 'onboard_F3:hard:0.7'],
    // c37: the real check-11 board and answer: three content facts shown, two sentences about the answer itself and a derived sum recorded, and the stated question (c36)
    ['onboard_F1:soft:0.3', 'onboard_F2:soft:0.3', 'onboard_F3:hard:0.7', 'onboard_F4:hard:0.7', 'onboard_F5:hard:0.7', 'onboard_F6:soft:0.3', 'stated_F1:hard:0.3', 'stated_F2:hard:0.3', 'stated_F5:hard:0.7']])
  assert.ok(built.totals.estInputTokens <= BRIEFING_COVERAGE_FACTS_CEILING && loaded.tokenCeiling === BRIEFING_COVERAGE_FACTS_CEILING && BRIEFING_COVERAGE_FACTS_CEILING >= BRIEFING_COVERAGE_CEILING)
})
test('per-fact coverage plan (c21): the same three facts on each board; the incomplete board lacks the approval, and offline the one re-design puts the decision part back', async () => {
  const built = await buildBriefingCoverageFactsPlan(), body = f => readFileSync(path.join(factsDir, 'requests', `${f}.json`), 'utf8')
  for (const f of ['f-complete', 'f-incomplete', 'f-as-attached']) assert.deepEqual(factsOf(body(f)), ['A사 견적은 11월 3일 요청', '11월 6일 v1 발송', 'v2는 팀장 승인 후 발송 예정입니다.'])
  assert.deepEqual(boardIn(body('f-complete')).map(p => p.shown[0].label), ['A사 견적 요청', 'A사 견적서 v1과 v2', 'A사 건 결정'])
  assert.deepEqual(boardIn(body('f-incomplete')).map(p => p.shown[0].label), ['A사 견적 요청', 'A사 견적서 v1과 v2']); assert.ok(!body('f-incomplete').includes('팀장 승인 후 발송하기로'))
  assert.deepEqual(built.flows.incomplete.stages, ['place', 'fit', 'order', 'fill_check', 'coverage', 'fill_check', 'coverage'])
  assert.deepEqual(built.flows.incomplete.redesign, { parts: [{ part: 'P3', trait: 'single', component: 'result_text' }], from: 'undecided-part', because: 'fact-missing' })
  assert.deepEqual(built.flows.asAttached, { status: 'presented', unshowable: ['F1'] })
  for (const f of ['f-complete', 'f-incomplete', 'f-as-attached']) { assert.doesNotMatch(body(f), /quote\/|"key"|outputId|viewId|"rect"/); assert.ok(!body(f).includes('발송 예정입니다."\n') && body(f).split('The board, its parts quoted').length === 2) }
})

test('c37 coverage plan: the check-11 request is what the product sends today (stated_F# for the three facts with no code anchor, the materials quoted once, no answer text), and offline it presents', async () => {
  const built = await buildBriefingCoverageFactsPlan(), wire = readFileSync(path.join(factsDir, 'requests', 'f-meta-sentences.json'), 'utf8'), body = JSON.parse(wire)
  assert.deepEqual(body.questions.map(q => q.name), ['onboard_F1', 'onboard_F2', 'onboard_F3', 'onboard_F4', 'onboard_F5', 'onboard_F6', 'stated_F1', 'stated_F2', 'stated_F5'])
  assert.ok(body.input[0].content.includes('quoted materials') && body.input[1].content.split('The materials, each quoted as JSON:').length === 2)
  assert.deepEqual(boardIn(wire).map(p => p.shown[0].label), ['진행 경과', '남은 일']); assert.equal(boardIn(wire)[0].shown[0].lines.length, 3)
  assert.match(body.questions.find(q => q.name === 'stated_F1').instructions, /^The sentence, quoted exactly as a JSON string: "devlog 기록을 날짜순으로 정리했습니다\."/)
  assert.ok(!wire.includes('| 날짜 | 진행 상황 |'), 'the answer itself is not in the request, only its facts'); assert.doesNotMatch(wire, /"key"|outputId|viewId|"rect"|\/Users\//)
  assert.deepEqual(built.flows.metaSentences, { status: 'presented', stages: ['place', 'fit', 'order', 'fill_check', 'coverage', 'coverage'], unshowable: [] }) // c38: the answer has 7 facts: 6 in the first coverage request (the one in the plan), the 7th in a second
})

test('c39: the plain-fact requests are the c21 bytes again (F2 measured .96 / .99 on them); the table-row guidance is in the question of a fact that IS a table row only', async () => {
  const sha = f => createHash('sha256').update(readFileSync(path.join(factsDir, 'requests', `${f}.json`))).digest('hex').slice(0, 12)
  // c43 (plan v3): c38 had put the guidance in the request's rule text, and "11월 6일 v1 발송" fell from .96 to .21 (complete) and .04 (incomplete). These are the sha256 of the bytes that were .96.
  assert.deepEqual(['f-complete', 'f-incomplete', 'f-as-attached'].map(sha), ['8411a0b3a438', '911d93d653cf', '1246a2d3a5bd'])
  const wire = readFileSync(path.join(factsDir, 'requests', 'f-meta-sentences.json'), 'utf8'), body = JSON.parse(wire), text = n => body.questions.find(q => q.name === n).instructions
  for (const n of ['onboard_F3', 'onboard_F4', 'onboard_F5']) assert.match(text(n), /This fact is the cells of a table row joined by " · "/, n)
  for (const n of ['onboard_F1', 'onboard_F2', 'onboard_F6', 'stated_F1', 'stated_F2', 'stated_F5']) assert.doesNotMatch(text(n), /table row/, `${n}: a plain sentence gets no row guidance`)
  assert.doesNotMatch(body.input[0].content, /table row|month-day/, 'the request rule is the c21 text (plus the materials phrase of the stated request)')
})
