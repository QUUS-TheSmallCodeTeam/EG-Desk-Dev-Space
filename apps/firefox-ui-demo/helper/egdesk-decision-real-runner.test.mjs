import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EXIT, independentEstimate, loadPlan, main, planTable, runPlan, scoreExpectation, scoreRequest, writeResults } from './egdesk-decision-real-runner.mjs'

const KEY = 'sk-test-not-a-real-key-0123456789'
const sha = text => createHash('sha256').update(text).digest('hex')
const predicate = (name, text = 'Is it so?') => ({ type: 'predicate', name, instructions: text })
const choice = (name, values) => ({ type: 'choice', name, instructions: 'Pick one.', choices: values.map(value => ({ value })) })
const bodyText = (questions, input = '공개 합성 문장입니다.') => JSON.stringify({ model: 'gpt-6-luna', input, questions }, null, 2) + '\n' // deliberately not compact: the exact bytes are what is sent

/** A plan directory with three requests. `mutate(plan, files)` may change the plan object or a file before it is written. */
function fixture(mutate = () => {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'egdesk-real-runner-'))
  mkdirSync(path.join(dir, 'requests'))
  const files = {
    a: bodyText([predicate('needs_reply'), choice('status', ['done', 'open', 'blocked'])]),
    b: bodyText([predicate('is_question'), predicate('is_secret')]),
    c: bodyText([choice('target', ['p1', 'p2', 'none'])]),
  }
  const plan = { set: 'unit', tokenCeiling: 5000, passRule: 'every request passes its hard checks', requests: [
    { id: 'a', file: 'requests/a.json', sha256: sha(files.a), estInputTokens: 400, expect: [
      { name: 'needs_reply', kind: 'predicate', min: 0.8, severity: 'hard', note: 'a direct question' },
      { name: 'status', kind: 'choice', equals: 'done', minConfidence: 0.75, severity: 'hard', note: 'reported as finished' }] },
    { id: 'b', file: 'requests/b.json', sha256: sha(files.b), estInputTokens: 300, expect: [
      { name: 'is_question', kind: 'predicate', max: 0.2, severity: 'hard', note: 'a statement' },
      { name: 'is_secret', kind: 'predicate', max: 0.2, severity: 'soft', note: 'nothing private' }] },
    { id: 'c', file: 'requests/c.json', sha256: sha(files.c), estInputTokens: 200, expect: [
      { name: 'target', kind: 'choice', oneOf: ['p1', 'p2'], severity: 'soft', note: 'either page is acceptable' }] },
  ] }
  mutate(plan, files, dir)
  for (const [id, text] of Object.entries(files)) writeFileSync(path.join(dir, 'requests', `${id}.json`), text)
  const planFile = path.join(dir, 'plan.json')
  writeFileSync(planFile, JSON.stringify(plan))
  return { dir, planFile, files, plan }
}
const pred = (name, probability) => ({ type: 'predicate', name, probability })
const pick = (name, value, values, top = 0.94) => { const rest = (1 - top) / (values.length - 1), n = values.length
  return { type: 'choice', name, choice: value, confidence: (top - 1 / n) / (1 - 1 / n), probabilities: values.map(v => ({ value: v, probability: v === value ? top : rest })) } }
const GOOD = { a: [pred('needs_reply', 0.97), pick('status', 'done', ['done', 'open', 'blocked'])], b: [pred('is_question', 0.02), pred('is_secret', 0.01)], c: [pick('target', 'p2', ['p1', 'p2', 'none'])] }
/** A mock fetch that answers per request body and records every call. `script(id, n)` may return { status } or throw. */
function mockFetch(files, answers = GOOD, script = () => null) {
  const calls = []
  const fetchImpl = async (url, init) => {
    const text = Buffer.from(init.body).toString('utf8')
    const id = Object.keys(files).find(key => files[key] === text) ?? '?'
    calls.push({ url, init, id, text })
    const scripted = script(id, calls.length)
    if (scripted?.throw) throw Object.assign(new Error('boom'), { name: scripted.throw })
    const status = scripted?.status ?? 200
    const usage = { input_tokens: scripted?.inputTokens ?? 123, output_tokens: 0, input_tokens_details: { cached_tokens: 0 } }
    return { status, headers: { get: name => (name === 'openai-processing-ms' ? '211' : name === 'x-request-id' ? 'req_secret_header' : null) },
      json: async () => (status === 200 ? { model: 'gpt-6-luna', answers: answers[id], usage } : { error: { code: 'rate_limit_exceeded', message: `do not echo ${init.headers.authorization}` } }) }
  }
  return { calls, fetchImpl }
}
const capture = () => { const out = [], err = []; return { out, err, print: line => out.push(line), printError: line => err.push(line) } }
// The run summary line (sent / stoppedBecause); since cycle 9 the usage total is printed after it, as the last line.
const summaryOf = io => JSON.parse(io.out.find(line => JSON.parse(line).stoppedBecause !== undefined))

test('loadPlan: exact file bytes are hashed and kept; the table shows what would be sent', () => {
  const f = fixture()
  const plan = loadPlan(f.planFile)
  assert.deepEqual([plan.set, plan.tokenCeiling, plan.totals.requests, plan.totals.estInputTokens], ['unit', 5000, 3, 900])
  assert.equal(plan.requests[0].bytes.toString('utf8'), f.files.a, 'the body is the file, byte for byte (not re-serialised)')
  assert.deepEqual(planTable(plan).map(row => [row.id, row.choice, row.predicate, row.hard, row.soft, row.sha.length]), [['a', 1, 1, 2, 0, 12], ['b', 0, 2, 1, 1, 12], ['c', 1, 0, 0, 1, 12]])
  assert.equal(plan.requests[0].independentEst, independentEstimate(1, 1, Buffer.byteLength(f.files.a)))
  assert.equal(plan.requests[2].expect[0].options, 3)
})

