import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { DECISION_PROVIDERS, DecisionError, createDecisionBudget, createDecisionClient, decisionProviderFromEnv, decisionTopicRecipient } from './egdesk-decision-client.mjs'
import { openDecisionCredentialStore } from './egdesk-decision-credential.mjs'
import { classifyGeminiFailure, geminiInput, geminiRequest } from './egdesk-decision-gemini.mjs'

const KEY = 'AIzaSyFAKE-not-a-real-key-0000000000000'
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const make = (respond, extra = {}) => {
  const seen = []
  const client = createDecisionClient({ provider: 'gemini', getApiKey: () => KEY, fetchImpl: async (url, init) => { seen.push({ url, init, body: JSON.parse(init.body) }); return respond(seen.at(-1)) }, ...extra })
  return { client, seen }
}
const usage = n => ({ total_input_tokens: n, input_tokens_by_modality: [{ modality: 'text', tokens: n }], total_output_tokens: 0, total_tokens: n })
const Q = {
  p: { type: 'predicate', name: 'is_ready', instructions: 'Is it ready?' },
  c: { type: 'choice', name: 'pick_radio', instructions: 'Which radio?', choices: [{ value: 'Small', description: 'Small size' }, { value: 'Medium', description: '' }, { value: 'Large' }] },
  s: { type: 'score', name: 'sev', instructions: 'How severe?', levels: [{ label: 'low' }, { label: 'mid', description: 'some' }, { label: 'high' }] },
}

test('provider defaults to openai and gemini needs the explicit switch', () => {
  assert.equal(decisionProviderFromEnv({}), 'openai')
  assert.equal(decisionProviderFromEnv({ EGDESK_DECISION_PROVIDER: 'nonsense' }), 'openai')
  assert.equal(decisionProviderFromEnv({ EGDESK_DECISION_PROVIDER: ' Gemini ' }), 'gemini')
  const open = createDecisionClient({ getApiKey: () => KEY })
  assert.equal(open.provider, 'openai'); assert.equal(open.endpoint, DECISION_PROVIDERS.openai.endpoint); assert.equal(open.model, 'gpt-6-luna')
  const g = createDecisionClient({ provider: 'gemini', getApiKey: () => KEY })
  assert.equal(g.endpoint, 'https://generativelanguage.googleapis.com/v1beta/decisions'); assert.equal(g.model, 'gemini-decision-1')
  assert.throws(() => createDecisionClient({ provider: 'x', getApiKey: () => KEY }), TypeError)
})

test('request translation: header, endpoint, noul/choice/score, messages flattened, no OpenAI-only fields', async () => {
  const { client, seen } = make(() => json(200, { answers: {}, usage: usage(10) }))
  await client.decide({ input: [{ role: 'developer', content: 'Rules.' }, { role: 'user', content: [{ type: 'input_text', text: 'Hello' }, { type: 'input_json', data: { a: 1 } },
    { type: 'input_image', image_url: 'data:image/png;base64,AAAA', detail: 'low' }] }], questions: [Q.p, Q.c, Q.s], promptCacheKey: 'k', safetyIdentifier: 's' })
  const { url, init, body } = seen[0]
  assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/decisions')
  assert.equal(init.headers['x-goog-api-key'], KEY); assert.equal(init.headers.authorization, undefined)
  assert.equal(body.model, 'gemini-decision-1'); assert.equal(body.prompt_cache_key, undefined); assert.equal(body.safety_identifier, undefined)
  assert.deepEqual(body.questions.is_ready, { type: 'noul', instructions: 'Is it ready?' })
  assert.deepEqual(body.questions.pick_radio, { type: 'choice', instructions: 'Which radio?', criteria: { Small: 'Small size', Medium: '', Large: '' } })
  assert.deepEqual(body.questions.sev, { type: 'score', instructions: 'How severe?', criteria: ['low', 'mid: some', 'high'] })
  const texts = body.input.filter(b => b.type === 'text').map(b => b.text).join('')
  assert.match(texts, /\[developer\]\nRules\./); assert.match(texts, /Hello/); assert.match(texts, /\{"a":1\}/)
  assert.deepEqual(body.input.find(b => b.type === 'image'), { type: 'image', data: 'AAAA', mime_type: 'image/png', resolution: 'low' })
  assert.equal(JSON.stringify(body).includes(KEY), false)
})

