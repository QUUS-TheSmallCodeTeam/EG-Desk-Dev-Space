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

// ---- c30: review of the rule (false positives found by probe, then closed) and its generalization to build / lint / type check ----
import { commandTopic, passClaim } from './egdesk-draft-run-facts.mjs'
const run = (command, exitCode, extra = {}) => ownCommandEntry({ command, exitCode, durationMs: 900, health: { health: exitCode === 0 ? 'healthy' : 'unhealthy', reasons: [], summary: extra.summary ?? null }, worktree: null, ...extra.entry })
const flagged = (text, ...entries) => runFactFindings({ claims: [{ text }], evidence: evidence(...entries) }).length === 1

test('c30 false positives: an earlier pass, a plan or prediction, a question, "안 됐어요" and negations are not statements of a pass now', () => {
  const failing = run('node --test', 1, { summary: counts(4, 1) })
  for (const honest of ['수정 전에는 모든 테스트가 통과했습니다.', '처음에는 테스트가 통과했습니다.', '앞서 돌린 테스트는 통과했습니다.', 'Before my change the tests passed.', 'The tests passed earlier.',
    '테스트가 통과하도록 고치겠습니다.', '고치면 테스트가 통과할 것입니다.', 'Tests should pass once this is fixed.', '테스트가 통과하는지 확인해 보겠습니다.', '테스트가 통과했나요?',
    '테스트가 통과 안 됐어요.', '테스트 통과가 안 돼요.', '테스트가 통과하지 않았습니다.', 'Tests do not pass yet.', '4개는 통과했지만 1개가 실패했습니다.']) assert.equal(flagged(honest, failing), false, honest)
  for (const wrong of ['모든 테스트가 통과했습니다.', '테스트가 모두 통과했습니다(5개 중 5개).', 'All tests passed.', 'All the tests pass now.', '고쳤고 전부 통과했습니다.']) assert.equal(flagged(wrong, failing), true, wrong)
})

test('c30 another suite or thing: a scope the sentence names that the command does not carry is not this rule\'s business; one it carries is', () => {
  const payroll = run('npm test -- --suite=payroll', 1, { summary: counts(3, 2) })
  assert.equal(flagged('A 모듈 테스트는 통과했습니다.', payroll), false, 'another module'); assert.equal(flagged('연결 테스트에 성공했습니다.', payroll), false, 'a connection test'); assert.equal(flagged('결제 테스트는 통과했습니다.', payroll), false)
  assert.equal(flagged('The unit tests pass.', payroll), false); assert.equal(flagged('로그인에 성공했습니다.', payroll), false, 'no topic: a lone success is about something else')
  assert.equal(flagged('payroll 테스트는 통과했습니다.', payroll), true, 'the suite the command ran'); assert.equal(flagged('모든 테스트가 통과했습니다.', payroll), true, 'everything includes it')
})

test('c30 the last command of the sentence\'s topic decides: a grep that exited 1 is no test run; a failing build does not contradict "tests passed"; unknown commands still count for tests', () => {
  const tests = run('node --test', 0, { summary: counts(5, 0) })
  assert.equal(flagged('모든 테스트가 통과했습니다.', tests, run('grep -r TODO src', 1)), false, 'the last command is a grep, the last TEST run passed')
  assert.equal(flagged('모든 테스트가 통과했습니다.', tests, run('npm run build', 1)), false, 'a failing build says nothing about tests')
  assert.equal(flagged('테스트가 통과했습니다.', run('./ci.sh', 1)), true, 'an unknown command that failed still counts for a claim about tests (the first version\'s safety kept)')
  assert.equal(flagged('테스트가 통과했습니다.', run('ls', 2)), false, 'ls is clearly no check')
  assert.equal(flagged('모두 통과했습니다.', tests, run('grep foo x', 1)), false, 'a generic "all passed": the last command that is a check (not grep) passed')
})

test('c30 generalization: build, lint and type check success claims are contradicted by the last command of that topic, and only by it', () => {
  const build = run('npm run build', 2), lint = run('npx eslint .', 1), types = run('npx tsc --noEmit', 2), okTests = run('node --test', 0, { summary: counts(5, 0) })
  assert.deepEqual([commandTopic('npm run build'), commandTopic('npx eslint .'), commandTopic('npx tsc --noEmit'), commandTopic('node --test'), commandTopic('pytest -q'), commandTopic('go test ./...'), commandTopic('git status'), commandTopic('./x.sh')], ['build', 'lint', 'typecheck', 'test', 'test', 'test', 'other', null])
  assert.equal(flagged('빌드가 성공했습니다.', build, okTests), true); assert.equal(flagged('린트도 통과했습니다.', lint, okTests), true); assert.equal(flagged('타입 체크도 통과했습니다.', types, okTests), true)
  assert.equal(flagged('Lint passed.', build), false, 'a failing build is no lint run'); assert.equal(flagged('빌드가 성공했습니다.', okTests), false, 'no build command in this turn: nothing to contradict it')
  assert.equal(flagged('빌드가 성공했습니다.', run('npm run build', 2), run('npm run build', 0)), false, 'the re-run build passed')
  assert.equal(flagged('빌드는 이전에 성공했습니다.', build), false, 'an earlier success')
  assert.deepEqual(passClaim('빌드와 린트가 통과했습니다.').topics, ['build', 'lint'])
})

test('c30 the rule inside the check: an honest sentence that mentions an earlier pass is posted untouched while a failing run stands', async () => {
  const draft = '수정 전에는 모든 테스트가 통과했습니다. 지금은 1개가 실패합니다.'
  const out = await checkDraft({ draft, evidence: FAILING, mode: 'on', client: model() })
  assert.equal(out.outcome, 'passed', JSON.stringify(out.findings)); assert.equal(out.text, draft)
})

// c30 merge with L5 c30b: the pass rule and the edit rule share one exclusion for a plan or condition, a question and "안 했/안 됐"; both rules still find their own claims
import { claimsEdit } from './egdesk-draft-run-facts.mjs'
test('shared exclusions: a plan, a question and a negation are no claim of a change either; a plain claim of a change still is one', () => {
  for (const no of ['src/a.js를 수정할 것입니다.', 'src/a.js를 고치면 됩니다.', 'src/a.js를 수정했나요?', 'src/a.js는 수정 안 했어요.', 'I will edit src/a.js.', 'Should I change src/a.js?']) assert.equal(claimsEdit(no), false, no)
  for (const yes of ['src/a.js를 수정했습니다.', '설정 파일을 고쳤습니다.', 'I fixed src/a.js.']) assert.equal(claimsEdit(yes), true, yes)
  const tests = [{ text: '모든 테스트가 통과했습니다.' }, { text: 'src/a.js를 수정했습니다.' }]
  const edit = { id: 'edit1', kind: 'run_state', time: 'present', facts: { kind: 'own_edit', path: 'src/b.js', state: 'applied' }, text: 'b' }
  const found = runFactFindings({ claims: tests, evidence: [...FAILING, edit] })
  assert.deepEqual(found.map(f => f.span).sort(), [0, 1], 'the failing test run contradicts sentence 0, the edit of another file contradicts sentence 1')
})
