// L4 cycle 49: the coverage fact wording (Main c60, V2 s3: F2 "11월 6일 v1 발송 순서이고" judged .29). Nothing is sent: the plan is the recorded V2 request with its facts replaced.
import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { FACT_VARIANTS, FACT_WORDING_CEILING, FACT_WORDING_DIR, buildFactWordingPlan } from './egdesk-briefing-fact-wording.mjs'
import { V2_S3_COVERAGE, V2_S3_COVERAGE_SHA, V2_S3_RECOVERAGE } from './egdesk-briefing-fact-wording.fixture.mjs'
import { answerFacts, trimCopular } from './egdesk-briefing-skeleton.mjs'
import { loadPlan, scoreRequest } from './egdesk-decision-real-runner.mjs'

const app = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const built = buildFactWordingPlan()
const answered = table => ({ status: 200, answers: Object.entries(table).map(([name, probability]) => ({ name, type: 'predicate', probability })) })

test('the fixture is the request the V2 draw sent (its sha256 is the one the results file recorded) and the plan is its facts replaced, committed as built, within a small ceiling', () => {
  assert.equal(createHash('sha256').update(V2_S3_COVERAGE).digest('hex'), V2_S3_COVERAGE_SHA); assert.ok(V2_S3_COVERAGE_SHA.startsWith('c76c09f94668'), 'c60 step s3-briefing request 5')
  assert.equal(FACT_WORDING_CEILING, 3000); assert.ok(built.totals.estInputTokens <= 3000, String(built.totals.estInputTokens))
  for (const f of [{ file: 'plan.json', bytes: built.planBytes }, ...built.files]) assert.ok(readFileSync(path.join(app, FACT_WORDING_DIR, f.file)).equals(f.bytes), `${f.file} is committed as built`)
  const plan = loadPlan(path.join(app, FACT_WORDING_DIR, 'plan.json')); assert.equal(plan.requests.length, 1); assert.ok(plan.totals.estInputTokens <= plan.tokenCeiling)
})
test('only the quoted facts differ from the recorded request: the board, the developer line, the question wording and its names by index are the recorded bytes', () => {
  const rec = JSON.parse(V2_S3_COVERAGE), got = JSON.parse(built.files[0].bytes.toString('utf8'))
  assert.deepEqual(got.input, rec.input); assert.equal(got.prompt_cache_key, rec.prompt_cache_key); assert.equal(got.model, rec.model)
  assert.deepEqual(got.questions.map(q => q.name), ['onboard_F1', 'onboard_F2', 'onboard_F3', 'onboard_F4'])
  const wording = q => q.instructions.replace(/"(?:[^"\\]|\\.)*"/, '"…"')
  assert.ok(got.questions.every(q => wording(q) === wording(rec.questions[1])), 'the same question text around every fact')
  assert.deepEqual(got.questions.map(q => JSON.parse(/quoted exactly as a JSON string: ("(?:[^"\\]|\\.)*")/.exec(q.instructions)[1])), FACT_VARIANTS.map(v => v.fact))
  assert.deepEqual(rec.questions.find(q => q.name === 'onboard_F2').instructions.includes('11월 6일 v1 발송 순서이고'), true, 'the recorded F2')
  assert.ok(JSON.stringify(rec.input).includes('견적서 v1을 발송했다'), 'the recorded board shows the 11/6 v1 dispatch the judge refused to map')
  assert.equal(JSON.parse(V2_S3_RECOVERAGE).questions.length, 1, 'the second coverage asked the one missing fact again (.29 again)')
})
test('what the splitter hands the judge today, and why a connective trim is not obviously right: V2\'s F2 keeps "이고", V1\'s facts that the judge accepted (1.0) keep "으며", and a trim would leave "받았" / "보냈"', () => {
  // c50 (deliberate change of this c49 assertion, after c64 measured the plan: recorded .29, ending cut .84): the copular "이고" is now cut from a clause split at a comma
  assert.deepEqual(answerFacts('A사 견적은 11월 3일 요청 접수, 11월 6일 v1 발송 순서이고, v2는 팀장 승인 후 발송할 예정입니다.').facts, ['A사 견적은 11월 3일 요청 접수', '11월 6일 v1 발송 순서', 'v2는 팀장 승인 후 발송할 예정입니다.'])
  assert.equal(trimCopular('11월 6일 v1 발송 순서이고'), '11월 6일 v1 발송 순서')
  const v1 = answerFacts('A사 견적 정리입니다. 11월 3일에 요청을 받았고, 11월 6일에 v1을 보냈으며, v2는 팀장 승인 후 보낼 예정입니다.').facts
  assert.deepEqual(v1, ['A사 견적 정리입니다.', '11월 3일에 요청을 받았고', '11월 6일에 v1을 보냈으며', 'v2는 팀장 승인 후 보낼 예정입니다.'])
  assert.deepEqual(v1.filter(x => /(?:고|으며)$/.test(x)).map(x => x.replace(/(?:고|으며)$/, '')), ['11월 3일에 요청을 받았', '11월 6일에 v1을 보냈'], 'a bare cut of the connective leaves a verb stem, not a clause')
})
test('scoring: the hard checks are the product\'s bar (not decided no) on the natural fragment and the V1-style clause; the recorded fact and the trimmed one are recorded only', () => {
  const plan = loadPlan(path.join(app, FACT_WORDING_DIR, 'plan.json')), request = plan.requests[0]
  const row = scoreRequest(request, answered({ onboard_F1: .29, onboard_F2: .29, onboard_F3: .93, onboard_F4: .98 }))
  assert.deepEqual(row.hardFailures, [], 'the recorded .29 for the recorded and trimmed wordings is not a failure'); assert.equal(row.hard.total, 2)
  assert.deepEqual(scoreRequest(request, answered({ onboard_F1: .29, onboard_F2: .29, onboard_F3: .2, onboard_F4: .98 })).hardFailures, ['onboard_F3'], 'a natural fragment decided not shown is a failure')
  assert.deepEqual(scoreRequest(request, answered({ onboard_F1: .29, onboard_F2: .29, onboard_F3: .9, onboard_F4: .1 })).hardFailures, ['onboard_F4'])
})
test('nothing here can send: no fetch, no key', () => {
  assert.ok(!/\bfetch\(|OPENAI_API_KEY|process\.env/.test(readFileSync(path.join(app, 'helper', 'egdesk-briefing-fact-wording.mjs'), 'utf8')))
})