test('string input stays a string; odd question names and boolean choices get safe ids and map back', async () => {
  assert.equal(geminiInput('plain'), 'plain')
  const qs = [{ type: 'choice', name: 'a b/c', instructions: 'x', choices: [{ value: true, description: 'yes' }, { value: 'true', description: 'text' }] }]
  const { body, plan } = geminiRequest({ input: 'i', questions: qs })
  assert.deepEqual(Object.keys(body.questions), ['q1']); assert.deepEqual(Object.keys(body.questions.q1.criteria), ['true', 'true_'])
  assert.equal(plan.get('a b/c').valueOf.get('true'), true); assert.equal(plan.get('a b/c').valueOf.get('true_'), 'true')
  const { client } = make(() => json(200, { answers: { q1: { type: 'choice', choice: 'true', probabilities: { true: 0.8, true_: 0.2 }, confidence: 0.8 } }, usage: usage(5) }))
  const out = await client.decide({ input: 'i', questions: qs })
  assert.equal(out.answers['a b/c'].choice, true); assert.deepEqual(out.answers['a b/c'].probabilities.map(r => r.value), [true, 'true'])
})

test('responses become the same normalized answers the callers already read', async () => {
  const budget = createDecisionBudget()
  const { client } = make(() => json(200, { answers: {
    is_ready: { type: 'noul', noul: 0.97, confidence: 0.97 },
    pick_radio: { type: 'choice', choice: 'Medium', probabilities: { Medium: 0.9, Small: 0.07, Large: 0.03 }, confidence: 0.9 },
    sev: { type: 'score', score: 1.12, legend: { 0: 'low' }, probabilities: { 0: 0.03, 1: 0.83, 2: 0.14 }, confidence: 0.83 } }, usage: usage(321) }), { budget })
  const out = await client.decide({ input: 'x', questions: [Q.p, Q.c, Q.s] })
  assert.deepEqual({ ...out.answers.is_ready }, { type: 'predicate', probability: 0.97 })
  assert.equal(out.answers.pick_radio.choice, 'Medium'); assert.equal(out.answers.pick_radio.confidence, 0.9)
  assert.deepEqual(out.answers.pick_radio.probabilities.map(r => r.value), ['Medium', 'Small', 'Large'])
  assert.equal(out.answers.sev.type, 'score'); assert.equal(out.answers.sev.score, 1.12)
  assert.deepEqual(out.answers.sev.probabilities.map(r => [r.value, r.label]), [[1, 'mid'], [2, 'high'], [0, 'low']])
  assert.equal(out.usage.inputTokens, 321); assert.equal(out.usage.outputTokens, 0); assert.equal(out.model, 'gemini-decision-1')
  assert.equal(budget.snapshot().inputTokens, 321)
})

test('missing, wrong-type and unknown-choice answers are unknown, never a value', async () => {
  const { client } = make(() => json(200, { answers: { pick_radio: { type: 'choice', choice: 'Huge', probabilities: { Huge: 1 }, confidence: 1 }, sev: { type: 'noul', noul: 0.5, confidence: 0.5 } }, usage: usage(1) }))
  const out = await client.decide({ input: 'x', questions: [Q.p, Q.c, Q.s] })
  assert.equal(out.answers.is_ready.type, 'missing'); assert.equal(out.answers.pick_radio.type, 'invalid'); assert.equal(out.answers.sev.type, 'invalid')
})

test('strict single choice works through the translation', async () => {
  const { client } = make(() => json(200, { answers: { pick_radio: { type: 'choice', choice: 'Large', probabilities: { Large: 0.6, Medium: 0.4 }, confidence: 0.6 } }, usage: usage(2) }))
  const out = await client.decide({ input: 'x', questions: [Q.c], strictChoiceResponse: true })
  assert.equal(out.answers.pick_radio.choice, 'Large')
})

