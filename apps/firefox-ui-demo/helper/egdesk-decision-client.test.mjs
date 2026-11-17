import test from 'node:test'
import assert from 'node:assert/strict'
import { DECISIONS_ENDPOINT, DECISION_MODEL, DecisionError, createDecisionBudget, createDecisionClient, validateDecisionRequest } from './egdesk-decision-client.mjs'

const KEY = 'sk-proj-TESTKEY-0123456789abcdefWXYZ'

function fakeFetch(handler) {
  const calls = []
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body)
    calls.push({ url, init, body })
    return handler({ url, init, body })
  }
  return { fetchImpl, calls }
}
function respond(status, data) {
  const text = typeof data === 'string' ? data : JSON.stringify(data)
  return { ok: status >= 200 && status < 300, status, text: async () => text }
}
const QUESTIONS = [
  { type: 'predicate', name: 'damaged', instructions: 'Is it damaged?' },
  { type: 'choice', name: 'dept', instructions: 'Which department?', choices: [{ value: 'billing' }, { value: 'technical' }, { value: true, description: 'a boolean option' }] },
  { type: 'score', name: 'severity', instructions: 'How severe?', levels: [{ label: 'low' }, { label: 'mid' }, { label: 'high' }] },
]

test('decide sends the documented request and maps answers by question name', async () => {
  const { fetchImpl, calls } = fakeFetch(() => respond(200, {
    model: 'gpt-6-luna',
    answers: [
      { type: 'score', name: 'severity', score: 1.1, confidence: 0.55, probabilities: [
        { value: 0, label: 'low', probability: 0.1 }, { value: 1, label: 'mid', probability: 0.7 }, { value: 2, label: 'high', probability: 0.2 }] },
      { type: 'predicate', name: 'damaged', probability: 0.92 },
      { type: 'choice', name: 'dept', choice: 'billing', confidence: 0.93, probabilities: [
        { value: 'technical', probability: 0.02 }, { value: 'billing', probability: 0.95 }, { value: true, probability: 0.03 }] },
    ],
    usage: { input_tokens: 42, input_tokens_details: { cached_tokens: 10, cache_write_tokens: 0 }, output_tokens: 0, total_tokens: 42 },
  }))
  const client = createDecisionClient({ getApiKey: () => KEY, fetchImpl })
  const result = await client.decide({ input: 'evidence', questions: QUESTIONS, promptCacheKey: 'egd-test' })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, DECISIONS_ENDPOINT)
  assert.equal(calls[0].init.method, 'POST')
  assert.equal(calls[0].init.headers.authorization, `Bearer ${KEY}`)
  assert.equal(calls[0].init.headers['content-type'], 'application/json')
  assert.deepEqual(calls[0].body, { model: DECISION_MODEL, input: 'evidence', questions: QUESTIONS, prompt_cache_key: 'egd-test' })
  assert.deepEqual(result.answers.damaged, { type: 'predicate', probability: 0.92 })
  assert.equal(result.answers.dept.choice, 'billing')
  assert.equal(result.answers.dept.confidence, 0.93)
  assert.deepEqual(result.answers.dept.probabilities.map(row => row.value), ['billing', true, 'technical'])
  assert.equal(result.answers.severity.score, 1.1)
  assert.deepEqual({ ...result.usage }, { inputTokens: 42, cachedTokens: 10, cacheWriteTokens: 0, outputTokens: 0, totalTokens: 42 })
  assert.equal(result.model, 'gpt-6-luna')
  assert.ok(result.latencyMs >= 0)
})

test('refused, missing, mismatched and out-of-set answers read as unknown, never as no', async () => {
  const { fetchImpl } = fakeFetch(() => respond(200, { answers: [
    { type: 'refusal', name: 'damaged' },
    // The string 'true' is not the boolean option true.
    { type: 'choice', name: 'dept', choice: 'true', confidence: 0.9, probabilities: [] },
  ] }))
  const client = createDecisionClient({ getApiKey: () => KEY, fetchImpl })
  const result = await client.decide({ input: 'x', questions: QUESTIONS })
  assert.equal(result.answers.damaged.type, 'refusal')
  assert.deepEqual(result.answers.dept, { type: 'invalid', reason: 'choice' })
  assert.equal(result.answers.severity.type, 'missing')
})

