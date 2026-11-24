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
  assert.equal(JSON.parse(io.out.at(-1)).stoppedBecause, 'dry_run')
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
  assert.equal(JSON.parse(io.out.at(-1)).stoppedBecause, 'over_token_ceiling')
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
