// c29: "모든 테스트가 통과했습니다" against a run whose last test run counted a failure (the c29 negative on the fake: the draft check passed it, would_pass). Found by code now.
import test from 'node:test'
import assert from 'node:assert/strict'
import { checkDraft } from './egdesk-draft-check.mjs'
import { claimsPass, lastRunFacts, runFactFindings } from './egdesk-draft-run-facts.mjs'
import { ownCommandEntry, ownCommandEvidence } from './egdesk-own-command-evidence.mjs'

const entry = (exitCode, summary, extra = {}) => ownCommandEntry({ command: 'node --test', exitCode, durationMs: 900, health: { health: exitCode === 0 ? 'healthy' : 'unhealthy', reasons: [], summary }, worktree: null, ...extra })
const counts = (passed, failed) => ({ runner: 'node_test', passed, failed, total: passed + failed, line: `ℹ pass ${passed} / ℹ fail ${failed}` })
const evidence = (...entries) => entries.map((e, i) => ownCommandEvidence(e, i, { quoteLine: true }))
const PASSING = evidence(entry(0, counts(5, 0))), FAILING = evidence(entry(1, counts(4, 1)))

test('claimsPass: a sentence that says the tests passed, with no word of failure; honest sentences, other claims and partial reports are not', () => {
  for (const yes of ['모든 테스트가 통과했습니다.', '테스트가 모두 통과했습니다(5개 중 5개).', '고쳤고 전부 통과했습니다', '테스트를 다시 돌렸더니 통과했습니다.', 'All tests passed.', 'All the tests pass now.', 'Every test passed.']) assert.equal(claimsPass(yes), true, yes)
  for (const no of ['테스트 5개 중 1개가 실패했습니다.', '4개는 통과했지만 1개가 실패했습니다.', '모든 테스트가 통과한 것은 아닙니다.', '테스트가 아직 통과하지 않았습니다.', 'One test failed, the other four passed.', 'The tests did not all pass.', 'src/price.mjs를 고쳤습니다.', '파일을 읽었습니다.', '빌드 폴더를 정리했습니다.']) assert.equal(claimsPass(no), false, no)
})

test('runFactFindings: contradicted only when the LAST run counted a failure, exited non-zero, was stopped, or never finished; nothing without facts', () => {
  const claims = [{ text: '파일을 읽었습니다.' }, { text: '모든 테스트가 통과했습니다.' }]
  assert.deepEqual(runFactFindings({ claims, evidence: FAILING }), [{ kind: 'contradicted', span: 1, evidence: ['own1'], reason: 'run_facts' }])
  assert.deepEqual(runFactFindings({ claims, evidence: PASSING }), [], 'a passing run supports it')
  assert.deepEqual(runFactFindings({ claims, evidence: evidence(entry(1, counts(4, 1)), entry(0, counts(5, 0))) }), [], 'the re-run is the last: it passed')
  assert.equal(runFactFindings({ claims, evidence: evidence(entry(0, counts(5, 0)), entry(1, counts(4, 1))) }).length, 1, 'a later failing run contradicts an earlier passing one')
  assert.equal(runFactFindings({ claims, evidence: evidence(entry(1, null)) }).length, 1, 'exit code 1 without a summary')
  assert.equal(runFactFindings({ claims, evidence: evidence(entry(null, null, { stopped: true })) }).length, 1, 'stopped: it did not complete')
  assert.equal(runFactFindings({ claims, evidence: evidence(entry(null, null)) }).length, 1, 'no exit code and no counts: it never finished')
  assert.equal(runFactFindings({ claims, evidence: evidence(entry(0, null)) }).length, 0, 'exit 0 without a summary: nothing contradicts it')
  assert.deepEqual(runFactFindings({ claims, evidence: [{ id: 'x', kind: 'terminal', text: '1 failed', opaque: false }] }), [], 'text alone is no fact'); assert.equal(lastRunFacts([]), null)
  assert.deepEqual(runFactFindings({ claims: [{ text: '4개는 통과했지만 1개가 실패했습니다.' }], evidence: FAILING }), [], 'an honest report is not contradicted')
})

const answers = (names, p) => names.map(name => ({ name, type: 'predicate', probability: p(name) }))
const model = (calls = []) => ({ decide: async request => { calls.push(request); return { answers: answers(request.questions.map(q => q.name), name => (/^sup_/.test(name) ? 0.95 : 0.03)), usage: { input_tokens: 10 } } } })
const reviser = text => async () => text

test('checkDraft (predicate design), mode on: a false "all passed" is revised even though the model says it is supported; the true one passes untouched; the model being down does not let it through', async () => {
  const draft = '모든 테스트가 통과했습니다.'
  const revised = await checkDraft({ draft, evidence: FAILING, mode: 'on', client: model(), revise: reviser('테스트 5개 중 1개가 실패했습니다.') })
  assert.equal(revised.outcome, 'revised', JSON.stringify(revised.findings)); assert.equal(revised.text, '테스트 5개 중 1개가 실패했습니다.'); assert.deepEqual(revised.findings.map(f => [f.kind, f.reason]), [['contradicted', 'run_facts']])
  const passed = await checkDraft({ draft, evidence: PASSING, mode: 'on', client: model(), revise: reviser('x') })
  assert.equal(passed.outcome, 'passed'); assert.equal(passed.text, draft)
  const calls = [], down = await checkDraft({ draft, evidence: FAILING, mode: 'on', client: { decide: async r => { calls.push(r); throw new Error('unreachable') } }, revise: reviser('테스트 5개 중 1개가 실패했습니다.') })
  // the rule needs no answer from the model, so the false claim is found; the rewrite cannot be re-checked while the model is down, so nothing is posted as if checked
  assert.equal(down.outcome, 'withheld'); assert.equal(down.text, ''); assert.deepEqual(down.findings.map(f => f.reason), ['run_facts'])
  const none = await checkDraft({ draft, evidence: FAILING, mode: 'on', client: { decide: async () => { throw new Error('unreachable') } }, revise: async () => null })
  assert.equal(none.outcome, 'withheld', 'no honest rewrite: nothing is posted as if checked')
  const advisory = await checkDraft({ draft, evidence: FAILING, mode: 'advisory', client: model() })
  assert.equal(advisory.outcome, 'unchecked'); assert.equal(advisory.text, draft); assert.deepEqual(advisory.findings.map(f => f.kind), ['contradicted'], 'advisory records it and posts the draft')
})

test('checkDraft: the rule changes nothing without own-command facts (the same answers as before), and a revision that repeats the false claim is not accepted', async () => {
  const plain = { id: 'm1', kind: 'memory_page', time: 'past', text: '배포는 월요일에 끝났습니다.' }
  const before = await checkDraft({ draft: '배포는 월요일에 끝났습니다.', evidence: [plain], mode: 'on', client: model() })
  assert.equal(before.outcome, 'passed')
  const unrelated = await checkDraft({ draft: '모든 테스트가 통과했습니다.', evidence: [plain], mode: 'on', client: model() })
  assert.equal(unrelated.outcome, 'passed', 'no own command in the evidence: not this rule\'s business')
  const stubborn = await checkDraft({ draft: '모든 테스트가 통과했습니다.', evidence: FAILING, mode: 'on', client: model(), revise: reviser('고쳤고 전부 통과했습니다.') })
  assert.notEqual(stubborn.text, '고쳤고 전부 통과했습니다.', 'the rewrite says it again: it is not posted'); assert.ok(['withheld', 'certain_part'].includes(stubborn.outcome), stubborn.outcome)
})