test('HTTP failures map to decision error codes and never carry the key or upstream text', async () => {
  const cases = [
    [401, { error: { message: `Incorrect API key provided: ${KEY}`, code: 'invalid_api_key' } }, 'invalid_key', false],
    [429, { error: { message: 'credits used', code: 'credit_balance_exhausted' } }, 'no_credit', false],
    [429, { error: { code: 'insufficient_quota', type: 'insufficient_quota' } }, 'no_credit', false],
    [429, { error: { code: 'rate_limit_exceeded' } }, 'rate_limited', true],
    [404, { error: { code: 'model_not_found' } }, 'model_unavailable', false],
    [403, { error: { code: 'unsupported_country_region_territory' } }, 'model_unavailable', false],
    [500, 'upstream failure page', 'server_error', true],
    [400, { error: { code: 'invalid_value' } }, 'invalid_request', false],
  ]
  for (const [status, body, code, retryable] of cases) {
    const { fetchImpl } = fakeFetch(() => respond(status, body))
    const client = createDecisionClient({ getApiKey: () => KEY, fetchImpl })
    await assert.rejects(client.decide({ input: 'x', questions: [QUESTIONS[0]] }), error => {
      assert.ok(error instanceof DecisionError)
      assert.equal(error.code, code)
      assert.equal(error.status, status)
      assert.equal(error.retryable, retryable)
      const text = `${error.message} ${JSON.stringify(error)} ${error.stack}`
      assert.ok(!text.includes(KEY), `${code} leaked the key`)
      assert.ok(!text.includes('Incorrect API key') && !text.includes('upstream failure page'))
      return true
    })
  }
})

test('a broken success body is a bad_response', async () => {
  for (const body of ['not json', { answers: 'nope' }, {}]) {
    const { fetchImpl } = fakeFetch(() => respond(200, body))
    const client = createDecisionClient({ getApiKey: () => KEY, fetchImpl })
    await assert.rejects(client.decide({ input: 'x', questions: [QUESTIONS[0]] }), { code: 'bad_response' })
  }
})

test('a slow provider times out, an outside abort cancels and a network failure is unreachable', async () => {
  let sent = 0
  // Like fetch: rejects at once for an aborted signal, otherwise waits for the abort.
  const hang = (url, init) => new Promise((resolve, reject) => {
    sent++
    const fail = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
    if (init.signal.aborted) fail()
    else init.signal.addEventListener('abort', fail)
  })
  const client = createDecisionClient({ getApiKey: () => KEY, fetchImpl: hang, timeoutMs: 20 })
  await assert.rejects(client.decide({ input: 'x', questions: [QUESTIONS[0]] }), { code: 'timeout', retryable: true })
  assert.equal(sent, 1)
  // Cancelled while waiting for the key: nothing is sent.
  const early = new AbortController()
  const before = client.decide({ input: 'x', questions: [QUESTIONS[0]], timeoutMs: 5000, signal: early.signal })
  early.abort()
  await assert.rejects(before, { code: 'aborted' })
  assert.equal(sent, 1)
  // Cancelled in flight.
  const late = new AbortController()
  const inFlight = client.decide({ input: 'x', questions: [QUESTIONS[0]], timeoutMs: 5000, signal: late.signal })
  await new Promise(resolve => setTimeout(resolve, 5))
  late.abort()
  await assert.rejects(inFlight, { code: 'aborted' })
  assert.equal(sent, 2)
  const down = createDecisionClient({ getApiKey: () => KEY, fetchImpl: async () => { throw new TypeError('fetch failed') } })
  await assert.rejects(down.decide({ input: 'x', questions: [QUESTIONS[0]] }), { code: 'unreachable', retryable: true })
})