test('loadPlan refuses anything that is not exactly the declared plan', () => {
  const refused = (mutate, pattern) => assert.throws(() => loadPlan(fixture(mutate).planFile), error => error.name === 'PlanError' && pattern.test(error.message), String(pattern))
  refused((plan, files) => { files.a = files.a.replace('합성', '변조') }, /a: sha256 mismatch/)
  refused(plan => { plan.requests[0].sha256 = 'ABC' }, /sha256 must be 64 lowercase hex/)
  refused(plan => { plan.requests[0].file = '../outside.json' }, /not found|inside the plan directory/)
  refused(plan => { plan.requests[0].file = '/etc/hosts' }, /relative to the plan/)
  refused(plan => { plan.requests[1].file = 'requests/missing.json' }, /b: request file not found/)
  refused(plan => { plan.requests[1].id = 'a' }, /duplicate id a/)
  refused(plan => { plan.requests[1].id = 'bad id' }, /id must be/)
  refused(plan => { delete plan.tokenCeiling }, /tokenCeiling/)
  refused(plan => { plan.passRule = '' }, /passRule/)
  refused(plan => { plan.requests = [] }, /1 to 200 requests/)
  refused(plan => { plan.requests[0].estInputTokens = 0 }, /estInputTokens/)
  refused(plan => { plan.requests[0].expect[0].name = 'no_such_question' }, /no question with this name/)
  refused(plan => { plan.requests[0].expect[0].kind = 'choice'; plan.requests[0].expect[0].equals = 'x' }, /expected a choice but the question is predicate/)
  refused(plan => { plan.requests[0].expect[1].equals = 'finished' }, /not one of the question's choices/)
  refused(plan => { plan.requests[0].expect[1].oneOf = ['done'] }, /exactly one of equals \/ oneOf/)
  refused(plan => { delete plan.requests[0].expect[0].min }, /needs min and\/or max/)
  refused(plan => { plan.requests[0].expect[0].max = 0.5 }, /min <= max/)
  refused(plan => { plan.requests[0].expect[0].severity = 'fatal' }, /severity must be/)
  refused(plan => { plan.requests[0].expect[1].minConfidence = 2 }, /minConfidence/)
  const rehash = (plan, files, id, text) => { files[id] = text; plan.requests.find(r => r.id === id).sha256 = sha(text) }
  refused((plan, files) => rehash(plan, files, 'c', JSON.stringify({ model: 'gpt-5', input: 'x', questions: [choice('target', ['p1', 'p2', 'none'])] })), /must name model gpt-6-luna/)
  refused((plan, files) => rehash(plan, files, 'c', JSON.stringify({ model: 'gpt-6-luna', input: 'x', questions: [choice('target', ['p1', 'p2', 'none'])], endpoint: 'https://elsewhere.example' })), /unexpected body field endpoint/)
  refused((plan, files) => rehash(plan, files, 'c', JSON.stringify({ model: 'gpt-6-luna', input: 'x', questions: [choice('target', ['p1', 'p2', 'none']), choice('target', ['p1', 'p2'])] })), /not a valid Decisions request/)
  refused((plan, files) => rehash(plan, files, 'c', 'not json'), /not UTF-8 JSON/)
  // A symlink that points outside the plan directory is not a request file.
  const f = fixture(), outside = path.join(mkdtempSync(path.join(os.tmpdir(), 'egdesk-real-outside-')), 'x.json')
  writeFileSync(outside, f.files.c); symlinkSync(outside, path.join(f.dir, 'requests', 'link.json'))
  const plan = JSON.parse(readFileSync(f.planFile, 'utf8')); plan.requests[2].file = 'requests/link.json'; writeFileSync(f.planFile, JSON.stringify(plan))
  assert.throws(() => loadPlan(f.planFile), /regular file inside the plan directory/)
  assert.throws(() => loadPlan(path.join(f.dir, 'nope.json')), /cannot read the plan file/)
})

test('dry run is the default: nothing is sent even when a key is in the environment', async () => {
  const f = fixture(), mock = mockFetch(f.files), io = capture()
  const code = await main([f.planFile, '--out', path.join(f.dir, 'results.json')], { env: { OPENAI_API_KEY: KEY }, fetchImpl: mock.fetchImpl, ...io })
  assert.equal(code, EXIT.ok); assert.equal(mock.calls.length, 0)
  const head = JSON.parse(io.out[0])
  assert.deepEqual([head.mode, head.endpoint, head.requests, head.estInputTokens, head.tokenCeiling, head.withinCeiling], ['dry_run', 'https://api.openai.com/v1/decisions', 3, 900, 5000, true])
  assert.equal(summaryOf(io).stoppedBecause, 'dry_run')
  assert.deepEqual(JSON.parse(io.out.at(-1)), { usageTotal: { inputTokens: 0, declaredEstimate: 900, tokenCeiling: 5000, requestsSent: 0 } })
  assert.throws(() => statSync(path.join(f.dir, 'results.json')), /ENOENT/, 'a dry run writes no results file')
  assert.equal(io.out.join('\n').includes(KEY), false)
})

test('--send without a key: exit 3 and nothing sent; an implausible key is no key', async () => {
  const f = fixture()
  for (const env of [{}, { OPENAI_API_KEY: '' }, { OPENAI_API_KEY: 'short' }, { OPENAI_API_KEY: 'sk-with a space-0123456789012345' }]) {
    const mock = mockFetch(f.files), io = capture()
    assert.equal(await main([f.planFile, '--send'], { env, fetchImpl: mock.fetchImpl, ...io }), EXIT.noKey)
    assert.equal(mock.calls.length, 0)
    assert.match(io.err.join('\n'), /OPENAI_API_KEY is not set/)
  }
  const usage = capture(), none = mockFetch(f.files)
  for (const argv of [[], [f.planFile, '--endpoint', 'https://elsewhere.example'], [f.planFile, 'second.json'], [f.planFile, '--out']]) {
    assert.equal(await main(argv, { env: { OPENAI_API_KEY: KEY }, fetchImpl: none.fetchImpl, ...usage }), EXIT.usage, JSON.stringify(argv))
  }
  assert.equal(none.calls.length, 0, 'the endpoint is not a parameter; an unknown flag sends nothing')
})

test('refuses to start above the plan token ceiling (declared estimates), in a dry run too', async () => {
  const f = fixture(plan => { plan.tokenCeiling = 899 }), mock = mockFetch(f.files), io = capture()
  assert.equal(await main([f.planFile, '--send'], { env: { OPENAI_API_KEY: KEY }, fetchImpl: mock.fetchImpl, ...io }), EXIT.stopped)
  assert.equal(mock.calls.length, 0)
  assert.equal(summaryOf(io).stoppedBecause, 'over_token_ceiling')
  const dry = capture()
  assert.equal(await main([f.planFile], { env: {}, fetchImpl: mock.fetchImpl, ...dry }), EXIT.stopped, 'the lane sees the problem before asking for approval')
  assert.equal(JSON.parse(dry.out[0]).withinCeiling, false)
  const exact = fixture(plan => { plan.tokenCeiling = 900 }), ok = mockFetch(exact.files)
  assert.equal((await runPlan({ plan: loadPlan(exact.planFile), key: KEY, send: true, fetchImpl: ok.fetchImpl })).sent, 3, 'exactly at the ceiling is allowed')
})

test('a real run: official endpoint, exact bytes, no redirect, one POST each; results file is 0600 and never holds the key', async () => {
  const f = fixture(), mock = mockFetch(f.files), io = capture(), out = path.join(f.dir, 'results.json')
  writeFileSync(out, 'old'); chmodSync(out, 0o644)
  let clock = 0
  const code = await main([f.planFile, '--send', '--out', out], { env: { OPENAI_API_KEY: KEY }, fetchImpl: mock.fetchImpl, now: () => (clock += 125), ...io })
  assert.equal(code, EXIT.ok)
  assert.deepEqual(mock.calls.map(call => call.id), ['a', 'b', 'c'])
  for (const call of mock.calls) {
    assert.equal(call.url, 'https://api.openai.com/v1/decisions')
    assert.deepEqual([call.init.method, call.init.redirect, call.init.headers.authorization, call.init.headers['content-type']], ['POST', 'error', `Bearer ${KEY}`, 'application/json'])
    assert.equal(sha(call.init.body), f.plan.requests.find(r => r.id === call.id).sha256, 'the bytes on the wire hash to the plan')
    assert.ok(call.init.signal instanceof AbortSignal)
  }
  assert.equal(statSync(out).mode & 0o777, 0o600)
  const raw = readFileSync(out, 'utf8'), saved = JSON.parse(raw)
  assert.equal(raw.includes(KEY), false); assert.equal(raw.includes('req_secret_header'), false); assert.equal(io.out.concat(io.err).join('\n').includes(KEY), false)
  assert.deepEqual([saved.set, saved.endpoint, saved.automaticRetries, saved.outcome.sent, saved.outcome.stoppedBecause, saved.outcome.usage.inputTokens], ['unit', 'https://api.openai.com/v1/decisions', 0, 3, null, 369])
  assert.deepEqual(saved.results.a, { status: 200, elapsedMs: 125, openaiProcessingMs: '211', model: 'gpt-6-luna', usage: { input_tokens: 123, output_tokens: 0, cached_tokens: 0 }, answers: GOOD.a })
  assert.deepEqual([saved.scorecard.requestsPassed, saved.scorecard.hardFailures, saved.scorecard.softMisses, saved.scorecard.allAnsweredPassed], ['3/3', 0, 0, true])
  const status = saved.scorecard.requests[0].checks[1]
  assert.deepEqual([status.pass, status.observed.choice, status.observed.options, status.observed.top, status.observed.margin], [true, 'done', 3, 0.94, 0.91])
  assert.ok(Math.abs(status.observed.confidence - 0.91) < 1e-9, 'confidence is recorded as reported (chance-corrected)')
})

test('no retries: the first HTTP failure, network error or timeout stops the run and later requests are not sent', async () => {
  for (const [script, stopped, exit] of [[(id) => (id === 'b' ? { status: 429 } : null), 'http_429', EXIT.stopped], [(id) => (id === 'b' ? { throw: 'TypeError' } : null), 'network', EXIT.stopped],
    [(id) => (id === 'b' ? { throw: 'AbortError' } : null), 'timeout', EXIT.stopped]]) {
    const f = fixture(), mock = mockFetch(f.files, GOOD, script), io = capture(), out = path.join(f.dir, 'r.json')
    assert.equal(await main([f.planFile, '--send', '--out', out], { env: { OPENAI_API_KEY: KEY }, fetchImpl: mock.fetchImpl, ...io }), exit)
    assert.deepEqual(mock.calls.map(call => call.id), ['a', 'b'], `${stopped}: b is tried once, c never`)
    const saved = JSON.parse(readFileSync(out, 'utf8'))
    assert.equal(saved.outcome.stoppedBecause, stopped)
    assert.deepEqual(saved.scorecard.requests.map(row => row.state), ['answered', 'failed', 'not_sent'])
    assert.deepEqual([saved.scorecard.requestsPassed, saved.scorecard.notSent, saved.scorecard.allAnsweredPassed], ['1/3', 1, false])
    assert.equal(JSON.stringify(saved).includes(KEY), false, 'an upstream error text that echoes the header is not stored')
    if (stopped === 'http_429') assert.deepEqual([saved.results.b.status, saved.results.b.apiCode, saved.results.b.answers], [429, 'rate_limit_exceeded', []])
  }
})

test('a body that changed after the plan was loaded sends nothing; reported usage above the ceiling stops the run', async () => {
  const f = fixture(), plan = loadPlan(f.planFile), mock = mockFetch(f.files)
  plan.requests[2].bytes = Buffer.from(f.files.c.replace('합성', '변조'))
  const outcome = await runPlan({ plan, key: KEY, send: true, fetchImpl: mock.fetchImpl })
  assert.deepEqual([outcome.sent, outcome.stoppedBecause, outcome.mismatch, mock.calls.length], [0, 'hash_mismatch', 'c', 0], 'even the unchanged requests are not sent')
  const g = fixture(p => { p.tokenCeiling = 1000 }), heavy = mockFetch(g.files, GOOD, () => ({ inputTokens: 600 }))
  const stopped = await runPlan({ plan: loadPlan(g.planFile), key: KEY, send: true, fetchImpl: heavy.fetchImpl })
  assert.deepEqual([stopped.sent, stopped.stoppedBecause, stopped.usage.inputTokens, heavy.calls.length], [2, 'token_ceiling_reached', 1200, 2])
  const dry = await runPlan({ plan: loadPlan(g.planFile), key: KEY, fetchImpl: heavy.fetchImpl })
  assert.deepEqual([dry.sent, dry.stoppedBecause, dry.scorecard], [0, 'dry_run', null])
})

test('scoring: bounds are inclusive, a soft miss does not fail a request, an unreadable answer fails its check', async () => {
  const f = fixture(), plan = loadPlan(f.planFile), [a, b, c] = plan.requests
  const p = (expectation, value) => scoreExpectation(expectation, value === null ? undefined : { type: 'predicate', probability: value }).pass
  assert.deepEqual([p(a.expect[0], 0.8), p(a.expect[0], 0.7999), p(b.expect[0], 0.2), p(b.expect[0], 0.21), p(a.expect[0], null)], [true, false, true, false, false])
  assert.equal(p({ name: 'x', kind: 'predicate', min: 0.3, max: 0.7, severity: 'soft', note: '' }, 0.5), true)
  const values = ['done', 'open', 'blocked']
  const low = scoreExpectation(a.expect[1], pick('status', 'done', values, 0.7))
  assert.deepEqual([low.pass, low.reason, low.observed.choice], [false, 'below_min_confidence', 'done'], 'right value, confidence 0.55 below the 0.75 bar')
  const other = scoreExpectation(a.expect[1], pick('status', 'open', values))
  assert.deepEqual([other.pass, other.reason], [false, 'other_choice'])
  assert.deepEqual([scoreExpectation(a.expect[1], { type: 'refusal' }).pass, scoreExpectation(a.expect[1], { type: 'refusal' }).observed], [false, { state: 'refusal' }])
  assert.equal(scoreExpectation(c.expect[0], pick('target', 'p1', ['p1', 'p2', 'none'], 0.4)).pass, true, 'oneOf without minConfidence accepts any confidence')
  // Request level, through the product's own answer normaliser.
  const softMiss = scoreRequest(b, { status: 200, answers: [pred('is_question', 0.05), pred('is_secret', 0.6)] })
  assert.deepEqual([softMiss.pass, softMiss.hardFailures, softMisses(softMiss)], [true, [], ['is_secret']])
  const hardMiss = scoreRequest(b, { status: 200, answers: [pred('is_question', 0.9), pred('is_secret', 0.01)] })
  assert.deepEqual([hardMiss.pass, hardMiss.hardFailures], [false, ['is_question']])
  const refusal = scoreRequest(a, { status: 200, answers: [{ type: 'refusal', name: 'needs_reply' }, { name: 'status', type: 'choice', choice: 'not-an-option', confidence: 1, probabilities: [] }] })
  assert.deepEqual([refusal.pass, refusal.hardFailures, refusal.checks.map(check => check.observed.state)], [false, ['needs_reply', 'status'], ['refusal', 'invalid']])
  assert.deepEqual(scoreRequest(a, { status: 200, answers: [] }).hardFailures, ['needs_reply', 'status'], 'a missing answer is a failed check, never a pass')
  assert.equal(scoreRequest(a, undefined).state, 'not_sent'); assert.equal(scoreRequest(a, { status: 500, answers: [] }).state, 'failed')
  // End to end with one hard failure and one soft miss.
  const answers = { ...GOOD, a: [pred('needs_reply', 0.4), pick('status', 'done', values)], c: [pick('target', 'none', ['p1', 'p2', 'none'])] }
  const outcome = await runPlan({ plan, key: KEY, send: true, fetchImpl: mockFetch(f.files, answers).fetchImpl })
  assert.deepEqual([outcome.scorecard.requestsPassed, outcome.scorecard.hardFailures, outcome.scorecard.softMisses, outcome.scorecard.allAnsweredPassed], ['2/3', 1, 1, false])
  const file = path.join(f.dir, 'direct.json'); writeResults(file, outcome, new Date('2026-11-24T10:00:00Z'))
  assert.deepEqual([statSync(file).mode & 0o777, JSON.parse(readFileSync(file, 'utf8')).at], [0o600, '2026-11-24T10:00:00.000Z'])
})
function softMisses(row) { return row.softMisses }

// ---- cycle 9: score expectations and no silent pass ----
const scoreQ = (name, levels = ['negligible', 'low', 'moderate', 'high', 'critical']) => ({ type: 'score', name, instructions: 'How risky?', levels: levels.map(label => ({ label })) })
const scoreAnswer = (name, score, confidence, top = 0.8) => ({ type: 'score', name, score, confidence, probabilities: [{ value: Math.round(score), label: 'x', probability: top }, { value: 0, label: 'y', probability: 1 - top }] })
function scoreFixture(mutate = () => {}) {
  return fixture((plan, files) => {
    files.d = bodyText([scoreQ('risk')], 'git reset --hard HEAD~5 on a clean tree')
    files.e = bodyText([scoreQ('risk')], 'npm publish')
    plan.requests.push(
      { id: 'd', file: 'requests/d.json', sha256: sha(files.d), estInputTokens: 150, expect: [
        { name: 'risk', kind: 'score', min: 2.5, severity: 'hard', note: 'discarding five commits must reach the approval bar' },
        { name: 'risk', kind: 'score', minConfidence: 0.75, severity: 'soft', note: 'and the model should be sure of it' }] },
      { id: 'e', file: 'requests/e.json', sha256: sha(files.e), estInputTokens: 150, expect: [], recordOnly: true })
    mutate(plan, files)
  })
}

test('score expectations: validated against the question levels, bounds are a conjunction, inclusive, and the observed score is kept', async () => {
  const f = scoreFixture(), plan = loadPlan(f.planFile)
  const d = plan.requests.find(r => r.id === 'd')
  assert.deepEqual(d.expect[0], { name: 'risk', kind: 'score', severity: 'hard', note: 'discarding five commits must reach the approval bar', min: 2.5, levels: 5 })
  const check = (expectation, answer) => scoreExpectation(expectation, answer)
  const at = { name: 'risk', kind: 'score', min: 2.5, max: 3.5, minConfidence: 0.75, maxConfidence: 0.95, severity: 'hard', note: '', levels: 5 }
  assert.equal(check(at, scoreAnswer('risk', 2.5, 0.75)).pass, true, 'all bounds inclusive (lower)')
  assert.equal(check(at, scoreAnswer('risk', 3.5, 0.95)).pass, true, 'all bounds inclusive (upper)')
  assert.deepEqual([check(at, scoreAnswer('risk', 2.14, 0.8)).pass, check(at, scoreAnswer('risk', 2.14, 0.8)).reason], [false, 'below_min'], 'the measured git reset answer fails a min 2.5 check')
  assert.equal(check(at, scoreAnswer('risk', 3.6, 0.8)).reason, 'above_max')
  assert.equal(check(at, scoreAnswer('risk', 3, 0.5)).reason, 'below_min_confidence')
  assert.equal(check(at, scoreAnswer('risk', 3, 0.99)).reason, 'above_max_confidence')
  assert.equal(check(at, scoreAnswer('risk', 1, 0.2)).reason, 'below_min+below_min_confidence', 'every failed bound is named')
  assert.deepEqual(check(at, scoreAnswer('risk', 2.77, 0.64, 0.66)).observed, { score: 2.77, confidence: 0.64, top: 0.66, topLevel: 3, levels: 5 })
  assert.deepEqual([check(at, { type: 'refusal' }).pass, check(at, { type: 'refusal' }).observed], [false, { state: 'refusal' }])
  assert.equal(check(at, { type: 'predicate', probability: 1 }).pass, false, 'another answer type is a failed check')
  const refused = (mutate, pattern) => assert.throws(() => loadPlan(scoreFixture(mutate).planFile), error => error.name === 'PlanError' && pattern.test(error.message), String(pattern))
  refused(plan => { plan.requests[3].expect[0] = { name: 'risk', kind: 'score', severity: 'hard', note: 'x' } }, /needs at least one of min, max, minConfidence, maxConfidence/)
  refused(plan => { plan.requests[3].expect[0].min = 5 }, /min must be a level between 0 and 4/)
  refused(plan => { plan.requests[3].expect[0].max = 1 }, /min must be <= max/)
  refused(plan => { plan.requests[3].expect[1].maxConfidence = 0.5 }, /minConfidence must be <= maxConfidence/)
  refused(plan => { plan.requests[3].expect[1].minConfidence = 1.5 }, /minConfidence must be a probability/)
  refused(plan => { plan.requests[0].expect[0] = { name: 'needs_reply', kind: 'score', min: 1, severity: 'hard', note: 'x' } }, /expected a score but the question is predicate/)
  refused(plan => { plan.requests[3].expect[0] = { name: 'risk', kind: 'predicate', min: 0.5, severity: 'hard', note: 'x' } }, /expected a predicate but the question is score/)
  refused(plan => { plan.requests[3].expect[0].kind = 'rank' }, /kind must be "predicate", "choice" or "score"/)
})

test('no silent pass: a request with no expectations is refused unless it is marked recordOnly, and a recorded request is never counted as passed', async () => {
  const refused = (mutate, pattern) => assert.throws(() => loadPlan(scoreFixture(mutate).planFile), error => error.name === 'PlanError' && pattern.test(error.message), String(pattern))
  refused(plan => { delete plan.requests[4].recordOnly }, /e: no expectations; add expectations, or mark the request "recordOnly": true/)
  refused(plan => { plan.requests[4].recordOnly = 'yes' }, /recordOnly must be true when present/)
  refused(plan => { plan.requests[4].recordOnly = false }, /recordOnly must be true when present/)
  refused(plan => { plan.requests[3].recordOnly = true }, /d: a recordOnly request carries no expectations/)
  // The exact situation of the command plan: the six risk requests had expect [] and the run said "pass".
  const f = scoreFixture(), plan = loadPlan(f.planFile)
  assert.deepEqual(planTable(plan).map(row => [row.id, row.recordOnly, row.hard, row.soft]), [['a', false, 2, 0], ['b', false, 1, 1], ['c', false, 0, 1], ['d', false, 1, 1], ['e', true, 0, 0]])
  const answers = { ...GOOD, d: [scoreAnswer('risk', 2.14, 0.8)], e: [scoreAnswer('risk', 1.66, 0.43)] }
  const mock = mockFetch(f.files, answers), io = capture(), out = path.join(f.dir, 'r.json')
  assert.equal(await main([f.planFile, '--send', '--out', out], { env: { OPENAI_API_KEY: KEY }, fetchImpl: mock.fetchImpl, ...io }), EXIT.ok)
  assert.deepEqual(mock.calls.map(call => call.id), ['a', 'b', 'c', 'd', 'e'], 'the record-only request is still sent, once, in order')
  const saved = JSON.parse(readFileSync(out, 'utf8'))
  const rows = Object.fromEntries(saved.scorecard.requests.map(row => [row.id, row]))
  assert.deepEqual([rows.e.state, rows.e.pass, rows.e.checks], ['recorded', null, []])
  assert.deepEqual(saved.results.e.answers, answers.e, 'its answers are kept for later scoring')
  assert.deepEqual([rows.d.pass, rows.d.hardFailures, rows.d.hard, rows.d.soft], [false, ['risk'], { passed: 0, total: 1 }, { passed: 1, total: 1 }])
  assert.deepEqual([saved.scorecard.requestsPassed, saved.scorecard.recordedOnly, saved.scorecard.hardFailures, saved.scorecard.allAnsweredPassed], ['3/4', 1, 1, false],
    'requestsPassed counts checked requests only; the recorded one is neither a pass nor hidden')
  // Printed: per request hard/soft outcome, and the usage total at the end.
  const lines = io.out.map(line => JSON.parse(line))
  const perRequest = lines.filter(line => line.state)
  assert.deepEqual(perRequest.map(line => [line.id, line.state, line.pass, line.hard ?? null, line.soft ?? null]),
    [['a', 'answered', true, '2/2', '0/0'], ['b', 'answered', true, '1/1', '1/1'], ['c', 'answered', true, '0/0', '1/1'], ['d', 'answered', false, '0/1', '1/1'], ['e', 'recorded', null, null, null]])
  assert.deepEqual(lines.at(-1), { usageTotal: { inputTokens: 615, declaredEstimate: 1200, tokenCeiling: 5000, requestsSent: 5 } })
  assert.equal(io.out.join('\n').includes(KEY), false)
  // A plan whose every request is record-only can never report "all passed".
  const only = fixture(p => { for (const r of p.requests) { r.expect = []; r.recordOnly = true } })
  const run = await runPlan({ plan: loadPlan(only.planFile), key: KEY, send: true, fetchImpl: mockFetch(only.files).fetchImpl })
  assert.deepEqual([run.scorecard.requestsPassed, run.scorecard.recordedOnly, run.scorecard.allAnsweredPassed], ['0/0', 3, false])
})

test('the existing guarantees hold with score and record-only requests in the plan', async () => {
  const f = scoreFixture()
  const none = mockFetch(f.files), dry = capture()
  assert.equal(await main([f.planFile], { env: { OPENAI_API_KEY: KEY }, fetchImpl: none.fetchImpl, ...dry }), EXIT.ok)
  assert.equal(none.calls.length, 0, 'dry run by default')
  assert.deepEqual(JSON.parse(dry.out.at(-1)), { usageTotal: { inputTokens: 0, declaredEstimate: 1200, tokenCeiling: 5000, requestsSent: 0 } })
  const noKey = capture()
  assert.equal(await main([f.planFile, '--send'], { env: {}, fetchImpl: none.fetchImpl, ...noKey }), EXIT.noKey)
  assert.equal(none.calls.length, 0)
  const stop = mockFetch(f.files, GOOD, id => (id === 'd' ? { status: 500 } : null))
  const stopped = await runPlan({ plan: loadPlan(f.planFile), key: KEY, send: true, fetchImpl: stop.fetchImpl })
  assert.deepEqual([stopped.stoppedBecause, stop.calls.map(call => call.id), stopped.scorecard.requests.map(row => row.state)], ['http_500', ['a', 'b', 'c', 'd'], ['answered', 'answered', 'answered', 'failed', 'not_sent']])
  const tight = scoreFixture(p => { p.tokenCeiling = 1199 }), refusedRun = mockFetch(tight.files)
  assert.equal((await runPlan({ plan: loadPlan(tight.planFile), key: KEY, send: true, fetchImpl: refusedRun.fetchImpl })).stoppedBecause, 'over_token_ceiling')
  assert.equal(refusedRun.calls.length, 0)
  for (const call of stop.calls) { assert.equal(call.url, 'https://api.openai.com/v1/decisions'); assert.equal(call.init.redirect, 'error') }
})

test('whenAccepted: a choice check that fails only on a wrong install at the given bar; validated at load', () => {
  const ok = fixture(plan => { plan.requests[2].expect = [{ name: 'target', kind: 'choice', oneOf: ['p1', 'p2'], whenAccepted: { minConfidence: 0.85, minMargin: 0.2 }, severity: 'hard', note: 'no wrong install' }] })
  const loaded = loadPlan(ok.planFile)
  const e = loaded.requests[2].expect[0]
  assert.deepEqual(e.whenAccepted, { minConfidence: 0.85, minMargin: 0.2 })
  const answer = (value, confidence, rows) => ({ type: 'choice', choice: value, confidence, probabilities: rows.map(([v, p]) => ({ value: v, probability: p })) })
  // Wrong top choice, but below the bar: nothing would be installed, so the check passes.
  assert.equal(scoreExpectation(e, answer('none', 0.6, [['none', 0.73], ['p1', 0.2], ['p2', 0.07]])).pass, true)
  // Wrong top choice above both bars: a wrong install.
  const wrong = scoreExpectation(e, answer('none', 0.95, [['none', 0.97], ['p1', 0.02], ['p2', 0.01]]))
  assert.deepEqual([wrong.pass, wrong.reason, wrong.observed.accepted], [false, 'wrong_install', true])
  // Confidence clears the bar but the margin does not: not installed.
  assert.equal(scoreExpectation(e, answer('none', 0.9, [['none', 0.55], ['p1', 0.4], ['p2', 0.05]])).pass, true)
  // A partial distribution: the unreported mass counts as the runner-up, as the product does.
  assert.equal(scoreExpectation(e, answer('none', 0.9, [['none', 0.5], ['p1', 0.05]])).pass, true) // 0.45 unreported: margin 0.05
  assert.equal(scoreExpectation(e, answer('none', 0.9, [['none', 0.6], ['p1', 0.05]])).pass, false) // 0.35 unreported: margin 0.25, installed
  // Exactly at the bar is accepted (inclusive), and an expected value installed is a pass.
  assert.equal(scoreExpectation(e, answer('none', 0.85, [['none', 0.6], ['p1', 0.4], ['p2', 0]])).pass, false)
  assert.equal(scoreExpectation(e, answer('p2', 0.99, [['p2', 0.99], ['p1', 0.01], ['none', 0]])).pass, true)
  // A refused or missing answer still fails its check.
  assert.equal(scoreExpectation(e, undefined).pass, false)
  for (const [bad, why] of [[{ minConfidence: 0.85 }, /whenAccepted needs exactly/], [{ minConfidence: 2, minMargin: 0.2 }, /whenAccepted needs exactly/], [[0.85, 0.2], /whenAccepted needs exactly/]]) {
    const f = fixture(plan => { plan.requests[2].expect = [{ name: 'target', kind: 'choice', oneOf: ['p1'], whenAccepted: bad, severity: 'hard', note: 'x' }] })
    assert.throws(() => loadPlan(f.planFile), why)
  }
  const both = fixture(plan => { plan.requests[2].expect = [{ name: 'target', kind: 'choice', oneOf: ['p1'], minConfidence: 0.5, whenAccepted: { minConfidence: 0.85, minMargin: 0.2 }, severity: 'hard', note: 'x' }] })
  assert.throws(() => loadPlan(both.planFile), /either minConfidence or whenAccepted/)
})

test('productBars: a hard check looser than the declared product bar is refused at load (dry run and send), unless it is marked diagnostic', async () => {
  const bars = { '*predicate': { yes: 0.8, no: 0.2, source: 'unit' }, '*choice': { minConfidence: 0.75, minMargin: 0.2 } }
  // a: needs_reply min .8 (ok) and status equals done minConfidence .75 but no minMargin (looser on margin)
  const loose = fixture(plan => { plan.productBars = bars })
  assert.throws(() => loadPlan(loose.planFile), /looser than the declared product bars.*status \(status\): minMargin none < product 0.2/)
  // main refuses it before anything else, in dry run and with --send
  for (const args of [[loose.planFile], [loose.planFile, '--send']]) {
    const io = capture(); let calls = 0
    const code = await main(args, { env: { OPENAI_API_KEY: KEY }, fetchImpl: async () => { calls++; return new Response('{}') }, print: io.print, printError: io.printError })
    assert.deepEqual([code, calls], [EXIT.usage, 0]); assert.match(io.err.join('\n'), /looser than the declared product bars/)
  }
  // the L4 case: several >= .7 against a product yes bar of .8
  const l4 = fixture(plan => { plan.productBars = bars; plan.requests[0].expect[0].min = 0.7; plan.requests[0].expect[1].minMargin = 0.2 })
  assert.throws(() => loadPlan(l4.planFile), /needs_reply \(needs_reply\): min 0.7 < product yes bar 0.8/)
  // max above the no bar
  const maxLoose = fixture(plan => { plan.productBars = bars; plan.requests[0].expect[1].minMargin = 0.2; plan.requests[1].expect[0].max = 0.5 })
  assert.throws(() => loadPlan(maxLoose.planFile), /is_question \(is_question\): max 0.5 > product no bar 0.2/)
  // the same looser check marked diagnostic loads; soft checks are never linted
  const diag = fixture(plan => { plan.productBars = bars; plan.requests[0].expect[0].min = 0.7; plan.requests[0].expect[0].diagnostic = true; plan.requests[0].expect[1].minMargin = 0.2 })
  const ok = loadPlan(diag.planFile)
  assert.equal(ok.diagnostic, 1); assert.equal(ok.requests[0].expect[0].diagnostic, true)
  // a family bar wins over the kind default; a hard check with no bar at all is refused
  const fam = fixture(plan => { plan.productBars = { needs_reply: { yes: 0.7 }, '*choice': { minConfidence: 0.75, minMargin: 0.2 }, '*predicate': { yes: 0.8, no: 0.2 } }; plan.requests[0].expect[0].min = 0.7; plan.requests[0].expect[1].minMargin = 0.2 })
  assert.equal(loadPlan(fam.planFile).productBars.needs_reply.yes, 0.7)
  const none = fixture(plan => { plan.productBars = { '*choice': { minConfidence: 0.75, minMargin: 0.2 } }; plan.requests[0].expect[1].minMargin = 0.2 })
  assert.throws(() => loadPlan(none.planFile), /no product bar declared for family needs_reply or kind predicate/)
  // a whenAccepted wrong-install check at a STRICTER bar than the product's would miss installs: refused
  const wa = fixture(plan => { plan.productBars = bars; plan.requests[0].expect[1].minMargin = 0.2; plan.requests[2].expect = [{ name: 'target', kind: 'choice', oneOf: ['p1'], whenAccepted: { minConfidence: 0.9, minMargin: 0.2 }, severity: 'hard', note: 'x' }] })
  assert.throws(() => loadPlan(wa.planFile), /whenAccepted confidence 0.9 > product 0.75/)
  // malformed bars and flags
  for (const [mutate, why] of [[p => { p.productBars = { '*predicate': { yes: 0.2, no: 0.8 } } }, /no must be below yes/], [p => { p.productBars = { '*predicate': { bar: 0.8 } } }, /only yes, no/], [p => { p.productBars = {} }, /productBars must be/],
    [p => { p.requests[0].expect[0].diagnostic = 'yes' }, /diagnostic must be true/]]) assert.throws(() => loadPlan(fixture(mutate).planFile), why)
  // without productBars nothing is refused, and the runner says the checks were not compared
  const io = capture()
  assert.equal(await main([fixture().planFile], { env: {}, fetchImpl: async () => new Response('{}'), print: io.print, printError: io.printError }), EXIT.ok)
  assert.ok(io.out.some(line => /"productBars":"not declared"/.test(line)))
})

test('choice minMargin: the product margin (runner-up includes unreported mass) must reach it', () => {
  const e = { name: 'status', kind: 'choice', equals: 'done', minConfidence: 0.75, minMargin: 0.2, severity: 'hard', note: '', options: 3 }
  const a = (conf, rows) => ({ type: 'choice', choice: 'done', confidence: conf, probabilities: rows.map(([value, probability]) => ({ value, probability })) })
  assert.equal(scoreExpectation(e, a(0.8, [['done', 0.85], ['open', 0.1], ['blocked', 0.05]])).pass, true)
  const narrow = scoreExpectation(e, a(0.8, [['done', 0.55], ['open', 0.4], ['blocked', 0.05]]))
  assert.deepEqual([narrow.pass, narrow.reason], [false, 'below_min_margin'])
  assert.equal(scoreExpectation(e, a(0.8, [['done', 0.6], ['open', 0.05]])).pass, true) // .35 unreported: margin .25
  assert.equal(scoreExpectation(e, a(0.8, [['done', 0.5], ['open', 0.05]])).pass, false) // .45 unreported: margin .05
})

test('grouped-question lint: a request whose grouped questions do not each carry their own item is refused (dry run and send) unless it is diagnostic', async () => {
  const same = 'Is the work about the same matter as the card quoted under this question?'
  const c12 = bodyText([predicate('same_matter_R1', same), predicate('same_matter_R2', same)], [{ role: 'user', content: 'Question same_matter_R1:\n"""A사 견적서 v1"""' }, { role: 'user', content: 'Question same_matter_R2:\n"""점심 메뉴"""' }])
  const add = (diagnostic, plan, files) => {
    files.d = c12
    plan.requests.push({ id: 'd', file: 'requests/d.json', sha256: sha(c12), estInputTokens: 200, ...(diagnostic === undefined ? {} : { diagnostic }), expect: [{ name: 'same_matter_R1', kind: 'predicate', min: 0.8, severity: 'hard', note: 'x' }] })
  }
  const refused = fixture((plan, files) => add(undefined, plan, files))
  assert.throws(() => loadPlan(refused.planFile), /d: grouped questions do not each carry their own item \(same_matter_R#: identical_instructions\)/)
  for (const args of [[refused.planFile], [refused.planFile, '--send']]) {
    const io = capture(); let calls = 0
    const code = await main(args, { env: { OPENAI_API_KEY: KEY }, fetchImpl: async () => { calls++; return new Response('{}') }, print: io.print, printError: io.printError })
    assert.deepEqual([code, calls], [EXIT.usage, 0])
  }
  const marked = fixture((plan, files) => add(true, plan, files))
  const loaded = loadPlan(marked.planFile)
  const row = planTable(loaded).find(r => r.id === 'd')
  assert.deepEqual([row.diagnostic, row.groupingLint], [true, 'fails'])
  assert.equal(planTable(loaded).find(r => r.id === 'a').groupingLint, undefined, 'a clean request shows nothing')
  assert.throws(() => loadPlan(fixture((plan, files) => add('yes', plan, files)).planFile), /diagnostic must be true when present/)
  // the same two cards quoted INSIDE their questions (L1 c13) load without any mark
  const c13 = bodyText([predicate('same_matter_R1', `${same}\nThe card:\n"""\nA사 견적서 v1\n"""`), predicate('same_matter_R2', `${same}\nThe card:\n"""\n점심 메뉴\n"""`)])
  const fixed = fixture((plan, files) => { files.d = c13; plan.requests.push({ id: 'd', file: 'requests/d.json', sha256: sha(c13), estInputTokens: 200, expect: [{ name: 'same_matter_R1', kind: 'predicate', min: 0.8, severity: 'hard', note: 'x' }] }) })
  assert.equal(loadPlan(fixed.planFile).requests.find(r => r.id === 'd').groupingOk, true)
})

test('waitBeforeMs: the runner pauses before a request (never a retry), records the pause, validates bounds, and a dry run neither waits nor sends', async () => {
  const f = fixture(plan => { plan.requests[1].waitBeforeMs = 20000; plan.requests[2].waitBeforeMs = 70000 })
  const plan = loadPlan(f.planFile)
  assert.deepEqual([plan.requests.map(r => r.waitBeforeMs), plan.totals.waitMs], [[0, 20000, 70000], 90000])
  assert.deepEqual(planTable(plan).map(r => r.waitBeforeMs ?? 0), [0, 20000, 70000])
  const events = [], m = mockFetch(f.files)
  const fetchImpl = async (url, init) => { events.push('send'); return m.fetchImpl(url, init) }
  const sleep = async ms => { events.push(`wait ${ms}`) }
  const out = await runPlan({ plan, key: KEY, send: true, fetchImpl, sleep })
  assert.deepEqual(events, ['send', 'wait 20000', 'send', 'wait 70000', 'send'])
  assert.deepEqual([out.results.a.waitedMs, out.results.b.waitedMs, out.results.c.waitedMs], [undefined, 20000, 70000])
  // a failure stops the run: no wait for, and no send of, anything after it
  const stopEvents = []
  const failing = await runPlan({ plan, key: KEY, send: true, sleep: async ms => { stopEvents.push(`wait ${ms}`) },
    fetchImpl: async (url, init) => { stopEvents.push('send'); return mockFetch(f.files, GOOD, id => (id === 'b' ? { throw: 'TypeError' } : null)).fetchImpl(url, init) } })
  assert.deepEqual([stopEvents, failing.stoppedBecause, failing.sent], [['send', 'wait 20000', 'send'], 'network', 1])
  // dry run: nothing waits, nothing is sent
  const idle = []
  const dry = await runPlan({ plan, send: false, sleep: async ms => idle.push(ms), fetchImpl: async () => { idle.push('send') } })
  assert.deepEqual([dry.stoppedBecause, idle], ['dry_run', []])
  for (const [bad, why] of [[-1, /waitBeforeMs must be an integer/], [120001, /waitBeforeMs must be an integer/], [1.5, /waitBeforeMs must be an integer/]]) assert.throws(() => loadPlan(fixture(p => { p.requests[0].waitBeforeMs = bad }).planFile), why)
  assert.equal(loadPlan(fixture(p => { p.requests.forEach(r => { r.waitBeforeMs = 120000 }) }).planFile).totals.waitMs, 360000, 'three waits of 120 s are allowed')
  const many = fixture((p, files) => { for (let k = 0; k < 5; k++) { files[`w${k}`] = bodyText([predicate('needs_reply')], `대기 ${k}`); p.requests.push({ id: `w${k}`, file: `requests/w${k}.json`, sha256: sha(files[`w${k}`]), estInputTokens: 100, waitBeforeMs: 120000, expect: [{ name: 'needs_reply', kind: 'predicate', min: 0.8, severity: 'soft', note: 'x' }] }) } p.requests[0].waitBeforeMs = 120000 })
  assert.throws(() => loadPlan(many.planFile), /the waits add up to 720000 ms, over 600000/)
})

test('transport "product": a real send goes through the product transport, records warmBefore and the socket phases; a dry run creates no transport', async () => {
  const f = fixture(plan => { plan.transport = 'product'; plan.requests[1].waitBeforeMs = 5 })
  const made = [], m = mockFetch(f.files)
  let warmNow = false
  const createTransport = ({ trace }) => {
    const t = { closed: false, fetch: async (url, init) => { trace({ phase: 'start', t: 0, reused: false }); if (!warmNow) { trace({ phase: 'connect', t: 40, reused: false }); trace({ phase: 'secureConnect', t: 90, reused: false }) }
      trace({ phase: 'response', t: 300, reused: warmNow }); const r = await m.fetchImpl(url, init); warmNow = true; return r },
      warm: () => warmNow, close() { t.closed = true } }
    made.push(t); return t
  }
  const io = capture()
  assert.equal(await main([f.planFile, '--send'], { env: { OPENAI_API_KEY: KEY }, fetchImpl: async () => { throw new Error('the default fetch must not be used') }, createTransport, sleep: async () => {}, print: io.print, printError: io.printError }), EXIT.ok)
  assert.equal(made.length, 1); assert.equal(made[0].closed, true)
  const lines = io.out.map(line => JSON.parse(line))
  assert.equal(lines[0].transport, 'product'); assert.equal(lines[0].waitMs, 5)
  const outcome = await runPlan({ plan: loadPlan(f.planFile), key: KEY, send: true, fetchImpl: m.fetchImpl, warm: () => false, annotate: () => ({ reusedSocket: false, connectMs: 40 }), sleep: async () => {} })
  assert.deepEqual([outcome.results.a.warmBefore, outcome.results.a.reusedSocket, outcome.results.a.connectMs], [false, false, 40])
  const dryMade = []
  await main([f.planFile], { env: {}, createTransport: o => { dryMade.push(o); return createTransport(o) }, print: () => {}, printError: () => {} })
  assert.equal(dryMade.length, 0)
  assert.throws(() => loadPlan(fixture(p => { p.transport = 'undici' }).planFile), /transport must be "product"/)
  // the phases helper: numbers only
  const { transportPhases } = await import('./egdesk-decision-real-runner.mjs')
  assert.deepEqual(transportPhases([{ phase: 'start', t: 10 }, { phase: 'lookup', t: 12 }, { phase: 'connect', t: 50 }, { phase: 'secureConnect', t: 110 }, { phase: 'response', t: 410, reused: false }]),
    { reusedSocket: false, dnsMs: 2, connectMs: 40, tlsMs: 100, responseMs: 400 })
  assert.deepEqual(transportPhases([{ phase: 'start', t: 0 }, { phase: 'response', t: 200, reused: true }]), { reusedSocket: true, responseMs: 200 })
})