const failing = async (respond, extra) => {
  const { client } = make(respond, extra)
  try { await client.decide({ input: 'x', questions: [Q.p] }) } catch (e) { return e }
  assert.fail('should have thrown')
}
const err = (status, error) => json(status, { error })

test('429 free-tier limits: per-minute is rate_limited (retryable), per-day is spend_limit_reached', async () => {
  const minute = await failing(() => err(429, { code: 429, status: 'RESOURCE_EXHAUSTED', message: `quota ${KEY}`, details: [{ violations: [{ quotaId: 'DecisionsRequestsPerMinute' }] }] }))
  assert.equal(minute.code, 'rate_limited'); assert.equal(minute.retryable, true); assert.equal(minute.status, 429); assert.equal(minute.apiCode, 'resource_exhausted')
  const day = await failing(() => err(429, { code: 429, status: 'RESOURCE_EXHAUSTED', details: [{ violations: [{ quotaId: 'DecisionsRequestsPerDayPerProject' }] }] }))
  assert.equal(day.code, 'spend_limit_reached'); assert.equal(day.retryable, false)
  for (const e of [minute, day]) assert.equal(JSON.stringify([e.message, e.code, e.apiCode]).includes(KEY), false)
})

test('400 / 401 / 403 / 404 / 5xx map to the existing closed codes without upstream text', async () => {
  assert.equal((await failing(() => err(400, { status: 'INVALID_ARGUMENT', message: 'API key not valid. Please pass a valid API key.', details: [{ reason: 'API_KEY_INVALID' }] }))).code, 'invalid_key')
  assert.equal((await failing(() => err(400, { status: 'INVALID_ARGUMENT', message: 'bad question' }))).code, 'invalid_request')
  assert.equal((await failing(() => err(401, { status: 'UNAUTHENTICATED' }))).code, 'invalid_key')
  assert.equal((await failing(() => err(403, { status: 'PERMISSION_DENIED' }))).code, 'model_unavailable')
  assert.equal((await failing(() => err(404, { status: 'NOT_FOUND' }))).code, 'model_unavailable')
  const s = await failing(() => err(503, { status: 'UNAVAILABLE' })); assert.equal(s.code, 'server_error'); assert.equal(s.retryable, true)
  assert.equal((await failing(() => new Response('<html>', { status: 502 }))).code, 'server_error')
  assert.equal(classifyGeminiFailure(400, null).code, 'invalid_request')
})

test('a blocked prompt (200, prompt_feedback.block_reason, no answers) is a closed failure that records usage only', async () => {
  const budget = createDecisionBudget()
  for (const reason of ['safety', 'prohibited_content']) {
    const e = await failing(() => json(200, { answers: {}, prompt_feedback: { block_reason: reason, block_reason_message: 'secret text' } }), { budget })
    assert.equal(e.code, 'invalid_request'); assert.equal(e.apiCode, `blocked_${reason}`); assert.equal(e.retryable, false)
    assert.equal(e.message.includes('secret'), false)
  }
  assert.equal(budget.snapshot().inputTokens, 0)
})

test('a 200 without answers is bad_response; timeout, key missing and cancel keep their closed codes', async () => {
  assert.equal((await failing(() => json(200, { usage: usage(1) }))).code, 'bad_response')
  const slow = await failing(r => new Promise((_, rej) => r.init.signal.addEventListener('abort', () => rej(new Error('aborted')))), { timeoutMs: 20 }) // fetch ignoring abort never resolves; the client's abort rejects it
  assert.equal(slow.code, 'timeout'); assert.equal(slow.retryable, true)
  const noKey = createDecisionClient({ provider: 'gemini', getApiKey: () => null, fetchImpl: async () => assert.fail('no request without a key') })
  await assert.rejects(() => noKey.decide({ input: 'x', questions: [Q.p] }), e => e instanceof DecisionError && e.code === 'not_configured')
})