test('requests that break published limits are refused before any network call', async () => {
  const { fetchImpl, calls } = fakeFetch(() => respond(200, { answers: [] }))
  const client = createDecisionClient({ getApiKey: () => KEY, fetchImpl })
  const predicate = name => ({ type: 'predicate', name, instructions: 'x' })
  const bad = [
    { input: 'x', questions: Array.from({ length: 401 }, (_, index) => predicate(`q${index}`)) },
    { input: 'x', questions: [] },
    { input: 'x', questions: [predicate('same'), predicate('same')] },
    { input: 'x', questions: [{ type: 'predicate', instructions: 'unnamed' }] },
    { input: 'x', questions: [{ type: 'rank', name: 'r', instructions: 'x' }] },
    { input: 'x', questions: [{ type: 'choice', name: 'c', instructions: 'x', choices: [{ value: 'a' }] }] },
    { input: 'x', questions: [{ type: 'choice', name: 'c', instructions: 'x', choices: Array.from({ length: 256 }, (_, index) => ({ value: `v${index}` })) }] },
    { input: 'x', questions: [{ type: 'choice', name: 'c', instructions: 'x', choices: [{ value: 'a' }, { value: 'a' }] }] },
    { input: 'x', questions: [{ type: 'score', name: 's', instructions: 'x', levels: Array.from({ length: 11 }, (_, index) => ({ label: `l${index}` })) }] },
    { input: 'x', questions: [predicate('p')], promptCacheKey: 'k'.repeat(65) },
    { input: [], questions: [predicate('p')] },
  ]
  for (const request of bad) await assert.rejects(client.decide(request), { code: 'invalid_request' })
  assert.equal(calls.length, 0)
  assert.doesNotThrow(() => validateDecisionRequest({ input: 'x',
    questions: [{ type: 'choice', name: 'c', instructions: 'x', choices: [{ value: 'true' }, { value: true }] }] }))
})

test('without a saved key nothing is sent', async () => {
  const { fetchImpl, calls } = fakeFetch(() => respond(200, { answers: [] }))
  const client = createDecisionClient({ getApiKey: async () => null, fetchImpl })
  await assert.rejects(client.decide({ input: 'x', questions: [QUESTIONS[0]] }), { code: 'not_configured' })
  assert.equal(calls.length, 0)
})

test('verifyKey checks a candidate key with one tiny request', async () => {
  const cases = [
    [200, { answers: [{ type: 'predicate', name: 'key_check', probability: 0.9 }] }, 'verified'],
    [401, {}, 'invalid_key'],
    [429, { error: { code: 'credit_balance_exhausted' } }, 'no_credit'],
  ]
  for (const [status, body, expected] of cases) {
    const { fetchImpl, calls } = fakeFetch(() => respond(status, body))
    const client = createDecisionClient({ getApiKey: () => null, fetchImpl })
    const verdict = await client.verifyKey(KEY)
    assert.equal(verdict.status, expected)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].init.headers.authorization, `Bearer ${KEY}`)
    assert.equal(calls[0].body.questions.length, 1)
  }
  const client = createDecisionClient({ getApiKey: () => null, fetchImpl: async () => { throw new Error('must not be called') } })
  assert.deepEqual(await client.verifyKey(''), { status: 'invalid_key', retryable: false })
})

test('the local budget counts input tokens per month and refuses past the cap', async () => {
  let time = Date.UTC(2026, 10, 30, 12)
  const budget = createDecisionBudget({ monthlyInputTokenCap: 100, now: () => time })
  const { fetchImpl, calls } = fakeFetch(() => respond(200, { answers: [{ type: 'predicate', name: 'damaged', probability: 0.5 }], usage: { input_tokens: 60 } }))
  const client = createDecisionClient({ getApiKey: () => KEY, fetchImpl, budget })
  await client.decide({ input: 'x', questions: [QUESTIONS[0]] })
  await client.decide({ input: 'x', questions: [QUESTIONS[0]] })
  assert.equal(budget.snapshot().inputTokens, 120)
  await assert.rejects(client.decide({ input: 'x', questions: [QUESTIONS[0]] }), { code: 'budget_exceeded' })
  assert.equal(calls.length, 2)
  time = Date.UTC(2026, 11, 1, 0)
  assert.equal(budget.canSpend(), true)
  assert.deepEqual({ ...budget.snapshot() }, { month: '2026-12', inputTokens: 0, cap: 100 })
  assert.throws(() => createDecisionBudget({ monthlyInputTokenCap: 0 }), TypeError)
})