test('a timeout after dispatch counts an estimate in the budget (gemini)', async () => {
  const budget = createDecisionBudget()
  await failing(r => new Promise((_, rej) => r.init.signal.addEventListener('abort', () => rej(new Error('aborted')))), { timeoutMs: 20, budget })
  assert.equal(budget.snapshot().unmeteredRequests, 1)
})

test('send binding: the recipient differs by provider, endpoint and model; the gate sees the Gemini endpoint', async () => {
  const seenBinding = []
  const { client } = make(() => json(200, { answers: {}, usage: usage(1) }), { recipientForKey: (k, endpoint, model) => { seenBinding.push([endpoint, model]); return decisionTopicRecipient(k, 1, endpoint, model) } })
  let gateGot = null
  await client.decide({ input: 'x', questions: [Q.p], authorizeDispatch: fp => { gateGot = fp; return true } })
  assert.equal(gateGot, decisionTopicRecipient(KEY, 1, DECISION_PROVIDERS.gemini.endpoint, DECISION_PROVIDERS.gemini.model))
  assert.notEqual(gateGot, decisionTopicRecipient(KEY, 1, DECISION_PROVIDERS.openai.endpoint, DECISION_PROVIDERS.openai.model))
  // a grant bound to the OpenAI recipient does not authorize a Gemini send
  const openFp = decisionTopicRecipient(KEY, 1, DECISION_PROVIDERS.openai.endpoint, DECISION_PROVIDERS.openai.model)
  const { client: c2 } = make(() => assert.fail('must not send'), { recipientForKey: (k, e, m) => decisionTopicRecipient(k, 1, e, m) })
  await assert.rejects(() => c2.decide({ input: 'x', questions: [{ ...Q.p, name: 'topic_need_x' }], authorizeDispatch: fp => fp === openFp }), e => e.code === 'evidence_unavailable')
})

test('verifyKey works over Gemini and never echoes the key', async () => {
  const { client } = make(() => json(200, { answers: { key_check: { type: 'noul', noul: 0.9, confidence: 0.9 } }, usage: usage(8) }))
  assert.deepEqual(await client.verifyKey(KEY), { status: 'verified', retryable: false })
  const { client: bad } = make(() => err(400, { status: 'INVALID_ARGUMENT', details: [{ reason: 'API_KEY_INVALID' }] }))
  assert.deepEqual(await bad.verifyKey(KEY), { status: 'invalid_key', retryable: false })
})

test('credential store: separate Gemini file; the OpenAI key is never read as a Gemini key; key file fallback', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'l41-')); chmodSync(dir, 0o700)
  const oai = openDecisionCredentialStore({ dataDir: dir, log: () => {} })
  assert.equal(oai.save('sk-proj-' + 'a'.repeat(30)), true)
  const g = openDecisionCredentialStore({ dataDir: dir, log: () => {}, provider: 'gemini' })
  assert.equal(g.getApiKey(), null); assert.equal(g.status, 'missing')
  assert.equal(g.save(KEY), true)
  assert.equal(openDecisionCredentialStore({ dataDir: dir, log: () => {}, provider: 'gemini' }).getApiKey(), KEY)
  assert.equal(openDecisionCredentialStore({ dataDir: dir, log: () => {} }).getApiKey(), 'sk-proj-' + 'a'.repeat(30))
  const dir2 = mkdtempSync(path.join(tmpdir(), 'l41-')); chmodSync(dir2, 0o700)
  const kf = path.join(dir2, 'k.txt'); writeFileSync(kf, `GEMINI_API_KEY=${KEY}\n`, { mode: 0o600 })
  const viaFile = openDecisionCredentialStore({ dataDir: path.join(dir2, 's'), log: () => {}, provider: 'gemini', keyFile: kf })
  assert.equal(viaFile.getApiKey(), KEY)
  assert.equal(openDecisionCredentialStore({ dataDir: path.join(dir2, 's2'), log: () => {}, provider: 'openai', keyFile: kf }).getApiKey(), null)
  assert.throws(() => openDecisionCredentialStore({ dataDir: dir, provider: 'x' }), TypeError)
})
